/**
 * 采集服务的拉取循环：分页 + 切窗 + 水位推进的**联合**行为。
 *
 * 单测 `scheduler-window.test.ts` 只覆盖 scheduler 的单个方法；
 * 而这次两个丢消息的 bug 都出在**服务层怎么组合这些方法**上：
 * ① 对每一页都做截断判定（满页必然触发）→ 回溯几乎停滞；
 * ② 切窗后只跑左半、并对切小的窗推水位 → 右半那段历史永久跳过。
 *
 * 所以这一层必须有自己的测试：用假插件精确控制每页返回什么，
 * 断言「哪些窗被拉过」与「水位落在哪」。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock, MS_PER_MINUTE } from "@mycontext/kernel"
import type {
  ChannelConversationPullSpec,
  ChannelPlugin,
  ChannelPullPage,
  ChannelPullSpec,
} from "@mycontext/channels"
import { INITIAL_BACKFILL_MS, WINDOW_LOOKAHEAD_MS } from "@mycontext/ingest"
import {
  ConversationRepository,
  DistillSourceRepository,
  SyncCursorRepository,
} from "@mycontext/store"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
/**
 * 服务层 `PAGE_LIMIT` 的镜像。**必须与它同值**。
 *
 * 截断检测的判据是「本页条数 ≥ 90% × PAGE_LIMIT」这个**相对**阈值，
 * 所以"满页"在这些用例里意味着 `itemCount === PAGE_LIMIT`。
 * 两边不同值时"满页"就构造不出来，表现是三条切窗用例莫名失败
 * （PAGE_LIMIT 从 50 提到 100 那次就是这样：50 条不再算满页 →
 * 不触发截断 → `status` 停在 idle、水位不再分段前进）。
 *
 * 服务层不导出这个常量（它是实现细节），所以只能镜像 + 靠这段注释锁住。
 */
const PAGE_LIMIT = 100
/** scheduler 的 scope 字符串（`${channelId}:chat:l2`）。服务层不暴露它，测试里直接写。 */
const SCOPE = "dingtalk:chat:l2"

/** 记录每次 pull 的窗口，供断言「哪些范围被真的拉过」。 */
interface PullCall {
  start: number
  end: number
  cursor: string | null
}

function emptyPage(overrides: Partial<ChannelPullPage> = {}): ChannelPullPage {
  const base = {
    conversations: [],
    messages: [],
    nextCursor: null,
    itemCount: 0,
    rawPayload: "{}",
    ...overrides,
  }
  return {
    ...base,
    // 没显式给 hasMore 时按"有游标就还有下一页"推导 ——
    // 这保留了各用例原本的意图。真实钉钉两者会**背离**（见下面专门那条用例）。
    hasMore: overrides.hasMore ?? base.nextCursor !== null,
  }
}

/**
 * 造一个只实现 ingest 的假插件。
 *
 * `respond` 决定每次 pull 返回什么 —— 测试用它精确复现「满页」「有无下一页」。
 */
function makePlugin(respond: (spec: ChannelPullSpec, calls: PullCall[]) => ChannelPullPage) {
  const calls: PullCall[] = []
  const plugin = {
    meta: { id: "dingtalk" },
    ingest: {
      probe: async () => null,
      pull: async (spec: ChannelPullSpec) => {
        calls.push({ start: spec.start, end: spec.end, cursor: spec.cursor })
        return respond(spec, calls)
      },
    },
  } as unknown as ChannelPlugin
  return { plugin, calls }
}

function makeService(plugin: ChannelPlugin, clock: ManualClock) {
  const vault = openTestVault()
  /**
   * ★ 显式写一行「不限会话」的 chat 源。
   *
   * 不写的话 `readCollectionScope` 读成「还没说过要采什么」= 一个都不采
   * （见 collection-scope.ts：清空渠道数据之后正是那个形态，默认值只能是空）。
   * 这些用例测的不是范围闸，所以要把范围明确置成"不限"。
   */
  new DistillSourceRepository(vault.db).upsert("chat", { enabled: true, scope: {} }, 0)
  const service = new IngestService({
    db: vault.db,
    clock,
    // 只留 error：切窗路径会打大量 info，刷屏会盖掉真正的失败信息
    logger: createLogger("test-ingest", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  // ★ 必须 start()：`tickPull` 现在会复查 `running`。
  // 那条守卫挡的是「stop 之后仍起新一轮 → 往已关闭的库上写」
  // （logout 路径实测抛 `The database connection is not open`）。
  // autoStart:false 保证 start() 不会起定时器，只置 running。
  service.start()
  return { vault, service, cursors: new SyncCursorRepository(vault.db, clock) }
}

describe("★ 满页不再被误判为截断（回溯停滞的回归防线）", () => {
  /**
   * 修复前：第一页就 itemCount=50 ≥ 45 → 立刻切窗，永远走不到第二页。
   * 修复后：有 nextCursor 时满页是正常的，正常翻页直到 nextCursor === null。
   */
  it("满页 + 有下一页 → 正常翻页，不切窗", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin((spec) => {
      // 前两页满页且有下一页；第三页收尾（不满页，所以不触发截断判定）
      const page = spec.cursor === null ? 1 : Number(spec.cursor)
      if (page < 3) return emptyPage({ itemCount: PAGE_LIMIT, nextCursor: String(page + 1) })
      return emptyPage({ itemCount: 7, nextCursor: null })
    })
    const { vault, service, cursors } = makeService(plugin, clock)

    await service.tickPull()

    // 三次调用，窗口始终是同一个（没被切小）
    expect(calls).toHaveLength(3)
    expect(new Set(calls.map((c) => `${c.start}:${c.end}`)).size).toBe(1)
    expect(calls.map((c) => c.cursor)).toEqual([null, "2", "3"])
    // 整窗抽干 → 水位推进（本窗无消息 → clamp 到 now）
    expect(cursors.watermark(SCOPE)).toBe(START)
    vault.close()
  })

  /**
   * ★★ 真实钉钉的坑：`hasMore:false` 但 `nextCursor` **非空**。
   *
   * 实测 277 页里 **276 页**是这个组合（且平均只有 6.1 条 —— 远不满页）。
   * 按"cursor 为空才算抽干"写的话 `drained` 永远为 false → 这个窗一直翻到
   * 撞 MAX_PAGES_PER_WINDOW（50 页）→ 被当成"没抽干"放回队首 → 下一轮从头再来。
   * 表现是**水位永不前进**（活锁）且每轮烧 50 次 CLI 调用，
   * 而日志里只有一句 "page budget exhausted" —— 看不出是游标语义读错了。
   *
   * 用**不满页**（6 条，真实均值）是刻意的：满页 + 无下一页是
   * *合法的截断嫌疑*，那时切窗才是对的。这条测的是非满页时不该继续翻。
   */
  it("hasMore=false 但 cursor 非空 → 停止翻页并推进水位（活锁回归）", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin(() =>
      emptyPage({ itemCount: 6, nextCursor: "opaque-token", hasMore: false }),
    )
    const { vault, service, cursors } = makeService(plugin, clock)

    await service.tickPull()

    // 只调一次就停（不是翻到 50 页预算耗尽）
    expect(calls).toHaveLength(1)
    // 水位推进了 —— 活锁的判据就是这一条
    expect(cursors.watermark(SCOPE)).toBe(START)
    vault.close()
  })

  /**
   * 与上一条成对：`hasMore:true` 时**要**继续翻页。
   *
   * 单独一条"停下来"的断言分不清"正确地停"与"根本不会翻页"。
   */
  it("hasMore=true → 继续翻页直到服务端说没有了", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin((spec) => {
      const page = spec.cursor === null ? 1 : Number(spec.cursor)
      return page < 3
        ? emptyPage({ itemCount: 6, nextCursor: String(page + 1), hasMore: true })
        : // 最后一页：仍然带一个非空 cursor（真实形态），靠 hasMore 收尾
          emptyPage({ itemCount: 4, nextCursor: "trailing-token", hasMore: false })
    })
    const { vault, service, cursors } = makeService(plugin, clock)

    await service.tickPull()

    expect(calls.map((c) => c.cursor)).toEqual([null, "2", "3"])
    expect(cursors.watermark(SCOPE)).toBe(START)
    vault.close()
  })

  /**
   * 回溯进度：修复前**第一页**就误判截断切窗，每轮只推进「窗宽 / 2^n」，
   * 实测「每分钟 1 条消息的 7 天回溯」每轮 9 次调用只推进 0.025 天，
   * 走完 7 天需约 280 轮 / 2500 次调用。
   *
   * 这条断言的是：正常渠道（不满页）**一次调用**就覆盖整个 7 天回溯窗。
   */
  it("一轮拉取即走完整个回溯窗（不再每轮只推进一点）", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin(() => emptyPage({ itemCount: 3, nextCursor: null }))
    const { vault, service, cursors } = makeService(plugin, clock)

    await service.tickPull()

    // 一次调用覆盖整窗：不切窗、不分页
    expect(calls).toHaveLength(1)
    expect(calls[0]!.start).toBe(START - INITIAL_BACKFILL_MS)
    expect(calls[0]!.end).toBe(START + WINDOW_LOOKAHEAD_MS)
    // 水位推到 now → 下一轮从 now 附近继续，而不是还在 7 天前磨
    expect(cursors.watermark(SCOPE)).toBe(START)
    vault.close()
  })
})

describe("★ 切窗后右半必须被拉（丢半个窗的回归防线）", () => {
  /**
   * 修复前：`splitIfTruncated` 只返回左半，服务层 `window = split` 接着跑左半，
   * 右半 [mid, end) 没有任何机制记住 —— 且随后对切小的窗 commitWindow，
   * 水位推到 mid，实测永久跳过 3.5 天历史。
   */
  it("第一次满页触发切窗后，两个子窗的范围都被拉过", async () => {
    const clock = new ManualClock(START)
    // 只有「整窗」这一次返回满页；子窗返回少量数据（不再触发切窗）
    let firstCall = true
    const { plugin, calls } = makePlugin(() => {
      if (firstCall) {
        firstCall = false
        return emptyPage({ itemCount: PAGE_LIMIT })
      }
      return emptyPage({ itemCount: 1 })
    })
    const { vault, service, cursors } = makeService(plugin, clock)

    await service.tickPull()

    const root = calls[0]
    expect(root).toBeDefined()
    const mid = root!.start + Math.floor((root!.end - root!.start) / 2)

    const ranges = calls.slice(1).map((c) => `${c.start}:${c.end}`)
    // 左半与右半都必须出现
    expect(ranges).toContain(`${root!.start}:${mid}`)
    expect(ranges).toContain(`${mid}:${root!.end}`)

    // 水位推到 now，而不是 mid（修复前是 mid → 跳过右半）
    expect(cursors.watermark(SCOPE)).toBe(START)
    expect(cursors.watermark(SCOPE)).not.toBe(mid)
    vault.close()
  })

  /**
   * 翻页预算耗尽时只能推到**已确认的连续前缀**，不能推到整窗右端
   * （否则跳过没抽干的那部分）。
   *
   * 但也**不能完全不推** —— 「一直撞预算」会让水位永远不动、
   * 每轮从同一个起点重跑，那是活锁，比修复前更糟。
   */
  it("翻页预算耗尽 → 水位只推到已确认前缀，且严格小于整窗右端", async () => {
    const clock = new ManualClock(START)
    // 永远满页无下一页 → 永远切窗 → 队列永远非空 → 撞上 MAX_PAGES_PER_WINDOW
    const { plugin } = makePlugin(() => emptyPage({ itemCount: PAGE_LIMIT }))
    const { vault, service, cursors } = makeService(plugin, clock)

    await service.tickPull()

    const watermark = cursors.watermark(SCOPE)
    // 没抽干 → 不能推到整窗右端
    expect(watermark).toBeLessThan(START + WINDOW_LOOKAHEAD_MS)
    expect(cursors.get(SCOPE)?.status).toBe("failed")
    vault.close()
  })

  /**
   * ★ 活锁防线：反复撞预算时水位必须**单调前进**。
   *
   * 这条是我在修复过程中自己引入又发现的问题：最初的"没抽干就完全不推水位"
   * 会让病态渠道（每次都满页无下一页）永远卡在同一个起点。
   */
  it("反复撞预算时水位单调前进（不活锁）", async () => {
    const clock = new ManualClock(START)
    // 病态渠道：左半永远满页无下一页（不断切窗），保证每轮都撞预算
    const { plugin } = makePlugin(() => emptyPage({ itemCount: PAGE_LIMIT }))
    const { vault, service, cursors } = makeService(plugin, clock)

    await service.tickPull()
    const first = cursors.watermark(SCOPE)
    await service.tickPull()
    const second = cursors.watermark(SCOPE)

    // 严格前进：每轮都确认掉一段最左侧的历史
    expect(second).toBeGreaterThan(first)
    vault.close()
  })
})

describe("水位与服务端时间", () => {
  it("有消息时用服务端最大 sentAt 推水位", async () => {
    const clock = new ManualClock(START)
    const sentAt = START - 10 * MS_PER_MINUTE
    const { plugin } = makePlugin(() =>
      emptyPage({
        itemCount: 1,
        conversations: [{ externalId: "c1", title: "群", type: "group", memberCount: 3 }],
        messages: [
          {
            externalId: "m1",
            conversationExternalId: "c1",
            senderExternalId: "u1",
            senderDisplayName: "张三",
            contentText: "你好",
            contentJson: null,
            quotedExternalId: null,
            sentAt,
            mentions: [],
            hasMedia: false,
          },
        ],
      }),
    )
    const { vault, service, cursors } = makeService(plugin, clock)

    await service.tickPull()

    expect(cursors.watermark(SCOPE)).toBe(sentAt)
    vault.close()
  })
})

/**
 * ★★ 切窗前**先落库**（64% 采集成本浪费的回归防线）。
 *
 * 修复前的顺序是「判切窗 → 切了就 `break`」，于是那一整页（50 条）被扔掉。
 * 而 DWS 的 `list-all` 实测**从不返回 cursor**（见 message-parse.ts），
 * 于是密集语料下**每个满页窗都会切窗**、每次切窗都白扔一页 ——
 * 形成「拉了就扔」的二分树。实测 20 轮：671 次 CLI 调用拉回 27743 条、
 * 仅落库 10118 条（**64% 纯浪费**），60msg/min 时子进程时间达 444min。
 *
 * 先落库是安全的：幂等键（payload_hash）保证子窗重拉同一批不产生重复行。
 * 切窗的意义是"把这段时间再扫一遍以防截断"，不是"这一页的数据不能要"。
 */
describe("★ 切窗前先落库（拉了就扔的回归防线）", () => {
  /** 造 n 条消息，时间递增；externalId 唯一，便于数落库行数。 */
  function messagesFor(tag: string, count: number, baseAt: number) {
    return Array.from({ length: count }, (_, index) => ({
      externalId: `${tag}-m${index}`,
      conversationExternalId: "c1",
      senderExternalId: "u1",
      senderDisplayName: "张三",
      contentText: `内容 ${tag}-${index}`,
      contentJson: null,
      quotedExternalId: null,
      sentAt: baseAt + index,
      mentions: [],
      hasMedia: false,
    }))
  }

  it("触发切窗的那一页仍然落库（不是拉了就扔）", async () => {
    const clock = new ManualClock(START)
    const sentAt = START - 60 * MS_PER_MINUTE
    // 第一次调用：满页无下一页 → 触发切窗。这一页的 50 条必须落库。
    let firstCall = true
    const { plugin } = makePlugin(() => {
      if (firstCall) {
        firstCall = false
        return emptyPage({
          itemCount: PAGE_LIMIT,
          conversations: [{ externalId: "c1", title: "群", type: "group", memberCount: 3 }],
          messages: messagesFor("root", PAGE_LIMIT, sentAt),
        })
      }
      // 子窗返回空，不再切窗
      return emptyPage({ itemCount: 0 })
    })
    const { vault, service } = makeService(plugin, clock)

    const result = await service.tickPull()

    // ★ 修复前这里是 0：切窗时 break 把整页扔了
    expect(result.changed).toBe(PAGE_LIMIT)
    const rows = vault.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM messages").get()?.c
    expect(rows).toBe(PAGE_LIMIT)
    vault.close()
  })

  /**
   * 子窗重拉同一批消息不产生重复行（幂等键兜住）——
   * 这正是"先落库"安全的前提，所以要显式钉住。
   */
  it("子窗重拉同一批消息不产生重复行（幂等键兜住）", async () => {
    const clock = new ManualClock(START)
    const sentAt = START - 60 * MS_PER_MINUTE
    let call = 0
    // 前两次都返回**同一批** 50 条：第一次触发切窗，左子窗又拉到同一批。
    const { plugin } = makePlugin(() => {
      call += 1
      if (call <= 2) {
        return emptyPage({
          itemCount: PAGE_LIMIT,
          conversations: [{ externalId: "c1", title: "群", type: "group", memberCount: 3 }],
          messages: messagesFor("dup", PAGE_LIMIT, sentAt),
        })
      }
      return emptyPage({ itemCount: 0 })
    })
    const { vault, service } = makeService(plugin, clock)

    await service.tickPull()

    const rows = vault.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM messages").get()?.c
    // 拉了两遍，库里仍是 50 行
    expect(rows).toBe(PAGE_LIMIT)
    vault.close()
  })
})

/**
 * ★★ 生命周期：`stop()` 必须重置 `busy` 并等在途的那一轮。
 *
 * 两个独立的 bug 都在这里：
 * ① `stop()` 不重置 `busy`，而 `tickPull` 的守卫只看 `busy` ——
 *    stop 撞上正在跑的一轮后 `busy` 永远停在 true，之后每轮被静默挡掉
 *    （定时器在跑、无错误无日志、状态页仍显示 running:true）；
 * ② `stop()` 是同步的、不等在途的 tick，而调用方随后就关库 ——
 *    那一轮从 DWS 子进程回来时写到已关闭的连接上，实测抛
 *    `The database connection is not open`，且无人 catch（unhandledRejection）。
 */
describe("★ stop 的生命周期（静默停摆与关库竞态的回归防线）", () => {
  it("stop 之后 tickPull 直接返回（不再往库上写）", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin(() => emptyPage({ itemCount: 1 }))
    const { vault, service } = makeService(plugin, clock)

    await service.stop()
    await service.tickPull()

    // 一次 pull 都没发生：running 守卫拦在起新一轮之前
    expect(calls).toHaveLength(0)
    vault.close()
  })

  it("★ stop 重置 busy —— 重新 start 后采集能恢复（不静默停摆）", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin(() => emptyPage({ itemCount: 1 }))
    const { vault, service } = makeService(plugin, clock)

    await service.tickPull()
    const before = calls.length
    expect(before).toBeGreaterThan(0)

    await service.stop()
    service.start()
    await service.tickPull()

    // 修复前：busy 卡在 true → 这一轮被静默挡掉，calls 不再增长
    expect(calls.length).toBeGreaterThan(before)
    vault.close()
  })

  /**
   * ★ 核心竞态：stop 发生在一轮 tick 的**中途**（正在 await 子进程）。
   *
   * `stop()` 必须等那一轮收尾后才返回，否则调用方（logout → closeAll）
   * 会先把库关掉。这里用一个手工控制的 promise 精确复现那个时刻。
   */
  it("★ stop 等在途的那一轮收尾（logout 关库竞态）", async () => {
    const clock = new ManualClock(START)
    let releasePull: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releasePull = resolve
    })
    let pullFinished = false

    // makePlugin 的 respond 是同步的，而这条用例需要一个能**挂住**的 pull，
    // 所以建完之后直接替掉 ingest.pull（respond 因此永远不会被调用）。
    const { plugin } = makePlugin(() => emptyPage({ itemCount: 0 }))
    const ingest = (plugin as unknown as { ingest: { pull: unknown } }).ingest
    ingest.pull = async () => {
      await gate
      pullFinished = true
      return emptyPage({ itemCount: 0 })
    }

    const { vault, service } = makeService(plugin, clock)

    const inFlight = service.tickPull()
    // 此刻那一轮卡在 await 上
    const stopping = service.stop()
    // 放行后，stop 必须等它跑完才 resolve
    releasePull?.()
    await stopping
    expect(pullFinished).toBe(true)

    await inFlight
    vault.close()
  })
})

/**
 * ★ 退避：`attempts` 必须被消费。
 *
 * 首版只把它累加进 DB 而无人读 —— 每轮都报错的病态渠道会以固定 2 分钟频率
 * 持续烧 CLI 调用，既不减速也不升级告警（那是"重试风暴"的标准形状）。
 *
 * 但退避的触发条件要窄：大回溯会连着很多轮撞预算，那是**正常的分批工作**
 * 且水位单调前进 —— 对它退避等于"越有进展越被减速"，
 * 7 天历史会拖成几小时。所以判据是"失败"，不是"没抽干"。
 */
describe("★ 失败退避（重试风暴的回归防线）", () => {
  it("连续报错后跳过若干轮，且 failedAttempts 在快照里可见", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin(() => {
      throw new Error("network unreachable")
    })
    const { vault, service } = makeService(plugin, clock)

    await service.tickPull()
    expect(calls).toHaveLength(1)
    // 第一次失败 → attempts=1 → 跳过 1 轮
    expect(service.snapshot().failedAttempts).toBe(1)
    // 降级必须在状态页可见（首版只写 DB 的 last_error，UI 看不到）
    expect(service.snapshot().lastError).not.toBeNull()

    await service.tickPull()
    expect(calls).toHaveLength(1) // 被退避跳过

    await service.tickPull()
    expect(calls).toHaveLength(2) // 退避耗尽，重新尝试
    vault.close()
  })

  it("用户手动同步（clearBackoff）能立刻打破退避", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin(() => {
      throw new Error("network unreachable")
    })
    const { vault, service } = makeService(plugin, clock)

    await service.tickPull()
    expect(calls).toHaveLength(1)

    // 不清退避的话这一轮会被跳过；用户点了"立即同步"就该真的跑
    service.clearBackoff()
    await service.tickPull()
    expect(calls).toHaveLength(2)
    vault.close()
  })

  it("★ 撞预算但有推进时**不**退避（大回溯不该越有进展越慢）", async () => {
    const clock = new ManualClock(START)
    // 第一个窗能抽干（推进水位），随后的窗永远满页无下一页（不断切窗撞预算）
    let call = 0
    const { plugin, calls } = makePlugin(() => {
      call += 1
      if (call === 1) return emptyPage({ itemCount: 1, nextCursor: null })
      return emptyPage({ itemCount: PAGE_LIMIT, nextCursor: null })
    })
    const { vault, service } = makeService(plugin, clock)

    await service.tickPull()
    const afterFirst = calls.length
    // 下一轮必须真的跑（没被退避挡掉）
    await service.tickPull()
    expect(calls.length).toBeGreaterThan(afterFirst)
    vault.close()
  })

  it("成功一轮后退避清零", async () => {
    const clock = new ManualClock(START)
    let fail = true
    const { plugin } = makePlugin(() => {
      if (fail) throw new Error("transient")
      return emptyPage({ itemCount: 0 })
    })
    const { vault, service } = makeService(plugin, clock)

    await service.tickPull()
    expect(service.snapshot().failedAttempts).toBe(1)

    fail = false
    service.clearBackoff()
    await service.tickPull()
    expect(service.snapshot().failedAttempts).toBe(0)
    // 成功路径要清掉上一轮的错误（否则瞬时失败会永久留在面板上）
    expect(service.snapshot().lastError).toBeNull()
    vault.close()
  })
})

/**
 * ★★ 单轮翻页预算必须够大到能抽干一个真实的 7 天回溯窗。
 *
 * ## 这条防的是一个实测发生过的活锁
 *
 * `MAX_PAGES_PER_WINDOW` 首版是 50，与 `PAGE_LIMIT`（单页 50 条）碰巧同值 ——
 * 混起来看会以为"一轮 50 条"，实际是"一轮最多 50 页"。
 *
 * 实测该账号 7 天窗内 **2529 条**消息 → 需要 **51 页**。预算 50 页时首窗
 * 永远抽不完 → `confirmedEnd` 恒为 null → **水位永不前进**，
 * 每轮烧满 50 次 CLI 调用把同一段历史反复重拉，
 * 日志里只有一句 `page budget exhausted`。
 * 实测复现：连续 5 轮各 50 页，第 3/4/5 轮各新增 **0 条**，水位始终是 0。
 *
 * 断言方式是**行为**而不是常量值：造一个"要 51 页才抽干"的渠道，
 * 断言一轮之内水位真的推进了。改小预算会让它变红。
 */
describe("★★ 单轮预算够抽干真实规模的回溯窗（活锁回归）", () => {
  it("需要 51 页才抽干的窗，一轮之内能抽干并推进水位", async () => {
    const clock = new ManualClock(START)
    const PAGES_NEEDED = 51
    let served = 0
    // 前 50 页满页且 hasMore=true，第 51 页收尾。
    const { plugin, calls } = makePlugin(() => {
      served += 1
      return served < PAGES_NEEDED
        ? emptyPage({ itemCount: PAGE_LIMIT, nextCursor: `c${served}`, hasMore: true })
        : emptyPage({ itemCount: 29, nextCursor: "trailing", hasMore: false })
    })
    const { vault, service, cursors } = makeService(plugin, clock)

    await service.tickPull()

    // 真的翻到了第 51 页（预算 50 时这里会停在 50）
    expect(calls).toHaveLength(PAGES_NEEDED)
    // ★ 水位推进了 —— 这是活锁与否的唯一判据
    expect(cursors.watermark(SCOPE)).toBe(START)
    expect(cursors.get(SCOPE)?.status).toBe("idle")
    vault.close()
  })
})

/**
 * ★ 补历史的消息不投给数字人。
 *
 * 真机故障：加了反向历史回填之后，7/13～7/22 的消息被补进库，而快通道
 * （`inbound.message`）对**所有**落库消息一律发信号 —— 它区分不出
 * "刚到的"和"补历史补出来的"。数字人于是给 10~19 天前的群消息逐条
 * 起草，实测积了 6 条待审草稿。
 *
 * 两重后果：① 一条三周前的消息现在回是社交事故；② 回填一轮几千条，
 * 逐条走 agent 判定＋起草是几百次调用换 0 个有用的草稿。
 *
 * 落库、进蒸馏都要照常 —— 那正是回填的目的。只有"投给数字人"这一步要跳过。
 */
describe("★ 回填的消息不进数字人待审队列", () => {
  /** 造一条落在指定时间的消息，形状与 `ParsedMessageLike` 一致。 */
  function messageAt(externalId: string, sentAt: number) {
    return {
      externalId,
      conversationExternalId: "cid-1",
      senderExternalId: "peer-1",
      senderDisplayName: "对端",
      contentText: "在吗",
      contentJson: null,
      quotedExternalId: null,
      sentAt,
      mentions: [],
      hasMedia: false,
    }
  }

  function conversationRow() {
    return {
      externalId: "cid-1",
      type: "group" as const,
      title: "群",
      memberCount: 5,
    }
  }

  it("★★★ 增量采到的消息会发 `batch.persisted`（UI 刷新信号）", async () => {
    /**
     * ## 这一条这一轮**换了对象**
     *
     * 原来它断言 `inbound.message`（快通道的逐条投递事件）。那条路已删
     * （v4 §4：投递只走 changelog），而**批级** UI 信号 `batch.persisted`
     * 留着 —— 渲染层订阅它刷新计数。
     *
     * ★ 两者的区别值得记：`inbound.message` 是**投递**（要判路由与准入），
     * `batch.persisted` 是**通知界面**（不判任何东西）。原来它们并存，
     * 而前者的三个触发条件（changed>0 / 非 backfill / 订阅方挂上）
     * 正是"为什么这条没投"有三个答案的来源。
     */
    const clock = new ManualClock(START)
    const { plugin } = makePlugin((spec) =>
      spec.cursor === null
        ? emptyPage({
            conversations: [conversationRow()],
            messages: [messageAt("msg-fresh", START - 60_000)],
            itemCount: 1,
            hasMore: false,
          })
        : emptyPage({ hasMore: false }),
    )
    const { vault, service } = makeService(plugin, clock)
    const batches: number[] = []
    service.events.on("batch.persisted", (e: { changed: number }) => batches.push(e.changed))

    await service.tickPull()

    expect(
      batches.some((changed) => changed > 0),
      "有新消息就该刷 UI",
    ).toBe(true)
    vault.close()
  })

  it("★★★ 回填的消息**仍然落库**（蒸馏要用），而不投给分身靠路由挡", async () => {
    /**
     * ## 这一条的判据从"事件"移到了"路由"
     *
     * 原来它断言"回填不发 `inbound.message`" —— 那是靠 `persist()` 里
     * `options.backfill === true` 那一支实现的。那条路已删。
     *
     * 而"回填的消息不该被起草"这个**要求没变**，它现在由
     * `routeToAttention` 的第三条判据保证：`sentAt < enabled_at` →
     * `before_enabled_at`。而回填的消息**按定义**比库里所有消息都早
     * （窗口从已知最早那条往左走），所以那条判据必然拦住它们。
     *
     * ★★ 那个判据比事件那一支**更强**：它对**任何**灌入路径都成立
     * （包括消费者重放、手动导入），而事件那一支只覆盖 `persist` 一条。
     * `persist` 里那段注释写的正是这个理由（"靠一个持久、且对任何灌入
     * 路径都成立的判据更可靠"）。
     *
     * ★ 所以这里只断言**落库**那一半 —— 不投递那一半由
     * `attention-scope.test.ts` 的 `before_enabled_at` 那条锁住。
     */
    const clock = new ManualClock(START)
    const backfilled = START - 19 * 24 * 60 * MS_PER_MINUTE
    const { plugin } = makePlugin((spec) => {
      // 回填窗的右端 <= 库里最早那条消息的时间，据此区分两条路径。
      const isBackfill = spec.end <= START - 60_000
      if (isBackfill) {
        return emptyPage({
          conversations: [conversationRow()],
          messages: [messageAt("msg-old", backfilled)],
          itemCount: 1,
          hasMore: false,
        })
      }
      return spec.cursor === null
        ? emptyPage({
            conversations: [conversationRow()],
            messages: [messageAt("msg-fresh", START - 60_000)],
            itemCount: 1,
            hasMore: false,
          })
        : emptyPage({ hasMore: false })
    })
    const { vault, service } = makeService(plugin, clock)

    // 先跑一轮增量，让库里有"最早那条" + 让回填有起点。
    await service.tickPull()

    // 引导里选了 180 天 —— 回填据此往左走。
    new DistillSourceRepository(vault.db).upsert(
      "chat",
      { enabled: true, scope: { since: START - 180 * 24 * 60 * MS_PER_MINUTE } },
      START,
    )
    await service.tickPull()

    const stored = vault.db
      .prepare<[string], { c: number }>("SELECT count(*) AS c FROM messages WHERE external_id = ?")
      .get("msg-old")
    expect(stored?.c, "回填的消息必须落库（蒸馏要用）").toBe(1)
    vault.close()
  })
})

describe("★ 听记采集尊重引导里的勾选（distill_sources.minutes.enabled）", () => {
  /** 造一个带 minutes 能力的假插件，记下 list 被调了几次。 */
  function makeMinutesPlugin() {
    let listed = 0
    const plugin = {
      meta: { id: "dingtalk" },
      ingest: {
        probe: async () => null,
        pull: async () => emptyPage({ itemCount: 0, nextCursor: null }),
      },
      minutes: {
        list: async () => {
          listed += 1
          return { page: { items: [], nextToken: null, hasMore: false }, rawPayload: "[]" }
        },
        body: async () => ({ summaryText: null, transcriptJson: null, rawPayload: "{}" }),
      },
    } as unknown as ChannelPlugin
    return { plugin, listedCount: () => listed }
  }

  it("源不存在（老库）→ 默认采（引导默认勾了听记）", async () => {
    const clock = new ManualClock(START)
    const { plugin, listedCount } = makeMinutesPlugin()
    const { vault, service } = makeService(plugin, clock)
    // 不写 distill_sources → minutesEnabled() 返回 true
    await service.tickMinutes()
    expect(listedCount()).toBe(1)
    vault.close()
  })

  it("★ 显式关掉听记源 → 一次都不采（那个勾选框不再是装饰）", async () => {
    const clock = new ManualClock(START)
    const { plugin, listedCount } = makeMinutesPlugin()
    const { vault, service } = makeService(plugin, clock)
    new DistillSourceRepository(vault.db).upsert("minutes", { enabled: false, scope: {} }, START)
    await service.tickMinutes()
    expect(listedCount()).toBe(0)
    vault.close()
  })

  it("显式开启听记源 → 采", async () => {
    const clock = new ManualClock(START)
    const { plugin, listedCount } = makeMinutesPlugin()
    const { vault, service } = makeService(plugin, clock)
    new DistillSourceRepository(vault.db).upsert("minutes", { enabled: true, scope: {} }, START)
    await service.tickMinutes()
    expect(listedCount()).toBe(1)
    vault.close()
  })
})

/**
 * ★★ 听记列表的**抽干**。
 *
 * ## 首版只取首页，而那是一个完全静默的数据缺失
 *
 * 首版注释写着「后续页由下一轮的 cursor=null 重新覆盖到最新的那批」——
 * 后半句是错的：每一轮都从 `cursor=null` 开始，所以永远只覆盖最新的
 * 那 50 条，**历史页一次都不会被访问**。第 51 场之前的会议永久采不到。
 *
 * 而当时没有任何出口：不落库、不上报、不记日志。状态页的听记计数
 * 稳定停在 50，与"这个账号一共 50 场会"在界面上无法区分。
 *
 * 下面每一条对应抽干循环的一个停止条件 —— 少一条就是一类病态。
 */
describe("★★ 听记列表抽干分页", () => {
  /**
   * 造一个按调用序号返回预置页的假 minutes 插件。
   *
   * 记下每次 `list` 收到的 spec：范围收窄那一组要断言 since/until 传下去了。
   */
  function makePagedMinutesPlugin(pages: readonly { items: string[]; next: string | null }[]) {
    const specs: { cursor?: string | null; since?: number | null; until?: number | null }[] = []
    const plugin = {
      meta: { id: "dingtalk" },
      ingest: {
        probe: async () => null,
        pull: async () => emptyPage({ itemCount: 0, nextCursor: null }),
      },
      minutes: {
        list: async (spec: { cursor?: string | null } = {}) => {
          const index = specs.length
          specs.push(spec)
          // 超出预置页数时继续返回最后一页（模拟"服务端一直说还有"）
          const page = pages[Math.min(index, pages.length - 1)] ?? { items: [], next: null }
          return {
            page: {
              items: page.items.map((uuid, i) => ({
                externalId: uuid,
                title: `会议 ${uuid}`,
                // 每页的会议时间递减（真实的 list 是新→旧）
                startedAt: START - (index * 10 + i) * 86_400_000,
                durationSec: 600,
                summaryText: null,
                transcriptJson: null,
                speakersJson: null,
              })),
              nextToken: page.next,
              hasMore: page.next !== null,
            },
            rawPayload: JSON.stringify({ page: index }),
          }
        },
        body: async () => ({
          summaryText: "摘要",
          transcriptJson: JSON.stringify({ hasNext: false, pages: 1, paragraphList: [] }),
          transcriptPages: 1,
          transcriptTruncated: false,
          rawPayload: "{}",
        }),
      },
    } as unknown as ChannelPlugin
    return { plugin, specs }
  }

  /** 库里的听记条数。 */
  function minutesCount(vault: ReturnType<typeof openTestVault>): number {
    return vault.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM minutes").get()?.c ?? 0
  }

  /** `minutes_coverage` 那一行。 */
  function coverage(vault: ReturnType<typeof openTestVault>) {
    return vault.db
      .prepare<
        [string],
        { drained: number; earliest_started_at: number | null; listed_total: number }
      >("SELECT * FROM minutes_coverage WHERE channel_id = ?")
      .get("dingtalk")
  }

  it("★★ 三页全部抽干：三页都落库，coverage 记 drained=1", async () => {
    const clock = new ManualClock(START)
    const { plugin, specs } = makePagedMinutesPlugin([
      { items: ["m1", "m2"], next: "t1" },
      { items: ["m3"], next: "t2" },
      { items: ["m4"], next: null },
    ])
    const { vault, service } = makeService(plugin, clock)

    const result = await service.tickMinutes()

    expect(specs).toHaveLength(3)
    expect(result.listed).toBe(4)
    // ★ 四条都进库了 —— 首版只会有前两条
    expect(minutesCount(vault)).toBe(4)
    expect(coverage(vault)?.drained).toBe(1)
    expect(coverage(vault)?.listed_total).toBe(4)
    vault.close()
  })

  it("★ 首页不传 cursor，之后每页传上一页的 nextToken", async () => {
    const clock = new ManualClock(START)
    const { plugin, specs } = makePagedMinutesPlugin([
      { items: ["m1"], next: "t1" },
      { items: ["m2"], next: null },
    ])
    const { vault, service } = makeService(plugin, clock)

    await service.tickMinutes()

    expect(specs[0]?.cursor).toBeNull()
    expect(specs[1]?.cursor).toBe("t1")
    vault.close()
  })

  /**
   * ★★ 撞页数预算 → `drained = 0`。**截断必须落库**。
   *
   * 只记 warn 日志（documents 那条链现在的做法）用户看不到，
   * 而"我的会议怎么只有这些"恰恰是用户会问的。
   */
  it("★★ 一直 hasMore=true → 停在页数预算，且 drained=0（截断可见）", async () => {
    const clock = new ManualClock(START)
    // 永远给**新**游标（所以不会被"游标没前进"提前挡住）
    let token = 0
    const plugin = {
      meta: { id: "dingtalk" },
      ingest: {
        probe: async () => null,
        pull: async () => emptyPage({ itemCount: 0, nextCursor: null }),
      },
      minutes: {
        list: async () => {
          token += 1
          return {
            page: {
              items: [
                {
                  externalId: `m${String(token)}`,
                  title: null,
                  startedAt: START - token * 86_400_000,
                  durationSec: null,
                  summaryText: null,
                  transcriptJson: null,
                  speakersJson: null,
                },
              ],
              nextToken: `t${String(token)}`,
              hasMore: true,
            },
            rawPayload: "{}",
          }
        },
        body: async () => ({
          summaryText: null,
          transcriptJson: null,
          transcriptPages: 1,
          transcriptTruncated: false,
          rawPayload: "{}",
        }),
      },
    } as unknown as ChannelPlugin
    const { vault, service } = makeService(plugin, clock)

    const result = await service.tickMinutes()

    // MINUTES_MAX_LIST_PAGES = 20（服务侧常量，不导出 —— 这里锁的是行为）
    expect(token).toBe(20)
    expect(result.listed).toBe(20)
    expect(coverage(vault)?.drained, "撞预算 = 没抽干，必须记下来").toBe(0)
    vault.close()
  })

  /**
   * ★ 游标没前进 → 停。
   *
   * 不停的话下一轮参数完全相同，必然死循环（烧光预算换回同一页）。
   * `conversations.ts` 的群列表循环踩过同一个坑。
   */
  it("★ nextToken 没前进 → 停（否则原地打转）", async () => {
    const clock = new ManualClock(START)
    const { plugin, specs } = makePagedMinutesPlugin([
      { items: ["m1"], next: "same" },
      { items: ["m1"], next: "same" },
    ])
    const { vault, service } = makeService(plugin, clock)

    await service.tickMinutes()

    // 第一页拿到 same → 第二页也回 same → 停
    expect(specs).toHaveLength(2)
    expect(coverage(vault)?.drained).toBe(0)
    vault.close()
  })

  it("★ 说还有但没给游标 → 停，且 drained=0（翻不动 ≠ 抽干了）", async () => {
    const clock = new ManualClock(START)
    const plugin = {
      meta: { id: "dingtalk" },
      ingest: {
        probe: async () => null,
        pull: async () => emptyPage({ itemCount: 0, nextCursor: null }),
      },
      minutes: {
        list: async () => ({
          // hasMore 说还有，但 nextToken 是 null
          page: { items: [], nextToken: null, hasMore: true },
          rawPayload: "{}",
        }),
        body: async () => ({
          summaryText: null,
          transcriptJson: null,
          transcriptPages: 1,
          transcriptTruncated: false,
          rawPayload: "{}",
        }),
      },
    } as unknown as ChannelPlugin
    const { vault, service } = makeService(plugin, clock)

    await service.tickMinutes()

    expect(coverage(vault)?.drained).toBe(0)
    vault.close()
  })

  it("coverage 记下已覆盖到的最早会议时间（进度条的分母）", async () => {
    const clock = new ManualClock(START)
    const { plugin } = makePagedMinutesPlugin([
      { items: ["m1"], next: "t1" },
      { items: ["m2"], next: null },
    ])
    const { vault, service } = makeService(plugin, clock)

    await service.tickMinutes()

    // 第二页的会议更早（makePagedMinutesPlugin 里时间随页递减）
    const earliest = coverage(vault)?.earliest_started_at
    expect(earliest).toBe(START - 10 * 86_400_000)
    vault.close()
  })

  /**
   * ★ 转写的抽干状态要落到 `minutes` 表上。
   *
   * 状态页靠 `count(*) WHERE transcript_truncated = 1` 显示
   * "N 场会的转写不完整" —— 不落库的话那个数字算不出来。
   */
  it("★ 转写截断落进 minutes.transcript_truncated", async () => {
    const clock = new ManualClock(START)
    const plugin = {
      meta: { id: "dingtalk" },
      ingest: {
        probe: async () => null,
        pull: async () => emptyPage({ itemCount: 0, nextCursor: null }),
      },
      minutes: {
        list: async () => ({
          page: {
            items: [
              {
                externalId: "m1",
                title: "长会",
                startedAt: START,
                durationSec: 7200,
                summaryText: null,
                transcriptJson: null,
                speakersJson: null,
              },
            ],
            nextToken: null,
            hasMore: false,
          },
          rawPayload: "{}",
        }),
        // 撞了渠道侧的上限
        body: async () => ({
          summaryText: "摘要",
          transcriptJson: JSON.stringify({ hasNext: true, pages: 20, paragraphList: [] }),
          transcriptPages: 20,
          transcriptTruncated: true,
          rawPayload: "{}",
        }),
      },
    } as unknown as ChannelPlugin
    const { vault, service } = makeService(plugin, clock)

    await service.tickMinutes()

    const row = vault.db
      .prepare<
        [string],
        { transcript_pages: number | null; transcript_truncated: number | null }
      >("SELECT transcript_pages, transcript_truncated FROM minutes WHERE external_id = ?")
      .get("m1")
    expect(row?.transcript_pages).toBe(20)
    expect(row?.transcript_truncated).toBe(1)
    vault.close()
  })
})

/**
 * ★★ 听记的**范围收窄** —— CLAUDE.md 第 5 节。
 *
 * 听记采集从前完全不看用户选的时间范围。只取首页时这被"覆盖面太小"掩盖了；
 * 一旦抽干历史，不收窄就会把用户明确排除掉的时间段整段采回来。
 *
 * ★ 判据必须读 **minutes 自己那一行**的 scope，不能用 `readCollectionScope`
 * （它写死了 `kind = 'chat'`）—— 见 `IngestService.minutesTimeRange` 的注释。
 */
describe("★★ 听记采集尊重引导里选的时间范围", () => {
  function makeRecordingPlugin() {
    const specs: { since?: number | null; until?: number | null }[] = []
    const plugin = {
      meta: { id: "dingtalk" },
      ingest: {
        probe: async () => null,
        pull: async () => emptyPage({ itemCount: 0, nextCursor: null }),
      },
      minutes: {
        list: async (spec: { since?: number | null; until?: number | null } = {}) => {
          specs.push(spec)
          return { page: { items: [], nextToken: null, hasMore: false }, rawPayload: "[]" }
        },
        body: async () => ({
          summaryText: null,
          transcriptJson: null,
          transcriptPages: 1,
          transcriptTruncated: false,
          rawPayload: "{}",
        }),
      },
    } as unknown as ChannelPlugin
    return { plugin, specs }
  }

  it("★★ 配了 since/until → 传给渠道（否则会采到被排除的时间段）", async () => {
    const clock = new ManualClock(START)
    const { plugin, specs } = makeRecordingPlugin()
    const { vault, service } = makeService(plugin, clock)
    const since = START - 30 * 86_400_000
    const until = START - 86_400_000
    new DistillSourceRepository(vault.db).upsert(
      "minutes",
      { enabled: true, scope: { since, until } },
      START,
    )

    await service.tickMinutes()

    expect(specs[0]?.since).toBe(since)
    expect(specs[0]?.until).toBe(until)
    vault.close()
  })

  it("没配过范围（老库）→ 不传时间窗（全量，不因升级突然少采）", async () => {
    const clock = new ManualClock(START)
    const { plugin, specs } = makeRecordingPlugin()
    const { vault, service } = makeService(plugin, clock)

    await service.tickMinutes()

    expect(specs[0]?.since).toBeUndefined()
    expect(specs[0]?.until).toBeUndefined()
    vault.close()
  })

  it("配了范围但只有 since → 只传 since", async () => {
    const clock = new ManualClock(START)
    const { plugin, specs } = makeRecordingPlugin()
    const { vault, service } = makeService(plugin, clock)
    const since = START - 7 * 86_400_000
    new DistillSourceRepository(vault.db).upsert(
      "minutes",
      { enabled: true, scope: { since } },
      START,
    )

    await service.tickMinutes()

    expect(specs[0]?.since).toBe(since)
    expect(specs[0]?.until).toBeUndefined()
    vault.close()
  })

  /**
   * ★ 读的是 **minutes** 那一行，不是 chat 那一行。
   *
   * 当前引导给两个源写的是同一对 since/until，所以这两条在生产上恰好
   * 等价 —— 那是**巧合而不是契约**。这条用例把它们**故意配成不同**，
   * 锁住"读对了哪一行"。
   */
  it("★ 只配 chat 的范围时听记不受影响（读的是 minutes 自己那一行）", async () => {
    const clock = new ManualClock(START)
    const { plugin, specs } = makeRecordingPlugin()
    const { vault, service } = makeService(plugin, clock)
    const repo = new DistillSourceRepository(vault.db)
    // chat 配了一个很窄的窗，minutes 那一行不配 scope
    repo.upsert("chat", { enabled: true, scope: { since: START - 86_400_000 } }, START)
    repo.upsert("minutes", { enabled: true, scope: {} }, START)

    await service.tickMinutes()

    // 拿 chat 的范围去卡听记会让这里变成 START - 86_400_000
    expect(specs[0]?.since).toBeUndefined()
    vault.close()
  })

  /**
   * ## ★★★ 坏 JSON 按**最严**处理（这一条的方向改过，理由在下面）
   *
   * 这条用例原来断言的是「按『没配过』处理 → 照采、不传时间窗」，
   * 理由写的是"不让手改过的库停采"。那个理由**只看到了一半代价**：
   *
   * · 停采的代价：没数据（可恢复 —— 在设置里重存一次范围就好）；
   * · 照采的代价：用户可能选的是"只学最近 30 天"，而 JSON 坏掉之后
   *   不传时间窗就把**全部历史**采回来了 —— 按 CLAUDE.md 第 5 节
   *   那是隐私事故，**不可撤回**。
   *
   * 两者不对称，所以方向必须是"最严"。而这也让两个域**一致**了：
   * chat 那侧（`readCollectionScope` → `readDomainScope`）一直是最严，
   * 只有听记这条 catch 返回 `{}` 是照采 —— 同一个"坏 JSON"在两个域上
   * 被解读成相反的方向，而那种不一致本身就是缺陷。
   *
   * ★ 停采的**静默**问题另有出路（不是靠放宽方向）：
   * `IngestService.domainScopeOrWarn` 会记一条 warn 并写清恢复办法。
   */
  it("★★ 坏 JSON 的 scope → 整轮不采（最严），而不是当成「没配过」照采", async () => {
    const clock = new ManualClock(START)
    const { plugin, specs } = makeRecordingPlugin()
    const { vault, service } = makeService(plugin, clock)
    vault.db
      .prepare(
        "INSERT INTO distill_sources (kind, enabled, scope_json, updated_at) VALUES (?, 1, ?, ?)",
      )
      .run("minutes", "{not json", START)

    await service.tickMinutes()

    /**
     * 一次渠道调用都不该发：范围读不出来时，"拉回来再说"就已经晚了
     * （拉回来的东西可能整段超出用户选的范围）。
     *
     * 反证：把 `minutesEnabled` 里的 `!scope.unreadable` 去掉 ⇒ 这一条转红。
     */
    expect(specs).toHaveLength(0)
    vault.close()
  })
})

/**
 * 定向补拉 `refreshConversation` —— 「发出去的消息两分钟才出现」的直接修法，
 * 以及常驻 agent 会话「更勤地轮询」的落点（每探针 tick 补一趟）。
 */
describe("IngestService.refreshConversation（定向补拉）", () => {
  /** 造一个带 `pullConversation` 的假插件；记录每次定向拉的 target/since。 */
  function makeDirectedPlugin(respond: (spec: ChannelConversationPullSpec) => ChannelPullPage) {
    const directed: ChannelConversationPullSpec[] = []
    const plugin = {
      meta: { id: "dingtalk" },
      ingest: {
        probe: async () => null,
        pull: async () => emptyPage(),
        pullConversation: async (spec: ChannelConversationPullSpec) => {
          directed.push(spec)
          return respond(spec)
        },
      },
    } as unknown as ChannelPlugin
    return { plugin, directed }
  }

  function seedGroup(vault: ReturnType<typeof openTestVault>) {
    new ConversationRepository(vault.db).upsert({
      id: "conv-g",
      channelId: "dingtalk",
      externalId: "cid-group-1",
      type: "group",
      title: "沙箱项目群",
      memberCount: 8,
      createdAt: START,
    })
  }

  it("群会话 → 用 openConversationId 定向拉并落库", async () => {
    const clock = new ManualClock(START)
    const { plugin, directed } = makeDirectedPlugin(() =>
      emptyPage({
        messages: [
          {
            externalId: "ext-new-1",
            conversationExternalId: "cid-group-1",
            senderExternalId: "peer",
            senderDisplayName: "小李",
            contentText: "刚发的这条要秒级可见",
            contentJson: null,
            quotedExternalId: null,
            sentAt: START + 5_000,
            mentions: [],
            hasMedia: false,
          },
        ],
        itemCount: 1,
      }),
    )
    const { vault, service } = makeService(plugin, clock)
    seedGroup(vault)

    const changed = await service.refreshConversation("cid-group-1")

    expect(changed).toBe(1)
    expect(directed).toHaveLength(1)
    expect(directed[0]?.target).toEqual({
      kind: "group",
      openConversationId: "cid-group-1",
    })
    vault.close()
  })

  it("渠道没有 pullConversation 能力 → 返回 0，不报错（退回等全局轮询）", async () => {
    const clock = new ManualClock(START)
    // makePlugin 造的 ingest 只有 probe/pull，没有 pullConversation。
    const { plugin } = makePlugin(() => emptyPage())
    const { vault, service } = makeService(plugin, clock)
    seedGroup(vault)

    await expect(service.refreshConversation("cid-group-1")).resolves.toBe(0)
    vault.close()
  })

  it("会话不在库里 → 返回 0（没什么可定向拉的）", async () => {
    const clock = new ManualClock(START)
    const { plugin, directed } = makeDirectedPlugin(() => emptyPage())
    const { vault, service } = makeService(plugin, clock)

    await expect(service.refreshConversation("cid-unknown")).resolves.toBe(0)
    expect(directed).toHaveLength(0)
    vault.close()
  })

  it("★ 常驻 agent 的会话每探针 tick 被定向补拉一次", async () => {
    const clock = new ManualClock(START)
    const { plugin, directed } = makeDirectedPlugin(() => emptyPage())
    const vault = openTestVault()
    new ConversationRepository(vault.db).upsert({
      id: "conv-g",
      channelId: "dingtalk",
      externalId: "cid-group-1",
      type: "group",
      title: "常驻群",
      memberCount: 8,
      createdAt: START,
    })
    // ★ 显式「不限会话」——不写的话范围读成"一个都不采"，常驻那一路会被闸住
    new DistillSourceRepository(vault.db).upsert("chat", { enabled: true, scope: {} }, START)
    const service = new IngestService({
      db: vault.db,
      clock,
      logger: createLogger("test-ingest", { level: "error" }),
      plugin,
      dbPath: vault.path,
      autoStart: false,
      // 常驻会话：探针 tick 应对它做定向补拉。
      residentConversationExternalIds: () => ["cid-group-1"],
    })
    service.start()

    await service.tickProbe()

    // 至少命中常驻那一个（探针本身 probe() 返回 null，不产生额外 hint）。
    expect(directed.some((d) => d.target.kind === "group")).toBe(true)
    vault.close()
  })
})

/**
 * ★★ 定向对账：补**全量窗结构性补不到**的那些落后会话。
 *
 * ## 这条用例锁的是一个实测到的真漏采
 *
 * `reconciliationWindow()` 造的是一个**全局窗**，其 `start` 被
 * `INITIAL_BACKFILL_MS`（7 天）夹住。于是"库里最新一条早于 7 天"的落后会话
 * 那个窗永远覆盖不到 —— `scripts/check-ingest-gap.mjs` 在真机上跑出 8 个落后，
 * 其中 4 个落后 235 分钟 ~ 167 天，脚本的结论正是「要靠定向补采」。
 *
 * 所以这里造一个**落后 30 天**的会话（远超 7 天夹子），断言定向那一趟
 * 真的把它的消息补进库 —— 只有全量窗时它是补不到的。
 */
describe("IngestService 定向对账（补全量窗补不到的落后会话）", () => {
  it("★ 落后 30 天的会话（超出 7 天窗夹子）能被定向补回来", async () => {
    const clock = new ManualClock(START)
    const DAY = 24 * 60 * MS_PER_MINUTE
    const oursLast = START - 30 * DAY

    const directed: string[] = []
    const plugin = {
      meta: { id: "dingtalk" },
      ingest: {
        probe: async () => null,
        // 全量窗那一趟什么都不返回：证明补回来的是**定向**那一趟的功劳。
        pull: async () => emptyPage(),
        pullConversation: async (spec: {
          target: { kind: "group"; openConversationId: string } | { kind: "direct" }
          since: number
        }) => {
          if (spec.target.kind !== "group") return emptyPage()
          directed.push(spec.target.openConversationId)
          return emptyPage({
            messages: [
              {
                externalId: "recovered-1",
                conversationExternalId: spec.target.openConversationId,
                senderExternalId: "peer",
                senderDisplayName: "小李",
                contentText: "这条被定向补回来了",
                contentJson: null,
                quotedExternalId: null,
                sentAt: oursLast + 1_000,
                mentions: [],
                hasMedia: false,
              },
            ],
            itemCount: 1,
          })
        },
      },
    } as unknown as ChannelPlugin

    const { vault, service } = makeService(plugin, clock)
    new ConversationRepository(vault.db).upsert({
      id: "conv-behind",
      channelId: "dingtalk",
      externalId: "cid-behind",
      type: "group",
      title: "落后很久的群",
      memberCount: 20,
      createdAt: oursLast,
    })
    // 探针说它 1 分钟前还有新消息，而我们库里最新是 30 天前 → 落后。
    vault.db
      .prepare(
        `INSERT INTO probe_snapshots
           (channel_id, conversation_external_id, last_msg_at, unread_count, observed_at)
         VALUES ('dingtalk', 'cid-behind', ?, 3, ?)`,
      )
      .run(START - MS_PER_MINUTE, START)

    const before = countMessages(vault.db)
    // 走完整的一轮 L2（内部会跑对账 → 再跑定向对账）。
    await service.tickPull()

    expect(directed).toContain("cid-behind")
    expect(countMessages(vault.db)).toBeGreaterThan(before)
    vault.close()
  })
})

function countMessages(db: ReturnType<typeof openTestVault>["db"]): number {
  return db.prepare<[], { c: number }>("SELECT count(*) AS c FROM messages").get()?.c ?? 0
}
