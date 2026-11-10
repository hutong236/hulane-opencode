import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { writeStore } from "../hulane/scripts/lib/state-store.mjs";
import { evaluateCoderWorktree } from "../hulane/scripts/lib/opencode-worktree-guard.mjs";

function run(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("Hulane Coder may edit only an approved matching worktree and branch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-worktree-gate-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-external-"));
  try {
    run(root, "init", "-q");
    run(root, "config", "user.name", "CI");
    run(root, "config", "user.email", "ci@example.invalid");
    fs.writeFileSync(path.join(root, "README.md"), "test");
    run(root, "add", "README.md");
    run(root, "commit", "-qm", "init");
    const worktree = path.join(root, ".hulane", "worktrees", "REQ-12");
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    run(root, "worktree", "add", "-b", "hulane/req-12", worktree, "HEAD");
    const item = {
      ...createWorkItem({
        id: "REQ-12", issue_number: 12, title: "Worktree guard",
        risk_level: "low", delivery_required: true,
      }),
      human_approval: "approved", status: "doing",
      branch: "hulane/req-12", worktree_path: worktree,
    };
    writeStore(root, {
      schema_version: 2, repository: "acme/demo", revision: 0,
      updated_at: new Date().toISOString(), items: { "REQ-12": item },
    });
    const evaluate = (directory, action, resources) => evaluateCoderWorktree({
      agent: "hulane-coder", action, resources, locationDirectory: directory,
    });
    assert.equal(evaluate(root, "edit", ["src/main.js"]).allowed, false, "Root checkout must be blocked");
    assert.equal(evaluate(worktree, "edit", ["src/main.js"]).allowed, true);
    assert.equal(evaluate(worktree, "shell", ["npm test"]).allowed, true);
    assert.equal(evaluate(worktree, "edit", [path.join(outside, "secret.txt")]).allowed, false);
    fs.symlinkSync(outside, path.join(worktree, "escape"));
    assert.equal(evaluate(worktree, "edit", ["escape/secret.txt"]).allowed, false, "Symlink escape must be blocked");
    assert.equal(evaluate(worktree, "edit", []).allowed, false, "Empty file target must be blocked");
    assert.equal(evaluateCoderWorktree({
      agent: "hulane-reviewer", action: "edit", resources: ["x"], locationDirectory: root,
    }).allowed, true, "Other agents remain restricted through their own declarative permissions");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
