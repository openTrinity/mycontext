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
   | `forge/publish.py` | `_assert_publishable` + `ownsOutput` 门禁；`_prune` 扫空的 skill 根 | **悄悄往 `~/.claude/skills` 写**；残留空目录被当成装好的 skill |
   | `forge/cli.py` | `CONFIG_TEMPLATE` 的 `ownsOutput` | 门禁读不到开关，等于没开 |
   | `forge/compose.py` | `rules.json` 里发布 `policy.freshness` | 装好的 skill 读不到滞后阈值 → 退回内置默认值 |
   | `forge/signals.json` | `thresholds.freshness`；`rulesVersion` = `signals-v5` | 同上；版本串对不上导致派生数字无法追溯 |
   | `forge/runtime.py` | `HostStore`（读宿主库 + 报滞后） | `context`/`fresh` 退回「必然 degraded」 |
   | `forge/ingest.py` | `MENTION_LOOKBACK_DAYS` + 失败原因由 source 给 | @提及只回看 30 天；诊断指错方向 |
   | `forge/sources/jsonl.py` | `unusableRows` / `unusableReason` | 上游 jsonl 路径的 `complete` 判定失效 |
   | `templates/persona/scripts/persona.py` | `_tail_with_lag` 三档读 + `fresh` 的滞后判据 + `_threshold` | ★ **发送前的滞后闸失效**：库落后时照样发 |
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
