/**
 * @vitest-environment jsdom
 *
 * DropdownMenu 的**定位不许溢出视口**。
 *
 * ## 这组测试防的是一个真实 bug
 *
 * 用户报「这里 picker 被截断了」——仪表盘页头右上角那个渠道选择器展开后，
 * 菜单右侧被窗口边缘切掉。
 *
 * 成因：三个使用点（渠道 picker / 侧栏账号菜单 / Select）**全都是
 * `align="start"`**，也就是菜单左边缘对齐触发器左缘。而菜单通常**比触发器宽**
 * （下限 140px，而渠道 picker 的触发器只有 ~90px）——于是它向右多出去几十像素。
 * 那个 picker 又贴着窗口右缘，多出去的部分就跑到了窗口外。
 *
 * ★ 我第一版修错了：只给 `left`/`right` 的**起点**加 `Math.max`。
 * 而 `align="start"` 走 `left` 分支、问题在**右边缘**溢出 —— 夹起点不解决任何事
 * （`align="end"` 那个分支压根没有使用点）。这组测试就是那次错误的检测器。
 *
 * ## ★ 为什么这个组件的回归格外要紧
 *
 * 它被三处共用，其中一处是**退出登录的唯一入口**（侧栏账号菜单）。
 * 为了修一处的视觉问题而把另两处弄坏，代价远超收益 ——
 * 所以下面每条"贴边"用例都配了一条"不贴边时不动"的反证。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DropdownMenu, DropdownMenuItem } from "@mycontext/design"

afterEach(cleanup)

/** jsdom 默认视口 1024×768；这里固定住，免得依赖环境默认值。 */
const VIEWPORT_WIDTH = 1024

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: VIEWPORT_WIDTH, configurable: true })
})

/**
 * 渲染一个菜单，并让触发器的 `getBoundingClientRect` 返回指定位置。
 *
 * ★ 必须 mock 那个方法：jsdom 里所有元素的 rect 都是全零，
 * 而这个组件的定位**完全**基于实测 rect —— 不给的话每条用例都在测 0。
 */
function openAt(box: { left: number; width: number }): HTMLElement {
  render(
    <DropdownMenu
      align="start"
      side="bottom"
      trigger={(props) => (
        <button
          {...props}
          data-testid="trigger"
          ref={(node) => {
            props.ref(node)
            if (node === null) return
            node.getBoundingClientRect = () =>
              ({
                left: box.left,
                right: box.left + box.width,
                top: 40,
                bottom: 68,
                width: box.width,
                height: 28,
                x: box.left,
                y: 40,
                toJSON: () => ({}),
              }) as DOMRect
          }}
        >
          触发器
        </button>
      )}
    >
      <DropdownMenuItem onSelect={() => undefined}>钉钉</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => undefined}>飞书</DropdownMenuItem>
    </DropdownMenu>,
  )
  fireEvent.click(screen.getByTestId("trigger"))
  return screen.getByRole("menu")
}

/** 从 style 里读出一个像素值（`"123px"` → 123）。 */
function px(value: string): number {
  return Number.parseFloat(value.replace("px", ""))
}

describe("★★★ 浮层不许溢出视口", () => {
  /**
   * ★★★ 这一条就是用户报的那个形态：触发器贴着右缘。
   *
   * 触发器宽 90（渠道 picker 的实测值）、右缘离视口只剩 14px，
   * 而菜单下限 140px —— 左对齐的话右边缘会到 `920+140=1060 > 1024`。
   */
  it("★★★ 触发器贴右缘时，菜单整体左移而不是溢出", () => {
    const menu = openAt({ left: 920, width: 90 })
    const left = px(menu.style.left)
    const width = px(menu.style.minWidth)
    // 核心断言：右边缘在视口内（留 8px 边）
    expect(left + width).toBeLessThanOrEqual(VIEWPORT_WIDTH - 8)
    // ★ 而且它确实被移动过（不是恰好没溢出）
    expect(left).toBeLessThan(920)
  })

  /**
   * ★ 反证：触发器**不贴边**时位置不动 —— 那才是 `align="start"` 的意义。
   *
   * 少了这条，把 `left` 恒设成 8 也会让上面那条通过，而那会让所有菜单
   * 都跑到窗口最左边（包括侧栏账号菜单）。
   */
  it("★ 不贴边时严格对齐触发器左缘（不能一律左移）", () => {
    const menu = openAt({ left: 200, width: 90 })
    expect(px(menu.style.left)).toBe(200)
  })

  /**
   * ★ 触发器贴**左**缘时不能被推到负坐标。
   *
   * 这一条对应侧栏账号菜单（它在最左侧）。`Math.max(VIEWPORT_MARGIN, …)`
   * 那一层就是为它留的。
   */
  it("★ 贴左缘时不出现负坐标（侧栏账号菜单在最左）", () => {
    const menu = openAt({ left: 0, width: 90 })
    expect(px(menu.style.left)).toBeGreaterThanOrEqual(0)
  })

  /**
   * ★★ 菜单**不窄于触发器** —— 宽触发器（账号菜单）的行为不能被改坏。
   */
  it("★★ 宽触发器：菜单不比它窄", () => {
    const menu = openAt({ left: 20, width: 240 })
    expect(px(menu.style.minWidth)).toBeGreaterThanOrEqual(240)
  })

  /**
   * ★ 上限仍然生效：`fixed` 定位让包含块变成视口，没有上限时长文本
   * 会把菜单撑到大半个窗口（账号菜单实测发生过）。
   */
  it("★ 宽度有上限（否则长文本会把菜单撑到大半个窗口）", () => {
    const menu = openAt({ left: 20, width: 90 })
    expect(px(menu.style.maxWidth)).toBeLessThanOrEqual(VIEWPORT_WIDTH - 24)
  })
})
