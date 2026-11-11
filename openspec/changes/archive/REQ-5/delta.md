# REQ-5 Delta Spec:hulane-release-workflow 能力(ADDED)

## ADDED Requirements

### Requirement: Gate A 预授权同轮放行

用户在需求原话中明确批准(如「直接做」「预授权」)时,编排者 SHALL 在开单同轮以 `human:<身份>` actor 应用 `approve_requirement` 事件(patch.approval_source="pre_authorized",evidence 引用用户原话),工单不进入 Gate A 停等直接到达 ready;用户原话未含明确批准时 SHALL 维持既有语义:停在 waiting_approval 等待 Issue 评论人工批准(approval_source="issue_stop")。

#### Scenario: 预授权同轮直达 ready
- WHEN 用户需求原话含明确批准,且工单 risk_level ∈ {low,medium}、spec_sync_required=false
- THEN 编排者同轮应用 approve_requirement(actor 为 human:<身份>,patch.approval_source="pre_authorized",evidence 引用用户原话),工单到达 ready、human_approval=approved,不在 waiting_approval 停等

#### Scenario: 无预授权原话仍停等
- WHEN 用户需求原话未含明确批准
- THEN 工单照常停在 waiting_approval,Gate A 审批路径与 V3.6.0 完全一致

### Requirement: 预授权硬边界（状态机强制）

状态机 SHALL 仅对 risk_level ∈ {low,medium} 且 spec_sync_required=false 的工单接受 approval_source="pre_authorized" 的 approve_requirement 事件;risk_level=high 或 spec_sync_required=true 的工单 SHALL 永远拒绝预授权并保持 waiting_approval(强制停等人工审批);预授权事件的 actor SHALL 匹配 `human:<身份>` 形式,缺失即拒绝。

#### Scenario: 高风险拒绝预授权
- WHEN 对 risk_level=high 的工单应用 approval_source="pre_authorized" 的 approve_requirement
- THEN 状态机抛错,工单状态仍为 waiting_approval

#### Scenario: spec_sync_required 工单拒绝预授权
- WHEN 对 spec_sync_required=true 的工单应用 approval_source="pre_authorized" 的 approve_requirement
- THEN 状态机抛错(携带规格变更的工单必须走 Gate A 同框人工审批),状态不变

#### Scenario: human actor 缺失拒绝
- WHEN 预授权 approve_requirement 的 actor 不匹配 human:<身份> 形式
- THEN 状态机抛错,事件不生效

#### Scenario: 中风险且无规格工单放行
- WHEN 对 risk_level=medium 且 spec_sync_required=false 的工单应用 approval_source="pre_authorized"
- THEN 边界校验通过,预授权事件生效并留痕

### Requirement: approval_source 留痕与写入通道收口

approve_requirement SHALL 把 approval_source(枚举 "issue_stop" | "pre_authorized")写入工单状态并随事件历史(actor/evidence)留痕;该字段 SHALL 仅允许 approve_requirement 事件写入,其余事件携带即抛错;V3.7.0 之前立项的存量工单经 normalizeWorkItem 读取时 SHALL 回填 approval_source="issue_stop",不阻断既有流转。

#### Scenario: 留痕写入
- WHEN 预授权事件生效
- THEN 工单状态含 approval_source="pre_authorized",历史记录含 human actor 与引用用户原话的 evidence

#### Scenario: 写入通道收口
- WHEN approve_requirement 之外的任何事件在 patch 中携带 approval_source
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
