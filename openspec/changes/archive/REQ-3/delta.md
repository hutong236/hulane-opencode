# REQ-3 Delta：hulane-spec-layer 能力（ADDED 快照）

<!-- 本文件是 REQ-3 规划期起草、Gate A 批准的 delta 快照（决策史归档）。
     主规格已由实现 PR 智能合并至 openspec/specs/hulane-spec-layer/spec.md。 -->

## ADDED Requirements

### Requirement: 规划期读取主规格并产出 delta

标准工单规划时，hulane-planner SHALL 读取本次改动触碰到的各 capability 主规格（`openspec/specs/<capability>/spec.md`），以其既有 Requirements/Scenarios 为基线产出 `spec_delta_draft`（ADDED/MODIFIED/REMOVED/RENAMED 分组），并把验收标准从 delta 的 Scenario 导出；承载该行为的能力缺少主规格时 SHALL 记入 scope_questions。

#### Scenario: 派发 planner 读取既有规格

- WHEN 一个 standard 工单的改动触碰已有主规格的 capability
- THEN planner 返回的 delta 草案以该主规格为基线，验收标准逐条对应 delta Scenario

#### Scenario: 能力无主规格

- WHEN 改动明显属于某 capability 而该 capability 没有 `spec.md`
- THEN planner 在 scope_questions 中记录缺失，不虚构既有基线

### Requirement: delta 全文进 Gate A 审批包

spec_sync_required 工单 SHALL 把 delta 全文作为一条 GitHub Issue 评论随需求与方案一并交 Gate A 审批；delta 过长时允许摘要加仓库内路径。

#### Scenario: Gate A 审批包包含 delta

- WHEN 工单进入 waiting_approval
- THEN Issue 上存在包含 delta 全文（或摘要+路径）的评论，人工一次批准需求、方案与规格变更

### Requirement: 主规格智能合并随实现 PR 提交

Coder SHALL 在实现 worktree 内写 `openspec/changes/archive/<REQ-ID>/`（proposal.md / delta.md / decisions.md）决策史，并在同一 PR 内完成 delta→主规格的智能合并：ADDED 追加需求（同名已存在则按 MODIFIED 处理）、MODIFIED 替换声明的 scenario 并保留 delta 未提及的既有 scenario、REMOVED 删除整个需求块、RENAMED 改名；只有被触碰到的 capability 的主规格 SHALL 被改写。

#### Scenario: MODIFIED 保留未提及的 scenario

- WHEN delta 的 MODIFIED 条目只声明了某需求的一个新 scenario
- THEN 合并后该需求的其余既有 scenario 原样保留

#### Scenario: 未触碰的能力不受影响

- WHEN 工单只触碰 capability A
- THEN capability B 的 `spec.md` 在 PR 中保持逐字节不变

### Requirement: merge 后结构校验并记录 specs_commit_sha

PR 合并后、Issue 关闭前，编排者 SHALL 调用 `hulane_record_specs_synced`：控制面用 Git 对象读取 `specs_commit_sha`（必须等于已记录的 merged_sha）提交树中的 `openspec/specs/` 主规格并做结构校验，非法即拒绝；校验通过才记录 `specs_synced` 事件（waiting_close 自环）。

#### Scenario: 记录成功

- WHEN merged_sha 提交树内全部主规格通过结构校验且 specs_commit_sha == merged_sha
- THEN specs_synced 事件被记录，specs_commit_sha/spec_delta_dir 写入工单状态

#### Scenario: 结构非法规格被拒绝

- WHEN merged_sha 提交树内某主规格缺少必需标题骨架（如需求无 Scenario）
- THEN 控制面拒绝记录，状态不变，Issue 不允许关闭

### Requirement: Done 前置双层强制

spec_sync_required 且 specs_synced 未记录的工单 SHALL 被双层拦截：状态机对 `issue_closed` 事件与 Done 不变式抛错，PreToolUse 守卫对 `gh issue close` 命令拒绝（令牌路径与状态自证路径共用同一断言）。

#### Scenario: 状态机拒绝关单

- WHEN spec_sync_required 工单处于 waiting_close 且 specs_synced !== true
- THEN issue_closed 事件抛错，validateWorkItem 的 Done 不变式同样不满足

#### Scenario: 守卫拒绝 gh issue close

- WHEN 守卫收到 spec_sync_required 且 specs_synced !== true 的工单的 gh issue close 命令
- THEN 命令被拒绝，无论是否携带授权令牌

### Requirement: 豁免与存量祖父条款

small 工单的 spec_sync_required SHALL 恒为 false；standard 工单默认 true，仅允许 planner 对纯基建/纯文档条目显式豁免并记录原因；V3.6.0 之前立项的存量工单 SHALL 由 normalizeWorkItem 回填 spec_sync_required=false、specs_synced=false，不被新前置阻塞。

#### Scenario: small 快车道不受阻

- WHEN 一个 size=small 的工单走完合并关单流程
- THEN 全程不要求 specs_synced 证据

#### Scenario: 存量工单祖父放行

- WHEN 一个缺少规格层字段的存量工单经 normalizeWorkItem 读取
- THEN 回填 false/false 后可直接 issue_closed 到达 done

### Requirement: 规格格式结构约束

主规格 SHALL 满足标题骨架：唯一 H1 `# <capability> Specification`、含 `## Purpose` 与 `## Requirements`、每个 `### Requirement: <名称>` 至少带一个 `#### Scenario: <名称>`；delta 规格 SHALL 至少含一个 `## ADDED|MODIFIED|REMOVED|RENAMED Requirements` 分组，ADDED/MODIFIED 条目同主规格需求结构，RENAMED 条目用 FROM:/TO: 行。校验只约束标题结构，正文可为中文。

#### Scenario: 中文内容合法

- WHEN 一份主规格的 Purpose/需求正文/scenario 全部为中文但标题骨架完整
- THEN 结构校验通过

#### Scenario: 标题漂移非法

- WHEN 主规格的 H1 缺少 "Specification" 后缀，或某需求没有任何 Scenario 标题
- THEN 结构校验失败并指出具体漂移

### Requirement: PR checks 可选软校验

hulane-pr-checks 脚本 SHALL 在仓库存在 `openspec/` 目录且本机装有 openspec CLI 时运行 `openspec validate --specs`，否则静默跳过且不计为失败。

#### Scenario: 无 openspec CLI 时跳过

- WHEN 仓库没有 `openspec/` 目录或本机没有 openspec 命令
- THEN PR checks 不因规格校验缺失而失败
