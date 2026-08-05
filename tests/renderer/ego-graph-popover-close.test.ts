/**
 * ego 图那个选中浮层**必须有出口**。
 *
 * ## ★ 这一条来自一次截图自查
 *
 * 浮层（点节点后弹出来的那张小卡，写着名字 / 类型 / 被提及次数 / 「看他的
 * 事实」）原来**只有入口没有出口**：`setSelected` 有两处调用
 * （图上点节点、邻居列表点一行），而没有任何一处把它置回 `null`。
 *
 * 于是它一旦出现就永久压在画布左上角，挡住那一片的节点。表现是：
 *
 * · 不报错、不影响数据、单测全绿（当时根本没有覆盖这个组件的测试）；
 * · 图**越用越糊** —— 每点一个人都把左上角那块遮得更久；
 * · 用户唯一的办法是切走这一页再切回来，而没人会想到那是"关闭"的方式。
 *
 * 是拍浅色/暗色两张图逐个看的时候发现的：两张图上都糊着同一张
 * 「LlmGateway · 系统 · 被提及 181 次」的卡片 —— 而它来自更早一次点击。
 *
 * ## 为什么是读源码而不是渲染组件
 *
 * 与 `ego-graph-hover.test.ts` 同一个理由：G6 要 canvas，jsdom 里起不来，
 * 这个组件整体只能靠 CDP 探针在真应用里验。但"有没有出口"是**静态可判**的。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/graph/ego-graph-panel.tsx"),
  "utf8",
)

/** 去掉注释 —— 注释里提到 `setSelected(null)` 不算实现了它。 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "")

describe("★ 选中浮层必须能关掉", () => {
  it("存在把 selected 置回 null 的调用", () => {
    expect(CODE).toContain("setSelected(null)")
  })

  /**
   * ★ 出口必须在**浮层里面**，不是页面别处的某个副作用。
   *
   * 少了这一条，"在某个 useEffect 里把它清掉"也能过上面那条 ——
   * 而那种实现下用户仍然没有一个可以点的东西。
   * 判据：浮层那段 JSX（从 `node === null ? null :` 起）里同时有
   * 一个 button 和那个调用。
   *
   * ★ 结束边界用 `neighbors.map`（邻居列表的第一行**代码**），
   * 不用注释里的「邻居列表」—— `CODE` 已经把注释剥掉了，
   * 拿注释当锚点会切出一个空串，而那时断言失败指向的是浮层"没有出口"，
   * 一个完全错误的结论（第一版就是这么假红的）。
   */
  it("出口是浮层里的一个按钮（而不是别处的副作用）", () => {
    const start = CODE.indexOf("node === null ? null :")
    expect(start, "应能找到浮层那段 JSX").toBeGreaterThan(-1)
    const end = CODE.indexOf("neighbors.map", start)
    expect(end, "应能找到邻居列表那段代码（浮层的结束边界）").toBeGreaterThan(start)
    const popover = CODE.slice(start, end)
    expect(popover).toContain("setSelected(null)")
    expect(popover).toContain("<button")
  })

  /**
   * ★ 那个按钮要有无障碍名字。
   *
   * 内容是一个 "×" —— 对读屏器只是一个符号，而它是浮层**唯一**的出口。
   * 没有 aria-label 的表现是：用读屏器的人根本关不掉这张卡。
   */
  it("关闭按钮有 aria-label（× 对读屏器不是文字）", () => {
    /**
     * ## ★ 判据必须先**框定浮层那一段**，不能全局找第一个 setSelected(null)
     *
     * 第一版是 `CODE.indexOf("setSelected(null)")` + 往前找 `<button`。
     * 那依赖"文件里第一个 setSelected(null) 就是关闭按钮里的那个"——
     * 而后来面板加了「回到初始视图」的 `resetView`，它也调
     * `setSelected(null)`，而且位置在**更前面**（state 声明区）。
     * 于是 `lastIndexOf("<button", …)` 往前找不到任何 button，
     * 断言红在 `-1 > -1` —— 报的却是一件与无障碍无关的事。
     *
     * 改成与上一条同一个口径：先切出浮层那段 JSX，只在里面找。
     */
    const start = CODE.indexOf("node === null ? null :")
    expect(start, "应能找到浮层那段 JSX").toBeGreaterThan(-1)
    const end = CODE.indexOf("neighbors.map", start)
    const popover = CODE.slice(start, end)

    const closeAt = popover.indexOf("setSelected(null)")
    expect(closeAt, "浮层里应有把 selected 置回 null 的调用").toBeGreaterThan(-1)
    const btnStart = popover.lastIndexOf("<button", closeAt)
    expect(btnStart, "那个调用应该在一个 <button 里").toBeGreaterThan(-1)
    expect(popover.slice(btnStart, closeAt)).toContain("aria-label")
  })

  /**
   * 无障碍名字走 i18n（这一批 `graph` 命名空间是双语的），
   * 不写死中文 —— 写死的表现是英文界面上突然出现一个中文标签。
   */
  it("关闭的文案走 i18n，不写死中文", () => {
    expect(CODE).toContain('t("closeDetail"')
  })
})
