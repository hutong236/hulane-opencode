---
id:
state_revision:
title:
type:
status: waiting_approval
risk_level:
delivery_required: false
delivery_reason:
skip_allowed: true
human_approval: required
owner:
github_issue:
github_state_comment:
github_pr:
branch:
worktree_path:
created:
updated:
agent_owner: orchestrator
agent_status:
coder_result: pending
tester_result: pending
reviewer_result: pending
rework_count: 0
rework_limit: 3
test_result: unknown
pr_checks: unknown
pr_check_name:
pr_check_run_url:
pr_head_sha:
merge_guard_mode: unverified # unverified|github_required_checks|control_plane_verified
required_checks_enforced: false
legacy_completion: false
spec_sync_required: false # standard 工单默认 true（planner 可豁免纯基建/纯文档条目）；small 恒 false
specs_synced: false
specs_commit_sha:
spec_delta_dir:
merge_status: none
build_status: unknown # unknown|running|passed|failed|skipped(人工确认不打 tag 时为 skipped)
tag_confirmation: pending
image:
image_tag:
image_digest:
commit_sha:
workflow_run_url:
registry_verified: false
release_url:
sbom_status: unknown
sbom_digest:
provenance_status: unknown
provenance_digest:
blocked: false
block_reason:
next_action: human_approval
---
# <ID> <中文标题>

## 背景
说明为什么要做这个改动。

## 目标
一句话描述完成后的可验证结果。

## 功能范围
- [ ]

## 非范围
明确不做的部分，避免范围蔓延。

## 验收标准
<!-- 有代码、测试或 Actions 证据后才可打勾，禁止提前勾选。 -->
<!-- 领域工单建议覆盖——前端/UI：页面原型归型、仅令牌配色（无硬编码色值）、明暗双主题、可访问性基线；后端 Go：分层边界、错误包装与哨兵映射、信封与分页、迁移幂等、审计覆盖、Swagger 同步。 -->
<!-- spec_sync_required 工单的验收标准由 delta 的 Scenario 导出：每条 Scenario 至少对应一条可勾选项。 -->
- [ ]

## Planner 摘要
<!-- dispatch hulane-planner 后回填：拆解结论与风险。 -->

## 页面设计
<!-- 仅 page_design_needed 工单回填：hulane-designer 的设计说明（含设计方向与偏离声明）、原型路径与 hulane-design-critic 评分历史；Gate A 随需求与方案一并审批。 -->

## 规格关联
<!-- 仅 spec_sync_required 工单回填：受影响 capability（[[wikilink]] 到 openspec/specs/<capability>/spec.md 的能力名）、
delta 路径（openspec/changes/archive/<ID>/delta.md）、specs_commit_sha（= merged_sha，由 hulane_record_specs_synced 校验记录）、
sync 状态（pending / synced / exempt）。 -->
- capability：
- delta：
- specs_commit_sha：
- sync 状态：

## GitHub
- Issue：
- PR：
- 分支：
- 构建运行：

## 关联
<!-- 用 wikilink 关联其他工单，如 [[REQ-123]]、[[BUG-456]]；无关联可留空。 -->

## Agent 执行记录
<!-- 按 planner / designer / design-critic / coder / tester / reviewer / build-checker 顺序追加结论与证据链接。 -->
