/**
 * 侧边栏交互状态。
 *
 * 参考项目的「两种展开方式」由三个状态组合而成，这里保留同一套语义：
 *
 *   collapsed        用户显式收起；false 时侧栏占据布局宽度（方式 A：固定展开）
 *   hovering         收起态下 hover 触发的临时浮层预览（方式 B：hover 展开）
 *   preventHovering  刚点过「收起」时抑制 hover，避免鼠标还停在按钮上就立刻又浮出来
 *
 * 派生量：
 *   floating = collapsed && hovering   浮层预览中（不占布局宽度）
 *   visible  = !collapsed || floating  侧栏内容是否应渲染
 *
 * collapsed 与 width 持久化在 localStorage（渲染层偏好，与 useTheme 同一套做法，
 * 不必进 SQLite）；hovering / preventHovering 是纯交互态，刷新即重置。
 */
import { useCallback, useEffect, useRef, useState } from "react"

const COLLAPSED_KEY = "mycontext.sidebar.collapsed"
const WIDTH_KEY = "mycontext.sidebar.width"

export const SIDEBAR_DEFAULT_WIDTH = 228
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 420

/**
 * 窄窗口下不启用 hover 浮层：浮层会盖掉大部分内容区，
 * 小屏上「预览」的价值不如直接固定展开。
 */
const HOVER_DISABLED_WIDTH = 768

/** 鼠标横向离开侧栏这么多像素后收回浮层。 */
const HOVER_EXIT_SLACK = 20

export function clampSidebarWidth(width: number): number {
  if (Number.isNaN(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)))
}

function readCollapsed(): boolean {
  return localStorage.getItem(COLLAPSED_KEY) === "true"
}

function readWidth(): number {
  const stored = localStorage.getItem(WIDTH_KEY)
  if (stored === null) return SIDEBAR_DEFAULT_WIDTH
  return clampSidebarWidth(Number.parseInt(stored, 10))
}

export interface SidebarState {
  collapsed: boolean
  width: number
  /** 浮层预览中：盖在内容之上，不占布局宽度 */
  floating: boolean
  /** 侧栏内容是否应渲染 */
  visible: boolean
  /** 顶栏按钮：收起态点击 → 固定展开；展开态点击 → 收起 */
  toggle: () => void
  /** 浮层 → 固定展开（「钉住」） */
  pin: () => void
  /** hover 进入触发区 */
  beginHover: () => void
  /**
   * 鼠标离开触发按钮：只解除「刚收起」的抑制，不关闭浮层。
   * 关闭由鼠标横向距离判定负责（见实现注释）。
   */
  releaseHoverSuppression: () => void
  /** 立即收回浮层（遮罩点击等显式动作） */
  endHover: () => void
  setWidth: (width: number) => void
}

export function useSidebarState(): SidebarState {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [width, setWidthState] = useState(readWidth)
  const [hovering, setHovering] = useState(false)
  // 用 ref 而非 state：它只在事件回调里读写，不需要触发重渲染。
  const preventHovering = useRef(false)

  const [hoverAllowed, setHoverAllowed] = useState(() => window.innerWidth > HOVER_DISABLED_WIDTH)

  useEffect(() => {
    const onResize = () => setHoverAllowed(window.innerWidth > HOVER_DISABLED_WIDTH)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  const floating = collapsed && hovering && hoverAllowed
  const visible = !collapsed || floating

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

  /**
   * 浮层态下靠鼠标横向位置自动收回。
   *
   * 用 document.mousemove 而不是浮层的 onMouseLeave：浮层展开后可能盖住顶栏的
   * 触发按钮，浏览器随即对按钮派发 mouseleave；若以此关闭就会「刚展开又收回」。
   * 距离判定与元素覆盖无关，因此不受这个问题影响。
   *
   * 两个刻意的取舍：
   * 1. 阈值用 width（目标宽度，来自 state）而不是实时测量的 DOM 宽度：
   *    展开动画进行中实测宽度还很小，用它会把停在按钮上的鼠标误判为「已离开」。
   * 2. 只有「明确移到侧栏外侧一段距离」才收回；鼠标停在浮层内或按钮上都保持展开。
   *    并且 pointerover 到浮层内部时直接续期，避免动画期间的边界抖动。
   */
  useEffect(() => {
    if (!floating) return
    const onMouseMove = (event: MouseEvent) => {
      // 鼠标仍在侧栏浮层内部（含其子元素）时一律保持展开，
      // 不依赖坐标——动画中途坐标判定不可靠。
      const target = event.target
      if (target instanceof Element && target.closest("[data-sidebar-panel]") !== null) return
      if (event.clientX > width + HOVER_EXIT_SLACK) setHovering(false)
    }
    document.addEventListener("mousemove", onMouseMove)
    return () => document.removeEventListener("mousemove", onMouseMove)
  }, [floating, width])

  const beginHover = useCallback(() => {
    if (preventHovering.current) return
    setHovering(true)
  }, [])

  /**
   * 鼠标离开触发按钮。
   *
   * 刻意「只解除抑制、不关闭浮层」：浮层一旦展开就会盖住触发按钮本身，
   * 此时浏览器会对按钮派发 mouseleave。若在这里关闭浮层，就会出现
   * 「浮层刚出来 → 盖住按钮 → 触发 leave → 立刻收回」的抖动。
   * 关闭的唯一依据是下面 useEffect 里的鼠标横向距离判定。
   */
  const releaseHoverSuppression = useCallback(() => {
    preventHovering.current = false
  }, [])

  const endHover = useCallback(() => {
    setHovering(false)
    // 鼠标已离开触发区，抑制标记的使命结束，否则下次 hover 会被无故拦掉。
    preventHovering.current = false
  }, [])

  const toggle = useCallback(() => {
    setHovering(false)
    setCollapsed((previous) => {
      // 由展开转收起时抑制 hover：此刻鼠标正停在按钮上，
      // 不抑制的话浮层会立刻弹出来，收起动作看起来像没生效。
      preventHovering.current = !previous
      return !previous
    })
  }, [])

  const pin = useCallback(() => {
    setHovering(false)
    preventHovering.current = false
    setCollapsed(false)
  }, [])

  const setWidth = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next)
    setWidthState(clamped)
    localStorage.setItem(WIDTH_KEY, String(clamped))
  }, [])

  return {
    collapsed,
    width,
    floating,
    visible,
    toggle,
    pin,
    beginHover,
    releaseHoverSuppression,
    endHover,
    setWidth,
  }
}
