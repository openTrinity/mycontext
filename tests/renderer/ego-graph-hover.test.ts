/**
 * ego 图 hover 高亮的门禁。
 *
 * ## ★ 为什么是"读源码断言"而不是渲染组件
 *
 * G6 要 canvas，jsdom 里起不来 —— 这个组件只能靠 CDP 探针在真应用里验。
 * 但探针跑不进 CI（要先起应用、先登录、还要有图谱数据），
 * 而这两个 bug 都是**静态可判**的不变量。所以这里锁不变量，
 * 交互本身仍由 `pnpm check:graph-ui` 在真应用上过一遍。
 *
 * ## 锁的是哪两个 bug（都是"hover 后画面变虚且不恢复"）
 *
 * ① `active` 没写回 `opacity` —— G6 的 state 样式是**叠加**的，
 *    节点从 `inactive` 变 `active` 时只有 `active` 里列出的属性被重写，
 *    没列的 `opacity` 保留 0.25。于是被 hover 的那个点自己也是淡的。
 * ② `setElementState` 是 **async**（内部 await 动画队列的 draw）。
 *    fire-and-forget 地调它，快速 hover 进出会让多次 draw 重叠，
 *    **后发的可能先完成** —— 最后落在画面上的是"压暗"而不是"清空"。
 *
 * 两个都不报错、不告警，单测（如果只测数据层）全绿。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/graph/ego-graph.tsx"),
  "utf8",
)

const PANEL = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/graph/ego-graph-panel.tsx"),
  "utf8",
)

/**
 * ★★ 必须有一条**不依赖"等事件来通知"**的兜底。
 *
 * ## 为什么单独锁这一条
 *
 * 「离开图区之后画面还虚着」这个 bug 修了三轮才干净，因为每一层
 * 事件监听都有它收不到的路径：
 *
 * · G6 的 `node:pointerleave` —— 依赖它自己的拾取，指针在两帧之间跨过
 *   整个画布时中间的图元没被"进入"过，也就不会"离开"；
 * · 邻居列表行的 `onMouseLeave` —— 走 React 合成事件（依赖 `mouseout`
 *   逐级派发），一步甩出去时那串事件不落到那一行上；
 * · 面板根的 `onPointerLeave` —— 只在**跨出边界**时派发，而指针停在
 *   面板内的空白处（图例、标题、图与列表之间的缝）时不触发。
 *
 * 三条都是"等一个事件"，而每加一条都只是把漏洞挪个位置。
 * 真正兜住的是**主动量位置**：`document` 上的 `pointermove` 必然连续
 * 派发，判一下指针在不在面板矩形内。断言这个机制存在，而不是断言写法。
 */
describe("★★ 必须有「主动量位置」的兜底，而不只是等 leave 事件", () => {
  it("面板上有 document 级 pointermove 监听", () => {
    const code = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    expect(code).toMatch(/document\.addEventListener\(\s*["']pointermove["']/)
    // 必须解绑，否则每次 hover 变化都会叠一个监听
    expect(code).toMatch(/document\.removeEventListener\(\s*["']pointermove["']/)
  })

  it("判据是「指针在不在面板矩形内」（量位置，不是等事件）", () => {
    const code = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    expect(code).toMatch(/getBoundingClientRect/)
    expect(code).toMatch(/clientX/)
    expect(code).toMatch(/clientY/)
  })

  /**
   * 画布空白处也要清 —— 从节点划到空白（还在画布里）时
   * 外层 div 的 pointerleave 不触发，而那时已经没有聚焦目标了。
   */
  it("画布上的 pointermove 也清 hover", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    expect(code).toMatch(/canvas:pointermove/)
  })
})

/** 抓 `state: { ... }` 那一段（node 的状态样式声明）。 */
function stateBlock(): string {
  const m = /state:\s*\{([\s\S]*?)\n\s{8}\},/.exec(SRC)
  expect(m, "应能找到 node.state 声明块").not.toBeNull()
  return m?.[1] ?? ""
}

describe("★ active 必须显式写回 opacity（否则 hover 的那个点自己也是淡的）", () => {
  /**
   * 这是"变虚"最直接的那一半。
   *
   * `inactive` 把 opacity 压到 0.25 是刻意的（"是这个"而不是"这个更亮些"），
   * 所以不能靠删掉它来修 —— `active` 必须把 opacity 显式抬回来。
   */
  it("inactive 压暗了 opacity，那么 active 就必须写回 opacity", () => {
    const block = stateBlock()
    const inactiveDims = /inactive:\s*\{[^}]*opacity/.test(block)
    if (!inactiveDims) return // 没压暗就不需要写回
    const activeMatch = /active:\s*\{([^}]*)\}/.exec(block)
    expect(activeMatch, "应有 active 状态声明").not.toBeNull()
    expect(activeMatch?.[1]).toMatch(/\bopacity\s*:/)
  })

  /** labelOpacity 同理 —— 只抬 opacity 会留下一个淡名字配实心圆点。 */
  it("labelOpacity 也要成对写回", () => {
    const block = stateBlock()
    if (!/inactive:\s*\{[^}]*labelOpacity/.test(block)) return
    const activeMatch = /active:\s*\{([^}]*)\}/.exec(block)
    expect(activeMatch?.[1]).toMatch(/\blabelOpacity\s*:/)
  })
})

describe("★ setElementState 的并发必须被防住（这是「不恢复」的那一半）", () => {
  /**
   * `setElementState` 返回 Promise（G6 v5 内部 await draw）。
   * 裸调用 = fire-and-forget = 重叠的 draw 竞争，而它们的完成顺序
   * 不保证与发出顺序一致。
   *
   * 断言"有一个序号守卫"而不是断言某种具体写法：修法可以变
   * （序号 / AbortController / 队列），但**必须有**一个机制。
   */
  it("有单调序号守卫（区分「这次是不是最新的」）", () => {
    expect(SRC).toMatch(/stateSeqRef/)
    // 每次进 effect 自增
    expect(SRC).toMatch(/stateSeqRef\.current\s*\+=\s*1/)
    // 异步完成后与最新序号比对
    expect(SRC).toMatch(/seq\s*===?\s*stateSeqRef\.current|seq\s*!==\s*stateSeqRef\.current/)
  })

  /**
   * ★ 最新意图必须存在 **ref** 里，不能只靠闭包。
   *
   * 重放时读闭包里的 `highlightId` 拿到的是**那一次**的值（已过期），
   * 于是重放会把画面设回一个用户早就移开的节点 —— 症状与原 bug 一样，
   * 只是更难查（因为看起来"有防并发了"）。
   */
  it("重放时读 ref 里的最新意图，不是闭包里的过期值", () => {
    expect(SRC).toMatch(/wantRef/)
    expect(SRC).toMatch(/wantRef\.current\s*=/)
  })

  /** 状态动画被打断是常态，不能让它变成未捕获的 rejection。 */
  it("setElementState 的 rejection 被吞掉（打断不是错误）", () => {
    /**
     * 只断言"这个调用被包进了 Promise 链且链上有 catch"，
     * 不锁字符间距 —— 我第一版用了一个限定 400 字符距离的正则，
     * 而真实代码里 `.then(...)` 那段注释就有 300 多字符，于是假红。
     * 断言要贴被测的**性质**，不是贴当前的排版。
     */
    const call = SRC.slice(SRC.indexOf("setElementState("))
    expect(call).toContain(".catch(")
    // 且 catch 出现在同一条链上（在下一个 useEffect / return 之前）
    const chainEnd = call.indexOf("\n  }, [highlightId])")
    expect(call.slice(0, chainEnd)).toContain(".catch(")
  })
})

describe("hover-activate 仍然不能加回来", () => {
  /**
   * 这条是历史锚：加上 G6 的 `hover-activate` 之后整张图**刚加载就是灰的**
   * （它初始化时就把所有节点置 inactive）。实测高饱和像素从 61124 掉到 5140。
   * 而那个 bug 完全不报错，只是"看起来没设计感"。
   */
  it("behaviors 里没有 hover-activate", () => {
    const m = /behaviors:\s*\[([\s\S]*?)\]/.exec(SRC)
    expect(m, "应能找到 behaviors 声明").not.toBeNull()
    // 注释里提到它是可以的（那是解释为什么不用），但不能真的注册
    const code = (m?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "")
    expect(code).not.toContain("hover-activate")
  })
})

/**
 * ★★ 指针离开**整块图区**时必须退出聚焦态。
 *
 * ## 这是第三个"hover 之后不恢复"的 bug，成因与前两个不同
 *
 * 前两个是状态样式与异步竞态（见文件头）。这一个是**事件收不到**：
 *
 * G6 的 `node:pointerleave` 只在指针从**一个节点**上离开时触发。而指针
 * 如果直接从节点掠出整块画布（沿边缘划出去、或一把甩到别的版块），
 * G6 的拾取在两帧之间跨过了整个画布，中间那些图元压根没被"进入"过，
 * 也就不会"离开" —— 于是 `hovered` 永久停在最后那个节点上：
 * 图上一个点亮着、其余全灰，而鼠标已经不在图谱区域里了。
 *
 * 修法是在**包裹 canvas 的 div** 上挂 DOM 的 `onPointerLeave`：
 * 那个事件不冒泡且必然成对 —— 浏览器保证指针跨出元素边界时派发一次，
 * 无论中途经过什么、移动多快。
 *
 * ★ 挂在**外层 div** 而不是 canvas 上：G6 会在容器里重建 canvas
 * （数据变化、resize 都会），挂在 canvas 上的监听会随之丢掉。
 */
describe("★★ 离开整块图区要退出聚焦（node:pointerleave 收不到那一路）", () => {
  /**
   * 剥掉注释的源码。
   *
   * 这一组断言全都在找 JSX 里的 handler，而注释里也会提到
   * `onPointerLeave` / `onHover` 这些词（本文件与被测文件都有大段注释
   * 在解释这些机制）—— 不剥的话断言可能命中一句注释而不是真实代码。
   */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

  /**
   * 抓某个 handler 的**函数体**（支持单表达式与花括号块两种写法）。
   *
   * ★ 不锁具体写法是刻意的：这两个 handler 后来从
   * `onPointerLeave={() => onHover?.(null)}` 变成了一个块
   * （因为"退出聚焦态"除了清高亮还要关 tooltip —— G6 的 tooltip 同样
   * 收不到"一步甩出画布"那一路）。锁单表达式的正则会因为一次**正确的**
   * 扩展而变红，那种门禁只会教人去改断言。
   *
   * 判据因此是"这个 handler 存在，且它的函数体里清了 hover"。
   */
  const handlerBody = (name: string): string | null => {
    const start = code.indexOf(`${name}={`)
    if (start === -1) return null
    // 从 `={` 的那个 `{` 开始做花括号配平，取到匹配的 `}` 为止
    let depth = 0
    const from = code.indexOf("{", start + name.length)
    for (let i = from; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1
      else if (code[i] === "}") {
        depth -= 1
        if (depth === 0) return code.slice(from + 1, i)
      }
    }
    return null
  }

  it("包裹层上有 onPointerLeave 且它清空 hover", () => {
    /**
     * 断言"存在一个 onPointerLeave 且它清了 hover" ——
     * 不锁 div 的 class 或位置（那是排版，会变），也不锁函数体的写法。
     */
    const body = handlerBody("onPointerLeave")
    expect(body, "包裹 Graphin 的那一层要有 onPointerLeave").not.toBeNull()
    expect(body ?? "").toMatch(/onHover\?\.\(null\)/)
  })

  it("★ 节点级的 pointerleave **仍然**保留（两条互补，不是重复）", () => {
    /**
     * 在图**内部**从一个节点移到空白处时，外层 div 的 pointerleave
     * 不会触发（指针还在 div 里），而那时确实该退出聚焦态。
     * 删掉任何一条都会留下一半的失效面。
     */
    expect(SRC).toContain('graph.on("node:pointerleave"')
  })

  it("键盘用户 Tab 出去时也清（那时压根没有指针事件）", () => {
    const body = handlerBody("onBlur")
    expect(body, "包裹层要有 onBlur").not.toBeNull()
    expect(body ?? "").toMatch(/onHover\?\.\(null\)/)
  })

  /**
   * ★★ 退出聚焦态**也要关掉 tooltip**。
   *
   * G6 的 tooltip 靠图元自己的 `pointerleave` 收，而那正是上面整段注释
   * 说的那条收不到的路 —— 于是浮窗留在画布上，鼠标已经在别的版块了。
   *
   * 实测（CDP）：指针移到图区外之后 `.tooltip` 仍是
   * `visibility: visible; opacity: 1`，文字停在最后那个节点上，
   * 等多久都不消失。所以"清高亮"与"关浮窗"必须是同一个动作的两半。
   */
  it("离开图区时也关 tooltip（不然浮窗挂在画布上不走）", () => {
    const body = handlerBody("onPointerLeave")
    expect(body ?? "").toMatch(/hideTooltip\(\)/)
    // tooltip 插件要有 key，否则 getPluginInstance 拿不到实例
    expect(code).toMatch(/key:\s*["']ego-tooltip["']/)
    expect(code).toMatch(/getPluginInstance/)
  })

  it("★ onPointerLeave 挂在包裹层，不是挂在 Graphin 上", () => {
    /**
     * Graphin 不转发未知的 DOM 事件 —— 写在它上面等于没写，
     * 而那种"看起来加了"的失效最难查。所以断言它出现在 `<div` 之后、
     * `<Graphin` 之前。
     *
     * ## ★★ 判据必须先剥掉注释，理由记在这里
     *
     * 第一版直接 `SRC.indexOf("onPointerLeave")`，而后来有人在这个文件
     * **上方的注释里**提到了 `onPointerLeave`（解释 G6 的 tooltip 怎么收）。
     * 于是 `indexOf` 命中了那句注释 —— 它在 `<div` 之前，断言变成
     * `-1 > -1` 而红，报的却是一件与真实结构无关的事。
     *
     * 源码文本型断言全都有这个脆弱面：注释与代码在同一个字符串里。
     * 剥掉注释之后，位置关系才真的在说"JSX 长什么样"。
     */
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    const leaveAt = code.indexOf("onPointerLeave")
    const divAt = code.lastIndexOf("<div", leaveAt)
    const graphinAt = code.indexOf("<Graphin")
    expect(leaveAt, "onPointerLeave 应出现在 JSX 里（不只是注释里）").toBeGreaterThan(-1)
    expect(divAt).toBeGreaterThan(-1)
    expect(leaveAt).toBeGreaterThan(divAt)
    expect(leaveAt).toBeLessThan(graphinAt)
  })
})
