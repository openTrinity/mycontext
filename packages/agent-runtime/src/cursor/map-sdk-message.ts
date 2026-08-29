/**
 * `@cursor/sdk` 的 `SDKMessage` → 内部 `AgentEvent[]`。
 *
 * 保持与 ACP mapper 同一出口形状，好让 `ChatItemReducer` / UI 不动。
 */
import type { AgentEvent, ToolStatus } from "../chat-item.js"
import type { SDKMessage } from "@cursor/sdk"

export function mapSdkMessage(message: SDKMessage, turnId: string): AgentEvent[] {
  switch (message.type) {
    case "assistant": {
      const events: AgentEvent[] = []
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          events.push({ type: "text_delta", turnId, text: block.text })
        } else if (block.type === "tool_use") {
          events.push({
            type: "tool_call",
            turnId,
            callId: block.id,
            toolName: block.name,
            args: block.input,
          })
        }
      }
      return events
    }
    case "thinking":
      return message.text ? [{ type: "thought_delta", turnId, text: message.text }] : []
    case "tool_call": {
      const status: Exclude<ToolStatus, "pending"> =
        message.status === "error"
          ? "error"
          : message.status === "completed"
            ? "success"
            : "running"
      if (message.status === "running") {
        return [
          {
            type: "tool_call",
            turnId,
            callId: message.call_id,
            toolName: message.name,
            args: message.args,
          },
        ]
      }
      {
        const summary =
          typeof message.result === "string"
            ? message.result.slice(0, 500)
            : message.result !== undefined
              ? JSON.stringify(message.result).slice(0, 500)
              : undefined
        return [
          summary === undefined
            ? { type: "tool_result", turnId, callId: message.call_id, status }
            : { type: "tool_result", turnId, callId: message.call_id, status, summary },
        ]
      }
    }
    case "status":
      if (message.status === "ERROR" && message.message) {
        return [{ type: "error", turnId, message: message.message }]
      }
      return []
    default:
      return []
  }
}
