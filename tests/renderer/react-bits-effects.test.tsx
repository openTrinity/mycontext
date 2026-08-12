/**
 * @vitest-environment jsdom
 *
 * React Bits 三个自写特效的**回退契约**。
 *
 * ## 这一组锁的不是"动效好不好看"，是"动效不能吞掉内容/静默失败"
 *
 * 三个特效都在真文字/真功能之上盖了一层视觉。最容易静默出错的是**回退**：
 *
 * · `ParticleText` 用 canvas 画字 —— canvas 对读屏是一张图，真文字必须仍在
 *   DOM 里（`sr-only`），否则问候语对读屏用户直接消失，而界面上"看起来正常"；
 * · `ShuffleText` 滚动时每个位是随机字形 —— 真文字同样必须留着给读屏/选中；
 * · `prefers-reduced-motion` 时三者都要退成**静态**（无障碍惯例 + 前庭敏感），
 *   而不是"照样动一下再停"；
 * · `SplashCursor` 依赖 WebGL2 + 浮点目标 —— 拿不到时必须**优雅退场**
 *   （不画、回调 onUnsupported），而不是画一块黑或抛异常把整个空态带塌。
 *
 * 这些都不会让 lint/tsc 报错，评审也看不出来 —— 只有断言能锁住（CLAUDE.md §4）。
 *
 * ## ★ 为什么 mock framer-motion 的 useReducedMotion 而不是打桩 matchMedia
 *
 * framer-motion 的 `useReducedMotion` 在**模块级**缓存了一个 MediaQueryList
 * 单例，首次调用后再改 `window.matchMedia` 不生效（同一进程里别的用例先把它
 * 初始化成 false 了）。所以直接 mock 这个 hook，用一个可控开关切回退分支。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import type * as FramerMotion from "framer-motion"

/** 可控的"减少动效"开关；mock 的 useReducedMotion 读它。 */
let reducedMotion = false

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof FramerMotion>()
  return { ...actual, useReducedMotion: () => reducedMotion }
})

// import 必须在 mock 之后（vi.mock 被提升，这里只是语义清晰）。
const { ShuffleText } = await import("@mycontext/design")
const { ParticleText } = await import("@renderer/features/dashboard/particle-text")
const { SplashCursor } = await import("@renderer/features/graph/splash-cursor")

beforeEach(() => {
  reducedMotion = false
})
afterEach(cleanup)

describe("★★ 无障碍：真文字永远在 DOM 里", () => {
  /**
   * ★ ParticleText 动画态下把字画到 canvas，但真文字必须仍可被读屏/选中。
   * 反证：删掉那层 `sr-only` 真文字，这条转红 —— 那正是"问候语对读屏消失"。
   */
  it("ParticleText 动画态：canvas 之外仍有完整文字", () => {
    reducedMotion = false
    const { container } = render(<ParticleText text="下午好，小王" />)
    expect(container.textContent ?? "").toContain("下午好，小王")
    // 动画态确实挂了 canvas（否则就是走了回退，这条断言就名不副实）
    expect(container.querySelector("canvas")).not.toBeNull()
  })

  it("ShuffleText 动画态：滚动层之外仍有完整文字", () => {
    reducedMotion = false
    const { container } = render(<ShuffleText text="MyContext" />)
    expect(container.textContent ?? "").toContain("MyContext")
  })
})

describe("★★ prefers-reduced-motion：退成静态", () => {
  /**
   * ★ reduced-motion 时 ParticleText **不画 canvas**，直接渲染那行字。
   * 反证：若回退分支没了，canvas 会出现，这条转红。
   */
  it("ParticleText：不出现 canvas，只剩静态文字", () => {
    reducedMotion = true
    const { container } = render(<ParticleText text="下午好，小王" />)
    expect(container.querySelector("canvas")).toBeNull()
    expect(container.textContent ?? "").toBe("下午好，小王")
  })

  it("ShuffleText：静态文字，无滚动层", () => {
    reducedMotion = true
    const { container } = render(<ShuffleText text="MyContext" />)
    // 静态态整块就一个文本节点，不该有"钉宽度 + 滚动层 + sr-only"三层
    expect(container.textContent).toBe("MyContext")
    expect(container.querySelectorAll("span").length).toBeLessThanOrEqual(1)
  })

  /**
   * ★★ SplashCursor：reduced-motion 时**根本不渲染画布**（返回 null）。
   * 它是背景特效，静态态下应完全让位给上层的说明文字与「建图」按钮。
   */
  it("SplashCursor：reduced-motion 时不渲染任何东西（返回 null）", () => {
    reducedMotion = true
    const { container } = render(<SplashCursor />)
    expect(container.querySelector("canvas")).toBeNull()
    expect(container.firstChild).toBeNull()
  })
})

describe("★★ SplashCursor：拿不到 WebGL2 时优雅退场", () => {
  /**
   * jsdom 没有 WebGL —— `getContext('webgl2')` 返回 null。
   * 这正好模拟了"环境不支持"：必须回调 onUnsupported 且**不抛异常**，
   * 而不是画一块黑或让整个空态崩掉（本仓库最忌讳的静默/硬失败）。
   */
  it("无 WebGL2：回调 onUnsupported，不抛异常", () => {
    reducedMotion = false
    const onUnsupported = vi.fn()
    expect(() => render(<SplashCursor onUnsupported={onUnsupported} />)).not.toThrow()
    expect(onUnsupported).toHaveBeenCalledTimes(1)
  })
})

/**
 * ── 主题变了必须重画（暗色下那行字曾经是黑的）────────────────────
 *
 * 用户报："暗色主题 greeting 文本用的 particle 是黑色基调就不行"。
 *
 * 成因不在颜色取值，而在 **effect 依赖**：颜色是从
 * `getComputedStyle(probe).color` 读的，而 `className` 里写的是
 * `text-[var(--text-base-primary)]` —— 切主题时**那个字符串一个字都不变**，
 * 变的是 CSS 变量的值。于是 effect 不重跑，canvas 保留上一次（亮色）画好的
 * 黑字，而背景已经变暗。
 *
 * 判据是"`data-theme` 变了之后有没有重新画" —— jsdom 里没有真 canvas
 * （`getContext` 未实现），所以断言落在**重绘被触发**这件事上：
 * 组件必须响应 `documentElement` 上那个属性的变化。
 */
describe("★★ 主题切换：ParticleText 必须重画（否则暗色下是黑字）", () => {
  it("data-theme 变化会触发重新读取样式", async () => {
    document.documentElement.dataset["theme"] = "light"
    const { container } = render(<ParticleText text="早上好" />)
    const canvas = container.querySelector("canvas")
    expect(canvas).not.toBeNull()

    /**
     * 判据：数 `canvas.getContext` 被调了几次 —— 那是绘制 effect 的**入口**。
     *
     * ## ★ 为什么不数 `getComputedStyle`（我第一版那样写，红了）
     *
     * jsdom 没实现 `getContext`，于是 effect 在 `ctx === null` 处**提前
     * return**，压根走不到读样式那一步。判据必须落在**提前 return 之前**
     * 的那个调用上，否则它在这个环境里恒不成立 —— 那是"断言的前提没成立"，
     * 不是被测行为错了。
     *
     * 反证：把 `themeMode` 从 effect 依赖里去掉（＝修复前的
     * `[text, className, reduced]`），切主题后这个计数不再增长 → 红。
     * 而红之前的状态正是用户看到的"暗色下黑字"。
     */
    const spy = vi.spyOn(canvas as HTMLCanvasElement, "getContext")
    const before = spy.mock.calls.length
    await act(async () => {
      document.documentElement.dataset["theme"] = "dark"
      // MutationObserver 回调是微任务级的，让它跑完再断言
      await Promise.resolve()
    })
    expect(spy.mock.calls.length).toBeGreaterThan(before)
    spy.mockRestore()
  })
})
