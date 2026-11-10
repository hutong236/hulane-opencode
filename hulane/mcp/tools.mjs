import { spawnSync } from "node:child_process";
import { applyEvent, validateWorkItem, validateWorkItemInput } from "../scripts/lib/state-machine.mjs";
import { createLocalWorkItem, findControlRoot, getItem, initializeRepositoryState, putItem, readStore } from "../scripts/lib/state-store.mjs";
import {
  createIssue,
  findIssueByTitlePrefix,
  hydrateItemFromGitHub,
  renameIssueTitle,
  resolveRepository,
  runGh,
  syncItemToGitHub,
} from "../scripts/lib/github-state.mjs";
import { createWorktree } from "../scripts/lib/worktree.mjs";
import { issueAuthorization, issueReleaseAuthorization } from "../scripts/lib/authorization.mjs";
import { validateDeliveryEvidence } from "../scripts/lib/delivery.mjs";
import { runPreflight } from "../scripts/lib/preflight.mjs";
import { initializeTargetRepository } from "../scripts/lib/initializer.mjs";
import { writeProjection } from "../scripts/lib/projection.mjs";
import { DEFAULT_PR_CHECK, verifyPullRequestChecks } from "../scripts/lib/pr-checks.mjs";
import { CAPABILITY_SPEC_FILE, isCapabilitySpecPath, SPECS_DIR, validateSpecFile } from "../scripts/lib/specs.mjs";

const objectSchema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string", minLength: 1 };
const id = { type: "string", pattern: "^(REQ|BUG)-[1-9][0-9]*$" };
const commitSha = { type: "string", pattern: "^[0-9a-fA-F]{40}$" };

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "hulane_preflight",
    description: "Read-only readiness check for Git, GitHub, the applicable PR merge guard, and verifiable image delivery.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "hulane_initialize",
    description: "Initialize hulane state, Obsidian projections, PR checks, and tag-only image workflow without touching business code.",
    inputSchema: objectSchema({ repository: { type: "string", pattern: "^[^/]+/[^/]+$" } }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_open_work_item",
    description: "Create the Work Item locally first (offline-capable, zero gh calls): local REQ/BUG numbering, issue_pending=true, planner summary and acceptance criteria persisted for flush. Stops at Gate A. The GitHub Issue is created later by hulane_flush.",
    inputSchema: objectSchema({
      title: text,
      type: { enum: ["feature", "bug", "refactor", "maintenance"] },
      risk_level: { enum: ["low", "medium", "high"] },
      size: { enum: ["standard", "small"], default: "standard" },
      delivery_required: { type: "boolean" },
      delivery_reason: { type: "string" },
      skip_allowed: { type: "boolean" },
      spec_sync_required: { type: "boolean" },
      planner_summary: { type: "string" },
      acceptance_criteria: { type: "array", items: text, minItems: 1 },
      repository: { type: "string", pattern: "^[^/]+/[^/]+$" },
    }, ["title", "type", "risk_level", "delivery_required", "skip_allowed", "planner_summary", "acceptance_criteria"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_transition",
    description: "Apply one evidence-bearing state-machine event, update projection, and normally sync the GitHub Issue.",
    inputSchema: objectSchema({
      id, event: text, actor: text, evidence: text, patch: { type: "object", additionalProperties: true }, to: { type: "string" },
      sync: { type: "boolean", default: true }, repository: { type: "string" },
    }, ["id", "event", "actor", "evidence"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_status",
    description: "Read canonical Work Item status; optionally hydrate GitHub first so remote truth wins.",
    inputSchema: objectSchema({ id, refresh_from_github: { type: "boolean", default: false }, repository: { type: "string" } }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "hulane_validate",
    description: "Validate one or all local Work Items against the V2 state invariants.",
    inputSchema: objectSchema({ id }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "hulane_sync",
    description: "Sync a validated local Work Item to its GitHub Issue state label and machine comment.",
    inputSchema: objectSchema({ id, repository: { type: "string" } }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_hydrate",
    description: "Hydrate canonical state from a GitHub Issue and refresh the local cache/projection.",
    inputSchema: objectSchema({ issue_number: { type: "integer", minimum: 1 }, repository: { type: "string" } }, ["issue_number"]),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "hulane_flush",
    description: "Complete a pending Work Item's GitHub Issue in one serial online window: idempotent title-prefix precheck, create-or-reuse the Issue (body rebuilt from the persisted planner summary / acceptance criteria / delivery policy), rename to '<ID> <title>', record the issue_created self-loop, then one sync with the final state label and full machine comment. Push/PR/CI/merge/close stay in their existing guarded flows.",
    inputSchema: objectSchema({
      id, actor: { const: "orchestrator" }, evidence: text,
      sync: { type: "boolean", default: true }, repository: { type: "string" },
    }, ["id", "actor", "evidence"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_worktree_create",
    description: "Create the approved Work Item's isolated branch/worktree, transition ready to planning, and sync state.",
    inputSchema: objectSchema({
      id, actor: { const: "orchestrator" }, evidence: text, branch: { type: "string" }, base: { type: "string" },
      sync: { type: "boolean", default: true }, repository: { type: "string" },
    }, ["id", "actor", "evidence", "base"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_verify_pr_checks",
    description: "Verify the exact PR head and successful workflow check; use GitHub enforcement when available or the private-repository control-plane guard otherwise.",
    inputSchema: objectSchema({
      id, check_name: { type: "string", minLength: 1, default: DEFAULT_PR_CHECK },
      actor: { const: "orchestrator" }, evidence: text,
      sync: { type: "boolean", default: true }, repository: { type: "string" },
    }, ["id", "actor", "evidence"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_authorize",
    description: "Primary-Agent-only issuance of a state-bound, short-lived, single-use token. Required for git push and git tag mutations; PR merge and Issue close are state-verified by the guard and need no token.",
    inputSchema: objectSchema({
      id, action: { enum: ["git-push", "git-tag", "pr-merge", "issue-close"] },
      actor: { const: "orchestrator" }, ttl_seconds: { type: "integer", minimum: 10, maximum: 600 },
    }, ["id", "action", "actor"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_verify_delivery",
    description: "Cross-check Actions, Release, registry digest, merged SHA, SBOM and provenance; then record image_verified.",
    inputSchema: objectSchema({
      id, workflow_metadata: { type: "object", additionalProperties: true }, release_metadata: { type: "object", additionalProperties: true }, registry_digest: text,
      release_url: text, sbom_digest: text, provenance_digest: text, actor: { const: "orchestrator" }, evidence: text,
      sync: { type: "boolean", default: true }, repository: { type: "string" },
    }, ["id", "workflow_metadata", "release_metadata", "registry_digest", "release_url", "sbom_digest", "provenance_digest", "actor", "evidence"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_record_specs_synced",
    description: "Validate the capability main specs touched by spec_delta_dir (falls back to the full openspec/specs tree when the delta carries no specs/ snapshots) inside the exact specs_commit_sha tree (Git object read, not working tree), then record the specs_synced evidence event. specs_commit_sha must equal the recorded merged_sha.",
    inputSchema: objectSchema({
      id, actor: { const: "orchestrator" }, evidence: text,
      specs_commit_sha: commitSha, spec_delta_dir: text,
      sync: { type: "boolean", default: true }, repository: { type: "string" },
    }, ["id", "actor", "evidence", "specs_commit_sha", "spec_delta_dir"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "hulane_authorize_release",
    description: "Primary-Agent-only issuance of a repository-level release token pair (no Work Item): the strict-SemVer version and 40-char SHA are pinned, the SHA must equal the current origin/main HEAD, and the target tag must not exist remotely. Returns one single-use tag token and one single-use push token for the lightweight /hulane_release path.",
    inputSchema: objectSchema({
      version: text,
      sha: commitSha,
      actor: { const: "orchestrator" },
      evidence: text,
      ttl_seconds: { type: "integer", minimum: 10, maximum: 600, default: 120 },
    }, ["version", "sha", "actor", "evidence"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
]);

function repositoryFor(root, explicit) {
  const configured = readStore(root).repository;
  if (explicit && configured && explicit !== configured) throw new Error(`State store belongs to ${configured}, not ${explicit}`);
  if (explicit) return explicit;
  return configured || resolveRepository(root);
}

function persist(root, item, { sync = true, repository, projection = {} } = {}) {
  putItem(root, item);
  const projectionFile = writeProjection(root, item, projection);
  // 统一 sync 降级:pending 工单不解析仓库(那可能需要 gh)、syncItemToGitHub
  // 自身对 pending 短路返回 skipped,离线流转全程不被 GitHub 阻塞
  const github = sync
    ? syncItemToGitHub(item, item.issue_pending === true ? { cwd: root } : { repository: repositoryFor(root, repository), cwd: root })
    : null;
  return { item, projection_file: projectionFile, github };
}

// 用 git 对象库直接读 specs_commit_sha 提交树里的 openspec/specs 主规格并做
// 结构校验——不依赖工作区状态(合并发生在远端,本地工作区可能还没更新)。
// 提交不在本地对象库时先 fetch 一次默认远端再重试。
// 校验范围优先收窄为 spec_delta_dir 触达的 capability(与规格同步"只重写被触达 capability"
// 的语义对齐);delta 目录在树里没有 specs/ 快照时回退全量,保持保守。
function validateSpecsTreeAtCommit(root, commitSha, deltaDir = "") {
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  };
  const commitKnown = () => spawnSync("git", ["cat-file", "-e", `${commitSha}^{commit}`], { cwd: root }).status === 0;
  if (!commitKnown()) {
    git(["fetch", "origin"]);
    if (!commitKnown()) throw new Error(`commit ${commitSha} is not present in the local Git repository after fetch`);
  }
  const specFiles = git(["ls-tree", "-r", "--name-only", commitSha, "--", "openspec/specs/"])
    .split(/\r?\n/).map((line) => line.trim()).filter(isCapabilitySpecPath);
  if (!specFiles.length) {
    throw new Error(`commit ${commitSha} carries no openspec/specs/<capability>/spec.md capability specs`);
  }
  const normalizedDelta = String(deltaDir ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  let touchedCapabilities = null;
  if (normalizedDelta) {
    const deltaSpecPrefix = `${normalizedDelta}/specs/`;
    const deltaSpecFiles = git(["ls-tree", "-r", "--name-only", commitSha, "--", deltaSpecPrefix])
      .split(/\r?\n/).map((line) => line.trim())
      .filter((file) => file.startsWith(deltaSpecPrefix) && file.endsWith(`/${CAPABILITY_SPEC_FILE}`));
    if (deltaSpecFiles.length) {
      touchedCapabilities = new Set(deltaSpecFiles.map((file) => file.slice(deltaSpecPrefix.length).replace(/\/spec\.md$/, "")));
    }
  }
  const targets = touchedCapabilities
    ? specFiles.filter((file) => touchedCapabilities.has(file.slice(SPECS_DIR.length + 1).replace(/\/spec\.md$/, "")))
    : specFiles;
  if (!targets.length) {
    throw new Error(`delta ${normalizedDelta} in commit ${commitSha} touches no openspec/specs/<capability>/spec.md main spec`);
  }
  const validated = [];
  for (const file of targets) {
    const result = validateSpecFile(file, git(["show", `${commitSha}:${file}`]));
    if (!result) throw new Error(`${file} in commit ${commitSha} is not a recognizable spec document`);
    validated.push(result.kind === "capability"
      ? { file, capability: result.capability, requirements: result.requirements.length }
      : { file, groups: result.groups.map((group) => group.group) });
  }
  return { commit: commitSha, scope: touchedCapabilities ? "delta" : "all", specs: validated };
}

function liveFacts(root, item, repository) {
  const facts = { issue: { number: item.issue_number, state: item.issue_state, url: item.github_issue_url }, pr: null, image_runs: [] };
  if (item.pr_number) {
    try {
      facts.pr = JSON.parse(runGh([
        "pr", "view", String(item.pr_number), "--repo", repository,
        "--json", "number,state,url,isDraft,mergeable,headRefName,baseRefName,mergeCommit,statusCheckRollup",
      ], { cwd: root }));
    } catch (error) {
      facts.pr = { error: error.message };
    }
  }
  if (["building", "waiting_close", "done"].includes(item.status) && item.image_tag) {
    try {
      facts.image_runs = JSON.parse(runGh([
        "run", "list", "--repo", repository, "--workflow", "Hulane Build Image", "--branch", item.image_tag,
        "--limit", "10", "--json", "databaseId,status,conclusion,url,headSha,event,workflowName,headBranch",
      ], { cwd: root }) || "[]");
    } catch (error) {
      facts.image_runs = [{ error: error.message }];
    }
  }
  return facts;
}

// Issue 正文模板:开单入参与持久化工单共用同一份字段(planner_summary/
// acceptance_criteria/size/发版策略),flush 重建正文与首建不漂移
function issueBody(source) {
  const criteria = (source.acceptance_criteria?.length
    ? source.acceptance_criteria.map((value) => `- [ ] ${value}`)
    : ["- [ ] 待补充"]
  ).join("\n");
  const size = source.size ?? "standard";
  const intake = size === "small"
    ? "## Intake\n- size: small (fast lane — inline plan, no planner subagent dispatch)\n\n"
    : "";
  return `<!-- cmdb-dev-work-item:v2 -->\n\n${intake}## Planner summary\n${source.planner_summary || "待补充"}\n\n## Acceptance criteria\n${criteria}\n\n## Delivery policy\n- delivery_required: ${source.delivery_required}\n- skip_allowed: ${source.skip_allowed}\n- reason: ${source.delivery_reason || "Runtime delivery required"}\n`;
}

export function callTool(name, args = {}, context = {}) {
  const root = findControlRoot(context.cwd ?? process.cwd());

  if (name === "hulane_preflight") return runPreflight(root);
  if (name === "hulane_initialize") return initializeTargetRepository(root, context.pluginRoot, args.repository ?? null);

  if (name === "hulane_open_work_item") {
    // 本地优先开单(REQ-11):输入校验前置,之后零 gh 调用——编号取 store 内
    // 全部工单(REQ/BUG 合并)最大值+1,前缀由 type 决定;planner_summary 与
    // acceptance_criteria 持久化进工单,供 flush 在线窗口重建 Issue 正文;
    // 历史上「先建 Issue 再初始化」的孤儿与回滚问题随建单本地化一并消失
    validateWorkItemInput(args);
    const configured = readStore(root).repository;
    if (args.repository && configured && args.repository !== configured) {
      throw new Error(`State store belongs to ${configured}, not ${args.repository}`);
    }
    const repository = args.repository ?? configured ?? null;
    // Initialization binds the repository and creates local support folders.
    // Allocation and first state persist now happen in ONE guarded transaction.
    initializeRepositoryState(root, repository);
    const item = createLocalWorkItem(root, {
      title: args.title,
      type: args.type,
      risk_level: args.risk_level,
      size: args.size ?? "standard",
      delivery_required: args.delivery_required,
      delivery_reason: args.delivery_reason,
      skip_allowed: args.skip_allowed,
      spec_sync_required: args.spec_sync_required,
      planner_summary: args.planner_summary,
      acceptance_criteria: args.acceptance_criteria,
    }, repository);
    const result = persist(root, item, {
      sync: true,
      repository,
      projection: { plannerSummary: args.planner_summary, acceptanceCriteria: args.acceptance_criteria },
    });
    return { ...result, issue_pending: true, flush_hint: "GitHub Issue not created yet; call hulane_flush in the next online window" };
  }

  if (name === "hulane_transition") {
    if (["start_planning", "checks_passed", "image_verified", "specs_synced", "issue_created"].includes(args.event)) {
      throw new Error(`${args.event} is reserved for its dedicated MCP evidence tool`);
    }
    const item = getItem(root, args.id);
    const next = applyEvent(item, args.event, { actor: args.actor, evidence: args.evidence, patch: args.patch ?? {}, to: args.to });
    return persist(root, next, { sync: args.sync !== false, repository: args.repository });
  }

  if (name === "hulane_status") {
    if (!args.id) return readStore(root, { allowMissing: false });
    let item = getItem(root, args.id);
    let repository = null;
    if (args.refresh_from_github) {
      if (item.issue_pending === true) {
        // remote-truth-wins 尊重 pending:远端尚无此单,刷新退化为只读本地,
        // 不因远端无单清掉本地或报错
        item = getItem(root, args.id);
      } else {
        repository = repositoryFor(root, args.repository);
        item = hydrateItemFromGitHub({ repository, issueNumber: item.issue_number, cwd: root });
        putItem(root, item, { source: "github" });
        writeProjection(root, item);
      }
    }
    return { item, facts: repository ? liveFacts(root, item, repository) : null };
  }

  if (name === "hulane_validate") {
    if (args.id) validateWorkItem(getItem(root, args.id));
    else for (const item of Object.values(readStore(root, { allowMissing: false }).items)) validateWorkItem(item);
    return { valid: true, id: args.id ?? null };
  }

  if (name === "hulane_sync") {
    const item = getItem(root, args.id);
    // pending 工单的 sync 统一降级:不解析仓库、不触 gh,返回 skipped
    if (item.issue_pending === true) return syncItemToGitHub(item, { cwd: root });
    return syncItemToGitHub(item, { repository: repositoryFor(root, args.repository), cwd: root });
  }

  if (name === "hulane_hydrate") {
    const item = hydrateItemFromGitHub({ repository: repositoryFor(root, args.repository), issueNumber: args.issue_number, cwd: root });
    putItem(root, item, { source: "github" });
    return { item, projection_file: writeProjection(root, item) };
  }

  if (name === "hulane_flush") {
    // flush 在线窗口(REQ-11):一次串行完成幂等预查→补建/复用 Issue→标题落位
    // →issue_created 回填→按最终状态做一次 sync(最终 hulane:<status> 标签 +
    // 全量状态注释,注释本身携带全量 history,不回放历史标签)。
    // push/PR/CI/合并/关单不并入 flush,仍走既有逐环节守卫流程。
    const item = getItem(root, args.id);
    if (item.issue_pending !== true) {
      throw new Error(`${args.id} has no pending GitHub Issue to flush (already bound to Issue #${item.issue_number}); use hulane_sync instead`);
    }
    const repository = repositoryFor(root, args.repository);
    const run = (ghArgs) => runGh(ghArgs, { cwd: root });
    const canonicalTitle = `${item.id} ${item.title}`;

    // 1. 幂等预查:Issue 已建但本地回填未落(flush 中途断线)时复用,不重复建
    const existing = findIssueByTitlePrefix({ repository, workItemId: item.id, cwd: root, run });
    let issue;
    if (existing) {
      issue = { number: existing.number, url: existing.url };
      renameIssueTitle({ repository, issueNumber: issue.number, title: canonicalTitle, cwd: root, run });
    } else {
      // 2+3. 补建 Issue:正文由工单持久化的 planner_summary/acceptance_criteria/
      // 发版策略重建,标题直接落 `<ID> <title>` 规范形
      issue = createIssue({ repository, title: canonicalTitle, body: issueBody(item), cwd: root, run });
    }

    // 4. issue_created 自环回填(写入通道收口:仅此事件可写 issue_number/issue_pending)
    const next = applyEvent(item, "issue_created", {
      actor: args.actor,
      evidence: args.evidence,
      patch: { issue_number: issue.number, github_issue_url: issue.url },
    });

    // 5. 以当前最终状态做一次 sync
    const result = persist(root, next, { sync: args.sync !== false, repository });
    return {
      ...result,
      issue_number: issue.number,
      issue_url: issue.url,
      reused_existing_issue: Boolean(existing),
    };
  }

  if (name === "hulane_worktree_create") {
    const item = getItem(root, args.id);
    if (item.status !== "ready") throw new Error("Worktree creation requires ready state");
    const worktree = createWorktree(root, { id: args.id, branch: args.branch, base: args.base });
    const next = applyEvent(item, "start_planning", {
      actor: args.actor,
      evidence: args.evidence,
      patch: { branch: worktree.branch, worktree_path: worktree.path },
    });
    return { worktree, ...persist(root, next, { sync: args.sync !== false, repository: args.repository }) };
  }

  if (name === "hulane_verify_pr_checks") {
    const item = getItem(root, args.id);
    const repository = repositoryFor(root, args.repository);
    const verification = verifyPullRequestChecks({
      root,
      repository,
      item,
      checkName: args.check_name ?? DEFAULT_PR_CHECK,
    });
    const next = applyEvent(item, "checks_passed", {
      actor: args.actor,
      evidence: args.evidence,
      patch: verification.patch,
    });
    return { verification, ...persist(root, next, { sync: args.sync !== false, repository }) };
  }

  if (name === "hulane_authorize") {
    return issueAuthorization(root, { id: args.id, action: args.action, actor: args.actor, ttlSeconds: args.ttl_seconds });
  }

  if (name === "hulane_authorize_release") {
    return issueReleaseAuthorization(root, {
      version: args.version,
      sha: args.sha,
      actor: args.actor,
      evidence: args.evidence,
      ttlSeconds: args.ttl_seconds ?? 120,
    });
  }

  if (name === "hulane_verify_delivery") {
    const item = getItem(root, args.id);
    if (item.status !== "building") throw new Error("Delivery verification requires building state");
    const patch = validateDeliveryEvidence({
      item,
      workflowMetadata: args.workflow_metadata,
      releaseMetadata: args.release_metadata,
      registryDigest: args.registry_digest,
      releaseUrl: args.release_url,
      sbomDigest: args.sbom_digest,
      provenanceDigest: args.provenance_digest,
    });
    const next = applyEvent(item, "image_verified", { actor: args.actor, evidence: args.evidence, patch });
    return persist(root, next, { sync: args.sync !== false, repository: args.repository });
  }

  if (name === "hulane_record_specs_synced") {
    const item = getItem(root, args.id);
    if (item.specs_synced === true) throw new Error(`${args.id} has already recorded specs_synced`);
    if (String(args.specs_commit_sha ?? "") !== String(item.merged_sha ?? "")) {
      throw new Error("specs_commit_sha must equal the recorded merged_sha");
    }
    // 先校验 merged_sha 提交树里的主规格结构,非法即拒绝,不动状态
    const specs_validation = validateSpecsTreeAtCommit(root, args.specs_commit_sha, args.spec_delta_dir);
    const next = applyEvent(item, "specs_synced", {
      actor: args.actor,
      evidence: args.evidence,
      patch: { specs_commit_sha: args.specs_commit_sha, spec_delta_dir: args.spec_delta_dir },
    });
    return { specs_validation, ...persist(root, next, { sync: args.sync !== false, repository: args.repository }) };
  }

  throw new Error(`Unknown MCP tool: ${name}`);
}
