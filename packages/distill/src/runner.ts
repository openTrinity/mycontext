/**
 * 蒸馏 runner：把 `distill_tasks` 里的任务真的跑掉。
 *
 * ## 这一层的职责边界
 *
 * · **切窗口 + 入队** —— 按 `(facet, 时间窗)` 建任务，幂等（重复入队不产生重复工作）；
 * · **跑一个任务** —— 取语料 → 过守卫 → map（统计或 LLM）→ merge → 写库；
 * · **不决定何时跑** —— 那是宿主（定时器 / Outbox 消费者）的事。
 *
 * 分开的理由：这样"跑一个任务"是一个可以单独测、单独重试、单独计费的单元。
 *
 * ## ★ 每个任务是一次独立的事务边界
 *
 * 一个任务失败**只**影响它自己：标 failed + 记原因，其余任务照跑。
 * 让一个失败带走整轮的话，一次限流就等于整次蒸馏白跑 ——
 * 而蒸馏是花钱的，白跑的代价是真实的。
 *
 * ## ★ 合并必经 `mergeFacet`
 *
 * 不是"新结论覆盖旧结论"：那会让画像随最后一轮蒸馏漂移，而用户
 * 永远看不到它变过。走合并才有三态（补充/确认/矛盾）与用户手改优先。
 */
import { AppError, type Clock, type Logger } from "@mycontext/kernel"
import type { LlmClient } from "@mycontext/llm"
import {
  ConversationRepository,
  DistillTaskRepository,
  MessageRepository,
  ProfileFacetRepository,
  type ConversationRow,
  type DistillTaskRow,
  type MessageRow,
  type SqliteDatabase,
} from "@mycontext/store"
import { filterDistillable, type DistillRejectReason, type FacetCandidate } from "./guards.js"
import { LLM_FACETS, mapFacetWithLlm, type LlmFacet } from "./map/llm-map.js"
import { readWorkCorpus, type WorkCorpusItem } from "./map/work-corpus.js"
import { routineCandidates } from "./map/stats.js"
import { assertDeidentified, assertSelfAttributed } from "./guards.js"
import { mergeFacet, type FacetRow } from "./reduce/merger.js"
import { candidateKey, findSimilar } from "./reduce/dedupe.js"

/** 统计型 facet 的任务名。它不调 LLM，与 LLM_FACETS 并列成为最后一个任务。 */
export const STAT_FACET = "routines"

/** 全部会被切成任务的 facet。 */
export const ALL_FACETS: readonly string[] = [...LLM_FACETS, STAT_FACET]

/** 一个窗口最多取多少条消息。超了就靠切更小的窗口，而不是截断。 */
const MAX_MESSAGES_PER_TASK = 400

/**
 * 一个窗口最多取多少篇文档/纪要。
 *
 * 比消息的上限小两个量级，因为单篇是消息的一个量级长（截到 1200 字）：
 * 400 篇 × 1200 字会把上下文撑爆，而它们只是**背景**（见
 * `llm-map.SYSTEM_PROMPT` 第 6 条），不是主要证据来源。
 * 取最近的若干篇（SQL 按时间倒序）—— 那也是与画像最相关的。
 */
const MAX_WORK_ITEMS_PER_TASK = 12

/**
 * 哪些 facet 要读文档。
 *
 * 只有这两个：`role`（他负责什么）与 `knowhow`（他定过什么规矩）——
 * 技术方案与 wiki 的第一段往往直接写着系统边界，那是聊天里挖不到的。
 *
 * `workflow` / `artifacts` **刻意不读**：那两个要的是「他自己怎么做」，
 * 而文档不带作者（见 `work-corpus.ts` 文件头），拿别人的文档去推断
 * 「他写方案的结构习惯」正是这一层最容易犯的那个错。
 * `routines` 是统计型的，与 LLM 无关。
 *
 * ## ★★ 这里的名字必须是**现行** facet 名
 *
 * 曾经写的是 `ownership` —— 那是 `role` 的旧名。改名时漏了这一处，
 * 后果全静默：985 篇文档（236 篇有正文）里**一篇都没进** `role` 这一层，
 * 而日志、产物、进度页都看不出少了什么，只是结论比应有的薄。
 * `tests/unit/distill/work-corpus.test.ts` 现在断言这个数组是
 * `LLM_FACETS` 的子集，正是为了让下一次改名漏掉时**测试红**而不是静默。
 */
const WORK_CORPUS_FACETS: readonly string[] = ["role", "knowhow"]

export interface DistillRunnerOptions {
  /**
   * 结论正文里不许出现的字面量（真实姓名、公司名、内部系统名、商标）。
   *
   * ★ 由宿主给：这个包不知道谁是同事、公司叫什么。写死一张名单等于
   * 换个用户就失效，而失效的表现是静默的（守卫恒放行）。
   *
   * ★ 调用方**必须自己过滤太短的词**：两个字的中文名会撞上普通词
   * （见 `scripts/check-no-local-data.mjs` 的 `CJK_NAME_MIN_LENGTH` 那段）。
   * 这一层不猜长度。
   *
   * 不给 = 不检查（守卫直接放行）。那时唯一的防线是 prompt。
   */
  forbiddenTerms?: readonly string[]
  db: SqliteDatabase
  clock: Clock
  logger: Logger
  /** LLM 客户端。为 null 时只跑统计型任务（没配 key 也该能出一部分画像） */
  llm: LlmClient | null
  /** 本人显示名（进 prompt，让模型知道哪条是"我"） */
  selfNames: readonly string[]
  /** 时区偏移（分钟）。统计必须显式传，不能读运行环境 */
  offsetMinutes?: number
  /** 生成 id（注入让测试可复现） */
  newId: () => string
}

export interface PlanInput {
  /** 蒸馏范围起点（unix ms）；null 表示不限（用库里最早的消息） */
  since: number | null
  until: number
  /** 会话白名单；空表示不限 */
  conversationIds?: readonly string[]
  /** 窗口长度（天）。切窗是为了可续跑与可观测，不是为了省钱 */
  /**
   * 切窗宽度（天）。缺省 7。
   *
   * ## ★ 这个数直接决定一轮的**成本**
   *
   * 任务数 = 窗口数 × facet 数。实测 3 个月语料 + 7 天窗 = 135 个任务，
   * 一轮约 80 万 token / 100 分钟。放宽到 30 天则是约 25 个任务。
   *
   * 窄窗的收益是**时间分辨率**（能看出"他六月开始不管这类事了"），
   * 而 work 层抽的是长期结论（职责、规矩）—— 那些东西不需要按周切。
   * 所以这一层适合宽窗；需要时间分辨率的是 forge 的衰减与近窗对比，
   * 而那一层免费。
   */
  windowDays?: number
}

export interface TaskRunResult {
  taskId: string
  facet: string
  state: "done" | "failed" | "skipped"
  /** 过守卫后的语料条数 */
  accepted: number
  /**
   * 这个任务读了几篇文档/纪要（0 = 这个 facet 不读文档，或窗口内没有）。
   *
   * 单独一个计数而不是合进 `accepted`：两类语料的可信度不同
   * （文档不带作者，见 `work-corpus.ts`），而"这轮的结论有多少是文档撑起来的"
   * 是排查画像质量时的第一个问题。
   */
  workItems?: number
  rejected: Record<DistillRejectReason, number>
  /** 写库的结论数（insert + update） */
  written: number
  /** 被合并逻辑跳过的（用户手改优先 / 无变化） */
  skippedByMerge: number
  /**
   * 因为**没脱敏**被丢掉的条数（正文里有真实姓名/商标/内部系统名）。
   *
   * 与 `skippedByMerge` 分开计：那个是"已有更可信的版本"（正常），
   * 这个是"模型没听 prompt 第 8 条"（需要有人去调 prompt）。
   * 混成一个数会让后者永远看不见。
   */
  droppedNotDeidentified: number
  /**
   * 因为**归因不对**被丢掉的条数（证据不是本人说的，或引用了这一批里没有的 id）。
   *
   * 与 `droppedNotDeidentified` 分开计，理由同那一条：两者要采取的行动不同
   * —— 脱敏漏了是去调 prompt 第 8 条，归因错了是这一层的判据问题
   * （实测 tasks 有 61 条、role 有 16 条证据是别人说的话）。
   * 混成一个数会让其中一个永远看不见。
   */
  droppedNotSelfAttributed: number
  costTokens: number
  error?: string
}

export class DistillRunner {
  private readonly tasks: DistillTaskRepository
  private readonly facets: ProfileFacetRepository
  private readonly messages: MessageRepository
  private readonly conversations: ConversationRepository

  constructor(private readonly options: DistillRunnerOptions) {
    this.tasks = new DistillTaskRepository(options.db)
    this.facets = new ProfileFacetRepository(options.db)
    this.messages = new MessageRepository(options.db)
    this.conversations = new ConversationRepository(options.db)
  }

  /**
   * 按时间窗 × facet 切任务并入队。返回新建了多少个。
   *
   * ★ 幂等：同一个 `(facet, window)` 已存在就跳过。增量蒸馏每轮都会
   * 重新算一遍"该蒸哪些窗口"，不幂等的话每轮都把同一段重蒸一遍。
   */
  plan(input: PlanInput): { created: number; total: number } {
    const now = this.options.clock.now()
    const windowMs = (input.windowDays ?? 7) * 86_400_000

    /**
     * `since` 为 null（不限）时用库里最早的消息时间。
     * 用 0 的话会切出几十年的空窗口 —— 每个都要走一遍任务生命周期。
     */
    const earliest =
      input.since ??
      this.options.db
        .prepare<[], { min_at: number | null }>("SELECT min(sent_at) AS min_at FROM messages")
        .get()?.min_at ??
      input.until

    let created = 0
    let total = 0
    for (let start = earliest; start < input.until; start += windowMs) {
      const end = Math.min(start + windowMs, input.until)
      for (const facet of ALL_FACETS) {
        total += 1
        const inserted = this.tasks.enqueue(
          {
            id: this.options.newId(),
            facet,
            // 一期只做 global 画像：会话级 spec 是第二期（要先有 global 基线）
            scope: "global",
            scopeRef: "",
            windowStart: start,
            windowEnd: end,
          },
          now,
        )
        if (inserted) created += 1
      }
    }

    this.options.logger.info("distill planned", {
      created,
      total,
      windowDays: input.windowDays ?? 7,
    })
    return { created, total }
  }

  /** 取一批任务并逐个跑。返回每个任务的结果（进度页与日志都要）。 */
  async runBatch(limit = 4, conversationIds?: readonly string[]): Promise<TaskRunResult[]> {
    // ★ 传 now 让超时的 `running` 被回收 —— 见 `claimBatch` 的注释：
    // 僵尸 running 会让队列永远排不空，于是 work 层的收尾永不执行。
    const batch = this.tasks.claimBatch(limit, 3, this.options.clock.now())
    const out: TaskRunResult[] = []
    for (const task of batch) {
      out.push(await this.runTask(task, conversationIds))
    }
    return out
  }

  /**
   * 跑一个任务。
   *
   * **不抛**：失败标 failed 并把原因记进任务行。抛的话会把整批带走，
   * 而一次限流不该让其余任务白跑。
   */
  async runTask(task: DistillTaskRow, conversationIds?: readonly string[]): Promise<TaskRunResult> {
    const now = this.options.clock.now()
    const result: TaskRunResult = {
      taskId: task.id,
      facet: task.facet,
      state: "done",
      accepted: 0,
      rejected: {
        identity_unconfirmed: 0,
        self_generated: 0,
        bot_channel: 0,
        empty_content: 0,
        distill_disabled: 0,
      },
      written: 0,
      skippedByMerge: 0,
      droppedNotDeidentified: 0,
      droppedNotSelfAttributed: 0,
      costTokens: 0,
    }

    this.tasks.markRunning(task.id, now)

    try {
      const windowMessages = this.messages.distillableInWindow({
        start: task.windowStart,
        end: task.windowEnd,
        limit: MAX_MESSAGES_PER_TASK,
        // ★ 白名单是 external_id（见 distillableInWindow 的注释）。
        ...(conversationIds === undefined || conversationIds.length === 0
          ? {}
          : { conversationExternalIds: conversationIds }),
      })

      const conversationById = new Map<string, ConversationRow>()
      for (const message of windowMessages) {
        if (conversationById.has(message.conversationId)) continue
        const row = this.conversations.findById(message.conversationId)
        if (row !== null) conversationById.set(message.conversationId, row)
      }

      const { accepted, rejected } = filterDistillable(windowMessages, conversationById)
      result.accepted = accepted.length
      result.rejected = rejected

      /**
       * 文档与纪要摘要 —— 只给需要它们的 facet 读（见 `WORK_CORPUS_FACETS`）。
       *
       * 在空窗口判定**之前**取：一个窗口可能一条消息都没有而有几篇文档
       * （比如那周他只在写方案），此时按"没语料"跳过会白扔掉真实语料。
       */
      const workItems: WorkCorpusItem[] = WORK_CORPUS_FACETS.includes(task.facet)
        ? readWorkCorpus(this.options.db, {
            channelId: "dingtalk",
            start: task.windowStart,
            end: task.windowEnd,
            limit: MAX_WORK_ITEMS_PER_TASK,
          })
        : []
      result.workItems = workItems.length

      if (accepted.length === 0 && workItems.length === 0) {
        /**
         * 空窗口标 **skipped** 而不是 done。
         *
         * 两者在进度页上必须能区分：全是 skipped 说明"这段时间没语料"
         * 或"身份没确认"，而全是 done 说明真的蒸出了东西。
         * 混成一种的话"蒸馏完成但画像是空的"看起来就完全正常。
         */
        this.tasks.markSkipped(task.id, now, this.explainEmpty(rejected))
        return { ...result, state: "skipped" }
      }

      /**
       * ★ 统计型与抽取型的**成本来源不同**，所以在这里就分开拿。
       *
       * 统计型是纯本地计算，costTokens 如实为 0 —— 那是正确答案而不是
       * "没测到"（同 `fidelity.md` 的约定）。抽取型的用量由 `mapFacetWithLlm`
       * 把每批 `completion.usage` 累加后返回；**不能**事后读
       * `llm.usage()`，那是 client 的生命周期累计，见 `MapLlmResult.costTokens`
       * 的注释（实测它把 routines 记成了 1070 万 token）。
       */
      const mapped =
        task.facet === STAT_FACET
          ? {
              candidates: routineCandidates(accepted, {
                offsetMinutes: this.options.offsetMinutes ?? 8 * 60,
              }),
              costTokens: 0,
            }
          : await this.mapWithLlm(task.facet, accepted, conversationById, workItems)
      const candidates = mapped.candidates
      // 成本先记下来：下面任何一条 continue / 提前 return 都不该让它丢失，
      // 因为钱**已经花掉了**（结论被守卫丢掉不会退款）。
      result.costTokens = mapped.costTokens

      // 统计型可能因样本不足产出 0 条 —— 那是**正确行为**，不是失败
      if (candidates.length === 0) {
        this.tasks.markSkipped(task.id, now, "本窗口没有可靠结论（样本不足或模型未抽出）")
        return { ...result, state: "skipped", accepted: accepted.length }
      }

      /**
       * ★★ 归因表：证据 id → 那条消息是不是本人说的。
       *
       * 只收**这一批真的喂给了模型**的语料（`accepted` + `workItems`），
       * 不是整库 —— 因为它同时承担「这个 id 是不是编的」这个判断：
       * 拿整库去查会让模型引用一条它根本没看到的消息也算合法，
       * 而那与编一个 id 只差一层运气。
       *
       * 文档与纪要记 `null`（作者未知，见 `work-corpus.ts` 文件头）——
       * 于是它们不能单独支撑任何结论（`assertSelfAttributed` 要求至少一条
       * 本人证据），但也不会被当成"编造的 id"整条作废。那正是文档
       * 「只能作为环境背景」这个定位的落地。
       */
      const authorship = new Map<string, boolean | null>()
      for (const message of accepted) authorship.set(message.id, message.isSelf)
      for (const item of workItems) {
        authorship.set(item.id, item.authorship === "self" ? true : null)
      }

      /**
       * ★★ 去重的**已有行快照**：每个 facet 只查一次，循环内复用。
       *
       * 在循环外查是必要的，但要注意它是**快照** —— 同一批里两条互相近义的
       * 候选都会与"写之前"的状态比。所以下面写完一条要把它**补进快照**，
       * 否则同一批内的重复合不掉（实测同一个窗口里模型确实会给出两条近义结论）。
       */
      const dedupeScope =
        task.facet === STAT_FACET
          ? []
          : this.facets.listByFacet(task.facet, "global", "").map((row) => ({
              facet: row.facet,
              key: row.key,
              value: safeParse(row.valueJson),
            }))

      for (const candidate of candidates) {
        /**
         * ★★ 脱敏：命中就**丢掉这一条**（并计数），不让整个任务失败。
         *
         * 整任务失败会连坐同一批里合格的结论 —— 而那些是花了钱抽出来的。
         * 计数进 `droppedNotDeidentified`，日志里报个数**不报内容**
         * （内容就是真实姓名，进日志等于换个地方泄漏）。
         *
         * 这是第二道防线；第一道是 prompt 第 8 条（见 `llm-map.SYSTEM_PROMPT`）。
         * 两道都要 —— 模型会漏，而这一层的产物进 skill 包，而 skill 包会被
         * 导出、分享、进 git。
         */
        const deid = assertDeidentified(candidate, {
          forbidden: this.options.forbiddenTerms ?? [],
        })
        if (!deid.ok) {
          result.droppedNotDeidentified += 1
          continue
        }

        /**
         * ★★ 归因：证据必须真实存在，且由本人的话支撑。
         *
         * 与脱敏同一档处理（丢这一条、计数、不让整任务失败）——
         * 一条归因错的结论不该连坐同一批里合格的那些。
         *
         * ★ 统计型 facet 跳过：它的候选由 `routineCandidates` 从 `accepted`
         * 直接算出，证据就是那批消息本身，没有"模型编来源"这个失效模式。
         * 而它的证据里**本来就**含 `is_self=0` 的消息（作息统计要看整体节奏），
         * 拿这道守卫去卡它会把唯一一个免费的 facet 全部拒掉。
         */
        if (task.facet !== STAT_FACET) {
          const attributed = assertSelfAttributed(candidate, authorship)
          if (!attributed.ok) {
            result.droppedNotSelfAttributed += 1
            continue
          }
        }

        /**
         * ★★ 定位到哪一行：先找近义的已有行，找不到才用算出来的稳定 key。
         *
         * 这两步替换掉了原来的「用模型给的 key 去 find」。那条路的问题见
         * `reduce/dedupe.ts` 文件头：模型每个窗口编一个新 key，于是
         * `UNIQUE(facet,scope,scope_ref,key)` 从不命中，`mergeFacet` 的三态
         * **从未跑过**（实测 260/273 条停在 revision=1），
         * 「有 20 句话都这么说」这个信号永久丢失。
         *
         * `candidate.key`（模型给的）**不再参与定位**。它仍在
         * `FacetCandidate` 上，因为 `parseFacetItems` 还在读模型的 `key`
         * 字段做形状校验 —— 但那只是"模型有没有按格式回话"的证据，
         * 不是数据库定位用的东西。
         *
         * ## ★★ 但统计型 facet 用它**自己的** key
         *
         * `routines` 的 key 是**代码里的常量**（`stats.ts` 的 `active_hours` /
         * `active_weekdays` / `reply_latency_ms`）—— 那本来就稳定，而且
         * `mergeFacet` 的数值累积分支（`isNumericFacet`）正是**按这些名字**
         * 找到上一轮那一行的。
         *
         * 拿词法 key 覆盖它们会同时坏掉两件事，且都不报错：
         * · 每轮算出的 key 随直方图的值变化 → 数值再也累积不起来，
         *   每轮都是一行新记录；
         * · 审阅页与下游按 `active_hours` 这个名字取值，取不到就是空。
         */
        const key =
          task.facet === STAT_FACET
            ? candidate.key
            : (findSimilar(candidate, dedupeScope) ?? candidateKey(candidate))
        const existing = this.facets.find(candidate.facet, candidate.scope, candidate.scopeRef, key)
        const merged = mergeFacet(existing as FacetRow | null, candidate)
        if (merged.action === "skip") {
          result.skippedByMerge += 1
          continue
        }
        this.facets.write(
          {
            // update 时 id 不会被用到（按唯一键定位现有行），但仍要给一个
            id: existing?.id ?? this.options.newId(),
            facet: candidate.facet,
            scope: candidate.scope,
            scopeRef: candidate.scopeRef,
            key,
            value: merged.value,
            confidence: merged.confidence,
            evidence: merged.evidence,
            source: candidate.source,
            ...(merged.action === "update" && merged.conflict !== undefined
              ? { conflict: merged.conflict }
              : {}),
            windowStart: task.windowStart,
            windowEnd: task.windowEnd,
          },
          now,
        )
        // ★ 补进快照 —— 见上面的注释：否则同一批内的近义候选合不掉。
        if (existing === null) {
          dedupeScope.push({ facet: candidate.facet, key, value: merged.value })
        }
        result.written += 1
      }

      const tokens = result.costTokens
      this.tasks.markDone(task.id, now, {
        inputMessageCount: accepted.length,
        costTokens: tokens,
      })
      /**
       * ★ 一个任务的**去留账**。没有这一行，两道守卫的效果就是不可见的：
       * "抽出 20 条、写进 3 条"与"抽出 3 条、写进 3 条"在产物上一模一样，
       * 而前者说明 prompt 需要调（模型在大量产出不合格的结论）。
       *
       * 只报**个数**不报内容 —— 被拦下的正文里可能正是真实姓名。
       */
      this.options.logger.info("distill task done", {
        facet: task.facet,
        accepted: accepted.length,
        workItems: workItems.length,
        candidates: candidates.length,
        written: result.written,
        skippedByMerge: result.skippedByMerge,
        droppedNotDeidentified: result.droppedNotDeidentified,
        droppedNotSelfAttributed: result.droppedNotSelfAttributed,
        /**
         * ★★ 字段名**不能**叫 `costTokens` —— `redact.ts` 的 `SENSITIVE_KEY`
         * 正则含 `token`，于是它会被整条替换成 `"[unset]"`。
         *
         * 实测踩到：这一行日志在真机上打出 `costTokens: '[unset]'`，
         * 而我刚刚才修好"成本计量"那个 bug（读 client 累计值 → 读本次增量）。
         * 也就是修对了数字，却在最后一步把它遮掉了 —— 成本仍然不可见。
         *
         * 用 `spentTokens` 之外的写法都躲不开那个正则（`tokens` 本身就命中），
         * 所以改成 `usage`：语义一样，且不含敏感词。
         */
        usage: tokens,
      })
      return result
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.tasks.markFailed(task.id, now, detail)
      this.options.logger.warn("distill task failed", {
        taskId: task.id,
        facet: task.facet,
        detail,
      })
      return { ...result, state: "failed", error: detail }
    }
  }

  /**
   * 跑抽取型 map。
   *
   * ★ 返回 `{candidates, costTokens}` 而不是只返回 candidates：钱是在这里花的，
   * 而"花了多少"必须跟着结论一起往上走。原来这个函数只返回 candidates，
   * 于是调用方只能事后去问 client "你一共花了多少" —— 那个数是生命周期累计，
   * 不是本任务增量（见 `MapLlmResult.costTokens`）。
   */
  private async mapWithLlm(
    facet: string,
    accepted: readonly MessageRow[],
    conversationById: ReadonlyMap<string, ConversationRow>,
    workItems: readonly WorkCorpusItem[],
  ): Promise<{ candidates: FacetCandidate[]; costTokens: number }> {
    const client = this.options.llm
    if (client === null) {
      /**
       * 没配 LLM 时**抛**而不是静默产出 0 条。
       *
       * 静默的话用户会看到"蒸馏完成，画像里只有作息统计"，
       * 而完全想不到是少配了一个 key。
       */
      throw new AppError("CONFIG_INVALID", "未配置 LLM，无法跑抽取型蒸馏", {
        messageKey: "errors:config.invalid",
        messageParams: { detail: "MYCONTEXT_LLM_API_KEY" },
      })
    }
    if (!(LLM_FACETS as readonly string[]).includes(facet)) {
      throw new AppError("CONFIG_INVALID", `未知的 facet：${facet}`)
    }
    const mapped = await mapFacetWithLlm(
      facet as LlmFacet,
      accepted,
      conversationById,
      { scope: "global", scopeRef: "" },
      { client, selfNames: this.options.selfNames, workItems },
    )
    return { candidates: mapped.candidates, costTokens: mapped.costTokens }
  }

  /**
   * 把"为什么这个窗口是空的"写成人话。
   *
   * 只记"0 条语料"的话用户不知道该做什么。而 `identity_unconfirmed`
   * 有明确的动作（去确认身份），`bot_channel` 是预期的（机器人群本该排除）。
   */
  private explainEmpty(rejected: Record<DistillRejectReason, number>): string {
    if (rejected.identity_unconfirmed > 0) {
      return `本人身份未确认，${String(rejected.identity_unconfirmed)} 条语料被拒 —— 先在状态页确认身份`
    }
    const parts = Object.entries(rejected)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${String(count)}`)
    return parts.length === 0 ? "本窗口没有消息" : `全部被守卫拒：${parts.join(" ")}`
  }

  progress() {
    return this.tasks.progress()
  }
}

/**
 * `value_json` → 值。坏了就返回原串而不是抛。
 *
 * 这里只用于去重的相似度比对：一行的 JSON 坏掉不该让整轮蒸馏失败，
 * 而拿原串去比相似度**仍然是有意义的**（那个串里就有原文的字）。
 */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}
