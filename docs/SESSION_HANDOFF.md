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
