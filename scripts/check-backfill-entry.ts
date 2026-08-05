/**
 * 回溯链的真库探针 —— 回答「选了 180 天，这台机器会怎么补」。
 *
 * ## 为什么必须用产品里那个 `IngestScheduler`
 *
 * 探针自己按同样的公式再算一遍是没有价值的：那样两边一起写错也一起绿
 * （记忆里那条"反证本身也会写错"就是这个形状）。这里 new 的是**产品那个类**，
 * 读的是**产品那个仓储**，`floor` 取的是**引导真的写进库的**
 * `distill_sources.scope_json.since`。
 *
 * ## 它验的是三件在单测里验不到的事
 *
 * 1. 库里那个 `scope_json` 真的能被读出来（字段名 / JSON 形状 / enabled 位）；
 * 2. 规划出的窗**连续且不越界**，末窗恰好停在实时路起点；
 * 3. `commitBackfill` 真的能在这个 schema 上把进度写进去并读回来
 *    —— 那是我在写这条链时发现 `commitWindow` 静默 no-op 的那个坑。
 *
 * ★ 只跑在**副本**上（调用方负责拷贝）：这条探针会写 `sync_cursors`。
 */
import { DistillSourceRepository, VAULT_MIGRATIONS, openStore } from "@mycontext/store"
import { IngestScheduler, INITIAL_BACKFILL_MS } from "@mycontext/ingest"
import { systemClock } from "@mycontext/kernel"

export interface BackfillProbeReport {
  /** 引导里选的起点（unix ms）。null = 没选过 / 聊天源关了 */
  floor: number | null
  /** 回溯终点 = now - 7d */
  ceiling: number
  /** 库里最早一条消息 */
  earliestMessage: number | null
  /** 现在缺多少天历史（floor 到最早那条之间） */
  missingDays: number | null
  /** 规划出的窗数（一轮补一个） */
  plannedWindows: number
  /** 窗口首尾 */
  firstWindow: { start: number; end: number } | null
  lastWindow: { start: number; end: number } | null
  /** 窗口是否首尾相接、无缝隙 */
  contiguous: boolean
  /** 末窗右端是否 ≤ ceiling（越界就会与实时路重叠白跑） */
  withinCeiling: boolean
  /** 进度真的能写进去并读回来（那个 upsert 坑的回归） */
  progressPersists: boolean
  /** 回溯 scope 与实时 scope 确实不同 */
  scopesDistinct: boolean
}

export function runBackfillProbe(options: {
  dbPath: string
  channelId: string
}): BackfillProbeReport {
  const handle = openStore({ path: options.dbPath, migrations: VAULT_MIGRATIONS })
  try {
    const scheduler = new IngestScheduler({
      db: handle.db,
      clock: systemClock,
      channelId: options.channelId,
    })

    // 用产品的读法拿 floor —— 字段名或 enabled 位写错时这里就是 null
    const chat = new DistillSourceRepository(handle.db)
      .list()
      .find((source) => source.kind === "chat")
    const floor = chat !== undefined && chat.enabled ? (chat.scope.since ?? null) : null

    const now = systemClock.now()
    const ceiling = now - INITIAL_BACKFILL_MS
    const earliest =
      handle.db.prepare<[], { t: number | null }>("SELECT MIN(sent_at) AS t FROM messages").get()
        ?.t ?? null

    const base: BackfillProbeReport = {
      floor,
      ceiling,
      earliestMessage: earliest,
      missingDays:
        floor === null || earliest === null
          ? null
          : Math.max(0, Math.round((earliest - floor) / 86_400_000)),
      plannedWindows: 0,
      firstWindow: null,
      lastWindow: null,
      contiguous: true,
      withinCeiling: true,
      progressPersists: false,
      scopesDistinct: scheduler.scope !== scheduler.backfillScope,
    }
    if (floor === null) return base

    /**
     * 走一遍完整规划：每次 `commitBackfill` 之后再问下一个窗 ——
     * 这与生产里"一轮补一个窗"的时序**完全一致**，
     * 所以它顺带验了进度真的被持久化（不持久化的话这个循环永远拿到同一个窗）。
     */
    const windows: { start: number; end: number }[] = []
    for (let i = 0; i < 5000; i++) {
      const window = scheduler.backfillWindow(floor)
      if (window === null) break
      windows.push({ start: window.start, end: window.end })
      scheduler.commitBackfill(window.end)
    }

    const contiguous = windows.every(
      (window, index) => index === 0 || window.start === windows[index - 1]?.end,
    )
    const last = windows.at(-1) ?? null
    return {
      ...base,
      plannedWindows: windows.length,
      firstWindow: windows[0] ?? null,
      lastWindow: last,
      contiguous,
      withinCeiling: last === null || last.end <= ceiling,
      // 循环能终止就说明进度写进去了（否则它会一直拿到首窗直到撞 5000）
      progressPersists: windows.length > 0 && windows.length < 5000,
    }
  } finally {
    handle.close()
  }
}
