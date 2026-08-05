/**
 * 主题色（accent）。
 *
 * ## ★ 为什么这组断言的重点是**对比度**
 *
 * 「主题色支持黄色」听起来是纯风格需求，但黄色有一个硬约束：
 * 亮黄在白底上实测只有 **1.40:1** 的对比度（WCAG 正文要求 ≥4.5:1）——
 * 也就是说如果直接用亮黄做强调色，**链接与选中态的文字会看不见**。
 *
 * 那不是"风格偏淡"，是缺陷；而它的表现很隐蔽：
 * 开发者在自己的屏幕上（往往亮度高、对比好）可能觉得"能看"，
 * 而用户在阳光下或低端屏上完全读不到。所以这条必须是断言而不是约定。
 *
 * 断言的是**编译后的 CSS 变量值**而不是源码里的字面量：
 * 真正决定颜色的是最终产物，源码可能被 postcss/主题层再改一次。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const PRIMITIVES = readFileSync(
  join(import.meta.dirname, "../../../packages/design/src/styles/primitives.css"),
  "utf8",
)

/** WCAG 相对亮度。 */
function luminance(hex: string): number {
  const value = hex.replace("#", "")
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
  )
  const linear = channels.map((c) => (c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

/** 从 primitives.css 里取某个主题块的某一阶。 */
function readStep(selector: string, step: number): string {
  const start = PRIMITIVES.indexOf(selector)
  expect(start, `找不到 ${selector}`).toBeGreaterThan(-1)
  const block = PRIMITIVES.slice(start, PRIMITIVES.indexOf("}", start))
  const match = new RegExp(`--brand-brand-${step}:\\s*(#[0-9a-f]{6})`, "i").exec(block)
  expect(match, `${selector} 缺 --brand-brand-${step}`).not.toBeNull()
  return (match as RegExpExecArray)[1] as string
}

/** 亮色主题的内容区底色（semantic.css 的 --bg-base-normal）。 */
const LIGHT_BG = "#fcfcfc"
/** 暗色主题的内容区底色。 */
const DARK_BG = "#1f1f1f"

/**
 * 三套主题色：蓝（默认，值在 `:root`）/ 黄 / 紫。
 *
 * ★ 曾经有四套，其中 `ink` 与 `blue` 都是蓝 —— 用户分不出那两个有什么
 * 区别，而"看起来有得选实际是同一个"是选择器最糟的形态。合并之后
 * 默认那一套就是蓝，它的值只写在 `:root`（唯一真源）。
 */
const THEMES = [
  { name: "蓝（默认，:root）", selector: ":root {" },
  { name: "黄", selector: ':root[data-accent="amber"]' },
  { name: "紫", selector: ':root[data-accent="violet"]' },
] as const

describe("★★ 每套主题色在白底上都要可读（WCAG AA）", () => {
  it.each(THEMES)("$name 的 -60 对白底 ≥ 4.5:1", ({ selector }) => {
    const color = readStep(selector, 60)
    const ratio = contrast(color, LIGHT_BG)
    expect(
      ratio,
      `${color} 对 ${LIGHT_BG} 只有 ${ratio.toFixed(2)}:1 —— ` +
        `强调色文字会读不清（亮黄 #ffd400 实测 1.40:1 就是这个陷阱）`,
    ).toBeGreaterThanOrEqual(4.5)
  })

  it.each(THEMES)("$name 的 -40 对暗底 ≥ 4.5:1（暗色主题用这一阶）", ({ selector }) => {
    const color = readStep(selector, 40)
    expect(contrast(color, DARK_BG)).toBeGreaterThanOrEqual(4.5)
  })

  /**
   * 探针的负例。
   *
   * 不测这条，`contrast()` 写错（比如把公式搞反）会让上面几条
   * **静默永远通过** —— 而"断言是空的"与"断言通过"外观完全相同。
   */
  it("探针能识别出真正不可读的颜色（否则断言是空的）", () => {
    // 亮黄对白底：这是我们刻意避开的那个值
    expect(contrast("#ffd400", LIGHT_BG)).toBeLessThan(2)
    // 已知的合格值
    expect(contrast("#3563d6", LIGHT_BG)).toBeGreaterThan(4.5)
  })
})

describe("主题色的结构约束", () => {
  it("每套 accent 各有完整 12 阶（缺一阶会让某个语义 token 落空）", () => {
    for (const { selector } of THEMES) {
      for (const step of [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
        const start = PRIMITIVES.indexOf(selector)
        const block = PRIMITIVES.slice(start, PRIMITIVES.indexOf("}", start))
        expect(block, `${selector} 缺 --brand-brand-${step}`).toContain(`--brand-brand-${step}:`)
      }
    }
  })

  it("★ 低阶（0-30）是透明色（要在亮/暗两种底上都不脏）", () => {
    for (const { selector } of THEMES) {
      const start = PRIMITIVES.indexOf(selector)
      const block = PRIMITIVES.slice(start, PRIMITIVES.indexOf("}", start))
      for (const step of [0, 5, 10, 20, 30]) {
        const match = new RegExp(`--brand-brand-${step}:\\s*([^;]+);`).exec(block)
        expect(match?.[1]?.trim(), `${selector} 的 -${step} 应当是 rgba()`).toMatch(/^rgba\(/)
      }
    }
  })

  /**
   * ★ 默认色不该有自己的 `[data-accent="ink"]` 块。
   *
   * `useTheme` 选中 ink 时**删掉**属性，让默认等于"没有覆盖" ——
   * 若这里再写一份 ink 块，就有了两处定义同一套颜色，迟早漂。
   */
  it('★ 没有 [data-accent="ink"] 块（默认值只有 :root 一份）', () => {
    expect(PRIMITIVES).not.toContain('data-accent="ink"')
  })

  /**
   * ★ 默认色（blue）同样不该有自己的块。
   *
   * `useTheme` 选中默认时**删掉** `data-accent`，于是渲染出来的是
   * `:root` 那一套。如果这里还留着一份 `[data-accent="blue"]`，
   * 两份值就会各自漂 —— 而漂了的表现是"选中蓝色和默认看起来不一样"，
   * 而它们本该是同一个东西。
   */
  it('★ 没有 [data-accent="blue"] 块（默认 = :root，不是又一份拷贝）', () => {
    expect(PRIMITIVES).not.toContain('data-accent="blue"')
  })
})

describe("亮色主题的侧栏要明显比内容区灰", () => {
  const SEMANTIC = readFileSync(
    join(import.meta.dirname, "../../../packages/design/src/styles/semantic.css"),
    "utf8",
  )

  /**
   * 首版是 `#f6f6f6` 对 `#fcfcfc` —— 只差 6 个色阶，实测看起来"一样白"，
   * 于是左右分区完全靠那根 8% 黑的分隔线撑，整屏没有层次。
   */
  it("★ 侧栏与内容区的亮度差要够（不能只差几个色阶）", () => {
    const light = SEMANTIC.slice(0, SEMANTIC.indexOf('[data-theme="dark"]'))
    const sidebar = /--bg-sidebar-normal:\s*(#[0-9a-f]{6})/i.exec(light)?.[1]
    const base = /--bg-base-normal:\s*(#[0-9a-f]{6})/i.exec(light)?.[1]
    expect(sidebar).toBeDefined()
    expect(base).toBeDefined()

    const delta =
      Number.parseInt((base as string).slice(1, 3), 16) -
      Number.parseInt((sidebar as string).slice(1, 3), 16)
    expect(
      delta,
      `侧栏 ${sidebar} 与内容 ${base} 只差 ${delta} —— 看起来会一样白`,
    ).toBeGreaterThanOrEqual(10)
  })
})

/**
 * ★ 主题色的**默认值必须与 `:root` 那一套一致**。
 *
 * ## 这条锁住的是一个"选了没反应"的 bug
 *
 * `useTheme` 的机制是：选中默认时**删掉** `data-accent` 属性，
 * 于是渲染出来的是 `:root` 里那一套。这意味着 `DEFAULT_ACCENT`
 * 必须指向 `:root` 实际装的那个颜色。
 *
 * 写错的后果：用户看到"选中了黄色"，而界面是蓝的 —— 不报错、
 * 没有日志，只是明显不对。改这一版时我自己先写错了一次
 * （把 amber 设成默认，而 `:root` 里装的是墨蓝）。
 */
describe("★ 默认主题色与 :root 一致", () => {
  it("ACCENTS 里恰好三个，且默认是第一个", async () => {
    const module = await import("@renderer/lib/use-theme")
    expect(module.ACCENTS).toEqual(["blue", "amber", "violet"])
    expect(module.DEFAULT_ACCENT).toBe(module.ACCENTS[0])
  })

  it("★ 默认色不在 primitives.css 里有自己的块（它就是 :root）", async () => {
    const module = await import("@renderer/lib/use-theme")
    /**
     * 有块 = 有两份定义。两份会各自漂，而漂了之后"选中默认"与
     * "什么都没选"看起来不一样 —— 但它们本该是同一个东西。
     */
    expect(PRIMITIVES).not.toContain(`data-accent="${module.DEFAULT_ACCENT}"`)
  })

  it("非默认的每一个都**有**自己的块（否则那个选项点了没反应）", async () => {
    const module = await import("@renderer/lib/use-theme")
    for (const accent of module.ACCENTS) {
      if (accent === module.DEFAULT_ACCENT) continue
      expect(PRIMITIVES, `${accent} 没有对应的 CSS 块`).toContain(`data-accent="${accent}"`)
    }
  })
})
