/**
 * 图谱区「一键回到初始视图」按钮的门禁。
 *
 * ## ★ 为什么是"读源码断言"而不是渲染组件
 *
 * G6 要 canvas，jsdom 里起不来 —— 这一块的交互只能靠 CDP 探针在真应用里
 * 验。但探针跑不进 CI（要先起应用、先登录、还要有图谱数据），
 * 而这里要守的几条都是**静态可判**的不变量。
 *
 * 与 `ego-graph-hover.test.ts` 同一个路子（那个文件的头部注释解释得更细）。
 *
 * ## 守的是哪几件事
 *
 * 用户原话：「知识图谱区域得有一个按钮一键重置（focus 的那种 icon 感觉）
 * 失去聚焦，回到原始的图的样子」。
 *
 * 这一块有**五种**会累积的临时状态，而"回到原样"要清其中四种。
 * 少清一种，用户按下按钮之后画面仍然是脏的 —— 而那是最难查的一类失效：
 * 按钮**有反应**（视口回去了），但"失去聚焦"没做到。
 *
 * 第五种（`focusedName`，下面那批事实的筛选）**刻意不清** ——
 * 它有自己的出口（联动带上的「看全部」），而且作用范围跨出了图谱区。
 * 这一条也要锁：防止有人"顺手"把它加进去。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const GRAPH = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/graph/ego-graph.tsx"),
  "utf8",
)

const PANEL = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/graph/ego-graph-panel.tsx"),
  "utf8",
)

const ICONS = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/shell/icons.tsx"),
  "utf8",
)

/**
 * 剥掉注释的源码。
 *
 * ★ 这一步是这一组成立的**前提**，不是清理。这几个文件的注释里大量提到
 * `fitView` / `focusedName` / `setChannels` 这些词（它们在解释为什么这么做），
 * 不剥的话断言可能命中一句注释而不是真实代码 —— 那时"功能在不在"
 * 这个结论是假的（注释不会执行）。
 *
 * 这个坑在 `dashboard-identity-warning.test.ts` 上真的栽过一次。
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

const PANEL_CODE = code(PANEL)
const GRAPH_CODE = code(GRAPH)

/**
 * 抓某个函数的**函数体**（花括号配平）。
 *
 * 不锁具体写法：`resetView` 里那几个 setter 的顺序、有没有顺手关 tooltip
 * 都可能变，而那些变化是**正确的**扩展。判据只要"这个函数存在、
 * 且它的函数体里做了那几件事"。
 */
function functionBody(source: string, name: string): string | null {
  const start = source.indexOf(`const ${name} = `)
  if (start === -1) return null
  const from = source.indexOf("{", start)
  if (from === -1) return null
  let depth = 0
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1
    else if (source[i] === "}") {
      depth -= 1
      if (depth === 0) return source.slice(from + 1, i)
    }
  }
  return null
}

describe("★★ 复位按钮清掉全部四种图内状态（缺一件都不算回到原样）", () => {
  const body = functionBody(PANEL_CODE, "resetView")

  it("有一个 resetView 函数", () => {
    expect(body, "面板层应有 resetView").not.toBeNull()
  })

  /**
   * ★ 视口 —— 这是真正**缺出口**的那一个。
   *
   * `behaviors` 里注册了 `drag-canvas` / `zoom-canvas` / `drag-element`，
   * 用户把画面拖歪/缩坏之后在这个按钮之前**没有任何办法**回去
   * （只能切走这一页再切回来，那会重新拉一次 ego 数据）。
   */
  it("复位视口（调 EgoGraph 塞进来的那个命令）", () => {
    expect(body ?? "").toMatch(/resetViewportRef\.current\?\.\(\)/)
  })

  /** 详情浮层：它有自己的 `×`，但复位也该把它关掉 */
  it("关掉详情浮层（setSelected(null)）", () => {
    expect(body ?? "").toMatch(/setSelected\(null\)/)
  })

  /** hover 压暗态：其余节点变虚那个 */
  it("退出聚焦压暗（setHovered(null)）", () => {
    expect(body ?? "").toMatch(/setHovered\(null\)/)
  })

  /** 渠道筛选：回到"全部渠道" */
  it("清空渠道筛选（setChannels 给一个空集）", () => {
    expect(body ?? "").toMatch(/setChannels\(new Set\(\)\)/)
  })
})

describe("★★ 复位**不**碰下面那批事实的筛选", () => {
  /**
   * `focusedName` 是**父级**（`dashboard-module`）的 state，同时驱动
   * 下面的事实面板与联动带。它已经有专门的出口 —— 联动带上的「看全部」。
   *
   * 让复位也清它有两个问题：
   * · 与「看全部」重复（同一件事两个入口，而它们的名字暗示不同的范围）；
   * · 作用范围**跨出图谱区** —— 用户按"回到初始视图"时不会预期
   *   下面那批事实也跟着变。
   *
   * 判据锁两侧：面板**没有**清它的调用，且面板也**没有**为此新增回调 prop。
   */
  it("resetView 里没有清 focusedName 的动作", () => {
    const body = functionBody(PANEL_CODE, "resetView") ?? ""
    expect(body).not.toMatch(/focus/i)
    expect(body).not.toMatch(/onPickEntity/)
  })

  /**
   * ★ 也没有偷偷加一个"清事实筛选"的 prop。
   *
   * 只锁函数体的话，有人可以加一个 `onResetFocus` prop 然后在别处调 ——
   * 那样这一条仍然绿，而行为已经变了。
   */
  it("没有为复位新增清事实筛选的回调 prop", () => {
    expect(PANEL_CODE).not.toMatch(/onClearFocus|onResetFocus|onFocusReset/)
  })
})

describe("★★ 按钮本身可达且只在有东西可复位时出现", () => {
  /**
   * 图标按钮**必须**有可读名字 —— 一个只有图形的按钮对读屏器是
   * "button"，用户不知道它做什么。`IconButton` 的 `label` 进 aria-label。
   */
  it("按钮有可读名字（走 i18n 的 resetView）", () => {
    expect(PANEL_CODE).toMatch(/label=\{t\("resetView"\)\}/)
  })

  it("用 FocusIcon（取景框那个），不是循环箭头/放大镜", () => {
    expect(PANEL_CODE).toMatch(/<FocusIcon\s*\/>/)
    expect(ICONS).toContain("export function FocusIcon")
  })

  /**
   * ★★ 只在**有东西可复位**时出现。
   *
   * 一个点了没有任何变化的按钮比没有更糟 —— 这一块的渠道筛选就是按
   * 这条在单渠道时隐藏的（`ego-graph-panel.tsx` 里那条注释：
   * "点了没有任何变化的开关比没有更糟"）。
   *
   * 判据要求 `canReset` 同时看**四个**来源：只看视口的话，
   * hover/选中/筛选留下的脏状态就没有出口了。
   */
  it("canReset 同时看视口/选中/hover/渠道四个来源", () => {
    const at = PANEL_CODE.indexOf("const canReset")
    expect(at, "应有 canReset 判据").toBeGreaterThan(-1)
    const line = PANEL_CODE.slice(at, PANEL_CODE.indexOf("\n", at))
    expect(line).toMatch(/viewportDirty/)
    expect(line).toMatch(/selected/)
    expect(line).toMatch(/hovered/)
    expect(line).toMatch(/channels/)
  })

  it("按钮受 canReset 控制（没东西可复位时不渲染）", () => {
    expect(PANEL_CODE).toMatch(/\{canReset \?/)
  })

  /**
   * ★ 判"视口动过"**不能**拿 zoom 值去比。
   *
   * 初始构图走 `autoFit: "view"`，算出来的 zoom 本来就不是 1
   * （它按内容缩放过）—— 拿 `zoom !== 1` 判会让按钮一直亮着。
   */
  it("不用 zoom 值判视口是否动过", () => {
    expect(PANEL_CODE).not.toMatch(/getZoom\(\)\s*[!=]==?\s*1/)
  })
})

describe("★★ fitView 的两条防护（这个文件已经踩过的坑，新代码不能绕过）", () => {
  const body = functionBody(GRAPH_CODE, "resetViewport")

  it("有 resetViewport 函数", () => {
    expect(body, "EgoGraph 应有 resetViewport").not.toBeNull()
  })

  /**
   * ★ `graph.destroyed` 判空。
   *
   * `graphRef` 是我们自己存的，G6 销毁实例时**不会**清空它
   * （HMR / 换主题 / 数据换一批都会重建）。对已销毁的实例调方法会抛
   * `The graph instance has been destroyed` —— 这个文件的 `hideTooltip`
   * 注释里记着实测见过一次。
   */
  it("调 fitView 前判 graph.destroyed", () => {
    expect(body ?? "").toMatch(/graph === null \|\| graph\.destroyed/)
  })

  /**
   * ★ `.catch()` 吞掉 rejection。
   *
   * `fitView` 返回 Promise 且带视口动画。动画被打断（用户马上又拖了一下、
   * 或组件卸载）是**常态**而不是错误 —— 不吞会变成 unhandled rejection。
   * 与这个文件里 `setElementState` 那处同一个理由。
   */
  it("fitView 的 rejection 被吞掉（打断不是错误）", () => {
    expect(body ?? "").toMatch(/fitView\(\)[\s\S]{0,80}\.catch\(/)
  })
})

describe("★★ 视口事件名是 G6 v5 真实存在的那两个", () => {
  /**
   * ## 为什么这一条值得存在
   *
   * 我第一版写的是 `graph.on("viewportchange", …)` —— 而 G6 v5 **没有**
   * 这个事件。它不报错、不告警，只是那个回调**永远不触发**，
   * 于是"视口动过"这个 flag 永远是 false、按钮永远不出现。
   * 一个静默失效的监听是这个仓库反复出现的那类 bug。
   *
   * 真实的枚举在 `@antv/g6/lib/constants/events/graph.d.ts`：
   * · `aftertransform`（AFTER_TRANSFORM）—— 可视区域变化（平移 + 缩放）；
   * · `afterelementtranslate`（AFTER_ELEMENT_TRANSLATE）—— 拖走一个节点。
   */
  it("监听 aftertransform（平移/缩放都走它）", () => {
    expect(GRAPH_CODE).toMatch(/graph\.on\("aftertransform"/)
  })

  it("也监听 afterelementtranslate（拖走一个节点也算动过）", () => {
    expect(GRAPH_CODE).toMatch(/graph\.on\("afterelementtranslate"/)
  })

  /** 那个不存在的名字不许回来 */
  it("没有 viewportchange（G6 v5 里不存在这个事件）", () => {
    expect(GRAPH_CODE).not.toMatch(/viewportchange/)
  })

  /**
   * ★★ `fitView()` 自己也会触发 `aftertransform`。
   *
   * 所以复位之后不能简单地把 flag 置 false —— 那次 fitView 的回调会紧接着
   * 把它置回 true，按钮就**永远不消失**。必须有一个"正在复位中"的标记
   * 把那一次忽略掉。
   *
   * 断言"有这个机制"而不是断言某种写法（ref / 时间戳 / 计数都行）。
   */
  it("有机制忽略 fitView 自己触发的那次视口回调", () => {
    expect(PANEL_CODE).toMatch(/resettingRef/)
    // 回调里真的据它提前返回
    expect(PANEL_CODE).toMatch(/if \(resettingRef\.current\) return/)
  })
})
