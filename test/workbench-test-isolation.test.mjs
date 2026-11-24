import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("root test command explicitly isolates legacy regression suite from Workbench", () => {
  const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const workbenchPackage = JSON.parse(readFileSync(path.join(root, "workbench/package.json"), "utf8"));
  assert.equal(rootPackage.scripts.test, "node --test test/*.test.mjs");
  assert.equal(rootPackage.scripts["test:core"], rootPackage.scripts.test);
  assert.ok(existsSync(path.join(root, "workbench/apps/api/test/health.spec.ts")));
  assert.ok(workbenchPackage.scripts.test, "Workbench must retain its independent test command");
  // `workbench/test/` is not a workspace: nothing runs its tests unless this script does.
  assert.match(workbenchPackage.scripts.test, /node --test test\/\*\.test\.mjs/);
  assert.match(workbenchPackage.scripts.test, /npm run test --workspaces/);
});
