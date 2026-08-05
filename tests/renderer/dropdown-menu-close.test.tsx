/**
 * @vitest-environment jsdom
 *
 * DropdownMenu 选中项后的**关闭行为**。
 *
 * ## 这组测试防的是一个真实 bug
 *
 * 点侧栏头像弹出菜单 → 点"设置" → 设置弹窗打开，但**这个菜单没自己关**，
 * 浮在弹窗背后。成因：选中一项时只调了 `onSelect`，没有关菜单；而"点外部
 * 关闭"抓不到这次点击——它发生在菜单**内部**。于是终结类动作（设置/退出）
 * 选完之后菜单一直开着，直到用户又点了一次别处。
 *
 * 修法是让菜单项默认"选中即关"（菜单的标准语义），个别就地循环的项
 * （主题/语言，点一下换下一档）显式 `closeOnSelect={false}` 保持打开。
 *
 * 断言的是**关不关**这件事本身，而不是"onSelect 被调了没"——后者一直是对的，
 * 坏的恰恰是关闭那一步。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from "@mycontext/design"

afterEach(cleanup)

/** 打开菜单：渲染 + 点触发器。返回触发器便于后续断言 aria-expanded。 */
function openMenu(children: React.ReactNode): HTMLElement {
  render(
    <DropdownMenu
      trigger={(props) => (
        <button {...props} data-testid="trigger">
          menu
        </button>
      )}
    >
      {children}
    </DropdownMenu>,
  )
  const trigger = screen.getByTestId("trigger")
  fireEvent.click(trigger)
  return trigger
}

describe("★★ DropdownMenu 选中即关（修头像菜单浮在设置弹窗背后）", () => {
  it("★★ 选中普通项后菜单关闭（default closeOnSelect）", () => {
    const onSelect = vi.fn()
    const trigger = openMenu(<DropdownMenuItem onSelect={onSelect}>设置</DropdownMenuItem>)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")

    fireEvent.click(screen.getByText("设置"))

    // 两件事都要成立：动作执行了 + 菜单关了。坏的时候是"执行了但没关"。
    expect(onSelect).toHaveBeenCalledOnce()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("设置")).toBeNull()
  })

  it("★ closeOnSelect={false} 的项选中后菜单**留着**（主题/语言就地循环）", () => {
    const onSelect = vi.fn()
    const trigger = openMenu(
      <DropdownMenuItem closeOnSelect={false} onSelect={onSelect}>
        主题
      </DropdownMenuItem>,
    )

    fireEvent.click(screen.getByText("主题"))

    expect(onSelect).toHaveBeenCalledOnce()
    // ★ 反证：这一项**不**关，否则循环切换每点一次都要重新展开
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(screen.queryByText("主题")).not.toBeNull()
  })

  it("★ 同一菜单里混用：点循环项不关，再点终结项才关", () => {
    const trigger = openMenu(
      <>
        <DropdownMenuItem closeOnSelect={false}>主题</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>退出</DropdownMenuItem>
      </>,
    )
    fireEvent.click(screen.getByText("主题"))
    expect(trigger.getAttribute("aria-expanded")).toBe("true") // 循环项：留着
    fireEvent.click(screen.getByText("退出"))
    expect(trigger.getAttribute("aria-expanded")).toBe("false") // 终结项：关
  })

  it("disabled 项点了既不触发也不关", () => {
    const onSelect = vi.fn()
    const trigger = openMenu(
      <DropdownMenuItem disabled onSelect={onSelect}>
        设置
      </DropdownMenuItem>,
    )
    fireEvent.click(screen.getByText("设置"))
    expect(onSelect).not.toHaveBeenCalled()
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
  })
})
