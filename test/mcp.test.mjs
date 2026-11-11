import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOL_DEFINITIONS, callTool } from "../hulane/mcp/tools.mjs";
import { validateInput } from "../hulane/mcp/validate.mjs";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { writeStore } from "../hulane/scripts/lib/state-store.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(repositoryRoot, "hulane", "mcp", "server.mjs");
const pluginRoot = path.join(repositoryRoot, "hulane");

function gitRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-mcp-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Hulane Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

const validCapabilitySpec = [
  "# billing Specification",
  "",
  "## Purpose",
  "",
  "中文目的。",
  "",
  "## Requirements",
  "",
  "### Requirement: 开票",
  "",
  "系统 SHALL 开票。",
  "",
  "#### Scenario: 正常开票",
  "",
  "- WHEN 已确认",
  "- THEN 开票",
].join("\n");

const validDeltaSpec = "## ADDED Requirements\n\n### Requirement: 开票\n\n#### Scenario: 正常开票\n";

// 提交树内含合法 openspec 规格,并把 REQ-1 停在 waiting_close(merged_sha=该提交)
function specsRepository({ malformed = false, withSpecs = true } = {}) {
  const root = gitRepository();
  if (withSpecs) {
    fs.mkdirSync(path.join(root, "openspec", "specs", "billing"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "openspec", "specs", "billing", "spec.md"),
      malformed
        ? "# billing Specification\n\n## Purpose\n\n## Requirements\n\n### Requirement: 开票\n\n系统 SHALL 开票。\n"
        : validCapabilitySpec,
    );
    fs.mkdirSync(path.join(root, "openspec", "changes", "archive", "REQ-1"), { recursive: true });
    fs.writeFileSync(path.join(root, "openspec", "changes", "archive", "REQ-1", "delta.md"), validDeltaSpec);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "specs"], { cwd: root });
  }
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const item = {
    ...createWorkItem({
      id: "REQ-1",
      issue_number: 1,
      title: "Spec sync",
      risk_level: "low",
      delivery_required: false,
      delivery_reason: "Docs only",
      skip_allowed: true,
    }),
    status: "waiting_close",
    human_approval: "approved",
    tester_result: "passed",
    reviewer_result: "approved",
    pr_checks: "passed",
    pr_check_name: "Hulane PR Checks / verify",
    pr_check_run_url: "https://github.com/acme/demo/actions/runs/456",
    pr_head_sha: "b".repeat(40),
    merge_guard_mode: "github_required_checks",
    required_checks_enforced: true,
    merged_sha: sha,
  };
  writeStore(root, { schema_version: 2, repository: "acme/demo", revision: 0, updated_at: new Date().toISOString(), items: { [item.id]: item } });
  return { root, sha, item };
}

test("MCP tool catalog is deterministic and input schemas reject extra fields", () => {
  assert.equal(TOOL_DEFINITIONS.length, 15);
  assert.equal(new Set(TOOL_DEFINITIONS.map((tool) => tool.name)).size, 15);
  const preflight = TOOL_DEFINITIONS.find((tool) => tool.name === "hulane_preflight");
  assert.deepEqual(validateInput(preflight.inputSchema, { unexpected: true }), ["arguments.unexpected is not allowed"]);
});

test("hulane_authorize_release validates version, sha, actor, evidence, and ttl bounds", () => {
  const tool = TOOL_DEFINITIONS.find((entry) => entry.name === "hulane_authorize_release");
  assert.ok(tool, "hulane_authorize_release must exist in the catalog");
  const base = { version: "v1.2.3", sha: "a".repeat(40), actor: "orchestrator", evidence: "user asked to release" };
  assert.deepEqual(validateInput(tool.inputSchema, base), []);
  for (const field of ["version", "sha", "evidence"]) {
    const { [field]: omitted, ...rest } = base;
    assert.ok(
      validateInput(tool.inputSchema, rest).some((error) => error.includes(`.${field}`)),
      `missing ${field} must be rejected`,
    );
  }
  assert.ok(validateInput(tool.inputSchema, { ...base, actor: "hulane-coder" }).some((error) => error.includes("actor")));
  assert.ok(validateInput(tool.inputSchema, { ...base, sha: "short" }).some((error) => error.includes("sha")));
  assert.ok(validateInput(tool.inputSchema, { ...base, ttl_seconds: 9 }).some((error) => error.includes("ttl_seconds")));
  assert.ok(validateInput(tool.inputSchema, { ...base, ttl_seconds: 601 }).some((error) => error.includes("ttl_seconds")));
  assert.ok(validateInput(tool.inputSchema, { ...base, unexpected: true }).some((error) => error.includes("unexpected")));
});

test("MCP server supports modern discovery and legacy initialization", () => {
  const root = gitRepository();
  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const messages = [
    { jsonrpc: "2.0", id: "discover", method: "server/discover", params: { _meta: modernMeta } },
    { jsonrpc: "2.0", id: "modern-list", method: "tools/list", params: { _meta: modernMeta } },
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hulane_initialize", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "hulane_validate", arguments: {} } },
  ];
  const result = spawnSync(process.execPath, [server], {
    cwd: root,
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(responses.find((response) => response.id === "discover").result.supportedVersions.includes("2026-07-28"));
  assert.equal(responses.find((response) => response.id === "modern-list").result.resultType, "complete");
  assert.equal(responses.find((response) => response.id === 1).result.protocolVersion, "2025-11-25");
  assert.equal(responses.find((response) => response.id === 2).result.tools.length, 20);
  assert.equal(responses.find((response) => response.id === 3).result.isError, undefined);
  assert.equal(responses.find((response) => response.id === 4).result.structuredContent.valid, true);
  assert.ok(fs.existsSync(path.join(root, ".hulane", "state.json")));
});

test("MCP server returns a protocol error for malformed tool input", () => {
  const root = gitRepository();
  const request = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "hulane_transition", arguments: { id: "bad" } } };
  const result = spawnSync(process.execPath, [server], { cwd: root, input: `${JSON.stringify(request)}\n`, encoding: "utf8" });
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.error.code, -32602);
});

test("generic transitions cannot bypass dedicated worktree, PR-check, or delivery evidence tools", () => {
  const root = gitRepository();
  assert.throws(() => callTool("hulane_transition", {
    id: "REQ-1",
    event: "image_verified",
    actor: "orchestrator",
    evidence: "forged",
    sync: false,
  }, { cwd: root, pluginRoot: path.join(repositoryRoot, "hulane") }), /reserved/);
  assert.throws(() => callTool("hulane_transition", {
    id: "REQ-1",
    event: "checks_passed",
    actor: "orchestrator",
    evidence: "forged",
    sync: false,
  }, { cwd: root, pluginRoot: path.join(repositoryRoot, "hulane") }), /reserved/);
  assert.throws(() => callTool("hulane_transition", {
    id: "REQ-1",
    event: "specs_synced",
    actor: "orchestrator",
    evidence: "forged",
    patch: { specs_commit_sha: "a".repeat(40), spec_delta_dir: "openspec/changes/archive/REQ-1" },
    sync: false,
  }, { cwd: root, pluginRoot: path.join(repositoryRoot, "hulane") }), /reserved/);
});

test("hulane_record_specs_synced validates the merged tree then records the evidence", () => {
  const { root, sha } = specsRepository();
  const result = callTool("hulane_record_specs_synced", {
    id: "REQ-1",
    actor: "orchestrator",
    evidence: "merged tree spec structure validated",
    specs_commit_sha: sha,
    spec_delta_dir: "openspec/changes/archive/REQ-1",
    sync: false,
  }, { cwd: root, pluginRoot });
  assert.equal(result.item.status, "waiting_close");
  assert.equal(result.item.specs_synced, true);
  assert.equal(result.item.specs_commit_sha, sha);
  assert.equal(result.specs_validation.commit, sha);
  assert.deepEqual(result.specs_validation.specs, [{ file: "openspec/specs/billing/spec.md", capability: "billing", requirements: 1 }]);
  assert.throws(() => callTool("hulane_record_specs_synced", {
    id: "REQ-1",
    actor: "orchestrator",
    evidence: "double record",
    specs_commit_sha: sha,
    spec_delta_dir: "openspec/changes/archive/REQ-1",
    sync: false,
  }, { cwd: root, pluginRoot }), /already recorded/);
});

test("hulane_record_specs_synced rejects malformed trees and mismatched SHAs", () => {
  const malformed = specsRepository({ malformed: true });
  assert.throws(() => callTool("hulane_record_specs_synced", {
    id: "REQ-1",
    actor: "orchestrator",
    evidence: "malformed",
    specs_commit_sha: malformed.sha,
    spec_delta_dir: "openspec/changes/archive/REQ-1",
    sync: false,
  }, { cwd: malformed.root, pluginRoot }), /Scenario/);

  const bare = specsRepository({ withSpecs: false });
  assert.throws(() => callTool("hulane_record_specs_synced", {
    id: "REQ-1",
    actor: "orchestrator",
    evidence: "no specs",
    specs_commit_sha: bare.sha,
    spec_delta_dir: "openspec/changes/archive/REQ-1",
    sync: false,
  }, { cwd: bare.root, pluginRoot }), /no openspec\/specs/);

  const { root, sha } = specsRepository();
  assert.throws(() => callTool("hulane_record_specs_synced", {
    id: "REQ-1",
    actor: "orchestrator",
    evidence: "wrong sha",
    specs_commit_sha: "c".repeat(40),
    spec_delta_dir: "openspec/changes/archive/REQ-1",
    sync: false,
  }, { cwd: root, pluginRoot }), /must equal the recorded merged_sha/);
});

// 假 gh 垫片：记录每次调用到 gh-calls.log，第 FAKE_GH_FAIL_ON 次调用模拟失败，
// `issue create` 输出固定 Issue URL，其余调用静默成功。
function fakeGhBin(sandbox) {
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const shim = [
    "#!/bin/sh",
    'sandbox="$(cd "$(dirname "$0")/.." && pwd)"',
    'printf \'%s\\n\' "$*" >> "$sandbox/gh-calls.log"',
    'n=$(cat "$sandbox/gh-counter" 2>/dev/null || echo 0)',
    "n=$((n + 1))",
    'printf \'%s\\n\' "$n" > "$sandbox/gh-counter"',
    'if [ -n "$FAKE_GH_FAIL_ON" ] && [ "$n" -eq "$FAKE_GH_FAIL_ON" ]; then',
    '  echo "simulated gh failure" >&2',
    "  exit 1",
    "fi",
    'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
    '  echo "https://github.com/example/org/issues/99"',
    "fi",
    "exit 0",
  ].join("\n");
  fs.writeFileSync(path.join(bin, "gh"), shim, { mode: 0o755 });
  return bin;
}

function withFakeGh(sandbox, fn) {
  const bin = fakeGhBin(sandbox);
  const previousPath = process.env.PATH;
  const previousFailOn = process.env.FAKE_GH_FAIL_ON;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  delete process.env.FAKE_GH_FAIL_ON;
  try {
    return fn(sandbox);
  } finally {
    process.env.PATH = previousPath;
    if (previousFailOn === undefined) delete process.env.FAKE_GH_FAIL_ON;
    else process.env.FAKE_GH_FAIL_ON = previousFailOn;
  }
}

// 断网垫片:gh 存在但每次调用必败(模拟网络不可达),仍记录调用日志——
// 日志文件缺失即证明零 gh 调用
function offlineGhBin(sandbox) {
  const bin = path.join(sandbox, "offline-bin");
  fs.mkdirSync(bin, { recursive: true });
  const shim = [
    "#!/bin/sh",
    'sandbox="$(cd "$(dirname "$0")/.." && pwd)"',
    'printf \'%s\\n\' "$*" >> "$sandbox/gh-calls.log"',
    'echo "simulated network unreachable" >&2',
    "exit 1",
  ].join("\n");
  fs.writeFileSync(path.join(bin, "gh"), shim, { mode: 0o755 });
  return bin;
}

function withOfflineGh(sandbox, fn) {
  const previousPath = process.env.PATH;
  process.env.PATH = `${offlineGhBin(sandbox)}${path.delimiter}${previousPath}`;
  try {
    return fn(sandbox);
  } finally {
    process.env.PATH = previousPath;
  }
}

// flush 垫片:支撑幂等预查(issue list 读 gh-issues.json)、补建(issue create)、
// 状态注释首发(POST 返回 424242)与全路径 sync(issue view/labels、评论列表空)
function flushGhBin(sandbox) {
  const bin = path.join(sandbox, "flush-bin");
  fs.mkdirSync(bin, { recursive: true });
  const shim = [
    "#!/bin/sh",
    'sandbox="$(cd "$(dirname "$0")/.." && pwd)"',
    'printf \'%s\\n\' "$*" >> "$sandbox/gh-calls.log"',
    'case "$1 $2" in',
    '  "issue list")',
    '    if [ -f "$sandbox/gh-issues.json" ]; then cat "$sandbox/gh-issues.json"; else echo "[]"; fi',
    "    ;;",
    '  "issue create")',
    '    echo "https://github.com/example/org/issues/99"',
    "    ;;",
    '  "issue view")',
    "    echo '{\"labels\":[]}'",
    "    ;;",
    "  *)",
    '    case "$*" in',
    '      *"api --method POST repos/"*"/comments"*) echo "424242" ;;',
    '      *"comments?per_page=100"*) echo "[]" ;;',
    "      *) : ;;",
    "    esac",
    "    ;;",
    "esac",
    "exit 0",
  ].join("\n");
  fs.writeFileSync(path.join(bin, "gh"), shim, { mode: 0o755 });
  return bin;
}

function withFlushGh(sandbox, fn) {
  const previousPath = process.env.PATH;
  process.env.PATH = `${flushGhBin(sandbox)}${path.delimiter}${previousPath}`;
  try {
    return fn(sandbox);
  } finally {
    process.env.PATH = previousPath;
  }
}

const openWorkItemArgs = {
  title: "Demo item",
  type: "feature",
  risk_level: "low",
  size: "small",
  delivery_required: false,
  delivery_reason: "batched release",
  skip_allowed: true,
  spec_sync_required: false,
  planner_summary: "demo",
  acceptance_criteria: ["demo criterion"],
  repository: "example/org",
};

test("open_work_item validates input before creating the GitHub Issue", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-open-"));
  const root = gitRepository();
  withFakeGh(sandbox, () => {
    // 历史六犯：non-runtime 发版策略缺 delivery_reason
    assert.throws(
      () => callTool("hulane_open_work_item", { ...openWorkItemArgs, delivery_reason: " " }, { cwd: root }),
      /Non-runtime delivery policy requires delivery_reason/,
    );
    // 历史第二类：small 必须 low
    assert.throws(
      () => callTool("hulane_open_work_item", { ...openWorkItemArgs, risk_level: "medium" }, { cwd: root }),
      /size small requires risk_level low/,
    );
    // 校验失败时 gh 绝不能被调用（否则又会留下孤儿 Issue）
    assert.equal(fs.existsSync(path.join(sandbox, "gh-calls.log")), false);
  });
});

test("open_work_item creates locally with zero gh calls while GitHub is unreachable", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-offline-open-"));
  const root = gitRepository();
  withOfflineGh(sandbox, () => {
    const result = callTool("hulane_open_work_item", openWorkItemArgs, { cwd: root });
    assert.equal(result.item.status, "waiting_approval");
    assert.equal(result.item.id, "REQ-1"); // 空 store,本地号从 1 起
    assert.equal(result.item.issue_pending, true);
    assert.equal(result.item.issue_number, null);
    assert.equal(result.item.github_issue_url, null);
    assert.equal(result.item.planner_summary, "demo");
    assert.deepEqual(result.item.acceptance_criteria, ["demo criterion"]);
    assert.deepEqual(result.github, { skipped: "issue_pending", id: "REQ-1", issue_number: null, label: null, revision: 1 });
    // 断网开单:全程零 gh 调用(垫片日志缺失),也不再有孤儿回滚
    assert.equal(fs.existsSync(path.join(sandbox, "gh-calls.log")), false);
    const projection = fs.readFileSync(result.projection_file, "utf8");
    assert.match(projection, /issue_pending: true/);
    assert.match(projection, /Issue 待补建（flush）/);
  });
});

test("local numbering merges REQ and BUG prefixes and never collides", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-local-number-"));
  const root = gitRepository();
  const req9 = createWorkItem({ id: "REQ-9", issue_number: 9, title: "Nine", risk_level: "low", delivery_required: false, delivery_reason: "docs", skip_allowed: true });
  const bug8 = createWorkItem({ id: "BUG-8", issue_number: 8, title: "Eight", risk_level: "low", delivery_required: false, delivery_reason: "docs", skip_allowed: true });
  writeStore(root, { schema_version: 2, repository: "example/org", revision: 0, updated_at: new Date().toISOString(), items: { [req9.id]: req9, [bug8.id]: bug8 } });
  withOfflineGh(sandbox, () => {
    const feature = callTool("hulane_open_work_item", { ...openWorkItemArgs, type: "feature" }, { cwd: root });
    assert.equal(feature.item.id, "REQ-10"); // REQ-9 + BUG-8 合并取最大 9 + 1
    const bug = callTool("hulane_open_work_item", { ...openWorkItemArgs, type: "bug" }, { cwd: root });
    assert.equal(bug.item.id, "BUG-11"); // REQ-10 已入 store,下一号 11
  });
});

test("pending transitions flow offline with unified sync degradation", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-offline-flow-"));
  const root = gitRepository();
  withOfflineGh(sandbox, () => {
    callTool("hulane_open_work_item", { ...openWorkItemArgs, risk_level: "medium", size: "standard", spec_sync_required: false }, { cwd: root });
    const approve = callTool("hulane_transition", {
      id: "REQ-1", event: "approve_requirement", actor: "orchestrator",
      evidence: "user asked offline", patch: { approval_source: "auto_intake" },
    }, { cwd: root });
    assert.equal(approve.item.status, "ready");
    assert.equal(approve.github.skipped, "issue_pending");
    // start_planning 走专用工具,同样离线成功
    const worktree = callTool("hulane_worktree_create", {
      id: "REQ-1", actor: "orchestrator", evidence: "offline worktree", base: "HEAD",
    }, { cwd: root });
    assert.equal(worktree.item.status, "planning");
    assert.equal(worktree.github.skipped, "issue_pending");
    const transitions = [
      { event: "plan_complete", actor: "orchestrator" },
      { event: "code_complete", actor: "orchestrator" },
      { event: "tests_passed", actor: "orchestrator" },
      { event: "review_approved", actor: "orchestrator" },
    ];
    for (const step of transitions) {
      const result = callTool("hulane_transition", {
        id: "REQ-1", event: step.event, actor: step.actor,
        evidence: `${step.event} offline evidence`,
      }, { cwd: root });
      assert.equal(result.item.issue_pending, true);
      assert.equal(result.github.skipped, "issue_pending");
    }
    const status = callTool("hulane_status", { id: "REQ-1", refresh_from_github: true }, { cwd: root });
    // remote-truth-wins 尊重 pending:刷新退化为只读本地,本地未动、零 gh
    assert.equal(status.item.status, "pr_open");
    assert.equal(status.item.issue_pending, true);
    assert.equal(status.facts, null);
    assert.equal(fs.existsSync(path.join(sandbox, "gh-calls.log")), false);
    // pr_created 对 pending 抛错:PR 必须挂在已补建的真实 Issue 上
    assert.throws(
      () => callTool("hulane_transition", {
        id: "REQ-1", event: "pr_created", actor: "orchestrator",
        evidence: "forged", patch: { pr_number: 5, github_pr_url: "https://github.com/example/org/pull/5" },
      }, { cwd: root }),
      /run hulane_flush first/,
    );
  });
});

test("issue_created is reserved for the flush tool", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-reserved-"));
  const root = gitRepository();
  withOfflineGh(sandbox, () => {
    callTool("hulane_open_work_item", openWorkItemArgs, { cwd: root });
    assert.throws(() => callTool("hulane_transition", {
      id: "REQ-1",
      event: "issue_created",
      actor: "orchestrator",
      evidence: "forged backfill",
      patch: { issue_number: 1, github_issue_url: "https://github.com/example/org/issues/1" },
      sync: false,
    }, { cwd: root }), /reserved/);
  });
});

function flushSandbox(prefix) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = gitRepository();
  const item = createWorkItem({
    id: "REQ-9",
    issue_pending: true,
    title: "Demo item",
    risk_level: "low",
    size: "small",
    delivery_required: false,
    delivery_reason: "batched release",
    skip_allowed: true,
    spec_sync_required: false,
    planner_summary: "demo",
    acceptance_criteria: ["demo criterion"],
  });
  writeStore(root, { schema_version: 2, repository: "example/org", revision: 0, updated_at: new Date().toISOString(), items: { [item.id]: item } });
  return { sandbox, root, item };
}

const flushArgs = { id: "REQ-9", actor: "orchestrator", evidence: "online window: Issue created and backfilled" };

test("hulane_flush creates, backfills, and syncs the final state in one window", () => {
  const { sandbox, root } = flushSandbox("hulane-flush-");
  withFlushGh(sandbox, () => {
    const result = callTool("hulane_flush", flushArgs, { cwd: root });
    assert.equal(result.issue_number, 99);
    assert.equal(result.issue_url, "https://github.com/example/org/issues/99");
    assert.equal(result.reused_existing_issue, false);
    assert.equal(result.item.issue_pending, false);
    assert.equal(result.item.issue_number, 99);
    assert.equal(result.item.github_issue_url, "https://github.com/example/org/issues/99");
    assert.equal(result.item.status, "waiting_approval"); // 自环不改状态
    assert.equal(result.item.history.at(-1).event, "issue_created");
    assert.equal(result.github.label, "hulane:waiting-approval");
    const calls = fs.readFileSync(path.join(sandbox, "gh-calls.log"), "utf8");
    assert.match(calls, /issue list [^]*REQ-9 in:title/); // 幂等预查先行
    const lines = calls.split("\n");
    const createIndex = lines.findIndex((line) => line.startsWith("issue create"));
    assert.ok(createIndex >= 0, "flush must create the Issue");
    assert.equal(lines.filter((line) => line.startsWith("issue create")).length, 1); // 补建恰好一次
    assert.match(lines[createIndex], /REQ-9 Demo item/); // 标题直接落 <ID> <title>
    // body 参数跨多行:截到下一条 gh 命令前,断言正文由持久化验收标准重建
    const nextCommand = lines.findIndex((line, index) => index > createIndex && /^(issue|label|api) /.test(line));
    const createBlock = lines.slice(createIndex, nextCommand === -1 ? undefined : nextCommand).join("\n");
    assert.match(createBlock, /demo criterion/);
    assert.match(createBlock, /Planner summary/);
    assert.match(calls, /--add-label hulane:waiting-approval/); // 最终标签一次到位
    assert.match(calls, /cmdb-dev-state:v2/); // 全量状态注释随一次 sync 发布
    // 注释携带最终 revision(created=1 + issue_created=2),hydrate 可取回等 revision 状态
    assert.match(calls, /"revision": 2/);
    // flush 后非 pending:再次 flush 引导改走 hulane_sync
    assert.throws(() => callTool("hulane_flush", flushArgs, { cwd: root }), /no pending GitHub Issue/);
  });
});

test("hulane_flush is idempotent: precheck hit reuses the existing Issue", () => {
  const { sandbox, root } = flushSandbox("hulane-flush-idem-");
  // 模拟 flush 中途断线:Issue 已建(远端存在)但本地回填未落,重跑 flush 复用
  fs.writeFileSync(
    path.join(sandbox, "gh-issues.json"),
    `${JSON.stringify([{ number: 77, title: "REQ-9 Demo item", url: "https://github.com/example/org/issues/77" }])}\n`,
  );
  withFlushGh(sandbox, () => {
    const result = callTool("hulane_flush", flushArgs, { cwd: root });
    assert.equal(result.reused_existing_issue, true);
    assert.equal(result.issue_number, 77);
    assert.equal(result.item.issue_number, 77);
    assert.equal(result.item.issue_pending, false);
    const calls = fs.readFileSync(path.join(sandbox, "gh-calls.log"), "utf8");
    assert.equal(calls.split("\n").filter((line) => line.includes("issue create")).length, 0); // 绝不重复建
    assert.match(calls, /issue edit 77 [^]*--title REQ-9 Demo item/); // 复用路径标题落位
  });
});
