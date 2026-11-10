import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initializeRepositoryState } from "../hulane/scripts/lib/state-store.mjs";

test("state store binds once to a GitHub repository", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-store-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  initializeRepositoryState(root);
  const bound = initializeRepositoryState(root, "acme/demo");
  assert.equal(bound.repository, "acme/demo");
  assert.throws(() => initializeRepositoryState(root, "other/repo"), /belongs to acme\/demo/);
});
