/**
 * 历史回填的游标规则。
 *
 * ## 这组测试防的是什么
 *
 * 用户在引导里选「180 天」，而采集写死回溯 7 天且**没有任何代码读那个选择**
 * —— 库里只有 7 天，状态页每个数字都正常（消息在涨、无错误、蒸馏等级 A），
 * 唯一的症状是画像薄，而"薄"没有参照物。这一整类故障的形状是
 * **静默少数据**，所以下面每条都在断言"少了要能看出来 / 不该少"。
 *
 * ## 为什么回填必须是另一条游标
 *
 * 增量那条 watermark 是单向前进的（`MAX(watermark, ?)`），且承载
 * 「`[0, watermark)` 已完整落库」这个不变式。补历史要往它**左边**走，
 * 借用它会同时破坏两件事：`MAX()` 不让它变小，而即使绕过去改小了，
 * 「水位左边已完整」在回填跑完前就是假的。所以这里反复断言两条游标
 * **互不干扰**。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, MS_PER_MINUTE } from "@mycontext/kernel"
import { SyncCursorRepository } from "@mycontext/store"
import { IngestScheduler } from "@mycontext/ingest"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
const DAY = 24 * 60 * MS_PER_MINUTE

function makeScheduler(clock: ManualClock, backfillPageBudget?: number) {
  const vault = openTestVault()
  const scheduler = new IngestScheduler({
    db: vault.db,
    clock,
    channelId: "dingtalk",
    pageLimit: 50,
    ...(backfillPageBudget === undefined ? {} : { backfillPageBudget }),
  })
  return { vault, scheduler, cursors: new SyncCursorRepository(vault.db, clock) }
}

/** 往库里塞一条消息，只为让 `min(sent_at)` 有值（回填的默认起点）。 */
function seedMessage(vault: TestVault, sentAt: number, id = `m-${String(sentAt)}`): void {
  vault.db
    .prepare(
      `INSERT OR IGNORE INTO conversations
         (id, channel_id, external_id, type, title, created_at)
       VALUES ('c1', 'dingtalk', 'cid-1', 'group', '群', 0)`,
    )
    .run()
  vault.db
    .prepare(
      `INSERT INTO messages
         (id, channel_id, conversation_id, external_id, content_text,
          sent_at, direction, origin, created_at)
       VALUES (?, 'dingtalk', 'c1', ?, 'hi', ?, 'inbound', 'human', 0)`,
    )
    .run(id, `ext-${id}`, sentAt)
}

describe("回填窗的计算", () => {
  it("库里没消息时不回填（该让增量的首轮回溯先跑）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    /**
     * ★ 返回 null 而不是「从 now 往回切窗」。
     *
     * 空库时 `since` 那边是一片未知，摸黑切几十个空窗要几十次 CLI 调用
     * 换 0 条数据；而 `nextWindow` 的 `INITIAL_BACKFILL_MS` 本来就会把
     * 最近这段拉回来，拉回来之后回填才有一个真实的左端可以接着走。
     */
    expect(scheduler.nextBackfillWindow(START - 180 * DAY)).toBeNull()
    vault.close()
  })

  it("首次回填从库里最早那条消息往左走，而不是从 now", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const earliest = START - 7 * DAY
    seedMessage(vault, earliest)

    const window = scheduler.nextBackfillWindow(START - 180 * DAY)
    /**
     * ★ 右端**正好**是 earliest，不是 now。
     *
     * 从 now 往回走会把增量已经覆盖的 `[earliest, now)` 重扫一遍 ——
     * 几百次 CLI 调用换 0 条新数据，而且看起来完全正常（在跑、在花配额）。
     */
    expect(window?.end).toBe(earliest)
    // 往**左**走（宽度由密度决定，见下面那组；这里只断言方向）
    expect(window!.start).toBeLessThan(earliest)
    vault.close()
  })

  it("窗宽被 since 夹住，不会越过用户选的下界", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const earliest = START - 7 * DAY
    seedMessage(vault, earliest)
    // since 只比 earliest 早 1 天，而默认窗宽是 7 天。
    const since = earliest - DAY

    const window = scheduler.nextBackfillWindow(since)
    // 越过 since 去多拉 6 天不是"多拉一点无害"：那是用户明确没选的范围。
    expect(window?.start).toBe(since)
    vault.close()
  })

  it("已经回填到 since 就停（不无限往回挖）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const earliest = START - 7 * DAY
    seedMessage(vault, earliest)
    scheduler.commitBackfillFloor(earliest - 10 * DAY)

    // 目标是 5 天前，而下界已经到 17 天前 —— 没活可干。
    expect(scheduler.nextBackfillWindow(START - 5 * DAY)).toBeNull()
    vault.close()
  })

  it("since 为 null（不限）时一直往回走", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const earliest = START - 7 * DAY
    seedMessage(vault, earliest)

    const window = scheduler.nextBackfillWindow(null)
    expect(window).not.toBeNull()
    // 「不限」= 没有左边界夹它，所以窗真的往左伸出去
    expect(window!.start).toBeLessThan(earliest)
    expect(window!.end).toBe(earliest)
    vault.close()
  })
})

describe("★ 回填下界与增量水位互不干扰", () => {
  it("推回填下界不动增量水位", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler, cursors } = makeScheduler(clock)
    scheduler.beginWindow({ start: START - 60_000, end: START, cursor: null })
    scheduler.commitProgress(START - 10_000)

    scheduler.commitBackfillFloor(START - 30 * DAY)

    // 增量水位原地不动 —— 否则「已完整落库到 X」这个不变式会被补历史破坏。
    expect(scheduler.watermark).toBe(START - 10_000)
    expect(cursors.get(scheduler.scope)?.watermark).toBe(START - 10_000)
    // 两行游标是分开的
    expect(scheduler.backfillScope).not.toBe(scheduler.scope)
    expect(scheduler.backfillFloor).toBe(START - 30 * DAY)
    vault.close()
  })

  it("推增量水位不动回填下界", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    scheduler.commitBackfillFloor(START - 30 * DAY)
    scheduler.beginWindow({ start: START - 60_000, end: START, cursor: null })
    scheduler.commitProgress(START)

    expect(scheduler.backfillFloor).toBe(START - 30 * DAY)
    vault.close()
  })

  it("★ 下界只能往更早走（反方向的 MIN，不是 MAX）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    scheduler.commitBackfillFloor(START - 30 * DAY)
    // 再提交一个更晚的值：那意味着"回填倒退了"，必须被拒。
    scheduler.commitBackfillFloor(START - 10 * DAY)

    /**
     * 允许倒退的后果不是报错，是**永久跳过**：下界退回 10 天前之后，
     * `[30天前, 10天前)` 那段既不会被增量覆盖（它在水位左边），
     * 也不会被回填覆盖（下界已经过去了）。
     */
    expect(scheduler.backfillFloor).toBe(START - 30 * DAY)
    vault.close()
  })

  it("★ 首次提交不会被初始的 0 吃掉（MIN(0, x) 恒为 0 的陷阱）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    // beginWindow 会给新 scope 插一行 watermark = 0。
    scheduler.beginBackfillWindow({ start: START - 30 * DAY, end: START, cursor: null })
    scheduler.commitBackfillFloor(START - 30 * DAY)

    /**
     * 裸 `MIN(watermark, ?)` 在这里会算出 0 并永久卡住 —— 而 0 读起来像
     * 「已经回填到 1970 年」，于是回填在第一轮之后再也不跑，
     * 且看起来是**完成**的状态。所以 0 必须显式表示"还没记过"。
     */
    expect(scheduler.backfillFloor).toBe(START - 30 * DAY)
    vault.close()
  })

  it("回填失败不污染增量那行的失败计数（否则退避会误伤收新消息）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    scheduler.beginBackfillWindow({ start: START - 30 * DAY, end: START, cursor: null })
    scheduler.failBackfillWindow("network error")

    // 增量的退避判据读的是 `failedAttempts`；补历史失败不该让它减速。
    expect(scheduler.failedAttempts).toBe(0)
    vault.close()
  })
})

describe("覆盖范围要可见", () => {
  it("报出「选了多久、覆盖到哪、还差多少」", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const earliest = START - 7 * DAY
    seedMessage(vault, earliest)
    const since = START - 180 * DAY

    const coverage = scheduler.backfillCoverage(since)
    expect(coverage.since).toBe(since)
    expect(coverage.coveredFrom).toBe(earliest)
    // ★ 这个数就是过去完全看不见的那 173 天。
    expect(coverage.remainingMs).toBe(earliest - since)
    vault.close()
  })

  it("回填推进后 remaining 变小（进度要能看出在动）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedMessage(vault, START - 7 * DAY)
    const since = START - 180 * DAY
    const before = scheduler.backfillCoverage(since).remainingMs

    scheduler.commitBackfillFloor(START - 60 * DAY)
    const after = scheduler.backfillCoverage(since)

    expect(after.coveredFrom).toBe(START - 60 * DAY)
    expect(after.remainingMs).toBeLessThan(before)
    expect(after.remainingMs).toBe(120 * DAY)
    vault.close()
  })

  it("到位后 remaining 归零", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedMessage(vault, START - 7 * DAY)
    const since = START - 180 * DAY
    scheduler.commitBackfillFloor(since)

    expect(scheduler.backfillCoverage(since).remainingMs).toBe(0)
    vault.close()
  })

  it("选了「不限」时不报一个假的 remaining", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedMessage(vault, START - 7 * DAY)

    /**
     * 「不限」没有目标，算不出"还差多少"。报 0 是刻意的：
     * 编一个数（比如按最早消息到 1970 年）会让进度条显示 4% 并永远走不完。
     */
    expect(scheduler.backfillCoverage(null).remainingMs).toBe(0)
    vault.close()
  })

  /**
   * ★★ 「一条消息都还没有」**不能**与「已覆盖到目标」返回同一个东西。
   *
   * ## 这条锁的是一个静默说谎的故障
   *
   * `backfillCoverage` 曾经对"库里没消息"也返回 `remainingMs: 0` —— 而 UI 判
   * `remainingMs <= 0` 就显示「选的 N 天已全部采集完成」。于是一个**采集完全
   * 失败**的库在引导页上报告"完成"。
   *
   * 实测踩到过（本机 2026-08-05 07:24 那个账号）：采集第一轮就撞
   * `SESSION_EXPIRED` 进 blocked 终态、游标 `status=failed`、`watermark=0`、
   * `messages` 表一行都没有，而界面写着"选的 90 天已全部采集完成"，
   * 蒸馏跟着 0 语料 / 覆盖度 D。用户无从判断是"没数据"还是"采集坏了"。
   *
   * 所以 `started` 必须是独立可观测的一位。
   */
  it("★★ 库里一条消息都没有时 started=false（不能被当成「采完了」）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    // 刻意不 seed 任何消息 —— 这就是采集失败后的库
    const since = START - 90 * DAY

    const coverage = scheduler.backfillCoverage(since)

    expect(coverage.started).toBe(false)
    expect(coverage.coveredFrom).toBeNull()
    vault.close()
  })

  it("有消息之后 started=true", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedMessage(vault, START - 7 * DAY)

    expect(scheduler.backfillCoverage(START - 90 * DAY).started).toBe(true)
    vault.close()
  })

  /**
   * ★ 回填推进过（有下界）也算已开始 —— 即使 messages 表此刻被清过。
   *
   * `coveredFrom` 的规则是"下界优先，没有才落回最早消息"（与
   * `nextBackfillWindow` 同源）。started 必须跟着同一个规则，
   * 否则"回填在跑但界面说还没开始"。
   */
  it("回填推进过时 started=true（哪怕 messages 表是空的）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    scheduler.commitBackfillFloor(START - 30 * DAY)

    const coverage = scheduler.backfillCoverage(START - 90 * DAY)

    expect(coverage.started).toBe(true)
    expect(coverage.coveredFrom).toBe(START - 30 * DAY)
    vault.close()
  })

  /** 「不限」+ 有消息：算不出 remaining，但确实已经开始了。 */
  it("选「不限」且有消息时 started 仍为 true", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedMessage(vault, START - 7 * DAY)

    expect(scheduler.backfillCoverage(null).started).toBe(true)
    vault.close()
  })
})

/**
 * ★ 窗宽必须按密度自适应，否则密集账号会活锁。
 *
 * 这一组是**实测踩到的故障**的回归测试，不是假想：
 * 固定 7 天窗 + 这个账号的真实密度（7 天约 5900 条）撞上回填单轮预算
 * （120 页 × 50 条 = 6000 条）—— 第一个窗用 119 页刚好压线，第二个窗
 * 就抽不干。而回填「没抽干就不推下界」（那是对的，切窗后算不出可靠的
 * 连续左端），于是下界永久停住，每轮烧满预算重拉同一个窗。
 *
 * 当时日志里只有一行 `round not drained`，与"正在跑"完全同形。
 */
describe("★ 回填窗宽按**服务端实测页数**反馈（防漏采整段历史）", () => {
  /**
   * ## 这组测试防的是一个真实漏采了 4 个月的 bug
   *
   * 旧实现按「已覆盖区间在**库里**的密度」估窗宽，乘一个实测系数
   * （1.4，来自"库里 4606 / 服务端 5871"）反推服务端量。而那个系数是在
   * **已采全**的区间量的；回填要去的是**没采过**的区间，那里库里近乎空。
   *
   * 实测这台机器：7 月（已采全）比值 1.27，而 4/1–4/4（未采）**>41**。
   * 窗宽被高估 30 倍 → 每轮撞 120 页预算 → 抽不干 → 下界不推 →
   * 中间整段被跳过。库里 3-6 月只剩 465 条（全来自 2 个群，单聊 0 条），
   * 而服务端那段实际约 3.7 万条。
   *
   * 所以现在不预测、只反馈：**看上一轮真实翻了多少页**。
   */
  /** 造一条"上一轮"的游标记录：窗宽 + 实际翻页数。 */
  function seedLastRound(
    vault: TestVault,
    clock: ManualClock,
    scope: string,
    widthMs: number,
    pages: number,
  ): void {
    const end = START - 10 * DAY
    const cursors = new SyncCursorRepository(vault.db, clock)
    cursors.beginWindow(scope, end - widthMs, end)
    for (let i = 0; i < pages; i += 1) cursors.advancePage(scope, `c${String(i)}`)
  }

  /** 让 `min(sent_at)` 有值 —— 回填的起点。 */
  function seedOne(vault: TestVault, at: number): void {
    vault.db
      .prepare(
        `INSERT OR IGNORE INTO conversations
           (id, channel_id, external_id, type, title, created_at)
         VALUES ('c1', 'dingtalk', 'cid-1', 'group', '群', 0)`,
      )
      .run()
    vault.db
      .prepare(
        `INSERT INTO messages
           (id, channel_id, conversation_id, external_id, content_text,
            sent_at, direction, origin, created_at)
         VALUES ('m1', 'dingtalk', 'c1', 'e1', 'hi', ?, 'inbound', 'human', 0)`,
      )
      .run(at)
  }

  const BUDGET = 120

  it("★ 首轮（没有上一轮记录）从保守的 1 天起步，不是 7 天", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 30 * DAY)

    const window = scheduler.nextBackfillWindow(null)
    /**
     * ★ 往**窄**的那侧偏是刻意的：估宽了的代价是整段被跳过（这个 bug），
     * 估窄了只是多跑几轮。两者不对称。
     */
    expect((window!.end - window!.start) / DAY).toBe(1)
    vault.close()
  })

  it("★ 上一轮撞了预算（没抽干）→ 窗宽收窄到 1/3", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 30 * DAY)
    // 上一轮：9 天的窗、翻满 120 页 → 撞预算
    seedLastRound(vault, clock, scheduler.backfillScope, 9 * DAY, BUDGET)

    const window = scheduler.nextBackfillWindow(null)
    expect((window!.end - window!.start) / DAY).toBeCloseTo(3, 1)
    vault.close()
  })

  it("★ 收窄用 ÷3 而不是 ÷2（高估 30 倍时二分要 5 轮，÷3 只要 3 轮）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 300 * DAY)
    seedLastRound(vault, clock, scheduler.backfillScope, 27 * DAY, BUDGET)

    const w1 = scheduler.nextBackfillWindow(null)
    const days = (w1!.end - w1!.start) / DAY
    // ÷2 会得到 13.5 天；÷3 得到 9 天 —— 断言的是后者
    expect(days).toBeCloseTo(9, 1)
    expect(days).toBeLessThan(13)
    vault.close()
  })

  it("★ 抽干且只用掉不到 1/3 预算 → 放宽（×2），不会永久钉在窄窗", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 90 * DAY)
    // 上一轮：2 天的窗只翻了 5 页 → 远没用完预算
    seedLastRound(vault, clock, scheduler.backfillScope, 2 * DAY, 5)

    const window = scheduler.nextBackfillWindow(null)
    expect((window!.end - window!.start) / DAY).toBeCloseTo(4, 1)
    vault.close()
  })

  it("落在舒适区（用掉 1/3 ~ 全部预算）时保持不变", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 90 * DAY)
    // 60 页 / 120 预算 = 一半，既不收窄也不放宽
    seedLastRound(vault, clock, scheduler.backfillScope, 3 * DAY, 60)

    const window = scheduler.nextBackfillWindow(null)
    expect((window!.end - window!.start) / DAY).toBeCloseTo(3, 1)
    vault.close()
  })

  it("★ 正好用满预算算「没抽干」（>= 而不是 >）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 90 * DAY)
    /**
     * 循环条件是 `pages < budget`，所以 pages == budget 时是**被预算截断**的。
     * 判成抽干会让下界推过一段没采完的区间 —— 那正是静默漏采。
     */
    seedLastRound(vault, clock, scheduler.backfillScope, 9 * DAY, BUDGET)

    const window = scheduler.nextBackfillWindow(null)
    // 收窄了（而不是保持 9 天）
    expect((window!.end - window!.start) / DAY).toBeLessThan(9)
    vault.close()
  })

  it("★ 反馈量存在 DB，跨重启仍然有效（不是内存态）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 90 * DAY)
    seedLastRound(vault, clock, scheduler.backfillScope, 12 * DAY, BUDGET)

    // 换一个**新的** scheduler 实例（模拟进程重启），读同一个库
    const restarted = new IngestScheduler({
      db: vault.db,
      clock,
      channelId: "dingtalk",
      pageLimit: 50,
      backfillPageBudget: BUDGET,
    })
    const window = restarted.nextBackfillWindow(null)
    // 重启后仍然收窄到 4 天，而不是回到首轮的 1 天或某个宽窗
    expect((window!.end - window!.start) / DAY).toBeCloseTo(4, 1)
    vault.close()
  })

  it("窗宽有上限：反复放宽也不会切出巨窗（30 天）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 300 * DAY)
    // 25 天只翻 2 页 → ×2 = 50 天，应被夹到 30
    seedLastRound(vault, clock, scheduler.backfillScope, 25 * DAY, 2)

    const window = scheduler.nextBackfillWindow(null)
    expect((window!.end - window!.start) / DAY).toBeLessThanOrEqual(30)
    vault.close()
  })

  it("窗宽有下限：反复收窄也不会切到分钟级（1 小时）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 7 * DAY)
    // 2 小时的窗仍撞预算 → ÷3 = 40 分钟，应被夹到 1 小时
    seedLastRound(vault, clock, scheduler.backfillScope, 2 * 60 * MS_PER_MINUTE, BUDGET)

    const window = scheduler.nextBackfillWindow(null)
    expect(window!.end - window!.start).toBeGreaterThanOrEqual(60 * MS_PER_MINUTE)
    vault.close()
  })

  it("显式传 windowMs 时不做自适应（调用方说了算）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    seedOne(vault, START - 7 * DAY)
    seedLastRound(vault, clock, scheduler.backfillScope, 9 * DAY, BUDGET)

    const window = scheduler.nextBackfillWindow(null, 2 * DAY)
    expect(window!.end - window!.start).toBe(2 * DAY)
    vault.close()
  })

  /**
   * ★★ 回归：真机那个漏采场景。
   *
   * 库里 3-6 月近乎空（每天几条），而服务端每天约 300 条。
   * 旧实现会按"库里几条"估出很宽的窗（实测 4.3 天，而真实需要 763 页）。
   * 新实现**不看库里的密度**，所以不会被这个假象带偏。
   */
  it("★★ 回归：待采区间库里近乎空时，窗宽不被高估", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock, BUDGET)
    const earliest = START - 30 * DAY
    // 模拟真机：库里那段每天只有 2 条（实际服务端每天 ~300 条）
    vault.db
      .prepare(
        `INSERT OR IGNORE INTO conversations
           (id, channel_id, external_id, type, title, created_at)
         VALUES ('c1', 'dingtalk', 'cid-1', 'group', '群', 0)`,
      )
      .run()
    const insert = vault.db.prepare(
      `INSERT INTO messages
         (id, channel_id, conversation_id, external_id, content_text,
          sent_at, direction, origin, created_at)
       VALUES (?, 'dingtalk', 'c1', ?, 'hi', ?, 'inbound', 'human', 0)`,
    )
    for (let i = 0; i < 6; i += 1) {
      insert.run(`s${String(i)}`, `e-s${String(i)}`, earliest + i * 12 * 60 * MS_PER_MINUTE)
    }

    const window = scheduler.nextBackfillWindow(null)
    const days = (window!.end - window!.start) / DAY
    /**
     * ★ 旧实现在这个输入下会算出 >4 天（库里 6 条 / 3 天 → 极稀疏 → 放大到
     * 上限附近）。新实现首轮固定 1 天，与库里的密度**无关** ——
     * 这条断言的关键就是"与库里条数无关"。
     */
    expect(days).toBe(1)
    vault.close()
  })
})

describe("★★ 内部空洞检测（回填补不了的那种缺口）", () => {
  /**
   * ## 这组测试防的是一个漏了约 3.6 万条、且不报错的缺口
   *
   * 回填只能延伸**左端**（`[floor, 最早消息)`）。而实测这台机器：
   * 首次采集只回溯 7 天（7/23 起）→ 之后回填往左跳到 2 月 →
   * **3-6 月落在"已覆盖区间"内部却是空的**。
   *
   * 此后回填一路往 2 月更左边走，永远不回头；而增量水位也声称
   * `[0, now)` 已完整 —— 两个游标各自都"正确"，中间那段没有任何
   * 机制会去覆盖它。直接问二进制那段每天约 300 条。
   */
  function seedAt(vault: TestVault, times: readonly number[]): void {
    vault.db
      .prepare(
        `INSERT OR IGNORE INTO conversations
           (id, channel_id, external_id, type, title, created_at)
         VALUES ('c1', 'dingtalk', 'cid-1', 'group', '群', 0)`,
      )
      .run()
    const insert = vault.db.prepare(
      `INSERT INTO messages
         (id, channel_id, conversation_id, external_id, content_text,
          sent_at, direction, origin, created_at)
       VALUES (?, 'dingtalk', 'c1', ?, 'hi', ?, 'inbound', 'human', 0)`,
    )
    times.forEach((at, i) => {
      insert.run(`g-${String(i)}`, `e-g-${String(i)}`, at)
    })
  }

  it("没有空洞时返回 null（常态，不该白拉一趟）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    // 连续 5 天，每天一条 —— 间隔 1 天，远小于 7 天阈值
    seedAt(
      vault,
      [0, 1, 2, 3, 4].map((d) => START - d * DAY),
    )
    expect(scheduler.interiorGap()).toBeNull()
    vault.close()
  })

  it("★★ 真机形状：7 天窗 + 2 月那批，中间 4 个月的空洞被找出来", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    /**
     * 复现实测：最近 7 天密集 + 约 5 个月前有一批，中间整段空白。
     * 这正是「首次 7 天回溯 + 回填跳到 2 月」造出的形状。
     */
    const recent = [0, 1, 2, 3, 4, 5, 6].map((d) => START - d * DAY)
    const old = [150, 151, 152].map((d) => START - d * DAY)
    seedAt(vault, [...recent, ...old])

    const gap = scheduler.interiorGap()
    expect(gap).not.toBeNull()
    // 空洞应该是「150 天前那批的最后一条」到「7 天前那批的第一条」
    const days = (gap!.end - gap!.start) / DAY
    expect(days).toBeGreaterThan(140)
    expect(days).toBeLessThan(145)
    vault.close()
  })

  it("空洞的两端落在真实消息之间（不会越过已有数据去重拉）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    const left = START - 100 * DAY
    const right = START - 10 * DAY
    // 只播这两条（不含 START），让 [left, right) 是唯一也是最大的间隔
    seedAt(vault, [left, right])

    const gap = scheduler.interiorGap()
    expect(gap!.start).toBe(left + 1)
    expect(gap!.end).toBe(right)
    vault.close()
  })

  it("★ 阈值可调；短于阈值的正常静默期不算空洞（周末/休假）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    // 间隔 5 天 —— 默认 7 天阈值下不算空洞
    seedAt(vault, [START, START - 5 * DAY, START - 10 * DAY])
    expect(scheduler.interiorGap()).toBeNull()
    // 但把阈值降到 3 天就该找到
    expect(scheduler.interiorGap({ minGapDays: 3 })).not.toBeNull()
    vault.close()
  })

  it("★ 多个空洞时取**最大**那个，不是最靠右的", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    /**
     * 三个间隔：[200,150)=50 天、[150,100)=50 天、[100,10)=**90 天**，
     * 外加一个 [10, now)=10 天。
     *
     * ★ 首版按"最靠右"取，会选中那个 10 天的边缘间隔，于是每轮都在补一段
     * 本来就没数据的区间，而真正那个 90 天的空洞永远排不上。
     */
    seedAt(vault, [
      START,
      START - 10 * DAY,
      START - 100 * DAY,
      START - 150 * DAY,
      START - 200 * DAY,
    ])

    const gap = scheduler.interiorGap()
    expect((gap!.end - gap!.start) / DAY).toBeCloseTo(90, 0)
    vault.close()
  })

  it("库里只有一条时没有空洞可言（LAG 拿不到前一条）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedAt(vault, [START])
    expect(scheduler.interiorGap()).toBeNull()
    vault.close()
  })

  it("空库时返回 null，不抛", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    expect(scheduler.interiorGap()).toBeNull()
    vault.close()
  })

  it("只看本渠道（另一个渠道的消息不该填出/掩盖空洞）", () => {
    const clock = new ManualClock(START)
    const { vault, scheduler } = makeScheduler(clock)
    seedAt(vault, [START, START - 100 * DAY])
    // 塞一条飞书的消息落在空洞正中间
    vault.db
      .prepare(
        `INSERT OR IGNORE INTO conversations
           (id, channel_id, external_id, type, title, created_at)
         VALUES ('c2', 'feishu', 'fs-1', 'group', '飞书群', 0)`,
      )
      .run()
    vault.db
      .prepare(
        `INSERT INTO messages
           (id, channel_id, conversation_id, external_id, content_text,
            sent_at, direction, origin, created_at)
         VALUES ('fs-m', 'feishu', 'c2', 'fs-e', 'hi', ?, 'inbound', 'human', 0)`,
      )
      .run(START - 50 * DAY)

    const gap = scheduler.interiorGap()
    // 钉钉那个空洞仍然是完整的 90 天，没被飞书那条切开
    expect((gap!.end - gap!.start) / DAY).toBeCloseTo(100, 0)
    vault.close()
  })
})
