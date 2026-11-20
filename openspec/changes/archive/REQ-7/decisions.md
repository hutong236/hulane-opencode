# REQ-7 Decisions：关键取舍记录

工单:REQ-7(Gate A 白名单化:开单同轮默认自动放行,停等收窄为白名单)。
批准人:human:hutong236;批准日期:2026-10-13(Issue #7 审批包评论
issuecomment-6149814366,用户原话「开单,开始实施」)。
以下为批准时已裁决事项,实现按此执行,不再自行取舍。

## ① 新通道命名:auto_intake

- 同轮默认放行通道定名 `auto_intake`:语义是「立项(intake)环节的自动化
  批准」,与 `issue_stop`(人工停等批准)、`pre_authorized`(用户原话显式
  预授权)构成三值枚举。
- 弃选「same_turn」「auto_approve」等命名:前者描述机制而非语义,后者与
  pre_authorized 的边界模糊——auto_intake 强调「默认通道」,pre_authorized
  强调「用户原话明示」,两条通道的 actor 形式与 evidence 措辞义务不同,
  必须在枚举层即可区分。

## ② actor 诚实性:auto_intake 的 actor 必须恰为 orchestrator

- `auto_intake` 事件的 actor 硬校验为恰 `"orchestrator"`;出现任何
  `human:<身份>` 形式反而抛错。方向是「禁止伪造人」而不是「禁止机器」:
  人未敲审批命令时在历史里登记 human actor 是审计伪造;反过来,
  orchestrator 按 SHALL 义务登记自己,审计链(审批包评论 + evidence 引用
  用户原话)仍可回溯到人。
- `pre_authorized` 的 `human:<身份>` 硬校验保持不变:该通道的本义就是
  「用户原话即人批」,actor 必须如实指向那个身份。

## ③ pre_authorized 特权单调性放宽(仅 high 拒)

- 旧边界「低/中风险 + 非规格」放宽为「仅 high 拒」,与 auto_intake 对齐。
- 裁决依据(特权单调性):若保持 pre_authorized 不能批规格工单而
  auto_intake 能批,会出现「审计更强的通道反而特权更弱」的倒挂;两条
  同轮通道的硬边界必须一致,风险一维是唯一机器可自证的停等理由。
- spec_sync_required 从同轮放行边界中删除:规格变更的审计已由「delta 全文
  进审批包评论」承载,不依赖停等。

## ④ 白名单②③为编排文档层义务

- 停等白名单三种情形中,仅 ① risk_level=high 由状态机强制(机器可判定);
  ② Planner 报告需求歧义/scope_questions 未闭合、③ 用户显式暂停写为
  SKILL.md 与命令的编排者 SHALL 义务,不入状态机——「歧义」「用户要停」
  无法从工单字段自证,硬编码会制造虚假的机器确定性。

## ⑤ spec_sync_required 不再构成停等理由

- standard 工单默认 spec_sync_required=true,旧硬校验使「预授权/自动放行」
  对绝大多数 standard 工单形同虚设(取证:近三周全部工单都停等)。
- 规格层的前置核验不动:delta→主规格智能合并仍在实现 PR 内完成,
  `hulane_record_specs_synced` 仍在关单前校验 merged_sha 树,状态机与守卫
  双层拦截不变。放宽的是 Gate A 的「同框人工批准」,不是规格同步本身。

## ⑥ 审批包评论不豁免

- 无论同轮放行与否,审批包(需求、方案、页面设计含评分历史、spec delta
  全文或摘要+路径)SHALL 作为一条 GitHub Issue 评论发布;评论应在
  approve_requirement 应用前(或同轮内)发布,与 approval_source 记录互为
  审计证据。`/hulane_approve` 保留为白名单情形的人工覆盖通道
  (issue_stop 语义不变),存量工单与既有流转零回归。

## ⑦ policy_skip evidence 措辞联动

- 自动放行后不存在「approving human actor」,policy_skip 的 evidence 措辞
  从「Issue 号、批准人、delivery_reason」改为「Issue 号、approval_source、
  delivery_reason」,与三值枚举对齐(SKILL.md 第 11 步、hulane_approve.md、
  FLOWCHARTS 第 137 行三处同步)。
