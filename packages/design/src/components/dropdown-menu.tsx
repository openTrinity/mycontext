/**
 * DropdownMenu — 触发器 + 浮层菜单。
 *
 * ## 键盘可达是必需的，不是加分项
 *
 * 这个组件承载「设置 / 主题 / 语言 / 退出登录」——**退出登录只能从这里进**。
 * 一个只能用鼠标点的菜单意味着键盘用户无法登出。
 *
 * 实现的四件事：
 * · `↓`/`↑` 在项间移动（循环）；
 * · `Esc` 关闭并把焦点还给触发器（不还的话焦点掉到 body，Tab 会从页首重新开始）；
 * · `Enter`/`Space` 激活当前项；
 * · 打开时焦点移到第一项（而不是留在触发器上 —— 那样按 ↓ 才动，多一步）。
 *
 * ## 为什么不用原生 `<dialog>`（与 Dialog 组件不同）
 *
 * 菜单要**贴着触发器**定位，而 top layer 里的元素脱离了正常流，
 * 得自己算坐标并跟随滚动/窗口尺寸变化。菜单是轻量浮层、生命周期短，
 * 用绝对定位 + 点外部关闭更简单可靠。
 *
 * 不引第三方 UI 库：见 avatar.tsx 同款理由。
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { cn } from "../lib/cn.js"

/**
 * 浮层到视口边缘的最小间距。
 *
 * ★ 有它是因为触发器可能本身就贴着窗口边（渠道选择器在右上角，
 * 实测离右缘只剩 ~8px）—— 那时按 `align` 严格对齐会让浮层看起来被切掉。
 */
const VIEWPORT_MARGIN = 8

/** 浮层下限（见 `menuMinWidth`）。 */
const MENU_MIN_WIDTH = 140

/** 浮层的偏好宽度上限（见 `menuMaxWidth`）。 */
const MENU_PREFERRED_WIDTH = 280

/**
 * 浮层的**实际**宽度（用于把它夹进视口）。
 *
 * ★ 与下面 style 里的 `minWidth` / `maxWidth` **同源**：三处各算一遍
 * 迟早分叉，而分叉的表现是"夹的位置不对、仍然溢出一点"。
 *
 * 取 `min(maxWidth, max(minWidth, 触发器宽))` —— 也就是浮层在没有内容
 * 撑宽时的稳定宽度。内容更宽时由 `maxWidth` 兜住，而那个值本身已经
 * 减过视口留边，所以不会溢出。
 */
function menuWidth(rect: { triggerWidth: number }): number {
  return Math.min(menuMaxWidth(rect), menuMinWidth(rect))
}

/**
 * 下限：不窄于触发器，且至少放得下一行短文本。
 *
 * 140px 是给"图标 + 两字渠道名 + 勾选标记"留的 —— 再窄会让它们挤在一起。
 */
function menuMinWidth(rect: { triggerWidth: number }): number {
  return Math.max(rect.triggerWidth, MENU_MIN_WIDTH)
}

/**
 * 上限：不超过 280px，也不超过视口留边。
 *
 * ★ 有上限是因为 `fixed` 定位让包含块变成**视口**（而不是父容器），
 * 于是长文本（邮箱、组织名）不再换行、菜单能横向撑到大半个窗口 ——
 * 实测账号菜单发生过这个。
 */
function menuMaxWidth(rect: { triggerWidth: number }): number {
  return Math.min(Math.max(rect.triggerWidth, MENU_PREFERRED_WIDTH), window.innerWidth - 24)
}

export interface DropdownMenuProps {
  /** 触发器。收到 props 后要自己渲染成可聚焦元素 */
  trigger: (props: {
    ref: (node: HTMLButtonElement | null) => void
    onClick: () => void
    "aria-expanded": boolean
    "aria-haspopup": "menu"
    "aria-controls": string
  }) => ReactNode
  children: ReactNode
  /** 浮层对齐方向。默认贴底、左对齐 */
  align?: "start" | "end"
  side?: "top" | "bottom"
  className?: string
}

/** 可聚焦的菜单项选择器。`[hidden]` 与 disabled 的项要排除在导航之外。 */
const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"]):not([hidden])'

/**
 * 让菜单项能关闭菜单，而不必把 `close` 一路透传到每个 `DropdownMenuItem`。
 *
 * ★ 这是修一个真实 bug：选中一项后菜单**不会自己关**。点"设置"打开设置弹窗后，
 * 这个菜单还浮在弹窗背后——因为点击发生在菜单**内部**，触发不了"点外部关闭"，
 * 而选中逻辑里又没有 close。结果是弹窗关掉后菜单还开着。
 *
 * 默认关闭是菜单的标准语义（选完即收）。个别需要"选中不关"（如多选）的项
 * 可以显式传 `closeOnSelect={false}` 覆盖。
 */
const DropdownCloseContext = createContext<(() => void) | null>(null)

export function DropdownMenu({
  trigger,
  children,
  align = "start",
  side = "top",
  className,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  /** 关闭并把焦点还给触发器（见文件头）。 */
  const close = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  // 打开后把焦点移到第一项。
  useEffect(() => {
    if (!open) return
    const first = menuRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)
    first?.focus()
  }, [open])

  // 点外部关闭。用 pointerdown 而不是 click：
  // click 在按下与释放之间如果 DOM 变了会丢事件（拖拽选中文字时常见）。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target === null) return
      if (menuRef.current?.contains(target) === true) return
      if (triggerRef.current?.contains(target) === true) return
      // 点外部时**不**把焦点抢回触发器：用户的意图是去点别的地方。
      close(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  /**
   * ★★ 浮层坐标。**`fixed` 定位挂在视口坐标系上**，而不是 `absolute` 贴容器。
   *
   * ## 为什么必须这样
   *
   * `absolute` 的浮层会被任何 `overflow: hidden` 的祖先裁掉。实测：搜索的
   * 输入框（Composer）外框正是 `overflow: hidden`，而菜单展开后底部 69px
   * 直接被切掉 —— 看起来就是"输入框渲染错乱"。
   *
   * 换 `fixed` 之后它脱离所有滚动/裁剪容器，代价是要自己算坐标（下面那段）
   * 并在窗口尺寸/滚动变化时重算。
   */
  const [rect, setRect] = useState<{
    top: number
    left: number
    right: number
    triggerWidth: number
  } | null>(null)

  /**
   * 每次打开都按触发器的**实测**位置算一遍。
   *
   * ★ 不缓存：触发器可能因为布局变化挪位（侧栏折叠、窗口缩放），
   * 而一个记在 state 里的旧坐标会让菜单飘在别处。
   */
  useEffect(() => {
    if (!open) {
      setRect(null)
      return
    }
    const measure = () => {
      const node = triggerRef.current
      if (node === null) return
      const box = node.getBoundingClientRect()
      setRect({
        // side=top 时用触发器上缘（下面按 translateY(-100%) 反推），否则用下缘
        top: side === "top" ? box.top : box.bottom,
        left: box.left,
        right: window.innerWidth - box.right,
        /**
         * ★★ 触发器宽度 —— 浮层的 `max-width` 要参考它。
         *
         * `absolute` 时浮层的包含块是**父容器**（如侧栏 365px），文字自然在
         * 那个宽度里换行。改成 `fixed` 之后包含块变成**视口**（2000px），
         * 于是长文本（邮箱、组织名）不再换行，菜单横向撑得极宽 ——
         * 实测账号菜单从一列变成横跨大半个窗口。
         *
         * 用"触发器宽度与一个上限里取大的那个"：既不比触发器窄（对齐好看），
         * 也不会因为一条长文本无限变宽。
         */
        triggerWidth: box.width,
      })
    }
    measure()
    // 滚动用捕获阶段：触发器可能在某个内部滚动容器里
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [open, side])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])]
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    const delta = event.key === "ArrowDown" ? 1 : -1
    // 循环：到底再按 ↓ 回到第一项（比"卡住"更符合菜单的预期）
    const next = items[(current + delta + items.length) % items.length]
    next?.focus()
  }

  return (
    <div className="relative">
      {trigger({
        ref: (node) => {
          triggerRef.current = node
        },
        onClick: () => setOpen((value) => !value),
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-controls": menuId,
      })}
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          onKeyDown={onKeyDown}
          /**
           * ★★ 必需：本组件可能位于窗口**拖拽区**内（页头就是）。
           *
           * 拖拽区里的鼠标事件由系统窗口管理器接管 —— 于是浮层虽然画出来了，
           * 但**点不动**（实测：菜单能展开，点任何一项都没反应）。
           * `globals.css` 里那条 `[data-window-drag] [data-no-drag]` 规则
           * 会把它退出拖拽区。
           *
           * ★ 触发器有 `no-drag` 是不够的：它只覆盖按钮自己那几十像素，
           * 而浮层是 `absolute` 定位、超出触发器的范围 —— 超出的那部分
           * （也就是全部菜单项）仍在拖拽区上。
           */
          data-no-drag
          style={
            rect === null
              ? // 还没量到（首帧）：先藏起来，避免在左上角闪一下
                { visibility: "hidden" }
              : {
                  top: rect.top,
                  /**
                   * ★★★ 对齐之后还要**夹进视口** —— 否则宽于触发器的菜单会溢出。
                   *
                   * ## 这一条修的是"picker 被截断"
                   *
                   * 三个使用点（渠道 picker / 账号菜单 / Select）**全都是
                   * `align="start"`**，也就是菜单左边缘对齐触发器左缘。而菜单
                   * 通常比触发器宽（`minWidth` 至少 140px，渠道 picker 的触发器
                   * 只有 ~90px）——于是它向**右**多出去几十像素。
                   *
                   * 仪表盘那个 picker 在页头右上角、离窗口右缘只剩十几像素，
                   * 于是多出去的部分直接跑到窗口外，视觉上就是"被切了一刀"
                   * （用户截图）。
                   *
                   * ★ 我第一版只给 `left`/`right` 的**起点**加了 `Math.max`，
                   * 那是错的：`align="start"` 走的是 `left` 分支，而问题在
                   * **右边缘**溢出 —— 起点本来就够靠左，夹它不解决任何事。
                   * （而 `align="end"` 那个分支压根没有使用点。）
                   *
                   * 正确的判据是"菜单的**右边缘**不能超过视口右缘减留边"，
                   * 超了就把它整体左移。这对其余两个使用点是无害的：
                   * 侧栏账号菜单与 Select 都在左侧/中部，`Math.min` 不生效。
                   */
                  ...(align === "start"
                    ? {
                        left: Math.max(
                          VIEWPORT_MARGIN,
                          Math.min(
                            rect.left,
                            window.innerWidth - VIEWPORT_MARGIN - menuWidth(rect),
                          ),
                        ),
                      }
                    : { right: Math.max(rect.right, VIEWPORT_MARGIN) }),
                  // side=top：把自己整体上移一个身高，从而贴在触发器上方
                  transform: side === "top" ? "translateY(calc(-100% - 4px))" : undefined,
                  marginTop: side === "top" ? undefined : 4,
                  /**
                   * ★ 限宽（见 `triggerWidth` 的注释）。取 `max(触发器宽, 280)`
                   * 并且不超过视口留边 —— 于是长文本回到换行，而窄触发器
                   * （如一个图标按钮）也不会得到一个 40px 的菜单。
                   */
                  maxWidth: menuMaxWidth(rect),
                  /**
                   * ★★ 最小宽度**跟着触发器**，而不是恒定 220px。
                   *
                   * 类名里原来写死 `min-w-[220px]`（给账号菜单那种"头像 + 名字 +
                   * 邮箱"的宽菜单定的）。而渠道选择器的触发器只有 ~90px：
                   * 菜单被强行撑到 220px，`align=end` 又把右边缘对齐到触发器
                   * 右缘，于是它整体向**左**溢出一大截 —— 而触发器本身贴着
                   * 窗口右上角，看上去就是"下拉框被切了一刀"（用户截图）。
                   *
                   * 判据改成"不窄于触发器，且至少能放下一行短文本"：
                   * 宽触发器（账号菜单）行为不变，窄触发器（图标 picker）
                   * 得到一个与自己同宽的菜单 —— 那也是对齐上最自然的结果。
                   *
                   * 140px 这个下限是给"图标 + 两字渠道名 + 勾选标记"留的：
                   * 再窄会让「钉钉」和右侧的勾挤在一起。
                   */
                  minWidth: menuMinWidth(rect),
                }
          }
          className={cn(
            // ★ fixed 而不是 absolute —— 见上面 `rect` 的注释（overflow 裁剪）
            // ★ 不写 min-w：宽度由 style 里的 minWidth 按触发器算（见那段注释）
            "fixed z-50 radius-lg p-1",
            "border border-[var(--border-light)] bg-[var(--bg-pop)] shadow-[var(--shadow-lg)]",
            className,
          )}
        >
          <DropdownCloseContext.Provider value={close}>{children}</DropdownCloseContext.Provider>
        </div>
      ) : null}
    </div>
  )
}

export interface DropdownMenuItemProps {
  onSelect?: () => void
  disabled?: boolean
  /** 左侧图标 */
  icon?: ReactNode
  /** 右侧附加内容（快捷键提示、当前值、子菜单箭头） */
  trailing?: ReactNode
  /**
   * 选中后是否关闭菜单。默认 `true`（菜单的标准语义：选完即收）。
   * 需要"选中后停留"的场景（如就地循环切换、多选）显式传 `false`。
   */
  closeOnSelect?: boolean
  children: ReactNode
  className?: string
}

export function DropdownMenuItem({
  onSelect,
  disabled = false,
  icon,
  trailing,
  closeOnSelect = true,
  children,
  className,
}: DropdownMenuItemProps) {
  const close = useContext(DropdownCloseContext)
  const handleClick = () => {
    onSelect?.()
    // 先执行动作再关：动作里若要读菜单内的状态还来得及。
    // 点外部关闭抓不到这次点击（它发生在菜单内部），所以必须在这里显式关。
    if (closeOnSelect) close?.()
  }
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled}
      disabled={disabled}
      onClick={disabled ? undefined : handleClick}
      className={cn(
        "flex w-full items-center gap-2 radius-md px-2 py-1.5 text-left",
        "typography-body-small-400 text-[var(--text-base-primary)]",
        "transition-colors duration-150 ease-out",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
        disabled
          ? "cursor-not-allowed text-[var(--text-base-disable)]"
          : "hover:bg-[var(--overlay-on-container-hover)]",
        className,
      )}
    >
      {icon === undefined ? null : (
        <span className="flex size-4 shrink-0 items-center justify-center text-[var(--text-base-secondary)]">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing === undefined ? null : (
        <span className="shrink-0 text-[var(--text-base-tertiary)]">{trailing}</span>
      )}
    </button>
  )
}

/** 分组分隔线。`role="none"` 让读屏器跳过它（它是纯视觉的）。 */
export function DropdownMenuSeparator() {
  return <div role="none" className="my-1 h-px bg-[var(--border-divider-light)]" />
}
