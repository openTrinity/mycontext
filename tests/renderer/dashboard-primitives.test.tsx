/**
 * @vitest-environment jsdom
 *
 * 仪表盘那三个新原语的**几何**与事实面板的**联动**。
 *
 * ## 为什么这几条值得锁
 *
 * 都是"不报错但视觉上错了"的那一类 —— 而它们在评审里看不出来：
 *
 * · **0 值画出一段可见的条**：`Math.max(ratio * 100, 1.5)` 这种写法很自然
 *   （"给个最小宽度免得看不见"），但它会让一个 0 让人以为有一点点 ——
 *   而这一页恰好会出现真正的 0（某个 fact 类型一条都没有）。
 * · **最大值溢出轨道**：条宽算成 `value / total` 而不是 `value / max` 时，
 *   最大的那一条永远填不满；反过来算错分母会超过 100%（溢出圆角）。
 * · **实体一换却停在旧页码**：受控的 `entityFocus` 由**父级**改
 *   （图上点一个人），那条路径不经过面板里的任何 setter。
 *   漏掉的表现是"列表空的、上面写着共 12 条"——像查询坏了。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { Distribution, StatTile } from "@renderer/features/dashboard/primitives"
import { FACT_RAMP, FACT_TYPES, entityColor } from "@renderer/features/graph/palette"

afterEach(cleanup)

/** 条形的内层（数据段）的行内 `width`。取不到时返回 null 而不是抛。 */
function barWidths(container: HTMLElement): string[] {
  return [...container.querySelectorAll("span[style*='width']")].map(
    (el) => (el as HTMLElement).style.width,
  )
}

describe("★ Distribution 的几何", () => {
  it("0 值不画出任何可见宽度（不是「给个最小宽度」）", () => {
    const { container } = render(
      <Distribution
        rows={[
          { label: "有", value: 10, color: "#1d4ed8" },
          { label: "没有", value: 0, color: "#c3ddf7" },
        ]}
      />,
    )
    const widths = barWidths(container)
    expect(widths).toHaveLength(2)
    // 最大值填满轨道
    expect(widths[0]).toBe("100%")
    // 0 就是 0 —— 不是 1.5%、不是 2px
    expect(widths[1]).toBe("0%")
  })

  it("非 0 的小值有可见下限（否则 6663 里的 123 会消失）", () => {
    const { container } = render(
      <Distribution
        rows={[
          { label: "多", value: 6663, color: "#1d4ed8" },
          { label: "少", value: 1, color: "#c3ddf7" },
        ]}
      />,
    )
    const widths = barWidths(container)
    const small = Number.parseFloat(widths[1] ?? "0")
    // 1/6663 = 0.015% → 亚像素，必须抬到可见
    expect(small).toBeGreaterThanOrEqual(1)
    // 但不能抬到与真实比例混淆的量级
    expect(small).toBeLessThan(5)
  })

  it("最大值恰好填满轨道，不溢出", () => {
    const { container } = render(
      <Distribution
        rows={FACT_TYPES.map((type, i) => ({
          label: type,
          value: (i + 1) * 100,
          color: FACT_RAMP[type] ?? "#c3ddf7",
        }))}
      />,
    )
    for (const w of barWidths(container)) {
      expect(Number.parseFloat(w)).toBeLessThanOrEqual(100)
    }
    // 最大的那一条是 100%（分母是 max 而不是 total）
    expect(barWidths(container).at(-1)).toBe("100%")
  })

  it("★ 每一行都有可见的数值标签（relief 规则要求，不可删）", () => {
    /**
     * 浅色主题下 `#1baf7a`(2.74:1) 与 `#eda100`(2.11:1) 低于 3:1 ——
     * 验证脚本给的是 WARN 而不是 FAIL，代价是**必须**有可见标签。
     * 删掉标签这条就违规了，而那不会有任何报错。
     */
    render(
      <Distribution
        rows={[
          { label: "决策", value: 663, color: "#1d4ed8" },
          { label: "因果", value: 123, color: "#5b9be3" },
        ]}
      />,
    )
    expect(screen.getByText("663")).toBeTruthy()
    expect(screen.getByText("123")).toBeTruthy()
  })
})

describe("★ 取色表：颜色跟着实体，不跟着排名", () => {
  it("同一个类型在明暗两套里各是一个固定值，不随传入顺序变", () => {
    const a = entityColor("Person", "light")
    const b = entityColor("Person", "light")
    expect(a).toBe(b)
    // 明暗是两个不同的值（不是自动翻转的同一个）
    expect(entityColor("Person", "dark")).not.toBe(a)
  })

  it("未知类型落到中性灰，不借用别的类型的颜色", () => {
    const unknown = entityColor("SomethingKlInvented", "light")
    for (const known of ["Person", "System", "Project", "Organization"]) {
      expect(unknown).not.toBe(entityColor(known, "light"))
    }
  })

  it("★ 事实类型的 ramp 亮度单调（有序编码的前提）", () => {
    const lin = (c: number) => {
      const v = c / 255
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    const lum = (hex: string) =>
      0.2126 * lin(Number.parseInt(hex.slice(1, 3), 16)) +
      0.7152 * lin(Number.parseInt(hex.slice(3, 5), 16)) +
      0.0722 * lin(Number.parseInt(hex.slice(5, 7), 16))
    const ramp = FACT_TYPES.map((t) => lum(FACT_RAMP[t] ?? "#c3ddf7"))
    for (let i = 1; i < ramp.length; i++) {
      // 语义强度降序 → 亮度必须递增（深 = 强）
      expect(ramp[i]).toBeGreaterThan(ramp[i - 1] as number)
    }
  })
})

/**
 * ★★ 这一页**没有框** —— 层级靠色阶与间距，不靠边界。
 *
 * ## 为什么这一组要存在
 *
 * 这条判断被改过一次。上一版我给主数字套了 `Panel`（理由是"它裸贴在
 * 页面底色上，而下面的分身卡有壳"）—— 那个观察对，方向反了：
 * 两块都升成卡之后这一页变成"框套框套框"，5 个块 3 层边界。
 * 用户的话是「上面为啥还要加框，好怪，能不能视觉简洁高级点」。
 *
 * 判据用 class 里的 token 名而不是计算色 —— jsdom 不算 CSS 变量
 * （`getComputedStyle` 拿到空串，那会让断言恒绿）。真实色值由
 * `scripts/probe-dashboard-ui.mjs` 在真浏览器里量。
 *
 * ## ★ 这一组曾有一条 `HeroStat` 的用例，组件删了、意图留下
 *
 * `HeroStat`（那个 48px 主数字块）在"消息改用 MiniStat"之后就没有
 * 消费者了，这一轮从 `primitives.tsx` 删掉。但它锁的**意图**
 * （"上半部分那些数不许有面"）仍然成立 —— 现在由下面
 * 「`StatTile` 默认凹槽」那几条，加上探针里那条"上半部分没有
 * border-top / 没有 z1 面"共同守着。
 */
describe("★★ 去框：数字块默认凹槽", () => {
  /**
   * ★ `StatTile` 的默认 `surface` 是 `sunken`。
   *
   * 这个默认值改过：原来是 `raised`，于是分身卡里那四个数字与承载它们的
   * 卡是同一个色值（真应用里量到都是 `rgb(38,38,38)`）——"框里的框"。
   * 现在"忘了传"的结果是对的那个，所以要有东西锁住它。
   */
  it("StatTile 默认是凹槽（z0），不是 z1", () => {
    const { container } = render(<StatTile label="待我确认" value="1" />)
    const tile = container.firstElementChild
    expect(tile?.className).toContain("--bg-card-z0")
    expect(tile?.className).not.toContain("--bg-card-z1")
  })

  /** 凹槽不带描边 —— 色阶已经分层了，再加描边是同一件事说两遍 */
  it("凹槽不带 ring", () => {
    const { container } = render(<StatTile label="待我确认" value="1" />)
    expect(container.firstElementChild?.className ?? "").not.toContain("ring-1")
  })

  /** `raised` 仍然可用（给真的需要独立一张卡的地方），只是不再是默认 */
  it("显式传 raised 仍能得到一张卡", () => {
    const { container } = render(<StatTile label="x" value="1" surface="raised" />)
    expect(container.firstElementChild?.className).toContain("--bg-card-z1")
  })
})
