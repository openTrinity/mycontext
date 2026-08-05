# im-persona-forge

把一个人在工作聊天里的**沟通方式**炼化成一份**开箱可用**的 Agent Skill：
不只是模仿用词和对不同人的语气，更包括**决策层**——哪些消息该回、哪些该转给别人、
哪些永远不能自己拍板。

本仓库交付的是**炉子**，不含任何人的数据。炉子本身与**语言无关、平台无关**：
所有词法规则装在可替换的 locale 包里，所有数据接入走统一的 source 适配器。

---

## 核心设计：Skill 是产物，语料是真源

```
IM 平台 ──pull──▶ 本地语料库 (SQLite，全量原文，700/600)
   │                  │
 source 适配器          ├── build ──▶ 可度量特征 (表达 · 决策 · 关系)
 (dws / jsonl)         │      ↑
                       │   locale 包 (zh-CN / en / null)
                       └── publish ─▶ <slug>-persona  +  <slug>-inbox
```

**删掉装好的 skill，`publish` 能一模一样地重建出来。**
所有优化都在炉子里做，然后重新发布——加载 skill 的 agent 不需要在运行过程中调优。
手写的修正写在产物文件的 `<!-- owner:begin -->` 块里，每次重建都保留。

产出两个 skill，分工明确：

| Skill | 职责 | 不做什么 |
|---|---|---|
| `<slug>-persona` | 判断该不该回 → 起草/发送 | 不做发现 |
| `<slug>-inbox` | 发现哪些消息在等回复 | 不做任何回复判断，不发送 |

---

## 通用性：三条分界线

炉子要能发给任何人用，就不能把**任何一个人的语料形状**焊进引擎。三层各有明确归属：

### 1. 语言 → locale 包（`forge/locales/*.json`）

引擎只做**测量**，locale 包告诉它这些词是什么意思。所有正则——表达标记、场景、
来意分类、风险类别、开口方式、回复形态、机器人名、敏感头衔、停用词、禁用语——
全在包里，`forge/*.py` 里**一个汉字都不许有**（`forge scan --scope repo` 强制）。

```bash
python3 -m forge locales    # 装了哪些包，哪个适配当前语料
```

- `locale.id: "auto"`（默认）从**本人自己的消息**做字符集直方图来判定，纯离线、无模型调用。
  这里有个容易搞反的不对称：中文工作聊天里满是英文标识符（工具名、分支名、工单号），
  按码点数 Latin 常常反超 Han——但英文散文里**不会**出现成串汉字。所以
  非拉丁文字占比达到 15% 就直接定调，而不是简单比大小。
- 双语语料（国际团队来回切语言）取主导包，并把没覆盖到的部分**写进 `fidelity.md`**。
- **没有匹配的包也能跑**：`NULL_PACK` 是个正常对象，不是错误状态。结构层
  （句长、延迟、沉默率、开口分布、逐人往来）照常全量测量，词法层
  **诚实报空**——并且产物会明说这一点，不会让人把「没测到」读成「他从不这样」。

自己加一门语言：复制 `forge/locales/zh-CN.json`，**保留全部 key**，按那门语言
自己的习惯重写正则。不要逐词翻译——一个只能匹配字面直译的包，会拿几乎匹配不上的
模式产出很自信的数字，比不装包更糟。

公司内部专有的词（内网机器人名、自家工单模板）放
`<dataRoot>/locale-overrides.json`，**永远不进发行包**——那是别人的负担。

### 2. 平台 → source 适配器（`forge/sources/*.py`）

```bash
python3 -m forge sources    # 有哪些数据源，各自能做什么
```

| kind | 说明 | 能力 |
|---|---|---|
| `dws` | 钉钉（走 `dws` CLI） | 读 / 目录 / @提及 / 实时尾部 / 发送 |
| `jsonl` | 任何平台的规范化导出 | 只读，离线快照 |
| `vault` | MyContext 桌面端已采集的语料库（SQLite） | 读 / 目录 / @提及（**不发送、不实时读**） |

`capabilities()` 是这套接缝诚实的关键：**不能发送的数据源会让 persona 的 send
明确拒绝并说明原因**，而不是在子进程边界上抛个看不懂的错。同理，**不能做实时读的
数据源会让 inbox 的 `check` 直接返回 `unsupported: true`** ——
而不是去轮询 PATH 上那个 `dws`（在离线源的 profile 上，那个 CLI 属于**另一个人**，
轮询它会把别人的消息当成本人的候选）。`ID_PATTERN` 由适配器
自己声明，给分享扫描用——只认一家厂商 id 格式的正则，会**默默放过**所有别家的 id。

没有适配器的平台走 `jsonl`：自己导出、转成规范化格式（schema 见
`forge/sources/jsonl.py`），整套测量引擎照常工作。

```bash
python3 -m forge init --source jsonl \
  --source-option path=~/exports/slack \
  --source-option 'identity={"openIds":["U0123456"],"name":"Real Name"}'
```

**单聊必须显式标 `singleChat: true`**。它默认 `false`（群聊）是安全的一边，但也是
最贵的一次写错：群里只有 @到本人 的消息才算「问到他头上」，所以一份全是单聊的导出
忘了这个字段，会**一条 ask 都挖不出来**——决策层整个退化成默认值，而风格层照常有数字，
看上去像是成功了。`forge build` 会报 `no_asks_mined`，`fidelity.md` 直接判 D 并指名
这两个最常见的原因，但**修的地方在导出脚本里**。

**时间戳必须是字符串**（`createdAt`，`"2026-07-30 09:15:00"` 或 ISO 8601）。unix 数字时间戳会被**拒绝而不是猜**——秒/毫秒/微秒无法从数值推断，猜错就是所有
延迟测量里一个静默的千倍误差，请在自己的导出脚本里转好。读进来但时间戳不可用的行
会计入 `sourceStats.undatedLines`、**指名具体行号**，并且让 `complete` 变成
`false`——一次「什么都没用上」的导入永远不会报成成功。

`identity` 必须显式给：导出文件里每个 id 长得都一样，**猜错本人身份是这里最坏的
故障模式**——会把别人的话算成本人的，然后产出一个很自信的错人格。所以适配器宁可
拒绝启动也不猜。

#### `vault`：读另一个应用已经采好的语料

MyContext 桌面端自己做采集（两级轮询、水位、截断二分、幂等键）并维护本人身份权威表，
所以 `vault` 源**不拉取**，只把那个库投影成规范化消息——`ingest.pull` 那条路一行不改地复用，
目录同步、人员登记、1:1 对端反查、FTS 重建全都照常。

```bash
python3 -m forge init --source vault \
  --source-option path=~/Library/Application\ Support/MyContext/vaults/<vaultId>/core.sqlite
```

三件事与别的源不同：

- **本人身份不用配**：从库里的 `channel_self_identity` 读。但 `confirmed_at` 为空
  （用户还没在应用里确认）就**拒绝启动**，而不是先用着——身份错了之后画像全错且不可逆。
- **`is_self` 为 NULL 一律排除并计数**。那不是「别人」，是「还没判定」：应用在用户确认
  身份之前采到的消息都是 NULL，之后回填。补成 0 会把本人的话算成别人的，而**之后没有
  任何信号能纠回来**。这类行会让 `complete` 变成 `false`，`note` 里直接说是身份没确认——
  免得看起来像「这人不太说话」。
- **只读**：连接用 `mode=ro` 打开。那个库属于应用，可能正在被写；语料库这边是 forge 自己的文件。

@提及走库里的 `message_mentions` 真表（应用在采集时从平台结构化字段解析的），
比按显示名在正文里匹配准。也因为它是本地查询而不是分页接口，
`MENTION_LOOKBACK_DAYS = None`——不做 30 天回看限制，否则半年的库会**静默丢掉**
所有更早的结构化提及，而群里 @到本人 恰恰是决策层最需要的证据。

发送和实时读都声明为**不支持**：那是应用的职责（它持有渠道会话与自己的发送授权）。
声明成 true 会让 persona 的 send 去找 PATH 上那个 `dws`——而那个 CLI 登录的是**另一个人**。

### 3. 阈值 → `signals.json` → `thresholds`

每一个「多少算够」的判断都在这一处、有名字、有理由，并计入 `rulesVersion`。
`rulesVersion` 的完整形态是 `signals-v3+<pack>@<version>`——**换 locale 包等同于
改规则**，派生数字必须一起失效，否则就不可复现了。

---

## 产物要能被弱模型执行,而不只是被强模型读懂

这是最容易被忽略的一条:如果技能只是「一堆写得很好的说明」,那回复质量其实来自
**读它的模型有多强**,而不是来自炼化器。换个能力弱一些的模型,它会跳过实时上下文、
忘记按人限定召回、把测出来的 92% 回复率当成「什么都能答」的许可、也想不到该去
核查一个事实到底在不在语料里。

这些都不是语言能力的问题,是**编排**的问题。而编排应该由脚本负责。

所以每一个「可以机械判定」的决定,都必须是一次命令的返回值,而不是一段提示:

| 判断 | 以前 | 现在 |
|---|---|---|
| **在回的到底是哪些消息** | 只看最后一条 | `brief.answering.text` = **整串连发**;`burst.count` 说明是几条 |
| 这条在回什么 | 靠模型自己想到去读上下文 | `brief.respondingTo`(从**连发之前**往回找) |
| 这是什么来意、碰哪些风险类 | 靠模型读 Markdown 表格 | `brief.classification`(用 locale 包的正则算**整串**) |
| 该不该回 | 模型人工对照 Step 4 闸门 | `brief.verdict` + `because` 逐条理由 |
| 这个事实有没有依据 | 纯模型直觉 | `facts` → `evidence` / **`none`** |
| 草稿合不合规 | 散文里写的风格建议 | `check` → `pass`/`warn`/`block` |
| 能不能发 | scope + allowlist + 长度 | **再加草稿内容风险门禁** |

### 连发的一串消息是**一件事**

IM 里一句话经常拆成几条发。原来 `brief` 只拿最后一条去分类,于是

```
连发: 合同金额那边要你签字确认 | 今天给个回复 | 谢谢啦
   只看最后一条 → verdict=reply, mayAutoSend=True, risk=[]      ← 一句「谢谢啦」放行了
   看整串       → verdict=draft, mayAutoSend=False, risk=[approval, money, ...]
```

风险词落在闸门**没读过**的那一条里。在真实语料上量过:5 分钟内同一人连发共 10440 次,
其中 **317 次(3.0%)** 的风险类只出现在前几条——而且这个错**永远朝同一个方向**(朝着发出去)。

现在 `brief` 按 `signals.json → thresholds.burst` 把连发折成一个判定单元:
风险类取**并集**,来意取**最保守**的那个(任一条命中 `alwaysDraftKinds` 就整串按它算)。
折叠只会让结论更严,不会放宽——自测里有一条不变量专门断言这一点。
`inbox` 的候选也带上 `burstCount`,让 agent 知道 `text` 只是最后一条。

### 回几条,是**测出来的**,不是规则

连发折叠刚做完时,我在产物里写了一句「Reply once, to all of it」——**这是我自己的猜测,
语料不支持**。实测:本人的回复里 **41.8% 是多条消息**,而且**因人而异**:

| tone band | 一次回复的中位条数 | 多条占比 |
|---|---|---|
| A(最随意) | 1 | **44.1%** |
| B | 1 | 28.1% |
| C | 1 | 25.6% |
| D(最正式) | 1 | 7.7% |

「总是回一条」和「总是拆开」都是猜。所以这一层归 `analyze.reply_bubbles()` **测量**:
把本人连续的消息按 `bubbleGapSeconds` 归并成一次回复,逐 band 统计,写进
`style.md` / `rules.json` / `brief.styleTargets`。

产物里那句指令**按测出来的数字反转**——45% 的人被告知「每个点各发一条短消息」,
5% 的人被告知「正常就回一条」,测不到就明说测不到。自测里有一条断言这两个方向
**必须产生不同的指令**,防止又退化成一句固定的话。

这一层**纯结构**(只看发送者和时间戳,零正则),所以 **null-locale 下照常测得出来**——
`fidelity.md` 里它属于结构层,不会因为没装语言包就报空。

```bash
persona.py brief  --conversation-id <cid> --single true --peer-open-id <id>
persona.py facts  --query "战队"          # 在不在语料里?
persona.py check  --text "<草稿>"          # 机械校验
```

`brief` 一次调用把实时上下文、来意分类、风险类别、身份解析、按人限定的先例、
风格硬指标、事实核查线索、以及**已经跑完的闸门结论**全部返回。弱模型的工作从
「读 5 个文件并自己编排」变成「读一个 JSON,照 verdict 执行」。

**`references/rules.json`** 是 `decisions.md` 的机器可读孪生:同一份 policy,
一份给人看(带测量率,供强模型权衡),一份给脚本用(只有结论)。两份**必须一致** ——
自测里有一条不变量断言它们逐字相等,我故意植入过分歧,三条检查同时失败。

### 最重要的一处修补:发送前检查草稿内容

原来的 `send` 只查 **收件人**(scope / allowlist / 长度),**从不看要说什么**。
一条写着「批了,我保证周五上线」的草稿会畅通无阻 —— 强模型不会写出那种草稿,弱模型会。

现在风险门禁在 `runtime.DwsClient.send` 里(最底层,唯一真能发消息的地方),
检查草稿本身是否触及风险类别,并且**模式缺失或为空时都 fail-closed**:读不到
`rules.json` 就拒绝自动发,一个检测不到任何风险类的 locale 包同样拒绝 ——
否则草稿会通过一个从未真正跑过的检查。而且它排在 scope 检查**之前** ——
因为「批了」这种草稿在任何 scope 下都是错的,先报「sending is disabled」会让人
以为放宽 scope 就能发。

---

## 出厂质检：`forge report`

```bash
python3 -m forge report              # 覆盖度（确定性、可复跑）
python3 -m forge report --rubric     # 另外生成双 agent 盲测规程
```

发布时自动把覆盖度报告写进 `references/fidelity.md`。两半刻意分开，因为可信度性质不同：

- **覆盖度**（纯 Python）：样本量、活跃天数、用了哪个 locale 包及其判定依据、
  哪些文字它没覆盖、数据源缺哪些能力、每一层证据强度、**以及「这次构建测不到什么」**。
  逐层给 ✅/⚠️，最后给一个**覆盖度等级**（A–D）——刻意叫覆盖度而不是质量分：
  层层都测到了，也不代表像那个人。
- **行为保真度**：`--rubric` 从语料里抽**没发布过**的真实提问当盲测题，
  规程要求**答题 agent 与评分 agent 必须是两个独立 agent**，答题方不知道在被测哪个维度。
  权重最高的维度是**决策保真度（40 分）**——语气再像，回了一个本人根本不会回的问题，
  是失败而不是接近。结果贴进 `fidelity-behavioral` owner 块，随重建保留。

规程文件带答案，**只留在数据根、绝不进产物目录**——能看到答案的答题 agent 不算被测。

（这两点的思路参考了 [nuwa-skill](https://github.com/alchaincyf/nuwa-skill)
的保真度评分卡：LLM 自评 skill 质量的准确率接近随机，所以自评分比没有分更坏——
它看起来像证据。平台适配器一层的分法参考了
[colleague-skill](https://github.com/titanwings/colleague-skill) 的
per-platform collector 结构。）

---

## 这一版修掉了什么

### 0. 过拟合作者自己的语料

炉子不含任何人的**数据**，但曾经把一份语料的**形状**吸进了引擎：所有词法规则是中文正则；
平台是焊死的钉钉（`people.md` 里直接印 `openDingTalkId`，扫描器只认钉钉 id 形状）；
一堆阈值和**注释里的"实测"数字**其实是作者自己的聊天记录。

非中文用户拿到的不是报错，而是一份语法上完整、内容上全空的人格：所有标记计数 0、
所有来意归到 `other_ask`、所有风险类别因「证据不足」判成 `never_settle`、
话术为空——而 `style.md` 还在教他别写「赋能 / 抓手 / 打通」。**没报错才是最糟的。**

现在：locale 包 + 语言无关内核 + source 适配器 + 阈值外置 + `fidelity.md` 明说测不到什么，
并且 `forge scan --scope repo` 会因为引擎里出现任何一个汉字而**扫描失败**——
这条规则本身就是防复发的。自测跨 `zh-CN` / `en` / null 三种 locale 各跑一遍全量语料检查。

### 1. 轮询经常失败、agent 没响应

三个真实原因，都验证过：

- 旧轮询问的是 `list-unread-conversations`（未读会话）。**只要你在手机上看过一眼，
  未读标记就清了**，接口返回 `[]`。实测现在就是空的。
- 旧轮询用 `chat message list --user "" --time 1970-01-01 --direction older` 探测
  "最后一条是谁发的"。这个调用在单聊上**直接报 business error**——单聊必须用对方的
  `openDingTalkId`，不能传会话 id。
- 两种失败都被 `except: return []` 吞掉了。**失败和"没有新消息"输出完全一样**，
  所以 agent 安静地死掉，日志里只剩一行 `{"candidates":0}`。

现在：

- 读**真实消息流**（`chat message list-all`），不依赖客户端未读标记；
- 单聊用 `peerOpenId`（从语料库里取，不额外调接口）；
- **失败就是失败**：`ok: false` 带上错误原文，永远不伪装成"没消息"；
- checkpoint + 去重，一条消息只报一次，崩了能续；
- `skipped` 明细可见（`ownerSpokeLast` / `notAddressed` / …），能区分
  "确实没事" 和 "过滤器把什么都吃了"；
- `inbox.py health` 一条命令看清活没活；`watch` 连续失败 5 次**主动退出**，
  不在坏掉的凭证上安静打转。

### 2. 蒸馏不够准：缺决策层

旧版只有"怎么说"，没有"该不该说"。现在多挖一层，来源是**每一条别人问过的话，
包括本人没回的那些**——沉默是唯一能证明"这类问题不是我该答的"的证据，
只看回复永远看不到。

`decisions.md` 是产出的第一顺位文件：

| 来意 | 出现次数 | 本人回复率 | 默认动作 |
|---|---|---|---|
| 要你拍板/审批 | … | … | 只起草，绝不自动回 |
| 问技术细节 | … | … | 直接答 |
| 催进度 | … | … | 简短回 + 反问范围 |
| 闲聊/FYI | … | … | 经常不用回 |

外加：
- **风险类别硬门禁**（承诺/审批/金额/排期/人事/对外/组织/删除）——
  历史上本人自己拍板的比例低于阈值就是 `never_settle`，证据不足**也**算，
  「没有证据」不等于「可以」；
- **本人真实的转介和拖延话术**（「这个得问一下 X」「回头我看下」），
  agent 需要的是他本人的台阶，不是通用的"我稍后回复您"；
- **本人真实的「先问清是哪一个」话术**（「哪一段」「哪个图片」「…是指?」）——
  见下节；
- **auto-send 候选人**：谁的往来一贯低风险、回得快——只是**测量结果**，
  开权限仍要 `forge autonomy --allow <name>` 明确授权。

### 第三种出口：语料里有提及、但不足以回答

原来 `facts` 只有两个出口：`evidence` 用事实、`none` 说不知道。但它其实还能识别
第三种状态——**主体在语料里有，被问的那部分没有**：

```json
{"verdict":"evidence", "partial":true,
 "corroborated":["新项目"], "notFound":["上线"]}
```

这种情况下含糊回答和直接说不知道都不如**先问清是哪一个**。而这是个可测量的习惯：

```
真正的澄清式反问: 13 / 2009 = 0.65%
  哪一段 · 哪个图片 · 不自动预览是指? · trace是指后端的还是前端的 · 哪个链接,main那个吗?
```

所以做成第五类可挖掘话术（`replyShapes.clarify`），与 handoff/defer/decline 完全同构：
正则在 **locale 包**里（zh-CN / en 各按本语言习惯写），话术**从语料挖**，
`facts` 和 `brief` 都返回 `clarifyOption`。

**两个刻意的取舍：**

- **挖不到就报空,绝不退化成通用的「请问是哪一个？」**——`clarifyOption: []`
  配一条明说「这份语料没有这种习惯,不要自创」。编一句通用问法会让 agent 明显比本人啰嗦。
- **引擎不猜「该不该澄清」**。我试过用「未定指代」当触发器:含指代的消息 211 条,
  她澄清反问的只有 3 条(**98.6% 照常直接答**)。触发条件是语义判断,正则测不出——
  所以只在 `facts` 已判定信息不足时提供「怎么问」,不提供「什么时候问」。

另一个坑:现有的 `openerMixPct.counter_question` 是 12%,但抽样发现绝大多数是
**语气词而非澄清**（「吃啥呢」「点啥呢」）。拿它当澄清率会高估 18 倍,
所以 `clarify` 正则刻意收紧,自测里有一条反向断言「语气词式问句不得判为 clarify」。

### 3. 数据不落全，agent 没法召回

现在**全量存本地**：每个人的消息原文、真实姓名、会话标题、真实 id、引用、@。
理由很直接——agent 判断"这条要不要回"必须看到对方到底说了什么、对方是谁，
哈希做不到这件事。

边界不是内容，是**位置**：语料库 600、数据根 700、`.gitignore`、绝不分享；
**发布出去的 skill** 才受严格约束（无 raw id、无路径、无凭证），
`forge scan --scope skill` 在每次 publish 时自动跑。唯一在写入时就抹掉的是凭证。

---

## 用法

```bash
python3 -m forge doctor        # 出问题先跑这个（含 locale / 数据源 / 覆盖度）
python3 -m forge init  --display-name "<真名>" --since 2026-01-28
python3 -m forge pull  --since full        # 首次全量；之后 --since auto 增量
python3 -m forge build
python3 -m forge publish
python3 -m forge refresh                  # 日常：pull → build → publish
python3 -m forge locales                  # 装了哪些语言包，哪个适配当前语料
python3 -m forge sources                  # 有哪些数据源，各自能做什么
python3 -m forge report                   # 覆盖度报告；--rubric 出盲测规程
python3 -m forge lock                     # 装好的 skill 变只读，别的 agent 改不了
python3 -m forge export --out x.tar.gz    # 打包给另一台机器上的 agent
python3 -m forge inspect
python3 -m forge scan --scope repo        # 仓库能不能公开分享
python3 -m forge selftest                 # 离线自测，无网络、无个人数据
```

全部输出 JSON；碰远端或写盘的都支持 `--dry-run`。

### 给别的 agent 用，且不让它自己调

```bash
python3 -m forge lock
```

装好的每个文件变 `444`。别的 agent 想改 `SKILL.md` 或任何 reference 会直接拿到
`PermissionError` —— **「不要在运行时调整」从一句请求变成文件系统的事实**。读取不受影响；
`forge publish` 仍能重建（写临时文件再 rename，然后自动重新加锁），所以更新只能从炼化器来。
`--unlock` 解锁。

**同一台机器**：不用做别的，skill 已经在 `~/.claude/skills/` 和 `~/.codex/skills/`。

**另一台机器**：`forge export`。包里只有 Markdown + 脚本，**不含语料库、配置、日志、绝对路径**
（导出前自动跑分享扫描，不干净就拒绝导出）。那边 `recall` / `who` / `send` 会返回
`degraded: markdown-only` 并说明原因，而**决策层、风格、关系、场景全部可用** —— 因为它们
本来就是纯 Markdown。

### 增量更新

```bash
python3 -m forge refresh
```

`pull --since auto` 从 checkpoint 续拉（回退 30 分钟重叠，因为消息可能比时间戳晚落库），
`build` 重算全部特征，`publish` 覆盖生成段、保留你的 owner 块。

首次全量回填要一段时间：接口每页硬上限 100 条（传 `--limit 1000` 也一样），
半年约 1000 次调用，且**会被服务端限流**。客户端因此自带节流与退避；
被限流的时间窗会跳过并记进 `gapsToRetry`，**checkpoint 不会跨过缺口前进**，
下次 `--since auto` 自动补齐。

### 放开自主发送

```bash
python3 -m forge autonomy                                    # 看当前状态 + 测量出的候选人
python3 -m forge autonomy --scope allowlist --allow "张三"    # 只对这个人自动发低风险
python3 -m forge autonomy --scope draft_only                  # 收回
```

三档共享同一套硬门禁。**scope 只放宽"给谁发"，放不宽"什么能发"**：
风险类别、"在问你拍板"、发送前复查，三档都一样。兜底永远 `draft_only`。

单线程试运行：在 `persona-config.json` → `inbox.onlyConversationTitles` 里
只填一个会话名。

### 手动修正

- **改语气档位 / 标记敏感人**：`relationship-overrides.json`。
  收紧随便改；放松（S → A）必须显式写 `"trust": true`，不会手滑发生。
- **改文案、加规则**：直接编辑产物文件里的 `<!-- owner:begin ... -->` 块，
  每次 publish 都保留。生成段别手改——会被覆盖，改了也白改。

---

## 目录

```text
im-persona-forge/
├── SKILL.md · README.md · .gitignore
├── forge/
│   ├── cli.py          init/doctor/pull/build/publish/refresh/locales/sources/report/…
│   ├── locale.py       语言包加载 · 字符集判定 · NULL_PACK（诚实降级）
│   ├── locales/        ★ 全部词法规则都在这里，引擎里一个汉字都没有
│   │   ├── zh-CN.json  中文（简体）工作聊天
│   │   └── en.json     英文工作聊天（按英文习惯写，不是翻译）
│   ├── sources/        ★ 平台接缝：引擎只认规范化消息
│   │   ├── __init__.py MessageSource 协议 · capabilities() · 注册表
│   │   ├── dws.py      钉钉（id 词汇 / id 形状 / 客户端卡片 / 时区偏移）
│   │   └── jsonl.py    任意平台的规范化导出（离线，可自测）
│   ├── runtime.py      DWS 客户端 + 语料读取器 —— 原样拷进每个产出 skill
│   ├── store.py        SQLite 全量语料库 + FTS
│   ├── ingest.py       增量可续拉取（checkpoint / 限流退避 / 缺口重试）
│   ├── analyze.py      表达 DNA · 回合配对 · 回复条数 · 来意与沉默（词法全部来自 locale 包）
│   ├── decide.py       决策挖掘：回不回 / 转介 / 先问清 / 永不拍板 / 自主候选
│   ├── relations.py    语气档位 + 逐人回复权限
│   ├── compose.py      测量结果 → 完整 skill 文案 + owner 块保留
│   ├── report.py       ★ 覆盖度报告（fidelity.md）+ 双 agent 盲测规程
│   ├── build.py        语料 → features.json
│   ├── publish.py      装配安装两个 skill（含清理陈旧文件）
│   ├── scan.py         分享安全扫描（含「引擎里不许有词法规则」这条硬规则）
│   ├── selftest.py     617 项离线回归，跨 zh-CN / en / null 三种 locale（fixture 全虚构）
│   └── signals.json    ★ 只剩语言无关的阈值（改了就换 rulesVersion）
└── templates/
    ├── persona/        SKILL.md + scripts/persona.py
    └── inbox/          SKILL.md + scripts/inbox.py
```

产出的 skill：

```text
<slug>-persona/
├── SKILL.md              入口：先判断，再起草；硬规则；发送流程
├── references/
│   ├── decisions.md      ★ 该不该回 · 风险硬门禁 · 本人的转介/澄清话术
│   ├── style.md          句长/反问/软化比/开口方式/高频词/禁用词
│   ├── people.md         逐人语气档位与回复权限
│   ├── scenes.md         场景差异 + 真实回合示例
│   ├── limits.md         窗口、样本量、聊天数据看不到什么
│   ├── fidelity.md       ★ 出厂质检：哪些层测到了、哪些没测到、覆盖度等级
│   └── rules.json        ★ decisions.md 的机器可读孪生 —— 脚本执行的那一份
└── scripts/
    ├── persona.py        brief / facts / check / context / recall / who / fresh / send
    └── imruntime.py      与炉子同一份运行时

<slug>-inbox/
├── SKILL.md              check / watch / health / mark / stop
└── scripts/ inbox.py · imruntime.py
```

本地私有数据在 `~/.claude/user-context/<slug>/`：
`database/persona.db`（全量语料）、`derived/features.json`、
`derived/fidelity-rubric.md`（**带答案，绝不发布**）、
`locale-overrides.json`（本公司专有词，不进发行包）、
`relationship-overrides.json`、`agent-sent.jsonl`、`action-audit.jsonl`、
`inbox-state.json`、`dws-calls.jsonl`。

---

## 自主运行链路

```
<slug>-inbox   inbox.py check      纯发现：哪些消息在等回复（零判断）
     ↓
<slug>-persona persona.py brief     ★ 一次调用:实时上下文 + 分类 + 风险 + 身份
                                   + 按人限定先例 + 风格硬指标 + **闸门结论**
     ↓
<slug>-persona persona.py facts     事实核查:在不在语料里?none 就不许编
               persona.py check     草稿机械校验:超长/风险措辞/禁用语/该拆不拆
     ↓
<slug>-persona persona.py fresh    发送前复查：本人是否已回？有没有更新的消息？
               persona.py send     执行 + 记账（自动发的不污染下次蒸馏）
                                   —— 并再查一遍草稿内容风险,模式缺失就拒发
```

`send` 会按 scope 拦截、把 messageId 记进 `agent-sent.jsonl`
（下次 pull 自动排除，否则 persona 会开始模仿自己），并且无论成败都写审计。
**永远不要直接用 `dws chat message send`**——那条路不记账。

一键停：`python3 <inbox>/scripts/inbox.py stop`

---

## 扩展炉子（贡献者须知）

三条硬规则，`forge scan --scope repo` 和 `forge selftest` 会强制执行：

**1. `forge/*.py` 里不许出现任何自然语言文本。**
需要指定码点范围或单个标记时写 `\uXXXX` 转义，并在旁边注明它是什么。
词法规则去 `forge/locales/<id>.json`，平台自带的卡片文案去
`forge/sources/*.py` 的 `CLIENT_FURNITURE`，某家公司专有的词去操作者本机的
`locale-overrides.json`。**这条规则就是防止这次重构被慢慢磨掉的。**

**2. 加一门语言 = 加一个 locale 包。**
复制 `zh-CN.json`，`id` / `version` / `scripts` / `wordBoundaries` 改掉，
**其余 key 全部保留**（`askKinds` / `riskTags` / `openerShapes` 的 key 是固定的——
引擎和 `compose.py` 的标签表按 key 索引；正则按那门语言自己的习惯重写，
这才是要变的部分）。自测会检查每个随包发布的 locale 都是完整的、
且所有包的分类 key 一致。

计量单位不通用的阈值可以按包覆盖（目前是 `quoteMaxLength`）：40 个码点的中文是
一句完整的话，40 个码点的英文只是个片段。

**3. 加一个平台 = 加一个 source 适配器。**
实现 `MessageSource`（见 `forge/sources/__init__.py` 的协议和规范化消息 schema），
声明 `KIND` / `PLATFORM_LABEL` / `ID_LABEL` / `ID_PATTERN` / `CAPS`，
在 `_REGISTRY` 里登记。**做不到的能力要在 `CAPS` 里说不，并让对应方法抛
`Unsupported`**——返回空列表会让「失败」和「没有」变得无法区分，那正是这套重构
要消灭的一类故障。

改完跑：

```bash
python3 -m forge selftest         # 617 项，跨三种 locale
python3 -m forge scan --scope repo
python3 -m forge scan --scope fixtures   # 见下
```

**测试 fixture 必须是编的，不能是记下来的。** 自测用的假语料是虚构的
（`小美`/`Sam`/`build-bot` 在真实语料里都是 0 命中），但写 fixture 的人是**看着真实
输出写的**，一句有辨识度的话很容易就被带过去 —— 而带过去之后，从代码上再也看不出
它是编的还是抄的。

所以这件事不靠自觉，靠机械核对：`forge scan --scope fixtures` 拿
`forge/selftest.py` 里的长短语去比对**你自己的语料库**，两边都出现就报出来。
它是独立 scope，因为它需要读语料 —— 而其他几个 scope 绝不许碰语料库。

判定用两个信号：短语**够长**（7 字以上，在中文里已是句子片段而非常用表达）
**且在语料里很少见**（<5 条）→ `high`，要求重写；否则 `info`，人扫一眼即可。

---

## 隐私边界

- 原始与派生数据只在本机；不读取 / 解密 / 保存 DWS token。
- 凭证在写入时就抹掉（唯一的例外性删除）。
- 发布出去的 skill：无 raw id、无 home 路径、无凭证——publish 时自动扫。
- 语气档位是观测到的互动习惯，不是对感情的判断；不比较人，不对外提档位。
- persona 不生成承诺、审批、金额、排期、人事评价、对外立场或未确认事实。
- 分享包绝不包含任何人的聊天、语料库、关系账本或炼好的人格。
