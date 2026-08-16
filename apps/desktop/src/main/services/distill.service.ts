/**
 * DistillService —— 蒸馏的**宿主**：定时器 + 进度上报 + 用户可中断。
 *
 * ## ★ 现在跑的是 forge，不是 LLM 抽取
 *
 * 画像整体由 `ForgeService`（纯 stdlib Python、零模型调用、确定性测量）产出。
 * 曾经这里先用 `DistillRunner` 把语料喂给模型抽 5 个 facet，再把结论渲染成
 * agent 读的 md —— 那条路**已经摘掉**：
 *
 * · `profile_facets` 不再有任何读者（persona 的 workspace 只装 forge 的产物）；
 * · 而它每个任务是一次几十秒、上万 token 的模型调用。
 *
 * 产出没人读、成本照付，是比"功能缺失"更坏的状态：它不报错，只是每次蒸馏都
 * 悄悄花钱。所以 LLM 那半**默认不跑**（`llmFacets: false`），代码留在
 * `packages/distill/` 里 —— forge 不测 `identity`/`expertise` 这类语义维度，
 * 将来若要把它们作为补充接回来，接的是同一份 runner。
 *
 * ## 为什么 runner 与宿主分开
 *
 * `DistillRunner` 是纯逻辑（切窗 / 跑一个任务 / 合并落库），可以单独测。
 * 而"什么时候跑、跑几个、怎么告诉 UI"是宿主策略 —— 它依赖定时器、
 * BrowserWindow、以及用户点了什么。混在一起会让 runner 没法测。
 *
 * ## ★ 一轮只跑少量任务
 *
 * 一个任务是一次 LLM 调用（实测 tone 那类 60-90 秒）。一轮跑光所有任务
 * 会让"停止"按钮在几十分钟内没有反应。每轮跑 2 个 + 间隔 5 秒，
 * 于是用户点停之后最多等一个任务的时间。
 *
 * ## ★ 进度必须**推**给 UI，不是让 UI 轮询
 *
 * 蒸馏是分钟级的过程。轮询要么太频（浪费）要么太疏（看起来卡住）。
 * 推送让"刚跑完一个任务"立刻可见 —— 那是用户判断"它还在动"的唯一依据。
 */
import { randomUUID } from "node:crypto"
import type { BrowserWindow } from "electron"
import type { Clock, Logger } from "@mycontext/kernel"
import { AppError } from "@mycontext/kernel"
import type { LlmProvider } from "@mycontext/llm"
import {
  ALL_FACETS,
  DistillRunner,
  decideWorkRefresh,
  inducePlaybooks,
  readPlaybookChunks,
  renderWorkLayer,
  type WorkPlaybookSection,
} from "@mycontext/distill"
import {
  ChangelogRepository,
  ConsumerCursorRepository,
  DistillSourceRepository,
  DistillTaskRepository,
  ProfileFacetRepository,
  SelfIdentityRepository,
  readCollectionScope,
  type SqliteDatabase,
} from "@mycontext/store"
import { IPC_EVENTS, type DistillProgressView } from "@mycontext/ipc-contract"

/** 每轮跑几个任务。小批是为了让"停止"有响应，不是为了限流。 */
const TASKS_PER_ROUND = 2
/** 自动重蒸的缺省周期。见 `DistillServiceOptions.autoIntervalMs`。 */
const AUTO_INTERVAL_MS = 6 * 60 * 60_000

/**
 * work 层的游标 id。
 *
 * 复用 `consumer_cursors`（v3 就有那张表）而不是加一列/加一张表：`ack()` 恰好
 * 同时写 `acked_seq` 与 `last_success_at`，而"抽到哪"与"什么时候抽的"正是
 * 攒批判据要的两个值。零迁移，而且状态页那套 lag/stale 自动能看到它。
 *
 * ★ 不能兼用 `DISTILL_CONSUMER_ID`：那个游标的语义是"**入队**到哪"
 * （消费 changelog 建任务），而这个是"**抽完**到哪"。合并的话"任务已建"
 * 会被记成"结论已抽"—— 那是一个静默的谎，与 `graph-export` / `graph-build`
 * 分成两个游标是同一个理由。
 *
 * ★ 导出它是因为 `DataPlaneService` 要用它当 `runCycle` 的 runnable 键，
 * 而那个键必须与 `CONSUMERS` 里那一行、与游标表里那一行**逐字相同**
 * （写错的表现是状态页多一行 absent、少一行真实进度，且不报错）。
 * 复制一个字面量过去就是给自己一次拼错的机会。
 */
export const WORK_CONSUMER_ID = "distill-work"

/**
 * 一轮 work 层最多跑几批，防止判据出错时无限跑下去。
 *
 * 每批 `TASKS_PER_ROUND` 个任务，所以上限是 40 个任务 —— 远超正常一轮
 * （四个 facet × 窗口数）。到顶时剩下的任务留给下一轮，游标不推进，
 * 所以不会丢语料，只是慢一轮。
 */
const WORK_MAX_ROUNDS = 20

/**
 * work 层的切窗宽度（天）。
 *
 * ## ★★ 为什么是 30 而不是沿用 runner 缺省的 7
 *
 * 任务数 = 窗口数 × facet 数，而每个任务是一次上万 token 的调用。
 * 实测 3 个月语料 + 7 天窗切出 **135 个任务**，一轮约 **80 万 token /
 * 100 分钟**；30 天窗是约 25 个 —— 成本降到六分之一。
 *
 * 而窄窗买到的东西这一层**用不上**：窄窗的收益是时间分辨率（"他六月起
 * 不管这类事了"），而 work 层抽的是长期结论（职责、流程、规矩）——
 * 那些不按周变。需要时间分辨率的是 forge 的衰减与近窗对比，**而那一层免费**。
 *
 * ★ 宽窗的代价是单个任务喂进去的消息更多（上限仍是
 * `MAX_MESSAGES_PER_TASK`，超了取最近的），也就是一个窗里较早的消息
 * 可能进不了 prompt。对"长期结论"这是可接受的：同一条规矩会在多个窗里
 * 反复出现，而 `mergeFacet` 按证据合并。
 */
const WORK_WINDOW_DAYS = 30

/**
 * 建图在跑时，work 层先短等多久再重判（见 `maybeRefreshWorkLayer` 里那段）。
 *
 * ## ★ 20 秒这个数是**量出来的**，不是拍的
 *
 * 它要能区分两件事：
 * · **注定失败的建图** —— 实测 `graph build started` → `failed` 间隔
 *   14 秒（16:06:22 → 16:06:36），上游类型 bug 那一类；
 * · **真在长跑的建图** —— Phase A 实测 60+ 分钟。
 *
 * 20 秒比 14 秒宽一点（留网关抖动的余量），又远小于真实长任务的量级，
 * 所以"等完还在跑"基本等价于"这是个长任务"。
 *
 * ★ 不要把它调大到分钟级：那会让每一轮 work 层刷新都先干等几分钟，
 * 而攒批判据下一轮照样成立 —— 等待本身不产出任何东西。
 */
const GRAPH_SETTLE_WAIT_MS = 20_000

/**
 * playbook 归纳最多从图里取多少个 chunk 当候选。
 *
 * 只是**取数**的上限（真正送进模型的由 `PLAYBOOK_BATCH_SIZE ×
 * PLAYBOOK_MAX_BATCHES` 定），所以给得宽一些：候选池越大，
 * 按流程密度排序时挑到的越像流程。实测本机 2149 个 message chunk 里
 * 1700 个本人有发言、803 个带流程痕迹。
 */
const PLAYBOOK_CANDIDATE_LIMIT = 3000

/**
 * 第三方商标与工具名 —— 结论正文里不许出现（脱敏名单的一部分）。
 *
 * ## ★ 为什么必须在这里拦，而不只靠 prompt
 *
 * 实测第二轮（脱敏 prompt 已生效）跑出的 `role` 结论里仍然出现了
 * `check:trademarks` 明确拦的那个商标 —— 模型认为"他用什么工具开发"是
 * 职能的一部分，那个判断本身不算错，只是它不知道这个仓库有商标门禁。
 *
 * 而后果比人名更直接：`work.md` 若被导出并进仓库，`check:trademarks`
 * 会红；不进仓库则是把第三方商标写进了分发物。两者都要避免。
 *
 * ## ★ 按片段拼装，与 `scripts/check-trademarks.mjs` 同一个手法
 *
 * 否则**这个文件自己**会命中那道门禁（那个脚本扫全仓库）。
 * 两处各存一份不理想，但共享一个常量意味着让门禁脚本 import 应用代码
 * （它是独立的 node 脚本，跑在构建前）—— 那个耦合更糟。
 * `tests/unit/distill/work-brand-terms.test.ts` 断言两份一致。
 */
const FORBIDDEN_BRAND_TERMS: readonly string[] = ["q" + "oder", "q" + "wenwork", "q" + "wen-work"]

/**
 * forge 的阶段名。
 *
 * 与 `ForgeService` 的 `ForgeStep` 同一组值，但**不 import 那个模块** ——
 * 这一层只经 `runForge` 回调与它打交道（路径按 vault 变，见 `attach`），
 * 直接 import 会把装配顺序反过来。三个值都在 IPC 契约里（`forgeStatus.step`）。
 */
export type ForgeStepName = "pull" | "build" | "publish"

/** forge 的运行态（内存）。见 `DistillService.forge` 的注释。 */
interface ForgeRuntimeState {
  running: boolean
  /**
   * 正在跑的阶段。`null` = 没在跑（或还没进第一个阶段）。
   *
   * ★ 这个字段在 IPC 契约里早就声明了，但主进程一直写死 `null`
   * ——于是界面只能显示一句"正在蒸馏…"干等几分钟。
   * 现在由 `ForgeService.run` 的 `onStep` 回调填真值。
   */
  step: "pull" | "build" | "publish" | null
  lastRunAt: number | null
  lastOk: boolean | null
  failedStep: "pull" | "build" | "publish" | null
  reason: string | null
  messages: number
  turns: number
  asks: number
  files: number
  grade: string | null
}

const IDLE_FORGE: ForgeRuntimeState = {
  running: false,
  step: null,
  lastRunAt: null,
  lastOk: null,
  failedStep: null,
  reason: null,
  messages: 0,
  turns: 0,
  asks: 0,
  files: 0,
  grade: null,
}

export interface DistillServiceOptions {
  /**
   * 蒸馏产出了新画像时调一次。
   *
   * 由装配层接到 `PersonaService.markProfileChanged()` —— 这一层不该
   * 直接持有数字人（蒸馏与回复是两条独立的链路，互相 import 会让
   * "谁依赖谁"变成一个环）。可选：单测不关心这条通知。
   */
  onProfileChanged?: () => void
  /**
   * 蒸馏跑完、语料已经落盘时调一次 —— 让图谱那条链**立刻**跟上。
   *
   * ## ★★ 为什么必须有（不然「开始学习」看起来不建图）
   *
   * 建图由 `GraphSync` 的定时轮询驱动（10 分钟一轮），而蒸馏完成
   * **不叫醒它**。于是用户点完「开始学习」，蒸馏几十秒就跑完了，
   * 而图谱那边最多要干等 10 分钟才开始动 —— 界面上什么都没有。
   *
   * 同事机器上的实测时间线正是这个形状：
   * ```
   * 09:53:35  forge run finished          ← 蒸馏完了
   * 09:59:43  graph export synced         ← 6 分钟后才轮到
   * 10:01:10  graph auto-built
   * ```
   * 中间那 6 分钟里没有任何图谱动作，所以"点了开始学习不会建图"这个
   * 判断从用户视角看是对的 —— 它只是**没接上**，而不是坏了。
   *
   * 与 `onProfileChanged` 同构：这一层不直接持有 FeedService
   * （蒸馏与图谱是两条独立链路，互相 import 会让依赖成环），由装配层接。
   * 可选：单测不关心这条通知。
   */
  onCorpusReady?: () => void
  clock: Clock
  logger: Logger
  /** provider.get() 为 null 时只跑统计型任务（抽取型显式报错，不静默产 0 条） */
  llmProvider: LlmProvider
  getWindow: () => BrowserWindow | null
  /**
   * 跑 forge（测量型引擎），产出 skill 包。这是现在**画像的唯一来源**。
   *
   * 注入一个回调而不是让这个服务直接持有 `ForgeService`：路径按 vault 变，
   * 而它要在登录时才知道是哪个 vault（见 `attach`）。
   *
   * ★ 返回的是**完整**结果而不是 `{ok, reason}`：`messages` / `turns` /
   * `asks` / `files` / `grade` 是回答"蒸得怎么样"的那几个数，而它们曾经
   * 在这个回调的边界上被丢掉 —— 于是 UI 只能显示「等待中」。
   *
   * ★ `since` 是**用户选的那个范围**的起点（unix ms），`null` = 用 forge
   * 自己的增量水位。这个参数曾经不存在 —— 于是引导页那个「30/90/180 天」
   * 选择器选完之后 `days` 走到 `start(input)` 就被丢掉，forge 永远按
   * `since: null` 跑。表现是：选 180 天，实际蒸的是"上次蒸到哪就从哪续"，
   * 而首次跑时是 `analysisStart`（库里最早那条消息的日期）——
   * 也就是**用户选什么都一样**，且界面上看不出来。
   *
   * ★ `windowDays` 是**测量**窗口（`build --window-days`），与 `since` 不同：
   * `since` 决定什么进语料库，它决定 build 看哪一段。语料库一旦有了半年，
   * 光靠 `since` 是收不窄的（`--since auto` 只管右端），于是「重蒸最近 30 天」
   * 做不到。非破坏性：语料一条不删，下轮不传就又是全量。
   */
  runForge?: (
    signal?: AbortSignal,
    onStep?: (step: ForgeStepName) => void,
    since?: number | null,
    windowDays?: number | null,
  ) => Promise<ForgeRunOutcome>
  /**
   * forge 能不能跑（缺 Python / 缺引擎）。
   *
   * 与 `runForge` 分开是因为它要在**跑之前**就能显示：没装 Python 时
   * 蒸馏根本不会启动，而那时唯一的痕迹是一行启动日志 —— 用户在界面上
   * 只看到「等待中」，无从下手。
   */
  forgeAvailability?: () => { ok: boolean; reason: string | null }
  /**
   * 清掉 forge 自己的增量水位，让下一轮真的从头蒸。
   *
   * ★ 必须由外部注入：那个水位在 forge 的**派生库**里
   * （`<vault>/forge/database/persona.db` 的 `pulledThrough` meta），
   * 不在这个服务能碰到的 vault 里。
   *
   * 返回是否真的清掉了 —— 只记日志用。文件不存在（还没蒸过）时是 false，
   * 那不是错误。
   */
  resetForge?: () => boolean
  /**
   * 自动重蒸的周期（毫秒）。0 = 关掉（仍可手动点「开始蒸馏」）。
   *
   * ## ★ 为什么需要自动跑
   *
   * 画像只在用户点「开始」时更新，而那个按钮只在**引导流程的第 4 步**。
   * 也就是说：走完引导之后画像就**再也不会变**了 —— 新语料、新的
   * 「别人问我」（决策层的全部证据）都不会进去，而界面上没有任何东西
   * 提示需要重跑。
   *
   * forge 跑一轮很便宜：纯本地测量、零模型调用（实测 4400 条约 5 秒），
   * 而且是增量的（`--since auto` 从自己的水位续）。所以定期跑的代价接近于零，
   * 而不跑的代价是画像慢慢过期。
   *
   * 缺省 6 小时：语料按天累积，更频繁没有意义（同一份语料测出来的结论
   * 一样），更稀疏会让"今天刚聊的事"几天后才进决策层。
   */
  autoIntervalMs?: number
  /**
   * 把 work 层产物写进 skill 包。
   *
   * 与 `runForge` 同构地注入：落点是 `<vault>/skills/persona-persona/references/`，
   * 而这一层在登录时才知道是哪个 vault（见 `attach`）。
   *
   * 传 `null` 内容 = 一条够格的结论都没有 → **删掉**已有文件而不是留一个旧的。
   * 留旧的会让 agent 读到上一轮的结论，而那份结论可能正是这轮被判定为
   * 置信度不足的（比如语料范围收窄了）。
   *
   * 可选：单测不关心落盘。
   */
  writeWorkFile?: (content: string | null) => void
  /**
   * work 层产物在不在（`work.md` 是否存在）。
   *
   * ★ 攒批判据的「首次」分支读它，而不是读游标是否为 0 —— 两者不是一回事：
   * 产物可能被删过（换 vault、用户清过 skill 包、上一轮因置信度不足而删了它），
   * 那时游标还在。只看游标会让这些情况**永远不再产出**，且界面上看不出来。
   */
  workArtifactExists?: () => boolean
  /**
   * forge 测出的 ask 频率与衰减半衰期 —— 给 `work.md` 的 `tasks` 一节引用。
   *
   * 与 `runForge` 同构地注入：那份数据在 `<vault>/forge/derived/features.json`，
   * 路径按 vault 变，而这一层在登录时才知道是哪个 vault。
   *
   * ★ **频率必须来自 forge**（测量），内容来自 LLM（抽取）。让 work 层自己
   * 数一遍会造出第二个真源，而两个数打架时没有任何机制决定谁赢。
   *
   * 不给 / 返回空 = 产物里省掉频率那段（而不是写「0 次」——「测出来 0 次」
   * 与「没测」是两件事）。
   */
  workForgeContext?: () => {
    askKinds: Record<string, { asks: number; answerRatePct: number }>
    staleAfterDays: number
  }
  /**
   * 打开 kl 的图库（**只读**）—— playbook 归纳的语料来源。
   *
   * ★ 与 `runForge` 同构地注入：图库路径按 vault 分，而这一层在登录时才知道
   * 是哪个 vault。返回 `null` = 还没建过图（**正常状态**，不是故障）。
   *
   * ★ 由宿主打开而不是 distill 自己开：`@mycontext/distill` 不依赖
   * better-sqlite3（native 模块，本仓库的 Electron/Node ABI 反复踩过）。
   */
  openGraphDb?: () => { db: SqliteDatabase; close: () => void } | null
  /**
   * 建图正在跑吗 —— 为真时**跳过** playbook 归纳。
   *
   * ★★ 实测：建图用 12 并发打同一个 LLM 网关时，归纳这条路**必然** 524
   * （Cloudflare 前置，源站 100s 内没返回完整响应）。所以必须串行 ——
   * 跳过一轮比烧一次注定失败的调用好。
   */
  graphBusy?: () => boolean
  /**
   * 是否跑 LLM 抽取那半（写 `profile_facets`）。
   *
   * ★ 默认 **false**。那些 facet 现在没有任何读者（persona 的 workspace 只装
   * forge 的产物），而每个任务是一次上万 token 的模型调用 —— 产出没人读、
   * 成本照付，且不报错。
   *
   * 留成开关而不是删掉代码：forge 不测 `identity` / `expertise` 这类语义维度，
   * 将来要把它们作为补充接回来时，接的是同一份 runner。
   *
   * ## ★ 为什么是回调而不是 boolean
   *
   * 用户在设置页改这个开关时这个服务已经构造完了。传值会锁死在装配那一刻,
   * 表现是"打开了开关但要重启才生效",而界面上不会提示需要重启。
   * 回调让每一轮判据现读（装配层接 `preferences.workLayerEnabled()`）。
   *
   * 不给 = 关。**默认必须是关**：这一层开着就是在后台静默花钱。
   */
  llmFacets?: () => boolean
}

/** `runForge` 回调的返回：与 `ForgeRunResult` 同形，但不依赖那个模块。 */
export interface ForgeRunOutcome {
  ok: boolean
  failedStep: "pull" | "build" | "publish" | null
  reason: string | null
  messages: number
  turns: number
  asks: number
  files: number
  grade: string | null
}

export class DistillService {
  private db: SqliteDatabase | null = null
  /** forge 运行回调，随 vault 变（见 attach）。null = 不跑 forge。 */
  private runForge:
    | ((
        signal?: AbortSignal,
        onStep?: (step: ForgeStepName) => void,
        since?: number | null,
        windowDays?: number | null,
      ) => Promise<ForgeRunOutcome>)
    | null = null
  private runner: DistillRunner | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<unknown> | null = null
  /**
   * 后台那轮 work 层自己的闸 —— **不占 `inFlight`**。
   *
   * ## ★★ 为什么必须分开（实测踩到：点「开始学习」没反应）
   *
   * `inFlight` 的语义是「**用户这次触发的**那一轮正在跑」，`start()` /
   * `runRound()` 都靠它防重入。而 work 层的后台轮次（挂载时评估、6 小时
   * 定时器、开关被打开）原来也塞进同一个 `inFlight` —— 于是：
   *
   * ```
   * 12:22  登录 → attach 里 fire-and-forget 跑一轮 work 层 → 占住 inFlight
   * 12:33  用户点「开始学习」→ start() 的 `if (this.inFlight === null)` 不成立
   *        → 静默 return this.progress()，日志一个字都没有
   * ```
   *
   * 而一轮 work 层是 20 批 × 2 个任务 × 约 60s = **最多 40 分钟**。也就是
   * 用户在这 40 分钟里点按钮全部无效，且界面与日志都看不出为什么。
   * forge 那条路（几十秒）撞上的概率低，所以这个坑是 work 层引入的。
   *
   * ★ 参照 `KlServerService` 的做法：建图有自己的 `building` 布尔，
   * 从不占别人的锁 —— 所以「建图在跑」与「用户点了建图」是两件独立的事。
   * 这里同理：后台轮次自己排程、自己防重入，用户的主动操作永远优先。
   */
  private workInFlight: Promise<unknown> | null = null
  /**
   * forge 的最近一轮状态。
   *
   * 内存态而不是落库：它描述的是"这次运行发生了什么"，而运行本身不跨重启
   * （重启后该做的是重新蒸一次，而不是显示上次的数字）。真正需要持久的
   * 那部分已经在产物里（`fidelity.md` 的覆盖度等级、forge 自己的水位）。
   */
  private forge: ForgeRuntimeState = { ...IDLE_FORGE }
  /**
   * 在跑那一轮 forge 的取消器。null = 没在跑。
   *
   * 每次起跑新建一个（见 `start`）：复用的话第一次 `stop()` 之后它永久
   * 是 aborted，之后每次开始都会立刻自我取消。
   */
  private abort: AbortController | null = null
  /** 清 forge 水位的回调，随 vault 变（见 attach）。null = 清不了。 */
  private resetForge: (() => boolean) | null = null
  /**
   * 用户这次选的范围起点（unix ms），`null` = 不限（走 forge 增量水位）。
   *
   * 只给 LLM 那条路上的「排空后补一轮 forge」用（见 `runRound`）——
   * 那一轮是同一次「开始」动作的尾巴，该沿用同一个范围。
   * 自动重蒸**不读它**（那是定时任务，见 `attach` 里的注释）。
   */
  private plannedSince: number | null = null
  /**
   * 用户这次选的**测量**窗口天数，`null` = 不限（全量测量）。
   *
   * ## ★ 为什么它与 `plannedSince` 都存下来，而自动重蒸只沿用这一个
   *
   * 两个参数的时效性不同：
   *
   * · `since`（采集下界）是**一次性动作参数** ——「这次回溯多远」。自动重蒸
   *   不该沿用它，否则每 6 小时重采半年（见 `attach` 里 autoTimer 的注释）。
   * · `windowDays`（测量窗口）是**长期口味** ——「我要一个反映最近 N 天的画像」。
   *   自动重蒸**必须**沿用它，否则会出现这个静默倒退：用户选了 30 天、
   *   界面显示按 30 天蒸好了，6 小时后定时任务不带窗口重跑一遍，
   *   画像悄悄变回全量 —— 而界面上没有任何迹象说它变了。
   */
  private plannedWindowDays: number | null = null
  /**
   * 自动重蒸的定时器。与 `timer`（LLM 轮次）分开：那个跑完就停，
   * 这个要一直活着 —— 混用会让"抽完了"顺手把自动重蒸也停掉。
   */
  private autoTimer: ReturnType<typeof setInterval> | null = null
  /**
   * 落 work 层产物的回调，随 vault 变（见 attach）。null = 不落盘。
   *
   * 与 `runForge` / `resetForge` 同构：落点是这个账号的 skill 目录，
   * 而那个路径在登录时才知道。构造时给会让切换账号后把 work 层写进
   * 上一个账号的包里 —— 那是画像串号，且不报错。
   */
  private writeWorkFile: ((content: string | null) => void) | null = null
  /**
   * work 层连续失败次数 + 上次失败时刻。**只在内存里**
   * （见 `work-refresh.ts` 的 `WORK_BACKOFF_MS`）：失败多半是配置问题，
   * 用户填完 key 会重启应用 —— 那时该立刻重试，而不是继续等 2 小时。
   */
  private workFailures = 0
  private workLastFailureAt: number | null = null
  /**
   * 上一轮归纳出的工作套路。null = 还没归纳过。
   *
   * ★ 存在内存里而不是落库：它是**派生物**（从 kl 的 chunk 归纳来的），
   * 而真正的持久化落点是 `work.md` 那个文件本身。进程重启后第一轮
   * 归纳会重建它 —— 而在那之前产物里的套路仍然是上一次写进去的那份，
   * 因为我们不会因为内存里没有就把文件里的删掉。
   */
  private playbooks: WorkPlaybookSection | null = null
  /** 探测 work 层产物是否存在，随 vault 变（见 attach）。null = 当作不存在。 */
  private workArtifactExists: (() => boolean) | null = null
  /** forge 侧的频率/半衰期（随 vault 变，见 attach）。null = 没有那份数据。 */
  private workForgeContext:
    | (() => {
        askKinds: Record<string, { asks: number; answerRatePct: number }>
        staleAfterDays: number
      })
    | null = null

  constructor(private readonly options: DistillServiceOptions) {}

  /**
   * work 层（LLM 抽取）开着吗 —— **每次现读**，不缓存。
   *
   * 用户在设置页改开关时这个服务已经构造完了，缓存等于"要重启才生效"，
   * 而界面上不会提示需要重启。不给回调 = 关（默认不花钱）。
   */
  private get workLayerOn(): boolean {
    return this.options.llmFacets?.() === true
  }

  attach(
    db: SqliteDatabase,
    runForge?: (
      signal?: AbortSignal,
      onStep?: (step: ForgeStepName) => void,
      since?: number | null,
      windowDays?: number | null,
    ) => Promise<ForgeRunOutcome>,
    resetForge?: () => boolean,
    writeWorkFile?: (content: string | null) => void,
    workArtifactExists?: () => boolean,
    workForgeContext?: () => {
      askKinds: Record<string, { asks: number; answerRatePct: number }>
      staleAfterDays: number
    },
  ): void {
    this.db = db
    this.writeWorkFile = writeWorkFile ?? this.options.writeWorkFile ?? null
    this.workArtifactExists = workArtifactExists ?? this.options.workArtifactExists ?? null
    this.workForgeContext = workForgeContext ?? this.options.workForgeContext ?? null
    /**
     * forge 的运行回调随 vault 变（它要拿这个账号的语料路径与产物落点），
     * 所以在 attach 时给而不是构造时给 —— 构造时给会让切换账号后
     * 仍蒸上一个账号的语料，而那个错误不会报错，只会产出**另一个人**的画像。
     */
    this.runForge = runForge ?? this.options.runForge ?? null
    // 水位在 forge 的派生库里，路径同样按 vault 变（见 options.resetForge）
    this.resetForge = resetForge ?? this.options.resetForge ?? null
    /**
     * ★ 只在 `llmFacets` 打开时才造 runner。
     *
     * 关着的时候造它是纯浪费，但更重要的是它**掩盖了状态**：runner 在、
     * `progress()` 报着它的计数、`reset()` 清着它的表，读代码的人会以为
     * 那条路是活的。而实际上没有任何入口能打开这个开关
     * （startup 不传、`distillStartInputSchema` 里也没有这个字段）。
     *
     * 留成开关而不是删掉 `packages/distill/`：forge 不测 `identity` /
     * `expertise` 这类语义维度，将来要把它们作为补充接回来时接的是同一份
     * runner。但"接得回来"与"现在假装它在跑"是两件事。
     *
     * ## ★★ 为什么改成**懒建**（而不是在这里按开关建一次）
     *
     * 开关现在是用户可改的（设置页），而 `attach()` 只在登录那一刻跑。
     * 在这里按开关建的后果是：登录后打开开关 → runner 仍是 null →
     * 那一轮 `if (runner === null) return` **静默什么都不做**。
     * 用户看到的是"我开了开关,但它没反应",而日志里连一行都没有。
     *
     * 所以这里只清掉旧 runner（换 vault 了），真正的构造推迟到
     * `requireWorkRunner()` —— 用到时现建,开关的状态自然就是最新的。
     */
    this.runner = null

    /**
     * ★★ 丢掉 facet 名已经不存在的陈旧任务。
     *
     * facet 集合是代码里的常量,而库里的任务是按**当时**那套名字建的。改了集合
     * 之后旧任务不会自己消失 —— 本机实测有 48 条（`identity` / `tone` /
     * `persona` / `expertise` / `relations`,建于集合变更之前）。
     *
     * 留着它们的后果全是静默的：进度条永远显示"还有 40 个没跑"；runner 认领到
     * 一条之后不知道怎么处理那个 facet；而最要命的是**"排空"这个条件永远不成立**,
     * 于是 `writeWorkLayer()` 永远不会被调到 —— 也就是 work.md 永远不产出,
     * 而日志里一个错都没有。
     *
     * 放在 attach（每次登录/切 vault）而不是一次性迁移脚本：facet 集合还会再变,
     * 而"每次挂载时对账一次"是幂等且自愈的 —— 与 `store.link_direct_peers` 那类
     * self-heal 同一个思路。没有陈旧任务时它什么都不做。
     */
    const dropped = new DistillTaskRepository(db).dropUnknownFacets(ALL_FACETS)
    if (dropped > 0) {
      // info 而不是 debug：这是一次**数据删除**，即便是自愈也该留痕。
      this.options.logger.info("dropped distill tasks with unknown facets", {
        dropped,
        known: ALL_FACETS.join(","),
      })
    }

    /**
     * ★★ 同理丢掉**切窗宽度**已经不对的未完成任务。
     *
     * 与上面那条是同一个形状（代码里的常量变了，库里的旧行不会自己消失），
     * 但代价更直接：实测本机库里 366 个 7 天窗任务与 30 个新窗任务并存，
     * 319 条 pending，而一轮上限 40 个 —— **永远排不空**，于是
     * `finalizeWorkLayer()` 永不执行、游标永不推进、下一轮从头再抽一遍。
     * 而那 366 个覆盖的语料与新窗**完全重叠**，跑完只是把同一段语料
     * 按两种切法各付一次钱。
     *
     * 放在 attach（每次登录/切 vault）而不是一次性迁移：宽度还会再变，
     * 而"每次挂载对账一次"是幂等且自愈的。宽度没变时它什么都不做。
     */
    const staleWindows = new DistillTaskRepository(db).dropMismatchedWindows(
      WORK_WINDOW_DAYS * 86_400_000,
    )
    if (staleWindows > 0) {
      this.options.logger.info("dropped distill tasks with stale window width", {
        dropped: staleWindows,
        windowDays: WORK_WINDOW_DAYS,
      })
    }

    /**
     * ★ 起自动重蒸的定时器。
     *
     * 挂载时**不立刻跑**（与 FeedService 的图谱同步不同）：登录那一刻
     * 采集还没开始，语料与上次退出时一样，跑了只是白测一遍。等第一个
     * 周期到就好 —— 而"从没蒸过"这个状态由界面提示用户点按钮。
     *
     * `unref`：这一轮不该阻塞进程退出（下一个周期总会再来）。
     */
    const interval = this.options.autoIntervalMs ?? AUTO_INTERVAL_MS
    if (interval > 0 && this.runForge !== null) {
      this.autoTimer = setInterval(() => {
        /**
         * ★ 两个闸都要看：
         * · `workInFlight` —— 上一轮后台还没跑完，别叠一轮；
         * · `inFlight` —— 用户正在跑一轮，让他先跑完（语料不会跑掉）。
         */
        if (this.workInFlight !== null || this.inFlight !== null) return
        this.abort = new AbortController()
        /**
         * ★ 自动重蒸走 `null`（forge 自己的增量水位），**不**沿用用户选的范围。
         *
         * 那个范围是"这次重来一遍，回溯多远"的意思，是一次性的动作参数；
         * 而自动重蒸要的是"把新攒的语料续上"。拿 180 天去跑定时任务
         * 等于每 6 小时重测半年 —— 而 `--since auto` 正是为这件事存在的。
         *
         * ★ 但**测量窗口要沿用**（`plannedWindowDays`）。那是长期口味而不是
         * 一次性动作：不沿用的话，用户选的 30 天窗口会在 6 小时后被定时任务
         * 悄悄换回全量，而界面上看不出画像变了。见 `plannedWindowDays`。
         */
        /**
         * ★ 用 `workInFlight` 而不是 `inFlight` —— 见那个字段的注释：
         * 后台轮次不该挡住用户点「开始学习」。
         */
        this.workInFlight = this.runForgeStep(null, this.plannedWindowDays)
          .then(() => this.maybeRefreshWorkLayer())
          .finally(() => {
            this.workInFlight = null
          })
      }, interval)
      this.autoTimer.unref?.()
    }

    /**
     * ★★ 挂载时评估一次 work 层 —— 开关**已经是开**的情况必须被覆盖。
     *
     * ## 为什么 `workLayerToggled` 不够
     *
     * 那个只在开关**被点击**的那一刻触发。而最常见的情形恰恰不是点击：
     * 用户上次会话里开了开关，然后重启应用 —— 这一次启动没有"打开"这个
     * 动作，于是三条路一条都不通：
     *
     * · 点击触发：这次没点；
     * · 自动轮：6 小时后才到；
     * · 手动「开始学习」：要用户主动点。
     *
     * 结果是**开关明明是开的，却什么都不发生**，而界面上不会说在等什么。
     * 实测就是这个形状（开关 true、模型配着、语料 3.4 万条、work.md 不存在）。
     *
     * ★ 与上面那条"挂载时不立刻跑 forge"的注释不冲突：forge 不立刻跑是因为
     * 登录那一刻语料与上次退出时一样，重测一遍纯浪费。work 层不一样 ——
     * 它可能**从来没跑过**（首次开开关、或上次跑失败了），而那个状态只有
     * 评估一次才知道。攒批判据会挡住"没有新数据"的情况，所以这一次评估
     * 在稳态下是免费的（读两个数就返回 `no-new-data`）。
     *
     * fire-and-forget + 不占 `inFlight`：它不该阻塞登录，也不该让"正在蒸馏"
     * 这个状态在登录瞬间就亮起来。
     */
    this.workInFlight = this.maybeRefreshWorkLayer().finally(() => {
      this.workInFlight = null
    })
    void this.workInFlight.catch(() => {
      // 失败已在里面记过日志；这里吞掉是为了不让一个可选环节打断登录。
    })
  }

  async detach(): Promise<void> {
    this.stop()
    /**
     * 自动重蒸的定时器只在 detach 时停，**不**在 stop() 里停。
     *
     * `stop()` 的语义是"用户点了停止这一轮"，而那不该关掉自动重蒸
     * —— 否则点一次停止之后画像就永久不再更新了，而界面上没有任何
     * 地方能看出来自动更新被关了。
     */
    if (this.autoTimer !== null) {
      clearInterval(this.autoTimer)
      this.autoTimer = null
    }
    if (this.inFlight !== null) {
      try {
        await this.inFlight
      } catch {
        // 在途失败已记过日志
      }
    }
    this.db = null
    this.runner = null
  }

  /**
   * 切窗入队并开始跑。
   *
   * 幂等：重复调用不会产生重复任务（`enqueue` 按 `(facet, window)` 去重），
   * 也不会起两套定时器。
   *
   * ★ 默认只跑 forge。LLM 抽取那半（`llmFacets`）默认关，见 options 的注释。
   * 关掉时**不切窗、不入队**：留一堆 pending 任务会让进度页显示「还有 30 个
   * 没跑」而它们永远不会跑 —— 那比不显示更糟。
   *
   * ## ★ `input.days` 必须真的传给 forge
   *
   * 这个参数原来**只在 LLM 那条路上被读**（`runner.plan`），而 forge 那条路
   * （默认路径）里 `runForgeStep()` 不接参数 —— 于是引导页那个
   * 「30 / 90 / 180 天」选择器选完之后，`days` 走到这里就沉了。
   *
   * 实测这台机器的后果：`distill_sources.scope_json` 记着
   * `{"since":1770080941327}`（= 2026-02-03，正好 180 天），而 forge 实际
   * 从 `analysisStart`（库里最早那条消息 = 2026-07-23）起跑。也就是说
   * **选 180 天与选 30 天产出完全一样**，而界面上没有任何迹象。
   */
  start(
    input: { days?: number | null | undefined; windowDays?: number | undefined } = {},
  ): DistillProgressView {
    /**
     * 天数换成绝对起点。
     *
     * `null`/不传 = 不限范围 → 交给 forge 的 `--since auto`（增量水位，
     * 首次跑时退化成 `analysisStart`）。这与"用户没选"的语义一致。
     */
    const until = this.options.clock.now()
    const since =
      input.days === null || input.days === undefined ? null : until - input.days * 86_400_000
    this.plannedSince = since
    /**
     * ★ 同一个「30 / 90 / 180 天」也当作 forge 的**测量**窗口。
     *
     * 修掉 `since` 那个 bug 之后，选 30 天确实只**采集** 30 天了 —— 但语料库里
     * 可能早就有半年（上次选过宽范围，或 `resolveSince` 回扫补过历史），
     * 而 build 从不受 `since` 约束，于是它照样把半年全部测进画像。
     * 表现与那个已修的 bug 一模一样：**选 30 天与选 180 天产出仍然相同**。
     *
     * ★ 注意不能复用 `input.windowDays` —— 那是 LLM 那条路的**切片宽度**
     * （`runner.plan`），与「测量多久」无关。两个同名不同义的参数，
     * 混用不会报错，只会让画像的时间范围变成一个谁都说不清的数。
     *
     * 非破坏性：语料一条不删。用户下次选「不限」就又是全量。
     */
    this.plannedWindowDays = input.days === null || input.days === undefined ? null : input.days

    /**
     * ★★ 用户点了「开始学习」—— **一定要留痕**。
     *
     * 实测踩到：一轮后台 work 层占着锁时，`start()` 的每条分支都被
     * `if (this.inFlight === null)` 静默挡掉，然后 `return this.progress()`
     * —— 界面看起来"点了没反应"，而日志里一个字都没有。
     * 那正是这个仓库反复防的静默失效，而它是 work 层引入的
     * （forge 那条路几十秒，撞上的概率低；work 层一轮最多 40 分钟）。
     */
    this.options.logger.info("distill start requested", {
      days: input.days ?? null,
      workLayerOn: this.workLayerOn,
      // 这两个数是"为什么没反应"的直接答案
      userRoundBusy: this.inFlight !== null,
      backgroundRoundBusy: this.workInFlight !== null,
    })

    /**
     * ★★ 「开始学习」**只跑 forge**，不跑 work 层 —— 不管开关是开还是关。
     *
     * ## 为什么（这是引导流程的核心取舍）
     *
     * 两层的性质完全不同：
     *
     * | | forge | work 层 |
     * | --- | --- | --- |
     * | 耗时 | 实测 **5 秒**（4400 条语料） | 一轮最多 **40 分钟** |
     * | 成本 | 零（纯 stdlib Python） | 每轮几万 token |
     * | 产出 | 语气/句长/时延/逐人 tone band —— 数字人**能用**的最小集 | 职责/流程/规矩/套路（增强） |
     *
     * 而引导流程要回答的是「**现在能用了吗**」。forge 跑完就能用，
     * 所以那才是引导该等的东西。让用户在引导页干等 40 分钟去换一层
     * **增强**，是把主次搞反了。
     *
     * ## ★ 而且这与设置页那个开关的语义一致
     *
     * 「工作层抽取」的说明原文：「蒸馏在后台跑（6 小时一轮），所以这笔开销
     * 是持续的」。也就是它**本来就承诺**在后台跑 —— 而原来这里一开开关就
     * 在引导里同步跑一轮，等于当场违背那句说明，用户完全没预期。
     *
     * ## work 层什么时候跑
     *
     * 三条路，全部在后台、全部过攒批判据（`decideWorkRefresh`）：
     * · `attach()` 挂载时评估一次（覆盖"开关本来就开着"）；
     * · 6 小时定时器；
     * · 用户在设置页**打开开关**那一刻（`workLayerToggled`）。
     *
     * 所以关掉开关的人永远不会为它付钱，开着的人也不会被它堵在引导页。
     */
    if (this.inFlight === null) {
      /**
       * ★ 每次起跑都换一个新的 AbortController。
       *
       * 复用同一个的话第一次 `stop()` 之后它永久是 aborted 状态，
       * 于是之后每次「开始」都会立刻被自己取消 —— 表现是点了没反应。
       */
      this.abort = new AbortController()
      this.inFlight = this.runForgeStep(since, this.plannedWindowDays).finally(() => {
        this.inFlight = null
        this.abort = null
      })
    } else {
      // ★ 说清"为什么这次点击没起新的一轮" —— 静默 return 是那个坑本身
      this.options.logger.warn("distill start ignored: a user round is already running", {})
    }
    return this.progress()
  }

  /**
   * 停。
   *
   * ## ★ 必须真的打断在跑的 forge
   *
   * 曾经这里只 `clearInterval` —— 而只跑 forge 时那个定时器**根本不存在**
   * （forge 是一次性全量重算，不走轮次）。于是「停止」对它完全无效：
   * 一轮的超时上限是 pull 10min + build 15min + publish 2min，用户点了停
   * 之后没有任何东西会停，而界面上那个按钮看起来是生效了的。
   *
   * `abort()` 会传导到 `ProcessRunner.spawn` 的 signal，真的杀掉子进程。
   */
  /**
   * 用户刚在设置页**打开**了工作层开关 —— 立刻评估一次,不等下一个周期。
   *
   * ## ★ 为什么需要它
   *
   * 自动轮是 6 小时一次。不接这个的话,用户打开开关之后最长要等 6 小时才会
   * 有任何动静,而界面上**不会说"在等下一轮"** —— 实测就是这个形状：
   * 开关打开于 19:33:57,而最后一轮 forge 是 19:33:34（早 23 秒），
   * 于是那一晚什么都没发生,看起来就是"开了没反应"。
   *
   * ★ 不传 `force`：这条是**开关被打开**触发的,不是用户点「开始学习」。
   * 攒批判据仍然该管着它（没有新数据时就不该跑）—— 那时判据会给
   * `no-new-data`,而那是正确答案,不是需要绕过的障碍。
   *
   * fire-and-forget：调用方是 IPC handler，它该立刻返回让开关的 UI 状态落定,
   * 而这一轮可能要跑几分钟。失败已在 `maybeRefreshWorkLayer` 里记过日志。
   */
  workLayerToggled(enabled: boolean): void {
    if (!enabled) return
    /**
     * ★★ 这是**用户的主动操作**，所以它不与后台那轮互斥。
     *
     * 踩到过：`attach()` 末尾那轮评估会占住 `workInFlight`，于是登录后
     * 立刻打开开关这个动作被静默吞掉（`tests/.../distill-forge.test.ts`
     * 的「打开开关立刻评估一次」当场变红）。
     *
     * 而重入是安全的：`maybeRefreshWorkLayer` 里每一步都有自己的闸
     * （攒批判据、`graphBusy`、`claimBatch` 的行级认领），两轮同时进去
     * 只会各自认领不同的任务，不会重复抽同一批。
     *
     * ★ 但**不覆盖** `workInFlight`：那个引用是给定时器判"上一轮跑完没"的，
     * 覆盖会让它以为后台空闲而叠一轮。所以这里 fire-and-forget，
     * 失败已在 `maybeRefreshWorkLayer` 里记过日志。
     */
    void this.maybeRefreshWorkLayer().catch(() => {
      // 已在内部记过日志；这里吞掉是为了不让一个可选环节冒泡成未捕获拒绝
    })
  }

  /**
   * ── 给 `runCycle` 的两个入口（`distill-work` 那个 runnable 用）─────
   *
   * ## ★★ 为什么要暴露它们
   *
   * work 层原来只由内部定时器与开关驱动（`maybeRefreshWorkLayer` 是
   * `private`）。于是它声明的 `dependsOn` 对它**没有执行力** ——
   * 它不是 `OutboxConsumer`，压根不经过依赖闸。
   *
   * 接进 `runCycle` 之后那两条边（`distill` 与 `graph-build`）从
   * "记得写对"变成"算出来的"，且状态页能说出「work 在等建图」
   * 而不是「work 没进展」。
   *
   * ★★★ 但"这一轮该不该真跑"的判据**留在原处**（`decideWorkRefresh`：
   * 攒够 200 条 / 3 天 / 开关 / 有没有模型 / 退避）。`runCycle` 每 2 分钟
   * 一轮，而 work 层是天级的 —— 把判据搬进循环等于每 2 分钟问一次要不要
   * 花钱。所以这个方法**本身很便宜**（不该跑时读几个游标就返回）。
   */

  /** 跑一轮 work 层评估。★ 不该跑时内部早退，所以调用它是便宜的。 */
  async refreshWorkLayer(): Promise<void> {
    await this.maybeRefreshWorkLayer()
  }

  /**
   * work 层游标当前到哪（`distill-work` 的 `acked_seq`）。
   *
   * ★ 未挂载 vault → 0。那时 `runCycle` 里那几行会算出"没在等" ——
   * 而那正确：没挂库时什么都不该在等。
   */
  workSeq(): number {
    const db = this.db
    if (db === null) return 0
    try {
      return (
        new ConsumerCursorRepository(db, this.options.clock).get(WORK_CONSUMER_ID)?.ackedSeq ?? 0
      )
    } catch {
      /**
       * ★ 读不出来报 0 而不是抛：这个值只用于**展示进度**，
       * 而抛错会让整轮 `runCycle` 记一次 skipped（那会掩盖真正的问题）。
       */
      return 0
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.abort !== null) {
      this.abort.abort()
      this.options.logger.info("distill stop requested; aborting forge", {})
    }
  }

  /**
   * 重来一遍：清任务表 + 清各源水位 + **清 forge 自己的水位**。
   *
   * ★ **不删 facet**：合并是幂等的（按 `(facet, scope, scope_ref, key)`
   * 定位并按证据合并），重蒸只会补充/更新。删 facet 会丢掉人工确认过的、
   * 或来自别的源的结论 —— 那是不可逆的损失。
   *
   * ## ★ forge 的水位不在这个库里
   *
   * 它是 forge 自己派生库里的一个 meta（`pulledThrough`），而 `--since auto`
   * 就是从那里续跑的。只清 `distill_tasks` 与 `distill_sources` 的话
   * 「重新蒸馏」对 forge 完全无效 —— 它照旧只增量跑，而那两张表现在
   * 只有 LLM runner 在用（默认还是关的）。也就是这个按钮的文案在骗人：
   * 用户点了「重新蒸馏」，实际什么都没重来。
   */
  reset(): DistillProgressView {
    const db = this.requireDb()
    const cleared = new DistillTaskRepository(db).clear()
    const sources = new DistillSourceRepository(db)
    const now = this.options.clock.now()
    for (const row of sources.list()) {
      if (row.enabled) sources.resetProgress(row.kind, now)
    }
    const forgeReset = this.resetForge?.() ?? false
    /**
     * 一并清掉内存里的上一轮结果。
     *
     * 留着的话「重新蒸馏」之后界面还显示上次的 4400 条与等级 A，
     * 而实际语料库刚被清空 —— 那个数字会让用户以为不用再跑了。
     */
    this.forge = { ...IDLE_FORGE }
    this.options.logger.info("distill reset", { clearedTasks: cleared, forgeReset })
    const progress = this.progress()
    this.emit(progress)
    return progress
  }

  progress(): DistillProgressView {
    const db = this.db
    if (db === null) {
      return {
        total: 0,
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        costTokens: 0,
        lastError: null,
        facetCount: 0,
        running_: false,
        forge: this.forgeStatus(),
      }
    }
    const raw = new DistillTaskRepository(db).progress()
    /**
     * ★ `llmFacets` 关着时不报任务计数 —— 那些任务**没有消费者**。
     *
     * ## 这修的是一个真实的界面谎言
     *
     * `start()` 在 `llmFacets !== true` 时刻意不入队（见那里的注释：
     * "留一堆 pending 任务会让进度页显示「还有 30 个没跑」而它们永远
     * 不会跑"）。但**库里可能已经有**遗留任务 —— 早期版本入过队、或者
     * 有人短暂打开过那个开关。实测本机就有 6 条 `pending` / `attempts=0`、
     * 创建于两周前，于是引导页永远显示：
     *
     *   进度 0 / 6 · 跳过 0 · 失败 0 · 待跑 6
     *
     * 而**同一屏上面**写着「上次蒸馏成功 · 产物 11 个 · 覆盖度等级 A」。
     * 两个数字互相矛盾，而那个 0/6 永远不会动 —— 用户只能理解成"坏了"。
     *
     * 判据用**开关本身**而不是"有没有 runner"：runner 是构造期按同一个
     * 开关造的，用它等于绕一圈问同一件事，而绕的那一圈将来会漂。
     *
     * 遗留行**不删**：`reset()` 会清（那是用户显式要求重来），而在一个
     * 只读的 `progress()` 里删库是超出它职责的副作用 —— 而且删掉之后
     * 万一有人重新打开 `llmFacets`，那些窗口就得重新切一遍。
     */
    const counts = this.workLayerOn
      ? raw
      : { ...raw, total: 0, pending: 0, running: 0, done: 0, failed: 0, skipped: 0 }
    return {
      ...counts,
      /**
       * `facetCount` 与进度分开报。
       *
       * "任务全 done 但 facetCount 是 0" 是一个必须能看出来的状态 ——
       * 只看进度条的话它显示 100%，而画像其实是空的。
       */
      facetCount: new ProfileFacetRepository(db).count(),
      running_: this.timer !== null || this.forge.running,
      forge: this.forgeStatus(),
    }
  }

  /**
   * forge 的对外状态。
   *
   * ★ `available` 每次都重新问，不缓存：用户可能在应用开着的时候装了
   * Python。缓存住的话他装完还要重启才能蒸馏，而界面上没有任何提示说
   * 需要重启。
   */
  private forgeStatus(): DistillProgressView["forge"] {
    const availability = this.options.forgeAvailability?.() ?? { ok: true, reason: null }
    return {
      available: availability.ok,
      unavailableReason: availability.reason,
      running: this.forge.running,
      // 由 `ForgeService.run` 的 onStep 回调填 —— 见 ForgeRuntimeState.step
      step: this.forge.step,
      lastRunAt: this.forge.lastRunAt,
      lastOk: this.forge.lastOk,
      failedStep: this.forge.failedStep,
      /**
       * 原因优先报"不能跑"。
       *
       * 两者同时存在时（上次失败了、而现在 Python 也没了），先说不能跑 ——
       * 那是用户**当下**要解决的，而上一轮的失败原因很可能就是它导致的。
       */
      reason: availability.ok ? this.forge.reason : availability.reason,
      messages: this.forge.messages,
      turns: this.forge.turns,
      asks: this.forge.asks,
      files: this.forge.files,
      grade: this.forge.grade,
    }
  }

  /**
   * 用户在引导里勾的会话白名单；空数组 = 不限。
   *
   * ★ 这个值在接线前是**纯装饰**：引导页把它写进 `distill_sources.scope_json`
   * 而没有任何代码读 —— 用户排除掉的会话照样被蒸进画像，且界面上看不出来。
   *
   * 判据走 `@mycontext/store` 的 `readCollectionScope`（唯一权威，
   * 见 collection-scope.ts 文件头：修复前四处各一份实现且已经漂了）。
   */
  private scopedConversationIds(): readonly string[] {
    const db = this.db
    if (db === null) return []
    const scope = readCollectionScope(db)
    if (!scope.restricted) return []
    return [...scope.allow]
  }

  /**
   * 定时轮里的 work 层：**先过攒批判据，再决定要不要花钱**。
   *
   * ## ★★ 为什么不能跟着 forge 每轮都跑
   *
   * forge 免费（纯本地测量、零模型调用，实测 4400 条约 5 秒），所以它 6 小时
   * 全量重跑一遍无所谓。work 层每个 facet 是一次上万 token 的调用，一轮四个
   * —— 挂同一个定时器就是**每天 4 次为同一批老语料付钱**，而那正是 LLM 那半
   * 当年被整个关掉的原因（见类注释）。原样复活那个成本模型等于把当时的结论作废。
   *
   * 判据是 `decideWorkRefresh`（形状抄 `decideAutoBuild`，那边解决的是同一个
   * 问题：一次很贵的操作挂在一个很密的定时器上）。**不抛**：调用方是定时器。
   *
   * ★ 用 changelog 的 seq 而不是消息条数：那是这个库里"数据准备到哪"的
   * 单调水位，而消息条数会因为保留策略裁剪而**变小** —— 用它做差会算出负数，
   * 于是永远判定"没有新数据"，且看不出来。
   */
  /**
   * 可中断的等待。
   *
   * ★ 必须听 `this.abort` —— 用户切采集范围 / 退登时会 abort，那时还在这里
   * 睡着会让 `reset()` 之后的清理与一个仍在跑的旧轮次交错。
   * 中断时**静默返回**（不抛）：调用方紧接着会重查 `graphBusy`，
   * 而"被中断"与"等完了"在那个判断上是同一件事。
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abort?.signal
      if (signal?.aborted === true) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private async maybeRefreshWorkLayer(opts: { force?: boolean } = {}): Promise<void> {
    const db = this.db
    if (db === null) return
    const cursors = new ConsumerCursorRepository(db, this.options.clock)
    try {
      const cursor = cursors.register(WORK_CONSUMER_ID, {
        /**
         * `required: false` —— 它落后**不该**阻止裁剪历史。
         *
         * work 层抽的是长期结论（职责、规矩），漏掉一段中间历史只会让它少
         * 几条证据；而让一个可能被用户关掉的消费者卡住整个 Outbox 的清理水位，
         * 代价是库无限增长。与 `graph-build` 那个游标同一个判断。
         */
        required: false,
      })
      const latestSeq = new ChangelogRepository(db).head()
      const decision = decideWorkRefresh({
        latestSeq,
        lastRunSeq: cursor.ackedSeq,
        lastRunAt: cursor.lastSuccessAt,
        now: this.options.clock.now(),
        artifactExists: this.workArtifactExists?.() ?? false,
        enabled: this.workLayerOn,
        llmReady: this.options.llmProvider.get() !== null,
        consecutiveFailures: this.workFailures,
        lastFailureAt: this.workLastFailureAt,
      })
      /**
       * ★★ `force` 只绕过**攒批**，绝不绕过开关与"有没有模型"。
       *
       * 手动点「开始学习」是一次明确的用户动作,让它等"攒够 200 条 / 3 天"
       * 是荒谬的（用户看到的是点了没反应）。所以攒批那几档
       * （`below-threshold` / `no-new-data`）在 force 下让路。
       *
       * 但 `disabled` 与 `no-llm` **必须仍然拦住**：
       * · `disabled` 是用户没同意花钱 —— 一个"开始学习"按钮不该越过它;
       * · `no-llm` 是根本没配模型 —— 强跑只会刷一轮注定失败的调用。
       * `backoff` 也保留：连续失败后立刻重试同样会失败,只是更快地烧钱。
       */
      const forcePastBatching =
        opts.force === true &&
        (decision.reason === "below-threshold" || decision.reason === "no-new-data")
      if (!decision.run && !forcePastBatching) {
        // debug 而不是 info：这条在稳态下每 6 小时一次，且绝大多数是
        // `disabled`（默认关着）—— 用 info 会把它变成日志噪声。
        this.options.logger.debug("work layer refresh skipped", { reason: decision.reason })
        return
      }
      this.options.logger.info("work layer refresh starting", {
        reason: decision.reason,
        forced: forcePastBatching,
        newMessages: decision.run ? decision.newMessages : 0,
      })

      /**
       * ★★ 建图在跑 → 整个 work 层让路（不只是 playbook）。
       *
       * ## 实测：两者抢同一个 LLM 网关，抽取被拖慢 3 倍
       *
       * 一次真机运行的时间线（`graph build started` 之后）：
       *
       * ```
       * 建图正忙时的单任务耗时：230s / 231s / 151s / 157s
       * 建图接近尾声时：        106s / 65s / 61s      ← 快 3 倍
       * 同期 kl-server stderr： 532 条 APIConnectionError（建图自己也在被限流）
       * 同期我们这侧：          13 次 llm retry，全是超时
       * ```
       *
       * 也就是两边都在被网关拒，而重试又加剧了拥塞。原来 `graphBusy()` 只挡
       * playbook 那一步 —— 那是我按"归纳是单次长请求、必然是输的那方"想的，
       * 但实测 facet 抽取（4 次串行调用/任务）被拖得更惨。
       *
       * ★ 让路是**零损失**的：语料不会跑掉，攒批判据下一轮照样成立。
       * 而硬抢的代价是真实的 —— 两边都慢，且都在烧重试。
       *
       * ★ 放在 `decideWorkRefresh` **之后**：那样日志里能看出"判据说该跑，
       * 只是建图占着"，而不是与"攒批不够"混成同一句 skipped。
       */
      /**
       * ★★ forge **先跑**，而且**从不让路**。
       *
       * 三条理由，都与它的性质有关：
       *
       * · **不碰 LLM 网关** —— 纯 stdlib Python、零模型调用，所以让它给建图
       *   让路没有任何收益（抢的不是同一个资源）；
       * · **免费且快** —— 实测 4400 条约 5 秒。而它产出的是语气/句长/时延/
       *   逐人 tone band 那一整套，也就是数字人**最先需要**的东西；
       * · **它的 publish 会重写 `SKILL.md`** —— 而那份索引表决定 ACP 路的
       *   agent 能不能发现 `references/work.md`。实测磁盘上那份还是旧的
       *   （缺 work.md 一行），于是 work 层写了产物却没人读 —— 整层白做的
       *   那个形态。让路时把 forge 一起跳过，等于让那个索引表永远修不好。
       *
       * 所以顺序是：**forge（快、免费、先出语气）→ work 层（慢、花钱、
       * 可以让路）→ 若 work 真的有产出，再 publish 一次让索引表跟上**。
       */
      await this.runForgeStep(this.plannedSince, this.plannedWindowDays)

      /**
       * ★★ 建图在跑 → **等一会儿再判**，而不是立刻放弃这一轮。
       *
       * ## 实测：原来那个 `return` 让 work 层永远抽不上
       *
       * 判据曾经是"`graphBusy()` 为真就 return"。看起来合理，实测下来是
       * 一个死循环 —— 因为建图**常常十几秒就失败**（上游那个
       * `'list' object has no attribute 'strip'` 类型 bug 会复发）：
       *
       * ```
       * 16:06:18  work layer refresh starting  {newMessages: 995}
       * 16:06:20  graph build started                    ← GraphSync 轮询触发
       * 16:06:22  forge run finished  {grade: A}
       * 16:06:22  work layer deferred                    ← 让路，然后 return
       * 16:06:36  graph build failed  'list' object…     ← 14 秒后就崩了
       * 16:08:14  distill tasks enqueued {created: 6}
       * （16:18 那一轮逐行重复，一模一样）
       * ```
       *
       * work 层在那 14 秒里让掉了一整轮（它本来要跑几十分钟），而崩完之后
       * 没人回头叫它。于是 `distill_tasks` 攒到 6 个 pending / **0 个 done**、
       * 游标停在 36719 落后 1043 条、`profile_facets` 4.5 小时没更新 ——
       * 全部对外无声，因为每一环单独看都"正常让路了"。
       *
       * ## 判据改成"它是真的在长跑吗"
       *
       * 短等一次再查：
       * · 十几秒内崩掉/跑完 → 这一轮照常抽，不白等；
       * · 仍在跑 → 那是真的长任务（Phase A 实测 60+ 分钟），让路是对的。
       *
       * ★ 等待期间用 `signal` 可中断：用户切范围/退登时不该还在这儿睡。
       * ★ 只等**一次**，不轮询到底：那会把"让路"变成"排队几十分钟"，
       *   而攒批判据下一轮照样成立（语料不会跑掉），没必要在这里耗着。
       */
      if (this.options.graphBusy?.() === true) {
        this.options.logger.info(
          "work layer waiting: graph build in progress (forge already ran)",
          {
            reason: decision.run ? decision.reason : "forced",
            waitMs: GRAPH_SETTLE_WAIT_MS,
          },
        )
        await this.sleep(GRAPH_SETTLE_WAIT_MS)
      }

      if (this.options.graphBusy?.() === true) {
        /**
         * ★ 等过之后仍在跑 = 真的长任务，这才让路。
         * forge 已经跑完（语气那一层是新的），所以这不是"什么都没做"。
         */
        this.options.logger.info("work layer deferred: graph build still running after wait", {
          reason: decision.run ? decision.reason : "forced",
        })
        return
      }

      /**
       * ★ 现建而不是"没有就静默返回"。
       *
       * 判据已经说了这一轮该跑（`decision.run`），此时拿不到 runner 只可能是
       * 还没登录 —— 那属于该说出来的状态，而不是悄悄跳过。原来那行
       * `if (runner === null) return` 正是"开了开关没反应"的根因。
       */
      this.runner ??= this.buildWorkRunner()
      const runner = this.runner
      if (runner === null) {
        this.options.logger.warn("work layer refresh skipped: no runner (not logged in)", {})
        return
      }
      const until = this.options.clock.now()
      runner.plan({ since: this.plannedSince, until, windowDays: WORK_WINDOW_DAYS })
      /**
       * 跑到排空。每个任务自己是一次事务边界（失败只标自己），所以这里
       * 只需要一个"还认领得到活吗"的循环。
       *
       * ★ 判据是 `runBatch` 的**返回条数**，不是 `progress().pending` ——
       * 与 `runRound` 那条同一个理由：任何一条认领不到的 pending
       * （facet 名已废 / 宽度已变 / attempts 打满 / 僵尸 running）都会让
       * `pending > 0` 恒成立，于是这个循环空转满 `WORK_MAX_ROUNDS` 轮
       * （每轮都白问一次数据库），然后带着"还没抽完"的错觉去写产物。
       */
      let guard = 0
      let yieldedToGraph = false
      while (guard < WORK_MAX_ROUNDS) {
        /**
         * ★★ 每批**之前**再查一次建图 —— 入口查一次不够。
         *
         * 实测时序（真机）：
         *
         * ```
         * 11:52:42  work layer refresh starting   ← 已经进了循环
         * 11:52:43  graph build started           ← 1 秒后建图才开始
         * 11:58:05  单任务耗时 168s               ← 于是照样在抢网关
         * ```
         *
         * 入口那道闸只在**这一轮开始时**成立，而建图是另一条链路
         * （`GraphSync` 的轮询）触发的 —— 两者随时可能交错。这一轮要跑
         * 几十分钟，期间建图开始的概率很高。
         *
         * ★ 让路时**不推进游标、不写产物**：这一轮等于没跑完，
         * 而下一轮攒批判据照样成立（语料不会跑掉）。直接 `return` 而不是
         * `break` 就是为了跳过下面的 `finalizeWorkLayer` —— 否则会把
         * "抽了一半"记成"抽到这里了"，那段语料永远不会再被抽。
         */
        if (this.options.graphBusy?.() === true) {
          yieldedToGraph = true
          break
        }
        const batch = await runner.runBatch(TASKS_PER_ROUND, this.scopedConversationIds())
        guard += 1
        this.emit(this.progress())
        if (batch.length === 0) break
      }
      if (yieldedToGraph) {
        /**
         * ★★ 让路时仍然**写产物**，只是不推游标。
         *
         * 两件事必须分开：
         *
         * · **不推游标** —— 这一轮没抽完，推了会把"抽了一半"记成"抽到这里了"，
         *   那段语料永远不会再被抽（`finalizeWorkLayer` 存在的理由）；
         * · **但要写产物** —— 已经抽出来的 facet 是真的、花过钱的。不写等于
         *   让这一轮的成本白烧，而且 `SKILL.md` 那份过期的索引表也永远修不好
         *   （实测：磁盘上那份缺 `references/work.md` 一行，于是 ACP 路的
         *   agent 根本不知道有这个文件 —— 整层白做的那个形态又回来了）。
         *
         * ★ 写产物是**幂等**的，且不花钱（纯渲染 + 一次文件写）。
         * 而 playbook 归纳要花钱，所以那一步跳过 —— 下一轮建图闲下来再跑。
         */
        this.writeWorkLayer()
        this.options.logger.info("work layer refresh yielded: graph build started mid-round", {
          roundsDone: guard,
          // ★ 说清"产物写了、游标没推" —— 否则下一轮重抽会看起来像 bug
          wroteArtifact: true,
          cursorAdvanced: false,
        })
        return
      }

      if (guard >= WORK_MAX_ROUNDS) {
        /**
         * 撞上限**要说出来**：那意味着还有任务没跑完，而下面照样会推进游标
         * （产物是按已有结论渲染的，那部分是真的）。不报的话"这一轮其实只
         * 抽了一半"就完全不可见 —— 而 `WORK_MAX_ROUNDS` 是个防呆闸，
         * 正常一轮不该撞到它。
         */
        this.options.logger.warn("work layer refresh hit round cap", {
          rounds: guard,
          pending: this.progress().pending,
        })
      }
      /**
       * ★★ 归纳工作套路 —— 必须在 `finalizeWorkLayer` **之前**。
       *
       * 那个函数会写产物，而它引用的是 `this.playbooks`（上一轮归纳的结果）。
       * 顺序反过来的话，这一轮新归纳的套路要等**下一次**写产物才出现 ——
       * 表现是"跑完一轮，套路那一节还是旧的"，而日志里看不出为什么。
       *
       * 失败不抛（见 `maybeInducePlaybooks`）：套路是增强，而 facet 那五节
       * 是独立且已验证过的，不该被它连坐。
       */
      await this.maybeInducePlaybooks()
      /**
       * ★ 只在真的抽完之后才写 + 推进游标（见 `finalizeWorkLayer`）。
       *
       * 提前推的话「这一轮失败了」会被记成「已经抽到这里了」，于是那段语料
       * 永远不会再被抽 —— 而产物里看不出缺了什么。
       */
      this.finalizeWorkLayer(latestSeq)

      /**
       * ★★ work 层写完产物之后**再 publish 一次**。
       *
       * ## 为什么需要第二次（而开头那次不够）
       *
       * 开头那次 forge 跑在 work 层**之前** —— 那时 `references/work.md`
       * 还是上一轮的（或者根本不存在）。而 `publish` 做两件与它有关的事：
       *
       * · 用**当前模板**重写 `SKILL.md` —— 那份文件里的参考件索引表决定
       *   ACP 路的 agent 能不能**发现** `references/work.md`。实测磁盘上
       *   那份还是旧的（缺 work.md 一行），于是产物写了却没人读；
       * · 按 `externalSkillFiles` 豁免保住 work.md（不当残留删掉）。
       *
       * 所以顺序必须是 **work 写完 → 再 publish**：那样索引表与产物同一轮对齐。
       *
       * ★ 这一次很便宜：forge 是纯 stdlib Python、零模型调用，实测 4400 条
       * 约 5 秒。为一个"agent 能不能读到"的问题跑 5 秒是划算的。
       *
       * ★ 失败只记 warn：产物已经写出去了，而索引表下一轮还有机会修。
       * 为一个收尾步骤让整轮记成失败会触发退避，那是把次要问题升级成主要问题。
       */
      try {
        await this.runForgeStep(this.plannedSince, this.plannedWindowDays)
        this.options.logger.info("forge re-published after work layer", {})
      } catch (error) {
        this.options.logger.warn("forge re-publish after work layer failed", {
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    } catch (error) {
      // 连续失败计数只在内存里（见 `work-refresh.ts` 的 `WORK_BACKOFF_MS`）：
      // 失败多半是配置，用户填完 key 会重启，那时该立刻重试。
      this.workFailures += 1
      this.workLastFailureAt = this.options.clock.now()
      const detail = error instanceof Error ? error.message : String(error)
      cursors.recordError(WORK_CONSUMER_ID, detail)
      this.options.logger.warn("work layer refresh failed", {
        detail,
        consecutiveFailures: this.workFailures,
      })
    }
  }

  /**
   * 渲染 work 层并落盘。**不抛**：调用方是排空后的收尾，抛了会把
   * 「蒸馏完成」这个状态吞掉，而画像其实已经产出了。
   *
   * ★ 为什么写文件而不是只留在 `profile_facets` 里
   *
   * 那张表**没有读者** —— persona 的 workspace 只装 forge 的 skill 包
   * （这正是 LLM 那半当年被关掉的原因：产出没人读、成本照付、且不报错）。
   * 所以 work 层要有意义，它的产物必须进那个包。
   */
  /**
   * work 层一轮的**收尾**：落盘 + 推进游标 + 清失败计数。
   *
   * ## ★★ 为什么必须是一个函数
   *
   * 自动轮与手动「开始学习」是两条独立的代码路径,而它们都要做这三件事。
   * 各写一份的后果实测踩到了：手动那条路**只写文件、不推游标**,于是下一次
   * 自动轮认为"有一大批新数据还没抽",把刚抽完的同一段语料再抽一遍 ——
   * 再付一次钱,而两次结论一模一样,所以从产物上看不出任何异常。
   *
   * 三件事绑在一起也是**语义**上正确的：产物写出来了才算"抽到这里了",
   * 而游标正是那句话的持久化形式。分开写就允许它们不一致。
   *
   * `ackSeq` 省略 = 手动那条路（它自己按任务队列排空,`latestSeq` 由这里现读）。
   */
  private finalizeWorkLayer(ackSeq?: number): void {
    const db = this.db
    if (db === null) return
    this.writeWorkLayer()
    try {
      const seq = ackSeq ?? new ChangelogRepository(db).head()
      const cursors = new ConsumerCursorRepository(db, this.options.clock)
      /**
       * ★ 先 register 再 ack —— 而不是直接 ack。
       *
       * `ack()` 是一条 `UPDATE ... WHERE consumer_id = ?`：**没有那一行时它
       * 静默什么都不做**（没有返回值、不抛错）。手动这条路不像自动轮那样
       * 先走过 `register`，所以直接 ack 会一声不响地丢掉水位 —— 表现正是
       * 这个函数存在的理由（下一轮重抽、再付一次钱）。
       *
       * register 是幂等的（`INSERT ... ON CONFLICT DO UPDATE` 刷心跳），
       * 所以自动轮那条路多走一次也没有副作用。
       */
      cursors.register(WORK_CONSUMER_ID, { required: false })
      cursors.ack(WORK_CONSUMER_ID, seq)
      this.workFailures = 0
      this.workLastFailureAt = null
    } catch (error) {
      /**
       * 推游标失败**不抛**：产物已经写出去了，而这一层是收尾。
       *
       * 代价是下一轮会重抽一次（多花一次钱）——那比让「蒸馏完成」这个状态被
       * 一个 ack 失败吞掉要好，后者会让用户以为画像没生成。
       */
      this.options.logger.warn("work layer cursor ack failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private writeWorkLayer(): void {
    const db = this.db
    const write = this.writeWorkFile
    if (db === null || write === null) return
    try {
      const facets = new ProfileFacetRepository(db).listByScope("global", "")
      const identity = new SelfIdentityRepository(db).get("dingtalk")
      /**
       * ★ 现读 forge 的产物，不缓存：work 层的收尾**紧跟在 forge 之后**
       * （见 `runRound` 的顺序注释），所以这一刻读到的是刚测出来的那份。
       * 缓存会让频率停在上一轮 —— 而那与抽取内容并排写在同一行，
       * 读的人会以为两个数是同一轮的。
       */
      const forgeContext = this.workForgeContext?.() ?? { askKinds: {}, staleAfterDays: 0 }
      const rendered = renderWorkLayer(facets, {
        displayName: identity?.displayNames[0] ?? "",
        nowMs: this.options.clock.now(),
        askKinds: forgeContext.askKinds,
        staleAfterDays: forgeContext.staleAfterDays,
        /**
         * ★★ 工作套路：**上一轮归纳的结果**，不是这里现算的。
         *
         * 归纳是一次几分钟的模型调用（实测 4 个 chunk / 6692 token / 150s），
         * 而 `writeWorkLayer` 是同步的收尾函数（`finalizeWorkLayer` 调它）。
         * 在这里 await 会把"写产物"这一步变成一个几分钟的异步过程，而它的
         * 调用方（`runRound` / `maybeRefreshWorkLayer`）都不预期那样。
         *
         * 所以归纳在 `maybeInducePlaybooks()` 里单独跑，结果存在
         * `this.playbooks`；这里只**引用**它。代价是新归纳的套路要等下一次
         * 写产物才出现 —— 而那正常就在同一轮的几秒之后（归纳先跑、写在后）。
         */
        ...(this.playbooks === null ? {} : { playbookSection: this.playbooks }),
      })
      write(rendered.content)
      this.options.logger.info("work layer written", {
        included: rendered.included,
        droppedLowConfidence: rendered.droppedLowConfidence,
        // `null` 内容是一个正常状态（还没抽出够格的结论），不是失败 ——
        // 但要能在日志里区分它与"写了 0 条"。
        removed: rendered.content === null,
        playbooks: this.playbooks?.playbooks.length ?? 0,
      })
    } catch (error) {
      this.options.logger.warn("work layer write failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 跑一轮 playbook 归纳（从 kl-graph 的 chunk 里）。
   *
   * ## ★★ 为什么与 facet 抽取分开，而不是塞进 runner
   *
   * 三个性质都不同：
   *
   * · **输入不同** —— facet 读 `messages`（我们的库），playbook 读 kl 的
   *   `chunks`（他们切好的 session）。后者要求图已经建过；
   * · **失败语义不同** —— facet 一个任务失败只影响它自己；playbook 抽取失败
   *   必须**保留上一版产物**（见 `inducePlaybooks` 的注释：一次网关抖动
   *   不该让套路消失）；
   * · **成本形状不同** —— 一次调用几分钟（实测 150s / 6692 token），
   *   而 facet 是每窗口一次的短调用。
   *
   * ## ★★ 必须与建图串行
   *
   * 实测：建图用 12 并发打同一个网关时，这条路**必然** HTTP 524
   * （Cloudflare 前置，源站 100s 内没返回完整响应）。所以 `graphBusy()`
   * 为真时直接跳过这一轮 —— 留给下一轮，而不是烧一次注定失败的调用。
   *
   * 失败**不抛**：这一层是增强。抛的话会打断 work 层的其余部分
   * （facet 那五节是独立的、已经验证过的）。
   */
  private async maybeInducePlaybooks(): Promise<void> {
    const db = this.db
    const openGraph = this.options.openGraphDb
    const llm = this.options.llmProvider.get()
    if (db === null || openGraph === undefined || llm === null) return

    // ★ 与建图串行 —— 见上面的注释
    if (this.options.graphBusy?.() === true) {
      this.options.logger.info("playbook induction skipped: graph build in progress", {})
      return
    }

    const identity = new SelfIdentityRepository(db).get("dingtalk")
    const selfNames = identity?.displayNames ?? []
    if (selfNames.length === 0) return

    const graph = openGraph()
    if (graph === null) return
    try {
      const candidates = readPlaybookChunks(graph.db, {
        selfNames,
        limit: PLAYBOOK_CANDIDATE_LIMIT,
      })
      if (candidates.length === 0) {
        this.options.logger.info("playbook induction skipped: no graph chunks yet", {})
        return
      }
      const result = await inducePlaybooks(candidates, {
        client: llm,
        selfNames,
        ...(this.abort === null ? {} : { signal: this.abort.signal }),
      })
      /**
       * ★ 只在**真的归纳出东西**时才替换 `this.playbooks`。
       *
       * 归纳出 0 条有两种可能（语料里确实没流程 / 这一轮取样不巧），
       * 而覆盖率那一行会说清是哪种。但**不该因此丢掉上一轮的套路** ——
       * 那些是花过钱、已经验证过结构的。
       */
      if (result.playbooks.length > 0) {
        this.playbooks = { playbooks: result.playbooks, coverage: result.coverage }
      }
      this.options.logger.info("playbook induction done", {
        playbooks: result.playbooks.length,
        droppedInvalid: result.droppedInvalid,
        calls: result.calls,
        // ★ 不叫 costTokens —— `redact.ts` 的 SENSITIVE_KEY 含 `token`，
        //   那个键会被整条遮成 "[unset]"（见 runner.ts 同名字段的长注释）
        usage: result.costTokens,
        // ★ 覆盖率进日志：换个人跑失效时这是第一个要看的数
        candidates: result.coverage.candidates,
        eligible: result.coverage.eligible,
        sampled: result.coverage.sampled,
      })
    } catch (error) {
      /**
       * ★ 失败只记 warn，**不动 `this.playbooks`**（保留上一版）。
       *
       * 见 `inducePlaybooks` 的注释：「这一轮没跑成」与「确实没有套路」
       * 必须分开 —— 混起来的话一次 524 就让产物里的套路消失，
       * 而那看起来与"他没有套路"一模一样。
       */
      this.options.logger.warn("playbook induction failed; keeping previous", {
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      graph.close()
    }
  }

  private emit(progress: DistillProgressView): void {
    const window = this.options.getWindow()
    if (window === null || window.isDestroyed()) return
    window.webContents.send(IPC_EVENTS.distillProgress, progress)
  }

  /**
   * 跑 forge 并把结果推给 UI。**不抛** —— 调用方在定时器里。
   *
   * ## ★ 结果必须留下来，不能只记日志
   *
   * 这里曾经只 `logger.warn` 一句就把 `ForgeRunResult` 丢掉了 ——
   * 而 `messages` / `turns` / `asks` / `files` / `grade` 恰好是回答
   * "蒸得怎么样"的那五个数。丢掉之后 UI 只有 `distill_tasks` 的计数，
   * 而那张表在只跑 forge 时恒空，于是界面永远显示「等待中」。
   *
   * ## 开跑就推一次
   *
   * forge 是分钟级的过程（pull 几千条 + 全量测量 + 发布）。不在开头推的话
   * 用户点了「开始」之后界面几分钟内一动不动 —— 与"没反应"无法区分。
   *
   * @param since 只蒸这个时间点之后的（unix ms）。`null` = 用 forge 自己的
   *   增量水位。**必须由调用方显式给**：默认成 `null` 会让"忘记传"
   *   静默退化成"忽略用户选的范围"，而那正是修复前的那个 bug。
   * @param windowDays 只**测量**最近这么多天。同样必须显式给，理由同上。
   *   `null` = 不限（全量测量，读 forge 配置的缺省）。
   */
  private async runForgeStep(since: number | null, windowDays: number | null): Promise<void> {
    const runForge = this.runForge
    if (runForge === null) return
    this.forge = { ...this.forge, running: true, step: null, reason: null }
    this.emit(this.progress())
    try {
      /**
       * ★ 每进一个阶段推一次事件。
       *
       * 三个阶段合起来几十秒到几分钟，而在此之前整个过程只有开始与结束
       * 两个事件 —— 界面上是一句"正在蒸馏…"干等到底。
       *
       * 每次都 emit：`step` 是这段时间里**唯一会变的东西**，
       * 不推的话渲染层拿到的仍是进入 pull 时那个快照。
       */
      const result = await runForge(
        this.abort?.signal,
        (step) => {
          this.forge = { ...this.forge, step }
          this.emit(this.progress())
        },
        since,
        windowDays,
      )
      this.forge = {
        running: false,
        // 跑完了就没有"正在哪一步"了；失败停在哪由 failedStep 表达
        step: null,
        lastRunAt: this.options.clock.now(),
        lastOk: result.ok,
        failedStep: result.failedStep,
        reason: result.reason,
        messages: result.messages,
        turns: result.turns,
        asks: result.asks,
        files: result.files,
        grade: result.grade,
      }
      if (!result.ok) {
        this.options.logger.warn("forge run failed", {
          failedStep: result.failedStep,
          reason: result.reason,
        })
      } else if (result.asks === 0) {
        /**
         * ★ `asks === 0` 是**失败**，不是「这个人没被问过」。
         *
         * 一条 ask 都没挖到时整个决策层退化成默认值，而风格层照常有数字
         * —— 产物看起来是完整的。forge 自己为这种情况专门判 D 级
         * （否则能拿到 B，而 B 读起来像"基本可信"，恰恰是最没有证据的
         * 那部分）。这里把它提到 `reason` 上，让它在界面上而不是只在
         * `fidelity.md` 里 —— 没人会主动去看那个文件。
         */
        this.forge.reason =
          "一条「别人问我」都没挖到，决策层整个是默认值而不是测量结论。" +
          "常见原因是单聊被误判成群聊或身份没回填完 —— 覆盖度等级会是 D。"
        this.options.logger.warn("forge mined no asks; decision layer is defaults", {
          messages: result.messages,
          turns: result.turns,
        })
      }
      /**
       * ★ 蒸出新画像 → 通知数字人换代。
       *
       * 不通知的话正在聊的会话会**继续用蒸馏前的 workspace**，直到它被
       * idle（10 分钟）或 LRU 淘汰 —— 而 agent 的画像全部来自 workspace
       * 里的文件。那 10 分钟里回复走旧画像，界面上看不出区别：
       * 用户刚点完「重新蒸馏」，以为已经生效了。
       *
       * `asks === 0` 那种"产物完整但决策层是默认值"的情况**也要**通知：
       * 那仍然是一份新产物（`publish` 真的写了文件），旧的那份已经被覆盖，
       * 不换代只会让内存里的认知与磁盘不一致。
       *
       * 失败（`!result.ok`）不通知：那时 publish 没跑到，磁盘上还是旧的。
       */
      if (result.ok) this.options.onProfileChanged?.()
      /**
       * ★★ 蒸馏完 → **立刻**踢一轮图谱同步（导出 + 判断要不要建图）。
       *
       * 不踢的话要等 `GraphSync` 的下一个 10 分钟周期，而用户刚点完
       * 「开始学习」正盯着界面 —— 那 0~10 分钟的静默就是"不会建图"的
       * 全部由来（见 `onCorpusReady` 的注释与那份实测时间线）。
       *
       * 失败（`!result.ok`）也踢：导出与蒸馏是两件事，蒸馏挂了不代表
       * 那批消息不该进图谱 —— 而 `decideAutoBuild` 自己会判要不要真建
       * （没新数据 / 没配网关时它跳过，不会白烧 LLM）。
       */
      this.options.onCorpusReady?.()
      this.emit(this.progress())
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.forge = {
        ...this.forge,
        running: false,
        /**
         * ★ 抛出时**保留** `step` —— 那是"崩在哪一步"的唯一线索。
         *
         * 正常失败走的是 `result.failedStep`（run 不抛，每步失败都带着
         * "停在哪"返回）。走到这个 catch 里说明是**意外**（进程崩、
         * 取消、Python 环境炸了），那时 `failedStep` 是 null，
         * 而清掉 step 就等于把唯一的定位信息也丢了。
         */
        lastRunAt: this.options.clock.now(),
        lastOk: false,
        reason: detail,
      }
      this.options.logger.warn("forge run threw", { detail })
      this.emit(this.progress())
    }
  }

  private requireDb(): SqliteDatabase {
    if (this.db === null) throw new AppError("DB_UNAVAILABLE", "尚未登录")
    return this.db
  }

  /**
   * 取 runner，没有就现建（见 `buildWorkRunner`）。
   *
   * ★ 建好之后存进 `this.runner`：`runRound()` 与 work 层那一轮都读它，
   * 而它们要的是**同一个** runner —— 各自新建一个会让"入队"与"取件"落在
   * 两个实例上，表现是任务建了却永远没人跑。
   */
  private requireRunner(): DistillRunner {
    this.runner ??= this.buildWorkRunner()
    const runner = this.runner
    if (runner === null) throw new AppError("DB_UNAVAILABLE", "尚未登录")
    return runner
  }

  /**
   * work 层的 runner —— **懒建**，用到时才造。
   *
   * ## ★★ 为什么不能在 `attach()` 里按开关建一次
   *
   * `attach()` 只在登录那一刻跑，而开关是用户随时可改的（设置页）。
   * 登录后打开开关时 runner 还是 null，于是那一轮 `if (runner === null)`
   * **静默返回** —— 用户看到"开了开关但没反应"，日志里一行都没有。
   * 懒建让开关的状态在真正用到的那一刻才被读，所以"打开就生效"，
   * 不需要重启也不需要重新登录。
   *
   * 每次现建而不是缓存：`llm` 是 `LlmHolder` 的**快照**（用户改网关后
   * holder 会 reconfigure，缓存住的 runner 会一直用旧 client）；
   * `selfNames` 同理，身份确认是登录之后才发生的事。构造本身很便宜
   * （几个字段赋值），而缓存一个含过期依赖的对象是真的会出错。
   *
   * 未登录返回 null —— 调用方据此跳过这一轮（那时也没有语料可抽）。
   */
  private buildWorkRunner(): DistillRunner | null {
    const db = this.db
    if (db === null) return null
    const identity = new SelfIdentityRepository(db).get("dingtalk")
    return new DistillRunner({
      db,
      clock: this.options.clock,
      logger: this.options.logger,
      // 现取 holder 的当前 client：用户改了网关/模型之后这一轮就用新的。
      llm: this.options.llmProvider.get(),
      /**
       * 本人显示名进 prompt。
       *
       * 身份未确认时是空数组 —— 那时守卫会拒掉全部语料，所以这里
       * 空着不会造成"用错名字"，只会让任务全 skipped（且原因写清了）。
       */
      selfNames: identity?.displayNames ?? [],
      /**
       * ★★ 落库前的脱敏名单 —— 真实姓名从库里现取。
       *
       * 由宿主给而不是写死在 `packages/distill` 里：那个包不知道谁是同事。
       * 写死一张名单等于换个用户就失效，而失效的表现是**静默的**
       * （守卫恒放行，产物照写，人名照进 skill 包）。
       */
      forbiddenTerms: this.forbiddenTerms(db),
      newId: () => randomUUID(),
    })
  }

  /**
   * 结论正文里不许出现的字面量：**真实姓名** + 第三方商标。
   *
   * ## ★ 为什么要过滤长度
   *
   * 两个字的中文名会大量撞上普通词（「明明」「容易」「健康」都可能是花名）——
   * `scripts/check-no-local-data.mjs` 的 `CJK_NAME_MIN_LENGTH` 那段长注释
   * 记录了这个代价，而它那边的取舍是"宁可误报，人工确认后进白名单"。
   *
   * 这里的取舍**相反**：误伤会把一条合格的结论无声丢掉（用户看不到，
   * 也没人来确认），所以下限取 3 —— 三字中文名撞词率已经很低，
   * 而两字名带来的误伤会持续、静默地削薄产物。
   *
   * ★ 代价要写明：真有同事叫两字名时，那个名字不会被这道守卫拦住。
   * 那时的防线是 prompt 第 8 条 + `check:no-local-data`（产物若进仓库）。
   *
   * ## ★ 为什么本人的名字也在名单里
   *
   * `work.md` 通篇讲的就是本人，所以正文里出现"某某会先确认现象"这种
   * 第三人称自述是噪音；更要紧的是那份产物可能被分享出去。标题那一处
   * 由渲染器单独处理（那是刻意的、且是唯一一处）。
   */
  private forbiddenTerms(db: SqliteDatabase): readonly string[] {
    const MIN_LENGTH = 3
    const terms = new Set<string>(FORBIDDEN_BRAND_TERMS)
    try {
      /**
       * 语料里出现过的**发送者显示名** —— 那就是同事的真实姓名/花名。
       *
       * 从 messages 现取而不是维护一张表：那张表不存在，而这个查询是
       * `SELECT DISTINCT`（实测本机 36 个名字），每轮 work 层跑一次的成本
       * 可以忽略。
       */
      const rows = db
        .prepare<
          [],
          { name: string | null }
        >("SELECT DISTINCT sender_display_name AS name FROM messages " + "WHERE sender_display_name IS NOT NULL AND sender_display_name != ''")
        .all()
      for (const row of rows) {
        const name = (row.name ?? "").trim()
        if (name.length >= MIN_LENGTH) terms.add(name)
      }
      const identity = new SelfIdentityRepository(db).get("dingtalk")
      for (const name of identity?.displayNames ?? []) {
        if (name.trim().length >= MIN_LENGTH) terms.add(name.trim())
      }
    } catch (error) {
      /**
       * 读不出来时**不抛**，但要留痕。
       *
       * 抛的话整轮 work 层失败；而静默返回空名单更糟 —— 那等于关掉这道守卫，
       * 且没有任何迹象。折中：返回已经收集到的部分并 warn，让"守卫变弱了"
       * 这件事在日志里可见。
       */
      this.options.logger.warn("deidentify term list incomplete", {
        detail: error instanceof Error ? error.message : String(error),
        collected: terms.size,
      })
    }
    return [...terms]
  }
}
