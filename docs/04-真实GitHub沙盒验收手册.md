# Hulane OpenCode V2 — 真实 GitHub 沙盒验收操作手册

> **用途：** 该文档是验收操作计划，不是已经执行成功的报告。生产门禁的权威状态为 [Issue #3](https://github.com/hutong236/hulane-opencode/issues/3)。当前 `main` 合并开发基线 `db2815a2a694d5447d8ef61fc1148fa416446a09`， [CI 42936837021](https://github.com/hutong236/hulane-opencode/actions/runs/42936837021) 6/6 通过；**生产安全验收未完成，不允许由此推断可以正式发布**。

## 0. 已核验与阻塞（2026-11-17）

| 检查 | 结果 | 证据 / 影响 |
| --- | --- | --- |
| `main` 合并后 GitHub Actions | PASS（6/6） | [run 42936837021](https://github.com/hutong236/hulane-opencode/actions/runs/42936837021)，SHA `db2815a...` |
| 本仓库分支保护 | **FAIL** | GitHub `GET /branches/main`: `protected:false`，`required_status_checks.enforcement_level:off`，`contexts:[]` |
| 本仓库 Repository Rulesets | **FAIL** | GitHub `GET /rulesets` 返回空列表（仅代表本仓库该接口所见规则；需管理员另核对继承规则） |
| 分支保护配置权限 | **BLOCKED** | GitHub App `GET /branches/main/protection` HTTP 403，且当前连接不提供管理 Ruleset 的写接口 |
| 独立私有沙盒、真实 Gate A/B/C 与 GHCR 签名 | **NOT RUN** | 尚未提供可用的隔离仓库与授权；不得在生产仓库做故障注入 |

## 1. 管理员准备（必须在独立环境）

1. 新建一个**私有、可丢弃**的 GitHub 测试仓库（以下称 `OWNER/hulane-v2-sandbox`，这是占位符，不是已创建的仓库），配置 `main` 为默认分支。不要共享生产 secrets、部署凭据或 GHCR 包权限。
2. 用独立测试身份和最小权限 token 登录 `gh`，检查 `gh auth status`；有可能发起 Issue、PR、创建标签和测试镜像的授权，但不要授予生产代码或包访问权。
3. 将本项目的 `hulane/templates/github-actions/pr-checks.yml` 复制到沙盒 `.github/workflows/pr-checks.yml`；将 `hulane/templates/github-actions/hulane-pr-checks.sh` 复制到 `.github/scripts/hulane-pr-checks.sh`。加入可运行的最小 npm 或其他测试入口和安全的测试 Dockerfile（只使用公开基础镜像，无 secrets）。
4. 管理员在 **Settings → Rules → Rulesets** 为沙盒 `main` 建立 Active branch ruleset：要求 Pull Request、阻止 force push / 删除、要求 PR checks 必须通过并为最新提交。确认 **Hulane PR Checks** 工作流的实际 Job `verify` 在 GitHub UI 中显示的必需检查名称和 App 身份；UI 常见显示为 `Hulane PR Checks / verify`，保存前以真实检查上下文为准，不要假设字符串。
5. **另外为本项目本身的 `main` 配置保护。** 本项目使用 `Hulane OpenCode CI`，6 个实际 Job 为：`core-tests (20)`、`core-tests (22)`、`opencode-v2-adapter`、`opencode-cli-integration`、`platform-install-smoke (macos-15)`、`platform-install-smoke (ubuntu-24.04-arm)`。管理员应选择实际产生的检查，并核对 App 来源；不能拿沙盒 `Hulane PR Checks / verify` 误当作本项目已有检查。

管理员配置后记录：规则 URL/ID、Active 状态、目标分支、Required Checks、允许的 bypass 人员/App 与各自权限；有 bypass 时须明确证明业务角色无法绕过。以一个 Pending/Failed Check 的 PR 尝试 Merge，并确认**GitHub 服务器真实拒绝**；在旧 SHA 完成后推新 commit，确认新 SHA 的 Pending Checks 仍阻止 Merge。

## 2. 安装及真实 OpenCode V2 启动

以下命令只能在已准备的独立测试机器/Runner及私有沙盒执行，替换占位符：

```bash
git clone https://github.com/hutong236/hulane-opencode.git
cd hulane-opencode
git checkout main
npm ci
npm test
opencode --version             # 预期 opencode v2.2.7（需单独安装/固定 CLI）
gh auth status

git clone git@github.com:OWNER/hulane-v2-sandbox.git ../hulane-v2-sandbox
node bin/install.mjs --project ../hulane-v2-sandbox --dry-run
node bin/install.mjs --project ../hulane-v2-sandbox
cd ../hulane-v2-sandbox
opencode debug agents          # 核验 8 Agent
opencode mcp list              # 核验 hulane-control connected
```

在 Worktree 里使用 Coder Agent；不要用主仓库根目录的 OpenCode 会话代替 Worktree。记录本次 `git rev-parse HEAD`、Node/CLI/OS 版本、安装前后配置差异和原始日志。测试任何授权/失败时，避免把密钥、个人 token 或敏感仓库路径写入 Issue。

## 3. Gate A/B 与真实研发流

用独立 REQ 和 BUG 各执行一次，记录 GitHub Issue、真实 `hulane-control` MCP 工具调用和对应 Work Item 状态 revision：

1. 创建 REQ/BUG → GitHub Issue 持久化 → Gate A。低风险自动审批只在符合 `auto_intake` 条件时通过；其他人工审批必须由有 write/maintain/admin 权限的测试用户在**当前 Issue**发表与当前 revision 完全匹配的 `HULANE_APPROVAL approve_requirement ...` 评论。
2. 创建匹配 branch 与 Worktree → Planner → Coder → Tester → Reviewer；在 Worktree 写入无害变更并运行项目测试。
3. 推分支创建 PR → 验证最新 Head SHA、默认目标分支与全部 GitHub required checks；人为提交失败测试，确认 Gate B 和 GitHub 服务器都拒绝合并。
4. 当前 revision 的 Gate B 评论必须匹配 `HULANE_APPROVAL approve_merge REQ-N revision=R head=40位SHA`，并验证作者写权限，重复/过期/伪造评论不能生效；使用绑定 Head SHA 的受保护 Merge，记录 Merge SHA。
5. 执行 OpenSpec 记录、Issue 关闭与 `Done` 状态；对 BUG/低中高风险重复必要路径，并核对每个状态变更都有不可抵赖证据。

**刻意拒绝场景：** 任意 `actor=human:...` 而无评论、只读用户评论、修改旧 revision/PR Head 后沿用旧评论、待运行/失败/同名冲突的 Checks、PR Base 改为非默认分支、重放已消费授权 token、跨 Worktree 操作。

## 4. Gate C / GHCR / Sigstore （仅测试镜像与测试 tag）

- 复制模板 `hulane/templates/github-actions/build-image.yml` 至沙盒 `.github/workflows/build-image.yml`。不要把本项目的开发验证版本号用作正式软件版本，不要复用生产镜像包名。
- 只有达到合法 `building` 状态、测试人员在 Issue 按正确 revision/tag 完成 Gate C 后，才执行受保护的 **annotated tag** 创建和 push。明确测试轻量标签、错误 SHA、不是默认分支祖先等拒绝分支。
- 检查 GitHub Actions run 是该 tag 触发且成功，Release 必须附 `delivery-metadata.json`；核对 GitHub Tag 对象 SHA/commit 与记录 Merge SHA，GHCR tag 的实际 digest 与交付元数据一致。
- 在独立环境对**不可变 Digest**执行签名验证（将变量替换成沙盒数据）：

```bash
gh attestation verify \
  oci://ghcr.io/OWNER/hulane-v2-sandbox@sha256:DIGEST \
  --repo OWNER/hulane-v2-sandbox \
  --signer-repo OWNER/hulane-v2-sandbox \
  --signer-workflow OWNER/hulane-v2-sandbox/.github/workflows/build-image.yml \
  --source-digest MERGE_SHA \
  --predicate-type https://slsa.dev/provenance/v1

gh attestation verify \
  oci://ghcr.io/OWNER/hulane-v2-sandbox@sha256:DIGEST \
  --repo OWNER/hulane-v2-sandbox \
  --signer-repo OWNER/hulane-v2-sandbox \
  --signer-workflow OWNER/hulane-v2-sandbox/.github/workflows/build-image.yml \
  --source-digest MERGE_SHA \
  --predicate-type https://spdx.dev/Document/v2.3
```

- 拒绝只有 `sbom: generated` / `provenance: generated` 文本但没有有效签名的交付；尝试改动 digest、tag、Release Asset、signer workflow、源 SHA，均不得把 Work Item 标记 `image_verified`。保存成功的验证结果及每项伪造的失败证据。

## 5. 不可省略的安全/异常测试

| 类别 | 必须做的真实测试 | 通过条件 |
| --- | --- | --- |
| Shell 越界 | Coder Worktree 中尝试绝对路径写、重定向、封装子进程、符号链接跳转，及不受信任 shell 命令 | OS/容器权限或受限执行器真正拦截非授权写；**仅有 OpenCode Hook 弹窗不合格** |
| 多会话 | 两个独立 OpenCode V2 实例并发操作同一个 Work Item、互相重试 | Revision 不回退；无重复 Issue/PR/Tag；冲突 fail-closed |
| 崩溃恢复 | GitHub 已完成副作用但进程在本地持久化前退出；重新启动与 reconcile | 远端事实优先、幂等接管、完整审计，错误合并/关闭不发生 |
| 安装升级/回滚 | 在代表性的 macOS ARM 和 Linux 机器上新装、二次安装、升级和回退 | 未覆盖用户原有配置，备份可恢复，Agent/MCP/权限一致 |
| 供应链/许可 | 复查原版来源、License、依赖安全和 OpenCode V2 2.2.7 兼容性 | 来源和限制有文档，不把 beta 兼容声明成正式长期稳定支持 |

## 6. 证据归档和放行决策

为每个场景保存：测试环境与仓库 URL（脱敏）、UTC 执行时间、Work Item ID、Issue/PR/Checks/Actions/Release URL、Head/Merge/Tag SHA、镜像 Digest、预期结果、实际结果、命令退出状态、至少一个失败/越权负向用例及其服务器端拒绝证据。按场景把链接汇总到 [Issue #3](https://github.com/hutong236/hulane-opencode/issues/3)，并且**只有实际运行且验证过的项目才勾选**。

**放行条件：** 所有必须的服务端 Ruleset、Agent Shell 边界、Gate A/B/C、状态一致性、供应链签名和环境恢复通过，且管理者明确授权发布。未提供私有 sandbox 或仓库规则管理权限时，结果必须为 **BLOCKED**，不得以绿灯 CI、单元测试或文档宣称生产验收通过。
