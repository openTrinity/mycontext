/**
 * @vitest-environment jsdom
 *
 * 联动带的两个状态。
 *
 * ## ★ 为什么这一条值得一组门禁
 *
 * 用户反馈的原话是「我点个图谱的点我很难感知到下面会有筛选的感觉」——
 * 而联动在代码上一直是通的（`entityFocus` 在页面级，两个子组件都接好了）。
 * 也就是说这个缺陷是**看不见的反馈**，不是断掉的数据流。
 *
 * 这类缺陷的复发形态很特别：数据仍然对，测试（如果只测数据）全绿，
 * 只有那句话没了 / 那条带没变。所以要锁的恰恰是**文案与状态的对应关系**：
 *
 * · 没筛时必须有一句**教人去点**的话 —— 否则用户没有理由去点一个点，
 *   而可发现性不能靠"试一下就知道了"；
 * · 筛上之后那句话必须**换掉**，变成"正在看谁" —— 两句同时在场
 *   等于状态没切换，而那时用户读到的是互相矛盾的两条信息。
 *
 * 反证都验过：把 `focus === null` 那个分支的条件反过来，两组都变红。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { FocusBridge } from "@renderer/features/dashboard/focus-bridge"

afterEach(cleanup)

describe("★ 没筛时：把那条暗线写出来", () => {
  it("给一句教人去点的提示", () => {
    render(<FocusBridge focus={null} color={null} count={null} onClear={() => {}} />)
    expect(screen.getByText(/点图上任意一个点/)).toBeTruthy()
  })

  /**
   * ★ 反面：提示态里**不能**出现"正在看"。
   *
   * 少了这一条，"两种文案都渲染"那个实现也能过上面那条 ——
   * 而那时用户同时读到"去点一个点"和"正在看 X"，不知道现在是哪个状态。
   */
  it("提示态不出现「正在看」", () => {
    render(<FocusBridge focus={null} color={null} count={null} onClear={() => {}} />)
    expect(screen.queryByText(/正在看/)).toBeNull()
  })

  /** 没筛时没有可清除的东西 —— 一个点了什么都不发生的按钮是噪声 */
  it("提示态不给「看全部」按钮", () => {
    render(<FocusBridge focus={null} color={null} count={null} onClear={() => {}} />)
    expect(screen.queryByRole("button", { name: "看全部" })).toBeNull()
  })
})

describe("★ 筛上之后：状态带说清「正在看谁」", () => {
  it("带上那个名字与条数", () => {
    render(<FocusBridge focus="小云" color="#5b8ff9" count={42} onClear={() => {}} />)
    expect(screen.getByText("小云")).toBeTruthy()
    expect(screen.getByText(/正在看/)).toBeTruthy()
    expect(screen.getByText("42 条")).toBeTruthy()
  })

  /**
   * ★ 提示句必须**消失**。
   *
   * 这是上一组那条反面断言的另一半 —— 两边各锁一个方向，
   * 于是"永远只渲染其中一种"和"两种都渲染"都过不去。
   */
  it("选中之后不再出现那句提示", () => {
    render(<FocusBridge focus="小云" color="#5b8ff9" count={42} onClear={() => {}} />)
    expect(screen.queryByText(/点图上任意一个点/)).toBeNull()
  })

  /**
   * ★ 用 `role="status"` 而不是一个普通 div。
   *
   * 读屏器要在筛选变化时**读出来** —— 视觉高亮之外的那一半。
   * 而这一条同时是 CDP 探针找这条带的锚点（见 check-dashboard-ui.mjs），
   * 去掉它探针会报"联动带没变成正在看"，指向一个错误的方向。
   */
  it("状态带是 role=status（读屏器能播报，探针也靠它定位）", () => {
    render(<FocusBridge focus="小云" color="#5b8ff9" count={42} onClear={() => {}} />)
    expect(screen.getByRole("status")).toBeTruthy()
  })

  it("「看全部」真的调 onClear（清筛选的唯一出口）", () => {
    const onClear = vi.fn()
    render(<FocusBridge focus="小云" color="#5b8ff9" count={42} onClear={onClear} />)
    screen.getByRole("button", { name: "看全部" }).click()
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  /**
   * 还在查的时候不写条数。
   *
   * ★ 判据是 `count === null` 而不是 `count === 0`：0 是一个**真实的**值
   * （这个人确实没有事实），把它当成"还在查"会让空结果显示成没有条数 ——
   * 而用户分不出"查不到"与"还在查"。
   */
  it("count=null（还在查）不写条数，count=0（真的没有）要写", () => {
    const { unmount } = render(
      <FocusBridge focus="小云" color="#5b8ff9" count={null} onClear={() => {}} />,
    )
    expect(screen.queryByText(/条$/)).toBeNull()
    unmount()
    render(<FocusBridge focus="小云" color="#5b8ff9" count={0} onClear={() => {}} />)
    expect(screen.getByText("0 条")).toBeTruthy()
  })

  /**
   * 色点是"上面那个点 = 这条带 = 下面这批事实"的连接件（见组件文件头），
   * 但它可以缺 —— 从事实列表点进来的实体不在 ego 图里，那时没有类型色。
   * 缺色时**不能**退化成一个黑点（那看起来像另一个类型）。
   */
  it("color=null 时不画色点（而不是画一个默认色的点）", () => {
    const { container, unmount } = render(
      <FocusBridge focus="小云" color={null} count={1} onClear={() => {}} />,
    )
    expect(container.querySelectorAll("span[aria-hidden]").length).toBe(0)
    unmount()
    const withColor = render(
      <FocusBridge focus="小云" color="#5b8ff9" count={1} onClear={() => {}} />,
    )
    const dot = withColor.container.querySelector("span[aria-hidden]")
    expect(dot).not.toBeNull()
    // 色值原样落到行内样式上 —— 与图上那个节点同一个值
    expect((dot as HTMLElement).style.background).toContain("rgb(91, 143, 249)")
  })
})
