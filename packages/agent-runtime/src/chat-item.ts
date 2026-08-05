/**
 * 统一消息模型（ChatItem）。
 *
 * 借鉴参考实现的数据契约：**一行 = 一个可渲染项**，
 * 而不是「一条消息里嵌一堆 part」。理由是流式渲染下前者好处理得多 ——
 * tool_call 的状态从 pending 变 success 时只更新一个 item，
 * 而嵌套模型要去某条消息的 parts 数组里找那一项。
 *
 * 这个模型同时是**落库形态**（`search_chat_messages` 一行一个 item），
 * 所以「刷新页面后看到的东西」与「流式过程中看到的东西」由同一份数据驱动 ——
 * 两套渲染路径是 UI bug 的主要来源。
 */

export const CHAT_ITEM_TYPES = ["message", "thought", "tool_call", "plan", "error"] as const
export type ChatItemType = (typeof CHAT_ITEM_TYPES)[number]

export type ChatItemRole = "user" | "assistant" | "system"

export type ToolStatus = "pending" | "running" | "success" | "error"

/** 内容块。刻意做得窄：一期只有文本与代码，图片/表格二期再加。 */
export type UnifiedContentBlock =
  | { kind: "text"; text: string }
  | { kind: "code"; language: string | null; code: string }
  | { kind: "citation"; ordinal: number; label: string }

export interface ChatItem {
  id: string
  seq: number
  role: ChatItemRole
  itemType: ChatItemType
  content: UnifiedContentBlock[]
  /** itemType='tool_call' 时有值 */
  toolName?: string
  toolStatus?: ToolStatus
  /** 同一轮的 items 共享，便于折叠与重放 */
  turnId?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  createdAt: number
}

/** Agent 事件：ACP 通知规范化后的形态。reducer 消费它产出 ChatItem。 */
export type AgentEvent =
  | { type: "text_delta"; turnId: string; text: string }
  | { type: "thought_delta"; turnId: string; text: string }
  | { type: "tool_call"; turnId: string; callId: string; toolName: string; args?: unknown }
  | {
      type: "tool_result"
      turnId: string
      callId: string
      status: Exclude<ToolStatus, "pending">
      summary?: string
      /**
       * 人读的工具动作描述，用来把 `bash` 这种**通道名**换成它实际在做的事。
       *
       * 来源见 mapper 的 `extractToolLabel`：opencode 的 bash 工具有个
       * `description` 参数（模型填的「5-10 词说明这条命令干什么」），
       * 终态的 `title` 也会被换成它。没有就不带这个字段（保留原工具名）。
       */
      label?: string
    }
  | { type: "plan"; turnId: string; entries: { text: string; done: boolean }[] }
  | { type: "citation"; turnId: string; ordinal: number; label: string }
  | { type: "error"; turnId: string; message: string }
  | { type: "turn_end"; turnId: string; usage?: { inputTokens?: number; outputTokens?: number } }

export function textBlock(text: string): UnifiedContentBlock {
  return { kind: "text", text }
}

/** 把内容块拼成纯文本（落库的 digest、搜索预览、日志都用它）。 */
export function toPlainText(blocks: readonly UnifiedContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "text") return block.text
      if (block.kind === "code") return block.code
      return `[${block.ordinal}]`
    })
    .join("")
}
