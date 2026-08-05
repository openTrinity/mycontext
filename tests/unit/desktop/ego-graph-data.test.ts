/**
 * @vitest-environment jsdom
 *
 * ego 图的拼装逻辑。
 *
 * ## ★ 为什么这些判断必须单测
 *
 * Graphin / G6 画在 canvas 上，jsdom 里跑不起来 —— 组件只能靠 CDP 探针
 * 验"画布挂起来了"。而真正容易错的是**取谁、取多少、边怎么算、
 * 渠道怎么归**这些判断，它们全在这个纯函数模块里。
 *
 * 这里锁四类行为：
 *
 * 1. **认不出「我」时不能崩**，要给 null 让 UI 说人话；
 * 2. **上限截断**（全图 2170 个实体，不截就是一团毛线）；
 * 3. **二跳只加边不加节点**（加了节点就又回到毛线团）；
 * 4. **渠道多值去重且排序**（顺序不稳会让同一份数据两次渲染不一样）。
 * 5. **tooltip 的 HTML**（见文件末尾）—— 那一组要解析真 DOM 来验
 *    "只有一个根节点"，所以整个文件跑在 jsdom 下。
 */
import { describe, expect, it } from "vitest"
import {
  buildEgoGraph,
  matchSelfEntity,
  tooltipHtml,
  nodeRadius,
  TOP_PEERS,
  type EntityRow,
  type FactEntityLink,
} from "@renderer/features/graph/ego-graph-data"

function entity(id: string, name: string, mentions = 10, type = "Person"): EntityRow {
  return { id, name, type, mentions }
}

/** 一条 fact 关联一组实体 → 展开成 ABOUT 行。 */
function fact(factId: string, entityIds: readonly string[]): FactEntityLink[] {
  return entityIds.map((entityId) => ({ factId, entityId }))
}

describe("★ 认出「我」：判据是本人身份里的名字，不是硬编码", () => {
  const rows = [entity("e1", "小周", 2658), entity("e2", "小吴", 1131)]

  it("按名字命中", () => {
    expect(matchSelfEntity(rows, ["小周"])?.id).toBe("e1")
  })

  it("★ 同名时取提及数最高的（抽取没消歧完时图里会有同名实体）", () => {
    const dup = [entity("low", "小周", 9), entity("high", "小周", 2658)]
    expect(matchSelfEntity(dup, ["小周"])?.id).toBe("high")
  })

  it("多个候选名（花名 + 全名）任一命中即可", () => {
    expect(matchSelfEntity(rows, ["高鹏", "小周"])?.id).toBe("e1")
  })

  it("★ 认不出来返回 null，**不抛** —— UI 要能说「图里还没有你」", () => {
    expect(matchSelfEntity(rows, ["查无此人"])).toBeNull()
    expect(matchSelfEntity(rows, [])).toBeNull()
    // 空串与空白不算名字（身份表里可能有脏值）
    expect(matchSelfEntity(rows, ["", "   "])).toBeNull()
  })
})

describe("★ 拼图：共现推关系", () => {
  const self = entity("me", "小周", 2658)
  const entityById = new Map([
    ["me", self],
    ["a", entity("a", "小吴", 1131)],
    ["b", entity("b", "LlmGateway", 177, "System")],
    ["c", entity("c", "赵敏", 565)],
  ])

  it("与我同在一条 fact 里的算邻居，weight = 共现的 fact 数", () => {
    const links = [
      ...fact("f1", ["me", "a"]),
      ...fact("f2", ["me", "a"]),
      ...fact("f3", ["me", "b"]),
    ]
    const g = buildEgoGraph({ self, links, entityById, factChannels: [] })
    expect(g.self?.id).toBe("me")
    // 中心 + 两个邻居
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "me"])
    const toA = g.edges.find((e) => e.source === "me" && e.target === "a")
    expect(toA?.weight).toBe(2)
    expect(g.edges.find((e) => e.target === "b")?.weight).toBe(1)
  })

  it("★ 没有「我」→ 空图（不是抛错，也不是画一堆无主的节点）", () => {
    const g = buildEgoGraph({
      self: null,
      links: fact("f1", ["a", "b"]),
      entityById,
      factChannels: [],
    })
    expect(g).toEqual({ self: null, nodes: [], edges: [] })
  })

  it("不与我共现的实体不进图（那不是我的 ego 图）", () => {
    const links = [...fact("f1", ["me", "a"]), ...fact("f2", ["b", "c"])]
    const g = buildEgoGraph({ self, links, entityById, factChannels: [] })
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "me"])
  })

  it("★ 节点大小用**总提及数**，不是共现数（那是边的粗细）", () => {
    const links = fact("f1", ["me", "a"])
    const g = buildEgoGraph({ self, links, entityById, factChannels: [] })
    // 小吴共现 1 次，但总提及 1131
    expect(g.nodes.find((n) => n.id === "a")?.mentions).toBe(1131)
  })

  it("hop 标对：我是 0，邻居是 1", () => {
    const g = buildEgoGraph({ self, links: fact("f1", ["me", "a"]), entityById, factChannels: [] })
    expect(g.nodes.find((n) => n.id === "me")?.hop).toBe(0)
    expect(g.nodes.find((n) => n.id === "a")?.hop).toBe(1)
  })
})

describe("★ 上限截断：全图 2170 个实体，不截就是一团毛线", () => {
  it(`最多 ${String(TOP_PEERS)} 个邻居，按共现数降序保留`, () => {
    const self = entity("me", "我", 999)
    const entityById = new Map([["me", self]])
    const links: FactEntityLink[] = []
    // 造 40 个邻居，第 i 个共现 i 次 —— 那么保留的应该是共现最多的那些
    for (let i = 1; i <= 40; i += 1) {
      const id = `p${String(i)}`
      entityById.set(id, entity(id, `邻居${String(i)}`))
      for (let k = 0; k < i; k += 1) links.push(...fact(`f${String(i)}_${String(k)}`, ["me", id]))
    }
    const g = buildEgoGraph({ self, links, entityById, factChannels: [] })
    expect(g.nodes.length).toBe(TOP_PEERS + 1)
    // 共现最少的那个（p1）必然被截掉，最多的（p40）必然留下
    const ids = new Set(g.nodes.map((n) => n.id))
    expect(ids.has("p40")).toBe(true)
    expect(ids.has("p1")).toBe(false)
  })

  it("★ 共现数相同时顺序必须**确定**（否则两次渲染的图不一样）", () => {
    const self = entity("me", "我")
    const entityById = new Map([["me", self]])
    const links: FactEntityLink[] = []
    for (const id of ["z", "y", "x"]) {
      entityById.set(id, entity(id, id))
      links.push(...fact(`f_${id}`, ["me", id]))
    }
    const first = buildEgoGraph({ self, links, entityById, factChannels: [], topPeers: 2 })
    const second = buildEgoGraph({ self, links, entityById, factChannels: [], topPeers: 2 })
    expect(first.nodes.map((n) => n.id)).toEqual(second.nodes.map((n) => n.id))
  })
})

describe("★ 二跳：只加边，不加节点", () => {
  const self = entity("me", "我")
  const entityById = new Map([
    ["me", self],
    ["a", entity("a", "A")],
    ["b", entity("b", "B")],
  ])

  it("一条 fact 里有我 + 两个邻居 → 那两个邻居之间也有边", () => {
    const g = buildEgoGraph({
      self,
      links: fact("f1", ["me", "a", "b"]),
      entityById,
      factChannels: [],
    })
    // 节点仍是 3 个（我 + 两个邻居），没有因为二跳多出节点
    expect(g.nodes.length).toBe(3)
    const peerEdge = g.edges.find((e) => e.source !== "me" && e.target !== "me")
    expect(peerEdge).toBeDefined()
  })

  it("★ 被截断的邻居不参与二跳（否则会画出连不到节点的边，G6 会报错）", () => {
    const g = buildEgoGraph({
      self,
      links: fact("f1", ["me", "a", "b"]),
      entityById,
      factChannels: [],
      // 只留 1 个邻居
      topPeers: 1,
    })
    const ids = new Set(g.nodes.map((n) => n.id))
    for (const edge of g.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
    }
  })
})

describe("★ 渠道归属", () => {
  const self = entity("me", "我")
  const entityById = new Map([
    ["me", self],
    ["a", entity("a", "A")],
  ])

  it("邻居带上那条关系所在的渠道", () => {
    const g = buildEgoGraph({
      self,
      links: fact("f1", ["me", "a"]),
      entityById,
      factChannels: [{ factId: "f1", channelId: "dingtalk" }],
    })
    expect(g.nodes.find((n) => n.id === "a")?.channels).toEqual(["dingtalk"])
  })

  it("★ 多渠道去重且排序（顺序不稳会让描边色在两次渲染间跳）", () => {
    const g = buildEgoGraph({
      self,
      links: [...fact("f1", ["me", "a"]), ...fact("f2", ["me", "a"])],
      entityById,
      factChannels: [
        { factId: "f1", channelId: "feishu" },
        { factId: "f1", channelId: "dingtalk" },
        { factId: "f2", channelId: "dingtalk" },
      ],
    })
    expect(g.nodes.find((n) => n.id === "a")?.channels).toEqual(["dingtalk", "feishu"])
  })

  it("对不上渠道时是空数组（不描一个错的颜色）", () => {
    const g = buildEgoGraph({
      self,
      links: fact("f1", ["me", "a"]),
      entityById,
      factChannels: [],
    })
    expect(g.nodes.find((n) => n.id === "a")?.channels).toEqual([])
  })
})

/**
 * ★ 对数缩放。
 *
 * 实测本人 2658 次而边缘实体 9 次，差约 300 倍 —— 线性映射下后者是一个
 * 亚像素的点（等于看不见也点不到）。对数之后两者半径差在 3 倍以内。
 */
describe("★ 节点半径：对数缩放", () => {
  it("提及数差 300 倍，半径差不到 3 倍", () => {
    const big = nodeRadius(2658, 1)
    const small = nodeRadius(9, 1)
    expect(big / small).toBeLessThan(3)
    // 但仍然要有区别 —— 否则"谁更重要"这一维就没了
    expect(big).toBeGreaterThan(small)
  })

  it("中心节点比同提及数的邻居大（它是这张图的锚点）", () => {
    expect(nodeRadius(100, 0)).toBeGreaterThan(nodeRadius(100, 1))
  })

  it("提及数为 0 或负数也给正半径（脏数据不该让节点消失）", () => {
    expect(nodeRadius(0, 1)).toBeGreaterThan(0)
    expect(nodeRadius(-5, 1)).toBeGreaterThan(0)
  })
})

/**
 * ★★ hover tooltip 的 HTML —— 两个只在真应用里才暴露的坑。
 *
 * 用户报的现象是「hover 某个节点有空白浮窗」。两个原因叠在一起，
 * **两个都不报错**：
 *
 * ① 字段在 `model.data` 里，不在 model 上（G6 传的是节点模型）；
 * ② `@antv/component` 只取返回 HTML 的**第一个子节点**
 *    （`e.innerHTML=t; return e.childNodes[0]`）—— 并列的兄弟全丢。
 *
 * 所以下面每一条都是在锁一个具体的失效形态，而不是"测一下拼字符串"。
 */
describe("★★ tooltip 的 HTML（空白浮窗那个 bug）", () => {
  const model = {
    id: "n1",
    data: { name: "孙芳", typeLabel: "人", mentionsLabel: "被提及 96 次", channels: "钉钉" },
    style: { fill: "#2a78d6" },
  }

  it("★ 从 model.data 取值，不从 model 顶层（顶层全是 undefined）", () => {
    const html = tooltipHtml(model)
    expect(html).toContain("孙芳")
    expect(html).toContain("人")
    expect(html).toContain("被提及 96 次")
    expect(html).toContain("钉钉")
  })

  it("★ 只有一个根节点（并列的兄弟节点会被 @antv/component 丢掉）", () => {
    const html = tooltipHtml(model)
    /**
     * 用真的 DOM 解析来验，而不是数字符串里有几个 `<div` ——
     * 后者证不了"根节点只有一个"这件事。
     * 这一条反证过：把外层那个 wrapper 去掉就红。
     */
    const host = document.createElement("div")
    host.innerHTML = html
    expect(host.childNodes.length).toBe(1)
    // 而那一个根节点里必须真的有内容（不是一个空壳）
    expect((host.childNodes[0] as HTMLElement).innerHTML.length).toBeGreaterThan(20)
  })

  it("★ 取不到名字时返回空串（让 G6 干脆不显示，而不是显示一个空框）", () => {
    // G6 源码里是 `if(!u.content) return` —— 空串就是"不显示"
    expect(tooltipHtml(undefined)).toBe("")
    expect(tooltipHtml({ id: "n1", style: {} })).toBe("")
    expect(tooltipHtml({ id: "n1", data: {} })).toBe("")
    // ★ 这是那个 bug 的形状：字段在顶层 → 取不到 → 必须是空串而不是空框
    expect(tooltipHtml({ id: "n1", name: "孙芳", data: {} })).toBe("")
  })

  it("★ 人名里的尖括号被转义（真实人名，一个 < 就会破坏结构）", () => {
    const html = tooltipHtml({
      id: "n1",
      data: { name: '<img src=x>"&', typeLabel: "人", mentionsLabel: "被提及 1 次", channels: "" },
    })
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img src=x&gt;")
    expect(html).toContain("&quot;&amp;")
    // 结构仍然只有一个根节点（转义没把它拆开）
    const host = document.createElement("div")
    host.innerHTML = html
    expect(host.childNodes.length).toBe(1)
  })

  it("没有渠道时不摆一个空行", () => {
    const html = tooltipHtml({
      id: "n1",
      data: { name: "OKR", typeLabel: "项目", mentionsLabel: "被提及 3 次", channels: "" },
    })
    const host = document.createElement("div")
    host.innerHTML = html
    // 根节点里两行：名字 + 类型·提及数
    expect((host.childNodes[0] as HTMLElement).children.length).toBe(2)
  })
})
