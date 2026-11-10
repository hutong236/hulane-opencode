import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, createWorkItem, nextLocalWorkItemNumber, normalizeWorkItem, validateWorkItem, validateWorkItemInput } from "../hulane/scripts/lib/state-machine.mjs";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const githubGuard = {
  pr_check_name: "Hulane PR Checks / verify",
  pr_check_run_url: "https://github.com/acme/demo/actions/runs/456",
  pr_head_sha: sha,
  merge_guard_mode: "github_required_checks",
  required_checks_enforced: true,
};
const deliveryPatch = {
  image: "ghcr.io/acme/demo",
  image_tag: "v1.4.0",
  image_digest: digest,
  workflow_run_url: "https://github.com/acme/demo/actions/runs/123",
  registry_verified: true,
  release_url: "https://github.com/acme/demo/releases/tag/v1.4.0",
  sbom_status: "verified",
  provenance_status: "verified",
  sbom_digest: `sha256:${"c".repeat(64)}`,
  provenance_digest: `sha256:${"d".repeat(64)}`,
};
const clock = () => new Date("2026-08-31T12:00:00Z");

function runtimeItem(overrides = {}) {
  return createWorkItem({
    id: "REQ-12",
    issue_number: 12,
    title: "Runtime change",
    risk_level: "low",
    delivery_required: true,
    skip_allowed: false,
    ...overrides,
  }, clock);
}

function move(item, event, patch = {}, actor = "orchestrator") {
  return applyEvent(item, event, { actor, evidence: `${event} evidence`, patch }, clock);
}

const specSyncPatch = { specs_commit_sha: sha, spec_delta_dir: "openspec/changes/archive/REQ-12" };

// 非运行时条目停在 waiting_close:与 skip 路径同构,免受镜像交付不变式干扰
function waitingCloseItem(overrides = {}, fieldOverrides = {}) {
  return {
    ...runtimeItem({
      delivery_required: false,
      delivery_reason: "Documentation and specs; on-demand batched release",
      skip_allowed: true,
      ...overrides,
    }),
    status: "waiting_close",
    human_approval: "approved",
    tester_result: "passed",
    reviewer_result: "approved",
    pr_checks: "passed",
    ...githubGuard,
    merged_sha: sha,
    ...fieldOverrides,
  };
}

test("human gates reject agent actors", () => {
  const item = runtimeItem();
  assert.throws(() => move(item, "approve_requirement"), /human:<identity>/);
  const approved = move(item, "approve_requirement", {}, "human:owner");
  assert.equal(approved.status, "ready");
  assert.equal(approved.human_approval, "approved");
});

test("runtime work cannot skip image delivery", () => {
  const item = { ...runtimeItem(), status: "waiting_tag_confirm", human_approval: "approved" };
  assert.throws(() => move(item, "approve_skip", {}, "human:owner"), /skip is forbidden/);
});

test("non-runtime work may complete through an explicit human skip", () => {
  let item = runtimeItem({
    delivery_required: false,
    delivery_reason: "Documentation only",
    skip_allowed: true,
  });
  item = { ...item, status: "waiting_tag_confirm", human_approval: "approved", tester_result: "passed", reviewer_result: "approved", pr_checks: "passed", ...githubGuard, merged_sha: sha };
  item = move(item, "approve_skip", {}, "human:owner");
  assert.equal(item.status, "waiting_close");
  assert.equal(item.build_status, "skipped");
  item = move(item, "specs_synced", specSyncPatch);
  item = move(item, "issue_closed");
  assert.equal(item.status, "done");
  assert.equal(validateWorkItem(item), true);
});

test("skip-allowed work closes itself via policy_skip after merge", () => {
  let item = runtimeItem({
    risk_level: "low",
    delivery_required: false,
    delivery_reason: "UI tweak; on-demand batched release",
    skip_allowed: true,
  });
  item = { ...item, status: "waiting_tag_confirm", human_approval: "approved", tester_result: "passed", reviewer_result: "approved", pr_checks: "passed", ...githubGuard, merged_sha: sha };
  item = move(item, "policy_skip", {}, "orchestrator");
  assert.equal(item.status, "waiting_close");
  assert.equal(item.tag_confirmation, "skipped_by_policy");
  assert.equal(item.build_status, "skipped");
  assert.equal(item.next_action, "close_issue");
  item = move(item, "specs_synced", specSyncPatch);
  item = move(item, "issue_closed");
  assert.equal(item.status, "done");
  assert.equal(validateWorkItem(item), true);
});

test("policy_skip stays bound to the persisted skip policy and Gate A approval", () => {
  const runtime = { ...runtimeItem(), status: "waiting_tag_confirm", human_approval: "approved" };
  assert.throws(() => move(runtime, "policy_skip"), /skip is forbidden/);

  const unapproved = runtimeItem({
    delivery_required: false,
    delivery_reason: "Documentation only",
    skip_allowed: true,
  });
  const pending = { ...unapproved, status: "waiting_tag_confirm" };
  assert.throws(() => move(pending, "policy_skip"), /Gate A approval/);

  const midMerge = { ...unapproved, status: "merging", human_approval: "approved" };
  assert.throws(() => move(midMerge, "policy_skip"), /Invalid transition/);
});

test("size classifies the intake lane and stays consistent with risk", () => {
  const small = createWorkItem({
    id: "REQ-31",
    issue_number: 31,
    title: "Button copy tweak",
    risk_level: "low",
    size: "small",
    delivery_required: false,
    delivery_reason: "UI tweak; on-demand batched release",
    skip_allowed: true,
  }, clock);
  assert.equal(small.size, "small");

  assert.throws(() => runtimeItem({ risk_level: "medium", size: "small" }), /size small requires risk_level low/);
  assert.throws(() => runtimeItem({ size: "tiny" }), /size must be one of/);
  assert.equal(runtimeItem().size, "standard");
  assert.equal(runtimeItem().spec_sync_required, true);
  assert.equal(small.spec_sync_required, false);
  assert.throws(
    () => createWorkItem({
      id: "REQ-32",
      issue_number: 32,
      title: "Small with specs",
      risk_level: "low",
      size: "small",
      delivery_required: false,
      delivery_reason: "UI tweak",
      skip_allowed: true,
      spec_sync_required: true,
    }, clock),
    /never requires spec sync/,
  );

  const escalated = move({ ...small, status: "waiting_approval" }, "approve_requirement", { size: "standard" }, "human:owner");
  assert.equal(escalated.size, "standard");
  assert.throws(
    () => validateWorkItem({ ...small, risk_level: "medium" }),
    /size small requires low risk/,
  );
});

test("image verification requires a digest", () => {
  const item = { ...runtimeItem(), status: "building", human_approval: "approved", tester_result: "passed", reviewer_result: "approved", pr_checks: "passed", ...githubGuard, merged_sha: sha };
  assert.throws(() => move(item, "image_verified"), /image_digest/);
  const verified = move(item, "image_verified", deliveryPatch);
  assert.equal(verified.status, "waiting_close");
  assert.equal(verified.build_status, "passed");
});

test("Gate C persists the exact SemVer tag before tag authorization", () => {
  const item = { ...runtimeItem(), status: "waiting_tag_confirm", human_approval: "approved", merged_sha: sha };
  assert.throws(() => move(item, "approve_tag", {}, "human:owner"), /image_tag/);
  const approved = move(item, "approve_tag", { image_tag: "v2.0.0" }, "human:owner");
  assert.equal(approved.status, "building");
  assert.equal(approved.image_tag, "v2.0.0");
});

test("checks_passed requires persisted merge-guard evidence", () => {
  const item = {
    ...runtimeItem(),
    status: "pr_checking",
    human_approval: "approved",
    tester_result: "passed",
    reviewer_result: "approved",
    pr_number: 42,
  };
  assert.throws(() => move(item, "checks_passed"), /merge-guard evidence/);
  const checked = move(item, "checks_passed", githubGuard);
  assert.equal(checked.status, "merging");
  assert.equal(checked.required_checks_enforced, true);
});

test("control-plane checks auto-merge at low/medium risk", () => {
  const item = {
    ...runtimeItem({ risk_level: "medium" }),
    status: "pr_checking",
    human_approval: "approved",
    tester_result: "passed",
    reviewer_result: "approved",
    pr_number: 42,
  };
  const checked = move(item, "checks_passed", {
    ...githubGuard,
    merge_guard_mode: "control_plane_verified",
    required_checks_enforced: false,
  });
  assert.equal(checked.status, "merging");
  assert.equal(checked.merge_guard_mode, "control_plane_verified");
  assert.equal(checked.next_action, "merge_pr");
});

test("high-risk checks stop at human Gate B under either guard mode", () => {
  const base = {
    status: "pr_checking",
    human_approval: "approved",
    tester_result: "passed",
    reviewer_result: "approved",
    pr_number: 42,
  };
  const githubHigh = move(
    { ...runtimeItem({ risk_level: "high" }), ...base },
    "checks_passed",
    githubGuard,
  );
  assert.equal(githubHigh.status, "waiting_human_merge");
  assert.equal(githubHigh.next_action, "human_merge_approval");
  const controlPlaneHigh = move(
    { ...runtimeItem({ risk_level: "high" }), ...base },
    "checks_passed",
    { ...githubGuard, merge_guard_mode: "control_plane_verified", required_checks_enforced: false },
  );
  assert.equal(controlPlaneHigh.status, "waiting_human_merge");
});

test("planning requires an isolated branch and worktree", () => {
  let item = move(runtimeItem(), "approve_requirement", {}, "human:owner");
  assert.throws(() => move(item, "start_planning"), /requires branch/);
  item = move(item, "start_planning", { branch: "hulane/req-12", worktree_path: "/repo/.hulane/worktrees/REQ-12" });
  assert.equal(item.status, "planning");
  assert.equal(item.branch, "hulane/req-12");
});

test("fourth rework failure blocks and human resume resets the budget", () => {
  let item = move(runtimeItem(), "approve_requirement", {}, "human:owner");
  item = move(item, "start_planning", { branch: "hulane/req-12", worktree_path: "/repo/.hulane/worktrees/REQ-12" });
  item = move(item, "plan_complete");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    item = move(item, "code_complete");
    item = move(item, "tests_failed");
    if (attempt <= 3) assert.equal(item.status, "doing");
  }
  assert.equal(item.status, "blocked");
  assert.equal(item.rework_count, 4);
  item = applyEvent(item, "resume", {
    actor: "human:owner",
    evidence: "Human reviewed repeated failures",
    to: "testing",
  }, clock);
  assert.equal(item.status, "testing");
  assert.equal(item.rework_count, 0);
});

test("specs_synced is a waiting_close self-loop gated by full evidence", () => {
  const base = waitingCloseItem();
  assert.throws(() => move({ ...base, merged_sha: null }, "specs_synced", specSyncPatch), /merged_sha/);
  assert.throws(
    () => move(base, "specs_synced", { ...specSyncPatch, specs_commit_sha: "not-a-sha" }),
    /40-character specs_commit_sha/,
  );
  assert.throws(() => move(base, "specs_synced", { ...specSyncPatch, spec_delta_dir: "   " }), /spec_delta_dir/);

  const synced = move(base, "specs_synced", specSyncPatch);
  assert.equal(synced.status, "waiting_close");
  assert.equal(synced.specs_synced, true);
  assert.equal(synced.specs_commit_sha, sha);
  assert.equal(synced.spec_delta_dir, "openspec/changes/archive/REQ-12");
  assert.equal(synced.next_action, "close_issue");
});

test("specs_commit_sha must equal the recorded merged_sha", () => {
  const base = waitingCloseItem();
  assert.throws(
    () => move(base, "specs_synced", { ...specSyncPatch, specs_commit_sha: "b".repeat(40) }),
    /specs_commit_sha to equal the recorded merged_sha/,
  );
  const mismatchedDone = {
    ...base,
    status: "done",
    issue_state: "closed",
    specs_synced: true,
    specs_commit_sha: "b".repeat(40),
    spec_delta_dir: "openspec/changes/archive/REQ-12",
  };
  assert.throws(() => validateWorkItem(mismatchedDone), /specs_commit_sha to equal merged_sha/);
});

test("spec_sync_required items cannot close or reach done without specs_synced", () => {
  const base = waitingCloseItem();
  assert.throws(() => move(base, "issue_closed"), /issue_closed requires recorded specs_synced/);
  assert.throws(
    () => validateWorkItem({ ...base, status: "done", issue_state: "closed" }),
    /done requires recorded specs_synced/,
  );
  // 证据字段只能由 specs_synced 事件写入,不允许借其它事件的 patch 绕过前置
  assert.throws(
    () => move(base, "issue_closed", { specs_synced: true, specs_commit_sha: sha, spec_delta_dir: "x" }),
    /only the specs_synced event may set it/,
  );
  assert.throws(
    () => move(base, "issue_closed", { spec_sync_required: false }),
    /only approve_requirement may set it/,
  );

  const done = move(move(base, "specs_synced", specSyncPatch), "issue_closed");
  assert.equal(done.status, "done");
  assert.equal(validateWorkItem(done), true);
  assert.throws(
    () => validateWorkItem({ ...done, specs_commit_sha: "drifted" }),
    /40-character specs_commit_sha/,
  );
});

test("exempt standard items skip the spec gate", () => {
  const exempt = waitingCloseItem({ spec_sync_required: false });
  const done = move(exempt, "issue_closed");
  assert.equal(done.status, "done");
  assert.equal(done.spec_sync_required, false);
  assert.equal(done.specs_synced, false);
  assert.equal(validateWorkItem(done), true);
});

test("legacy items normalize to grandfathered spec fields and close directly", () => {
  const legacy = waitingCloseItem();
  for (const field of ["spec_sync_required", "specs_synced", "specs_commit_sha", "spec_delta_dir"]) {
    delete legacy[field];
  }
  const normalized = normalizeWorkItem(legacy);
  assert.equal(normalized.spec_sync_required, false);
  assert.equal(normalized.specs_synced, false);
  assert.equal(normalized.specs_commit_sha, null);
  assert.equal(normalized.spec_delta_dir, null);
  const done = move(normalized, "issue_closed");
  assert.equal(done.status, "done");
  assert.equal(validateWorkItem(done), true);
});

test("the tag path is equally constrained by the spec gate", () => {
  let item = {
    ...runtimeItem(),
    status: "waiting_tag_confirm",
    human_approval: "approved",
    tester_result: "passed",
    reviewer_result: "approved",
    pr_checks: "passed",
    ...githubGuard,
    merged_sha: sha,
  };
  item = move(item, "approve_tag", { image_tag: "v1.4.0" }, "human:owner");
  item = move(item, "image_verified", deliveryPatch);
  assert.equal(item.status, "waiting_close");
  assert.throws(() => move(item, "issue_closed"), /specs_synced/);
  item = move(item, "specs_synced", specSyncPatch);
  item = move(item, "issue_closed");
  assert.equal(item.status, "done");
  assert.equal(validateWorkItem(item), true);
});

test("Gate A approval is the only event that may revise the spec-sync exemption", () => {
  const approved = move(runtimeItem(), "approve_requirement", { spec_sync_required: false }, "human:owner");
  assert.equal(approved.spec_sync_required, false);
  const stillRequired = move(runtimeItem(), "approve_requirement", {}, "human:owner");
  assert.equal(stillRequired.spec_sync_required, true);
});

test("same-turn approval hard boundary keeps only high risk out for both channels", () => {
  // 高风险拒绝:pre_authorized 与 auto_intake 双枚举值都抛错且状态不变
  const highPre = runtimeItem({ risk_level: "high", spec_sync_required: false });
  assert.throws(
    () => move(highPre, "approve_requirement", { approval_source: "pre_authorized" }, "human:owner"),
    /must stop at Gate A/,
  );
  assert.equal(highPre.status, "waiting_approval");
  const highAuto = runtimeItem({ risk_level: "high", spec_sync_required: false });
  assert.throws(
    () => move(highAuto, "approve_requirement", { approval_source: "auto_intake" }),
    /must stop at Gate A/,
  );
  assert.equal(highAuto.status, "waiting_approval");

  // spec_sync_required 不再拒绝:规格工单两条同轮通道都放行(原 throw 断言反转)
  const specItem = runtimeItem({ risk_level: "low" });
  assert.equal(specItem.spec_sync_required, true);
  const autoSpec = move(specItem, "approve_requirement", { approval_source: "auto_intake" });
  assert.equal(autoSpec.status, "ready");
  assert.equal(autoSpec.approval_source, "auto_intake");
  const preSpec = move(runtimeItem({ risk_level: "low" }), "approve_requirement", { approval_source: "pre_authorized" }, "human:owner");
  assert.equal(preSpec.status, "ready");
  assert.equal(preSpec.approval_source, "pre_authorized");

  // 原「不允许借预授权豁免规格」反转为生效:同轮通道可携带 spec 豁免 patch
  const exempted = move(runtimeItem({ risk_level: "low" }), "approve_requirement", { approval_source: "pre_authorized", spec_sync_required: false }, "human:owner");
  assert.equal(exempted.status, "ready");
  assert.equal(exempted.spec_sync_required, false);

  // pre_authorized 的 actor 非 human:<身份> 仍拒绝(approve_requirement 本就是 human 事件)
  assert.throws(
    () => move(runtimeItem({ risk_level: "medium", spec_sync_required: false }), "approve_requirement", { approval_source: "pre_authorized" }),
    /human:<identity>/,
  );

  // medium + 非 spec 放行,留痕生效(pre_authorized 保持既有行为)
  const preAuthorized = move(runtimeItem({ risk_level: "medium", spec_sync_required: false }), "approve_requirement", { approval_source: "pre_authorized" }, "human:owner");
  assert.equal(preAuthorized.status, "ready");
  assert.equal(preAuthorized.human_approval, "approved");
  assert.equal(preAuthorized.approval_source, "pre_authorized");
  assert.equal(preAuthorized.history.at(-1).actor, "human:owner");
  // low + 非 spec 同样放行
  const lowLane = move(runtimeItem({ risk_level: "low", spec_sync_required: false }), "approve_requirement", { approval_source: "pre_authorized" }, "human:owner");
  assert.equal(lowLane.approval_source, "pre_authorized");
});

test("auto_intake is the default same-turn lane with strict actor honesty", () => {
  // medium + spec 工单 + actor="orchestrator" → ready 且 approval_source="auto_intake"
  const auto = move(runtimeItem({ risk_level: "medium" }), "approve_requirement", { approval_source: "auto_intake" });
  assert.equal(auto.status, "ready");
  assert.equal(auto.human_approval, "approved");
  assert.equal(auto.approval_source, "auto_intake");
  assert.equal(auto.history.at(-1).actor, "orchestrator");

  // actor 诚实性:auto_intake 携带 human:<身份> 形式反而抛错(人未敲审批命令不得伪造 human actor)
  assert.throws(
    () => move(runtimeItem({ risk_level: "medium" }), "approve_requirement", { approval_source: "auto_intake" }, "human:owner"),
    /auto_intake" requires actor exactly "orchestrator/,
  );
  // 其它任意非 orchestrator actor 同样拒绝
  assert.throws(
    () => move(runtimeItem({ risk_level: "low" }), "approve_requirement", { approval_source: "auto_intake" }, "ci-bot"),
    /auto_intake/,
  );

  // 回归:pre_authorized + orchestrator 仍抛 human actor 错
  assert.throws(
    () => move(runtimeItem({ risk_level: "medium", spec_sync_required: false }), "approve_requirement", { approval_source: "pre_authorized" }),
    /human:<identity>/,
  );

  // validateWorkItem 枚举校验:接受 auto_intake、拒绝未知值
  assert.equal(validateWorkItem({ ...runtimeItem({ spec_sync_required: false }), approval_source: "auto_intake" }), true);
  assert.throws(
    () => validateWorkItem({ ...runtimeItem({ spec_sync_required: false }), approval_source: "self_approved" }),
    /invalid approval_source/,
  );
});

test("end-to-end: standard spec item flows green through the auto_intake default lane", () => {
  let item = createWorkItem({
    id: "REQ-77",
    issue_number: 77,
    title: "Standard spec-carrying change",
    risk_level: "medium",
    delivery_required: false,
    delivery_reason: "Docs and specs; on-demand batched release",
    skip_allowed: true,
    spec_sync_required: true,
  }, clock);
  assert.equal(item.status, "waiting_approval");
  assert.equal(item.spec_sync_required, true);
  assert.equal(item.approval_source, "issue_stop");

  item = move(item, "approve_requirement", { approval_source: "auto_intake" });
  assert.equal(item.status, "ready");
  assert.equal(item.approval_source, "auto_intake");
  assert.equal(item.human_approval, "approved");

  item = move(item, "start_planning", { branch: "hulane/req-77", worktree_path: "/repo/.hulane/worktrees/REQ-77" });
  item = move(item, "plan_complete");
  item = move(item, "code_complete");
  item = move(item, "tests_passed");
  item = move(item, "review_approved");
  item = move(item, "pr_created", { pr_number: 77, github_pr_url: "https://github.com/acme/demo/pull/77" });
  item = move(item, "checks_passed", githubGuard);
  assert.equal(item.status, "merging");
  item = move(item, "pr_merged", { merged_sha: sha });
  assert.equal(item.status, "waiting_tag_confirm");
  item = move(item, "policy_skip");
  assert.equal(item.status, "waiting_close");
  assert.equal(item.tag_confirmation, "skipped_by_policy");
  item = move(item, "specs_synced", { specs_commit_sha: sha, spec_delta_dir: "openspec/changes/archive/REQ-77" });
  item = move(item, "issue_closed");
  assert.equal(item.status, "done");
  assert.equal(validateWorkItem(item), true);
  assert.equal(item.approval_source, "auto_intake");
});

test("approve_requirement defaults approval_source to issue_stop and new items start there", () => {
  assert.equal(runtimeItem().approval_source, "issue_stop");
  const approved = move(runtimeItem({ spec_sync_required: false }), "approve_requirement", {}, "human:owner");
  assert.equal(approved.status, "ready");
  assert.equal(approved.approval_source, "issue_stop");
});

test("only approve_requirement may write approval_source", () => {
  const base = waitingCloseItem();
  assert.throws(
    () => move(base, "issue_closed", { approval_source: "pre_authorized" }),
    /only approve_requirement may set it/,
  );
  assert.throws(
    () => move(base, "issue_closed", { approval_source: "auto_intake" }),
    /only approve_requirement may set it/,
  );
  assert.throws(
    () => move(base, "specs_synced", { ...specSyncPatch, approval_source: "pre_authorized" }),
    /only approve_requirement may set it/,
  );
  assert.throws(
    () => move(base, "specs_synced", { ...specSyncPatch, approval_source: "auto_intake" }),
    /only approve_requirement may set it/,
  );
});

test("legacy items normalize approval_source to issue_stop and validateWorkItem enforces the enum", () => {
  const legacy = waitingCloseItem({ spec_sync_required: false });
  delete legacy.approval_source;
  const normalized = normalizeWorkItem(legacy);
  assert.equal(normalized.approval_source, "issue_stop");
  const done = move(normalized, "issue_closed");
  assert.equal(done.status, "done");
  assert.equal(validateWorkItem(done), true);

  assert.throws(
    () => validateWorkItem({ ...runtimeItem({ spec_sync_required: false }), approval_source: "self_approved" }),
    /invalid approval_source/,
  );
  assert.throws(
    () => move(runtimeItem({ spec_sync_required: false }), "approve_requirement", { approval_source: "chat" }, "human:owner"),
    /Invalid Work Item REQ-12: .*invalid approval_source/,
  );
});

test("validateWorkItemInput rejects every cross-field violation before an Issue can be created", () => {
  const base = {
    title: "Demo",
    type: "feature",
    risk_level: "low",
    size: "small",
    delivery_required: false,
    delivery_reason: "on-demand batched release",
    skip_allowed: true,
    spec_sync_required: false,
  };
  assert.equal(validateWorkItemInput(base).size, "small");

  // 六犯根因：non-runtime 发版策略缺 delivery_reason
  assert.throws(
    () => validateWorkItemInput({ ...base, delivery_reason: " " }),
    /Non-runtime delivery policy requires delivery_reason/,
  );
  // 历史第二类：small 必须 low
  assert.throws(
    () => validateWorkItemInput({ ...base, risk_level: "medium" }),
    /size small requires risk_level low/,
  );
  assert.throws(
    () => validateWorkItemInput({ ...base, risk_level: "urgent" }),
    /risk_level must be one of/,
  );
  assert.throws(
    () => validateWorkItemInput({ ...base, title: "  " }),
    /title is required/,
  );
  assert.throws(
    () => validateWorkItemInput({ ...base, size: "nano" }),
    /size must be one of/,
  );
  assert.throws(
    () => validateWorkItemInput({ ...base, delivery_required: true, delivery_reason: null }),
    /Runtime delivery cannot allow skip/,
  );
  assert.throws(
    () => validateWorkItemInput({ ...base, spec_sync_required: true }),
    /size small never requires spec sync/,
  );
  // standard 默认值派生：spec_sync 默认必须、发版默认运行时
  const standard = validateWorkItemInput({ title: "Demo", risk_level: "high" });
  assert.equal(standard.size, "standard");
  assert.equal(standard.deliveryRequired, true);
  assert.equal(standard.skipAllowed, false);
  assert.equal(standard.specSyncRequired, true);
});

// ===== REQ-11:本地优先开单、issue_created 自环与 pending 不变量 =====

function pendingItem(overrides = {}) {
  return createWorkItem({
    id: "REQ-40",
    issue_pending: true,
    title: "Offline item",
    risk_level: "low",
    delivery_required: false,
    delivery_reason: "batched release",
    skip_allowed: true,
    planner_summary: "offline plan",
    acceptance_criteria: ["offline criterion"],
    ...overrides,
  }, clock);
}

test("local-first creation persists pending identity, planner summary, and criteria", () => {
  const item = pendingItem();
  assert.equal(item.status, "waiting_approval");
  assert.equal(item.issue_pending, true);
  assert.equal(item.issue_number, null);
  assert.equal(item.github_issue_url, null);
  assert.equal(item.issue_state, "open");
  assert.equal(item.planner_summary, "offline plan");
  assert.deepEqual(item.acceptance_criteria, ["offline criterion"]);
  assert.equal(validateWorkItem(item), true);
  assert.equal(item.history[0].evidence, "Local Work Item REQ-40 created offline; GitHub Issue pending flush");
  // 在线先建 Issue 的旧通道不变:issue_number 必填且与 id 数字一致
  const online = createWorkItem({ id: "REQ-41", issue_number: 41, title: "Online item", risk_level: "low", delivery_required: true }, clock);
  assert.equal(online.issue_pending, false);
  assert.throws(
    () => createWorkItem({ id: "REQ-42", issue_number: 43, title: "Mismatch", risk_level: "low", delivery_required: true }, clock),
    /id number must equal issue_number/,
  );
  assert.throws(
    () => createWorkItem({ id: "REQ-42", issue_pending: true, issue_number: 43, title: "Bad", risk_level: "low", delivery_required: true }, clock),
    /without an issue_number/,
  );
});

test("local numbering merges REQ and BUG prefixes", () => {
  assert.equal(nextLocalWorkItemNumber({ items: {} }), 1);
  const store = {
    items: {
      "REQ-9": { id: "REQ-9" },
      "BUG-8": { id: "BUG-8" },
    },
  };
  assert.equal(nextLocalWorkItemNumber(store), 10); // REQ-9 + BUG-8 合并取最大 9
  store.items["REQ-10"] = { id: "REQ-10" };
  assert.equal(nextLocalWorkItemNumber(store), 11);
});

test("issue_created self-loop backfills pending items without touching status", () => {
  const item = pendingItem();
  const before = { status: item.status, next_action: item.next_action };
  const backfilled = move(item, "issue_created", {
    issue_number: 77,
    github_issue_url: "https://github.com/acme/demo/issues/77",
  });
  assert.equal(backfilled.status, before.status); // 自环不改状态
  assert.equal(backfilled.next_action, before.next_action);
  assert.equal(backfilled.issue_pending, false);
  assert.equal(backfilled.issue_number, 77); // 本地号 REQ-40 与远端 Issue #77 解耦
  assert.equal(backfilled.github_issue_url, "https://github.com/acme/demo/issues/77");
  assert.equal(backfilled.history.at(-1).event, "issue_created");
  assert.equal(validateWorkItem(backfilled), true);
  // 非 pending 重复应用抛错、状态不变
  assert.throws(() => move(backfilled, "issue_created", { issue_number: 78, github_issue_url: "https://github.com/acme/demo/issues/78" }), /applies only to issue_pending/);
  assert.equal(backfilled.issue_number, 77);
});

test("issue_created patch requires a positive issue_number and a github.com URL", () => {
  const item = pendingItem();
  assert.throws(() => move(item, "issue_created", { github_issue_url: "https://github.com/acme/demo/issues/77" }), /positive issue_number/);
  assert.throws(() => move(item, "issue_created", { issue_number: 0, github_issue_url: "https://github.com/acme/demo/issues/77" }), /positive issue_number/);
  assert.throws(() => move(item, "issue_created", { issue_number: 77 }), /github\.com Issue URL/);
  assert.throws(() => move(item, "issue_created", { issue_number: 77, github_issue_url: "https://example.test/issues/77" }), /github\.com Issue URL/);
});

test("only issue_created may write issue_number/issue_pending through a patch", () => {
  const item = pendingItem();
  assert.throws(
    () => move(item, "approve_requirement", { issue_number: 77, github_issue_url: "https://github.com/acme/demo/issues/77" }, "human:owner"),
    /only the issue_created event may set it/,
  );
  assert.throws(
    () => move(item, "approve_requirement", { issue_pending: false }, "human:owner"),
    /only the issue_created event may set it/,
  );
  // flush 之外的事件(含保留事件specs_synced)同样不得伪造回填
  const base = { ...waitingCloseItem(), issue_pending: true, issue_number: null, github_issue_url: null };
  assert.throws(
    () => move(base, "specs_synced", { ...specSyncPatch, issue_number: 77 }),
    /only the issue_created event may set it/,
  );
});

test("pending items cannot close, reach done, or open a PR", () => {
  const base = { ...waitingCloseItem(), issue_pending: true, issue_number: null, github_issue_url: null };
  assert.throws(() => move(base, "issue_closed"), /run hulane_flush first/);
  assert.throws(
    () => validateWorkItem({ ...base, status: "done", issue_state: "closed" }),
    /done requires the flushed GitHub Issue/,
  );
  const atReview = { ...pendingItem(), status: "review", human_approval: "approved", tester_result: "passed" };
  assert.throws(
    () => move(atReview, "pr_created", { pr_number: 5, github_pr_url: "https://github.com/acme/demo/pull/5" }),
    /run hulane_flush first/,
  );
});

test("pending invariants are enforced by validateWorkItem", () => {
  const item = pendingItem();
  assert.throws(() => validateWorkItem({ ...item, issue_number: 77 }), /issue_pending requires a null issue_number/);
  assert.throws(
    () => validateWorkItem({ ...item, github_issue_url: "https://github.com/acme/demo/issues/77" }),
    /issue_pending requires a null github_issue_url/,
  );
  assert.throws(() => validateWorkItem({ ...item, issue_state: "closed" }), /issue_pending requires an open Issue state/);
  assert.throws(() => validateWorkItem({ ...item, issue_pending: "yes" }), /invalid issue_pending/);
  assert.throws(() => validateWorkItem({ ...item, issue_pending: false }), /invalid issue_number/);
});

test("legacy items normalize issue_pending to false and keep flowing unchanged", () => {
  const legacy = waitingCloseItem({ spec_sync_required: false });
  delete legacy.issue_pending;
  const normalized = normalizeWorkItem(legacy);
  assert.equal(normalized.issue_pending, false);
  const done = move(normalized, "issue_closed");
  assert.equal(done.status, "done");
  assert.equal(validateWorkItem(done), true);
});

test("pending items transition through the whole lifecycle offline", () => {
  let item = pendingItem({ risk_level: "medium" });
  item = move(item, "approve_requirement", { approval_source: "auto_intake" });
  item = move(item, "start_planning", { branch: "hulane/req-40", worktree_path: "/repo/.hulane/worktrees/REQ-40" });
  item = move(item, "plan_complete");
  item = move(item, "code_complete");
  item = move(item, "tests_passed");
  item = move(item, "review_approved");
  assert.equal(item.status, "pr_open");
  assert.equal(item.issue_pending, true);
  // flush 后 PR 才可能创建:回填 → pr_created 放行
  item = move(item, "issue_created", { issue_number: 88, github_issue_url: "https://github.com/acme/demo/issues/88" });
  item = move(item, "pr_created", { pr_number: 40, github_pr_url: "https://github.com/acme/demo/pull/40" });
  assert.equal(item.status, "pr_checking");
  assert.equal(validateWorkItem(item), true);
});
