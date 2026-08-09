/**
 * 采集服务：把渠道插件、调度器、Outbox 消费者接成一个可启停的循环。
 *
 * ## 为什么服务层这么薄
 *
 * 时间窗规则、幂等、同事务写入、消费者租约这些**正确性相关**的逻辑
 * 全在 `@mycontext/ingest` 里（纯 Node，可单测）。这一层只做三件事：
 * 定时器、生命周期（登录/登出时挂载与卸载 vault）、把状态推给 UI。
 *
 * 这个切分不是洁癖：采集的 bug 几乎都是"边界条件下丢消息"，
 * 而那类 bug 只能靠注入时钟的单测抓 —— 如果逻辑写在服务里，
 * 就得起 Electron 才能测，实际上等于测不了。
 *
 * ## 快通道
 *
 * 入库事务提交后额外发一个**进程内信号**（不走 Outbox 轮询）：
 * 数字人要 15-20s 内响应 @我，而 Outbox 是「可靠但有延迟」的通道。
 * 信号丢了不影响正确性 —— 消费者侧有定期兜底扫描，两条路按 message_id 去重。
 * 这是「快通道 + 慢兜底」，不是两套真源。
 */
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import type { Clock, Logger } from "@mycontext/kernel"
import { isAppError } from "@mycontext/kernel"
import type { ChannelConversationItem, ChannelPlugin } from "@mycontext/channels"
import { createDistillHandler, DISTILL_CONSUMER_ID } from "@mycontext/distill"
import {
  createPersonaFastPath,
  createPersonaInboxHandler,
  PERSONA_CONSUMER_ID,
  type PersonaSupervisor,
} from "@mycontext/persona"
import {
  createFtsHandler,
  FTS_CONSUMER_ID,
  IngestScheduler,
  AdaptiveInterval,
  newId,
  normalize,
  OutboxConsumer,
  persistBatch,
  persistMinutes,
  persistDocuments,
  sha256,
  type PullWindow,
} from "@mycontext/ingest"
import {
  ChangelogRepository,
  collectStorageStats,
  ConsumerCursorRepository,
  ConversationRepository,
  FtsIndexRepository,
  MediaAssetRepository,
  MessageRepository,
  MinutesRepository,
  MinutesCoverageRepository,
  DocumentRepository,
  PersonaRunRepository,
  RetentionRunner,
  ProbeSnapshotRepository,
  SelfIdentityRepository,
  readCollectionScope,
  isConversationInScope,
  isSentAtInScope,
  purgeOutOfScopeMessages,
  type CollectionScope,
  type PurgeReport,
  type MessageRow,
  type SqliteDatabase,
} from "@mycontext/store"

/** L1 探针基础周期。实测探针约 0.7s，15s 是「够快且不浪费」的折中。 */
/**
 * L1 探针**基础**周期的默认值。
 *
 * ★ 默认 10 秒（用户可在设置页 5–120s 间调，见 `IngestServiceOptions.intervals`）。
 * 实测探针约 0.7s，10s 是「够快且不浪费」的折中；`AdaptiveInterval` 仍会
 * 在探针变慢时自动降频。之前写死 15s，现在是可配置的默认。
 */
const PROBE_INTERVAL_MS = 10_000
/** 降频上限：再慢就该告警而不是继续退让。 */
const PROBE_INTERVAL_MAX_MS = 120_000
/** L2 正文兜底周期。即使探针无命中也跑 —— 探针有已读会话的盲区。 */
const PULL_INTERVAL_MS = 2 * 60_000
/**
 * 听记轮询周期。
 *
 * 30 分钟：会议是**稀疏**事件（实测该账号 22 场覆盖数月），而每轮都要把
 * `minutes list all` 抽干（没有水位可推，见 `tickMinutes`）——
 * 成本大致固定：实测一页约 0.8s，22 场会 = 2 页 ≈ 1.6s。
 * 按消息那样 2 分钟一轮等于每小时 30 次无谓的全量抽干。
 */
const MINUTES_INTERVAL_MS = 30 * 60_000
/**
 * 文档轮询周期。**分两档**（见 `documentsInterval()`）。
 *
 * ## ★★ 为什么必须分档：60 分钟 × 5 篇 = 冷启动要 8.7 天
 *
 * 原来只有一个 60 分钟 + 每轮 5 篇。两个数字各自都有理由
 * （文档变更频率低；一轮列举成本不小，要给消息侧让出 busy 锁），
 * 但**没人把它们相除**：
 *
 * 实测这台机器 `documents` 表 1147 篇，可读后缀 1043 篇，而**只有 4 篇
 * 取到了正文**。按 5 篇/小时补 1039 篇 = **8.7 天连续运行** ——
 * 而桌面应用开开关关，实际累计跑过的轮次寥寥。
 *
 * 而下游代价是实打实的：导出侧只导有正文的（没正文的进图只是空 chunk），
 * 于是 kl 只看到 4 篇文档。而实测文档的信息密度远高于聊天
 * （44 个 wiki chunk 产出 158 条事实，占全图 18.7%，而 chunk 数只占 2.4%）
 * —— 补齐那 1039 篇粗估能多出一万多条事实，是现在整个图的十几倍。
 *
 * ## 参数是从听记抄的，而两者规模差 52 倍
 *
 * `DOCUMENTS_BODY_PER_ROUND` 的原注释是「与听记同一个理由，但给多一点
 * （5 vs 3）」。听记 20 条，3 篇/轮 30 分钟一轮 → 3.3 小时补完，够用。
 * 文档 1043 篇，同一套参数搬过去慢了 60 倍 ——
 * 决定时参照的是**单次调用成本**，没有参照**队列长度**。
 *
 * ## 分档：追平前后是两种工况
 *
 * · **冷启动**（还缺 >`DOCUMENTS_BACKLOG_THRESHOLD` 篇）：10 分钟 × 20 篇
 *   = 2880 篇/天 → 一天内追平。这一档只在首次接入/清库重来时存在；
 * · **稳态**（追平了）：60 分钟 × 5 篇 = 原来的参数，原来那些理由
 *   （低频变更、让出采集锁）**在稳态下全部成立**，所以一个字不改。
 *
 * 也就是说这不是"把保守参数调激进"，而是让那些理由只管它们该管的那一段。
 */
const DOCUMENTS_INTERVAL_MS = 60 * 60_000
/**
 * 冷启动档的轮询周期。10 分钟。
 *
 * ★ 不敢再快的理由仍然成立：一轮要跑 `wiki space list` + 每库递归
 * `node list`（实测 20+ 个库）+ `drive recent` 翻页，且占着 busy 锁 ——
 * 消息侧的 2 分钟一轮在等它。10 分钟给了 6 倍提速，同时一小时里
 * 仍有 50 分钟完全不碰采集锁。
 */
const DOCUMENTS_INTERVAL_BACKLOG_MS = 10 * 60_000
/**
 * 还缺多少篇才算"冷启动"。
 *
 * 50：一天的稳态产能（5 × 24 = 120）能覆盖它，也就是跨过这条线之后
 * 稳态速率追得上，不会在阈值上下反复抖。
 *
 * ★ 判据只算**可读后缀**（`countMissingBody` 按白名单过滤）——
 * 不过滤的话那 104 篇永远取不到正文的表格/图片会让判据恒为真，
 * 于是永远跑冷启动档（每 10 分钟跑一轮全量列举，一天 144 次）。
 */
const DOCUMENTS_BACKLOG_THRESHOLD = 50
/**
 * 单轮最多补几篇文档正文（稳态档）。
 *
 * 与听记的 `MINUTES_BODY_PER_ROUND` 同一个理由，但给得多一点（5 vs 3）：
 * 文档正文是**一次** CLI 调用（听记要两次：summary + transcription），
 * 且 `doc read` 实测 0.3-0.8s。5 篇约 2-4 秒，可接受。
 *
 * ★ 这个值只管**稳态**。冷启动走 `DOCUMENTS_BODY_PER_ROUND_BACKLOG`
 * —— 原注释说"不要为了快点补齐把它调大，补齐是几轮之后的事"，
 * 而实际是 5000 轮之后（见 `DOCUMENTS_INTERVAL_MS` 那段算术）。
 */
const DOCUMENTS_BODY_PER_ROUND = 5
/**
 * 冷启动档单轮补几篇。20 篇 × 0.3-0.8s ≈ 6-16 秒。
 *
 * ★ 这是这次改动里唯一真正"更占锁"的地方，所以给了上限而不是不设限：
 * 16 秒的最坏情况下消息侧最多晚一轮（它的周期是 2 分钟）。
 * 而串行 100 篇会占到一分钟以上 —— 那时探针命中的新消息会被推迟，
 * 那是用户能感知的（"消息怎么半天不出现"）。
 */
const DOCUMENTS_BODY_PER_ROUND_BACKLOG = 20
/**
 * 单轮最多补几条听记正文。
 *
 * ## ★★ 抽干转写之后这个数的成本涨了一个数量级
 *
 * 从前一条听记的正文 = 2 次 CLI 调用（summary + 转写第一页）。
 * 抽干之后是 **1 + N** 次，而 N 按实测是会议时长 / 6 分钟：
 *
 * | 会议时长 | 转写页数 | 该条的调用数 | 耗时（每页约 0.7s） |
 * | --- | --- | --- | --- |
 * | 106 分钟 | 18 | 19 | 约 13s |
 * | 138 分钟 | 21 | 22 | 约 15s |
 * | 343 分钟 | 40（撞上限） | 41 | 约 29s |
 *
 * 所以 3 条/轮的最坏情况约 **90 秒**（三场都是马拉松会）。
 *
 * ★ 这个开销**不挡消息侧**：听记走 `inFlightMinutes` 这个独立守卫，
 * 不占 `this.busy`（消息侧的 `tickPull` 与定向补拉抢的是那把锁）。
 * 所以它跑 90 秒也不会让新消息晚到 —— 这一点是抽干可以做得这么激进的前提。
 *
 * 仍然保持 3 而不是调小：会议是稀疏事件（实测 22 场），3 条/轮 ×
 * 30 分钟一轮 = 约 4 小时补完全部历史，一次性成本，之后每轮只补新增的。
 */
const MINUTES_BODY_PER_ROUND = 3
/**
 * 听记列表最多翻几页。
 *
 * ## ★★ 为什么必须抽干，而首版"只取首页"是一个静默的数据缺失
 *
 * 首版注释写的是「一期只取首页：低频任务不必一轮翻完全部历史，
 * hasMore 的后续页由下一轮的 cursor=null 重新覆盖到最新的那批」——
 * **后半句是错的**：每一轮都从 `cursor=null` 开始，所以永远只覆盖最新的
 * 那一页，历史页**一次都不会被访问**。
 *
 * 而这个缺失当时没有任何出口（不落库、不上报、不记日志）：状态页的听记
 * 计数稳定停在一页的量，与"这个账号一共这么多会"完全同形。
 *
 * ## 20 页够不够（按实测的页大小算）
 *
 * 实测 `--limit` 的**硬顶是 20**（2026-08-09，传 50/100/200/1000 都回 20，
 * 见 `MINUTES_PAGE_LIMIT` 的注释）。所以 20 页 = **400 场会议**。
 * 实测那个账号一共 22 场（2 页抽干），400 留了近 20 倍余量。
 *
 * 这个上限的主要作用其实是**挡住病态响应**（`nextToken` 不前进导致原地
 * 打转），与 `conversations.ts` 的 `GROUP_MAX_PAGES` 同一个角色。
 *
 * 撞上限时把 `drained: false` 落进 `minutes_coverage` —— 截断必须可见。
 */
const MINUTES_MAX_LIST_PAGES = 20
/**
 * 单页条数。与截断检测的 90% 阈值配合使用。
 *
 * ## ★ 为什么是 100 而不是 50
 *
 * 实测 `chat message list-all` 的 `--limit` 硬上限就是 **100**
 * （传 200/500/1000 都只回 100 条，无警告）。原值 50 让翻页次数、
 * CLI 调用数与耗时**全部翻倍**而没有任何补偿收益：
 * 同一个 4 天窗 limit=50 要 82 页，limit=100 只要 48 页。
 *
 * 截断检测用的是「本页条数 ≥ 90% × PAGE_LIMIT」这个**相对**阈值，
 * 所以改这个数不需要同步改那边的判据。
 */
const PAGE_LIMIT = 100
/**
 * 逐会话抽干的单会话翻页预算。
 *
 * 实测密度：一个活跃群 4 天 636 条 = 7 页（limit=100）；最密的单聊
 * 4 天 1138 条 ≈ 12 页。给 60 页（6000 条）留足几倍余量，
 * 同时挡住"响应形状异常导致原地打转"这类病态情况。
 *
 * 不给更大：定向补拉占着 `busy` 锁，而消息侧在等
 * （与 `MAX_PAGES_PER_BACKFILL_ROUND` 同一个理由）。抽不完下一轮接着来 ——
 * 循环的起点是"库里这个会话的最新一条"，所以它天然可续跑。
 */
const MAX_PAGES_PER_CONVERSATION = 60
/**
 * 翻页时往回让的重叠量。
 *
 * ## ★★ 这一秒不是保险，是**必需**的
 *
 * 服务端的时间边界是 **exclusive**，而 `createTime` **只到秒**。
 * 实测：以「本页边界那一秒」当下一页 `--time`，**该秒的其余消息
 * 永久丢失** —— 两种朴素推进法各丢 24 条，且丢的不是同一批。
 * 而单页内同秒多条是常态（实测一页 96 个不同秒里就有重复秒）。
 *
 * 代价是边界那批会重复返回，所以调用方**必须**配 id 去重
 * （`payload_hash` 兜住"不产生重复行"，但兜不住"原地打转烧满预算"）。
 */
const PAGE_OVERLAP_MS = 1_000
/**
 * 单轮翻页预算，防止异常响应导致无限翻页。
 *
 * ## ★ 为什么是 600 而不是 50
 *
 * 首版是 50，而这个值与 `PAGE_LIMIT`（单页 50 条）**不是一回事** ——
 * 它们只是碰巧同值，混起来看会以为"一轮 50 条"。
 *
 * 实测这个账号 7 天窗内有 **2529 条**消息 → 需要 **51 页**才抽得干。
 * 预算 50 页时首窗永远抽不完 → `confirmedEnd` 恒为 null →
 * **水位永不前进（活锁）**：每轮烧满 50 次 CLI 调用、把同一段历史反复重拉，
 * 而日志里只有一句 `page budget exhausted`。
 * 实测复现：连续 5 轮各 50 页，第 3/4/5 轮各新增 **0 条**，水位始终是 0。
 *
 * 而 2529 条只是个**轻量**账号（一个活跃的几百人群一周就能过万）。
 * 所以这个上限的作用应该是"挡住病态响应导致的无限循环"，
 * 而不是"限制正常回溯的规模" —— 600 页 × 50 条 = 3 万条，
 * 既覆盖真实回溯，又仍然是个有限的兜底。
 *
 * 撞预算本身不进退避（见 `applyBackoff(confirmedEnd === null)`）：
 * 大回溯连着撞预算但**水位单调前进**是正常的分批工作。
 */
const MAX_PAGES_PER_WINDOW = 600
/**
 * 对账补采的单轮翻页预算。
 *
 * ★ 比主窗小得多（600 → 40）：对账是**补历史**，不该和实时那一趟抢预算。
 * 抽不完下一轮接着来 —— 落后的会话已经落后几百分钟了，再等两分钟没有代价；
 * 而让它占满预算会直接推迟新消息到数字人的时间。
 *
 * 40 页 × 50 条 = 2000 条，够覆盖一次典型的延迟补采
 * （实测最严重的落后 559 分钟，那段时间内的消息远少于 2000 条）。
 */
const RECONCILE_MAX_PAGES = 40

/**
 * 每轮定向补账最多补几个会话。
 *
 * 对账是补历史，不该和实时那一趟抢 CLI 调用（每个会话一次子进程，
 * 实测约 0.6s）。8 个落后会话分两轮补完；抽不完下一轮接着来 ——
 * 它们已经落后几百分钟到上百天，再等一轮没有代价。
 */
const RECONCILE_MAX_DIRECTED = 5
/**
 * 每轮逐会话抽干几个「用户勾选的」会话。
 *
 * 实测单个会话抽干 4 天窗约 7 页 / 5 秒（limit=100）。给 3 个 ≈ 15 秒，
 * 与对账那一趟（`RECONCILE_MAX_DIRECTED = 5`）同一个量级 ——
 * 都是"补历史不该和实时那一趟抢 `busy` 锁"。
 *
 * 用户勾 44 个会话时约 15 轮（30 分钟）轮完一遍；之后每轮都是增量
 * （起点是库里该会话的最新一条），成本迅速降到接近零。
 */
const SCOPED_DRAIN_PER_ROUND = 3
/**
 * 轮转扫描（L1.5）的默认周期。
 *
 * ## ★★ 为什么必须有这一级（实测证据）
 *
 * L1 探针只调 `chat message list-unread-conversations` —— 它只返回**有未读
 * 红点**的会话。而"在客户端读过"会让会话立刻从那个列表消失，
 * 恰恰说明那是最活跃的会话。
 *
 * 实测这台机器：探针返回 **23** 个会话，而会话全集是 **173** 个 ——
 * 覆盖率只有 **13.3%**。盲区里有 **33 个会话在 48 小时内有新消息**，
 * 包括当天上午还在说话的群。
 *
 * 原来唯一的兜底是 L2 全量分页（`pullMs`，2 分钟），而实测它的召回只有
 * **89.8%**（42 个群对账，漏掉的 270 条全在请求的时间窗内）。合起来是
 * 「探针漏 87% 的会话，兜底自己漏 10% 的消息」。
 *
 * ## ★ 为什么 30 秒这个量级成立（关键）
 *
 * 判据**不需要逐会话发请求**：一次会话目录调用就拿到全部会话的
 * `lastMsgCreateAt`，与库里各自的最新一条比一下就知道谁落后
 * （批量查，见 `MessageRepository.latestSentAtByChannel`）。
 *
 * 所以一轮的固定成本是 **1 次 CLI 调用 + 1 次 GROUP BY**，与会话数无关；
 * 只有**真的落后**的那几个才付定向补拉的钱。逐个探测就完全不同了：
 * 173 次子进程 × 0.6s ≈ 100 秒，那样 30 秒一轮根本跑不完。
 */
const ACTIVE_SCAN_INTERVAL_MS = 30_000
/**
 * 轮转扫描每轮最多补几个会话。
 *
 * 稳态下命中数很少（大部分会话没有新消息），这个预算基本用不满。
 * 它挡的是**冷启动**：那时几乎全部会话都落后，不设上限会让一轮跑几分钟
 * 并占着 `busy` 锁挤掉实时那一趟。
 *
 * 5 个 × 每个 0.6s–5s ≈ 几秒到半分钟；追不完下一轮接着来，
 * 而 `activeScanOffset` 保证尾部的会话不会被饿死。
 */
const ACTIVE_SCAN_PER_ROUND = 5
/**
 * 会话目录的缓存时长。
 *
 * 三路合并（`list-all-conversations` ×2 + `chat group list-all` 翻页）实测约
 * **4.8s**（见 conversations.ts 文件头）—— 比扫描周期本身还长，每轮重取
 * 会让这一级变成最贵的一路，而它的目的恰恰是廉价。
 *
 * 2 分钟：目录变化（新建群 / 新单聊）不需要秒级发现，而**已有会话的新消息**
 * 靠缓存里的 id + 每轮重取的那一路窗口就能发现。
 */
const CONVERSATION_DIRECTORY_TTL_MS = 2 * 60_000
/**
 * 睡眠标志的自愈时限：suspend 之后最多认它这么久。
 *
 * ## ★★ 为什么必须有这个兜底
 *
 * `powerMonitor` 的 `resume` 不是保证送达的（进程在睡眠中被换出、
 * 事件在某些机型/虚拟化环境下丢失都发生过）。而 `suspended` 卡在 true
 * 就是**永久静默停采** —— 正是本次修复要消灭的那个形状，不能自己再造一个。
 *
 * 2 小时：远大于任何一次正常的"合盖-开盖"，又不会让真丢事件的机器
 * 停采一整天。超时之后按"醒着"处理，最坏情况只是多一批失败请求，
 * 而它们已被 `recordError` 的复核归成瞬时故障。
 */
const SUSPEND_SELF_HEAL_MS = 2 * 60 * 60_000
/**
 * 「本轮被闸住」这条日志的最小间隔。
 *
 * ## ★ 为什么必须节流
 *
 * 闸门在**每一轮**都会命中，而最密的那一路是探针（默认 10s）。不节流的话
 * 一小时能刷 360 条一模一样的 warn —— 那会把真正的错误淹掉，
 * 等于用一个噪音问题换掉一个静默问题。
 *
 * 5 分钟：足够让"采集为什么不动"在日志里**有痕迹**（这是它唯一的目的），
 * 又不会盖住别的行。按「原因 + 哪一路」分别计时，
 * 所以睡眠与 blocked 不会互相顶掉对方的名额。
 */
const GATE_LOG_THROTTLE_MS = 5 * 60_000
/**
 * 被 `session_expired` 闸住之后，隔多久**主动复核**一次登录态。
 *
 * ## ★★ 为什么必须有这个复核 —— 否则登录好了应用也不会动
 *
 * `blockedReason` 是终态，原来**只能**由 `clearBlocked()` 清掉，
 * 而它的调用方只有「状态页那个提示的关闭按钮」「IPC 重试」「post-auth 钩子」。
 * 定时轮询不重新探活。于是这条真实链路会永久卡住（实测,日志可复现）：
 *
 * 1. 睡眠/网络抖动 → 一次 token 刷新失败 → 置 `session_expired`；
 * 2. 醒来后 CLI 自己把 token 刷好了（`auth status` 返回 authenticated=true）；
 * 3. **没有人调 `clearBlocked()`** → 六处闸门继续全部关闭,
 *    日志每 5 分钟一条 `ingest round skipped {"blockedReason":"session_expired"}`,
 *    而界面显示「未连接」。用户唯一的出路是重启应用或去点那个提示。
 *
 * 这正是本项目最怕的那类静默失效：**每一层都"正常工作"**
 * （闸门按 blocked 跳过、日志照记、UI 照显示），只有整体是死的。
 *
 * 5 分钟：`auth status` 是一次子进程 + 可能的刷新网络请求（实测约 0.3–2s），
 * 比一轮采集便宜得多；而用户重新授权后最多等 5 分钟就自动恢复。
 * 取值与 `GATE_LOG_THROTTLE_MS` 一致不是巧合 —— 那条日志正好是
 * "还卡着"的心跳,两者同频时日志里每条 skipped 都对应一次真实复核。
 *
 * ★ 只对 `session_expired` 复核，**不碰** `permission_required`：
 * 后者要用户去来源应用点授权，我们这边复核不出结果（`auth status` 是
 * authorized 的，缺的是数据权限），白烧一次子进程。
 */
const SESSION_RECHECK_INTERVAL_MS = 5 * 60_000
/**
 * 回填的单轮翻页预算。
 *
 * ## ★ 为什么比增量的 600 小得多
 *
 * 这两个预算防的是不同的事。增量那个要足够大以**抽干当前窗**
 * （抽不干 → 水位不前进 → 活锁，见 `MAX_PAGES_PER_WINDOW`）。
 * 回填不会活锁：抽不干只是"这一窗下轮重来"，下界原地不动而已。
 *
 * 所以这里的预算是**给增量让路**用的：回填要跑几十轮几十分钟，
 * 而每一页都是一次 0.6s 的 CLI 调用占着同一个 `busy` 锁 ——
 * 给它 600 页等于一轮里有 6 分钟收不到新消息，数字人看起来就是卡住了。
 * 120 页 × 50 条 = 6000 条/轮，对 7 天窗足够，且单轮上限约 72s。
 */
const MAX_PAGES_PER_BACKFILL_ROUND = 120
/**
 * 连续多少轮「没抽干」算活锁。
 *
 * 3 轮（约 6 分钟）：偶尔一轮抽不干是正常的（某段特别密），而连着三轮
 * 都不推下界就说明窗宽估小了以外的问题，需要有人看见。
 */
const BACKFILL_STALL_ROUNDS = 3
/**
 * 卡住后减半的下限。
 *
 * 1 小时：比这更窄说明这一小时里的消息就超过单轮预算，那已经不是
 * 「窗切大了」而是账号密度真的超出设计（该做的是抬预算或换分页策略），
 * 而无限减半会切出几千个窗，把回填拖成永远跑不完。
 */
const MIN_BACKFILL_WIDTH_MS = 60 * 60_000
/**
 * 连续失败多少轮之后开始跳过 L2（上限）。
 *
 * `attempts` 原先只被累加进 DB 而无人消费 —— 病态渠道（每轮都报错，
 * 或每轮撞预算却一点没确认）会以固定 2 分钟频率持续烧 CLI 调用，
 * 既不减速也不升级告警。
 *
 * 这里用「跳过 `min(attempts, 上限)` 轮」做线性退避：仍会周期性重试
 * （故障可能自愈），但代价随失败次数下降。
 * 不用指数退避是刻意的：指数退避在长时间故障后会变成"几小时不试一次"，
 * 而这个模块的目标是**零丢失**，宁可多试。
 *
 * ⚠️ 触发条件是「失败」而**不是**「本轮没抽干」：大回溯会连着很多轮撞预算，
 * 那是正常的分批工作且水位单调前进 —— 对它退避等于"越有进展越被减速"。
 * 判据见 `runPull` 里 `applyBackoff(confirmedEnd === null)` 那处注释。
 */
const MAX_FAILURE_BACKOFF_ROUNDS = 5

export interface IngestServiceOptions {
  db: SqliteDatabase
  clock: Clock
  logger: Logger
  plugin: ChannelPlugin
  dbPath: string
  /** 单元测试里关掉定时器，只手动 tick */
  autoStart?: boolean
  /**
   * 数字人管控层。给了就挂 `persona-inbox` 消费者。
   *
   * 可选是刻意的：单测里不需要数字人，而"没有 supervisor 就不投递"
   * 比"投给一个假的"更接近真实（后者会让测试通过而生产路径没验过）。
   */
  personaSupervisor?: PersonaSupervisor
  /**
   * 投递成功后的回调 —— 叫醒调度 + 推快照。
   *
   * ★ 为什么不能省：`onInbound` 只是把消息放进信箱，取件的是
   * `PersonaService` 那个 8 秒定时器。不回调的话消息平均要多等 4 秒
   * 才被看到，而界面上那几秒里「待处理」数字一动不动
   * （与"根本没收到"在界面上无法区分）。
   *
   * 只在**真的接纳了**至少一条时调 —— 准入闸拒掉的那些不该叫醒任何人
   * （86 个会话的账号里绝大多数消息是被成本闸拒掉的，那时唤醒就是白跑）。
   */
  onPersonaDelivered?: () => void
  /**
   * 采集轮询周期（可配置，来自设置页 → `dh_settings.ingestIntervals`）。
   *
   * ★ `probeBaseMs` 默认 **10 秒**（用户可在 5–120s 间调）。它是探针的
   * **基础**周期，不是绝对周期 —— `AdaptiveInterval` 仍会在探针耗时超过
   * 周期一半时降频（几百个群之后自我退让）。这一点要在 UI 上写清楚，
   * 否则用户设了 10s 看到 20s 会以为没生效。
   *
   * `pullMs`（L2 全量分页兜底）**不建议**跟着降到 10s：一轮最多 600 页，
   * 10s 一轮会持续占满 busy 锁挤掉发送。让"新消息秒级可见"的是探针 hint
   * + 定向补拉，不是把全量轮询加密。不给时用内置默认。
   */
  intervals?: {
    probeBaseMs?: number
    probeMaxMs?: number
    pullMs?: number
    minutesMs?: number
    documentsMs?: number
    /**
     * 轮转扫描（L1.5）周期。默认 30s，可配 15s–5min。
     * 见 `ACTIVE_SCAN_INTERVAL_MS`：它补的是探针那 87% 的盲区。
     */
    activeScanMs?: number
  }
  /**
   * 「哪些会话现在有**常驻 agent**」的提供者（external_id 列表）。
   *
   * ## 为什么这些会话要更勤地拉（用户明确要的）
   *
   * 常驻 agent = 数字人正在替这个会话做事（正在生成草稿 / 刚回过 / 用户
   * 正盯着它审）。这类会话**最不能漏消息**：漏一条就是"它没看见对方刚说的话
   * 就回了"。而全局探针有已读会话盲区、全局轮询是 2 分钟一轮 —— 都不够。
   *
   * 所以每个探针 tick 额外对这些会话做一次**定向补拉**（`refreshConversation`），
   * 与探针同频（默认 10s）。代价可控：常驻数有上限（`maxResident`，默认 8）。
   *
   * 不给（单测 / 无 persona）= 不做这件事。
   */
  residentConversationExternalIds?: () => readonly string[]
}

export interface IngestSnapshot {
  running: boolean
  channelId: string
  messages: number
  conversations: number
  unjudged: number
  outboxHead: number
  ftsIndexed: number
  ftsLag: number
  probeIntervalMs: number
  probeThrottled: boolean
  lastError: string | null
  /** 需要用户介入的终态（登录过期 / 缺授权）：UI 要显式引导，不能静默重试 */
  blockedReason: "session_expired" | "permission_required" | null
  /** 连续失败轮数。>0 时状态页要显示「正在退避重试」，否则减速看起来像卡住 */
  failedAttempts: number
  selfConfirmed: boolean
  /** 媒体元数据行数（一期只记 ID 不下载字节） */
  mediaAssets: number
  /** 听记条数 */
  minutes: number
  /**
   * 听记的**覆盖面**（"是不是全部"，不是"有多少"）。null = 还没跑过一轮。
   *
   * ★ 上面那个计数在首版会稳定停在 50（列表只取首页），而那与
   * "这个账号一共 50 场会"在界面上完全同形 —— 这一组是那个静默缺失的出口。
   * 与 `backfill` 那三个数字同一个思路：把落差摊开才能被看见。
   */
  minutesCoverage: {
    /** 上一轮把列表翻到底了吗。false = 撞了页数预算，覆盖不全。 */
    drained: boolean
    /** 已覆盖到的最早会议时间（unix ms）；null = 库里还没有会议。 */
    earliestStartedAt: number | null
    /** 有几场会的**转写**没抽干（与 `drained` 是两件事，见契约里的注释）。 */
    transcriptTruncated: number
  } | null
  storage: {
    mainBytes: number
    walBytes: number
    rawRecords: number
    rawPruned: number
    vectors: number
  }
  staleConsumers: string[]
  /**
   * 「选的范围 vs 实际覆盖」。
   *
   * ★ 必须在状态页上，不能只在日志里：这个落差过去是**完全静默**的 ——
   * 用户在引导里选 180 天、库里只有 7 天，而界面上每一个数字都正常
   * （消息数在涨、无错误、蒸馏 grade 是 A）。唯一的症状是画像薄，
   * 而"薄"没有参照物，看不出来。
   */
  backfill: {
    /** 用户选的下界；null = 不限，undefined 序列化后为 null 表示没配 */
    since: number | null
    /** 已覆盖到的最早时间；null = 库里还没有消息 */
    coveredFrom: number | null
    /** 还差多少毫秒到目标；0 = 已到位 */
    remainingMs: number
    /**
     * 回填卡住了的原因；null = 正常。
     *
     * 与 `remainingMs` 分开报：那个只说"还差多少"，而**差着不动**
     * 与"正在推进"在界面上是同一个数字。活锁必须自己有一个出口。
     */
    stalled: string | null
    /**
     * 当前正在回填的时间窗；null = 这一刻没有在跑的窗。
     *
     * ★ 让等待变成**可观察**的：只报 `remainingMs` 时那个数字每几分钟
     * 才动一次，用户分不清"在跑"与"卡住"。引导第四步用它显示
     * "正在拉 X 到 Y"。
     */
    activeWindow: { start: number; end: number } | null
    /** 已采集的消息总数（该渠道）。进度条的分子。 */
    messages: number
    /**
     * 采集**有没有真的开始**（库里有消息，或回填推进过）。
     *
     * ★ 必须与 `remainingMs` 分开：「一条都没有」曾经也被算成
     * `remainingMs: 0`，于是界面对一个**采集完全失败**的库显示
     * 「选的 N 天已全部采集完成」（实测踩到过，见 `backfillCoverage`
     * 的注释）。false 时 UI 要说"还没开始"，不能说"已完成"。
     */
    started: boolean
  }
  /**
   * 采集范围闸的状态。
   *
   * ★ 必须可见，理由与 `backfill` 那一段同源：全局窗（`list-all`）没有
   * 会话过滤参数，所以"只采勾选的会话"只能靠**落库前丢弃**实现。
   * 而丢弃不上报的话，"越界被挡住了"与"这段时间本来没消息"在界面上
   * 完全同形 —— 用户无法确认自己的勾选真的生效了。
   */
  scope: {
    /** 是否设了会话白名单。false = 用户没配过范围（不设限） */
    restricted: boolean
    /** 许可的会话数；null = 不限（≠ 0，那是"一个都不许"） */
    allowed: number | null
    /** 本进程累计丢弃的越界消息条数 */
    droppedOutOfScope: number
    /** 最近一次丢弃的时刻；null = 本进程还没丢过 */
    lastDroppedAt: number | null
  }
}

export class IngestService {
  /** 快通道：入库后立刻投递，供数字人订阅。 */
  readonly events = new EventEmitter()

  private readonly scheduler: IngestScheduler
  private readonly probeInterval: AdaptiveInterval
  private readonly ftsConsumer: OutboxConsumer
  /**
   * 蒸馏消费者：有新消息就把对应时间窗排进 `distill_tasks`。
   *
   * ★ 只**入队**不跑：跑蒸馏是几十秒的 LLM 调用，在 handler 里跑会让
   * 租约过期 → 被抢占 → 同一批消息被重复蒸馏（真金白银）。
   * 真正跑任务由 `DistillService` 的定时器驱动。
   */
  private readonly distillConsumer: OutboxConsumer
  /**
   * 数字人消费者：新消息投给管控层。同样只投递不处理 ——
   * 在 handler 里处理会让租约过期 → 同一条消息被处理两遍 → **可能重复发送**
   * （这是不可逆的社交后果，比重复花钱严重）。
   */
  private readonly personaConsumer: OutboxConsumer | null
  /** 快通道投递器：入库即把消息交给管控层（见构造里的注释） */
  private readonly personaFastPath: ((messageId: string) => boolean) | null
  private probeTimer: NodeJS.Timeout | null = null
  private pullTimer: NodeJS.Timeout | null = null
  private minutesTimer: NodeJS.Timeout | null = null
  private inFlightMinutes: Promise<unknown> | null = null
  private documentsTimer: NodeJS.Timeout | null = null
  private activeScanTimer: NodeJS.Timeout | null = null
  private inFlightDocuments: Promise<unknown> | null = null
  private running = false
  private busy = false
  /**
   * 系统是否处于睡眠（由 `powerMonitor` 的 suspend/resume 驱动）。
   *
   * ## ★★ 为什么需要它
   *
   * macOS 睡眠期间会周期性 DarkWake（实测约每 16-18 分钟一次，
   * 窗口只有 2-4 秒）来跑维护任务。定时器在那几秒里**照样触发** ——
   * 于是采集 tick 被唤起，而网络还没起来、token 刷新也做不了。
   * 实测 2026-08-08：13:11:01 DarkWake → 13:11:05 `Entering Sleep`，
   * 那 4 条命令就夹在这中间，全部 `auth_token_present:false`。
   *
   * 结果是每一轮睡眠都稳定产出一批注定失败的请求 —— 白烧子进程、
   * 污染 `lastError`、把退避计数推上去。挡住它比事后归类便宜得多。
   *
   * ## ★ 只挡"发起新一轮"，不打断在途的那一轮
   *
   * 在途的 tick 让它自己收尾（它可能正 await 一个子进程，硬断会留孤儿）。
   * suspend 只保证**不再新起**。
   *
   * ## ★★ 卡住的方向是刻意选的
   *
   * 若 resume 事件因故没来（进程在睡眠中被换出、事件丢失），这个标志会
   * 一直是 true —— 那就是"永久停采"，正是本次要修的那个 bug 的形状。
   * 所以它**必须能自愈**：`resumeAt` 记下预期恢复时刻，超过
   * `SUSPEND_SELF_HEAL_MS` 没收到 resume 就自己放行（见 `suspendedNow`）。
   *
   * 两个方向的代价不对称，所以宁可放行：
   * · 误判成"醒着"→ 多一批失败请求，而它们已被 `recordError` 的复核
   *   归成瞬时故障（不再进 blocked）—— 可恢复；
   * · 误判成"睡着"→ 永久停采且完全静默 —— 不可恢复。
   */
  private suspended = false
  /** 进入睡眠的时刻；用于 `suspendedNow` 的自愈判断。null = 没在睡。 */
  private suspendedAt: number | null = null
  /**
   * 「本轮被闸住」日志的上次输出时刻，按 `<原因>:<哪一路>` 记。
   *
   * 见 `GATE_LOG_THROTTLE_MS`：这条日志的作用是让"采集为什么不动"
   * 在日志里留痕 —— 在此之前，被闸住与真的没有新消息**长得一模一样**
   * （导出照跑、条数不变、一条错都没有），只能靠翻 `pmset` 反推。
   */
  private gateLoggedAt = new Map<string, number>()
  private lastError: string | null = null
  private blockedReason: IngestSnapshot["blockedReason"] = null
  /**
   * 上次为 `session_expired` 做主动复核的时刻；0 = 还没复核过。
   *
   * 与 `gateLoggedAt` 分开存：那张表是**日志节流**，清它只影响"下一条日志
   * 什么时候能出来"。而这个是**探活节流**，混用会让「清了节流表」
   * 顺带触发一次真实的子进程调用 —— 两件事的代价差几个数量级。
   */
  private lastSessionRecheckAt = 0
  private pendingHints = new Set<string>()
  /**
   * 在途的 `tickPull`。`stop()` 要 await 它。
   *
   * 不等的话：logout 路径是 `dataPlane.detach()` → `vaults.closeAll()`，
   * 而 detach 里的 `stop()` 原先是同步的 —— 库被关掉时正在 await DWS 子进程
   * （实测约 0.6s）的那一轮回来后会写到已关闭的连接上，抛
   * `The database connection is not open`，且这个 reject 无人 catch。
   */
  private inFlightPull: Promise<unknown> | null = null
  /**
   * 退避计数：>0 时本轮 L2 跳过（每轮递减）。
   *
   * 见 `MAX_FAILURE_BACKOFF_ROUNDS`。放在内存而不是 DB：进程重启后重新试一次
   * 是我们想要的行为（重启常常正是用户"修好了什么"之后的动作）。
   */
  private backoffRounds = 0
  /**
   * 逐会话抽干的轮转位置。
   *
   * 每轮只处理一小批勾选会话（`SCOPED_DRAIN_PER_ROUND`），
   * 用它记住"上一轮停在哪"——不记的话每轮都从第一个开始，
   * 于是列表尾部的会话**永远轮不到**（而它们往往正是最缺数据的那些）。
   */
  private scopedDrainOffset = 0
  /**
   * 轮转扫描的位置。与 `scopedDrainOffset` 同一个理由：每轮只处理一小批，
   * 不记位置的话列表尾部永远轮不到（而那往往正是最缺数据的那些）。
   */
  private activeScanOffset = 0
  /**
   * 会话目录的缓存（三路合并实测 4.8s，比扫描周期还长 —— 不能每轮重取）。
   * null = 还没取过或已过期。
   */
  private directoryCache: { at: number; items: readonly ChannelConversationItem[] } | null = null
  /** 回填连续「没抽干」的轮数：达到阈值就是活锁，要升级成告警。 */
  private backfillStalledRounds = 0
  /** 活锁的人话描述；非 null 时进快照，让状态页能显示。 */
  private backfillStalled: string | null = null
  /**
   * 卡住后强制的窗宽；null = 用 scheduler 的密度自适应。
   *
   * 放在内存而不是 DB：进程重启后重新按密度估一次是我们想要的
   * （重启常常正是"改了什么"之后的动作），而把一个临时的窄窗持久化
   * 会让它在问题早已消失后继续拖慢回填。
   */
  private backfillWidthOverrideMs: number | null = null

  /**
   * 因**超出用户勾选范围**而被丢弃的消息累计条数（进程内）。
   *
   * ★ 为什么必须记这个数：全局窗（`list-all`）没有会话过滤参数，所以
   * "只采勾选的会话"只能靠落库前丢弃来实现 —— 而丢弃如果不可见，
   * 它与"这段时间本来就没消息"在日志和状态页上完全同形。那正是
   * 这个代码库里最贵的那类静默降级（CLAUDE.md 第 4 节）。
   *
   * 只在内存里（不进 DB）是刻意的：它回答的是"这个进程这一段时间挡掉了
   * 多少"，用于确认闸门真的在工作。累计值持久化反而会让人误读成
   * "库里现在有这么多越界数据"—— 而那是 `purgeOutOfScopeMessages` 的报告。
   */
  private droppedOutOfScope = 0
  /** 最近一次丢弃的时刻；null = 这个进程还没丢过。状态页据此区分"没配范围"与"配了但最近没越界数据进来"。 */
  private lastDroppedAt: number | null = null

  /**
   * 解析后的轮询周期（可配置，见 `IngestServiceOptions.intervals`）。
   * clamp 在合理区间内 —— 用户设了 1ms 会把 CLI 打爆，设了一天等于关掉。
   */
  private readonly pullIntervalMs: number
  private readonly minutesIntervalMs: number
  private readonly documentsIntervalMs: number
  private readonly activeScanIntervalMs: number

  constructor(private readonly options: IngestServiceOptions) {
    const iv = options.intervals ?? {}
    const clamp = (v: number | undefined, def: number, min: number, max: number): number =>
      v === undefined ? def : Math.min(max, Math.max(min, v))
    // 探针基础周期 5s–120s；L2 兜底 30s–10min；听记 5min–2h。
    const probeBase = clamp(iv.probeBaseMs, PROBE_INTERVAL_MS, 5_000, 120_000)
    const probeMax = clamp(iv.probeMaxMs, PROBE_INTERVAL_MAX_MS, probeBase, 300_000)
    this.pullIntervalMs = clamp(iv.pullMs, PULL_INTERVAL_MS, 30_000, 10 * 60_000)
    this.minutesIntervalMs = clamp(iv.minutesMs, MINUTES_INTERVAL_MS, 5 * 60_000, 2 * 60 * 60_000)
    /**
     * 文档周期 10min–6h（**稳态**档；冷启动见 `documentsInterval()`）。
     *
     * ★ 原先写死（注释写的是"等有人真需要再给"）—— 而它与其余四项
     * 不同源这件事本身就是个坑：「采集频率」面板宣称能配采集，
     * 却漏了一路，于是"文档多久拉一次"只有能开 SQLite 的人配得了。
     * 区间给得比听记更宽：知识库重度用户想更勤，纯聊天用户想更懒。
     *
     * ★ 下界从 15min 放到 10min：与 `DOCUMENTS_INTERVAL_BACKLOG_MS` 对齐 ——
     * 冷启动档要用 10 分钟，而它同样要过这个 clamp（用户配得比冷启动档
     * 还勤时应当听用户的）。下界卡在 15min 的话冷启动档会被静默钳到 15min，
     * 那种"设了没生效"是最难查的一类。
     */
    this.documentsIntervalMs = clamp(
      iv.documentsMs,
      DOCUMENTS_INTERVAL_MS,
      10 * 60_000,
      6 * 60 * 60_000,
    )
    /**
     * 轮转扫描 15s–5min。
     *
     * 下界 15s 是刻意的：这一级的固定成本只有 1 次 CLI 调用 + 1 次 GROUP BY
     * （见 `ACTIVE_SCAN_INTERVAL_MS`），所以它比全量分页便宜得多，
     * 允许比 `pullMs` 更勤。但比探针的 5s 下界高 —— 目录调用毕竟比
     * 未读列表贵（缓存命中时才接近零）。
     */
    this.activeScanIntervalMs = clamp(iv.activeScanMs, ACTIVE_SCAN_INTERVAL_MS, 15_000, 5 * 60_000)

    this.scheduler = new IngestScheduler({
      db: options.db,
      clock: options.clock,
      channelId: options.plugin.meta.id,
      logger: options.logger,
      pageLimit: PAGE_LIMIT,
      // ★ 让 scheduler 按这个数反推窗宽，否则密集账号会活锁（见 adaptiveBackfillWidth）
      backfillPageBudget: MAX_PAGES_PER_BACKFILL_ROUND,
    })
    this.probeInterval = new AdaptiveInterval(probeBase, probeMax)
    this.ftsConsumer = new OutboxConsumer({
      db: options.db,
      clock: options.clock,
      consumerId: FTS_CONSUMER_ID,
      owner: `main-${process.pid}`,
      handler: createFtsHandler(options.db, options.clock, options.logger),
      // FTS 是纯本地的，批量可以大
      batchSize: 2000,
    })

    this.distillConsumer = new OutboxConsumer({
      db: options.db,
      clock: options.clock,
      consumerId: DISTILL_CONSUMER_ID,
      owner: `main-${process.pid}`,
      handler: createDistillHandler({
        db: options.db,
        clock: options.clock,
        logger: options.logger,
        newId: () => randomUUID(),
      }),
      // 只做窗口去重与入队，纯本地，批量可以大
      batchSize: 2000,
      /**
       * ★ `required: true` —— 这个消费者落后时**不能**裁剪历史。
       * 裁了就等于永久丢掉那段时间的画像来源。
       * 与 graph-export（外部消费者，false）相反，判据是"丢了能不能补回来"。
       */
      required: true,
    })

    const supervisor = options.personaSupervisor
    /**
     * 慢兜底的处理器。抽出来是为了在 handler 里包一层"投递成功就回调"，
     * 而不用把回调逻辑塞进 `@mycontext/persona`（那一层不该知道 UI 与定时器）。
     */
    const createdPersonaHandler =
      supervisor === undefined
        ? null
        : createPersonaInboxHandler({
            db: options.db,
            clock: options.clock,
            supervisor,
            logger: options.logger,
          })
    this.personaConsumer =
      supervisor === undefined || createdPersonaHandler === null
        ? null
        : new OutboxConsumer({
            db: options.db,
            clock: options.clock,
            consumerId: PERSONA_CONSUMER_ID,
            owner: `main-${process.pid}`,
            handler: (batch) => {
              const result = createdPersonaHandler(batch)
              // 兜底路径也要叫醒 —— 它捞回来的消息同样在等取件人
              if (result.processed > 0) options.onPersonaDelivered?.()
              return result
            },
            batchSize: 500,
            /**
             * ★ `required: false` —— 与蒸馏相反：数字人落后时**允许**裁剪历史。
             * 一条三天前没回的消息现在回也没意义了；而画像的语料丢了是永久损失。
             * 设成 true 会让数字人一旦停用就阻塞整个保留策略。
             */
            required: false,
          })

    /**
     * ★ 快通道：入库即投递给管控层，不等它自己那 8 秒 tick。
     *
     * ## 为什么两条路都要
     *
     * 管控层是消息流的**订阅者**（不是"监听某些会话的东西"）。订阅的
     * 语义要求"入库就知道"，而 Outbox 消费者是被动的 —— 它要等
     * `tickPull`（2 分钟）或探针那一轮才推进，于是"新消息到数字人"
     * 最坏要等两分钟多。
     *
     * 但快通道**不能取代**慢兜底：进程内事件在崩溃、异常抛出、
     * 或订阅方还没挂上时会丢，而 changelog 是持久的。
     * 两条路按 `message_id` 去重（`Mailbox.push`），所以重叠是安全的 ——
     * 这正是 `mailbox.ts` 文件头写的那个设计。
     *
     * ## 为什么 DWS 没有真正的 push
     *
     * 查过全部 vendored reference：Webhook 只有**出向**
     * （`message send-by-webhook` 发告警），没有任何 watch/subscribe/
     * long-poll 命令。所以"感知新消息"对外仍是轮询（`PROBE_INTERVAL_MS`），
     * 这里的"订阅"是**进程内**的那一段 —— 省掉的是我们自己引入的延迟。
     */
    this.personaFastPath =
      supervisor === undefined
        ? null
        : createPersonaFastPath({
            db: options.db,
            clock: options.clock,
            supervisor,
            logger: options.logger,
          })
    if (this.personaFastPath !== null) {
      this.events.on("inbound.message", (message: MessageRow) => {
        try {
          /**
           * ★ 只在**真的接纳了**才回调。
           *
           * `personaFastPath` 返回 false 的两种情况都不该叫醒调度：
           * 准入闸拒掉（这个账号 86 个会话，多数消息被成本闸拒）、
           * 或者慢兜底已经收下了同一条（按 message_id 去重）。
           * 不区分的话每条入库消息都会排一次唤醒 —— 回溯时是几千次空跑。
           */
          const accepted = this.personaFastPath?.(message.id) ?? false
          if (accepted) this.options.onPersonaDelivered?.()
        } catch (error) {
          /**
           * 投递失败只记日志。
           *
           * 抛出去会打断 `persist()` 的循环 —— 后面那些消息连
           * `batch.persisted` 都收不到（UI 就不刷新了）。而这条消息
           * 仍在 changelog 里，慢兜底会补上。
           */
          this.options.logger.warn("persona fast path failed", {
            messageId: message.id,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      })
    }
  }

  /** 启动。幂等：重复调用不会起两套定时器。 */
  start(): void {
    if (this.running) return
    if (this.options.plugin.ingest === undefined) {
      this.options.logger.info("channel has no ingest capability, skipping", {
        channelId: this.options.plugin.meta.id,
      })
      return
    }
    this.running = true
    this.ftsConsumer.register()
    this.distillConsumer.register()
    this.personaConsumer?.register()
    // 启动时跑一次索引完整性自检：索引与源表失配是静默故障。
    const check = new FtsIndexRepository(this.options.db).integrityCheck()
    if (!check.ok) {
      this.options.logger.error("fts integrity check failed", { detail: check.error })
    }

    if (this.options.autoStart !== false) {
      this.scheduleProbe()
      this.pullTimer = setInterval(() => void this.tickPull(), this.pullIntervalMs)
      // 立刻跑一轮，不等第一个周期到
      void this.tickPull()

      // 听记：低频。会议是稀疏事件（实测该账号 20 条 / hasMore），
      // 按消息那样 2 分钟一轮纯属浪费子进程时间。
      if (this.options.plugin.minutes !== undefined) {
        this.minutesTimer = setInterval(() => void this.tickMinutes(), this.minutesIntervalMs)
        void this.tickMinutes()
      }

      /**
       * 文档：最低频的一路（默认 60 分钟）。
       *
       * ★ 与听记一样**挂载时也跑一轮**：不跑的话首次登录要等一小时才有文档，
       * 而引导跑完用户就想看到"文档也采到了"。
       */
      if (this.options.plugin.documents !== undefined) {
        this.scheduleDocuments()
        void this.tickDocuments()
      }

      /**
       * ★★ 轮转扫描（L1.5）：补探针那 87% 的盲区。
       *
       * 实测探针覆盖率只有 13.3%（23/173），盲区里有 33 个会话在 48 小时内
       * 有新消息 —— 因为 `list-unread-conversations` 只返回**有未读红点**的，
       * 而"你读过"恰恰说明那是最活跃的会话。详见 `ACTIVE_SCAN_INTERVAL_MS`。
       *
       * 需要 `conversations`（会话目录）与 `pullConversation`（定向补拉）
       * 两个能力：前者给"渠道说的最后消息时间"，后者去补。
       * 缺任一就整个跳过 —— 那是骨架渠道的正常状态，不是错误。
       *
       * 挂载时**不**立刻跑一轮：`start()` 已经排了 `tickPull`（全量兜底），
       * 两个一起跑会在登录那一刻抢同一把 `busy` 锁。等第一个周期到就行 ——
       * 30 秒之内新消息本来就由探针那一路负责。
       */
      if (
        this.options.plugin.conversations !== undefined &&
        this.options.plugin.ingest?.pullConversation !== undefined
      ) {
        this.activeScanTimer = setInterval(
          () => void this.tickActiveScan(),
          this.activeScanIntervalMs,
        )
      }
    }
    this.options.logger.info("ingest started", { channelId: this.options.plugin.meta.id })
  }

  /**
   * 停止。
   *
   * ## ★ 必须重置 `busy`，否则重新登录后采集永久静默停摆
   *
   * `tickPull` 的守卫只看 `busy`，而 `stop()` 原先不重置它：
   * 若 stop 发生在一轮 tick 的中途（logout 恰好撞上正在跑的采集），
   * `busy` 会永远停在 true。同进程内重新登录后 `attach` 会造一个**新的**
   * IngestService（新实例 busy=false），但**同一个实例被复用**的路径
   * （手动 stop/start、将来的暂停开关）就会得到：定时器在跑、每轮被 busy 挡掉、
   * 无错误无日志、状态页仍显示 running:true —— 采集彻底停了而看起来完全正常。
   *
   * ## ★ 返回 Promise 并 await 在途的 tick
   *
   * 调用方（logout / dispose）随后会关库。不等在途 tick 的话，那一轮
   * 从 DWS 子进程回来时会写到已关闭的连接上，抛出无人 catch 的
   * unhandledRejection。这里等它自己收尾（tickPull 内部有 running 复查，
   * 会在写库前提前返回）。
   */
  async stop(): Promise<void> {
    this.running = false
    if (this.probeTimer !== null) clearTimeout(this.probeTimer)
    if (this.pullTimer !== null) clearInterval(this.pullTimer)
    if (this.minutesTimer !== null) clearInterval(this.minutesTimer)
    if (this.documentsTimer !== null) clearTimeout(this.documentsTimer)
    if (this.activeScanTimer !== null) clearInterval(this.activeScanTimer)
    this.probeTimer = null
    this.pullTimer = null
    this.minutesTimer = null
    this.documentsTimer = null
    this.activeScanTimer = null
    // 目录缓存跟着清：下次 attach 可能是**另一个账号**，
    // 留着等于把上一个账号的会话列表带进新会话（跨账号泄漏）。
    this.directoryCache = null

    // 等在途的那一轮结束再放开 busy 与释放租约：
    // 顺序反了会让调用方以为"已经停了"而去关库。
    const inFlight = this.inFlightPull
    if (inFlight !== null) {
      // tickPull 自己 catch 全部异常，这里不会 reject；加 catch 只为防将来改动。
      await inFlight.catch(() => undefined)
    }
    // 听记那一轮同理：它也会写库，不等就可能写到已关闭的连接上。
    const inFlightMinutes = this.inFlightMinutes
    if (inFlightMinutes !== null) {
      await inFlightMinutes.catch(() => undefined)
    }
    // 文档那一轮同理：它也写库，不等就可能写到已关闭的连接上。
    const inFlightDocuments = this.inFlightDocuments
    if (inFlightDocuments !== null) {
      await inFlightDocuments.catch(() => undefined)
    }
    this.busy = false
    this.inFlightPull = null
    this.inFlightMinutes = null
    this.inFlightDocuments = null
    this.ftsConsumer.release()
    this.distillConsumer.release()
    this.personaConsumer?.release()
  }

  /**
   * 探针周期是自适应的，所以用 setTimeout 递归而不是 setInterval。
   *
   * 「探针耗时 > 周期一半就降频」的判据在几百个群之后才会触发 ——
   * 而那时的表现是"数字人越来越慢"且没有任何错误，所以必须自动处理。
   */
  private scheduleProbe(): void {
    if (!this.running) return
    this.probeTimer = setTimeout(() => {
      void this.tickProbe().finally(() => this.scheduleProbe())
    }, this.probeInterval.intervalMs)
  }

  /** L1：廉价探针。返回本轮探到的变化会话数。 */
  async tickProbe(): Promise<number> {
    const ingest = this.options.plugin.ingest
    // `running` 复查与 tickPull 同理：stop 之后不该再起新的子进程。
    if (ingest === undefined || !this.running) return 0
    /**
     * ★ 闸门判定前先给一次**自愈机会**（节流过，见 `recheckSessionIfBlocked`）。
     *
     * 挂在探针这一路而不是六处都挂：探针是最廉价、最高频的那条,
     * 它一解闸,另外五路本轮或下一轮自然跟上。六处各挂一次的话,
     * 同一个 5 分钟窗口里会有六次复核抢同一个节流名额,
     * 谁先跑到谁生效 —— 那种时序依赖没法测。
     */
    if (this.blockedReason !== null) {
      if (!(await this.recheckSessionIfBlocked())) {
        this.noteGated("blocked", "probe")
        return 0
      }
      // 自愈成功：`running` 可能在 await 期间被 stop() 改掉,重新确认一次。
      if (!this.running) return 0
    }
    if (this.suspendedNow()) {
      this.noteGated("suspended", "probe")
      return 0
    }

    const startedAt = this.options.clock.now()
    try {
      const result = await ingest.probe()
      if (result === null) {
        // 探针无能力时也照顾常驻会话 —— 它们最不能漏消息（见选项注释）。
        await this.refreshResidents()
        return 0
      }
      const hints = this.scheduler.diffProbe(result, this.options.clock.now())
      for (const hint of hints) this.pendingHints.add(hint.conversationExternalId)

      /**
       * ★ 探到变化的会话：**定向补拉**每一个，而不是只把全局轮询提前。
       *
       * 过去这里只 `void this.tickPull()`（全局时间窗分页），而 `pendingHints`
       * 被写了从不读 —— 探针辛苦算出的"哪几个会话有更新"被扔了。现在
       * 逐个 `refreshConversation`：只拉那几个、秒级到位，且覆盖了全局轮询
       * 够不到的"已读会话盲区"（那种会话 unread=0，全局窗也许早推过去了）。
       *
       * 仍然保留全局 `tickPull` 作兜底（它有 hints 覆盖不到的会话），
       * 但定向补拉让"用户正在看的那个会话"不必等它。
       */
      if (hints.length > 0) {
        for (const hint of hints) {
          await this.refreshConversation(hint.conversationExternalId)
          this.pendingHints.delete(hint.conversationExternalId)
        }
        // 兜底：全局轮询覆盖 hints 之外的会话（探针有盲区，见 diffProbe）。
        void this.tickPull()
      }

      // ★ 常驻 agent 的会话每 tick 都补一次（最不能漏，见选项注释）。
      await this.refreshResidents()
      return hints.length
    } catch (error) {
      await this.recordError(error)
      return 0
    } finally {
      this.probeInterval.observe(this.options.clock.now() - startedAt)
    }
  }

  /**
   * 对当前有常驻 agent 的会话逐个定向补拉。
   *
   * 串行而不是并发：常驻数有上限（默认 8），而并发 8 个 CLI 子进程会和
   * 全局轮询抢 busy 与配额。串行 + 每个只拉一页，总开销约几秒，可接受。
   * 与主轮询去重：`refreshConversation` 自己带 `running`/能力判断。
   */
  private async refreshResidents(): Promise<void> {
    const ids = this.options.residentConversationExternalIds?.() ?? []
    for (const externalId of ids) {
      if (!this.running) return
      await this.refreshConversation(externalId)
    }
  }

  /**
   * 听记采集：**抽干**列表分页 → 落库 → 给缺正文的补正文。
   *
   * ## 为什么"列"与"补正文"在同一轮但分两步
   *
   * `list` 只给元信息，正文要逐条再调两次以上（summary + 抽干转写的每一页）。
   * 若在 list 的循环里同步补正文，一次全量会让这一轮跑很久 ——
   * 而听记轮询本来是低频后台任务，长时间占着 DWS 子进程不划算。
   *
   * 所以：list 每轮抽干（元信息便宜且幂等），正文每轮只补
   * `MINUTES_BODY_PER_ROUND` 条最新的。几轮之后就补齐了。
   *
   * ## 不做水位，但**做范围收窄**（两件事）
   *
   * · **没有水位**：`--start/--end` 是「可选筛选」而非水位语义
   *   （它不保证"这之后的都给你"），所以 `IngestScheduler` 那套
   *   「重叠窗口 + 水位」在这里没有对应物。幂等靠
   *   `(channel_id, external_id)` 唯一键 + upsert 的正文守卫 ——
   *   重复列同一条听记不产生 Outbox seq。
   * · **但要传时间范围**：抽干历史会碰到用户明确排除掉的时间段，
   *   而那是隐私边界（CLAUDE.md 第 5 节）。见 `minutesTimeRange`。
   *
   * ## ★ 抽干的截断要落库
   *
   * 撞了页数预算时 `minutes_coverage.drained = 0` —— 状态页据此说
   * "覆盖可能不全"。只记日志的话用户看不到（见
   * `MinutesCoverageRepository` 的注释）。
   */
  async tickMinutes(): Promise<{ listed: number; changed: number; bodies: number }> {
    const minutes = this.options.plugin.minutes
    const empty = { listed: 0, changed: 0, bodies: 0 }
    if (minutes === undefined || !this.running) return empty
    if (this.blockedReason !== null) {
      this.noteGated("blocked", "minutes")
      return empty
    }
    if (this.suspendedNow()) {
      this.noteGated("suspended", "minutes")
      return empty
    }
    if (this.inFlightMinutes !== null) return empty
    /**
     * ★ 尊重用户在引导里对「听记」那一栏的勾选。
     *
     * 原来这里只看渠道有没有 minutes 能力，不看 `distill_sources.minutes.enabled`
     * —— 于是取消勾选照样采、照样进知识图谱，那个勾选框两个方向都是装饰。
     * 现在：源关掉就不采（`enabled === false`）。源不存在（老库没这一行）
     * 当作**默认采**（引导默认勾了 minutes），避免升级后突然不采听记。
     */
    if (!this.minutesEnabled()) return empty

    const run = this.runMinutes(minutes)
    this.inFlightMinutes = run
    try {
      return await run
    } finally {
      this.inFlightMinutes = null
    }
  }

  /**
   * 听记源是否开启。**没配过**（表里没有这一行）= 默认开（引导默认勾了它，
   * 且老库升级后不该突然不采）；**显式配成关**才不采。
   *
   * ★ 不能用 `DistillSourceRepository.list()` 判：它对缺失的 kind 会**合成**
   * 一行 `enabled:false`（见那里的 back-fill）—— 于是"没配过"与"显式关"
   * 在它眼里同形。所以这里直接查原始表，用「有没有这一行」区分两者。
   */
  private minutesEnabled(): boolean {
    const row = this.options.db
      .prepare<[string], { enabled: number }>("SELECT enabled FROM distill_sources WHERE kind = ?")
      .get("minutes")
    return row === undefined ? true : row.enabled === 1
  }

  /**
   * 听记源的时间范围（用户在引导第 3 步选的）。
   *
   * ## ★★ 为什么必须有这个，以及为什么**不能**用 `readCollectionScope`
   *
   * 听记采集从前完全不看采集范围。只取首页时这件事被"覆盖面太小"掩盖了；
   * 一旦抽干历史，就会把用户明确排除掉的时间段整段采回来 ——
   * 按 CLAUDE.md 第 5 节那是隐私问题，不是"多采点没坏处"。
   *
   * `readCollectionScope`（store 的唯一权威）**只读 `kind = 'chat'` 那一行**
   * （函数名里没有 chat，但实现写死了）。而引导对**每个**源各写一行 scope
   * （见 `onboarding-view.tsx` 的保存循环：非 chat 源写 `{since, until}`）。
   * 拿 chat 的范围去卡听记在这个应用里恰好等价（引导给两者写的是同一对
   * since/until），但那是**巧合而不是契约** —— 用户将来能分源配范围时
   * 就错了，而错的方向是"采了不该采的"。
   *
   * ## 三态与 `minutesEnabled` 保持一致
   *
   * 没有这一行（没配过）→ 不限。所以返回的两个值都可能是 undefined，
   * 渠道层据此决定传不传 `--start/--end`。
   *
   * ★ 直接查原始表而不是 `DistillSourceRepository.list()`：同 `minutesEnabled`
   * 的理由 —— 那个方法对缺失的 kind 会合成一行，于是"没配过"不可辨识。
   */
  private minutesTimeRange(): { since?: number; until?: number } {
    const row = this.options.db
      .prepare<
        [string],
        { scope_json: string | null }
      >("SELECT scope_json FROM distill_sources WHERE kind = ?")
      .get("minutes")
    if (row?.scope_json === undefined || row.scope_json === null || row.scope_json === "") {
      return {}
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(row.scope_json)
    } catch {
      // 坏 JSON 按"没配过"处理（不限）。与 onboarding 仓储的 parseJson 同一个
      // 口径：一个手改过的库不该让采集整个停下。
      return {}
    }
    if (typeof parsed !== "object" || parsed === null) return {}
    const scope = parsed as { since?: unknown; until?: unknown }
    return {
      ...(typeof scope.since === "number" && Number.isFinite(scope.since)
        ? { since: scope.since }
        : {}),
      ...(typeof scope.until === "number" && Number.isFinite(scope.until)
        ? { until: scope.until }
        : {}),
    }
  }

  /**
   * 文档源是否开启。判据与听记完全一样（见 `minutesEnabled`）：
   * **没配过 = 默认开**（引导默认勾了它），**显式配成关**才不采。
   *
   * ★ 同样不能用 `DistillSourceRepository.list()` 判 —— 它对缺失的 kind 会
   * 合成一行 `enabled:false`，于是"没配过"与"显式关"同形。
   */
  private documentsEnabled(): boolean {
    const row = this.options.db
      .prepare<[string], { enabled: number }>("SELECT enabled FROM distill_sources WHERE kind = ?")
      .get("doc")
    return row === undefined ? true : row.enabled === 1
  }

  /**
   * 还缺多少篇**可读**文档的正文。
   *
   * 只算白名单后缀（见 `ChannelDocuments.readableExtensions`）——
   * 表格/图片/快捷链接永远取不到，算进来会让"追平了吗"恒为否。
   * 渠道没给白名单时返回 0（判据不可靠时按"已追平"走保守档）。
   */
  private documentsBacklog(): number {
    const exts = this.options.plugin.documents?.readableExtensions
    if (exts === undefined || exts.length === 0) return 0
    return new DocumentRepository(this.options.db).countMissingBody(
      this.options.plugin.meta.id,
      exts,
    )
  }

  /**
   * 本轮该用哪一档（周期 + 每轮篇数）。见 `DOCUMENTS_INTERVAL_MS` 的算术。
   *
   * ★ 每轮**现算**而不是启动时定一次：追平之后要自己降回稳态，
   * 而"清空重来"之后要自己升回冷启动档。存一个快照的话这两个转换都不会发生。
   */
  private documentsPace(): { intervalMs: number; bodiesPerRound: number; backlog: number } {
    const backlog = this.documentsBacklog()
    if (backlog > DOCUMENTS_BACKLOG_THRESHOLD) {
      return {
        /**
         * ★ 取**更勤的那个**：用户可能把周期配得比冷启动档还短
         * （下界 10min），那时该听用户的。反过来用户配了 6 小时也不该
         * 让冷启动卡在 6 小时 —— 那个配置表达的是稳态期望。
         */
        intervalMs: Math.min(DOCUMENTS_INTERVAL_BACKLOG_MS, this.documentsIntervalMs),
        bodiesPerRound: DOCUMENTS_BODY_PER_ROUND_BACKLOG,
        backlog,
      }
    }
    return {
      intervalMs: this.documentsIntervalMs,
      bodiesPerRound: DOCUMENTS_BODY_PER_ROUND,
      backlog,
    }
  }

  /**
   * 排下一轮文档采集。
   *
   * 用 `setTimeout` 自重排而不是 `setInterval`：周期是**分档**的
   * （见 `documentsPace`），而 `setInterval` 的周期在创建时就固定了 ——
   * 那样追平之后仍会每 10 分钟跑一轮全量列举（一天 144 次），
   * 而冷启动结束这件事恰恰是我们要能观察到的。
   */
  private scheduleDocuments(): void {
    if (this.documentsTimer !== null) clearTimeout(this.documentsTimer)
    if (!this.running) return
    const { intervalMs } = this.documentsPace()
    this.documentsTimer = setTimeout(() => {
      void this.tickDocuments().finally(() => this.scheduleDocuments())
    }, intervalMs)
  }

  /**
   * 文档采集：列元信息 → 落库 → 给缺正文的补正文。
   *
   * 结构与 `tickMinutes` 同构（列全量 + 每轮补 N 篇），理由见
   * `DOCUMENTS_INTERVAL_MS` 与 `DOCUMENTS_BODY_PER_ROUND` 的注释。
   *
   * ## 不做水位
   *
   * `drive recent` 按"最近访问"排序、`wiki node list` 按目录树 —— 两者都不
   * 接受时间过滤，所以「重叠窗口 + 水位」那套在这里没有对应物。
   * 幂等靠 `(channel_id, external_id)` 唯一键 + upsert 的正文守卫。
   */
  async tickDocuments(): Promise<{ listed: number; changed: number; bodies: number }> {
    const documents = this.options.plugin.documents
    const empty = { listed: 0, changed: 0, bodies: 0 }
    if (documents === undefined || !this.running) return empty
    if (this.blockedReason !== null) {
      this.noteGated("blocked", "documents")
      return empty
    }
    if (this.suspendedNow()) {
      this.noteGated("suspended", "documents")
      return empty
    }
    if (this.inFlightDocuments !== null) return empty
    // ★ 尊重用户在引导里对「文档」那一栏的勾选（见 documentsEnabled）。
    if (!this.documentsEnabled()) return empty

    const run = this.runDocuments(documents)
    this.inFlightDocuments = run
    try {
      return await run
    } finally {
      this.inFlightDocuments = null
    }
  }

  private async runDocuments(
    documents: NonNullable<ChannelPlugin["documents"]>,
  ): Promise<{ listed: number; changed: number; bodies: number }> {
    const channelId = this.options.plugin.meta.id
    const totals = { listed: 0, changed: 0, bodies: 0 }
    const deps = {
      db: this.options.db,
      clock: this.options.clock,
      logger: this.options.logger,
    }

    try {
      // ① 列元信息（一轮只取首批：wiki 是全量递归，drive 取首页）。
      const listed = await documents.list({})
      if (!this.running) return totals
      totals.listed = listed.items.length

      if (listed.truncated) {
        /**
         * ★ 截断必须**报出来**，不能只体现在条数上。
         *
         * 撞了递归深度 / 单库上限 / 还有更多知识库没列到 —— 三种都会让
         * 这一轮的文档数少于真实值，而"少了"在界面上与"就这么多"无法区分。
         */
        this.options.logger.warn("documents listing truncated; coverage is partial", {
          listed: listed.items.length,
        })
      }

      if (listed.items.length > 0) {
        const now = this.options.clock.now()
        const result = persistDocuments(deps, {
          raw: [
            {
              id: newId(now),
              channelId,
              resource: "doc",
              // 列举没有单一平台主键（一轮聚合了多次调用）→ 空串，
              // 幂等靠 payloadHash（见 raw_records 的 UNIQUE 与 §3.3）。
              externalId: "",
              payload: listed.rawPayload,
              payloadHash: sha256(listed.rawPayload),
              source: "dws-cli",
              fetchedAt: now,
            },
          ],
          documents: listed.items.map((item) => ({
            id: newId(item.updatedAt ?? now),
            channelId,
            externalId: item.externalId,
            origin: item.origin,
            title: item.title,
            docType: item.docType,
            extension: item.extension,
            url: item.url,
            workspaceId: item.workspaceId,
            // 列举这一步没有正文：null 会被 upsert 的 COALESCE 保留已有值
            contentText: item.contentText,
            updatedAt: item.updatedAt,
            createdAt: item.createdAt,
            fetchedAt: now,
          })),
        })
        totals.changed = result.changed.length
      }

      /**
       * ② 给缺正文的补正文。
       *
       * ★ 两处**都**用分档的值（见 `documentsPace`）：篇数是这一档的配额，
       * 而队列按 `readableExtensions` 过滤 —— 后者不做的话每轮配额会被
       * 表格/图片白占（实测队首 8 篇里 2 篇是 `able`，而且每轮都是同样那几篇）。
       */
      const pace = this.documentsPace()
      const readable = documents.readableExtensions
      const repo = new DocumentRepository(this.options.db)
      if (pace.backlog > DOCUMENTS_BACKLOG_THRESHOLD) {
        /**
         * 冷启动档要能被看到：它跑 10 分钟一轮、每轮 20 篇，
         * 而"为什么这会儿采集这么频繁"必须查得出来。追平后这条自然消失。
         */
        this.options.logger.info("documents backlog; using catch-up pace", {
          backlog: pace.backlog,
          intervalMs: pace.intervalMs,
          bodiesPerRound: pace.bodiesPerRound,
        })
      }
      for (const row of repo.listMissingBody(channelId, pace.bodiesPerRound, readable)) {
        if (!this.running) break
        const body = await documents.body({
          externalId: row.externalId,
          extension: row.extension,
        })
        if (!this.running) break
        /**
         * ★ 取不到正文也要**落一次**（`contentText` 仍是 null）。
         *
         * 不落的话这一篇会永远留在 `listMissingBody` 的队首，每轮都被重试
         * —— 而表格/脑图那类**永远**取不到正文。落一次让 `fetched_at` 前进，
         * 于是它排到队尾（按 updated_at 排序时不再霸占前 5 个位置）。
         *
         * 更彻底的办法是记一个"终态 miss"（像头像那样），但文档的情况不同：
         * 一篇表格明天可能被转成文档，所以不该判终态。按后缀过滤已经
         * 挡住了绝大多数无谓调用（见 `READABLE_EXTENSIONS`）。
         */
        if (body.contentText !== null || body.rawPayload !== null) {
          const now = this.options.clock.now()
          persistDocuments(deps, {
            raw:
              body.rawPayload === null
                ? []
                : [
                    {
                      id: newId(now),
                      channelId,
                      resource: "doc.body",
                      // 正文有平台主键 → 用它，让同一篇的重复抓取幂等。
                      externalId: row.externalId,
                      payload: body.rawPayload,
                      payloadHash: sha256(body.rawPayload),
                      source: "dws-cli",
                      fetchedAt: now,
                    },
                  ],
            documents: [
              {
                id: row.id,
                channelId,
                externalId: row.externalId,
                contentText: body.contentText,
                fetchedAt: now,
              },
            ],
          })
          if (body.contentText !== null) totals.bodies += 1
        }
      }

      if (totals.changed > 0 || totals.bodies > 0) {
        this.options.logger.info("documents synced", { ...totals })
        this.events.emit("batch.persisted", { changed: totals.changed })
      }
      return totals
    } catch (error) {
      /**
       * 文档整轮失败**不进退避、不写 blockedReason**：它是增益路径，
       * 失败只是这一轮没采到文档，消息侧完全不受影响
       * （与定向补拉、对账同一个口径）。
       */
      this.options.logger.warn("documents sync failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return totals
    }
  }

  /**
   * 定向补拉**一个会话**的近期消息，并立刻落库 + 推快照。
   *
   * ## 为什么需要它（两个"要立刻看见"的场景）
   *
   * 全局轮询（`tickPull`）是 2 分钟一轮的全量分页。而有两件事等不了那 2 分钟：
   * · **我们自己刚发出一条** —— 发送 API 只回 `openTaskId`，消息不在库里；
   *   要等下一轮 `list-all` 才拉回来。定向补拉让它秒级出现在会话里。
   * · **探针/事件说某会话有更新** —— 只补那一个，不必等全局轮询到它。
   *
   * ## 与 `tickPull` 的边界
   *
   * 这条**不动实时水位**（`commitProgress`）：它是"额外补一小段"，
   * 与对账（`reconcileStale`）同理 —— 推水位会让全局轮询以为这段已抽干。
   * 幂等键（`payload_hash`）兜住它与全局轮询重叠的那部分，不产生重复行。
   *
   * 渠道无 `pullConversation` 能力（或该会话查不到 target）时返回 0，
   * 不报错 —— 调用方退回等全局轮询。
   *
   * @param options.reason 调用来源。`"self-sent"` 表示"用户/数字人自己刚发出
   *   一条"，此时**不受范围闸约束**（见下面那段）。
   * @returns 新落库的消息条数
   */
  async refreshConversation(
    conversationExternalId: string,
    options: { reason?: "self-sent" } = {},
  ): Promise<number> {
    const ingest = this.options.plugin.ingest
    if (ingest === undefined || ingest.pullConversation === undefined) return 0
    if (!this.running) return 0
    if (this.blockedReason !== null) {
      this.noteGated("blocked", "refreshConversation")
      return 0
    }
    if (this.suspendedNow()) {
      this.noteGated("suspended", "refreshConversation")
      return 0
    }

    /**
     * ★★ 范围闸：不在用户勾选范围内的会话**一次定向请求都不发**。
     *
     * ## 这道闸挡住的是四个入口
     *
     * `refreshConversation` 有五个调用方，其中四个的入参完全不受范围约束：
     * · **探针 hints**（`tickProbe`）—— `list-unread-conversations` 返回的是
     *   "有未读红点的会话"，与用户勾了什么毫无关系；
     * · **事件通路**（`DataPlaneService` 的 `onSignal`）——
     *   `event consume user_im_message_receive_at` 是"一个订阅覆盖全部群"，
     *   服务端侧**无法**按会话收窄（见 `ChannelEvents` 契约），所以越界事件
     *   照收；能做的只有"收到了也不去拉"；
     * · **对账**（`reconcileStaleDirected`）—— 来自 `probe_snapshots`，全量；
     * · **常驻会话**（`refreshResidents`）—— 数字人正在服务的会话。
     *
     * 少了这道闸，前向就算在 `persist` 里把数据丢了，**请求本身仍然发了出去**
     * —— 那是对一个用户明确排除掉的会话做了一次真实读取。按 CLAUDE.md
     * 第 5 节，"不许扩大读取面"针对的正是这件事，而不只是"不许存下来"。
     *
     * ## 为什么"自己刚发出的"要例外
     *
     * `onSentMessage` 那条路径的目的是把**用户自己刚发的**消息秒级拉回来
     * 显示（发送 API 只返回 openTaskId，消息不在库里）。它不是"扩大采集面"：
     * 那条消息是用户此刻的主动行为，且他正盯着这个会话等它出现。
     * 拦掉的话表现是"我发出去了但界面上没有" —— 一个明显的功能缺陷。
     *
     * 落库仍然过 `persist` 的范围闸，所以越界会话里这条消息不会进语料；
     * 这里放行的只是"去把它取回来"这一次请求。
     */
    if (options.reason !== "self-sent") {
      const scope = readCollectionScope(this.options.db)
      if (!isConversationInScope(scope, conversationExternalId)) {
        this.options.logger.debug("ingest skipping out-of-scope conversation", {
          allowed: scope.allow.size,
        })
        return 0
      }
    }

    const conversations = new ConversationRepository(this.options.db)
    const conversation = conversations.findByExternalId(
      this.options.plugin.meta.id,
      conversationExternalId,
    )
    if (conversation === null) return 0

    /**
     * ★ 已判定不可读的会话**永久跳过**，不再发一次必失败的请求。
     *
     * 服务端拒绝就是拒绝（实测保密群 `server_error_code=1001`）。
     * 不跳的话每 2 分钟一轮都会再撞一次 —— 那是白烧配额，
     * 且日志里会堆一串看起来像"故障"的告警。
     *
     * 这里读的是落库标记而不是本轮的错误：终态错误只让**这一次**停下，
     * 「以后都别再试」需要持久化（见 `markUnreadable` 的注释）。
     */
    const unreadable = conversations.unreadableByExternalId(this.options.plugin.meta.id)
    const reason = unreadable.get(conversationExternalId)
    if (reason !== undefined) {
      this.options.logger.info("ingest skipping unreadable conversation", { reason })
      return 0
    }

    /**
     * 定向拉的目标：群用 openConversationId（= external_id），
     * 单聊用**对端 openDingTalkId**（external_id 是 cid，不是人 —— 见
     * `findPeerExternalId` 的注释）。单聊对方从没说过话时拿不到对端，
     * 返回 0（那时也确实没有增量可补）。
     */
    let target: Parameters<NonNullable<typeof ingest.pullConversation>>[0]["target"]
    if (conversation.type === "group") {
      target = { kind: "group", openConversationId: conversation.externalId }
    } else {
      const peer = conversations.findPeerExternalId(conversation.id)
      if (peer === null) return 0
      target = { kind: "direct", peerOpenId: peer }
    }

    /**
     * 从"我们库里这个会话的最新一条"往新拉。一条都没有时退回最近 10 分钟
     * —— 刚发出的那条必然落在这个窗里，而 10 分钟足够覆盖发送到补拉的间隔。
     */
    const latest = new MessageRepository(this.options.db).latestSentAtByExternalId(
      this.options.plugin.meta.id,
      conversationExternalId,
    )
    const since = latest ?? this.options.clock.now() - 10 * 60_000

    /**
     * ★ 兜住 FK：`persistBatch` 只从 `page.conversations` 里解析会话 →
     * 消息 的外键，而 `chat message list` 的响应是**平铺消息**
     * （无会话分组，见 message-parse.ts 的 flat 分支）。那样每条消息都会被
     * 「conversation not resolved」丢掉。这个会话我们库里已经有（上面刚查到），
     * 页面没带就用库里那行补上——定向拉不该因为响应形状不同就落不了库。
     */
    const fallbackConversation = {
      externalId: conversation.externalId,
      title: conversation.title,
      type: conversation.type,
      memberCount: conversation.memberCount,
    }

    try {
      /**
       * ## ★★ 真正的翻页循环（首版这里是**单次调用**）
       *
       * 实测证据：`chat message list` 每页返回 `hasMore=true` 且一个群
       * 第一页 97 条、抽干 **636 条**。首版只调一次就返回，于是定向补拉
       * 恒只拿第一页 —— 而它是"落后会话唯一的补救路径"
       * （`reconcileStaleDirected` 就靠它，见那里的注释：全局窗被 7 天
       * 夹子挡住，补不到落后 167 天的会话）。
       *
       * 翻页**不能用 cursor**：这条命令没有 `--cursor`（实测传了 `exit=3`，
       * `unknown flag`）。只能推进 `--time`，见
       * `ChannelConversationPullSpec` 的文件头。
       *
       * 方向用 `newer`（与 `since` 的语义一致：从库里最新那条往现在拉）。
       */
      let cursorAt = since
      let pages = 0
      let changed = 0
      /** 已见过的消息 id：跨页去重（退一秒重叠必然带来重复，见下）。 */
      const seen = new Set<string>()

      while (pages < MAX_PAGES_PER_CONVERSATION) {
        const page = await ingest.pullConversation({
          target,
          since: cursorAt,
          direction: "newer",
          limit: PAGE_LIMIT,
        })
        pages += 1
        // stop 可能在 await 期间发生（logout 撞上正在跑的补拉）。写库前返回。
        if (!this.running) return changed

        const conversationsForPage =
          page.conversations.length > 0 ? page.conversations : [fallbackConversation]
        changed += this.persist({ ...page, conversations: conversationsForPage }).changed.length

        if (!page.hasMore) break
        if (page.messages.length === 0) break

        /**
         * ★★ 下一页起点 = 本页**最新**那条的时间 **减** `PAGE_OVERLAP_MS`。
         *
         * 为什么必须退这一秒：时间边界是 **exclusive**，而 `createTime`
         * **只到秒**。实测以「本页边界那一秒」当下一页 `--time` 时，
         * **该秒的其余消息永久丢失** —— 两种朴素推进法各丢 24 条，
         * 且丢的不是同一批。单页内同秒多条是常态（实测一页 96 个不同秒里
         * 就有重复秒）。
         *
         * 退一秒必然让边界那批重复返回，所以**必须**配 `seen` 去重才不会
         * 原地打转（`payload_hash` 兜住了"不产生重复行"，但兜不住
         * "同一页反复拉到预算耗尽"）。
         */
        let newest = cursorAt
        let fresh = 0
        for (const message of page.messages) {
          if (!seen.has(message.externalId)) {
            seen.add(message.externalId)
            fresh += 1
          }
          if (message.sentAt > newest) newest = message.sentAt
        }
        // 一整页都是见过的 → 已经在原地打转，停（否则烧满预算换 0 条）。
        if (fresh === 0) break
        const nextAt = newest - PAGE_OVERLAP_MS
        // 时间没前进 → 停。不停的话下一轮参数完全相同，必然死循环。
        if (nextAt <= cursorAt) break
        cursorAt = nextAt
      }

      if (changed > 0) {
        this.options.logger.info("ingest refreshed conversation", { changed, pages })
      } else if (pages >= MAX_PAGES_PER_CONVERSATION) {
        // 撞预算而一条没新增是异常的（正常情况下会先 break）—— 值得看见。
        this.options.logger.warn("ingest conversation drain hit page budget", { pages })
      }
      return changed
    } catch (error) {
      /**
       * ★ 服务端明确拒绝这个会话 → 落一个持久标记，不再重试。
       *
       * 这是与 `persist` 里那条（`list-all` 的伪消息）互补的另一半：
       * 保密群在**逐会话**接口上是直接抛错的（`RESOURCE_FORBIDDEN`），
       * 根本走不到 persist。只记日志的话每轮都会再撞一次。
       *
       * `PERMISSION_REQUIRED` 记成 `cross_org`：它与保密群不同 ——
       * 用户在宿主 UI 授权一次就能读，所以原因要分开记，UI 才能说对话
       * （见 `markUnreadable` 的注释）。
       *
       * ⚠️ 实测 `CrossOrgPermissionDenied` 绝大多数是**我们自己调错了**：
       * 用会话列表的 `ownerOpenDingtalkId` 当单聊对端会稳定触发它。
       * 改用 `findPeerExternalId`（消息里的真实 sender）后 30 个单聊里
       * 29 个不再需要任何授权。所以标记成 cross_org 之前，ID 那条路
       * 必须已经是对的 —— 否则这个标记会把一个我们自己的 bug
       * 固化成"用户需要去授权"。
       */
      if (isAppError(error) && !error.retryable) {
        const kind =
          error.code === "RESOURCE_FORBIDDEN"
            ? "confidential"
            : error.code === "PERMISSION_REQUIRED"
              ? "cross_org"
              : null
        if (kind !== null) {
          conversations.markUnreadable(
            this.options.plugin.meta.id,
            conversationExternalId,
            kind,
            this.options.clock.now(),
          )
          this.options.logger.warn("ingest conversation marked unreadable", {
            reason: kind,
            code: error.code,
          })
          return 0
        }
      }
      // 定向补拉失败**不进退避、不写 lastError**：它是额外的一趟，
      // 失败只是这一次没补上，全局轮询完全不受影响（与 reconcileStale 同理）。
      this.options.logger.warn("ingest refreshConversation failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return 0
    }
  }

  private async runMinutes(
    minutes: NonNullable<ChannelPlugin["minutes"]>,
  ): Promise<{ listed: number; changed: number; bodies: number }> {
    const channelId = this.options.plugin.meta.id
    const totals = { listed: 0, changed: 0, bodies: 0 }
    const deps = {
      db: this.options.db,
      clock: this.options.clock,
      logger: this.options.logger,
    }
    /**
     * ★★ 用户选的时间范围。**每轮现读**（不缓存）——
     * 用户改了范围下一轮就该生效，而缓存过期的方向恰好是
     * "继续采已经被排除掉的时间段"。见 `minutesTimeRange` 的注释。
     */
    const range = this.minutesTimeRange()

    try {
      /**
       * ① **抽干**列表分页。
       *
       * 首版只取首页，而那是一个静默的数据缺失（见 `MINUTES_MAX_LIST_PAGES`
       * 的注释：第 51 场之前的会议永远采不到，且状态页看不出来）。
       *
       * ## ★ 每页各自落库，不攒到最后
       *
       * 攒起来的话中途 `stop()`（logout / 退出）会把已经拉到的几页一起丢掉，
       * 而它们本来是可以保住的。听记的 upsert 是幂等的
       * （`(channel_id, external_id)` 唯一键 + 正文守卫），所以多次小事务
       * 与一次大事务在结果上等价，但抗中断。
       *
       * ## ★ 每轮都从 `cursor=null` 重新抽干是**有意**的
       *
       * 听记没有水位可推（`--start/--end` 是可选筛选而非水位语义），
       * 而重复列举的代价只有 CLI 调用：upsert 的正文守卫保证未变化的行
       * **不发 Outbox seq**（见 `MinutesRepository.upsertMany`），
       * 所以下游不会每轮重算全部听记。
       *
       * 20 页 × 约 0.5s ≈ 10s，30 分钟一轮可接受；且听记走的是
       * `inFlightMinutes` 这个独立守卫（不占 `this.busy`），
       * 所以它跑多久都不会挡住消息侧的采集。
       */
      let cursor: string | null = null
      let pages = 0
      let drained = false

      while (pages < MINUTES_MAX_LIST_PAGES) {
        const { page, rawPayload } = await minutes.list({
          cursor,
          ...(range.since === undefined ? {} : { since: range.since }),
          ...(range.until === undefined ? {} : { until: range.until }),
        })
        // stop 可能在 await 期间发生（logout 撞上正在跑的这一轮）。写库前返回。
        if (!this.running) return totals
        pages += 1
        totals.listed += page.items.length

        if (page.items.length > 0) {
          const now = this.options.clock.now()
          const result = persistMinutes(deps, {
            raw: [
              {
                id: newId(now),
                channelId,
                resource: "minutes",
                /**
                 * 列举没有单一平台主键（这是第 N 页）→ 空串，幂等靠 payloadHash。
                 * ★ 空串而不是 null：可空列参与 UNIQUE 时那些行的唯一性
                 * 完全不生效（见 raw-records.ts 文件头）。
                 */
                externalId: "",
                payload: rawPayload,
                payloadHash: sha256(rawPayload),
                source: "dws-cli",
                fetchedAt: now,
              },
            ],
            minutes: page.items.map((item) => ({
              id: newId(item.startedAt ?? now),
              channelId,
              externalId: item.externalId,
              title: item.title,
              startedAt: item.startedAt,
              durationSec: item.durationSec,
              summaryText: item.summaryText,
              transcriptJson: item.transcriptJson,
              speakersJson: item.speakersJson,
              fetchedAt: now,
            })),
          })
          totals.changed += result.changed.length
        }

        // 服务端说没有下一页 → 抽干了。
        if (!page.hasMore) {
          drained = true
          break
        }
        /**
         * 说还有但没给游标 → 翻不动。`drained` 留 false（确实没抽干）。
         *
         * 与「游标没前进」分开判是因为两者的成因不同：前者是响应缺字段，
         * 后者是服务端回了同一个游标。合成一个 break 的话日志里分不出来。
         */
        if (page.nextToken === null) break
        // 游标没前进 → 停，否则下一轮参数完全相同，必然死循环。
        if (page.nextToken === cursor) break
        cursor = page.nextToken
      }

      /**
       * ★ 记覆盖面 —— 截断必须**可见**，不能只体现在条数上。
       *
       * 落库而不是只记日志：状态页要显示它，而日志用户看不到。
       * 完整理由见 `MinutesCoverageRepository` 的注释。
       */
      const minutesRepo = new MinutesRepository(this.options.db)
      new MinutesCoverageRepository(this.options.db).record(channelId, {
        drained,
        earliestStartedAt: minutesRepo.earliestStartedAt(channelId),
        listedTotal: totals.listed,
        at: this.options.clock.now(),
      })
      if (!drained) {
        /**
         * 撞了页数预算 / 游标异常 —— 这一轮的覆盖面是**不完整**的。
         *
         * warn 而不是 info：与 `documents listing truncated` 同一个口径。
         * 正常情况下会先命中 `hasMore === false` 而走不到这里。
         */
        this.options.logger.warn("minutes listing not drained; coverage is partial", {
          pages,
          listed: totals.listed,
        })
      }

      // ② 给缺正文的补正文（每轮限量，见方法注释）。
      for (const row of minutesRepo.listMissingBody(channelId, MINUTES_BODY_PER_ROUND)) {
        if (!this.running) break
        const body = await minutes.body(row.externalId)
        if (!this.running) break
        const now = this.options.clock.now()
        persistMinutes(deps, {
          raw: [
            {
              id: newId(now),
              channelId,
              resource: "minutes.body",
              // 正文有平台主键 → 用它，让同一条听记的正文重复抓取幂等。
              externalId: row.externalId,
              payload: body.rawPayload,
              payloadHash: sha256(body.rawPayload),
              source: "dws-cli",
              fetchedAt: now,
            },
          ],
          minutes: [
            {
              id: row.id,
              channelId,
              externalId: row.externalId,
              summaryText: body.summaryText,
              transcriptJson: body.transcriptJson,
              // 转写抽了几页 / 抽干了吗 —— 状态页据此报"N 场会转写不完整"
              transcriptPages: body.transcriptPages,
              transcriptTruncated: body.transcriptTruncated,
              fetchedAt: now,
            },
          ],
        })
        totals.bodies += 1
      }

      if (totals.changed > 0 || totals.bodies > 0) {
        this.options.logger.info("minutes ingested", { ...totals, pages, drained })
      }
    } catch (error) {
      // 听记失败**不影响消息采集**：分开记录，不进 blockedReason
      // （听记是附加能力，为它把整条采集链路停掉是不成比例的）。
      this.options.logger.warn("minutes tick failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    return totals
  }

  /**
   * L2：拉正文并入库。
   *
   * `busy` 守卫防止两轮重叠：探针触发与定期兜底可能同时到，
   * 而并发跑同一个时间窗只会做无用功（幂等保证不出错，但白花成本）。
   *
   * ## ★ 显式待办窗口队列（而不是"切窗后接着跑切小的那个"）
   *
   * 截断检测会把一个窗二分成两个子窗。旧实现只接着跑左半、把右半丢掉，
   * 且随后对切小的窗 commitWindow —— 水位推到 mid，实测永久跳过 3.5 天历史。
   * 现在两个子窗**都入队**，逐个抽干。
   *
   * ## ★ 两条不变式（整个函数的正确性都挂在它们上）
   *
   * 1. **`queue` 始终按 `start` 升序**。切窗产生的两个子窗天然有序，
   *    插到队首（`unshift(left, right)`）保持整体有序。
   * 2. **`confirmedEnd` 是"已抽干的连续前缀"的右端**，不是"抽干过的最大右端"。
   *    水位是一个单一时间点，语义是「它之前的都已落库」——
   *    所以部分完成时只能推到从左端起连续抽干的那个位置。
   *
   * 有了 (1)，逐个 `shift` 出来抽干、每抽干一个就把 `confirmedEnd` 前移到它的
   * 右端，得到的就恰好是 (2)。这样撞上翻页预算时仍能推进已确认的那一段 ——
   * 否则「一直撞预算」会让水位永远不动、每轮从同一个起点重跑（活锁）。
   *
   * ## ★ `running` 复查（不只看 `busy`）
   *
   * stop 之后不该再起新的一轮，也不该在写库前继续往一个即将被关掉的
   * 连接上写。守卫只看 `busy` 的话，logout → 关库的路径上会抛出
   * `The database connection is not open`。
   */
  async tickPull(): Promise<{ changed: number; unchanged: number }> {
    const ingest = this.options.plugin.ingest
    // ★ `running` 也要查：stop 之后起新一轮 = 往已关闭的库上写。
    if (ingest === undefined || !this.running || this.busy) {
      return { changed: 0, unchanged: 0 }
    }
    if (this.blockedReason !== null) {
      this.noteGated("blocked", "pull")
      return { changed: 0, unchanged: 0 }
    }
    if (this.suspendedNow()) {
      this.noteGated("suspended", "pull")
      return { changed: 0, unchanged: 0 }
    }
    this.busy = true
    // 退避：连续失败后跳过若干轮（`attempts` 必须被消费，否则病态渠道会
    // 以固定频率持续烧 CLI 调用而不升级告警）。手动同步走 `runOnce` 时
    // 用户是显式要求，会先 clearBackoff 再跑。
    if (this.backoffRounds > 0) {
      this.backoffRounds -= 1
      this.options.logger.debug("ingest pull skipped by backoff", {
        remaining: this.backoffRounds,
      })
      this.busy = false
      return { changed: 0, unchanged: 0 }
    }
    // 记下在途 promise 供 `stop()` await：不等它就关库会抛无人 catch 的 rejection。
    const pending = this.runPull(ingest).finally(() => {
      this.busy = false
      this.inFlightPull = null
    })
    this.inFlightPull = pending
    return pending
  }

  /** `tickPull` 的本体。抽出来是为了让 busy/in-flight 的记账只有一处。 */
  private async runPull(
    ingest: NonNullable<ChannelPlugin["ingest"]>,
  ): Promise<{ changed: number; unchanged: number }> {
    const totals = { changed: 0, unchanged: 0 }
    try {
      const rootWindow: PullWindow = this.scheduler.nextWindow()
      this.scheduler.beginWindow(rootWindow)

      // 不变式 (1)：**按 start 升序**（见上文，水位只能推连续前缀）。
      const queue: PullWindow[] = [rootWindow]
      // 不变式 (2)：已抽干的连续前缀右端；null = 一个窗都还没抽干完。
      let confirmedEnd: number | null = null
      // 整轮的全局最大业务时间（跨所有子窗），优先用它推水位。
      let maxSentAt: number | null = null
      let pages = 0
      // 撞预算 / 切到最小宽度这类"本轮没抽干"要在状态页可见（见下文）。
      let degraded: string | null = null

      while (queue.length > 0 && pages < MAX_PAGES_PER_WINDOW) {
        const window = queue.shift() as PullWindow
        let cursor: string | null = null
        let drained = false

        // 抽干这个窗的全部分页。
        while (pages < MAX_PAGES_PER_WINDOW) {
          const page = await ingest.pull({
            start: window.start,
            end: window.end,
            cursor,
            limit: PAGE_LIMIT,
          })
          pages += 1
          // stop 可能在 await 期间发生（logout 撞上正在跑的采集）。
          // 在**写库前**返回：库随后就会被关掉。
          if (!this.running) return totals

          /**
           * ★ 先落库，再判断要不要切窗。
           *
           * 顺序反了（先判切窗、切了就 `break` 丢掉这一页）会造成
           * 「拉了就扔」：满页窗会切窗，而每次切窗都白扔一整页 50 条。
           * 实测 20 轮：671 次 CLI 调用拉回 27743 条、仅落库 10118 条 ——
           * 64% 的采集成本纯浪费，60msg/min 时子进程时间达 444min。
           *
           * 先落库是安全的：幂等键（payload_hash）保证子窗重拉同一批消息
           * 不会产生重复行，切窗的意义只是"把这段时间再扫一遍以防截断"，
           * 不是"这一页的数据不能要"。
           *
           * > 订正：原注释写的是「DWS 的 list-all 实测从不返回 cursor」。
           * > 那个结论是被信封 bug 误导出来的（在根对象上找 nextCursor，
           * > 而它在 result 下）。实测**每页都带**非空 nextCursor，
           * > 但 276/277 页 `hasMore:false` —— 所以终止判据是 hasMore，不是 cursor。
           */
          const result = this.persist(page)
          totals.changed += result.changed.length
          totals.unchanged += result.unchanged
          for (const message of result.changed) {
            // 用服务端的业务时间推水位，不用本地 now
            if (maxSentAt === null || message.sentAt > maxSentAt) maxSentAt = message.sentAt
          }

          // 截断检测：只在「没有下一页却刚好满页」时才可疑（见 splitIfTruncated）。
          // 对每页都判定会让正常满页误触发，回溯几乎停滞。
          //
          // ★ 传 `hasMore ? "more" : null` 而不是原始 cursor：判据的语义是
          // "还有没有下一页"，而 cursor 非空**不代表**还有下一页（见上文订正）。
          // 传原始 cursor 会让「满页 + 无下一页」这个可疑组合永远不成立，
          // 截断检测就等于关掉了。
          const split = this.scheduler.splitIfTruncated(window, {
            itemCount: page.itemCount,
            nextCursor: page.hasMore ? "more" : null,
          })
          if (split !== null) {
            // 两个子窗都入队：只跑左半等于永久跳过右半那段历史。
            // 插到**队首**以保持不变式 (1)（队列按 start 升序）。
            queue.unshift(split[0], split[1])
            break
          }

          /**
           * ★ 终止判据是 `hasMore`，**不是** cursor 是否为空。
           *
           * 实测 277 页里 276 页 `hasMore:false` 却仍返回一个非空
           * `nextCursor` —— 按"cursor 为空才算抽干"写的话 `drained`
           * 永远为 false，这个窗会一直翻到撞 MAX_PAGES_PER_WINDOW 预算，
           * 然后被当成"没抽干"放回队首，下一轮从头再来。
           * 表现是**水位永不前进**（活锁）而每轮烧 50 次 CLI 调用，
           * 且日志里只有一句"page budget exhausted"，看不出是游标语义读错了。
           */
          if (!page.hasMore) {
            drained = true
            this.scheduler.advancePage(null)
            break
          }
          cursor = page.nextCursor
          this.scheduler.advancePage(cursor)
          if (cursor === null) {
            drained = true
            break
          }
        }

        // 这个窗完整抽干了 → 连续前缀前移到它的右端（不变式 2）。
        // 没抽干的两种情况：① 切了窗（子窗已入队，父窗不必放回）；
        // ② 预算耗尽（放回队首，让下面识别出"还有活没干完"）。
        if (drained) confirmedEnd = window.end
        else if (pages >= MAX_PAGES_PER_WINDOW) {
          queue.unshift(window)
          break
        }
      }

      if (queue.length > 0) {
        // 还有窗没抽干：水位只能推到已确认的连续前缀，剩下的下轮继续。
        // 关键是**仍然推进**已确认的那段 —— 否则一直撞预算就永远不前进（活锁）。
        if (confirmedEnd !== null) {
          this.scheduler.commitProgress(
            maxSentAt !== null && maxSentAt < confirmedEnd ? maxSentAt : confirmedEnd,
          )
        }
        degraded = `page budget exhausted with ${queue.length} pending window(s)`
        this.scheduler.failWindow(degraded)
        this.options.logger.warn("ingest window queue not drained", {
          pending: queue.length,
          pages,
          confirmedEnd,
        })
        /**
         * ★ 撞预算**本身不进退避**，只有「撞预算且一点没推进」才进。
         *
         * 大回溯（7 天历史 + 密集语料）会连着很多轮撞预算，那是**正常的分批工作**
         * ——每轮都确认掉一段最左侧的历史、水位单调前进。对它退避等于
         * 「回溯越有进展、越被减速」，7 天历史会拖成几小时。
         *
         * 真正该退避的是「撞了预算又什么都没确认」：那说明连第一个窗都抽不干
         * （病态渠道 / 每页都触发切窗），继续以固定频率重试只是烧 CLI 调用。
         */
        this.applyBackoff(confirmedEnd === null)
      } else {
        // ★ 只有整轮所有子窗的所有分页都确认落库后才推进到整窗右端。
        // effectiveEnd 在调用方显式算出：commitWindow 那层薄壳容易让人误传
        // 一个被切小的子窗（那正是修复前的 bug），所以直接调 commitProgress。
        this.scheduler.commitProgress(maxSentAt ?? rootWindow.end)
        this.pendingHints.clear()
        // 整轮抽干 = 成功：清掉退避。
        this.applyBackoff(false)
      }

      // ★ 降级必须在状态页可见。
      //
      // 修复前撞预算只写 DB 的 last_error（scheduler.failWindow），
      // 而 UI 快照读的是 `this.lastError` —— 于是「本轮没抽干」在面板上
      // 完全看不见，与"一切正常"外观相同。同时成功路径要清掉上一轮的
      // 错误，否则一次瞬时失败会永久留在面板上。
      this.lastError = degraded

      /**
       * ★ 对账补采：探针说有更新、而我们库里没有的那些会话。
       *
       * ## 为什么固定窗口不够
       *
       * 水位 + 2 分钟重叠只对抗小的时钟偏差与延迟。服务端延迟**超过重叠窗**
       * 时那段已经被水位推过去了 —— 固定窗口再也不会覆盖它，而漏采的
       * **表现与一切正常完全相同**（状态 idle、无错误）。
       *
       * 实测这台机器 92 个会话里有 8 个落后：6 / 235 / 559 分钟，
       * 另有 3 个会话我们一条消息都没有（探针报未读 1 / 35 / 35）。
       * 跑 `node scripts/check-ingest-gap.mjs` 能看到当前的数字。
       *
       * ## ★ 抽干之后**不推水位**
       *
       * 这个窗是往**回**补的（start 远早于水位）。推水位会让它倒退，
       * 而倒退意味着此后每轮都重拉一大段历史 —— 那不是漏数据，是把采集拖死。
       * 所以这里只 `drainWindow`，绝不 `commitProgress`。
       *
       * ## 为什么放在主窗之后、且只在主窗抽干时跑
       *
       * 主窗是**实时性**优先的那一趟（新消息要尽快到数字人）。对账是补历史，
       * 让它跟在后面；主窗自己都没抽干时（撞预算）更不该再加一趟 ——
       * 那只会让预算更紧，而落后的会话再等一轮没有代价。
       */
      if (degraded === null) await this.reconcileStale(ingest)

      /**
       * ★★ 逐会话抽干「用户勾选的」会话 —— 与全局窗取**并集**。
       *
       * 全局窗（`list-all`）实测召回只有 **89.8%**（42 个群对账），
       * 而它漏掉的 270 条全部在时间窗内。这一趟按会话逐个抽干，
       * 两路并集实测召回 **100%**。去重靠 `payload_hash`（已有机制）。
       *
       * 与对账同样只在主窗抽干时跑（`degraded === null`）：主窗自己都
       * 撞预算时再加一趟只会让预算更紧，而勾选会话再等一轮没有代价。
       */
      if (degraded === null) {
        totals.changed += await this.drainScopedConversations(ingest)
      }

      /**
       * 历史回填：把下界往用户在引导里选的 `since` 推一段。
       *
       * ★ 与对账同样排在主窗之后，但**不**受 `degraded` 约束、且在
       * **自己的 try** 里：补历史是"锦上添花"，而收新消息是数字人的命脉
       * —— 回填炸了不该让这一轮的增量白跑，也不该进增量那条退避
       * （那会让"补历史失败"拖慢收新消息）。
       *
       * 顺序上排在对账之后：对账补的是**刚刚漏掉的**（用户马上会看的），
       * 回填补的是几个月前的 —— 前者更急。
       */
      try {
        /**
         * ★★ 先补**内部空洞**，再往左推下界。
         *
         * 回填只能延伸左端，补不了"已覆盖区间内部"的空段（见
         * `scheduler.interiorGap` 的注释）。实测这台机器就有一个：
         * 首次只回溯 7 天（7/23 起）、之后回填跳到 2 月，于是 3-6 月
         * 落在已覆盖区间里却是空的 —— 而两个游标都认为自己是对的，
         * 没有任何机制会回头看那 4 个月（漏约 3.6 万条且不报错）。
         *
         * 顺序上空洞优先：它是**已知的缺口**，而往左推是"看看还有没有更早的"。
         * 已知的缺口比未知的探索更该先做。
         */
        const gapFilled = await this.fillInteriorGap(ingest)
        totals.changed += gapFilled.changed
        totals.unchanged += gapFilled.unchanged
        if (gapFilled.changed === 0 && !gapFilled.attempted) {
          const backfilled = await this.runBackfillStep(ingest)
          totals.changed += backfilled.changed
          totals.unchanged += backfilled.unchanged
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.scheduler.failBackfillWindow(detail)
        this.events.emit("backfill.changed")
        this.options.logger.warn("ingest backfill failed", { detail })
      }

      // 空闲若干轮后做一次 WAL checkpoint（否则 WAL 只增不减）
      if (this.scheduler.observeRound(totals.changed)) {
        new RetentionRunner(this.options.db, this.options.clock, {}, this.options.logger).run({
          checkpoint: true,
        })
      }

      // FTS 增量建索引：紧跟入库，支撑「新消息 1s 内可搜到」
      await this.ftsConsumer.runOnce()
      /**
       * 蒸馏与数字人两个消费者也在这里推进。
       *
       * 放在同一个 tick 里而不是各起一个定时器：它们都很快（只做本地
       * 入队/投递），而各起定时器会让"有几个后台循环在跑"变得难以说清。
       * 各自的 try 隔离：一个失败不该影响另一个（也不该影响采集）。
       */
      try {
        await this.distillConsumer.runOnce()
      } catch (error) {
        this.options.logger.warn("distill consumer failed", {
          detail: error instanceof Error ? error.message : String(error),
        })
      }
      if (this.personaConsumer !== null) {
        try {
          await this.personaConsumer.runOnce()
        } catch (error) {
          this.options.logger.warn("persona consumer failed", {
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      this.scheduler.failWindow(error instanceof Error ? error.message : String(error))
      await this.recordError(error)
      this.applyBackoff(true)
    }
    // busy 的复位在 `tickPull` 的 finally 里（与 in-flight 记账放在一处）。
    return totals
  }

  /**
   * 对账补采：把「探针说有更新、而我们库里没有」的那段时间再拉一遍。
   *
   * ## ★ 与主窗那一趟刻意**不共用**代码
   *
   * 主循环那一段（queue / confirmedEnd / maxSentAt / splitIfTruncated）
   * 的复杂度全部来自**水位推进**：水位是单一时间点，语义是"它之前的都已
   * 落库"，所以要维护"已抽干的连续前缀"这个不变式。
   *
   * 而对账**不推水位**（见调用处的注释：推了会让它倒退）。不需要维护
   * 那个不变式，也就不需要那套队列与前缀记账。把它塞进主循环意味着
   * 给那段本来就难的逻辑加一个"这一趟不算水位"的分支 —— 而水位算错
   * 是这条链路上最贵的错误（永久漏采或永久重拉）。
   *
   * 所以这里是一个**扁平的翻页循环**：拉、落库、翻到没有为止。
   * 代价是重复了十几行分页代码，换来的是"改主循环时不会顺手改坏对账"。
   *
   * ## 预算
   *
   * 单独一份、且比主窗小（`RECONCILE_MAX_PAGES`）：对账是补历史，
   * 不该和实时那一趟抢预算。抽不完下一轮接着来 —— 落后的会话再等
   * 一轮没有代价（它们已经落后几百分钟了）。
   *
   * ## 不做截断检测
   *
   * 截断检测的作用是"防止水位跳过没抽干的那段"。这里不推水位，
   * 所以满页只意味着"还有下一页"，翻页本身就覆盖了。
   */
  private async reconcileStale(ingest: NonNullable<ChannelPlugin["ingest"]>): Promise<void> {
    const plan = this.scheduler.reconciliationWindow()
    if (plan === null) return

    this.options.logger.info("ingest reconciling stale conversations", {
      staleCount: plan.staleCount,
      start: plan.window.start,
      end: plan.window.end,
    })

    let cursor: string | null = null
    let pages = 0
    let recovered = 0
    try {
      while (pages < RECONCILE_MAX_PAGES) {
        const page = await ingest.pull({
          start: plan.window.start,
          end: plan.window.end,
          cursor,
          limit: PAGE_LIMIT,
        })
        pages += 1
        // stop 可能在 await 期间发生 —— 在写库前返回（库随后会被关掉）
        if (!this.running) return
        recovered += this.persist(page).changed.length
        if (!page.hasMore) break
        cursor = page.nextCursor
        if (cursor === null) break
      }
    } catch (error) {
      /**
       * ★ 对账失败**不进退避、不写 lastError**。
       *
       * 它是额外的一趟；失败了只是这一轮没补上，实时采集完全不受影响。
       * 让它污染退避会让"某个历史会话拉不动"拖慢所有新消息的采集，
       * 而那是把一个次要问题升级成主要问题。
       */
      this.options.logger.warn("ingest reconciliation failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return
    }

    this.options.logger.info("ingest reconciliation done", {
      staleCount: plan.staleCount,
      pages,
      recovered,
    })

    // ★ 全量窗补不到的那些，走逐会话定向补（见下面那个方法的注释）。
    await this.reconcileStaleDirected(ingest)
  }

  /**
   * 逐会话定向补账：**全量窗结构性补不到的那些落后会话**。
   *
   * ## ★ 为什么必须有这一步（实测证据）
   *
   * `reconciliationWindow()` 造的是**一个全局窗**，而它的 `start` 被
   * `INITIAL_BACKFILL_MS`（**7 天**）夹住。于是"库里最新一条早于 7 天"的
   * 落后会话，那个窗**永远覆盖不到**。
   *
   * 实测这台机器（`scripts/check-ingest-gap.mjs`，107 个会话）：8 个落后，
   * 其中 4 个落后 235 分钟 ~ **167 天**、1 个库里一条都没有。
   * 前者的消息全都早于 7 天前 —— 也就是说上面那一趟跑了也补不回来，
   * 而脚本的结论正是「要靠定向补采」。
   *
   * ## 为什么这里能补到
   *
   * `pullConversation` 是**按会话 + 起始时间**拉（`chat message list
   * --direction newer`），没有全局窗那个 7 天夹子：起点直接取
   * "我们库里这个会话的最新一条"（`refreshConversation` 内部就是这么取的）。
   * 一个会话一趟，落后 167 天也能从那一点往后接着拉。
   *
   * ## 预算与失败处置
   *
   * 每轮最多补 `RECONCILE_MAX_DIRECTED` 个会话（对账是补历史，不该和实时
   * 那一趟抢 CLI 调用）；抽不完下一轮接着来。单个会话失败只记日志 ——
   * `refreshConversation` 自己已经不进退避、不写 lastError（它是额外的一趟）。
   *
   * 渠道没有 `pullConversation` 能力时整个跳过（`refreshConversation` 返回 0）。
   */
  private async reconcileStaleDirected(
    ingest: NonNullable<ChannelPlugin["ingest"]>,
  ): Promise<void> {
    if (ingest.pullConversation === undefined) return
    const stale = new ProbeSnapshotRepository(this.options.db).staleConversations(
      this.options.plugin.meta.id,
    )
    if (stale.length === 0) return

    /**
     * 先补**落后最多**的：那些正是全局窗夹子覆盖不到的（库里最新一条最旧）。
     * `oursLastMsgAt === null`（一条都没有）排最前 —— 它落后 ∞。
     */
    const ordered = [...stale].sort(
      (left, right) => (left.oursLastMsgAt ?? 0) - (right.oursLastMsgAt ?? 0),
    )
    let recovered = 0
    let attempted = 0
    for (const item of ordered.slice(0, RECONCILE_MAX_DIRECTED)) {
      if (!this.running) return
      attempted += 1
      recovered += await this.refreshConversation(item.conversationExternalId)
    }
    if (attempted > 0) {
      this.options.logger.info("ingest directed reconciliation done", {
        staleCount: stale.length,
        attempted,
        recovered,
      })
    }
  }

  /**
   * 用户在引导里选的采集下界（unix ms）；null = 不限。
   *
   * ## ★ 这个值曾经是纯装饰
   *
   * 引导页把「180 天 + 勾选的会话」写进 `distill_sources.scope_json`，
   * 而**没有任何代码读它** —— 采集照旧用写死的 `INITIAL_BACKFILL_MS`
   * （7 天）。于是用户选了半年，库里只有 7 天，而界面上没有任何地方
   * 显示这个落差：产物看起来是完整的，只是画像薄。
   *
   * 源没开或没配范围时返回 undefined（≠ null）：null 是用户**显式选了
   * 「不限」**，那要一直往回挖；undefined 是"没说"，此时不该启动回填。
   */
  private backfillSince(): number | null | undefined {
    const scope = readCollectionScope(this.options.db)
    // 源关掉 → 不回填（`readCollectionScope` 对关掉的源给 since: undefined）
    if (!scope.enabled) return undefined
    return scope.since
  }

  /**
   * 当前采集范围。**每次现读**，不缓存 —— 用户改勾选要立刻生效。
   *
   * ## ★★ 这个列表曾经完全没有采集方在读
   *
   * 引导页把「时间下界 + 勾选的会话」写进 `distill_sources.scope_json`，
   * 而采集只读了 `since`（见 `backfillSince`）—— `conversationIds`
   * 只有 forge / feed / distill 在读，也就是「采全量，蒸的时候才过滤」。
   *
   * 实测这台机器的后果是**两个方向同时错**：
   * · 用户勾了 44 个会话，其中只有 3 个在库里有数据；
   * · 库里 54,307 条消息，**53,769 条（99%）属于没勾选的会话**。
   *
   * 后者不只是浪费 —— 按 CLAUDE.md 第 5 节，超出用户选定范围去采集
   * 是**隐私问题**，不是"多采点没坏处"。
   *
   * 判据统一走 `@mycontext/store` 的 `readCollectionScope`：修复前采集、
   * 蒸馏、forge、导出各有一份实现，而它们对"源被关掉"的解读已经漂成了
   * 「不限」（= 采全部）。四份实现里漂一份就是一次隐私事故且不报错。
   */
  private collectionScope(): CollectionScope {
    return readCollectionScope(this.options.db)
  }

  /**
   * 勾选的会话 external_id（逐会话抽干那一趟的驱动列表）。
   *
   * 不限（`restricted === false`）时返回空数组 —— 调用方据此整趟跳过，
   * 因为那时全局窗已经覆盖了全部会话。
   */
  private scopedConversationIds(): string[] {
    const scope = this.collectionScope()
    if (!scope.restricted) return []
    return [...scope.allow]
  }

  /**
   * 按用户勾选的会话**逐个抽干**。
   *
   * ## 为什么必须有这一趟（而不是只靠全局窗）
   *
   * 全局窗（`list-all`）实测**不是全量**：42 个群对账下来它的召回是
   * **89.8%**，漏掉的 270 条全部落在请求的时间窗内。最极端的一个 42 人群，
   * `list-all` 翻完 48 页返回 **0 条**，而逐会话立刻给 29 条。
   *
   * 而逐会话也不能单独用：它对跨组织会话会被拒（`CrossOrgPermissionDenied`），
   * 那些恰恰只有 `list-all` 读得到（实测 14 条群消息 + 1 个跨组织单聊）。
   *
   * 所以两路都要，**按 `openMessageId` 取并集**。去重不需要新机制 ——
   * `persistBatch` 的 `payload_hash` 幂等键已经兜住了重复写入
   * （实测两路返回同一条消息时 id 完全一致）。并集实测召回 **100%**。
   *
   * ## 为什么排在最后、且有自己的预算
   *
   * 它是补历史性质的一趟，不该和"新消息尽快到数字人"抢 `busy` 锁。
   * 每轮只处理 `SCOPED_DRAIN_PER_ROUND` 个会话，**轮转**着来
   * （用 `scopedDrainOffset` 记进度）—— 抽不完下一轮接着，
   * 而每个会话内部的起点是"库里这个会话的最新一条"，所以天然可续跑。
   *
   * 不推任何水位：与对账、补空洞同一个口径（那几条水位的语义是
   * 「[0, 它) 已完整」，而这一趟是逐会话往回补的）。
   */
  /**
   * 会话目录（三路合并）—— **带缓存**。
   *
   * ★ 缓存是必需的而不是优化：三路合并实测约 **4.8s**（两次
   * `list-all-conversations` + `chat group list-all` 翻页，见 conversations.ts
   * 文件头），比扫描周期本身还长。每轮重取会让这一级从"最便宜的一路"
   * 变成"最贵的一路"，而它存在的全部理由就是廉价。
   *
   * TTL 2 分钟：目录**结构**的变化（新建群、新单聊）不需要秒级发现。
   * 而"已有会话有没有新消息"这件事不受 TTL 影响 —— 那靠每轮与库里比对
   * （比对的是缓存里的 `lastMessageAt`，而它随每次重取刷新）。
   */
  private async conversationDirectory(): Promise<readonly ChannelConversationItem[]> {
    const capability = this.options.plugin.conversations
    if (capability === undefined) return []
    const now = this.options.clock.now()
    const cached = this.directoryCache
    if (cached !== null && now - cached.at < CONVERSATION_DIRECTORY_TTL_MS) return cached.items
    const list = await capability.list()
    // stop 可能在 await 期间发生 —— 那时不要把结果写进缓存（下次 attach 可能是别的账号）
    if (!this.running) return []
    this.directoryCache = { at: now, items: list.items }
    return list.items
  }

  /**
   * L1.5 轮转扫描：**按最近活跃优先**扫全部会话，补探针的盲区。
   *
   * ## ★★ 为什么需要这一级（实测证据，见 `ACTIVE_SCAN_INTERVAL_MS`）
   *
   * 探针只调 `list-unread-conversations` —— 只返回**有未读红点**的会话。
   * 实测覆盖率 **13.3%**（23/173），而盲区里有 **33 个会话在 48 小时内
   * 有新消息**。原因很直接：在客户端读过就没有红点了，而"读过"恰恰
   * 说明那是最活跃的会话。
   *
   * ## 判据：拿渠道的时间戳与库里比，而不是逐个发请求
   *
   * 一次目录调用就拿到全部会话的 `lastMessageAt`（缓存后接近零成本），
   * 与库里各自的最新一条比（一次 GROUP BY）——
   * `渠道的 > 库里的` 就是有新消息。所以**一轮的固定成本与会话数无关**，
   * 只有真的落后的那几个才付定向补拉的钱。
   *
   * 逐个探测是不可行的：173 次子进程 × 0.6s ≈ 100 秒，30 秒一轮跑不完。
   *
   * ## 排序：DWS 不支持，我们自己排
   *
   * 实测 `chat list-all-conversations` **没有任何 sort flag**，且
   * `--cursor` 无效（传 0/1/50 返回逐字相同的首页），返回顺序**大体降序
   * 但不严格**（99 个相邻对里 22 个逆序）。但 `lastMsgCreateAt` 100% 齐全，
   * 所以按它降序排就是精确的活跃度序 —— 最活跃的先补。
   *
   * ## 边界
   *
   * · **尊重用户勾选的范围**：勾了就只扫那些（超范围采集是隐私问题，
   *   见 CLAUDE.md 第 5 节）；
   * · **不可读的跳过**：保密群识别过就不再碰；
   * · **不推任何水位**：与对账、补空洞同一个口径 —— 那几条水位的语义是
   *   「[0, 它) 已完整」，而这一趟是逐会话补的；
   * · **轮转**：命中数可能远超预算（冷启动时几乎全部落后），
   *   用 `activeScanOffset` 保证尾部不被饿死。
   */
  async tickActiveScan(): Promise<number> {
    const ingest = this.options.plugin.ingest
    if (ingest?.pullConversation === undefined) return 0
    if (!this.running || this.busy) return 0
    if (this.blockedReason !== null) {
      this.noteGated("blocked", "activeScan")
      return 0
    }
    if (this.suspendedNow()) {
      this.noteGated("suspended", "activeScan")
      return 0
    }

    this.busy = true
    try {
      const directory = await this.conversationDirectory()
      if (!this.running || directory.length === 0) return 0

      const channelId = this.options.plugin.meta.id
      const conversations = new ConversationRepository(this.options.db)
      const unreadable = conversations.unreadableByExternalId(channelId)
      // ★ 一次 GROUP BY 拿全部会话的库内最新时间 —— 逐个查会阻塞主进程 173 次
      const ours = new MessageRepository(this.options.db).latestSentAtByChannel(channelId)
      const scope = this.collectionScope()

      /**
       * 落后的会话 = 渠道说的最后消息时间**晚于**我们库里的最新一条。
       *
       * 库里一条都没有（`ours` 里没这个 key）时也算落后 —— 那是最该补的
       * 那一类（实测有 3 个会话我们一条消息都没有，而探针报未读 1/35/35）。
       */
      const stale: { externalId: string; remoteAt: number; oursAt: number | null }[] = []
      for (const item of directory) {
        if (item.lastMessageAt === null) continue
        if (unreadable.has(item.externalId)) continue
        /**
         * ★ 只扫范围内的。
         *
         * 判据走 `isConversationInScope` 而不是 `scoped.size > 0 && ...`：
         * 后者把"配了范围但一个都没勾"当成"不限"，于是"我一个都不要"
         * 被执行成"全都要"（见 collection-scope.ts 文件头）。
         */
        if (!isConversationInScope(scope, item.externalId)) continue
        const oursAt = ours.get(item.externalId) ?? null
        if (oursAt === null || item.lastMessageAt > oursAt) {
          stale.push({ externalId: item.externalId, remoteAt: item.lastMessageAt, oursAt })
        }
      }
      if (stale.length === 0) return 0

      /**
       * ★ 按渠道的最后消息时间**降序** —— 最近活跃的先补。
       *
       * 这正是用户要的"按最近更新优先"。而 DWS 自己不排序（实测无 sort flag
       * 且返回顺序不严格），所以排序必须在这里做。
       */
      stale.sort((left, right) => right.remoteAt - left.remoteAt)

      // 轮转：从上一轮停下的位置继续，尾部不会饿死
      const offset = this.activeScanOffset % stale.length
      const batch = [...stale.slice(offset), ...stale.slice(0, offset)].slice(
        0,
        ACTIVE_SCAN_PER_ROUND,
      )
      this.activeScanOffset = (offset + batch.length) % stale.length

      let recovered = 0
      for (const item of batch) {
        if (!this.running) break
        // `refreshConversation` 自己不进退避、不写 lastError（额外的一趟）
        recovered += await this.refreshConversation(item.externalId)
      }

      if (recovered > 0 || stale.length > 0) {
        this.options.logger.info("ingest active scan done", {
          scanned: directory.length,
          stale: stale.length,
          attempted: batch.length,
          recovered,
        })
      }
      // 快照推送不用在这里做：`persist()` 已经 emit `batch.persisted`，
      // DataPlane 订阅它并节流推给 UI（见那里的注释）。
      return recovered
    } catch (error) {
      /**
       * 整轮失败**不进退避、不写 blockedReason**：它是增益路径，
       * 失败只是这一轮没扫（与对账、定向补拉同一个口径）。
       */
      this.options.logger.warn("ingest active scan failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return 0
    } finally {
      this.busy = false
    }
  }

  private async drainScopedConversations(
    ingest: NonNullable<ChannelPlugin["ingest"]>,
  ): Promise<number> {
    if (ingest.pullConversation === undefined) return 0
    const scoped = this.scopedConversationIds()
    // 没勾选 = 不限定范围 → 全局窗那一趟已经覆盖，不必再逐个跑一遍。
    if (scoped.length === 0) return 0

    const conversations = new ConversationRepository(this.options.db)
    const unreadable = conversations.unreadableByExternalId(this.options.plugin.meta.id)
    /**
     * 只保留「库里有这一行、且没被判定不可读」的。
     *
     * 库里没有的跳过而不是报错：`refreshConversation` 需要从库里读会话类型
     * 与单聊对端。实测有 42 个勾选的 id 在当前渠道目录里查不到 ——
     * 那是引导页存的 id 与可用 id 之间的一层不一致，值得单独查，
     * 但不该让这一趟整体失败。
     */
    const candidates = scoped.filter(
      (externalId) =>
        !unreadable.has(externalId) &&
        conversations.findByExternalId(this.options.plugin.meta.id, externalId) !== null,
    )
    if (candidates.length === 0) return 0

    // 轮转：从上一轮停下的位置继续，保证每个会话都会轮到。
    const offset = this.scopedDrainOffset % candidates.length
    const slice = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(
      0,
      SCOPED_DRAIN_PER_ROUND,
    )
    this.scopedDrainOffset = (offset + slice.length) % candidates.length

    let recovered = 0
    for (const externalId of slice) {
      if (!this.running) return recovered
      // `refreshConversation` 自己不进退避、不写 lastError（额外的一趟）。
      recovered += await this.refreshConversation(externalId)
    }
    if (recovered > 0) {
      this.options.logger.info("ingest scoped drain done", {
        scoped: scoped.length,
        candidates: candidates.length,
        attempted: slice.length,
        recovered,
      })
    }
    return recovered
  }

  /**
   * 往更早的时间回填一个窗。
   *
   * ## 为什么一轮只跑一个窗
   *
   * 每轮（2 分钟）推进一个 7 天窗 → 180 天约 26 轮 ≈ 52 分钟，
   * 全程不阻塞增量采集、进程随时可退出续跑。一轮里贪多会让
   * 「收新消息」的延迟被补历史拖长，而那是数字人的响应速度。
   *
   * ## 与增量共用同一套抽干逻辑
   *
   * 截断切窗、`hasMore` 判据、翻页预算这三条都照抄增量那边 ——
   * 它们各自防一种静默丢消息，回填**同样**会踩（它拉的数据量更大）。
   */
  /**
   * 补一段**内部空洞**（已覆盖区间里连续多天没消息的那种）。
   *
   * ## 与回填、对账的分工
   *
   * · **回填**：延伸左端（`[floor, 最早消息)`）—— 只能往更早走；
   * · **对账**：探针说某会话有更新而我们没有 → 补那一小段（分钟到小时级）；
   * · **本方法**：已覆盖区间**内部**连续多天空白 → 补那一段（天到月级）。
   *
   * 三者都是"额外的一趟"，都**不推增量水位**（那条水位的语义是
   * 「[0, 它) 已完整」，而这些补采是往回填的，推它会让水位倒退或说谎）。
   *
   * ## ★ 为什么一轮只补一段、且只补到预算为止
   *
   * 一个 4 个月的空洞按实测密度要约 760 页，而单轮预算 120 页。
   * 所以这里**不追求一轮补完**：拉到预算就停，下一轮 `interiorGap`
   * 会算出一个**变小了的**空洞（因为刚补进去的消息把它切短了），
   * 于是自然续跑。这让它天然可中断、可续跑，且不需要额外的游标。
   *
   * ## 返回 `attempted` 而不是只返回条数
   *
   * 调用方要区分「没有空洞」与「有空洞但这一轮没捞到新的」——
   * 前者该去跑回填（往左推），后者不该（否则会把预算从空洞那边抢走）。
   */
  private async fillInteriorGap(
    ingest: NonNullable<ChannelPlugin["ingest"]>,
  ): Promise<{ changed: number; unchanged: number; attempted: boolean }> {
    const totals = { changed: 0, unchanged: 0, attempted: false }
    const gap = this.scheduler.interiorGap()
    if (gap === null) return totals
    totals.attempted = true

    const gapDays = (gap.end - gap.start) / (24 * 60 * 60_000)
    this.options.logger.info("ingest filling interior gap", {
      from: new Date(gap.start).toISOString(),
      to: new Date(gap.end).toISOString(),
      days: Math.round(gapDays),
    })

    /**
     * 用与回填**同一套**抽干逻辑（截断切窗 + hasMore + 翻页预算）——
     * 那三条各防一种静默丢消息，空洞这边同样会踩。
     */
    const queue: PullWindow[] = [gap]
    let pages = 0
    while (queue.length > 0 && pages < MAX_PAGES_PER_BACKFILL_ROUND) {
      const window = queue.shift() as PullWindow
      let cursor: string | null = null
      while (pages < MAX_PAGES_PER_BACKFILL_ROUND) {
        const page = await ingest.pull({
          start: window.start,
          end: window.end,
          cursor,
          limit: PAGE_LIMIT,
        })
        pages += 1
        // stop 可能在 await 期间发生（logout 撞上正在跑的补采）。写库前返回。
        if (!this.running) return totals
        // ★ `backfill: true` —— 补历史的消息不投给数字人（与回填同一个理由）。
        const result = this.persist(page, { backfill: true })
        totals.changed += result.changed.length
        totals.unchanged += result.unchanged

        const split = this.scheduler.splitBackfillIfTruncated(window, {
          itemCount: page.itemCount,
          nextCursor: page.hasMore ? "more" : null,
        })
        if (split !== null) {
          queue.unshift(split[0], split[1])
          break
        }
        if (!page.hasMore) break
        cursor = page.nextCursor
        if (cursor === null) break
      }
    }

    /**
     * ★ 刻意**不推任何游标**。
     *
     * 空洞的进度由「空洞本身变小」体现（下一轮 `interiorGap` 重新算），
     * 而不是由一个游标记着。理由：空洞可能有多个、也可能在补的过程中
     * 分裂成两个更小的 —— 用游标记"补到哪了"会在分裂时失效，
     * 而重新算是幂等且自洽的。
     */
    this.options.logger.info("ingest interior gap round done", {
      pages,
      changed: totals.changed,
      pending: queue.length,
    })
    return totals
  }

  private async runBackfillStep(
    ingest: NonNullable<ChannelPlugin["ingest"]>,
  ): Promise<{ changed: number; unchanged: number }> {
    const totals = { changed: 0, unchanged: 0 }
    const since = this.backfillSince()
    if (since === undefined) return totals

    const rootWindow = this.scheduler.nextBackfillWindow(
      since,
      this.backfillWidthOverrideMs ?? undefined,
    )
    if (rootWindow === null) return totals
    this.scheduler.beginBackfillWindow(rootWindow)
    /**
     * 回填状态本身也是进度。
     *
     * 一个窗口可能全部是重复数据，`persist()` 此时不会发 `batch.persisted`，
     * 但 activeWindow 已经变化。只靠入库事件会让 UI 一直停在上一个窗口。
     */
    this.events.emit("backfill.changed")

    /**
     * 队列按 start **升序**，与增量那边同理：下界只能往左推连续前缀。
     * 切窗后两个子窗都入队 —— 只跑一半等于永久跳过另一半历史。
     */
    const queue: PullWindow[] = [rootWindow]
    // 已抽干的连续**左**端；null = 一个窗都没抽干。注意方向与增量相反。
    let confirmedStart: number | null = null
    let pages = 0

    while (queue.length > 0 && pages < MAX_PAGES_PER_BACKFILL_ROUND) {
      const window = queue.shift() as PullWindow
      let cursor: string | null = null
      let drained = false

      while (pages < MAX_PAGES_PER_BACKFILL_ROUND) {
        const page = await ingest.pull({
          start: window.start,
          end: window.end,
          cursor,
          limit: PAGE_LIMIT,
        })
        pages += 1
        // stop 可能在 await 期间发生（logout 撞上正在跑的回填）。写库前返回。
        if (!this.running) return totals

        // 先落库再判切窗（顺序反了会「拉了就扔」，见增量那边的注释）。
        // ★ `backfill: true` —— 补历史的消息不投给数字人，见 `persist`。
        const result = this.persist(page, { backfill: true })
        totals.changed += result.changed.length
        totals.unchanged += result.unchanged

        const split = this.scheduler.splitBackfillIfTruncated(window, {
          itemCount: page.itemCount,
          nextCursor: page.hasMore ? "more" : null,
        })
        if (split !== null) {
          queue.unshift(split[0], split[1])
          break
        }
        if (!page.hasMore) {
          drained = true
          this.scheduler.advanceBackfillPage(null)
          break
        }
        cursor = page.nextCursor
        this.scheduler.advanceBackfillPage(cursor)
        if (cursor === null) {
          drained = true
          break
        }
      }

      /**
       * ★ 只有**队列空了**才敢把下界推到 rootWindow.start。
       *
       * 抽干一个子窗不等于它左边也抽干了：下界是"这个点左边还没采"的
       * 断言，提前推过去会让中间那段永久无人覆盖。所以这里只记
       * "整轮的最左端"，真正提交在循环外，且以 `queue.length === 0` 为条件。
       */
      if (drained) {
        confirmedStart =
          confirmedStart === null ? window.start : Math.min(confirmedStart, window.start)
      } else if (pages >= MAX_PAGES_PER_BACKFILL_ROUND) {
        queue.unshift(window)
        break
      }
    }

    if (queue.length === 0 && confirmedStart !== null) {
      this.scheduler.commitBackfillFloor(confirmedStart)
      this.options.logger.info("ingest backfill window done", {
        from: new Date(confirmedStart).toISOString(),
        to: new Date(rootWindow.end).toISOString(),
        changed: totals.changed,
        pages,
      })
      this.backfillStalledRounds = 0
      this.backfillStalled = null
      /**
       * 抽干了就丢掉「卡住后强制减半」那个 override，交回给自适应。
       *
       * ## ★ 这一行曾与旧的自适应组成一个**永不收敛的循环**
       *
       * 旧的自适应按「库里的密度」估宽度，而它在**未采区间**上高估 30 倍
       * （见 `scheduler.ts` 的 `adaptiveBackfillWidth` 注释）。于是：
       *
       *   宽窗撞预算 → 3 轮后减半 → 减半那轮抽干了 → **清掉 override**
       *   → 又估出同样的宽窗 → 又撞 3 轮 → …
       *
       * 每 4 轮只前进半个窗，而每轮是 120 次 CLI 调用（约 72 秒）。
       * 实测后果：3-6 月整段被跳过（库里只留 465 条且全来自 2 个群，
       * 单聊一条都没有），而服务端那段其实有约 3.7 万条。
       *
       * ★ 现在清它是**安全**的：自适应改成了按上一轮真实页数反馈，
       * 撞过预算的那一轮会让它自己收窄（÷3），不会再回到那个宽度。
       * 也就是"收窄"这件事从 override 移进了反馈回路本身 ——
       * override 只剩"连续卡住时加速收敛"这一个作用。
       */
      this.backfillWidthOverrideMs = null
    } else {
      /**
       * 没抽干就**一点都不推**下界。
       *
       * 与增量那边"推已确认的连续前缀"不同：那边的队列有序且水位向前，
       * 推一段是安全的；这边队列是切窗后乱序插入的，"已确认的连续左端"
       * 无法在中途可靠地算出来。宁可下一轮整窗重跑（幂等键兜住重复），
       * 也不能把一个不完整的下界记进去 —— 那会静默跳过一段历史。
       */
      this.backfillStalledRounds += 1
      this.options.logger.info("ingest backfill round not drained; floor unchanged", {
        pending: queue.length,
        pages,
        stalledRounds: this.backfillStalledRounds,
      })
      /**
       * ★ 连续抽不干必须升级成**告警 + 状态页可见**，不能一直 info。
       *
       * 「不推下界」是安全的，但连着不推就是**活锁**：每轮烧满预算重拉
       * 同一个窗，回填永远到不了目标。实测踩过一次（固定 7 天窗 + 密集
       * 账号：一窗 5900 条 vs 6000 条预算），当时日志里只有一行
       * `round not drained`，看起来和"正在跑"一模一样。
       *
       * 窗宽自适应（`adaptiveBackfillWidth`）应该让这件事不再发生，
       * 所以走到这里说明那个估算也没兜住 —— 那是需要有人看见的。
       */
      if (this.backfillStalledRounds >= BACKFILL_STALL_ROUNDS) {
        /**
         * ★ 卡住后**主动把窗切窄**，而不是无限重试同一个窗。
         *
         * 光告警不够：估算再准也总有估歪的时候（这个账号就有单窗需要 167 页
         * 而预算 120 的真实区间），而"重试同一个宽度"在数学上永远不会成功
         * —— 每轮烧满预算、拉回的全是已落库的重复行，下界一步不动。
         * 实测 5 轮 120 页，新增 0 条。
         *
         * 减半是收敛的：窗宽有下限（`MIN_BACKFILL_WIDTH_MS`），最多几轮
         * 就会切到预算装得下的宽度。而幂等键让重叠重拉不产生重复行，
         * 所以切窄的唯一代价是多跑几轮。
         */
        this.backfillWidthOverrideMs = Math.max(
          MIN_BACKFILL_WIDTH_MS,
          Math.floor((rootWindow.end - rootWindow.start) / 2),
        )
        this.backfillStalled =
          `历史回填连续 ${String(this.backfillStalledRounds)} 轮没抽干当前时间窗（` +
          `每轮 ${String(pages)} 页）。已把窗宽减半重试；若仍不前进，` +
          `说明这段历史的消息密度超过单轮预算。`
        this.options.logger.warn("ingest backfill stalled; halving window width", {
          stalledRounds: this.backfillStalledRounds,
          pending: queue.length,
          pages,
          window: {
            from: new Date(rootWindow.start).toISOString(),
            to: new Date(rootWindow.end).toISOString(),
          },
          nextWidthMs: this.backfillWidthOverrideMs,
        })
        // 重置计数：让减半后的窗有完整的 N 轮机会，而不是立刻又判定卡住。
        this.backfillStalledRounds = 0
      }
    }
    // floor / stalled / activeWindow 都可能变化，即使这一轮新增消息为 0。
    this.events.emit("backfill.changed")
    return totals
  }

  /**
   * 按 DB 里的连续失败次数设置退避轮数。
   *
   * 读 DB 而不是自己再数一遍：`attempts` 由 `commitWindow` 归零，
   * 而"什么算成功"的定义只该有一份（在 scheduler 里）。
   */
  private applyBackoff(failed: boolean): void {
    if (!failed) {
      this.backoffRounds = 0
      return
    }
    this.backoffRounds = Math.min(this.scheduler.failedAttempts, MAX_FAILURE_BACKOFF_ROUNDS)
  }

  /**
   * 入库 + 发快通道信号。
   *
   * 信号在事务**提交后**发（persistBatch 返回即已提交）：
   * 提交前发信号会让订阅方查不到那条消息。
   *
   * 两个事件、两种粒度，刻意分开：
   * · `inbound.message` —— **逐条**，数字人订阅（它要对每条消息判定是否回复）；
   * · `batch.persisted` —— **每批一次**，UI 状态推送订阅。
   *
   * 分开的原因：`snapshot()` 是 9 个全表 COUNT 的同步查询，回溯 20 万条时
   * 逐条触发累计约 21 分钟主进程阻塞（实测单次 0.29ms@1万行 → 6.31ms@20万行）。
   * 而状态页要的只是"现在有多少条"，批级粒度完全够。
   */
  private persist(
    page: {
      conversations: Parameters<typeof normalize>[0]["conversations"]
      messages: Parameters<typeof normalize>[0]["messages"]
      rawPayload: string
      /** 服务端拒绝读取的会话（保密群等）。见 `ChannelPullPage`。 */
      refusedConversations?: string[]
    },
    options: { backfill?: boolean } = {},
  ) {
    /**
     * ★ 先记「不可读」，再落库。
     *
     * 放在 `persist` 里是因为它是**所有**采集路径的唯一漏斗（增量、回填、
     * 对账、定向补拉、补空洞都走这里）。放在某一条路径上的话，
     * 其余几条仍会把保密群当"0 条"，而那正是要消灭的静默失效。
     *
     * 幂等：同一个会话反复标记只刷新时间戳。
     */
    const refused = page.refusedConversations ?? []
    if (refused.length > 0) {
      const conversations = new ConversationRepository(this.options.db)
      const now = this.options.clock.now()
      for (const externalId of refused) {
        conversations.markUnreadable(this.options.plugin.meta.id, externalId, "confidential", now)
      }
      this.options.logger.warn("ingest marked conversations unreadable", {
        count: refused.length,
        reason: "confidential",
      })
    }

    /**
     * ★★ 范围闸：把**用户没勾选**的会话与超出时间范围的消息在入库前丢掉。
     *
     * ## 为什么必须在这里
     *
     * `persist` 是全部五条采集路径的唯一漏斗（增量主窗、对账、回填、
     * 补空洞、定向补拉）。而**越界数据的主要来源是全局窗**：
     * `chat message list-all` 只接受时间窗（`--start/--end/--cursor/--limit`），
     * **没有会话过滤参数** —— 服务端一定会把窗内所有会话的消息都返回。
     * 也就是说"不采越界会话"这件事在渠道侧无法表达，只能在落库前拦。
     *
     * 实测（本机 vault）后果：84,325 条消息里 46,415 条（55%）属于用户
     * 没勾的 178 个会话，且最近 1 小时新落库的 327 条里仍有 208 条（64%）
     * 越界 —— 按 CLAUDE.md 第 5 节这是隐私问题，不是"多采点没坏处"。
     *
     * ## 为什么不在这里过滤 `page.conversations`
     *
     * 会话**目录**要留（它不是聊天内容，只有标题/人数/类型）：
     * · 引导页的会话选择列表要能列出还没采过的会话（否则用户选不到它）；
     * · `refreshConversation` 靠库里的会话行判类型、查单聊对端；
     * · `drainScopedConversations` 的候选过滤前置要求会话行存在。
     * 把目录也筛掉会让"取消勾选"变成"以后再也勾不回来"。
     *
     * ## 丢弃必须**可见**
     *
     * 只 `continue` 不计数的话，"越界被丢"与"这段时间没消息"在日志和
     * 状态页上完全同形 —— 那正是这个代码库里最贵的那类静默降级
     * （CLAUDE.md 第 4 节）。所以累计进 `droppedOutOfScope` 并进快照。
     */
    const scope = readCollectionScope(this.options.db)
    let scopedPage = page
    if (scope.restricted) {
      const kept = page.messages.filter(
        (message) =>
          isConversationInScope(scope, message.conversationExternalId) &&
          isSentAtInScope(scope, message.sentAt),
      )
      const dropped = page.messages.length - kept.length
      if (dropped > 0) {
        this.droppedOutOfScope += dropped
        this.lastDroppedAt = this.options.clock.now()
        this.options.logger.info("ingest dropped out-of-scope messages", {
          dropped,
          kept: kept.length,
          allowed: scope.allow.size,
        })
      }
      scopedPage = { ...page, messages: kept }
    }

    /**
     * ★ 整页都越界时**不写 `raw_records`**。
     *
     * `rawPayload` 是整页原始响应，里面含窗内**所有**会话的消息正文 ——
     * 也就是说即使把 `messages` 筛干净了，只要还写 raw，越界的真实聊天
     * 内容照样以 JSON 形式留在库里（实测 8,705 行 raw 的 `payload_pruned_at`
     * 全为 NULL，即一条都还没裁）。
     *
     * 页内**有**在范围内的消息时仍然写：那一页是那些消息的重放来源，
     * 而重放能力是解析器 bug 的唯一兜底（见 `prunePayloads` 的注释）。
     * 这种页里夹带的越界正文由 `RetentionRunner` 到期裁掉。
     * 这个折中是刻意的：两害相权，宁可留一段有保质期的原始响应，
     * 也不放弃"解析错了能重放"。
     */
    if (scopedPage.messages.length === 0 && page.messages.length > 0) {
      return { changed: [] as MessageRow[], unchanged: 0 }
    }

    const self = new SelfIdentityRepository(this.options.db).get(this.options.plugin.meta.id)
    const result = persistBatch(
      { db: this.options.db, clock: this.options.clock, logger: this.options.logger },
      normalize({
        channelId: this.options.plugin.meta.id,
        conversations: scopedPage.conversations,
        messages: scopedPage.messages,
        rawPayload: scopedPage.rawPayload,
        rawResource: "chat.message",
        selfExternalIds: new Set((self?.openIds ?? []).map((entry) => entry.value)),
        // 显示名用于把 content 里的 `@真名(花名)` 判成"@我"——
        // 实测 list-all 没有 atUsers 字段，@ 只在文本里（见 content-extract.ts）。
        // 未确认身份时传空集：不触发 > 误触发。
        selfDisplayNames: new Set(
          self?.confirmedAt !== null && self?.confirmedAt !== undefined
            ? (self?.displayNames ?? [])
            : [],
        ),
        // 未确认身份时 is_self 一律留 null —— 猜错会永久丢失人格语料
        selfConfirmed: self?.confirmedAt !== null && self?.confirmedAt !== undefined,
        fetchedAt: this.options.clock.now(),
      }),
    )

    /**
     * ★ 认领数字人自己发出去的那些消息。
     *
     * 必须在**发信号之前**：`inbound.message` 会把消息投给管控层，
     * 而准入闸看 `is_self`。数字人发的消息 `is_self = 1`（确实是本人账号
     * 发的），所以它本来就会被拒 —— 但 `origin` 这一列是给**蒸馏**看的，
     * 而蒸馏读的是库，不是这个事件。先标再发信号只是为了让同一批数据
     * 在任何观察点上都是自洽的。
     *
     * 为什么在这里而不是发送成功时标：发送那一刻这条消息**还不在库里**
     * （我们只有平台返回的 openMessageId），要等采集把它拉回来。所以
     * 按平台 id 对账是唯一可行的接法（见 `claimAgentOrigin` 的注释）。
     *
     * 窗口取这一批消息里最早那条的时间再往前一天：对账只需要覆盖
     * 刚采回来的这些，而整张表会一直长。
     */
    if (result.changed.length > 0) {
      const oldest = Math.min(...result.changed.map((row) => row.sentAt))
      const agentSent = new PersonaRunRepository(this.options.db).agentSentExternalIds(
        oldest - 86_400_000,
      )
      const claimed =
        agentSent.length === 0
          ? 0
          : new MessageRepository(this.options.db).claimAgentOrigin(
              this.options.plugin.meta.id,
              agentSent,
            )
      if (claimed > 0) {
        this.options.logger.info("claimed agent-sent messages", { claimed })
      }
    }

    /**
     * ★ 补历史的消息**不投给数字人**。
     *
     * 它们照常落库、照常进蒸馏（那正是回填的目的），但不该进待审队列：
     * 一条 19 天前的消息，现在起草一条回复不是"帮上忙"，是社交事故。
     * 而且回填一轮几千条，逐条走 agent 判定＋起草是几百次调用换 0 个
     * 有用的草稿。
     *
     * 实测踩过：加了反向回填之后，7/13～7/22 的历史消息被当成新消息投给
     * 数字人，起草时已过 10~19 天，而准入闸的年龄判据带一个
     * `conversationRead` 前置条件（未读的群没有任何年龄上限），拦不住。
     *
     * 判据用「这一批是从哪条路径落库的」而不是「消息有多老」：后者要选一个
     * 阈值，而那个阈值同时也是"增量采集允许多晚的消息进队列"——两件事
     * 耦在一个数上，调其中一个必然误伤另一个。
     *
     * ## 慢兜底靠准入闸的年龄上限兜，不靠这里记 id
     *
     * Outbox 消费者会扫 changelog 补投，绕过这里。但**回填的消息按定义
     * 就比库里所有消息都早**（窗口从已知最早那条往左走），所以准入闸里
     * 那条无条件年龄上限（`MAX_GROUP_DRAFTABLE_AGE_MS`）必然拦住它们。
     *
     * 刻意**不**在内存里记一份"这些 id 是回填的"：那个集合会无界增长，
     * 且进程重启后就丢了 —— 重启后消费者补投同一批消息时，那份记录
     * 恰好已经不在。靠一个持久、且对任何灌入路径都成立的判据更可靠。
     */
    if (options.backfill === true) {
      if (result.changed.length > 0) {
        this.events.emit("batch.persisted", { changed: result.changed.length })
      }
      return result
    }

    for (const message of result.changed) {
      this.events.emit("inbound.message", message satisfies MessageRow)
    }
    // 批级信号：UI 推送用这个，不要订阅 inbound.message（见上文）。
    if (result.changed.length > 0) {
      this.events.emit("batch.persisted", { changed: result.changed.length })
    }
    return result
  }

  /**
   * 用户改了采集范围之后，把库对齐到新范围。**立刻**，不等下一轮。
   *
   * ## ★★ 为什么"改了勾选"不能只影响以后
   *
   * 范围闸（`persist` / `refreshConversation` 里那两道）只管住"从现在起
   * 不再采越界的"。而用户把一个会话**取消勾选**时，那个会话的历史消息
   * 已经在库里、已经在 FTS 索引里、已经被导进知识图谱 —— 只挡前向的话
   * 用户的动作在他能观察到的每个地方都**没有效果**：搜得到、蒸得到、
   * 数字人检索事实时照样引用。那与"这个开关是装饰"没有区别。
   *
   * ## 三件事，顺序有意义
   *
   * 1. **清越界**（`purgeOutOfScopeMessages`）—— 先删，因为下面两步的
   *    产物都派生自库里的消息；反了的话会先按旧数据重建一次。
   * 2. **重置回填下界** —— 用户**放宽**范围（勾了新会话 / 把下界往前挪）时
   *    必须让回填重新往回挖。不重置的话 `nextBackfillWindow` 会从
   *    `backfillFloor`（上次已达成的下界）继续，而它已经等于旧的 since
   *    → 返回 null → **新勾的会话永远补不到历史**，只有增量。
   *    表现是"我勾了这个群，但它只有今天的消息"。
   * 3. **叫醒逐会话抽干** —— 新勾的会话在下一轮 `tickPull` 就会被
   *    `drainScopedConversations` 逐个抽干。这里只重置轮转位置，让新加的
   *    不必等一圈（`scopedDrainOffset` 可能正指在列表中段）。
   *
   * 导出与建图**不在这里**做：那是 `FeedService` 的职责（它持有
   * materializer 与建图触发器），由装配层在调完这个方法之后接着调。
   * 在这里去碰它们会让 ingest 反向依赖 feed —— 那正是现在刻意避免的环。
   *
   * @param options.dryRun 只数不删（给"改动会影响多少条"的预览用）
   * @returns 清理报告。`messages: 0` = 新范围下没有越界数据（常见且正常）
   */
  applyScopeChange(options: { dryRun?: boolean } = {}): PurgeReport {
    const scope = this.collectionScope()
    const report = purgeOutOfScopeMessages(
      this.options.db,
      this.options.plugin.meta.id,
      scope,
      options,
    )
    if (options.dryRun === true) return report

    /**
     * ★ 重置回填下界，让放宽后的范围真的会被往回补。
     *
     * `commitFloor` 的 upsert 用的是 `MIN(现有, 新值)`（水位只能往更早走），
     * 所以**不能**靠它把下界"抬回"到一个更晚的值 —— 那正好是我们要的方向：
     * 这里要的是"忘掉已达成的下界，重新按 since 挖"。所以直接删那一行。
     *
     * 删而不是改：`nextBackfillWindow` 对"没有这一行"（watermark 0）的处理
     * 是"落回库里最早那条消息"，也就是从现有数据的左端重新往回走 ——
     * 与首次回填完全同一条路径。少一个特殊分支。
     */
    this.options.db.prepare("DELETE FROM sync_cursors WHERE scope = ?").run(this.backfillScopeKey())
    this.backfillStalled = null
    this.backfillStalledRounds = 0
    this.backfillWidthOverrideMs = null
    /**
     * 轮转位置归零：新勾的会话排在候选列表里的位置未知，而 offset 可能
     * 正指在中段 —— 归零让"刚勾的那个"最迟在下一轮就被抽到。
     */
    this.scopedDrainOffset = 0
    this.activeScanOffset = 0
    /**
     * ★ 会话目录缓存作废。
     *
     * `tickActiveScan` 用它判"哪些会话落后"，而它有 2 分钟 TTL。不清的话
     * 改完范围后最多两分钟内那一趟仍按旧目录跑 —— 数据是对的（闸在
     * persist 上），但"刚勾的会话什么时候开始有数据"会被推迟一个 TTL，
     * 而用户此刻正盯着看。
     */
    this.directoryCache = null
    /**
     * 丢弃计数归零：它回答的是"当前范围下挡掉了多少"，跨范围累加没有意义
     * （用户会把改范围之前挡掉的量误读成新范围仍在漏）。
     */
    this.droppedOutOfScope = 0
    this.lastDroppedAt = null

    this.options.logger.info("ingest scope change applied", {
      restricted: scope.restricted,
      allowed: scope.restricted ? scope.allow.size : null,
      purgedMessages: report.messages,
      purgedConversations: report.conversations,
      purgedFtsRows: report.ftsRows,
      purgedMediaAssets: report.mediaAssets,
    })
    // 清理会改变库里的条数 —— 推一次快照，否则界面上的数字要等下一批消息才更新。
    if (report.messages > 0) this.events.emit("batch.persisted", { changed: 0 })
    return report
  }

  /**
   * 回填游标的 scope 键。
   *
   * 与 `IngestScheduler.backfillScope` 同一个字符串。刻意从 scheduler 上读
   * 而不是在这里再拼一遍 —— 拼错的话 `applyScopeChange` 会删掉一行不存在的
   * 游标（静默无效果：范围放宽了但历史永远补不回来）。
   */
  private backfillScopeKey(): string {
    return this.scheduler.backfillScope
  }

  /**
   * 记录错误并识别**终态**。
   *
   * 登录过期与缺授权靠重试永远好不了 —— 继续重试只会反复弹窗骚扰用户。
   * 因此这两类进入 blocked 状态，由 UI 引导用户处理后手动恢复。
   *
   * ## ★★ `SESSION_EXPIRED` 必须先复核，不能直接判终态
   *
   * 渠道 CLI 的 token 刷新是**懒惰**的：access token 只活 2 小时，
   * 到点后由"下一条命令"就地走 refresh（二进制里那串
   * `access_token expired, trying refresh_token` → `refreshing token
   * (dual-locked)`），而 refresh 要抢锁**并且要发网络请求**。
   *
   * 于是有一个不归我们控制的窗口：**刷新恰好撞上睡眠或断网**。
   * 这时 CLI 拿不到 token，报的是 `not_authenticated` + exit 2 ——
   * 与"refresh token 真的过期了"**完全同形**（同一个 reason、同一个 code）。
   *
   * 实测（2026-08-08 本机）：
   * · 系统 `Entering Sleep` 与那 4 条失败命令**同一秒**（13:11:05）；
   * · CLI 侧 `auth_token_present:false` 在 6756 条命令里**只出现过这 4 次**；
   * · 那 4 条的 `command_start`→`command_end` 墙上钟只差 26µs，
   *   而 `duration` 报 503ms —— 单调钟走了半秒，是进程被冻结的指纹。
   *
   * 直接判终态的后果（已实测）：`blockedReason` 一置位，6 处闸门全部
   * 静默 return，采集**停了 2.5 小时**直到用户手动重新登录 ——
   * 而登录从头到尾都是好的。UI 还显示「登录已过期，去重新授权」，
   * 把用户指向一件不需要做的事。
   *
   * 所以这里去问**权威来源**：`auth status` 说仍然 authorized，
   * 就说明这是瞬时故障，按可重试处理（退避会自然消化掉）。
   * 不猜、不看时间窗、不试图识别"是不是在睡眠" —— 那些都是间接证据。
   *
   * 复核本身失败（网络还没恢复 / 命令超时）时**保持 blocked**：
   * 那时我们无法证明登录是好的，而误判成可重试会退回到无限重试风暴
   * （见 `classifyDwsError` 的注释）。宁可要求用户介入一次。
   */
  private async recordError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    this.lastError = message
    if (isAppError(error)) {
      if (error.code === "SESSION_EXPIRED") {
        if (await this.sessionStillValid()) {
          /**
           * 登录是好的 —— 这次失败是 token 刷新被打断。不置 blocked，
           * 让退避去消化。日志要留痕：否则"采集少了一轮"完全不可见。
           */
          this.options.logger.warn("ingest transient auth failure; session still valid", {
            detail: message,
          })
          return
        }
        this.blockedReason = "session_expired"
        /**
         * ★★ 置闸门的同时**记一次复核时刻** —— 这次判定本身就是一次权威复核。
         *
         * 不记的话下一轮探针会立刻再问一次 `auth status`（间隔判据看到的是
         * `lastSessionRecheckAt = 0`），也就是同一秒内为同一个结论烧两个子进程。
         * 而且那次复核的答案必然还是"未授权"—— 纯浪费。
         *
         * 语义上也该记：`sessionStillValid()` 刚刚问过权威来源并得到否定答案,
         * 复核窗口理应从**这一刻**起算，而不是从下一轮探针起算。
         */
        this.lastSessionRecheckAt = this.options.clock.now()
      } else if (error.code === "PERMISSION_REQUIRED") this.blockedReason = "permission_required"
    }
    this.options.logger.warn("ingest tick failed", { detail: message, blocked: this.blockedReason })
  }

  /**
   * 被 `session_expired` 闸住时，节流地复核一次登录态；恢复了就**自动解闸**。
   *
   * 完整的 why 在 `SESSION_RECHECK_INTERVAL_MS` 上方 —— 一句话：
   * 那个终态原本没有任何自动出路，token 刷好了应用也不会动。
   *
   * @returns `true` = 现在没被闸住（本来就没有，或刚刚自愈）
   *
   * ★ 复核**不抛**（`sessionStillValid` 已经吞掉异常）：拿不到答案就
   * 保持闸住，下一轮再试。让一次网络抖动把闸门打开是更坏的方向。
   */
  private async recheckSessionIfBlocked(): Promise<boolean> {
    if (this.blockedReason === null) return true
    // 数据权限缺失复核不出结果（见常量注释），保持闸住。
    if (this.blockedReason !== "session_expired") return false

    const now = this.options.clock.now()
    if (now - this.lastSessionRecheckAt < SESSION_RECHECK_INTERVAL_MS) return false
    this.lastSessionRecheckAt = now

    if (!(await this.sessionStillValid())) return false

    /**
     * 恢复了。这条必须是 `info` 而不是 `debug`：
     * "卡住了"每 5 分钟一条日志，而"恢复了"只有这一条 ——
     * 少了它，日志里就只剩一串 skipped 然后突然开始正常采集，
     * 没人能解释中间发生了什么。
     */
    this.options.logger.info("ingest session recovered; clearing blocked gate", {
      previous: this.blockedReason,
    })
    this.clearBlocked()
    return true
  }

  /**
   * 复核登录态：`true` = CLI 说仍然 authorized（那次失败是瞬时的）。
   *
   * ★ 复核**不抛**：它只是"能不能证明登录是好的"这一个问题的答案。
   * 拿不到答案（命令失败/超时）返回 false，让调用方保持原本的终态判定。
   */
  private async sessionStillValid(): Promise<boolean> {
    try {
      const status = await this.options.plugin.auth.status()
      return status.state === "authorized"
    } catch (error) {
      this.options.logger.debug("ingest session recheck failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * 用户处理完终态（重新扫码 / 完成授权）后调用。
   *
   * 一并清退避：用户点「重试」时期望的是**立刻**再试一次，
   * 而不是"还要再等 5 轮"（后者表现为点了没反应）。
   *
   * ★ 也清闸门日志的节流表：不清的话"恢复之后又被闸住"的**第一轮**
   * 会落在上一次的 5 分钟窗口里被吞掉 —— 而那一条恰好是最该看到的
   * （它说明用户以为修好了，其实没修好）。
   */
  clearBlocked(): void {
    this.blockedReason = null
    this.lastError = null
    this.backoffRounds = 0
    this.gateLoggedAt.clear()
    /**
     * ★ 也清复核节流：用户点「重试」之后如果又被闸住，
     * 下一轮该**立刻**去问一次权威来源，而不是背着上一个 5 分钟窗口。
     *
     * 具体的坏情形：用户重新扫码 → 点重试（清闸门）→ 但扫的是另一个身份、
     * 于是又被闸住 → 那时 `lastSessionRecheckAt` 还是旧值，
     * 于是"真正修好之后"最多要再等 5 分钟才被发现。
     */
    this.lastSessionRecheckAt = 0
  }

  /**
   * 清掉退避计数（手动同步 / 用户点重试时调）。
   *
   * 与 `clearBlocked` 分开：blocked 是"需要用户去别处处理"的终态，
   * 退避只是"最近失败过所以在减速"。手动同步不该把 blocked 也清掉
   * （那会让登录过期的账号被反复重试）。
   */
  clearBackoff(): void {
    this.backoffRounds = 0
  }

  /**
   * 系统进入睡眠：不再发起新一轮采集。
   *
   * 由 `powerMonitor` 的 `suspend` 驱动。**不动定时器**（不 clearInterval）——
   * 睡眠期间 timer 本来就只在 DarkWake 那几秒里零星触发，而重建定时器要复制
   * `start()` 里那一整段条件装配（听记/文档/轮转扫描各有各的启用条件），
   * 复制一份就是两处会分叉。用一个闸门表达"现在别起新的"更小且不会漏。
   *
   * 在途的那一轮不打断：它可能正 await 一个子进程，硬断会留孤儿进程。
   */
  suspend(): void {
    if (this.suspended) return
    this.suspended = true
    this.suspendedAt = this.options.clock.now()
    this.options.logger.info("ingest suspended (system sleep)")
  }

  /**
   * 系统醒来：放行并**清掉退避**。
   *
   * ★ 清退避是这件事的重点。睡眠期间那几次 DarkWake 已经把
   * `backoffRounds` 推上去了（每次失败 +1），不清的话开盖之后还要空转
   * 好几轮才恢复 —— 用户看到的是"打开电脑后好一会儿没有新消息"。
   *
   * ★ **不清 `blockedReason`**：那是"需要用户去别处处理"的终态，
   * 与睡醒无关（refresh token 真过期了，睡一觉也不会好）。
   * 与 `clearBackoff`/`clearBlocked` 的分工保持一致。
   */
  resume(): void {
    if (!this.suspended) return
    this.suspended = false
    this.suspendedAt = null
    this.backoffRounds = 0
    // 同 clearBlocked：下一次被闸住时那条日志要能立刻出来（见那里的注释）。
    this.gateLoggedAt.clear()
    this.options.logger.info("ingest resumed (system wake)")
  }

  /**
   * 现在是否该按"睡眠中"处理。
   *
   * ★ 带自愈：`resume` 丢了的话不能永久停采（见 `suspended` 字段注释里
   * 那段"两个方向代价不对称"）。超过 `SUSPEND_SELF_HEAL_MS` 就自己放行，
   * 并且**把状态真的复位**（而不是每次都重新算一遍）——
   * 否则日志会在之后每一轮都重复报一次自愈。
   */
  private suspendedNow(): boolean {
    if (!this.suspended) return false
    const since = this.suspendedAt
    if (since !== null && this.options.clock.now() - since > SUSPEND_SELF_HEAL_MS) {
      this.options.logger.warn("ingest suspend flag self-healed; resume event never arrived", {
        suspendedForMs: this.options.clock.now() - since,
      })
      this.suspended = false
      this.suspendedAt = null
      return false
    }
    return true
  }

  /**
   * 「本轮被闸住」——**唯一**该由闸门调用的记录入口。
   *
   * ## ★ 为什么需要它
   *
   * 6 处闸门原本是静默 `return`。于是 blocked / 睡眠期间的日志长这样：
   * 导出照跑、`messages` 一小时纹丝不动、**一条错误都没有** ——
   * 与"真的没人说话"完全无法区分（实测那 2.5 小时就是这么过去的，
   * 定位它得去翻 `pmset -g log`）。这正是本仓库第 4 节说的静默降级形状。
   *
   * ## ★ 只记「被闸住」，不记 `!running` / `busy`
   *
   * 那两个是**正常状态**：停机后不该再采（`stop()` 之后起新一轮 =
   * 往已关闭的库上写），而 `busy` 只是上一轮还没跑完（下一轮自然会跟上）。
   * 把它们也记下来会让这条日志失去信号价值 —— 它要回答的是
   * "为什么该采而没采"。
   *
   * @param reason 闸住的原因（进日志，要能直接读懂）
   * @param route 哪一路（probe/pull/…）。与 reason 一起做节流键，
   *   所以睡眠与 blocked 不会互相顶掉对方的名额。
   */
  private noteGated(reason: "suspended" | "blocked", route: string): void {
    const key = `${reason}:${route}`
    const now = this.options.clock.now()
    const last = this.gateLoggedAt.get(key)
    if (last !== undefined && now - last < GATE_LOG_THROTTLE_MS) return
    this.gateLoggedAt.set(key, now)
    this.options.logger.info("ingest round skipped", {
      reason,
      route,
      // blocked 的具体类型要带上：session_expired 与 permission_required
      // 的处置完全不同（前者重新扫码、后者去来源应用授权）。
      ...(reason === "blocked" ? { blockedReason: this.blockedReason } : {}),
    })
  }

  /**
   * 状态快照：状态页读它。**存储增长必须可见**，否则 500MB 会被当 bug 报上来。
   *
   * ⚠️ 这个函数**不便宜**：9 个全表 `COUNT(*)` + 2 个 pragma。
   * 实测 1 万行 0.29ms、20 万行 6.31ms，而 better-sqlite3 是同步的 ——
   * 每次调用都是主进程的一段硬阻塞。因此**不要在逐条消息的路径上调它**，
   * 只能由 batch 结束或节流后的推送触发（见 data-plane.service 的 pushSnapshot）。
   */
  snapshot(): IngestSnapshot {
    const channelId = this.options.plugin.meta.id
    const messages = new MessageRepository(this.options.db)
    const changelog = new ChangelogRepository(this.options.db)
    const consumers = new ConsumerCursorRepository(this.options.db, this.options.clock)
    const stats = collectStorageStats(this.options.db, this.options.dbPath)
    const self = new SelfIdentityRepository(this.options.db).get(channelId)
    const scope = this.collectionScope()
    const minutesRepo = new MinutesRepository(this.options.db)
    const coverage = new MinutesCoverageRepository(this.options.db).get(channelId)

    return {
      running: this.running,
      channelId,
      messages: messages.count(),
      conversations: new ConversationRepository(this.options.db).count(),
      unjudged: messages.countUnjudged(),
      outboxHead: changelog.head(),
      ftsIndexed: new FtsIndexRepository(this.options.db).count(),
      ftsLag: this.ftsConsumer.lag(),
      probeIntervalMs: this.probeInterval.intervalMs,
      probeThrottled: this.probeInterval.throttled,
      lastError: this.lastError,
      blockedReason: this.blockedReason,
      // 退避中要可见：不显示的话"采集变慢了"看起来与卡住一样。
      failedAttempts: this.scheduler.failedAttempts,
      selfConfirmed: self?.confirmedAt !== null && self?.confirmedAt !== undefined,
      // 媒体与听记也要可见：不显示的话「采到了但没落库」与「本来就没有」
      // 在面板上完全同形 —— 这正是本轮修复的那一类故障。
      mediaAssets: new MediaAssetRepository(this.options.db).count(),
      minutes: minutesRepo.count(),
      /**
       * ★ 听记的覆盖面。**光有条数不够** —— 条数回答"有多少"，
       * 而"是不是全部"是另一个问题（见 `IngestSnapshot.minutesCoverage`）。
       *
       * `coverage === null`（还没跑过一轮）时整块给 null，而不是编一个
       * `drained: true`：那会把"不知道"显示成"没问题"。
       */
      minutesCoverage:
        coverage === null
          ? null
          : {
              drained: coverage.drained,
              earliestStartedAt: coverage.earliestStartedAt,
              transcriptTruncated: minutesRepo.countTranscriptTruncated(channelId),
            },
      storage: {
        mainBytes: stats.mainBytes,
        walBytes: stats.walBytes,
        rawRecords: stats.rawRecords,
        rawPruned: stats.rawPruned,
        vectors: stats.vectors,
      },
      staleConsumers: consumers.staleConsumers().map((consumer) => consumer.consumerId),
      // 「选了 180 天但只采到 7 天」必须可见（见 IngestSnapshot 的注释）。
      backfill: {
        ...this.scheduler.backfillCoverage(this.backfillSince() ?? null),
        stalled: this.backfillStalled,
      },
      /**
       * 范围闸的工作量。见 `IngestSnapshot.scope` 与 `droppedOutOfScope`。
       *
       * `allowed` 在不限时报 null 而不是 0：0 会被读成"许可零个会话"，
       * 而那是完全相反的状态（一个都不采 vs 全都采）。
       */
      scope: {
        restricted: scope.restricted,
        allowed: scope.restricted ? scope.allow.size : null,
        droppedOutOfScope: this.droppedOutOfScope,
        lastDroppedAt: this.lastDroppedAt,
      },
    }
  }
}
