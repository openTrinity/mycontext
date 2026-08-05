/**
 * 蒸馏任务表（`distill_tasks`）。
 *
 * ## 为什么蒸馏要有任务表，而不是"一把跑完"
 *
 * 一次全量蒸馏是几十到几百次 LLM 调用（几分钟到几十分钟）。用户会关窗口、
 * 会断网、模型会限流。没有任务表的话每一次中断都意味着**从头再来** ——
 * 而"从头再来"在这里等于重花一遍钱。
 *
 * 所以按 `(facet, scope, scope_ref, window)` 切成行：
 * · 中断后只重跑没 done 的；
 * · 失败的单独记 `last_error` 与 `attempts`（进度页能显示"哪一段失败了、为什么"）；
 * · 唯一键让重复入队变成幂等（增量蒸馏会反复看到同一个窗口）。
 *
 * ## ★ 唯一键必须包含 window
 *
 * 只按 `(facet, scope, scope_ref)` 唯一的话，第二个时间窗会**覆盖**第一个 ——
 * 表现是"蒸馏跑了很久但只有最后一段的结果"，且不报错。
 * v6 的表没建这个 UNIQUE（只有 PRIMARY KEY id），所以去重靠这里的查询做。
 */
import type { SqliteDatabase } from "../database.js"

export type DistillTaskState = "pending" | "running" | "done" | "failed" | "skipped"

export interface DistillTaskRow {
  id: string
  facet: string
  scope: string
  scopeRef: string
  windowStart: number
  windowEnd: number
  state: DistillTaskState
  attempts: number
  lastError: string | null
  inputMessageCount: number | null
  costTokens: number | null
  createdAt: number
  updatedAt: number
}

interface RawRow {
  id: string
  facet: string
  scope: string
  scope_ref: string
  window_start: number
  window_end: number
  state: string
  attempts: number
  last_error: string | null
  input_message_count: number | null
  cost_tokens: number | null
  created_at: number
  updated_at: number
}

const STATES: ReadonlySet<string> = new Set(["pending", "running", "done", "failed", "skipped"])

function toRow(raw: RawRow): DistillTaskRow {
  return {
    id: raw.id,
    facet: raw.facet,
    scope: raw.scope,
    scopeRef: raw.scope_ref,
    windowStart: raw.window_start,
    windowEnd: raw.window_end,
    state: STATES.has(raw.state) ? (raw.state as DistillTaskState) : "pending",
    attempts: raw.attempts,
    lastError: raw.last_error,
    inputMessageCount: raw.input_message_count,
    costTokens: raw.cost_tokens,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

/** 进度快照：引导页第 4 步与设置页都读它。 */
export interface DistillProgress {
  total: number
  pending: number
  running: number
  done: number
  failed: number
  skipped: number
  /** 已花的 token（各任务累加） */
  costTokens: number
  /**
   * 最近一条**需要用户知道**的原因（失败或跳过）。
   *
   * ★ 跳过的原因也要报，不能只报 failed。
   *
   * 最常见的情形恰恰是跳过：身份未确认 → 守卫拒掉全部语料 →
   * 每个任务都 skipped 且各自记了"先去确认身份"。只读 failed 的话
   * 这条**可执行的**提示永远出不来，用户只看到"完成，0 条结论"。
   *
   * failed 优先于 skipped：真错了比"这段没语料"更需要先看。
   */
  lastError: string | null
}

export class DistillTaskRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 入队一个任务；同 `(facet, scope, scope_ref, window)` 已存在则**不动它**。
   *
   * 返回是否真的新建了。幂等是增量蒸馏的前提：每一轮都会重新计算
   * "该蒸哪些窗口"，重复入队必须不产生重复工作
   * （否则每轮都把同一段重蒸一遍，花钱且结论不变）。
   */
  enqueue(
    input: {
      id: string
      facet: string
      scope: string
      scopeRef: string
      windowStart: number
      windowEnd: number
    },
    at: number,
  ): boolean {
    const existing = this.db
      .prepare<[string, string, string, number, number], { id: string }>(
        `SELECT id FROM distill_tasks
          WHERE facet = ? AND scope = ? AND scope_ref = ?
            AND window_start = ? AND window_end = ?`,
      )
      .get(input.facet, input.scope, input.scopeRef, input.windowStart, input.windowEnd)
    if (existing !== undefined) return false

    this.db
      .prepare(
        `INSERT INTO distill_tasks
           (id, facet, scope, scope_ref, window_start, window_end,
            state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        input.id,
        input.facet,
        input.scope,
        input.scopeRef,
        input.windowStart,
        input.windowEnd,
        at,
        at,
      )
    return true
  }

  /**
   * 取一批待跑的任务。
   *
   * `failed` 也算待跑（但 attempts 有上限，见 `maxAttempts`）——
   * 限流/网络抖动导致的失败重试一次通常就好了。
   */
  claimBatch(limit: number, maxAttempts = 3): DistillTaskRow[] {
    return this.db
      .prepare<[number, number], RawRow>(
        `SELECT * FROM distill_tasks
          WHERE (state = 'pending' OR (state = 'failed' AND attempts < ?))
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(maxAttempts, limit)
      .map(toRow)
  }

  markRunning(id: string, at: number): void {
    this.db
      .prepare(
        `UPDATE distill_tasks SET state = 'running', attempts = attempts + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(at, id)
  }

  markDone(id: string, at: number, stats: { inputMessageCount: number; costTokens: number }): void {
    this.db
      .prepare(
        `UPDATE distill_tasks
            SET state = 'done', last_error = NULL, input_message_count = ?,
                cost_tokens = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(stats.inputMessageCount, stats.costTokens, at, id)
  }

  markFailed(id: string, at: number, error: string): void {
    this.db
      .prepare(
        "UPDATE distill_tasks SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
      )
      // 错误串截断：模型返回的原文可能很长，而这一列只用于展示
      .run(error.slice(0, 500), at, id)
  }

  /** 语料为空的窗口标 skipped 而不是 done：两者在进度页上要能区分。 */
  markSkipped(id: string, at: number, reason: string): void {
    this.db
      .prepare(
        "UPDATE distill_tasks SET state = 'skipped', last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(reason.slice(0, 500), at, id)
  }

  progress(): DistillProgress {
    const rows = this.db
      .prepare<
        [],
        { state: string; c: number; tokens: number | null }
      >("SELECT state, count(*) AS c, sum(cost_tokens) AS tokens FROM distill_tasks GROUP BY state")
      .all()

    const progress: DistillProgress = {
      total: 0,
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      costTokens: 0,
      lastError: null,
    }
    for (const row of rows) {
      progress.total += row.c
      progress.costTokens += row.tokens ?? 0
      if (row.state === "pending") progress.pending = row.c
      else if (row.state === "running") progress.running = row.c
      else if (row.state === "done") progress.done = row.c
      else if (row.state === "failed") progress.failed = row.c
      else if (row.state === "skipped") progress.skipped = row.c
    }

    /**
     * failed 优先，其次 skipped。
     *
     * `state = 'failed' DESC` 让 failed 排在前面（SQLite 里 true=1），
     * 同状态内按时间取最新的那条。
     */
    progress.lastError =
      this.db
        .prepare<[], { last_error: string | null }>(
          `SELECT last_error FROM distill_tasks
            WHERE state IN ('failed', 'skipped') AND last_error IS NOT NULL
            ORDER BY (state = 'failed') DESC, updated_at DESC LIMIT 1`,
        )
        .get()?.last_error ?? null

    return progress
  }

  /**
   * 清空任务（"重新蒸馏"时用）。
   *
   * 只删任务**不删 facet**：合并是幂等的（按 `(facet, scope, scope_ref, key)`
   * 定位并按证据合并），重蒸只会补充/更新。删 facet 反而会丢掉
   * 人工确认过的、或来自别的源的结论。
   */
  clear(): number {
    return this.db.prepare("DELETE FROM distill_tasks").run().changes
  }
}
