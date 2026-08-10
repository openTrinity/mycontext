/**
 * 事实检索的过滤逻辑。
 *
 * ## ★ 这里锁两类会真正伤到用户的行为
 *
 * 1. **FTS 语法注入**。`facts_fts` 是 fts5，`MATCH` 吃的是**查询语法**
 *    而不是纯文本 —— 用户输入里的 `"` / `*` / `NEAR(` 都有语法含义。
 *    实测原样传会抛（`unterminated string` / `fts5: syntax error` /
 *    `unknown special query`），而抛出的表现是**整个面板降级**，
 *    用户只看到"读图谱失败"。而这些字符是随手就会打出来的。
 *
 * 2. **「一条都没有」与「筛掉了」必须分开**。图里有 6663 条事实；
 *    用户筛完看到空列表时要知道是"我筛太窄"还是"图本来是空的" ——
 *    两者的下一步完全不同（放宽条件 vs 去建图）。
 *
 * 用注入的假图库（`GraphReadHandle`）：真实现要原生模块 + 真图库文件，
 * 而这两类都是纯逻辑。真图库上的接线由 `tests/externals/` 那条验。
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Logger } from "@mycontext/kernel"
import { GraphQueryService, type GraphReadHandle } from "@main/services/graph-query.service"

/** `entitiesByName`/`allEntities` 返回的行，测试里只用到 id/name。 */
type EntityRow = ReturnType<GraphReadHandle["entitiesByName"]>[number]

const NOW = new Date(2026, 6, 31, 12, 0, 0).getTime()

/**
 * 造一个**含 knowledge.db 文件**的 dataDir。
 *
 * 文件必须真的存在：`facts()` / `ego()` 的第一道判断是 `existsSync` ——
 * 那条路径（"还没建过图"）与"库在但结果为空"是两个不同的提示，
 * 而用 `"."` 当 dataDir 会让每个用例都走进前者（踩过一次：
 * capture 全是 undefined，看起来像"参数没透下去"）。
 */
function dataDirWithDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-graph-q-"))
  writeFileSync(join(dir, "knowledge.db"), "")
  return dir
}
const MS_PER_DAY = 86_400_000

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
}

/** 记录 `searchFacts` 收到的入参，并按需返回行。 */
function fakeDb(
  rows: number,
  capture: { query?: Parameters<GraphReadHandle["searchFacts"]>[0] },
  /** 按实体筛的真实关联（`factIdsForEntity` 先 entitiesByName 再问 kl）用得到 */
  entities: EntityRow[] = [],
) {
  const handle: GraphReadHandle = {
    entitiesByName: (names) => entities.filter((e) => names.includes(e.name)),
    allEntities: () => entities,
    factLinksAround: () => [],
    factConversations: () => [],
    entitiesByIds: () => [],
    searchFacts: (query) => {
      capture.query = query
      return {
        total: rows,
        rows: Array.from({ length: Math.min(rows, query.limit) }, (_, i) => ({
          id: `f${String(i)}`,
          text: `事实 ${String(i)}`,
          type: "STATUS",
          confidence: 0.9,
          at: NOW,
          entities: ["小吴"],
        })),
      }
    },
    close: () => undefined,
  }
  return handle
}

function makeService(
  rows: number,
  capture: { query?: unknown } = {},
  extra: {
    entities?: EntityRow[]
    factsOfEntity?: (entityId: string) => Promise<ReadonlySet<string>>
  } = {},
) {
  return new GraphQueryService({
    logger: noopLogger,
    dataDir: () => dataDirWithDb(),
    now: () => NOW,
    getSelfNames: () => ["小周"],
    getChannelByConversation: () => new Map(),
    openDb: () => fakeDb(rows, capture as { query?: never }, extra.entities ?? []),
    ...(extra.factsOfEntity === undefined ? {} : { factsOfEntity: extra.factsOfEntity }),
  })
}

const BASE = { days: null, types: [], entityName: null, keyword: "", limit: 20, offset: 0 }

describe("★ 时间范围换算成时间戳下界", () => {
  it("days 给了 → since = now - days（不是天数原样传下去）", async () => {
    const capture: { query?: { since: number | null } } = {}
    await makeService(3, capture).facts({ ...BASE, days: 7 })
    expect(capture.query?.since).toBe(NOW - 7 * MS_PER_DAY)
  })

  it("days 为 null → since 也是 null（「全部」不该被算成 0 时刻）", async () => {
    const capture: { query?: { since: number | null } } = {}
    await makeService(3, capture).facts({ ...BASE, days: null })
    expect(capture.query?.since).toBeNull()
  })
})

describe("★ 过滤条件原样透到查询层", () => {
  it("类型多选、实体、关键词、分页都传下去", async () => {
    const capture: { query?: Record<string, unknown> } = {}
    await makeService(3, capture).facts({
      days: 30,
      types: ["DECISION", "DELEGATE"],
      entityName: "小吴",
      keyword: "沙箱",
      limit: 10,
      offset: 20,
    })
    expect(capture.query?.["types"]).toEqual(["DECISION", "DELEGATE"])
    expect(capture.query?.["entityName"]).toBe("小吴")
    expect(capture.query?.["keyword"]).toBe("沙箱")
    expect(capture.query?.["limit"]).toBe(10)
    expect(capture.query?.["offset"]).toBe(20)
  })
})

/**
 * ★★★ 按实体筛：走 kl 的真实关联，而不是正文匹配。
 *
 * 这一组锁的是一次真实的 bug（点「紫蓝」→ 事实 0 条，而那人明明有 60 条
 * 关联）。双重根因里的关系那一半：`edges` 表恒空、facts 没有实体外键，
 * 所以唯一真实的 fact↔entity 关系只能问 kl `/facts`。原来用 `text LIKE`
 * 近似，会漏（紫蓝真实 60、正文 35），名字有更全写法时漏更多。
 */
describe("★★★ 按实体筛走 kl 真实关联（不是正文匹配）", () => {
  const ZILAN: EntityRow = { id: "e-zilan", name: "紫蓝", type: "PERSON", mentions: 74 }

  it("★★★ 有 factsOfEntity → 传的是 fact id 交集，不是 text LIKE", async () => {
    const capture: { query?: Record<string, unknown> } = {}
    const service = makeService(3, capture, {
      entities: [ZILAN],
      factsOfEntity: () => Promise.resolve(new Set(["fa", "fb", "fc"])),
    })
    await service.facts({ ...BASE, entityName: "紫蓝" })
    // 反面：不能退回正文匹配（那是 bug 的来源）
    expect(capture.query?.["factIds"]).toEqual(["fa", "fb", "fc"])
  })

  it("★★ 同名多实体（抽取出两条同名 id）→ 两个 id 的 fact 并起来", async () => {
    // 图里同名实体可能不止一条（抽取/合并的产物）。entitiesByName 精确名命中
    // 返回多行时，每条都要问一遍再并起来，否则会漏。
    const dupA: EntityRow = { id: "e-a", name: "紫蓝", type: "PERSON", mentions: 40 }
    const dupB: EntityRow = { id: "e-b", name: "紫蓝", type: "PERSON", mentions: 34 }
    const capture: { query?: Record<string, unknown> } = {}
    const service = makeService(3, capture, {
      entities: [dupA, dupB],
      factsOfEntity: (id) =>
        Promise.resolve(id === "e-a" ? new Set(["fa", "fb"]) : new Set(["fb", "fc"])),
    })
    await service.facts({ ...BASE, entityName: "紫蓝" })
    // 只查一个 id 会漏掉只挂在第二条上的 fc
    expect(new Set(capture.query?.["factIds"] as string[])).toEqual(new Set(["fa", "fb", "fc"]))
  })

  it("★★ kl 读不到（factsOfEntity 未注入）→ 退回正文匹配，而不是恒 0", async () => {
    const capture: { query?: Record<string, unknown> } = {}
    // 不给 factsOfEntity
    const service = makeService(3, capture, { entities: [ZILAN] })
    await service.facts({ ...BASE, entityName: "紫蓝" })
    // factIds 不传（undefined）→ searchFacts 那侧走 text LIKE
    expect("factIds" in (capture.query ?? {})).toBe(false)
  })

  it("★★ 全部 factsOfEntity 都抛 → 退回正文（undefined），不谎称没有", async () => {
    const capture: { query?: Record<string, unknown> } = {}
    const service = makeService(3, capture, {
      entities: [ZILAN],
      factsOfEntity: () => Promise.reject(new Error("kl busy")),
    })
    await service.facts({ ...BASE, entityName: "紫蓝" })
    expect("factIds" in (capture.query ?? {})).toBe(false)
  })

  it("★★ 查无此实体 → 传空数组（恒空），而不是退回正文撞词", async () => {
    const capture: { query?: Record<string, unknown> } = {}
    const service = makeService(3, capture, {
      entities: [], // entitiesByName 查不到
      factsOfEntity: () => Promise.resolve(new Set(["x"])),
    })
    await service.facts({ ...BASE, entityName: "查无此人" })
    expect(capture.query?.["factIds"]).toEqual([])
  })
})


describe("★ 「筛空了」与「图里没有」要给不同的话", () => {
  it("有筛选条件且 0 条 → 提示放宽条件", async () => {
    const result = await makeService(0).facts({ ...BASE, keyword: "查无此词" })
    expect(result.available).toBe(true)
    expect(result.total).toBe(0)
    expect(result.reason).toContain("当前筛选下没有")
  })

  it("★ 没有任何筛选却 0 条 → 那是图本身空的，提示去建图", async () => {
    const result = await makeService(0).facts(BASE)
    expect(result.reason).toContain("图里还没有事实")
    // 不该给"放宽条件"—— 没有条件可放宽
    expect(result.reason).not.toContain("放宽")
  })

  it("时间范围也算筛选条件（只选了近 7 天而 0 条 → 放宽）", async () => {
    expect((await makeService(0).facts({ ...BASE, days: 7 })).reason).toContain("当前筛选下没有")
  })

  it("有结果时 reason 为 null（不该在正常状态下摆一句提示）", async () => {
    const result = await makeService(5).facts(BASE)
    expect(result.reason).toBeNull()
    expect(result.facts.length).toBe(5)
  })
})

describe("★ 图库不存在时降级，而不是抛", () => {
  it("给一句可行动的话（去建图），available 为 false", async () => {
    const service = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => "/tmp/definitely-not-a-real-kl-dir-xyz",
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
    })
    const result = await service.facts(BASE)
    expect(result.available).toBe(false)
    expect(result.reason).toContain("还没建过图")
    expect(result.facts).toEqual([])
  })

  /**
   * ★ 未挂载 vault（`dataDir()` 返回空串）也必须降级。
   *
   * 这是身份隔离引入的**新状态**：`dataDir` 从值改成了 getter，而未登录时
   * 它没有值可给。返回空串时若不走降级，`join("", "knowledge.db")` 会得到
   * 一个相对路径 `knowledge.db` —— 那会在**进程 cwd** 下找库，
   * 也就是可能读到仓库目录里某个同名文件，而那比"图不存在"糟得多。
   */
  it("未挂载 vault（dataDir 为空）→ 同样降级，不去 cwd 找库", async () => {
    const service = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => "",
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
    })
    expect((await service.facts(BASE)).available).toBe(false)
    expect((await service.ego()).available).toBe(false)
  })

  it("ego 图同样降级（同一个判断，两条路径都要有）", async () => {
    const service = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => "/tmp/definitely-not-a-real-kl-dir-xyz",
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
    })
    expect((await service.ego()).available).toBe(false)
  })
})

describe("★ 查询层抛错时整块降级，不让异常穿到 IPC", () => {
  it("searchFacts 抛 → available:false + 原因带上 detail", async () => {
    const service = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => dataDirWithDb(),
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
      openDb: () => ({
        entitiesByName: () => [],
        allEntities: () => [],
        factLinksAround: () => [],
        factConversations: () => [],
        entitiesByIds: () => [],
        searchFacts: () => {
          throw new Error("fts5: syntax error")
        },
        close: () => undefined,
      }),
    })
    const result = await service.facts(BASE)
    expect(result.available).toBe(false)
    expect(result.reason).toContain("fts5")
  })
})

describe("★ ego 图找不到「我」时说人话", () => {
  function egoService(
    over: Partial<GraphReadHandle>,
    /**
     * ★ 额外注入。关键是 `factsOfEntity` —— 给了它才走"问 kl"那条真实路径
     * （关系边不在 SQLite 里，见 `GraphQueryOptions.factsOfEntity`）。
     */
    extra: Partial<ConstructorParameters<typeof GraphQueryService>[0]> = {},
    selfNames: readonly string[] = ["小周"],
  ) {
    return new GraphQueryService({
      logger: noopLogger,
      dataDir: () => dataDirWithDb(),
      now: () => NOW,
      getSelfNames: () => selfNames,
      getChannelByConversation: () => new Map(),
      ...extra,
      openDb: () => ({
        entitiesByName: () => [],
        factLinksAround: () => [],
        factConversations: () => [],
        entitiesByIds: () => [],
        searchFacts: () => ({ total: 0, rows: [] }),
        close: () => undefined,
        ...over,
      }),
    })
  }

  it("身份没确认（没有显示名）→ 提示去确认身份，且**一次库都不开**", async () => {
    let opened = false
    const service = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => dataDirWithDb(),
      now: () => NOW,
      getSelfNames: () => [],
      getChannelByConversation: () => new Map(),
      openDb: () => {
        opened = true
        throw new Error("不该走到这里")
      },
    })
    expect((await service.ego()).reason).toContain("确认本人身份")
    expect(opened).toBe(false)
  })

  it("图里没有这个名字 → 提示建图没覆盖到", async () => {
    expect((await egoService({ entitiesByName: () => [] }).ego()).reason).toContain("图里还没有你")
  })

  /**
   * ★★ 「真的没共现」与「读不到关系」要说不同的话。
   *
   * 关系边在默认后端（ladybug）下不在 SQLite 里，所以"读 edges 得到空"
   * **不等于**"没有关系"。这条走的是**问过 kl 仍然空**那一档 ——
   * 那时指向「优化图谱」才是对的。
   */
  it("★ 问过 kl 仍然没有共现 → 提示跑「优化图谱」", async () => {
    const reason = (
      await egoService(
        { entitiesByName: () => [{ id: "me", name: "小周", type: "Person", mentions: 100 }] },
        { factsOfEntity: () => Promise.resolve(new Set<string>()) },
      ).ego()
    ).reason
    expect(reason).toContain("还没抽到")
  })

  /**
   * ★★★ 而**没接 kl** 时那句话不能说"没抽到" —— 那是假话。
   *
   * 修复前 ego 图读 SQLite 的 `edges`，而那张表在 ladybug 下按设计恒空
   * （上游 `storage/base.py:446` 明写）。于是一个有 26558 条边的图上，
   * 界面永远显示「还没抽到你和别人的关联（可能要再跑一次「优化图谱」）」——
   * 把读错源说成了数据没建好，而点优化图谱不会有任何帮助。
   */
  it("★★★ 没接 kl（关系读不到）→ 不许说「还没抽到」", async () => {
    const reason = (
      await egoService({
        entitiesByName: () => [{ id: "me", name: "小周", type: "Person", mentions: 100 }],
        factLinksAround: () => [],
      }).ego()
    ).reason
    expect(reason).not.toContain("还没抽到")
    expect(reason).toMatch(/图谱服务|读到/)
  })
})

describe("★★★ 关系走 kl 的交集（SQLite 的 edges 表恒空）", () => {
  /**
   * ★★★ 这一组锁的是**图可视化为什么一直是空面板**。
   *
   * 关系边（`ABOUT`：fact↔entity）在默认后端下不在 SQLite 里 ——
   * 上游 `kl_graph/storage/base.py:446` 明写「on the ladybug backend edges
   * live in LadybugDB and the SQLite `edges` table is empty」，而
   * `config.default.yaml:39` 里 `KL_GRAPH_BACKEND` 的默认值正是 `ladybug`。
   *
   * 实测同一时刻两个源：
   *
   * ```
   * GET /status → {"graph_backend":"ladybug","sqlite":{"edges":26558}}
   * SELECT COUNT(*) FROM edges  → 0
   * ```
   *
   * ## 为什么用「交集」而不是别的
   *
   * 试过三个端点（都实测）：`/expand` 只给 ENTITY_SIMILAR；`/entity` 给
   * ABOUT 但上游硬编码 `edges_out[:5]` 截断到 5 条；`/graph_hop` 返回空。
   * 只有 `/facts` 的 `limit` 是入参。所以做法是：对每个候选实体问一次
   * "它参与了哪些 fact"，与「我」的那一份求交集 —— 交集非空 = 共现。
   *
   * 实测代价：41 个高频实体 0.10s；全部 618 个 0.72s（平均 1.2ms/次）。
   */
  const ME = { id: "me", name: "小周", type: "Person", mentions: 100 }
  const HIM = { id: "him", name: "小李", type: "Person", mentions: 50 }
  const STRANGER = { id: "x", name: "路人", type: "Person", mentions: 5 }

  /** `entityId → 它参与的 fact id`。复刻 kl `/facts` 的语义。 */
  const FACTS: Record<string, string[]> = {
    me: ["f1", "f2", "f3"],
    him: ["f2", "f9"], // 与我共有 f2 → 应当成为邻居
    x: ["f7"], // 与我毫无交集 → 不该出现
  }

  function service(over: Partial<GraphReadHandle> = {}) {
    const asked: string[] = []
    const svc = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => dataDirWithDb(),
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
      factsOfEntity: (entityId) => {
        asked.push(entityId)
        return Promise.resolve(new Set(FACTS[entityId] ?? []))
      },
      openDb: () => ({
        entitiesByName: () => [ME],
        allEntities: () => [ME, HIM, STRANGER],
        entitiesByIds: (ids) => [ME, HIM, STRANGER].filter((e) => ids.includes(e.id)),
        factLinksAround: () => {
          throw new Error("不该读 edges 表：它在 ladybug 下恒空")
        },
        factConversations: () => [],
        searchFacts: () => ({ total: 0, rows: [] }),
        close: () => undefined,
        ...over,
      }),
    })
    return { svc, asked }
  }

  /**
   * ★★★ 有共现就要出现在图里。
   *
   * ★ `factLinksAround` 在这个替身里**直接抛** —— 于是"偷偷退回读 SQLite"
   * 会让这条炸掉。判据不是"结果对"，而是"根本没碰那张空表"。
   */
  it("★★★ 与我共有一条 fact 的实体成为邻居（且不碰 edges 表）", async () => {
    const { svc } = service()
    const view = await svc.ego()

    expect(view.available).toBe(true)
    expect(view.reason).toBeNull()
    const names = view.nodes.map((n) => n.name)
    expect(names).toContain("小李")
  })

  /**
   * ★★ 毫无交集的实体不许出现 —— 否则图上全是不相干的人。
   *
   * ⚠️ 这条**单靠自己锁不住交集判据**：反证时把 `if (mine.has(factId))`
   * 去掉（= 拿并集）它仍然绿，因为下游 `buildEgoGraph` 里有
   * `if (!members.has(self.id)) continue` —— 那一层也会把不含我的 fact 滤掉。
   * 也就是有两道过滤，去掉任一道结果都还对。
   *
   * 留着它是因为它锁的是**对外可见的行为**（不相干的人不上图）；
   * 交集判据本身由下面那条按 `links` 数量锁。
   */
  it("★★ 没有共现的实体不进图", async () => {
    const { svc } = service()
    const view = await svc.ego()
    expect(view.nodes.map((n) => n.name)).not.toContain("路人")
  })

  /**
   * ★★★ 交集判据本身：**不许把不含我的 fact 也算成关联**。
   *
   * 判据落在 `factConversations` 收到的 fact id 上 —— 那是 `links` 去重后的
   * 结果，也就是我们这一层真正产出的东西（下游 `buildEgoGraph` 的第二道
   * 过滤看不到它）。
   *
   * 拿并集的话 `f7`（路人独有）与 `f9`（小李独有）会混进来 ——
   * 而它们与我无关。那不只是多几条边：`factConversations` 会去查这些 fact
   * 的会话，于是渠道描边也跟着错。
   */
  it("★★★ 只有与我共有的 fact 进入 links（并集会混进无关 fact）", async () => {
    let askedFacts: readonly string[] = []
    const svc = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => dataDirWithDb(),
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
      factsOfEntity: (entityId) => Promise.resolve(new Set(FACTS[entityId] ?? [])),
      openDb: () => ({
        entitiesByName: () => [ME],
        allEntities: () => [ME, HIM, STRANGER],
        entitiesByIds: (ids) => [ME, HIM, STRANGER].filter((e) => ids.includes(e.id)),
        factLinksAround: () => [],
        factConversations: (factIds) => {
          askedFacts = factIds
          return []
        },
        searchFacts: () => ({ total: 0, rows: [] }),
        close: () => undefined,
      }),
    })
    await svc.ego()

    // 我的三条都在
    expect([...askedFacts].sort()).toEqual(["f1", "f2", "f3"])
    // ★ 别人独有的不许进来（并集就会带上它们）
    expect(askedFacts).not.toContain("f9")
    expect(askedFacts).not.toContain("f7")
  })

  /**
   * ★★ 「我」自己也要问一次并把那些边放进去。
   *
   * 不放的话 `buildEgoGraph` 认不出中心节点（它靠 `self.id` 的那些边），
   * 于是中心是孤立的 —— 界面上表现为"有邻居但没有我"。
   */
  it("★★ 中心节点在图里（我自己那份边没漏）", async () => {
    const { svc, asked } = service()
    const view = await svc.ego()
    expect(asked).toContain("me")
    expect(view.self).not.toBeNull()
  })

  /**
   * ★ 单个实体查失败不该让整张图失败。
   *
   * kl 在建图期间会忙（实测 `/entity` 直接 500），那时个别请求失败是常态。
   * 一个失败就整页降级的话，最该能看的时刻反而看不到。
   */
  it("★ 某个实体查失败 → 当成没共现，图照样出", async () => {
    const svc = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => dataDirWithDb(),
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
      factsOfEntity: (entityId) => {
        if (entityId === "him") return Promise.reject(new Error("500"))
        return Promise.resolve(new Set(FACTS[entityId] ?? []))
      },
      openDb: () => ({
        entitiesByName: () => [ME],
        allEntities: () => [ME, HIM],
        entitiesByIds: (ids) => [ME, HIM].filter((e) => ids.includes(e.id)),
        factLinksAround: () => [],
        factConversations: () => [],
        searchFacts: () => ({ total: 0, rows: [] }),
        close: () => undefined,
      }),
    })
    const view = await svc.ego()
    // 「我」那份边还在，所以图仍然可用
    expect(view.available).toBe(true)
  })

  /**
   * ★★ 候选集有上限 —— 这是 N 次 HTTP，实体数会随语料长。
   *
   * 按 `mention_count` 倒序取，所以砍掉的是最边缘的那些。
   */
  it("★★ egoCandidateLimit 生效（不无限发请求）", async () => {
    const asked: string[] = []
    const svc = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => dataDirWithDb(),
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
      egoCandidateLimit: 1,
      factsOfEntity: (entityId) => {
        asked.push(entityId)
        return Promise.resolve(new Set(FACTS[entityId] ?? []))
      },
      openDb: () => ({
        entitiesByName: () => [ME],
        // ★ limit 由 handle 收到并生效（真实现是 SQL 的 LIMIT ?）
        allEntities: (limit) => [ME, HIM, STRANGER].slice(0, limit),
        entitiesByIds: () => [ME],
        factLinksAround: () => [],
        factConversations: () => [],
        searchFacts: () => ({ total: 0, rows: [] }),
        close: () => undefined,
      }),
    })
    await svc.ego()
    // 只问了「我」（候选被 limit=1 砍成只剩 ME，而 ME 会被过滤掉）
    expect(asked).toEqual(["me"])
  })
})
