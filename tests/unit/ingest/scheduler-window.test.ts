/**
 * 采集调度的时间窗规则。
 *
 * 这三条规则各自防一种**静默丢消息**（数据看起来采到了，实际缺了一段，
 * 而且缺的那段永远不会被重拉，因为水位已经推过去了）：
 * ① 只在整窗全部分页确认落库后才推进 watermark；
 * ② 达到 limit 的 90% 即疑似截断 → 二分切窗；
 * ③ 用**服务端**返回的最大时间推水位，不用本地 now。
 *
 * 全部注入 ManualClock：窗口逻辑依赖"现在几点"，用真实时钟测不了边界。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, MS_PER_MINUTE } from "@mycontext/kernel"
import {
  ConversationRepository,
  ProbeSnapshotRepository,
  SyncCursorRepository,
} from "@mycontext/store"
import {
  AdaptiveInterval,
  INITIAL_BACKFILL_MS,
  IngestScheduler,
  MIN_WINDOW_MS,
  WINDOW_LOOKAHEAD_MS,
  WINDOW_OVERLAP_MS,
  type PullWindow,
} from "@mycontext/ingest"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000

function makeScheduler(clock: ManualClock, pageLimit = 50) {
  const vault = openTestVault()
  const scheduler = new IngestScheduler({
    db: vault.db,
    clock,
    channelId: "dingtalk",
    pageLimit,
  })
  return { vault, scheduler, cursors: new SyncCursorRepository(vault.db, clock) }
}

/**
 * 模拟调用方「整窗抽干后推水位」的那一步。
 *
 * `IngestScheduler.commitWindow(window, maxSentAt)` 已被删掉：它只是
 * `commitProgress(maxSentAt ?? window.end)` 的一层薄壳，而两者的正确性前提
 * 完全不同 —— 前者要求传"被完整抽干的窗"，传一个被 `splitIfTruncated`
 * 切小的窗就会把右半永久跳过（那正是修复前的 bug，且在阅读时看不出来）。
 * 现在服务层显式算 effectiveEnd 后调 `commitProgress`，这个 helper 就是
 * 那段计算的等价物，只在测试里保留。
 */
function commitDrainedWindow(
  scheduler: IngestScheduler,
  // 收 PullWindow 而不是 `{ end }`：调用点传的都是完整窗对象，
  // 收窄成 `{ end }` 会让对象字面量因多余属性而报 TS2353。
  window: PullWindow,
  maxSentAt: number | null,
): void {
  scheduler.commitProgress(maxSentAt ?? window.end)
}

describe("时间窗计算", () => {
  it("首次采集从回溯窗口开始（没有水位）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const window = scheduler.nextWindow()
    expect(window.start).toBe(START - INITIAL_BACKFILL_MS)
    vault.close()
  })

  it("有水位时往回退一个重叠窗（对抗时钟偏差与服务端延迟）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    scheduler.beginWindow({ start: START - 10_000, end: START, cursor: null })
    commitDrainedWindow(
      scheduler,
      { start: START - 10_000, end: START, cursor: null },
      START - 1000,
    )

    const window = scheduler.nextWindow()
    expect(window.start).toBe(START - 1000 - WINDOW_OVERLAP_MS)
    vault.close()
  })

  it("end 向前留量（本地时钟慢时不漏刚到的消息）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    expect(scheduler.nextWindow().end).toBe(START + WINDOW_LOOKAHEAD_MS)
    vault.close()
  })
})

describe("★ 只在整窗确认后推进水位", () => {
  it("分页推进不动水位", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    const window = { start: START - 60_000, end: START, cursor: null }

    scheduler.beginWindow(window)
    scheduler.advancePage("cursor-2")
    scheduler.advancePage("cursor-3")

    const row = cursors.get(scheduler.scope)
    expect(row?.pageCount).toBe(2)
    expect(row?.cursor).toBe("cursor-3")
    // ★ 关键：取了两页但水位仍是 0 —— 此刻崩溃会整窗重跑，不丢尾部。
    expect(row?.watermark).toBe(0)
    // 公开 getter 与库里的值必须一致（回溯脚本靠它判断"追上了没有"）
    expect(scheduler.watermark).toBe(0)
    vault.close()
  })

  it("watermark getter 反映 commitProgress 的结果（回溯脚本的进度判据）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    expect(scheduler.watermark).toBe(0)
    scheduler.beginWindow({ start: START - 60_000, end: START, cursor: null })
    scheduler.commitProgress(START - 10_000)
    expect(scheduler.watermark).toBe(START - 10_000)
    vault.close()
  })

  it("半途失败后水位不动，下次整窗重跑", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    const window = { start: START - 60_000, end: START, cursor: null }

    scheduler.beginWindow(window)
    scheduler.advancePage("cursor-2")
    scheduler.failWindow("network error")

    expect(cursors.get(scheduler.scope)?.watermark).toBe(0)
    expect(cursors.get(scheduler.scope)?.status).toBe("failed")
    // 下次的窗口起点仍在原处（首次回溯窗），不会跳过这一段
    expect(scheduler.nextWindow().start).toBe(START - INITIAL_BACKFILL_MS)
    vault.close()
  })

  it("整窗确认后水位才推进", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    const window = { start: START - 60_000, end: START, cursor: null }
    scheduler.beginWindow(window)
    scheduler.advancePage(null)
    commitDrainedWindow(scheduler, window, START - 5_000)

    expect(cursors.get(scheduler.scope)?.watermark).toBe(START - 5_000)
    expect(cursors.get(scheduler.scope)?.status).toBe("idle")
    vault.close()
  })
})

describe("★ 用服务端时间推水位，不用本地 now", () => {
  it("传入服务端最大时间时以它为准", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    const window = { start: START - 60_000, end: START + WINDOW_LOOKAHEAD_MS, cursor: null }
    scheduler.beginWindow(window)
    // 本地时钟给的 end 比服务端最新消息还晚 —— 用 end 推水位会跳过那段差值
    commitDrainedWindow(scheduler, window, START - 30_000)
    expect(cursors.get(scheduler.scope)?.watermark).toBe(START - 30_000)
    vault.close()
  })

  it("本窗无消息且窗口右端未越过 now 时，退回窗口右端（确实没有，不会漏）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    const window = { start: START - 60_000, end: START, cursor: null }
    scheduler.beginWindow(window)
    commitDrainedWindow(scheduler, window, null)
    expect(cursors.get(scheduler.scope)?.watermark).toBe(START)
    vault.close()
  })

  it("水位只增不减（迟到的旧消息不会把水位拉回去）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    const window = { start: START - 60_000, end: START, cursor: null }
    scheduler.beginWindow(window)
    commitDrainedWindow(scheduler, window, START)
    scheduler.beginWindow(window)
    commitDrainedWindow(scheduler, window, START - 100_000)
    expect(cursors.get(scheduler.scope)?.watermark).toBe(START)
    vault.close()
  })
})

/**
 * ★ 水位永不超过 now —— 空窗黑洞的回归防线。
 *
 * 修复前 `commitWindow` 用 `maxSentAt ?? window.end`，而 `nextWindow()` 给的
 * `end = now + WINDOW_LOOKAHEAD_MS`。本窗无消息时水位被推到未来 5 分钟，
 * 下一窗 `start = watermark - WINDOW_OVERLAP_MS = now + 3min` 跑到 now 之后，
 * `[now, now+3min)` 这段再也不会被任何窗覆盖 —— 落在里面的消息永久丢失。
 * 实测「新账号 + 安静期」6 轮，服务端 5 条消息 100% 未采集。
 *
 * `MAX(watermark, ?)` 只防回退不防推太远，所以 clamp 必须在 `commitProgress` 里。
 */
describe("★ 水位永不超过 now（空窗不造黑洞）", () => {
  it("空窗 + nextWindow 的 lookahead 右端：水位 clamp 到 now，不进未来", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    const window = scheduler.nextWindow()
    // 前提：窗口右端确实越过了 now（否则这条测试测不到东西）
    expect(window.end).toBe(START + WINDOW_LOOKAHEAD_MS)

    scheduler.beginWindow(window)
    commitDrainedWindow(scheduler, window, null)

    expect(cursors.get(scheduler.scope)?.watermark).toBe(START)
    vault.close()
  })

  it("空窗后下一窗仍覆盖 now 之前（黑洞不存在）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const first = scheduler.nextWindow()
    scheduler.beginWindow(first)
    commitDrainedWindow(scheduler, first, null)

    const next = scheduler.nextWindow()
    // 修复前这里是 now + 3min（黑洞）；现在必须回退到 now 之前
    expect(next.start).toBeLessThanOrEqual(START)
    expect(next.start).toBe(START - WINDOW_OVERLAP_MS)
    vault.close()
  })

  it("服务端时钟超前时 maxSentAt 同样 clamp（宁可下轮重拉，幂等兜住）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    const window = { start: START - 60_000, end: START + WINDOW_LOOKAHEAD_MS, cursor: null }
    scheduler.beginWindow(window)
    commitDrainedWindow(scheduler, window, START + 10 * MS_PER_MINUTE)
    expect(cursors.get(scheduler.scope)?.watermark).toBe(START)
    vault.close()
  })

  it("连续多轮空窗不会让水位累积漂移到未来", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    for (let round = 0; round < 6; round += 1) {
      const window = scheduler.nextWindow()
      scheduler.beginWindow(window)
      commitDrainedWindow(scheduler, window, null)
      // 每轮都必须成立：水位 ≤ now
      expect(cursors.get(scheduler.scope)?.watermark).toBeLessThanOrEqual(clock.now())
      clock.advance(MS_PER_MINUTE)
    }
    vault.close()
  })
})

describe("★ 截断检测与二分切窗", () => {
  it("没有下一页却刚好满页时，切成两个子窗（右半不丢）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, 50)
    const window = { start: START - 60 * MS_PER_MINUTE, end: START, cursor: null }
    const split = scheduler.splitIfTruncated(window, {
      itemCount: 45,
      nextCursor: null,
    })
    expect(split).not.toBeNull()
    const [left, right] = split as readonly [typeof window, typeof window]
    const mid = window.start + 30 * MS_PER_MINUTE
    expect(left.start).toBe(window.start)
    expect(left.end).toBe(mid)
    // ★ 右半必须被返回：旧实现只给左半，右半那段历史永久跳过
    expect(right.start).toBe(mid)
    expect(right.end).toBe(window.end)
    vault.close()
  })

  /**
   * ★ 分页场景下「满页」是正常的，不是截断信号。
   *
   * `looksTruncated` 是「达到 limit 的 90%」，而满页正是 nextCursor 存在的原因 ——
   * 对每页都判定会让每轮都在第一页就切窗。实测「每分钟 1 条消息的 7 天回溯」
   * 每轮 9 次 CLI 调用只推进 0.025 天，走完 7 天需约 280 轮 / 2500 次调用。
   */
  it("有下一页时满页不算截断（否则回溯几乎停滞）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, 50)
    const window = { start: START - 60 * MS_PER_MINUTE, end: START, cursor: null }
    expect(
      scheduler.splitIfTruncated(window, {
        itemCount: 50,
        nextCursor: "cursor-2",
      }),
    ).toBeNull()
    vault.close()
  })

  it("未达阈值时不切", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, 50)
    const window = { start: START - 60 * MS_PER_MINUTE, end: START, cursor: null }
    expect(scheduler.splitIfTruncated(window, { itemCount: 44, nextCursor: null })).toBeNull()
    vault.close()
  })

  /**
   * 切到最小宽度还截断：只能接受可能缺数据，但**必须让它可见**
   * （标 truncated + 告警），而不是静默继续。
   */
  it("切到最小宽度时标记 truncated 并停止切分", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock, 50)
    scheduler.beginWindow({ start: START - MIN_WINDOW_MS, end: START, cursor: null })
    const split = scheduler.splitIfTruncated(
      { start: START - MIN_WINDOW_MS, end: START, cursor: null },
      { itemCount: 50, nextCursor: null },
    )
    expect(split).toBeNull()
    expect(cursors.get(scheduler.scope)?.truncated).toBe(true)
    vault.close()
  })

  it("两个子窗在 mid 处相接，合起来完整覆盖原窗（不留缝）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, 50)
    const window = { start: START - 61 * MS_PER_MINUTE, end: START, cursor: null }
    const split = scheduler.splitIfTruncated(window, {
      itemCount: 50,
      nextCursor: null,
    })
    const [left, right] = split as readonly [typeof window, typeof window]
    // 相接而非留缝：left.end === right.start
    expect(left.end).toBe(right.start)
    expect(left.start).toBe(window.start)
    expect(right.end).toBe(window.end)
    vault.close()
  })
})

describe("探针比对", () => {
  it("首次见到的会话都算有变化", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const hints = scheduler.diffProbe(
      { conversations: [{ externalId: "cid-1", lastMsgAt: START, unreadCount: 2 }] },
      START,
    )
    expect(hints.map((hint) => hint.conversationExternalId)).toEqual(["cid-1"])
    vault.close()
  })

  it("时间与未读数都没变时不算变化（省掉正文拉取的成本）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const probe = { conversations: [{ externalId: "cid-1", lastMsgAt: START, unreadCount: 2 }] }
    scheduler.diffProbe(probe, START)
    expect(scheduler.diffProbe(probe, START + 1000)).toEqual([])
    vault.close()
  })

  it("lastMsgAt 前进即算变化", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    scheduler.diffProbe(
      { conversations: [{ externalId: "cid-1", lastMsgAt: START, unreadCount: 0 }] },
      START,
    )
    const hints = scheduler.diffProbe(
      { conversations: [{ externalId: "cid-1", lastMsgAt: START + 5000, unreadCount: 0 }] },
      START + 5000,
    )
    expect(hints.length).toBe(1)
    vault.close()
  })

  it("完整未读快照中缺席的已知会话会被明确标记为已读", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    new ConversationRepository(vault.db).upsert({
      id: "conv-read",
      channelId: "dingtalk",
      externalId: "cid-read",
      type: "direct",
      title: "已读会话",
      createdAt: START - 1000,
    })

    scheduler.diffProbe({ conversations: [], completeUnreadSnapshot: true }, START)

    expect(new ProbeSnapshotRepository(vault.db).get("dingtalk", "cid-read")).toMatchObject({
      unreadCount: 0,
      observedAt: START,
    })
    vault.close()
  })

  it("非完整未读快照不能把缺席会话误判为已读", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    new ConversationRepository(vault.db).upsert({
      id: "conv-unknown",
      channelId: "dingtalk",
      externalId: "cid-unknown",
      type: "direct",
      title: "读状态未知",
      createdAt: START - 1000,
    })

    scheduler.diffProbe({ conversations: [], completeUnreadSnapshot: false }, START)

    expect(new ProbeSnapshotRepository(vault.db).get("dingtalk", "cid-unknown")).toBeNull()
    vault.close()
  })
})

/**
 * ★ 已读的会话必须被清零。
 *
 * 探针命令是 `chat message list-unread-conversations` —— 它**只返回当前
 * 未读**的会话。而写入是 upsert，于是"读过了"这件事在库里没有任何
 * 对应的写：那一行会一直留着旧的 `unread_count`。
 *
 * 实测这个偏差真的发生了：库里 30 行 `unread_count > 0`，而探针此刻只
 * 返回 17 个 —— 差的 13 行是已经读过的，最老一行观测于 11 小时前、
 * 仍写着 `unread=1`。
 *
 * 把这一列直接显示出来就是一堆**幽灵未读**：用户点进去发现没有新消息，
 * 然后不再相信这个数字 —— 那比不显示更糟。
 */
describe("★ 未读清零：本轮没返回的会话说明已经读了", () => {
  it("上一轮有未读、这一轮没出现 → 清零", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const probes = new ProbeSnapshotRepository(vault.db)

    scheduler.diffProbe(
      {
        conversations: [
          { externalId: "cid-read", lastMsgAt: START, unreadCount: 3 },
          { externalId: "cid-still", lastMsgAt: START, unreadCount: 1 },
        ],
        completeUnreadSnapshot: true,
      },
      START,
    )
    expect(probes.get("dingtalk", "cid-read")?.unreadCount).toBe(3)

    // 下一轮：cid-read 被读掉了 → 探针不再返回它
    scheduler.diffProbe(
      {
        conversations: [{ externalId: "cid-still", lastMsgAt: START, unreadCount: 1 }],
        completeUnreadSnapshot: true,
      },
      START + 15_000,
    )

    expect(probes.get("dingtalk", "cid-read")?.unreadCount).toBe(0)
    // 仍未读的那个不受影响
    expect(probes.get("dingtalk", "cid-still")?.unreadCount).toBe(1)
    vault.close()
  })

  it("★ 清零**不删行**，`lastMsgAt` 要保留（否则下一轮把每个会话都判成变了）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const probes = new ProbeSnapshotRepository(vault.db)

    scheduler.diffProbe(
      {
        conversations: [{ externalId: "cid-1", lastMsgAt: START, unreadCount: 5 }],
        completeUnreadSnapshot: true,
      },
      START,
    )
    scheduler.diffProbe({ conversations: [], completeUnreadSnapshot: true }, START + 15_000)

    const row = probes.get("dingtalk", "cid-1")
    expect(row).not.toBeNull()
    expect(row?.unreadCount).toBe(0)
    /**
     * `last_msg_at` 是下一轮 `changed` 比对的基准。删行或清掉它的话，
     * 下一轮 `previous === null` → 每个会话都算"变了" → 每轮全量拉正文。
     */
    expect(row?.lastMsgAt).toBe(START)
    vault.close()
  })

  it("清零之后那个会话再次未读 → 又能被记上（不是一次性的）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const probes = new ProbeSnapshotRepository(vault.db)

    scheduler.diffProbe(
      {
        conversations: [{ externalId: "cid-1", lastMsgAt: START, unreadCount: 2 }],
        completeUnreadSnapshot: true,
      },
      START,
    )
    scheduler.diffProbe({ conversations: [], completeUnreadSnapshot: true }, START + 15_000)
    expect(probes.get("dingtalk", "cid-1")?.unreadCount).toBe(0)

    // 又来新消息了
    const hints = scheduler.diffProbe(
      {
        conversations: [{ externalId: "cid-1", lastMsgAt: START + 30_000, unreadCount: 4 }],
        completeUnreadSnapshot: true,
      },
      START + 30_000,
    )
    expect(probes.get("dingtalk", "cid-1")?.unreadCount).toBe(4)
    // 而且要算成"变了"（lastMsgAt 前进了）
    expect(hints.length).toBe(1)
    vault.close()
  })

  it("只影响本渠道（多渠道之后清零不能跨渠道）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const probes = new ProbeSnapshotRepository(vault.db)
    // 手写一行别的渠道的未读
    probes.upsert({
      channelId: "feishu",
      conversationExternalId: "oc-1",
      lastMsgAt: START,
      unreadCount: 7,
      observedAt: START,
    })

    scheduler.diffProbe({ conversations: [], completeUnreadSnapshot: true }, START + 15_000)

    expect(probes.get("feishu", "oc-1")?.unreadCount).toBe(7)
    vault.close()
  })
})

describe("自适应周期（探针耗时占周期比）", () => {
  it("耗时超过半个周期时降频", () => {
    const interval = new AdaptiveInterval(15_000, 120_000)
    expect(interval.intervalMs).toBe(15_000)
    interval.observe(9_000)
    expect(interval.intervalMs).toBe(22_500)
    expect(interval.throttled).toBe(true)
  })

  it("降频有上限（不会无限退化）", () => {
    const interval = new AdaptiveInterval(15_000, 60_000)
    for (let round = 0; round < 20; round += 1) interval.observe(50_000)
    expect(interval.intervalMs).toBe(60_000)
  })

  it("恢复后逐步回落，而不是一次跳回（避免临界点抖动）", () => {
    const interval = new AdaptiveInterval(15_000, 120_000)
    interval.observe(9_000)
    const throttled = interval.intervalMs
    interval.observe(100)
    expect(interval.intervalMs).toBeLessThan(throttled)
    expect(interval.intervalMs).toBeGreaterThanOrEqual(15_000)
  })

  it("正常耗时不改变周期", () => {
    const interval = new AdaptiveInterval(15_000, 120_000)
    interval.observe(700) // 实测 L1 探针耗时
    expect(interval.intervalMs).toBe(15_000)
    expect(interval.throttled).toBe(false)
  })
})

describe("空闲检测（触发 WAL checkpoint）", () => {
  it("连续 5 轮无新消息后返回 true 且计数复位", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    for (let round = 0; round < 4; round += 1) {
      expect(scheduler.observeRound(0)).toBe(false)
    }
    expect(scheduler.observeRound(0)).toBe(true)
    expect(scheduler.observeRound(0)).toBe(false)
    vault.close()
  })

  it("有新消息时计数复位", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    scheduler.observeRound(0)
    scheduler.observeRound(0)
    scheduler.observeRound(3)
    for (let round = 0; round < 4; round += 1) {
      expect(scheduler.observeRound(0)).toBe(false)
    }
    expect(scheduler.observeRound(0)).toBe(true)
    vault.close()
  })
})

/**
 * ★★ 对账补采：探针说有更新、而我们库里没有的那些会话。
 *
 * ## 这一组锁的是一个实测存在的漏采
 *
 * 时间窗那套（水位 + 2 分钟重叠 + 5 分钟前探）只对抗**小**的时钟偏差与延迟。
 * 服务端延迟超过重叠窗时那段已经被水位推过去了 —— 固定窗口**再也不会覆盖它**，
 * 而漏采的表现与一切正常完全相同（状态 idle、无错误）。
 *
 * 实测这台机器 92 个会话里 8 个落后：6 / 235 / 559 分钟，
 * 另有 3 个会话库里一条消息都没有（探针却报未读 1 / 35 / 35）。
 * 跑 `node scripts/check-ingest-gap.mjs` 能看到当前数字。
 *
 * ## ★ 最重要的那条断言是「不能推水位」
 *
 * 对账窗是往**回**补的（start 远早于水位）。拿它推水位会让水位倒退，
 * 而倒退意味着此后每一轮都重拉一大段历史 —— 那不是漏数据，是把采集拖死。
 * 所以下面既断言"窗口确实往回覆盖"，也断言"跑完之后水位没动"。
 */
describe("★★ 对账补采（固定窗口覆盖不到的那段）", () => {
  /** 造一个「探针说有更新、库里落后」的会话。 */
  function seedStale(
    vault: ReturnType<typeof openTestVault>,
    input: { externalId: string; probeAt: number; oursAt: number | null },
  ): void {
    new ConversationRepository(vault.db).upsert({
      id: `conv-${input.externalId}`,
      channelId: "dingtalk",
      externalId: input.externalId,
      type: "direct",
      title: input.externalId,
      createdAt: START - MS_PER_MINUTE,
    })
    new ProbeSnapshotRepository(vault.db).upsert({
      channelId: "dingtalk",
      conversationExternalId: input.externalId,
      lastMsgAt: input.probeAt,
      unreadCount: 1,
      observedAt: input.probeAt,
    })
    if (input.oursAt === null) return
    vault.db
      .prepare(
        `INSERT INTO messages (id, channel_id, conversation_id, external_id,
           content_text, sent_at, direction, is_self, origin, created_at)
         VALUES (?, 'dingtalk', ?, ?, '旧消息', ?, 'inbound', 0, 'human', ?)`,
      )
      .run(
        `m-${input.externalId}`,
        `conv-${input.externalId}`,
        `ext-${input.externalId}`,
        input.oursAt,
        input.oursAt,
      )
  }

  it("没有落后的会话时返回 null（常态，不该白跑一趟）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedStale(vault, { externalId: "cid-ok", probeAt: START, oursAt: START })
    expect(scheduler.reconciliationWindow()).toBeNull()
    vault.close()
  })

  it("★ 探针比我们新很多 → 给出一个覆盖那段的窗口", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    // 探针说 START，我们库里只到 START - 60min（落后一小时）
    const ours = START - 60 * MS_PER_MINUTE
    seedStale(vault, { externalId: "cid-lag", probeAt: START, oursAt: ours })

    const plan = scheduler.reconciliationWindow()
    expect(plan).not.toBeNull()
    expect(plan?.staleCount).toBe(1)
    // 窗口要**往回**盖到我们库里那条之前（带重叠窗）
    expect(plan?.window.start).toBeLessThanOrEqual(ours)
    // 且要盖住探针说的那个时间
    expect(plan?.window.end).toBeGreaterThanOrEqual(START)
    vault.close()
  })

  it("★★ 对账**不推水位**（推了会让水位倒退 → 每轮重拉一大段历史）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    /**
     * 先让水位推到 START（模拟正常采集已经推过去了）。
     *
     * ★ 必须先 `beginWindow`：`commitWindow` 是 UPDATE，没有行时是 no-op
     * （首版漏了这一步，`before` 读出来是 0，断言变得毫无意义）。
     */
    scheduler.beginWindow({ start: START - MS_PER_MINUTE, end: START, cursor: null })
    scheduler.commitProgress(START)
    const before = cursors.watermark("dingtalk:chat:l2")
    expect(before).toBe(START)

    seedStale(vault, {
      externalId: "cid-lag",
      probeAt: START - MS_PER_MINUTE,
      oursAt: START - 60 * MS_PER_MINUTE,
    })
    const plan = scheduler.reconciliationWindow()
    expect(plan).not.toBeNull()
    /**
     * ★ 窗口本身是往回的 —— 这正是它不能拿来推水位的原因。
     * 断言这一点是为了让"它往回"这件事在测试里显式存在：
     * 有人日后把它接到 commitProgress 上时，下面那条会红。
     */
    expect(plan?.window.start).toBeLessThan(before)

    // 对账只拉数据、不动水位（调用方的契约）
    expect(cursors.watermark("dingtalk:chat:l2")).toBe(before)
    vault.close()
  })

  it("★ 库里一条都没有的会话也算落后（探针报未读却零消息）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedStale(vault, { externalId: "cid-empty", probeAt: START - MS_PER_MINUTE, oursAt: null })
    const plan = scheduler.reconciliationWindow()
    expect(plan?.staleCount).toBe(1)
    vault.close()
  })

  it("★ 回溯有上限（一条都没有的会话不该让每轮都拉一整年）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    // 探针说的时间在很久以前（一年前），且我们一条都没有
    seedStale(vault, {
      externalId: "cid-ancient",
      probeAt: START - 365 * 24 * 60 * MS_PER_MINUTE,
      oursAt: null,
    })
    const plan = scheduler.reconciliationWindow({ maxLookbackMs: 7 * 24 * 60 * MS_PER_MINUTE })
    expect(plan).not.toBeNull()
    // start 被上限夹住，而不是跑到一年前
    expect(plan?.window.start).toBeGreaterThanOrEqual(START - 7 * 24 * 60 * MS_PER_MINUTE)
    vault.close()
  })

  it("★ 秒级抖动不算落后（探针与消息的时间戳不同源）", () => {
    /**
     * 实测两条抖动样本：45 秒与 3 秒 —— 那两个会话的消息其实都采到了。
     * 不设容差的话每轮都会为它们白跑一趟对账。
     */
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedStale(vault, {
      externalId: "cid-jitter",
      probeAt: START,
      oursAt: START - 45_000,
    })
    expect(scheduler.reconciliationWindow()).toBeNull()
    vault.close()
  })
})
