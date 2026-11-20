# REQ-5 Decisions：Gate A 裁决记录

工单：REQ-5（hulane V3.7.0 Gate A 单单预授权 + 轻量批量发版）。
批准人：human:hutong236；批准日期：2026-10-06。
以下为 Gate A 批准时已裁决事项，实现按此执行，不再自行取舍。

## ① capability 命名：单一 capability 承载两条行为

- 新能力定名 `hulane-release-workflow`，同时承载「人工放行直达（Gate A 预授权）」
  与「按需批量发版（/hulane_release）」两组行为基线。
- 不拆分为两个 capability：两者同属「人工放行的强度与直达路径」这一个行为域，
  拆分会把同一裁决（用户原话批准的边界）分散到多份主规格。

## ② tag 推送腿：一次签发两枚单次令牌

- `hulane_authorize_release` 一次返回 `tag_token` 与 `push_token` 两枚令牌，
  分别对应 tag 创建（`release-tag`）与 tag 推送（`release-push`）两条独立命令。
- 裁决依据：guard 的「一次调用一个受保护操作」规则下，tag 创建与 tag 推送天然是
  两条 Bash 调用；两枚令牌各自单次、各自钉死 `{version, sha}`，任何一枚被重放或
  挪用（如 tag 令牌去推分支、push 令牌去打另一个 tag）都在消费校验层被拒。
- 弃选「单枚双动作令牌」：会削弱单次语义（一枚令牌两次消费），且与既有
  `hulane_authorize` 的「一动作一令牌」形态不一致。

## ③ 远端加固：签发前以 ls-remote 为准

- 签发前用 `git ls-remote origin refs/heads/main` 校验请求的 SHA 必须等于
  origin/main 当前 HEAD，用 `git ls-remote --tags origin <tag>` 确认目标 tag
  在远端不存在；不信任本地引用（worktree/缓存可能陈旧）。
- 目的：防止对过期 SHA 打 tag（tag 不在 main 前沿）与覆盖/重放既有 tag；
  已存在的 tag 拒绝重新签发，需要人工处置后再发。

## ④ #2 远端 tag 形态：保 annotated tag（实现期补充裁决）

- 裁决人 human:hutong236，裁决日期 2026-10-06（Gate A 拥有者对实现评审
  议题 #2 的裁决）：远端 tag 保持 annotated 形态，不改轻量 tag。
- 实现：推送腿命令形态为 `git push origin <tag对象SHA>:refs/tags/<vX.Y.Z>`——
  tag 腿先建 annotated tag，编排者用 `git rev-parse <vX.Y.Z>`（不解引用，即
  不带 `^{}`）取 tag 对象 SHA，push 腿用该 SHA；消费时三重验证链：
  ①`git cat-file -t <refspec SHA>` 为 tag（防本地 tag 被删重建为轻量蒙混）；
  ②`git rev-parse <钉死version>` 等于 refspec SHA（该对象即本地钉死版本之
  tag 对象）；③`git rev-parse <钉死version>^{}` 解引用等于钉死 commit SHA。
- delta 措辞相应修订：「release 令牌约束」的消费点名句与「scope 钉死」
  Scenario 同步，新增「annotated 形态保持」「轻量蒙混拒」两 Scenario
  （主规格与归档 delta 两侧逐字对应）。
