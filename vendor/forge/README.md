# vendor/forge — 内置的 im-persona-forge 蒸馏引擎

这里放的是**源**，不是构建产物：`pnpm prepare:bin` 从这里拷到
`apps/desktop/resources/forge/`（后者被 gitignore）。

上游：`im-persona-forge`。一套**纯 stdlib Python、零模型调用**的确定性测量引擎，
把一个人在工作聊天里的沟通方式炼化成可执行的 Agent Skill。

## 为什么内置而不是装依赖

- **零 pip 依赖**：只用标准库，所以「内置源码」等于「装好了」，不需要 venv、
  不需要 `pip install`，也不会因为用户机上某个包的版本不同而行为不同。
- **30 个文件 / 1.4MB 纯文本**：普通 git blob 完全可接受，diff 可读。
  与 `vendor/dws` 那 21MB 二进制的取舍不同 —— 那边入 git 是为了省掉「每人配一次环境」，
  这边入 git 顺带让**代码审查成为可能**。
- **Python 解释器不内置**：走系统 `python3`。缺失**不是错误**，应用降级并在状态页
  明示（与 `opencode` 同一档策略，见 `scripts/prepare-bin.mjs` 的注释）。
  内置一个解释器要几十 MB，与「102MB 不入 git」那条既有决策冲突。

## 解释器要求

**Python ≥ 3.9**。macOS 自带的 `/usr/bin/python3`（3.9.6）实测可用，
完整自测（728 项）在 3.9.6 与 3.13 上都全绿。

## 目录内容

| 路径 | 说明 |
| --- | --- |
| `forge/` | 引擎本体（测量 · 决策挖掘 · 产物装配 · 自测） |
| `forge/locales/` | 语言包（`zh-CN` / `en`）—— **全部词法规则都在这里** |
| `forge/sources/` | 平台接缝：`dws`（钉钉 CLI）· `jsonl`（离线导出）· **`vault`（本仓库的语料库，含近实时读）** |
| `forge/signals.json` | 语言无关的阈值，改了就换 `rulesVersion` |
| `templates/` | skill 模板（persona）—— 见下「inbox 包已删除」 |
| `SKILL.md` | 上游给 agent 的入口说明 |
| `UPSTREAM-README.md` | 上游完整设计文档（含每条取舍的理由） |
| `VERSION` | `signals.json` 的 `rulesVersion`（当前 `signals-v5`），升级时比对用 |
| `SHA256SUMS` | 每个文件的 hash |

### `vault` 源是本仓库加的

上游的 `dws` 源自己调钉钉 CLI 采集。本应用**已经有**采集（两级轮询、水位、
截断二分、幂等键）和身份权威表，所以 `vault` 源不拉取，只把 `core.sqlite`
投影成规范化消息，复用上游的 `ingest.pull`。

三条与其他源不同的约束（都写在 `forge/sources/vault.py` 的模块注释里）：

- **`is_self IS NULL` 排除并计数**，不补 0。那是「还没判定」而不是「别人」——
  补 0 会把本人的话算成别人的，而之后没有任何信号能纠回来。
- **`confirmed_at` 为空拒绝启动**，不先用着。
- **只读**（`mode=ro`）：那个库属于应用，可能正在被写。

### 「近实时读」：为什么不是 `tail`，也不是「必然 degraded」

上游只有两档：要么调 CLI 拿实时（`tail: true`），要么读 forge 自己的语料库并
警告「可能落后几小时」。对本应用两档都不对——应用的采集是 L1 探针 15s–120s 自适应
加 **L2 固定 2 分钟无条件兜底**，所以那个库是**分钟级**新鲜的，不是小时级。

所以 vault 源声明第三档 `recentReads: true`，语义刻意与 `tail` 区分：

| | 承诺 |
| --- | --- |
| `tail: true` | 「你读到的就是现在」 |
| `recentReads: true` | 「几乎是现在，**而且我会告诉你差多少**」 |

`recent_messages()` 因此必须连 `lagSeconds` 一起返回，取自应用自己的
`sync_cursors.watermark`（「已完整落库到此」）——不是最新消息的时间戳：
一个安静的会话会因此报出几小时滞后而看起来坏了，而实际上采集完全正常。
**取不到就报 `None`（未知），绝不报 0。**

发送前的 `fresh` 因此有了第三条判据（与「本人已回」「有更新消息」并列）：
滞后超过 `thresholds.freshness.maxLagSeconds`（150 秒）即判 stale。150 是
2 分钟兜底周期加余量——采集本身要花时间，卡在恰好 120 会在健康系统上误判。
**未知滞后也算 stale**：把未知当成 0，与「完全同步」在最需要区分的那一刻
长得一模一样，而那一刻之后消息已经发出去了。

### `inbox` 包已删除

上游产出两个 skill，`<slug>-inbox` 只做一件事：轮询平台找等回复的消息。
本应用**已经有那套**（两级轮询 + Outbox 消费者 + `Mailbox` 合并窗口 +
`message_mentions` 结构化 @判定），而且做得更细 —— 也就是那个包在这里
从来没有消费者（vault 源 `tail: false`，`publish` 本来就跳过它）。

所以整个 `templates/inbox/` 连同 `publish.py` 里的打包分支一起删掉了。
留着一个不会被发布、也没人读的模板，代价不是那几百行，而是它会让
读代码的人以为消息发现这件事有两个实现。

`staleAfterMinutes`（测出来是 90 分钟）**保留**：它现在喂 persona 自己的
`fresh` 检查，并发布在 `rules.json` 的 `policy` 里。配置组也因此从
`inbox` 改名成 `replyWindow` —— 那两个只有 inbox 用的标题过滤键
（`denyConversationTitles` / `onlyConversationTitles`）一起删了。

### 产物落点：userData，按 vault 隔离

★ 上游 `forge init` 的默认 `skillRoots` 是 `~/.claude/skills/<slug>-persona` 与
`~/.codex/skills/<slug>-persona`。对「自己给自己炼画像」那是对的（就是要让本机
agent 加载它），对本应用是**三重错误**：

- 那是**运行这台机器的人**的 agent 配置目录，应用无权往里写；
- 上游默认值只有一份，**多账号会打在同一路径上互相覆盖** —— 而画像错人不可逆；
- **卸载应用带不走它**，`userData` 删掉才是干净的。

所以路径一律由应用给出（`VaultStore.forgeRoot()` / `skillRoot()`）：

```
<userData>/vaults/<vaultId>/
├── core.sqlite          语料（应用拥有）
└── forge/               ← 蒸馏的一切派生物，vault 删了就一起没了
    ├── database/        forge 自己的派生库
    ├── derived/         features.json
    ├── owner-blocks.json  ★ 用户手改的 owner 块，必须持久化
    └── skills/          发布出的 persona skill 包
```

本仓库另给 `publish.py` 加了一道 `ownsOutput` 门禁：置 true 时**拒绝**写入
`~/.claude`、`~/.codex`、`~/.cursor` 等目录。两边都设防，因为「记得传对路径」
不是可依赖的保证 —— 而这个错误一旦发生是静默的：skill 装上了、能用，
只是出现在了一个没人打算改动的 agent 里。

个人直接用 forge 时不受影响：`ownsOutput` 默认 false。

### 时间衰减与测量窗口（本仓库加的，`signals-v6`）

上游把语料当成一个**没有时间维度**的集合：每条消息等权。对「炼一次画像」是对的，
对本应用不对 —— 这里的语料由采集器持续追加，只增不减。于是半年前的习惯会永久
与本周等权，而这件事有三个具体后果，且全部是静默的：

- 词汇表里一个已结项目的黑话永远排在前面（它出现过的天数更多）；
- 换组半年的同事仍停在 band A，而 A 带 `autoAnswer: low-risk allowed`；
- **最严重**：某个 ask kind 三月起就不管了，但一二月答得很勤，累计答复率仍然高 →
  `defaultAction` 仍是 `answer` → agent 替本人回一类他早就不负责的事。

所以加了两个**互相独立**的旋钮。分开是因为它们回答不同的问题，混成一个就没法
分别提问了：

| | 语义 | 配置 |
| --- | --- | --- |
| **衰减** | 旧证据**算得少**（半衰 90 天，有下限不到 0） | `signals.json → recency` |
| **测量窗口** | 旧证据**完全不算**，且在 `limits.md` 里说出来 | `build --window-days` / `measureWindowDays` |

三条硬约束，破一条就会把「衰减」变成新的静默失效源：

1. **锚点是语料的最后一天，不是 `now()`。** 用 `now()` 会让同一份语料明天测出
   不同结果 —— 而「同语料 + 同 signals ⇒ 同输出」是整个引擎的立足点；且一份停止
   采集的语料会自己一路衰减到下限，没有任何消息变化。
2. **`verification` 那两个证据门槛（`minSupport` / `minDistinctDays`）读原始计数。**
   加权它们会让「有证据但很旧」被报成「证据不足」—— 那是两句不同的话，而分清它们
   正是 `fidelity.md` 存在的全部理由。所以每个桶都同时存加权数与原始数。
3. **衰减只能收紧，不能放权。** 风险门与自动发送候选要求**加权与原始两个透镜都过**
   才放行。否则安静一个季度就能让某个风险类的加权 settle 率越过 40%，
   翻成 `sometimes_settles` —— 也就是衰减凭空造出一份授权。

「近 N 天」那个率是**并列发布**的（`decisions.md` 多一列 Recently，超过
`driftPoints` 打 ⚑changed），不是替换掉全窗口那个：一个数说不出「他以前答、
现在不答了」，而那恰恰是 agent 替人回话之前最该知道的一句。折成一个平均值
会把趋势藏起来 —— 与 `_finish()` 同时报中位数和均值让偏度可见是同一个道理。

`forge selftest` 里有 21 条针对这些不变量的断言（`_recency_suite`），
包括「衰减单独不能放松风险门」和「窗口不删任何语料」。

### work 层：应用往 skill 包里加的那一个文件

产物目录里有一个**不是 forge 写的**文件：

```
<vault>/forge/skills/persona-persona/
├── SKILL.md              forge 写
├── references/
│   ├── style.md          forge 写（测量值）
│   ├── decisions.md      forge 写（测量值）
│   ├── …
│   └── work.md           ★ 应用写（LLM 抽取）
```

`work.md` 是「他负责什么、怎么做事、定过什么规矩」。这几样**没有结构化信号**
—— 一个人负责哪个系统这件事不体现在他消息的长度、时间或词频里，只体现在他
说的话里，所以数不出来。而 forge 的前提是零模型调用，于是这一层走
`packages/distill` 的 LLM 抽取（facet：`ownership` / `workflow` /
`artifacts` / `knowhow`），产物落进同一个包 —— 因为对加载 skill 的 agent 来说
那是**一个**包。

两处必须让 forge 知道「这个文件不是我的」，否则各是一种静默失效：

| 机制 | 不豁免会怎样 |
| --- | --- |
| `_prune` | 下一轮 `publish` 把它当成"上一版的残留"**删掉**，而且报成普通清理。应用按自己的节奏又写回去 → 文件存在与否取决于谁最后跑，抽它花的 token 白烧 |
| `lock` | 锁成 444 → 应用下一轮重写 `PermissionError`。而那条路是定时跑的，表现为「work 层悄悄不更新了」 |

登记方式是配置里的 `externalSkillFiles`（`ForgeService.writeConfig` 写，
常量 `WORK_LAYER_SKILL_PATH` 是单一真源）。只在 `ownsOutput: true` 时生效 ——
个人自己跑 forge 时没有宿主应用，豁免会让真正过期的文件永远留着。

★ **能力不是授权。** `work.md` 说的是「他会做什么」，而「agent 能不能替他答」
只由 `decisions.md` / `rules.json` 决定（答复率、风险类、never_settle）。
所以它进 `references/` 而**不进** `rules.json`（脚本读的唯一真值），
文件开头也明写了这一句。混起来不报错：agent 会拿着一份很有底气的能力清单
去答一个本该草稿的问题，而每一层看起来都在正常工作。

★ **它与 forge 的更新节奏刻意不同。** forge 每 6 小时全量重跑（免费）；
work 层每轮几万 token，所以走攒批（`packages/distill/src/work-refresh.ts`：
首次 / 攒够 200 条 / 攒够 3 天且有新数据，失败指数退避）。挂同一个定时器
就是每天 4 次为同一批老语料付钱 —— 而那正是 LLM 那半当年被关掉的原因。

### 为什么有 SHA256SUMS

forge 是**会被 spawn 执行**的第三方源码。「有人顺手改了 vendor 里一行 Python」
与「上游升级」在 diff 里长得一样，hash 让两者可区分。

`check:vendor-integrity` 另外拦**未登记的文件**：逐行比对只证明清单里的文件没变，
不证明盘上没有清单外的文件 —— 而 Python 的 import 不要求那个文件出现在任何清单里。

## 升级步骤

1. 从上游取新版本，**逐目录同步**（排除缓存与任何本地数据）：

   ```bash
   SRC=<上游仓库根>
   rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' \
     --exclude '.DS_Store' "$SRC/forge/"     vendor/forge/forge/
   rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' \
     --exclude '.DS_Store' "$SRC/templates/" vendor/forge/templates/
   install -m 644 "$SRC/SKILL.md"  vendor/forge/SKILL.md
   install -m 644 "$SRC/README.md" vendor/forge/UPSTREAM-README.md
   ```

2. **恢复本仓库的改动**。`rsync --delete` 会把上游版本盖回去，而下面这些是本仓库
   加的 —— 少一处都是静默失效（功能照跑，只是行为不对）：

   | 文件 | 本仓库的改动 | 丢了会怎样 |
   | --- | --- | --- |
   | `forge/sources/vault.py` | 整个文件（上游没有）：vault 源 + `recent_messages` / `collection_lag` / `conversationIds` 蒸馏范围 | 蒸馏报 `unknown message source 'vault'` |
   | `forge/sources/__init__.py` | 注册表的 `vault` 一行、`recentReads` 能力、`recent_messages` 协议、`MENTION_LOOKBACK_DAYS` | 同上；@提及只回看 30 天 |
   | `forge/publish.py` | `_assert_publishable` + `ownsOutput` 门禁；`_prune` 扫空的 skill 根；**`external_files` / `_prune` 与 `lock` 对宿主自有文件的豁免** | **悄悄往 `~/.claude/skills` 写**；残留空目录被当成装好的 skill；**应用写的 `references/work.md` 被下一轮 publish 静默删掉**（prune 报成普通清理），且 `lock` 会把它锁成 444 让应用重写 PermissionError |
   | `forge/cli.py` | `CONFIG_TEMPLATE` 的 `ownsOutput` / `measureWindowDays` / `externalSkillFiles`；`build --window-days` | 门禁读不到开关，等于没开；测量窗口这个旋钮消失；work 层产物失去豁免（见上一行） |
   | `forge/compose.py` | `rules.json` 里发布 `policy.freshness`；决策表的「Recently」列与 ⚑changed、`recentlyDriftedAskKinds`、`limits.md` 的窗口/衰减说明 | 装好的 skill 读不到滞后阈值 → 退回内置默认值；**衰减后的数字照发但不说自己被衰减过**（读的人会拿它跟旧构建比，把衰减当成行为变化） |
   | `forge/signals.json` | `thresholds.freshness`；**`recency` 整组**；`rulesVersion` = `signals-v6` | 同上；版本串对不上导致派生数字无法追溯；**时间衰减静默关掉**（半年前的习惯重新与本周等权 —— 见下） |
   | `forge/analyze.py` | `Recency` / `corpus_anchor_day` / `_weighted_percentile`；`Rules(…, anchor_day)` 与 `window_clause`；`_fold`/`_finish`/`vocabulary`/`reply_bubbles` 的加权 | **洞 2 回归**：一个早就不管的 ask kind 因为累计答复率高，`defaultAction` 仍是 `answer` —— agent 替本人回一类他已经不负责的事 |
   | `forge/decide.py` | 四套并行计数（加权 / 原始 / 近窗）；漂移降级；风险门与自动发送候选的「两个透镜都要过」 | 同上；且**衰减会变成放权**：安静一个季度就能让某个风险类的加权 settle 率越过 40% 翻成 `sometimes_settles` |
   | `forge/relations.py` | `_weighted_volumes`：band 按加权互动量算 | 换组半年的同事永久停在 band A，而 A 带 `autoAnswer: low-risk allowed` |
   | `forge/report.py` | `fidelity.md` 里的衰减与测量窗口说明 | 覆盖度报告不说自己被衰减过 —— 「未测到」与「测到了但很旧」再次混为一谈 |
   | `forge/build.py` | `build(cfg, window_days)`、`_window_start`、`meta` 里的 `corpusWindow`/`measureWindow`/`recency` | 窗口与衰减都失效；`limits.md` 把语料全跨度当成测量跨度报出去 |
   | `forge/runtime.py` | `HostStore`（读宿主库 + 报滞后） | `context`/`fresh` 退回「必然 degraded」 |
   | `forge/ingest.py` | `MENTION_LOOKBACK_DAYS` + 失败原因由 source 给 | @提及只回看 30 天；诊断指错方向 |
   | `forge/sources/jsonl.py` | `unusableRows` / `unusableReason` | 上游 jsonl 路径的 `complete` 判定失效 |
   | `templates/persona/scripts/persona.py` | `_tail_with_lag` 三档读 + `fresh` 的滞后判据 + `_threshold` | ★ **发送前的滞后闸失效**：库落后时照样发 |
   | `templates/persona/SKILL.md` | 参考件索引表里的 `references/work.md` 一行 | ★★ **work 层整层白做**：产物照写、每轮照付费抽取，而 ACP 路的 agent 不知道有这个文件 → 没人读（不报错） |
   | `forge/selftest.py` | vault 套件 + 落点 / 滞后 / 蒸馏范围 断言 | 以上全部失去回归保护 |

   `tests/unit/forge-vendor.test.ts` 会断言 `vault` 源仍然注册着，
   而 `forge selftest` 会断言落点门禁仍然生效 —— 但**先跑一遍再提交**。

3. 更新 `VERSION`（取 `forge/signals.json` 的 `rulesVersion`）；
4. 重算 hash：

   ```bash
   find vendor/forge -type f -not -name 'SHA256SUMS' -print0 \
     | sort -z | xargs -0 shasum -a 256 > vendor/forge/SHA256SUMS
   ```

5. 跑上游自测 + 本仓库门禁，两者都必须全绿：

   ```bash
   (cd vendor/forge && python3 -B -m forge selftest)  # 728 项，离线，无个人数据
   pnpm verify
   ```

## 许可

上游代码版权归其作者所有，本仓库内置分发以便随包交付。
