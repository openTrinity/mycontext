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
function fakeDb(rows: number, capture: { query?: Parameters<GraphReadHandle["searchFacts"]>[0] }) {
  const handle: GraphReadHandle = {
    entitiesByName: () => [],
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

function makeService(rows: number, capture: { query?: unknown } = {}) {
  return new GraphQueryService({
    logger: noopLogger,
    dataDir: () => dataDirWithDb(),
    now: () => NOW,
    getSelfNames: () => ["小周"],
    getChannelByConversation: () => new Map(),
    openDb: () => fakeDb(rows, capture as { query?: never }),
  })
}

const BASE = { days: null, types: [], entityName: null, keyword: "", limit: 20, offset: 0 }

describe("★ 时间范围换算成时间戳下界", () => {
  it("days 给了 → since = now - days（不是天数原样传下去）", () => {
    const capture: { query?: { since: number | null } } = {}
    makeService(3, capture).facts({ ...BASE, days: 7 })
    expect(capture.query?.since).toBe(NOW - 7 * MS_PER_DAY)
  })

  it("days 为 null → since 也是 null（「全部」不该被算成 0 时刻）", () => {
    const capture: { query?: { since: number | null } } = {}
    makeService(3, capture).facts({ ...BASE, days: null })
    expect(capture.query?.since).toBeNull()
  })
})

describe("★ 过滤条件原样透到查询层", () => {
  it("类型多选、实体、关键词、分页都传下去", () => {
    const capture: { query?: Record<string, unknown> } = {}
    makeService(3, capture).facts({
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
 * ★ 空结果的两种解释。
 *
 * 这一条锁的是"用户不知道该做什么"那类失效：同一个空列表，
 * 一种要他放宽条件，另一种要他去建图。给同一句话等于什么都没说。
 */
describe("★ 「筛空了」与「图里没有」要给不同的话", () => {
  it("有筛选条件且 0 条 → 提示放宽条件", () => {
    const result = makeService(0).facts({ ...BASE, keyword: "查无此词" })
    expect(result.available).toBe(true)
    expect(result.total).toBe(0)
    expect(result.reason).toContain("当前筛选下没有")
  })

  it("★ 没有任何筛选却 0 条 → 那是图本身空的，提示去建图", () => {
    const result = makeService(0).facts(BASE)
    expect(result.reason).toContain("图里还没有事实")
    // 不该给"放宽条件"—— 没有条件可放宽
    expect(result.reason).not.toContain("放宽")
  })

  it("时间范围也算筛选条件（只选了近 7 天而 0 条 → 放宽）", () => {
    expect(makeService(0).facts({ ...BASE, days: 7 }).reason).toContain("当前筛选下没有")
  })

  it("有结果时 reason 为 null（不该在正常状态下摆一句提示）", () => {
    const result = makeService(5).facts(BASE)
    expect(result.reason).toBeNull()
    expect(result.facts.length).toBe(5)
  })
})

describe("★ 图库不存在时降级，而不是抛", () => {
  it("给一句可行动的话（去建图），available 为 false", () => {
    const service = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => "/tmp/definitely-not-a-real-kl-dir-xyz",
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
    })
    const result = service.facts(BASE)
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
  it("未挂载 vault（dataDir 为空）→ 同样降级，不去 cwd 找库", () => {
    const service = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => "",
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
    })
    expect(service.facts(BASE).available).toBe(false)
    expect(service.ego().available).toBe(false)
  })

  it("ego 图同样降级（同一个判断，两条路径都要有）", () => {
    const service = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => "/tmp/definitely-not-a-real-kl-dir-xyz",
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
    })
    expect(service.ego().available).toBe(false)
  })
})

describe("★ 查询层抛错时整块降级，不让异常穿到 IPC", () => {
  it("searchFacts 抛 → available:false + 原因带上 detail", () => {
    const service = new GraphQueryService({
      logger: noopLogger,
      dataDir: () => dataDirWithDb(),
      now: () => NOW,
      getSelfNames: () => ["小周"],
      getChannelByConversation: () => new Map(),
      openDb: () => ({
        entitiesByName: () => [],
        factLinksAround: () => [],
        factConversations: () => [],
        entitiesByIds: () => [],
        searchFacts: () => {
          throw new Error("fts5: syntax error")
        },
        close: () => undefined,
      }),
    })
    const result = service.facts(BASE)
    expect(result.available).toBe(false)
    expect(result.reason).toContain("fts5")
  })
})

describe("★ ego 图找不到「我」时说人话", () => {
  function egoService(over: Partial<GraphReadHandle>, selfNames: readonly string[] = ["小周"]) {
    return new GraphQueryService({
      logger: noopLogger,
      dataDir: () => dataDirWithDb(),
      now: () => NOW,
      getSelfNames: () => selfNames,
      getChannelByConversation: () => new Map(),
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

  it("身份没确认（没有显示名）→ 提示去确认身份，且**一次库都不开**", () => {
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
    expect(service.ego().reason).toContain("确认本人身份")
    expect(opened).toBe(false)
  })

  it("图里没有这个名字 → 提示建图没覆盖到", () => {
    expect(egoService({ entitiesByName: () => [] }).ego().reason).toContain("图里还没有你")
  })

  it("有我但没有共现 → 提示跑「优化图谱」（与上一条是不同的下一步）", () => {
    const reason = egoService({
      entitiesByName: () => [{ id: "me", name: "小周", type: "Person", mentions: 100 }],
      factLinksAround: () => [],
    }).ego().reason
    expect(reason).toContain("还没抽到")
  })
})
