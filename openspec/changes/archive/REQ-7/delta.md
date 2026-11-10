# REQ-7 Delta：已批准 delta 全文快照

批准来源：GitHub Issue #7 审批包评论 issuecomment-6149814366（2026-10-13，
用户原话「开单,开始实施」构成批准）。以下为该 delta 的逐字快照,主规格智能
合并以此为准。

# REQ-7 Delta Spec:hulane-release-workflow 能力(MODIFIED)

## MODIFIED Requirements

### Requirement: Gate A 预授权同轮放行

开单完成后,编排者 SHALL 在同轮应用 approve_requirement 使工单直达 ready,不在 waiting_approval 停等:默认以 actor="orchestrator"、patch.approval_source="auto_intake" 应用,evidence SHALL 引用用户本轮原话;用户原话含明确批准措辞(如「直接做」「预授权」)时 SHALL 改用 patch.approval_source="pre_authorized" 且 actor 为 human:<身份> 形式。无论走哪条同轮通道,编排者 SHALL 把审批包(需求、方案、页面设计含评分历史、spec delta 全文或摘要+路径)作为一条 GitHub Issue 评论发布留痕,自动放行不豁免该评论。/hulane_approve SHALL 保留为人工覆盖通道(approval_source="issue_stop" 语义不变)。仅白名单停等情形 SHALL 维持 STOP:① risk_level=high;② Planner 报告需求歧义或 scope_questions 未闭合;③ 用户明说「等我确认」等显式暂停。spec_sync_required=true SHALL 不再构成停等理由。

#### Scenario: 开单默认同轮自动放行
- WHEN 开单完成且不落在任何白名单停等情形
- THEN 编排者同轮应用 approve_requirement(actor="orchestrator"、patch.approval_source="auto_intake"、evidence 引用用户原话),审批包评论先行发布,工单到达 ready、human_approval=approved,不停等

#### Scenario: 显式批准原话走 pre_authorized
- WHEN 用户需求原话含明确批准措辞且不落在白名单停等情形
- THEN 同轮 approve_requirement 以 patch.approval_source="pre_authorized"、actor=human:<身份> 应用,evidence 引用该批准原话

#### Scenario: 规格工单不再停等
- WHEN spec_sync_required=true 的 standard 工单开单完成且不落在白名单停等情形
- THEN Gate A 同轮自动放行,spec delta 随审批包评论留痕,不因规格同步要求停等

#### Scenario: 存量工单与既有通道不受影响
- WHEN 存量 waiting_approval 工单继续走 /hulane_approve,或缺 approval_source 字段的存量工单经 normalizeWorkItem 读取
- THEN 既有行为不变(人工批准仍记 issue_stop,存量回填 issue_stop 后照常流转)

### Requirement: 预授权硬边界（状态机强制）

状态机 SHALL 仅对 risk_level ∈ {low,medium} 的工单接受 approval_source ∈ {"pre_authorized","auto_intake"} 的 approve_requirement 事件;risk_level=high 的工单 SHALL 永远拒绝同轮放行并保持 waiting_approval。spec_sync_required SHALL 不再构成同轮放行边界。actor 诚实性 SHALL 强制:approval_source="auto_intake" 的事件 actor 必须恰为 "orchestrator",approval_source="pre_authorized" 的事件 actor 必须匹配 human:<身份> 形式,错配即抛错、状态不变。

#### Scenario: 高风险拒绝同轮放行
- WHEN 对 risk_level=high 的工单应用 approval_source="pre_authorized" 或 "auto_intake" 的 approve_requirement
- THEN 状态机抛错,工单状态仍为 waiting_approval

#### Scenario: spec_sync_required 不再拒绝
- WHEN 对 spec_sync_required=true 且 risk_level ∈ {low,medium} 的工单应用同轮放行事件(auto_intake 或 pre_authorized)
- THEN 边界校验通过,事件生效并留痕

#### Scenario: auto_intake actor 诚实性
- WHEN approval_source="auto_intake" 的 approve_requirement 携带 "orchestrator" 以外的任何 actor(含 human:<身份> 形式)
- THEN 状态机抛错,事件不生效

#### Scenario: pre_authorized actor 形式保持
- WHEN approval_source="pre_authorized" 的 approve_requirement 的 actor 不匹配 human:<身份> 形式
- THEN 状态机抛错,事件不生效

#### Scenario: 中低风险同轮放行生效
- WHEN 对 risk_level ∈ {low,medium} 的工单应用边界内的同轮放行事件
- THEN 事件生效,工单到达 ready,approval_source 与 actor 按通道如实留痕

### Requirement: approval_source 留痕与写入通道收口

approve_requirement SHALL 把 approval_source(枚举 "issue_stop" | "pre_authorized" | "auto_intake")写入工单状态并随事件历史(actor/evidence)留痕;该字段 SHALL 仅允许 approve_requirement 事件写入,其余事件携带即抛错;V3.7.0 之前立项的存量工单经 normalizeWorkItem 读取时 SHALL 回填 approval_source="issue_stop",不阻断既有流转。

#### Scenario: 留痕写入
- WHEN 同轮放行事件生效(pre_authorized 或 auto_intake)
- THEN 工单状态含对应 approval_source,历史记录含该通道约定形式的 actor 与引用用户原话的 evidence

#### Scenario: 写入通道收口扩枚举
- WHEN approve_requirement 之外的任何事件在 patch 中携带 approval_source="auto_intake" 或 "pre_authorized"
- THEN 状态机抛错(Unsupported state patch field)

#### Scenario: 存量工单祖父回填
- WHEN 缺少 approval_source 字段的存量工单被 normalizeWorkItem 读取
- THEN 回填 "issue_stop" 后照常流转,不因缺字段被拒

# REQ-7 Delta Spec:hulane-spec-layer 能力(MODIFIED)

## MODIFIED Requirements

### Requirement: delta 全文进 Gate A 审批包

spec_sync_required 工单 SHALL 把 delta 全文作为一条 GitHub Issue 评论随需求与方案一并进 Gate A 审批包;delta 过长时允许摘要加仓库内路径。Gate A 同轮自动放行 SHALL 不豁免该评论:评论 SHALL 在同轮放行应用前(或同轮内)发布,作为自动放行的审计留痕。

#### Scenario: Gate A 审批包包含 delta
- WHEN spec_sync_required 工单开单并同轮自动放行
- THEN Issue 上存在包含 delta 全文(或摘要+路径)的评论,与 approval_source="auto_intake" 的自动放行记录互为审计证据

#### Scenario: 白名单停等时评论先于人工批准
- WHEN 工单落在白名单停等情形等待 /hulane_approve
- THEN delta 评论已在 waiting_approval 期间发布,人工一次批准需求、方案与规格变更的语义不变
