import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "bin/install.mjs");
const execute = (project, ...args) => spawnSync(process.execPath, [installer, "--project", project, ...args], { encoding: "utf8" });
const createProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "hulane-opencode-"));

test("installer dry-run is nonmutating and shows MCP and plugin plan", () => {
  const project = createProject();
  try {
    const r = execute(project, "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /hulane-control/);
    assert.match(r.stdout, /"plugins"/);
    assert.equal(fs.existsSync(path.join(project, "opencode.json")), false);
    assert.equal(fs.existsSync(path.join(project, ".opencode")), false);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("installer copies ten commands, eight agents, and skill to the target repo", () => {
  const project = createProject();
  try {
    const r = execute(project);
    assert.equal(r.status, 0, r.stderr);
    const commands = fs.readdirSync(path.join(project, ".opencode", "commands")).filter(x => x.endsWith(".md"));
    const agents = fs.readdirSync(path.join(project, ".opencode", "agents")).filter(x => x.endsWith(".md"));
    assert.equal(commands.length, 10);
    assert.equal(agents.length, 8);
    assert.equal(fs.existsSync(path.join(project, ".opencode", "skills", "hulane-development", "SKILL.md")), true);
    const cfg = JSON.parse(fs.readFileSync(path.join(project, "opencode.json"), "utf8"));
    assert.equal(cfg.mcp.servers["hulane-control"].type, "local");
    assert.equal(cfg.mcp.servers["hulane-control"].cwd, ".");
    assert.equal(cfg.mcp.servers["hulane-control"].codemode, false);
    assert.ok(cfg.permissions.some(rule => rule.action === "hulane-control_*" && rule.effect === "deny"));
    const orchestrator = fs.readFileSync(path.join(project, ".opencode", "agents", "hulane-orchestrator.md"), "utf8");
    assert.match(orchestrator, /action: "hulane-control_\*"[\s\S]*?effect: ask/);
    assert.equal(cfg.plugins[0].package, root);
    assert.equal(execute(project).status, 0);
    const rerun = JSON.parse(fs.readFileSync(path.join(project, "opencode.json"), "utf8"));
    assert.equal(rerun.plugins.length, 1);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("installer preserves preexisting JSON config, backs it up, preserves stronger rules", () => {
  const project = createProject();
  try {
    fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({
      custom: { stable: true },
      permissions: [{ action: "shell", resource: "*", effect: "deny" }]
    }));
    const r = execute(project);
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(fs.readFileSync(path.join(project, "opencode.json"), "utf8"));
    assert.deepEqual(cfg.custom, { stable: true });
    assert.deepEqual(cfg.permissions.at(-1), { action: "shell", resource: "*", effect: "deny" });
    assert.ok(fs.readdirSync(project).some(x => x.startsWith("opencode.json.hulane-opencode.bak.")));
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("installer refuses ambiguous JSONC and existing command collision", () => {
  const project = createProject();
  try {
    fs.writeFileSync(path.join(project, "opencode.jsonc"), "{ // do not rewrite me\n }");
    assert.notEqual(execute(project).status, 0);
    fs.rmSync(path.join(project, "opencode.jsonc"));
    fs.mkdirSync(path.join(project, ".opencode", "commands"), { recursive: true });
    const file = path.join(project, ".opencode", "commands", "hulane_dev.md");
    fs.writeFileSync(file, "user's custom command");
    assert.equal(execute(project, "--dry-run").status, 0);
    assert.notEqual(execute(project).status, 0);
    assert.equal(fs.readFileSync(file,"utf8"), "user's custom command");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("OpenCode V2 adapter declares native hooks, all command/agent frontmatter is migrated", () => {
  const plugin = fs.readFileSync(path.join(root, "opencode", "plugin", "index.ts"), "utf8");
  assert.match(plugin, /Plugin\.define\(/);
  assert.match(plugin, /ctx\.shell\.hook\("create\.before"/);
  assert.match(plugin, /ctx\.tool\.hook\("execute\.before"/);
  for (const kind of ["commands", "agents"]) {
    for (const name of fs.readdirSync(path.join(root, "opencode", kind))) {
      const md = fs.readFileSync(path.join(root, "opencode", kind, name), "utf8");
      assert.match(md, /^---\n/);
      assert.doesNotMatch(md.slice(0, md.indexOf("\n---", 4)), /injectAgentsMd|maxTurns|^tools:/m);
    }
  }
});


test("MCP authority is denied globally and allowed only as orchestrator ask", () => {
  const base = path.join(root, "opencode", "agents");
  const names = fs.readdirSync(base).filter(x => x.endsWith(".md"));
  assert.equal(names.length, 8);
  for (const name of names) {
    const md = fs.readFileSync(path.join(base, name), "utf8");
    const front = md.split("\n---\n")[0];
    if (name === "hulane-orchestrator.md") {
      assert.match(front, /action: "hulane-control_\*"[\s\S]*?effect: ask/);
    } else {
      assert.match(front, /action: "\*"[\s\S]*?effect: deny/);
      assert.doesNotMatch(front, /action: "hulane-control_\*"/);
    }
  }
});

test("designer may edit only its generated prototype location", () => {
  const md = fs.readFileSync(path.join(root, "opencode", "agents", "hulane-designer.md"), "utf8");
  const front = md.split("\n---\n")[0];
  assert.match(front, /resource: "\.hulane\/designs\/\*\*"[\s\S]*?effect: ask/);
  assert.doesNotMatch(front, /action: "edit"\s+resource: "\*"\s+effect: allow/);
});
