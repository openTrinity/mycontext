/**
 * 传输形态 → 渲染形态（`ChatItem`）。
 *
 * ## 为什么值得抽出来
 *
 * 搜索（`SearchChatItem`）与数字分身（`PersonaTraceItem`）用的是**同一个**
 * ChatItem 模型，两侧的 IPC schema 字段逐个同构（见 `personaTraceItemSchema`
 * 的注释）。唯一的转换是 `contentJson` 字符串 → `UnifiedContentBlock[]`：
 * 传输层与存储层都不解析内容块，解析只发生在这里。
 *
 * 各写一份的代价是真实的：`exactOptionalPropertyTypes` 下"可选字段为 null"
 * 必须写成 `...(x === null ? {} : { x })`（直接给 `undefined` 过不了类型），
 * 而那个写法很容易在第二份里写成 `toolName: row.toolName ?? undefined`
 * —— 编译过、运行时 `toolStatus` 变成 undefined、工具行的状态点就没了。
 */
import type { ChatItem, ToolStatus, UnifiedContentBlock } from "@mycontext/agent-runtime"

/** 两个模块共用的传输行形状（字段同构，见文件头）。 */
export interface WireChatItem {
  id: string
  seq: number
  role: ChatItem["role"]
  itemType: ChatItem["itemType"]
  contentJson: string
  toolName: string | null
  toolStatus: ToolStatus | null
  turnId: string | null
  createdAt: number
}

/**
 * `contentJson` 坏掉时**不抛**：渲染层崩掉整屏比少显示一条过程严重得多。
 * 退回一个空内容块数组 —— 那一行仍然出现（能看到"有这么一步"），只是没正文。
 */
function parseContent(json: string): UnifiedContentBlock[] {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? (parsed as UnifiedContentBlock[]) : []
  } catch {
    return []
  }
}

export function toChatItems(rows: readonly WireChatItem[]): ChatItem[] {
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    role: row.role,
    itemType: row.itemType,
    content: parseContent(row.contentJson),
    ...(row.toolName === null ? {} : { toolName: row.toolName }),
    ...(row.toolStatus === null ? {} : { toolStatus: row.toolStatus }),
    ...(row.turnId === null ? {} : { turnId: row.turnId }),
    createdAt: row.createdAt,
  }))
}
