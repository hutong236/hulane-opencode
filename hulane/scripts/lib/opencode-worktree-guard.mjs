import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findControlRoot, readStore } from "./state-store.mjs";

// A managed Coder may write/run only while OpenCode is opened inside the
// EXACT approved Work Item worktree. It cannot use the canonical checkout.
const STATES = new Set(["doing", "testing", "review"]);

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  if (result.status !== 0 || result.error) throw new Error("Git worktree check failed");
  return result.stdout.trim();
}

function canonical(target) {
  let current = path.resolve(target);
  const pending = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to resolve requested path");
    pending.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...pending);
}

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

export function evaluateCoderWorktree({ agent, action, resources = [], locationDirectory }) {
  if (agent !== "hulane-coder" || !["edit", "shell"].includes(action)) {
    return { allowed: true, reason: "Not a Hulane Coder edit/shell action" };
  }
  try {
    if (!locationDirectory) throw new Error("Missing OpenCode location");
    const root = findControlRoot(locationDirectory);
    const openedWorktree = canonical(git(locationDirectory, "rev-parse", "--show-toplevel"));
    const branch = git(locationDirectory, "branch", "--show-current");
    const store = readStore(root, { allowMissing: false });
    const item = Object.values(store.items).find((candidate) =>
      candidate.human_approval === "approved" &&
      STATES.has(candidate.status) &&
      candidate.worktree_path &&
      candidate.branch === branch &&
      canonical(candidate.worktree_path) === openedWorktree
    );
    if (!item) throw new Error("No approved Work Item matches this Git worktree and branch");
    if (action === "edit") {
      if (!Array.isArray(resources) || !resources.length) throw new Error("Edit target path is missing");
      for (const resource of resources) {
        if (typeof resource !== "string" || !resource.trim()) throw new Error("Invalid edit target");
        const target = canonical(path.isAbsolute(resource) ? resource : path.resolve(locationDirectory, resource));
        if (!inside(openedWorktree, target)) throw new Error("Edit target escapes approved Worktree");
      }
    }
    return { allowed: true, work_item: item.id, reason: "Approved Worktree and branch matched" };
  } catch (error) {
    return { allowed: false, reason: "Hulane Worktree gate: " + error.message };
  }
}
