# REQ-3 Proposal：hulane 原生能力规格层

## What

给 hulane V3.6.0 增加原生能力规格层（OpenSpec 兼容格式）：

- 业务仓库以 `openspec/specs/<capability>/spec.md` 沉淀各能力的行为基线（唯一 H1 `# <capability> Specification`、`## Purpose`、`## Requirements`，每个 `### Requirement:` 为 SHALL 语句且至少带一个 `#### Scenario:` WHEN/THEN 列表；正文可中文）。
- 规划期（hulane-planner）读取被触碰 capability 的主规格并产出 delta（`## ADDED|MODIFIED|REMOVED|RENAMED Requirements` 分组；RENAMED 条目用 FROM:/TO: 行），delta 全文进 Gate A 审批包，验收标准从 Scenario 导出。
- 实现期（hulane-coder）在 worktree 内写 `openspec/changes/archive/<REQ-ID>/` 决策史，并在同一 PR 内完成 delta→主规格的智能合并（ADDED 追加/同名按 MODIFIED、MODIFIED 保留未提及 scenario、REMOVED 删整块、RENAMED 改名；只改触碰到的 capability）。
- 合并后、关单前，编排者经新 MCP 工具 `hulane_record_specs_synced` 对 merged_sha 提交树做规格结构校验（Git 对象读取，不依赖工作区），通过即记录 `specs_synced` 事件，`specs_commit_sha = merged_sha`。
- 该前置由状态机不变式（issue_closed/Done）与 PreToolUse 守卫（gh issue close，令牌与状态自证共用断言）双层强制——是机制不是提示词纪律。

## Why

- 规格资产沉淀：主规格=行为基线，changes 归档=决策史，业务逻辑随代码一起可追溯。
- 变更提效：同一份 delta 契约复用为 Gate A 验收标准、Tester 用例来源（scenario→覆盖矩阵）与 Reviewer 行为对照。
- 状态机强制：不做只靠 prompt 的"建议同步"，未同步的 spec_sync_required 工单无法关单。

## 方案对比与裁决

| 维度 | 方案 A（工具直接推送合并后的主规格） | 方案 B（sync 随实现 PR 提交，已裁决采用） |
| --- | --- | --- |
| 主规格合并的审查时机 | merge 后由控制面推送，绕过 PR 评审 | 随实现 PR 一起评审，规格与代码同框 |
| 新增授权动作 | 需要新增 specs-sync-push 动作与令牌形态 | 不新增任何授权动作（ACTIONS/ACTION_STATES 不动） |
| 控制面职责 | 读工作区/写 git，破坏"控制面不写业务代码"边界 | merge 后只读 Git 对象做校验并记事件 |
| 回滚与追溯 | 控制面提交游离于工单 PR 之外 | 规格变更与实现同 PR、同 merged_sha |

方案 B 由 Gate A 裁决采用：合并语义由 coder 在 worktree 内完成并随 PR 审查；merge 后编排者仅对 merged_sha 树做结构校验并记录 `specs_synced`（`specs_commit_sha = merged_sha`），不新增 specs-sync-push 授权动作。

## 状态机落点

- `waiting_close` 增加自环事件 `specs_synced: waiting_close`；证据=merged_sha 已记录 + 40 位 specs_commit_sha + 非空 spec_delta_dir。
- `spec_sync_required`：standard 默认 true（纯基建/纯文档由 planner 显式豁免并记录原因）、small 恒 false、存量工单祖父回填 false。
- `issue_closed` 前置与 Done 不变式镜像同一约束；守卫 issue-close 断言与授权令牌路径共用。
