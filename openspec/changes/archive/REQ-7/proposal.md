# REQ-7 Proposal：Gate A 白名单化(开单同轮默认自动放行)

## What

把 Gate A 从「无差别停」反转为「开单同轮默认自动放行 + 审批包 Issue 评论留痕不阻断」:

- **默认同轮自动放行**:开单完成后编排者同轮应用 `approve_requirement`,默认
  actor="orchestrator"、`patch.approval_source="auto_intake"`(新枚举值),evidence
  引用用户本轮原话;用户原话含明确批准措辞(如「直接做」「预授权」)时改用
  `pre_authorized` 且 actor 为 `human:<身份>` 形式。审批包(需求、方案、页面设计
  含评分历史、spec delta 全文或摘要+路径)先发 GitHub Issue 评论留痕,自动放行
  不豁免该评论。
- **停等白名单收窄为三种**:① risk_level=high(状态机强制);② Planner 报告需求
  歧义/scope_questions 未闭合(编排文档义务);③ 用户明说「等我确认」等显式暂停
  (编排文档义务)。三种情形维持 STOP 等 `/hulane_approve`。
- **spec_sync_required 不再构成停等理由**:同轮放行硬边界由「低/中风险 + 非规格」
  收窄为「仅 high 拒」;`pre_authorized` 边界同步放宽(特权单调性:避免弱审计
  通道能批规格工单而强审计通道反而不能的倒挂)。
- **actor 诚实性状态机强制**:`auto_intake` 的 actor 必须恰为 "orchestrator",
  出现任何 `human:<身份>` 形式反而抛错;`pre_authorized` 的 `human:<身份>` 硬校验
  保持不变。`/hulane_approve` 保留为人工覆盖通道(`issue_stop` 语义不变)。

## Why

- 会话取证(2026-10-13,db.sqlite 近三周记录)证实:每次开单(REQ/BUG 均是)后都停在
  waiting_approval,用户须手工敲 `/hulane_approve`;即使原话已说「同意开单」
  (10-12 23:39)仍须再敲一次(23:51)。根因:V3.7.0 预授权通道 (a) 措辞门槛过严
  (b) `spec_sync_required=true` 一律停(状态机硬校验,而 standard 工单默认 true)。
- 「用户已在本轮说出需求并认可方向」本身就是批准事实;再用一次人工审批命令把它
  重新登记一遍是纯确认仪式。把这一事实以留痕方式接进状态机(auto_intake +
  evidence 引用原话 + 审批包评论),既消灭仪式又保住审计链——审批包评论不豁免,
  Issue 上仍可事后回溯「为什么这单没停」。
- 停等收窄为白名单后,人工审批回归其本义:只在机器无法自证的场合(高风险、
  需求歧义、用户要停)介入。

## 改动面

- `hulane/scripts/lib/state-machine.mjs`:`APPROVAL_SOURCES` 扩枚举;
  `requireHumanActor` 增 auto_intake 豁免分支(actor 恰为 orchestrator,其余
  human 事件与 pre_authorized 校验不变);`approve_requirement` 边界块改写为
  仅 high 拒(错误消息保留 "must stop at Gate A" 尾串);`APPROVAL_TRACE_FIELDS`
  写入通道收口、normalizeWorkItem 回填、createWorkItem 默认值全部不动。
- `hulane/schemas/work-item-state.schema.json`:`approval_source` 枚举加
  `auto_intake`(三值)。
- `test/state-machine.test.mjs`:高风险拒绝断言扩为双枚举值;原「spec 工单拒绝
  预授权」「不允许借预授权豁免规格」两条 throw 断言反转为生效断言;新增
  auto_intake 用例、actor 诚实性用例、写入通道收口 auto_intake 变体、端到端
  全链(开单→auto_intake→…→policy_skip→specs_synced→issue_closed→done)。
- 编排文档:`SKILL.md`(Human gates 第 1 条、生命周期第 5/10/11 步)、
  `hulane_dev.md`、`hulane_approve.md`(/hulane_approve 定位为人工覆盖通道)。
- 主规格智能合并:`hulane-release-workflow` 三条需求(同轮放行/硬边界/留痕收口)、
  `hulane-spec-layer` 一条需求(delta 全文进审批包)按批准 delta 改写。
- 仓库文档:README/FLOWCHARTS/Hulane_ZCode_AI_Dev_Workflow/CHANGELOG(Unreleased)。

## 交付策略

`delivery_required: false` / `skip_allowed: true`(按需批量发版;流程改造单,
合并后随下一次 `/hulane_release` 批量出镜像)。
