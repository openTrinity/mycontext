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
  useChannels,
  useCreateSearchSession,
  useSearchPrompt,
  useSearchSessionDetail,
  useSearchStream,
} from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { toChatItems } from "../agent-stream/to-chat-items.js"
import { SearchView } from "./search-view.js"
import { SessionView } from "./session-view.js"

/**
 * 主渠道 id —— 档位列表里它排第一（SearchView 缺省选第一项）。
 *
 * ★ 渲染层写死这个常量是可接受的：它只影响**排序**。真正的判据在主进程
 * （`SearchServiceOptions.primaryChannelId`），而那边不给缺省。
 */
const PRIMARY_CHANNEL_ID = "dingtalk"

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
  const channels = useChannels()

  /**
   * 可选的检索档位 —— **只列已授权的渠道**。
   *
   * ★ 档位与 kl 启动是解耦的（起哪些 kl 看连了哪些渠道），所以给出一个
   * "没连那个渠道"的档位，结果是那个端口上没有 kl → 连接失败 → 静默降级。
   *
   * ★ 主渠道排**第一**：SearchView 缺省选第一项，于是"不动这个控件"
   * 就是现有行为（零迁移的另一半，另一半在 `agentHomeFor`）。
   *
   * ## ★★ 单渠道时**仍然给一项**，不再返回空数组
   *
   * 原来是 `< 2 → []`（"一个渠道时混合没意义，而 SearchView 少于两项就不渲染
   * 选择器"）。那个理由本身成立，但它造成一个**静默降级**：
   *
   * 用户记得这里有「钉钉 / 飞书 / 混合」三档；某天飞书退了授权（或切换账号
   * 清了凭据），三档**整个消失**且没有任何解释 —— 他的反应是"功能没了"，
   * 而真相是"只剩一个渠道可搜"。实测就是这么发生的（飞书 `not_configured`
   * → 已授权只剩钉钉 → 空数组 → 控件消失）。
   *
   * 现在恒给"每个已授权渠道一项"，≥2 个时才追加 `all` 混合档。
   * `ChannelPicker` 在只有一项时会**退化成静态标识**（见那个组件的文件头），
   * 所以单渠道下用户看到的是「钉钉」这个当前范围而不是一片空白 ——
   * "现在搜的是哪里"始终有答案，另一个渠道回来时混合档自动恢复。
   */
  const scopes = useMemo(() => {
    const authorized = (channels.data ?? []).filter(
      (channel) => channel.available && channel.status.state === "authorized",
    )
    if (authorized.length === 0) return []
    const primaryFirst = [...authorized].sort((a, b) =>
      a.id === PRIMARY_CHANNEL_ID ? -1 : b.id === PRIMARY_CHANNEL_ID ? 1 : 0,
    )
    const perChannel = primaryFirst.map((channel) => ({
      id: channel.id,
      label: t(channel.labelKey),
    }))
    // 混合档只有两个以上渠道才有意义（一个渠道的"混合"就是它自己）
    if (authorized.length < 2) return perChannel
    return [...perChannel, { id: "all", label: t("scope.all") }]
  }, [channels.data, t])

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

  /** 首屏提交：先建会话（带上档位），再把第一条查询发出去。 */
  const submitFromHome = (query: string, scope: string): void => {
    setPendingQuery(query)
    createSession.mutate(
      { query, ...(scope === "" ? {} : { scope }) },
      {
        onSuccess: (session) => {
          onSessionCreated(session.id)
          prompt.mutate(
            { sessionId: session.id, query },
            { onSettled: () => setPendingQuery(null) },
          )
        },
        onError: () => setPendingQuery(null),
      },
    )
  }

  if (activeSessionId === null) {
    return (
      <SearchView
        userName={userName}
        onSubmit={submitFromHome}
        disabled={createSession.isPending || pendingQuery !== null}
        degradedNotice={degradedNotice}
        scopes={scopes}
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
