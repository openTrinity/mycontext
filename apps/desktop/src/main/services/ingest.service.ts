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
  DistillSourceRepository,
  FtsIndexRepository,
  MediaAssetRepository,
  MessageRepository,
  MinutesRepository,
  DocumentRepository,
  PersonaRunRepository,
  RetentionRunner,
  ProbeSnapshotRepository,
  SelfIdentityRepository,
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
 * 30 分钟：会议是**稀疏**事件（实测 20 条覆盖数周），而 `minutes list all`
 * 不支持时间过滤 —— 每轮都是全量列，成本固定。按消息那样 2 分钟一轮
 * 等于每小时 30 次无谓的全量拉取。
 */
const MINUTES_INTERVAL_MS = 30 * 60_000
/**
 * 文档轮询周期。
 *
 * ★ 60 分钟，比听记还低频。理由：文档的**变更频率低**（一篇文档一天改几次
 * 已经算活跃），而一轮的成本不小 —— `wiki space list` + 每个知识库递归
 * `node list`（实测该账号 20+ 个库、每库若干层）+ `drive recent` 翻页。
 *
 * 而且文档不像消息有"秒级可见"的需求：没人会因为一篇文档晚一小时进库而
 * 感觉产品坏了。把它压到低频是给消息侧让出采集锁（同一个 busy 锁）。
 */
const DOCUMENTS_INTERVAL_MS = 60 * 60_000
/**
 * 单轮最多补几篇文档正文。
 *
 * 与听记的 `MINUTES_BODY_PER_ROUND` 同一个理由，但给得多一点（5 vs 3）：
 * 文档正文是**一次** CLI 调用（听记要两次：summary + transcription），
 * 且 `doc read` 实测 0.3-0.8s。5 篇约 2-4 秒，可接受。
 *
 * ★ 不要为了"快点补齐"把它调大：这一轮占着 busy 锁，而消息侧在等。
 * 补齐是几轮之后的事，而每一轮都不该长时间阻塞。
 */
const DOCUMENTS_BODY_PER_ROUND = 5
/** 单轮最多补几条听记正文。正文是逐条两次 CLI 调用（summary + transcription）。 */
const MINUTES_BODY_PER_ROUND = 3
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
  private lastError: string | null = null
  private blockedReason: IngestSnapshot["blockedReason"] = null
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
     * 文档周期 15min–6h。
     *
     * ★ 原先写死（注释写的是"等有人真需要再给"）—— 而它与其余四项
     * 不同源这件事本身就是个坑：「采集频率」面板宣称能配采集，
     * 却漏了一路，于是"文档多久拉一次"只有能开 SQLite 的人配得了。
     * 区间给得比听记更宽：知识库重度用户想更勤，纯聊天用户想更懒。
     */
    this.documentsIntervalMs = clamp(
      iv.documentsMs,
      DOCUMENTS_INTERVAL_MS,
      15 * 60_000,
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
        this.documentsTimer = setInterval(() => void this.tickDocuments(), this.documentsIntervalMs)
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
    if (this.documentsTimer !== null) clearInterval(this.documentsTimer)
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
    if (ingest === undefined || !this.running || this.blockedReason !== null) return 0

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
      this.recordError(error)
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
   * 听记采集：列元信息 → 落库 → 给缺正文的补正文。
   *
   * ## 为什么"列"与"补正文"在同一轮但分两步
   *
   * `list` 只给元信息，正文要逐条再调两次（summary + transcription）。
   * 若在 list 的循环里同步补正文，一次全量（实测 20 条 × 2 = 40 次子进程调用）
   * 会让这一轮跑很久，而听记轮询本来是低频后台任务 —— 长时间占着
   * DWS 子进程会拖慢消息侧的采集。
   *
   * 所以：list 每轮全量（便宜，元信息幂等），正文每轮只补
   * `MINUTES_BODY_PER_ROUND` 条最新的。几轮之后就补齐了，
   * 而任何一轮都不会长时间占用子进程。
   *
   * ## 不做水位
   *
   * `minutes list all` 不支持时间过滤（实测 flag 只有 --limit/--cursor/--query/
   * --start/--end，而 start/end 是"可选筛选"不是水位语义）。
   * 幂等靠 `(channel_id, external_id)` 唯一键 + upsert 的正文守卫 ——
   * 重复列同一条听记不产生 Outbox seq。
   */
  async tickMinutes(): Promise<{ listed: number; changed: number; bodies: number }> {
    const minutes = this.options.plugin.minutes
    const empty = { listed: 0, changed: 0, bodies: 0 }
    if (minutes === undefined || !this.running || this.blockedReason !== null) return empty
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
    if (documents === undefined || !this.running || this.blockedReason !== null) return empty
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

      // ② 给缺正文的补正文（每轮限量，见常量注释）。
      const repo = new DocumentRepository(this.options.db)
      for (const row of repo.listMissingBody(channelId, DOCUMENTS_BODY_PER_ROUND)) {
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
   * @returns 新落库的消息条数
   */
  async refreshConversation(conversationExternalId: string): Promise<number> {
    const ingest = this.options.plugin.ingest
    if (ingest === undefined || ingest.pullConversation === undefined) return 0
    if (!this.running || this.blockedReason !== null) return 0

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

    try {
      // ① 列一页元信息（一期只取首页：低频任务不必一轮翻完全部历史，
      //    hasMore 的后续页由下一轮的 cursor=null 重新覆盖到最新的那批）。
      const { page, rawPayload } = await minutes.list({})
      if (!this.running) return totals
      totals.listed = page.items.length

      if (page.items.length > 0) {
        const result = persistMinutes(
          { db: this.options.db, clock: this.options.clock, logger: this.options.logger },
          {
            raw: [
              {
                id: newId(this.options.clock.now()),
                channelId,
                resource: "minutes",
                externalId: "",
                payload: rawPayload,
                payloadHash: sha256(rawPayload),
                source: "dws-cli",
                fetchedAt: this.options.clock.now(),
              },
            ],
            minutes: page.items.map((item) => ({
              id: newId(item.startedAt ?? this.options.clock.now()),
              channelId,
              externalId: item.externalId,
              title: item.title,
              startedAt: item.startedAt,
              durationSec: item.durationSec,
              summaryText: item.summaryText,
              transcriptJson: item.transcriptJson,
              speakersJson: item.speakersJson,
              fetchedAt: this.options.clock.now(),
            })),
          },
        )
        totals.changed = result.changed.length
      }

      // ② 给缺正文的补正文（每轮限量，见方法注释）。
      const repo = new MinutesRepository(this.options.db)
      for (const row of repo.listMissingBody(channelId, MINUTES_BODY_PER_ROUND)) {
        if (!this.running) break
        const body = await minutes.body(row.externalId)
        if (!this.running) break
        persistMinutes(
          { db: this.options.db, clock: this.options.clock, logger: this.options.logger },
          {
            raw: [
              {
                id: newId(this.options.clock.now()),
                channelId,
                resource: "minutes.body",
                // 正文有平台主键 → 用它，让同一条听记的正文重复抓取幂等。
                externalId: row.externalId,
                payload: body.rawPayload,
                payloadHash: sha256(body.rawPayload),
                source: "dws-cli",
                fetchedAt: this.options.clock.now(),
              },
            ],
            minutes: [
              {
                id: row.id,
                channelId,
                externalId: row.externalId,
                summaryText: body.summaryText,
                transcriptJson: body.transcriptJson,
                fetchedAt: this.options.clock.now(),
              },
            ],
          },
        )
        totals.bodies += 1
      }

      if (totals.changed > 0 || totals.bodies > 0) {
        this.options.logger.info("minutes ingested", totals)
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
    if (ingest === undefined || !this.running || this.busy || this.blockedReason !== null) {
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
      this.recordError(error)
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
    const row = new DistillSourceRepository(this.options.db).list().find((s) => s.kind === "chat")
    if (row === undefined || !row.enabled) return undefined
    // `since` 缺字段 = 用户选了"不限"（引导页对不限就是不写这个键）。
    return row.scope.since ?? null
  }

  /**
   * 用户在引导里**勾选**的会话 external_id。空数组 = 没限定（全部）。
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
   */
  private scopedConversationIds(): string[] {
    const row = new DistillSourceRepository(this.options.db).list().find((s) => s.kind === "chat")
    if (row === undefined || !row.enabled) return []
    return [...(row.scope.conversationIds ?? [])]
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
    if (!this.running || this.busy || this.blockedReason !== null) return 0

    this.busy = true
    try {
      const directory = await this.conversationDirectory()
      if (!this.running || directory.length === 0) return 0

      const channelId = this.options.plugin.meta.id
      const conversations = new ConversationRepository(this.options.db)
      const unreadable = conversations.unreadableByExternalId(channelId)
      // ★ 一次 GROUP BY 拿全部会话的库内最新时间 —— 逐个查会阻塞主进程 173 次
      const ours = new MessageRepository(this.options.db).latestSentAtByChannel(channelId)
      const scoped = new Set(this.scopedConversationIds())

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
        // 勾选过就只扫勾选的（没勾 = 不限定）
        if (scoped.size > 0 && !scoped.has(item.externalId)) continue
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
    const self = new SelfIdentityRepository(this.options.db).get(this.options.plugin.meta.id)
    const result = persistBatch(
      { db: this.options.db, clock: this.options.clock, logger: this.options.logger },
      normalize({
        channelId: this.options.plugin.meta.id,
        conversations: page.conversations,
        messages: page.messages,
        rawPayload: page.rawPayload,
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
   * 记录错误并识别**终态**。
   *
   * 登录过期与缺授权靠重试永远好不了 —— 继续重试只会反复弹窗骚扰用户。
   * 因此这两类进入 blocked 状态，由 UI 引导用户处理后手动恢复。
   */
  private recordError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.lastError = message
    if (isAppError(error)) {
      if (error.code === "SESSION_EXPIRED") this.blockedReason = "session_expired"
      else if (error.code === "PERMISSION_REQUIRED") this.blockedReason = "permission_required"
    }
    this.options.logger.warn("ingest tick failed", { detail: message, blocked: this.blockedReason })
  }

  /**
   * 用户处理完终态（重新扫码 / 完成授权）后调用。
   *
   * 一并清退避：用户点「重试」时期望的是**立刻**再试一次，
   * 而不是"还要再等 5 轮"（后者表现为点了没反应）。
   */
  clearBlocked(): void {
    this.blockedReason = null
    this.lastError = null
    this.backoffRounds = 0
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
   * 状态快照：状态页读它。**存储增长必须可见**，否则 500MB 会被当 bug 报上来。
   *
   * ⚠️ 这个函数**不便宜**：9 个全表 `COUNT(*)` + 2 个 pragma。
   * 实测 1 万行 0.29ms、20 万行 6.31ms，而 better-sqlite3 是同步的 ——
   * 每次调用都是主进程的一段硬阻塞。因此**不要在逐条消息的路径上调它**，
   * 只能由 batch 结束或节流后的推送触发（见 data-plane.service 的 pushSnapshot）。
   */
  snapshot(): IngestSnapshot {
    const messages = new MessageRepository(this.options.db)
    const changelog = new ChangelogRepository(this.options.db)
    const consumers = new ConsumerCursorRepository(this.options.db, this.options.clock)
    const stats = collectStorageStats(this.options.db, this.options.dbPath)
    const self = new SelfIdentityRepository(this.options.db).get(this.options.plugin.meta.id)

    return {
      running: this.running,
      channelId: this.options.plugin.meta.id,
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
      minutes: new MinutesRepository(this.options.db).count(),
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
    }
  }
}
