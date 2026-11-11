# Hulane OpenCode — 会话交接与逐步提交记录

> **本文件是 Web/ChatGPT 会话结束后的恢复入口。每完成一个可验收的小步骤，必须立刻 Commit + Push，并在本文件记录新的进展（优先与该步骤同一提交）。**
>
> 续作时始终先读取 GitHub 远程分支当前状态，不依赖上一次会话的聊天记录。工作约定详见仓库根目录 [AGENTS.md](../AGENTS.md)。

## 1. 持久化入口

| 项目 | 位置 |
| --- | --- |
| GitHub 仓库 | https://github.com/hutong236/hulane-opencode |
| 当前开发分支 | `feat/opencode-v2-initial-implementation` |
| 代码审查 | [Draft PR #1](https://github.com/hutong236/hulane-opencode/pull/1)（**禁止未经生产门禁验收直接合并**） |
| 总体设计 | [01 总体设计](./01-Hulane-OpenCode-总体设计.md) |
| 开发手册 | [02 开发实施](./02-Hulane-OpenCode-开发实施手册.md) |
| 验证与缺口 | [03 集成验收与缺口](./03-OpenCode-集成验收与缺口.md) |
| 最新源码 | [当前开发分支](https://github.com/hutong236/hulane-opencode/tree/feat/opencode-v2-initial-implementation) |

## 2. 上次代码验证基线（创建本文件时）

- 代码验证提交：`b45ac3aeecfea27d58a828c4ef162628fd4dc637`。
- 验证成功的 Actions：[42848769992](https://github.com/hutong236/hulane-opencode/actions/runs/42848769992)。
- Node.js 20、22：156/156 项回归测试通过；OpenCode SDK 2.2.7 Hook 测试通过；真实 OpenCode CLI v2.2.7 能发现 8 个 Hulane Agent，MCP `hulane-control connected`。
- 已实现：上游 Hulane 3.10.0 状态机/MCP/Worktree/OpenSpec 迁入、10 Commands、7 subagents + 1 orchestrator、Skill、安装器、5 个 MCP 受保护操作、权限隔离与 Coder Worktree 门禁。
- **尚未验收**：真实业务沙盒完整 Gate A/B/C 与 PR/Release/Evidence 链、GitHub Ruleset、Shell 全范围隔离、多进程并发与异常恢复、macOS ARM 和 Linux 实机；不可当作生产发布版本。

## 3. 本次完成的原子步骤

**步骤：建立 Web 会话失效后也可持续开发的 GitHub 断点续作规范。**

- 新增 `AGENTS.md` 和 `docs/SESSION_HANDOFF.md`，更新 README 导航。
- 要求每个小步骤结束立刻提交并推送，不再累积多步骤等到会话结束才提交。
- 这一文档步骤无需修改运行时，原代码测试结果沿用上述已验证基线；本次 GitHub 提交是否触发/通过 CI 必须在推送后实际核查。
- 当前步骤的准确 Commit SHA：在 GitHub PR 的最新提交或执行 `git rev-parse origin/feat/opencode-v2-initial-implementation` 获取；不要把提交内的硬编码 SHA 当作最新。
- 保持 Draft PR，未合并 `main`。

## 4. 下一独立任务（仅选择一个）

**建议优先：生成并提交针对 `@opencode/plugin` 2.2.7 的可复现 `package-lock.json`，让 CI 使用 `npm ci`，严格固定实际运行的 OpenCode CLI 版本，并完成对应 CI 回归。**

验收标准：依赖安装可复现，Node.js 20/22 和真实 OpenCode V2 的四组 CI 均通过；每完成这项任务，**立即推送并更新交接记录**。

后续按优先顺序：GitHub 沙盒业务 E2E → Gate B/C 与 Release/镜像证据 → 权限绕行负向测试 → 并发与崩溃恢复 → macOS ARM/Linux 安装验证。每一项继续拆成单独可推送步骤。

## 5. 会话恢复检查（新会话第一步）

```bash
git fetch origin
git switch feat/opencode-v2-initial-implementation
git pull --ff-only
git rev-parse HEAD
git status --short
npm test
```

同时检查远端 [PR #1](https://github.com/hutong236/hulane-opencode/pull/1) 与 [Actions](https://github.com/hutong236/hulane-opencode/actions) 的最新提交与 CI 状态。若与本文件描述不一致，以 **GitHub 最新远端提交、PR、Actions 结果** 为准并先更新本文件。

### Step 1 — 固定真实 CLI 版本

- Branch: `feat/opencode-v2-initial-implementation`
- Changed: `.github/workflows/ci.yml`
- Implementation: `@opencode/cli` 改为固定安装 `2.2.7`，并在集成 Job 校验 `opencode --version` 精确等于 `2.2.7`。
- Validation: 静态校验和提交已执行；本次 GitHub Actions 完成前不得宣称通过，以该 Commit 对应 Actions 为准。
- Next atomic task: 从 CI 生成真实 npm lockfile 后提交，CI 改用 `npm ci`。

### Step 2 — 由真实 GitHub Runner 生成依赖锁（引导步骤）

- Changed: `.github/workflows/ci.yml`
- Purpose: 临时添加只读 `lockfile-bootstrap` Job，使用 Node.js 22 的 npm 解析实际 `@opencode/plugin@2.2.7` 依赖，输出 `package-lock.json` Base64 至 Actions 日志。
- Validation: 通过 Actions 的 `lockfile-bootstrap` Job 验证；这一步是生成锁文件的可信输入，不把尚未生成的锁文件视为完成。
- Next atomic task: 从已完成的 Job 日志读取实际 Base64、解码、提交真实 `package-lock.json`，删除临时 Job，并切换 `npm ci`。

### Step 3 — 修复精确版本验证误报

- Changed: `.github/workflows/ci.yml`
- Observed CI failure: [Actions 42852390530](https://github.com/hutong236/hulane-opencode/actions/runs/42852390530)。
- Root cause: 真正的 `opencode --version` 输出是 `opencode v2.2.7`，而不是 `2.2.7`。
- Fix: 版本检查精确对比 `opencode v2.2.7`；实际软件已按固定版本成功安装。
- Validation: 当前提交发起新的 CI，结果以对应 GitHub Actions 为准。
- Next: 读取 lockfile-bootstrap 日志，生成锁文件并从临时 Job 转换成 `npm ci`。

### Step 4 — 提交真实 package-lock.json，切换 npm ci

- Changed: `package-lock.json`、`.github/workflows/ci.yml`、`docs/SESSION_HANDOFF.md`。
- Evidence: [Actions 42852462399](https://github.com/hutong236/hulane-opencode/actions/runs/42852462399) 的 `lockfile-bootstrap` Job 成功；原地生成的 lockfileV3 在提交前校验 `@opencode/plugin@2.2.7`，无非预期 npm Registry 网址。
- Change: CI `opencode-v2-adapter` 和 `opencode-cli-integration` 改用 `npm ci`，删除临时 bootstrap Job；CLI 2.2.7 仍被精确固定。
- Validation: 本步骤生成并校验了 lockfile JSON（272 条 package 记录，133474 bytes）；修改后的 CI 结果须查看对应提交 Actions，不能预先标记通过。
- Next atomic task: 对安全授权与持久状态竞态做负向测试与增量加固。

### Step 5 — macOS Apple Silicon 与 Linux ARM64 原生安装 Smoke

- Changed: `.github/workflows/ci.yml`
- Added: `platform-install-smoke` 矩阵：GitHub 官方 `macos-15`（Apple M1 ARM64）和 `ubuntu-24.04-arm`（Linux ARM64）。
- Acceptance: ARM 原生 Node22、锁依赖 `npm ci`、SDK Plugin smoke、精确 CLI 2.2.7 安装、临时 Git 项目 dry-run + 安装、MCP 配置检查。
- Limitation: 本项是 ARM64 **安装与加载 Smoke**，不是实际用户机器端到端安全验收；以对应 Actions 成功结果为准。
- Next: 完善 Work Item 状态变更并发拒绝与锁崩溃恢复测试。

### Step 6 — 加强状态存储并发写入的原子性

- Changed: `hulane/scripts/lib/state-store.mjs`、`hulane/mcp/tools.mjs`、`test/state-store.test.mjs`。
- Implementation: `state-write.lock` 进程间独占写入；根状态修订号 CAS；同修订号 Work Item 冲突拒绝，完全相同的重试幂等；仅显式标记 `source:"github"` 的两处 GitHub hydrate 接受远端覆盖。
- Regression: 新增 3 项锁、CAS、冲突/远端恢复测试；实际 CI 状态待核查。
- Remaining: 中断遗留锁的人工安全恢复机制及并发建单压测。
- Next: 增加防误删活跃进程锁的崩溃恢复工具。

### Step 7 — 崩溃遗留状态写锁的安全恢复

- Changed: `hulane/scripts/lib/state-lock-recovery.mjs`、`bin/recover-state-lock.mjs`、`hulane/scripts/lib/state-store.mjs`、`test/state-lock-recovery.test.mjs`。
- Behavior: 状态写锁加入 hostname；默认恢复 dry-run，仅显式 `--apply` 删除满足同机、PID 确定不存在、锁龄至少 30s 的遗留锁；活跃 PID、外部主机、损坏元数据、新锁一律拒绝；用另一个排他恢复锁避免两个恢复进程竞态。
- Usage: `node bin/recover-state-lock.mjs --project /path/to/repo --dry-run`，核实结果后 `--apply`。
- Regression: 3 项死锁恢复、活跃/异地主机拦截、互斥恢复测试（待 CI 验证）。
- Limit: 不提供不安全的强制解锁；异地主机/损坏锁需管理员线下审计，人工移除前须确保无写进程运行。
- Next: 加强开单编号分配的冲突重试与远端副作用幂等。

### Step 8 — 多进程本地开单编号原子分配

- Changed: `hulane/scripts/lib/state-store.mjs`、`hulane/mcp/tools.mjs`、`test/state-store.test.mjs`。
- Implementation: `createLocalWorkItem` 在同一个进程间锁内重新读取状态、分配 REQ/BUG 全局自增编号并持久化；`hulane_open_work_item` 不再先在锁外取编号。有限锁竞争重试（最多约 500ms），崩溃锁不自动抢占。
- Regression: 原有离线开单/跨前缀编号测试 + 新增编号顺序测试；需以 CI 为准。
- Remaining: 真正并发的多个 OS 进程压力测试、崩溃恢复与云端 Issue 幂等仍需持续验证。
- Next: 添加两个真实 Node 子进程同时创建工单的压力回归并核验连续编号。

### Step 9 — 真实多进程分配回归

- Changed: `test/state-store.test.mjs`。
- New regression: 在同一真实临时 Git 仓库并行启动 4 个独立 Node.js OS 进程，每个创建 8 个 Work Item；断言 32 个编号无重复、数字部分连续、最终 Store 保留 32 个 Work Item。
- Validation: 本提交 CI 执行后才能确定跨进程压力测试是否通过。若锁竞争超时，需要独立修复提交。
- Next: 完整真实 OpenCode CLI 操作链与负向场景；GitHub 沙盒端到端仍然需要独立授权环境和 Ruleset。

### Step 10 — 目标项目既有 allow 规则不能重开 MCP 权限

- Changed: `bin/install.mjs`、`test/opencode-install.test.mjs`、`opencode/README.md`。
- Security: installer 将最终 `hulane-control_*` deny 固定为项目 permissions **最后一条**，覆盖既有 `* allow`、`hulane-control_* allow` 和具体 secure-merge allow；其他项目 Shell 规则照旧，编排 Agent 的单独 ask 配置仍生效。
- Regression: 宽泛和具体 MCP allow 负向测试、重装输出幂等；修订旧有 shell 规则断言（CI 待核查）。
- Next: 对 permission hook 运行时针对 Coder/其他代理的控制和工具调用添加更完整集成测试；继续 PR/Gate E2E。

### Step 11 — Gate B 检查结果与 PR Base 加固

- Changed: `hulane/scripts/lib/pr-checks.mjs`、`test/pr-checks.test.mjs`。
- Security: 同名 check 有任何 pending/failed 即拒绝；逐一要求所有 GitHub branch protection/ruleset 必需 contexts 出现在当前 PR 检查中且全部通过；业务 PR Base 必须是仓库的真实默认分支。
- Regression: 同名冲突、缺失/待运行的必需 context、非默认分支 PR 拦截（新增 3 项测试）。
- Limit: 依旧需要在**独立 GitHub 沙盒仓库**验证 Ruleset 的 App 绑定/权限和实时 Checks 行为；此次为控制面决策逻辑加固。
- Next: 对真实 GitHub sandbox 运行 Gate A/B/C、Release 元数据与负向回滚验收。

### Step 12 — Release Tag 物理对象校验

- Changed: `hulane/templates/github-actions/build-image.yml`、`test/preflight.test.mjs`。
- Security: Tag-only GHCR 工作流拒绝轻量标签；验证远程与本地相同的 annotated tag 对象 SHA；由已验证的 tag 对象解析 commit，并继续校验默认分支祖先关系。
- Regression: 静态工作流安全约束测试；实际 GitHub Release/GHCR 流程仍需独立沙盒发版实验。
- Previous CI: [42855529087](https://github.com/hutong236/hulane-opencode/actions/runs/42855529087) 六 Job 全部通过。
- Next: 防止交付验证仅凭调用者伪造的元数据/摘要就标记 registry_verified。

### Step 13 — 修复 Release workflow 静态检查正则

- Changed: `test/preflight.test.mjs`。
- Fix: 识别 Git 中 `^{commit}` 剥离 annotated tag 的真实语法；原提交中正则遗漏花括号，已在提交后立即复核发现。
- Validation: 变更前本地正则无法匹配；修复后通过源码匹配检查，完整 CI 结果由本次 Actions 确认。
- Next: 避免伪造的交付摘要和声明进入 verified 状态。

### Step 14 — 人工 Gate A/B/C 从 GitHub 证据核验

- Changed: `hulane/scripts/lib/human-approval.mjs`、`hulane/mcp/tools.mjs`、`test/human-approval.test.mjs`、三个 OpenCode 审批 Commands。
- Security: 除低中风险 `auto_intake` 之外，人工事件均须同一 Work Item GitHub Issue 的精确 `HULANE_APPROVAL` 评论；由 GitHub 实际评论作者和 collaborator permission(write/maintain/admin)验证，且绑定当前 revision、Gate B PR Head、Gate C Tag。MCP 参数 `actor=human:xxx` 不再能直接自证人工批准。
- Tradeoff: `pre_authorized` 也需先发布 GitHub Issue/评论才可手工批准；待补建的离线 Issue 不支持人工事件。此变更刻意 fail-closed。
- Regression: 3 项角色、旧 revision、不同作者、过期评论、PR head/tag、API 真实查询调用测试。
- Next: 评估真实 GitHub沙盒门禁（需要独立沙盒仓库与服务端 Rulesets 权限）。

### Step 15 — Signed GitHub Artifact Attestations for GHCR releases

- Changed: `hulane/templates/github-actions/build-image.yml`、`test/preflight.test.mjs`。
- Implementation: 镜像推送完成后由 `anchore/sbom-action@v0` 扫描实际 digest 生成 SPDX JSON，`actions/attest@v4` 分别产生并发布 Sigstore 签名的 SLSA Provenance 与 SPDX SBOM，subject 绑定 GHCR 精确 digest；生成证明失败会中止后续 Release metadata/Release。
- Evidence: 使用 GitHub 官方 attestation 规范；可用 `gh attestation verify oci://ghcr.io/OWNER/IMAGE@sha256:... -R OWNER/REPO --predicate-type https://slsa.dev/provenance/v1` 和 SBOM predicate 单独验证。
- Regression: 工作流具备明确验证步骤、权限、精确镜像 digest 的静态合同测试；真正 GHCR 构建与签名仍需独立沙盒验证。
- Next: `hulane_verify_delivery` 自行执行远端 Actions、Release、GHCR、Sigstore 验证，不再信任 Agent 输入的摘要。

### Step 16 — 独立 GitHub / GHCR / Sigstore 发布证据核验

- Changed: `hulane/scripts/lib/delivery-remote.mjs`、`hulane/mcp/tools.mjs`。
- Security: `hulane_verify_delivery` 不再仅调用纯字段比较；重新查询 GitHub Actions 实际成功的 tag/commit run，查询 GitHub Release 和 annotated tag 对象，下载实际 Release 的 delivery-metadata.json，读取 GHCR Registry tag digest，并用 `gh attestation verify` 对锁定 OCI digest 的 SLSA 和 SPDX 签名证明做独立验证；本地字段摘要取已验证 Statement 哈希。
- Fail closed: 无网络、无 Docker Buildx、无 GH CLI attestation 能力、缺失元数据/签名/授权时不记录 `image_verified`，Issue 保持未完成。
- Current validation: 控制面代码已推送；需要补充注入式真实远端模拟/错误路径单元测试，并在 GitHub 沙盒对真实 OCI attestation 验证。
- Next: 补充远端 Release、GHCR、签名证据正/反向测试并在 CI 上运行。

### Step 17 — 发布事实验证的模拟集成负向测试

- Changed: `test/delivery-remote.test.mjs`。
- New tests (4): 使用实际 `verifyLiveDelivery` 函数与可注入独立 GitHub/OCI 命令模拟器，覆盖成功 Action/tag/Release/Registry/Sigstore 两种 predicate；失败 Workflow、伪造 digest、轻量 tag、缺失 Release asset、元数据篡改、签名目标错误与调用者冒用证明哈希。
- Validation: 完整 CI 必须通过；沙盒真实发布验收仍为单独门槛。
- Next: 文档状态同步、Issue 验收任务列表与生产权限配置。

### Step 18 — 真实 MCP 子进程端到端离线生命周期测试

- Changed: `test/mcp-real-stdio.test.mjs`。
- Actual integration: CI 使用 Node `spawn` 启动实际 `hulane/mcp/server.mjs`（stdio JSON-RPC），逐条执行 initialize、tools/list、离线 open、伪造 human Gate A 拒绝、低风险 auto_intake、Worktree 创建和 status 读取；验证真实 Git worktree 隔离及本地持久化。
- Limitation: 验收范围是 **MCP 真实进程 + 本地 Git**，不代表有权合并真实 GitHub PR、发 GHCR 镜像或真正运行 OpenCode Agent 任务。
- Validation: 本次提交后的 CI 执行结果为准。
- Next: 核查 CI、修复任何集成回归，并记录管理员权限/沙盒生产验收阻塞。

### Step 19 — 与生产验收 Issue 对齐的最新文档

- Changed: `README.md`、`docs/03-OpenCode-集成验收与缺口.md`、`opencode/README.md`、`docs/SESSION_HANDOFF.md`。
- Canonical user-facing blocker and checklist: [Issue #3](https://github.com/hutong236/hulane-opencode/issues/3)。
- Updated: 移除旧的“尚未 lockfile”描述，补充新安全控制、Apple Silicon / Linux ARM Smoke、真实 MCP stdio 与签名验证实现；对于还在排队的 CI 和缺少管理员权限的真实发布验收保持未完成状态。
- Next: 等待最新六项 CI 完成，处理失败项并及时提交；如需外部管理员/独立沙盒，Issue #3 保持待办，不自动合并主分支。

## 6. 后续步骤追加模板

```markdown
### Step N — [独立任务名称]
- Branch / commit: feat/opencode-v2-initial-implementation / <远端 SHA>
- Files changed: ...
- What was implemented: ...
- Validation: ...（通过 / 失败 / 未执行；CI URL）
- Risks / blockers: ...
- Next atomic task: ...
```

**故障回退规则**：提交/推送后如无法确认成功，首先检查远端 SHA；CI 失败保留失败记录并立即以单独修复提交推进。未推送的工作不算完成，禁止无意覆盖别人推送的更新。
