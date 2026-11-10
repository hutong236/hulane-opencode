import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SECURE_TOOL_DEFINITIONS, callSecureTool } from "../hulane/mcp/secure-tools.mjs";
import { validateInput } from "../hulane/mcp/validate.mjs";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { writeStore } from "../hulane/scripts/lib/state-store.mjs";

test("secure tools expose only explicit fixed-argument protected operations", () => {
  assert.equal(SECURE_TOOL_DEFINITIONS.length, 5);
  assert.equal(new Set(SECURE_TOOL_DEFINITIONS.map(x => x.name)).size, 5);
  for (const tool of SECURE_TOOL_DEFINITIONS) {
    assert.equal(tool.annotations.destructiveHint, true);
    assert.deepEqual(validateInput(tool.inputSchema, { id: "REQ-12" }), []);
    assert.ok(validateInput(tool.inputSchema, { id: "REQ-12", shell: "echo unsafe" }).length > 0);
    assert.ok(validateInput(tool.inputSchema, { id: "../invalid" }).length > 0);
  }
});

test("all secure operations fail closed without the required work item lifecycle gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-secure-tool-"));
  try {
    const git = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    const item = createWorkItem({
      id: "REQ-12",
      issue_number: 12,
      title: "Insufficient approval",
      risk_level: "low",
      delivery_required: true,
    });
    writeStore(root, {
      schema_version: 2, repository: "acme/demo", revision: 0,
      updated_at: new Date().toISOString(), items: { [item.id]: item },
    });
    for (const { name } of SECURE_TOOL_DEFINITIONS) {
      await assert.rejects(callSecureTool(name, { id: "REQ-12" }, { cwd: root }));
    }
    const lockPath = path.join(root, ".hulane", "opencode-operation-locks");
    assert.equal(fs.readdirSync(lockPath).length, 0, "locks must be cleaned after failures");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
