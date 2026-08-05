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
import { DistillRunner } from "@mycontext/distill"
import {
  DistillSourceRepository,
  DistillTaskRepository,
  ProfileFacetRepository,
  SelfIdentityRepository,
  type SqliteDatabase,
} from "@mycontext/store"
import { IPC_EVENTS, type DistillProgressView } from "@mycontext/ipc-contract"

/** 每轮跑几个任务。小批是为了让"停止"有响应，不是为了限流。 */
const TASKS_PER_ROUND = 2
/** 轮间隔。任务本身几十秒，这个间隔只是让事件循环喘口气。 */
const ROUND_INTERVAL_MS = 5_000
/** 自动重蒸的缺省周期。见 `DistillServiceOptions.autoIntervalMs`。 */
const AUTO_INTERVAL_MS = 6 * 60 * 60_000

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
   */
  runForge?: (
    signal?: AbortSignal,
    onStep?: (step: ForgeStepName) => void,
    since?: number | null,
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
   * 是否跑 LLM 抽取那半（写 `profile_facets`）。
   *
   * ★ 默认 **false**。那些 facet 现在没有任何读者（persona 的 workspace 只装
   * forge 的产物），而每个任务是一次上万 token 的模型调用 —— 产出没人读、
   * 成本照付，且不报错。
   *
   * 留成开关而不是删掉代码：forge 不测 `identity` / `expertise` 这类语义维度，
   * 将来要把它们作为补充接回来时，接的是同一份 runner。
   */
  llmFacets?: boolean
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
      ) => Promise<ForgeRunOutcome>)
    | null = null
  private runner: DistillRunner | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<unknown> | null = null
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
   * 自动重蒸的定时器。与 `timer`（LLM 轮次）分开：那个跑完就停，
   * 这个要一直活着 —— 混用会让"抽完了"顺手把自动重蒸也停掉。
   */
  private autoTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: DistillServiceOptions) {}

  attach(
    db: SqliteDatabase,
    runForge?: (
      signal?: AbortSignal,
      onStep?: (step: ForgeStepName) => void,
      since?: number | null,
    ) => Promise<ForgeRunOutcome>,
    resetForge?: () => boolean,
  ): void {
    this.db = db
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
     */
    if (this.options.llmFacets === true) {
      const identity = new SelfIdentityRepository(db).get("dingtalk")
      this.runner = new DistillRunner({
        db,
        clock: this.options.clock,
        logger: this.options.logger,
        // 取当前 client 快照（llmFacets 默认关，runner 极少建；配置变了要重建）
        llm: this.options.llmProvider.get(),
        /**
         * 本人显示名进 prompt。
         *
         * 身份未确认时是空数组 —— 那时守卫会拒掉全部语料，所以这里
         * 空着不会造成"用错名字"，只会让任务全 skipped（且原因写清了）。
         */
        selfNames: identity?.displayNames ?? [],
        newId: () => randomUUID(),
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
        if (this.inFlight !== null) return
        this.abort = new AbortController()
        /**
         * ★ 自动重蒸走 `null`（forge 自己的增量水位），**不**沿用用户选的范围。
         *
         * 那个范围是"这次重来一遍，回溯多远"的意思，是一次性的动作参数；
         * 而自动重蒸要的是"把新攒的语料续上"。拿 180 天去跑定时任务
         * 等于每 6 小时重测半年 —— 而 `--since auto` 正是为这件事存在的。
         */
        this.inFlight = this.runForgeStep(null).finally(() => {
          this.inFlight = null
          this.abort = null
        })
      }, interval)
      this.autoTimer.unref?.()
    }
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

    if (this.options.llmFacets !== true) {
      // forge 是全量重算，不需要切窗；直接跑一次就是完整的一轮。
      if (this.inFlight === null) {
        /**
         * ★ 每次起跑都换一个新的 AbortController。
         *
         * 复用同一个的话第一次 `stop()` 之后它永久是 aborted 状态，
         * 于是之后每次「开始」都会立刻被自己取消 —— 表现是点了没反应。
         */
        this.abort = new AbortController()
        this.inFlight = this.runForgeStep(since).finally(() => {
          this.inFlight = null
          this.abort = null
        })
      }
      return this.progress()
    }

    const runner = this.requireRunner()
    runner.plan({
      since,
      until,
      ...(input.windowDays === undefined ? {} : { windowDays: input.windowDays }),
    })

    if (this.timer === null) {
      this.timer = setInterval(() => {
        if (this.inFlight !== null) return
        this.inFlight = this.runRound().finally(() => {
          this.inFlight = null
        })
      }, ROUND_INTERVAL_MS)
      this.timer.unref?.()
    }
    // 立刻跑一轮，不等第一个间隔 —— 否则用户点了"开始"要等 5 秒才看到动静
    if (this.inFlight === null) {
      this.inFlight = this.runRound().finally(() => {
        this.inFlight = null
      })
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
    const counts =
      this.options.llmFacets === true
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
   */
  private scopedConversationIds(): readonly string[] {
    const db = this.db
    if (db === null) return []
    const row = new DistillSourceRepository(db).list().find((source) => source.kind === "chat")
    if (row === undefined || !row.enabled) return []
    return row.scope.conversationIds ?? []
  }

  /** 跑一轮。**不抛**：调用方是定时器。 */
  private async runRound(): Promise<void> {
    const runner = this.runner
    if (runner === null) return
    try {
      const results = await runner.runBatch(TASKS_PER_ROUND, this.scopedConversationIds())
      const progress = this.progress()
      this.emit(progress)

      // 没有任务可跑了 → 停定时器（不然它会空转到进程退出）
      if (results.length === 0 && progress.pending === 0) {
        this.stop()
        this.options.logger.info("distill drained", {
          done: progress.done,
          skipped: progress.skipped,
          failed: progress.failed,
          facets: progress.facetCount,
          costTokens: progress.costTokens,
        })
        this.emit(this.progress())
        /**
         * 抽完之后跑 forge。
         *
         * 放在**排空之后**而不是每轮都跑：forge 是全量重算（切窗对它没意义），
         * 每轮跑一次等于把同一份语料测 N 遍，而结论一模一样。
         *
         * `await` 它：不 await 的话「蒸馏完成」这个状态会在 skill 还没生成时
         * 就推给 UI，用户随即去看画像，看到的是上一轮的产物。
         */
        await this.runForgeStep(this.plannedSince)
      }
    } catch (error) {
      this.options.logger.warn("distill round failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
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
   */
  private async runForgeStep(since: number | null): Promise<void> {
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

  private requireRunner(): DistillRunner {
    const runner = this.runner
    if (runner === null) throw new AppError("DB_UNAVAILABLE", "尚未登录")
    return runner
  }
}
