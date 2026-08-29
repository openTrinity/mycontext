import type { AgentEvent } from "../chat-item.js"
import { mapSdkMessage } from "./map-sdk-message.js"

/** 纯函数单测夹具：构造最小 SDKMessage 形状。 */
export function mapAssistantText(turnId: string, text: string): AgentEvent[] {
  return mapSdkMessage(
    {
      type: "assistant",
      agent_id: "a",
      run_id: "r",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
    turnId,
  )
}
