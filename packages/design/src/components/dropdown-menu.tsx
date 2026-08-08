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
          className={cn(
            "absolute z-50 min-w-[220px] radius-lg p-1",
            "border border-[var(--border-light)] bg-[var(--bg-pop)] shadow-[var(--shadow-lg)]",
            side === "top" ? "bottom-full mb-1" : "top-full mt-1",
            align === "start" ? "left-0" : "right-0",
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
