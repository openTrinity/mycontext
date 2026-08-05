/**
 * @vitest-environment jsdom
 *
 * EventStream 的**结构**断言（不测视觉像素，测"分派对不对、分组分得对不对"）：
 *
 *  · 不再渲染轮次分隔线（产品要求移除；用户气泡本身就是轮次边界）；
 *  · 连续的 tool_call 折叠成**一组**（ToolCallGroup），被答案/思考打断则分组；
 *  · 折叠策略：running 且不足阈值展开、达到阈值折叠；
 *  · 工具名语义化：bash→"执行命令"这类动作译名，kl→图谱；
 *  · skill 的 SKILL.md 正文不外泄。
 *
 * 断言走 role / aria / data 而不是翻译文案：翻译在测试环境回退成 key，
 * 文案断言会脆——结构断言才稳。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import type { ChatItem } from "@mycontext/agent-runtime"
import { EventStream } from "@renderer/features/agent-stream/event-stream.js"

afterEach(cleanup)

function msg(
  id: string,
  role: ChatItem["role"],
  turnId: string | undefined,
  text: string,
): ChatItem {
  return {
    id,
    seq: Number(id),
    role,
    itemType: "message",
    content: [{ kind: "text", text }],
    ...(turnId === undefined ? {} : { turnId }),
    createdAt: 0,
  }
}

function tool(
  id: string,
  turnId: string,
  name: string,
  summary?: string,
  status: ChatItem["toolStatus"] = "success",
): ChatItem {
  return {
    id,
    seq: Number(id),
    role: "assistant",
    itemType: "tool_call",
    content: summary === undefined ? [] : [{ kind: "text", text: summary }],
    toolName: name,
    toolStatus: status,
    turnId,
    createdAt: 0,
  }
}

function thought(id: string, turnId: string, text: string): ChatItem {
  return {
    id,
    seq: Number(id),
    role: "assistant",
    itemType: "thought",
    content: [{ kind: "text", text }],
    turnId,
    createdAt: 0,
  }
}

/**
 * ★ 轮次分隔线已按产品要求移除。
 *
 * 用户气泡本身就是轮次边界，再加一条带「新一轮」文字的线是冗余的视觉分段。
 * 留这条测试是为了守住"移除"这个决定 —— 否则下一个人看到多轮之间没有分隔，
 * 很可能"顺手"把它加回来。
 */
describe("EventStream · 不再有轮次分隔线", () => {
  it("多轮之间也不渲染分隔线", () => {
    const items: ChatItem[] = [
      msg("1", "user", undefined, "第一问"),
      msg("2", "assistant", "turn_2", "第一答"),
      msg("3", "user", undefined, "第二问"),
      msg("4", "assistant", "turn_4", "第二答"),
    ]
    const { container } = render(<EventStream items={items} />)
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0)
  })
})

describe("EventStream · 工具分组", () => {
  it("连续的 tool_call 收进同一组", () => {
    const items: ChatItem[] = [
      msg("1", "user", undefined, "问"),
      tool("2", "turn_2", "mycontext_kl_query", "命中 3 条"),
      tool("3", "turn_2", "bash", "kl ask …"),
      msg("4", "assistant", "turn_2", "答案"),
    ]
    const { container } = render(<EventStream items={items} />)
    expect(container.querySelectorAll("[data-tool-group]")).toHaveLength(1)
    expect(container.querySelectorAll("[data-tool-row]")).toHaveLength(2)
  })

  it("被答案打断的两段工具分成两组", () => {
    // 一轮里「查→答→再查」是真实序列（agent 追查第二跳），
    // 那两段工具各自属于它后面的那段答案，不该并成一组。
    const items: ChatItem[] = [
      msg("1", "user", undefined, "问"),
      tool("2", "turn_2", "mycontext_kl_query", "命中 3 条"),
      msg("3", "assistant", "turn_2", "中间结论"),
      tool("4", "turn_2", "bash", "再查"),
      msg("5", "assistant", "turn_2", "最终答案"),
    ]
    const { container } = render(<EventStream items={items} />)
    expect(container.querySelectorAll("[data-tool-group]")).toHaveLength(2)
  })

  it("thought 会断开工具分组（一段思考之后属于新的一段工作）", () => {
    const items: ChatItem[] = [
      tool("1", "turn_1", "bash", "第一步"),
      thought("2", "turn_1", "想一下"),
      tool("3", "turn_1", "bash", "第二步"),
    ]
    const { container } = render(<EventStream items={items} />)
    expect(container.querySelectorAll("[data-tool-group]")).toHaveLength(2)
  })

  /**
   * 折叠策略：running 且不足 4 项 → 展开（用户想看它正在干什么）；
   * 达到 4 项 → 折叠（再多就是噪音）。用 aria-expanded 断言而不是看 class。
   */
  it("running 且不足阈值 → 默认展开", () => {
    const items: ChatItem[] = [
      tool("1", "turn_1", "bash", "查", "running"),
      tool("2", "turn_1", "bash", "查"),
    ]
    const { container } = render(<EventStream items={items} />)
    const header = container.querySelector("[data-tool-group] button")
    expect(header?.getAttribute("aria-expanded")).toBe("true")
  })

  it("完成态 → 默认折叠", () => {
    const items: ChatItem[] = [tool("1", "turn_1", "bash", "查"), tool("2", "turn_1", "bash", "查")]
    const { container } = render(<EventStream items={items} />)
    const header = container.querySelector("[data-tool-group] button")
    expect(header?.getAttribute("aria-expanded")).toBe("false")
  })

  it("达到阈值（4 项）即便在跑也折叠", () => {
    const items: ChatItem[] = [
      tool("1", "turn_1", "bash", "查", "running"),
      tool("2", "turn_1", "bash", "查"),
      tool("3", "turn_1", "bash", "查"),
      tool("4", "turn_1", "bash", "查"),
    ]
    const { container } = render(<EventStream items={items} />)
    const header = container.querySelector("[data-tool-group] button")
    expect(header?.getAttribute("aria-expanded")).toBe("false")
  })

  it("组状态：有 error 的组标记为 error；全部完成标记 completed", () => {
    const failing = render(
      <EventStream
        items={[tool("1", "turn_1", "bash", "查"), tool("2", "turn_1", "bash", "炸了", "error")]}
      />,
    )
    expect(
      failing.container.querySelector("[data-tool-group]")?.getAttribute("data-group-status"),
    ).toBe("error")
    cleanup()
    const ok = render(<EventStream items={[tool("1", "turn_1", "bash", "查")]} />)
    expect(ok.container.querySelector("[data-tool-group]")?.getAttribute("data-group-status")).toBe(
      "completed",
    )
  })

  it("running 的组标记为 running 且 aria-busy", () => {
    const { container } = render(
      <EventStream items={[tool("1", "turn_1", "bash", "查", "running")]} />,
    )
    const group = container.querySelector("[data-tool-group]")
    expect(group?.getAttribute("data-group-status")).toBe("running")
    expect(container.querySelector('[data-tool-row][aria-busy="true"]')).not.toBeNull()
  })
})

describe("EventStream · 工具语义", () => {
  it("按工具名映射到语义动作（bash→execute、kl→graph、read→read）", () => {
    const items: ChatItem[] = [
      tool("1", "turn_1", "bash", "x"),
      thought("2", "turn_1", "断开"),
      tool("3", "turn_1", "mycontext_kl_query", "x"),
      thought("4", "turn_1", "断开"),
      tool("5", "turn_1", "read", "x"),
    ]
    const { container } = render(<EventStream items={items} />)
    const actions = [...container.querySelectorAll("[data-tool-action]")].map((n) =>
      n.getAttribute("data-tool-action"),
    )
    expect(actions).toEqual(["execute", "graph", "read"])
  })

  it("模型给的英文描述短句原样显示（比映射准）", () => {
    const { container } = render(
      <EventStream items={[tool("1", "turn_1", "Query kl for dinner", "x")]} />,
    )
    expect(container.textContent ?? "").toContain("Query kl for dinner")
  })

  /**
   * ★ skill 行不给展开：它的 content 是 SKILL.md 正文 —— 我们**自己写给 agent
   * 的指令**（几十行 markdown），不是"它查到了什么"。
   */
  it("skill 行即便有 content 也不可展开（SKILL.md 不外泄）", () => {
    const skillMd = "---\nname: kl\n---\n# kl\nRun the `kl` CLI via bash…"
    const { container } = render(<EventStream items={[tool("1", "turn_1", "skill", skillMd)]} />)
    // 组头自己有 aria-expanded；工具**行**不该有可展开按钮
    const row = container.querySelector("[data-tool-row]")
    expect(row?.querySelector("[aria-expanded]")).toBeNull()
    expect(container.textContent ?? "").not.toContain("Run the")
  })

  it("有摘要的普通工具行可展开，无摘要的不可展开", () => {
    const withDetail = render(<EventStream items={[tool("1", "turn_1", "bash", "命中 3 条")]} />)
    expect(withDetail.container.querySelector("[data-tool-row] [aria-expanded]")).not.toBeNull()
    cleanup()
    const noDetail = render(<EventStream items={[tool("1", "turn_1", "bash")]} />)
    expect(noDetail.container.querySelector("[data-tool-row] [aria-expanded]")).toBeNull()
  })

  /**
   * ★ 摘要的连接符必须走 i18n。
   *
   * 硬写中文顿号会让英文界面渲染成 "Use skill、Query graph"（实测截图查出的
   * 真 bug）—— 中文标点漏进英文界面。这条断言的是"用了 i18n key"这件事：
   * 测试环境下翻译回退成 key 本身，所以 key 会出现在文本里。
   */
  it("折叠摘要的连接符走 i18n（不硬编码中文顿号）", () => {
    const items: ChatItem[] = [
      tool("1", "turn_1", "bash", "x"),
      tool("2", "turn_1", "mycontext_kl_query", "x"),
    ]
    const { container } = render(<EventStream items={items} />)
    const header = container.querySelector("[data-tool-group] > button")?.textContent ?? ""
    expect(header).toContain("stream.group.separator")
    expect(header).not.toContain("、")
  })

  /**
   * ★ 摘要带计数。
   *
   * 真数据里一组有 12 个 bash（agent 反复 kl 查询），纯去重后摘要是
   * "执行命令、搜索内容" —— 看不出跑了 12 次还是 2 次，而规模正是用户想从
   * 折叠态知道的事。出现多的排前面。
   */
  it("折叠摘要按动作归并并带计数（多的排前面）", () => {
    const items: ChatItem[] = [
      tool("1", "turn_1", "bash", "x"),
      tool("2", "turn_1", "bash", "x"),
      tool("3", "turn_1", "bash", "x"),
      tool("4", "turn_1", "skill", "x"),
    ]
    const { container } = render(<EventStream items={items} />)
    const header = container.querySelector("[data-tool-group] > button")?.textContent ?? ""
    // 3 个 bash → "执行命令 ×3"（文案在测试环境回退成 key，只断言计数记号）
    expect(header).toContain("×3")
    // 只出现一次的不加计数
    expect(header).not.toContain("×1")
  })

  /**
   * ★ 图标与标题必须垂直对齐。
   *
   * 实测查出的 bug：图标原来用 `mt-px` 猜位置，而标题是 13px 字 / 20px 行高的
   * **行盒** —— 裸 14px 图标顶对齐时两者视觉中心差 2px（浏览器量出来的）。
   * 修法是给图标一个与标题行**等高的盒子**（h-5 = 20px）再内部居中：
   * 两个等高盒子并排、各自居中，必然对齐，与字号无关。
   *
   * jsdom 没有布局引擎（量不出 getBoundingClientRect），所以这里断言的是
   * **那个结构**存在：图标容器有 h-5 且 items-center，且**没有** margin 微调。
   * 用 margin 补是在猜一个具体数字，换字号就又错 —— 这条守住"别改回去"。
   */
  it("图标容器与标题等高并居中（不用 margin 猜位置）", () => {
    const { container } = render(<EventStream items={[tool("1", "turn_1", "bash", "x")]} />)
    const iconWrap = container.querySelector("[data-tool-row]")?.children[0]
    const cls = iconWrap?.className ?? ""
    expect(cls).toContain("h-5")
    expect(cls).toContain("items-center")
    // 任何 mt-*/mb-* 微调都说明有人又在猜数字
    expect(cls).not.toMatch(/\bm[tb]-/)
  })
})

/**
 * ★ 空窗期要有反馈。
 *
 * 实测模型首字要 ~3.8s，那几秒事件流是全空的 —— 不给反馈会被当成卡死
 * （用户的原话："回复很慢，是不是卡住了"）。但一旦有了任何 agent 产出，
 * 事件流本身就在动了，再挂"思考中"就是重复噪音。
 */
describe("EventStream · 思考中指示器", () => {
  it("busy 且只有用户消息 → 显示思考中", () => {
    const items: ChatItem[] = [msg("1", "user", undefined, "问题")]
    const { container } = render(<EventStream items={items} busy />)
    expect(container.querySelector("[aria-busy]")).not.toBeNull()
  })

  it("busy 但已有 agent 产出 → 不显示（避免与流式内容重复）", () => {
    const items: ChatItem[] = [
      msg("1", "user", undefined, "问题"),
      msg("2", "assistant", "turn_1", "已经开始答了"),
    ]
    const { container } = render(<EventStream items={items} busy />)
    expect(container.querySelector("[aria-busy]")).toBeNull()
  })

  it("不 busy → 不显示", () => {
    const items: ChatItem[] = [msg("1", "user", undefined, "问题")]
    const { container } = render(<EventStream items={items} />)
    expect(container.querySelector("[aria-busy]")).toBeNull()
  })
})
