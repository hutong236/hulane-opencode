import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverFile = path.join(root, "hulane", "mcp", "server.mjs");

test("real MCP stdio JSON-RPC: offline Work Item, auto Gate A, Worktree, read state and fake human denied", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-real-mcp-"));
  let child;
  try {
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["config", "user.name", "Hulane Integration"], { cwd: project });
    execFileSync("git", ["config", "user.email", "hulane-integration@example.invalid"], { cwd: project });
    fs.writeFileSync(path.join(project, "README.md"), "sandbox\n");
    execFileSync("git", ["add", "."], { cwd: project });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: project });
    child = spawn(process.execPath, [serverFile], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });
    let counter = 0, stderr = "";
    const awaiting = new Map();
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on("line", line => {
      const message = JSON.parse(line);
      const entry = awaiting.get(message.id);
      if (entry) { awaiting.delete(message.id); entry.resolve(message); }
    });
    child.on("error", error => { for (const e of awaiting.values()) e.reject(error); awaiting.clear(); });
    function rpc(method, params = {}) {
      const id = ++counter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { awaiting.delete(id); reject(new Error("MCP timeout: " + method + " " + stderr)); }, 15000);
        awaiting.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    async function tool(name, args = {}) {
      const response = await rpc("tools/call", { name, arguments: args });
      assert.equal(response.error, undefined);
      return response.result;
    }
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "hulane-e2e", version: "1.0" } });
    assert.equal(init.result.serverInfo.name, "hulane-control");
    const listed = await rpc("tools/list");
    assert.ok(listed.result.tools.length >= 20);
    assert.ok(listed.result.tools.some(entry => entry.name === "hulane_secure_merge"));
    const opened = await tool("hulane_open_work_item", {
      title: "Offline MCP smoke", type: "feature", risk_level: "low", size: "standard",
      delivery_required: true, skip_allowed: false, planner_summary: "Test isolated Worktree",
      acceptance_criteria: ["MCP state can be read"],
    });
    assert.equal(opened.isError, undefined, opened.content?.[0]?.text);
    assert.equal(opened.structuredContent.item.id, "REQ-1");
    assert.equal(opened.structuredContent.item.status, "waiting_approval");
    const fake = await tool("hulane_transition", {
      id: "REQ-1", event: "approve_requirement", actor: "human:impersonated",
      evidence: "this is not an actual GitHub comment",
    });
    assert.equal(fake.isError, true, "string-based human approval must never open Gate A");
    const approved = await tool("hulane_transition", {
      id: "REQ-1", event: "approve_requirement", actor: "orchestrator",
      evidence: "low-risk auto-intake", patch: { approval_source: "auto_intake" },
    });
    assert.equal(approved.isError, undefined, approved.content?.[0]?.text);
    assert.equal(approved.structuredContent.item.status, "ready");
    const tree = await tool("hulane_worktree_create", {
      id: "REQ-1", actor: "orchestrator", evidence: "MCP-integration Worktree", base: "HEAD",
    });
    assert.equal(tree.isError, undefined, tree.content?.[0]?.text);
    assert.equal(tree.structuredContent.item.status, "planning");
    assert.ok(fs.existsSync(tree.structuredContent.worktree.path));
    const state = await tool("hulane_status", { id: "REQ-1" });
    assert.equal(state.structuredContent.item.status, "planning");
    assert.equal(state.structuredContent.item.issue_pending, true);
    assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: project, encoding: "utf8" }).includes(tree.structuredContent.worktree.path), true);
  } finally {
    if (child) { child.stdin.end(); child.kill(); }
    fs.rmSync(project, { recursive: true, force: true });
  }
});
