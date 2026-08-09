# 数字分身架构：四个模块，三个契约

本文是这次架构调整的**设计与验收记录**。读它不需要先读代码；
动这条链路之前应当先读它。

**五步已全部落地**（见第 7 节的实测验收）。第 8 节记的是真机验证抓到的四处
问题 —— 那几条是这份文档里最值得先看的部分。

契约的类型定义在 `packages/persona/src/contracts.ts`（只有形状，没有逻辑）。

---

## 1. 为什么要动

现在这条链路的实现集中在 `apps/desktop/src/main/services/persona.service.ts`
（当时 **3962 行**，现已降到 3000 行上下），其中 `runBatch()` 一个方法里串了四件事：装配上下文、跑三个
判定子进程、调模型生成、决定发不发并落库。后果不是"文件太长"，而是三类具体问题：

### 1.1 同一个问题有三个互不知情的口径

| 判据             | 位置                                                        | 值                                       |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------- |
| 合并同会话连发   | `packages/persona/src/mailbox.ts`（`DEFAULT_*` 那几个常量） | 最老 ≥3s **且** 最新静默 ≥6s，上限 30 条 |
| 折成"一件事"     | forge `rules.json → policy.burst`，由 `persona.py` 消费     | 间隔 300s，最多 12 条                    |
| 送进模型的上下文 | `persona.service.ts` 硬编码                                 | 30 条                                    |

三个数字回答同一个问题的三个侧面，分别写在 TS 常量、Python 读的 JSON、
和一行硬编码里。于是**没有任何一处能回答"这一轮到底看了多少"**。

### 1.2 安全管控散在七处，其中三处重复判同一件事

- **kill switch** 判 3 次：`supervisor.ts` 的 `admit()`、`policy.ts` 的 `evaluatePolicy()`、`send-guard.ts` 的 `send()`。
  第三处是对的（总闸必须在真发之前兜一道），前两处是同一件事判两遍。
- **"本人已经回过这轮"** 判 3 次，且**判据不同**：

  - `admit()` 的 `turnAnswered` —— 只看 `is_self`；
  - `isReplyTurnOpen()` —— 带 4 小时过期窗；
  - `persona.py fresh` —— 看 `isOwner && !isAgentSent`，**区分了分身代发**。

  第三条才是对的。分身自己发出去的消息也是本人 id，把它当成"本人已经回了"
  会**静默压掉第一次自动回复之后的每一次跟进**。

- **内容审查** 3 处：`bannedPhrases` 子串匹配、`evaluateScene` 五条、`persona.py check`。
  长度上限有两个：`MAX_AUTO_LENGTH = 60`（scene.ts）与 `maxCodepoints: 300`（forge 配置）。
- **@提及** 查 2 次同一张表（`inbox-consumer.ts` 的准入投递、以及起草那一侧）。

### 1.3 跨语言字符串匹配决定了一个用户可见的开关

`forge.service.ts` 把 `autonomy.scope` 硬写成 `draft_only` →
`persona.py:251` 每轮追加一句英文 downgrade →
host 用 `isScopeOnlyDowngrade()` 按原文 `includes("autonomy scope is draft_only")` 把它顶掉。

上游改一个词，自动发送就静默全失效。根因不是这个补丁写得不好，而是
**"用户有没有授权自动发"同时存在于 forge 配置和 host 的 `replyMode` 里**。

---

## 2. 四个模块

```
IngestService ──快通道──┐
Outbox 消费者 ──慢兜底──┴─▶ ① intake ──TurnRequest──▶ ② compose
                              （收）                    （生成）
                                                           │ ReplyProposal
                                                           ▼
              delivery ◀──SendDecision── ③ guard ◀── TurnRequest + ReplyProposal
              （发）④                     （管控）
```

| 模块       | 职责                               | LLM            | 子进程                   | 可穷举单测         |
| ---------- | ---------------------------------- | -------------- | ------------------------ | ------------------ |
| ① intake   | 订阅 → 准入 → 合批 → 装配上下文    | 无             | 仅媒体下载（IO，非判断） | 是                 |
| ② compose  | prompt 装配 → 生成 → 信封解析      | **有（唯一）** | `brief`（取理解）        | 部分（用 fixture） |
| ③ guard    | 全部安全管控，唯一决策点           | 无             | `check` / `fresh`        | 是                 |
| ④ delivery | 目标解析 → SendGuard → 审计 → 回拉 | 无             | 渠道 CLI                 | 是                 |

`PersonaService` 缩回**接线层**：起定时器、实现 supervisor 的三个回调、
推快照、IPC 读路径。实际从 3962 行降到 3000 行上下 —— 剩下的主要是 IPC 读路径
与 workspace 物化，见 7 节末尾那段说明。

### 2.1 三条不变量

1. **compose 手上没有发送能力，也没有授权信息。** 消息里藏 prompt injection
   时，模型能做的最坏的事是写出一段我们不想发的文本 —— 而那段文本仍要过 guard。
   _自动发送是宿主行为，不是模型行为。_
2. **guard 是唯一决策点。** "为什么这条没发"只有一个答案，不再需要在四个文件里拼。
3. **测量与政策分离。** 见第 4 节。

### 2.2 guard 内部是 Python + TS 混合，这是刻意的

`check` 只读 `references/rules.json`、跑若干正则，不碰库不碰网络
（`persona.py:1060` 就一行）。纯 TS 重写技术上可行，**但不该做** ——
理由是 forge 自己写下的那条（`compose.py:872`）：

> a second source of truth for policy would drift from the first,
> and **the drift would be invisible**

`rules.json` 里的正则是从 locale pack 原样搬来的 Python 正则。我核对过
`zh-CN.json`：`askKinds` / `riskTags` / `replyShapes` 目前全是基础组
（`(你觉得|你看|要不要|…)`），**没有** `(?P<`、`(?i)` 等 Python 专有构造，
所以 JS 今天能编译。但"今天能"不等于"明天还能" —— 上游加一个 `(?i)`
或后行断言，TS 那份就会**静默匹配失败**，而失败形态是"风险类检测不出来
→ 该拦的没拦"。

所以正则只在 Python 侧跑。**guard 仍然满足"管控层不含 LLM"**：
`persona.py` 是零模型调用的纯 stdlib Python。

一个附带的好处：拆分后 TS 侧**反而不碰正则了** —— `classification` 由
forge 算好给（见 4.3）。

---

## 3. 三个契约

见 `packages/persona/src/contracts.ts`。摘要：

| 契约            | 从 → 到                | 回答什么                                       |
| --------------- | ---------------------- | ---------------------------------------------- |
| `TurnRequest`   | intake → compose/guard | 这一轮要回什么、带多少上下文、有多新           |
| `ReplyProposal` | compose → guard        | 打算说什么（`text: null` + 理由 也是合法结果） |
| `SendDecision`  | guard → delivery       | 发 / 只出草稿 / 丢，以及**全部**原因           |

两处值得单说：

- **`ReplyProposal.text === null` 必须带 `noReplyReason`。** 现在"这一轮不该回"
  是靠 service 提前 `return` 表达的，于是「判定说不必回」与「生成失败了」
  在库里长得一样 —— 前者是正常工作，后者要修。
- **`TurnFreshness.collectionLagMs === null` 不等于 0。** 库落后于平台时，
  "最新那行"确实是我们**有**的最新一行，而更新的可能存在只是还没采回来。
  这是三种 stale 里唯一在数据本身看不出来的，所以 null 按不安全处理
  （与 `rules.json` 的 `freshness.unknownLagIsStale` 同口径）。

---

## 4. forge 的边界：只测量，不发许可

### 4.1 结论

**`vendor/forge/` 一行不改。** 改的是 host 侧怎么消费它。

这是硬约束：`vendor/forge/SHA256SUMS` + `scripts/check-vendor-integrity.mjs`
会拦住任何未登记的改动，连"往树里多加一个文件"都拦。README 写明 vendor 是
上游源码副本，入 git 是为了让代码审查可能。

### 4.2 forge 里哪些是测量、哪些是政策

| 内容                                                | 性质                                   | 位置                      |
| --------------------------------------------------- | -------------------------------------- | ------------------------- |
| `answerRatePct` / `shapePct.settle` / 原始计数 `n`  | **测量**                               | `decide.py:_rate_block`   |
| `evidenceSufficient` / `recentlyDrifted`            | **测量的元数据**                       | `decide.py:375`           |
| `medianCodepoints` / `medianBubbles` / `neverWrite` | **测量**                               | `compose.py:render_rules` |
| `precedents` / `escapeHatches.clarify`              | **测量**（本人原话）                   | `persona.py:cmd_brief`    |
| `classification`（askKind / riskTags）              | **测量**                               | `persona.py:classify`     |
| `defaultAction: "draft_gated"`                      | **政策**                               | `decide.py:372`           |
| `policy: "never_settle"` 的默认值                   | **政策**                               | `decide.py:_risk_policy`  |
| `alwaysDraftKinds`                                  | **政策**，且是**硬编码常量**           | `signals.json:91`         |
| `autonomy.scope` / `allowlist` / `maxCodepoints`    | **政策**，且**完全来自 host 传的配置** | `cfg["autonomy"]`         |

最纯粹的例子是 `signals.json:91` 的 `alwaysDraftKinds`：一个硬编码列表，
`decide.py:372` 拿它无条件把 `defaultAction` 压成 `draft_gated`，
注释原话是「no matter how reliably the owner answers them in person」。
**这条规则与蒸馏结果无关** —— 它是一条企业级安全策略被塞进了测量引擎。

同理 `_risk_policy` 的默认值 `never_settle`（"absence of evidence is not
permission"）是政策判断，而测量结论只是 `settleSharePct = 0, n = 3`。

一句话概括这条边界：**forge 说"他 92% 会答这类问题"，guard 说"92% 不等于
可以替他答"**。后半句正是 forge 自己写下的话（"a rate is evidence, not
permission"），只是它把执行放在了自己那边。

### 4.3 好消息：`brief` 的 payload 已经把两者分开了

`persona.py:cmd_brief` 的返回：

```
"classification": {...}    ← 纯测量：askKind / riskTags / genuineAsk / chitchat
                              + riskDetectable / askKindDetectable（能力元数据）
"recipient": {...}         ← 纯测量：toneBand / sensitive / resolved
"styleTargets": {...}      ← 纯测量
"precedents": [...]        ← 纯测量
"factLeads": [...]         ← 纯测量
"clarifyOption": [...]     ← 纯测量（本人原话）
"context": {source,degraded}← 事实
──────────────────────────────────────
"verdict": ...             ← 政策产物
"mayAutoSend": ...         ← 政策产物
"because": [...]           ← 政策产物
```

**host 拿 `classification` + `recipient` + `context` 就足以自己重新判定。**
所以拆分只需要停止消费后三个字段，forge 不用动。

### 4.4 已知缺口：`rules.json` 只发布政策结论，不发布原始率

`compose.py:render_rules` 发布的是 `byAskKind: {kind → defaultAction}` ——
**已经是政策结论**，原始的 `answerRatePct` / `n` / `evidenceSufficient`
不在 `rules.json` 里。

原始数据在 `<forgeRoot>/derived/features.json`（`build.py:179`），
而 `forgeRoot` 是 host 自己给 forge 的目录，**host 完全可读**。

所以 guard 的政策层有两种取数方式：

- **A（首选）**：读 `features.json` 拿原始率与证据量，自己套政策；
- **B（过渡）**：继续读 `rules.json` 的 `byAskKind`，但把它当"forge 建议"
  而非"判定"，由 guard 的 `GuardPolicy` 覆盖。

第 2 步先做 B（改动小、可对照验证），确认稳定后再评估 A。
**这一条必须写下来** —— 否则下一个人会以为 `byAskKind` 是测量。

### 4.5 `check` 的角色变化

`check` 是唯一保留的例外：它自己跑 `classify(draft)` 判"草稿正文本身有没有
陈述风险类"。这一条 host 拿不到（草稿是新生成的文本，forge 没见过）。

所以 `check` 保留，但角色从**政策闸**变成**对草稿正文的测量**：
返回 `riskTags` 与 `codepoints`，由 guard 决定这意味着什么。
同样不用改 forge —— `problems[].kind`（`risk_in_draft` / `too_long` /
`never_write`）已经是结构化的，guard 只需重新解释 `severity`。

---

## 5. `decide_action` 的 12 条降级：搬迁清单

`persona.py:179-260` 的降级逻辑本身是对的，要**原样搬进 TS**，
只是政策参数改由 `GuardPolicy` 给。rank 表（只降不升）必须一起搬：

```
reply:0 / handoff:1 / draft:2 / silent:3   —— 只能往大的方向走
```

| #   | 条件                                      | 降到   | 性质                                  | 搬去哪                               |
| --- | ----------------------------------------- | ------ | ------------------------------------- | ------------------------------------ |
| 1   | `rules.json` 读不出来                     | draft  | 政策（fail closed）                   | `GuardPolicy.onUnavailable`          |
| 2   | `!askKindDetectable`                      | draft  | 政策（能力缺失→保守）                 | guard                                |
| 3   | `!coverage.replyShapes`                   | draft  | 同上                                  | guard                                |
| 4   | `askKind ∈ alwaysDraftKinds`              | draft  | **政策**（硬编码列表）                | `GuardPolicy.alwaysReviewAskKinds`   |
| 5   | `askKind ∈ thinAskKinds`                  | draft  | 政策（证据不足→保守）                 | `GuardPolicy.onInsufficientEvidence` |
| 6   | 每个命中的 `riskTag`                      | draft  | **政策**                              | `GuardPolicy.riskClassPolicy`        |
| 7   | `!riskDetectable`                         | draft  | 政策（能力缺失→保守）                 | guard                                |
| 8   | 纯客套且非真问                            | silent | 测量驱动的政策                        | guard                                |
| 9   | 收件人未按 id 认出                        | draft  | 政策                                  | guard                                |
| 10  | 收件人 sensitive                          | draft  | 政策                                  | guard                                |
| 11  | `toneBand === "S"` 或 band 为 manual-only | draft  | 政策                                  | guard                                |
| 12  | `autonomy.scope === "draft_only"`         | draft  | **政策，且与 host 的 replyMode 重复** | **删掉**，由 `replyMode` 唯一表达    |

第 12 条删掉之后，`isScopeOnlyDowngrade()` 那个补丁函数整个消失 ——
它存在的唯一原因就是那个重复。

### 5.1 对照验证（第 2 步的验收判据）

搬进 TS 之后必须证明**两边给出相同 verdict**。做法：写一个对照脚本，
拿库里最近若干轮的真实输入同时跑 TS 版与 `persona.py brief`，逐条比对
`verdict`。全等才算搬对；不等的每一条都要能解释为什么。

不做这一步的话，"搬错一条降级"的表现是**某一类问题突然开始自动回了**，
而它不报错。

---

## 6. 归一清单（哪些"两个真源"在哪一步消失）

| 问题                       | 现状                                       | 归一后                                                   | 步  |
| -------------------------- | ------------------------------------------ | -------------------------------------------------------- | --- |
| 窗口/上下文条数三个口径    | mailbox + rules.json + 硬编码              | `IntakePolicy` 一处                                      | 1   |
| @提及查两次                | inbox-consumer + service                   | `TurnRequest.mentionsSelf`                               | 1   |
| "本人已回"判三次且判据不同 | admit + isReplyTurnOpen + fresh            | `TurnFreshness.ownerRepliedAfter`（以 fresh 的判据为准） | 1   |
| kill switch 判三次         | admit + policy + SendGuard                 | guard 判一次 + SendGuard 兜一道（**纵深，保留**）        | 2   |
| 内容审查散三处             | banned + scene + check                     | guard 内并列输出                                         | 2   |
| 长度上限两个值             | `MAX_AUTO_LENGTH=60` / `maxCodepoints=300` | `GuardPolicy.maxAutoSendCodepoints`                      | 2   |
| scope 跨语言字符串匹配     | `isScopeOnlyDowngrade`                     | 删掉                                                     | 2   |

`fresh` 归一后**只保留它独有的第三条**（采集滞后 vs `rules.json` 阈值）。
那次 spawn 仍然必要 —— 阈值在产物里，host 抄一份就又是一个"两个真源"。

---

## 7. 五步，与各步的验收

**状态：五步已全部落地。** 下表的"验收"列记的是实际跑过的结果。

| 步    | 内容                                                                   | 有 LLM/子进程     | 验收（实测）                                          |
| ----- | ---------------------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| **0** | 本文档 + `contracts.ts`                                                | 无                | ✅ typecheck                                          |
| **1** | intake：准入 + 合批 + 上下文装配 + 媒体；修 retarget 不看 mention 的洞 | 仅媒体下载        | ✅ `tests/unit/persona/intake.test.ts`（15 条）       |
| **2** | guard：收拢七处闸 + 搬 12 条降级                                       | `check`/`fresh`   | ✅ `guard.test.ts`（23 条）+ `check:gate-parity`      |
| **3** | compose：prompt 装配 + 生成 + 信封解析                                 | **LLM** + `brief` | ✅ `persona-service.test.ts` 全绿（两条路同形）       |
| **4** | delivery：目标解析 + SendGuard + 审计                                  | 渠道 CLI          | ✅ 自动发送那一组（含单聊审计记对端 id）              |
| **5** | 收尾：删死代码、service 瘦身                                           | 无                | ✅ lint / typecheck / check:all / 3934 条单测 / smoke |

**只有第 3 步有 LLM。** ①②④⑤ 全是可穷举、可单测的确定性代码。

行为改变集中在第 2 步（删第 12 条降级）。第 1、3、4 步是**只搬不改**。

`persona.service.ts` 从 **3962 行降到 3000 行上下**。没有达到当初写的"400 行以内"
—— 剩下的是 IPC 读路径（`messages` / `drafts` / `runTrace` / `runDetail` /
`searchMessages` 等约 900 行）与 workspace 物化（`createAgent` / `readGuidance`）。
那些确实属于接线层，但把它们再拆成"读模型"与"workspace 管理"两个模块是
下一轮的事 —— 这一轮的目标是**四条链路的边界**，而那已经达成。

### 7.1 `verdict` 暂时保留但不消费

forge 照常算 `verdict`/`mayAutoSend`/`because`，host 停止消费。理由：

- forge 一行不改，零风险；
- 正好用它做 5.1 的对照验证。

代价是产物里留着一个没人读的判定，将来会有人误以为它生效了 —— 所以
`persona.service.ts` 的 `toGateVerdict()` 里是 `void brief.verdict` 加一段注释
（**显式丢弃**），而不是默默不取。
对照验证跑稳一段时间后，再考虑要不要向上游提一个 `--no-verdict` 开关。

---

## 8. 真机验证发现的四处问题（都在写代码时被真跑抓到）

这一节记的是**实际踩到的**，不是设想的。前两条是 `scripts/check-gate-parity.mjs`
拿真 forge 产物跑出来的 —— 单测抓不到它们，因为单测用的是我们自己编的 payload。

### 8.1 `context.degraded` 是**字符串**，不是布尔

真实输出：

```json
"context": { "source": "corpus", "degraded": "no live read available" }
```

写成 `degraded === true` 会把**"这不是当前的上下文"读成"是当前的"** ——
方向正好是危险的那一侧：拿几小时前的语料当实时读，然后以本人身份回一条
已经过时的话。现在的判据是「有这个字段且非空」，并且 `source === "corpus"`
本身也算降级（那个来源的定义就是"我只有语料库"）。

### 8.2 `brief` 的 payload 里**没有** `policy` / `bands` / `coverage`

它们在 `references/rules.json` 里。从 payload 读会拿到空表 →
`defaultAction` 退回 `draft` → **一切都只出草稿**。方向是安全的，
但那是一次静默的能力丢失（测出来的 `byAskKind` 永远用不上），
而外观与"这些消息本来就该人工"完全一样。

现在 `readCoverage()` / `readAdvice()` 直接读 `rules.json`。
parity 门禁里有两条**反向**断言（"policy 不在 brief 里"），
这样上游哪天真的把它加进 payload，门禁会变红提醒我们改回更同源的读法。

### 8.3 `decision_reason` 记了分类记录而不是拦它的理由

`because[0]` 永远是 `measured default for \`X\` is answer`—— 那是
"我们量出这类问题的默认动作是啥"，不是"为什么拦住了这一条"。
实测形态：一条纯客套走 silent，而`decision_reason`写着
"measured default for`other_ask` is **answer**" —— 一句自相矛盾的话。

修法是 `GateVerdict.decidingReason`：只记**最后一次真正改变动作**的那条理由。

### 8.4 `check` 的总判定被忽略了

我最初只重新解释了 `check` 的三项（风险类 / 长度 / severity），而没有尊重
它自己的 `result: "block"`。后果：一条被 `check` 挡下、但原因不在那三项里的
草稿会被放过去 —— 又一次"少一道闸"，而外观正常。

现在 guard 对 `check` 的态度是明确的：**它说不行就不行，它说行我们再自己看一遍**
（与 `holdForReview` 同一条"只能收紧"的语义）。

### 8.5 三处"比 Python 更宽松"的潜在分歧（专项 review 抓到的）

写完之后又做了一轮**只找"哪里比 Python 更容易放行"**的审查。方向是单向的：
更保守可以接受，更宽松是 bug。抓到三处，都只在**产物形状变了**时才触发 ——
而那正是这一层存在的理由。

| 分歧                           | 表现                                                                                             | 修法                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `coverage.*` 用 `!== false`    | Python 是 truthiness，所以 `replyShapes: null` **Python 降级、TS 不降级**                        | 改成「只有 `undefined` 算有能力」              |
| `riskTags` 形状不对时压成 `[]` | 上游把它从数组改成标量、而 `riskDetectable` 仍是 `true` → 零风险类**且**无第 ⑦ 条降级 → 判 reply | 形状读不懂时连带把 `riskDetectable` 打成 false |
| 第 ④ 条只读 host 的名单        | 产物发布一份**更长**的 `alwaysDraftKinds` 时，多出来的类型被静默忽略                             | 两份取**并集**（host 是下界，产物只能更严）    |

另外 review 指出 `guard.ts` 有一句注释在**报告愿望而不是事实**：它写着
"`collectionLagMs === null` 按不安全处理"，而那个方法从来没读过这个字段
（真正挡住的是 `lag === null`，也就是 `fresh` 那次判定的结论）。行为是安全的，
但那句话会让下一个人以为有一道 host 侧的滞后闸。已改正 —— 这条属于 CLAUDE.md §4。

顺带修掉 parity 脚本里一处**会掩盖分歧**的 seed：它把 `decision_request` 记成
`answer`，而真实的 `forge publish` 永远不会（`decide.py:372` 已经把
`alwaysDraftKinds` 折进 `byAskKind` 了）。照真实形态 seed 之后，
那条门禁才验得到真东西。

### 8.6 顺带修掉的一个已知洞

原 `latestInboundAfter` 的注释里承认了但没修：改目标时**不看 @提及**，
而群聊缺省触发模式要求被 @。于是一个热闹的群里可能把目标改到一条
没 @ 本人的消息上并为它起草 —— 既违背用户设的触发条件，也在烧 token。

现在 intake 的改目标用的是**与准入闸相同的判据**（`tests/unit/persona/intake.test.ts`
的头两条锁住了正反两面）。

---

## 9. 重构之后清掉的东西

拆完之后专门查了一轮"还在编译但已经没人读"的东西 —— 那类东西的害处不是占空间，
而是**下一个人会以为它还生效**。

### 9.1 删掉的代码

| 删掉的                                                   | 为什么                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PersonaRunRepository.isReplyTurnOpen()`（约 40 行 SQL） | 零生产调用。判据搬到了 `TurnFreshness.ownerRepliedAfter`，而且搬的时候**修正了判据**（区分分身代发）。留着一个没人调的判据会让人以为存储层还有一道闸                                                   |
| `PersonaService.grantManager()`                          | 与 `PersonaDelivery` 里那份**逐字重复**，包括那个必填的 `downgradeToDraft` 回调。漏配它的表现是"授权过期后一直失败、而用户只看到数字人不回了" —— 一处装配就不可能漏。现在由 `delivery.grants(db)` 提供 |
| `MeasuredTraits` 类型                                    | 想当"测量总览"的伞形类型，被 `MessageClassification` / `RecipientTraits` / `TraitCoverage` 三个具体类型取代后**一个引用都没有**                                                                        |
| `gateSkillDir()` 的重复注释块                            | 同两段话在同一个 doc comment 里出现了两遍（拆分时的复制粘贴残留）                                                                                                                                      |
| `renderTask` / `renderReviewFeedback` 的 `export`        | 只在 compose 内部用。多导出等于把它们放进公开 API 面                                                                                                                                                   |
| compose 里 `UNEVALUATED_CONFIDENCE` 的再导出             | 没人从 compose 拿它（`persona.service.ts` 直接从 `@mycontext/persona` 取）                                                                                                                             |

### 9.2 改掉的过时注释

- **五处 `generateDraft`**（`startup.ts` / `persona.service.ts` /
  `render.ts` / 两个探针）—— 那个函数已被 `PersonaComposer.compose` 吸收，
  但注释还在用它当路标。`startup.ts` 那处最糟：它告诉读者"`PersonaAcp.turn`
  返回 null 时 `generateDraft` 自己落回直连"，而读者按那个名字什么都搜不到。
  按 CLAUDE.md §4，那属于"实测结论过了保质期"。
- **`tests/unit/store/persona-drafts.test.ts`** 断言 `isReplyTurnOpen` 是
  "自动发的前置判据" —— 那句话在拆分之后是**假的**。改成只锁存储层那一半
  （本人回了之后草稿照样 pending），并写明判据搬去了哪、顺带修正了什么。
- **本文里的行号引用**（`persona.service.ts:3918` / `mailbox.ts:245` /
  `persona.service.ts:2327` 等）—— 行号会腐坏，改成引符号名。
  只有指向 `vendor/forge` 的行号留着：那棵树是 hash 锁定的，行号稳定。
- **`@提及` 归一那一行**原来写得过头了：起草侧确实归一到
  `TurnRequest.mentionsSelf`，但**准入投递那次仍在**（它在入队之前、
  拿不到 `TurnRequest`，属于不同阶段）。已改成如实描述。

### 9.3 顺带修掉一个悄悄坏掉的探针

`scripts/check-persona-entry.ts` 读 `snapshot.whitelistCount` —— 那个字段在
白名单删掉时就没了（现在是 `autoReplyCount`）。两层掩盖让它一直没被发现：

- 它用 esbuild 打包，而 esbuild **只剥类型、不做类型检查**；
- 它不在任何 tsconfig 的 references 里，`pnpm typecheck` 看不见它。

于是那个探针一直在打印 `undefined`。已改正。

### 9.4 刻意**保留**的"看起来冗余"的东西

- **kill switch 判两次**（guard + `SendGuard`）—— 那是纵深，不是重复：
  总闸必须在真发之前再兜一道。第 6 节的表里标着"纵深，保留"。
- **一批"X 已删，原因是 Y"的历史注释**（`whitelistCount` → `autoReplyCount`、
  `listening` 开关、`materializeAll` 的四个 md、`installForgeSkills` 的 cpSync）
  —— 它们防的是"有人顺手把删掉的东西加回来"。CLAUDE.md §2 里那个
  「顺手统一导致 16 条真数据断言静默消失」的例子就是这类注释存在的理由。
- **`isScopeOnlyDowngrade` 在注释里的几处提及** —— 它们解释的是
  **为什么现在的设计不去匹配英文散文**。删掉那些解释等于邀请那个模式回来。

---

## 10. 上线后按真实产出做的三处修正

拆完之后拿库里的真实草稿复核了一轮（`dh_agent_runs` 最近 12 轮），发现产出
形态不对：**每条只有 2-7 个字符，而每轮烧掉 3000-5000 token**。查出三个原因，
都不是"模型不听话"。

实测的那段对话（2026-08-10 00:08–00:16，单聊）：

```
对方> 是 / 都不重要 / 组合起来重要 / 帮我上班重要   ← 4 条，15 秒内
分身> 确实
分身> 那你得谢谢我                                  ← 同一串被回了两次
对方> why
分身> 都帮你上班了
对方> 不是你帮我上班 / 你是啥模型啊
分身> 那也是我开的                                  ← 只回到了第一条
本人> 服了，glm 5.2                                 ← 本人亲自在聊
分身> 不告诉你                                      ← 分身还在插话
对方> 付了 / 服了
分身> 早该服了
本人> 我要把它关了
```

### 10.1 合并窗口**已经失效**——因为起草变慢了

`mailbox.ts` 的 `DEFAULT_QUIET_MS = 6000` 那段注释写着「6 秒的来源不是猜的：
它要覆盖**一轮起草的耗时（实测 4-6 秒）**」。

而 `dh_agent_runs.latency_ms` 现在是 **19–82 秒**（推理模型 + 每轮三五千 token）。
于是时序变成：等 6 秒 → 起草 20-80 秒 → **这期间对方又发 3 条** → 发出去 →
下一轮再为那 3 条起草。**分身在追着回，每次只回到一个片段**。

这正是 CLAUDE.md §4 那条：注释里的实测结论有保质期，而它现在指向一个错的值。

**修法**：`DEFAULT_INTAKE_POLICY.quietMs` 提到 **25 秒**（不再沿用 mailbox 的 6 秒）。
代价说清楚：对方只发一条时首次响应从 6 秒变成 25 秒 —— 晚 20 秒的一条完整
回复，好过 6 秒后一句答非所问（后者还会再引出一轮追回）。

★ 真正的根治是「起草期间新消息作废这一轮并重新合批」，那是另一件事（未做）。

### 10.2 本人亲自在聊时分身**不退让**（已诊断，**本轮未修**）

`00:14:19` 本人说「服了，glm 5.2」→ `00:14:38` 分身回「不告诉你」——
**跟本人抢话**，对方看到的是同一个人在自问自答。

根因：两处判据（`intake.ts` 的 `ownerRepliedAfter`、`inbox-consumer.ts` 的
`turnAnswered`）**都只看触发消息之后**（`sent_at > ?`）。而「付了」是 00:15:20
发的，本人说话在它**之前** —— 于是那一轮完全看不到本人在场。

两条判据问的不是同一件事：

- `ownerRepliedAfter` —— 这一轮**被回过**了吗；
- 「本人正在亲自聊吗」—— **目前没有任何判据回答它**。

**状态：本轮刻意不修。** 实现过一版（intake 采「最近 N 分钟内本人真人说过话」
的事实 + guard 一道闸），验证通过后按决定回滚了 —— 因为它有一个尚未解决的
前置依赖，见下。

**如果将来要做，归属是 guard 而不是 delivery**（这次的边界正好回答了这个问题）：

- 「本人在场」是**事实**（intake 采），「该不该发」是**判定**（guard 出）；
- 它**只该挡自动发、不该挡出草稿** —— delivery 拿到时草稿已经落库，
  在那儿拦会让草稿状态与实际行为脱节；
- 要能说出原因，而 `SendDecision.primaryReason` 是唯一出口。

**★ 前置依赖（这才是本轮不做的真实理由）：`origin='agent'` 的标注不完整。**

判据必须排除分身代发（`origin != 'agent'`）—— 否则分身会**把自己锁死**：
回过一条就永远认为"本人在聊"，再也不自动发。方向正好反了，而且不报错。

而那个标注依赖一条会断的链：钉钉的 `send` 只返回 `openTaskId`，消息 id 要再走
一跳 `query-send-status`，那一跳失败时 `claimAgentOrigin` 就匹配不上。
本机实测：

|                                                 | 数     |
| ----------------------------------------------- | ------ |
| 分身真发成功（`dh_send_attempts.state='sent'`） | 14     |
| 拿到平台消息 id                                 | 13     |
| 库里标上 `origin='agent'`                       | **13** |

漏的那条（`2026-08-09 15:25:40` 的「那行」）在库里是 `origin='human'`，
于是会被当成"本人在场"。方向是**保守**的（少回而不是乱回），
但它是一次静默的行为偏差。

这个漏标本身是既有问题（`check-send-linkage.mjs` 那个探针就是为它写的），
只影响蒸馏语料与消息标签。**加这道闸会给它一个新的后果**，所以先修标注、
再加闸；兜底思路是让判据同时查 `dh_send_attempts`（那张表按内容 hash 记，
不依赖消息 id）。

### 10.3 `maxTokens: 400` 对推理模型**恒返回空正文**

真机直打网关（`glm-5.2`）：

```
max_tokens=20   → finish_reason=length, content="",  reasoning_content="1. **分析请求：**…"
max_tokens=2000 → finish_reason=stop,   content="好", 光推理就花了 77 token
```

推理模型**先把预算花在思考上**，正文是想完才写的。预算不够时它不报错，
而是给一个空 `content` → `LlmClient` 判「返回空内容」→ 重试 → 还是空。
库里那批 2-7 字符的草稿就是这个形态。

**修法**：`DRAFT_MAX_TOKENS = 2000`。注意 `max_tokens` 是**上限不是用量**——
非推理模型写完就 `stop`，按实际计费，所以这个调整对它们零成本。
回复长度仍由 `style.md` 的测量约束管（中位数 6 字），**上限放宽不等于回复变长**。

顺带修掉一处诊断缺失：`client.ts` 的「返回空内容」现在带上 `finishReason`
与 `reasoningLength`。`length` 与 `stop` 指向完全不同的处置（前者是我们预算
不够、后者该查 prompt），而原来两者长得一样 —— 我查这个问题时只能靠手动
curl 打网关才看出区别。

### 10.4 一处顺带的口径归一

`quietMs` 现在有三个读者（intake 的 `takeBatch`、`wake()` 的延迟、
supervisor 的 Mailbox），而原来后两个各自 `?? DEFAULT_QUIET_MS`。
静默期一改就会分叉，表现是**唤醒在静默期没满时触发 → 取到空批次 →
这一批要等 8 秒兜底**（也就是"唤醒白接了"，且看不出来）。

现在三处都从 `DEFAULT_INTAKE_POLICY.quietMs` 取，supervisor 那处改成**总是
显式给**而不是"只在传了时才给"。

★ 测试侧同源：`persona-service.test.ts` 原来硬编码 `clock.advance(10_000)`，
静默期一提到 25 秒就有 40 条用例一起变红（症状是"一轮都没跑起来"）。
现在改成从 `DEFAULT_INTAKE_POLICY` 派生的 `PAST_BATCH_WINDOW_MS`。
