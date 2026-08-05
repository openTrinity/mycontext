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
import { filterDistillable, type DistillRejectReason } from "./guards.js"
import { LLM_FACETS, mapFacetWithLlm, type LlmFacet } from "./map/llm-map.js"
import { routineCandidates } from "./map/stats.js"
import { mergeFacet, type FacetRow } from "./reduce/merger.js"

/** 统计型 facet 的任务名。它不调 LLM，与 LLM_FACETS 并列成为第 6 个任务。 */
export const STAT_FACET = "routines"

/** 全部会被切成任务的 facet。 */
export const ALL_FACETS: readonly string[] = [...LLM_FACETS, STAT_FACET]

/** 一个窗口最多取多少条消息。超了就靠切更小的窗口，而不是截断。 */
const MAX_MESSAGES_PER_TASK = 400

export interface DistillRunnerOptions {
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
  windowDays?: number
}

export interface TaskRunResult {
  taskId: string
  facet: string
  state: "done" | "failed" | "skipped"
  /** 过守卫后的语料条数 */
  accepted: number
  rejected: Record<DistillRejectReason, number>
  /** 写库的结论数（insert + update） */
  written: number
  /** 被合并逻辑跳过的（用户手改优先 / 无变化） */
  skippedByMerge: number
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
    const batch = this.tasks.claimBatch(limit)
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

      if (accepted.length === 0) {
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

      const candidates =
        task.facet === STAT_FACET
          ? routineCandidates(accepted, {
              offsetMinutes: this.options.offsetMinutes ?? 8 * 60,
            })
          : await this.mapWithLlm(task.facet, accepted, conversationById)

      // 统计型可能因样本不足产出 0 条 —— 那是**正确行为**，不是失败
      if (candidates.length === 0) {
        this.tasks.markSkipped(task.id, now, "本窗口没有可靠结论（样本不足或模型未抽出）")
        return { ...result, state: "skipped", accepted: accepted.length }
      }

      for (const candidate of candidates) {
        const existing = this.facets.find(
          candidate.facet,
          candidate.scope,
          candidate.scopeRef,
          candidate.key,
        )
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
            key: candidate.key,
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
        result.written += 1
      }

      const tokens = this.options.llm?.usage().totalTokens ?? 0
      result.costTokens = tokens
      this.tasks.markDone(task.id, now, {
        inputMessageCount: accepted.length,
        costTokens: tokens,
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

  private async mapWithLlm(
    facet: string,
    accepted: readonly MessageRow[],
    conversationById: ReadonlyMap<string, ConversationRow>,
  ) {
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
      { client, selfNames: this.options.selfNames },
    )
    return mapped.candidates
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
