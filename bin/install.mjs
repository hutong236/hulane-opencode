#!/usr/bin/env node
// Install the independently maintained Hulane OpenCode V2 adapter into a TARGET project.
// Refuses ambiguous JSONC and collisions unless --force is explicitly supplied.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(self), "..");
const argv = process.argv.slice(2);
const valueFor = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(name + " requires a path");
  return argv[i + 1];
};
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const projectArg = valueFor("--project");
if (!projectArg || argv.includes("--help")) {
  console.log("Usage: node bin/install.mjs --project <existing-project-dir> [--dry-run] [--force]");
  process.exit(projectArg ? 0 : 2);
}
const project = path.resolve(projectArg);
if (!fs.statSync(project, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Project directory does not exist: " + project);
if (project === packageRoot) throw new Error("Install into a business repository, not the Hulane source checkout");
const configPath = path.join(project, "opencode.json");
let config = {};
if (fs.existsSync(configPath)) {
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch { throw new Error("Existing opencode.json is JSONC or malformed; merge manually instead of overwriting"); }
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("Invalid project OpenCode config");
}
if (fs.existsSync(path.join(project, "opencode.jsonc")) && !fs.existsSync(configPath)) {
  throw new Error("opencode.jsonc exists; merge the documented plugin/MCP/permissions manually");
}
const copySpecs = [
  ["commands", path.join(packageRoot, "opencode", "commands")],
  ["agents", path.join(packageRoot, "opencode", "agents")],
  ["skills", path.join(packageRoot, "opencode", "skills")],
];
const planned = [];
const walk = (source, target) => {
  for (const dirent of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, dirent.name);
    const to = path.join(target, dirent.name);
    if (dirent.isDirectory()) walk(from, to);
    else if (dirent.isFile()) planned.push({ from, to, content: fs.readFileSync(from) });
  }
};
for (const [type, source] of copySpecs) walk(source, path.join(project, ".opencode", type));
const currentPlugins = Array.isArray(config.plugins) ? config.plugins : [];
const cleanedPlugins = currentPlugins.filter((value) =>
  value !== packageRoot && !(value && typeof value === "object" && value.package === packageRoot));
const existingServers = config.mcp?.servers ?? {};
const expectedServer = {
  type: "local",
  command: [process.execPath, path.join(packageRoot, "hulane", "mcp", "server.mjs")],
  cwd: ".",
  codemode: false,
  disabled: false
};
if (existingServers["hulane-control"] && !force && JSON.stringify(existingServers["hulane-control"]) !== JSON.stringify(expectedServer)) {
  throw new Error("Existing mcp.servers.hulane-control entry conflicts; use --force after review");
}
const expected = {
  ...config,
  $schema: config.$schema ?? "https://opencode.ai/config.json",
  plugins: [...cleanedPlugins, { package: packageRoot }],
  mcp: {
    ...(config.mcp ?? {}),
    servers: {
      ...existingServers,
      "hulane-control": {
        type: "local",
        command: [process.execPath, path.join(packageRoot, "hulane", "mcp", "server.mjs")],
        cwd: ".",
        codemode: false,
        disabled: false
      }
    }
  }
};
const existingRules = Array.isArray(config.permissions) ? [...config.permissions] : [];
const shellAsk = { action: "shell", resource: "*", effect: "ask" };
const mcpDeny = { action: "hulane-control_*", resource: "*", effect: "deny" };
// OpenCode V2: last matching permission wins. Project rules may adjust shell
// defaults, but MUST NOT turn the Hulane authority MCP back into allow.
// Remove earlier duplicate denials so that repeated installs remain stable.
const projectRules = existingRules.filter(rule =>
  !(rule?.action === mcpDeny.action && rule?.resource === mcpDeny.resource && rule?.effect === mcpDeny.effect));
expected.permissions = [
  ...(existingRules.some(rule => JSON.stringify(rule) === JSON.stringify(shellAsk)) ? [] : [shellAsk]),
  ...projectRules,
  mcpDeny
];
const configText = JSON.stringify(expected, null, 2) + "\n";
const existingFiles = planned.filter(({ to, content }) => fs.existsSync(to) && !fs.readFileSync(to).equals(content));
if (existingFiles.length && !force && !dryRun) {
  throw new Error("Existing files differ; refusing overwrite: " + existingFiles.map(x => x.to).join(", "));
}
console.log("Project: " + project);
console.log("Hulane source: " + packageRoot);
console.log("Files: " + planned.length + "; config: " + configPath + (dryRun ? " [dry run]" : ""));
if (dryRun) {
  console.log(JSON.stringify(expected, null, 2));
  process.exit(0);
}
const backup = (file) => {
  if (!fs.existsSync(file)) return;
  fs.copyFileSync(file, file + ".hulane-opencode.bak." + Date.now());
};
for (const { to, content } of planned) {
  if (fs.existsSync(to) && fs.readFileSync(to).equals(content)) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) backup(to);
  fs.writeFileSync(to, content);
}
if (!fs.existsSync(configPath) || fs.readFileSync(configPath, "utf8") !== configText) {
  if (fs.existsSync(configPath)) backup(configPath);
  fs.writeFileSync(configPath, configText, { mode: 0o600 });
}
console.log("Installed. Run: opencode mcp list; then /hulane_check.");
console.log("SECURITY: verify shell hook and protected Git operations in a sandbox before production use.");
