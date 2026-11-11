# REQ-9 Decisions：关键取舍记录

工单:REQ-9(hulane 执行纪律守卫:移植 ECC 纪律钩子——git 钩子绕过拦截、
lint 配置保护、提交内容卫生)。批准人:Gate A auto_intake(用户原话
「深度思考学习ECC的架构和设计,提升和优化当前hulane插件能力.」,2026-10-19,
Issue #9 审批包评论 issuecomment-6262830127)。以下为批准时已裁决事项
(Planner 设计取舍备案,非阻塞),实现按此执行,不再自行取舍。

## ① console.log 全 deny(严于 ECC 的 warning+放行)

- ECC 对 console.log 记 warning 后放行;hulane 侧 ZCode PreToolUse 协议
  没有干净的 warning 通道(permissionDecision 只有 allow/deny)。
- 裁决:console.log 与密钥/debugger 同权全 deny;误伤场景由
  `HULANE_DISCIPLINE_DISABLE=commit-quality` 逃生口兜底。

## ② --amend 豁免(对齐 ECC)

- `git commit --amend` 时提交内容卫生检查不生效,与 ECC 行为对齐:
  amend 通常是补改上一笔,拦它会阻断常规修复流。
- 已知残余缺口:amend 可夹带新暂存内容绕过扫描,文档化接受,v2 复评。

## ③ Bash 重定向改写保护配置留 v2

- `echo x > .eslintrc.js` 等 Bash 侧重定向改写 lint 配置的形态,v1 不做:
  与 ECC 覆盖面对齐(ECC 的 config-protection 只挂 Edit/Write),可靠识别
  重定向目标需要 Bash 参数语义解析,超出 v1 轻量版边界。
- 已知残余缺口:文档化接受,留待 v2 与「重定向写 git 配置」一并复评。

## ④ 轻量版绕过缺口文档化接受

- 不移植 ECC 的 406 行 shell 语义解析器(shell-scan):heredoc、管道生成
  命令、sed 动态生成、`env -S` 传播等复合形态不在 v1 检测覆盖面;检测在
  guard.mjs 既有 shell 分段(换行/&&/||/;)粒度进行,消息体剥离复用同一套
  工具。
- 取舍依据:ECC 解析器的复杂度(预算控制、sed 执行模型、env 传播状态机)
  与 hulane 场景的风险收益不匹配;缺口在 hulane/README.md「执行纪律守卫」
  中向用户文档化,v2 按实际绕过案例增量收紧。
