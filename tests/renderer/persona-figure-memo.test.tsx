/**
 * @vitest-environment jsdom
 *
 * `PersonaFigure` 的 `useMemo` 稳定性。
 *
 * ## 为什么这值得一个独立的测试文件
 *
 * 抽屉界面一屏最多 64 个缩略图，而每张 dataUri 均值 ~18700 字符
 * （实测 64 张累计 **851KB**）。memo 一旦失效，每次父组件重渲染都要
 * 重新拼这 851KB —— 而**失效是静默的**：不报错，只是变卡。
 * 那正是本仓库反复记录的那类"看起来做了优化其实没生效"。
 *
 * 判据是**`createAvatar` 的调用次数**（会随缺陷变化的量），
 * 不是"渲染出来了几个 img"（那在 memo 完全失效时也成立）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"

/**
 * 把 `createAvatar` 换成一个会计数的桩。
 *
 * `vi.mock` 必须在 import 被测组件**之前**生效，所以用工厂式 mock
 * 而不是 `spyOn`（后者拿不到 ESM 的具名导出）。
 */
const calls = { count: 0 }
vi.mock("@dicebear/core", () => ({
  createAvatar: (_style: unknown, options: { seed: string }) => {
    calls.count += 1
    // 产物只要"随参数变"就够了 —— 这里不测 SVG 内容
    return { toDataUri: () => `data:stub,${JSON.stringify(options)}` }
  },
}))

const { PersonaFigure } = await import("@mycontext/design")

afterEach(cleanup)
beforeEach(() => {
  calls.count = 0
})

describe("★ memo 依赖不能是对象引用", () => {
  it("同一份 custom 的**新对象引用**不触发重新生成", () => {
    /**
     * 这是最容易写错的一处：`custom` 是对象，父组件每次重渲染都会
     * 给一个新引用。依赖数组写 `[custom]` 的话 memo 全部失效。
     */
    const view = render(<PersonaFigure seed="s" custom={{ slots: { hair: "variant07" } }} />)
    expect(calls.count).toBe(1)

    // 内容完全相同、引用不同
    view.rerender(<PersonaFigure seed="s" custom={{ slots: { hair: "variant07" } }} />)
    expect(calls.count).toBe(1)
  })

  it("★ 键序无关：{hair,eyes} 与 {eyes,hair} 命中同一个 memo", () => {
    /**
     * ★ 这条锁的是"不能用裸 `JSON.stringify`"。
     *
     * `custom.slots` 的键顺序**由用户点击顺序决定**（先点头发再点眼睛
     * vs 反过来），而 `JSON.stringify({a,b}) !== JSON.stringify({b,a})`。
     * 不排序的话，两个语义完全相同的配置会算出两个不同的 key，
     * memo 在语义没变时失效 —— 而那只表现为"变卡"。
     */
    const view = render(
      <PersonaFigure seed="s" custom={{ slots: { hair: "variant07", eyes: "variant02" } }} />,
    )
    expect(calls.count).toBe(1)

    view.rerender(
      <PersonaFigure seed="s" custom={{ slots: { eyes: "variant02", hair: "variant07" } }} />,
    )
    expect(calls.count).toBe(1)
  })

  it("内容真的变了才重新生成（证明上面两条不是恒真的）", () => {
    /**
     * 没有这一条时，一个"永远不重新生成"的实现（比如 memo 依赖写成
     * 空数组）也能让上面两条通过 —— 那种实现的表现是**点了没反应**，
     * 比变卡严重得多。
     */
    const view = render(<PersonaFigure seed="s" custom={{ slots: { hair: "variant07" } }} />)
    expect(calls.count).toBe(1)
    view.rerender(<PersonaFigure seed="s" custom={{ slots: { hair: "variant30" } }} />)
    expect(calls.count).toBe(2)
    view.rerender(<PersonaFigure seed="other" custom={{ slots: { hair: "variant30" } }} />)
    expect(calls.count).toBe(3)
  })

  it("空 custom 与不传 custom 命中同一个 memo", () => {
    // 调用方常写 `custom={value.figureCustom ?? {}}` —— 那不该比不传更贵
    const view = render(<PersonaFigure seed="s" custom={{}} />)
    expect(calls.count).toBe(1)
    view.rerender(<PersonaFigure seed="s" />)
    expect(calls.count).toBe(1)
  })

  it("有上传图片时完全不调 createAvatar", () => {
    // 图片优先级更高，那时生成一张扔掉的 SVG 是纯浪费
    render(<PersonaFigure seed="s" imageSrc="mycontext-file://a.png" custom={{}} />)
    expect(calls.count).toBe(0)
  })
})

describe("★★ 抽屉一次只材质化一屏（64 格不全部进 DOM）", () => {
  /**
   * ## 为什么这一组值得存在
   *
   * `SlotDrawer` 的 `MAX_ROWS`/`COLUMNS` 只限制**可视高度** ——
   * 上一版把整个 `slot.variants`（`hair` = 64 格）一次性渲染，
   * 滚动区外那 32+ 格早就生成并解码了。实测 64 格 = **1279KB**
   * dataUri 字符串（UTF-16 约 2.5MB）。
   *
   * 判据是 `createAvatar` 的**调用次数**（会随缺陷变化的量），
   * 不是"DOM 里有几个 button" —— 后者刻意保持 64 个（序号不能随
   * 滚动位置漂，读屏器与 CDP 探针都靠它定位）。
   */
  const labels = {
    slotLabel: (key: string) => `slot:${key}`,
    noneLabel: "none",
  }

  it("hair（64 个变体）首次只生成一屏（32 格）", async () => {
    const { SlotDrawer, FIGURE_SLOTS } = await import("@mycontext/design")
    const hair = FIGURE_SLOTS.notionists.slots.find((slot) => slot.key === "hair")
    // 前提：这个槽位真的比一屏多，否则这条断言什么都没测
    expect(hair?.variants.length).toBeGreaterThan(32)

    render(
      <SlotDrawer
        slot={hair as never}
        style="notionists"
        seed="s"
        value={{}}
        onChange={() => {}}
        slotLabel={labels.slotLabel("hair")}
        noneLabel={labels.noneLabel}
        cellSize={52}
      />,
    )
    /**
     * 32 = MAX_ROWS(4) × COLUMNS(8)。断言"不超过一屏"而不是精确等于 32：
     * 那两个常量是布局参数，将来调成 5 行不该让这条测试红 ——
     * 要锁的是"**不是全部** 64 格"这件事。
     */
    expect(calls.count).toBeLessThanOrEqual(32)
    // 而且真的画了东西（否则一个"什么都不渲染"的实现也能通过上面那条）
    expect(calls.count).toBeGreaterThan(0)
  })

  it("★ 按钮仍然是 64 个（序号不许随滚动漂）", async () => {
    const { SlotDrawer, FIGURE_SLOTS } = await import("@mycontext/design")
    const hair = FIGURE_SLOTS.notionists.slots.find((slot) => slot.key === "hair")
    const { container } = render(
      <SlotDrawer
        slot={hair as never}
        style="notionists"
        seed="s"
        value={{}}
        onChange={() => {}}
        slotLabel="slot:hair"
        noneLabel="none"
        cellSize={52}
      />,
    )
    /**
     * 只省缩略图、不省按钮：省掉按钮会让 `aria-label` 里的序号
     * （"头发 40"）随滚动位置变化 —— 读屏器用户听到的编号会漂，
     * 而 CDP 探针正是靠这个 label 点第 40 格的。
     */
    const cells = [...container.querySelectorAll("button[aria-label]")].filter((node) =>
      /^slot:hair \d+$/.test(node.getAttribute("aria-label") ?? ""),
    )
    expect(cells).toHaveLength(hair?.variants.length ?? 0)
    // 最后一格的序号必须是 64（而它那时还没有缩略图）
    expect(cells.at(-1)?.getAttribute("aria-label")).toBe(`slot:hair ${String(cells.length)}`)
  })
})
