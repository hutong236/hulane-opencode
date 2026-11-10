import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveControlDir } from "./state-store.mjs";

const ID_PATTERN = /^(REQ|BUG)-[1-9][0-9]*$/;

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

export function defaultBranchFor(id) {
  if (!ID_PATTERN.test(id)) throw new Error("Work Item id must match REQ-<issue> or BUG-<issue>");
  return `hulane/${id.toLowerCase()}`;
}

export function worktreePath(root, id) {
  if (!ID_PATTERN.test(id)) throw new Error("Work Item id must match REQ-<issue> or BUG-<issue>");
  const base = path.join(resolveControlDir(root), "worktrees");
  const target = path.resolve(base, id);
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error("Invalid worktree path");
  return target;
}

export function createWorktree(root, { id, branch = defaultBranchFor(id), base = "HEAD" }) {
  const target = worktreePath(root, id);
  if (fs.existsSync(target)) throw new Error(`Worktree path already exists: ${target}`);

  const branchCheck = git(root, ["check-ref-format", "--branch", branch], { allowFailure: true });
  if (branchCheck.status !== 0) throw new Error(`Invalid branch name: ${branch}`);
  const baseCheck = git(root, ["rev-parse", "--verify", `${base}^{commit}`], { allowFailure: true });
  if (baseCheck.status !== 0) throw new Error(`Base ref does not resolve to a commit: ${base}`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const exists = git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true }).status === 0;
  if (exists) git(root, ["worktree", "add", target, branch]);
  else git(root, ["worktree", "add", "-b", branch, target, base]);

  return {
    id,
    branch,
    path: target,
    base,
    head: git(target, ["rev-parse", "HEAD"]).stdout.trim(),
  };
}
