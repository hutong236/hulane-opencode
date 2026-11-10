# Hulane OpenCode

独立维护的 Hulane → OpenCode V2 移植项目（当前 **0.1.0 开发验证版**）。

## 当前状态
- ✅ 上游 Hulane 3.10.0 的状态机、GitHub Issue/PR 同步、离线工单、Worktree、OpenSpec、MCP、交付核验源码作为独立快照纳入本仓库。
- ✅ 迁入上游 Node.js 回归测试；Node.js 20/22 均通过 156/156 项测试；真实 OpenCode CLI v2.2.7 已验证 8 Agent 发现和 MCP 连通（详见验收记录）。
- 🧪 新 OpenCode V2 的 Commands、Agents、Skill、MCP 配置与插件安装器见 `opencode/` 和 `bin/install.mjs`，**已完成真实 CLI 的插件与 MCP 发现验证，尚未完成端到端研发流程及负向安全验收**。
- ⚠️ 原 ZCode Hooks 保留作兼容/参考和回归测试，不会安装为 OpenCode Hooks；不能据此宣称强制权限门禁已验证。
- ⚠️ OpenCode V2 SDK 尚在变化，已固定 `@opencode/plugin` 为 2.2.7，但仍需提交 lockfile 并完成完整版本验收；生产使用前须锁定并验证具体版本。

## 安装（开发环境）
1. 使用 Node.js >=20，安装 OpenCode V2、Git、GitHub CLI 并完成 `gh auth login`。
2. 克隆 **本仓库**并在仓库目录执行 `npm install`。运行 `npm test`。
3. 在目标业务仓库中执行：
   `node /path/to/hulane-opencode/bin/install.mjs --project /path/to/business-repo --dry-run`，确认变更后去掉 `--dry-run`。
4. 进入业务仓库执行 `opencode mcp list`，验证 `hulane-control`，执行 `/hulane_check`。
5. 使用 GitHub 沙盒仓库执行完整 Gate A/B/C、Checks、Tag/GHCR 负向测试后才允许生产使用。

安装器只生成/更新目标业务仓库的 `.opencode` 配置及 `opencode.json`。存在非 JSON 的 JSONC 配置时将拒绝自动合并，防止覆盖用户配置；已有文件默认不会强行覆盖。

## 源码
- `hulane/`：保留上游相对路径和原有业务控制层，后续渐进解耦。
- `opencode/`：OpenCode V2 原生适配与模板。
- `bin/install.mjs`：目标仓库安全安装器。
- `test/`：上游行为回归测试及新增适配测试。
- `docs/`：总体设计及开发实施手册。

## 文档
- [总体技术设计](docs/01-Hulane-OpenCode-总体设计.md)
- [开发实施手册](docs/02-Hulane-OpenCode-开发实施手册.md)
- [当前集成验收与未完成项](docs/03-OpenCode-集成验收与缺口.md)

源自 [hutong236/hutong-zcode-marketplace](https://github.com/hutong236/hutong-zcode-marketplace/tree/main/hulane)，版本与 SHA 记录见 [UPSTREAM_SOURCE.md](UPSTREAM_SOURCE.md)。MIT License。
