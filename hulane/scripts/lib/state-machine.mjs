const ID_PATTERN = /^(REQ|BUG)-(\d+)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const SEMVER_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export const STATES = Object.freeze([
  "waiting_approval",
  "ready",
  "planning",
  "doing",
  "testing",
  "review",
  "pr_open",
  "pr_checking",
  "waiting_human_merge",
  "merging",
  "waiting_tag_confirm",
  "building",
  "waiting_close",
  "blocked",
  "done",
]);

export const RISKS = Object.freeze(["low", "medium", "high"]);
export const SIZES = Object.freeze(["standard", "small"]);
export const APPROVAL_SOURCES = Object.freeze(["issue_stop", "pre_authorized", "auto_intake"]);
export const MERGE_GUARD_MODES = Object.freeze([
  "unverified",
  "github_required_checks",
  "control_plane_verified",
]);
export const DEFAULT_REWORK_LIMIT = 3;
export const HUMAN_EVENTS = new Set([
  "approve_requirement",
  "approve_merge",
  "approve_tag",
  "approve_skip",
]);

const REWORK_EVENTS = new Set(["tests_failed", "changes_requested", "checks_failed"]);

const STATIC_TRANSITIONS = Object.freeze({
  waiting_approval: { approve_requirement: "ready" },
  ready: { start_planning: "planning" },
  planning: { plan_complete: "doing" },
  doing: { code_complete: "testing" },
  testing: { tests_failed: "doing", tests_passed: "review" },
  review: { changes_requested: "doing", review_approved: "pr_open" },
  pr_open: { pr_created: "pr_checking" },
  pr_checking: { checks_failed: "doing" },
  waiting_human_merge: { approve_merge: "merging" },
  merging: { pr_merged: "waiting_tag_confirm" },
  waiting_tag_confirm: { approve_tag: "building", approve_skip: "waiting_close", policy_skip: "waiting_close" },
  building: { image_verified: "waiting_close" },
  // specs_synced 是 waiting_close 上的自环:记录规格同步证据,不改变状态,
  // 但它是 spec_sync_required 工单 issue_closed 的硬前置
  waiting_close: { specs_synced: "waiting_close", issue_closed: "done" },
});

const PATCH_FIELDS = new Set([
  "agent_owner",
  "approval_source",
  "block_reason",
  "branch",
  "build_status",
  "github_issue_url",
  "github_pr_url",
  "image",
  "image_digest",
  "image_tag",
  "issue_number",
  "issue_pending",
  "issue_state",
  "merged_sha",
  "next_action",
  "pr_checks",
  "pr_check_name",
  "pr_check_run_url",
  "pr_head_sha",
  "merge_guard_mode",
  "required_checks_enforced",
  "pr_number",
  "provenance_status",
  "provenance_digest",
  "registry_verified",
  "release_url",
  "sbom_status",
  "sbom_digest",
  "size",
  "spec_sync_required",
  "specs_commit_sha",
  "spec_delta_dir",
  "specs_synced",
  "tag_confirmation",
  "workflow_run_url",
  "worktree_path",
]);

// 规格同步字段的写入通道收口:豁免只允许发生在 Gate A(approve_requirement),
// 证据三件套只允许由 specs_synced 事件本身写入——否则任意事件带 patch 就能
// 绕过 issue_closed / Done 的规格同步前置
const SPEC_EXEMPTION_FIELDS = new Set(["spec_sync_required"]);
const SPEC_EVIDENCE_FIELDS = new Set(["specs_synced", "specs_commit_sha", "spec_delta_dir"]);
// Gate A 留痕字段同样收口:approval_source 只允许由 approve_requirement 写入,
// 其余事件携带即抛错,防止事后伪造预授权来源
const APPROVAL_TRACE_FIELDS = new Set(["approval_source"]);
// Issue 回填字段收口:issue_number/issue_pending 只允许由 issue_created 自环事件
// (hulane_flush 在线窗口应用)写入——否则任意事件带 patch 就能把 pending 工单
// 伪造绑定到一个从未建过的 GitHub Issue
const ISSUE_BACKFILL_FIELDS = new Set(["issue_number", "issue_pending"]);

function assertPatchFieldOwnership(event, patch = {}) {
  for (const key of Object.keys(patch)) {
    if (SPEC_EXEMPTION_FIELDS.has(key) && event !== "approve_requirement") {
      throw new Error(`Unsupported state patch field: ${key} (only approve_requirement may set it)`);
    }
    if (SPEC_EVIDENCE_FIELDS.has(key) && event !== "specs_synced") {
      throw new Error(`Unsupported state patch field: ${key} (only the specs_synced event may set it)`);
    }
    if (APPROVAL_TRACE_FIELDS.has(key) && event !== "approve_requirement") {
      throw new Error(`Unsupported state patch field: ${key} (only approve_requirement may set it)`);
    }
    if (ISSUE_BACKFILL_FIELDS.has(key) && event !== "issue_created") {
      throw new Error(`Unsupported state patch field: ${key} (only the issue_created event may set it)`);
    }
  }
}

function nowIso(now) {
  return (typeof now === "function" ? now() : new Date()).toISOString();
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean, received ${String(value)}`);
}

function requireHumanActor(event, actor, patch = {}) {
  // Gate A 开单同轮自动放行的 actor 诚实性:auto_intake 的 actor 必须恰为
  // "orchestrator"——人未敲审批命令,不得伪造 human:<身份> 留痕;出现任何
  // human:<身份> 形式反而抛错。其余 HUMAN_EVENTS 与 pre_authorized 的
  // human:<身份> 硬校验保持不变。
  if (event === "approve_requirement" && patch?.approval_source === "auto_intake") {
    if (actor !== "orchestrator") {
      throw new Error('approve_requirement with approval_source "auto_intake" requires actor exactly "orchestrator"');
    }
    return;
  }
  if (HUMAN_EVENTS.has(event) && !/^human:[A-Za-z0-9_.@-]+$/.test(actor ?? "")) {
    throw new Error(`${event} requires actor in human:<identity> form`);
  }
}

function filteredPatch(patch = {}) {
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCH_FIELDS.has(key)) throw new Error(`Unsupported state patch field: ${key}`);
    result[key] = value;
  }
  return result;
}

export function mergeGuardSatisfied(item) {
  const evidenceComplete = SHA_PATTERN.test(String(item.pr_head_sha ?? ""))
    && /^https:\/\/github\.com\//.test(String(item.pr_check_run_url ?? ""))
    && Boolean(String(item.pr_check_name ?? "").trim());
  if (!evidenceComplete) return false;
  if (item.merge_guard_mode === "github_required_checks") {
    return item.required_checks_enforced === true;
  }
  return item.merge_guard_mode === "control_plane_verified"
    && item.required_checks_enforced === false;
}

export function normalizeWorkItem(item) {
  const next = structuredClone(item);
  if (next.schema_version !== 2) return next;
  const historicalDone = next.status === "done" && (
    !("required_checks_enforced" in next)
    || !("merge_guard_mode" in next)
    || !("pr_head_sha" in next)
    || !("registry_verified" in next)
    || !("sbom_digest" in next)
    || !("provenance_digest" in next)
  );
  if (!("worktree_path" in next)) next.worktree_path = null;
  if (!("rework_count" in next)) next.rework_count = 0;
  if (!("rework_limit" in next)) next.rework_limit = DEFAULT_REWORK_LIMIT;
  if (!("registry_verified" in next)) next.registry_verified = false;
  if (!("release_url" in next)) next.release_url = null;
  if (!("sbom_status" in next)) next.sbom_status = "unknown";
  if (!("provenance_status" in next)) next.provenance_status = "unknown";
  if (!("sbom_digest" in next)) next.sbom_digest = null;
  if (!("provenance_digest" in next)) next.provenance_digest = null;
  if (!("required_checks_enforced" in next)) next.required_checks_enforced = false;
  if (!("merge_guard_mode" in next)) {
    next.merge_guard_mode = next.required_checks_enforced ? "github_required_checks" : "unverified";
  }
  if (!("pr_head_sha" in next)) next.pr_head_sha = null;
  if (!("pr_check_name" in next)) next.pr_check_name = null;
  if (!("pr_check_run_url" in next)) next.pr_check_run_url = null;
  if (!("size" in next)) next.size = "standard";
  if (!("legacy_completion" in next)) next.legacy_completion = historicalDone;
  // V3.6.0 前立项的存量工单没有规格层字段:按祖父条款回填 false/false,
  // 不被 specs_synced 前置阻塞(参照 legacy_completion 的存量豁免方式)
  if (!("spec_sync_required" in next)) next.spec_sync_required = false;
  if (!("specs_synced" in next)) next.specs_synced = false;
  if (!("specs_commit_sha" in next)) next.specs_commit_sha = null;
  if (!("spec_delta_dir" in next)) next.spec_delta_dir = null;
  // V3.7.0 前立项的存量工单没有 Gate A 来源字段:祖父回填 issue_stop,
  // 既有流转不受影响(参照规格层字段的存量豁免方式)
  if (!("approval_source" in next)) next.approval_source = "issue_stop";
  // V3.9.0 前立项的存量工单都是在线开单(Issue 先建):祖父回填 issue_pending=false,
  // REQ-3/5/7/9 等既有工单行为逐字节不变
  if (!("issue_pending" in next)) next.issue_pending = false;
  return next;
}

// 本地优先开单的编号分配:store 内全部工单(REQ 与 BUG 前缀合并)数字最大值 + 1。
// 前缀由 type 决定,与 GitHub Issue 编号完全解耦(flush 后 issue_number 另行回填)
export function nextLocalWorkItemNumber(store) {
  let max = 0;
  for (const id of Object.keys(store?.items ?? {})) {
    const match = String(id).match(ID_PATTERN);
    if (match) max = Math.max(max, Number(match[2]));
  }
  return max + 1;
}

// 纯输入校验，不依赖 GitHub Issue：open_work_item 必须在建 Issue 之前调用。
// 历史上校验发生在建 Issue 之后且失败无回滚，参数不合法会留下
// 「有 Issue 无状态机」的孤儿（delivery_reason 一项即六犯）。
// 返回建单派生字段，createWorkItem 复用同一份逻辑，双处不漂移。
export function validateWorkItemInput(input) {
  if (!RISKS.includes(input.risk_level)) throw new Error(`risk_level must be one of ${RISKS.join(", ")}`);
  if (!String(input.title ?? "").trim()) throw new Error("title is required");
  const size = input.size ?? "standard";
  if (!SIZES.includes(size)) throw new Error(`size must be one of ${SIZES.join(", ")}`);
  if (size === "small" && input.risk_level !== "low") throw new Error("size small requires risk_level low");
  const deliveryRequired = asBoolean(input.delivery_required, true);
  const skipAllowed = asBoolean(input.skip_allowed, false);
  if (deliveryRequired && skipAllowed) throw new Error("Runtime delivery cannot allow skip");
  if (!deliveryRequired && !String(input.delivery_reason ?? "").trim()) {
    throw new Error("Non-runtime delivery policy requires delivery_reason");
  }
  // 规格同步要求:standard 默认必须(planner 显式豁免纯基建/纯文档条目),
  // small 恒 false(快车道不吃规格层前置)
  const specSyncRequired = asBoolean(input.spec_sync_required, size !== "small");
  if (size === "small" && specSyncRequired) throw new Error("size small never requires spec sync");
  return { size, deliveryRequired, skipAllowed, specSyncRequired };
}

export function createWorkItem(input, now = () => new Date()) {
  const checked = validateWorkItemInput(input);
  const idMatch = String(input.id ?? "").match(ID_PATTERN);
  if (!idMatch) throw new Error("Work Item id must match REQ-<issue> or BUG-<issue>");
  // 本地优先开单(issue_pending=true):GitHub Issue 尚未创建,issue_number 必为
  // null,编号由 store 本地自增分配,flush 在线窗口经 issue_created 事件回填。
  // 在线先建 Issue 的旧通道(CLI 兼容)仍要求 id 数字 == issue_number。
  const issuePending = input.issue_pending === true;
  let issueNumber = null;
  if (!issuePending) {
    issueNumber = Number(input.issue_number);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("issue_number must be a positive integer");
    if (Number(idMatch[2]) !== issueNumber) throw new Error("Work Item id number must equal issue_number");
  } else if (input.issue_number !== undefined && input.issue_number !== null) {
    throw new Error("issue_pending Work Items must be created without an issue_number");
  }
  const { size, deliveryRequired, skipAllowed, specSyncRequired } = checked;

  const timestamp = nowIso(now);
  const item = {
    schema_version: 2,
    id: input.id,
    issue_pending: issuePending,
    issue_number: issueNumber,
    planner_summary: String(input.planner_summary ?? "").trim() || null,
    acceptance_criteria: Array.isArray(input.acceptance_criteria) ? input.acceptance_criteria.map(String) : [],
    github_issue_url: input.github_issue_url ?? null,
    title: String(input.title ?? "").trim(),
    type: idMatch[1] === "BUG" ? "bug" : (input.type ?? "feature"),
    status: "waiting_approval",
    previous_status: null,
    risk_level: input.risk_level,
    size,
    delivery_required: deliveryRequired,
    delivery_reason: String(input.delivery_reason ?? "").trim(),
    skip_allowed: skipAllowed,
    human_approval: "required",
    approval_source: "issue_stop",
    branch: null,
    worktree_path: null,
    pr_number: null,
    github_pr_url: null,
    merged_sha: null,
    issue_state: "open",
    coder_result: "pending",
    tester_result: "pending",
    reviewer_result: "pending",
    pr_checks: "unknown",
    pr_check_name: null,
    pr_check_run_url: null,
    pr_head_sha: null,
    merge_guard_mode: "unverified",
    required_checks_enforced: false,
    legacy_completion: false,
    spec_sync_required: specSyncRequired,
    specs_synced: false,
    specs_commit_sha: null,
    spec_delta_dir: null,
    tag_confirmation: "pending",
    build_status: "unknown",
    image: null,
    image_tag: null,
    image_digest: null,
    workflow_run_url: null,
    registry_verified: false,
    release_url: null,
    sbom_status: "unknown",
    provenance_status: "unknown",
    sbom_digest: null,
    provenance_digest: null,
    blocked: false,
    block_reason: null,
    agent_owner: "orchestrator",
    next_action: "human_approval",
    attempts: { coder: 0, tester: 0, reviewer: 0 },
    rework_count: 0,
    rework_limit: DEFAULT_REWORK_LIMIT,
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
    history: [{
      revision: 1,
      event: "created",
      from: null,
      to: "waiting_approval",
      actor: input.actor ?? "orchestrator",
      evidence: input.evidence ?? (issuePending
        ? `Local Work Item ${input.id} created offline; GitHub Issue pending flush`
        : `GitHub Issue #${issueNumber} created`),
      at: timestamp,
    }],
  };
  validateWorkItem(item);
  return item;
}

function targetFor(item, event, payload) {
  if (event === "block") {
    if (item.status === "done") throw new Error("Done is terminal and cannot be blocked");
    return "blocked";
  }
  if (event === "resume") {
    if (item.status !== "blocked") throw new Error("resume is valid only from blocked");
    const target = payload.to ?? item.previous_status;
    if (!STATES.includes(target) || ["blocked", "done"].includes(target)) {
      throw new Error("Blocked item has no valid resumable previous state");
    }
    return target;
  }
  if (event === "checks_passed") {
    if (item.status !== "pr_checking") throw new Error("checks_passed requires pr_checking");
    // Gate B 只由高风险触发;控制面守卫的低/中风险依赖已核验的补偿控制
    // (全部上报检查成功 + 精确 Head SHA + --match-head-commit)自动合并
    return item.risk_level === "high" ? "waiting_human_merge" : "merging";
  }
  // issue_created 是任意状态上的自环(仿 specs_synced 模式):只对 pending 工单
  // 生效,不改状态,记录 GitHub Issue 补建回填的留痕
  if (event === "issue_created") {
    if (item.issue_pending !== true) throw new Error("issue_created applies only to issue_pending Work Items");
    return item.status;
  }
  const target = STATIC_TRANSITIONS[item.status]?.[event];
  if (!target) throw new Error(`Invalid transition: ${item.status} --${event}--> ?`);
  if (REWORK_EVENTS.has(event) && item.rework_count >= item.rework_limit) return "blocked";
  return target;
}

export function applyEvent(item, event, payload = {}, now = () => new Date()) {
  validateWorkItem(item);
  const actor = payload.actor ?? "orchestrator";
  const evidence = String(payload.evidence ?? "").trim();
  if (!evidence) throw new Error("Every transition requires evidence");
  requireHumanActor(event, actor, payload.patch);
  assertPatchFieldOwnership(event, payload.patch);

  if ((event === "approve_skip" || event === "policy_skip") && (item.delivery_required || !item.skip_allowed)) {
    throw new Error("skip is forbidden by the persisted delivery policy");
  }
  if (event === "policy_skip" && item.human_approval !== "approved") {
    throw new Error("policy_skip requires the Gate A approval that persisted the delivery policy");
  }
  if (event === "start_planning") {
    if (!String(payload.patch?.branch ?? "").trim()) throw new Error("start_planning requires branch");
    if (!String(payload.patch?.worktree_path ?? "").trim()) throw new Error("start_planning requires worktree_path");
  }
  if (event === "review_approved" && item.tester_result !== "passed") {
    throw new Error("Reviewer approval requires tester_result=passed");
  }
  if (event === "pr_created") {
    // PR 必须挂在真实存在的 GitHub Issue 上:pending 工单(尚未 flush)先补建 Issue
    if (item.issue_pending === true) {
      throw new Error("pr_created requires the GitHub Issue to exist; run hulane_flush first");
    }
    const prNumber = payload.patch?.pr_number;
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("pr_created requires a positive pr_number");
    if (!/^https:\/\/github\.com\//.test(String(payload.patch?.github_pr_url ?? ""))) throw new Error("pr_created requires github_pr_url");
  }
  if (event === "checks_passed") {
    if (item.tester_result !== "passed" || item.reviewer_result !== "approved") throw new Error("checks_passed requires passed Tester and approved Reviewer");
    const mode = payload.patch?.merge_guard_mode;
    if (!MERGE_GUARD_MODES.includes(mode) || mode === "unverified") {
      throw new Error("checks_passed requires verified merge-guard evidence");
    }
    if (!SHA_PATTERN.test(String(payload.patch?.pr_head_sha ?? ""))) {
      throw new Error("checks_passed requires the verified PR head SHA");
    }
    if (!String(payload.patch?.pr_check_name ?? "").trim()) {
      throw new Error("checks_passed requires the verified PR check name");
    }
    if (!/^https:\/\/github\.com\//.test(String(payload.patch?.pr_check_run_url ?? ""))) {
      throw new Error("checks_passed requires a GitHub PR check URL");
    }
    if (mode === "github_required_checks" && payload.patch?.required_checks_enforced !== true) {
      throw new Error("GitHub merge guard requires enforced server-side checks evidence");
    }
    if (mode === "control_plane_verified" && payload.patch?.required_checks_enforced !== false) {
      throw new Error("Control-plane merge guard must not claim GitHub enforcement");
    }
  }
  if (event === "pr_merged" && !SHA_PATTERN.test(String(payload.patch?.merged_sha ?? ""))) {
    throw new Error("pr_merged requires a 40-character merged_sha");
  }
  if (event === "pr_merged" && (item.pr_checks !== "passed" || !mergeGuardSatisfied(item) || item.reviewer_result !== "approved")) {
    throw new Error("pr_merged requires approved review and a verified merge guard");
  }
  if (event === "approve_tag" && !SEMVER_TAG_PATTERN.test(String(payload.patch?.image_tag ?? ""))) {
    throw new Error("approve_tag requires the confirmed strict SemVer image_tag");
  }
  if (event === "approve_tag" && !SHA_PATTERN.test(String(item.merged_sha ?? ""))) {
    throw new Error("approve_tag requires merged_sha");
  }
  if (event === "image_verified") {
    if (!DIGEST_PATTERN.test(String(payload.patch?.image_digest ?? ""))) throw new Error("image_verified requires sha256 image_digest");
    const image = String(payload.patch?.image ?? "");
    if (!image.startsWith("ghcr.io/") || image !== image.toLowerCase()) throw new Error("image_verified requires a lowercase GHCR image");
    if (!SEMVER_TAG_PATTERN.test(String(payload.patch?.image_tag ?? ""))) throw new Error("image_verified requires a strict SemVer image_tag");
    if (item.image_tag && payload.patch?.image_tag !== item.image_tag) throw new Error("verified image_tag differs from Gate C confirmation");
    if (!/^https:\/\/github\.com\//.test(String(payload.patch?.workflow_run_url ?? ""))) throw new Error("image_verified requires a GitHub workflow_run_url");
    if (!/^https:\/\/github\.com\//.test(String(payload.patch?.release_url ?? ""))) throw new Error("image_verified requires a GitHub release_url");
    if (payload.patch?.registry_verified !== true) throw new Error("image_verified requires independent registry verification");
    if (payload.patch?.sbom_status !== "verified") throw new Error("image_verified requires verified SBOM evidence");
    if (payload.patch?.provenance_status !== "verified") throw new Error("image_verified requires verified provenance evidence");
    if (!DIGEST_PATTERN.test(String(payload.patch?.sbom_digest ?? ""))) throw new Error("image_verified requires the SBOM attestation digest");
    if (!DIGEST_PATTERN.test(String(payload.patch?.provenance_digest ?? ""))) throw new Error("image_verified requires the provenance attestation digest");
  }
  if (event === "specs_synced") {
    // 双层强制的状态机侧:证据三件套齐全才允许记录;specs_commit_sha 钉死
    // merged_sha(方案 B:merge 后只对合并提交树做校验,不接受其它来源的规格树)
    if (!SHA_PATTERN.test(String(item.merged_sha ?? ""))) throw new Error("specs_synced requires the recorded merged_sha");
    if (!SHA_PATTERN.test(String(payload.patch?.specs_commit_sha ?? ""))) throw new Error("specs_synced requires a 40-character specs_commit_sha");
    if (String(payload.patch?.specs_commit_sha) !== String(item.merged_sha)) {
      throw new Error("specs_synced requires specs_commit_sha to equal the recorded merged_sha");
    }
    if (!String(payload.patch?.spec_delta_dir ?? "").trim()) throw new Error("specs_synced requires spec_delta_dir");
  }
  if (event === "issue_created") {
    // flush 回填证据:正整数 issue_number + github.com Issue URL
    if (item.issue_pending !== true) throw new Error("issue_created applies only to issue_pending Work Items");
    const createdNumber = payload.patch?.issue_number;
    if (!Number.isInteger(createdNumber) || createdNumber <= 0) {
      throw new Error("issue_created requires a positive issue_number");
    }
    if (!/^https:\/\/github\.com\//.test(String(payload.patch?.github_issue_url ?? ""))) {
      throw new Error("issue_created requires a github.com Issue URL");
    }
  }
  if (event === "issue_closed" && item.issue_pending === true) {
    throw new Error("issue_closed requires the GitHub Issue to exist; run hulane_flush first");
  }
  if (event === "issue_closed" && item.spec_sync_required && item.specs_synced !== true) {
    throw new Error("issue_closed requires recorded specs_synced evidence while spec_sync_required");
  }

  const from = item.status;
  const to = targetFor(item, event, payload);
  const timestamp = nowIso(now);
  const next = structuredClone(item);
  Object.assign(next, filteredPatch(payload.patch));
  next.status = to;
  next.revision += 1;
  next.updated_at = timestamp;
  next.blocked = to === "blocked";

  if (event === "block") {
    next.previous_status = from;
    next.block_reason = payload.patch?.block_reason ?? evidence;
    next.next_action = "resolve_blocker";
  } else if (event === "resume") {
    next.block_reason = null;
    next.previous_status = null;
    if (String(item.block_reason ?? "").startsWith("Rework limit ")) next.rework_count = 0;
  }

  if (REWORK_EVENTS.has(event)) next.rework_count += 1;

  if (event === "approve_requirement") {
    next.human_approval = "approved";
    next.next_action = "start_planning";
    // Gate A 留痕:默认 issue_stop(Issue 评论人工批准);同轮放行
    // (pre_authorized/auto_intake)的硬边界收窄为风险一维——仅 high 拒绝,
    // spec_sync_required 不再构成同轮放行边界,越界抛错、状态不变
    next.approval_source = payload.patch?.approval_source ?? "issue_stop";
    if (["pre_authorized", "auto_intake"].includes(next.approval_source)
      && !["low", "medium"].includes(item.risk_level)) {
      throw new Error("same-turn approval (pre_authorized/auto_intake) requires risk_level low/medium; high-risk items must stop at Gate A for human approval");
    }
  } else if (event === "code_complete") {
    next.coder_result = "completed";
    next.tester_result = "pending";
    next.reviewer_result = "pending";
    next.attempts.coder += 1;
    next.next_action = "run_tests";
  } else if (event === "tests_failed") {
    next.tester_result = "failed";
    next.reviewer_result = "pending";
    next.attempts.tester += 1;
    next.next_action = "return_to_coder";
  } else if (event === "tests_passed") {
    next.tester_result = "passed";
    next.attempts.tester += 1;
    next.next_action = "review";
  } else if (event === "changes_requested") {
    next.reviewer_result = "changes_requested";
    next.attempts.reviewer += 1;
    next.next_action = "return_to_coder";
  } else if (event === "review_approved") {
    next.reviewer_result = "approved";
    next.attempts.reviewer += 1;
    next.next_action = "create_pr";
  } else if (event === "pr_created") {
    next.pr_checks = "unknown";
    next.pr_check_name = null;
    next.pr_check_run_url = null;
    next.pr_head_sha = null;
    next.merge_guard_mode = "unverified";
    next.required_checks_enforced = false;
    next.next_action = "verify_pr_checks";
  } else if (event === "checks_failed") {
    next.pr_checks = "failed";
    next.pr_check_name = null;
    next.pr_check_run_url = null;
    next.pr_head_sha = null;
    next.merge_guard_mode = "unverified";
    next.required_checks_enforced = false;
    next.next_action = "return_to_coder";
  } else if (event === "checks_passed") {
    next.pr_checks = "passed";
    next.next_action = to === "waiting_human_merge" ? "human_merge_approval" : "merge_pr";
  } else if (event === "pr_merged") {
    next.next_action = "human_tag_confirmation";
  } else if (event === "approve_tag") {
    next.tag_confirmation = "approved";
    next.build_status = "running";
    next.next_action = "verify_image";
  } else if (event === "approve_skip") {
    next.tag_confirmation = "skipped_by_human";
    next.build_status = "skipped";
    next.next_action = "close_issue";
  } else if (event === "policy_skip") {
    next.tag_confirmation = "skipped_by_policy";
    next.build_status = "skipped";
    next.next_action = "close_issue";
  } else if (event === "image_verified") {
    next.build_status = "passed";
    next.next_action = "close_issue";
  } else if (event === "specs_synced") {
    next.specs_synced = true;
    next.next_action = "close_issue";
  } else if (event === "issue_created") {
    // 自环回填:issue_number/github_issue_url 经 patch 写入,这里只翻转 pending 标志;
    // 状态与 next_action 保持不变,history 留痕
    next.issue_pending = false;
  } else if (event === "issue_closed") {
    next.issue_state = "closed";
    next.next_action = "none";
  }

  if (to === "blocked" && REWORK_EVENTS.has(event)) {
    next.previous_status = from;
    next.block_reason = `Rework limit ${next.rework_limit} exhausted after ${event}`;
    next.next_action = "human_intervention";
  }

  next.history.push({
    revision: next.revision,
    event,
    from,
    to,
    actor,
    evidence,
    at: timestamp,
  });
  if (next.history.length > 100) next.history = next.history.slice(-100);
  validateWorkItem(next);
  return next;
}

export function validateWorkItem(item) {
  const errors = [];
  const idMatch = String(item.id ?? "").match(ID_PATTERN);
  if (!idMatch) errors.push("invalid id");
  if (typeof item.issue_pending !== "boolean") errors.push("invalid issue_pending");
  // pending 不变量:Issue 未建 ⇒ issue_number/github_issue_url 必为 null、Issue 必为 open;
  // 非 pending(已 flush 或在线开单)⇒ issue_number 必为正整数。本地优先编号后
  // id 数字与 issue_number 解耦(REQ-10 可回填为 Issue #77),旧的 id/issue 相等
  // 不变量随之退役;存量在线开单工单两数本就相等,行为不变
  if (item.issue_pending === true) {
    if (item.issue_number !== null) errors.push("issue_pending requires a null issue_number");
    if (item.github_issue_url !== null) errors.push("issue_pending requires a null github_issue_url");
    if (item.issue_state !== "open") errors.push("issue_pending requires an open Issue state");
  } else if (item.issue_pending === false && (!Number.isInteger(item.issue_number) || item.issue_number <= 0)) {
    errors.push("invalid issue_number");
  }
  if (!STATES.includes(item.status)) errors.push("invalid status");
  if (!RISKS.includes(item.risk_level)) errors.push("invalid risk_level");
  if (!SIZES.includes(item.size)) errors.push("invalid size");
  if (item.size === "small" && item.risk_level !== "low") errors.push("size small requires low risk");
  if (!String(item.title ?? "").trim()) errors.push("title required");
  if (typeof item.required_checks_enforced !== "boolean") errors.push("invalid required_checks_enforced");
  if (!MERGE_GUARD_MODES.includes(item.merge_guard_mode)) errors.push("invalid merge_guard_mode");
  if (item.merge_guard_mode === "github_required_checks" && item.required_checks_enforced !== true) {
    errors.push("github merge guard requires required_checks_enforced");
  }
  if (item.merge_guard_mode === "control_plane_verified" && item.required_checks_enforced !== false) {
    errors.push("control-plane guard cannot claim GitHub enforcement");
  }
  if (item.pr_checks === "passed" && !item.legacy_completion && !mergeGuardSatisfied(item)) {
    errors.push("passed PR checks require complete merge-guard evidence");
  }
  if (typeof item.legacy_completion !== "boolean") errors.push("invalid legacy_completion");
  if (typeof item.spec_sync_required !== "boolean") errors.push("invalid spec_sync_required");
  if (!APPROVAL_SOURCES.includes(item.approval_source)) errors.push("invalid approval_source");
  if (typeof item.specs_synced !== "boolean") errors.push("invalid specs_synced");
  if (item.specs_synced === true && !SHA_PATTERN.test(String(item.specs_commit_sha ?? ""))) {
    errors.push("recorded specs_synced requires a 40-character specs_commit_sha");
  }
  if (item.delivery_required && item.skip_allowed) errors.push("runtime delivery cannot allow skip");
  if (!item.delivery_required && !String(item.delivery_reason ?? "").trim()) errors.push("delivery_reason required");
  if (!Array.isArray(item.history)) errors.push("history must be an array");
  if (!Number.isInteger(item.revision) || item.revision < 1) errors.push("invalid revision");
  if (!Number.isInteger(item.rework_limit) || item.rework_limit < 1) errors.push("invalid rework_limit");
  if (!Number.isInteger(item.rework_count) || item.rework_count < 0) errors.push("invalid rework_count");
  if (item.rework_count > item.rework_limit + 1) errors.push("rework_count exceeds terminal allowance");
  if (item.status === "done") {
    if (item.issue_pending === true) errors.push("done requires the flushed GitHub Issue");
    if (item.issue_state !== "closed") errors.push("done requires closed Issue");
    if (item.human_approval !== "approved") errors.push("done requires requirement approval");
    if (item.tester_result !== "passed") errors.push("done requires passed tests");
    if (item.reviewer_result !== "approved") errors.push("done requires reviewer approval");
    if (item.pr_checks !== "passed") errors.push("done requires passed PR checks");
    if (!item.legacy_completion && !mergeGuardSatisfied(item)) errors.push("done requires a verified merge guard");
    if (!SHA_PATTERN.test(String(item.merged_sha ?? ""))) errors.push("done requires merged_sha");
    if (item.spec_sync_required && item.specs_synced !== true) errors.push("done requires recorded specs_synced while spec_sync_required");
    if (item.specs_synced === true && String(item.specs_commit_sha ?? "") !== String(item.merged_sha ?? "")) {
      errors.push("done requires specs_commit_sha to equal merged_sha");
    }
    if (item.delivery_required) {
      if (item.build_status !== "passed") errors.push("runtime delivery requires passed image build");
      if (!DIGEST_PATTERN.test(String(item.image_digest ?? ""))) errors.push("runtime delivery requires image digest");
      if (!item.legacy_completion) {
        if (item.registry_verified !== true) errors.push("runtime delivery requires registry verification");
        if (item.sbom_status !== "verified") errors.push("runtime delivery requires verified SBOM");
        if (item.provenance_status !== "verified") errors.push("runtime delivery requires verified provenance");
        if (!DIGEST_PATTERN.test(String(item.sbom_digest ?? ""))) errors.push("runtime delivery requires SBOM attestation digest");
        if (!DIGEST_PATTERN.test(String(item.provenance_digest ?? ""))) errors.push("runtime delivery requires provenance attestation digest");
        if (!String(item.release_url ?? "").startsWith("https://github.com/")) errors.push("runtime delivery requires release URL");
      }
    } else if (item.build_status === "skipped" && !item.skip_allowed) {
      errors.push("skip is not allowed");
    }
  }
  if (errors.length) throw new Error(`Invalid Work Item ${item.id ?? "<unknown>"}: ${errors.join("; ")}`);
  return true;
}
