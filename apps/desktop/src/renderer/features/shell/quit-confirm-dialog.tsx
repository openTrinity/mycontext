/**
 * QuitConfirmDialog —— 按 ⌘Q 时的退出确认。
 *
 * ## ★ 为什么这个框画在渲染层而不是用 `dialog.showMessageBox`
 *
 * 首版用的是原生框。它能用，但**永远长得像另一个程序**：字体、圆角、
 * 按钮排布、复选框样式全由 OS 决定，mac 上还带一个巨大的应用图标。
 * 而这是用户按 ⌘Q 时唯一看到的界面 —— 一个与设计系统毫无关系的系统灰框
 * 出现在这里，观感上就是"应用之外的东西"。
 *
 * 现在走 `shell:quit-requested` 事件让渲染层画，用与 `SettingsDialog`
 * 同一套 token（`radius-xl` + `--border-light` + `--bg-base-normal` +
 * `--shadow-lg`），于是它看起来就是这个应用的一部分。
 *
 * ## 尺寸与构图
 *
 * 400px 定宽、纵向三段（图标+标题 / 说明 / 底部一行）。
 * 不给 min-height：内容只有三行，撑高会让它显得空。
 *
 * 图标用**警示黄**而不是危险红：退出不是破坏性操作（数据都已落盘，
 * 最坏是丢一轮在途采集，靠 `payload_hash` 幂等兜住）。红色会把
 * "你要中断一些工作" 夸张成 "你要毁掉什么东西"。
 *
 * ## 三个交互约定
 *
 * · **Esc / 点遮罩 = 取消**。退出是有后果的动作，误触应当落在安全的一侧；
 * · **「退出」按钮拿默认焦点**。用户按 ⌘Q 的意图就是退出，让他能直接
 *   再按一下回车完成 —— 而不是先 Tab 找按钮。取消仍在一个 Esc 之内；
 * · **勾选状态不跨次保留**。每次打开都显式重置成"没勾" ——
 *   `<Dialog>` 的卸载帮不了我们（见组件里那个 effect 的注释）。
 */
import { useEffect, useId, useRef, useState } from "react"
import { Button, Checkbox, Dialog } from "@mycontext/design"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface QuitConfirmDialogProps {
  open: boolean
  /** 用户取消（点取消 / Esc / 点遮罩）。 */
  onCancel: () => void
  /** 用户确认退出。`dontAskAgain` 是那个复选框的状态。 */
  onConfirm: (dontAskAgain: boolean) => void
}

export function QuitConfirmDialog({ open, onCancel, onConfirm }: QuitConfirmDialogProps) {
  const { t } = useDynamicTranslation()
  const titleId = useId()
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  /*
   * 每次打开都从"没勾"开始。
   *
   * ★ 必须显式重置，不能指望 `<Dialog>` 的卸载帮我们清掉：它只卸载
   * **自己的 children**，而这个 state 住在它的父组件（也就是本组件）里，
   * 关闭时不会被销毁。少了这一段的表现是：用户上次勾了但点了取消，
   * 下次打开发现"下次不再提醒"已经勾着 —— 再按一下退出就**静默永久
   * 关掉了提醒**，而他并没有在这一次里选择过它。
   */
  useEffect(() => {
    if (open) setDontAskAgain(false)
  }, [open])

  /*
   * 「退出」拿默认焦点（见文件头第二条约定）。
   *
   * 必须等一帧：`<Dialog>` 的 `showModal()` 在它自己的 effect 里跑，
   * 而原生 dialog 打开时会把焦点移到内部第一个可聚焦元素上 —— 我们要
   * 在那之后才抢，否则焦点会被它盖回去。
   */
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => confirmRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      labelledBy={titleId}
      // 容器只做圆角裁剪；底色/边框/阴影全在内层
      // （写在 <dialog> 上的 bg-* 会与它自己的 reset 类撞特异性，见 Dialog 的注释）
      className="radius-xl"
    >
      <div
        className="flex flex-col gap-4 radius-xl border border-[var(--border-light)] bg-[var(--bg-base-normal)] p-5 shadow-[var(--shadow-lg)]"
        style={{ width: "min(400px, calc(100vw - 64px))" }}
      >
        <div className="flex items-start gap-3">
          {/*
            警示图标进一个圆形淡底：与正文的字重/字号无关地把"这是个提问"
            立起来。不用 emoji —— 那会跟着系统字体变形。
          */}
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--status-fill-warning-container)] text-[var(--status-warning)]"
          >
            <svg viewBox="0 0 20 20" fill="none" className="size-5">
              <path d="M10 6.5v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="10" cy="13.8" r="0.9" fill="currentColor" />
              <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </span>

          <div className="flex min-w-0 flex-col gap-1 pt-0.5">
            <h2 id={titleId} className="typography-body-large-700 text-[var(--text-base-primary)]">
              {t("quit.confirmTitle")}
            </h2>
            <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("quit.confirmDetail")}
            </p>
          </div>
        </div>

        {/*
          底部一行：复选框在左、两颗按钮在右。
          复选框与按钮同一行而不是单独一段 —— 它是这次决定的**修饰**
          （"顺便别再问了"），不是一个并列的问题。
        */}
        <div className="flex items-center justify-between gap-4">
          <Checkbox
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.currentTarget.checked)}
            label={t("quit.dontAskAgain")}
          />
          <div className="flex shrink-0 items-center gap-2">
            <Button size="md" variant="secondary" onClick={onCancel}>
              {t("actions.cancel")}
            </Button>
            {/*
              退出用 primary 而不是 danger：这不是破坏性操作（见文件头）。
              danger 的红色会让每次 ⌘Q 都像在做一个危险决定。
            */}
            <Button
              ref={confirmRef}
              size="md"
              variant="primary"
              onClick={() => onConfirm(dontAskAgain)}
            >
              {t("quit.confirmAction")}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
