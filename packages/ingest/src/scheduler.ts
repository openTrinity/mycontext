/**
 * 采集调度：两级轮询 + 时间窗管理。
 *
 * ## 两级设计
 *
 * L1 廉价探针（实测约 0.7s）决定是否值得付 L2 的正文成本（实测约 0.6s）。
 * L1 有个**已知盲区**：用户在客户端读过的会话会从未读列表消失，此时探针探不到。
 * 因此 L2 保留固定周期的兜底轮询（即使 L1 无命中也跑）。
 * 两层结果按幂等键去重，重复拉取不产生重复行。
 * **不追求零延迟，追求零丢失。**
 *
 * ## 三条会静默丢消息的规则（都必须实现，不是可选优化）
 *
 * 1. **游标只在整窗全部分页确认落库后才推进 watermark**。
 *    半途崩溃 → watermark 不动 → 下次整窗重跑（靠幂等兜住）。
 *    「取一页推一次水位」会在崩溃时永久丢掉窗口尾部，而且看起来像采到了。
 *
 * 2. **截断检测**：`--limit` 的语义未明确（限会话数还是消息数），
 *    因此**没有下一页却刚好满页**时就认为可能被截断 ——
 *    把该窗二分成两个子窗**分别抽干**。静默截断是最坏情况：缺的那段永远不会被重拉
 *    （水位已经推过去了）。
 *    注意判定必须带「没有下一页」这个前置条件：分页场景下正常满页必然达到阈值，
 *    对每页都判定会让回溯几乎停滞（实测 7 天回溯需 ~2500 次调用）。
 *    切窗后**两个子窗都要入队**，只丢右半等于永久跳过那一半历史。
 *
 * 3. **时钟偏移方向**：`--end` 用本地时钟而消息时间来自服务端。
 *    本地时钟慢时 end 会小于服务端最新时间 → 重叠窗口失效。
 *    因此 end 向前留量，且用**服务端返回的最大时间**而不是本地 now 推水位。
 *    但水位**永不超过 now**：lookahead 是给「拉取范围」的留量（宁可多拉），
 *    不是给「已确认落库」的 —— 空窗时把水位推到未来会造出永久黑洞，见
 *    `commitWindow`。
 */
import { MS_PER_MINUTE, type Clock, type Logger } from "@mycontext/kernel"
import { looksTruncated } from "@mycontext/channels"
import type { SqliteDatabase } from "@mycontext/store"
import { ProbeSnapshotRepository, SyncCursorRepository } from "@mycontext/store"

/** 窗口重叠：对抗时钟偏差与服务端延迟。幂等键保证重叠不产生重复行。 */
export const WINDOW_OVERLAP_MS = 2 * MS_PER_MINUTE
/** end 向前留量：本地时钟慢时避免漏掉刚到的消息。 */
export const WINDOW_LOOKAHEAD_MS = 5 * MS_PER_MINUTE
/** 首次采集的回溯窗口：没有水位时从这里开始。 */
export const INITIAL_BACKFILL_MS = 7 * 24 * 60 * MS_PER_MINUTE
/** 单窗最小宽度：二分切窗切到这个宽度还截断就只能接受并告警。 */
export const MIN_WINDOW_MS = MS_PER_MINUTE
/**
 * ★ 这里曾有两个常量（`PAGES_PER_ROW_SLACK = 1.4` 与 `EFFECTIVE_PAGE_ROWS = 32`），
 * 用来「按库里的条数反推服务端会吐多少页」。**它们已被删掉**，因为那个
 * 反推方式在**未采过的区间**上是错的 —— 而回填要去的正是那种区间。
 *
 * 实测：7 月（已采全）服务端/库里 = 1.27，而 4/1–4/4（未采）> 41。
 * 用 1.4 去估未采区间会把窗宽高估 30 倍，后果是整段历史被跳过
 * （详见 `adaptiveBackfillWidth` 的文件注释）。
 *
 * 现在改成**用上一轮真实翻了多少页**做反馈调节，不再预测。
 */

export interface ChangeHint {
  conversationExternalId: string
  lastMsgAt: number | null
  unreadCount: number | null
}

export interface ProbeResult {
  conversations: {
    externalId: string
    lastMsgAt: number | null
    unreadCount: number | null
  }[]
  completeUnreadSnapshot?: boolean
}

export interface PullWindow {
  start: number
  end: number
  cursor: string | null
}

/**
 * 截断检测的输入。
 *
 * 刻意**不含** `maxSentAt`：截断判定只看「条数是否触到 limit 且没有下一页」，
 * 业务时间不参与。首版把它放在入参里，调用方一直在传而这里从未读 ——
 * 读者会误以为它参与判定（"是不是时间超了才切窗？"）。
 * 水位推进用的 maxSentAt 由调用方自己累计后传给 `commitProgress`。
 */
export interface PullPageResult {
  /** 本页解析出的消息条数（截断检测用） */
  itemCount: number
  nextCursor: string | null
}

export interface SchedulerOptions {
  db: SqliteDatabase
  clock: Clock
  channelId: string
  logger?: Logger
  /** 单页条数上限，透传给渠道命令 */
  pageLimit?: number
  /**
   * 回填单轮的**翻页**预算。
   *
   * ★ 单位是页不是条：活锁的判据是「翻页数是否超预算」，而首版按条数
   * 反推窗宽，两处口径偏差（库里条数 vs 服务端条数、满页 vs 实际每页）
   * 相乘后把 167 页的需求估成 72 页 —— 真机上直接活锁。
   *
   * 给 scheduler 是因为它要按这个数反推窗宽，而"一轮最多翻几页"是服务层
   * 的节流决定。两边各持一半会让活锁在"预算调小了但窗宽没跟着变"时静默复现。
   */
  backfillPageBudget?: number
}

/**
 * 自适应周期。
 *
 * 「探针耗时 > 周期一半时降频」而不是设绝对阈值：
 * 绝对阈值要随机器性能与账号规模反复调，而「一次探测不该占掉半个周期」
 * 这个判据是自解释的、跨环境成立的。
 *
 * 几百个群之后 L1 的未读列表会变长，15s 周期可能追不上并堆积 ——
 * 表现是"数字人越来越慢"而没有任何错误。
 */
export class AdaptiveInterval {
  private current: number

  constructor(
    private readonly base: number,
    private readonly max: number,
  ) {
    this.current = base
  }

  get intervalMs(): number {
    return this.current
  }

  get throttled(): boolean {
    return this.current > this.base
  }

  /** 记录一次执行耗时并调整周期。 */
  observe(durationMs: number): void {
    if (durationMs > this.current / 2) {
      this.current = Math.min(this.max, Math.round(this.current * 1.5))
      return
    }
    // 恢复时逐步回落而不是一次跳回：避免在临界点上来回抖动。
    if (durationMs < this.current / 4 && this.current > this.base) {
      this.current = Math.max(this.base, Math.round(this.current / 1.5))
    }
  }
}

export class IngestScheduler {
  private readonly cursors: SyncCursorRepository
  private readonly probes: ProbeSnapshotRepository
  /** 连续无新消息的轮数：达到阈值后触发空闲期维护（WAL checkpoint）。 */
  private idleRounds = 0

  constructor(private readonly options: SchedulerOptions) {
    this.cursors = new SyncCursorRepository(options.db, options.clock)
    this.probes = new ProbeSnapshotRepository(options.db)
  }

  get scope(): string {
    return `${this.options.channelId}:chat:l2`
  }

  /**
   * 历史回填的游标 scope。
   *
   * ## ★ 为什么不能复用 `scope` 的 watermark
   *
   * 那个 watermark 是**单向前进**的（`commitWindow` 用 `MAX(watermark, ?)`），
   * 且承载「`[0, watermark)` 已完整落库」这个不变式 —— 增量采集的正确性
   * 全靠它。补历史是**反方向**的工作：它要往 watermark 的**左边**走。
   *
   * 想靠"把 watermark 改小"来补历史会同时破坏两件事：① `MAX()` 根本不让它
   * 变小；② 即使绕过去改小了，那段本已采过的区间会被重扫一遍，而更糟的是
   * 「水位左边已完整」这个不变式在回填跑完之前是**假的** —— 期间任何读水位
   * 判断"这段有没有采过"的地方都会得到错的答案。
   *
   * 所以回填用自己的一行游标，`watermark` 在这里的语义是**下界**：
   * 「`[floor, 最早消息)` 之前的还没采」。两个游标方向相反、互不干扰。
   */
  get backfillScope(): string {
    return `${this.options.channelId}:chat:backfill`
  }

  /**
   * L1：把探针结果与上次快照比对，给出「哪些会话可能有新消息」。
   *
   * 返回空数组**不代表没有新消息**（见上文盲区），所以 L2 仍要按固定周期跑。
   */
  diffProbe(result: ProbeResult, observedAt: number): ChangeHint[] {
    const hints: ChangeHint[] = []
    for (const conversation of result.conversations) {
      const previous = this.probes.get(this.options.channelId, conversation.externalId)
      const changed =
        previous === null ||
        (conversation.lastMsgAt ?? 0) > (previous.lastMsgAt ?? 0) ||
        (conversation.unreadCount ?? 0) > (previous.unreadCount ?? 0)

      this.probes.upsert({
        channelId: this.options.channelId,
        conversationExternalId: conversation.externalId,
        lastMsgAt: conversation.lastMsgAt,
        unreadCount: conversation.unreadCount,
        observedAt,
      })

      if (changed) {
        hints.push({
          conversationExternalId: conversation.externalId,
          lastMsgAt: conversation.lastMsgAt,
          unreadCount: conversation.unreadCount,
        })
      }
    }
    if (result.completeUnreadSnapshot === true) {
      this.probes.markAbsentAsRead(
        this.options.channelId,
        result.conversations.map((conversation) => conversation.externalId),
        observedAt,
      )
    }
    return hints
  }

  /**
   * 库里最早那条消息的时间；null = 一条都没有。
   *
   * 抽出来是因为 `nextBackfillWindow` 与 `backfillCoverage` 必须用**同一个**
   * 定义 —— 一个说"已覆盖到 X"而另一个从 Y 开始切窗的话，状态页显示的
   * 进度和实际跑的窗就会对不上，而那种偏差只在跑到边界时才暴露。
   */
  private earliestMessageAt(): number | null {
    return (
      this.options.db
        .prepare<
          [string],
          { min_at: number | null }
        >("SELECT min(sent_at) AS min_at FROM messages WHERE channel_id = ?")
        .get(this.options.channelId)?.min_at ?? null
    )
  }

  /**
   * 计算下一个待处理时间窗。
   *
   * start 刻意往回退 `WINDOW_OVERLAP_MS`：对抗时钟偏差与服务端延迟。
   * end 往前留 `WINDOW_LOOKAHEAD_MS`：本地时钟慢时不漏刚到的消息。
   */
  nextWindow(): PullWindow {
    const now = this.options.clock.now()
    const watermark = this.cursors.watermark(this.scope)
    const start = watermark === 0 ? now - INITIAL_BACKFILL_MS : watermark - WINDOW_OVERLAP_MS
    return { start, end: now + WINDOW_LOOKAHEAD_MS, cursor: null }
  }

  /**
   * 增量水位「说采过了、库里却一条都没有」的矛盾态。
   *
   * ## ★★★ 这是那个死锁的根因（实测）
   *
   * watermark>0 的语义是「`[0, watermark)` 已完整落库」。实测撞到过与它直接
   * 矛盾的状态：watermark 在今天凌晨、`messages` 表 **0 条**。成因是已修的
   * 时序 bug 的**遗留**——采集比范围行先跑、拉到的消息被 `scopeNotReady`
   * 全丢，水位却照常前移（`commitWindow` 是 `MAX()` 单向前进，退不回来）。
   *
   * 后果是死锁：增量按 `watermark - 2min` 只看最近几分钟（没有新消息 →
   * 恒 0 条），回填又被「库里没消息」挡在门外。点「立即同步」永远 0/0。
   *
   * ## ★ 为什么判据只能用在 `start()` 里做**一次性**修复，不能放进 `nextWindow`
   *
   * 「watermark>0 且库空」这个信号在**单次调用里**无法区分两种情况：
   * · 本 bug（水位被错误推过头，其实有消息没采）——该重扫；
   * · 空频道正常向前爬（真的没消息，水位跟着 now 走）——不该每轮重扫，
   *   否则就是另一个活锁（见 `ingest-window-queue` 那条「反复撞预算时水位
   *   单调前进」的门禁）。
   *
   * 两者只有**跨时间**才分得开。所以修复放在 `start()`：挂载时判一次、
   * 把错误的水位清零（`resetIncrementalWatermark`），之后 `nextWindow` 自然
   * 走首轮 `INITIAL_BACKFILL_MS` 全回溯 —— 一旦扫到消息，库不再空、水位重新
   * 可信、回填也随之解冻。挂载不在每轮之间发生，所以不会与活锁门禁冲突。
   */
  isWatermarkStale(): boolean {
    return this.cursors.watermark(this.scope) > 0 && this.earliestMessageAt() === null
  }

  /**
   * 把增量水位清零 —— `start()` 检测到上面那个矛盾态时调用。
   *
   * 删整行而不是 UPDATE：`nextWindow` 对「没有这一行」（watermark 0）的处理
   * 就是首轮全回溯，与我们要的行为完全同一条路，少一个特殊分支。
   * 丢掉「`[0, watermark)` 已完整」这个断言是安全的 —— 库里一条都没有，
   * 那个断言本来就是假的。
   */
  resetIncrementalWatermark(): void {
    this.cursors.deleteScope(this.scope)
  }

  beginWindow(window: PullWindow): void {
    this.cursors.beginWindow(this.scope, window.start, window.end)
  }

  /**
   * 计算下一个**历史回填**窗（往更早的时间走）。
   *
   * 与 `nextWindow` 的分工：那个把水位往 now 推（增量），这个把下界往
   * `since` 推（补历史）。两者用不同的游标行，可以在同一轮里各跑一段。
   *
   * ## 下界从哪来
   *
   * 首次（回填游标为 0）用**库里最早那条消息**的时间，而不是 now：
   * 增量采集已经覆盖了 `[最早消息, now)`，从 now 往回走会把那段重扫一遍
   * ——几百次 CLI 调用换 0 条新数据。
   *
   * 库里一条消息都没有时返回 null：那时该跑的是增量采集的首轮回溯
   * （`nextWindow` 的 `INITIAL_BACKFILL_MS`），而不是往 `since` 那边
   * 摸黑切几十个空窗。
   *
   * ## ★ 为什么一次只给一个窗
   *
   * 一次给一个、跑完记一次下界，回填就成了**可续跑**的：进程退出、
   * 用户登出、撞预算都只丢当前这一个窗的进度，而不是整段历史。
   *
   * ## ★ 窗宽必须按密度自适应，否则会活锁
   *
   * 固定 7 天在实测里**撞上了活锁**：这个账号 7 天有约 5900 条消息，
   * 而回填单轮预算是 120 页 × 50 条 = 6000 条 —— 第一个窗用掉 119 页
   * （刚好压线），下一个窗就抽不干了。而回填「没抽干就不推下界」
   * （见 `runBackfillStep`，那是对的：切窗后算不出可靠的连续左端），
   * 于是下界永久停住，每轮烧满 120 次 CLI 调用重拉同一个窗。
   * 日志里只有一句 `round not drained`，看起来像"在跑"。
   *
   * 所以窗宽由**已覆盖区间的实测密度**推出来：目标是一窗的消息数落在
   * 单轮预算的 60% 左右，留出余量给密度波动。抬预算不是解法 ——
   * 那会把「一轮几分钟收不到新消息」带回来（见 `MAX_PAGES_PER_BACKFILL_ROUND`）。
   *
   * @param since 回填的目标下界（unix ms）。null = 不限（一直往回走到没数据）。
   * @param windowMs 单窗宽度。不传则按实测密度自适应。
   */
  /**
   * 找**内部空洞**：已覆盖区间里连续多天没有任何消息的那些段。
   *
   * ## ★★ 为什么必须有这个（回填补不了内部空洞）
   *
   * 回填的语义是「`[floor, 最早消息)` 之前的还没采」—— 它只能把**左端**
   * 往更早推。这建立在一个假设上：`[最早消息, now)` 已由增量采集覆盖完整。
   *
   * 而那个假设会被破坏，实测就破了：首次采集只回溯 7 天（7/23 起），
   * 之后回填往左跳到 2 月，于是 **3-6 月落在"已覆盖区间"内部却是空的**。
   * 此后回填一路往 2 月更左边走，**永远不会回头看那 4 个月**；
   * 而增量水位也声称 `[0, now)` 已完整 —— 两个游标都"正确"，
   * 中间那段没有任何机制会去覆盖它。
   *
   * 实测后果：库里 3-6 月只有 465 条（全来自 2 个群，单聊 0 条），
   * 而直接问二进制那段每天约 300 条。也就是漏了约 3.6 万条，
   * 而**没有任何地方会报错**。
   *
   * ## 判据：连续 `minGapDays` 天没有消息
   *
   * 用"天"而不是"小时"：正常人有整天不聊天（周末、休假），但**连续
   * 一周以上一条都没有**在一个日活账号上不合理。默认 7 天偏保守 ——
   * 宁可漏报一个真实的静默期，也不要把它当空洞去白拉一遍。
   *
   * ★ 返回**最大**那个空洞，不是最靠右的那个。
   *
   * 首版按 `next_at DESC`（最靠右）取，而那会选中"最近 10 天没聊"这类
   * 边缘间隔，把真正那个 90 天的空洞排在后面 —— 于是每轮都在补一个
   * 本来就没数据的小间隔，真空洞永远排不上。
   *
   * 按**跨度**排则天然优先处理"缺得最多"的那段；而补完它之后它会变小、
   * 下一轮自然轮到次大的那个。
   *
   * `null` = 没有空洞（常态）。
   */
  interiorGap(options: { minGapDays?: number } = {}): PullWindow | null {
    const minGapMs = (options.minGapDays ?? 7) * 24 * 60 * MS_PER_MINUTE
    /**
     * 取每一天的边界，用 SQL 算相邻消息的时间差 —— 找出差值超过阈值的那一对。
     *
     * 只看**有消息的那些天**之间的间隔，而不是逐天扫：后者在半年跨度上是
     * 180 次查询，而这个是一次。
     */
    const rows = this.options.db
      .prepare<[string, number], { prev_at: number; next_at: number }>(
        `SELECT prev_at, next_at FROM (
           SELECT sent_at AS next_at,
                  LAG(sent_at) OVER (ORDER BY sent_at) AS prev_at
             FROM messages WHERE channel_id = ?
         )
          WHERE prev_at IS NOT NULL AND next_at - prev_at > ?
          ORDER BY next_at - prev_at DESC LIMIT 1`,
      )
      .all(this.options.channelId, minGapMs)
    const gap = rows[0]
    if (gap === undefined) return null
    /**
     * 两端各留一点重叠：空洞的边界是"最后一条"与"下一条"，而那两条本身
     * 已经在库里。重叠靠幂等键兜住，代价只是几条重复行的比对。
     */
    return {
      start: gap.prev_at + 1,
      end: gap.next_at,
      cursor: null,
    }
  }

  nextBackfillWindow(since: number | null, windowMs?: number): PullWindow | null {
    const floor = this.cursors.watermark(this.backfillScope)
    const earliest = floor > 0 ? floor : this.earliestMessageAt()

    // 库里没消息 → 让增量采集的首轮回溯先跑。
    if (earliest === null) return null
    // 已经回填到目标了。
    if (since !== null && earliest <= since) return null

    const width = windowMs ?? this.adaptiveBackfillWidth()
    const start = since === null ? earliest - width : Math.max(since, earliest - width)
    // 宽度归零（since 恰好等于 earliest 的边界情形）→ 没活可干。
    if (start >= earliest) return null
    /**
     * 右端**不**加 overlap：这里的 `earliest` 是已确认覆盖的左端，
     * 与它相接就够。往右多要一截只会重拉已有数据 —— 回填的每一次
     * CLI 调用都是真实配额，而幂等键让重叠除了成本之外毫无收益。
     */
    return { start, end: earliest, cursor: null }
  }

  /**
   * 按**服务端实测**算下一个回填窗该多宽。
   *
   * ## ★★ 为什么不能用「库里的密度」来估（一个真实漏采了 4 个月的 bug）
   *
   * 首版采样「已覆盖区间最左那 3 天」在**库里**的条数，乘一个实测系数
   * （`PAGES_PER_ROW_SLACK = 1.4`，来自"库里 4606 / 服务端 5871"）反推
   * 服务端量。这在**已经采全**的区间上成立，而回填要去的恰恰是
   * **还没采过**的区间 —— 那里库里的条数近乎 0，比值根本不是 1.4。
   *
   * 实测这台机器（真数据，逐页抓下来对的账）：
   *
   * | 区间 | 库里 | 服务端 | 真实比值 |
   * | --- | --- | --- | --- |
   * | 7 月（已采全） | 4606 / 4.81 天 | 5871 | **1.27** ← 系数是在这量的 |
   * | 4/1–4/4（未采） | **29** | **>1213** | **>41** |
   *
   * 于是窗宽被高估 30 倍：算出 4.3 天的窗，而那 4 天真实需要 >25 页仍
   * `hasMore`（外推整段 3-6 月约 3.7 万条 / 763 页），而单轮预算是 120 页。
   * 后果不是"慢一点"，而是**整段历史被跳过**：每轮撞预算 → 抽不干 →
   * 下界不推 → 减半重试 → 偶尔抽干一次就把 override 清掉 → 又估出宽窗。
   * 实测结果：库里 3-6 月只有 465 条（全来自 2 个群），而单聊一条都没有。
   *
   * ## 现在的做法：**用上一轮真实翻了多少页**来调
   *
   * 服务端实际吐了多少条，只有跑过才知道。所以不再"预测"，而是**反馈**：
   * · 上一轮抽干了且远没用完预算 → 下一轮放宽（×2，上限 30 天）；
   * · 上一轮撞了预算（没抽干）→ 下一轮收窄（×⅓，下限 1 小时）；
   * · 没有历史（首轮）→ 从一个**保守**的宽度起步（1 天）。
   *
   * 收窄用 ÷3 而不是 ÷2：实测高估了 30 倍，二分要 5 轮才收敛，
   * 而每轮是 120 次 CLI 调用（约 72 秒）。÷3 只要 3 轮。
   * 放宽用 ×2 而不是更激进：放宽估错的代价是下一轮白烧 120 页。
   *
   * ★ 这个反馈量存在 DB（`sync_cursors.page_count`），所以**跨重启有效** ——
   * 存内存的话每次重启都要重新收敛一遍。
   */
  private adaptiveBackfillWidth(): number {
    const pageBudget = this.options.backfillPageBudget ?? 120
    const MIN = 60 * MS_PER_MINUTE
    const MAX = 30 * 24 * 60 * MS_PER_MINUTE
    /**
     * 首轮（没有上一轮记录）从 1 天起步。
     *
     * ★ 为什么是保守值而不是 7 天：估宽了的代价是**整段被跳过**（见上文），
     * 估窄了的代价只是多跑几轮。两者不对称，所以往窄的那侧偏。
     */
    const FIRST_ROUND_MS = 24 * 60 * MS_PER_MINUTE

    const row = this.cursors.get(this.backfillScope)
    const lastPages = row?.pageCount ?? 0
    const lastWidth =
      row === null || row.windowStart === null || row.windowEnd === null
        ? null
        : row.windowEnd - row.windowStart

    if (lastWidth === null || lastWidth <= 0 || lastPages <= 0) {
      return Math.min(MAX, Math.max(MIN, FIRST_ROUND_MS))
    }

    /**
     * 撞预算 = 没抽干 → 收窄。
     *
     * 判据用 `>=` 而不是 `>`：正好等于预算时也是"被预算截断"的
     * （循环条件是 `pages < budget`），当成抽干了会让下界推过一段没采完的区间。
     */
    if (lastPages >= pageBudget) {
      return Math.min(MAX, Math.max(MIN, Math.floor(lastWidth / 3)))
    }
    /**
     * 抽干了但只用掉不到三成预算 → 放宽。
     *
     * 留出余量而不是贴着预算放宽：密度会波动，贴着放等于下一轮大概率撞上。
     */
    if (lastPages * 3 < pageBudget) {
      return Math.min(MAX, Math.max(MIN, lastWidth * 2))
    }
    // 落在舒适区（用掉 1/3 ~ 全部预算）→ 保持。
    return Math.min(MAX, Math.max(MIN, lastWidth))
  }

  beginBackfillWindow(window: PullWindow): void {
    this.cursors.beginWindow(this.backfillScope, window.start, window.end)
  }

  /**
   * 把回填下界推到一个**已确认抽干**的更早时间点。
   *
   * 与 `commitProgress` 对称但方向相反，约束同样落在调用方：必须保证
   * `[floor, 原下界)` 的所有分页都已落库。半途提交会让那段历史被永久
   * 跳过 —— 而且是静默的（下界过去了，就再也没有窗会覆盖它）。
   */
  commitBackfillFloor(floor: number): void {
    this.cursors.commitFloor(this.backfillScope, floor)
  }

  /** 当前回填下界（unix ms）。0 = 还没回填过。 */
  get backfillFloor(): number {
    return this.cursors.watermark(this.backfillScope)
  }

  /**
   * 回填还差多少 —— 给状态页用。
   *
   * ★ 单独暴露而不是让 UI 自己算：`floor === 0` 要落回"库里最早的消息"
   * 这个规则在 `nextBackfillWindow` 里，抄一份到渲染层的话两边会漂。
   */
  backfillCoverage(since: number | null): {
    since: number | null
    /** 已覆盖的最早时间；null = 库里还没有消息 */
    coveredFrom: number | null
    /** 还没回填的毫秒数；0 = 已到目标 */
    remainingMs: number
    /**
     * 当前**正在回填**的那个时间窗；null = 这一刻没有在跑的窗。
     *
     * ★ 给界面回答「现在在拉哪一段」用的。只报 `remainingMs`
     * （"还差 38 天"）时进度是**不可感**的：那个数字每几分钟才动一次，
     * 用户分不清"在跑"与"卡住"。而"正在拉 6-11 到 6-13"是看得见在动的。
     *
     * 取自回填游标的 `window_start/window_end`（`beginWindow` 写入）。
     * `status !== "running"` 时返回 null —— 那时那两个值是**上一个**窗的
     * 残留，报出去会显示一个早已结束的区间。
     */
    activeWindow: { start: number; end: number } | null
    /** 已覆盖区间内的消息总数。界面用它显示"已采集 N 条"。 */
    messages: number
    /**
     * 采集**有没有真的开始**（库里有消息，或回填推进过）。
     *
     * ## ★★ 为什么 `remainingMs: 0` **不足以**表达"采完了"
     *
     * 这个方法曾经对「库里一条消息都没有」也返回 `remainingMs: 0` ——
     * 与"已经覆盖到目标"**返回同一个值**。而 UI 判 `remainingMs <= 0` 就显示
     * 「选的 N 天已全部采集完成」。
     *
     * 后果是**静默说谎**：实测踩到过（本机 2026-08-05 07:24 那个账号）——
     * 采集第一轮就撞 `SESSION_EXPIRED` 进入 blocked 终态、游标 `status=failed`、
     * `watermark` 还是 0（1970），`messages` 表一行都没有，而引导页第 5 步
     * 明明白白写着"选的 90 天已全部采集完成"，蒸馏跟着报 0 语料 / 覆盖度 D。
     * 用户完全无从判断是"没数据"还是"采集坏了"。
     *
     * 判据用 `coveredFrom === null` 而不是 `messages === 0`：前者与
     * `nextBackfillWindow` 的下界规则同源（都走"下界优先、否则落回最早消息"），
     * 而后者是另一个 COUNT —— 两处会漂。
     */
    started: boolean
  } {
    const floor = this.backfillFloor
    const coveredFrom = floor > 0 ? floor : this.earliestMessageAt()
    const row = this.cursors.get(this.backfillScope)
    /**
     * 只在 `running` 时报窗口。
     *
     * `beginWindow` 写下 window_start/end 之后它们会一直留在行里 ——
     * 一轮跑完（`commitFloor`）并不清空。不判 status 的话界面会一直
     * 显示最后那个已完成的区间，而"正在拉 6-11 到 6-13"这句话
     * 在它早已跑完之后仍然亮着，与真的在跑无法区分。
     */
    const activeWindow =
      row?.status === "running" && row.windowStart !== null && row.windowEnd !== null
        ? { start: row.windowStart, end: row.windowEnd }
        : null
    const messages = this.messageCount()
    // ★ 一条消息都没有 → 采集还没真的开始，不是"已完成"（见 started 的注释）。
    if (coveredFrom === null) {
      return { since, coveredFrom, remainingMs: 0, activeWindow, messages, started: false }
    }
    // 用户没设下界（不限范围）→ 没有"还差多少"可言，但采集确实已经在跑。
    if (since === null) {
      return { since, coveredFrom, remainingMs: 0, activeWindow, messages, started: true }
    }
    return {
      since,
      coveredFrom,
      remainingMs: Math.max(0, coveredFrom - since),
      activeWindow,
      messages,
      started: true,
    }
  }

  /** 库里这个渠道的消息总数。回填进度的分子（"已采集 N 条"）。 */
  private messageCount(): number {
    return (
      this.options.db
        .prepare<[string], { c: number }>("SELECT count(*) AS c FROM messages WHERE channel_id = ?")
        .get(this.options.channelId)?.c ?? 0
    )
  }

  /**
   * 对账窗口：**探针说有更新、而我们库里没有**的那些会话该补哪一段。
   *
   * ## ★ 为什么固定窗口不够（实测数据）
   *
   * 水位 + 2 分钟重叠只对抗"小的时钟偏差与延迟"。服务端延迟**超过重叠窗**
   * 时那段已经被水位推过去了，固定窗口再也不会覆盖它。
   *
   * 实测这台机器（92 个会话）：8 个会话的探针 `lastMsgAt` 晚于我们库里
   * 该会话的最新消息 —— 落后 6 / 235 / 559 分钟，另有 3 个会话我们
   * **一条消息都没有**（探针却报未读 1 / 35 / 35）。而水位早已推过它们，
   * 也就是说这些消息**永久漏采**，且界面上没有任何迹象（状态 idle、无错误）。
   *
   * ## 返回的是窗口，不是"要补的会话"
   *
   * 因为 `list-all` 是**按时间窗**拉的（它不接受会话过滤），所以补采的
   * 单位只能是时间窗。取所有落后会话里**最早**的那个"我们库里的时间"
   * 作为 start —— 一个窗覆盖全部落后会话，而不是每个会话一个窗
   * （后者在 8 个落后会话上就是 8 轮全量分页）。
   *
   * ## ★ 它的结果**绝不能**用来推水位
   *
   * 这个窗是往**回**补的（start 远早于水位）。拿它 `commitProgress`
   * 会让水位倒退，而水位倒退意味着此后每一轮都重拉一大段历史 ——
   * 那不是漏数据，是把采集拖死。调用方必须把它当"额外的一趟"，
   * 抽干之后不动水位。`SyncCursorRepository.commitWindow` 用的是
   * `MAX(watermark, ?)`，所以即使误传也不会真的倒退 —— 但语义上仍然是错的。
   *
   * `null` = 没有落后的会话（常态）。
   */
  reconciliationWindow(options: { toleranceMs?: number; maxLookbackMs?: number } = {}): {
    window: PullWindow
    staleCount: number
  } | null {
    const stale = this.probes.staleConversations(this.options.channelId, {
      ...(options.toleranceMs === undefined ? {} : { toleranceMs: options.toleranceMs }),
    })
    if (stale.length === 0) return null

    const now = this.options.clock.now()
    /**
     * 回溯上限：`ours = null`（一条都没有）的会话会把 start 拉到 0。
     * 那种会话要靠首次全量回溯覆盖，不该让每一轮对账都去拉一整年。
     */
    const maxLookback = options.maxLookbackMs ?? INITIAL_BACKFILL_MS
    const earliest = Math.min(
      ...stale.map((item) => item.oursLastMsgAt ?? item.probeLastMsgAt - MS_PER_MINUTE),
    )
    const start = Math.max(earliest - WINDOW_OVERLAP_MS, now - maxLookback)
    const latest = Math.max(...stale.map((item) => item.probeLastMsgAt))
    return {
      // end 取"探针见过的最晚 + 留量"，不用 now：对账要补的是**过去**那一段
      window: {
        start,
        end: Math.min(latest + WINDOW_LOOKAHEAD_MS, now + WINDOW_LOOKAHEAD_MS),
        cursor: null,
      },
      staleCount: stale.length,
    }
  }

  /**
   * 记录分页推进。**只**动 cursor 与 page_count，watermark 保持不变。
   *
   * 注意：切窗后子窗**不再调用 `beginWindow`**（那会重写 start/end 并清零
   * page_count，把"整轮覆盖了哪段"这个信息弄丢）。代价是 DB 里的 `cursor` 列
   * 在多子窗间交替写入后不再表示"某个窗的分页位置"，`page_count` 变成整轮累计。
   * 这两列只用于可观测性（排查时看"这一轮翻了多少页"），正确性不依赖它们 ——
   * 但排查时别把 cursor 当成某个窗的游标读。
   */
  advancePage(nextCursor: string | null): void {
    this.cursors.advancePage(this.scope, nextCursor)
  }

  /** 回填侧的分页记账。与 `advancePage` 同义，只是写另一行游标。 */
  advanceBackfillPage(nextCursor: string | null): void {
    this.cursors.advancePage(this.backfillScope, nextCursor)
  }

  /**
   * 截断检测的回填版。
   *
   * ★ 单独一个方法而不是给 `splitIfTruncated` 加参数：切到最小宽度时它会
   * `markTruncated(this.scope)` —— 回填撞到最小宽度却把**增量**那行标成
   * truncated，会让排查时看错行（"增量采集截断了"，而实际是补历史时截断的）。
   */
  splitBackfillIfTruncated(
    window: PullWindow,
    page: PullPageResult,
  ): readonly [PullWindow, PullWindow] | null {
    return this.splitWindow(window, page, this.backfillScope)
  }

  /**
   * 把水位推到一个**已确认抽干**的时间点。
   *
   * 参数是显式的 `effectiveEnd` 而不是窗口对象：正确性完全取决于调用方传的
   * 是"已确认抽干的右端"还是"某个窗的右端"，用窗口对象会让误传在阅读时看不出来
   * （切窗后传切小的窗 = 永久跳过右半，正是修复前的 bug）。
   *
   * ## ★ 水位永不超过 now（否则空窗会造出永久黑洞）
   *
   * 原实现是 `maxSentAt ?? window.end`，而 `window.end = now + WINDOW_LOOKAHEAD_MS`
   * （向前留量 5 分钟）。本窗无消息时水位被推到**未来 5 分钟**，
   * 下一窗 `start = watermark - WINDOW_OVERLAP_MS = now + 3min` 跑到 now 之后 ——
   * `[now, now+3min)` 这段再也不会被任何窗覆盖，落在里面的消息**永久丢失**。
   * 实测「新账号 + 安静期」6 轮，服务端 5 条消息 100% 未采集。
   *
   * `MAX(watermark, ?)` 只防水位回退，不防水位推太远，所以必须在这里 clamp。
   * 上限取 now 而不是 window.end：lookahead 是给「拉取范围」的留量
   * （宁可多拉），不是给「已确认落库」的（多推就是丢数据）。
   * maxSentAt 若因服务端时钟超前而大于 now，同样 clamp —— 代价只是下轮重拉
   * 一次（幂等键兜住），方向是安全的那一侧。
   *
   * @param effectiveEnd 已确认抽干的时间右端。**约束：调用方必须保证
   *   `[水位, effectiveEnd)` 区间内的所有分页都已落库。**
   */
  commitProgress(effectiveEnd: number): void {
    this.cursors.commitWindow(this.scope, Math.min(effectiveEnd, this.options.clock.now()))
  }

  failWindow(error: string): void {
    this.cursors.failWindow(this.scope, error)
  }

  /** 回填侧失败。写另一行，免得回填的问题看起来像增量采集坏了。 */
  failBackfillWindow(error: string): void {
    this.cursors.failWindow(this.backfillScope, error)
  }

  /**
   * 连续失败次数（`commitWindow` 成功时归零）。
   *
   * 暴露出来是为了让调用方**消费**它做退避。首版只把它累加进 DB 而无人读，
   * 于是病态渠道（每轮都撞预算或每轮都报错）会以固定频率持续烧 CLI 调用，
   * 既不升级告警也不减速 —— 那是"重试风暴"的标准形状。
   */
  get failedAttempts(): number {
    return this.cursors.get(this.scope)?.attempts ?? 0
  }

  /**
   * 当前水位（unix ms）。0 = 从未采过 → 下一轮会做完整回溯。
   *
   * 暴露出来给可观测用（回溯脚本要按它判断"追上了没有"）。
   * 只读 —— 推进水位必须走 `commitProgress`，那里有"只推连续前缀"的不变式。
   */
  get watermark(): number {
    return this.cursors.watermark(this.scope)
  }

  /**
   * 判断整窗是否疑似被截断，并给出**两个**子窗。
   *
   * ## ★ 只在「没有下一页」时才判定截断
   *
   * `looksTruncated` 是「条数达到 limit 的 90%」。分页场景下**正常满页必然成立**
   * ——满页正是 `nextCursor` 存在的原因。对每一页都判定会让每轮都在第一页就切窗，
   * 实测「每分钟 1 条消息的 7 天回溯」每轮 9 次 CLI 调用只推进 0.025 天，
   * 走完 7 天需约 280 轮 / 2500 次调用（回溯几乎停滞）。
   *
   * 真正可疑的是「刚好满页**却没有** nextCursor」：服务端既没给游标又给满了页，
   * 那才可能是静默截断。所以判定前置条件是 `page.nextCursor === null`。
   *
   * ## ★ 返回两个子窗，右半不能丢
   *
   * 旧实现只返回左半 `[start, mid]`，右半 `[mid, end]` 没有任何机制记住要补 ——
   * 且调用方随后对切小的窗 `commitWindow`，水位直接推到 mid，
   * 实测永久跳过 3.5 天历史。因此这里返回两个子窗，
   * 由调用方**双双入队分别抽干**，并且只在全部抽干后才推一次水位。
   *
   * 返回 null 表示没有截断或已切到最小宽度（后者会 markTruncated 并告警：
   * 到了这一步只能接受可能缺数据，但**必须让它可见**）。
   */
  splitIfTruncated(
    window: PullWindow,
    page: PullPageResult,
  ): readonly [PullWindow, PullWindow] | null {
    return this.splitWindow(window, page, this.scope)
  }

  /** `splitIfTruncated` 的本体，`scope` 只影响告警归属（见回填那个包装）。 */
  private splitWindow(
    window: PullWindow,
    page: PullPageResult,
    scope: string,
  ): readonly [PullWindow, PullWindow] | null {
    // ★ 有下一页时「满页」是正常的，不是截断信号。
    if (page.nextCursor !== null) return null

    const limit = this.options.pageLimit ?? 50
    if (!looksTruncated(page.itemCount, limit)) return null

    const width = window.end - window.start
    if (width <= MIN_WINDOW_MS) {
      this.cursors.markTruncated(scope)
      this.options.logger?.warn("window truncated at minimum width; data may be incomplete", {
        scope,
        start: window.start,
        end: window.end,
        itemCount: page.itemCount,
      })
      return null
    }

    const mid = window.start + Math.floor(width / 2)
    this.options.logger?.info("window split due to suspected truncation", {
      scope,
      itemCount: page.itemCount,
      limit,
      mid,
    })
    // 两个子窗在 mid 处相接（重叠一个时刻无害：幂等键保证不产生重复行）。
    return [
      { start: window.start, end: mid, cursor: null },
      { start: mid, end: window.end, cursor: null },
    ]
  }

  /** 记录一轮是否有新消息；连续空闲若干轮后返回 true（触发 WAL checkpoint）。 */
  observeRound(changedCount: number, idleThreshold = 5): boolean {
    if (changedCount > 0) {
      this.idleRounds = 0
      return false
    }
    this.idleRounds += 1
    if (this.idleRounds >= idleThreshold) {
      this.idleRounds = 0
      return true
    }
    return false
  }
}
