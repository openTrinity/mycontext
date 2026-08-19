/**
 * 增量合并。
 *
 * 三态设计借鉴 colleague-skill 的 `prompts/merger.md`：
 * · **补充** → 追加（新内容增加了细节）
 * · **确认** → 提升置信度，不重复写
 * · **矛盾** → **保留双结论并降置信**，交用户裁决
 *
 * ## 与它的关键差异
 *
 * colleague-skill 让 LLM 整段 diff 两份 md；我们按
 * `(facet, scope, scope_ref, key)` **精确定位到行**，因此：
 * · 数值型（响应时延、活跃时段）走**纯统计不调 LLM**；
 * · 只有判断型（性格、语气）才付模型成本。
 * 规模化后这个差异是数量级的 —— 几万条消息的统计是毫秒级的本地计算。
 *
 * 这个文件是**纯函数**（不碰 DB、不调模型），所以合并语义可以穷举测试。
 */
import type { FacetCandidate } from "../guards.js"

export interface FacetRow {
  id: string
  facet: string
  scope: string
  scopeRef: string
  key: string
  valueJson: string
  confidence: number
  evidenceJson: string
  source: "llm" | "stat" | "user"
  conflictJson: string | null
  revision: number
  windowStart: number | null
  windowEnd: number | null
  updatedAt: number
}

export type MergeRelation = "supplement" | "confirm" | "conflict"

export type MergeResult =
  | { action: "insert"; value: unknown; confidence: number; evidence: string[] }
  | {
      action: "update"
      relation: MergeRelation
      value: unknown
      confidence: number
      evidence: string[]
      /** 矛盾时保留的双结论（写进 conflict_json，供审阅页展示） */
      conflict?: { existing: unknown; candidate: unknown }
    }
  | { action: "skip"; reason: "user_override_wins" | "no_change" }

/** 走纯统计的 facet：这些的「合并」是数值累积，不该付模型成本。 */
const NUMERIC_FACETS = new Set(["routines"])

export function isNumericFacet(facet: string): boolean {
  return NUMERIC_FACETS.has(facet)
}

/** 证据合并 + 去重。上限防止一条结论挂着几万个 message_id（那会让行变得巨大）。 */
const MAX_EVIDENCE = 50

function mergeEvidence(existing: readonly string[], incoming: readonly string[]): string[] {
  // 新证据在前：审阅页展示时用户更可能想看最近的例子
  return [...new Set([...incoming, ...existing])].slice(0, MAX_EVIDENCE)
}

/**
 * 判断新旧结论的关系。
 *
 * 用**结构化比较**而不是让 LLM 判断：`(facet, key)` 已经把语义定位到了
 * 一个具体维度，剩下的只是"值一样吗"。让模型来判断这件事既慢又不确定。
 */
export function classifyRelation(existingValue: unknown, candidateValue: unknown): MergeRelation {
  if (JSON.stringify(existingValue) === JSON.stringify(candidateValue)) return "confirm"

  // 数组：新值是旧值的超集 → 补充；否则视为矛盾（元素被替换了）
  if (Array.isArray(existingValue) && Array.isArray(candidateValue)) {
    const existingSet = new Set(existingValue.map((item) => JSON.stringify(item)))
    const covered = [...existingSet].every((item) =>
      candidateValue.some((value) => JSON.stringify(value) === item),
    )
    return covered ? "supplement" : "conflict"
  }

  // 标量值不同 = 矛盾。**不做"取新的"**：那会让画像随最后一轮蒸馏漂移，
  // 而用户永远看不到它变过。
  return "conflict"
}

/** 数值型的累积：加权平均，权重是各自的证据条数。 */
function rollUpNumeric(existing: FacetRow, candidate: FacetCandidate): MergeResult {
  const existingValue = JSON.parse(existing.valueJson) as unknown
  const existingEvidence = JSON.parse(existing.evidenceJson) as string[]

  if (typeof existingValue !== "number" || typeof candidate.value !== "number") {
    // 非数值就退回普通路径，而不是硬算
    return {
      action: "update",
      relation: classifyRelation(existingValue, candidate.value),
      value: candidate.value,
      confidence: candidate.confidence,
      evidence: mergeEvidence(existingEvidence, candidate.evidence),
    }
  }

  const existingWeight = Math.max(1, existingEvidence.length)
  const candidateWeight = Math.max(1, candidate.evidence.length)
  const merged =
    (existingValue * existingWeight + candidate.value * candidateWeight) /
    (existingWeight + candidateWeight)

  return {
    action: "update",
    relation: "supplement",
    value: merged,
    // 样本越多越有信心，但不无限逼近 1（统计量始终有不确定性）
    confidence: Math.min(0.95, Math.max(existing.confidence, candidate.confidence) + 0.05),
    evidence: mergeEvidence(existingEvidence, candidate.evidence),
  }
}

/**
 * 合并一条 facet。
 *
 * @param existing 库里已有的那行（按 `(facet, scope, scope_ref, key)` 查）。
 *   null 表示首次写入。
 */
export function mergeFacet(existing: FacetRow | null, candidate: FacetCandidate): MergeResult {
  if (existing === null) {
    return {
      action: "insert",
      value: candidate.value,
      confidence: candidate.confidence,
      evidence: [...candidate.evidence].slice(0, MAX_EVIDENCE),
    }
  }

  /**
   * ★ 用户手改是最高优先级：LLM 不得覆盖人明确写下的结论。
   *
   * 没有这条的话，用户在审阅页改完一句话，下一轮蒸馏就把它改回去了 ——
   * 而用户不会再改第二次，他会关掉这个功能。
   */
  if (existing.source === "user" && candidate.source !== "user") {
    return { action: "skip", reason: "user_override_wins" }
  }

  if (isNumericFacet(candidate.facet)) return rollUpNumeric(existing, candidate)

  const existingValue = JSON.parse(existing.valueJson) as unknown
  const existingEvidence = JSON.parse(existing.evidenceJson) as string[]
  const relation = classifyRelation(existingValue, candidate.value)
  const evidence = mergeEvidence(existingEvidence, candidate.evidence)

  if (relation === "confirm") {
    // 确认：提升置信度但**不重复写值**。
    // 证据仍然合并 —— "有 20 句话都这么说"比"有 3 句"更有说服力。
    const bumped = Math.min(0.98, existing.confidence + 0.05)
    if (bumped === existing.confidence && evidence.length === existingEvidence.length) {
      return { action: "skip", reason: "no_change" }
    }
    return {
      action: "update",
      relation,
      value: existingValue,
      confidence: bumped,
      evidence,
    }
  }

  if (relation === "supplement") {
    return {
      action: "update",
      relation,
      value: candidate.value,
      confidence: Math.max(existing.confidence, candidate.confidence),
      evidence,
    }
  }

  /**
   * 矛盾：**保留双结论并降置信**，交用户裁决。
   *
   * 不自动选一个是刻意的：两个都有证据支撑，说明这个人在不同场景下
   * 确实表现不同（或者我们的抽取粒度太粗）。自动挑一个会丢掉这个信息，
   * 而降置信 + 展示双方让用户能一眼看出"这里需要人来判断"。
   */
  /**
   * 二次矛盾时优先保留**最初**那一方：`conflict.existing` 取自上一轮
   * `conflict_json` 里的 existing（那才是矛盾的"原始方"），而不是当前 value
   * 列 —— value 列在上一次矛盾后存的是 candidate 单方的值，拿它当 existing
   * 会把原始那一方覆盖丢（审阅页就只剩"新对更新"）。首条矛盾时
   * `conflict_json` 为 null，退到当前 value 列（它当时就是那一方）。
   */
  const priorExisting = existing.conflictJson
    ? ((JSON.parse(existing.conflictJson) as { existing?: unknown }).existing ?? existingValue)
    : existingValue
  return {
    action: "update",
    relation,
    value: candidate.value,
    confidence: Math.max(0.2, Math.min(existing.confidence, candidate.confidence) - 0.15),
    evidence,
    conflict: { existing: priorExisting, candidate: candidate.value },
  }
}
