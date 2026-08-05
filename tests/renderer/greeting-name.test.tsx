/**
 * @vitest-environment jsdom
 *
 * GreetingName 的 hover 彩蛋。
 *
 * 测的是**状态机与无障碍**，不是动画的视觉效果：
 * · hover 进入 → 显示颜文字；离开 → 回到名字
 * · 每次进入换一个**不同的**颜文字（重复会让用户以为卡了一下）
 * · 度量层保持在 DOM 里（容器宽度不因 hover 突变）
 * · 键盘可聚焦（纯装饰但既然能 hover 触发就该能聚焦触发）
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { FUN_FACES, GreetingName, greetingKeyForHour } from "@mycontext/design"

// 每个用例后卸载：不清理的话 getByTestId 会在第二个用例里命中多个节点
// （vitest 没开 globals，@testing-library 的自动 cleanup 不生效）。
afterEach(cleanup)

function faceCount(container: HTMLElement): number {
  // 度量层用的是最长颜文字，可见层用的是随机选的那个 —— 都算进来
  return FUN_FACES.filter((face) => container.textContent?.includes(face)).length
}

describe("hover 状态机", () => {
  it("默认显示名字，不显示颜文字（可见层）", () => {
    render(<GreetingName name="高鹏" />)
    const node = screen.getByTestId("greeting-name")
    expect(node.dataset["hovering"]).toBe("false")
    expect(node.textContent).toContain("高鹏")
  })

  it("hover 后进入彩蛋态", () => {
    render(<GreetingName name="高鹏" />)
    const node = screen.getByTestId("greeting-name")
    fireEvent.mouseEnter(node)
    expect(node.dataset["hovering"]).toBe("true")
    expect(faceCount(node)).toBeGreaterThan(0)
  })

  it("离开后回到名字态", () => {
    render(<GreetingName name="高鹏" />)
    const node = screen.getByTestId("greeting-name")
    fireEvent.mouseEnter(node)
    fireEvent.mouseLeave(node)
    expect(node.dataset["hovering"]).toBe("false")
  })

  it("聚焦也能触发（键盘可达）", () => {
    render(<GreetingName name="高鹏" />)
    const node = screen.getByTestId("greeting-name")
    expect(node.getAttribute("tabindex")).toBe("0")
    fireEvent.focus(node)
    expect(node.dataset["hovering"]).toBe("true")
    fireEvent.blur(node)
    expect(node.dataset["hovering"]).toBe("false")
  })
})

describe("颜文字轮播", () => {
  /**
   * 连续 hover 多次，断言**没有连续两次相同**。
   *
   * 抽到同一个的表现是"动画播了但内容没变"，看起来像卡了一下而不像彩蛋。
   */
  it("连续 hover 不会连续出现同一个颜文字", () => {
    render(<GreetingName name="高鹏" />)
    const node = screen.getByTestId("greeting-name")

    // 读 data-face 而不是从 textContent 反推：退场动画期间两层同时在 DOM 里，
    // 且度量层常驻一个固定颜文字 —— 反推会得到"数组里第一个匹配的"而非当前那个。
    const seen: string[] = []
    for (let round = 0; round < 12; round += 1) {
      fireEvent.mouseEnter(node)
      const current = node.dataset["face"]
      if (current !== undefined) seen.push(current)
      fireEvent.mouseLeave(node)
    }
    expect(seen.length).toBe(12)

    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).not.toBe(seen[index - 1])
    }
  })

  it("颜文字池至少有 2 个（否则「换一个」逻辑无意义）", () => {
    expect(FUN_FACES.length).toBeGreaterThanOrEqual(2)
  })
})

describe("布局稳定性", () => {
  /**
   * 两个 invisible 的度量层必须在 DOM 里：容器宽度取"名字"与"最长颜文字"
   * 的较大值，否则 hover 瞬间宽度突变，右侧的兄弟元素会跟着抖一下。
   */
  it("保留两个 aria-hidden 的度量层", () => {
    const { container } = render(<GreetingName name="高鹏" />)
    const hidden = container.querySelectorAll('[aria-hidden="true"].invisible')
    expect(hidden.length).toBe(2)
  })

  it("长名字被截断而不是撑破容器", () => {
    const { container } = render(<GreetingName name={"很".repeat(80)} />)
    expect(container.querySelector(".truncate")).not.toBeNull()
  })
})

describe("问候语分段", () => {
  it.each([
    [0, "greeting.lateNight"],
    [4, "greeting.lateNight"],
    [5, "greeting.morning"],
    [11, "greeting.morning"],
    [12, "greeting.afternoon"],
    [17, "greeting.afternoon"],
    [18, "greeting.evening"],
    [23, "greeting.evening"],
  ])("%i 点 → %s", (hour, expected) => {
    expect(greetingKeyForHour(hour)).toBe(expected)
  })
})
