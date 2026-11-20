# hulane-release-workflow Specification

## Purpose

承载 hulane 的人工放行直达与按需批量发版行为基线：Gate A 开单同轮默认自动放行（`approval_source="auto_intake"`、actor="orchestrator"，用户原话含明确批准措辞时走 `pre_authorized`），停等白名单收窄为高风险（状态机强制硬边界）、需求歧义与用户显式暂停三种情形，轻量批量发版命令 `/hulane_release` 以一次人工确认、零工单的方式对 origin/main HEAD 打 annotated tag 并推送，由钉死 version+SHA 的两枚单次 release 令牌与 PreToolUse 守卫约束 tag 写操作，构建核验依赖 GitHub 原生记录完成。

## Requirements

### Requirement: Gate A 预授权同轮放行

开单完成后,编排者 SHALL 在同轮应用 approve_requirement 使工单直达 ready,不在 waiting_approval 停等:默认以 actor="orchestrator"、patch.approval_source="auto_intake" 应用,evidence SHALL 引用用户本轮原话;用户原话含明确批准措辞(如「直接做」「预授权」)时 SHALL 改用 patch.approval_source="pre_authorized" 且 actor 为 human:<身份> 形式。无论走哪条同轮通道,编排者 SHALL 把审批包(需求、方案、页面设计含评分历史、spec delta 全文或摘要+路径)作为一条 GitHub Issue 评论发布留痕,自动放行不豁免该评论。仅离线开单(REQ-11:issue_pending=true、GitHub Issue 尚未补建)时该审批包评论发布义务 SHALL 展期至 flush 在线窗口,在 hulane_flush 补建 Issue 后、issue_closed 前发布;在线开单行为不变。/hulane_approve SHALL 保留为人工覆盖通道(approval_source="issue_stop" 语义不变)。仅白名单停等情形 SHALL 维持 STOP:① risk_level=high;② Planner 报告需求歧义或 scope_questions 未闭合;③ 用户明说「等我确认」等显式暂停。spec_sync_required=true SHALL 不再构成停等理由。

#### Scenario: 开单默认同轮自动放行
- WHEN 开单完成且不落在任何白名单停等情形
- THEN 编排者同轮应用 approve_requirement(actor="orchestrator"、patch.approval_source="auto_intake"、evidence 引用用户原话),审批包评论先行发布,工单到达 ready、human_approval=approved,不停等

#### Scenario: 显式批准原话走 pre_authorized
- WHEN 用户需求原话含明确批准措辞且不落在白名单停等情形
- THEN 同轮 approve_requirement 以 patch.approval_source="pre_authorized"、actor=human:<身份> 应用,evidence 引用该批准原话

#### Scenario: 规格工单不再停等
- WHEN spec_sync_required=true 的 standard 工单开单完成且不落在白名单停等情形
- THEN Gate A 同轮自动放行,spec delta 随审批包评论留痕,不因规格同步要求停等

#### Scenario: 离线开单评论展期至 flush 窗口
- WHEN 工单离线开单(issue_pending=true、GitHub Issue 尚未补建)且不落在白名单停等情形
- THEN Gate A 同轮自动放行照常生效,审批包评论发布义务展期至 hulane_flush 在线窗口,在 Issue 补建后、issue_closed 前完成留痕;在线开单的既有评论时序不变

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

### Requirement: 轻量批量发版命令 /hulane_release

`/hulane_release vX.Y.Z` SHALL 以一次人工确认完成发版:编排者先汇报自上个 tag 以来的合并清单(git log + gh pr merged)并回显目标版本与 main HEAD SHA,随后签发 release 令牌、在 main HEAD 打 annotated tag 并推送,tag 触发既有镜像 workflow 后台 watch,由 Build Checker 完成核验并汇报 Release URL/digest;全程 SHALL 不创建任何工单。未带版本号时 SHALL 停等用户补充,不得猜测版本。

#### Scenario: 带版本号一次确认直达 tag
- WHEN 用户执行 /hulane_release vX.Y.Z
- THEN 编排者汇报合并清单、回显版本与 main HEAD SHA,凭该二者签发 release 令牌后在 main HEAD 打 annotated tag 并推送,不创建任何工单

#### Scenario: 缺版本号停等
- WHEN 用户执行 /hulane_release 不带版本号
- THEN 编排者停等用户补充版本号,不签发令牌、不打 tag

#### Scenario: 确认前先见合并清单
- WHEN /hulane_release 流程进入确认环节
- THEN 用户先看到自上个 tag 的合并清单与 main HEAD SHA 回显,再发生令牌签发与 tag 写操作

### Requirement: release 令牌约束

`hulane_authorize_release` SHALL 签发仓库级(不挂工单)的 release 令牌:scope 钉死 {version(严格 SemVer), sha(40 位 SHA)}、单次使用、TTL 在既有 10–600 秒区间内,一次签发返回 tag 创建与 tag 推送两枚单次令牌;tag 已存在于远端、或 sha 非 origin/main HEAD 时 SHALL 拒绝签发;令牌消费时命令 SHALL 点名钉死的 tag 版本并与钉死 SHA 绑定:tag 创建命令 SHALL 点名钉死 commit SHA;tag 推送命令 SHALL 使用恰好一条显式 refspec `<annotated tag 对象 SHA>:refs/tags/<vX.Y.Z>`,消费时 SHALL 验证该对象为 annotated tag、即本地钉死版本之 tag 对象、且其解引用等于钉死 commit SHA,否则拒绝;裸 tag 写操作(无令牌)SHALL 仍被守卫拒绝;既有工单 tag 令牌路径(git-tag 于 building 态 + Gate C approved + merged_sha 点名)SHALL 回归不变。

#### Scenario: scope 钉死
- WHEN tag 创建命令未点名钉死 commit SHA,或 tag 推送命令的显式 refspec 未同时绑定钉死版本与 annotated tag 对象
- THEN 消费被拒,tag 写操作不发生

#### Scenario: annotated 形态保持
- WHEN push 腿放行并推送完成
- THEN 远端 refs/tags/<vX.Y.Z> 为 annotated tag 对象且解引用为钉死 commit

#### Scenario: 轻量蒙混拒
- WHEN push refspec 的对象非 annotated(或解引用非钉死 commit)
- THEN 消费被拒

#### Scenario: 单次使用
- WHEN 同一 release 令牌被第二次消费
- THEN 拒绝(already used),需重新签发

#### Scenario: TTL 过期
- WHEN release 令牌超过 expires_at 后被消费
- THEN 拒绝(expired)

#### Scenario: 裸 tag 无令牌仍拒
- WHEN 无任何令牌执行 tag 写操作
- THEN 守卫拒绝并提示需要单次授权令牌,与 V3.6.0 行为一致

#### Scenario: 工单 tag 路径回归不变
- WHEN 既有工单在 building 态经 hulane_authorize(git-tag) 打 tag
- THEN 校验链(tag_confirmation=approved、merged_sha 点名、状态钉死)与 V3.6.0 一致,不受 release 令牌路径影响

### Requirement: 无工单发版核验与审计

轻量发版 SHALL 不调用 hulane_verify_delivery(无工单态可写);构建核验由 Build Checker 对 GitHub 原生记录(Release、Actions run、registry digest 等)完成;发版审计 SHALL 依赖 GitHub Release + Actions run + registry digest 的原生记录,不产生 hulane 工单状态。

#### Scenario: 五源核验汇报
- WHEN tag 触发的镜像 workflow 完成
- THEN Build Checker 基于原生记录核验并向用户汇报 Release URL 与 digest,全程无任何工单状态写入

#### Scenario: 构建失败停等人工
- WHEN 镜像 workflow 失败或 registry digest 缺失
- THEN 编排者汇报失败原因与 run URL 并停等人工处置,不自动重试打 tag
