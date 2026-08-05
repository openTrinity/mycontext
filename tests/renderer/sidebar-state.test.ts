/**
 * @vitest-environment jsdom
 *
 * 侧边栏状态的行为测试。
 *
 * 覆盖「两种展开方式」的关键路径与那些容易在重构中被弄坏的细节：
 * preventHovering 的抑制与解除、浮层随鼠标位置自动收回、宽度 clamp 与持久化。
 */
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarState,
} from "@renderer/lib/use-sidebar-state"

/** 宽窗口：默认允许 hover 浮层 */
function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true })
}

/** 模拟鼠标移动到某个横向位置（target 默认是 document.body，即侧栏之外） */
function moveMouseTo(clientX: number, target?: Element): void {
  act(() => {
    const event = new MouseEvent("mousemove", { clientX, bubbles: true })
    ;(target ?? document.body).dispatchEvent(event)
  })
}

/** 造一个带 data-sidebar-panel 的元素，模拟「鼠标位于浮层内部」 */
function panelChild(): Element {
  const panel = document.createElement("aside")
  panel.setAttribute("data-sidebar-panel", "")
  const child = document.createElement("button")
  panel.appendChild(child)
  document.body.appendChild(panel)
  return child
}

beforeEach(() => {
  localStorage.clear()
  setWindowWidth(1400)
})

afterEach(() => {
  cleanup()
})

describe("初始状态", () => {
  it("默认展开、用默认宽度", () => {
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.collapsed).toBe(false)
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(result.current.visible).toBe(true)
    expect(result.current.floating).toBe(false)
  })

  it("从 localStorage 恢复折叠状态与宽度", () => {
    localStorage.setItem("mycontext.sidebar.collapsed", "true")
    localStorage.setItem("mycontext.sidebar.width", "300")
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.collapsed).toBe(true)
    expect(result.current.width).toBe(300)
    expect(result.current.visible).toBe(false)
  })

  it("localStorage 里的宽度非法时回落到默认值", () => {
    localStorage.setItem("mycontext.sidebar.width", "not-a-number")
    expect(renderHook(() => useSidebarState()).result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})

describe("方式 A：固定展开 / 收起", () => {
  it("toggle 在两态间切换并持久化", () => {
    const { result } = renderHook(() => useSidebarState())

    act(() => result.current.toggle())
    expect(result.current.collapsed).toBe(true)
    expect(localStorage.getItem("mycontext.sidebar.collapsed")).toBe("true")

    act(() => result.current.toggle())
    expect(result.current.collapsed).toBe(false)
    expect(localStorage.getItem("mycontext.sidebar.collapsed")).toBe("false")
  })

  it("展开态下 visible 为 true 且不是浮层", () => {
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.visible).toBe(true)
    expect(result.current.floating).toBe(false)
  })
})

describe("方式 B：hover 浮层预览", () => {
  it("收起态 hover 进入浮层，且不改变 collapsed", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle())
    // toggle 收起时会置抑制标记，先让鼠标离开解除它
    act(() => result.current.releaseHoverSuppression())

    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(true)
    expect(result.current.visible).toBe(true)
    // 关键：浮层预览不应把 collapsed 改掉，否则「临时」就变成「固定」了
    expect(result.current.collapsed).toBe(true)
  })

  it("展开态 hover 不产生浮层", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(false)
  })

  it("endHover 收回浮层", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle())
    act(() => result.current.releaseHoverSuppression())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(true)

    act(() => result.current.endHover())
    expect(result.current.floating).toBe(false)
  })

  it("鼠标横向移出侧栏范围后自动收回", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle())
    act(() => result.current.releaseHoverSuppression())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(true)

    // 仍在侧栏 + 容差内：保持浮出
    moveMouseTo(result.current.width + 10)
    expect(result.current.floating).toBe(true)

    // 超出容差：收回
    moveMouseTo(result.current.width + 100)
    expect(result.current.floating).toBe(false)
  })

  it("鼠标位于浮层内部时保持展开（即使坐标已超出阈值）", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle())
    act(() => result.current.releaseHoverSuppression())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(true)

    // 坐标远超阈值，但事件来自浮层内部 → 不应收回
    // （展开动画期间浮层实际宽度小于目标宽度，纯坐标判定会误杀）
    moveMouseTo(9999, panelChild())
    expect(result.current.floating).toBe(true)
  })

  it("窄窗口（<=768）禁用 hover 浮层", () => {
    setWindowWidth(600)
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle())
    act(() => result.current.releaseHoverSuppression())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(false)
    expect(result.current.visible).toBe(false)
  })
})

describe("preventHovering：收起后不立刻回弹", () => {
  it("点收起后紧接着 hover 不触发浮层（鼠标仍停在按钮上）", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle())

    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(false)
  })

  it("鼠标离开后抑制解除，再次 hover 正常浮出", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(false)

    // 鼠标移开 → 解除抑制
    act(() => result.current.releaseHoverSuppression())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(true)
  })

  it("releaseHoverSuppression 不关闭已展开的浮层（否则浮层盖住按钮就会抖动）", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle())
    act(() => result.current.releaseHoverSuppression())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(true)

    // 浮层展开后会盖住触发按钮，浏览器随即派发 mouseleave —— 不应关闭浮层
    act(() => result.current.releaseHoverSuppression())
    expect(result.current.floating).toBe(true)
  })

  it("由收起转展开时不设置抑制（下次收起后才需要）", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle()) // 收起，设抑制
    act(() => result.current.releaseHoverSuppression()) // 解除
    act(() => result.current.toggle()) // 展开，不应设抑制
    act(() => result.current.toggle()) // 再收起
    act(() => result.current.releaseHoverSuppression())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(true)
  })
})

describe("pin：浮层升级为固定展开", () => {
  it("pin 后 collapsed 为 false、不再是浮层", () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.toggle())
    act(() => result.current.releaseHoverSuppression())
    act(() => result.current.beginHover())
    expect(result.current.floating).toBe(true)

    act(() => result.current.pin())
    expect(result.current.collapsed).toBe(false)
    expect(result.current.floating).toBe(false)
    expect(result.current.visible).toBe(true)
    expect(localStorage.getItem("mycontext.sidebar.collapsed")).toBe("false")
  })
})

describe("宽度", () => {
  it("clamp 到允许区间", () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(260)).toBe(260)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it("setWidth 生效并持久化，超范围被 clamp", () => {
    const { result } = renderHook(() => useSidebarState())

    act(() => result.current.setWidth(320))
    expect(result.current.width).toBe(320)
    expect(localStorage.getItem("mycontext.sidebar.width")).toBe("320")

    act(() => result.current.setWidth(10_000))
    expect(result.current.width).toBe(SIDEBAR_MAX_WIDTH)
  })
})
