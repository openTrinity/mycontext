/**
 * FeedService 的图谱同步接线。
 *
 * ## 为什么这一层要单独测
 *
 * `GraphSyncService` 的调度语义由 `graph-sync.test.ts` 覆盖（纯逻辑）。
 * 这个文件测的是**服务层怎么把它接起来**——而接线的错误方式恰好都很安静：
 *
 * · `autoStart: false` 时不该起定时器（否则单测会在后台真写盘）；
 * · `detach()` 必须停定时器**并等在途那一轮收尾** ——
 *   不等的话导出中途库被关掉，会往已关闭的连接上读
 *   （与采集侧 logout 竞态是同一类问题，实测报
 *   `The database connection is not open` 且无人 catch）；
 * · 手动 `export()` 与自动同步必须落到**同一个目录** ——
 *   两份不一致的 bundle 会让"ingest 用的是哪份"完全不可知。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import { ChangelogRepository, ConsumerCursorRepository } from "@mycontext/store"
import { GRAPH_SYNC_CONSUMER_ID } from "@mycontext/knowledge-feed"
import { FeedService } from "@main/services/feed.service.js"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000
const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-feed-"))
  dirs.push(dir)
  return dir
}

/**
 * 这个 vault 的导出落点。★ 按 vault 分 —— 导出物是聊天正文的投影，
 * 而 handoff 里带着它们的绝对路径（见 `FeedDirs`）。
 *
 * 测试里直接拿 `sharedRoot` 当 vault 根：本组测的是同步逻辑，
 * 而"路径按 vault 分"由 `vault-paths` 那组锁。
 */
function feedDirs(root: string) {
  return {
    dataRoot: root,
    exportRoot: join(root, "exports", "dws"),
    klRoot: join(root, "kl"),
    handoffFile: join(root, "handoff.json"),
  }
}

function makeFeed(sharedRoot: string) {
  const dirs = feedDirs(sharedRoot)
  const feed = new FeedService({
    clock: new ManualClock(START),
    logger: createLogger("test-feed", { level: "error" }),
    embedding: () => ({ baseUrl: "http://127.0.0.1:1/v1", model: "m", dim: 2048 }),
    localEmbedding: { model: "m", dim: 1024 },
    llm: () => ({ baseUrl: "http://127.0.0.1:1", model: "qwen" }),
    // 不起定时器：本测试手动 tick，否则后台会真的写盘
    autoStart: false,
  })
  // ★ 落点与 feed 一起给出：调用方 attach 时要传（按 vault，见 FeedDirs）
  return Object.assign(feed, { testDirs: dirs })
}

/** 往 Outbox 写 n 条变更（让同步有活干）。 */
function appendChanges(vault: TestVault, n: number): number {
  const changelog = new ChangelogRepository(vault.db)
  changelog.append(
    Array.from({ length: n }, (_, index) => ({
      op: "upsert" as const,
      entityType: "message" as const,
      entityId: `msg-${index}`,
      channelId: "dingtalk",
      domain: "chat" as const,
      occurredAt: START + index,
      emittedAt: START + index,
      digest: `d${index}`,
    })),
  )
  return changelog.head()
}

describe("★ 图谱同步的接线", () => {
  it("attach 后注册了消费者（保留策略与状态页都靠它）", async () => {
    const vault = openTestVault()
    const feed = makeFeed(tempDir())
    try {
      await feed.attach(vault.db, feed.testDirs)
      const cursor = new ConsumerCursorRepository(vault.db, new ManualClock(START)).get(
        GRAPH_SYNC_CONSUMER_ID,
      )
      expect(cursor).not.toBeNull()
      // 外部消费者：落后不该阻止我们裁剪 raw_records
      expect(cursor?.required).toBe(false)
    } finally {
      await feed.detach()
      vault.close()
    }
  })

  it("autoStart:false 时不自动导出（单测不该在后台写盘）", async () => {
    const vault = openTestVault()
    const shared = tempDir()
    const feed = makeFeed(shared)
    try {
      appendChanges(vault, 3)
      await feed.attach(vault.db, feed.testDirs)
      // 没手动 tick → 导出目录不该出现
      expect(existsSync(join(shared, "exports", "dws", "chat", "records.jsonl"))).toBe(false)
    } finally {
      await feed.detach()
      vault.close()
    }
  })

  it("手动 tick 后真的写出四件套，且游标推进", async () => {
    const vault = openTestVault()
    const shared = tempDir()
    const feed = makeFeed(shared)
    try {
      const head = appendChanges(vault, 3)
      await feed.attach(vault.db, feed.testDirs)
      await feed.tickGraphSync()

      // 空库也会写出四件套（对方 loader 读到 0 条会 no-op，不报错）
      expect(existsSync(join(shared, "exports", "dws", "chat", "records.jsonl"))).toBe(true)
      expect(existsSync(join(shared, "exports", "dws", "minutes", "manifest.json"))).toBe(true)

      const cursor = new ConsumerCursorRepository(vault.db, new ManualClock(START)).get(
        GRAPH_SYNC_CONSUMER_ID,
      )
      expect(cursor?.ackedSeq).toBe(head)
      expect(feed.graphLag()).toBe(0)
    } finally {
      await feed.detach()
      vault.close()
    }
  })

  it("★ 手动 export() 与自动同步落到同一个目录（不能有两份 bundle）", async () => {
    const vault = openTestVault()
    const shared = tempDir()
    const feed = makeFeed(shared)
    try {
      await feed.attach(vault.db, feed.testDirs)
      const manual = feed.export()
      expect(manual.exportDir).toBe(join(shared, "exports", "dws"))

      appendChanges(vault, 2)
      await feed.tickGraphSync()
      // 自动那一轮写的是同一个目录（不是另建一份）
      expect(existsSync(join(manual.exportDir, "chat", "records.jsonl"))).toBe(true)
    } finally {
      await feed.detach()
      vault.close()
    }
  })

  it("export() 报出 source 数与两类条数（不再是没意义的文件数）", async () => {
    const vault = openTestVault()
    const feed = makeFeed(tempDir())
    try {
      await feed.attach(vault.db, feed.testDirs)
      const result = feed.export()
      // chat + minutes + wiki（文档接上之后是三个 source 目录）
      expect(result.sourceCount).toBe(3)
      expect(result.totalMessages).toBe(0)
      expect(result.totalMinutes).toBe(0)
    } finally {
      await feed.detach()
      vault.close()
    }
  })

  it("未挂载时 export() 返回空而不是抛错（状态页在登录前也会渲染）", () => {
    const feed = makeFeed(tempDir())
    const result = feed.export()
    expect(result.sourceCount).toBe(0)
    expect(result.exportDir).toBe("")
  })

  it("detach 后再 tick 不做事（不往已关闭的库上读）", async () => {
    const vault = openTestVault()
    const shared = tempDir()
    const feed = makeFeed(shared)
    appendChanges(vault, 2)
    await feed.attach(vault.db, feed.testDirs)
    await feed.detach()
    vault.close()

    // 库已关；这一轮必须直接返回而不是去读它
    await expect(feed.tickGraphSync()).resolves.toBeUndefined()
    expect(feed.graphLag()).toBe(0)
  })

  it("attach 幂等（重复挂载不留下两个定时器/两个同步器）", async () => {
    const vault = openTestVault()
    const feed = makeFeed(tempDir())
    try {
      await feed.attach(vault.db, feed.testDirs)
      await feed.attach(vault.db, feed.testDirs)
      const cursors = new ConsumerCursorRepository(vault.db, new ManualClock(START))
        .list()
        .filter((c) => c.consumerId === GRAPH_SYNC_CONSUMER_ID)
      expect(cursors).toHaveLength(1)
    } finally {
      await feed.detach()
      vault.close()
    }
  })
})

/**
 * 与 `makeFeed` 相同，只是**不关**定时器 —— 本组要数的正是那两枚。
 *
 * ★ 配合 `vi.useFakeTimers()`（见下面的 beforeEach）：真定时器会让
 * 10 分钟那枚在测试结束后仍挂着，而假定时器只是登记、不真的跑。
 */
function makeFeedAutoStart(sharedRoot: string) {
  const dirs = feedDirs(sharedRoot)
  const feed = new FeedService({
    clock: new ManualClock(START),
    logger: createLogger("test-feed", { level: "error" }),
    embedding: () => ({ baseUrl: "http://127.0.0.1:1/v1", model: "m", dim: 2048 }),
    localEmbedding: { model: "m", dim: 1024 },
    llm: () => ({ baseUrl: "http://127.0.0.1:1", model: "qwen" }),
  })
  return Object.assign(feed, { testDirs: dirs })
}

describe("★★ 挂载后的补跑（首轮必然白跑）", () => {
  // ★ 假定时器：只登记不真跑，于是能数、也不会漏到别的用例里
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * ★★★ 这一组锁的是一个**时序**问题，而它的表现是"重启后十分钟没有图"。
   *
   * ## 实测
   *
   * ```
   * 00:20:11  挂载 → 立刻跑一轮
   *           那一刻 head === ackedSeq（上次退出前已 ack）→ lag 0 → 白跑
   * 00:20:14  采集写第一条（seq 28820）        ← 比那一轮晚 3 秒
   * 00:24:59  head 已到 29937（lag 1118）      ← 但真正的下一轮要等 00:30:11
   * ```
   *
   * 也就是"挂载时先跑一轮"这个好意**跑早了 3 秒**：采集还没写入它就问完了，
   * 于是第一次真正的同步要等满一个周期（10 分钟），首次建图跟着推迟 ——
   * 而用户刚启动应用、正盯着界面。
   *
   * ★ 断言的形态：`autoStart:false` 时**两个定时器都不许起**
   *（单测不该在后台真写盘），而 `autoStart` 开着时补跑那一枚要存在且
   * 在 detach 时被清掉 —— 后者是真实风险：它会 `tickGraphSync()` 而那要查库，
   * 而 detach 之后调用方马上关库。
   */
  it("★★ autoStart:false → 补跑定时器也不起（不在后台写盘）", async () => {
    const shared = tempDir()
    const vault = openTestVault()
    try {
      const feed = makeFeed(shared)
      await feed.attach(vault.db, feed.testDirs)
      /**
       * ★ 判据用"进程里没有待触发的 timer"而不是私有字段：
       * `vitest` 的 fake timer 能数出来，而读私有字段等于把实现细节写进断言。
       */
      expect(vi.getTimerCount()).toBe(0)
      await feed.detach()
    } finally {
      vault.close()
    }
  })

  /**
   * ★★★ 开着 autoStart 时：周期 + 补跑**两枚**定时器。
   *
   * 只有一枚的话就是修复前的行为 —— 首轮白跑之后要等满一个周期。
   */
  it("★★★ autoStart 开着 → 周期与补跑两枚定时器都在", async () => {
    const shared = tempDir()
    const vault = openTestVault()
    try {
      const feed = makeFeedAutoStart(shared)
      await feed.attach(vault.db, feed.testDirs)
      expect(vi.getTimerCount()).toBe(2)
      await feed.detach()
    } finally {
      vault.close()
    }
  })

  /**
   * ★★ detach 要把**两枚都**清掉。
   *
   * 漏清补跑那枚的表现：登出/切身份之后 90 秒内冒出一次
   * `tickGraphSync()` → 查一个已经关掉的库 → 无人 catch 的
   * `The database connection is not open`（与 `pushTimer` 踩过的是同一个坑）。
   */
  it("★★ detach 之后一枚定时器都不留", async () => {
    const shared = tempDir()
    const vault = openTestVault()
    try {
      const feed = makeFeedAutoStart(shared)
      await feed.attach(vault.db, feed.testDirs)
      await feed.detach()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vault.close()
    }
  })
})
