# <REQ-ID> Delta Spec

<!-- delta 规格模板：openspec/changes/archive/<REQ-ID>/delta.md（决策史归档） -->
<!-- 标题骨架受 hulane 规格层校验：至少一个
「## ADDED|MODIFIED|REMOVED|RENAMED Requirements」分组；每个分组至少一个
「### Requirement: <名称>」条目。ADDED / MODIFIED 条目同主规格需求结构
（至少一个「#### Scenario:」）；REMOVED 只需需求块；RENAMED 条目用
FROM: / TO: 行。delta 在规划期起草、随 Gate A 审批包全文评审，
批准后由 Coder 在实现 PR 内智能合并进主规格。 -->

## ADDED Requirements

### Requirement: <新增需求名称>

<!-- 系统 SHALL <可验证的行为约束>。 -->

#### Scenario: <场景名称>

- WHEN <条件>
- THEN <可观察的结果>

## MODIFIED Requirements

<!-- MODIFIED 保留 delta 未提及的既有 scenario：只写变化的 scenario。 -->

### Requirement: <修改需求名称>

#### Scenario: <变化后的场景>

- WHEN <条件>
- THEN <可观察的结果>

## REMOVED Requirements

### Requirement: <删除需求名称>

<!-- 删除整个需求块（含全部 scenario）。 -->

## RENAMED Requirements

### Requirement: <新名称>

- FROM: `### Requirement: <旧名称>`
- TO: `### Requirement: <新名称>`
