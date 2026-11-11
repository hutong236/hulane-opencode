# Hulane OpenCode V2 集成验收记录（开发验证版）

> 当前版本：0.1.0（开发验证），2026-11-10。分支：`feat/opencode-v2-initial-implementation`；[Draft PR #1](https://github.com/hutong236/hulane-opencode/pull/1)。不代表生产验收。

## 1. 验证过的事实

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Node.js 20/22 回归 | 基线 156/156 通过；后续已扩展回归集并持续运行 | [Actions 42848077086](https://github.com/hutong236/hulane-opencode/actions/runs/42848077086) |
| OpenCode SDK | `@opencode/plugin` 2.2.7，`Plugin.define`/Shell/Tool/Permission Hook 加载和 Smoke 通过 | 同上 |
| 实际 OpenCode CLI | v2.2.7，`hulane` 本地插件已加载 | 同上 |
| Agent 发现 | 7 个子 Agent + `hulane-orchestrator` 8 个均可见 | CI `debug agents` 硬性断言 |
| MCP | `hulane-control connected`，原有 15 + 新增 5 个受控操作 | CI `mcp list` 和 MCP 单元测试 |
| Worktree 权限 | Coder 需处于匹配的已批准 Worktree、正确 branch、合法状态；根目录/越界编辑/符号链接跳出拒绝 | `test/opencode-worktree-guard.test.mjs` |

真实 OpenCode 冷启动时插件异步激活，`mcp list` 或 `plugin list` 太早调用可能返回空列表。使用 `opencode debug agents` 等待插件激活后再检查；CI 使用持久的受认证 OpenCode 服务进行相同验证。

## 2. 本地开发与安装核验

以下示例中 `/path/to/business-repo` 应是已有 Git 仓库；请首先选用无生产凭据的沙盒业务仓库。

```bash
git clone https://github.com/hutong236/hulane-opencode.git
cd hulane-opencode
git checkout feat/opencode-v2-initial-implementation
npm ci
npm test
node bin/install.mjs --project /path/to/business-repo --dry-run
node bin/install.mjs --project /path/to/business-repo

cd /path/to/business-repo
opencode debug agents
opencode mcp list
```

安装器会在项目写入 `opencode.json`，复制 `.opencode/commands`、`agents`、`skills`，通过绝对源码路径引用本地插件及 Node MCP 服务。**不要删除已克隆的独立插件目录**；否则项目的插件和 MCP 引用将失效。安装器拒绝有冲突的现有文件，`--force` 只可在检查备份后使用。

## 3. 目前安全边界

- MCP `codemode:false`，项目级 `hulane-control_*` 默认为 deny；仅 `hulane-orchestrator` 通过 Agent 配置覆盖成 ask；其他 Hulane 子 Agent 保持默认 deny。
- Designer 的写权限限制为 `.hulane/designs/**`；Coder 的 `edit` / `shell` 权限在 Hook 中验证 *当前 OpenCode Location* 是否位于已批准且记录一致的 Worktree 与分支。**Coder 必须从该 Worktree 启动对应 OpenCode 会话**；在仓库根目录执行会被安全拒绝。
- `hulane_secure_push`、`hulane_secure_tag_create`、`hulane_secure_tag_push`、`hulane_secure_merge`、`hulane_secure_close` 均在 MCP 控制层重新检查状态并使用固定参数命令。不得让模型将同等操作改成裸 Shell。
- GitHub Issue 机器评论、PR/Checks/Release 实际事实优先于本地 `.hulane/state.json`。本地文件仍需完善跨进程一致性控制。

## 4. 尚未完成的发布门槛

1. 在真实 **GitHub 沙盒** 仓库执行完整 REQ/BUG → Gate A → Worktree → Coder/Tester/Reviewer → PR → required checks → Gate B → Merge → OpenSpec → Issue Close；覆盖低中高风险与失败回滚。
2. Gate C、按需批量 Release、GitHub Actions、GHCR Digest、SBOM、Provenance 证据交叉核验。
3. 子进程、包装器、重定向及用户直接从外部终端执行 Git 操作等绕行测试。GitHub 必需检查/Ruleset 必须独立配置；插件自身无法代替 GitHub 服务端权限。
4. 在 Worktree 内的任意 Shell 命令仍可对其他绝对路径产生副作用，当前 Hook 不能证明沙盒级隔离；生产场景需 OS/容器权限或受限执行器。
5. 高并发 Work Item / 多 OpenCode 进程同仓库写入冲突及锁崩溃恢复、重入幂等、GitHub 状态竞争验收。
6. ✅ 已提交 `package-lock.json`，CI 改为 `npm ci`，固定 CLI v2.2.7，macOS M1 ARM64 / Linux ARM64 原生安装 Smoke 已通过；仍需要真实企业项目的安装升级/回滚验收。

**结论：**已得到可安装、可通过真实 OpenCode v2.2.7 CLI 发现的开发验证版。此阶段保持 Draft PR，不直接发布生产版本或执行真实业务仓库的受保护操作。


## 5. 2026-11-11 增量开发与真实生产验收边界

- **依赖与平台**：CLI/plugin 固定 v2.2.7；npm v3 锁文件；CI `npm ci`；Apple Silicon macOS 与 Linux ARM64 原生安装 Smoke 通过。
- **并发一致性**：状态写锁、修订号 CAS、Work Item 编号锁内原子分配、崩溃遗留锁的人工验证恢复。4 个独立 Node 进程同时创建 32 个工单的 CI 负向竞争回归已通过。
- **控制权限**：安装器末尾强制全局 `hulane-control_*` deny；低中风险 auto_intake 之外的人工 Gate A/B/C 需要 GitHub Issue 真实作者评论与仓库写权限，不信任字符串 `human:xxx`；Gate B 要求所有必需检查通过且 PR 指向真实默认分支。
- **Release 供应链**：工作流拒绝轻量 tag，校验远端 annotated tag 对象，针对 GHCR 镜像 digest 生成有签名的 SLSA/Spdx Artifact Attestations；`hulane_verify_delivery` 会独立查询 Actions、Release、Git Tag、GHCR digest 和 Sigstore 签名证明。新增模拟远端正/负测试及真实 MCP stdio 离线流程测试；截至本段更新，较新的提交仍有 GitHub Actions 排队，不能把它们描述为已验收。
- **尚未解决/需仓库管理员协作**：GitHub Rulesets / Required Checks 真正服务端强制、独立沙盒内的真实 PR → Merge → Release → GHCR 全链路验收、OpenCode Agent Shell 级 OS 沙盒隔离、企业机器安装升级回滚。当前 GitHub 集成读取 `main` 分支保护返回 403，不能由本会话认证为生产安全。

完整且可逐项勾选的生产验收清单：[#3 Production acceptance](https://github.com/hutong236/hulane-opencode/issues/3)。逐提交交接记录：[SESSION_HANDOFF](./SESSION_HANDOFF.md)。
