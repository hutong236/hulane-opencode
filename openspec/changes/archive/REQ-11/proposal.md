# REQ-11 Proposal：离线韧性——本地优先开单、sync 降级与 flush 上线

## What

用户 WiFi 访问 GitHub 极不稳定。此前 `hulane_open_work_item` 第一步就 `gh issue
create`（含 edit 改标题与孤儿回滚），之后每个 transition 经 persist() 实时
syncItemToGitHub，网络抖动即阻塞开单与全部流转。

本变更把开单与本地验证全程离线化，GitHub 写操作压缩到最后一次在线窗口：

1. 开单本地化：编号取 store 内全部工单（REQ 与 BUG 前缀合并）数字最大值+1，
   前缀由 type 决定；不再调 gh issue create/edit，删除孤儿回滚；新工单
   `issue_pending=true`、`issue_number=null`、`github_issue_url=null`；
   `planner_summary` 与 `acceptance_criteria` 持久化进工单供 flush 重建 Issue 正文。
2. pending 不变量与写入通道收口：pending 时 issue_number/github_issue_url 必为
   null、issue_state 必为 open；`issue_number`/`issue_pending` 仅新增自环事件
   `issue_created`（仿 specs_synced）可写；issue_closed、Done 不变式、pr_created
   与授权层 issue-close/pr-merge 均要求 Issue 已建。
3. sync 降级：syncItemToGitHub 对 pending 返回 `{skipped: "issue_pending"}`；
   status 刷新与 hydrate 对 pending 只读本地（remote-truth-wins 尊重 pending）。
4. `hulane_flush` 新工具 + `/hulane_flush` 命令：一次串行在线窗口完成幂等
   `<ID> ` 标题预查→补建/复用 Issue→标题落位→issue_created 回填→按最终状态
   一次 sync（最终标签 + 全量状态注释，不回放历史标签）。push/PR/CI/合并/关单
   不并入 flush，guard.mjs 与 discipline.mjs 零改动。
5. 配套：projection/JSON schema 增 pending 字段与条件约束；preflight 把 GitHub
   依赖检查归入 online_required 分组并加 offline_open_ready；兼容 CLI `new`
   允许省略 `--issue`，sync/hydrate 出降级文案；文档与规格同步。

## Why

- 网络是本环境最高频故障源；开单是流程入口，入口被 gh 阻塞则整条流水线停摆。
- 状态机的全部证据都在本地产生（transition patch + history），GitHub 只是审计
  与交付面——写操作天然可以压缩到一个在线窗口而不损失任何不变量。
- 关单/合并/PR 前置强制 Issue 已补建，保证「本地号」与「远端 Issue」最终一致，
  审计链不留断点；守卫零改动使越权面不因离线韧性扩大。

主规格：新增 `openspec/specs/hulane-work-item-lifecycle/spec.md`；MODIFIED 合并进
`hulane-spec-layer`（离线开单时评论展期至 flush 窗口）与 `hulane-release-workflow`
（仅审批包评论发布义务展期，其余条款不变）。
