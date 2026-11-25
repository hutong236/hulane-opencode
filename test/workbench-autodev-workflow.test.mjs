import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The scheduled workflow once lost its second half and still parsed, so every scheduled run reported success after
// doing nothing. These checks read the workflow as text on purpose: a truncated file must fail a test, not a parser.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github/workflows/workbench-autodev.yml"), "utf8");
const lines = workflow.split("\n");

function namedSteps() {
  const starts = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)- name: (.+)$/.exec(line);
    if (match) starts.push({ index, indent: match[1].length, name: match[2].trim() });
  });
  return starts.map((step) => {
    const end = lines.findIndex((line, index) => index > step.index
      && /^(\s*)-\s(?:name|uses):/.test(line) && RegExp.$1.length === step.indent);
    return { name: step.name, text: lines.slice(step.index, end === -1 ? undefined : end).join("\n") };
  });
}
const step = (name) => namedSteps().find((candidate) => candidate.name === name)?.text ?? "";

function runBlocks() {
  const blocks = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)run: \|$/.exec(line);
    if (!match) return;
    const indent = match[1].length + 2;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      if (lines[cursor].trim() !== "" && lines[cursor].search(/\S/) < indent) break;
      body.push(lines[cursor].slice(indent));
    }
    blocks.push({ line: index + 1, script: body.join("\n") });
  });
  return blocks;
}

test("the workflow keeps every stage of the bounded loop, in order", () => {
  assert.ok(workflow.endsWith("\n"), "the file ends in the middle of a step");
  assert.deepEqual(namedSteps().map((candidate) => candidate.name), [
    "Verify issue selection and safety logic",
    "Require credentials matching the selected model provider",
    "Select one ready Issue or failing PR",
    "Create or restore issue branch",
    "Install exact OpenCode V2 version",
    "Implement bounded change without GitHub credentials",
    "Verify change scope",
    "Run checks without any credentials",
    "Show the unpublished change",
    "Publish Draft pull request",
  ]);
});

test("every run block is valid bash and every here-document is terminated", () => {
  const blocks = runBlocks();
  assert.ok(blocks.length >= 5);
  for (const block of blocks) {
    assert.doesNotThrow(() => execFileSync("bash", ["-n"], { input: block.script, stdio: ["pipe", "ignore", "pipe"] }),
      `run block at line ${block.line}`);
  }
  const opened = {};
  const closed = {};
  for (const line of lines) {
    // A here-document starts after whitespace; `name<<MARKER` inside an echo is GitHub Actions' multi-line output.
    for (const match of line.matchAll(/(^|\s)<<-?\s*'?([A-Z_]+)'?/g)) opened[match[2]] = (opened[match[2]] ?? 0) + 1;
    const tag = /^([A-Z_]+)$/.exec(line.trim());
    if (tag) closed[tag[1]] = (closed[tag[1]] ?? 0) + 1;
  }
  assert.ok(Object.keys(opened).length >= 2);
  assert.deepEqual(closed, opened);
});

test("the model agent can only read and edit the allowed paths", () => {
  const block = step("Implement bounded change without GitHub credentials");
  const config = /<<'JSON'\n([\s\S]*?)\n\s*JSON\n/.exec(block);
  assert.ok(config, "the agent configuration is missing or unterminated");
  const agent = JSON.parse(config[1]).agents.autodev;
  assert.equal(agent.mode, "primary");
  assert.ok(agent.steps > 0 && agent.steps <= 120);
  // Rules are applied in order and the last match wins: everything is denied first, then read and scoped edit only.
  assert.deepEqual(agent.permissions, [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "edit", resource: "workbench/*", effect: "allow" },
    { action: "edit", resource: "docs/WORKBENCH_AUTODEV_LOG.md", effect: "allow" },
  ]);
  assert.match(block, /export OPENCODE_CONFIG="\$RUNNER_TEMP\/wb-agent\.json"/);
  assert.match(block, /--agent autodev/);
  // The hand-written handoff is the one file every hand-made branch edits at the same place.
  assert.ok(!block.includes("SESSION_HANDOFF.md"), "the model must not be pointed at the hand-written handoff");
  assert.match(block, /--standalone/);
  // --auto would approve every permission that is not explicitly denied.
  assert.ok(!block.includes("--auto"));
});

test("no GitHub credential reaches the model, and the publishing token is confined to two steps", () => {
  assert.ok(workflow.includes("persist-credentials: false"));
  const withToken = namedSteps().filter((candidate) => candidate.text.includes("WORKBENCH_AUTODEV_TOKEN"));
  assert.deepEqual(withToken.map((candidate) => candidate.name),
    ["Require credentials matching the selected model provider", "Publish Draft pull request"]);
  const withReadToken = namedSteps().filter((candidate) => /GH_TOKEN|github\.token/.test(candidate.text));
  assert.deepEqual(withReadToken.map((candidate) => candidate.name),
    ["Select one ready Issue or failing PR", "Publish Draft pull request"]);
});

test("publishing needs passing checks and can only open or update a Draft", () => {
  const publish = step("Publish Draft pull request");
  assert.match(publish, /if: .*steps\.verify\.outputs\.changed == 'true'/);
  assert.match(publish, /if: .*steps\.checks\.outputs\.pass == 'true'/);
  assert.match(publish, /gh pr create --draft/);
  for (const forbidden of ["--force", "--admin", "gh pr merge", "gh pr ready", "gh pr close", "gh issue close"]) {
    assert.ok(!publish.includes(forbidden), `publish step must not contain ${forbidden}`);
  }
  assert.match(step("Run checks without any credentials"), /test "\$pass" = true/,
    "a failing check must fail the run instead of leaving it green");
});

test("the handoff merges with the union driver, so concurrent checkpoints never conflict", () => {
  // Every autonomous run prepends a checkpoint to the same place as every hand-made branch.
  const attributes = readFileSync(path.join(root, ".gitattributes"), "utf8");
  assert.match(attributes, /^docs\/SESSION_HANDOFF\.md merge=union$/m);
  assert.match(attributes, /^docs\/WORKBENCH_AUTODEV_LOG\.md merge=union$/m);
});
