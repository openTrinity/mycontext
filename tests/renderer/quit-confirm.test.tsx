/**
 * @vitest-environment jsdom
 *
 * 退出确认框的行为门禁。
 *
 * ## 为什么这一屏值得一条测试
 *
 * 它是 ⌘Q 之后用户看到的**唯一**界面，而它的每一条行为都有一个
 * "错了就很糟"的反面：
 *
 * 1. **确认要把 dontAskAgain 一起交出去**。丢掉那个布尔的表现是
 *    "我勾了下次别问，可它每次还问" —— 一个用户会反复遇到的失效。
 * 2. **取消不能带 dontAskAgain**。取消时勾着"下次不再提醒"是自相矛盾
 *    的组合（下次也不问、但这次不退？），主进程那侧不读它，
 *    这里也不该发出来。
 * 3. **Esc = 取消**。退出有后果，误触必须落在安全的一侧。
 * 4. **关掉再打开时勾选状态要重置**。留着上次的勾选会让用户在完全
 *    没注意的情况下永久关掉提醒。
 *
 * 用真渲染而不是扫源码文本：这四条全是运行时行为（点了会怎样）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import { QuitConfirmDialog } from "@renderer/features/shell/quit-confirm-dialog"

afterEach(cleanup)

/**
 * jsdom 缺两样东西，都要补（与其它弹窗测试同款）：
 * · `ResizeObserver` —— Button 的 squircle 圆角要量尺寸；
 * · `dialog.showModal` / `close` —— 原生 dialog 的方法 jsdom 没实现。
 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

const dialogProto = globalThis.HTMLDialogElement?.prototype as
  | (HTMLDialogElement & { showModal?: () => void; close?: () => void })
  | undefined
if (dialogProto !== undefined) {
  dialogProto.showModal ??= function showModal(this: HTMLDialogElement): void {
    this.setAttribute("open", "")
  }
  dialogProto.close ??= function close(this: HTMLDialogElement): void {
    this.removeAttribute("open")
  }
}

function renderDialog(props: {
  open?: boolean
  onCancel?: () => void
  onConfirm?: (dontAskAgain: boolean) => void
}) {
  const i18n = createI18n("zh")
  const result = render(
    <I18nextProvider i18n={i18n}>
      <QuitConfirmDialog
        open={props.open ?? true}
        onCancel={props.onCancel ?? (() => undefined)}
        onConfirm={props.onConfirm ?? (() => undefined)}
      />
    </I18nextProvider>,
  )
  return { ...result, i18n }
}

describe("★ 文案与结构", () => {
  it("标题、说明、两颗按钮与复选框都在（少一个就是半个弹窗）", () => {
    const { i18n } = renderDialog({})
    const t = i18n.getFixedT("zh", "common")
    expect(screen.getByText(t("quit.confirmTitle"))).toBeTruthy()
    expect(screen.getByText(t("quit.confirmDetail"))).toBeTruthy()
    expect(screen.getByRole("button", { name: t("quit.confirmAction") })).toBeTruthy()
    expect(screen.getByRole("button", { name: t("actions.cancel") })).toBeTruthy()
    expect(screen.getByRole("checkbox")).toBeTruthy()
  })

  it("open=false 时不渲染内容（Dialog 关闭态不挂子树）", () => {
    const { i18n } = renderDialog({ open: false })
    const t = i18n.getFixedT("zh", "common")
    expect(screen.queryByText(t("quit.confirmTitle"))).toBeNull()
  })
})

describe("★ 确认路径", () => {
  it("直接点『退出』→ onConfirm(false)", () => {
    const onConfirm = vi.fn()
    const { i18n } = renderDialog({ onConfirm })
    const t = i18n.getFixedT("zh", "common")
    fireEvent.click(screen.getByRole("button", { name: t("quit.confirmAction") }))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it("★ 勾上『下次不再提醒』再点『退出』→ onConfirm(true)", () => {
    const onConfirm = vi.fn()
    const { i18n } = renderDialog({ onConfirm })
    const t = i18n.getFixedT("zh", "common")
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: t("quit.confirmAction") }))
    // 丢掉这个布尔的表现是"我勾了它还是每次都问"
    expect(onConfirm).toHaveBeenCalledWith(true)
  })
})

describe("★ 取消路径", () => {
  it("点『取消』→ onCancel，且**不**触发 onConfirm", () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const { i18n } = renderDialog({ onCancel, onConfirm })
    const t = i18n.getFixedT("zh", "common")
    fireEvent.click(screen.getByRole("button", { name: t("actions.cancel") }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("★ Esc → onCancel（误触要落在安全的一侧）", () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    renderDialog({ onCancel, onConfirm })
    /*
     * 原生 dialog 的 Esc 走 `cancel` 事件（Dialog 组件拦它转成 onClose）。
     * jsdom 不会因为 keyDown 自己派发 cancel，所以直接派发那个事件 ——
     * 测的是"cancel 事件 → onCancel"这条接线，而 Esc→cancel 是浏览器保证的。
     */
    const dialogNode = document.querySelector("dialog")
    expect(dialogNode).toBeTruthy()
    fireEvent(dialogNode as Element, new Event("cancel", { cancelable: true }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe("★ 勾选状态不跨次保留", () => {
  it("关掉再打开 → 复选框回到未勾（否则会静默永久关掉提醒）", () => {
    const i18n = createI18n("zh")
    const view = render(
      <I18nextProvider i18n={i18n}>
        <QuitConfirmDialog open onCancel={() => undefined} onConfirm={() => undefined} />
      </I18nextProvider>,
    )
    fireEvent.click(screen.getByRole("checkbox"))
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true)

    /*
     * 关闭再打开。
     *
     * ★ 这条曾经真的红过：`dontAskAgain` 的 state 住在 QuitConfirmDialog
     * 里（Dialog 的**父**组件），而 `<Dialog>` 关闭只卸载它自己的 children
     * —— 所以那个 state 活着。修法是组件里显式 `if (open) setDontAskAgain(false)`。
     */
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <QuitConfirmDialog open={false} onCancel={() => undefined} onConfirm={() => undefined} />
      </I18nextProvider>,
    )
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <QuitConfirmDialog open onCancel={() => undefined} onConfirm={() => undefined} />
      </I18nextProvider>,
    )
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false)
  })
})
