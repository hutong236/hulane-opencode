# Hulane OpenCode 独立重构项目——开发实施手册

> 文档编号：HOC-DEV-001  
> 版本：V1.0 / 2026-11-10  
> 对应架构：`01-Hulane-OpenCode-总体设计.md`  
> 新仓库建议：`hutong236/hulane-opencode`（已创建）；源插件：Hulane 3.10.0  
> 开发模式：独立 GitHub 仓库；不在旧 `hutong-zcode-marketplace` 上提交改动  
> **性质：可执行开发蓝图与待验证示例，并非现成可用插件**

## 1. 研发任务与交付顺序

采用“**先移植验证核心、再接入 V2、最后切换受保护操作**”的增量重构策略。不直接重写状态机；每一步都必须与源插件已核实的行为做差异回归。

| 阶段 | 范围 | 交付件 | 阶段通过条件 | 初步工作量（1 名熟悉 Node/OpenCode 工程师） |
|---|---|---|---|---|
| P0-0 | 新仓库、源码快照、许可证、锁版本 | 独立仓库、`UPSTREAM_SOURCE.md`、CI 初版 | 不引用旧仓库运行；原测试运行且版本可追溯 | 1–2 人日 |
| P0-1 | Core+MCP 的最低可用性 | MCP stdio、`check/status/init`、安装器基础 | OpenCode V2 实际调用 MCP 成功，无错写仓库 | 3–5 人日 |
| P1 | 需求、Agent、Worktree、PR 主链 | `dev/approve/resume/flush`、7 Agent、规格同步 | Low/Medium 工作项完成一次 PR 闭环 | 5–10 人日 |
| P2 | 安全/审批/镜像交付 | Gate B/C、Release、受控 GitHub 写入、负向测试 | 未授权合并/Tag/Close 全部拒绝 | 6–12 人日 |
| P3 | 完整回归、升级、发布 | 文档、安装包、版本兼容矩阵、Release | 旧数据兼容、双实例冲突可控、安装端 E2E | 3–6 人日 |

工程量仅用于排期，不能替代真正的兼容性 POC。**建议先完成 P0-1 再承诺最终交付日期。**

## 2. 开发环境与前置条件

- **OpenCode V2**：选择一个明确可安装的 V2 发布版本，记录 `opencode --version`。官方 V2 插件 API 是 beta；开发和 CI 固定精确版本，不用 `latest` 随意升级。
- Node.js：`>=20`（与源仓库 `package.json` 一致），`npm`/`pnpm`/`bun` 选一种包管理器；TypeScript 仅用于 Adapter 和安装器，Core 的 JS 在初期保留。
- Git、GitHub CLI `gh`、可用的 GitHub 认证；CI 环境使用专用最小权限凭据。
- macOS ARM64 与 Linux AMD64：分别完成真实安装/路径/权限测试；Windows 非首版强制目标。
- 测试业务仓库：一份隔离的 GitHub 沙盒仓库，配置真实 PR required checks；另备一个空仓库测试初始化。
- 建议 `Node.js 20/22 + TypeScript + node:test + ESLint + package manager lockfile`，禁止同时使用多个互相不一致的 lockfile。

环境预检查（仅验证本地环境，不创建资源）：

```bash
git --version
node --version
npm --version
gh --version
gh auth status
opencode --version
opencode plugin list
opencode mcp list
```

### 2.1 独立仓库初始化

在 GitHub 网页创建一个**空仓库**（推荐 `hutong236/hulane-opencode`）；或者在正确账号下使用下面示例。此处仅是使用说明，本次文档制作**没有创建仓库**。

```bash
mkdir hulane-opencode
cd hulane-opencode
git init -b main
printf '# Hulane OpenCode\n' > README.md
printf 'node_modules/\n.env\n*.log\n' > .gitignore
git add .
git commit -m 'chore: bootstrap independent OpenCode plugin repository'
# 确认账号/组织、可见性和仓库名后，才手动执行：
# gh repo create hutong236/hulane-opencode --private --source=. --remote=origin --push
```

仓库可见性需要用户自行确定；以上仅采用 `--private` 作为谨慎默认。**不得把旧 Marketplace 的 Git remote 改名后直接复用**。

### 2.2 从旧仓库导入源码，固定基线

建议将原项目克隆为只读参考，记录 commit SHA 后**只复制 `hulane/` 下必要文件**；不要复制 `.git/`、`.hulane/` 业务运行缓存、Token、开发机凭据、旧 Actions Secrets。

```bash
# 与新仓库并列的独立参考目录
git clone --depth 1 \
  https://github.com/hutong236/hutong-zcode-marketplace.git \
  ../hulane-upstream

git -C ../hulane-upstream rev-parse HEAD
# 将输出的 40 位 SHA 写入 UPSTREAM_SOURCE.md

mkdir -p src/core/legacy assets/legacy
cp -R ../hulane-upstream/hulane/scripts src/core/legacy/
cp -R ../hulane-upstream/hulane/mcp src/core/legacy/
cp -R ../hulane-upstream/hulane/commands assets/legacy/
cp -R ../hulane-upstream/hulane/agents assets/legacy/
cp -R ../hulane-upstream/hulane/skills assets/legacy/
cp -R ../hulane-upstream/hulane/templates assets/legacy/
```

以上复制位置是**过渡布局**。必须核查相对 `import ../scripts/lib`，再通过薄包装让原 Node 脚本与测试先跑通；不能在破坏相对路径后就宣称“核心已迁移”。另外检查仓库根 MIT `LICENSE`，保留版权/许可声明，新增 `UPSTREAM_SOURCE.md` 记录来源路径、版本、SHA、复制范围和改动。

## 3. 第一阶段：先建立行为基线

### 3.1 建立测试清单

从原仓库 `test/` 和 `hulane/scripts/lib/*` 导入已有测试（注意源仓库 `npm test` 是 `node --test`）。原有核心行为必须先归档为 golden tests：

1. 状态机 `STATES` 和允许事件，包含不可直接写入的受保护字段。
2. Low/Medium `auto_intake` / `pre_authorized` 与 High Risk 必须停等 Gate A。
3. Offline `issue_pending=true`、`hulane_flush` 幂等建单、`issue_created` 回填字段所有权。
4. `checks_passed` 由校验工具出证据；`pr_merged` 必须与 `pr_head_sha`/Checks/Reviewer 证据匹配。
5. `specs_synced` 必须只由专用事件记录，`specs_commit_sha` 必须等于 `merged_sha`。
6. `issue_closed`、Done、delivery policy、`legacy_completion` 的约束不降低。
7. `git worktree` 路径、无强制清理、分支名和实际默认分支。
8. 一次性令牌：状态绑定、仓库绑定、有效期、拒绝重复消费。
9. 旧 GitHub 状态标记 `<!-- cmdb-dev-state:v2 -->`、`cmdb-state` 块、revision、label 与老 `.cmdb-dev` 回退。
10. `gh` 命令异常/网络中断/部分成功/重复重试，不得生成虚假完成。

> 实施策略：**每次抽取一个模块→运行旧行为测试→再加新行为测试**。不要把源代码中的 `state-machine.mjs` 用大模型“一次性翻译”为 TypeScript 后就替换上线。

### 3.2 首批脚本建议

在新仓库的 `package.json` 配置（属于建议，安装依赖后生效）：

```json
{
  "name": "hulane-opencode",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test",
    "test:unit": "node --test tests/unit/*.test.mjs",
    "test:integration": "node --test tests/integration/*.test.mjs",
    "test:security": "node --test tests/security/*.test.mjs",
    "check": "npm run test"
  }
}
```

不要仅从上面一段推导“所有测试已存在”：它们要在阶段 P0 创建后才能运行。

## 4. OpenCode V2 MCP 接入（P0-1）

### 4.1 最小可验证配置

示例业务仓库的 `opencode.jsonc`（**路径为占位符，按实际安装位置生成**）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "hulane-control": {
        "type": "local",
        "command": [
          "node",
          "/ABSOLUTE/PATH/TO/hulane-opencode/runtime/mcp/server.mjs"
        ],
        "cwd": ".",
        "protocol": "legacy",
        "disabled": false,
        "codemode": false,
        "timeout": {
          "startup": 30000,
          "catalog": 30000,
          "execution": 600000
        }
      }
    }
  }
}
```

- `cwd: "."` 表示从**打开的业务项目工作区**启动 MCP 进程，符合原 `process.cwd()` 设计，**不可写成插件源码仓库目录**。
- `protocol: legacy` 在首个 POC 中验证当前 `initialize` 握手；原 server 还提供 `server/discover`，可在回归后单独验证 `auto`。
- `codemode: false` 便于在 P0 直接核对每个 Tool 的可见性和 Agent 权限；是否启用 Code Mode 后续专项测定。
- `timeout` 是 V2 的对象配置；不沿用 ZCode `.mcp.json` 的 `timeoutMs`。
- `environment` 可配置非机密参数，API Token 等只通过受管进程环境/密钥管理传入，不提交到仓库。

### 4.2 P0 MCP 联调步骤

```bash
# 在示例业务仓库根目录执行
opencode mcp list
opencode run --agent build '使用 hulane-control 执行 hulane_preflight，仅报告结果，不修改文件'
```

完成标准：MCP 出现在连接列表；工具可实际执行；结果可区分本地/在线检查；没有触及插件源码仓库或其他业务仓库；错误字段可诊断；重复执行不会改变业务资源。

### 4.3 服务端验证契约

`hulane-control` 至少支持：`initialize` / `tools/list` / `tools/call` / `ping`，同时按目标客户端需要支持 `server/discover`。不得假定新协议消息形态完全由旧手写 stdio 实现覆盖；需要真实 OpenCode 测试。工具输入遵循 JSON Schema，按 Tool 的读写属性约束可用角色。

控制平面返回建议规范（**新增目标契约，不是当前旧工具的既有输出**）：

```json
{
  "ok": false,
  "code": "HULANE_REVISION_CONFLICT",
  "message": "Remote state revision changed; hydrate first",
  "workItemId": "REQ-12",
  "currentRevision": 8,
  "expectedRevision": 7,
  "retryable": true
}
```

不要把它误当作 MCP 的底层 JSON-RPC Error 对象；它是 `tools/call` 内业务结果统一格式的设计目标。已存在的 Tool 可先保持旧输出，并在下一阶段加一层 response adapter。

## 5. OpenCode V2 插件 Adapter（P0-1）

### 5.1 SDK/插件骨架

官方 V2 插件文档使用 `@opencode/plugin` 的 `Plugin.define()` 形式。插件应提供默认导出、唯一 ID 和 `setup()`；源码样例：

```ts
import { Plugin } from "@opencode-ai/plugin"

export default Plugin.define({
  id: "hutong.hulane",
  setup: async (ctx) => {
    await ctx.session.hook("context", (event) => {
      // 只添加必要的简短状态指导，不把 Token/私密 Issue 信息注入模型。
      event.system.push("Hulane: 只能通过受控 MCP 推进状态；不得假定任务已经 Done。")
    })

    await ctx.tool.hook("execute.before", (event) => {
      // TODO: 对工具名、输入、Worktree 实际路径做纯函数判定。
      // 对违反规则的调用抛出可诊断错误，使用源插件策略的适配层。
      // 此 Hook 不是操作系统级沙盒，不能替代服务端 GitHub 权限。
    })
  }
})
```

**代码仅为骨架**。`event.system` 具体结构与 TypeScript 类型、Hook 中抛错的异常表现应在锁定 SDK 版本下编译/实际运行；不能把未执行过的模板当作编译成功代码。V2 插件 API 官方明确仍为 beta。

### 5.2 不在插件 `setup` 中启动永久阻塞任务

官方 V2 要求 `setup` 完成后返回注册；长生命周期 watcher 必须可取消，并在插件卸载时清理。不要在 `setup` 中无限等待 GitHub Checks。Checks 未完成时应留下 `pr_checking`，本轮反馈实际状态，再通过 `/hulane_resume` 继续；后台通知能力若采用，应单独测试生命周期及重启恢复。

### 5.3 权限策略、Policy 与 Hook 分层

- 第一层：OpenCode `permissions` 设 Agent 的最大能力，写 Agent 不继承可疑的通配权限。
- 第二层：OpenCode `policies` 对易识别的危险 Shell 形式执行不可临时批准的 `deny`。
- 第三层：`execute.before` 进行 Worktree/输入路径检查和执行纪律提示。
- 第四层：`hulane-control` 在服务端执行真实状态、SHA、Revision 和仓库检查。
- 第五层：GitHub Rulesets / Required Checks / 最小权限凭据防止旁路。

**重点：OpenCode 的 `permissions` / `policies` 只对通过 OpenCode 运行的工具生效。** 如果模型仍可启动任意子进程访问有权的 `gh`，单纯匹配 `git push` 文本绝不构成强授权。P2 优先安排**隔离 GitHub 写凭据**的受控 MCP 执行模型。

## 6. 文件安装器（P0）

### 6.1 最终安装布局（业务仓库内）

```text
business-repo/
├── opencode.jsonc
├── .opencode/
│   ├── commands/
│   │   ├── hulane_check.md
│   │   ├── hulane_init.md
│   │   ├── hulane_status.md
│   │   ├── hulane_dev.md
│   │   ├── hulane_approve.md
│   │   ├── hulane_resume.md
│   │   ├── hulane_flush.md
│   │   ├── hulane_merge_approve.md
│   │   ├── hulane_tag_approve.md
│   │   └── hulane_release.md
│   ├── agents/
│   │   ├── hulane-orchestrator.md
│   │   ├── hulane-planner.md
│   │   ├── hulane-designer.md
│   │   ├── hulane-design-critic.md
│   │   ├── hulane-coder.md
│   │   ├── hulane-tester.md
│   │   ├── hulane-reviewer.md
│   │   └── hulane-build-checker.md
│   ├── skills/hulane-development/SKILL.md
│   └── .hulane-managed-manifest.json  # 安装器管理清单（建议）
├── .hulane/                         # 运行状态，不纳入 Git
└── .github/workflows/               # init 安装的 Checks/镜像工作流
```

推荐**首版使用模板文件部署**，不要强依赖 SDK `command.transform/agent.transform` 的动态创建能力；后者可在成熟后改为纯插件注册。**特别注意 `.opencode/plugins/` 会自动发现插件文件**：不要同时把同一个文件放入自动发现目录又在 `plugins` 数组重复注册，避免重复安装 Hook。

### 6.2 安装器功能契约

建议 CLI：

```bash
# 安装器命令名称是目标设计，非已发布命令
hulane-opencode install --project .
hulane-opencode doctor --project .
hulane-opencode upgrade --project .
hulane-opencode uninstall --project .
```

`install`：检查 git root、Node/OpenCode；快照原 `opencode.jsonc`；结构化合并 MCP/Plugin 配置；复制 10 命令、Agent、Skill；写管理 manifest；**不自动运行 GitHub 推送或修改当前业务分支**。`upgrade`：仅在哈希等于已知管理版本时覆盖受管文件，用户改动冲突需显示 Diff 并保留；`uninstall`：只删 manifest 列出的受管文件，回滚配置中本插件管理字段，保留 `.hulane` 和 GitHub 对象。

## 7. Command 迁移任务明细（P1/P2）

| 命令 | 迁移关键点 | 最低验收用例 |
|---|---|---|
| `hulane_check` | 预检 Git/gh/OpenCode/MCP、Ruleset、图片工作流，保留离线可开单判断 | 无 gh 认证时标注 `online_required`，不误报失败成全不可用 |
| `hulane_init` | 初始化缓存、排除列表、CI 模板，重复安全 | 连续运行 2 次没有重复工作流/重置用户设置 |
| `hulane_status` | pending 本地状态；上线后先 Hydrate 再判断 | 删除本地缓存后在线可恢复；pending 时不虚构 Issue |
| `hulane_dev` | small/standard 分类、Planner、Spec delta、Gate A | 普通需求 auto_intake；High Risk 停待批准 |
| `hulane_approve` | 人类身份与审批来源；绑定目标工单及 revision | 错工单/高风险未批准拒绝写代码 |
| `hulane_resume` | 根据状态表恢复下一步，不重复副作用 | 断在 `pr_checking` 恢复后不重复 Push/PR |
| `hulane_flush` | 幂等标题预查、回填 issue_created、一次状态同步 | 网络中断重试仅 1 个 Issue |
| `hulane_merge_approve` | 必须是真实人类 Gate B、锁定 PR SHA | Checks 失败时即使请求批准也不能 Merge |
| `hulane_tag_approve` | Gate C、严格 Tag 版本、skip policy、实际镜像核验 | 未要求 release 的单不误建 tag；Tag 冲突拒绝 |
| `hulane_release` | 无工单批量 Tag、默认分支 SHA、GitHub + GHCR 证据 | 不新建 Work Item；目标 tag 重复时拒绝 |

每个 Markdown Command 均应：保留用户可见的命令名字；使用 `$ARGUMENTS` 输入；显式加载 `hulane-development` Skill；以目标业务仓库为执行位置；每次状态跃迁通过 MCP；遇到模型能力或权限缺失时停止而非假装成功。

### 7.1 一个命令样例

`.opencode/commands/hulane_status.md`：

```markdown
---
description: 查看 Hulane 工单状态并根据事实源恢复
agent: hulane-orchestrator
---

查询工作项：$ARGUMENTS。
如 issue_pending=true，则仅查本地状态；否则先通过
hulane-control 的 hulane_status(refresh_from_github=true)
刷新 GitHub 事实。输出当前状态、阻断原因、最近证据及下一步。
不要直接修改 .hulane/state.json，也不要声称未核验的 Done。
```

命令是编排提示词，**权限 enforcement 在工具/控制平面中**，不在上述文字里。

## 8. Agent 迁移任务与最小权限示例

### 8.1 Agent 的能力表

| Agent | Read/Glob/Grep | Shell | Edit | Subagent | 控制平面写工具 |
|---|---|---|---|---|---|
| Orchestrator | 允许 | 受限 | 拒绝直接改业务源码 | 允许调用列出的 7 个 | 可调用，但 MCP 再审查 |
| Planner | 允许 | 默认拒绝 | 拒绝 | 拒绝 | 拒绝 |
| Designer | 允许 | 受限 | 仅设计产物/批准路径 | 拒绝 | 拒绝 |
| Design Critic | 允许 | 默认拒绝 | 拒绝 | 拒绝 | 拒绝 |
| Coder | 允许 | 测试/构建命令按需受限 | 限当前 Worktree | 拒绝 | 拒绝 |
| Tester | 允许 | 测试命令受限 | 默认拒绝业务文件修改 | 拒绝 | 拒绝 |
| Reviewer | 允许 | 默认拒绝 | 拒绝 | 拒绝 | 拒绝 |
| Build Checker | 允许 | 只读状态/查询命令受限 | 拒绝 | 拒绝 | 拒绝 |

MCP 工具在 V2 可能经由 Code Mode `execute` 间接暴露，**必须按实际运行路径测试**。不要仅通过 Command Prompt 中写“不可调用”就认定隔离成立。

### 8.2 `hulane-reviewer` 只读 Agent 示例

```markdown
---
description: 只读审查代码和规格，不提交、不改文件
mode: subagent
steps: 30
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
---

只读审查已批准的 Work Item 和指定 worktree。
检查测试覆盖、变更风险、Spec 与实现是否一致。
报告 approved 或 changes_requested，并说明证据。
绝不能写文件、push、merge、tag、关闭 Issue 或启动子 Agent。
```

该示例展示 V2 frontmatter 方向；实际规则合并和 MCP/Code Mode 可见性必须由 `agent list` 与负向用例验证。若 `read` 本身能访问敏感文件，还需针对 `.env` / 私钥路径加全局 Policy 阻断。

## 9. 核心接口契约与新增受控操作（P1/P2）

### 9.1 保留的旧 MCP Tool

`hulane_preflight`、`hulane_initialize`、`hulane_open_work_item`、`hulane_transition`、`hulane_status`、`hulane_validate`、`hulane_sync`、`hulane_hydrate`、`hulane_flush`、`hulane_worktree_create`、`hulane_verify_pr_checks`、`hulane_authorize`、`hulane_verify_delivery`、`hulane_record_specs_synced`，并核对源 `tools.mjs` 中所有其他声明后建立完整清单。不要凭本文简略枚举直接删掉未知 Tool。

### 9.2 新增的强约束工具（提议）

| 工具 | 输入至少包含 | 必须由服务端检查 | 成功证据 |
|---|---|---|---|
| `hulane_push_branch` | work_item_id、expected_revision、head_sha | 对应 Worktree、分支、状态、远端、CI 流程 | remote ref SHA |
| `hulane_merge_pr` | id、pr_number、expected_revision、verified_head_sha | Gate B、Checks、Review、SHA 未变化、Ruleset | merged_sha、PR URL |
| `hulane_create_tag` | id、tag、merged_sha、Gate C approval ref | 严格 SemVer、Tag 不存在、SHA 在正确分支 | tag_object_sha |
| `hulane_push_tag` | tag、tag_object_sha、expected SHA | 对象是 annotated tag 且未远端存在 | remote tag ref |
| `hulane_close_issue` | id、issue_number、expected_revision | `waiting_close`、specs、delivery policy、Done 前置 | GitHub Issue closed |
| `hulane_release_batch` | version、base_branch_head_sha、approval | 无工单、Tag 不冲突、来源和版本确认 | tag/release run metadata |

这些是未来目标接口，并非旧版已有的公开 Tool。可以先用旧 Tool 验证主链，再切换到受控执行端；**P2 没完成前不得宣称“生产级防绕过”**。

### 9.3 服务端原子性与事件约束

- 每次状态写：`expected_revision` 校验 → 本地进程锁 → 目标 GitHub 最新状态读取/核实 → 校验 Gate → 执行单个副作用 → 记录事件 → 同步状态 → 最终真实事实回读。
- 如果 GitHub 已执行但本地同步失败：保留可观察的中间事件；重试先查 Issue/PR/Tag 的真实状态，识别相同对象后继续，不二次创建。
- 使用 `event_id` 和动作参数哈希实现幂等；对同一工单重复动作返回“already applied + evidence”，但如果内容不同则拒绝并人工协调。
- 安全失败要 fail closed；非安全性的 GitHub 暂时不可达可标 `retryable`，但不能默默推进。
- 在多客户端情况下，本地 Revision 并非分布式锁；推荐服务端短租约+远端回读验证；无可靠机制前**单个工单只能由一个控制客户端写入**。

## 10. 安全改造任务（P2，发布阻断项）

### 10.1 不可只移植原 Hook

原 `hooks/guard.mjs` 与 `hooks/discipline.mjs` 有大量可复用的**纯策略判断**，但 `hooks.json` 中的 ZCode `PreToolUse` 格式、`input.tool_input`、`hookSpecificOutput.permissionDecision` 无法直接当作 V2 API。应将纯函数搬到 `src/core/policy/`，V2 Adapter 调用它们；服务端执行关键写操作仍必须独立校验。

### 10.2 GitHub 凭据隔离

生产版中：

1. Orchestrator / Coder 的自由 Shell 进程**不持有**有权对受保护仓库推送、合并、打 Tag、关闭 Issue 的 GitHub Token。
2. 权限凭据由受控 MCP 服务/独立执行器保管；MCP 以真实执行上下文或能力令牌校验调用者，而不是相信参数 `actor=orchestrator`。
3. GitHub Rulesets 禁止无审批、无 required checks、无符合规则的 Merge；Actions 推送 GHCR 仅分配所需包权限。
4. 限制不可信 Issue/PR Markdown 的提示注入：只能作为需求数据，不可覆盖系统 Prompt 或解禁受保护 Tool。
5. 路径安全：校验真实 Git 仓库根、`realpath`、Worktree 是否匹配、符号链接跳转、`git -C`、多个 Git remote、`gh repo` 被动选择等。

### 10.3 必测的绕过手法

| 用例 | 期待结果 |
|---|---|
| `git push origin HEAD` 未授权 | 拒绝；远端分支不变 |
| `env -i git push ...`、`sh -c 'git push ...'` | 拒绝；不因文本包装绕过 |
| `node -e` / `python -c` 间接调用 Git | 不能使用有写权限凭据；远端无副作用 |
| `gh api` 直接调用 merge / issue close | 拒绝或因凭据不足失败；无 GitHub 状态变化 |
| `git -c core.hooksPath=... commit` 或 `--no-verify` | 纪律策略拒绝或 CI 强制查出违规 |
| Reviewer 调用写 MCP Tool | 拒绝；审计可见 |
| 子 Agent 派生子 Agent | 拒绝 |
| 在 Worktree 外编辑/符号链接逃逸 | 拒绝，磁盘不被修改 |
| High Risk `approve_requirement` 伪造 `actor=human:...` | 服务端拒绝伪造；必须有可信人类审批来源 |
| Merge 后修改 PR 目标 commit 或重推 head | 旧 head_sha 的 checks/merge 授权失效 |
| `specs_synced=true` 任意 patch | 拒绝；只能走独立核验 Tool |
| 缺 GHCR digest、Release metadata 或 Provenance | 拒绝 `image_verified` 和发版完成声明 |
| 用户关闭 OpenCode 插件、直接从外部终端推送 | GitHub 服务端 Ruleset 仍强制保护（若无 Ruleset，明确标为不满足强安全验收） |

如果上述任一受保护 GitHub 写操作能在无有效审批/无必需 Checks 的情况下完成，**P2 安全验收失败**。

## 11. 发布交付与 GitHub Actions（P2）

### 11.1 业务仓库工作流

- `pr-checks.yml` 触发 `pull_request`，必需的 `Hulane PR Checks / verify` 作为保护分支检查。
- `build-image.yml` 触发 `push: tags: ['v*']`，完成 Docker 镜像构建、GHCR push、SBOM/Provenance、Release 资产；具体 Action/工具版本必须锁定并由安全扫描验证。
- 对于无 Dockerfile 的业务仓库，`/hulane_check` 可以标记图片交付不适用，但不可把发布能力不适用误判断为无法开发。
- Merge 前校验从 GitHub 读到的是**确切 PR head**和 required check conclusion，不以某次模型输出的“测试通过”代替。

### 11.2 Tag 审批步骤

1. 人类在 `/hulane_tag_approve REQ-xx vX.Y.Z` 或 `/hulane_release vX.Y.Z` 明确版本。
2. 控制平面确认 merged_sha / 默认分支 HEAD、tag 尚不存在、审批确实来自可信主体。
3. 创建 annotated tag、获取 tag object SHA、推送该对象所对应的唯一 refspec。
4. 等待实际 Actions 结果；中断时可通过 `/hulane_resume` 继续，**不重复推送 Tag**。
5. Build Checker 独立读取 GitHub Release、Actions、GHCR digest、SBOM、Provenance；核验结果交给 `hulane_verify_delivery`。
6. 满足 Spec 闸门后 Close Issue；若是无工单批量发布，不写 Work Item 状态。

## 12. 测试矩阵及验收标准

### 12.1 单元、协议及集成

| 类别 | 测试集 | 必要条件 |
|---|---|---|
| Unit | `state-machine`, `authorization`, `specs`, `delivery` | 核心行为回归 + 新边界测试 |
| MCP 协议 | `initialize`, `server/discover`, `tools/list/call`, Bad JSON, Timeout | 真实 OpenCode V2 客户端连通且错误可读 |
| 安装器 | install / reinstall / upgrade / uninstall | 不覆盖用户文件、可恢复、清单准确 |
| Command | 10 个命令输入/无参数/有参数/错误态 | 被 OpenCode 正确发现且调用正确 MCP |
| Agent | 7 子 Agent、1 主 Agent | 权限不扩大、工具列表真实可测 |
| 状态兼容 | `cmdb-dev-state:v2`、`.cmdb-dev`、legacy Done | 可 Hydrate 不伪造证据 |
| Offline | pending → restart → flush x2 | 一个 Issue、唯一 revision 链 |
| GitHub | PR head change、Failed/Passed Checks、Merge Ruleset | 不满足时拒绝 Merge |
| 发布 | Tag/Release/GHCR/SBOM/Provenance | 摘要与不可变 digest 对齐 |
| 安全 | 10+ 类绕过/凭据/路径测试 | 受保护对象未发生越权改变 |
| 平台 | macOS arm64、Linux amd64 | 同一套安装包、MCP 路径和文件权限正确 |
| 多实例 | 两个客户端同时 `transition/flush` | 不静默覆盖，成功 1 次或冲突显式回报 |

### 12.2 端到端业务场景

**E2E-01 普通需求**：`/hulane_dev 添加列表筛选功能` → 小单/标准单分类 → GitHub Issue 或 pending → Gate A auto_intake → Worktree → Coder → Tester/Reviewer → PR → Checks → Merge → `policy_skip` →（需要时）Spec Sync → Issue Close，最终 `done`。逐步核实每个 evidence。

**E2E-02 高风险**：涉及 DB 不兼容迁移 / 授权变更，停在 Gate A；人工批准后开发；在 Gate B 再停一次；通过 Checks 后人工批准；未请求发版则按 policy skip 关闭；任何步骤都不得以文本方式绕过。

**E2E-03 指定镜像交付**：用户明确要求某工单发镜像，合并后停 Gate C；确认 SemVer；打 annotated tag；等待 Actions；5 项证据齐全；Spec 同步通过后才 Close。

**E2E-04 离线断点**：断网开单 → 本地保存 → 重启 → 在线 Flush → 人为在建 Issue 后断开 → 再次 Flush 复用既有 Issue → 本地缓存删除 → Hydrate 恢复。

**E2E-05 旧版兼容**：用旧 Hulane 3.10.0 产生的测试样本读取旧 Issue 评论和 `.hulane` 目录；不改数据源、不重命名在途 Worktree；不破坏现有状态协议。

**E2E-06 双客户端冲突**：两个 OpenCode 实例（可选 ZCode+OpenCode）同时更新一工单；一个成功，另一个 revision/lease conflict 或等待；不得两个 Agent 同时修改同一 Worktree。

### 12.3 Definition of Done（项目自身）

必须全部满足：

- [ ] 新仓库创建、独立 Version、MIT 许可及源 SHA 可审计。
- [ ] 旧 Core 测试保留并全部通过；核心额外安全测试通过。
- [ ] 安装/升级/卸载 `opencode.jsonc` 幂等，源 repo 不存在仍可运行。
- [ ] 真正运行中的 OpenCode V2 识别 10 Commands、7 Subagents、1 Orchestrator、Skill、MCP。
- [ ] MCP 状态/审批/Worktree、GitHub Issue/PR/CI/Delivery 的正反向 E2E 通过。
- [ ] Gate A/B/C、Spec Sync/Done 不变量不可通过 Agent 直改字段绕过。
- [ ] Shell 包装、Token 绕过、路径逃逸、并发冲突均完成负向测试。
- [ ] 发布包签名/完整性检查、SBOM/依赖扫描、macOS/Linux 集成通过。
- [ ] 发布前选定并记录目标 OpenCode V2 精确版本，锁 SDK 依赖；真实安装包验收通过。

## 13. 工作拆分：建议 GitHub Issues / Milestones

以下是可直接登记到新仓库 Project 的任务清单，不代表已创建：

| Issue | 任务 | 验收输出 | 依赖 |
|---|---|---|---|
| HOC-001 | Bootstrap / License / Upstream SHA | 可独立构建的仓库 | 无 |
| HOC-002 | Import Core + Golden Tests | 旧行为回归通过 | 001 |
| HOC-003 | MCP Protocol Compatibility | OpenCode V2 工具可调用 | 002 |
| HOC-004 | OpenCode V2 Plugin Skeleton | 插件 ID 出现在 list，Hooks 可注册 | 001 |
| HOC-005 | Installer / Config Merge | 幂等安装与卸载 | 003,004 |
| HOC-006 | Commands P0 (`check/init/status`) | P0 冒烟通过 | 003,005 |
| HOC-007 | 7 Agents + Orchestrator / Permissions | 受限 Agent 测试通过 | 004,005 |
| HOC-008 | Dev/Approve/Flush/Resume | 开单/审批/离线链路通过 | 006,007 |
| HOC-009 | Worktree/Specs/Test/Review/PR | 完整 PR E2E | 008 |
| HOC-010 | Revision / Cross-process Lock / Idempotency | 双实例不静默覆盖 | 002,008 |
| HOC-011 | Guard / Privileged MCP Executor | Shell 绕过安全测试通过 | 009,010 |
| HOC-012 | Gate B/C / Release / Delivery | 真实 Tag → GHCR 核验 | 011 |
| HOC-013 | Legacy State Compatibility | 3.10.0 在途工单恢复 | 010 |
| HOC-014 | CI / Release Packaging / Docs | 全平台发布验收完成 | 全部 |

### 13.1 推荐提交边界

一个 Issue 对应一个逻辑 PR；Core 行为迁移和 Adapter 变更分支提交，避免把纯代码格式化与业务语义改变混在一起。任何状态协议 Schema 变更必须配兼容测试与迁移说明；安全策略变更必须由 Reviewer 检查负向用例。

## 14. 可执行的开发路线（按周推进示例）

- **第一轮（P0）**：建新仓库、固定来源、导入 Core、搭 Node 测试、锁 OpenCode V2、MCP POC、模板安装器、3 个命令。达到“可连接可查询”才进入 P1。
- **第二轮（P1）**：迁移 7 Agent 和其他研发 Command，接入 Spec delta、Worktree、PR Checks，完成一个不发镜像的需求闭环。
- **第三轮（P2）**：移除对自由 Shell 特权操作的依赖，建立服务端授权/审计；Gate B/C、Tag、GHCR、SBOM 和批量发布；做红队绕过测试。
- **第四轮（P3）**：兼容在途工单、双实例并发、macOS/Linux、安装升级、失败恢复和文档；基于真实打包安装完成最终发布。

此处“轮次”是工作包，不承诺自然周就能完成。遇到 SDK 兼容、安全漏洞或 GitHub 分支保护不足，应先冻结发布、补测试，再讨论简化非安全功能。

## 15. 运行/运维手册模板

### 15.1 基础自检

```bash
# 在业务仓库根目录
pwd
git rev-parse --show-toplevel
git remote -v
gh auth status
opencode --version
opencode plugin list
opencode mcp list
```

OpenCode 内执行：

```text
/hulane_check
/hulane_status REQ-12
/hulane_dev 为 CI 清单增加排序和过滤
/hulane_resume REQ-12
/hulane_flush REQ-12
```

### 15.2 常见故障与处理

| 现象 | 原因优先排查 | 恢复方式 |
|---|---|---|
| `hulane-control` 未连接 | Node 路径、MCP `cwd`、stdlib 握手、`protocol` | `opencode mcp list`，进程日志，不改业务状态 |
| 命令找不到 | 模板未部署、文件目录/命名错误、插件未加载 | 运行安装器 doctor、检查 `.opencode/commands/` |
| `issue_pending` 一直为 true | GitHub 登录/网络/Flush 中断 | `/hulane_flush <ID>`，先查 Issue 是否已存在 |
| 远端 Revision 冲突 | 两客户端或缓存过期 | 禁止覆盖；`hulane_status(...refresh)`、恢复/人工处理 |
| Agent 无权写 Worktree | 当前目录不是批准的工作树、权限规则生效 | 检查 work_item 状态与 Worktree 真实路径 |
| Checks 已通过仍无法 Merge | head SHA 变化/必需检查不满足/Gate B | 重新核验当前 PR SHA，不复用旧证据 |
| 交付一直停 `building` | Actions 未结束或 GHCR/Release 缺证据 | 恢复查询真实 run，补证据，不重建 Tag |
| Spec Sync 阻断 Close | delta 主规格未合并或 SHA 不一致 | 补正确 Spec 的 PR/合并流程，再运行专用核验 |
| 旧 `.cmdb-dev` 在途工单异常 | 自动迁移破坏了 worktree 绝对路径 | 回退到原目录，人工修复，禁止自动 mv |

## 16. 需要人工最终确认的设计参数

1. 新仓库实际名称和可见性（建议 `hutong236/hulane-opencode`，私有默认）。
2. 当前实际使用的 OpenCode V2 版本（必须以 `opencode --version` 记录）。
3. 新包发布形式（优先先本地安装，稳定后 npm 包）。
4. GitHub 使用 `gh auth` 还是 GitHub App（企业/生产场景优先短期凭据/最小权限）。
5. 是否需要同一个在途工单跨 ZCode/OpenCode 双客户端可写；若需要，必须完成远端冲突和租约测试。

其他未列的细节按“**默认最小权限、保留源 Hulane 行为、不写旧仓库、遇冲突 fail closed**”执行。

## 17. 来源与验证标记

**源代码核查**：

- <https://github.com/hutong236/hutong-zcode-marketplace/tree/main/hulane>
- <https://github.com/hutong236/hutong-zcode-marketplace/blob/main/hulane/mcp/server.mjs>
- <https://github.com/hutong236/hutong-zcode-marketplace/blob/main/hulane/mcp/tools.mjs>
- <https://github.com/hutong236/hutong-zcode-marketplace/blob/main/hulane/scripts/lib/state-machine.mjs>
- <https://github.com/hutong236/hutong-zcode-marketplace/blob/main/hulane/scripts/lib/authorization.mjs>
- <https://github.com/hutong236/hutong-zcode-marketplace/blob/main/hulane/skills/hulane-development/SKILL.md>

**OpenCode 官方**（2026-11-10 查询）:

- V2 插件 API：<https://opencode.ai/docs/build/plugins/>
- V1/V2 差异：<https://opencode.ai/docs/migrate-v1>、<https://opencode.ai/docs/build/plugins/migrate-v1/>
- MCP：<https://opencode.ai/docs/mcp-servers>
- Agent/Command/Skill：<https://opencode.ai/docs/agents>、<https://opencode.ai/docs/commands>、<https://opencode.ai/docs/skills>
- 权限/策略：<https://opencode.ai/docs/permissions>、<https://opencode.ai/docs/policies>

**核查状态：** 旧仓库结构、核心语义和 OpenCode V2 文档已做静态资料核查；由于本轮尚未下载构建整个项目、尚未运行 OpenCode V2 真机 E2E，任何插件构建/工具执行/审批拦截效果都标为**待开发、待测试**，不应当作已完成成果。