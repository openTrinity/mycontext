/**
 * ACP `session/update` → `AgentEvent[]` 的转换。
 *
 * 这层单测验的是**我们的翻译**：给定一条 ACP 通知的 params，产出的 AgentEvent
 * 形状是否对。真实字段口径（尤其 tool_call / plan）由 `tests/externals/acp-e2e`
 * 的真进程断言锁定 —— 这里的输入 fixture 按已知的 opencode 1.15.5 形状构造。
 *
 * 关键契约（见 session-update-mapper.ts 头注释）：
 * · mapper 是纯函数，turnId 是入参（ACP 通知只带 sessionId）；
 * · mapper **永不产 turn_end**（turn 结束是 prompt 响应，由 SearchService 合成）。
 */
import { describe, expect, it } from "vitest"
import { ChatItemReducer, mapSessionUpdate, type AgentEvent } from "@mycontext/agent-runtime"

const TURN = "turn_1"

/** 包一层 `session/update` 的 params 外壳。 */
function update(sessionUpdate: string, rest: Record<string, unknown> = {}): unknown {
  return { sessionId: "s1", update: { sessionUpdate, ...rest } }
}

describe("mapSessionUpdate · 文本流", () => {
  it("agent_message_chunk → text_delta，带入参 turnId", () => {
    const events = mapSessionUpdate(
      update("agent_message_chunk", { content: { type: "text", text: "你好" } }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([{ type: "text_delta", turnId: TURN, text: "你好" }])
  })

  it("agent_thought_chunk → thought_delta（与 message 分开）", () => {
    const events = mapSessionUpdate(
      update("agent_thought_chunk", { content: { type: "text", text: "想一下" } }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([{ type: "thought_delta", turnId: TURN, text: "想一下" }])
  })

  it("空文本 chunk 不产事件（避免落一堆空 delta）", () => {
    expect(
      mapSessionUpdate(
        update("agent_message_chunk", { content: { type: "text", text: "" } }),
        TURN,
      ),
    ).toEqual([])
  })

  it("非 text 类型的 content 不产事件", () => {
    expect(
      mapSessionUpdate(update("agent_message_chunk", { content: { type: "image" } }), TURN),
    ).toEqual([])
  })
})

describe("mapSessionUpdate · 引用来源（replay 的 file part → citation）", () => {
  it("message chunk 带 resource_link → citation（name 优先于 uri）", () => {
    const events = mapSessionUpdate(
      update("agent_message_chunk", {
        content: { type: "resource_link", uri: "file:///a.md", name: "a.md" },
      }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([
      { type: "citation", turnId: TURN, ordinal: 0, label: "a.md" },
    ])
  })

  it("message chunk 带 resource → citation（取 resource.uri）", () => {
    const events = mapSessionUpdate(
      update("agent_message_chunk", {
        content: { type: "resource", resource: { uri: "file:///b.md", text: "…" } },
      }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([
      { type: "citation", turnId: TURN, ordinal: 0, label: "file:///b.md" },
    ])
  })

  it("thought chunk 里的 resource 不产 citation（思考里的引用不是答案出处）", () => {
    expect(
      mapSessionUpdate(
        update("agent_thought_chunk", { content: { type: "resource_link", uri: "file:///c.md" } }),
        TURN,
      ),
    ).toEqual([])
  })
})

describe("mapSessionUpdate · 显式忽略的子类型", () => {
  it.each([
    "user_message_chunk",
    "session_info_update",
    "usage_update",
    "current_mode_update",
    "available_commands_update",
  ])("%s → [](看见了但故意不处理)", (kind) => {
    expect(
      mapSessionUpdate(update(kind, { content: { type: "text", text: "x" }, used: {} }), TURN),
    ).toEqual([])
  })
})

describe("mapSessionUpdate · 工具", () => {
  it("tool_call → tool_call（toolCallId→callId）", () => {
    const events = mapSessionUpdate(
      update("tool_call", { toolCallId: "c1", title: "kl_query", rawInput: { q: "x" } }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([
      { type: "tool_call", turnId: TURN, callId: "c1", toolName: "kl_query", args: { q: "x" } },
    ])
  })

  it("tool_call 缺 toolCallId → 不产（无法关联乱序 result）", () => {
    expect(mapSessionUpdate(update("tool_call", { title: "x" }), TURN)).toEqual([])
  })

  it("tool_call_update completed → tool_result success + 摘要", () => {
    // ★ content 是嵌套两层的 ToolCallContent（见 tool.ts completedToolContent）：
    // `[{ type:"content", content:{ type:"text", text } }]` —— 扁平写法提取不到，会静默丢摘要。
    const events = mapSessionUpdate(
      update("tool_call_update", {
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "命中 3 条" } }],
      }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([
      { type: "tool_result", turnId: TURN, callId: "c1", status: "success", summary: "命中 3 条" },
    ])
  })

  it("tool_call_update failed → tool_result error", () => {
    const events = mapSessionUpdate(
      update("tool_call_update", { toolCallId: "c1", status: "failed" }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([
      { type: "tool_result", turnId: TURN, callId: "c1", status: "error" },
    ])
  })

  it("tool_call_update 非终态（in_progress）不产 tool_result", () => {
    expect(
      mapSessionUpdate(
        update("tool_call_update", { toolCallId: "c1", status: "in_progress" }),
        TURN,
      ),
    ).toEqual([])
  })

  /**
   * ★ label：把 `bash` 这种**通道名**换成它实际在做的事。
   *
   * 形状取自真进程 dump（见 mapper 的 `extractToolLabel` 注释）：
   * `tool_call` 只给 `title:"bash"` + 空 `rawInput`，动作描述在
   * `tool_call_update` 的 `rawInput.description` 里。不抽它的话界面上
   * 就是一列 `bash / bash / bash`。
   */
  it("tool_call_update → label 取 rawInput.description（真进程口径）", () => {
    const events = mapSessionUpdate(
      update("tool_call_update", {
        toolCallId: "c1",
        status: "completed",
        title: "bash",
        rawInput: {
          command: 'kl ask "今天晚饭讨论"',
          description: "Query kl for today's dinner discussion",
          timeout: 30_000,
        },
      }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([
      {
        type: "tool_result",
        turnId: TURN,
        callId: "c1",
        status: "success",
        label: "Query kl for today's dinner discussion",
      },
    ])
  })

  it("没有 description 时 label 兜底用终态 title", () => {
    const events = mapSessionUpdate(
      update("tool_call_update", {
        toolCallId: "c1",
        status: "completed",
        title: "Loaded skill: kl",
        rawInput: { name: "kl" },
      }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([
      {
        type: "tool_result",
        turnId: TURN,
        callId: "c1",
        status: "success",
        label: "Loaded skill: kl",
      },
    ])
  })

  it("description 为空串时不当 label（退回 title）", () => {
    const events = mapSessionUpdate(
      update("tool_call_update", {
        toolCallId: "c1",
        status: "completed",
        title: "bash",
        rawInput: { command: "ls", description: "   " },
      }),
      TURN,
    )
    // 空白 description 不该盖掉 title，也不该产出一个空 label（界面会变空行）
    expect(events).toEqual<AgentEvent[]>([
      { type: "tool_result", turnId: TURN, callId: "c1", status: "success", label: "bash" },
    ])
  })

  it("title 与 rawInput 都没有 → 不带 label（保留原工具名）", () => {
    const events = mapSessionUpdate(
      update("tool_call_update", { toolCallId: "c1", status: "failed" }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([
      { type: "tool_result", turnId: TURN, callId: "c1", status: "error" },
    ])
  })
})

describe("mapSessionUpdate · plan", () => {
  it("plan → plan（content/status 归一）", () => {
    const events = mapSessionUpdate(
      update("plan", {
        entries: [
          { content: "第一步", status: "completed" },
          { content: "第二步", status: "pending" },
        ],
      }),
      TURN,
    )
    expect(events).toEqual<AgentEvent[]>([
      {
        type: "plan",
        turnId: TURN,
        entries: [
          { text: "第一步", done: true },
          { text: "第二步", done: false },
        ],
      },
    ])
  })
})

describe("mapSessionUpdate · 稳健性", () => {
  it("未知子类型 → 返回 []（不抛，不猜）", () => {
    expect(mapSessionUpdate(update("some_future_type", { foo: 1 }), TURN)).toEqual([])
  })

  it("缺 update 字段 → []", () => {
    expect(mapSessionUpdate({ sessionId: "s1" }, TURN)).toEqual([])
  })

  it("params 为 null → []（不崩）", () => {
    expect(mapSessionUpdate(null, TURN)).toEqual([])
  })

  it("永不产 turn_end（turn 结束由 SearchService 合成）", () => {
    const kinds = ["agent_message_chunk", "tool_call", "tool_call_update", "plan", "whatever"]
    for (const k of kinds) {
      const events = mapSessionUpdate(
        update(k, { content: { type: "text", text: "x" }, toolCallId: "c", status: "completed" }),
        TURN,
      )
      expect(events.some((e) => e.type === "turn_end")).toBe(false)
    }
  })
})

describe("mapSessionUpdate → ChatItemReducer 端到端", () => {
  it("逐 token message chunk 经 mapper→reducer 拼成一条完整消息", () => {
    const reducer = new ChatItemReducer({ startSeq: 1, newId: (s) => `i${s}`, now: () => 1 })
    /**
     * ★ 哨兵串刻意**不用产品名**：这条用例验的是"分片能拼回整串"，
     * 而分片是按字符切的（`SEN` + `TINEL`）。用产品名当哨兵的话，
     * 任何一次全局改名都只会命中下面那个**拼接后**的期望值、碰不到上面的分片，
     * 于是用例红在一个与它的意图完全无关的原因上（实测踩过一次）。
     */
    const chunks = ["SEN", "TINEL", "-OK"]
    for (const text of chunks) {
      reducer.apply(
        mapSessionUpdate(update("agent_message_chunk", { content: { type: "text", text } }), TURN),
      )
    }
    // SearchService 侧合成的 turn_end 定稿：
    reducer.apply([{ type: "turn_end", turnId: TURN }])
    const items = reducer.snapshot().filter((i) => i.itemType === "message")
    expect(items).toHaveLength(1)
    expect(items[0]?.content.map((b) => (b.kind === "text" ? b.text : "")).join("")).toBe(
      "SENTINEL-OK",
    )
  })
})
