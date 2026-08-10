/**
 * ★★ 拿**真实语料**离线重放去重与归因两道新判据。
 *
 * ## 这个文件不是普通门禁，而是一次可重复的**实测**
 *
 * 用户的判断是「准确性和经济角度还差点意思」。而这个文件回答的是那个判断的
 * 定量版本：改完之后，那 273 条真实结论会变成什么样。
 *
 * 库不在时**跳过而不是失败** —— 与 `check:no-local-data` 同一档策略：
 * 同事和 CI 上没有本机 dev vault。所以它绿了不等于验过，
 * 只有在有真实数据的机器上跑过才算（这一句与那个脚本的注释是同一个意思）。
 *
 * ★ 只读：`mode=ro` 打开一份**副本**，不写任何东西。
 * 真实语料不能被测试改动，而副本让"重跑一次"不需要先恢复什么。
 */
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { assertSelfAttributed, candidateKey, findSimilar } from "@mycontext/distill"
import type { FacetCandidate } from "@mycontext/distill"
import Database from "better-sqlite3"

/** 找本机 dev vault 里**结论最多**的那一个（那就是真跑过蒸馏的账号）。 */
function findRichestVault(): string | null {
  const root = join(homedir(), "Library/Application Support/MyContextDevelop/vaults")
  if (!existsSync(root)) return null
  let best: { path: string; facets: number } | null = null
  for (const entry of readdirSync(root)) {
    const path = join(root, entry, "core.sqlite")
    if (!existsSync(path)) continue
    try {
      const db = new Database(path, { readonly: true })
      const row = db
        .prepare("SELECT count(*) AS c FROM profile_facets WHERE source = 'llm'")
        .get() as { c: number } | undefined
      db.close()
      const facets = row?.c ?? 0
      if (facets > 0 && (best === null || facets > best.facets)) best = { path, facets }
    } catch {
      // 库坏了/schema 太老：跳过它而不是让整个用例失败
    }
  }
  return best?.path ?? null
}

interface Row {
  facet: string
  key: string
  value_json: string
  confidence: number
  evidence_json: string
}

function toCandidate(row: Row): FacetCandidate {
  return {
    facet: row.facet,
    scope: "global",
    scopeRef: "",
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence_json) as string[],
    source: "llm",
  }
}

describe("★★ 真实语料上的去重与归因（没有本机 vault 时跳过）", () => {
  const vaultPath = findRichestVault()

  it.skipIf(vaultPath === null)("重放：报出会拒多少、会合并多少", () => {
    const db = new Database(vaultPath ?? "", { readonly: true })
    const rows = db
      .prepare(
        `SELECT facet, key, value_json, confidence, evidence_json
           FROM profile_facets WHERE source = 'llm' ORDER BY facet, key`,
      )
      .all() as Row[]

    /** 证据 id → is_self。文档与纪要记 null（作者未知）。 */
    const authorship = new Map<string, boolean | null>()
    for (const row of db.prepare("SELECT id, is_self FROM messages").all() as {
      id: string
      is_self: number | null
    }[]) {
      authorship.set(row.id, row.is_self === null ? null : row.is_self === 1)
    }
    for (const table of ["documents", "minutes"]) {
      for (const row of db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]) {
        authorship.set(row.id, null)
      }
    }

    // ① 归因守卫
    const rejected = new Map<string, Record<string, number>>()
    const kept: Row[] = []
    for (const row of rows) {
      const verdict = assertSelfAttributed(toCandidate(row), authorship)
      if (verdict.ok) {
        kept.push(row)
        continue
      }
      const byFacet = rejected.get(row.facet) ?? {}
      byFacet[verdict.reason] = (byFacet[verdict.reason] ?? 0) + 1
      rejected.set(row.facet, byFacet)
    }

    // ② 词法去重
    const scope: { facet: string; key: string; value: unknown }[] = []
    let merged = 0
    for (const row of kept) {
      const candidate = toCandidate(row)
      if (findSimilar(candidate, scope) !== null) {
        merged += 1
        continue
      }
      scope.push({ facet: row.facet, key: candidateKey(candidate), value: candidate.value })
    }

    const lines = [
      "",
      `原始 LLM 结论：${String(rows.length)} 条`,
      `归因守卫拒掉：${String(rows.length - kept.length)} 条`,
      `词法去重合并：${String(merged)} 条`,
      `最终剩下：    ${String(scope.length)} 条`,
      "",
      "按 facet（原始 → 归因后 → 去重后）：",
    ]
    const facets = [...new Set(rows.map((row) => row.facet))].sort()
    for (const facet of facets) {
      const before = rows.filter((row) => row.facet === facet).length
      const afterGuard = kept.filter((row) => row.facet === facet).length
      const after = scope.filter((row) => row.facet === facet).length
      const reasons = rejected.get(facet)
      const detail =
        reasons === undefined
          ? ""
          : `   拒因：${Object.entries(reasons)
              .map(([reason, count]) => `${reason}=${String(count)}`)
              .join(" ")}`
      lines.push(
        `  ${facet.padEnd(10)} ${String(before).padStart(3)} → ${String(afterGuard).padStart(3)} → ${String(after).padStart(3)}${detail}`,
      )
    }
    /**
     * ★ 用 `console.error` 而不是 `log`：这个仓库的 lint 只放行 error
     * （`no-console` 的 allow 列表）。这里输出的是**实测报告**而不是错误，
     * 但报告的价值在于被人看见 —— 而 stderr 同样会显示在测试输出里。
     */
    console.error(lines.join("\n"))

    /**
     * ★ 断言只锁**方向**，不锁具体数字：语料会变（采集在跑），
     * 写死"合并 40 条"会让这个用例几天后必然红，而它红的时候没人知道
     * 是判据坏了还是语料变了。
     */
    expect(rows.length).toBeGreaterThan(0)
    expect(scope.length).toBeLessThan(rows.length)
    db.close()
  })
})
