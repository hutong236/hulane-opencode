// Hulane OpenCode V2: execute privileged operations inside the MCP control plane.
// Agents never receive single-use authorization tokens; all subprocesses use argv, not a shell.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findControlRoot, getItem, readStore, resolveControlDir } from "../scripts/lib/state-store.mjs";
import { issueAuthorization, consumeAuthorization, verifyStateAuthorization } from "../scripts/lib/authorization.mjs";

const workItemID = { type: "string", pattern: "^(REQ|BUG)-[1-9][0-9]*$" };
const inputSchema = { type: "object", properties: { id: workItemID }, required: ["id"], additionalProperties: false };
const definitions = [
  ["hulane_secure_push", "Push the approved Work Item branch from its exact worktree after a state-bound one-use authorization."],
  ["hulane_secure_tag_create", "Create the exact Gate C approved annotated tag on the merged commit."],
  ["hulane_secure_tag_push", "Push the verified annotated tag after Gate C approval."],
  ["hulane_secure_merge", "Merge only the exact reviewed PR head SHA after the merge guard and Gate B."],
  ["hulane_secure_close", "Close the exact Work Item Issue only after all required completion evidence."],
];
export const SECURE_TOOL_DEFINITIONS = definitions.map(([name, description]) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true },
}));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    shell: false, timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    // Never echo token-bearing commands or potentially credential-bearing remote URLs.
    throw new Error(command + " operation failed (exit " + (result.status ?? "spawn") + ")");
  }
  return String(result.stdout ?? "").trim();
}

function withLock(root, id, fn) {
  const dir = path.join(resolveControlDir(root), "opencode-operation-locks");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filename = path.join(dir, id + ".lock");
  let fd;
  try { fd = fs.openSync(filename, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Another protected operation is in progress for " + id);
    throw error;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(filename, { force: true });
  }
}

function getScope(cwd, id) {
  const root = findControlRoot(cwd);
  return { root, item: getItem(root, id) };
}
function authorizeAndConsume(root, item, action, cwd, commandFactory) {
  const auth = issueAuthorization(root, { id: item.id, action, actor: "orchestrator" });
  const command = commandFactory(auth.token);
  consumeAuthorization(root, { token: auth.token, action, cwd, command });
}
function verifyTag(root, item) {
  const imageTag = item.image_tag;
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(String(imageTag))) {
    throw new Error("Tag is missing or not a strict SemVer");
  }
  if (!/^[a-f0-9]{40}$/i.test(String(item.merged_sha ?? ""))) throw new Error("Missing merged SHA");
  const type = run("git", ["cat-file", "-t", "refs/tags/" + imageTag], root);
  if (type !== "tag") throw new Error("Release tag is not annotated");
  const pointedSHA = run("git", ["rev-parse", "refs/tags/" + imageTag + "^{}"], root);
  if (pointedSHA.toLowerCase() !== item.merged_sha.toLowerCase()) throw new Error("Release tag does not match merged SHA");
}

export async function callSecureTool(name, input, context) {
  if (!SECURE_TOOL_DEFINITIONS.some((entry) => entry.name === name)) throw new Error("Unknown secure tool");
  const { root, item } = getScope(context.cwd, input.id);
  return withLock(root, item.id, () => {
    // Reload inside the lock. The state machine guards both the action and its exact target.
    const current = getItem(root, item.id);
    if (name === "hulane_secure_push") {
      if (!current.worktree_path) throw new Error("Worktree path missing");
      const cwd = current.worktree_path;
      authorizeAndConsume(root, current, "git-push", cwd,
        (token) => "HULANE_AUTH_TOKEN=" + token + " git push origin HEAD");
      run("git", ["push", "origin", "HEAD"], cwd);
      return { operation: name, work_item: input.id, branch: current.branch, pushed: true };
    }
    if (name === "hulane_secure_tag_create") {
      const tag = String(current.image_tag ?? "");
      const sha = String(current.merged_sha ?? "");
      authorizeAndConsume(root, current, "git-tag", root,
        (token) => "HULANE_AUTH_TOKEN=" + token + " git tag -a " + tag + " -m Release-" + tag + " " + sha);
      run("git", ["tag", "-a", tag, "-m", "Release " + tag, sha], root);
      verifyTag(root, current);
      return { operation: name, work_item: input.id, tag, commit_sha: sha, created: true };
    }
    if (name === "hulane_secure_tag_push") {
      verifyTag(root, current);
      const tag = current.image_tag;
      authorizeAndConsume(root, current, "git-push", root,
        (token) => "HULANE_AUTH_TOKEN=" + token + " git push origin refs/tags/" + tag + ":refs/tags/" + tag);
      run("git", ["push", "origin", "refs/tags/" + tag + ":refs/tags/" + tag], root);
      return { operation: name, work_item: input.id, tag, pushed: true };
    }
    if (name === "hulane_secure_merge") {
      const command = "gh pr merge " + current.pr_number + " --squash --match-head-commit " + current.pr_head_sha;
      verifyStateAuthorization(root, { action: "pr-merge", cwd: root, command });
      run("gh", ["pr", "merge", String(current.pr_number), "--squash", "--match-head-commit", current.pr_head_sha], root);
      return { operation: name, work_item: input.id, pr_number: current.pr_number, verified_pr_head: current.pr_head_sha, merged: true };
    }
    if (name === "hulane_secure_close") {
      const repository = readStore(root, { allowMissing: false }).repository;
      if (!/^[^/\s]+\/[^/\s]+$/.test(String(repository ?? ""))) throw new Error("GitHub repository binding missing");
      const command = "gh issue close " + current.issue_number + " --repo " + repository + " --comment Done";
      verifyStateAuthorization(root, { action: "issue-close", cwd: root, command });
      run("gh", ["issue", "close", String(current.issue_number), "--repo", repository, "--comment", "Done"], root);
      return { operation: name, work_item: input.id, issue_number: current.issue_number, closed: true };
    }
    throw new Error("Unimplemented protected operation");
  });
}
