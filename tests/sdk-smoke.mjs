// OpenCode SDK runtime smoke; execute under Node.js 22+ with type stripping.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../opencode/plugin/index.ts";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { writeStore } from "../hulane/scripts/lib/state-store.mjs";

assert.equal(typeof plugin.setup, "function", "OpenCode V2 Plugin.define must expose setup");
const callbacks = {};
await plugin.setup({
  location: { directory: process.cwd(), project: { id: "test", directory: process.cwd(), canonical: process.cwd() } },
  shell: { hook: async (event, callback) => { callbacks["shell:" + event] = callback; } },
  permission: { hook: async (event, callback) => { callbacks["permission:" + event] = callback; } },
  tool: { hook: async (event, callback) => { callbacks["tool:" + event] = callback; } }
});
assert.equal(typeof callbacks["shell:create.before"], "function");
assert.equal(typeof callbacks["permission:evaluate"], "function");
const unsafeCoder = { agent: "hulane-coder", action: "edit", resources: ["src/index.js"], effect: "allow" };
callbacks["permission:evaluate"](unsafeCoder);
assert.equal(unsafeCoder.effect, "deny", "Unapproved coder edit must be rejected");
assert.equal(typeof callbacks["tool:execute.before"], "function");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-sdk-smoke-"));
try {
  const git = spawnSync("git", ["init", "-q"], { cwd: sandbox, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  writeStore(sandbox, {
    schema_version: 2, repository: "acme/demo", revision: 0, updated_at: new Date().toISOString(),
    items: { "REQ-12": { ...createWorkItem({ id: "REQ-12", issue_number: 12, title: "Smoke", risk_level: "low", delivery_required: true }), status: "doing" } }
  });
  assert.doesNotThrow(() => callbacks["shell:create.before"]({ command: "git status", cwd: sandbox, env: {} }));
  assert.throws(() => callbacks["shell:create.before"]({ command: "git push origin HEAD", cwd: sandbox, env: {} }), /Hulane Git gate|authorization|token/i);
  assert.throws(() => callbacks["shell:create.before"]({ command: "git commit --no-verify", cwd: sandbox, env: {} }), /Hulane discipline|bypass/i);
  console.log("OpenCode V2 Plugin.define + native shell/tool hook smoke PASSED");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
