# REQ-3 Decisions：Gate A 裁决记录

工单：REQ-3（hulane V3.6.0 原生能力规格层）。以下为 Gate A 批准时已裁决事项，实现按此执行，不再自行取舍。

## ② 主规格合并路径：方案 B（sync 掚实现 PR 提交）

- 主规格的智能合并随实现 PR 一起提交审查，由 coder 在 worktree 内完成合并；merge 后编排者仅对 merged_sha 提交树做结构校验并经新 MCP 工具记录事件，`specs_commit_sha = merged_sha`。
- 不新增任何 specs-sync-push 授权动作：`authorization.mjs` 的 ACTIONS/ACTION_STATES 保持不动。
- 弃选方案 A（控制面在 merge 后直接推送合并后的主规格）：需要新增授权动作与令牌形态，主规格变更游离于工单 PR 评审之外，且控制面将写业务代码，破坏既有边界。

## ② spec_sync_required 默认值

- standard 工单默认 `spec_sync_required: true`。
- 纯基建/纯 docs 的 standard 工单由 planner 显式豁免（`spec_sync_required: false`）并在工单记录原因。
- small 工单恒 `false`（快车道不吃规格层前置）。

## ③ 决策史归档命名

- 归档目录固定为 `openspec/changes/archive/<REQ-ID>/`，内含 proposal.md（what & why + 方案对比）、delta.md（批准时的 delta 快照）、decisions.md（裁决记录）。

## ④ Gate A 审批 comment 携带 delta

- Gate A 审批包中的 delta 以全文贴出；过长时改为摘要 + 仓库内路径。

## ⑤ pr-checks 软校验

- `hulane-pr-checks.sh`（模板与本仓库工作副本两处同步）增加可选软校验：仅当存在 `openspec/` 目录且本机有 openspec CLI 时运行 `openspec validate --specs`，否则跳过、不计为失败。
