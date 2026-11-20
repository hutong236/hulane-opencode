import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, defaultBranchFor } from "../hulane/scripts/lib/worktree.mjs";
import { findControlRoot } from "../hulane/scripts/lib/state-store.mjs";

test("worktree creation isolates a Work Item on its own branch", () => {
  // git 输出真实路径,macOS 的 /var 软链需先解析才能与夹具路径一致
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hulane-worktree-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Hulane Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });

  const result = createWorktree(root, { id: "REQ-31" });
  assert.equal(result.branch, defaultBranchFor("REQ-31"));
  assert.equal(findControlRoot(result.path), root);
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: result.path, encoding: "utf8" }).trim(), "hulane/req-31");
});
