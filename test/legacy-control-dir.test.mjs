import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { getItem, initializeRepositoryState, readStore, resolveControlDir } from "../hulane/scripts/lib/state-store.mjs";
import { readGithubMeta } from "../hulane/scripts/lib/github-state.mjs";
import { worktreePath } from "../hulane/scripts/lib/worktree.mjs";
import { evaluateCommand } from "../hulane/hooks/guard.mjs";

// V3.0.0 更名前初始化的仓库只有 .cmdb-dev/state.json:新插件必须整体继续
// 使用旧控制根,guard 拦截、状态读写、授权与 worktree 都不能断档

function legacyRepository({ withHulaneStore = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-legacy-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const item = { ...createWorkItem({
    id: "REQ-90",
    issue_number: 90,
    title: "Legacy control dir",
    risk_level: "low",
    delivery_required: true,
  }), status: "pr_open", branch: "cmdb/req-90", worktree_path: path.join(root, ".cmdb-dev", "worktrees", "REQ-90") };
  const store = { schema_version: 2, repository: "acme/demo", revision: 3, updated_at: new Date().toISOString(), items: { [item.id]: item } };
  fs.mkdirSync(path.join(root, ".cmdb-dev"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cmdb-dev", "state.json"), JSON.stringify(store));
  if (withHulaneStore) {
    fs.mkdirSync(path.join(root, ".hulane"), { recursive: true });
    fs.writeFileSync(path.join(root, ".hulane", "state.json"), JSON.stringify(store));
  }
  return root;
}

test("legacy control dir keeps resolveControlDir, store reads and guard protection alive", () => {
  const root = legacyRepository();
  assert.equal(resolveControlDir(root), path.join(root, ".cmdb-dev"));
  const store = readStore(root, { allowMissing: false });
  assert.equal(store.items["REQ-90"].issue_number, 90);

  const result = evaluateCommand({ cwd: root, command: "git push" });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /requires a single-use Hulane authorization token/);
});

test("guard allowlist is still read from the legacy control dir", () => {
  const root = legacyRepository();
  fs.writeFileSync(
    path.join(root, ".cmdb-dev", "guard-allowlist.json"),
    JSON.stringify(["hutong236/hutong-zcode-marketplace"]),
  );
  const command = "git push https://github.com/hutong236/hutong-zcode-marketplace.git main";
  const result = evaluateCommand({ cwd: root, command });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /exempt remote/);
});

test("worktree paths and github meta resolve under the legacy control dir", () => {
  const root = legacyRepository();
  assert.equal(
    worktreePath(root, "REQ-91"),
    path.join(root, ".cmdb-dev", "worktrees", "REQ-91"),
  );
  fs.writeFileSync(
    path.join(root, ".cmdb-dev", "github-meta.json"),
    JSON.stringify({ "REQ-90": { comment_id: 777, state_label: "cmdb:waiting-approval" } }),
  );
  assert.deepEqual(readGithubMeta(root)["REQ-90"], { comment_id: 777, state_label: "cmdb:waiting-approval" });
});

test("re-running init on a legacy repository does not fork state into .hulane", () => {
  const root = legacyRepository();
  initializeRepositoryState(root, "acme/demo");
  assert.equal(fs.existsSync(path.join(root, ".hulane", "state.json")), false);
  assert.equal(getItem(root, "REQ-90").issue_number, 90);
  assert.equal(fs.existsSync(path.join(root, ".cmdb-dev", "worktrees")), true);
  const exclude = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /\/\.hulane\//);
  assert.match(exclude, /\/\.cmdb-dev\//);
});

test("a fresh .hulane store takes precedence when both control dirs exist", () => {
  const root = legacyRepository({ withHulaneStore: true });
  assert.equal(resolveControlDir(root), path.join(root, ".hulane"));
});
