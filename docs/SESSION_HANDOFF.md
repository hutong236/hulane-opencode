# Hulane OpenCode — 会话交接与逐步提交记录

> **本文件是 Web/ChatGPT 会话结束后的恢复入口。每完成一个可验收的小步骤，必须立刻 Commit + Push，并在本文件记录新的进展（优先与该步骤同一提交）。**
>
> 续作时始终先读取 GitHub 远程分支当前状态，不依赖上一次会话的聊天记录。工作约定详见仓库根目录 [AGENTS.md](../AGENTS.md)。

## 0. 当前权威状态（2026-11-17；覆盖下文历史阶段说明）

- **主线:** 已通过 [PR #1](https://github.com/hutong236/hulane-opencode/pull/1) squash merge 到 `main`，提交 `db2815a2a694d5447d8ef61fc1148fa416446a09`。此前文档中关于“PR #1 Draft / 禁止合并 / 继续在旧开发分支上开发”的描述仅用于历史追溯，**不再是当前操作指令**。
- **实测 GitHub Actions:** [main push run 42936837021](https://github.com/hutong236/hulane-opencode/actions/runs/42936837021) 已完成，6/6 jobs success；实际验证过的 CI 是开发验证，不是生产 E2E。
- **main 分支规则:** GitHub `GET /branches/main` 于 2026-11-17 返回 `protected:false` / required contexts empty；**主线尚无服务器强制保护**。GitHub 连接权限不包含仓库管理/Ruleset 写入能力。
- **未完成生产验收:** [Issue #3](https://github.com/hutong236/hulane-opencode/issues/3) 仍开放；需要 owner/admin 提供独立私有 sandbox、按实际 check context 配置 Ruleset，完成真实 REQ/BUG-Gate A/B/C-PR-GHCR-Sigstore E2E、Shell OS 隔离、跨会话恢复与实机回滚。
- **当前工作分支:** `chore/post-merge-acceptance-20261117`（从上述 main HEAD 派生），用于修正交接规范并补全后续验收材料；每步提交并核实远端。
- **验收执行手册:** [04 真实 GitHub 沙盒验收手册](./04-真实GitHub沙盒验收手册.md)；**下一独立任务:** 获取管理员配置的独立测试仓库并运行真实服务端检查/负向场景。**没有服务端分支保护和真实安全测试不得宣称生产就绪**。

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


### Workbench autonomous scheduler (2026-11-18)

- Branch: `feat/workbench-autodev-30m`; Draft [PR #35](https://github.com/hutong236/hulane-opencode/pull/35).
- Scope: deterministic dependency-aware selection of WB-001..WB-028; prefer red CI, block pending CI and green PRs awaiting human review; GitHub Actions every 30 minutes will run pinned OpenCode V2.2.7 with no GitHub write credentials and a strict workbench edit allowlist; a separate scoped publish step pushes a Draft PR.
- Credential prerequisites: `WORKBENCH_AUTODEV_MODEL` variable plus matching provider secret and `WORKBENCH_AUTODEV_TOKEN`; missing config produces BLOCKED, not a claimed task success.
- Checks: Node 20 and Node 22 core suites passed in [PR run 44152746154](https://github.com/hutong236/hulane-opencode/actions/runs/44152746154); macOS ARM job was still in progress at last review, **full CI not yet certified**. Final security guard also refuses secret-like file names and symlinks.
- Safety: No PR auto-merge, no Issue auto-close, no production Gate bypass. Needs real GitHub Actions scheduled run validation once merged to main; Issue #3 remains open.
- Next: validate full CI on exact final SHA; review+merge PR #35; configure secrets and model variable; dispatch one manual smoke run before relying on cron.

## Workbench Web UI kickoff — WB-001 (2026-11-18)

- Branch: `feat/WB-001-workbench-bootstrap`, PR [#33](https://github.com/hutong236/hulane-opencode/pull/33) (Draft), Issue [#5](https://github.com/hutong236/hulane-opencode/issues/5).
- Initial checkpoint: `a644f4507a7574f0d28e1a309f872d8aa1b5dab6` (27 files under workbench/ plus dedicated CI); React/Ant Design shell, local Fastify health endpoint, Worker/adapter boundaries.
- Evidence: [Workbench CI 44136603060](https://github.com/hutong236/hulane-opencode/actions/runs/44136603060) failed Typecheck (AntD Alert uses `message`, not `title`); root CI 44136524819 failed because `node --test` discovered new TypeScript `.test.ts` file. Root/main baseline remains unchanged.
- Fix: use `message`, rename test to `.spec.ts`, run it with `tsx --test`, enable TS extension import only for no-emit test config. Pending fresh CI verification. Keep PR Draft and do not claim WB-001 complete.
- Next: generate reproducible workbench/package-lock.json; use `npm ci` in workbench CI; implement lint/browser Smoke and run acceptance. GitHub runner may be used because current local container cannot resolve npm Registry (EAI_AGAIN).
- Separately, a read-only 30-minute delivery monitor is proposed by PR [#34](https://github.com/hutong236/hulane-opencode/pull/34); it will not run on schedule until merged into main.


### WB-001 — Fix root test isolation (2026-11-18)

- Failure confirmed: existing [Hulane CI run 44138113271](https://github.com/hutong236/hulane-opencode/actions/runs/44138113271) collected `workbench/apps/api/test/health.spec.ts` under root `node --test`, but root install has no Fastify; 181/182 tests passed before collection failure. It is not a regression of Hulane core assertions.
- Fix root `npm test` to explicitly run `test/*.test.mjs` for the pre-existing core test suite; Workbench tests remain in independent `workbench/ npm test`. New CI must confirm both, and no test is silently dropped from the core suite.
- Next: recheck exact branch SHA, root CI and Workbench CI. Review PR #33, keep #3 untouched.

### WB-001 — Root test discovery regression guard (2026-11-17)

- Task: add a Node built-in regression test enforcing explicit root test glob and independent Workbench test command, preventing accidental Fastify-dependent `.spec.ts` discovery by the root CI.
- Branch: `feat/WB-001-workbench-bootstrap`; PR #33; parent `11dc8ed32b7a544623cb6460c5f682f8aeddf4f3`.
- Files: `test/workbench-test-isolation.test.mjs`, `docs/SESSION_HANDOFF.md`.
- Validation: test is designed for existing root `npm test` on Node 20/22; **not locally executed** in this connector-only execution. Exact post-push Actions must determine pass/fail. Previous [Hulane CI 44153651055](https://github.com/hutong236/hulane-opencode/actions/runs/44153651055) had core Node20/22 success and one cancelled macOS ARM job; [Workbench CI 44153651029](https://github.com/hutong236/hulane-opencode/actions/runs/44153651029) succeeded.
- Risk: cancellation is not evidence of a failing test; do not mark the full Hulane matrix green. No real OpenCode CLI executed in this step.
- Next: inspect the new commit's full CI matrix, diagnose any actual failed job, and finish WB-001 review; keep Issue #5 open until verified acceptance and Issue #3 open for production gates.

### WB-001 — Negative API route regression (2026-11-17)

- Task / acceptance: GET /api/does-not-exist must return HTTP 404 and must not report status=ok; GET /api/health remains covered by existing positive test.
- Branch: `feat/WB-001-workbench-bootstrap`; Draft PR #33; parent `b0a45e415c03f752d8cd7261020e4b22746579b2`.
- Files: `workbench/apps/api/test/health.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Validation: connector-only change; local npm tests **not run**. Previous exact-parent Workbench CI [44172729271](https://github.com/hutong236/hulane-opencode/actions/runs/44172729271) succeeded; Hulane CI [44172728998](https://github.com/hutong236/hulane-opencode/actions/runs/44172728998) marked failure solely with macOS ARM job cancelled, five other jobs succeeded. New SHA CI is pending verification; no real OpenCode CLI run here.
- Concurrency: 100 latest Actions runs showed no queued/in-progress jobs at pre-write check; PR #33 head matched parent. GitHub auto-coding workflow in PR #35 is not merged into main.
- Risk: API negative path test not yet verified by runner; full Hulane matrix not green. Issue #5 and production Issue #3 remain open.
- Next: inspect new CI for this commit; investigate macOS ARM cancellation if reproducible, then add lint command and finish WB-001 acceptance.

### WB-001 checkpoint — source lint and CI gate (2026-11-18)

- Task: Add a deterministic zero-dependency Workbench source lint command, CI gate and regression tests; keep the existing independent npm lockfile unchanged.
- Branch: `feat/WB-001-workbench-bootstrap`; parent `6c537e3fcee4b98ddd2425e377c11fedac58481c`. The authoritative new SHA is the remote branch HEAD after push.
- Files: `workbench/package.json`, `workbench/scripts/lint.mjs`, `workbench/test/lint.test.mjs`, `.github/workflows/workbench-ci.yml`, this handoff.
- Acceptance: `npm run lint` rejects unresolved conflict markers, trailing whitespace, CRLF and missing final newline in Workbench source files; Node test fixtures cover positive/negative cases; Node 20/22 Workbench CI runs lint before typecheck/build/test.
- Validation: GitHub API source inspection only before push; no local `npm ci`, `npm run lint` or `npm test` executed in this session. CI for the new commit is pending until an actual Actions run is observed. Previous branch HEAD `6c537e3fcee4b98ddd2425e377c11fedac58481c` had successful Workbench/Hulane CI runs 44192490340/44192490474.
- Risk: This is intentionally a narrow source-hygiene lint, not a full ESLint ruleset. Existing files may require style cleanup if CI flags violations. No production Gate #3 claim.
- Next: inspect the new SHA's Workbench/Hulane CI; fix any real lint failure in a separate checkpoint, then complete WB-001 remaining browser/runtime acceptance.


### WB-002 — SQLite schema and storage foundation (2026-11-18)

- Issue [#6](https://github.com/hutong236/hulane-opencode/issues/6), branch `feat/WB-002-sqlite-foundation`, starting from `main` `cc9288bf2bca2e87f9856db5eb626e9688d94b6b`.
- Scope: ten-table SQLite schema, WAL/foreign keys/busy timeout, transactional SHA-checked migrations, project CAS repository, backup, isolated tests and storage boundaries.
- Validation: GitHub CI dependency generation/checkpoint pending (runner must resolve SQLite native driver). No local npm network available in this environment; do not report tests as passed until CI runs.
- Next: capture and commit independently generated Workbench lockfile; return CI to `npm ci`; run Node 20/22 API+DB+Workbench and existing Hulane suites; fix failures before PR is reviewable.


### WB-002 checkpoint — lockfile and types (2026-11-18)

- Previous checkpoint `d39da5741cf63cd30a41c06853d7768a8d5c82c5`: [Workbench CI 44229008803](https://github.com/hutong236/hulane-opencode/actions/runs/44229008803) found three TypeScript test `unknown` cast failures, while native dependency installation and source lint succeeded.
- Current step: commit Runner-generated `workbench/package-lock.json`, restore `npm ci`, add typings for SQLite count queries, use canonical macOS temporary test directories, clean isolated fixtures, publish ESM package typing exports.
- Verification status: fresh CI for this checkpoint pending. Full sqlite tests, root regression, macOS/Linux compatibility and correct WAL backup behavior must be checked in Actions; no test result is invented.
- Next: inspect exact HEAD CI for both Node 20/22; fix real failures, review DB migration/backup and repository boundaries, then open PR #6 and retain production #3.


### WB-002 — Atomic migration history and SQLite writer contention (2026-11-18)

- Existing HEAD `8946f80e8e60318f03427a56951245bf554d83ac` was verified by [Workbench CI 44229238584](https://github.com/hutong236/hulane-opencode/actions/runs/44229238584) (Node 20/22 2/2 success) and [Hulane CI 44229238505](https://github.com/hutong236/hulane-opencode/actions/runs/44229238505) (6/6 success).
- This checkpoint moves migration history reads and writes into the same SQLite BEGIN IMMEDIATE transaction, preventing concurrent startup races. Adds busy-timeout contention and migration tampering negative tests.
- No OpenCode CLI invocation from this development session; existing Hulane CI exercises its own CLI separately.
- Current step's CI pending until actual GitHub Actions status is observed. Next: verify final SHA, open PR for Issue #6 and confirm all acceptance gates.


### WB-003 — Browser Shell first checkpoint (2026-11-18)

- Issue #7, branch `feat/WB-003-web-shell-routing` based on `main` `ad726e5a499e893f5d4dc4a8251e243d70081685`.
- Added six URL routes, browser history handling, responsive mobile Drawer, breadcrumbs, error boundary, real /api/health state and retry, local-only theme preference and honest disabled business pages. Added route and API error unit tests.
- No additional npm packages in this checkpoint. CI status unverified until the exact new SHA runs. No core Hulane paths were changed.
- Next: inspect Workbench/Hulane CI, then add Playwright smoke and lockfile, verify deep-link refresh and mobile navigation. Production Issue #3 remains open.


### WB-003 Playwright browser tests checkpoint

- Earlier HEAD `0c0a35a5c5bc87bb29aa6d42655631cdde450068`: Workbench CI 44230432635 (2/2 passed), Hulane CI 44230432632 (6/6 passed).
- Added pinned Playwright Chromium and tests for six browser routes, reload, HTTP 500 retry, mobile Drawer and local theme persistence.
- Temporarily run npm install to export exact lockfile. This checkpoint's CI remains pending. Next: commit lockfile, restore npm ci, verify browsers and regression, open PR. Production #3 is unchanged.


### WB-003 — Lockfile + supported Playwright runner (2026-11-18)

- Previous HEAD `f1cc7c629716e4cc67bfea546c71dc92279adeff`: [Workbench CI 44230774775](https://github.com/hutong236/hulane-opencode/actions/runs/44230774775) Node 20 passed; Node 22 failed to install Chromium because `ubuntu-latest` resolved to Ubuntu 26.04, unsupported by pinned Playwright 1.56.1. Source compile/unit tests were not the reported failure.
- New checkpoint pins Workbench CI runner to `ubuntu-24.04`, commits npm lockfile from a real runner installation, returns CI to `npm ci`. E2E browser pass/fail pending on this SHA.
- Next: inspect 4 Playwright browser smoke cases; fix actual failures before approval and PR #38 merge. Production #3 remains open.


### WB-003 — Use GitHub runner's preinstalled Chrome (2026-11-18)

- Workbench CI 44231007520 had Node 20 test/build success while Node 22 Playwright Chromium download remained in progress. GitHub Ubuntu 24.04 x64 image documents Google Chrome as preinstalled; Playwright supports `channel: chrome`.
- Switch E2E from downloaded bundled Chromium to preinstalled Chrome, explicitly verify `google-chrome --version`, removing repeated browser binary installation. Tests still run in real headless Chrome.
- Actual browser test result for this change remains unverified until fresh CI. No affected production gates (#3) or privileged tool calls.


### WB-003 — Separate Node 20 HTTP smoke from Node 22 browser E2E

- At HEAD `4a9923f01d5608d11d6a4a02c51d010b8161b425`, Workbench CI [44231451726](https://github.com/hutong236/hulane-opencode/actions/runs/44231451726) Node 22 browser step failed BEFORE tests: the previous HTTP smoke started `npm run dev`, and its child service stayed bound to port 3000. Playwright refused to reuse it under CI strict mode. Node 20 tests succeeded.
- Fix: run independent HTTP smoke only on Node 20; Node 22 will test an isolated fresh server through Playwright's built-in `webServer`. Both suites still validate true `/api/health` connectivity.
- New SHA requires CI verification before merging PR #38. Production Issue #3 unchanged.


### WB-003 — Shared UI primitives and confirmed theme reset

- Exact prior HEAD `74e31df30d524035c99ac4c3a71b385336d34e1f`: [Workbench CI 44231617335](https://github.com/hutong236/hulane-opencode/actions/runs/44231617335) Node 20/22 green, including **4/4 browser E2E**; [Hulane CI 44231617289](https://github.com/hutong236/hulane-opencode/actions/runs/44231617289) 6/6 green.
- This change adds reusable empty DataTable and Popconfirm components, and uses confirmation to reset browser-local theme. Adds a Playwright test covering cancel and confirm actions.
- New CI results pending; do not mark PR #38 ready or Issue #7 accepted before exact new SHA passes.


### WB-003 — Stabilize Popconfirm E2E locator

- [Workbench CI 44231934598](https://github.com/hutong236/hulane-opencode/actions/runs/44231934598) previous HEAD `bc083e8af61ff0619e9af8069c4063cf867abdf5`: 4 existing Playwright tests passed, new confirmation test failed at a role/name locator for the Cancel action; actual confirmation title was visible. Node 20 passed, Node 22 test exit failed.
- Replace locale-sensitive accessible-name selector with scoped `.ant-popconfirm-buttons button` DOM selection and assert both controls exist. New CI must verify cancel and confirm behavior. Hulane production gate #3 unchanged.


### WB-004 — Canonical Git repository root validation (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `b908c34f0f1a596ec15342e59e96435014526bd3`; authoritative SHA is the verified remote HEAD.
- Scope: reusable fail-closed registration boundary: absolute path, no symlink components, real Git worktree root, Git invoked without a shell.
- Regression: temporary Git root, nested directory, non-Git directory, relative path and symlink alias.
- Validation: connector-only source changes; local npm/tsx tests **not run**. Check exact-SHA Actions before claiming success. Issue #8 CRUD/UI remain incomplete.
- Next: check CI, then integrate validation and duplicate detection into project registration. Production Issue #3 remains open.

### WB-004 — Fail-closed Git worktree and environment isolation (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `f0c9b3b3de73a3a14226bbd3aaecda7399ad8d88`; current remote HEAD must be checked after push.
- Scope: reject bare repositories, require `--is-inside-work-tree=true`, and strip inherited Git location overrides before subprocess validation.
- Regression: bare repository and hostile `GIT_DIR` redirect; retain existing canonical/nested/symlink tests.
- Validation: connector-only edit; local tests **not run**. Previous parent Workbench CI 44235079874 and Hulane CI 44235079936 passed; new SHA requires its own CI evidence.
- Risk: project registration CRUD/UI and duplicate-path persistence remain incomplete; Issue #8 stays open.
- Next: wire validated canonical root into project registration and add duplicate registration rejection tests; no production Gate approval (#3).

### WB-004 — Git root pre-registration API boundary (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `671b1774482b33df79eb3a9f0f9a2a34a5daa752`; authoritative commit SHA is remote branch HEAD after push.
- Scope: `POST /api/projects/validate` uses canonical Git root validator; rejects missing/non-string and invalid paths with HTTP 400, without returning local Git stderr or rejected paths.
- Regression: Fastify inject test for real temporary Git repository, non-Git directory, relative path and invalid body types.
- Validation: connector-only code change; local tests **not run**. Parent Workbench CI 44247948169 and Hulane CI 44247948168 succeeded; new SHA CI must be checked independently. Real OpenCode CLI not exercised.
- Risk: this endpoint validates only; it does not persist registrations or implement CRUD/UI. Issue #8 and production Issue #3 remain open.
- Next: implement atomic database-backed registration with canonical root uniqueness and duplicate rejection, then connect UI.

### WB-004 — Persistent repository-root uniqueness regression (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `83ec0ea5886bee669288ac083936ec73a7d9ee21`; latest SHA is the verified remote branch HEAD.
- Scope: add `ProjectRepository.findByRoot` for canonical-root lookup; retain SQLite `repo_root UNIQUE` as the authoritative atomic duplicate guard.
- Regression: two distinct slugs cannot register the same root; lookup and duplicate rejection persist after database close/reopen; failed registration leaves one record.
- Validation: GitHub connector-only source edit; local `npm test` **not run**. Check exact new SHA Workbench CI and Hulane CI before claiming pass. No real OpenCode CLI exercised.
- Limitation: the API registration endpoint is not yet connected to this repository, and path canonicalization must occur before calling `create`; Issue #8 stays open.
- Next: add `POST /api/projects` backed by `validateRepositoryRoot` and `WorkbenchDatabase.projects.create`, map SQLite uniqueness errors to HTTP 409, and test API persistence and duplicate requests. Production Issue #3 remains open.

### WB-004 — Git environment override hardening (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `38b5d712bc166b1fc46d6351df6cc87b4755dea6`; authoritative SHA is remote branch HEAD after push.
- Scope: strip all inherited `GIT_*` variables before running Git root validation, including injected `GIT_CONFIG_*` and alternate object directories; preserve non-Git process environment.
- Regression: a real temporary Git repository remains valid despite hostile `GIT_CONFIG_COUNT` / `core.bare` and `GIT_OBJECT_DIRECTORY` overrides.
- Validation: connector-only code change; local tests **not run**. Exact new SHA CI must be checked after push; real OpenCode CLI not exercised.
- Next: implement `POST /api/projects` using canonical root validation and SQLite persistence, map duplicate registration to HTTP 409, and add Fastify API regression. Issue #8 and production Issue #3 remain open.

### WB-004 — Cross-connection duplicate-root regression (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `ad0dfcf1a76531300ce3b9efe07a13270cc04611`; authoritative SHA is the remote branch HEAD after push.
- Files: `workbench/packages/database/test/project-root-concurrency.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: two independent SQLite connections see the same registered canonical root; a second slug cannot register it; exactly one row survives reopen.
- Validation: source-level regression authored via GitHub connector; local `npm test` **not run** in this execution environment. Exact-commit Workbench/Hulane CI must be checked after push; never assume green.
- Blockers: API `POST /api/projects` and CRUD/UI still missing; Issue #8 remains open. Production Issue #3 remains open.
- Next atomic task: connect validated Git root with persistent project registration API, returning HTTP 400 for invalid input and HTTP 409 for duplicate roots, with Fastify inject tests.

### WB-004 checkpoint — read-only real Git status (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent verified before edit: `2cceaf02e6807ed8118c20a477266f5e0bfe504e`.
- Files: `workbench/apps/api/src/repository-status.ts`, `workbench/apps/api/test/repository-status.spec.ts`, this handoff.
- Scope: read-only canonical-root Git status (HEAD SHA, branch including detached HEAD, dirty flag); no shell and no inherited GIT_* overrides. Regression covers clean/dirty/detached and nested-path rejection.
- Validation: source and test committed via GitHub API; local npm/typecheck/tests **not run** in this environment; Actions on the new commit must be checked before marking success. Real OpenCode CLI not exercised.
- Risk: status snapshot is non-atomic if repository changes between Git invocations; API persistence and CRUD/UI still missing.
- Next: inspect new CI, then implement POST /api/projects with SQLite and HTTP 400/409 tests.

### WB-004 checkpoint — Fastify path safety boundary regression (2026-11-19)

- Branch: `feat/WB-004-repo-root-validation`; parent remote SHA: `e6b1f455d9dfff2105d1c23452a72758586f79f4`.
- Added `workbench/apps/api/test/project-path-guards.spec.ts` to assert that the real Fastify validation endpoint accepts a canonical Git root, rejects nested directories and symlink aliases (including paths beneath aliases) with HTTP 400, and never returns local paths in error responses.
- Validation: test not run locally (GitHub API-only execution); CI for this new commit must be checked separately. The parent SHA's Workbench CI #44441483564 and Hulane CI #44441483557 succeeded; this is not evidence for the new test.
- Concurrency preflight: repository Actions run listing showed no queued/in-progress jobs, including the scheduled autonomous-development workflow; verify again before any subsequent write.
- Next: check new CI; then implement `POST /api/projects` with persistent SQLite registration and HTTP 400/409 regression tests. WB-004 and production acceptance #3 remain open.


### WB-004 checkpoint — read-only Git status HTTP endpoint (2026-11-19)

- Branch: `feat/WB-004-repo-root-validation`; parent remote SHA: `29a30f07e84c09c269a89497c228117216a3a3ee` (new remote SHA must be verified from the branch after push).
- Changed: `workbench/apps/api/src/app.ts`, `workbench/apps/api/test/project-status-api.spec.ts`, and this handoff.
- Acceptance: `POST /api/projects/status` returns actual HEAD SHA, branch and dirty state for a validated Git root; malformed, nested and missing paths fail HTTP 400 without leaking filesystem paths; detached HEAD is represented by a null branch.
- Validation: local npm tests/typecheck **not run** in this GitHub API-only environment. Parent commit Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44455078067 and Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44455078059 succeeded; new commit CI must be checked separately. Real OpenCode CLI not exercised.
- Concurrency: before write, repository Actions list showed 0 queued and 0 in-progress runs; recheck before updating ref.
- Next independent task: check this commit's CI, then implement SQLite-backed `POST /api/projects` with dependency/lockfile, HTTP 201/400/409 and persistence regression tests.

### WB-004 checkpoint — disable repository-configured Git fsmonitor execution (2026-11-19)

- Branch: `feat/WB-004-repo-root-validation`; parent verified SHA `a4f0bef2b3bca02974ad7d5d04dcf84949ccafb6`. The remote ref after push is authoritative.
- Scope: force `core.fsmonitor=false` and an inert hooks path for all read-only Git status commands, preventing an untrusted repository's fsmonitor executable from being launched during API status reads.
- Regression: create a real Git repository with a configured fsmonitor shell script and assert status succeeds without creating the script's execution marker.
- Validation: source/test authored through GitHub connector; local tests and typecheck **not run**. Parent Workbench CI #44502497069 and Hulane CI #44502497035 passed; new SHA CI must be checked independently. Real OpenCode CLI not exercised.
- Next: check new CI; then implement SQLite-backed `POST /api/projects` with HTTP 201/400/409, durable registration and workspace dependency/lockfile updates. Issue #8 and production #3 remain open.

### WB-004 — SQLite project registration checkpoint (2026-11-19)

- Added POST /api/projects with canonical Git-root validation, HTTP 201/400/409, SQLite uniqueness handling and lazy database lifecycle.
- Added regression for invalid path, duplicate registration and persistence across SQLite reopen. Updated API workspace dependency and lockfile.
- Validation: local tests/typecheck **not run**; new commit CI **not yet verified**; real OpenCode CLI not exercised. Production Issue #3 remains open.
- Next: inspect exact commit CI, fix failures before implementing project list/detail/delete API and UI.

### WB-004 — CI TS2307 database declaration build-order repair (2026-11-19)

- Isolated fix branch: `fix/WB-004-database-build-order-20261119`, based on WB-004 registration commit `2659fd40a1605a87cf883852d5d869db14047532` to avoid conflicting with the active automation branch.
- Observed failed Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44529026354 (Node 20 and 22): `src/app.ts` and `test/project-registration.spec.ts` TS2307 cannot resolve `@hulane/workbench-database` because package `types` points to `dist/index.d.ts`, which is absent before build.
- Fix: root workbench `typecheck` and `build` scripts prebuild the database workspace, producing its published declaration/runtime outputs before dependent API checks and builds.
- Parent Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44529026378 marked failure with 5 successes and one cancelled macOS job; do not claim successful CI. This isolated fix has not been tested locally; new Actions must confirm it.
- Next: inspect new fix PR CI; if green, integrate this fix into WB-004 safely after verifying concurrent writer state, then continue project list/detail/delete APIs and Web UI. Keep Issues #8 and #3 open.

### WB-004 — project detail endpoint checkpoint (2026-11-19)

- Isolated branch: `feat/WB-004-project-detail-20261119`, parent `b9b6f972dd0b1b454c3acaa09003495ca6257702` (PR #40 CI-green build-order repair).
- Scope: add `GET /api/projects/:id` for persisted project metadata with UUID input guard, HTTP 200/400/404 and no filesystem paths in errors. No repository mutation.
- Regression: Fastify inject test registers a real temporary Git repository, checks exact stored record, malformed ID and missing ID.
- Validation: local npm tests/typecheck **not run** in GitHub API-only environment; CI on the new commit is pending until verified. Parent PR #40 Workbench CI #44539518268 and Hulane CI #44539518237 succeeded; real OpenCode CLI not exercised.
- Next: inspect exact new commit CI, then implement project listing and deletion of registration without deleting Git files. Do not close Issues #8/#3 or merge production.


### WB-004 — SQLite project list API (2026-11-19)
- Branch: `feat/WB-004-project-list-20261119`; parent: `e875f6cca87b88557432a5cbb8a4b49f71dbc04b`; Draft PR follows branch creation.
- Acceptance: GET /api/projects returns 200 with an empty array or persisted project metadata in deterministic created_at/id order; no filesystem/Git access during listing.
- Changed: database ProjectRepository.list(), Fastify GET route, new project-list.spec.ts regression, this handoff.
- Validation: GitHub connector-only edit; local npm test/typecheck **not run**; new SHA CI must be checked after push. Parent SHA Workbench CI 44560530322 and Hulane CI 44560530218 both succeeded. Real OpenCode CLI not exercised.
- Risk: list currently unpaginated; project registry UI and safe unregister remain outstanding. Issue #8 and production Issue #3 remain open.
- Next atomic task: check new SHA CI and repair any failures; otherwise implement safe project unregister without deleting repository files.


### WB-004 — SQLite-only safe project unregister (2026-11-19)

- Isolated branch: `feat/WB-004-safe-unregister-20261119-2005`, based on verified list endpoint SHA `955ea6a53a2970e87977f10eda9c3b3018f6e575`; no writes to existing development branches.
- Scope: `DELETE /api/projects/:id` with UUID guard, 204 on successful unregister, 400 for malformed IDs and 404 for missing IDs; `ProjectRepository.delete` executes only `DELETE FROM projects WHERE id = ?` in SQLite.
- Regression: `project-unregister.spec.ts` registers a real temporary Git repository, checks 204/400/404, absence of registration after deletion, preservation of `.git` and a user marker file, and no filesystem path in errors.
- Validation: source/test authored via GitHub connector; local npm test/typecheck **not run**. Parent list SHA Workbench CI #44572313223 and Hulane CI #44572313392 completed successfully; new SHA CI must be checked independently. Real OpenCode CLI not exercised.
- Concurrency: this change is isolated on a newly named branch; no writes to main or active half-hour automation branches. Repository-wide active Actions cannot be conclusively enumerated through this connector.
- Risk: UI, live health status and full WB-004 acceptance remain outstanding; Issue #8 and production Issue #3 remain open.
- Next: inspect this branch's exact CI and fix failures first, then implement project management Web UI and real Git health display.


### WB-004 — Strict project list client contract (2026-11-19)
- Branch: `feat/WB-004-project-client-20261119-2359`; isolated from all existing development and scheduler branches; parent `0a17b2156cf24ff1bb0baf6ab0586fe379855549`.
- Code: `getProjects` uses existing same-origin `requestJson`; `decodeProjectList` checks envelope, record fields, UUID, absolute repository root, nonnegative integer revision, and duplicate IDs before rendering.
- Regression: `project-list-client.spec.ts` checks empty/valid responses and malformed/duplicate data.
- Validation: GitHub connector writes only; local `npm test`, `npm run typecheck`, browser smoke, and real OpenCode CLI **not run**. Parent Workbench CI #44605266143 and Hulane CI #44605266115 succeeded; new SHA CI pending verification.
- Concurrency: new isolated branch only; connector cannot fully enumerate scheduled half-hour Actions jobs. No write to `main` or shared feature branches.
- Risk: project UI not yet connected, project status UI and complete WB-004 acceptance outstanding. Issues #8 and #3 remain open.
- Next atomic task: inspect exact-commit CI and fix failures; then add project list loading/empty/error/retry UI.


### WB-004 — project list UI states (2026-11-20)
- Branch: `feat/WB-004-project-list-ui-20261120-0056`; parent verified `03e699f1e373d4b873d1e6725cc3a1facf1fc5ad` (remote branch SHA after push is authoritative).
- Scope: connect /projects to validated getProjects() with loading, empty, error/retry, and read-only project table. Abort stale requests on unmount/retry.
- Validation: parent Workbench CI #44642346340 and Hulane CI #44642346203 succeeded; this commit's CI pending. Local tests/typecheck/browser smoke and real OpenCode CLI not run in connector-only environment.
- Risks: registration, details, unregister, and live Git status Web controls remain unimplemented; no production acceptance. Issues #8 and #3 stay open.
- Next: inspect exact new SHA CI; fix any failures, then add browser UI regression/smoke for loading/empty/error/retry.

### WB-004 — HTTP request regression (2026-11-20)

- Branch: `test/WB-004-project-list-request-20261120-0304`, parent `a3e286236d0fcc5df7b525cc1e7a6fba61e37bd3`; authoritative new SHA is remote branch HEAD.
- Change: `workbench/apps/web/test/project-list-request.spec.ts` tests 503 then retry/empty result, AbortError propagation, malformed response rejection.
- Validation: local `npm test --workspace @hulane/workbench-web` and typecheck NOT RUN (GitHub connector has no local Node environment). Parent CI: Workbench 44649896984 and Hulane 44649896991 passed. New CI pending verification.
- Risk: HTTP client regression only, not DOM/browser smoke or real OpenCode CLI. No production Gate approval.
- Next: inspect new CI and add browser smoke covering loading, empty, failure, retry and stale request cancellation.


### WB-004 checkpoint — project list malformed-response recovery regression (2026-11-20)

- Step: Add two deterministic request-level regression tests: HTTP 200 malformed JSON must reject without poisoning the next valid retry; transport failure messages must not expose the underlying exception's sensitive text.
- Branch: `test/WB-004-project-list-failure-recovery-20261120` (isolated from `test/WB-004-project-list-request-20261120-0304`).
- Code commit before this handoff: `c191adec29e630e0bd37f1f09459db950e564b96`; authoritative final SHA is the remote branch HEAD.
- Files: `workbench/apps/web/test/project-list-request.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Validation: Parent commit Workbench CI runs 44665278910 / 44665269707 and Hulane CI 44665278893 succeeded. New commit tests, typecheck, browser Smoke and real OpenCode CLI are **not run locally**; new Actions results must be inspected before claiming success.
- Risk / blocker: These are HTTP-client regressions, **not** real browser interaction tests. No production Gate A/B/C verification. Issue #8 and Issue #3 stay open.
- Next step: Inspect this branch's CI; then add browser-level loading/empty/error/retry/cancellation coverage with an actual browser runner, without weakening Hulane Gate.


### WB-004 checkpoint — same-origin project list client guard (2026-11-20)

- Branch: `test/WB-004-project-client-origin-guard-20261120` (isolated from verified parent `3516496c861b018c70682719681392d44bfa4298`).
- Code commit: `68278df39d7a8562ab7797e79869a620988a7afb`.
- File: `workbench/apps/web/test/project-list-origin-guard.spec.ts`.
- Acceptance: assert GET project list uses same-origin `/api/projects`, JSON Accept, no-store and no explicit credentials; reject absolute/protocol-relative/non-API URLs without issuing fetch.
- Prior parent CI: Workbench #44671304861 success; Hulane #44671304879 success. New tests not run locally; new commit CI unverified until checked.
- Risk: this is request-level Node regression, not browser Smoke or production Gate A/B/C. No actual OpenCode CLI validation.
- Next: check new branch CI, repair failures first; then add browser-level project-list loading/empty/error/retry smoke.


### WB-004 checkpoint — Playwright project list browser regression (2026-11-20)

- Step: Add browser-level coverage for pending project list loading, real metadata rendering, empty-list refresh, HTTP 503 retry recovery, and navigation away from a pending request.
- Branch: `test/WB-004-project-list-browser-20261120-1100`, based on verified PR #48 head `754ac92ea33919075ddb6bfde4da8e41b013e40c`; code commit `bf9c609aa358a0a0c49d377602f522c6cc4e00b2`. Final remote branch HEAD after handoff is authoritative.
- Files: `workbench/e2e/project-list.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: Playwright tests must pass in Chrome via `cd workbench && npm run test:e2e`; CI at final branch SHA must be inspected. Browser tests authored, **not run locally**; new CI pending. Real OpenCode CLI and production Gate A/B/C **not run**.
- Concurrency: GitHub Actions repository-wide queued and in_progress queries both returned 0 before writing; last scheduled autonomous development run #44721080097 was completed/success. No writes to main or shared task branches.
- Risk: This is read-only list UX regression, not full project registration/detail/health UI acceptance. Issue #8 and production Issue #3 remain open. PR dependency chain #39–#48 must be reviewed before any merge.
- Next: inspect exact new SHA CI, fix failures first; then implement/verify project registration and health controls in the Web UI without bypassing Hulane Gate.


### WB-004 — Repair browser CI under React StrictMode (2026-11-20)

- Step: Fix failing PR #49 Playwright assertions (Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44724177979, Node 22 browser E2E: 3 failed, 1 passed; Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44724177744 passed).
- Branch: `fix/WB-004-playwright-strictmode-20261120`, based on PR #49 head `6fc29947f2267b0d3eaad549f939cc16410d3abf` (not main, to preserve the failing browser test context).
- Files: `workbench/e2e/project-list.spec.ts` and this handoff.
- Change: React.StrictMode runs the initial effect twice in development; route fixtures now keep initial empty/error outcomes through two requests and accept subsequent refresh/retry, while cell locators disambiguate duplicated DOM matches. The original browser tests and cancellation coverage remain in place.
- Validation: source/log inspection only. New SHA CI and local Playwright **not run/verified** at this checkpoint; real OpenCode CLI not exercised. Exact remote branch HEAD is authoritative after this handoff commit.
- Risk: the fixture assumes two initial requests in dev; verify exact Node 22 browser results before accepting. Do not close Issue #8 or production Issue #3.
- Next: inspect fresh Workbench CI Node 20/22 and Hulane CI for this fix; if red, use browser traces to repair the next failing assertion before adding WB-004 project registration UI.


### WB-004 — Fix empty-list refresh browser regression (2026-11-20)

- Step / acceptance: On the project list, after an empty response, clicking the Card refresh action must display a newly registered project, regardless of React StrictMode initial request count.
- Branch: `fix/WB-004-empty-refresh-e2e-20261120`, parent `aa4ce0973b09c5943149345ec61426efbf6cfb23` (stacked on Draft PR #50). Code commit: `013f077ad99dc61973c305db6532f51b9553862a`; authoritative final SHA is remote branch HEAD.
- Files: `workbench/e2e/project-list.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Failure evidence: Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44732780377 Node 22 failed 1/9 browser cases (8 passed): timeout waiting for `getByRole('button', { name: '刷新' })`; Node 20 succeeded. Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44732780438 succeeded.
- Change: scope click to `.ant-card-extra button` and switch mock response based on explicit refresh phase, rather than relying on exactly two StrictMode initial requests. Keep assertion that the newly returned project appears.
- Validation: source reviewed against actual `ProjectList.tsx`; local Playwright and real OpenCode CLI **not run**. New commit CI pending and must be checked before claiming pass.
- Risk: stacked PRs need review; this does not satisfy project registration/Git health UI or production Issue #3.
- Next: inspect exact SHA Workbench/Hulane CI; fix any failure, then implement project registration and Git health UI controls.

### WB-004 — Safe browser registration API client (2026-11-20)
- Branch: `feat/WB-004-registration-client-20261120`, stacked on PR #51 SHA `3afefaa50781ed3d2aa5da7f9c84c0ea5381d2bf`.
- Changed: `workbench/apps/web/src/api/client.ts`, `workbench/apps/web/test/project-registration.spec.ts`.
- Acceptance: local-only POST /api/projects with validated input and persisted response; duplicate/unsafe-path errors mapped without leaking server text; abort preserved. Server remains authoritative for realpath and Git root checks.
- Validation: new Node test cases added for success, invalid input, HTTP 400/409, malformed response and abort. No local npm or real OpenCode CLI execution in this API session; exact new commit's CI must be checked after push.
- Risk: registration UI and live Git health status are not yet wired. Issue #8 and production Issue #3 remain open.
- Next atomic task: add project registration form to ProjectList, show safe validation failures and refresh persisted list, with browser E2E.

### WB-004 checkpoint — 2026-11-20: repair incomplete Git tree

- Step: Restore the complete inherited repository tree on PR #52; the prior commit `b7fdcfbabfcaa6f474128cc875de5ed7186eb50c` accidentally used a root tree containing only 10 entries, omitting AGENTS.md, package manifests and most source files.
- Branch: `feat/WB-004-registration-client-20261120`; parent: `b7fdcfbabfcaa6f474128cc875de5ed7186eb50c`.
- Files: repository tree restored from parent PR #51 tree `78687d196cd8ceaf7ded0929a6e1f55affcf6e19`, preserving PR #52 registration client and test blobs; this handoff entry records the correction.
- Validation: GitHub Git Trees API confirmed PR #51 base tree contains 274 entries and defective PR #52 tree only 10; restored tree must be verified remotely after push. Local npm/typecheck/Playwright not run. CI pending; real OpenCode CLI not run.
- Risk: Do not treat the prior commit as a buildable full checkout. Production Gate remains unverified.
- Next: Inspect PR #52 Workbench/Hulane CI and fix any failures; then implement registration form and project list refresh.


### WB-004 — Web registration form and list refresh (2026-11-20)
- Branch: `feat/WB-004-registration-client-20261120`; parent remote SHA `e68213e47ed133c200f47868ee0723a76d214a0f` (new HEAD is authoritative after push).
- Files: `workbench/apps/web/src/components/ProjectList.tsx`, `docs/SESSION_HANDOFF.md`.
- Acceptance: project form accepts absolute path, slug and name; calls existing same-origin `registerProject`; prevents duplicate in-flight submit; shows sanitized 400/409 errors; resets form and reloads persisted list on success; aborts pending request on unmount.
- Validation: source review only in GitHub API environment; npm, TypeScript, Playwright and real OpenCode CLI not executed. Prior Workbench CI #44788480278 passed, Hulane CI #44788480158 failed due to cancelled macOS smoke job; new commit CI must be checked separately.
- Concurrency: repository Actions queue and in-progress runs were both zero before write (GitHub REST repository Actions collection).
- Risk: browser E2E for registration and real Git health status still missing; Issue #8 and production Issue #3 remain open.
- Next: inspect exact new SHA CI; fix failures first, then add Playwright registration/error/list refresh coverage and Git health status.


### WB-004 — Browser registration regression checkpoint (2026-11-20)
- Branch: `feat/WB-004-registration-client-20261120`; parent: `f9e08caf67c7c7be31a7a9a3001e443a2d408bc0`; authoritative new SHA is remote branch HEAD.
- Files: `workbench/e2e/project-registration.spec.ts`, this handoff.
- Acceptance: Playwright verifies local POST payload and persisted list refresh, duplicate 409 redaction, and relative path rejection without POST.
- Evidence: prior commit `f9e08caf67c7c7be31a7a9a3001e443a2d408bc0` Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44826052995 and Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44826053009 both completed success. New tests not locally executed; new SHA CI pending. Real OpenCode CLI not exercised.
- Concurrency: repository Actions in_progress=0, queued=0 immediately before write; target HEAD matched parent.
- Remaining: verify new Playwright Node 20/22 CI; then implement real Git health status and negative cases. Issue #8 and production #3 remain open; no production merge.

### WB-004 — Invalid Git root browser retry regression (2026-11-20)
- Branch: `feat/WB-004-registration-client-20261120`; parent verified remote SHA `3f628a9ecfd27239198e9689f834ac83984a0edd`.
- Files: `workbench/e2e/project-registration.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: browser regression checks API 400 for a non-Git absolute root is rendered as sanitized feedback without leaking server text; corrected path retries successfully and refreshes the registered list.
- Validation: previous SHA Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44833562838 and Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44833562856 both completed success. New Playwright test NOT executed locally; new SHA CI pending; real OpenCode CLI NOT exercised.
- Concurrency: repository Actions queued=0, in_progress=0 before this change; branch SHA verified. No production operations.
- Risk: mocked HTTP responses are not a real three-repository integration acceptance; Git health UI still missing. Issues #8 and #3 remain open.
- Next: inspect new SHA CI, fix failures first, then wire real HEAD/branch/dirty status into the Web project view with browser regression.
