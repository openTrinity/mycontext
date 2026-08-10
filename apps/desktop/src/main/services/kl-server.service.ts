/**
 * kl-server（Python 检索服务）子进程管理。
 *
 * ## 为什么要一个专门的 supervisor
 *
 * kl 是一个**长驻 HTTP 服务**（uvicorn，`127.0.0.1:8200`），不是一次性命令：
 * · 启动慢（实测 ~90s：Qdrant mmap warmup），期间 `/health` 回 `starting`；
 * · 一个进程服务全部查询（懒启动一次，之后复用）；
 * · 崩溃/退出要能被观察到并推给 UI（"图谱检索为什么没用上"）。
 *
 * 所以它需要一个**显式状态机** + 健康轮询 + 无孤儿退出，而不是散在调用点。
 *
 * ## 降级边界（local-first 的例外，必须明示）
 *
 * kl 的**数据**留在本机（SQLite + Qdrant 都是本地文件），但它的 embedding 与
 * LLM 调用会打到远端网关。这条出网边界通过 `networkEgress:true` 带给 UI ——
 * 沿用本项目「降级/边界必须可见」的原则，不静默出网。
 *
 * ## 为什么走 spawnDuplex 而不是 spawn
 *
 * `spawn()` 是"长驻但只读输出"，且它的 run() 带超时；kl-server 要**无限期存活**
 * 且我们要能主动 `close()`（SIGTERM→SIGKILL）。`spawnDuplex` 的句柄生命周期
 * 正好由调用方掌握（见 process.ts 的注释）。我们不往它 stdin 写东西 ——
 * 只借它"长驻 + 可主动关 + onExit 回调"这三件事。
 */
import { join } from "node:path"
import {
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs"
import Database from "better-sqlite3"
import type { BrowserWindow } from "electron"
import { type Clock, type Logger } from "@mycontext/kernel"
import {
  IPC_EVENTS,
  type KlServerStatus,
  type KlGraphBuildResult,
  type KlGraphOptimizeResult,
} from "@mycontext/ipc-contract"
import type { KlGraphOverview } from "@mycontext/ipc-contract"
import type { DuplexHandle, ProcessRunner } from "@mycontext/runtime-env"

/** kl-server 默认端口（可被 KL_SERVER_PORT 覆盖）。绑 127.0.0.1，不对外。 */
const DEFAULT_KL_PORT = 8200

/**
 * 「这个 kl-server 是本应用起的」的身份凭证文件名（放在 `dataDir` 下，按 vault 隔离）。
 *
 * ## ★★ 为什么需要它：区分「自家孤儿」与「外部进程」
 *
 * kl-server 绑固定端口 8200。上一个应用实例若没走到优雅 `stop()`
 * （crash / 强杀 / `app.exit(0)` 硬超时 / 开发态热重启）就会留下一个孤儿
 * （reparent 到 launchd）继续占着 8200。下一个实例探到端口被占就 **adopt** 它 ——
 * 而那个孤儿的 stdin/stdout/stderr 是上一个实例的 socketpair，**读端已经没了**。
 *
 * 查询（`/ask`）不 print 所以 adopt 无害，但**建图**会往 stdout 狂 print
 * （kl 的 `PHASE B.1…` 等），写到读端已关的 socket → `[Errno 32] Broken pipe`，
 * 建图恒失败。这是真实踩过的坑（图库停在 500 条 fact、自我图只有 2 个邻居）。
 *
 * pidfile 让我们能分辨：8200 上的到底是「本应用起的、只是换了实例」（可安全接管：
 * 杀掉重起一个有句柄的），还是「用户自己 `kl start` 的外部进程」（不碰它，
 * 但也不拿它建图）。判据见 `reclaimOrphan()`。
 */
const KL_PIDFILE_NAME = "kl-server.pid"

/** 接管自家孤儿时，等它让出端口的最长时间（超过就退回 adopt，不无限等）。 */
const RECLAIM_PORT_RELEASE_TIMEOUT_MS = 3_000

/** 等端口释放的轮询间隔。 */
const RECLAIM_POLL_INTERVAL_MS = 200

/**
 * pidfile 的内容形状。
 *
 * `port` 一并记下：判据里要求它与当前端口一致，才认定「同一个我」——
 * 否则一个陈旧 pidfile（pid 恰好被系统复用给别的进程）会让我们误杀无关进程。
 */
interface KlPidfile {
  pid: number
  port: number
  startedAt: number
}

/**
 * warmup 最长等待。实测冷启 ~90s（Qdrant mmap），给到 150s 留裕量 ——
 * 到点仍未 ready → failed（给手动重试），而不是无限期挂着让 UI 以为卡死。
 */
const WARMUP_TIMEOUT_MS = 150_000

/** 健康轮询间隔。warmup 阶段每 1.5s 探一次 `/health`。 */
const HEALTH_POLL_INTERVAL_MS = 1_500

/**
 * 连续多少次探测不到 `/status` 才认为"进程没了"。
 *
 * ★ 这**不是**一个变相的超时:它配合"子进程句柄已死"一起判(见 `awaitIngest`)。
 * 单独看探测失败会误伤 —— 建图期间 server 在烧 CPU,偶发 3s 超时是常态。
 * 5 次 × 3s = 15s 的连续失联,加上句柄确实死了,那时才是事实而不是推测。
 */
const INGEST_PROBE_FAILURE_LIMIT = 5

/** 建图进度轮询间隔。分钟级任务,3s 足够且不会刷屏 UI。 */
const INGEST_POLL_INTERVAL_MS = 3_000

/** `/status` 里 ingest 那一段（我们只取用得上的字段）。 */
export interface KlIngestSnapshot {
  state: "idle" | "running" | "done" | "error"
  phase: string
  percent: number
  error: string
  /** 图库当前的**绝对**规模（不是这一轮的增量，见 `KlBuildVolume`） */
  counts: { entities: number; facts: number; edges: number }
  /**
   * 这一轮**处理了多少语料** —— 上游 `/status.ingest` 直接给的四个数。
   *
   * ★ 这几个是「干了多少活」，与 `counts`（「现在有多少东西」）是两件事：
   * 增量建图时 `units_skipped` 往往远大于 `units_processed`
   * （实测 36613 发现 / 2589 跳过 / 34024 处理），而那个比例正是
   * "增量到底省了多少"的唯一证据。
   */
  volume: {
    /** 发现的语料单元总数 */
    unitsDiscovered: number
    /** 命中缓存跳过的（增量的收益就在这个数上） */
    unitsSkipped: number
    /** 真的处理了的 */
    unitsProcessed: number
    /** 切出的 chunk 数 */
    chunksCreated: number
  }
}

/**
 * 一轮建图**产出了多少** —— 前后差值，而不是绝对值。
 *
 * ## ★★ 为什么要单独一个类型而不是直接报 counts
 *
 * 界面上「实体 618」回答的是"图里有多少"，而用户问的是"这一轮干了什么"。
 * 增量建图下两者差别很大：一轮可能只新增几十个实体，而总数是几百 ——
 * 只报总数的话每轮看起来都"没动"（数字几乎不变），
 * 而那恰恰让人以为增量没生效。
 *
 * ★ 允许**负数**：`fresh=true` 重建会先清空，或上游合并了重复实体，
 * 都会让某一项减少。夹到 0 会把"合并生效了"显示成"没变化"。
 */
export interface KlBuildVolume {
  entities: number
  facts: number
  edges: number
  unitsDiscovered: number
  unitsSkipped: number
  unitsProcessed: number
  chunksCreated: number
}

/**
 * 图谱库的只读读取口。
 *
 * ★ 抽成接口是为了**能测**：真实现要一个 better-sqlite3 的原生模块 +
 * 一个真 kl 库文件，而我们要验的是"空库 / 半成品库 / 完整库分别给什么话"
 * —— 那是纯逻辑，不该被原生模块的 ABI（本项目反复踩过）绑住。
 */
export interface GraphDbHandle {
  count(table: string): number
  groupBy(table: string, column: string): Array<{ type: string; count: number }>
  topEntities(limit: number): Array<{ name: string; type: string; mentions: number }>
  recentFacts(
    limit: number,
  ): Array<{ text: string; type: string; confidence: number; at: number | null }>
  close(): void
}

/**
 * kl-server 找不到 Python 解释器时用的环境变量名。
 *
 * 一期不打包 Python（见方案 §4.2）：用本机的 kl venv 或系统 python，
 * 通过 `KL_PYTHON` 指定。缺省退回 `python3`（PATH 里找）。
 */
const KL_PYTHON_ENV = "KL_PYTHON"

export interface KlServerServiceOptions {
  clock: Clock
  logger: Logger
  processes: ProcessRunner
  /**
   * 这个 kl 服务哪个渠道的。
   *
   * ## ★★ 必填，因为它是 kl 侧断点续传的 key
   *
   * 透传成 `POST /ingest` 的 `source_id`，而 kl 用它算 checkpoint 路径
   * （`checkpoint_path(source_id)`）。两个渠道共用一个值 → 互相覆盖对方的
   * 续传进度。给默认值（比如 `"dws"`）会让"忘了传"变成一个静默的
   * 跨渠道污染，所以这里不给默认。
   */
  channelId: string
  /** kl-graph 代码根（含 kl_server.py）。缺失 = kl 未集成，永远 stopped。 */
  klRoot: string
  /**
   * kl 运行数据的根目录（注入 `KL_DATA_DIR`）。
   *
   * ★★ 注释与实现曾经不一致：这里写着"按 vault 隔离"，而装配层传的是
   * `klDataDirFor(paths.sharedRoot)` —— 一个**应用级**目录。于是第二个身份
   * 登录后读到的是第一个身份的图谱，而没有任何报错。
   *
   * 现在真的按 vault 走，且**切身份时用 `rebind()` 换**（见那个方法）。
   * 这个字段是构造时的初值（未登录时的占位）。
   */
  dataDir: string
  /**
   * 四件套导出目录（`sharedRoot/exports/dws`，由 FeedService 自动物化）。
   * 建图（`kl ingest`）读它 → 注入 `KL_DWS_EXPORT_DIR`。缺省则建图会报"没数据"。
   */
  exportDir?: string
  getWindow: () => BrowserWindow | null
  /**
   * 推送给渲染层时用**这个**状态，而不是 `this.status()`。
   *
   * ## ★★ 为什么需要它
   *
   * 多渠道下渲染层要的是合并后的状态（含 `perChannel`），而那是
   * `MultiKlServerService` 才有的。这个类只知道自己那一个 kl ——
   * 直接推 `this.status()` 会让渲染层每次收到推送都丢掉 `perChannel`，
   * 于是界面在第一次状态变化后就退化成"只有一个渠道"（完整分析见 `pushStatus`）。
   *
   * ★ 回调而不是持有门面：门面包着这个实例，反向引用会成环。
   * ★ 可选：单渠道装配与本类的单测不需要知道门面存在（不给就推自己的）。
   */
  mergedStatus?: () => KlServerStatus
  /**
   * 健康探测。注入以便测试：默认打真 `GET http://127.0.0.1:{port}/health`。
   * 返回 true = ready（`{status:"ok"}`）。
   */
  probeHealth?: (port: number) => Promise<boolean>
  /**
   * 起之前探"端口上是不是已经有一个健康的 server"。
   *
   * 与 `probeHealth` 缺省是同一个 `/health` 请求，但**语义不同**，
   * 所以注入点分开：这个问的是"别人在不在"，那个问的是"我起的那个好了吗"。
   * 测试里通常要 `probeExisting: () => false`（没人占端口）+
   * `probeHealth: () => true`（我起的立刻就绪）—— 共用一个注入点时
   * 这两个意图会互相打架。
   */
  probeExisting?: (port: number) => Promise<boolean>
  /**
   * 准备并**激活** mycontext 的共用 Python 环境，返回解释器路径 + 激活后的 env。
   *
   * ## 为什么这一步必须在启动路径上
   *
   * kl 是 Python 写的，而"本机有没有能跑它的 Python"不能指望：
   * **macOS 自带的是 3.9.6，kl 要求 ≥3.10**；依赖（约 280MB）也不入 git。
   * 不准备就直接 spawn 的后果是 kl-server `exit 3`，日志里只有退出码 ——
   * agent 能说话但**查不了图谱**，两件事很难联系起来（真实踩过）。
   *
   * 返回的 `env` 是"激活后的环境"（VIRTUAL_ENV / PATH 前插 venv/bin /
   * 清掉 PYTHONHOME），会整个传给 spawn —— 于是 kl 子进程里裸 `python`、
   * `kl` 都落在这个 venv 里，与终端 `source activate` 之后一样。
   *
   * 注入以便测试；返回 null = 环境不可用（start 会 fail 并给出可照做的提示）。
   */
  preparePython?: () => Promise<{ python: string; env: NodeJS.ProcessEnv } | null>
  /** 轮询间的等待。注入以便测试（默认 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>
  /**
   * `POST /ingest`。返回 HTTP 状态码。注入以便测试（默认打真请求）。
   *
   * 分开注入而不是塞进一个 `httpClient`：这两个调用的失败含义不同
   * （启动失败 vs 探测失败），测试要能只替其中一个。
   */
  postIngest?: (port: number, exportDir: string, sourceId: string) => Promise<number>
  /** 读 `/status` 里的 ingest 段。注入以便测试。 */
  readStatus?: (port: number) => Promise<KlIngestSnapshot | null>
  /** 打开图谱库（只读）。注入以便测试 —— 见 `GraphDbHandle` 的注释。 */
  openGraphDb?: (path: string) => GraphDbHandle
  /**
   * embedding/LLM 网关配置。给了才注入对应 KL_* env（决定 networkEgress）。
   * baseUrl/apiKey 缺任一 → 不注入那一路（kl 侧会用它自己的默认或报缺 key）。
   *
   * ★ 是**函数**而不是值：网关配置在运行期可变（用户在设置里改了）。
   * `buildEnv()` 每次 spawn 现读 —— 下次 kl 重启就用新网关，不必改这里。
   * 与 `FeedService.autoBuild` 同一个惰性模式。
   */
  gateway?: () => KlGatewayConfig | undefined
  /**
   * 自动建图的调度快照提供者（给 `graphOverview().buildSchedule`）。
   *
   * ★ **惰性**（函数而非值），与 `gateway` / `FeedService.autoBuild` 同一个理由：
   * 水位随每一轮采集在变，装配时取的快照到用户打开界面那一刻早已过期。
   *
   * 为什么由外面注入而不是这里自己算：水位在 `FeedService` 的
   * `GraphSyncService` 里（`buildWatermark()` / `lag()`），而这个服务
   * 只管 kl 进程与图谱库文件 —— 让它去读别人的游标表会把两个服务的
   * 职责搅在一起，而那正是"两处各算一份、然后漂移"的开始。
   *
   * 不给 = `buildSchedule` 为 null（未接自动建图），界面据此不显示那一块。
   */
  buildSchedule?: () => KlGraphOverview["buildSchedule"]
  /**
   * 图库被清空（`fresh=true`）之后清零建图水位。
   *
   * ★ 与 `buildSchedule` 同一个理由由外面注入：水位在 `FeedService` 的
   * `GraphSyncService` 里，这个服务只管 kl 进程与图库文件。
   *
   * 不给的后果不是崩，而是一个**错的数字**：清库后「待建 N 条」只算清库
   * 之后新采的那几条（实测 407），而真实要重建的是全部语料（实测 37826 个
   * chunk / 约 3 小时）。用户据此以为"马上就好"，反复重启，
   * 而每次重启都让 Phase A 从零开始 —— 于是图永远建不出来。
   */
  resetBuildWatermark?: () => boolean
  /** 覆盖端口（默认 8200）。 */
  port?: number
}

/** kl 出网网关的一份快照（`gateway()` 每次现算）。 */
export interface KlGatewayConfig {
  llmBaseUrl?: string
  llmModel?: string
  embedBaseUrl?: string
  embedModel?: string
  /** 出网密钥（embedding + LLM 共用网关时同一个）。 */
  apiKey?: string
  /**
   * embedding 维度。**必须与网关实际返回的维度一致** —— kl 的 Qdrant 集合按
   * 这个数建，向量维度对不上会在 upsert 时崩（实测网关 text-embedding-v4 默认
   * 返回 1024，而 kl 默认建 4096 集合 → shape mismatch）。走 DashScope 兼容
   * 网关时配 2048 + sendDimensions:true（matryoshka 截断到 2048）。
   */
  embeddingDim?: number
  /** 是否给 embedding 请求带 `dimensions` 参数（DashScope 兼容网关要 true）。 */
  sendDimensions?: boolean
}

type KlState = KlServerStatus["state"]

export class KlServerService {
  private state: KlState = "stopped"
  private reason: string | null = null
  private handle: DuplexHandle | null = null
  /**
   * 端口上那个 server 是**别人**起的（我们只是接管了它）。
   *
   * 复用态下我们没有句柄，也就没有 `onExit` 可依赖 —— `ensureReady` 必须
   * 每次重探 `/health`，而 `stop()` 不能去杀一个不属于我们的进程
   * （它可能是用户自己 `kl start` 起来的，杀掉会打断他手上的活）。
   */
  private adopted = false
  /**
   * 激活后的 Python 环境变量（由 `preparePython` 给出）。
   *
   * undefined = 没有注入过（测试里不注入 preparePython，或环境走本机 python）。
   * `buildEnv()` 会把它作为基底 —— 于是 kl 子进程在 venv 里。
   */
  private activatedEnv: NodeJS.ProcessEnv | undefined = undefined
  /**
   * 建图进度（`{phase, percent, startedAt}`）。null = 没在建图。
   *
   * ★ **当前没有 UI 消费方**，只用于日志与诊断。理由整段写在契约里
   * （`klServerStatusSchema.buildProgress`）：上游只有 Phase A 有真实回调，
   * 且这个字段在 optimize 停 server 时会卡在 stale 值上不自己清。
   * 拿它渲染进度前先读那段。
   */
  private buildProgress: { phase: string; percent: number; startedAt: number } | null = null
  /**
   * 最近一次从 kl `/status` 读到的**真实**关系边数。null = 还没问过。
   *
   * ## ★★ 为什么必须单独存这一个数
   *
   * 概览页其余数字直连只读 SQLite（理由见 `graphOverview` 的注释：聚合查询
   * 上游没有端点，且建图期间 kl 的 HTTP 在忙）。但**边数不能这么读** ——
   * `SELECT COUNT(*) FROM edges` 在 ladybug 后端下恒为 0，因为那张表按设计
   * 就是空的（上游 `storage/base.py` 的 `scan_edges_by_type` 注释明写，
   * 而 `KL_GRAPH_BACKEND` 的默认值就是 ladybug）。
   *
   * 实测同一时刻两个源的差距：
   *
   * ```
   * GET /status → {"graph_backend":"ladybug","sqlite":{"edges":26558}}
   * SELECT COUNT(*) FROM edges  → 0
   * ```
   *
   * kl 的 `/status` 用 `state.store.count_edges()` 按后端分派，所以它是对的。
   * 我们在建图轮询里本来就会拿到那个快照（`rebuildGraph` 的 `snapshot.counts`）
   * —— 把边数记下来，概览页就能报真实值而不是一个恒 0 的假数字。
   *
   * ★ 为什么是"最近一次"而不是现取：`graphOverview()` 是**同步**的
   * （IPC 那侧 `Promise.resolve(...)`），而问 HTTP 是异步的；更要紧的是
   * 建图期间 kl 的端点在忙，现取会把最该能看的时刻变成看不到。
   * 边数变化很慢，一个稍旧的真实值远好过一个永远为 0 的假值。
   */
  private lastKnownEdges: number | null = null
  /**
   * 最近一轮建图的产出（差值 + 处理量）。null = 这次启动还没建过。
   *
   * ## ★ 为什么留在内存而不落库
   *
   * 它回答的是"刚才那一轮干了什么" —— 一个**会话内**的问题。落库要建表、
   * 要考虑 per-vault、要想清楚保留多久，而收益只是"重启后还能看到上一轮"。
   * 而重启后真正有用的是图的**绝对规模**（那个一直有）。
   *
   * ★ 失败/被打断时**不覆盖**：那时没有可信的差值（可能建到一半），
   * 保留上一次成功的那份比显示一个半截数字好。
   */
  private lastBuildVolume: KlGraphBuildResult["volume"] = undefined
  /** 正在进行的 start（避免并发 ensureReady 起多个进程）。 */
  private starting: Promise<boolean> | null = null
  /** 正在建图（避免并发触发；建图期间禁止 ensureReady 起 server 抢 SQLite）。 */
  private building = false
  /**
   * 我们**主动**在停这个进程（`stop()` / `fresh=true` 的清库前置停）。
   *
   * ## ★★ 为什么建图需要知道这件事
   *
   * `awaitIngest` 唯一的失败判据是「进程没了」（时间上限被刻意删掉了，
   * 见那里的注释）。那条判据本身对 —— 但它**分不清"崩了"与"我们关的"**。
   *
   * 于是每次退出应用都会走出这一串（实测）：
   * ```
   * 14:50:14.021 shutdown step started {"step":"klServer"}   ← 我们杀 kl
   * 14:50:14.809 graph build failed {"reason":"建图中断：kl-server 进程已退出"}
   * 14:50:14.810 graph auto build failed {"consecutiveFailures":1,
   *                                      "retryAfterMs":1800000}
   * ```
   * 后果不是"一条难看的日志"：`consecutiveFailures` 会让
   * `autoBuildBackoffMs` 退避 **30 分钟** —— 也就是下次启动后半小时内
   * 不自动建图，而这一轮**根本没失败**，只是被我们打断了。
   * 每次退出都撞一次的话，自动建图基本就废了。
   *
   * 与 `onProcessExit` 里那套「`state === "stopped"` 就不报 failed」同源：
   * 主动停下的进程退出是**预期**，不是故障。
   */
  private stopping = false
  /**
   * 上一次 spawn 时**网关配置的指纹**（见 `gatewayFingerprint`）。
   *
   * kl 的网关是通过 `KL_*` env 传的，而 env 只在 spawn 那一刻定 —— 所以
   * "跑着的这个 kl 用的是哪份网关"这件事必须自己记下来，否则无从判断
   * 配置变了要不要重起（`onGatewayChanged`）。
   */
  private gatewayPrint = ""
  /**
   * 当前监听端口。**可变** —— 与下面 `dataDir` 同一条理由，由 `rebind()` 换。
   *
   * ★ 为什么不能构造时定死：一个 vault 下每个**已连渠道**各起一个 kl，
   * 而"连了哪几个"要到登录后才知道。装配层写 `klPort + N` 这种算式的话，
   * 端口与渠道的对应关系被记在两个地方（装配层的算式、挂载层的渠道顺序），
   * 一旦不一致就是"图谱查的是另一个渠道的库" —— 不报错，只是答错。
   * 现在端口由 `ChannelPipelineManager` **真探测**后分配再 rebind 进来。
   */
  private port: number
  /**
   * 当前生效的数据目录与导出目录 —— **可变**，切身份时由 `rebind()` 换。
   *
   * ★ 不能是 `readonly options.dataDir`：那样切身份后仍指着上一个身份的图库，
   * 而症状是"换了身份，图谱面板显示的还是上一个人的实体与事实"——
   * 不报错，只是答错。
   */
  private dataDir: string
  private exportDir: string
  /** 最近的 Python stderr。启动崩溃时带进失败原因，避免日志只剩 exit code。 */
  private readonly stderrTail: string[] = []

  constructor(private readonly options: KlServerServiceOptions) {
    this.port = options.port ?? DEFAULT_KL_PORT
    this.dataDir = options.dataDir
    this.exportDir = options.exportDir ?? ""
  }

  /**
   * 换到另一个身份的图谱数据目录。
   *
   * ## ★★ 调用方**必须先** `await stop()`
   *
   * 三件事都绑在旧目录上：跑着的子进程（`KL_DATA_DIR` 在它的 env 里，
   * spawn 之后改不了）、pidfile（放在 dataDir 下）、以及 8200 端口。
   *
   * 不先停就 rebind 的后果是一条真实的竞态：新目录里没有 pidfile →
   * `probeExisting(8200)` 探到旧身份那个进程还活着 → `reclaimOrphan()`
   * 找不到 pidfile → 判定它是"用户手工起的**外部进程**" → `adopted=true`。
   * 之后建图走到 `if (this.adopted)` 直接报错；而更糟的分支是 adopt 成功 ——
   * 那个进程的 `KL_DATA_DIR` 指着**旧身份的图库**，于是新身份的 `/ask`
   * 查到的是上一个人的知识。这正是 `KL_PIDFILE_NAME` 注释里记的那个坑
   * （Broken pipe / 图库停在 500 条 fact）换了个入口。
   *
   * 所以本方法只改字段、**不碰进程**：顺序的责任在装配层
   * （`unmountVault` 里那句 `await klServer.stop()` 必须是 await 而不是 void
   * —— 登出时 void 无所谓，因为后面没人再起；切身份时就是上面这条竞态）。
   *
   * ★ 本方法不 `ensureReady()`：起不起由调用方决定（挂载分支自己会起），
   * 在这里顺手起会让"换目录"这个纯赋值动作带上一次 90s 的 warmup。
   */
  rebind(next: { dataDir: string; exportDir: string; port?: number }): void {
    this.dataDir = next.dataDir
    this.exportDir = next.exportDir
    /**
     * ★ 端口一起换（可选）。与 dataDir 同一个前置条件：**调用方必须先
     * `await stop()`** —— 旧端口上的进程还活着时换端口，那个进程就变成了
     * 无人认领的孤儿（pidfile 里记的是旧端口，`reclaimOrphan` 按新端口找
     * 不到它），而它仍占着旧端口与旧图库。
     */
    if (next.port !== undefined) this.port = next.port
    // 换目录等于换了一份图 —— 上一个身份的失败原因不该留在界面上
    this.reason = null
    this.options.logger.info("kl data dir rebound", { dataDir: next.dataDir })
  }

  /** 当前状态快照（IPC 查询 + 推送共用）。 */
  status(): KlServerStatus {
    return {
      state: this.state,
      reason: this.reason,
      port: this.state === "stopped" ? null : this.port,
      building: this.building,
      networkEgress: this.hasGatewayEgress(),
      buildProgress: this.buildProgress,
    }
  }

  /**
   * 确保 kl-server 就绪（懒启动）。返回是否 ready。
   *
   * · 已 ready → 直接 true；
   * · starting（别的调用在起）→ 等它；
   * · stopped/failed → 起一次。
   *
   * ★ failed 后不自动重试：崩溃循环会刷屏且多半修不好（缺数据/缺 key）。
   * 调用方（或用户点"重试"）显式再调 `ensureReady` 才会重起 —— 见 `retry()`。
   */
  async ensureReady(): Promise<boolean> {
    if (this.state === "ready" && this.handle?.alive === true) return true
    if (this.starting !== null) return this.starting

    /**
     * ★ 这里**曾经**有一句 `if (this.building) return false`。
     *
     * 它的理由是「建图中：ingest 独占 SQLite/Qdrant，绝不能同时起 server
     * 抢文件」—— 那在 ingest 是**另一个进程**时是对的。改成 in-server
     * `/ingest` 之后前提消失了：干活的就是 server 自己，同一个 Qdrant writer。
     *
     * 而留着它会**反过来**把功能焊死：`rebuildGraph` 现在的第一步正是
     * `ensureReady()`，而它自己已经把 `building` 置成了 true ——
     * 于是 ensureReady 必然返回 false，建图 100% 报「kl-server 未就绪」。
     * 那个失败信息还会把人引向"服务起不来"（去查 Python、查端口），
     * 而真正的原因是我们自己上的一道锁。
     */

    // failed 态下 ensureReady 不自动重起：要走 retry()（用户显式动作）。
    if (this.state === "failed") return false

    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** 用户显式重试：清掉 failed 态并重起一次。 */
  async retry(): Promise<boolean> {
    if (this.state === "starting") return this.starting ?? false
    this.reason = null
    this.setState("stopped")
    return this.ensureReady()
  }

  /**
   * 网关配置变了 → 重起 kl，让它带上新的 `KL_*` env。
   *
   * ## ★★ 这条修的是一个静默失败（打包态实测抓到）
   *
   * `gateway()` 是**每次 spawn 现读**的（见那个字段的注释）——也就是 kl 用的
   * 永远是它**启动那一刻**的网关。而打包态没有 `.env`，首启时网关是空的：
   * ```
   * 16:19:10 llm not configured …          ← dotenvLoaded: false
   * 16:19:27 kl-server 起来（env 里只有 KL_LLM_MODEL，没有 base/key）
   * ── 用户随后在设置里填了网关 ──          ← LlmHolder 立刻生效，kl 不知道
   * 16:39:34 auto graph build failed
   *          {"reason":"litellm.InternalServerError: OpenAIException - Connection error."}
   * ```
   * 实测确认那个进程的环境里**真的没有** `KL_LLM_BASE_URL` / `KL_EMBED_API_KEY`。
   * 后果特别难查：Phase A（切块+向量化）照常跑完（`chunks: 3847`），
   * 只有 Phase B（LLM 抽实体）连不上 → `entities/facts/edges` 全 0。
   * 也就是**填了 key 却一直建不出图，而设置页显示保存成功**。
   *
   * ## 为什么按"指纹变了"判而不是无条件重起
   *
   * `onChange` 会因为改任何一项（模型、embedding 模型、主网关…）而触发，
   * 而重起 kl 要重付 ~6s 的 warmup（打包态实测 6012ms），期间检索不可用。
   * 只在**真正进 kl 环境的那几项**变了时才重起。
   *
   * ## 为什么建图中不重起
   *
   * ingest 跑在 server 进程内（in-server `/ingest`），杀它等于中断建图 ——
   * 而那批 LLM 抽取的钱已经花了。这一轮建完后下次启动自然会带上新网关。
   *
   * 幂等且安全：没起过（stopped）时只更新指纹不启动 —— 懒启动的语义不该
   * 被"改了个设置"打破。
   */
  async onGatewayChanged(): Promise<void> {
    const next = this.gatewayFingerprint()
    if (next === this.gatewayPrint) return
    const previous = this.gatewayPrint
    this.gatewayPrint = next

    // 没起过就没有"旧环境"要换；下次懒启动自然带上新的。
    if (this.state === "stopped") return
    if (this.building) {
      this.options.logger.info("gateway changed during graph build; deferring kl restart", {})
      return
    }
    // 复用的进程不是我们的孩子，杀它会打断别人手上的活（见 `adopted`）。
    if (this.adopted) {
      this.options.logger.info("gateway changed but kl-server was adopted; not restarting", {})
      return
    }
    this.options.logger.info("gateway changed; restarting kl-server", {
      hadGateway: previous !== "",
    })
    await this.stop()
    await this.ensureReady()
  }

  /**
   * 会进 kl 环境的那几项的指纹。
   *
   * ★ 不含 apiKey 的**明文** —— 这个值会进日志判断路径，而密钥不进日志是
   * 全仓的规矩。用长度替代：换一个不同的 key 长度多半会变，而同长度换 key
   * 的场景（轮换同一个网关的 token）下 kl 那边行为一样（都能出网）。
   */
  private gatewayFingerprint(): string {
    const gw = this.options.gateway?.()
    if (gw === undefined) return ""
    return [
      gw.llmBaseUrl ?? "",
      gw.llmModel ?? "",
      gw.embedBaseUrl ?? "",
      gw.embedModel ?? "",
      (gw.apiKey ?? "").length === 0 ? "nokey" : `key:${String((gw.apiKey ?? "").length)}`,
      String(gw.embeddingDim ?? ""),
      gw.sendDimensions === true ? "dim1" : "dim0",
    ].join("|")
  }

  /**
   * 建图：跑 `python -m scripts.ingest`（LLM 抽实体 + embedding，几分钟、**出网**）。
   *
   * 读四件套导出目录（`KL_DWS_EXPORT_DIR`，FeedService 自动物化），产出/更新
   * kl 的 SQLite + Qdrant（`KL_DATA_DIR`）。
   *
   * `fresh=false`（默认）：增量。Phase A 已完成会智能跳过，抽取命中缓存的消息
   * 不重抽（只对新消息烧 LLM），写库 INSERT OR IGNORE —— 第二次起很快。
   * `fresh=true`：清空重来。先删 knowledge.db / qdrant_data / extraction_cache
   * 再跑，会对全部消息重烧一遍抽取（贵）。**不**用 kl 的 `--fresh-db`：那个只删
   * db 不删 extraction_cache，抽取还会命中旧缓存，达不到"重抽"的意图。
   *
   * ## 为什么建图前要先 stop server
   *
   * server 起着时把 SQLite/Qdrant 打开着（WAL + mmap）；ingest 要写同一批文件。
   * 两个进程同时写会撞（SQLite 锁 / Qdrant 文件损坏）。所以：**先 stop → ingest
   * → 建完 ensureReady 重新起**（读新图）。建图期间 `building=true`，UI 上禁用
   * 入口、也挡住并发触发。
   */
  async rebuildGraph(fresh = false): Promise<KlGraphBuildResult> {
    /**
     * ★★ 每一条出口都要留痕 —— 见 `logBuildOutcome`。
     *
     * 同事机器上实测到的形状：他点了「重建」，日志里只有
     * ```
     * 09:52:45 kl graph data wiped for fresh rebuild
     * 09:52:48 kl-server ready
     * ── 之后到日志结束（5 分钟）什么都没有 ──
     * ```
     * 图库被清空了，而"为什么没建回来"**完全无从判断** —— postIngest 失败了？
     * 还在跑？已经失败并把 reason 显示在界面上而他没看到？
     * 自动建图那条路有 `auto graph build failed`（startup.ts 的 trigger 里打的），
     * 而手动点按钮走 IPC → 这里 → 直接返回 UI，一条日志都不打。
     *
     * 一个花几十分钟、还会**不可逆地清空数据**的操作，必须在日志上留痕。
     */
    if (this.building) {
      return this.logBuildOutcome(fresh, {
        ok: false,
        reason: "建图已在进行中",
        entities: 0,
        facts: 0,
        edges: 0,
      })
    }
    const python = this.resolvePython()
    if (python === null) {
      return this.logBuildOutcome(fresh, {
        ok: false,
        reason: "未找到 Python 解释器（设置 KL_PYTHON 指向 kl 的 venv）",
        entities: 0,
        facts: 0,
        edges: 0,
      })
    }
    if (this.exportDir === undefined || this.exportDir === "") {
      return this.logBuildOutcome(fresh, {
        ok: false,
        reason: "没有导出目录（还没采集到数据）",
        entities: 0,
        facts: 0,
        edges: 0,
      })
    }

    /**
     * ★★ `fresh=true` 的前置校验必须在**清库之前** —— 它是不可逆的。
     *
     * 原来的顺序是 `stop → wipe → ensureReady → postIngest`，而 wipe 之后
     * 每一步都可能失败并 return。那时用户的图**已经没了**，且（在加日志之前）
     * 没人知道发生了什么 —— 比点之前更糟。
     *
     * 这里只查两件**清库前就能知道**的事：
     * · 导出目录里有没有数据 —— 没有的话清完也建不出东西来；
     * · 网关配了没有 —— Phase B 要调 LLM 抽实体，没网关必然抽出 0 个
     *   （那正是打包态那个真实故障：`litellm … Connection error`）。
     *
     * 增量建图（`fresh=false`）**不做**这个校验：它不删任何东西，失败的代价
     * 只是白跑一趟，而多一道闸反而可能挡住合理的重试。
     */
    if (fresh) {
      const blocker = this.freshRebuildBlocker()
      if (blocker !== null) {
        return this.logBuildOutcome(fresh, {
          ok: false,
          reason: blocker,
          entities: 0,
          facts: 0,
          edges: 0,
        })
      }
    }

    /**
     * ★★ 建图**之前**的图规模 —— 差值的基线。
     *
     * 必须在这里取（在 `setBuilding(true)` 与任何清库之前）：
     * · `fresh=true` 会删掉整个 kl 目录，之后就再也读不到"原来有多少"；
     * · 增量建图跑到一半时读到的是"跑了一半的中间值"，减出来是错的。
     *
     * 读不出来（图库还不存在 = 首次建图）→ 全 0，那时差值就等于绝对值，
     * 语义正好对：首次建图"新增"的就是全部。
     */
    const before = this.readGraphCounts()

    this.options.logger.info("graph build started", {
      fresh,
      exportDir: this.exportDir,
      // 网关有没有 —— 只记布尔，不记 baseUrl/key（密钥不进日志是全仓规矩）
      hasGateway: this.hasGatewayEgress(),
      // 基线进日志：出问题时"这一轮从哪儿开始的"是第一个要问的
      before,
    })
    this.setBuilding(true)
    /**
     * ★ `fresh=true` 是**唯一**还需要先停 server 的路径。
     *
     * 增量建图现在交给跑着的 server（`POST /ingest`，见下），不用停它 ——
     * 干活的就是 server 自己，同一个 Qdrant writer，所以"两个进程抢文件"
     * 那个前提没有了。好处是建图期间检索不中断、也不用重付 ~90s 的 warmup。
     *
     * 但"清空重来"要**删文件**（knowledge.db / qdrant_data / extraction_cache），
     * 而那些文件正被 server 以 mmap 打开着。删一个打开着的 mmap 在 macOS 上
     * 不会立刻报错，而是留下一个已 unlink 但仍被映射的旧页面：server 继续读
     * 旧数据、新 ingest 往新文件写，两边永远对不上，而且没有任何报错。
     *
     * 所以顺序必须是：停 → 删 → （下面 ensureReady 把它起回来）→ POST /ingest。
     */
    if (fresh) {
      await this.stop()
      this.wipeGraphData()
    }
    try {
      /**
       * ★ 建图交给**跑着的 server**（`POST /ingest`），不再另起一个进程。
       *
       * ## 为什么换掉 `python -m scripts.ingest`
       *
       * 原来的做法是「stop server → 另起一个 ingest 进程 → 起回 server」，
       * 理由是"两个进程同时写 SQLite/Qdrant 会撞"。理由本身对，但代价是：
       * 建图期间检索完全不可用（几分钟），而且**每次都要重付一次
       * ~90s 的 Qdrant warmup**。
       *
       * kl 后来提供了 in-server 的 `/ingest`：它在 server 进程内跑
       * Phase A（切块+embedding，无 LLM）与 Phase B（LLM 抽取 + 建图），
       * **复用同一个 Qdrant writer**，建完热切换索引。也就是那个"会撞"的
       * 前提被上游消掉了 —— 现在建图期间检索照常可用，且不用重 warmup。
       *
       * ★ 副作用（必须先 ensureReady）：既然是"让 server 干活"，
       * server 就得先在。原来那条路径是反的（先 stop），照抄会 100% 失败。
       */
      // “建图”本身是一次显式用户操作。若服务此前启动失败，应在这里重试，
      // 否则补好依赖后仍必须先另点一次“重试”或重启应用，建图按钮会持续失败。
      const ready = this.state === "failed" ? await this.retry() : await this.ensureReady()
      if (!ready) {
        this.setBuilding(false)
        return this.logBuildOutcome(fresh, {
          ok: false,
          reason: this.reason ?? "kl-server 未就绪，无法建图",
          entities: 0,
          facts: 0,
          edges: 0,
        })
      }

      /**
       * ★★ 建图前的硬闸：绝不对 adopt 来的孤儿发 `/ingest`。
       *
       * `ensureReady` 上面已经试过 `reclaimOrphan()`（在 `start()` 里）——
       * 走到这里若仍是 `adopted`，说明端口上那个是**外部进程**（用户手工
       * `kl start` 的，没有我们的 pidfile），我们没有它的句柄、它的 stdio
       * 读端可能已死。对它 postIngest，建图一 print 就 `[Errno 32] Broken pipe`
       * ——那正是本次要根治的静默失败（图库停在 500 条 fact、自我图只剩 2 个邻居）。
       *
       * 所以宁可**明确报错**：告诉用户去关掉那个外部进程或重启应用（重启后
       * reclaim 因无 pidfile 仍判它为外部进程，但至少建图不再写死管道）。
       * 走 `logBuildOutcome` 失败分支 —— 只标记「建图失败」，不污染服务状态
       * （服务对查询仍是可用的，见 `building` 的契约注释）。
       */
      if (this.adopted) {
        this.setBuilding(false)
        return this.logBuildOutcome(fresh, {
          ok: false,
          reason:
            "检测到一个不受本应用管理的 kl-server 占用了 8200 端口，无法建图。" +
            "请关闭它（它多半是手动 `kl start` 起的），或重启本应用后再试。",
          entities: 0,
          facts: 0,
          edges: 0,
        })
      }

      const started = await this.postIngest(this.exportDir)
      if (started !== null) {
        this.setBuilding(false)
        /**
         * ★ **不调 `fail()`** —— 那会把服务状态置成 failed 并写 `reason`,
         * 而 UI 的「图谱服务」区渲染的正是 `reason`。于是**建图**失败会显示成
         * **服务**失败(实测截图:徽章「就绪」旁边挂着红色「建图失败:…」,
         * 而服务一直健康)。建图与服务是两个维度,见 `building` 的契约注释。
         *
         * 失败原因随返回值给调用方 —— UI 在「图谱数据」区显示它。
         */
        return this.logBuildOutcome(fresh, {
          ok: false,
          reason: `建图启动失败：${started}`,
          entities: 0,
          facts: 0,
          edges: 0,
        })
      }

      /**
       * `/ingest` 是**非阻塞**的（server 后台跑，立刻回 `started`）。
       * 所以这里要轮询 `/status` 等终态 —— 否则我们会在 Phase A 刚开始
       * 就报"建好了 0 个实体"，而那是本项目里最典型的静默失败形态。
       */
      const outcome = await this.awaitIngest()
      this.setBuilding(false)
      /**
       * ★★ 被主动打断 → **不是失败**，早于 error 判断返回。
       *
       * 走 `logBuildOutcome` 的失败分支会打一条 warn 并让上层记
       * `consecutiveFailures`（→ 30 分钟退避）。而这一轮是我们自己关的，
       * 下次启动照常建就行。见 `stopping` 与契约里 `cancelled` 的注释。
       */
      if (outcome.cancelled) {
        return {
          ok: false,
          cancelled: true,
          reason: null,
          entities: outcome.entities,
          facts: outcome.facts,
          edges: outcome.edges,
        }
      }
      if (outcome.error !== null) {
        // 同上:建图失败不污染服务状态。
        return this.logBuildOutcome(fresh, {
          ok: false,
          reason: `建图失败：${outcome.error}`,
          entities: 0,
          facts: 0,
          edges: 0,
        })
      }
      /**
       * ★★ `state: done` 但**没有事实** —— 那不是成功。
       *
       * kl 会在三种情况下"成功地"建出一张空图：
       * ① 输入是空的（导出目录里还没有 records.jsonl —— 自动建图跑在首次
       *    导出之前时就是这样）；
       * ② Phase A（切块+向量化，不用 LLM）跑完了，Phase B（LLM 抽实体）
       *    一条都没抽出来（网关不通）；
       * ③ ★ **抽取缓存被污染** —— 上游 `llm_extractor.py` 在 LLM 调用失败时
       *    `return [{entities:[], facts:[], _error:…}]` 并把那个空结果**写进
       *    磁盘缓存**。于是抽取不抛异常、ingest 报 `done "ingest complete"`，
       *    而**下一次**建图会全部命中那些空缓存 —— 实测 87 秒"建成"一张空图
       *    （4365 条消息、零 LLM 调用）。
       *
       * ## ★ 判据是 `facts === 0`，不是 `entities === 0 && facts === 0`
       *
       * 原来那个 `&&` 太松：③ 那种情况下 entities 可能非零（实体名能从
       * 别的路径落库），而 facts 一定是 0 —— fact 是**抽取的产物**，
       * 抽取全失败就一条都不会有。用 `&&` 的话那次 87 秒空跑就被判成了成功，
       * UI 上是一句绿色的"建图完成"。
       *
       * 一句"完成"配着 0 条事实，是本项目最典型的静默失败形态：用户没有任何
       * 理由去看日志，也就永远不知道要去填网关 key / 清抽取缓存。
       */
      if (outcome.facts === 0) {
        return this.logBuildOutcome(fresh, {
          ok: false,
          reason: this.emptyGraphReason(),
          entities: outcome.entities,
          facts: 0,
          edges: outcome.edges,
        })
      }
      return this.logBuildOutcome(fresh, {
        ok: true,
        reason: null,
        entities: outcome.entities,
        facts: outcome.facts,
        edges: outcome.edges,
        /**
         * ★ 差值 = 建完 − 建前。允许负数（fresh 重建先清空、
         * 或上游合并了重复实体）—— 夹到 0 会把"合并生效了"显示成"没变化"。
         */
        volume: this.rememberVolume(computeBuildVolume(before, outcome, outcome.volume)),
      })
    } catch (error) {
      this.setBuilding(false)
      const detail = error instanceof Error ? error.message : String(error)
      // 同上:建图异常不污染服务状态(服务可能仍在正常提供检索)。
      return this.logBuildOutcome(fresh, {
        ok: false,
        reason: `建图异常：${detail}`,
        entities: 0,
        facts: 0,
        edges: 0,
      })
    }
  }

  /**
   * 建图的**终态**统一在这里留痕（成败都记）。
   *
   * ## ★★ 为什么必须有
   *
   * 自动建图那条路在 `startup.ts` 的 trigger 里打 `auto graph build failed`，
   * 而**手动点按钮**走 IPC → `rebuildGraph` → 直接返回 UI，从入口到出口
   * 一条日志都不打。三份同事日志里的形状：
   *
   * ```
   * 09:55:46 kl graph data wiped for fresh rebuild
   * 09:55:49 kl-server ready
   * ── 之后什么都没有 ──
   * ```
   * 图库被清空了，而"为什么没建回来"完全无从判断。一个花几十分钟、
   * 还会**不可逆清空数据**的操作，必须在日志上留痕。
   *
   * 成功也记：`entities/facts/edges` 三个数是判断"这次是不是空跑"的依据
   * （实测抓到过 87 秒"建成"一张空图 —— 全部命中被污染的抽取缓存）。
   */
  private logBuildOutcome(fresh: boolean, result: KlGraphBuildResult): KlGraphBuildResult {
    if (result.ok) {
      this.options.logger.info("graph build finished", {
        fresh,
        entities: result.entities,
        facts: result.facts,
        edges: result.edges,
        /**
         * ★ 差值与处理量一起记：只有绝对值的话"这一轮是不是空跑"看不出来
         * （增量建图下总数几乎不变），而 `unitsSkipped` 是增量真的生效了
         * 的唯一证据。
         */
        volume: result.volume,
      })
    } else {
      this.options.logger.warn("graph build failed", { fresh, reason: result.reason })
    }
    return result
  }

  /**
   * `fresh=true`（清空重来）的**前置**闸 —— 返回非 null 就别清。
   *
   * ## ★★ 为什么必须在清库之前
   *
   * 原来的顺序是 `stop → wipe → ensureReady → postIngest`，而 wipe 之后
   * 每一步都可能失败并 return。那时用户的图**已经没了**：两台同事机器上
   * 各点了两次「重建」，结果都是 `kl graph data wiped` 之后再无建图 ——
   * 比点之前更糟，而且（加日志之前）没人知道发生了什么。
   *
   * 只查**清库前就能知道**的两件事：
   * · 导出目录里有没有数据 —— 没有的话清完也建不出东西；
   * · 网关配没配 —— Phase B 要调 LLM 抽实体，没网关必然抽出 0 个
   *   （而且上游会把失败缓存成空结果，见 `emptyGraphReason`）。
   *
   * 增量建图（`fresh=false`）**不走**这个闸：它不删任何东西，失败的代价只是
   * 白跑一趟，而多一道闸反而会挡住合理的重试。
   */
  private freshRebuildBlocker(): string | null {
    const exportDir = this.exportDir ?? ""
    if (exportDir !== "" && !existsSync(join(exportDir, "chat", "records.jsonl"))) {
      return "还没有可建图的数据（导出未生成）—— 清空重建会让现有图谱直接消失，已取消"
    }
    if (!this.hasGatewayEgress()) {
      return "还没配模型网关 —— 清空重建后无法抽取实体（图会是空的），已取消。请先在设置里配好网关"
    }
    return null
  }

  /**
   * 「ingest 说 done，但没有事实」时给出**下一步**。
   *
   * 四档判据，各自对应完全不同的处置 —— 所以必须分开而不是给一句
   * "建图失败"（那句话不能让任何人知道该做什么）：
   *
   * · 导出目录里没有 `records.jsonl` → 输入是空的。多见于自动建图跑在首次
   *   导出**之前**（实测：08:39 建图失败，而 08:29 才 `export materialized`）。
   *   处置是等下一轮，用户不用做任何事。
   * · ★ 有实体但没事实 → **抽取缓存被污染**（见下）。处置是清缓存重建，
   *   而**不是**改网关（网关可能已经是好的）。
   * · 有输入、`chunks` 也写进去了 → Phase A 成功、Phase B（LLM 抽取）没产出。
   *   处置是去填/修网关（这正是打包态那个故障：kl 带着空 `KL_LLM_BASE_URL`
   *   起来，litellm `Connection error`）。
   * · 有输入但 `chunks` 是 0 → 连切块都没做成，多半 embedding 网关不通
   *   （Phase A 要调 embedding）。
   *
   * ## ★★ 那个"污染缓存"是什么
   *
   * 上游 `kl_graph/ingest/llm_extractor.py` 在 LLM 调用失败时：
   * ```python
   * except Exception as e:
   *     self.stats["llm_errors"] += 1
   *     return [{"entities": [], "facts": [], "_error": str(e)} for _ in messages]
   * ```
   * 而 `_process_batch` 紧接着把这个空结果 `_write_cache` **写进磁盘**。
   * 于是：抽取不抛异常 → ingest 报 `done` → 我们判成功；而**下一次**建图
   * `_read_cache` 全部命中那些空结果，一个 LLM 都不调 —— 实测 87 秒
   * "建成"一张空图（4365 条消息）。
   *
   * 这时改网关**没有用**（缓存已经脏了），必须清掉 `extraction_cache`。
   * 「重建」（`fresh=true`）会删它，所以指引指向那个按钮。
   *
   * 不改上游：`kl-graph` 是算法团队的代码，改了会在 `sync:kl-graph` 合并时冲突。
   *
   * ★ 读 SQLite 而不是 `/status`：`/status` 的 snapshot 不带 messages/chunks
   * （见 `defaultReadStatus` 只取了 entities/facts/edges），而这两个数正是
   * 区分上面几档的关键。同一份文件、只读打开，与 `graphOverview` 同一套理由。
   */
  private emptyGraphReason(): string {
    const exportDir = this.exportDir ?? ""
    if (exportDir !== "" && !existsSync(join(exportDir, "chat", "records.jsonl"))) {
      return "没有可建图的数据（导出还没生成）—— 等下一轮采集完成后会自动重建"
    }

    const overview = this.graphOverview()
    /**
     * ★ 有实体、没事实 —— 抽取缓存被污染的特征形状（见上面那段）。
     *
     * 与"网关不通"分开是必要的：那一档的处置是去改设置，而这一档改设置
     * 没有任何用（缓存已经脏了），必须点「重建」清掉它。给错指引的代价是
     * 用户反复检查一个本来就正确的网关配置。
     */
    if (overview.entities > 0) {
      return (
        `有 ${String(overview.entities)} 个实体但一条事实都没有 —— ` +
        "多半是上一次建图时模型网关不通，失败结果被写进了抽取缓存。" +
        "点「重建」清掉缓存重来（先确认设置里的网关是好的）。"
      )
    }
    if (overview.chunks > 0) {
      return (
        `切块已完成（${String(overview.chunks)} 块）但没抽出任何实体 —— ` +
        "多半是模型网关不通。去「设置」确认网关地址与密钥；改完 kl 会自动重启。"
      )
    }
    return (
      "建图没有产出任何内容（连切块都没完成）—— 多半是 embedding 网关不通。" +
      "去「设置」确认网关地址与密钥；改完 kl 会自动重启。"
    )
  }

  /**
   * 图库里**有没有东西** —— 只回答这一个是非题。
   *
   * ## ★★ 为什么必须与 `graphOverview()` 分开（血的教训）
   *
   * 自动建图的 `graphExists` 判据曾经写成 `graphOverview().available`。
   * 那看起来只是"复用一下"，实际造出了一个**无限互递归**：
   *
   * ```
   * graphOverview()  → buildSchedule()            （:916 / :840 都调）
   *   → feed.graphBuildSchedule()                 （startup.ts 注入）
   *     → autoBuild.graphExists()                 （forecastAutoBuild 的入参）
   *       → graphOverview()  ← 回到起点，永不收敛
   * ```
   *
   * 而 `graphOverview()` 的 **catch 分支自己也在环上**（`empty()` 里同样调
   * `buildSchedule()`），所以撞栈之后不是抛出去，而是"warn 一条 → 重新进环"。
   * 实测后果：一次调用打出 **10,212,769 条**同样的
   * `read graph overview failed / Maximum call stack size exceeded`，
   * 3 小时 21 分钟写掉 **1.7 GB** 日志（~15000 行/秒），主进程事件循环
   * 再也不走一个 tick —— 表现为"应用启动不起来"。
   *
   * 触发点就在启动路径上：`FeedService.attach()` 那句"挂载时先跑一轮"。
   *
   * ★ 所以这个方法**绝不能**碰 `buildSchedule`。它的判据也不需要：
   * "图里有没有东西"要的是行数，而 `buildSchedule` 是"下次什么时候建"
   * —— 后者对前者毫无贡献，当初被牵进来纯粹是复用了一个过大的返回值。
   *
   * ★ 判据与 `graphOverview().available` 保持同源（`entities>0 || facts>0`）：
   * 两处漂移的话会出现"界面说图是空的、而自动建图认为图已存在"，
   * 那种矛盾没有任何地方能发现。所以这里是**唯一**的实现，
   * `graphOverview()` 复用它（反向依赖：轻的不依赖重的）。
   */
  /**
   * 读一次图规模（entities / facts / edges）—— 建图差值的基线。
   *
   * ## ★ 为什么 edges 走 `lastKnownEdges` 而不是 SQL
   *
   * SQLite 的 `edges` 表在默认后端（ladybug）下按设计恒空
   * （完整推理见 `lastKnownEdges` 的注释）。所以那一项只能用从 `/status`
   * 拿到的真实值；数不出来时给 0，差值那侧会把"两端都是 0"显示成"未统计"
   * 而不是"没新增"。
   *
   * 整段吞异常：这是给差值用的诊断数字，图库不存在（首次建图）时读不到
   * 是**正常**的 —— 那时全 0，差值恰好等于绝对值。
   */
  private readGraphCounts(): { entities: number; facts: number; edges: number } {
    const zero = { entities: 0, facts: 0, edges: 0 }
    const dbPath = join(this.dataDir, "knowledge.db")
    if (!existsSync(dbPath)) return zero
    const open = this.options.openGraphDb ?? defaultOpenGraphDb
    let db: GraphDbHandle | null = null
    try {
      db = open(dbPath)
      const handle = db
      const count = (table: string): number => {
        try {
          return handle.count(table)
        } catch {
          return 0
        }
      }
      return {
        entities: count("entities"),
        facts: count("facts"),
        // ★ 见上：edges 不从 SQL 数
        edges: this.lastKnownEdges ?? 0,
      }
    } catch {
      return zero
    } finally {
      try {
        db?.close()
      } catch {
        // 只读连接，关不掉无需处理
      }
    }
  }

  graphExists(): boolean {
    const dbPath = join(this.dataDir, "knowledge.db")
    if (!existsSync(dbPath)) return false
    const open = this.options.openGraphDb ?? defaultOpenGraphDb
    let db: GraphDbHandle | null = null
    try {
      db = open(dbPath)
      const handle = db
      const count = (table: string): number => {
        try {
          return handle.count(table)
        } catch {
          // 表还不存在（schema 未初始化）= 0，与 graphOverview 同口径。
          return 0
        }
      }
      return count("entities") > 0 || count("facts") > 0
    } catch (error) {
      /**
       * ★ 读不出来当成"没有图"，且**只记 debug**。
       *
       * 这个方法在自动建图的每一轮判断里被调（10 分钟一次），而"图读不出来"
       * 最常见的原因是建图正在热切换那个文件 —— 那是正常状态，不是故障。
       * 记 warn 的话又会变成刷屏，而这次刷屏正是被修的那个 bug。
       */
      this.options.logger.debug("graph existence probe failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      try {
        db?.close()
      } catch {
        // 关不掉无需处理：只读连接，进程退出会回收。
      }
    }
  }

  /**
   * 知识图谱概览（可视化版块的数据）。
   *
   * ★★ 注意：这个方法会调 `buildSchedule()`，而那条链路最终会回到
   * `KlServerService`。所以**主进程内部的判断逻辑不要调它** ——
   * 要"图里有没有东西"就调 `graphExists()`（见那里的注释：为什么分开）。
   * 这个方法只服务于 UI（`klGraphOverview` 那个 IPC）。
   *
   * ## ★ 为什么直接读 SQLite，而不走 kl 的 HTTP
   *
   * · 这些都是**聚合**查询（GROUP BY / ORDER BY LIMIT），kl 没有对应端点
   *   （`/entity` 是按名字查、`/ask` 是检索），要么让上游加接口、
   *   要么在这里读一次。数据就在本机同一个文件里，读它更直接；
   * · 更重要的：建图**期间**也要能看（那正是用户最想看的时刻），
   *   而那时 server 在忙 —— 实测 `/entity` 在建图中直接 500。
   *   读文件不受它影响。
   *
   * 只读打开（`readonly: true`）：这个库的 schema 归 kl 所有，我们绝不写它。
   * 写一下就会与它的 Qdrant 侧失去一致（那种不一致没有任何地方能发现）。
   *
   * ★ 每次调用开/关连接而不是长持一个：建图会**热切换**这个文件
   * （kl 的 hot-swap），长持的连接会读到旧快照 —— 表现是"建完图了但
   * 概览还是 0"，而那与"真的没建成"完全无法区分。
   */
  graphOverview(): KlGraphOverview {
    /**
     * ★★ 调度快照**取一次**，且它自己的失败不许传播出去。
     *
     * 两条都是这次那个 1.7 GB 事故的直接教训（详见 `graphExists()` 的注释）：
     *
     * ① 取一次：从前 `empty()` 与成功分支各调一次 `buildSchedule()`，
     *    于是**错误路径自己也在环上** —— 撞栈后不是抛出去，而是
     *    "warn 一条 → 再进环 → 再撞"，1000 万条 warn 都不收敛。
     *    现在错误路径复用这个已经算好的值，catch 里不再有任何可能失败的调用。
     * ② 兜住它的异常：`buildSchedule` 是注入的（`startup.ts` → `FeedService`
     *    → 游标表），它出问题不该让整个概览页变成"读图谱失败" ——
     *    那句话会把人引向 kl 与图库，而真正坏的是水位那一侧。
     *
     * 拿不到 → null，界面据此不显示那一块（与"未接自动建图"同一个表现）。
     */
    let schedule: KlGraphOverview["buildSchedule"] = null
    try {
      schedule = this.options.buildSchedule?.() ?? null
    } catch (error) {
      this.options.logger.warn("read build schedule failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    const empty = (reason: string): KlGraphOverview => ({
      available: false,
      reason,
      entities: 0,
      facts: 0,
      edges: 0,
      chunks: 0,
      messages: 0,
      entityTypes: [],
      factTypes: [],
      topEntities: [],
      recentFacts: [],
      // 调度状态与图能不能读**无关**：图还没建时这一块恰恰最该显示
      // （它要回答的正是"什么时候会建"）。
      buildSchedule: schedule,
      /**
       * ★ 图读不出来时**仍然报**上一轮的产出：那两件事无关 ——
       * 「刚才那轮建了多少」是已经发生的事实，不该因为此刻读不到图而消失。
       * 而 `fresh=true` 清库那个窗口里恰恰两者同时出现。
       */
      lastBuild: this.lastBuildVolume ?? null,
    })

    const dbPath = join(this.dataDir, "knowledge.db")
    if (!existsSync(dbPath)) {
      /**
       * ★★ **正在建图时不许说"还没建过"** —— 那是一句会误导操作的假话。
       *
       * `fresh=true` 的第一步是把整个 kl 目录删掉（`kl graph data wiped for
       * fresh rebuild`），此后一段时间 `knowledge.db` 确实不存在。而那时
       * 建图**正在跑**。
       *
       * 实测撞上（用户截图 + 库里数字）：界面显示「实体 0 / 事实 0」+
       * 「图是空的 —— 建图没有成功跑过（点「重新建图」…）」，而同一时刻
       * 库里已经有 `entities 321 / facts 409`，几分钟后那一轮正常完成
       * （`graph build finished {entities:321, facts:409, edges:24222}`）。
       *
       * 危险的不是"数字不准"，而是它**引导用户点「重新建图」**——
       * 那会把正在建的这一轮连同已建好的部分再删一遍，于是永远建不完。
       *
       * ★ 判据用 `this.building` 而不是"文件存不存在"：前者是我们自己的
       * 状态机（`rebuildGraph` 进出时置位），后者在 fresh 那个窗口里
       * 恰好给出相反的答案。
       *
       * ★★ **不许在文案里承诺时长**（原来写着"第一次要几分钟"）。
       * 耗时差两个数量级且不可预测 —— 实测同一台机器上：
       * 全量 Phase A 17 分钟、增量 Phase A 46.8 秒，而 Phase B 的 LLM 抽取
       * 完全取决于网关（那次被 524 超时打挂过一整批）。
       * 承诺一个数字的后果是：超过那个数字之后用户认为"卡住了"，
       * 于是去点重新建图 —— 而那正是这一整段要避免的动作。
       */
      return empty(
        this.building
          ? "正在建图 —— 这一轮完成后就会有内容，不用重新点"
          : "还没建过图（点「重新建图」开始，它会出网）",
      )
    }

    const open = this.options.openGraphDb ?? defaultOpenGraphDb
    let db: GraphDbHandle | null = null
    try {
      db = open(dbPath)
      const handle = db
      const count = (table: string): number => {
        try {
          return handle.count(table)
        } catch {
          // 表还不存在（schema 未初始化）—— 0 而不是抛，让页面照常渲染。
          return 0
        }
      }
      const groups = (table: string, column: string): Array<{ type: string; count: number }> => {
        try {
          return handle.groupBy(table, column)
        } catch {
          return []
        }
      }

      const entities = count("entities")
      const facts = count("facts")
      /**
       * ★★ 边数**不从 SQLite 数** —— 那张表在 ladybug 后端下恒空
       * （完整推理见 `lastKnownEdges` 与 `describeGraphStage` 的注释）。
       *
       * `null` = 还没从 `/status` 问到过真实值。那时**报 0 也没有意义**，
       * 但契约里 `edges` 是 number，所以对外仍给 0 —— 区别在于
       * 判据（`describeGraphStage`）收到的是 `undefined`，于是不会
       * 拿这个数去说"关系边还没建"那句假话。
       */
      const knownEdges = this.lastKnownEdges
      const edges = knownEdges ?? 0

      let topEntities: KlGraphOverview["topEntities"] = []
      try {
        topEntities = handle.topEntities(20)
      } catch {
        topEntities = []
      }

      let recentFacts: KlGraphOverview["recentFacts"] = []
      try {
        recentFacts = handle.recentFacts(12)
      } catch {
        recentFacts = []
      }

      /**
       * ★ `entities === 0` 时给的是"还没建成"而不是空页。
       *
       * 这两者在界面上必须分开：数据库文件存在、schema 也对、但每张表都是
       * 0 行 —— 那正是我们踩过的坑（`kl ingest` 从没成功跑过，
       * 而 `/health` 一直回 ok）。显示成一个干净的空页会让人以为
       * "我的聊天里就是没什么可抽的"。
       *
       * ## ★★ 判据必须把 `facts` 单独判，不能挂在 `entities` 上
       *
       * 原来只有三档，`edges === 0` 那一档说的是「实体与事实已就绪，
       * 关系边还没建（建图的最后一步）」—— 而它**根本没看 facts**。
       *
       * 实测撞上（用户截图 + 库里数字）：
       *
       * ```
       * chunks 2296   entities 60   facts 0   edges 0
       * ```
       *
       * 界面照旧说"事实已就绪、只差最后一步"，而事实是 0、差的是中间一大步。
       * 那句话把用户引向"再等等就好"，于是他不会去查真正的原因。
       *
       * ## 为什么这个组合会出现（`entities>0` 而 `facts===0`）
       *
       * 两者来自建图的**不同阶段**：
       * · `entities` 一部分在 Phase A（切块 + embedding）就能落；
       * · `facts` 要 Phase B 的 **LLM 抽取**才有。
       *
       * 所以"Phase A 成功、Phase B 挂了"会稳定产出这个组合。实测那次的
       * Phase B 是被网关打挂的（`Error 524: A timeout occurred`，
       * Cloudflare 网关超时，整批 `Batch LLM error … transient`）。
       *
       * ★ 文案指向**那一步**而不是"再等等"：抽取失败要么重试、要么换网关，
       * 而"最后一步"这个说法会让人什么都不做。
       */
      /**
       * ★★ 建图**正在跑**时，半成品不是"失败"。
       *
       * `describeGraphStage` 的那几句（"事实一条都没抽出来"、"关系边还没建"）
       * 说的是**一轮跑完之后**的状态。而建图中途它们全都会命中 ——
       * Phase A 完成时 facts 天然是 0、边要到最后一步才建。
       *
       * 实测那一轮：中途 `entities 321 / facts 409 / edges 0`，
       * 完成时 `edges 24222`。也就是说"关系边还没建"在中途是**正常**的，
       * 而把它说成需要用户处理的问题会让人去点重新建图。
       */
      const reason = this.building
        ? "正在建图 —— 数字会随进度增长"
        : describeGraphStage({ entities, facts, edges: knownEdges ?? undefined })

      return {
        /**
         * ★ 判据保持 `entities > 0 || facts > 0` —— 刻意**不**要求 facts。
         *
         * 这个字段的语义是"图谱面板有东西可显示吗"，而只有实体也确实能显示
         * （实体列表、类型分布、ego 图的节点）。要求 facts 会让一个
         * 半成品图整块消失，而那比显示半成品更糟：用户看不到"已经建了 60 个
         * 实体"这个事实，也就无法判断建图到底走到哪了。
         *
         * 真正需要区分的是**质量**，而那由上面的 `reason` 说清（facts=0 时
         * 明确写"事实一条都没抽出来"）。可见 + 带原因，比不可见好。
         */
        available: entities > 0 || facts > 0,
        reason,
        entities,
        facts,
        edges,
        chunks: count("chunks"),
        messages: count("messages"),
        entityTypes: groups("entities", "entity_type"),
        factTypes: groups("facts", "fact_type"),
        topEntities,
        recentFacts,
        // 上面取过一次（见那里：为什么不能在成功/失败两条路上各取一次）。
        buildSchedule: schedule,
        // ★ 「这一轮建了多少」——与上面那些绝对值是两件事（见契约里的注释）
        lastBuild: this.lastBuildVolume ?? null,
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn("read graph overview failed", { detail })
      return empty(`读图谱失败：${detail}`)
    } finally {
      try {
        db?.close()
      } catch {
        // 关不掉无需处理：只读连接，进程退出会回收。
      }
    }
  }

  /**
   * `POST /ingest`。返回 null = 已启动，否则是失败原因。
   *
   * 409 单独处理：server 说"已经有一个 ingest 在跑"。那不是错误 ——
   * 我们接着去轮询那一个的进度就行（比如上一次触发还没跑完就重启了应用）。
   */
  private async postIngest(exportDir: string): Promise<string | null> {
    const post = this.options.postIngest ?? defaultPostIngest
    try {
      /**
       * ★★ `source_id` 用**这个服务自己的渠道 id**。
       *
       * 上游那一版写死成一个常量，注释里写着「目前只有一个渠道，
       * 所以是常量；接飞书时这里要按导出物的来源分」—— 现在正是那个时候。
       *
       * 不按渠道分的后果不是"标签不好看"：kl 拿它算断点续传的 checkpoint 路径
       * （`checkpoint_path(source_id)`，见 `kl_graph/ingest/runner.py`），
       * 两个渠道共用一个值就会**互相覆盖对方的续传进度** ——
       * 表现是"增量建图每次都从头扫"或"某渠道的新导出被当成已处理过"。
       */
      const status = await post(this.port, exportDir, this.options.channelId)
      if (status === 409) {
        this.options.logger.info("ingest already running; following it", {})
        return null
      }
      return status >= 200 && status < 300 ? null : `HTTP ${status}`
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * 轮询 `/status` 直到 ingest 到终态（done / error）。
   *
   * 进度经 IPC 推给 UI：建图是分钟级的，没有进度的话用户只能看着一个
   * 不动的按钮猜它是在跑还是卡死了。
   */
  private async awaitIngest(): Promise<{
    error: string | null
    /**
     * ★ 被**我们自己**打断（`stop()` / 关机 / fresh 清库前置停），不是失败。
     *
     * 与 `error` 分开而不是塞进 error 字符串里：调用方要按它决定**要不要
     * 计入 `consecutiveFailures`** —— 而那个计数会触发 30 分钟退避
     * （见 `stopping` 的注释里那串实测日志）。用字符串匹配来区分是个
     * 迟早会漂移的判据。
     */
    cancelled: boolean
    entities: number
    facts: number
    edges: number
    /** 这一轮处理了多少语料（上游直接给的四个数，见 `KlIngestSnapshot.volume`） */
    volume: KlIngestSnapshot["volume"]
  }> {
    const readStatus = this.options.readStatus ?? defaultReadStatus
    const sleep = this.options.sleep ?? defaultSleep
    let counts = { entities: 0, facts: 0, edges: 0 }
    /**
     * 处理量：**每轮轮询都覆盖**，所以循环结束时是最后一次看到的值。
     *
     * ★ 与 `counts` 同一款做法。上游在跑的过程中这几个数一直在涨
     * （`detail: "extracting: 100/271 batches"` 那时就已经有部分值），
     * 而我们要的是终态那一份。
     */
    let volume: KlIngestSnapshot["volume"] = {
      unitsDiscovered: 0,
      unitsSkipped: 0,
      unitsProcessed: 0,
      chunksCreated: 0,
    }
    /**
     * 本轮建图的起点 —— 只进 `buildProgress` 供诊断（见契约里那个字段的注释）。
     *
     * ★ 在**循环外**取一次：放进循环就变成"上次轮询的时刻"，减出来永远是一个
     * 轮询间隔。
     */
    const startedAt = this.options.clock.now()
    /**
     * 连续探测失败次数 —— 这是唯一可靠的"它是不是没了"的判据，见下。
     */
    let consecutiveProbeFailures = 0

    /**
     * ★★ 这里**没有时间上限**，是刻意的。
     *
     * ## 原来有一个 45min 的 `INGEST_TIMEOUT_MS`，它是个假失败源
     *
     * 那个超时**并不会停掉建图** —— ingest 跑在 kl-server 进程里，我们这边
     * 只是停止观察。于是到点之后：报「建图失败：建图超时（>45min）」，而 kl
     * 那边一直跑到底。实测抓到过一次：
     *
     * ```
     * 06:45:41 WARN auto graph build failed {"reason":"建图失败：建图超时（>45min）"}
     * // 而同一时刻 /status 仍是 state=running phase_a，chunks 已写 38381 条
     * ```
     *
     * 而后果不止是"一条难看的日志"：`FeedService` 那边把它记成失败 →
     * `consecutiveFailures` 累进 → 触发退避 → **后续自动建图被推迟**，
     * 而实际上什么都没坏。也就是一次误判会真的降低功能可用性。
     *
     * ## 为什么不换一个"卡死"判据，而是干脆不判
     *
     * 试过两个，都不行（真机实测）：
     * · kl 的 `updated_at` —— **24 秒不变**；
     * · SQLite 里 `chunks` 表的行数 —— **36 秒不变**（停在 38381）。
     *
     * 因为 Phase A 是**整块提交**的：中途没有任何可观测的增量。任何基于
     * "多久没动就算死"的判据都会把正常建图判死 —— 那正是我们要修的 bug 的
     * 同一种形态，只是阈值换了个数字。
     *
     * ## 那靠什么结束
     *
     * 只靠**明确的终态**：`state` 变成 `done` / `error`。加一条兜底：
     * 连续多次连不上 `/status`（进程真没了），那时 `handle.alive` 也会是 false。
     * 这两个都是"事实"而不是"推测"。
     *
     * 真出现挂死时的表现是"建图一直显示在跑" —— 而那与事实一致（进程确实在、
     * 只是不出结果），用户仍可停服务或重启应用。比谎报一个失败诚实。
     */
    for (;;) {
      /**
       * ★★ 先判「是不是我们自己在关」，再判进程死活。
       *
       * 顺序是刻意的：`stop()` 会先立 `stopping` 再 await `killHandle()`，
       * 而那期间这个循环仍在跑。放到进程死活判据**之后**的话，仍然会先
       * 报一次「建图中断：进程已退出」—— 那正是要修的那条假失败。
       *
       * 不 await 完 sleep 就退出：关机路径上每多等一个 3s 轮询间隔，
       * `klServer` 那步（预算 2s）就更超时。
       */
      if (this.stopping) {
        this.buildProgress = null
        this.options.logger.info("graph build cancelled by shutdown", {})
        return { error: null, cancelled: true, ...counts, volume }
      }

      let snapshot: KlIngestSnapshot | null
      try {
        snapshot = await readStatus(this.port)
        consecutiveProbeFailures = 0
      } catch {
        // 建图期间 server 忙，偶发探测失败是常态 —— 继续轮询而不是判失败。
        snapshot = null
        consecutiveProbeFailures += 1
      }

      /**
       * ★ 进程没了才算失败（不是"太慢"算失败）。
       *
       * 两个条件都要：探测连续失败**且**我们的子进程句柄已经死了。
       * 只看探测会误伤（server 忙时偶发超时）；只看句柄在复用（adopted）态下
       * 恒为 null，永远不成立。
       */
      if (consecutiveProbeFailures >= INGEST_PROBE_FAILURE_LIMIT && this.handle?.alive !== true) {
        this.buildProgress = null
        return { error: "建图中断：kl-server 进程已退出", cancelled: false, ...counts, volume }
      }

      if (snapshot !== null) {
        counts = snapshot.counts
        volume = snapshot.volume
        // ★ 记下 backend-aware 的真实边数（见 lastKnownEdges 的注释）
        this.lastKnownEdges = snapshot.counts.edges
        this.buildProgress = { phase: snapshot.phase, percent: snapshot.percent, startedAt }
        this.pushStatus()
        if (snapshot.state === "done") {
          this.buildProgress = null
          return { error: null, cancelled: false, ...counts, volume }
        }
        if (snapshot.state === "error") {
          this.buildProgress = null
          return {
            error: snapshot.error === "" ? "未知错误" : snapshot.error,
            cancelled: false,
            ...counts,
            volume,
          }
        }
      }
      await sleep(INGEST_POLL_INTERVAL_MS)
    }
  }

  /**
   * 优化图谱：跑 `python -m scripts.improve`（periodic 阶段，**出网烧 LLM**）。
   *
   * 建图（ingest）只产原始的实体/事实/边；这一步在其上补：SIMILAR_TO 边、
   * 实体消歧（~200-500 次 LLM）。
   *
   * ## ★ 社群（community）已被算法侧默认关闭，这一步不再是查询的前提
   *
   * 上游把社群划为 experimental 并默认关（`config` 的
   * `pipelines.experimental.communities.enabled` = `KL_COMMUNITIES_ENABLED,0`）。
   * 关着时 improve **只跑相似度**、提前返回，不做 Leiden、不建 `community_L*` 列。
   *
   * 而 `/entity` 已经**优雅降级**：kl_server 用 `PRAGMA table_info` 探列，
   * `has_community = COMMUNITIES_ENABLED and "community_L0" in cols`，没有那几列
   * 就少返回社群字段，**不再 500**（旧注释说的"没跑 improve 就 no such column
   * → 500"在当前上游已不成立）。所以这一步现在是**可选优化**（补相似度边、
   * 消歧），不是"让查询能用"的前置。我们仍把它与 ingest 分成两个入口
   * （贵、可调参重跑）。
   *
   * 与建图同构：独占数据文件，先 stop → improve → 完成重启读优化后的图。
   */
  async optimizeGraph(): Promise<KlGraphOptimizeResult> {
    const empty = { factEdges: 0, entityEdges: 0, entityCommunities: 0, factCommunities: 0 }
    if (this.building) {
      return { ok: false, reason: "图谱任务已在进行中", ...empty }
    }
    const python = this.resolvePython()
    if (python === null) {
      return {
        ok: false,
        reason: "未找到 Python 解释器（设置 KL_PYTHON 指向 kl 的 venv）",
        ...empty,
      }
    }

    this.setBuilding(true)
    // periodic 同样独占 SQLite/Qdrant：先停 server。
    await this.stop()

    // improve 收尾打印计数行，挑出来做结果（先粗粒度）。
    // 形如 "  Fact SIMILAR_TO edges: 123" / "  Entity SIMILAR_TO edges: 45"
    // 社群那几行是多分辨率的（"L0: 12 communities, ..."），取出现的社群数之和。
    const counts = { ...empty }
    try {
      const result = await this.options.processes.spawn({
        executable: python,
        args: ["-m", "scripts.improve"],
        env: this.buildEnv(),
        cwd: this.options.klRoot,
        // 消歧要打 LLM，可能几分钟；给足超时（15min）。
        timeoutMs: 900_000,
        onLine: (line) => {
          this.options.logger.debug("kl improve", { line })
          const fe = /Fact SIMILAR_TO edges:\s*(\d+)/.exec(line)
          if (fe !== null) counts.factEdges = Number(fe[1])
          const ee = /Entity SIMILAR_TO edges:\s*(\d+)/.exec(line)
          if (ee !== null) counts.entityEdges = Number(ee[1])
          // "    L0: 12 communities, 340 entities" —— 累加各层社群数（粗粒度）。
          const comm = /:\s*(\d+)\s+communities,\s*(\d+)\s+(entities|facts)/.exec(line)
          if (comm !== null) {
            const n = Number(comm[1])
            if (comm[3] === "entities") counts.entityCommunities += n
            else counts.factCommunities += n
          }
        },
      })
      this.setBuilding(false)
      if (result.exitCode !== 0) {
        this.fail(`优化失败（exit ${result.exitCode}）：${result.stderr.slice(-300)}`)
        return { ok: false, reason: this.reason, ...empty }
      }
      this.setState("stopped")
      void this.ensureReady().catch(() => undefined)
      return { ok: true, reason: null, ...counts }
    } catch (error) {
      this.setBuilding(false)
      const detail = error instanceof Error ? error.message : String(error)
      this.fail(`优化异常：${detail}`)
      return { ok: false, reason: detail, ...empty }
    }
  }

  /** 清空图数据 + 抽取缓存（重建前用；必须在 server stop 后调）。 */
  private wipeGraphData(): void {
    const dir = this.dataDir
    /**
     * ★★ 必须连 **ladybug 图库**与 **checkpoint** 一起删。
     *
     * ## 实测：漏掉 checkpoint 会让「清空重建」永久失败
     *
     * 一次真机现场（用户："点开始学习没反应"）：
     *
     * ```
     * 14:05:36  graph build started {fresh: true} → 删了 knowledge.db / qdrant
     * 14:05:47  graph build failed:
     *           "Checkpoint batch '…' has no durable workset;
     *            run Phase A before any chunk-dependent phase"
     * ```
     *
     * 根因：`ingest_checkpoint.<source_id>.json` 留着，而它记着
     * `phase_a.persist_chunks` / `phase_b.extraction` 等步骤**已完成** ——
     * 而库刚被删空。于是 kl 跳过 Phase A 直奔 chunk 相关阶段，
     * 那时 workset 不存在 → 每次重建都报同一个错，且**清库也修不好**。
     *
     * 而 `building` 在失败路径上会复位，但 `graphBusy()` 那一瞬间仍为真 ——
     * 于是 work 层每轮都让路，playbook 永远等不到。一个漏删的文件
     * 沿着两条链路把两个功能一起卡住，且都不报"根因"。
     *
     * ## ladybug 同理
     *
     * 边在默认后端下存 `graph.ladybug`（SQLite 的 `edges` 表按设计恒空，
     * 见 `graph-query.service.ts` 的长注释）。只删 `knowledge.db` 会留下
     * 一份**指向已删实体**的旧边集 —— 新图与旧边混在一起，而没有任何地方
     * 会报错。
     *
     * ★ `extraction_cache.db` 那一行的文件名也修了：上游从目录改成了单文件，
     * 而我们还按旧名删（`extraction_cache`，无扩展名）—— 于是那句
     * 「删了才会真的重抽」**一直没做到**。这个改名漏了一处的形状，
     * 与 `WORK_CORPUS_FACETS` 里那个 `ownership` 是同一类。
     */
    for (const name of [
      "knowledge.db",
      "knowledge.db-shm",
      "knowledge.db-wal",
      "qdrant_data",
      // ★ 边在这里（ladybug 后端），不在 SQLite 的 edges 表
      "graph.ladybug",
      "graph.ladybug.wal",
    ]) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
    /**
     * ★★ checkpoint —— 见上面那段：不删它，「清空重建」会永久报
     * "has no durable workset"。
     *
     * 按前缀删所有 source_id 的：文件名含 `source_id`（`dingtalk` /
     * 将来可能有别的渠道），写死一个名字会在多渠道时漏掉。
     */
    for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
      if (entry.startsWith("ingest_checkpoint.") && entry.endsWith(".json")) {
        rmSync(join(dir, entry), { force: true })
      }
    }
    /**
     * 抽取缓存删了才会真的重抽（cache key = md5(chunk.id)，不删就命中旧结果）。
     *
     * ★ 两个名字都删：上游历史上是目录 `extraction_cache/`，现在是单文件
     * `extraction_cache.db`。只删旧名等于这句注释说的事从来没发生过。
     */
    for (const name of ["extraction_cache", "extraction_cache.db"]) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
    /**
     * ★★ 断点续传记录必须**跟着库一起删**，否则清库之后建图必然失败。
     *
     * `ingest_checkpoint.<sourceId>.json` 记着「哪个 batch 的 Phase A 做完了」，
     * 而那个 batch 的 workset 存在**刚被删掉的 `knowledge.db` 里**。于是 kl
     * 跳过 Phase A 直奔后续阶段，然后在那里失败：
     *
     * ```
     * Checkpoint batch '22aba72b-…' has no durable workset;
     * run Phase A before any chunk-dependent phase
     * ```
     *
     * 实测（本机 2026-08-10 10:20）：只删上面那几项、留着 checkpoint 时，
     * `/ingest` 回 200 且 `state:"running"`，40 秒后转 `state:"error"`，
     * `discovered=0 / processed=0` —— **清了库、一条都没建回来**。
     * 这正是本仓库最贵的那类形态：不可逆地毁了数据，而失败发生在之后。
     *
     * ★ 用 `readdirSync` 按前缀匹配而不是拼 `this.options.channelId`：
     * 同一个 dataDir 下可能躺着历史 sourceId 写的 checkpoint（上游改过
     * source_id 的取值，比如从 `dws` 改成渠道 id）。留一个不认识的下来
     * 就是留一颗同样的雷 —— 而这个目录本来就只归这一个渠道。
     */
    for (const name of (existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
      : []
    )
      .filter((entry) => entry.isFile() && entry.name.startsWith("ingest_checkpoint."))
      .map((entry) => entry.name)) {
      rmSync(join(dir, name), { force: true })
    }
    /**
     * ★ 图存储本体与它的 WAL。
     *
     * `knowledge.db` 是关系面，而实体/关系的图结构在 `graph.ladybug`
     * （见 `kl_graph/storage/ladybug_graph.py`）。只删前者会留下一份指向
     * 已消失行的图 —— 那是"清空重来"这个语义没做到。
     */
    for (const name of ["graph.ladybug", "graph.ladybug.wal", "extraction_cache.db"]) {
      rmSync(join(dir, name), { force: true })
    }
    /**
     * ★ 文件删了，建图水位也必须清零 —— 否则「待建条数」会少算两个数量级。
     *
     * 实测：清库后游标停在旧位置、head 更高 → 界面显示"待建 407 条"，
     * 而 kl 实际要重烧 37826 个 chunk。见 `resetBuildWatermark` 选项的注释。
     *
     * 清不掉只记 warn 不抛：清库本身已经做完了（不可逆），
     * 为一个显示用的游标让整个重建失败是把次要问题升级成主要问题。
     */
    const watermarkReset = this.options.resetBuildWatermark?.() ?? false
    this.options.logger.info("kl graph data wiped for fresh rebuild", {
      dataDir: dir,
      watermarkReset,
    })
    if (!watermarkReset) {
      this.options.logger.warn("graph build watermark not reset; 待建条数会偏小", {})
    }
  }

  private async start(): Promise<boolean> {
    // 又要起了 → 上一轮的"主动停"标记作废（否则重起后的建图会被误判成被取消）。
    this.stopping = false
    /**
     * ★ 先准备并激活 Python 环境，再谈起进程。
     *
     * 顺序是刻意的：环境没准备好时 `resolvePython()` 会"成功"退回系统
     * python3，于是我们带着一个缺包的解释器去 spawn，kl-server 起来就
     * `exit 3` —— 日志里只有 `kl-server exited unexpectedly {"code":3}`，
     * 看不出是缺依赖。先准备（幂等，就绪时秒返回），把因果摆在前面。
     */
    const prepared = await this.preparePythonEnv()
    if (prepared === "failed") return false

    const python = prepared?.python ?? this.resolvePython()
    if (python === null) {
      this.fail("未找到 Python 解释器（设置 KL_PYTHON 指向 kl 的 venv）")
      return false
    }
    // 激活后的环境：kl 子进程在 venv 里（裸 python/kl 都命中它）。
    this.activatedEnv = prepared?.env

    /**
     * ★ 先探一次：端口上已经有一个健康的 kl-server 就**直接复用**，不再起。
     *
     * ## 为什么必须有这一步（两个真实故障都出在这里）
     *
     * kl-server 绑固定端口 8200。端口被占时它 `Application startup complete`
     * 之后才 bind 失败并 `exit 3` —— 也就是**看起来启动成功了**，
     * 日志里那句 `error while attempting to bind` 夹在两条 INFO 之间。
     * 我们这边的表现只有一句 `kl-server exited unexpectedly {"code":3}`，
     * 完全看不出是端口冲突，于是我一度以为是崩溃。
     *
     * 占用者从哪来：上一个应用实例退出时留下的**孤儿**（reparent 到 launchd）、
     * 或用户自己跑过一次 `kl start`。前者尤其常见 —— 开发态频繁重启应用时，
     * 若 `stop()` 没走到（强杀 / 崩溃），孤儿就会一直占着 8200。
     *
     * 复用而不是杀掉占用者：那个进程持有 SQLite + Qdrant 的写句柄，
     * 杀它可能留下半写的 Qdrant 段。而它既然 `/health` 是 ok，
     * 它服务的就是同一份 `KL_DATA_DIR`（端口与数据目录都按 vault 定）。
     *
     * ★ 复用时 `handle` 保持 null —— 我们**没有**那个进程的句柄。
     * 所以 `ensureReady` 的 `handle?.alive === true` 判据在复用态下不成立，
     * 它会每次重探一遍 `/health`：那正是我们想要的（对端不是我们的孩子，
     * 只能靠探测知道它还活着）。
     *
     * ★ 用 `probeExisting` 而不是复用 `probeHealth`：两者语义不同 ——
     * 前者问"**别人**是不是已经在了"（起之前问一次），后者问"**我起的**那个
     * warmup 好了吗"（起之后轮询）。共用一个注入点的话，测试里
     * `probeHealth: () => true`（意思是"warmup 立刻就绪"）会被这里读成
     * "端口已被占"，于是**永远不 spawn** —— 而那正是我第一版的表现：
     * 8 个不相关的用例一起变红，全是因为 mock 的子进程根本没被起。
     * 缺省实现是同一个 `/health` 请求，但注入点必须分开。
     */
    const probeExisting = this.options.probeExisting ?? defaultProbeHealth
    const adopted = await probeExisting(this.port).catch(() => false)
    if (adopted) {
      /**
       * ★★ 端口被占 —— 先分辨「自家孤儿」还是「外部进程」，再决定 adopt 还是接管。
       *
       * 自家孤儿（上个实例没走优雅 stop 留下的，pidfile 指向存活的自家 pid）：
       * 杀掉它、重起一个**有句柄**的。理由整段在 `KL_PIDFILE_NAME` 与
       * `reclaimOrphan()` 的注释里 —— 一句话：adopt 孤儿会让建图写到死管道
       * （Broken pipe），必须换成自己有句柄的进程。
       *
       * 接管成功后**继续往下走正常 spawn**（不 return）。失败（外部进程 / 陈旧
       * pidfile / 没让出端口）才退回 adopt —— 那时查询仍可用，但建图会被
       * `rebuildGraph` 的硬闸挡住并给明确提示，而不是静默 EPIPE。
       */
      const reclaimed = await this.reclaimOrphan()
      if (!reclaimed) {
        this.options.logger.info("kl-server already listening; adopting", { port: this.port })
        this.adopted = true
        this.setState("ready")
        return true
      }
      // 接管成功：端口已让出，落到下面的正常 spawn。
    }

    // 数据目录必须存在：kl 会在里面开 SQLite / Qdrant。
    mkdirSync(this.dataDir, { recursive: true })
    this.setState("starting")

    try {
      this.stderrTail.length = 0
      // ★ 记下这次带进去的网关指纹：`onGatewayChanged` 靠它判断"跑着的这个
      // kl 用的还是不是当前配置"。必须在 spawn **这一刻**取（env 就是这时定的）。
      this.gatewayPrint = this.gatewayFingerprint()
      const handle = this.options.processes.spawnDuplex({
        executable: python,
        args: ["kl_server.py"],
        env: this.buildEnv(),
        // ★ cwd 必须是 klRoot：kl_server.py 用相对 import（kl_graph 包）。
        cwd: this.options.klRoot,
        /**
         * ★★ kl 的输出**不能全部记 debug** —— 打包态 `logLevel: info`
         * 会把它整段丢掉，而那里面有诊断建图失败**唯一**的线索。
         *
         * ## 三份同事日志证明了这个盲区的代价
         *
         * 有人「建图完成」但 facts=0。根因在上游 `llm_extractor.py`：
         * LLM 调用失败时它 `return [{entities:[], facts:[], _error:…}]`
         * 并把那个空结果**写进磁盘缓存**，于是抽取不抛异常、ingest 报
         * `done "ingest complete"`。再建一次就全部命中缓存 —— 实测 87 秒
         * "建成"一张空图（4365 条消息、零 LLM 调用）。
         *
         * 而失败次数只出现在它 stdout 的 `LLM errors: N` 那一行（`print`），
         * 我们把它记成 debug → **打包态一个字都看不到**。也就是说
         * 同事那台机器上"为什么 facts 是 0"在日志里根本不存在。
         *
         * 所以按行内容分级（`klLogLevelFor`）：错误与关键里程碑进 info/warn，
         * 其余仍是 debug。不无脑全提 info —— kl 的 stdout 很吵
         * （每批抽取都打一行 Progress），全提会淹掉我们自己的日志。
         */
        onLine: (line) => this.logKlLine(line),
        onStderr: (line) => {
          this.stderrTail.push(line)
          if (this.stderrTail.length > 20) this.stderrTail.shift()
          /**
           * ★★ stderr **不能一律 warn** —— 我上一版就是那么写的，理由是
           * "kl 只在真出问题时往 stderr 写"。那个判断是错的：**uvicorn、
           * LiteLLM、kl 自己的 logging 全部走 stderr**（Python logging 的默认
           * StreamHandler 就是 stderr）。实测一次 4 小时的会话：
           *
           * ```
           * 总 10817 条日志
           *   9706  kl-server stderr    ← 90%
           *     ↳ 5394 LiteLLM 日志 / 4108 kl 的 [INFO] / 30 条真警告
           * ```
           * 也就是 30 条有用的被 9676 条噪音埋着，而"日志里有 warn"本该是
           * "这台机器有问题"的第一信号 —— 那个信号被彻底冲淡了。日志文件
           * 4 小时涨到 1.7MB，人根本读不动。
           *
           * 所以走同一个分级函数（`klLogLevelFor`）：它已经能挑出
           * `LLM errors: <非零>` / ERROR / Traceback / litellm.*Error。
           * 剩下的按 debug —— 打包态看不见，但那正是我们想要的。
           *
           * ★ 兜底级别与 stdout 一致（debug）而不是 info：区分 stdout/stderr
           * 在 Python 这边没有信息量（同一个 logger 可能因为配置去任一边），
           * 而"哪些行重要"是**按内容**判的。
           *
           * 真正的启动失败仍然抓得到：`[Errno 48] address already in use`
           * 命中 `ERROR` 那条规则 → warn；而 `stderrTail` 无论级别都在收
           * （崩溃时 `onProcessExit` 把它整段带进 reason）。
           */
          this.logKlLine(line, "stderr")
        },
        // ★ 把 onExit 绑到**这个** handle：超时/stop 后 close() 的 onExit 可能
        // 迟到，而那时 retry() 已经换了新 handle。迟到的旧 onExit 不该误伤新进程。
        onExit: (info) => this.onProcessExit(info, handle),
      })
      this.handle = handle
      this.adopted = false
      // ★ 记下「这个进程是本应用起的」——下个实例据此接管孤儿（见 pidfile 注释）。
      this.writePidfile(handle.pid)
    } catch (error) {
      this.fail(`kl-server 启动失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }

    // warmup 轮询：等 /health ok，或超时/进程退出。
    return this.awaitHealthy()
  }

  private async awaitHealthy(): Promise<boolean> {
    const probe = this.options.probeHealth ?? defaultProbeHealth
    const sleep = this.options.sleep ?? defaultSleep
    const startedAt = this.options.clock.now()
    const deadline = startedAt + WARMUP_TIMEOUT_MS

    while (this.options.clock.now() < deadline) {
      // 进程在 warmup 中途死了：别再空转到超时。
      if (this.handle?.alive !== true) {
        // onProcessExit 已经把 state 置 failed（除非是我们主动 stop）。
        return this.state === "ready"
      }
      let healthy: boolean
      try {
        healthy = await probe(this.port)
      } catch {
        // 连不上是 warmup 常态（server 还没 listen）——继续轮询。
        healthy = false
      }
      if (healthy) {
        /**
         * ★ 成功也要打一行。
         *
         * 原来只有失败路径（超时 / 异常退出 / 复用孤儿）打日志，成功**全静默**
         * —— 于是日志里一条 `KlServer` 都没有时，无法区分"起好了"和"压根没被
         * 调用"。实测代价：kl 明明健康地跑在 8200（`/health` ok），我却按"没起来"
         * 查了一轮启动链路，因为日志里什么都没有。
         *
         * 一次启动一行，不是每轮，所以不会刷屏。
         */
        this.options.logger.info("kl-server ready", {
          port: this.port,
          warmupMs: this.options.clock.now() - startedAt,
        })
        this.setState("ready")
        /**
         * ★ 顺手问一次真实边数（见 `lastKnownEdges`）。
         *
         * 不问的话它只在**建图过程中**才会被填上，于是"启动后没建过图"的
         * 那段时间概览页只能报 0 —— 而那正是用户最可能打开它的时刻
         * （刚启动、想看看图里有什么）。
         *
         * ★ 不 await：ready 这条路不该等一次 HTTP。失败也不管 ——
         * 拿不到就还是 null，判据据此不说话，比说错话好。
         */
        void this.refreshEdgeCount()
        return true
      }
      await sleep(HEALTH_POLL_INTERVAL_MS)
    }

    // 超时：warmup 没在预算内完成。停掉半死的进程，置 failed。
    this.fail(`kl-server warmup 超时（>${Math.round(WARMUP_TIMEOUT_MS / 1000)}s）`)
    await this.killHandle()
    return false
  }

  /**
   * kl 的 stdout 按行分级记录。
   *
   * ## ★★ 为什么不能一律 debug（那是三个真实故障的共同盲区）
   *
   * 打包态 `logLevel: info` 会丢掉全部 debug，而 kl 的 stdout 里有诊断
   * 建图问题**唯一**的线索 —— 尤其 `LLM errors: N` 那一行：上游在 LLM
   * 调用失败时把空结果写进抽取缓存（`llm_extractor.py` 的 `except`），
   * 于是 ingest "成功"但一个 fact 都没有，而失败次数只在这行里。
   *
   * ## 为什么不一律 info
   *
   * kl 的 stdout 很吵：每批抽取都打 `Progress: 12/430 batches`，一次建图
   * 几百行。全提 info 会把我们自己的日志淹掉（而那台机器上的日志是排查
   * 远程问题的全部依据）。
   *
   * 所以只提**两类**：
   * · 错误征兆（`ERROR` / `Traceback` / `LLM errors: <非零>` / `failed`）→ warn
   * · 阶段里程碑（`PHASE` / `Extraction complete` / 统计汇总）→ info
   * 其余保持 debug。
   */
  private logKlLine(line: string, stream: "stdout" | "stderr" = "stdout"): void {
    // 消息名带上来源：查日志时"这行是 stderr"偶尔有用（判断上游怎么配的 logger）。
    const msg = stream === "stderr" ? "kl-server stderr" : "kl-server"
    const level = klLogLevelFor(line)
    if (level === "warn") this.options.logger.warn(msg, { line })
    else if (level === "info") this.options.logger.info(msg, { line })
    else this.options.logger.debug(msg, { line })
  }

  private onProcessExit(
    info: { code: number | null; signal: NodeJS.Signals | null },
    handle: DuplexHandle,
  ): void {
    // 迟到的旧 handle 的 onExit：当前 handle 已经不是它了（retry 换了新的）——忽略。
    if (this.handle !== handle) return
    this.handle = null
    // 我们的进程没了 —— pidfile 指向的东西已不存在，清掉，免得下个实例拿它当自家孤儿。
    this.clearPidfile()
    // 只有从"活着"的状态（starting/ready）意外退出才算崩溃。
    // stopped = 我们主动 stop；failed = 已经失败过（超时那条路径先 fail 再 close），
    // 两者都不该被这里的"退出"覆盖掉原因。
    if (this.state !== "starting" && this.state !== "ready") return
    this.options.logger.warn("kl-server exited unexpectedly", {
      code: info.code,
      signal: info.signal,
      stderr: this.stderrTail.slice(-5).join("\n"),
    })
    this.fail(this.describeExit(info))
  }

  /**
   * 把退出原因说成人话。
   *
   * ## ★★ 为什么不能只取 stderr 的最后一行
   *
   * 那一行往往是 uvicorn 的收尾（`Application startup failed. Exiting.`），
   * 而**真正的原因在更前面**。实测一次飞书 kl 起不来：
   * ```
   * ERROR:    Traceback (most recent call last):
   * Traceback (most recent call last):
   * RuntimeError: Storage folder …/kl/feishu/qdrant_data is already accessed
   *               by another instance of Qdrant client.
   * ERROR:    Application startup failed. Exiting.   ← 只取这行等于什么都没说
   * ```
   * 于是界面上只有「进程退出（code=3）：Application startup failed」，
   * 而真实原因（**目录被另一个 kl 占着**）与修法（清掉那个孤儿进程）
   * 一个字都看不到。
   *
   * ★ Qdrant 锁冲突单独认：它有明确的用户动作，而且在多渠道之后**会更常见**
   * —— 每个渠道一个 kl、各自一个 qdrant 目录，任何一次没走优雅退出
   * （crash / 强杀 / 开发态热重启）都会留下一个占着目录的孤儿。
   */
  private describeExit(info: { code: number | null; signal: string | null }): string {
    const tail = this.stderrTail.join("\n")
    const suffix = `（code=${info.code ?? "?"}, signal=${info.signal ?? "?"}）`

    // ★ 在整段 tail 里找，不是只看最后一行
    if (/already accessed by another instance of Qdrant client/.test(tail)) {
      const dir = /Storage folder (\S+) is already accessed/.exec(tail)?.[1]
      return `图谱存储目录被另一个进程占用${suffix}。多半是上次没退干净留下的 kl 孤儿 —— 结束它之后重试${
        dir === undefined ? "" : `。目录：${dir}`
      }`
    }
    if (/ModuleNotFoundError|ImportError/.test(tail)) {
      return `kl 的 Python 依赖缺失${suffix}。跑一次 \`pnpm setup:kl\` 装依赖后重试`
    }
    if (/Address already in use|EADDRINUSE/.test(tail)) {
      return `端口 ${String(this.port)} 已被占用${suffix}。结束占着它的进程后重试`
    }

    /**
     * 认不出时：找**最后一行看起来像错误的**（`XxxError: …`），
     * 而不是最后一行（那通常是收尾噪音）。
     */
    const errorLine = [...this.stderrTail].reverse().find((line) => /\w+Error/.test(line))
    const detail = errorLine ?? this.stderrTail.at(-1)
    return `kl-server 进程退出${suffix}${detail === undefined ? "" : `：${detail}`}`
  }

  /**
   * 停止 kl-server（app quit / 登出）。
   *
   * 先置 stopped 再关句柄：这样 onExit 回调看到 stopped 就不会误报 failed。
   * close() 内部走 SIGTERM→（3s）SIGKILL，无孤儿。
   *
   * ★ 复用态（`adopted`）下**不杀**：那个进程不是我们的孩子。它可能是用户
   * 自己 `kl start` 起来的，也可能正在给别的 vault 服务 —— 杀掉会打断
   * 他手上的活，而我们唯一想表达的只是"本应用不再用它了"。
   * 状态照常转 stopped（我们确实不用了），句柄本来就是 null。
   */
  async stop(): Promise<void> {
    /**
     * ★ 先立标记再动手：`killHandle` 里的 `await` 期间 `awaitIngest` 的轮询
     * 仍在跑，它必须能看到"这是主动停的"（见 `stopping` 的注释）。
     * 顺序反了就还是会报一次假失败。
     */
    this.stopping = true
    if (this.adopted) {
      this.options.logger.info("kl-server was adopted; leaving it running", { port: this.port })
      this.adopted = false
      this.setState("stopped")
      return
    }
    this.setState("stopped")
    await this.killHandle()
    // 优雅停之后 pidfile 也该消失：留着会让下次启动误判「有个自家孤儿要接管」。
    // （onProcessExit 通常也会清一次；这里补一道，因为 stop 可能先于 onExit 到。）
    this.clearPidfile()
  }

  private async killHandle(): Promise<void> {
    const handle = this.handle
    this.handle = null
    if (handle === null) return
    await handle.close().catch(() => {
      // 关不掉也只能记一笔：进程退出监听会兜底把 handle 清掉。
    })
  }

  /** pidfile 的绝对路径（放在 vault 隔离的 dataDir 下）。 */
  private pidfilePath(): string {
    return join(this.dataDir, KL_PIDFILE_NAME)
  }

  /**
   * 写 pidfile —— 记「这个 pid 是本应用起的 kl-server」。
   *
   * 写失败只记 debug、不影响启动：pidfile 是「下次启动能不能自愈」的优化，
   * 不是本次运行的正确性依赖。读侧（`readPidfile`）对任何异常都当「没有」处理。
   */
  private writePidfile(pid: number | undefined): void {
    if (pid === undefined) return
    const record: KlPidfile = { pid, port: this.port, startedAt: this.options.clock.now() }
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(this.pidfilePath(), JSON.stringify(record))
    } catch (error) {
      this.options.logger.debug("write pidfile failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 清 pidfile（进程没了 / 优雅停）。删不掉无所谓：读侧会再校验 pid 是否存活。 */
  private clearPidfile(): void {
    try {
      rmSync(this.pidfilePath(), { force: true })
    } catch {
      // 删不掉不影响：readPidfile 还会校验 pid 存活 + 端口一致，陈旧文件不会误伤。
    }
  }

  /** 读 pidfile。读不到 / 坏了 / 形状不对 → null（一律当「没有自家记录」）。 */
  private readPidfile(): KlPidfile | null {
    try {
      const raw = readFileSync(this.pidfilePath(), "utf8")
      const parsed = JSON.parse(raw) as Partial<KlPidfile>
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.port === "number" &&
        typeof parsed.startedAt === "number"
      ) {
        return { pid: parsed.pid, port: parsed.port, startedAt: parsed.startedAt }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 端口上那个 server 若是**本应用起的孤儿**，就杀掉它、等它让出端口，返回 true。
   *
   * ## 判据（三者缺一不接管，宁可退回 adopt 也不误杀）
   *
   * 1. pidfile 存在，且 `port` 与当前端口一致 —— 否则可能是别的 vault / 陈旧记录；
   * 2. `process.kill(pid, 0)` 不抛 —— 那个 pid 确实还活着；
   * 3.（调用点已保证）8200 上 `/health` ok —— 端口确实被一个健康 server 占着。
   *
   * pid 复用（系统把旧 pid 分给了无关进程）用条件 1 的 `port` + 调用点的 `/health`
   * 一起兜：一个无关进程既不会恰好写我们的 pidfile、也不会恰好在 8200 上回
   * `{status:ok}`。三者同时成立才动手。
   *
   * ## 为什么要杀而不是继续 adopt
   *
   * adopt 来的孤儿没有句柄、stdio 读端已死，建图一 print 就 Broken pipe
   * （见 `KL_PIDFILE_NAME` 注释）。杀掉重起一个有句柄的，是让建图不再写死管道的
   * 唯一办法。杀之前不需要额外确认 ingest 状态：孤儿的建图本来就在 EPIPE，
   * 不存在「打断一个正在跑的正常建图」。
   *
   * 杀不动 / 到点没让出端口 → 返回 false，调用方退回 adopt（查询仍可用，
   * 建图由 `rebuildGraph` 的硬闸给明确提示）。
   */
  private async reclaimOrphan(): Promise<boolean> {
    const record = this.readPidfile()
    if (record === null || record.port !== this.port) return false

    // pid 还活着吗？signal 0 只做存在性检查，不真的发信号。
    try {
      process.kill(record.pid, 0)
    } catch {
      // 进程早没了（pidfile 陈旧）——不是自家孤儿，清掉这条陈旧记录。
      this.clearPidfile()
      return false
    }

    this.options.logger.info("reclaiming orphaned kl-server", {
      pid: record.pid,
      port: this.port,
    })
    try {
      process.kill(record.pid, "SIGTERM")
    } catch (error) {
      this.options.logger.warn("failed to signal orphaned kl-server", {
        pid: record.pid,
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }

    // 等它让出端口：`probeExisting` 转 false 即释放。上限 3s，超了退回 adopt。
    const probeExisting = this.options.probeExisting ?? defaultProbeHealth
    const sleep = this.options.sleep ?? defaultSleep
    const deadline = this.options.clock.now() + RECLAIM_PORT_RELEASE_TIMEOUT_MS
    while (this.options.clock.now() < deadline) {
      await sleep(RECLAIM_POLL_INTERVAL_MS)
      const stillUp = await probeExisting(this.port).catch(() => false)
      if (!stillUp) {
        this.clearPidfile()
        return true
      }
    }
    this.options.logger.warn("orphaned kl-server did not release port in time; adopting instead", {
      pid: record.pid,
      port: this.port,
    })
    return false
  }

  /**
   * 解析 Python 解释器：KL_PYTHON > klRoot 下的 .venv > 系统 python3。
   *
   * ★ 为什么要探 klRoot/.venv：mycontext 的 dotenv 只灌进它自己的 config，不写
   * process.env，所以 `.env` 里的 KL_PYTHON 到不了这里；而系统 python3 多半没装
   * kl 的依赖（qdrant/litellm/…）→ 一起来就 exit 3。约定：kl 依赖装在
   * `klRoot/.venv`（build venv 就在那），优先用它，省掉 env 布线。
   */
  /**
   * 跑一次 `preparePython`（若注入了）。
   *
   * 三种返回：
   * · 环境对象 —— 准备好了，用它的解释器与激活 env；
   * · `"failed"` —— 注入了但准备失败，`start` 直接放弃并已 `fail()`；
   * · `null` —— 没注入（测试 / 走本机 python 的老路），交给 `resolvePython()`。
   */
  private async preparePythonEnv(): Promise<
    { python: string; env: NodeJS.ProcessEnv } | "failed" | null
  > {
    const prepare = this.options.preparePython
    if (prepare === undefined) return null

    const prepared = await prepare().catch((error: unknown) => {
      this.options.logger.warn("python environment preparation threw", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return null
    })
    if (prepared !== null) return prepared

    this.fail(
      "Python 环境没准备好（内置解释器下载失败或依赖装不上）。" +
        "跑 `pnpm setup:python` 看具体报错 —— 首次需要能出网。",
    )
    return "failed"
  }

  /**
   * 解析 Python 解释器 —— **仅当没有内置环境时的兜底**。
   *
   * 正常路径是 `preparePython()` 给出的 venv 解释器（内置 Python 建的）。
   * 这条兜底留给两种情况：显式 `KL_PYTHON`（想用自己的环境）、
   * 以及测试里不注入 preparePython 的那些用例。
   *
   * ★ 系统 python3 是**最后**一档且很可能不够用：macOS 自带 3.9.6，
   * 而 kl 要求 ≥3.10 —— 走到这一档时 kl-server 多半会 exit 3。
   * 那也正是我们改成内置 Python 的原因。
   */
  private resolvePython(): string | null {
    const explicit = process.env[KL_PYTHON_ENV]
    if (explicit !== undefined && explicit !== "") return explicit
    const venvPython = join(this.options.klRoot, ".venv", "bin", "python")
    if (existsSync(venvPython)) return venvPython
    // 系统 python3：交给 PATH 解析（spawn 找不到会抛，被 start 的 catch 兜住）。
    return "python3"
  }

  /** 组装 kl-server 的环境。KL_DATA_DIR 按 vault 隔离；网关按需注入。 */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    /**
     * ★ 基底用**激活后的**环境（若有），而不是裸 `process.env`。
     *
     * 激活后的那份里 `VIRTUAL_ENV` 指着我们的 venv、`PATH` 前插了它的 bin、
     * `PYTHONHOME`/`PYTHONPATH` 被清掉 —— 于是 kl 子进程里裸 `python`、`kl`
     * 都落在这个 venv 里，跟终端 `source activate` 之后一样。
     *
     * 用裸 process.env 的话，即便我们用绝对路径起了对的解释器，
     * kl 内部再 spawn 出来的 python（它的 scripts/ 里有）仍会命中系统那个。
     */
    const base = this.activatedEnv ?? process.env
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) env[key] = value
    }
    env["KL_DATA_DIR"] = this.dataDir
    env["KL_SERVER_PORT"] = String(this.port)
    // 建图（kl ingest）读四件套导出目录；server 查询用不到，但注入无害且统一。
    if (this.exportDir !== undefined && this.exportDir !== "")
      env["KL_DWS_EXPORT_DIR"] = this.exportDir

    const gw = this.options.gateway?.()
    if (gw !== undefined) {
      // LLM：kl 的 llm_extractor 自己拼 `anthropic/` 前缀，这里传**裸模型名**
      // 与不含 /v1 的 base（见 kl_graph/config.py 的注释）。
      if (gw.llmBaseUrl !== undefined && gw.llmBaseUrl !== "")
        env["KL_LLM_BASE_URL"] = gw.llmBaseUrl
      if (gw.llmModel !== undefined && gw.llmModel !== "") env["KL_LLM_MODEL"] = gw.llmModel
      if (gw.embedBaseUrl !== undefined && gw.embedBaseUrl !== "")
        env["KL_EMBED_BASE_URL"] = gw.embedBaseUrl
      if (gw.embedModel !== undefined && gw.embedModel !== "") env["KL_EMBED_MODEL"] = gw.embedModel
      // 出网密钥：embedding 走 KL_EMBED_API_KEY；LLM 侧从 ANTHROPIC_AUTH_TOKEN 读
      // （kl 的调用点如此约定），后者本就在 process.env 里，不用再塞。
      if (gw.apiKey !== undefined && gw.apiKey !== "") env["KL_EMBED_API_KEY"] = gw.apiKey
      // ★ 维度必须与网关实际返回一致，否则 Qdrant 集合维度对不上会崩（见字段注释）。
      if (gw.embeddingDim !== undefined) env["KL_EMBEDDING_DIM"] = String(gw.embeddingDim)
      if (gw.sendDimensions === true) env["KL_EMBED_SEND_DIMENSIONS"] = "1"
    }
    return env
  }

  private hasGatewayEgress(): boolean {
    const gw = this.options.gateway?.()
    if (gw === undefined) return false
    return (
      (gw.llmBaseUrl !== undefined && gw.llmBaseUrl !== "") ||
      (gw.embedBaseUrl !== undefined && gw.embedBaseUrl !== "")
    )
  }

  /**
   * 问一次 kl `/status`，把 backend-aware 的真实边数记下来。
   *
   * ★ 公开（而不是私有）是为了让测试走**这条真实的路** —— 生产里它由
   * `ready` 那一步调（`void this.refreshEdgeCount()`）。测试注入 `readStatus`
   * 再显式 await 它，等价于"server 起好了、问过一次 /status"，
   * 而不是绕过接线直接塞一个字段值（那会让接线本身无人验证）。
   *
   * ★ 整段**吞异常**：这是一个纯诊断数字，它拿不到不该影响任何流程。
   * 拿不到就保持 null —— `describeGraphStage` 收到 `undefined` 时闭嘴，
   * 那比报一个恒 0 的假数字好（见 `lastKnownEdges` 的注释）。
   */
  /**
   * 问 kl「这个实体参与了哪些 fact」→ fact id 集合。
   *
   * ## ★★★ 为什么这条必须走 HTTP 而不是读 SQLite
   *
   * `ABOUT` 边（fact↔entity）在默认后端（ladybug）下**不在 SQLite 里** ——
   * 上游 `storage/base.py` 明写那张 `edges` 表是空的，而
   * `KL_GRAPH_BACKEND` 默认就是 `ladybug`。实测 `SELECT COUNT(*) FROM edges`
   * → 0，而 `/status` 同时报 `edges: 26558`。
   *
   * ego 图（「它认识的人与事」）靠这些边推导共现，所以它一直是空的 ——
   * 而界面把这说成"还没抽到关联"。完整推理见
   * `GraphQueryOptions.factsOfEntity`。
   *
   * ## 为什么用 `/facts`
   *
   * `/entity` 也给 `ABOUT` 边，但上游硬编码 `edges_out[:5]` 截断到 5 条；
   * `/expand` 只给 `ENTITY_SIMILAR`。`/facts` 的 `limit` 是入参，可放大。
   * 实测 `limit=500` 时一次 1.2ms，618 个实体全问一遍 0.72s。
   *
   * ★ **没就绪时抛**而不是返回空集：空集会被上游读成"这个人没有任何关联"，
   * 那正是本项目最贵的那类谎（把"读不到"记成"没有"）。抛出去之后
   * `graph-query` 那侧的 catch 会给"图谱服务还没起来"这句真话。
   */
  async factsOfEntity(entityId: string, limit = 500): Promise<ReadonlySet<string>> {
    /**
     * ★★★ **等它起来**，而不是"没就绪就报错"。
     *
     * ## 这一行是"面板一直空"的真正修法
     *
     * kl 是懒启动的：挂载时 `void klServer.ensureReady()` 是 fire-and-forget，
     * 实测 warmup 约 10s（`kl-server ready {warmupMs: 10815}`）。而界面在
     * 那之前就查了 ego 图 —— 于是第一次必然失败。
     *
     * 更要紧的是**那一次失败不会被重试**：渲染层的
     * `refetchInterval: building ? 5_000 : false`（`useKlGraphEgo`）只在
     * 建图时轮询，平时是 `false`。所以启动后那一次失败的结果被缓存住，
     * 面板就一直空着 —— 而图里其实有 26558 条边。
     *
     * 实测两个状态的差别（同一份数据、同一段代码）：
     *
     * ```
     * kl 没在跑 → reason='读图谱失败：fetch failed'，nodes 0    ← 面板空
     * kl 在跑   → available=true，nodes 25 / edges 64          ← 面板有内容
     * ```
     *
     * ★ `ensureReady()` 是幂等且带 in-flight 合流的（并发调用等同一个
     * Promise），所以 ego 图那 600 多次调用只会触发一次启动。
     *
     * ★ 仍然会抛：`ensureReady` 返回 false 是**真的起不来**（缺 Python /
     * 端口被占 / failed 态不自动重起）。那时抛出去让上层给一句
     * "服务还没起来"，比静默返回空集好 —— 后者会被读成"这个人没有关联"。
     */
    if (!(await this.ensureReady())) {
      /**
       * ★ 用裸 `Error` 而不是 `AppError`：`ErrorCode` 是封闭联合，
       * 而这条只被 `graph-query` 内部 catch 掉换成一句降级文案，
       * 从不过 IPC 给渲染层 —— 为它加一个全局错误码是过度设计。
       */
      throw new Error("图谱服务还没就绪，关系数据暂时读不到")
    }
    const response = await fetch(`http://127.0.0.1:${this.port}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_id: entityId, limit }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`读关系失败：HTTP ${response.status}`)
    }
    const body = (await response.json()) as { facts?: Array<{ id?: string }> }
    const out = new Set<string>()
    for (const fact of body.facts ?? []) {
      if (typeof fact.id === "string" && fact.id !== "") out.add(fact.id)
    }
    return out
  }

  async refreshEdgeCount(): Promise<void> {
    try {
      const readStatus = this.options.readStatus ?? defaultReadStatus
      const snapshot = await readStatus(this.port)
      if (snapshot !== null) this.lastKnownEdges = snapshot.counts.edges
    } catch (error) {
      this.options.logger.debug("read edge count failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private fail(reason: string): void {
    this.reason = reason
    this.state = "failed"
    this.pushStatus()
  }

  private setState(next: Exclude<KlState, "failed">): void {
    // 非 failed 态没有 reason（failed 走 fail()，那里单独设 reason）。
    this.reason = null
    this.state = next
    this.pushStatus()
  }

  /** 记下这一轮的产出并原样返回（只在成功路径调，见字段注释）。 */
  private rememberVolume(
    volume: NonNullable<KlGraphBuildResult["volume"]>,
  ): NonNullable<KlGraphBuildResult["volume"]> {
    this.lastBuildVolume = volume
    return volume
  }

  /** 翻建图标志并推状态（建图与服务状态是两个维度，各自推）。 */
  private setBuilding(next: boolean): void {
    this.building = next
    this.pushStatus()
  }

  private pushStatus(): void {
    const window = this.options.getWindow()
    if (window === null || window.isDestroyed()) return
    /**
     * ★★ 推的是**多渠道合并后**的状态，不是 `this.status()`。
     *
     * ## 这一条修的是"界面每次刷新都退化"
     *
     * `this.status()` 是**这一个** kl 自己的状态 —— 它没有 `perChannel` 字段
     * （那是 `MultiKlServerService` 合并出来的）。而渲染层是
     * "首帧查询一次 + 之后全靠 `onStatus` 推送"：
     *
     * · 首帧 `serverStatus()` → 走多渠道门面 → `perChannel` 有两条（对的）；
     * · 之后任何一次状态变化推来的都**没有** `perChannel` → 覆盖掉首帧那份。
     *
     * 于是界面在第一次状态变化后就退化，并落进渲染层的"缺 perChannel"回落分支
     * ——实测表现是一张「飞书 · 就绪 · 8200」的卡（标签是飞书、数据是主渠道的），
     * 而 8200 是主渠道的端口。用户报了这个，我前几轮一直在渲染层找原因，
     * 而根因在**推送源**：查询与推送走的是两个不同的对象。
     *
     * ★ 用回调注入而不是让这个类持有门面：门面**包着**它（`MultiKlServerService`
     * 的构造参数就是这个实例），直接引用会成环。
     *
     * ★ 没给回调时回落到 `this.status()` —— 单渠道装配（以及这个类的单测）
     * 不需要知道门面的存在。
     */
    window.webContents.send(
      IPC_EVENTS.klServerStatus,
      this.options.mergedStatus?.() ?? this.status(),
    )
  }
}

/**
 * kl 某一行 stdout 该记成什么级别。
 *
 * ★ 纯函数且**导出** —— 判据是一堆字符串匹配，而"哪些行必须在打包态可见"
 * 正是这次三份同事日志暴露的问题（见 `logKlLine`）。规则写错与规则生效
 * **外观完全相同**（都是日志里没那行），不测就等于没写。
 */
/**
 * 图谱处于哪个半成品阶段 → 给用户的一句话。`null` = 没问题，不必说。
 *
 * ★ **导出且是纯函数**：判据是一串 if-else，而"说错话"与"说对话"在界面上
 * 长得一样（都是一行黄字）。不测就等于没写 —— 实测已经栽过一次：
 * 原来 `edges === 0` 那一档没看 facts，于是 `facts=0` 时界面说
 * 「实体与事实已就绪」，而那是假话。
 *
 * ★ 提出来而不是留在 `graphOverview()` 里，也是为了让测试不必开一个真 kl 库
 * （那要 better-sqlite3 + 一个建好的图文件，而本项目为原生模块 ABI 反复踩过坑）。
 */
/**
 * 算这一轮建图的**产出** = 建完 − 建前，再拼上处理量。
 *
 * ## ★★ 为什么提成导出的纯函数
 *
 * 反证时发现：把差值那三行改成直接用绝对值（= 修复前的信息量），
 * 全仓 976 条测试**一条都不红** —— 而那正是这次要修的东西
 * （增量建图下总数几乎不变，只报绝对值等于每轮都说"没动"）。
 *
 * 与 `buildAutoBuildSnapshot` / `buildForecastInput` 同一款做法：
 * 算术留在方法里就只能靠端到端撞上，提出来才锁得住。
 *
 * ★ 允许负数：`fresh` 重建先清空、或上游合并了重复实体，都会让某项减少。
 * 夹到 0 会把"合并生效了"显示成"没变化"。
 */
export function computeBuildVolume(
  before: { entities: number; facts: number; edges: number },
  after: { entities: number; facts: number; edges: number },
  work: KlIngestSnapshot["volume"],
): NonNullable<KlGraphBuildResult["volume"]> {
  return {
    entities: after.entities - before.entities,
    facts: after.facts - before.facts,
    edges: after.edges - before.edges,
    ...work,
  }
}

export function describeGraphStage(input: {
  entities: number
  facts: number
  /**
   * 关系边数。**`undefined` = 数不出来**（而不是 0）——
   * 见下面那一档：SQLite 的 `edges` 表在 ladybug 后端下设计上就是空的。
   */
  edges: number | undefined
}): string | null {
  const { entities, facts, edges } = input
  /**
   * ## ★★ `facts` 必须**单独判**，不能挂在 `entities` 上
   *
   * `entities>0 && facts===0` 不是罕见组合，而是一个**确定会出现**的状态：
   * 两者来自建图的不同阶段（实体一部分在 Phase A 就能落，事实要 Phase B
   * 的 LLM 抽取），所以"Phase A 成功、Phase B 挂了"稳定产出它。
   * 实测那次 Phase B 是被网关打挂的（`Error 524: A timeout occurred`，
   * 整批 `Batch LLM error … transient`）。
   *
   * ★ 文案指向**那一步**而不是"再等等"：抽取失败要么重试要么换网关，
   * 而"最后一步"这种说法会让用户什么都不做。
   */
  if (entities === 0 && facts === 0) {
    return "图是空的 —— 建图没有成功跑过（点「重新建图」，注意它会出网）"
  }
  if (facts === 0) {
    return "实体已建好，但事实一条都没抽出来 —— Phase B 的 LLM 抽取没成功（多为网关超时/限流，可重试或换网关）"
  }
  if (entities === 0) return "实体还没建好（抽取已完成，建图阶段未完成）"
  /**
   * ## ★★★ `edges === 0` **不能**当成"关系边还没建"
   *
   * 这一档原来无条件报「实体与事实已就绪，关系边还没建（建图的最后一步）」，
   * 而实测下来它在一个**完全建好**的图上永远为真：
   *
   * ```
   * GET /status → {"graph_backend":"ladybug","sqlite":{"entities":359,
   *                "facts":454,"edges":26558}}          ← 真实边数
   * SELECT COUNT(*) FROM edges  → 0                      ← 我们读的那张表
   * ```
   *
   * 原因不是没建成，是**边搬家了**。上游 `storage/base.py` 的
   * `scan_edges_by_type` 注释明写：「on the ladybug backend edges live in
   * LadybugDB and the SQLite `edges` table is empty」——
   * 而 `config.default.yaml` 里 `KL_GRAPH_BACKEND` 的默认值正是 `ladybug`。
   * kl 自己的 `/status` 用 `state.store.count_edges()`（按后端分派），
   * 所以它数得对；我们直连 SQLite 数的是一张**按设计永远空**的表。
   *
   * 那条假警告的代价：图明明有 26558 条边、可以正常检索，界面却一直说
   * "还差最后一步"。用户据此反复点「重新建图」—— 而每次重建都从零开始，
   * 于是"最后一步"永远不会完成。这与那条 1.7 GB 事故同一个形状：
   * **判据读错了源，而错的结论看起来完全合理**。
   *
   * ★ 所以判据改成 `undefined`（数不出来就别说话），而 0 与正数都不报警：
   * 在 ladybug 下 0 是正常值，没有任何信息量。真要发现"边没建成"，
   * 得走 `/status` 那条 backend-aware 的路 —— 那是 `graphOverview` 的事。
   */
  void edges
  return null
}

export function klLogLevelFor(line: string): "warn" | "info" | "debug" {
  /**
   * ★★ 先把**纯噪音**降级 —— 它必须排在所有 warn 规则之前。
   *
   * 实测（用户日志 2026-08-09）：一次建图里
   * `LiteLLM.Info: If you need to debug this error, use litellm._turn_on_debug()`
   * 刷了**几十行连续 WARN**，而它一个字的信息量都没有 —— 它只是 litellm 在
   * 每次调用失败后追加的一句固定提示。
   *
   * 它被提成 warn 是因为句中带 "error"，命中了下面那条宽松规则。后果不是
   * "日志有点吵"，而是**真正的那行被埋掉**：同一批日志里
   * `[ERROR] Batch LLM error … Error 524: A timeout occurred` 才是原因，
   * 而它夹在几十条无用 WARN 中间，肉眼扫过去只看到一片黄。
   *
   * ★ 判据钉在 `LiteLLM.Info:` 这个前缀上而不是整句：上游的措辞会变，
   * 而"以 LiteLLM.Info 开头的是提示不是错误"这一点是稳定的。
   * （`LiteLLM.Error:` 之类**不**在此列 —— 那是真错误，照旧走下面的规则。）
   */
  if (/LiteLLM\.Info\b/.test(line)) return "debug"

  /**
   * ★★ `LLM errors: N` —— 这一行是"建图成功但 facts=0"的**唯一**线索。
   *
   * 上游把 LLM 失败缓存成空结果，所以抽取不抛异常、ingest 报 done。
   * 只有这个计数能说明"其实全失败了"。`0` 要排除掉（正常情况每次都打）。
   */
  if (/LLM errors:\s*(?!0\b)\d+/.test(line)) return "warn"

  // Python 与 litellm 的错误征兆。`Traceback` 单独列：它的下一行才是原因，
  // 但那些行不带关键词 —— 至少要让人知道"这里炸过"，然后去开 debug 重跑。
  if (/\b(ERROR|CRITICAL|Traceback|Exception|litellm\.\w*Error)\b/.test(line)) return "warn"
  // "failed"/"error" 出现在句中（kl 用小写打了不少这类）。
  if (/\b(failed|error)\b/i.test(line) && !/0 error/i.test(line)) return "warn"

  /**
   * 里程碑：一次建图各打一行，不刷屏，而它们回答"跑到哪了"。
   * `PHASE B.1: LLM EXTRACTION` / `Extraction complete in 812.3s` /
   * `kl-server ready` / `Hot-swap done` / `Background ingest complete`。
   */
  if (
    /\b(PHASE|Extraction complete|Hot-swap|ingest complete|kl-server (starting|ready))\b/i.test(
      line,
    )
  )
    return "info"
  // 抽取统计汇总（`Total messages processed` / `Cache hits` / `LLM calls made`）——
  // 一次建图各一行，而它们合起来能判断"这次到底调没调 LLM"。
  if (
    /\b(Total messages processed|Cache hits|LLM calls made|Chunks needing extraction)\b/.test(line)
  )
    return "info"

  // 其余（每批一行的 Progress、逐条 loading）保持 debug。
  return "debug"
}

/** 默认健康探测：`GET /health` 且 body.status === "ok"。 */
async function defaultProbeHealth(port: number): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(3_000),
  })
  if (!response.ok) return false
  const body = (await response.json()) as { status?: string }
  return body.status === "ok"
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `POST /ingest`：让**跑着的 server** 开始建图（Phase A → Phase B）。
 *
 * 只回状态码：body 里除了 "started" 没有我们用得上的东西（进度要问 `/status`）。
 * 409 = 已有一个在跑，调用方据此改为"跟随那一个"。
 *
 * ## ★★ 字段名必须与上游的 `IngestRequest` 完全一致
 *
 * 实测（2026-08-09）上游把请求体换成了：
 *
 * ```py
 * class IngestRequest(BaseModel):
 *     model_config = ConfigDict(extra="forbid")   # ← 多一个字段就 422
 *     input_dir: str                              # ← 原来我们发的是 export_dir
 *     source_id: str = Field(min_length=1)        # ← 新增，必填
 * ```
 *
 * 而我们一直发 `{export_dir}`，于是**三条校验一起挂**（实测 curl 复现）：
 * `input_dir` missing + `source_id` missing + `export_dir` extra_forbidden
 * → `HTTP 422`。
 *
 * ★ 表现是 `graph build failed {reason:"建图启动失败：HTTP 422"}` 每轮重复，
 * 而**采集、导出、蒸馏全都正常** —— 也就是"只有图谱不长"，
 * 而 422 这个码本身完全不提示是哪个字段。所以这段注释把三个字段名钉在这里：
 * 上游再改一次时，比对点在这儿。
 *
 * ★ `source_id` 传渠道 id（`"dingtalk"`）而不是 vaultId：上游用它给 chunk 加
 * 命名空间前缀（`_namespace_chunk_ids`），也用它当 unit 去重的 scope。
 * 同一个 vault 里将来可能有多个渠道的语料，那时按渠道分开才是对的；
 * 而 vault 已经由 `KL_DATA_DIR` 隔离了，再拿它当 source_id 是把同一维度分两层。
 */
/**
 * 组装 `/ingest` 的请求体。**提成纯函数是为了能测**。
 *
 * 原来 body 直接内联在 `fetch` 调用里，于是唯一能验证它的方式是起一个真
 * server —— 而测试里的 fake 只看形参（`(port, dir) => 200`），
 * 字段名换了、少了必填项都一声不响。那正是 422 那个 bug 能上线的原因。
 *
 * ## ★★ 请求体的形状由上游 kl 定，且它 `extra="forbid"`
 *
 * `IngestRequest`（`kl_server.py`）要 `input_dir` + `source_id`，且
 * `model_config = ConfigDict(extra="forbid")` —— **多一个字段也 422**。
 *
 * 改动前发的是 `{ export_dir }`：字段名错、必填的 `source_id` 缺、
 * 且那个多出来的键本身就会被 forbid 拒掉。三重不匹配，实测日志：
 * `POST /ingest HTTP/1.1" 422 Unprocessable Entity`
 * → `graph build failed {"reason":"建图启动失败：HTTP 422"}`，也就是
 * **每次建图立刻失败**。
 *
 * ## ★★ `source_id` 必须按渠道给，且跨轮次稳定
 *
 * 它不是一个标签：kl 用它算**断点续传的 checkpoint 路径**
 * （`checkpoint_path(source_id)`，非字母数字会被替成 `_`）。
 * 两个渠道共用一个值 → 互相覆盖对方的续传进度，表现是"增量建图每次都从头
 * 扫"或"某渠道的新导出被当成已处理过"。所以用 channelId：每渠道一个、
 * 且重启后不变。
 */
export function buildIngestRequestBody(
  exportDir: string,
  sourceId: string,
): Record<string, unknown> {
  return { input_dir: exportDir, source_id: sourceId }
}

async function defaultPostIngest(
  port: number,
  exportDir: string,
  sourceId: string,
): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    /**
     * `input_dir` 显式给：server 侧默认读它自己的 `KL_DWS_EXPORT_DIR`，
     * 而我们的导出目录按 vault + 渠道定 —— 让它跟着我们走，别各有一份真源。
     *
     * ★ 只发这两个键。`concurrency` / `improve_mode` 有服务端默认值，
     * 而 forbid 意味着"发一个它不认识的就整个请求失败"—— 能不发就不发。
     */
    body: JSON.stringify(buildIngestRequestBody(exportDir, sourceId)),
    // 启动是非阻塞的，10s 足够；真正的等待在 /status 轮询里。
    signal: AbortSignal.timeout(10_000),
  })
  return response.status
}

/**
 * 读 `/status` 的 ingest 段 + 图规模。
 *
 * ★ 图规模取 `sqlite`（entities/facts/edges）而不是解析 stdout 的计数行：
 * 那些行只在 ingest 进程的输出里，而现在 ingest 跑在 server 内 ——
 * 它的 stdout 是 server 的日志流，我们不该去解析它（格式一变就静默归零）。
 */
async function defaultReadStatus(port: number): Promise<KlIngestSnapshot | null> {
  const response = await fetch(`http://127.0.0.1:${port}/status`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) return null
  const body = (await response.json()) as {
    ingest?: {
      state?: string
      phase?: string
      percent?: number
      error?: string
      units_discovered?: number
      units_skipped?: number
      units_processed?: number
      chunks_created?: number
    }
    sqlite?: { entities?: number; facts?: number; edges?: number }
  }
  const ingest = body.ingest ?? {}
  const sqlite = body.sqlite ?? {}
  const state = ingest.state
  return {
    state:
      state === "running" || state === "done" || state === "error" || state === "idle"
        ? state
        : "idle",
    phase: ingest.phase ?? "",
    percent: ingest.percent ?? 0,
    error: ingest.error ?? "",
    counts: {
      entities: sqlite.entities ?? 0,
      facts: sqlite.facts ?? 0,
      edges: sqlite.edges ?? 0,
    },
    /**
     * ★ 上游是 snake_case（`units_discovered`），这里转成我们的 camelCase。
     * 字段名照抄上游的语义，不改口径 —— 改了就没法与 kl 的日志对照。
     */
    volume: {
      unitsDiscovered: ingest.units_discovered ?? 0,
      unitsSkipped: ingest.units_skipped ?? 0,
      unitsProcessed: ingest.units_processed ?? 0,
      chunksCreated: ingest.chunks_created ?? 0,
    },
  }
}

/**
 * 默认的图谱库读取：`better-sqlite3` 只读连接。
 *
 * ★ 表名/列名是**写死的字面量**，不接受调用方拼串 —— 参数化查询无法
 * 参数化标识符，所以那条路只能靠字面量来保证没有注入面。
 * `count`/`groupBy` 收到未知表名时直接抛（由调用方吞成 0/[]）。
 */
function defaultOpenGraphDb(path: string): GraphDbHandle {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  const COUNTABLE: Record<string, string> = {
    entities: "SELECT COUNT(*) AS c FROM entities",
    facts: "SELECT COUNT(*) AS c FROM facts",
    edges: "SELECT COUNT(*) AS c FROM edges",
    chunks: "SELECT COUNT(*) AS c FROM chunks",
    messages: "SELECT COUNT(*) AS c FROM messages",
  }
  const GROUPABLE: Record<string, string> = {
    "entities.entity_type": `SELECT entity_type AS type, COUNT(*) AS count FROM entities
                               GROUP BY entity_type ORDER BY count DESC LIMIT 12`,
    "facts.fact_type": `SELECT fact_type AS type, COUNT(*) AS count FROM facts
                          GROUP BY fact_type ORDER BY count DESC LIMIT 12`,
  }
  return {
    count: (table) => {
      const sql = COUNTABLE[table]
      if (sql === undefined) throw new Error(`未知的表：${table}`)
      return (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0
    },
    groupBy: (table, column) => {
      const sql = GROUPABLE[`${table}.${column}`]
      if (sql === undefined) throw new Error(`未知的分组：${table}.${column}`)
      const rows = db.prepare(sql).all() as Array<{ type: string | null; count: number }>
      return rows.map((r) => ({ type: r.type ?? "Unknown", count: r.count }))
    },
    topEntities: (limit) => {
      const rows = db
        .prepare(
          `SELECT name, entity_type AS type, mention_count AS mentions
             FROM entities ORDER BY mention_count DESC LIMIT ?`,
        )
        .all(limit) as Array<{ name: string; type: string | null; mentions: number }>
      return rows.map((r) => ({ name: r.name, type: r.type ?? "Unknown", mentions: r.mentions }))
    },
    recentFacts: (limit) => {
      const rows = db
        .prepare(
          `SELECT text, fact_type AS type, confidence, timestamp AS at
             FROM facts ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(limit) as Array<{
        text: string
        type: string | null
        confidence: number | null
        at: number | null
      }>
      return rows.map((r) => ({
        text: r.text,
        type: r.type ?? "GENERAL",
        confidence: r.confidence ?? 0,
        at: r.at ?? null,
      }))
    },
    close: () => db.close(),
  }
}

/** 让 klRoot 下的 vault 数据目录约定成一处（供 startup 拼路径）。 */
export function klDataDirFor(sharedRoot: string): string {
  return join(sharedRoot, "kl")
}
