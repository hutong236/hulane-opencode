import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function yaml(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function frontmatter(item) {
  const fields = [
    ["id", item.id], ["state_revision", item.revision], ["title", item.title], ["type", item.type],
    ["status", item.status], ["risk_level", item.risk_level], ["delivery_required", item.delivery_required],
    ["delivery_reason", item.delivery_reason], ["skip_allowed", item.skip_allowed], ["human_approval", item.human_approval],
    ["approval_source", item.approval_source],
    ["issue_pending", item.issue_pending],
    ["github_issue", item.issue_number], ["github_issue_url", item.github_issue_url], ["github_pr", item.pr_number],
    ["github_pr_url", item.github_pr_url], ["branch", item.branch], ["worktree_path", item.worktree_path],
    ["agent_owner", item.agent_owner], ["coder_result", item.coder_result], ["tester_result", item.tester_result],
    ["reviewer_result", item.reviewer_result], ["rework_count", item.rework_count], ["rework_limit", item.rework_limit],
    ["pr_checks", item.pr_checks], ["pr_check_name", item.pr_check_name], ["pr_check_run_url", item.pr_check_run_url],
    ["pr_head_sha", item.pr_head_sha], ["merge_guard_mode", item.merge_guard_mode],
    ["required_checks_enforced", item.required_checks_enforced], ["legacy_completion", item.legacy_completion],
    ["spec_sync_required", item.spec_sync_required], ["specs_synced", item.specs_synced],
    ["specs_commit_sha", item.specs_commit_sha], ["spec_delta_dir", item.spec_delta_dir],
    ["tag_confirmation", item.tag_confirmation], ["build_status", item.build_status],
    ["image", item.image], ["image_tag", item.image_tag], ["image_digest", item.image_digest],
    ["workflow_run_url", item.workflow_run_url], ["registry_verified", item.registry_verified], ["release_url", item.release_url],
    ["sbom_status", item.sbom_status], ["sbom_digest", item.sbom_digest], ["provenance_status", item.provenance_status], ["provenance_digest", item.provenance_digest], ["blocked", item.blocked],
    ["block_reason", item.block_reason], ["next_action", item.next_action], ["created", item.created_at], ["updated", item.updated_at],
  ];
  return `---\n${fields.map(([key, value]) => `${key}: ${yaml(value)}`).join("\n")}\n---`;
}

function initialBody(item, { plannerSummary = "", acceptanceCriteria = [] } = {}) {
  const criteria = acceptanceCriteria.length ? acceptanceCriteria.map((value) => `- [ ] ${value}`).join("\n") : "- [ ] 待补充";
  // pending 工单的 Issue 引用显示「Issue 待补建(flush)」,提示先跑在线补建窗口
  const issueReference = item.issue_pending === true
    ? "Issue 待补建（flush）"
    : (item.github_issue_url ?? `#${item.issue_number}`);
  const background = item.issue_pending === true
    ? `本地优先开单（issue_pending=true），GitHub Issue 待 hulane_flush 在线窗口补建。`
    : `来自 GitHub Issue #${item.issue_number}。`;
  return `# ${item.id} ${item.title}\n\n## 背景\n${background}\n\n## 目标\n${item.title}\n\n## 功能范围\n- [ ] 按已批准范围实施\n\n## 非范围\n未经批准的范围变更。\n\n## 验收标准\n${criteria}\n\n## Planner 摘要\n${plannerSummary || "待补充"}\n\n## 规格关联\n- capability：\n- delta：\n- specs_commit_sha：\n- sync 状态：\n\n## GitHub\n- Issue：${issueReference}\n- PR：\n- 分支：\n- 构建运行：\n\n## 关联\n\n## Agent 执行记录\n`;
}

export function projectionPath(root, item) {
  const directory = item.type === "bug" ? "plan/02_Bugs" : "plan/01_Requirements";
  return path.join(root, directory, `${item.id}.md`);
}

export function writeProjection(root, item, options = {}) {
  const file = projectionPath(root, item);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let body = initialBody(item, options);
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, "utf8");
    const match = current.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
    if (match) body = match[1];
  }
  const temporary = path.join(path.dirname(file), `.${item.id}-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${frontmatter(item)}\n${body.trimEnd()}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}
