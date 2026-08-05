/**
 * 多路召回融合（RRF）。
 *
 * ## 为什么是 RRF 而不是加权分数相加
 *
 * 各路的分数**不可比**：FTS 的 `bm25()` 是负数且量纲取决于语料统计，
 * 向量余弦在 [-1,1]，图谱侧给的又是它自己的置信度。
 * 归一化后相加需要为每路调一个权重，而那个权重会随语料变化 ——
 * 调好的参数三个月后就不对了。
 *
 * RRF（Reciprocal Rank Fusion）只用**排名**不用分数：
 * `score = Σ 1/(k + rank_i)`。它对量纲免疫，没有需要调的权重
 * （k 是个平滑常数，业界惯用 60），并且天然偏好「多路都认可」的结果。
 *
 * ## 为什么要留 recall_debug
 *
 * 「为什么这条排在前面」是搜索里最常被问的问题。
 * 各路的原始排名与融合后的位次都留下来，排查时才不用靠猜。
 */

export interface RankedList {
  /** 这一路的名字：'local.fts' | 'local.vector' | 'kl.ask' | 'dws.search' */
  source: string
  /** 按相关性降序的实体 id */
  ids: readonly string[]
  /** 该路耗时，进 recall_debug */
  latencyMs?: number
}

export interface FusedHit {
  id: string
  score: number
  /** 命中它的路 + 在那一路里的排名（1-based）。答案里的引用标注要用它。 */
  hitBy: { source: string; rank: number }[]
}

/** RRF 的平滑常数。60 是业界惯用值：小了过分偏好第一名，大了各名次趋同。 */
const RRF_K = 60

export function fuseRrf(
  lists: readonly RankedList[],
  options: { topK?: number; k?: number } = {},
): FusedHit[] {
  const k = options.k ?? RRF_K
  const topK = options.topK ?? 20
  const accumulator = new Map<string, FusedHit>()

  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const rank = index + 1
      const existing = accumulator.get(id)
      const contribution = 1 / (k + rank)
      if (existing === undefined) {
        accumulator.set(id, {
          id,
          score: contribution,
          hitBy: [{ source: list.source, rank }],
        })
        return
      }
      existing.score += contribution
      existing.hitBy.push({ source: list.source, rank })
    })
  }

  return [...accumulator.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // 分数相同时按「被几路命中」再排：多路认可的更可信。
      if (b.hitBy.length !== a.hitBy.length) return b.hitBy.length - a.hitBy.length
      // 最后按 id 排，保证结果**确定性**（否则同分项顺序随 Map 插入序漂移，
      // 测试会间歇性失败而且看起来像真 bug）。
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .slice(0, topK)
}

export interface RecallDebug {
  perSource: { source: string; count: number; latencyMs: number | null }[]
  fusedCount: number
}

/** 召回调试信息。开发者模式常驻显示，正式版折叠。 */
export function buildRecallDebug(
  lists: readonly RankedList[],
  fused: readonly FusedHit[],
): RecallDebug {
  return {
    perSource: lists.map((list) => ({
      source: list.source,
      count: list.ids.length,
      latencyMs: list.latencyMs ?? null,
    })),
    fusedCount: fused.length,
  }
}
