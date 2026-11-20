# REQ-11 Decisions：关键取舍记录

工单:REQ-11(离线韧性——本地优先开单、sync 降级与 flush 上线)。Gate A 审计于
Issue #11 审批包。以下为批准时已裁决事项(编排者按已批准方案派发,非阻塞),
实现按此执行,不再自行取舍。

## ① 开单彻底本地化，不做「在线优先、失败降级」

- 编号 = store 内全部工单(REQ 与 BUG 前缀合并)数字最大值 + 1,与 GitHub Issue
  号解耦;旧「id 数字 == issue_number」不变量随之退役(存量在线开单工单两数本就
  相等,行为不变)。备选「先试 gh、超时再本地」被否:开单路径仍被网络超时拖住,
  且两套编号来源增加撞号面。
- 不再调 gh issue create/edit,孤儿回滚代码删除——本地开单不再可能产生
  「有 Issue 无状态机」的孤儿(3.7.2 的两条防线分别由前移校验与本地化覆盖)。

## ② issue_created 自环 + 写入通道收口(仿 specs_synced)

- `issue_number`/`issue_pending` 仅 issue_created 事件可写,其余 transition patch
  携带即抛 "Unsupported state patch field";generic hulane_transition 把
  issue_created 列为保留事件,回填只能来自 hulane_flush 的真实 gh 结果——
  防止任意事件伪造绑定到从未建过的 Issue。
- issue_created 为任意状态自环(blocked 亦可 flush),不改状态/next_action,
  history 留痕。

## ③ pending 硬前置:pr_created / issue_closed / Done / 授权层

- PR、合并、关单都指向真实 GitHub 对象,pending 一律拒绝并提示先 flush;
  授权层 assertActionState 对 issue-close 与 pr-merge 各补一行显式断言
  (token 路径与状态自证路径共用)。
- specs_synced 事件不要求 Issue 已建:规格证据可离线记录,GitHub 评论留痕
  (含 spec delta 审批包)随 flush 窗口补发、issue_closed 前完成(两条 MODIFIED)。

## ④ sync 降级语义:skipped 而非静默

- syncItemToGitHub 对 pending 返回 `{skipped: "issue_pending", ...}`,调用方
  可见降级事实;status(refresh=true) 对 pending 只读本地,remote-truth-wins
  尊重 pending(远端无单不清本地、不报错)。
- hulane_hydrate 按 Issue 号工作,pending 工单无号可 hydrate;flush 中途断线
  留下的「已建未回填」Issue 由 flush 幂等预查恢复,CLI hydrate 对该错误补
  降级文案指引。

## ⑤ flush 只补建,不并权

- flush 窗口 = 预查→补建/复用→标题落位→回填→一次最终 sync(状态注释含全量
  history,不回放历史标签)。push/PR/CI/合并/关单不并入;push 仍需
  hulane_authorize 令牌,guard push 白名单只认显式远端 URL 目标、不认 origin
  别名——两坑随文档化。guard.mjs/discipline.mjs 及其测试零改动。
- 幂等预查用 `gh issue list --search '<ID> in:title'` 再按 `<ID> ` 前缀过滤
  (正文命中的不算),含已关闭 Issue,覆盖中断恢复。

## ⑥ 已知残余风险

- 本地号跨仓库不唯一:同一业务仓库只用一个 store,不构成问题;若人为分裂
  控制目录,flush 预查按标题前缀仍能发现既有 Issue 并复用。
- 极端并发(同一 store 两个编排者同时开单)可能分到同号——单写者编排约定
  下接受,与既有 putItem 无锁写盘同风险面。
