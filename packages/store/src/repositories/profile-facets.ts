/**
 * 画像 facet 的读写。
 *
 * ## ★ 写入必经 `mergeFacet` + `assertHasEvidence`
 *
 * 这个仓储**只**提供 `upsertMerged`，不提供裸 `insert` ——
 * 让"绕过合并直接写"这件事在 API 层面不可能。
 * 理由：画像污染不可逆（污染后的结论会作为下一轮的基线继续放大），
 * 而绕过合并最自然的写法恰恰就是 `insert or replace`。
 *
 * 守卫（无证据拒绝入库）由**调用方**在构造候选时调用 ——
 * 它属于 `@mycontext/distill`，而 store 层不该反向依赖 distill。
 * 这里做的是第二道：`evidence_json` 为空数组时直接抛。
 *
 * ## 改动前留档
 *
 * 每次 update 都往 `profile_facet_revisions` 写一行旧值。
 * 那是"这条结论为什么变成现在这样"的唯一线索 —— 没有它，
 * 用户在审阅页看到一个奇怪的结论时无从判断它是哪一轮蒸馏写进去的。
 */
import { AppError } from "@mycontext/kernel"
import type { SqliteDatabase } from "../database.js"

export interface ProfileFacetRow {
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

interface RawRow {
  id: string
  facet: string
  scope: string
  scope_ref: string
  key: string
  value_json: string
  confidence: number
  evidence_json: string
  source: string
  conflict_json: string | null
  revision: number
  window_start: number | null
  window_end: number | null
  updated_at: number
}

function toRow(raw: RawRow): ProfileFacetRow {
  return {
    id: raw.id,
    facet: raw.facet,
    scope: raw.scope,
    scopeRef: raw.scope_ref,
    key: raw.key,
    valueJson: raw.value_json,
    confidence: raw.confidence,
    evidenceJson: raw.evidence_json,
    source:
      raw.source === "user" || raw.source === "stat"
        ? raw.source
        : ("llm" as ProfileFacetRow["source"]),
    conflictJson: raw.conflict_json,
    revision: raw.revision,
    windowStart: raw.window_start,
    windowEnd: raw.window_end,
    updatedAt: raw.updated_at,
  }
}

/** 写入的入参。`value` / `evidence` 是已解析形态，序列化在仓储内做。 */
export interface FacetWrite {
  id: string
  facet: string
  scope: string
  scopeRef: string
  key: string
  value: unknown
  confidence: number
  evidence: readonly string[]
  source: "llm" | "stat" | "user"
  conflict?: { existing: unknown; candidate: unknown } | null
  windowStart?: number | null
  windowEnd?: number | null
}

export class ProfileFacetRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** 按唯一键精确定位。合并的前提 —— 见 profile_facets 的 UNIQUE 注释。 */
  find(facet: string, scope: string, scopeRef: string, key: string): ProfileFacetRow | null {
    const raw = this.db
      .prepare<[string, string, string, string], RawRow>(
        `SELECT * FROM profile_facets
          WHERE facet = ? AND scope = ? AND scope_ref = ? AND key = ?`,
      )
      .get(facet, scope, scopeRef, key)
    return raw === undefined ? null : toRow(raw)
  }

  /** 列出某个 scope 下的全部 facet（materializer 渲染时用）。 */
  listByScope(scope: string, scopeRef = ""): ProfileFacetRow[] {
    return this.db
      .prepare<[string, string], RawRow>(
        `SELECT * FROM profile_facets WHERE scope = ? AND scope_ref = ?
          ORDER BY facet, key`,
      )
      .all(scope, scopeRef)
      .map(toRow)
  }

  list(): ProfileFacetRow[] {
    return this.db
      .prepare<[], RawRow>("SELECT * FROM profile_facets ORDER BY facet, scope, scope_ref, key")
      .all()
      .map(toRow)
  }

  count(): number {
    return (
      this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM profile_facets").get()?.c ?? 0
    )
  }

  /**
   * 写入一条（新建或更新）。
   *
   * ★ 空证据直接抛。这是第二道防线（第一道是 `assertHasEvidence`）——
   * 两道都留着，因为这条不变式一旦破了，画像的可审计性就整体失效，
   * 而那是用户信任这个功能的唯一依据。
   */
  write(input: FacetWrite, now: number): { inserted: boolean; revision: number } {
    if (input.evidence.length === 0) {
      throw new AppError(
        "DISTILL_NO_EVIDENCE",
        `结论 ${input.facet}/${input.key} 没有原文依据，拒绝写入画像`,
        {
          messageKey: "errors:byCode.DISTILL_NO_EVIDENCE",
          context: { facet: input.facet, key: input.key, scope: input.scope },
        },
      )
    }

    const existing = this.find(input.facet, input.scope, input.scopeRef, input.key)
    const valueJson = JSON.stringify(input.value)
    const evidenceJson = JSON.stringify([...input.evidence])
    const conflictJson =
      input.conflict === undefined || input.conflict === null
        ? null
        : JSON.stringify(input.conflict)

    if (existing === null) {
      this.db
        .prepare(
          `INSERT INTO profile_facets
             (id, facet, scope, scope_ref, key, value_json, confidence, evidence_json,
              source, conflict_json, revision, window_start, window_end, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.facet,
          input.scope,
          input.scopeRef,
          input.key,
          valueJson,
          input.confidence,
          evidenceJson,
          input.source,
          conflictJson,
          input.windowStart ?? null,
          input.windowEnd ?? null,
          now,
        )
      return { inserted: true, revision: 1 }
    }

    /**
     * 先留档再改。
     *
     * 顺序反了的话中途失败会留下"改了但没档"的行 —— 而那是无法察觉的
     * （行看起来完全正常，只是版本链少一环）。
     */
    this.db
      .prepare(
        `INSERT OR IGNORE INTO profile_facet_revisions
           (facet_id, revision, value_json, confidence, evidence_json, replaced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        existing.id,
        existing.revision,
        existing.valueJson,
        existing.confidence,
        existing.evidenceJson,
        now,
      )

    const revision = existing.revision + 1
    this.db
      .prepare(
        `UPDATE profile_facets
            SET value_json = ?, confidence = ?, evidence_json = ?, source = ?,
                conflict_json = ?, revision = ?, window_start = ?, window_end = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        valueJson,
        input.confidence,
        evidenceJson,
        input.source,
        conflictJson,
        revision,
        input.windowStart ?? existing.windowStart,
        input.windowEnd ?? existing.windowEnd,
        now,
        existing.id,
      )
    return { inserted: false, revision }
  }

  /** 读某条结论的历史版本（审阅页的"这条为什么变了"）。 */
  revisions(facetId: string): { revision: number; valueJson: string; replacedAt: number }[] {
    return this.db
      .prepare<[string], { revision: number; value_json: string; replaced_at: number }>(
        `SELECT revision, value_json, replaced_at FROM profile_facet_revisions
          WHERE facet_id = ? ORDER BY revision DESC`,
      )
      .all(facetId)
      .map((raw) => ({
        revision: raw.revision,
        valueJson: raw.value_json,
        replacedAt: raw.replaced_at,
      }))
  }

  /**
   * 删一条结论（审阅页的"这条不对"）。
   *
   * 版本链跟着 CASCADE 删 —— 见 v6 迁移里的注释：
   * 留着孤儿版本没有消费者会读，只会让"审计链断裂"无人察觉。
   */
  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM profile_facets WHERE id = ?").run(id)
    return result.changes > 0
  }
}
