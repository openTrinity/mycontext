/**
 * 图谱概览的门禁。
 *
 * ## ★ 这一组锁的是"空 / 半成品 / 完整"三态怎么说话
 *
 * 我们在这条链路上踩过的坑正是这个：`shared/kl/knowledge.db` schema 完全
 * 正确、`/health` 一直回 `ok`，而**每张表都是 0 行** —— 因为 `kl ingest`
 * 从没成功跑过（默认只导出、不触发；后来触发了又被孤儿 server 的
 * `Broken pipe` 打死）。
 *
 * 那个失效的形态是：一个**干净的空页**。用户看到"0 个实体"会理解成
 * "我的聊天里就是没什么可抽的"，而真相是这条链路从没跑通。
 * 所以三态必须说不同的话，且每一句都要**可行动**。
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, vi } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { KlServerService } from "@main/services/kl-server.service.js"
import type { GraphDbHandle } from "@main/services/kl-server.service.js"

const logger = createLogger("test", { level: "error" })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
  vi.restoreAllMocks()
})

/**
 * 造一个含 `knowledge.db` **文件**的 dataDir。
 *
 * 文件必须真的存在：`graphOverview` 的第一道判断是 `existsSync` ——
 * 那条路径（"还没建过图"）与"文件在但库是空的"是两个不同的提示。
 */
function dataDirWithDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-graph-"))
  dirs.push(dir)
  writeFileSync(join(dir, "knowledge.db"), "")
  return dir
}

function fakeDb(over: Partial<Record<string, number>> = {}, extra: Partial<GraphDbHandle> = {}) {
  const counts: Record<string, number> = {
    entities: 0,
    facts: 0,
    edges: 0,
    chunks: 0,
    messages: 0,
    ...over,
  }
  const handle: GraphDbHandle = {
    count: (table) => counts[table] ?? 0,
    groupBy: () => [],
    topEntities: () => [],
    recentFacts: () => [],
    close: () => {},
    ...extra,
  }
  return handle
}

function makeService(options: { dataDir: string; db?: GraphDbHandle }) {
  return new KlServerService({
    clock: new ManualClock(1_000),
    logger,
    processes: {} as never,
    klRoot: "/fake/kl-graph",
    dataDir: options.dataDir,
    getWindow: () => null,
    probeExisting: async () => false,
    probeHealth: async () => true,
    ...(options.db === undefined ? {} : { openGraphDb: () => options.db as GraphDbHandle }),
  })
}

describe("★ 图谱概览：空 / 半成品 / 完整必须说不同的话", () => {
  /**
   * 文件不存在 = 从没建过。这句要**指出下一步动作**，
   * 并预告代价（几分钟 + 出网）—— 否则用户点下去等半天不知道在等什么。
   */
  it("没有 knowledge.db → 说「还没建过图」并给出下一步", () => {
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-nodb-"))
    dirs.push(dir)
    const view = makeService({ dataDir: dir }).graphOverview()
    expect(view.available).toBe(false)
    expect(view.reason).toContain("还没建过图")
    expect(view.reason).toContain("重新建图")
    expect(view.entities).toBe(0)
  })

  /**
   * ★ 这是最重要的一条：文件在、schema 对、但全是 0 行。
   *
   * 那正是我们真实卡住的状态。它**绝不能**显示成一个干净的空页 ——
   * 必须明说"建图没有成功跑过"，否则那句 0 会被理解成
   * "我的数据里没什么可抽的"，而这条链路的真实故障就永远查不出来。
   */
  it("库存在但全 0 → 明说「建图没有成功跑过」，不是干净的空页", () => {
    const view = makeService({ dataDir: dataDirWithDb(), db: fakeDb() }).graphOverview()
    expect(view.available).toBe(false)
    expect(view.reason).toContain("没有成功跑过")
    // 且要预告代价，让人知道点下去要等
    expect(view.reason).toContain("出网")
  })

  /**
   * 半成品之一：抽取跑完了（有 facts）但实体没建。
   *
   * 与"全 0"分开是有用的：它说明 LLM 抽取那一段是通的（钱已经花了），
   * 卡在建图阶段 —— 那两种情况要查的地方完全不同。
   */
  it("有 facts 没 entities → 说「抽取已完成，建图阶段未完成」", () => {
    const view = makeService({
      dataDir: dataDirWithDb(),
      db: fakeDb({ facts: 6603 }),
    }).graphOverview()
    expect(view.reason).toContain("抽取已完成")
    // ★ available 为 true：确实有内容可看（6603 条事实），
    // 只是图还不完整。这里若判 false，用户会看不到已经抽出来的东西。
    expect(view.available).toBe(true)
    expect(view.facts).toBe(6603)
  })

  /**
   * 半成品之二：实体与事实都有，边还没建。
   *
   * 这是真实观测到的中间态（entities=2170 facts=6603 edges=0）——
   * fact 向量化跑完才建边。此时页面**应当可用**：分布图与枢纽都能看，
   * 只有"顺关系走"还不行。
   */
  it("有 entities/facts 没 edges → 说「关系边还没建」但页面可用", () => {
    const view = makeService({
      dataDir: dataDirWithDb(),
      db: fakeDb({ entities: 2170, facts: 6603 }),
    }).graphOverview()
    expect(view.available).toBe(true)
    expect(view.reason).toContain("关系边还没建")
    expect(view.entities).toBe(2170)
  })

  /** 完整图 → 没有任何提示语。有提示就等于说"还有问题"。 */
  it("完整图 → reason 为 null（不留一句多余的话）", () => {
    const view = makeService({
      dataDir: dataDirWithDb(),
      db: fakeDb({ entities: 2170, facts: 6603, edges: 8800, chunks: 10475, messages: 10385 }),
    }).graphOverview()
    expect(view.available).toBe(true)
    expect(view.reason).toBeNull()
    expect(view.edges).toBe(8800)
    expect(view.chunks).toBe(10475)
  })
})

describe("图谱概览：单张表坏了不该让整页白掉", () => {
  /**
   * ★ 某张表不存在时给 0/[]，而不是抛。
   *
   * kl 的 schema 会演进（`community_summaries` 就是后加的，server 自己
   * 也在 graceful degrade）。一张表缺失让整个概览抛异常的话，
   * 用户看到的是一个空白页 + 一句 IPC 报错 —— 而其余 4 张表本来是好的。
   */
  it("某张表查询抛错 → 该项为 0，其余照常", () => {
    const db = fakeDb(
      { entities: 2170, facts: 6603 },
      {
        count: (table) => {
          if (table === "edges") throw new Error("no such table: edges")
          return { entities: 2170, facts: 6603, chunks: 10475, messages: 10385 }[table] ?? 0
        },
      },
    )
    const view = makeService({ dataDir: dataDirWithDb(), db }).graphOverview()
    expect(view.edges).toBe(0)
    expect(view.entities).toBe(2170)
    expect(view.chunks).toBe(10475)
  })

  it("分布查询抛错 → 空数组，不影响计数", () => {
    const db = fakeDb(
      { entities: 2170, facts: 6603 },
      {
        groupBy: () => {
          throw new Error("no such column")
        },
      },
    )
    const view = makeService({ dataDir: dataDirWithDb(), db }).graphOverview()
    expect(view.entityTypes).toEqual([])
    expect(view.entities).toBe(2170)
  })

  /**
   * ★ 打开库本身失败（文件损坏 / 被独占）→ 空视图 + 原因，不抛。
   *
   * 建图会**热切换**这个文件，切换的瞬间打开可能失败。抛出去的话
   * 那一瞬间的轮询会让页面报错闪一下 —— 而下一次轮询它就好了。
   */
  it("打开库失败 → 空视图带原因，不抛", () => {
    const svc = new KlServerService({
      clock: new ManualClock(1_000),
      logger,
      processes: {} as never,
      klRoot: "/fake/kl-graph",
      dataDir: dataDirWithDb(),
      getWindow: () => null,
      probeExisting: async () => false,
      probeHealth: async () => true,
      openGraphDb: () => {
        throw new Error("database disk image is malformed")
      },
    })
    const view = svc.graphOverview()
    expect(view.available).toBe(false)
    expect(view.reason).toContain("malformed")
    expect(view.entities).toBe(0)
  })

  /**
   * ★ 连接必须关掉。
   *
   * 长持只读连接会在建图热切换后读到**旧快照** —— 表现是"建完图了但
   * 概览还是 0"，而那与"真的没建成"完全无法区分。所以每次开/关。
   */
  it("每次调用都关连接（否则热切换后读到旧快照）", () => {
    let closed = 0
    const db = fakeDb({ entities: 1 }, { close: () => (closed += 1) })
    const svc = makeService({ dataDir: dataDirWithDb(), db })
    svc.graphOverview()
    svc.graphOverview()
    expect(closed).toBe(2)
  })
})

/**
 * ★★ 这一组锁的是那个把应用彻底堵死的**互递归**。
 *
 * ## 事故形态（必须记住，因为它一个错都不报）
 *
 * `autoBuild.graphExists` 曾经写成 `klServer.graphOverview().available`，
 * 而 `graphOverview()` 会调 `buildSchedule()` → `feed.graphBuildSchedule()`
 * → 回头调 `autoBuild.graphExists()` —— 环闭合。更糟的是
 * `graphOverview()` 的 **catch 分支自己也在环上**（`empty()` 里又调一次
 * `buildSchedule()`），于是撞栈之后不是抛出去，而是
 * 「warn 一条 → 重新进环 → 再撞」。
 *
 * 实测后果：一次调用打出 **10,212,769 条**同样的
 * `read graph overview failed / Maximum call stack size exceeded`，
 * 3 小时 21 分写掉 **1.7 GB** 日志（~15000 行/秒），主进程事件循环
 * 一个 tick 都不再走 —— 用户看到的是"应用启动不起来"。
 *
 * 触发点在启动路径上（`FeedService.attach()` 的"挂载时先跑一轮"），
 * 所以它不是某个页面的问题，是开机就死。
 *
 * ## 为什么锁在这一层
 *
 * 那次 tsc **报过**这个循环（TS7022/7023），而当时的修法是给
 * `buildSchedule` 加显式返回类型 —— 类型告警消失，运行时的环留在原地。
 * 也就是说类型检查在这件事上不是门禁。所以必须有真实调用的断言。
 */
describe("★★ 概览 / 调度 互递归不许再回来", () => {
  /**
   * `graphExists()` 是给主进程内部判断用的轻量入口。它**绝不能**碰
   * `buildSchedule` —— 那正是环的另一半。
   */
  it("graphExists() 不调 buildSchedule（环在这里断开）", () => {
    let scheduleCalls = 0
    const svc = new KlServerService({
      clock: new ManualClock(1_000),
      logger,
      processes: {} as never,
      klRoot: "/fake/kl-graph",
      dataDir: dataDirWithDb(),
      getWindow: () => null,
      probeExisting: async () => false,
      probeHealth: async () => true,
      openGraphDb: () => fakeDb({ entities: 3, facts: 5 }),
      buildSchedule: () => {
        scheduleCalls += 1
        return null
      },
    })
    expect(svc.graphExists()).toBe(true)
    expect(scheduleCalls).toBe(0)
  })

  /**
   * ★ 判据必须与 `graphOverview().available` 同源（`entities>0 || facts>0`）。
   *
   * 漂移的后果是"界面说图是空的、而自动建图认为图已存在" ——
   * 那种矛盾没有任何地方能发现，而它会让自动建图永远不触发首次建图。
   */
  it("graphExists() 与 graphOverview().available 同源", () => {
    const cases = [
      { counts: {}, expected: false },
      { counts: { entities: 1 }, expected: true },
      // 只有 facts（抽取完了但实体阶段没完）也算"图里有东西"
      { counts: { facts: 1 }, expected: true },
    ]
    for (const c of cases) {
      const dir = dataDirWithDb()
      const svc = makeService({ dataDir: dir, db: fakeDb(c.counts) })
      expect(svc.graphExists()).toBe(c.expected)
      expect(svc.graphOverview().available).toBe(c.expected)
    }
  })

  /** 没有 knowledge.db → false，且不该去开连接。 */
  it("没有 knowledge.db → graphExists() 为 false 且不开连接", () => {
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-exists-nodb-"))
    dirs.push(dir)
    let opened = 0
    const svc = new KlServerService({
      clock: new ManualClock(1_000),
      logger,
      processes: {} as never,
      klRoot: "/fake/kl-graph",
      dataDir: dir,
      getWindow: () => null,
      probeExisting: async () => false,
      probeHealth: async () => true,
      openGraphDb: () => {
        opened += 1
        return fakeDb({ entities: 9 })
      },
    })
    expect(svc.graphExists()).toBe(false)
    expect(opened).toBe(0)
  })

  /** 读不出来（热切换瞬间 / 文件坏）→ 当成"没有图"，不抛。 */
  it("graphExists() 打开失败 → false 而不是抛", () => {
    const svc = new KlServerService({
      clock: new ManualClock(1_000),
      logger,
      processes: {} as never,
      klRoot: "/fake/kl-graph",
      dataDir: dataDirWithDb(),
      getWindow: () => null,
      probeExisting: async () => false,
      probeHealth: async () => true,
      openGraphDb: () => {
        throw new Error("database disk image is malformed")
      },
    })
    expect(svc.graphExists()).toBe(false)
  })

  /** `graphExists()` 也要关连接：它 10 分钟被调一次，泄一个就是长期泄。 */
  it("graphExists() 关连接", () => {
    let closed = 0
    const db = fakeDb({ entities: 1 }, { close: () => (closed += 1) })
    const svc = makeService({ dataDir: dataDirWithDb(), db })
    svc.graphExists()
    svc.graphExists()
    expect(closed).toBe(2)
  })

  /**
   * ★★ `buildSchedule` 在一次 `graphOverview()` 里**只取一次**。
   *
   * 从前成功分支与 `empty()` 各取一次，于是**错误路径自己也在环上** ——
   * 那正是"撞栈后还能再打 1000 万条 warn"的原因：catch 里那次调用
   * 会重新走一遍整条链路。
   */
  it("成功路径：buildSchedule 只取一次", () => {
    let calls = 0
    const svc = new KlServerService({
      clock: new ManualClock(1_000),
      logger,
      processes: {} as never,
      klRoot: "/fake/kl-graph",
      dataDir: dataDirWithDb(),
      getWindow: () => null,
      probeExisting: async () => false,
      probeHealth: async () => true,
      openGraphDb: () => fakeDb({ entities: 2, facts: 2 }),
      buildSchedule: () => {
        calls += 1
        return null
      },
    })
    svc.graphOverview()
    expect(calls).toBe(1)
  })

  /** 失败路径同样只取一次 —— catch 里不许再有任何可能重入的调用。 */
  it("失败路径：buildSchedule 也只取一次（catch 不许重入）", () => {
    let calls = 0
    const svc = new KlServerService({
      clock: new ManualClock(1_000),
      logger,
      processes: {} as never,
      klRoot: "/fake/kl-graph",
      dataDir: dataDirWithDb(),
      getWindow: () => null,
      probeExisting: async () => false,
      probeHealth: async () => true,
      openGraphDb: () => {
        throw new Error("database disk image is malformed")
      },
      buildSchedule: () => {
        calls += 1
        return null
      },
    })
    const view = svc.graphOverview()
    expect(view.available).toBe(false)
    expect(calls).toBe(1)
  })

  /**
   * ★ `buildSchedule` 自己抛 → 概览照常渲染，那一块为 null。
   *
   * 它是注入的（游标表那一侧），它坏了不该让整页变成"读图谱失败" ——
   * 那句话会把人引向 kl 与图库，而真正坏的在水位那边。
   */
  it("buildSchedule 抛错 → 概览照常返回，schedule 为 null", () => {
    const svc = new KlServerService({
      clock: new ManualClock(1_000),
      logger,
      processes: {} as never,
      klRoot: "/fake/kl-graph",
      dataDir: dataDirWithDb(),
      getWindow: () => null,
      probeExisting: async () => false,
      probeHealth: async () => true,
      openGraphDb: () => fakeDb({ entities: 4, facts: 4, edges: 4 }),
      buildSchedule: () => {
        throw new Error("cursor table missing")
      },
    })
    const view = svc.graphOverview()
    expect(view.available).toBe(true)
    expect(view.entities).toBe(4)
    expect(view.buildSchedule).toBeNull()
    // 不能把水位那边的错说成"读图谱失败"
    expect(view.reason).toBeNull()
  })

  /**
   * ★★ 端到端锁死那个环：把 `graphExists` 装成"经 buildSchedule 回来"的形状
   * （也就是事故当时的装配），断言它**不会**无限递归。
   *
   * 这一条是本组的核心 —— 上面几条锁的是各自的局部性质，
   * 而真正让应用死掉的是这两条边接在一起。
   */
  it("按事故当时的装配接线 → 不再无限递归", () => {
    let graphExistsCalls = 0
    let scheduleCalls = 0
    // eslint-disable-next-line prefer-const -- 环形装配：schedule 里要引用 svc
    let svc: KlServerService
    const feedGraphBuildSchedule = (): null => {
      scheduleCalls += 1
      // 事故当时 forecastAutoBuild 就是这样拿 graphExists 的
      graphExistsCalls += 1
      svc.graphExists()
      return null
    }
    svc = new KlServerService({
      clock: new ManualClock(1_000),
      logger,
      processes: {} as never,
      klRoot: "/fake/kl-graph",
      dataDir: dataDirWithDb(),
      getWindow: () => null,
      probeExisting: async () => false,
      probeHealth: async () => true,
      openGraphDb: () => fakeDb({ entities: 7, facts: 7 }),
      buildSchedule: feedGraphBuildSchedule,
    })

    const view = svc.graphOverview()
    expect(view.entities).toBe(7)
    // 环断开的判据：各自只被调了一次，没有指数/无限展开
    expect(scheduleCalls).toBe(1)
    expect(graphExistsCalls).toBe(1)
  })
})
