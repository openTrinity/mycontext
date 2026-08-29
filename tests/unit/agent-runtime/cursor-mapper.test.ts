import { describe, expect, it } from "vitest"
import { mapSdkMessage } from "../../../packages/agent-runtime/src/cursor/map-sdk-message.js"

describe("mapSdkMessage", () => {
  it("maps assistant text to text_delta", () => {
    const events = mapSdkMessage(
      {
        type: "assistant",
        agent_id: "a1",
        run_id: "r1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "你好" }],
        },
      },
      "turn_1",
    )
    expect(events).toEqual([{ type: "text_delta", turnId: "turn_1", text: "你好" }])
  })

  it("maps tool_call running then completed", () => {
    const start = mapSdkMessage(
      {
        type: "tool_call",
        agent_id: "a1",
        run_id: "r1",
        call_id: "c1",
        name: "grep",
        status: "running",
        args: { pattern: "x" },
      },
      "turn_1",
    )
    expect(start[0]?.type).toBe("tool_call")
    const done = mapSdkMessage(
      {
        type: "tool_call",
        agent_id: "a1",
        run_id: "r1",
        call_id: "c1",
        name: "grep",
        status: "completed",
        result: "ok",
      },
      "turn_1",
    )
    expect(done).toEqual([
      {
        type: "tool_result",
        turnId: "turn_1",
        callId: "c1",
        status: "success",
        summary: "ok",
      },
    ])
  })
})
