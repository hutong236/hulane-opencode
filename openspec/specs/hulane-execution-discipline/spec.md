# hulane-execution-discipline Specification

## Purpose

承载 hulane 插件执行纪律守卫的行为基线：在编码行为发生那一刻（Bash 与 Edit/Write 的 PreToolUse）强制三类纪律检查——git 钩子绕过拦截、lint/formatter 配置保护、提交内容卫生——补足既有交付守卫（push/tag/merge/close 令牌门禁）在「编码行为那一刻」无强制的短板。核心检测面移植自 affaan-m/ECC（MIT），轻量重写：不携带 ECC 的完整 shell 语义解析器，检测在 shell 分段粒度进行；检查全局生效（不依赖 hulane 管理状态），`HULANE_DISCIPLINE_DISABLE` 提供仅认 hook 进程环境的逃生口，主流程异常 fail-closed deny。

## Requirements

### Requirement: git 钩子绕过拦截

hulane SHALL 在 Bash PreToolUse 上拦截受保护 git 子命令(commit/push/merge/cherry-pick/rebase/am)的钩子绕过:--no-verify 及 git 接受的 `--no-v` 起无歧义前缀、commit 的 -n 短旗标(短选项簇分析:m/F/C/c/t 值吞型停扫、u/S 可选值型停扫,故 `-an` 拦、`-mn` 不拦)、`-c <hook-redirect-key>=`(含 `-c` 粘连形式与 --config-env)、hook-redirect 键(core.hooksPath/include.path/includeIf.*.path,大小写不敏感)、`git config <hook-redirect-key> <value>` 持久设置(含 --global/--local)、同命令行 GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n/GIT_CONFIG_PARAMETERS 注入(含 env 前缀形式)。命中即 permissionDecision=deny,fail-closed。检测 SHALL 在 shell 分段(换行/&&/||/;)粒度进行,复用 guard 既有分段与消息体剥离工具;完整 shell 语义解析(heredoc/管道/sed 生成命令/env -S 传播)明确不在覆盖面。

#### Scenario: 受保护子命令带 --no-verify 被拦
- WHEN `git commit --no-verify -m "x"` 或 `git merge --no-verify`
- THEN deny,reason 指明 git 钩子不可绕过

#### Scenario: --no-v 起无歧义前缀被拦
- WHEN `git push --no-veri`
- THEN deny

#### Scenario: commit 短旗标簇分析
- WHEN `git commit -an`
- THEN deny
- WHEN `git commit -mn "fix"`
- THEN allow(n 为 -m 的值)
- WHEN `git log -n 5`
- THEN allow

#### Scenario: hooksPath 配置覆盖被拦
- WHEN `git -c core.hooksPath=/dev/null commit` 或 `git config core.hooksPath /dev/null` 或 `git config --global include.path /x`
- THEN deny

#### Scenario: GIT_CONFIG_* 环境注入被拦
- WHEN `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git commit` 或 env 前缀形或含 `GIT_CONFIG_PARAMETERS='core.hooksPath=...'`
- THEN deny

#### Scenario: 无绕过的普通 git 命令放行
- WHEN `git commit -m "feat: ok"` 或 `git push origin main`
- THEN 纪律层不因本检查 deny

### Requirement: lint/formatter 配置保护

hulane SHALL 在 PreToolUse(Edit|Write)上对 basename 命中保护清单(ESLint/Prettier/Biome/Ruff/Stylelint/markdownlint 全家族 56 个 basename + `<tool>.config.<qualifier>.<ext>` 与 `.<tool>rc.<qualifier>.<ext>` 两条通配,含 commitlint/oxlint;大小写不敏感)且磁盘已存在的目标文件 deny;文件不存在(仅 lstat ENOENT)的首创放行;lstat 非 ENOENT 错误视为存在(fail-closed)。构建/测试配置(pyproject.toml/tsconfig/jest.config/vite.config 等)SHALL 不在保护面。

#### Scenario: 修改已存在 lint 配置被拦
- WHEN Edit 目标为磁盘已存在 .eslintrc.js(含大小写变体)
- THEN deny

#### Scenario: 首次创建放行
- WHEN Write 目标 eslint.config.mjs 不存在
- THEN allow

#### Scenario: 通配变体被拦
- WHEN Edit 目标 eslint.config.base.mjs
- THEN deny

#### Scenario: 构建测试配置不拦
- WHEN vite.config.ts / jest.config.js / tsconfig.json
- THEN allow

#### Scenario: lstat fail-closed
- WHEN 受保护 basename 且 lstat 抛 EACCES/EPERM/ELOOP
- THEN deny

### Requirement: 提交内容卫生检查

hulane SHALL 在 Bash PreToolUse 遇 `git commit`(含 --amend 时本检查不生效)时读取暂存区(`git diff --cached --name-only --diff-filter=ACMR`、`git show :<path>`,仅 .js/.jsx/.ts/.tsx/.py/.go/.rs,文件数与扫描总量有界),检测密钥形状(sk-ant-/sk-/ghp_/AKIA 前缀 + api[_-]?key 赋值两形态,占位符豁免:process.env.N 整值、${...}、<...> 整值及显式占位词白名单)、debugger 语句、console.log。命中任一 SHALL deny;暂存区为空或无可检文件 SHALL 放行。commit message 校验与 linter 调用明确不在本检查内。

#### Scenario: 暂存密钥被拦
- WHEN 暂存 .ts 含 `sk-ant-xxxx...`(20+ 位)或 AKIA 形状或 `api_key = "real9secret"`
- THEN deny,reason 指明文件与行号

#### Scenario: 占位符豁免
- WHEN `apiKey: "REPLACE_ME"` 或 `api_key: process.env.API_KEY`
- THEN allow

#### Scenario: debugger 与 console.log 被拦
- WHEN 暂存 .py 含 debugger 或 .ts 含非注释 console.log
- THEN deny

#### Scenario: --amend 豁免
- WHEN `git commit --amend --no-edit`
- THEN 本检查不生效

#### Scenario: 非 checkable 扩展与空暂存放行
- WHEN 暂存仅 .md 或空
- THEN allow

### Requirement: 全局生效、逃生口与 fail-closed

纪律检查 SHALL 全局生效:不依赖 findControlRoot/storePath 的 hulane 管理状态。环境变量 HULANE_DISCIPLINE_DISABLE(逗号分隔子集:git-bypass,config-protection,commit-quality)SHALL 仅从 hook 进程环境读取、SHALL NOT 从被检命令文本读取。discipline 主流程异常 SHALL fail-closed deny。

#### Scenario: 非 hulane 管理仓同样生效
- WHEN 任意非管理目录 `git commit --no-verify`
- THEN deny

#### Scenario: 进程环境逃生口
- WHEN 会话环境 HULANE_DISCIPLINE_DISABLE=commit-quality 且暂存含 console.log
- THEN allow

#### Scenario: 命令内联不可自禁
- WHEN `HULANE_DISCIPLINE_DISABLE=git-bypass git commit --no-verify`(进程环境未设)
- THEN deny

#### Scenario: 主流程 fail-closed
- WHEN discipline 主流程抛未捕获异常
- THEN deny,reason 含 fail-closed 标识

### Requirement: 接线方式与既有守卫不变

Bash 侧纪律检查 SHALL 在 guard.mjs 单 hook 进程内、先于既有特权操作守卫执行:纪律 deny 优先于一切放行(含白名单远端与令牌授权);纪律放行不改变守卫裁决。Edit/Write 侧 SHALL 经 hooks.json PreToolUse 新 matcher 条目(Edit|Write)挂 discipline 薄入口。输出遵循 ZCode PreToolUse 协议(hookSpecificOutput.permissionDecision)。既有 push/tag/merge/close 令牌与状态守卫行为 SHALL 保持不变。

#### Scenario: 纪律 deny 优先于授权放行
- WHEN 带 release 令牌的 tag 推送命令同时含 --no-verify
- THEN 纪律 deny

#### Scenario: 既有守卫回归不变
- WHEN 无纪律命中的受控 push(无令牌/白名单远端)
- THEN 裁决与变更前一致

#### Scenario: hooks.json 双 matcher 声明
- WHEN 读取 hooks.json
- THEN PreToolUse 含 Bash→guard.mjs 与 Edit|Write→discipline.mjs 两条件
