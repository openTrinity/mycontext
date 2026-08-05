/**
 * 钉钉的会话列表（蒸馏源选择用）。
 *
 * ## ★ 这个命令的分页是**坏的** —— 三条都实测过，不要照文档写
 *
 * `chat list-all-conversations --help` 说：「--limit 每页数量（最大 100，默认
 * 1000）…返回 hasMore=true 时用 nextCursor 作为下次 --cursor 继续翻页」。
 * 实测（账号有 113+ 个会话）：
 *
 * | 帮助文档说 | 实测 |
 * | --- | --- |
 * | `--limit` 默认 1000 | **上限 100**。传 101/150/200/1000 都只回 100 条，无警告 |
 * | `hasMore=true` 时继续翻 | **恒为 false**。`--limit 50` 只回 50 条时它也是 false |
 * | `--cursor` 传 nextCursor 翻页 | **完全无效**。cursor=0/1/50 返回**逐字相同**的首页 |
 *
 * 响应里也**没有** `nextCursor` 字段（只有 `conversations` 与 `hasMore`）。
 *
 * 三条合起来的后果：**这个命令只能拿到一个固定的 100 条窗口，拿不到全部**。
 * 按文档写出来的翻页循环会「跑一页就停」并且看起来很正常 —— 那正是最坏的情况：
 * 你以为拿到了全部，实际只有前 100 个。
 *
 * ## 因此这里用三路合并，而不是翻页
 *
 * 1. `list-all-conversations --limit 100` —— 最近 100 个会话（单聊+群聊），
 *    **带 `lastMsgCreateAt`**（唯一有最后消息时间的来源）；
 * 2. 同一命令加 `--exclude-muted` —— 免打扰被排除后窗口**下移**，实测**多出 13 个**
 *    （5 单聊 / 6 内部群 / 2 外部群）。一次额外调用约 0.7s，换 13 个会话值得；
 * 3. `chat group list-all` —— 这条的分页是**真的**（实测 73 + 39 = 112 个群，
 *    两页零重叠，`hasMore` 诚实，`nextCursor` 是个真游标）。补全群聊那一半：
 *    实测有 60 个群落在会话窗口之外，只用第 1 路就会全丢。
 *
 * 实测（`node scripts/check-conversations.mjs`，真实账号）：
 * 三路各自 100 / 100 / 73 → **合并 173**（单聊 61 / 群聊 112），
 * 比单命令**多出 73 个**，耗时约 4.8s。
 *
 * ## 仍然可能不全 —— 所以要如实上报
 *
 * 单聊只能来自 1 与 2 的窗口，没有任何命令能全量列单聊。因此返回值带
 * `truncated`，让 UI 说清"列表可能不完整"而不是让用户以为选项就这些。
 * 静默截断在这个项目里已经出过一次（`minutes list` 不带 scope），
 * 代价是"数据看着对但少了一半"。
 *
 * ## 两个与消息接口**不一样**的字段形态（用错会静默出错）
 *
 * · 类型判据是 `groupType`（`SINGLE_CHAT` / `INTERNAL_GROUP` /
 *   `NEW_EXTERNAL_GROUP` / `UNKNOWN_TYPE`）**或** `singleChat` 布尔；两个都给；
 * · 时间是 **ISO-8601 带时区**（`"2026-07-29T23:07:52.044+08:00"`），
 *   不是消息接口那种 `"yyyy-MM-dd HH:mm:ss"` 本地串。喂 `parseDwsLocalTime`
 *   会得到 NaN，而 NaN 排序让列表顺序随机 —— 看起来像"列表是乱的"，
 *   而不像"时间解析错了"。
 */
import type {
  ChannelConversationItem,
  ChannelConversationList,
  ChannelConversations,
} from "../../types.js"
import type { DwsCli } from "./cli.js"

/**
 * 会话列表单页条数。
 *
 * 写 100 而不是文档说的 1000：实测就是硬上限（见文件头）。
 * 写 1000 不会报错，只会让人以为要到了 1000 条。
 */
const CONVERSATION_LIMIT = 100

/** 群列表单页条数。这条命令的 `--limit` 上限实测是 200，但分页是好的，取 100 稳妥。 */
const GROUP_PAGE_LIMIT = 100

/** 群列表最多翻几页 —— 防异常响应下无限翻页。100×20 = 2000 个群，远超真实规模。 */
const GROUP_MAX_PAGES = 20

interface RawConversation {
  openConversationId?: unknown
  title?: unknown
  name?: unknown
  groupType?: unknown
  singleChat?: unknown
  memberCount?: unknown
  lastMsgCreateAt?: unknown
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * 解析 ISO-8601 时间。
 *
 * 与消息接口的 `parseDwsLocalTime` **不能混用**（见文件头）：
 * 那个函数按固定偏移解析 `"yyyy-MM-dd HH:mm:ss"`，喂它 ISO 串会得到 NaN。
 * 这里的串自带时区，`Date.parse` 就是对的。
 */
function parseIsoTime(value: unknown): number | null {
  const text = str(value)
  if (text === null) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

/** 判定单聊/群聊。`groupType` 优先，退回 `singleChat` 布尔。 */
function classify(raw: RawConversation): "direct" | "group" {
  const groupType = str(raw.groupType)
  if (groupType === "SINGLE_CHAT") return "direct"
  if (groupType !== null) return "group"
  return raw.singleChat === true ? "direct" : "group"
}

function toItem(raw: RawConversation): ChannelConversationItem | null {
  const externalId = str(raw.openConversationId)
  // 没有 id 的条目跳过：它既选不了也存不进（scope 里存的就是这个 id）
  if (externalId === null) return null
  return {
    externalId,
    title: str(raw.title) ?? str(raw.name),
    kind: classify(raw),
    memberCount: num(raw.memberCount),
    lastMessageAt: parseIsoTime(raw.lastMsgCreateAt),
  }
}

/**
 * 合并一批条目。
 *
 * 先到的优先，但**空字段可被后来的补上** —— 群列表没有 `lastMsgCreateAt`，
 * 会话列表有；反过来会话列表窗口外的群只有群列表能提供标题与人数。
 * 直接后写覆盖会把已知的时间擦成 null（那会让排序把它掉到最后）。
 */
function absorb(
  into: Map<string, ChannelConversationItem>,
  items: ChannelConversationItem[],
): void {
  for (const item of items) {
    const existing = into.get(item.externalId)
    if (existing === undefined) {
      into.set(item.externalId, item)
      continue
    }
    into.set(item.externalId, {
      externalId: item.externalId,
      title: existing.title ?? item.title,
      // 两个来源的类型判据是同一个字段，冲突时保留先到的
      kind: existing.kind,
      memberCount: existing.memberCount ?? item.memberCount,
      lastMessageAt: existing.lastMessageAt ?? item.lastMessageAt,
    })
  }
}

export function createDingTalkConversations(cli: Pick<DwsCli, "json">): ChannelConversations {
  /** 拉一次会话窗口。`excludeMuted` 为真时窗口下移（见文件头第 2 路）。 */
  async function conversationWindow(
    excludeMuted: boolean,
    signal?: AbortSignal,
  ): Promise<ChannelConversationItem[]> {
    const args = ["chat", "list-all-conversations", "--limit", String(CONVERSATION_LIMIT)]
    if (excludeMuted) args.push("--exclude-muted")
    const payload = await cli.json<unknown>(args, signal === undefined ? {} : { signal })
    if (typeof payload !== "object" || payload === null) return []
    const record = payload as { conversations?: unknown }
    const items = Array.isArray(record.conversations) ? record.conversations : []
    const out: ChannelConversationItem[] = []
    for (const entry of items) {
      if (typeof entry !== "object" || entry === null) continue
      const item = toItem(entry as RawConversation)
      if (item !== null) out.push(item)
    }
    return out
  }

  /** 翻完群列表。这条命令的游标是真的，所以这里是真的翻页循环。 */
  async function allGroups(signal?: AbortSignal): Promise<ChannelConversationItem[]> {
    const out: ChannelConversationItem[] = []
    let cursor: string | null = null

    for (let page = 0; page < GROUP_MAX_PAGES; page += 1) {
      const args = ["chat", "group", "list-all", "--limit", String(GROUP_PAGE_LIMIT)]
      if (cursor !== null) args.push("--cursor", cursor)
      const payload = await cli.json<unknown>(args, signal === undefined ? {} : { signal })
      if (typeof payload !== "object" || payload === null) break
      const record = payload as { groups?: unknown; hasMore?: unknown; nextCursor?: unknown }
      const groups = Array.isArray(record.groups) ? record.groups : []
      for (const entry of groups) {
        if (typeof entry !== "object" || entry === null) continue
        const item = toItem(entry as RawConversation)
        // 群列表没有 lastMsgCreateAt，item.lastMessageAt 必然是 null —— 那是事实，
        // 不要在这里编一个（会话列表能覆盖到的那些会在 absorb 里补上）。
        if (item !== null) out.push({ ...item, kind: "group" })
      }

      if (record.hasMore !== true) break
      // 游标实测是数字（`1782315723736`），但 flag 声明的是 string —— 统一成串。
      const next =
        typeof record.nextCursor === "number" ? String(record.nextCursor) : str(record.nextCursor)
      // 游标没前进（或回了 "0"）就停，否则会拿同一页翻到预算耗尽。
      if (next === null || next === "0" || next === cursor) break
      cursor = next
    }

    return out
  }

  return {
    async list(signal?: AbortSignal): Promise<ChannelConversationList> {
      const merged = new Map<string, ChannelConversationItem>()

      // 顺序有意义：带时间的窗口先进，群列表最后只补窗口外的那些。
      const primary = await conversationWindow(false, signal)
      absorb(merged, primary)
      absorb(merged, await conversationWindow(true, signal))
      absorb(merged, await allGroups(signal))

      const items = [...merged.values()].sort(
        (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
      )

      return {
        items,
        /**
         * 窗口拉满就认为被截断。
         *
         * 判据是"首页正好等于上限"而不是 `hasMore` —— 后者恒为 false（见文件头），
         * 拿它判断等于永远上报"完整"。单聊没有任何全量列举的命令，
         * 所以拉满时唯一诚实的说法就是"可能不全"。
         */
        truncated: primary.length >= CONVERSATION_LIMIT,
      }
    },
  }
}
