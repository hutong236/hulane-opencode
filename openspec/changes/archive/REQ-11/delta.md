# REQ-11 Delta：已批准 delta 全文快照

批准来源：Gate A 审计于 GitHub Issue #11 审批包（离线开单，评论义务随本 delta
展期至 flush 窗口补发）。以下为该 delta 的逐字快照（标题标记按仓库 delta
模板骨架归一为 `### Requirement:` / `#### Scenario:`，需求与场景正文保持
批准原文），主规格智能合并以此为准。

## ADDED Requirements

（capability：hulane-work-item-lifecycle，新建主规格
`openspec/specs/hulane-work-item-lifecycle/spec.md`）

### Requirement: 开单本地化与本地号自增

hulane_open_work_item SHALL NOT 调用 gh issue create/edit;SHALL 本地创建工单,编号取 store 内全部工单(REQ 与 BUG 前缀合并)数字最大值 + 1,前缀由 type 决定;新工单 SHALL 置 issue_pending=true、issue_number=null、github_issue_url=null,并把 planner_summary 与 acceptance_criteria 持久化进工单供 flush 重建 Issue 正文。

#### Scenario: 断网开单成功

- WHEN gh 不可达时调用 open_work_item
- THEN 本地落 waiting_approval 工单,issue_pending=true、issue_number=null,零 gh 调用

#### Scenario: 本地号自增不撞号

- WHEN store 已有 REQ-9 与 BUG-8 再开 feature
- THEN id 为 REQ-10

#### Scenario: 存量工单祖父回填

- WHEN 读取缺 issue_pending 的存量工单
- THEN normalizeWorkItem 回填 false,行为不变

### Requirement: pending 态不变量与回填写入通道收口

issue_pending=true 时 issue_number/github_issue_url 必为 null、issue_state 必为 open;issue_number/issue_pending 仅 issue_created 事件可写;issue_created 仅对 pending 生效;issue_closed、Done 不变式、pr_created 及 pr-merge/issue-close 授权 SHALL 要求 Issue 已建。

#### Scenario: 状态机拒绝 pending 关单

- WHEN 对 pending 应用 issue_closed
- THEN 抛错状态不变

#### Scenario: 伪造回填被拒

- WHEN 非 issue_created patch 携带 issue_number/issue_pending
- THEN 抛 Unsupported state patch field

#### Scenario: issue_created 自环回填

- WHEN 对 pending 应用 issue_created
- THEN issue_pending=false、状态/next_action 不变、history 留痕;对非 pending 应用 THEN 抛错

#### Scenario: 授权层拒绝 pending 关单

- WHEN issue-close 遇 pending
- THEN 拒绝并提示先 flush

### Requirement: sync 降级与 pending 的 remote-truth-wins 语义

syncItemToGitHub 对 pending 返回 skipped 而非抛错;全部控制面工具默认 sync 经统一降级不阻塞;status 刷新与 hydrate 对 pending 只读本地,不清本地不报错。

#### Scenario: 离线流转不阻塞

- WHEN pending 工单连续 transition
- THEN 每次成功,github.skipped="issue_pending"

#### Scenario: hydrate 尊重 pending

- WHEN pending 调 status(refresh=true)
- THEN 返回本地状态,本地未动

### Requirement: flush 在线窗口

hulane_flush 在一次串行在线窗口完成:标题幂等预查→补建 Issue→改标题→issue_created 回填→一次 sync 打最终标签。push/PR/CI/合并/关单仍走既有逐环节守卫流程,guard 零改动。

#### Scenario: flush 补建回填一气呵成

- WHEN 对 pending 工单在线调用 hulane_flush
- THEN Issue 建立、回填、最终标签与状态注释一次到位

#### Scenario: flush 幂等

- WHEN Issue 已建但回填未落后重跑
- THEN 预查命中复用,不重复建

#### Scenario: flush 不越权

- WHEN flush 完成后进入 push/merge/close 环节
- THEN push/merge/close 仍走原令牌与状态自证

## MODIFIED Requirements

（capability：hulane-spec-layer 与 hulane-release-workflow；delta 全文进 Gate A
审批包——离线开单时评论展期至 flush 窗口，issue_closed 前发布；在线行为不变。
hulane-release-workflow 仅离线开单时审批包评论发布义务展期至 flush 窗口；
其余条款不变。）

### Requirement: delta 全文进 Gate A 审批包

（hulane-spec-layer；保留未提及的既有 scenario，新增离线展期条款）

spec_sync_required 工单 SHALL 把 delta 全文作为一条 GitHub Issue 评论随需求与方案一并进 Gate A 审批包；离线开单（issue_pending=true）时该评论发布义务 SHALL 展期至 flush 在线窗口，在 Issue 补建后、issue_closed 前发布；在线开单行为不变。

#### Scenario: 离线开单评论展期至 flush 窗口

- WHEN spec_sync_required 工单离线开单且 GitHub 暂不可达
- THEN delta 评论义务展期至 hulane_flush 在线窗口，在 Issue 补建后、issue_closed 前发布

### Requirement: Gate A 预授权同轮放行

（hulane-release-workflow；保留未提及的既有 scenario，仅补离线展期条款）

开单同轮自动放行的审批包评论发布义务，在仅离线开单时 SHALL 展期至 flush 在线窗口（Issue 补建后、issue_closed 前发布）；其余条款不变。

#### Scenario: 离线开单评论展期至 flush 窗口

- WHEN 工单离线开单（issue_pending=true）且不落在白名单停等情形
- THEN 同轮自动放行照常生效，审批包评论义务展期至 hulane_flush 在线窗口补发
