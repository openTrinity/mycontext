/**
 * 引导进度与蒸馏资料源的仓储。
 *
 * 两者放一起：引导的第 3 步就是"选蒸馏源"，所以它们总是一起被读写
 * （引导页要同时知道"走到哪一步了"和"上次选了什么"）。
 */
import type { SqliteDatabase } from "../database.js"

/**
 * 引导的步骤。顺序即展示顺序。
 *
 * ★ `attention`（分身监听范围）在 `sources`（学习范围）之后、`distill`
 * （开始学习）之前 —— 语义顺序是"先选学哪些历史 → 再选盯哪些实时消息
 * → 再开始学"。它与 `sources` **刻意分成两步**（用户原话「在 onboarding
 * 也应该加一个步骤，不和学习范围放一起」）：两者语义相反（只增不减 vs
 * 可随时关掉），合在一步会让用户以为是一件事。
 *
 * ★ 加一步无需迁移：`step` 是无 CHECK 的 TEXT 主键，`list()` 对缺失的 step
 * 合成 `pending` 行（见下）。存量库升级后新步骤自然显示为"待办"。
 */
export const ONBOARDING_STEPS = [
  "channel",
  "model",
  "persona",
  "sources",
  "attention",
  "distill",
] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/**
 * 每步的状态。
 *
 * ★ `skipped` 与 `pending` 必须可区分：用户明确跳过某步之后重进引导，
 * 该步应显示"已跳过"而不是"还没做" —— 后者会让用户以为自己的操作没生效。
 */
export type OnboardingStepState = "pending" | "done" | "skipped"

export interface OnboardingStepRow {
  step: OnboardingStep
  state: OnboardingStepState
  /** 该步的产物（数字人名字/形象、选了哪些源…）。重跑引导时用它回填表单 */
  payload: unknown
  updatedAt: number
}

/** 蒸馏资料源的类型。前两个已接入采集，其余只有选择项（见 UI 的"未接入"标注）。 */
export const DISTILL_SOURCE_KINDS = [
  "chat",
  "minutes",
  "doc",
  "mail",
  "calendar",
  "todo",
  "attendance",
  "ding",
  "drive",
] as const
export type DistillSourceKind = (typeof DISTILL_SOURCE_KINDS)[number]

/** 蒸馏范围。各源用到的字段不同（见 distill_sources.scope_json 的注释）。 */
/**
 * 蒸馏范围。
 *
 * 每个可选字段都显式带 `| undefined`：仓库开了 `exactOptionalPropertyTypes`，
 * 而这个对象是从 IPC 那侧（zod 推导出的类型）原样传进来的 ——
 * zod 的 `.optional()` 推出的是 `k?: T | undefined`（值可以显式为 undefined）。
 * 不带的话赋值处会报类型不兼容，而"修"法通常是加个 `as` —— 那就把
 * 一个真实的形状差异盖住了。
 */
export interface DistillScope {
  /** unix ms；不传 = 不限 */
  since?: number | undefined
  until?: number | undefined
  /** 只蒸馏这些类型的会话（仅 chat 源有意义） */
  chatKinds?: ("direct" | "group")[] | undefined
  /**
   * 会话白名单（空/不传 = 按 chatKinds 全选）。**仅 chat 源**。
   *
   * ★ 刻意**不改名**成 `partitions`：这个键被采集、蒸馏、forge、导出
   * 四处读（`readCollectionScope` / `purgeOutOfScope` / `corpus-predicate`
   * / forge 那侧），而它们不一致过一次 —— 后果是库里 55% 的消息属于
   * 用户没勾的会话。换名是一次大范围破坏性变更，收益只是"名字更好"。
   */
  conversationIds?: string[] | undefined
  /**
   * **分区白名单**（域中立）。文档源用它装空间（知识库 / 云盘目录）的
   * external_id。
   *
   * ## ★★★ 为什么加一个新键而不是复用 `conversationIds`
   *
   * 那个键的名字是**聊天**概念，而 `distill_sources` 是每个 kind 一行 ——
   * 文档那一行里放一批 `wiki_xxx` 却叫 `conversationIds`，会让下一个读
   * 这段代码的人以为文档也按会话切。而更实际的问题是：那四处调用方
   * 读 `conversationIds` 时**默认它是会话** —— 比如 `purgeOutOfScope`
   * 会拿它去删 `messages`。
   *
   * ## ★★ 闸门早就准备好了，缺的只是这个键
   *
   * `admitByScope` 在文档那条路上**已经传对了分区键**
   * （`item.workspaceId ?? ""`），而 `readDomainScope` 对 doc 行读
   * `conversationIds`（恒 undefined）→ `restricted: false` → 分区闸恒放行。
   * 也就是说：过滤能力在，而范围里没有可读的白名单。
   *
   * 后果是用户只能"要么全部知识库、要么一个都不要" —— 而知识库里
   * 可能有与工作无关的空间（个人笔记、他人共享），那些不该进画像语料。
   *
   * ★ 合并规则（唯一一份，在 `readDomainScope` 里）：
   *   chat 域读 `conversationIds`；其余域读 `partitions`。
   *   两个都不存在 → `restricted: false`（不设限）。
   */
  partitions?: string[] | undefined
}

export interface DistillSourceRow {
  kind: DistillSourceKind
  enabled: boolean
  scope: DistillScope
  lastSyncedSeq: number
  state: "idle" | "running" | "failed"
  lastError: string | null
  updatedAt: number
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === "") return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    // 坏 JSON 按缺省处理而不是抛：一个手改过的库不该让整个引导页打不开。
    return fallback
  }
}

export class OnboardingRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 读全部步骤状态。
   *
   * 缺的步骤补成 `pending` —— 让调用方永远拿到**完整的四步**，
   * 不必自己处理"表里还没有这一行"。首次进入引导时表是空的，
   * 而 UI 需要把四步都画出来。
   */
  list(): OnboardingStepRow[] {
    const rows = this.db
      .prepare<
        [],
        { step: string; state: string; payload_json: string | null; updated_at: number }
      >("SELECT step, state, payload_json, updated_at FROM onboarding_progress")
      .all()
    const byStep = new Map(rows.map((row) => [row.step, row]))

    return ONBOARDING_STEPS.map((step) => {
      const row = byStep.get(step)
      return {
        step,
        state:
          row?.state === "done" || row?.state === "skipped"
            ? row.state
            : ("pending" as OnboardingStepState),
        payload: parseJson<unknown>(row?.payload_json ?? null, null),
        updatedAt: row?.updated_at ?? 0,
      }
    })
  }

  /** 标记某步的状态（幂等 upsert）。`payload` 不传时保留原值。 */
  setStep(step: OnboardingStep, state: OnboardingStepState, at: number, payload?: unknown): void {
    this.db
      .prepare(
        `INSERT INTO onboarding_progress (step, state, payload_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(step) DO UPDATE SET
           state = excluded.state,
           -- payload 不传时保留原值：只改状态不该把上次填的表单清空
           payload_json = COALESCE(excluded.payload_json, onboarding_progress.payload_json),
           updated_at = excluded.updated_at`,
      )
      .run(step, state, payload === undefined ? null : JSON.stringify(payload), at)
  }

  /**
   * 引导是否已完成。
   *
   * 判据是**四步都不是 pending**（done 或 skipped 都算走过了）——
   * 而不是"有没有授权"。后者是首版的 bug：授权成功就跳过了另外三步。
   */
  isComplete(): boolean {
    return this.list().every((row) => row.state !== "pending")
  }

  /**
   * 重新走引导：把所有步骤重置成 pending，但**保留 payload**。
   *
   * 保留是刻意的：用户重走引导通常是为了改某一步（比如换蒸馏范围），
   * 把上次填的名字/形象/会话选择也清掉会让他重新填一遍无关的东西。
   */
  reset(at: number): void {
    this.db.prepare("UPDATE onboarding_progress SET state = 'pending', updated_at = ?").run(at)
  }
}

export class DistillSourceRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** 读全部源；缺的补成"未启用" —— 与 OnboardingRepository.list 同一个理由。 */
  list(): DistillSourceRow[] {
    const rows = this.db
      .prepare<
        [],
        {
          kind: string
          enabled: number
          scope_json: string | null
          last_synced_seq: number
          state: string
          last_error: string | null
          updated_at: number
        }
      >("SELECT * FROM distill_sources")
      .all()
    const byKind = new Map(rows.map((row) => [row.kind, row]))

    return DISTILL_SOURCE_KINDS.map((kind) => {
      const row = byKind.get(kind)
      return {
        kind,
        enabled: row?.enabled === 1,
        scope: parseJson<DistillScope>(row?.scope_json ?? null, {}),
        lastSyncedSeq: row?.last_synced_seq ?? 0,
        state:
          row?.state === "running" || row?.state === "failed"
            ? row.state
            : ("idle" as DistillSourceRow["state"]),
        lastError: row?.last_error ?? null,
        updatedAt: row?.updated_at ?? 0,
      }
    })
  }

  /** 保存一个源的启用状态与范围。 */
  upsert(
    kind: DistillSourceKind,
    input: { enabled: boolean; scope: DistillScope },
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO distill_sources (kind, enabled, scope_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET
           enabled = excluded.enabled,
           scope_json = excluded.scope_json,
           updated_at = excluded.updated_at`,
      )
      .run(kind, input.enabled ? 1 : 0, JSON.stringify(input.scope), at)
  }

  /**
   * 推进增量水位。
   *
   * 用 `MAX` 而不是直接赋值：并发/重试下不能让水位**倒退**
   * （倒退会导致同一批消息被重复蒸馏 —— 那是真金白银的 LLM 调用）。
   */
  advance(kind: DistillSourceKind, seq: number, at: number): void {
    this.db
      .prepare(
        `UPDATE distill_sources
            SET last_synced_seq = MAX(last_synced_seq, ?), state = 'idle',
                last_error = NULL, updated_at = ?
          WHERE kind = ?`,
      )
      .run(seq, at, kind)
  }

  /** 重置某个源的水位（用户明确要求"重新蒸馏"时）。 */
  resetProgress(kind: DistillSourceKind, at: number): void {
    this.db
      .prepare(
        "UPDATE distill_sources SET last_synced_seq = 0, state = 'idle', last_error = NULL, updated_at = ? WHERE kind = ?",
      )
      .run(at, kind)
  }

  setState(
    kind: DistillSourceKind,
    state: DistillSourceRow["state"],
    at: number,
    error?: string,
  ): void {
    this.db
      .prepare(
        "UPDATE distill_sources SET state = ?, last_error = ?, updated_at = ? WHERE kind = ?",
      )
      .run(state, error ?? null, at, kind)
  }
}
