# hulane-work-item-lifecycle Specification

## Purpose

承载 hulane 工单生命周期的离线韧性行为基线：开单本地优先（零 gh 调用、本地号自增、
Issue 补建延后）、pending 态不变量与回填写入通道收口（`issue_created` 自环是
`issue_number`/`issue_pending` 的唯一写入通道）、sync 统一降级与 pending 的
remote-truth-wins 语义，以及 `hulane_flush` 在线窗口（幂等预查→补建/复用 Issue→
标题落位→回填→按最终状态一次同步）。GitHub 写操作从每个 transition 压缩到最后一次
在线窗口；push/PR/CI/合并/关单仍走既有逐环节守卫流程，守卫零改动。

## Requirements

### Requirement: 开单本地化与本地号自增

hulane_open_work_item SHALL NOT 调用 gh issue create/edit；SHALL 本地创建工单，编号取 store 内全部工单（REQ 与 BUG 合并）数字最大值+1、前缀由 type 决定；新工单 SHALL 置 issue_pending=true、issue_number=null、github_issue_url=null，并把 planner_summary 与 acceptance_criteria 持久化进工单供 flush 重建 Issue 正文。

#### Scenario: 断网开单成功

- WHEN gh 不可达时调用 open_work_item
- THEN 本地落 waiting_approval 工单，issue_pending=true、issue_number=null，零 gh 调用

#### Scenario: 本地号自增不撞号

- WHEN store 已有 REQ-9 与 BUG-8 再开 feature
- THEN id 为 REQ-10

#### Scenario: 存量工单祖父回填

- WHEN 读取缺 issue_pending 的存量工单
- THEN normalizeWorkItem 回填 false，行为不变

### Requirement: pending 态不变量与回填写入通道收口

issue_pending=true 时 issue_number/github_issue_url 必为 null、issue_state 必为 open；issue_number/issue_pending 仅 issue_created 事件可写；issue_created 仅对 pending 生效；issue_closed、Done 不变式、pr_created 及 pr-merge/issue-close 授权 SHALL 要求 Issue 已建。

#### Scenario: 状态机拒绝 pending 关单

- WHEN 对 pending 应用 issue_closed
- THEN 抛错状态不变

#### Scenario: 伪造回填被拒

- WHEN 非 issue_created patch 携带 issue_number/issue_pending
- THEN 抛 Unsupported state patch field

#### Scenario: issue_created 自环回填

- WHEN 对 pending 应用 issue_created
- THEN issue_pending=false、状态/next_action 不变、history 留痕

#### Scenario: issue_created 对非 pending 抛错

- WHEN 对非 pending 工单应用 issue_created
- THEN 抛错，状态不变

#### Scenario: pr_created 对 pending 抛错

- WHEN 对 pending 工单应用 pr_created
- THEN 抛错，PR 不得挂在不存在的 Issue 上

#### Scenario: 授权层拒绝 pending 关单

- WHEN issue-close 遇 pending
- THEN 拒绝并提示先 flush

### Requirement: sync 降级与 pending 的 remote-truth-wins 语义

syncItemToGitHub 对 pending 返回 skipped 而非抛错；全部控制面工具默认 sync 经统一降级不阻塞；status 刷新与 hydrate 对 pending 只读本地，不清本地不报错。

#### Scenario: 离线流转不阻塞

- WHEN pending 工单连续 transition
- THEN 每次成功，github.skipped="issue_pending"

#### Scenario: hydrate 尊重 pending

- WHEN pending 调 status(refresh=true)
- THEN 返回本地状态，本地未动

### Requirement: flush 在线窗口

hulane_flush 在一次串行在线窗口完成：标题幂等预查→补建 Issue→改标题→issue_created 回填→一次 sync 打最终标签。push/PR/CI/合并/关单仍走既有逐环节守卫流程，guard 零改动。

#### Scenario: flush 补建回填一气呵成

- WHEN 对 pending 工单调用 hulane_flush 且远端无既有 Issue
- THEN Issue 建立、回填、最终标签与状态注释一次到位

#### Scenario: flush 幂等

- WHEN Issue 已建但回填未落（flush 中途中断）重跑 flush
- THEN 预查命中复用，不重复建

#### Scenario: flush 不越权

- WHEN flush 完成后进入 push/merge/close 环节
- THEN 仍走原令牌与状态自证，守卫行为不变
