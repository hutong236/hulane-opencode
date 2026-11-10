# REQ-9 Proposal：执行纪律守卫(移植 ECC 纪律钩子)

## What

为 hulane 插件新增「执行纪律守卫」,在编码行为发生那一刻(Bash/Edit/Write
PreToolUse)强制三类纪律检查,核心检测面移植自 affaan-m/ECC(MIT),轻量重写:

- **① git 钩子绕过拦截**(源自 ECC block-no-verify.js):受保护子命令
  (commit/push/merge/cherry-pick/rebase/am)的 --no-verify 及无歧义前缀、
  commit 的 -n 短旗标(短选项簇分析)、`-c`/`--config-env` 的 hook-redirect
  配置覆盖(core.hooksPath/include.path/includeIf.*.path)、`git config` 持久
  写入、同命令行 GIT_CONFIG_* 环境注入。
- **② lint/formatter 配置保护**(源自 ECC config-protection.js):ESLint/
  Prettier/Biome/Ruff/Stylelint/markdownlint 全家族精确 basename 清单 + 两条
  `<tool>.config.<qualifier>.<ext>` / `.<tool>rc.<qualifier>.<ext>` 通配;
  已存在文件禁改(应修代码而非弱化检查配置),首创放行,lstat 非 ENOENT
  错误 fail-closed;构建/测试配置不在保护面。
- **③ 提交内容卫生检查**(源自 ECC pre-bash-commit-quality.js):`git commit`
  时读暂存区(非工作区),检测密钥形状(占位符豁免)、debugger、console.log,
  命中即 deny;--amend 不触发;文件数与扫描总量有界。

## Why

- hulane 既有守卫(push/tag/merge/close 的令牌与状态门禁)管的是「交付动作」,
  在「编码行为那一刻」没有强制:agent 可以 `--no-verify` 绕过钩子、改弱 lint
  配置让检查通过、把密钥和调试语句提交进历史。
- ECC(affaan-m/ECC,MIT)的三个运行时纪律钩子正是针对这一缺口的成熟检测面
  (来源评估:hutong-project-pm 仓 2026-10-19 ECC 对比评估);本工单把其核心
  检测面移植进 hulane 插件,轻量重写(不搬其完整 shell 语义解析器)。
- 全局生效(不依赖 hulane 管理状态):纪律是行为约束,与仓库是否被 hulane
  管理无关;`HULANE_DISCIPLINE_DISABLE` 逃生口只认 hook 进程环境,命令内联
  同名赋值不可自禁。

## 改动面

- `hulane/scripts/lib/discipline.mjs`(新建):纯检测库,文件头保留 ECC
  版权与 MIT 声明;导出 analyzeGitBypass / isProtectedConfigName /
  scanStagedContent / evaluateDisciplineBash / evaluateDisciplineEdit /
  disabledChecks。
- `hulane/hooks/guard.mjs`:export 既有 shellSegments/stripMessageBodies 供
  discipline 复用;main() 中纪律检查前置(纪律 deny 优先于白名单与令牌),
  既有 evaluateCommand 流程不改。
- `hulane/hooks/discipline.mjs`(新建):Edit/Write 薄入口;
  `hulane/hooks/hooks.json` PreToolUse 追加 Edit|Write matcher 条目。
- `test/discipline.test.mjs`(新建):覆盖验收 1-14 及 15/17 协议断言。
- 规格层:归档 `openspec/changes/archive/REQ-9/`,主规格新建
  `openspec/specs/hulane-execution-discipline/spec.md`(delta 的 ADDED
  Requirements 转正式规格);`test/specs.test.mjs` dogfood 快照同步扩条目。
- 文档:`hulane/README.md`「执行纪律守卫」小节、根 `CHANGELOG.md` Unreleased
  条目;`hulane/skills/hulane-development/SKILL.md` 不改(守卫行为对流程透明)。

## 交付策略

`delivery_required: false` / `skip_allowed: true`(无显式发版指令,插件变更
随批量按需发版节奏统一搭载 /hulane_release)。需求与审批包见
GitHub Issue #9(https://github.com/hutong236/hutong-zcode-marketplace/issues/9)。
