/**
 * 管控层（PersonaSupervisor）。★ **刻意不含 LLM。**
 *
 * ## 为什么管控层不调模型
 *
 * 需求原文要求「管控住 agent 本身也要足够稳定」。一旦它调模型，
 * 就继承了模型的全部失败模式 —— 超时、限流、幻觉出一个不存在的 conversationId。
 * 而它的职责（路由、限流、生命周期）**全都是确定性的**，
 * 用代码写完全够，还能 100% 单测覆盖。
 *
 * **智能只放在叶子节点（ConversationAgent）。**
 *
 * ## ★ 它是订阅者，不是「监听某些会话的东西」
 *
 * 首版有一个 per-conversation 的 `listening` 开关，默认关，准入闸第二条就是
 * 「没开监听 → 丢」。实测的后果：投递 200 条消息，准入闸拒掉 **184 条**，
 * 绝大多数就是这一条 —— 也就是**默认什么都不做**，而用户要逐个会话去开开关
 * （这个账号有 86 个会话，逐个开是不可能的）。
 *
 * 现在的模型是：**新消息一律进管控层**，管控层是消息流的订阅者。
 * 「要不要发出去」由**回复模式 + 白名单**决定（那是 policy 的事），
 * 「要不要生成」由触发条件收窄（群里只处理 @我，否则每条消息都过一次模型）。
 *
 * 这个区别不只是默认值：`listening` 把「我关注哪些会话」与「哪些能自动发」
 * 混成了一个开关，而这两件事的风险完全不同 —— 前者错了只是白花 token，
 * 后者错了是以本人身份误发。
 *
 * ## 职责
 *
 * 1. 订阅入站消息（进程内信号，快）+ Outbox 兜底扫描（慢）
 * 2. 路由：conversationId → ConversationAgent（按需创建）
 * 3. 生命周期：LRU 上限常驻，空闲回收
 * 4. 准入闸：只剩**客观**判据（见 `admit`）
 * 5. 限流：同会话短时合并成一批；全局并发 turn 有上限
 * 6. 全局 kill switch：立刻停所有自动发送
 * 7. 崩溃恢复：单个会话 Agent 崩溃只影响该会话
 *
 * ## 为什么每会话一个 Agent 而不是一个全局 Agent 加会话参数
 *
 * 每会话独立 session 才能让 harness 维护该会话独立的上下文与滚动摘要；
 * 且一个会话的 prompt injection 或崩溃不会污染其他会话。
 * 代价是 session 数量 —— 用 LRU + 空闲回收控制住。
 */
import { MS_PER_MINUTE, type Clock, type Logger } from "@mycontext/kernel"
import type { ConversationRow, MessageRow, SqliteDatabase } from "@mycontext/store"
import {
  Mailbox,
  MAX_DIRECT_DRAFTABLE_AGE_MS,
  MAX_GROUP_DRAFTABLE_AGE_MS,
  READ_REPLY_EXPIRY_MS,
  type DropReason,
} from "./mailbox.js"

/** LRU 常驻上限。每个会话一份 instance state，8 个是内存与响应速度的折中。 */
export const MAX_RESIDENT_AGENTS = 8
/** 空闲回收阈值。 */
export const IDLE_EVICT_MS = 10 * MS_PER_MINUTE
/** 全局并发 turn 上限。超出的排队而不是并发打模型（限流会让它们一起失败）。 */
export const MAX_CONCURRENT_TURNS = 3

export interface ConversationConfig {
  /** `yolo` = 不过判定闸直接发（见 policy.ts 的 REPLY_MODES 注释）。 */
  replyMode: "auto" | "draft" | "yolo"
  /**
   * 触发条件。四种，与界面上那四个选项一一对应：
   * `none` 不触发 / `mention` @我时 / `all` 每条消息 / `keyword` 命中关键词。
   *
   * `none` 在 `admit` 里**最先**被判掉（见那里），所以它不进 `matchesTrigger`
   * 的 switch —— 那个函数只回答"这条消息命中了吗"，而 `none` 的答案
   * 与消息内容无关。
   */
  triggerMode: "none" | "all" | "mention" | "keyword"
  keywords: readonly string[]
}

export interface AdmissionInput {
  message: MessageRow
  conversation: ConversationRow
  /**
   * 该会话的配置。`null` = 从没配过。
   *
   * ★ `null` 意味着**用缺省**，而缺省**按会话类型分流**（见
   * `resolveTriggerMode`）：群聊只处理 @我，单聊**不触发**
   * （没主动配过的私聊默认不打扰）。
   */
  config: ConversationConfig | null
  /** 该消息是否 @了本人 */
  mentionsSelf: boolean
  killSwitchActive: boolean
  now: number
  conversationRead: boolean
  /** 同会话中是否已有时间更晚的本人消息，表示这一轮已经被回复覆盖。 */
  turnAnswered: boolean
  /** 会话级排除由 store 的统一分类视图给出。 */
  conversationExclusion?: "bot_channel" | "self_conversation" | null
}

export type AdmissionVerdict = { ok: true } | { ok: false; reason: DropReason }

/**
 * 没配过时的缺省触发条件，**按会话类型分流**：
 *
 * · 单聊 → `none`（不触发）。用户没主动设过的单聊，默认不打扰 ——
 *   数字人不会对每一条私聊自动起草稿。想让它管，去会话设置里显式选。
 * · 群聊 → `mention`（只在 @我 时）。群里每条都处理是骚扰、也在烧 token，
 *   而 @我 是"这条确实找我"的明确信号。
 *
 * ★ 为什么单聊默认从 `mention`（实际等于"全回"）改成 `none`：
 * 早先的默认是"单聊不受 mention 限制、每条都回"，理由是"单聊里对方说的
 * 每句本来就是对你说的"。但那让**没配过的单聊**在用户毫不知情时就开始
 * 起草稿 —— 而"默认不动，除非我说要动"才是更稳妥的产品预期。
 * 显式设成别的模式仍然照选的来（见 `resolveTriggerMode`）。
 */
export const DEFAULT_TRIGGER_MODE_DIRECT = "none" as const
export const DEFAULT_TRIGGER_MODE_GROUP = "mention" as const

/**
 * 该会话**生效的**触发模式：配了就用配的，没配按会话类型取缺省。
 *
 * 单独抽出来是因为 `admit` 的最前面（判 `none` 短路）与 `matchesTrigger`
 * （判命中）都要用同一个值 —— 两处各写一遍 `?? 缺省` 迟早分叉。
 */
function resolveTriggerMode(input: AdmissionInput): ConversationConfig["triggerMode"] {
  if (input.config !== null) return input.config.triggerMode
  return input.conversation.type === "direct"
    ? DEFAULT_TRIGGER_MODE_DIRECT
    : DEFAULT_TRIGGER_MODE_GROUP
}

/**
 * 准入闸。**全是确定性判断**，命中即丢弃并记原因。
 *
 * ## ★ 只剩客观判据
 *
 * 五条里没有一条是"用户没配"：
 * · `kill_switch` —— 用户明确按下的急停；
 * · `origin_agent` —— 数字人自己发的（会自问自答）；
 * · `is_self` —— 本人发的（数字人代表的就是本人）；
 * · `bot_channel` —— 机器人/告警会话，回它没有意义；
 * · `self_conversation` —— 与自己的单聊，不存在需要回复的对方；
 * · `trigger_not_matched` —— 群里没 @我。
 *
 * 前五条是"这条消息在客观上不该触发"，最后一条是**成本闸**（不是权限闸）。
 * 删掉 `not_listening` 之后，"用户没管过这个会话"不再等于"丢掉"。
 *
 * 顺序有讲究：先判最便宜的，最后判需要查 mention 表的。
 */
export function admit(input: AdmissionInput): AdmissionVerdict {
  if (input.killSwitchActive) return { ok: false, reason: "kill_switch" }

  /**
   * ★ 「不触发」排在最前面（比 kill switch 之后的其余判据都早）。
   *
   * 它是用户对**这个会话**的明确意愿，而其余判据是"这条消息是否该触发"。
   * 放在后面的话，一个明说了"别管"的会话仍然要走完 exclusion 查询、
   * mention 表查询 —— 那是白付的成本，而结果一定是丢弃。
   */
  if (resolveTriggerMode(input) === "none") {
    return { ok: false, reason: "trigger_none" }
  }

  // 数字人自己发的消息不该触发它自己（否则会自问自答）
  if (input.message.origin === "agent") return { ok: false, reason: "origin_agent" }

  // 本人发的消息不需要数字人回（它代表的就是本人）
  if (input.message.isSelf === true) return { ok: false, reason: "is_self" }

  if (input.conversationExclusion !== null && input.conversationExclusion !== undefined) {
    return { ok: false, reason: input.conversationExclusion }
  }

  if (input.conversation.isBotChannel) return { ok: false, reason: "bot_channel" }

  if (input.turnAnswered) return { ok: false, reason: "already_answered" }

  /**
   * ★ 无条件的年龄上限，**先于** `conversationRead` 那条判。
   *
   * 那条只在"已明确读过"时生效，于是未读的群完全没有年龄上限 ——
   * 实测给一条 19 天前的群消息起过草稿（历史回填灌进来的）。
   * 见 `MAX_GROUP_DRAFTABLE_AGE_MS` 的注释。
   */
  const maxAge =
    input.conversation.type === "direct" ? MAX_DIRECT_DRAFTABLE_AGE_MS : MAX_GROUP_DRAFTABLE_AGE_MS
  if (input.now - input.message.sentAt > maxAge) {
    return { ok: false, reason: "stale_message" }
  }

  if (input.conversationRead && input.now - input.message.sentAt > READ_REPLY_EXPIRY_MS) {
    return { ok: false, reason: "stale_message" }
  }

  if (!matchesTrigger(input)) return { ok: false, reason: "trigger_not_matched" }

  return { ok: true }
}

function matchesTrigger(input: AdmissionInput): boolean {
  const mode = resolveTriggerMode(input)
  switch (mode) {
    /**
     * `none` 在 `admit` 里已经先判掉了（那里 return `trigger_none`），
     * 所以正常路径走不到这里。仍然写上是为了让 switch 穷尽 ——
     * 不写的话 TS 会因为缺分支报错，而"加个 default: return true"
     * 会让将来新增一种模式时**默认放行**（错的那一侧）。
     */
    case "none":
      return false
    case "all":
      return true
    case "mention":
      /**
       * ★ 单聊**不受** mention 限制：显式把一个单聊设成 `mention` 时，
       * 仍按"对方每句都是对你说的"处理（钉钉单聊里通常也 @不了人）。
       *
       * 注意这条只在**显式配了 `mention`** 的单聊上才会走到 —— 没配过的
       * 单聊缺省是 `none`（见 `resolveTriggerMode`），在 `admit` 最前面
       * 就短路了，根本进不到这里。
       */
      if (input.conversation.type === "direct") return true
      // 群聊默认只回 @我 的：群里每条都回是骚扰，也是在烧 token
      return input.mentionsSelf
    case "keyword": {
      const text = input.message.contentText ?? ""
      const keywords = input.config?.keywords ?? []
      return keywords.some((keyword) => keyword !== "" && text.includes(keyword))
    }
  }
}

export interface ResidentAgent {
  conversationId: string
  lastActiveAt: number
  /**
   * 这个 workspace 是按哪一代画像建的。
   *
   * ★ 存"代"而不是"有没有建过"：常驻的会话在 `acquire` 里会短路返回，
   * 于是蒸馏出的新画像对它不生效 —— 而 workspace 里的文件是 agent
   * 唯一的画像来源。用代号比对就能在**不打断在途 turn** 的前提下
   * 让它重新装一次（`createAgent` 本身是幂等的）。
   */
  profileGeneration: number
}

export interface SupervisorOptions {
  db: SqliteDatabase
  clock: Clock
  logger: Logger
  /** 创建/销毁会话 Agent 的钩子（真实实现起 ACP session；测试注入桩） */
  createAgent: (conversationId: string) => Promise<void>
  disposeAgent: (conversationId: string) => Promise<void>
  /** 处理一批消息（叶子节点：这里才有 LLM） */
  handleBatch: (conversationId: string, messageIds: readonly string[]) => Promise<void>
  maxResident?: number
  idleEvictMs?: number
  maxConcurrentTurns?: number
  /**
   * 同会话消息的合并窗口（ms）。缺省 3 秒。
   *
   * 透出来是为了**让门禁能关掉它**：不关的话"消费者在 handler 里偷偷
   * 处理"这件事会被窗口吃掉（tick 拿到空批次），断言恒真恒绿 ——
   * 那条门禁就等于没有。生产路径不传，仍用 3 秒缺省。
   */
  batchWindowMs?: number
  /** 「对方说完了」的静默期（见 Mailbox 的 DEFAULT_QUIET_MS）。只在测试里传。 */
  quietMs?: number
  /** 一批的条数上限。缺省见 `MAX_BATCH_SIZE`。 */
  maxBatchSize?: number
}

export class PersonaSupervisor {
  readonly mailbox: Mailbox
  /** LRU：Map 的插入顺序即访问顺序（重新 set 会移到末尾） */
  private readonly residents = new Map<string, ResidentAgent>()
  /**
   * 当前画像的"代"。蒸馏成功一次就 +1。
   *
   * ## ★ 为什么需要它：一个 10 分钟的静默窗口
   *
   * `acquire()` 对已常驻的会话直接返回，不调 `createAgent` —— 而装 skill
   * 就在 `createAgent` 里。所以蒸馏完成后，正在聊的那些会话会**继续用
   * 蒸馏前的 workspace**，直到它被 idle（10 分钟）或 LRU 淘汰掉。
   *
   * 那 10 分钟里回复走的是旧画像（或者压根没有画像时的兜底文案），
   * 而界面上看不出任何区别 —— 用户刚点完「重新蒸馏」，以为生效了。
   * 这正是这个项目里反复出现的那类失效：**成功返回，但结果不对**。
   *
   * 用"代"而不是强制 release：release 要 dispose agent（撤 MCP token），
   * 对一个正在生成草稿的会话做那件事会打断它。而 `createAgent` 是幂等的
   * （mkdirSync recursive / cpSync 覆盖 / INSERT ON CONFLICT），
   * 重跑一次只是把文件刷新到最新 —— 在途的 turn 不受影响。
   */
  private profileGeneration = 0
  private runningTurns = 0
  private killSwitch = false
  /**
   * 热改过的运行参数。
   *
   * 与 `options` 分开而不是直接改 options：options 是构造时的意图
   * （来自库或缺省），overrides 是"用户后来改的"。分开之后
   * "为什么现在跑的是 1 而不是 3"有一条清晰的来源链。
   */
  private readonly overrides: {
    maxResident?: number
    maxConcurrentTurns?: number
    idleEvictMs?: number
  } = {}

  constructor(private readonly options: SupervisorOptions) {
    this.mailbox = new Mailbox({
      db: options.db,
      clock: options.clock,
      ...(options.batchWindowMs === undefined ? {} : { batchWindowMs: options.batchWindowMs }),
      ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
      ...(options.maxBatchSize === undefined ? {} : { maxBatchSize: options.maxBatchSize }),
    })
  }

  get killSwitchActive(): boolean {
    return this.killSwitch
  }

  /**
   * 全局 kill switch。
   *
   * 立刻停止**所有**自动发送。这是用户在发现数字人说错话时的第一反应，
   * 所以它必须是同步生效的一个开关，不能是"下一轮生效"。
   */
  setKillSwitch(active: boolean): void {
    this.killSwitch = active
    this.options.logger.warn("persona kill switch toggled", { active })
  }

  /** 入站：准入闸 + 入队。返回是否被接纳。 */
  onInbound(
    input: Omit<
      AdmissionInput,
      "killSwitchActive" | "now" | "conversationRead" | "turnAnswered"
    > & {
      conversationRead?: boolean
      turnAnswered?: boolean
    },
  ): boolean {
    const verdict = admit({
      ...input,
      killSwitchActive: this.killSwitch,
      now: this.options.clock.now(),
      conversationRead: input.conversationRead ?? false,
      turnAnswered: input.turnAnswered ?? false,
    })
    if (!verdict.ok) {
      this.mailbox.drop(input.message.id, verdict.reason)
      return false
    }
    return this.mailbox.push({
      messageId: input.message.id,
      conversationId: input.message.conversationId,
    })
  }

  /**
   * 跑一轮调度。
   *
   * 由定时器驱动（而不是入队时立刻处理）：合并窗口需要"等一下"，
   * 而在入队路径上 sleep 会把采集线程也堵住。
   *
   * ## ★ 并发是真并发 —— 曾经不是
   *
   * 首版这个循环里写的是 `await this.options.handleBatch(...)`，于是
   * **每个 turn 串行**跑完才轮到下一个：`runningTurns` 永远只到 1，
   * `MAX_CONCURRENT_TURNS` 这个上限**从未生效过**。
   *
   * 后果不是"更慢"这么简单：三个会话同时来消息时，第三个要等前两个
   * 各自一次完整的模型调用（实测每次 3-8 秒）—— 也就是 20 秒后才开始，
   * 而目标是 15-20 秒内响应 @我。
   *
   * 而当时的测试断言是 `dispatched + skippedBusy === 2`（一个和），
   * 那个和在串行与并发两种实现下**都成立** —— 所以门禁没发现。
   * 现在的断言直接看**并发峰值**。
   */
  async tick(): Promise<{ dispatched: number; skippedBusy: number }> {
    if (this.killSwitch) return { dispatched: 0, skippedBusy: 0 }

    let skippedBusy = 0
    /** 本轮起的 turn。全部起完之后一起 await —— 那才是"并发"。 */
    const running: Promise<void>[] = []

    for (const conversationId of this.mailbox.pendingConversations()) {
      const limit =
        this.overrides.maxConcurrentTurns ?? this.options.maxConcurrentTurns ?? MAX_CONCURRENT_TURNS
      if (this.runningTurns >= limit) {
        // 排队而不是并发打模型：超过上限的并发只会让它们一起触发限流。
        skippedBusy += 1
        continue
      }

      const batch = this.mailbox.takeBatch(conversationId)
      if (batch.entries.length === 0) continue
      const messageIds = batch.entries.map((entry) => entry.messageId)

      if (batch.overflow > 0) {
        /**
         * 溢出必须记出来，而不是静默取最新 N 条。
         *
         * 不记的话"合并了 200 条"与"只看了最新 30 条"在结果上分不出来，
         * 而后者意味着 agent 漏看了前面的上下文 —— 回复会显得没头没尾。
         */
        this.options.logger.warn("inbox batch overflowed", {
          conversationId,
          taken: messageIds.length,
          dropped: batch.overflow,
        })
      }

      /**
       * `acquire` 仍然 await：它可能要起一个新 agent（物化画像、装 skill），
       * 而那一步必须在 `handleBatch` 之前完成。它是本地 IO（毫秒级），
       * 不是模型调用，所以串行它不影响响应时间。
       */
      await this.acquire(conversationId)
      this.runningTurns += 1
      running.push(this.runTurn(conversationId, messageIds))
    }

    /**
     * 等本轮全部收尾。
     *
     * 用 `allSettled` 而不是 `all`：`runTurn` 内部已经 catch 了，
     * 但如果哪天它漏了一个，`all` 会让整轮 tick 抛出去，
     * 而定时器里那个 catch 只会记一行 —— 其余会话的 `markProcessed`
     * 就都没跑（消息状态与内存队列脱同步）。
     */
    await Promise.allSettled(running)
    await this.evictIdle()
    return { dispatched: running.length, skippedBusy }
  }

  /**
   * 跑一个会话的一轮。**不抛** —— 单个会话失败只影响该会话。
   *
   * 抽出来是并发所必需的：内联在循环里就只能 `await`，
   * 而那正是"并发上限从未生效"的原因。
   */
  private async runTurn(conversationId: string, messageIds: readonly string[]): Promise<void> {
    try {
      await this.options.handleBatch(conversationId, messageIds)
      this.mailbox.markProcessed(messageIds)
      this.mailbox.markTurnSucceeded(conversationId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      /**
       * ★ 连续失败到上限就放弃这一批。
       *
       * 不放弃的话一条必然失败的输入（超长、含让网关 400 的字符）会
       * **永远**每 8 秒重试一次 —— 而表现只是"这个会话一直没回复"。
       */
      const abandoned = this.mailbox.markTurnFailed(conversationId, messageIds, detail)
      this.options.logger.warn("conversation agent turn failed", {
        conversationId,
        detail,
        attempts: this.mailbox.failureCount(conversationId),
        abandoned,
      })
    } finally {
      this.runningTurns -= 1
    }
  }

  /** 按需创建 + LRU 淘汰。 */
  private async acquire(conversationId: string): Promise<void> {
    const now = this.options.clock.now()
    const existing = this.residents.get(conversationId)
    if (existing !== undefined) {
      /**
       * ★ 画像换代了就重装一次，即使这个会话还常驻着。
       *
       * 不这么做的话蒸馏完成后正在聊的会话要等 10 分钟（idle 淘汰）
       * 才用得上新画像，而那段时间里它安静地用着旧的。
       * 见 `profileGeneration` 的注释。
       */
      if (existing.profileGeneration !== this.profileGeneration) {
        await this.options.createAgent(conversationId)
        this.options.logger.info("persona workspace refreshed for new profile", {
          conversationId,
          from: existing.profileGeneration,
          to: this.profileGeneration,
        })
      }
      // 重新 set 把它移到 Map 末尾 —— 这就是 LRU 的"最近使用"
      this.residents.delete(conversationId)
      this.residents.set(conversationId, {
        conversationId,
        lastActiveAt: now,
        profileGeneration: this.profileGeneration,
      })
      return
    }

    const max = this.overrides.maxResident ?? this.options.maxResident ?? MAX_RESIDENT_AGENTS
    while (this.residents.size >= max) {
      const oldest = this.residents.keys().next().value
      if (oldest === undefined) break
      await this.release(oldest, "lru")
    }

    await this.options.createAgent(conversationId)
    this.residents.set(conversationId, {
      conversationId,
      lastActiveAt: now,
      profileGeneration: this.profileGeneration,
    })
  }

  /**
   * 画像换代了（蒸馏成功一次）。
   *
   * 只 +1 计数，**不**在这里重建 workspace：那样要么打断在途的 turn，
   * 要么给一堆当下没消息的会话白做 IO。等它们下一次真的要回消息时
   * （`acquire`）再刷新 —— 那时刷新一定发生在 `handleBatch` 之前。
   *
   * ★ 幂等且便宜：连点两次「重新蒸馏」只是让代号多涨一次。
   */
  markProfileChanged(): void {
    this.profileGeneration += 1
    this.options.logger.info("persona profile generation bumped", {
      generation: this.profileGeneration,
      residents: this.residents.size,
    })
  }

  /** 空闲回收：超过阈值没活动的会话释放掉（连同它的 token）。 */
  private async evictIdle(): Promise<void> {
    const now = this.options.clock.now()
    const idleMs = this.overrides.idleEvictMs ?? this.options.idleEvictMs ?? IDLE_EVICT_MS
    for (const [conversationId, agent] of [...this.residents]) {
      if (now - agent.lastActiveAt >= idleMs) await this.release(conversationId, "idle")
    }
  }

  private async release(conversationId: string, cause: "lru" | "idle" | "stop"): Promise<void> {
    this.residents.delete(conversationId)
    try {
      // disposeAgent 内部会撤 MCP token —— 那一步不能省：
      // 实测外部 harness 的 closeSession 不断开 MCP 连接。
      await this.options.disposeAgent(conversationId)
    } catch (error) {
      this.options.logger.warn("dispose agent failed", {
        conversationId,
        cause,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 改运行参数，**立刻生效**。
   *
   * ★ 为什么要能热改而不是"重启生效"：用户把并发从 3 调到 1 通常是因为
   * **现在**正在被限流。让他等一次重启等于这个设置项没用。
   *
   * `maxResident` 调小时不立刻淘汰超出的那些 —— 下一次 `acquire`
   * 自然会淘汰到新上限。立刻淘汰要 await dispose，而这个方法是同步的
   * （从 IPC handler 里调），在这里 await 会把 UI 卡住。
   */
  applyLimits(limits: {
    maxResident?: number
    maxConcurrentTurns?: number
    maxBatchSize?: number
    idleEvictMs?: number
  }): void {
    if (limits.maxResident !== undefined) this.overrides.maxResident = limits.maxResident
    if (limits.maxConcurrentTurns !== undefined) {
      this.overrides.maxConcurrentTurns = limits.maxConcurrentTurns
    }
    if (limits.idleEvictMs !== undefined) this.overrides.idleEvictMs = limits.idleEvictMs
    if (limits.maxBatchSize !== undefined) this.mailbox.setMaxBatchSize(limits.maxBatchSize)
    this.options.logger.info("supervisor limits applied", { ...limits })
  }

  /** 常驻会话列表（状态页展示，让 LRU 行为可观测）。 */
  residentConversations(): ResidentAgent[] {
    return [...this.residents.values()]
  }

  /** 审核反馈只进入当前仍存活的会话上下文。 */
  isResident(conversationId: string): boolean {
    return this.residents.has(conversationId)
  }

  async stop(): Promise<void> {
    for (const conversationId of [...this.residents.keys()]) {
      await this.release(conversationId, "stop")
    }
  }
}
