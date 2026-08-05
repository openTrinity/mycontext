/**
 * Dialog — 模态弹窗。基于原生 `<dialog>`。
 *
 * ## 为什么用原生 `<dialog>` 而不是自己搭 portal
 *
 * 它免费给到三件**很难自己做对**的事：
 * · **top layer** —— 永远在最上层，不受祖先的 `overflow`/`z-index`/`transform`
 *   影响（自己搭 portal 时这三个都是常见的踩坑点）；
 * · **焦点陷阱** —— `showModal()` 之后 Tab 只在弹窗内循环，浏览器原生保证；
 * · **inert 背景** —— 背景内容自动不可点、不被读屏器读到。
 *
 * 自己实现这三件要几百行且容易在边缘情形失效（比如 iframe、shadow DOM）。
 *
 * ## 我们仍需要自己处理的两件
 *
 * · **Esc 关闭**：原生会触发 `cancel` 事件并关闭，但**不会**通知 React ——
 *   于是 React 的 `open` 状态与 DOM 脱同步，下次 `open=true` 时
 *   `showModal()` 报 "already open"。所以拦 `cancel` 转成 `onClose`。
 * · **点遮罩关闭**：原生 `::backdrop` 不是子元素，点它命中的是 `<dialog>` 本身。
 *   判据是「点击目标 === dialog 元素」（点内容时目标是内容节点）。
 *
 * 不引第三方 UI 库：见 avatar.tsx 同款理由。
 */
import { useEffect, useRef, type ReactNode } from "react"
import { cn } from "../lib/cn.js"

export interface DialogProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** 弹窗容器的额外类名（尺寸/圆角在这里给） */
  className?: string
  /** 无障碍标题的 id（指向弹窗内的标题节点） */
  labelledBy?: string
  /**
   * 点遮罩是否关闭。默认 true。
   * 有未保存内容的表单应传 false —— 误点遮罩丢掉输入是很糟的体验。
   */
  closeOnBackdrop?: boolean
}

export function Dialog({
  open,
  onClose,
  children,
  className,
  labelledBy,
  closeOnBackdrop = true,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  // 同步 React 的 open 与 DOM 的 open。
  //
  // ★ 必须用 showModal() 而不是设 `open` 属性：只有前者会进 top layer、
  // 建立焦点陷阱、并让背景 inert。设 `open` 属性得到的是一个**非模态**弹窗
  // （背景仍可点、Tab 会走出去）—— 而那个区别在视觉上看不出来。
  useEffect(() => {
    const node = ref.current
    if (node === null) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    const onCancel = (event: Event) => {
      // 阻止原生关闭，改由 React 状态驱动 —— 否则 DOM 与 state 脱同步。
      event.preventDefault()
      onClose()
    }
    node.addEventListener("cancel", onCancel)
    return () => node.removeEventListener("cancel", onCancel)
  }, [onClose])

  return (
    <dialog
      ref={ref}
      aria-modal="true"
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      onClick={(event) => {
        // 点遮罩：事件目标是 dialog 本身（点内容时目标是内容节点）。
        if (closeOnBackdrop && event.target === ref.current) onClose()
      }}
      /*
        原生 dialog 默认有 margin:auto + border + padding，且 ::backdrop 是黑色半透明。
        这里全部清掉，由调用方通过内层容器控制外观。

        ## ★ 不要在这里写 `bg-transparent`

        它与调用方传进 `className` 的 `bg-*` 是**同等特异性**（都是单个类），
        所以谁赢由**样式表里的先后顺序**决定，而不是 props 的顺序 ——
        实测 Tailwind 把 `.bg-transparent` 排在 `.bg-[var(--bg-base-normal)]`
        之后，于是调用方的背景被吃掉、弹窗**整个变透明**（背景内容透出来）。

        这类冲突不会报错、在小 diff 里也看不出来。所以规则是：
        **容器只负责"清掉浏览器默认"，一切可见外观交给内层。**
        背景色由 children 的根节点给（见 SettingsDialog）。
      */
      className={cn(
        "m-auto max-h-none max-w-none overflow-hidden border-0 p-0",
        "backdrop:bg-[var(--bg-page-mask)] backdrop:opacity-50",
        className,
      )}
    >
      {/*
        内容只在 open 时挂载：弹窗里常有查询与订阅，关闭后仍挂着会持续拉数据。
        （原生 dialog 关闭只是隐藏，不卸载子树。）
      */}
      {open ? children : null}
    </dialog>
  )
}
