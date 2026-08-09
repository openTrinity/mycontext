/**
 * 钉钉的采集实现。
 *
 * 两个命令的实测形态决定了这里的写法：
 * · `chat list-unread-conversations` —— 廉价探针（约 0.7s），
 *   时间字段是 unix ms（`lastMsgCreateAt`）；
 * · `chat message list-all` —— 正文（约 0.6s），
 *   `--start/--end` 必填且要求 `yyyy-MM-dd HH:mm:ss`，
 *   `--cursor` 首页传 `"0"`，`--limit` 必填（默认 50），
 *   返回结构 `conversationMessagesList[].messages[]` **按会话嵌套**。
 *
 * 读路径**无需任何授权**（实测）—— 只有发送才要走宿主 UI 确认。
 * 所以数据面不受授权门影响。
 */
import type {
  ChannelConversationPullSpec,
  ChannelIdentity,
  ChannelIngest,
  ChannelProbeResult,
  ChannelPullPage,
  ChannelPullSpec,
} from "../../types.js"
import type { DwsCli } from "./cli.js"
import { formatDwsLocalTime, normalizeUnix } from "./time.js"
import { parseMessageListPage } from "./message-parse.js"
import { resolveSelf, type AuthIdentityFallback } from "./self-identity.js"

interface UnreadConversationPayload {
  openConversationId?: unknown
  open_conversation_id?: unknown
  conversationId?: unknown
  lastMsgCreateAt?: unknown
  last_msg_create_at?: unknown
  /**
   * ★ 实测字段名是 `unreadPoint`（红点数），**不是** `unreadCount`。
   *
   * 首版只认 `unreadCount`/`unread_count`，两者在真实响应里都不存在 →
   * `unreadCount` 恒为 null → `diffProbe` 里
   * `(conversation.unreadCount ?? 0) > (previous.unreadCount ?? 0)` 恒为 false。
   * 也就是说探针的「未读数变多」这一半判据从未生效，只剩 `lastMsgAt` 那一半。
   * 表现是"探针不够灵敏"而非报错 —— 又一个静默降级。
   */
  unreadPoint?: unknown
  unread_point?: unknown
  unreadCount?: unknown
  unread_count?: unknown
  /** 实测存在：探针就能拿到会话标题与单聊标记，省一次 conversation-info。 */
  singleChat?: unknown
  title?: unknown
}

const UNREAD_CONVERSATION_LIMIT = 1000

function str(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return null
}

function num(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

/**
 * 取出会话数组。
 *
 * 传输层信封已由 `DwsCli.json` 剥掉（见 cli.ts 的 `unwrapEnvelope`），
 * 所以这里拿到的是 `{conversations: [...]}`。仍然保留多候选键的宽松匹配：
 * 少解析出一个字段的表现是静默的数据缺失，比抛错难查得多。
 */
function toArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (typeof payload !== "object" || payload === null) return []
  const record = payload as Record<string, unknown>
  for (const key of ["conversations", "items", "list", "data"]) {
    const value = record[key]
    if (Array.isArray(value)) return value
    if (typeof value === "object" && value !== null) {
      const nested = toArray(value)
      if (nested.length > 0) return nested
    }
  }
  return []
}

export function createDingTalkIngest(cli: Pick<DwsCli, "json">): ChannelIngest {
  return {
    async probe(signal?: AbortSignal): Promise<ChannelProbeResult | null> {
      // ★ 命令路径是 `chat message list-unread-conversations`，**不是** `chat ...`。
      // 首版写的是 `["chat","list-unread-conversations"]`，实测 DWS 返回
      // `unknown subcommand "list-unread-conversations" for "dws chat"` ——
      // 也就是 L1 探针从未真正工作过（表现是"探不到变化"，而非报错，
      // 因为 classifyDwsError 认不出这个内部错误，走的是 PROCESS_FAILED 重试）。
      const payload = await cli.json<unknown>(
        [
          "chat",
          "message",
          "list-unread-conversations",
          "--count",
          String(UNREAD_CONVERSATION_LIMIT),
        ],
        signal === undefined ? {} : { signal },
      )
      const conversations: ChannelProbeResult["conversations"] = []
      for (const item of toArray(payload)) {
        if (typeof item !== "object" || item === null) continue
        const record = item as UnreadConversationPayload
        const externalId = str(
          record.openConversationId,
          record.open_conversation_id,
          record.conversationId,
        )
        if (externalId === null) continue

        // 这个字段实测是 unix ms；仍然过一遍归一函数以防不同版本给秒。
        const rawTime = num(record.lastMsgCreateAt, record.last_msg_create_at)
        let lastMsgAt: number | null = null
        if (rawTime !== null) {
          try {
            lastMsgAt = normalizeUnix(rawTime)
          } catch {
            lastMsgAt = null
          }
        }

        conversations.push({
          externalId,
          lastMsgAt,
          // `unreadPoint` 排在最前：实测这才是真实字段名（见类型注释）。
          unreadCount: num(
            record.unreadPoint,
            record.unread_point,
            record.unreadCount,
            record.unread_count,
          ),
        })
      }
      return {
        conversations,
        // 命中上限时无法证明后面没有更多未读会话；此时不能把缺席会话标成已读。
        completeUnreadSnapshot: conversations.length < UNREAD_CONVERSATION_LIMIT,
      }
    },

    async pull(spec: ChannelPullSpec): Promise<ChannelPullPage> {
      const args = [
        "chat",
        "message",
        "list-all",
        // 必填，且格式固定 —— 用我们的固定偏移格式化，不用 toLocaleString
        "--start",
        formatDwsLocalTime(spec.start),
        "--end",
        formatDwsLocalTime(spec.end),
        // 首页是字符串 "0"（不是空串也不是省略）
        "--cursor",
        spec.cursor ?? "0",
        "--limit",
        String(spec.limit),
      ]
      const payload = await cli.json<unknown>(
        args,
        spec.signal === undefined ? {} : { signal: spec.signal },
      )
      const page = parseMessageListPage(payload)
      return {
        conversations: page.conversations,
        messages: page.messages,
        nextCursor: page.nextCursor,
        /**
         * 以服务端的显式信号为准，不看"有没有 cursor"。
         *
         * ⚠️ 订正：原注释写的是「实测 276/277 页 `hasMore:false` 却仍带非空
         * nextCursor」。**当前 CLI（v1.0.52.1）上那个结论不成立** ——
         * 重新实测 4 天窗共 82 页，其中 **81 页 `hasMore=true`**，
         * 只有最后一页是 false。那条旧结论曾误导出"list-all 翻不动"的判断。
         * 判据仍然用 `hasMore`（它是显式信号，比游标可靠），但理由是
         * "显式优于间接"，不是"游标恒不为空"。
         */
        hasMore: page.hasMore,
        itemCount: page.itemCount,
        // 原始响应整页留档：任何解析 bug 都能从这里重放，不用重新拉。
        rawPayload: JSON.stringify(payload),
        // 保密群等被服务端拒绝的会话（伪消息已在解析层丢掉）。
        refusedConversations: page.refusedConversations,
      }
    },

    async pullConversation(spec: ChannelConversationPullSpec): Promise<ChannelPullPage> {
      /**
       * `chat message list` 的目标三选一互斥：群 `--group`，
       * 单聊 `--open-dingtalk-id`（我们只有对端 openId，没有 userId）。
       *
       * ## ★ 方向由调用方给，且**没有** `--cursor` 可传
       *
       * `newer` = 从 `--time` 往现在拉（增量补拉）；
       * `older` = 从 `--time` 往更早拉（抽干一个会话）。
       *
       * 实测传 `--cursor` 直接 `exit=3`（`unknown flag`）——
       * 这条命令的翻页只能靠推进 `--time`，响应里的 `nextCursor`
       * 无处可传（见 types.ts 里 `ChannelConversationPullSpec` 的文件头）。
       * 所以这里**不回传 cursor**：给一个用不上的游标只会诱导
       * 调用方写出「拿 cursor 翻页」这种永远翻不动的循环。
       */
      const args = [
        "chat",
        "message",
        "list",
        ...(spec.target.kind === "group"
          ? ["--group", spec.target.openConversationId]
          : ["--open-dingtalk-id", spec.target.peerOpenId]),
        "--time",
        formatDwsLocalTime(spec.since),
        "--direction",
        spec.direction ?? "newer",
        "--limit",
        String(spec.limit),
      ]
      const payload = await cli.json<unknown>(
        args,
        spec.signal === undefined ? {} : { signal: spec.signal },
      )
      const page = parseMessageListPage(payload)
      return {
        conversations: page.conversations,
        messages: page.messages,
        /**
         * ★ 恒为 null：这条命令的游标传不回去（见上）。
         *
         * 翻页判据只有 `hasMore` + 调用方自己推进的时间边界。
         */
        nextCursor: null,
        hasMore: page.hasMore,
        itemCount: page.itemCount,
        rawPayload: JSON.stringify(payload),
        refusedConversations: page.refusedConversations,
      }
    },
  }
}

/**
 * @param authIdentity 「`get-self` 拿不到时从授权态取本人身份」的退路。
 *   不给 = 老行为（`get-self` 失败即整条链失败）。
 *   ★ 强烈建议给：实测有客户端对 `contact` 域没开通权限，而那时
 *   `auth status` 里本来就有 `user_id`（见 `resolveSelf` 的注释）。
 */
export function createDingTalkIdentity(
  cli: Pick<DwsCli, "json">,
  authIdentity?: AuthIdentityFallback,
): ChannelIdentity {
  return {
    resolveSelf: (options) =>
      resolveSelf(cli, "dingtalk", {
        ...(options?.inferFromMessages === undefined
          ? {}
          : { inferFromMessages: options.inferFromMessages }),
        ...(authIdentity === undefined ? {} : { authIdentity }),
      }),
  }
}
