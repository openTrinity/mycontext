/**
 * ACP `session/update` 通知 → `AgentEvent[]` 的转换层。
 *
 * ## 为什么需要它（接线的第一个缺口）
 *
 * `ChatItemReducer.apply()` 吃的是我们规范化的 `AgentEvent`
 * （text_delta / thought_delta / tool_call / tool_result / plan / citation /
 * error / turn_end），而 opencode 通过 `AcpClient.onNotification(method, params)`
 * 推的是 **ACP 线上通知** —— 一条 `session/update`，其 `params.update.sessionUpdate`
 * 才是真正的子类型。两者之间没有翻译，reducer 就收不到东西。
 *
 * ## 字段口径来源：读 opencode 源码 + 真进程锁定，不猜
 *
 * 形状取自 opencode 的 `acp/event.ts`（session/update 的**唯一**产出点）、
 * `acp/tool.ts`（tool_call / tool_call_update 的字段）、`acp/content.ts`
 * （message/thought chunk 的 content 形状）：
 *
 * · `agent_message_chunk` / `agent_thought_chunk`
 *     → `update.content = { type:"text", text }`（流式逐 token；**已真进程锁定**，
 *       见 acp-e2e.test.ts:256）。replay 时还会带 `resource_link` / `resource`
 *       两种 content（file part），那是**引用来源** → 映射成 citation。
 * · `tool_call`（工具开始，status 恒为 "pending"）
 *     → `{ toolCallId, title, kind, status:"pending", locations, rawInput }`。
 *       ★ 人类可读名是 **`title`** 不是 `kind`（kind 是枚举
 *       execute/fetch/edit/search/read/think/other，给 UI 配图标用）。
 * · `tool_call_update`（工具状态推进）
 *     → `{ toolCallId, status, title, kind, locations, content, rawInput, rawOutput }`；
 *       status ∈ pending|in_progress|completed|failed。
 *       ★★ `content` 是 `ToolCallContent[]`，形状**嵌套两层**：
 *       `[{ type:"content", content:{ type:"text", text } }]`（见 tool.ts
 *       `completedToolContent`）。第一版把它当 `[{type:"text",text}]` 是错的，
 *       那样工具摘要永远提取不到（静默丢）。
 * · `user_message_chunk` / `session_info_update` / `usage_update`
 *     → **显式忽略**。user_message 是 replay 回来的用户消息（我们库里已有）；
 *       session_info 是标题变更；usage 的用量我们从 prompt 响应拿。
 *
 * ## ★ 纯函数 + turnId 作为入参（不维护状态）
 *
 * ACP 的 update **只带 `sessionId`，不带 turnId**，而 reducer 的流式聚合
 * （appendStream / finalizeTurn / cancelTurn）全按 turnId 索引。若让 mapper
 * 自己维护"当前 turn"，它就不再是纯函数、也难测。所以 turnId 由**调用方**
 * （SearchService 发 `session/prompt` 时生成，如 `turn_${seq}`）闭包进
 * onNotification 回调，作为**入参**传进来。
 *
 * ## ★ turn_end 不在这里产
 *
 * ACP 里 turn 结束 = `session/prompt` 的**响应 resolve**（响应体带
 * `{ stopReason:"end_turn", usage, … }`），不是某条 update 通知
 * （acp-e2e 专门用 settleStream 轮询"流稳定"绕过这点）。所以 `turn_end` 由
 * SearchService 在 prompt 返回后**手动合成**喂给 reducer，本 mapper **永不产 turn_end**。
 */
import type { AgentEvent, ToolStatus } from "../chat-item.js"

/** 一条 `session/update` 通知的 params 外层形状。 */
interface SessionUpdateParams {
  sessionId?: string
  update?: SessionUpdate
}

/** `params.update` —— `sessionUpdate` 是判别式，其余字段随子类型不同。 */
interface SessionUpdate {
  sessionUpdate?: string
  [key: string]: unknown
}

/**
 * ACP 的内容块（message/thought chunk 里 `update.content` 的形状）。
 *
 * `text` 型带 `text`；`resource_link` 型带 `uri`/`name`；`resource` 型带
 * `resource:{uri, text?/blob?, mimeType?}`。见 content.ts 的 `partToContentChunks`。
 */
interface AcpContentBlock {
  type?: string
  text?: string
  uri?: string
  name?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
}

/**
 * ACP 的 ToolCallContent（tool_call_update 里 `content[]` 的**外层**形状）。
 *
 * ★ 嵌套两层：`{ type:"content", content:{ type:"text", text } }`
 * （另有 `type:"diff"` / `type:"content"` 里 `content.type:"image"` 等，
 * 摘要只取文本）。见 tool.ts 的 `completedToolContent` / `errorToolUpdate`。
 */
interface AcpToolCallContent {
  type?: string
  content?: AcpContentBlock
}

/**
 * 把一条 `session/update` 通知翻成 0..N 个 `AgentEvent`。
 *
 * @param params  `onNotification(method, params)` 里的 params（method 已由调用方过滤为 session/update）
 * @param turnId  本轮 prompt 的 turnId（调用方生成并贯穿该 turn 的所有 update）
 */
export function mapSessionUpdate(params: unknown, turnId: string): AgentEvent[] {
  const update = (params as SessionUpdateParams | null)?.update
  if (update === undefined || typeof update.sessionUpdate !== "string") return []

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return mapContentChunk(update, turnId, "text_delta")
    case "agent_thought_chunk":
      return mapContentChunk(update, turnId, "thought_delta")
    case "tool_call":
      return mapToolCall(update, turnId)
    case "tool_call_update":
      return mapToolCallUpdate(update, turnId)
    case "plan":
      return mapPlan(update, turnId)

    // 显式忽略（不是"未知"）—— 写出来是为了让下一个人知道这些**看见了但故意不处理**：
    // user_message_chunk 是 replay 回来的用户消息（库里已有）；
    // session_info_update 是标题变更（不是对话内容）；
    // usage_update 的用量我们从 prompt 响应拿（更准，带 cache 明细）。
    case "user_message_chunk":
    case "session_info_update":
    case "usage_update":
    case "current_mode_update":
    case "available_commands_update":
      return []

    default:
      // 真·未知子类型：静默丢会让"agent 不说话"极难归因，但抛错又会让一条
      // 无害的新通知类型打断整条流。折中——返回空，由调用方在 debug 里记原始 method。
      return []
  }
}

/**
 * message / thought chunk → text/thought delta，外加**引用来源**（resource*）→ citation。
 *
 * 流式路径 content 恒为 `{type:"text"}`；replay 路径可能带 file part
 * （`resource_link` / `resource`）—— 那是 agent 引用的来源，映射成 citation
 * 让 UI 能挂角标。thought 里的 resource 不产 citation（思考里的引用不是答案的出处）。
 */
function mapContentChunk(
  update: SessionUpdate,
  turnId: string,
  type: "text_delta" | "thought_delta",
): AgentEvent[] {
  const content = update["content"] as AcpContentBlock | undefined
  if (content === undefined) return []

  switch (content.type) {
    case "text": {
      if (typeof content.text !== "string" || content.text === "") return []
      return [{ type, turnId, text: content.text }]
    }
    case "resource_link": {
      if (type === "thought_delta") return []
      const label = content.name ?? content.uri
      return typeof label === "string" && label !== ""
        ? [{ type: "citation", turnId, ordinal: 0, label }]
        : []
    }
    case "resource": {
      if (type === "thought_delta") return []
      const label = content.resource?.uri
      return typeof label === "string" && label !== ""
        ? [{ type: "citation", turnId, ordinal: 0, label }]
        : []
    }
    default:
      return []
  }
}

/**
 * `tool_call` → AgentEvent.tool_call。
 *
 * 人类可读名取 `title`（见 tool.ts：shell 工具的 title 是命令本身，其余是
 * 模型给的标题），退化到 `kind`（枚举）再退化到空串（reducer 允许后补工具名）。
 */
function mapToolCall(update: SessionUpdate, turnId: string): AgentEvent[] {
  const callId = readString(update, "toolCallId")
  if (callId === null) return []
  const toolName = readString(update, "title") ?? readString(update, "kind") ?? ""
  return [{ type: "tool_call", turnId, callId, toolName, args: update["rawInput"] }]
}

/**
 * `tool_call_update` → AgentEvent.tool_result（只在到达终态时产）。
 *
 * status ∈ pending|in_progress|completed|failed。只有 completed/failed 是终态，
 * 产 tool_result（success/error）；pending/in_progress 不产（reducer 的 running
 * 由 tool_call 那步给的）。
 *
 * 终态还带一个 `label`（人读的动作描述）——见 `extractToolLabel`。
 */
function mapToolCallUpdate(update: SessionUpdate, turnId: string): AgentEvent[] {
  const callId = readString(update, "toolCallId")
  if (callId === null) return []
  const status = normalizeToolStatus(readString(update, "status"))
  if (status === null) return []
  const summary = extractToolSummary(update)
  const label = extractToolLabel(update)
  return [
    {
      type: "tool_result",
      turnId,
      callId,
      status,
      ...(summary === null ? {} : { summary }),
      ...(label === null ? {} : { label }),
    },
  ]
}

/**
 * 工具的**人读动作描述**。
 *
 * ## 为什么需要它
 *
 * 工具行原来显示 `tool_call` 那步的 `title`，而那一步 opencode 给的是**通道名**：
 * 一律是 `bash`（`rawInput` 还是空的 `{}`）。于是界面上一列 `bash / bash / bash`,
 * 用户看不出它到底查了什么 —— 而"它去查了什么"正是搜索模块可信度的一半。
 *
 * ## 真进程实测的字段口径（探针 dump）
 *
 * ```
 * tool_call        title="bash"  rawInput={}
 * tool_call_update title="bash"  rawInput={command:'kl ask "今天晚饭讨论"',
 *                                          description:"Query kl for today's dinner discussion",
 *                                          timeout:30000}   status=in_progress
 * tool_call_update title="Query kl for today's dinner discussion"  status=completed
 * ```
 *
 * 两条可用来源，按可靠性排：
 * ① `rawInput.description` —— bash 工具的显式参数（opencode 要求模型
 *    「5-10 词说明这条命令干什么」），语义最准；
 * ② 终态的 `title` —— opencode 自己也会把它换成 ①（skill 换成
 *    `Loaded skill: kl`），所以它是 ① 缺失时的兜底。
 *
 * 都没有就回 null，工具行保留原来的通道名（不硬造文案）。
 */
function extractToolLabel(update: SessionUpdate): string | null {
  const rawInput = update["rawInput"]
  if (typeof rawInput === "object" && rawInput !== null) {
    const description = (rawInput as { description?: unknown }).description
    if (typeof description === "string" && description.trim() !== "") return description
  }
  // 兜底：终态 title。它可能仍是通道名（`bash`），由调用方决定要不要用 ——
  // reducer 只在它与原名不同时才覆盖，所以同名时等于没发生。
  const title = readString(update, "title")
  return title !== null && title.trim() !== "" ? title : null
}

/**
 * `plan` → AgentEvent.plan。
 *
 * opencode 这版实际未观察到发 plan（保留映射以防开启）。entries 的文本字段
 * 名口径不确定 —— 同时兜 `content` 与 `text`；status==="completed" 视为 done。
 * 真形状由 M1.10 真进程锁定；在此之前该子类型是"建了但未验证"。
 */
function mapPlan(update: SessionUpdate, turnId: string): AgentEvent[] {
  const rawEntries = update["entries"]
  if (!Array.isArray(rawEntries)) return []
  const entries = rawEntries.map((raw) => {
    const entry = raw as { content?: unknown; text?: unknown; status?: unknown }
    const text =
      typeof entry.content === "string"
        ? entry.content
        : typeof entry.text === "string"
          ? entry.text
          : ""
    return { text, done: entry.status === "completed" }
  })
  return [{ type: "plan", turnId, entries }]
}

/**
 * ACP 工具状态 → `tool_result` 的终态。
 *
 * completed→success，failed→error；pending/in_progress（非终态）返回 null，
 * 调用方据此不产 tool_result。
 */
function normalizeToolStatus(raw: string | null): Exclude<ToolStatus, "pending"> | null {
  switch (raw) {
    case "completed":
      return "success"
    case "failed":
      return "error"
    default:
      return null
  }
}

/**
 * 从 tool_call_update 的 `content[]` 取一段可读摘要。
 *
 * ★ content 是嵌套两层的 ToolCallContent：`{ type:"content", content:{ type:"text", text } }`。
 * 取第一段文本即可 —— 完整输出不该塞进 tool_call 卡片（会把窗口撑爆），
 * 只给用户一个"跑了什么"的提示。
 */
function extractToolSummary(update: SessionUpdate): string | null {
  const content = update["content"]
  if (!Array.isArray(content)) return null
  for (const raw of content) {
    const outer = raw as AcpToolCallContent
    if (outer?.type !== "content") continue
    const inner = outer.content
    if (inner?.type === "text" && typeof inner.text === "string" && inner.text !== "") {
      return inner.text
    }
  }
  return null
}

function readString(update: SessionUpdate, key: string): string | null {
  const value = update[key]
  return typeof value === "string" && value !== "" ? value : null
}
