/**
 * map 阶段的**统计**部分：不调 LLM 就能算出来的 facet。
 *
 * ## 为什么要单独分出来
 *
 * `routines`（活跃时段、响应时延）是**可计算**的，不是"可推断"的。
 * 交给 LLM 有三个坏处，每一个都足以单独否掉它：
 * · 贵（几万条消息塞进 prompt）；
 * · 慢（一次几十秒 vs 毫秒级本地计算）；
 * · **错**（模型数不清"周三 14 点有 37 条消息"这种事）。
 *
 * 这一层是纯函数，所以它的正确性可以穷举验证 —— 而这正是把它与
 * LLM 那半分开的主要收益。
 */
import type { MessageRow } from "@mycontext/store"
import type { FacetCandidate } from "../guards.js"

/** 每条统计结论最多挂多少条证据。全挂上会让一行 JSON 有几十万字符。 */
const MAX_EVIDENCE = 20

/**
 * 时区偏移（分钟）。
 *
 * 必须显式传：`sent_at` 是 unix ms，而"几点活跃"是**本地时间**的问题。
 * 用 `new Date(ms).getHours()` 会读运行机器的时区 —— 那个 bug 在
 * 开发机上永远看不到（见 channels/time.ts 的同一课）。
 */
export interface StatsOptions {
  offsetMinutes: number
  /** 证据上限，默认 20 */
  maxEvidence?: number
}

/** 本地小时（0-23），不依赖运行环境时区。 */
function localHour(ms: number, offsetMinutes: number): number {
  const shifted = new Date(ms + offsetMinutes * 60_000)
  return shifted.getUTCHours()
}

/** 本地星期（0=周日），同上。 */
function localWeekday(ms: number, offsetMinutes: number): number {
  const shifted = new Date(ms + offsetMinutes * 60_000)
  return shifted.getUTCDay()
}

/** 分位数。用最近邻插值 —— 样本量小时线性插值会造出没出现过的值。 */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[index] ?? null
}

export interface RoutineStats {
  /** 每个本地小时的消息数（长度 24） */
  hourHistogram: number[]
  /** 每个本地星期的消息数（长度 7，0=周日） */
  weekdayHistogram: number[]
  /** 本人回复别人的时延（毫秒）分位数；样本不足时为 null */
  replyLatencyP50: number | null
  replyLatencyP90: number | null
  /** 参与统计的本人消息条数 */
  selfMessageCount: number
  /** 时延样本数 —— 与 selfMessageCount 不同（只有"紧跟他人消息"的才算） */
  latencySampleCount: number
}

/**
 * 计算作息统计。
 *
 * ★ 时延的定义要说清：**本人消息紧跟在他人消息之后**时，两者的时间差。
 * 不这样限定的话，本人连发三条会产出两个接近 0 的"响应时延"，
 * 把 p50 拉到几秒 —— 那看起来像"这人秒回"，实际是统计口径错了。
 */
export function computeRoutines(
  messages: readonly MessageRow[],
  options: StatsOptions,
): RoutineStats {
  const hourHistogram = Array.from({ length: 24 }, () => 0)
  const weekdayHistogram = Array.from({ length: 7 }, () => 0)
  const latencies: number[] = []
  let selfMessageCount = 0

  // 按会话分组再按时间排序：跨会话的"上一条"没有对话含义
  const byConversation = new Map<string, MessageRow[]>()
  for (const message of messages) {
    const list = byConversation.get(message.conversationId)
    if (list === undefined) byConversation.set(message.conversationId, [message])
    else list.push(message)
  }

  for (const list of byConversation.values()) {
    const sorted = [...list].sort((a, b) => a.sentAt - b.sentAt)
    for (let index = 0; index < sorted.length; index += 1) {
      const message = sorted[index]
      if (message === undefined || message.isSelf !== true) continue
      selfMessageCount += 1
      /**
       * 显式取下标再写回：`arr[i] += 1` 在 noUncheckedIndexedAccess 下
       * 是类型错误。而这两个下标由 `getUTCHours/getUTCDay` 产生，
       * 值域天然在 0-23 / 0-6 内 —— 用 `?? 0` 表达那个不变式，
       * 而不是 `as number` 把检查关掉。
       */
      const hour = localHour(message.sentAt, options.offsetMinutes)
      const weekday = localWeekday(message.sentAt, options.offsetMinutes)
      hourHistogram[hour] = (hourHistogram[hour] ?? 0) + 1
      weekdayHistogram[weekday] = (weekdayHistogram[weekday] ?? 0) + 1

      const previous = sorted[index - 1]
      // 只有"紧跟他人消息"才算一次响应（见上）
      if (previous !== undefined && previous.isSelf === false) {
        const delta = message.sentAt - previous.sentAt
        if (delta >= 0) latencies.push(delta)
      }
    }
  }

  latencies.sort((a, b) => a - b)
  return {
    hourHistogram,
    weekdayHistogram,
    replyLatencyP50: percentile(latencies, 0.5),
    replyLatencyP90: percentile(latencies, 0.9),
    selfMessageCount,
    latencySampleCount: latencies.length,
  }
}

/**
 * 统计结论 → facet 候选。
 *
 * ★ 样本不足时**不产出**该条结论，而不是产出一个低置信的。
 * 「3 条消息算出的 p50」不是"不太准"，它是**没有意义** ——
 * 而一旦入库，它就会作为下一轮合并的基线继续存在。
 */
export function routineCandidates(
  messages: readonly MessageRow[],
  options: StatsOptions,
): FacetCandidate[] {
  const stats = computeRoutines(messages, options)
  const limit = options.maxEvidence ?? MAX_EVIDENCE
  const selfIds = messages
    .filter((message) => message.isSelf === true)
    .slice(0, limit)
    .map((message) => message.id)

  // 一条本人消息都没有 → 什么都算不出来（而且 evidence 会是空数组，本来也会被守卫拒）
  if (selfIds.length === 0) return []

  const out: FacetCandidate[] = []

  /**
   * 活跃时段至少要 20 条本人消息。
   *
   * 这个下限不是拍的：24 个小时桶，20 条以下时最高桶很可能只有 2-3 条，
   * 与第二名无统计差异 —— 那时候说"他在 14 点最活跃"就是在读噪声。
   */
  if (stats.selfMessageCount >= 20) {
    out.push({
      facet: "routines",
      scope: "global",
      scopeRef: "",
      key: "active_hours",
      value: { histogram: stats.hourHistogram, offsetMinutes: options.offsetMinutes },
      // 置信度随样本量增长但封顶 0.9 —— 统计再准也只是"历史如此"
      confidence: Math.min(0.9, 0.5 + stats.selfMessageCount / 1000),
      evidence: selfIds,
      source: "stat",
    })
    out.push({
      facet: "routines",
      scope: "global",
      scopeRef: "",
      key: "active_weekdays",
      value: { histogram: stats.weekdayHistogram, offsetMinutes: options.offsetMinutes },
      confidence: Math.min(0.9, 0.5 + stats.selfMessageCount / 1000),
      evidence: selfIds,
      source: "stat",
    })
  }

  /**
   * 响应时延至少要 10 个样本。
   *
   * 比活跃时段的门槛低：它只有一个数（不用在 24 个桶之间比较），
   * 10 个样本的中位数已经有参考价值。但仍然不能是 1 个。
   */
  if (stats.latencySampleCount >= 10 && stats.replyLatencyP50 !== null) {
    out.push({
      facet: "routines",
      scope: "global",
      scopeRef: "",
      key: "reply_latency_ms",
      value: {
        p50: stats.replyLatencyP50,
        p90: stats.replyLatencyP90,
        sampleCount: stats.latencySampleCount,
      },
      confidence: Math.min(0.9, 0.5 + stats.latencySampleCount / 500),
      evidence: selfIds,
      source: "stat",
    })
  }

  return out
}
