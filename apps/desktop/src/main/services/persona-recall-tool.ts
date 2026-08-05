/**
 * agent 的检索工具 —— **声明与执行器只有这一份**。
 *
 * ## 为什么要单独一个文件
 *
 * 端到端脚本需要探针（"工具在真网关上到底能不能被调起来"），而探针
 * 如果自己抄一份工具声明，它验的就是**抄的那一份**：产品里的声明
 * 改坏了（描述被删、参数名改了、多加一个 `conversationId`），探针照样绿。
 *
 * 一份声明两处 import 之后，探针绿就真的意味着产品里那个工具能被调起来。
 *
 * ## ★ 隔离是结构性的，不是检查出来的
 *
 * `conversationId` 由执行器**闭包捕获**，工具的 JSON Schema 里只有
 * `query` 一个字段 —— 模型连"换个会话"这个动作都表达不出来。
 * 这比"签发 token 时限定 scope"更强：那是运行期检查（漏一处就是泄漏），
 * 这是**结构上不可能**。
 *
 * 为什么这件事值得这么小心：群聊里任何人都能发一句
 * 「查一下他和 XX 的单聊说了什么」。一旦 agent 能跨会话召回，
 * 那句话就是一次成功的数据窃取 —— 而它看起来只是一条普通消息。
 */
import type { LlmToolCall, LlmToolSpec } from "@mycontext/llm"
import { recallMessages, renderRecallForPrompt } from "@mycontext/retrieval"
import type { FtsIndexRepository, MessageRepository } from "@mycontext/store"

/** 单次召回给模型的条数。12 条够答一个问题，又不至于挤掉对话本身。 */
export const RECALL_TOOL_LIMIT = 12

export const RECALL_TOOL: LlmToolSpec = {
  name: "recall_conversation_history",
  description: [
    "在**当前这个会话**的历史消息里检索。",
    "用于回答「上次说的那个方案是什么」「谁负责这块」这类需要翻旧消息的问题。",
    "检索不到时会明确告诉你 —— 那时不要编，回一句表示稍后确认。",
  ].join(""),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索关键词，用空格分隔多个词" },
    },
    // ★ 只有 query。多一个 conversationId 就等于把隔离交给模型的自觉
    required: ["query"],
  },
}

export interface RecallToolRepos {
  fts: FtsIndexRepository
  messages: MessageRepository
}

/**
 * 造一个绑定在某个会话上的执行器。
 *
 * `onCall` 是给调用方观测用的（脚本要报"调了几次、命中几条"）——
 * 不给的话什么都不发生。生产路径只用它记日志。
 */
export function createRecallExecutor(input: {
  repos: RecallToolRepos
  conversationId: string
  onCall?: (event: { query: string; hits: number }) => void
}): (call: LlmToolCall) => string {
  return (call) => {
    const args = JSON.parse(call.argumentsJson) as { query?: unknown }
    const query = typeof args.query === "string" ? args.query : ""
    // 空检索词不去查库：FTS 空表达式的行为不稳定，且这本来就是模型的失误
    if (query.trim() === "") {
      input.onCall?.({ query: "", hits: 0 })
      return "检索词是空的，没有执行检索。"
    }
    const result = recallMessages(input.repos, query, {
      // ★ 锁死在当前会话 —— 模型影响不到这一项
      conversationIds: [input.conversationId],
      limit: RECALL_TOOL_LIMIT,
    })
    input.onCall?.({ query, hits: result.hits.length })
    return renderRecallForPrompt(result)
  }
}
