# REQ-5 Proposal：Gate A 单单预授权 + 轻量批量发版

## What

给 hulane V3.7.0 增加两项已批准的行为（承载于新 capability `hulane-release-workflow`）：

- **Gate A 单单预授权**：用户在需求原话中明确批准（如「直接做」「预授权」）且工单
  `risk_level ∈ {low,medium}`、`spec_sync_required=false` 时，编排者开单同轮以
  `human:<身份>` actor 应用 `approve_requirement`（`patch.approval_source="pre_authorized"`，
  evidence 引用用户原话），跳过 Gate A 停等直达 ready；硬边界由状态机强制
  （高风险与规格工单永远拒绝、状态不变），`approval_source`
  （枚举 `issue_stop` | `pre_authorized`）进工单状态/schema/投影，写入通道收口到
  `approve_requirement` 单一事件，存量工单由 normalizeWorkItem 回填 `issue_stop`。
- **轻量批量发版**：新命令 `/hulane_release [vX.Y.Z]` + 第 14 个 MCP 工具
  `hulane_authorize_release`——无工单直达 tag 发版：先汇报自上个 tag 的合并清单并回显
  目标版本与 origin/main HEAD SHA，一次签发两枚单次令牌（tag 创建 + tag 推送），
  scope 钉死 version+SHA、TTL 10–600 秒；guard 新增 release 令牌放行通道（tag 推送腿
  只认 annotated tag 对象的显式 refspec），裸 tag 仍拒、既有工单 tag 令牌路径回归
  不变；发版核验由 Build Checker 对 GitHub 原生记录完成，零工单状态写入。

## Why

- **预授权**：低风险、无规格变更的小改动在用户原话已明确批准时，再强制停等
  `/hulane_approve` 是一次纯形式的人机往返；把「用户原话即批准」以留痕方式接进
  状态机（而不是提示词约定），既减少停点又保住审计链。
- **轻量发版**：按需批量发版此前要开一个 maintenance 工单走全流程（Gate A→…→Gate C），
  而发版本身没有业务代码变更，工单只是形式载体；`/hulane_release` 用一次人工确认 +
  钉死 version+SHA 的单次令牌对实现同等强度的放行控制，零工单开销。

## 方案对比与裁决

| 维度 | 方案 A（复用工单令牌：开 maintenance 工单走 Gate C） | 方案 B（仓库级 release 令牌对，已裁决采用） |
| --- | --- | --- |
| 发版开销 | 每次发版一个完整工单生命周期（Issue→Gate A→PR→merge→Gate C） | 一次人工确认，零工单、零状态写入 |
| 放行强度 | 工单令牌（building 态 + Gate C approved + merged_sha 点名） | 两枚单次令牌钉死 version+SHA，签发前远端加固（SHA=origin/main HEAD、tag 远端不存在） |
| tag 推送腿 | 与 tag 创建共用「building 态 git-push」语义 | 独立 `release-push` 动作，guard 只认 annotated tag 对象的显式 refspec，普通分支推送不受影响 |
| 审计载体 | hulane 工单状态 + 事件历史 | GitHub 原生记录（Release + Actions run + registry digest） |

方案 B 由 Gate A 裁决采用（详见 decisions.md）。

## 状态机与守卫落点

- `PATCH_FIELDS` 增 `approval_source`；写入通道收口：仅 `approve_requirement` 可写，
  其余事件携带即抛 `Unsupported state patch field`。
- `approve_requirement`：`approval_source` 默认写 `issue_stop`；值为 `pre_authorized`
  时强制校验 `risk_level ∈ {low,medium}` 且规格工单（patch 前后）均不得要求 spec sync，
  越界抛错、状态不变。
- `hulane_authorize_release`（MCP 第 14 工具，actor 固定 orchestrator）：严格 SemVer
  （可带/裸 v 前缀，规范化为 `vX.Y.Z`）+ 40 位 SHA；`git ls-remote origin refs/heads/main`
  比对 HEAD、`git ls-remote --tags origin <tag>` 确认 tag 不存在；返回
  `{tag_token, push_token, version, sha, expires_at}`，两枚令牌各管一腿、各自单次。
- guard：新增 `HULANE_RELEASE_TAG_TOKEN`（git-tag 通道）与
  `HULANE_RELEASE_PUSH_TOKEN`（仅 `<tag对象SHA>:refs/tags/<vX.Y.Z>` 显式
  refspec 的 git-push 通道，推送 annotated tag 对象；消费时验证 annotated +
  解引用绑定钉死 commit）两个放行入口，
  既有 `HULANE_AUTH_TOKEN` 优先；`analyzeCommand` 分类逻辑保持不变。
