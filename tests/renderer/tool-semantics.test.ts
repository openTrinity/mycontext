/**
 * 工具语义映射的纯函数单测。
 *
 * 为什么单独测这一层：它是一串**优先级敏感**的规则（精确 → 模式 → kind 兜底），
 * 顺序错了不会报错、只会让界面显示一个不那么准的动作名 —— 那种退化很难在
 * 渲染断言里看出来（截图上"读取文件"和"搜索内容"都长得像一行灰字）。
 *
 * 移植自参考实现的 `toolDisplayTitle`/`TOOL_ICON_RULES`，
 * 差异见 tool-semantics.ts 的文件头。
 */
import { describe, expect, it } from "vitest"
import {
  isIdentifierLike,
  toolActionOf,
  toolTitleOf,
} from "@renderer/features/agent-stream/tool-semantics.js"

describe("toolActionOf · 精确匹配优先", () => {
  it.each([
    ["bash", "execute"],
    ["shell", "execute"],
    ["read", "read"],
    ["write", "edit"],
    ["apply_patch", "edit"],
    ["grep", "search"],
    ["fetch", "fetch"],
    ["think", "think"],
    ["skill", "skill"],
  ])("%s → %s", (name, action) => {
    expect(toolActionOf(name)).toBe(action)
  })
})

describe("toolActionOf · 图谱优先于通用动作", () => {
  /**
   * ★ 这条是优先级的核心：kl 工具名里常同时含 query/search，
   * 落到通用 search 上就丢了"这条查的是图谱"——而那正是答案可信度的锚点。
   */
  it.each(["kl_query", "mycontext_kl_query", "kl_search", "graph_lookup", "查图谱"])(
    "%s → graph",
    (name) => {
      expect(toolActionOf(name)).toBe("graph")
    },
  )

  it("不含 kl/graph 的检索仍是 search", () => {
    expect(toolActionOf("local_recall")).toBe("search")
    expect(toolActionOf("mycontext_local_recall")).toBe("search")
  })

  it("kl 只作为独立词或前缀命中，不误吞别的词", () => {
    // "walk"/"talking" 里都有 k+l 相邻，但不该被判成图谱
    expect(toolActionOf("walk_dir")).not.toBe("graph")
    expect(toolActionOf("talking_head")).not.toBe("graph")
  })
})

describe("toolActionOf · 模式与兜底", () => {
  it("mycontext_ 前缀不影响判定", () => {
    expect(toolActionOf("mycontext_local_recall")).toBe("search")
  })

  it("认不出的名字兜底 generic", () => {
    expect(toolActionOf("wibble_wobble")).toBe("generic")
  })

  it("空名兜底 generic", () => {
    expect(toolActionOf("")).toBe("generic")
    expect(toolActionOf("   ")).toBe("generic")
  })

  it("ACP kind 作为最后兜底", () => {
    expect(toolActionOf("execute")).toBe("execute")
    expect(toolActionOf("other")).toBe("generic")
  })
})

describe("toolTitleOf · 标识符 vs 人话", () => {
  it("标识符 → 显示动作译名（标识符对用户没意义）", () => {
    expect(toolTitleOf("bash")).toEqual({ kind: "action", action: "execute" })
    expect(toolTitleOf("mycontext_kl_query")).toEqual({ kind: "action", action: "graph" })
  })

  it("中文标题 → 原样显示（已经是人话）", () => {
    expect(toolTitleOf("查询今天的晚饭讨论")).toEqual({
      kind: "literal",
      text: "查询今天的晚饭讨论",
    })
  })

  it("英文短句 → 原样显示（模型给的 description 比映射准）", () => {
    expect(toolTitleOf("Query kl for dinner")).toEqual({
      kind: "literal",
      text: "Query kl for dinner",
    })
  })

  /**
   * 过长的英文标题退回动作译名：那通常是模型把整条命令塞进了标题，
   * 而一行工具行要跟状态字共处，长标题会把状态挤出可视区。
   */
  it("过长英文标题 → 退回动作译名", () => {
    const long = "Run a very long shell command that lists absolutely everything in the workspace"
    expect(long.length).toBeGreaterThan(32)
    expect(toolTitleOf(long)).toEqual({ kind: "action", action: "execute" })
  })

  it("unknown tool → generic 动作", () => {
    expect(toolTitleOf("unknown tool")).toEqual({ kind: "action", action: "generic" })
    expect(toolTitleOf("Unknown Tool")).toEqual({ kind: "action", action: "generic" })
  })
})

describe("isIdentifierLike", () => {
  it.each(["bash", "kl_query", "mcp__foo", "read-file", "a.b.c", "tool:run"])(
    "%s 是标识符",
    (name) => {
      expect(isIdentifierLike(name)).toBe(true)
    },
  )

  it.each(["Query kl for dinner", "查询晚饭", "run the thing"])("%s 不是标识符", (name) => {
    expect(isIdentifierLike(name)).toBe(false)
  })
})
