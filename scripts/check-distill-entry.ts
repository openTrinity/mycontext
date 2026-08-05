/**
 * 蒸馏 runner 的**真实**端到端：切窗 → 跑任务 → facet 落库（会花钱）。
 *
 * 与 `check-map.mjs` 的区别：那个只验 map 一段（消息 → 候选），
 * 这个走完整条链路（任务表 → 守卫 → map → merge → profile_facets），
 * 也就是用户点"开始蒸馏"时真正发生的事。
 *
 * 判据是**画像里真有带证据的结论**，不是"没报错"：
 * 任务全 skipped 也不会报错，而那正是"蒸馏完成但画像是空的"。
 */
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { LlmClient } from "@mycontext/llm"
import { createLogger, systemClock } from "@mycontext/kernel"
import {
  DistillTaskRepository,
  ProfileFacetRepository,
  openStore,
  VAULT_MIGRATIONS,
} from "@mycontext/store"
import { DistillRunner } from "@mycontext/distill"

export interface DistillCheckReport {
  planned: { created: number; total: number }
  ran: number
  done: number
  failed: number
  skipped: number
  /** 每个任务的语料条数与写库结论数 */
  perTask: { facet: string; state: string; accepted: number; written: number; error?: string }[]
  /** 画像里最终有多少条结论 */
  facetCount: number
  /** 按 facet 分组 */
  byFacet: Record<string, number>
  /** 每条结论的证据条数（最小值必须 > 0） */
  minEvidence: number
  sample: { facet: string; key: string; value: string; confidence: number; evidence: number }[]
  costTokens: number
  progress: ReturnType<DistillTaskRepository["progress"]>
  elapsedMs: number
}

export async function runDistillCheck(options: {
  dbPath: string
  baseUrl: string
  apiKey: string
  model: string
  /** 只蒸最近多少天 */
  days?: number
  /** 窗口长度（天） */
  windowDays?: number
  /** 最多跑几个任务（控制花费） */
  maxTasks?: number
  /** 跑前是否清空任务表（重来一遍） */
  reset?: boolean
  now: () => number
}): Promise<DistillCheckReport> {
  if (!existsSync(options.dbPath)) throw new Error(`vault 不存在：${options.dbPath}`)

  const handle = openStore({ path: options.dbPath, migrations: VAULT_MIGRATIONS })
  const logger = createLogger("DistillCheck", { level: "warn" })

  try {
    const tasks = new DistillTaskRepository(handle.db)
    if (options.reset === true) tasks.clear()

    const selfNames = handle.db
      .prepare<[], { display_names_json: string }>(
        "SELECT display_names_json FROM channel_self_identity LIMIT 1",
      )
      .all()
      .flatMap((raw) => JSON.parse(raw.display_names_json) as string[])

    const client = new LlmClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      logger,
      concurrency: 2,
    })

    const runner = new DistillRunner({
      db: handle.db,
      clock: systemClock,
      logger,
      llm: client,
      selfNames,
      newId: () => randomUUID(),
    })

    const startedAt = options.now()
    const until = options.now()
    const planned = runner.plan({
      since: until - (options.days ?? 7) * 86_400_000,
      until,
      ...(options.windowDays === undefined ? {} : { windowDays: options.windowDays }),
    })

    const results = await runner.runBatch(options.maxTasks ?? 6)

    const facets = new ProfileFacetRepository(handle.db)
    const rows = facets.list()
    const byFacet: Record<string, number> = {}
    for (const row of rows) byFacet[row.facet] = (byFacet[row.facet] ?? 0) + 1

    const evidenceCounts = rows.map((row) => (JSON.parse(row.evidenceJson) as string[]).length)

    return {
      planned,
      ran: results.length,
      done: results.filter((item) => item.state === "done").length,
      failed: results.filter((item) => item.state === "failed").length,
      skipped: results.filter((item) => item.state === "skipped").length,
      perTask: results.map((item) => ({
        facet: item.facet,
        state: item.state,
        accepted: item.accepted,
        written: item.written,
        ...(item.error === undefined ? {} : { error: item.error }),
      })),
      facetCount: rows.length,
      byFacet,
      minEvidence: evidenceCounts.length === 0 ? 0 : Math.min(...evidenceCounts),
      sample: rows.slice(0, 10).map((row) => {
        const value = JSON.parse(row.valueJson) as unknown
        return {
          facet: row.facet,
          key: row.key,
          value: (typeof value === "string" ? value : JSON.stringify(value)).slice(0, 120),
          confidence: row.confidence,
          evidence: (JSON.parse(row.evidenceJson) as string[]).length,
        }
      }),
      costTokens: client.usage().totalTokens,
      progress: tasks.progress(),
      elapsedMs: options.now() - startedAt,
    }
  } finally {
    handle.close()
  }
}
