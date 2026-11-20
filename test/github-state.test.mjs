import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEvent, createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import {
  assertRevisionCanSync,
  createIssue,
  findIssueByTitlePrefix,
  hydrateItemFromGitHub,
  parseGitHubState,
  readGithubMeta,
  renameIssueTitle,
  serializeGitHubState,
  stateLabel,
  syncItemToGitHub,
} from "../hulane/scripts/lib/github-state.mjs";

test("GitHub state comment round-trips", () => {
  const item = createWorkItem({
    id: "BUG-7",
    issue_number: 7,
    title: "Broken pagination",
    risk_level: "medium",
    delivery_required: true,
  });
  assert.deepEqual(parseGitHubState(serializeGitHubState(item)), item);
  assert.equal(stateLabel("waiting_tag_confirm"), "hulane:waiting-tag-confirm");
});

test("unmanaged comment is ignored", () => {
  assert.equal(parseGitHubState("ordinary comment"), null);
});

test("V1.2 state comments receive V1.3 isolation defaults", () => {
  const legacy = createWorkItem({
    id: "REQ-8",
    issue_number: 8,
    title: "Legacy state",
    risk_level: "low",
    delivery_required: true,
  });
  delete legacy.worktree_path;
  delete legacy.rework_count;
  delete legacy.rework_limit;
  const body = `<!-- cmdb-dev-state:v2 -->\n\n\`\`\`cmdb-state\n${JSON.stringify(legacy)}\n\`\`\``;
  const migrated = parseGitHubState(body);
  assert.equal(migrated.worktree_path, null);
  assert.equal(migrated.rework_count, 0);
  assert.equal(migrated.rework_limit, 3);
});

test("sync rejects newer or divergent GitHub state revisions", () => {
  const local = createWorkItem({ id: "REQ-9", issue_number: 9, title: "Sync", risk_level: "low", delivery_required: true });
  assert.throws(() => assertRevisionCanSync(local, { ...local, revision: 2 }), /newer state revision/);
  assert.throws(() => assertRevisionCanSync(local, { ...local, title: "Divergent" }), /conflicts/);
  assert.equal(assertRevisionCanSync(local, structuredClone(local)), true);
});

test("historical Done remains readable without fabricating V2 evidence", () => {
  const historical = {
    ...createWorkItem({ id: "REQ-10", issue_number: 10, title: "Historical", risk_level: "low", delivery_required: true }),
    status: "done",
    issue_state: "closed",
    human_approval: "approved",
    tester_result: "passed",
    reviewer_result: "approved",
    pr_checks: "passed",
    merged_sha: "a".repeat(40),
    build_status: "passed",
    image_digest: `sha256:${"b".repeat(64)}`,
  };
  for (const field of ["required_checks_enforced", "registry_verified", "release_url", "sbom_status", "provenance_status", "sbom_digest", "provenance_digest", "legacy_completion", "spec_sync_required", "specs_synced", "specs_commit_sha", "spec_delta_dir"]) {
    delete historical[field];
  }
  const body = `<!-- cmdb-dev-state:v2 -->\n\n\`\`\`cmdb-state\n${JSON.stringify(historical)}\n\`\`\``;
  const migrated = parseGitHubState(body);
  assert.equal(migrated.status, "done");
  assert.equal(migrated.legacy_completion, true);
  assert.equal(migrated.registry_verified, false);
  // 规格层字段同样按祖父条款回填:存量 Done 不被 specs_synced 前置阻塞
  assert.equal(migrated.spec_sync_required, false);
  assert.equal(migrated.specs_synced, false);
});

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hulane-github-state-"));
}

function seedMeta(root, itemId, entry) {
  fs.mkdirSync(path.join(root, ".hulane"), { recursive: true });
  fs.writeFileSync(path.join(root, ".hulane", "github-meta.json"), `${JSON.stringify({ [itemId]: entry }, null, 2)}\n`);
}

function fakeRun(handlers) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    for (const handler of handlers) {
      const output = handler(args);
      if (output !== undefined) {
        if (output instanceof Error) throw output;
        return output;
      }
    }
    throw new Error(`gh ${args.join(" ")} failed: unhandled call in fake runner`);
  };
  return { calls, run };
}

const isCommentList = (args) => args[0] === "api" && args.at(-1).includes("/comments?per_page=100");
const isLabelCreate = (args) => args[0] === "label" && args[1] === "create";
const isIssueView = (args) => args[0] === "issue" && args[1] === "view";
const isIssueEdit = (args) => args[0] === "issue" && args[1] === "edit";
const isMethod = (args, method) => args[0] === "api" && args[1] === "--method" && args[2] === method;

test("first sync takes the full path, posts the comment, and records meta", () => {
  const root = temporaryRoot();
  const item = createWorkItem({ id: "REQ-21", issue_number: 21, title: "First sync", risk_level: "low", delivery_required: true });
  const { calls, run } = fakeRun([
    (args) => (isCommentList(args) && !args.includes("--paginate") ? "[]" : undefined),
    (args) => (isCommentList(args) ? "[]" : undefined),
    (args) => (isLabelCreate(args) ? "" : undefined),
    (args) => (isIssueView(args) ? JSON.stringify({ labels: [] }) : undefined),
    (args) => (isIssueEdit(args) ? "" : undefined),
    (args) => (args[0] === "api" && args.includes("--jq") ? "424242" : undefined),
  ]);

  const result = syncItemToGitHub(item, { repository: "org/first-sync", cwd: root, run });

  assert.equal(result.label, "hulane:waiting-approval");
  assert.deepEqual(readGithubMeta(root)[item.id], { comment_id: 424242, state_label: "hulane:waiting-approval" });
  assert.ok(calls.some((args) => isMethod(args, "POST")));
  assert.ok(calls.some((args) => isIssueEdit(args) && args.includes("--add-label", "hulane:waiting-approval")));
});

test("second sync uses the fast path with exactly the label edit and comment PATCH", () => {
  const root = temporaryRoot();
  const item = createWorkItem({ id: "REQ-22", issue_number: 22, title: "Fast path", risk_level: "low", delivery_required: true });
  const ready = applyEvent(item, "approve_requirement", { actor: "human:tester", evidence: "approved" });
  seedMeta(root, ready.id, { comment_id: 424242, state_label: "hulane:waiting-approval" });
  const { calls, run } = fakeRun([
    (args) => (isLabelCreate(args) ? "" : undefined),
    (args) => (isIssueEdit(args) ? "" : undefined),
    (args) => (isMethod(args, "PATCH") ? "" : undefined),
    (args) => (isCommentList(args) ? "[]" : undefined),
  ]);

  syncItemToGitHub(ready, { repository: "org/fast-path", cwd: root, run });

  assert.deepEqual(readGithubMeta(root)[ready.id], { comment_id: 424242, state_label: "hulane:ready" });
  const mutating = calls.filter((args) => !isLabelCreate(args));
  assert.equal(mutating.length, 2);
  assert.ok(mutating.some((args) => isIssueEdit(args) && args.includes("--add-label", "hulane:ready") && args.includes("--remove-label", "hulane:waiting-approval")));
  assert.ok(mutating.some((args) => isMethod(args, "PATCH") && args.some((value) => String(value).endsWith("/issues/comments/424242"))));
  assert.ok(!calls.some(isCommentList), "fast path must not list comments");
  assert.ok(!calls.some(isIssueView), "fast path must not read current labels");
});

test("fast path skips the label edit when the status label is unchanged", () => {
  const root = temporaryRoot();
  const item = createWorkItem({ id: "REQ-23", issue_number: 23, title: "Same label", risk_level: "low", delivery_required: true });
  seedMeta(root, item.id, { comment_id: 424242, state_label: "hulane:waiting-approval" });
  const { calls, run } = fakeRun([
    (args) => (isMethod(args, "PATCH") ? "" : undefined),
    (args) => (isLabelCreate(args) ? "" : undefined),
  ]);

  const result = syncItemToGitHub(item, { repository: "org/same-label", cwd: root, run });

  assert.equal(result.label, "hulane:waiting-approval");
  assert.deepEqual(readGithubMeta(root)[item.id], { comment_id: 424242, state_label: "hulane:waiting-approval" });
  assert.equal(calls.filter((args) => !isLabelCreate(args)).length, 1, "unchanged label must cost exactly one PATCH");
  assert.ok(!calls.some(isIssueEdit));
});

test("a 404 on the cached comment id falls back to the conservative full path", () => {
  const root = temporaryRoot();
  const item = createWorkItem({ id: "REQ-24", issue_number: 24, title: "Stale meta", risk_level: "low", delivery_required: true });
  seedMeta(root, item.id, { comment_id: 999999, state_label: "hulane:waiting-approval" });
  const managed = {
    id: 424242,
    updated_at: "2026-09-07T00:00:00Z",
    body: serializeGitHubState(item),
  };
  const { calls, run } = fakeRun([
    (args) => (isMethod(args, "PATCH") && args.some((value) => String(value).endsWith("/issues/comments/999999")) ? new Error("gh api failed: Not Found (HTTP 404)") : undefined),
    (args) => (isCommentList(args) && !args.includes("--paginate") ? JSON.stringify([managed]) : undefined),
    (args) => (isCommentList(args) ? "[]" : undefined),
    (args) => (isLabelCreate(args) ? "" : undefined),
    (args) => (isIssueView(args) ? JSON.stringify({ labels: [{ name: "hulane:blocked" }] }) : undefined),
    (args) => (isIssueEdit(args) ? "" : undefined),
    (args) => (isMethod(args, "PATCH") ? "" : undefined),
  ]);

  const result = syncItemToGitHub(item, { repository: "org/stale-meta", cwd: root, run });

  assert.equal(result.label, "hulane:waiting-approval");
  assert.deepEqual(readGithubMeta(root)[item.id], { comment_id: 424242, state_label: "hulane:waiting-approval" });
  assert.ok(calls.some((args) => isIssueEdit(args) && args.includes("--remove-label", "hulane:blocked")), "full path must clean stray state labels");
  assert.equal(calls.filter((args) => isMethod(args, "PATCH") && args.some((value) => String(value).endsWith("/issues/comments/999999"))).length, 1, "only the failed fast-path attempt may target the stale comment id");
});

test("hydrate records the managed comment id for later fast syncs", () => {
  const root = temporaryRoot();
  const item = createWorkItem({ id: "REQ-25", issue_number: 25, title: "Hydrate meta", risk_level: "low", delivery_required: true });
  const managed = { id: 555, updated_at: "2026-09-07T00:00:00Z", body: serializeGitHubState(item) };
  const { run } = fakeRun([
    (args) => (isCommentList(args) ? JSON.stringify([[managed]]) : undefined),
    (args) => (isIssueView(args) ? JSON.stringify({ number: 25, state: "open", url: "https://example.test/25", title: item.title }) : undefined),
  ]);

  const hydrated = hydrateItemFromGitHub({ repository: "org/hydrate", issueNumber: 25, cwd: root, run });

  assert.equal(hydrated.id, item.id);
  assert.equal(hydrated.issue_state, "open");
  assert.deepEqual(readGithubMeta(root)[item.id], { comment_id: 555, state_label: "hulane:waiting-approval" });
});

// REQ-11:pending 工单的 sync 统一降级——远端尚无 Issue,返回 skipped 而非抛错
test("sync degrades to skipped for issue_pending items without touching gh", () => {
  const root = temporaryRoot();
  const item = createWorkItem({
    id: "REQ-26",
    issue_pending: true,
    title: "Offline pending",
    risk_level: "low",
    delivery_required: false,
    delivery_reason: "batched release",
    skip_allowed: true,
  });
  const { calls, run } = fakeRun([]); // 任何 gh 调用都会抛错:短路必须零调用
  const result = syncItemToGitHub(item, { repository: "org/pending", cwd: root, run });
  assert.deepEqual(result, { skipped: "issue_pending", id: "REQ-26", issue_number: null, label: null, revision: item.revision });
  assert.equal(calls.length, 0);
  // 状态注释往返携带 pending 身份,hydrate 后不变量保持
  const roundTripped = parseGitHubState(serializeGitHubState(item));
  assert.equal(roundTripped.issue_pending, true);
  assert.equal(roundTripped.issue_number, null);
});

test("flush helpers precheck by title prefix, create, and rename idempotently", () => {
  const root = temporaryRoot();
  const { calls, run } = fakeRun([
    (args) => (args[0] === "issue" && args[1] === "list" ? JSON.stringify([
      { number: 5, title: "Stale mention of REQ-26 in body only", url: "https://github.com/org/pending/issues/5" },
      { number: 7, title: "REQ-26 Offline pending", url: "https://github.com/org/pending/issues/7" },
    ]) : undefined),
    (args) => (args[0] === "issue" && args[1] === "create" ? "https://github.com/org/pending/issues/9?x=1" : undefined),
    (args) => (args[0] === "issue" && args[1] === "edit" ? "" : undefined),
  ]);
  // 预查:只认 `<ID> ` 前缀(或恰好等于 ID),正文命中的 #5 不算
  const hit = findIssueByTitlePrefix({ repository: "org/pending", workItemId: "REQ-26", cwd: root, run });
  assert.deepEqual(hit, { number: 7, url: "https://github.com/org/pending/issues/7", title: "REQ-26 Offline pending" });
  // 未命中 → 补建,URL 带 query 也能解析编号
  const miss = findIssueByTitlePrefix({ repository: "org/pending", workItemId: "REQ-27", cwd: root, run });
  assert.equal(miss, null);
  const created = createIssue({ repository: "org/pending", title: "REQ-27 Next", body: "body", cwd: root, run });
  assert.deepEqual(created, { number: 9, url: "https://github.com/org/pending/issues/9?x=1" });
  // 复用路径标题落位
  renameIssueTitle({ repository: "org/pending", issueNumber: 7, title: "REQ-26 Offline pending", cwd: root, run });
  assert.ok(calls.some((args) => args[0] === "issue" && args[1] === "edit" && args.includes("7") && args.includes("REQ-26 Offline pending")));
});
