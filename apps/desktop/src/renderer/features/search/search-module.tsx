/**
 * SearchModule — 搜索模块的容器。
 *
 * 只做三件事：会话状态、把 IPC 结果转成组件的 props、降级提示的文案选择。
 * 布局与交互在 SearchView / SessionView 里，检索在主进程里 ——
 * 这一层刻意保持薄，因为它是最难测的一层（依赖 IPC 与 react-query）。
 */
import { useMemo, useState } from "react"
import type { ChatItem } from "@mycontext/agent-runtime"
import {
  useCancelSearch,
  useCreateSearchSession,
  useSearchPrompt,
  useSearchSessionDetail,
  useSearchStream,
} from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { toChatItems } from "../agent-stream/to-chat-items.js"
import { SearchView } from "./search-view.js"
import { SessionView } from "./session-view.js"

export interface SearchModuleProps {
  userName: string
  /** 当前选中的会话（由侧栏驱动）；null 表示首屏 */
  activeSessionId: string | null
  onSessionCreated: (sessionId: string) => void
}

export function SearchModule({ userName, activeSessionId, onSessionCreated }: SearchModuleProps) {
  const { t } = useDynamicTranslation("search")
  const detail = useSearchSessionDetail(activeSessionId)
  const createSession = useCreateSearchSession()
  const prompt = useSearchPrompt()
  const cancel = useCancelSearch()
  const [pendingQuery, setPendingQuery] = useState<string | null>(null)
  const stream = useSearchStream(activeSessionId)

  /**
   * 降级提示。
   *
   * 判据**跟本轮实际走的路**走：优先用 stream 带下来的运行时 `degradedReason`
   * （agent 起不来落回召回时非空），退回静态判断（装没装 opencode）。
   * opencode 缺失是常态（102MB，不随包），所以这不是错误 —— 但必须明示，
   * 因为"答案质量突然变差"比"明确告知能力降级"难排查得多。
   */
  const degradedNotice =
    stream.degradedReason ??
    (detail.data !== undefined && !detail.data.agentAvailable ? t("degraded.noAgent") : null)

  // 传输形态 → 渲染形态。与数字分身共用同一个适配（见 to-chat-items 文件头）。
  const items = useMemo<ChatItem[]>(
    () => (detail.data === undefined ? [] : toChatItems(detail.data.items)),
    [detail.data],
  )

  /** 首屏提交：先建会话，再把第一条查询发出去。 */
  const submitFromHome = (query: string): void => {
    setPendingQuery(query)
    createSession.mutate(query, {
      onSuccess: (session) => {
        onSessionCreated(session.id)
        prompt.mutate({ sessionId: session.id, query }, { onSettled: () => setPendingQuery(null) })
      },
      onError: () => setPendingQuery(null),
    })
  }

  if (activeSessionId === null) {
    return (
      <SearchView
        userName={userName}
        onSubmit={submitFromHome}
        disabled={createSession.isPending || pendingQuery !== null}
        degradedNotice={degradedNotice}
      />
    )
  }

  return (
    <SessionView
      items={items}
      busy={prompt.isPending || detail.data?.session.state === "streaming"}
      onSubmit={(query) => prompt.mutate({ sessionId: activeSessionId, query })}
      onStop={() => cancel.mutate(activeSessionId)}
      degradedNotice={degradedNotice}
    />
  )
}
