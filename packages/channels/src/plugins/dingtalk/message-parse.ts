/**
 * `chat message list-all` 的响应解析。
 *
 * ## 传输层信封已在 `DwsCli.json` 里剥掉
 *
 * 真实响应是 `{arguments, result:{conversationMessagesList, hasMore, nextCursor}, success}`。
 * 首版在**根对象**上找 `conversationMessagesList` —— 而它在 `result` 下，
 * 于是恒返回 `{messages: [], itemCount: 0}`，表现为"这个时间窗没有新消息"。
 * 实测 277 页原始响应 / 1688 条消息、落库 **0** 条，且全程无报错。
 * 信封现在由 cli.ts 统一剥（见那里的 `unwrapEnvelope`），这里只看业务形状。
 *
 * ## 结构是**按会话嵌套**的（不是平铺的消息数组）
 *
 * 实测返回 `conversationMessagesList[].messages[]`，每个会话一组。
 * 按平铺处理会只拿到第一个会话的消息 —— 表现是"只有部分群的消息进来了"，
 * 而这看起来像权限问题而不是解析问题。
 *
 * ## 翻页靠 `hasMore` + `nextCursor`（都在 result 下）
 *
 * ★ 首版注释里写着「DWS 的 list-all 实测从不返回 cursor」—— **那个结论是错的**，
 * 是被上面的信封 bug 误导出来的（读根对象自然读不到）。实测真实响应
 * `hasMore: true` 且 `nextCursor` 是 200+ 字符的实串。
 * 也就是说翻页逻辑此前从未被执行过。
 */
import { parseDwsLocalTime, normalizeUnix } from "./time.js"
import { extractMedia, extractMentionTexts, type ParsedMedia } from "./content-extract.js"

export interface ParsedMessage {
  externalId: string
  conversationExternalId: string
  senderExternalId: string | null
  senderDisplayName: string | null
  contentText: string | null
  contentJson: string | null
  quotedExternalId: string | null
  /** unix ms（已按渠道时区归一） */
  sentAt: number
  mentions: { actorExternalId: string }[]
  /**
   * @ 到的**显示名**（真名与花名都收）。
   *
   * 与 `mentions` 分开是刻意的：`mentions` 存的是 ID，而显示名无法安全映射成 ID
   * （同名同姓实测 5+ 个）。上层只用它与本人已知名字比对。见 content-extract.ts。
   */
  mentionTexts: string[]
  hasMedia: boolean
  /** 媒体元数据（一期不下载字节） */
  media: ParsedMedia[]
}

export interface ParsedConversation {
  externalId: string
  title: string | null
  type: "direct" | "group"
  memberCount: number | null
}

export interface ParsedMessagePage {
  conversations: ParsedConversation[]
  messages: ParsedMessage[]
  nextCursor: string | null
  /** 本页返回的消息条数（截断检测用） */
  itemCount: number
  /**
   * 服务端明确告知的「还有下一页」。
   *
   * 与 `nextCursor` 分开保留：`hasMore === false` 是**显式**的结束信号，
   * 比"cursor 为空"这个间接信号可靠。首版只看 cursor，而 cursor 因为信封 bug
   * 恒为 null → 每一页都被当成最后一页。
   */
  hasMore: boolean
  /**
   * 服务端**拒绝读取**的会话 external_id（保密群等）。
   *
   * ★ 与「这个会话本页没有消息」必须区分开 —— 这正是 CLAUDE.md 第 5 节
   * 那条硬规则：识别到就跳过，并明确记成「不可读」而不是「0 条」。
   *
   * 判据是本页里出现了服务端的拒绝提示伪消息（见 `isRefusalContent`）。
   * 调用方应据此把会话标记为不可读并**永久跳过**，不要重试 ——
   * 服务端拒绝就是拒绝，换接口换参数试探是被明确禁止的。
   */
  refusedConversations: string[]
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * 解析时间：优先 unix 字段，退回本地时间串。
 *
 * 两者都拿不到时返回 null 让调用方跳过这条 ——
 * **不能默认成 0 或当前时间**：前者会让消息落到 1970（图谱的时间维度失真），
 * 后者会让历史消息看起来是刚发的（时间线彻底错乱）。两种错都是静默的。
 */
function parseSentAt(record: Record<string, unknown>): number | null {
  const unix = num(record["createTimestamp"]) ?? num(record["create_time_ms"])
  if (unix !== null) {
    try {
      return normalizeUnix(unix)
    } catch {
      return null
    }
  }
  const text = str(record["createTime"]) ?? str(record["create_time"])
  if (text === null) return null
  try {
    return parseDwsLocalTime(text)
  } catch {
    return null
  }
}

/**
 * 结构化的 @ 字段。
 *
 * ⚠️ 实测 `list-all` 的消息里**没有** `atUsers`，@ 只在 content 文本里
 * （见 content-extract.ts）。保留这个函数是因为其它命令（或未来版本）可能带该字段，
 * 带了就用 —— 那是真 ID，比从文本猜可靠得多。
 */
function parseMentions(record: Record<string, unknown>): { actorExternalId: string }[] {
  const raw = record["atUsers"] ?? record["at_users"] ?? record["mentions"]
  if (!Array.isArray(raw)) return []
  const out: { actorExternalId: string }[] = []
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ actorExternalId: item })
      continue
    }
    if (typeof item === "object" && item !== null) {
      const record2 = item as Record<string, unknown>
      const id =
        str(record2["openDingTalkId"]) ??
        str(record2["open_dingtalk_id"]) ??
        str(record2["userId"]) ??
        str(record2["id"])
      if (id !== null) out.push({ actorExternalId: id })
    }
  }
  return out
}

/**
 * 「服务端把拒绝理由塞进 content」的伪消息判据。
 *
 * ## ★ 这不是防御性编程，是实测到的真实响应
 *
 * 保密群（`groupType=INTERNAL_GROUP`、17638 人）在 `chat message list`
 * 上是硬拒的（`server_error_code=1001`，三种 direction 都拒）。
 * 但 `list-all` 对同一个群**返回了 13 条**，形态是：
 *
 * · `content` = `"该群为保密群，无法获取消息记录"`（13 条一字不差）
 * · `sender` / `createTime` / `openMessageId` = **真实值**（9 个真实姓名）
 *
 * 两个后果都必须挡住：
 * ① **隐私**：正文虽然没漏，但「谁在这个保密群里、什么时候发言」漏了。
 *    服务端已经明确拒绝这个群，我们不该从另一个接口把成员活动记下来。
 * ② **静默失效**：这 13 条会入库，于是界面上显示「已采集 13 条」——
 *    把**不可读**伪装成**已采集**。CLAUDE.md 第 5 节要求的正是相反：
 *    识别到就跳过，并明确记成「不可读」而不是「0 条」。
 *
 * ## 判据为什么是「整条 content 精确等于这句话」
 *
 * 不用 `includes("保密群")`：真实聊天里完全可能有人**讨论**保密群
 * （"这个群要不要设成保密群"），那是正常语料，误杀它等于丢数据。
 * 实测全量 4205 条里，命中这个精确判据的只有那 13 条伪消息，
 * 而含"保密群"字样的正常消息 0 条 —— 但精确匹配让将来出现时也不误杀。
 *
 * 同理不匹配 `permission` 之类的英文片段：实测全量里有 2 条正常消息
 * 含 `permission`（在讨论代码），宽松匹配会把它们当伪消息丢掉。
 */
const REFUSAL_CONTENTS: readonly string[] = [
  "该群为保密群，无法获取消息记录",
  "该群为保密群,无法获取消息记录",
]

/**
 * 这条消息是不是服务端的拒绝提示（而非真实消息）。
 *
 * 命中的会话应被记成「不可读」，见 `ParsedMessagePage.refusedConversations`。
 */
function isRefusalContent(text: string | null): boolean {
  if (text === null) return false
  return REFUSAL_CONTENTS.includes(text.trim())
}

/**
 * 这一条原始记录是不是服务端的拒绝提示伪消息。
 *
 * 在**进** `parseOneMessage` 之前判：那样调用方能拿到会话 id 去记
 * 「不可读」，而如果只在 parse 内部返回 null，外面就分不出
 * 「这条解析失败」与「这个会话被拒」。
 */
function isRefusalMessage(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false
  const record = raw as Record<string, unknown>
  return isRefusalContent(str(record["content"]) ?? str(record["text"]))
}

/**
 * 剥掉 `content` 上的**富文本信封**。
 *
 * ## ★ 实测：`content` 有两种形态，同一次调用的同一页里**混着出现**
 *
 * 绝大多数是纯文本，但有一部分是一层 JSON 字符串，形如
 * `{"textContent":{"text":<正文>},"contentType":<数字>}`。
 *
 * 判据是**逐条**而不是按版本/按会话/按命令：实测同一个 raw payload 里
 * 47 条包裹 + 1 条明文，`list-all` 与 `chat message list` 都会出现。
 * 形态高度一致 —— 采样 972 条，顶层键**只有** `{contentType, textContent}`
 * 这一种组合，内层**只有** `{text}`（contentType 见过 1/2/102/300/501/1200/1201/3100）。
 *
 * ## 不剥的后果：整条 JSON 被当成正文，而且**完全静默**
 *
 * · UI 上直接把那串 JSON 显示成消息正文；
 * · `extractMedia` / `extractMentionTexts` 在这条 JSON 文本上跑 ——
 *   媒体标记与 @ 都埋在内层，抽取判据全部错位；
 * · 最贵的一条：这些消息**照常进蒸馏语料**。实测一个真实库里 863 条这种行，
 *   其中约百条是本人消息（`is_self=1`）—— 也就是画像里混进了
 *   上百条"说话像 JSON"的样本。
 *
 * 这不是某个 dws 版次引入的差异：闭源版与开源版采的库里都有，只是没人注意到。
 *
 * ## 判据刻意保守
 *
 * 只在「能解析成 JSON 对象」且「有 `textContent.text` 字符串」时才剥，
 * 其余原样返回。宁可漏剥（表现是 UI 上一条难看的消息）也不能误剥 ——
 * 真有人发一条以 `{` 开头的纯文本时，把它改写成别的东西是不可逆的语料污染。
 */
export function unwrapRichContent(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  // 快路：绝大多数是纯文本，不进 JSON.parse。
  if (!trimmed.startsWith("{") || !trimmed.includes("textContent")) return raw

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return raw
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return raw

  const textContent = (parsed as Record<string, unknown>)["textContent"]
  if (typeof textContent !== "object" || textContent === null) return raw

  const text = (textContent as Record<string, unknown>)["text"]
  // 空串是**有效**结果（如纯图片消息的 text 为 ""）：用 `typeof` 判而不是真值判，
  // 否则空串会退回去返回整条 JSON。
  return typeof text === "string" ? text : raw
}

function parseOneMessage(raw: unknown, conversationExternalId: string): ParsedMessage | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>

  const externalId =
    str(record["openMessageId"]) ?? str(record["open_message_id"]) ?? str(record["messageId"])
  if (externalId === null) return null

  const sentAt = parseSentAt(record)
  if (sentAt === null) return null

  const quoted = record["quotedMessage"] ?? record["quoted_message"]
  const quotedId =
    typeof quoted === "object" && quoted !== null
      ? (str((quoted as Record<string, unknown>)["openMessageId"]) ??
        str((quoted as Record<string, unknown>)["open_message_id"]))
      : null

  /**
   * ★ 先剥富文本信封：实测有一部分 content 是
   * `{"textContent":{"text":"…"},"contentType":N}`（见 `unwrapRichContent`）。
   *
   * 必须在 `extractMedia` / `extractMentionTexts` **之前**剥 —— 那两个抽取器
   * 的判据是正文里的标记，在一条 JSON 上跑等于全部错位。
   *
   * 与下面的 `isRefusalContent` 顺序无关（拒绝提示是纯文本，不带信封），
   * 但剥在前面更安全：万一将来服务端把拒绝理由也包起来，判据仍然命中。
   */
  const contentText = unwrapRichContent(str(record["content"]) ?? str(record["text"]))
  /**
   * ★ 兜底：拒绝提示伪消息不该变成一条消息。
   *
   * 主判据在 `parseMessageListPage` 里（那里能拿到会话 id 去记「不可读」，
   * 见 `isRefusalMessage`）。这里再拦一次是因为本函数还有别的调用路径
   * （将来新增的解析分支），而漏掉的后果是**真实姓名与发言时间入库**。
   */
  if (isRefusalContent(contentText)) return null
  // 富文本/卡片：原样留一份 JSON，二期渲染富消息时不用重新采集。
  //
  // `forwardMessages`（合并转发的聊天记录）也收进来 —— 实测存在，
  // 结构与顶层 message 同形。**刻意不展开成独立 message 行**：
  // 转发进来的消息不属于当前会话，展开会让「谁在哪个会话说了什么」的归属变糊，
  // 且它的 openMessageId 会与原会话里那一行撞唯一键。
  const structured =
    record["contentJson"] ??
    record["richContent"] ??
    record["card"] ??
    (record["forwardMessages"] === undefined
      ? undefined
      : { forwardMessages: record["forwardMessages"] })

  const media = extractMedia(contentText)

  return {
    externalId,
    conversationExternalId:
      str(record["openConversationId"]) ??
      str(record["open_conversation_id"]) ??
      conversationExternalId,
    senderExternalId:
      str(record["senderOpenDingTalkId"]) ??
      str(record["sender_open_dingtalk_id"]) ??
      str(record["senderId"]),
    senderDisplayName: str(record["sender"]) ?? str(record["senderName"]),
    contentText,
    contentJson: structured === undefined ? null : JSON.stringify(structured),
    quotedExternalId: quotedId,
    sentAt,
    mentions: parseMentions(record),
    mentionTexts: extractMentionTexts(contentText),
    // ★ 以**抽出来的媒体**为准，不看 msgType —— 实测 list-all 里没有那个字段，
    // 首版的 `str(record["msgType"]) === "image"` 恒为 false。
    hasMedia:
      media.length > 0 ||
      record["hasMedia"] === true ||
      str(record["msgType"]) === "image" ||
      str(record["msgType"]) === "file",
    media,
  }
}

/**
 * 判定单聊 / 群聊。
 *
 * ★ 实测 group 层**只有** `["messages","openConversationId","singleChat","title"]`
 * 这四个字段 —— 首版找的 `conversationType`/`type`/`memberCount` **三个都不存在**，
 * 于是全部落到默认分支 `direct`：实测 9 个会话（含「云智能全员群」）
 * **全被判成单聊**。这是数字人「只监听单聊 / 只监听群聊」的判据，错了直接错授权范围。
 *
 * `singleChat` 是布尔，优先用它；其余候选保留给别的命令/版本。
 */
function classifyConversation(record: Record<string, unknown>): "direct" | "group" {
  const single = record["singleChat"] ?? record["single_chat"]
  if (typeof single === "boolean") return single ? "direct" : "group"

  const type = str(record["conversationType"]) ?? str(record["type"])
  if (type === "1" || type === "direct" || type === "single") return "direct"
  if (type === "2" || type === "group") return "group"
  // 无类型字段时按成员数推断：> 2 人必然是群。
  const members = num(record["memberCount"]) ?? num(record["member_count"])
  return members !== null && members > 2 ? "group" : "direct"
}

/**
 * 解析一页 `list-all` 响应。
 *
 * 对未知字段名保持宽松（同时试驼峰与下划线）：
 * 外部 CLI 的字段命名在不同版本间会变，而"少解析出一个字段"的表现是
 * 静默的数据缺失，比抛错难查得多。
 *
 * ## 同时接受「已剥信封」与「带信封」两种输入
 *
 * 正常路径下 `DwsCli.json` 已经剥掉信封了。但 `raw_records` 里**已经存下的**
 * 历史记录是**带信封**的整页响应（那是修复前的写入形态），而留存原生记录的
 * 全部意义就是"解析 bug 修好后能重放"。若这里只认剥好的形状，
 * 那 277 页已采数据就只能重新调 CLI 去拉 —— 等于放弃了重放能力。
 * 所以这里再兜一层：看到信封就进 `result`。
 */
export function parseMessageListPage(payload: unknown): ParsedMessagePage {
  const conversations: ParsedConversation[] = []
  const messages: ParsedMessage[] = []
  /** 命中拒绝提示的会话（保密群等）。用 Set 去重：一页里会有十几条同样的伪消息。 */
  const refused = new Set<string>()

  if (typeof payload !== "object" || payload === null) {
    return {
      conversations,
      messages,
      nextCursor: null,
      itemCount: 0,
      hasMore: false,
      refusedConversations: [],
    }
  }
  let root = payload as Record<string, unknown>

  // 带信封的输入（历史 raw_records / 直接喂原始响应）：进 result。
  if ("success" in root && "result" in root) {
    const inner = root["result"]
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      root = inner as Record<string, unknown>
    }
  }

  const groups =
    root["conversationMessagesList"] ??
    root["conversation_messages_list"] ??
    root["conversations"] ??
    root["data"]

  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (typeof group !== "object" || group === null) continue
      const record = group as Record<string, unknown>
      const conversationId =
        str(record["openConversationId"]) ??
        str(record["open_conversation_id"]) ??
        str(record["conversationId"])
      if (conversationId === null) continue

      conversations.push({
        externalId: conversationId,
        title: str(record["conversationTitle"]) ?? str(record["title"]) ?? str(record["name"]),
        type: classifyConversation(record),
        // 实测 list-all 不返回成员数 → 保持 null（不猜）。
        memberCount: num(record["memberCount"]) ?? num(record["member_count"]),
      })

      const items = record["messages"] ?? record["messageList"] ?? record["items"]
      if (!Array.isArray(items)) continue
      for (const item of items) {
        // ★ 先判拒绝提示：命中的会话要记成"不可读"，而不是让它表现成"0 条"。
        if (isRefusalMessage(item)) {
          refused.add(conversationId)
          continue
        }
        const parsed = parseOneMessage(item, conversationId)
        if (parsed !== null) messages.push(parsed)
      }
    }
  }

  // 有的响应把消息平铺在顶层（单会话查询）—— 也支持。
  // 嵌套分组已处理过时不再重复扫，否则同一条消息会被解析两遍。
  const flat = root["messages"] ?? root["messageList"]
  if (!Array.isArray(groups) && Array.isArray(flat)) {
    const flatConversationId = str(root["openConversationId"]) ?? ""
    for (const item of flat) {
      if (isRefusalMessage(item)) {
        // 平铺分支拿不到会话 id 时（单会话查询通常带），只能丢掉这条伪消息。
        if (flatConversationId !== "") refused.add(flatConversationId)
        continue
      }
      const parsed = parseOneMessage(item, flatConversationId)
      if (parsed !== null) messages.push(parsed)
    }
  }

  /**
   * 游标可能是**字符串也可能是数字** —— 两个命令的形态不同（都实测过）：
   * · `list-all` → 256 字符的字符串（真游标，有 `--cursor` 可传）；
   * · `chat message list` → 数字（如 `1785723701376`，且**没有** `--cursor`
   *   可传，见 ingest.ts 里 `pullConversation` 的注释）。
   *
   * ★ 原来只用 `str()`，于是数字游标恒解析成 null。它不是"翻页翻不动"
   * 的原因（那条命令本来就传不了游标），但会让 `hasMore` 缺失时的
   * 退路判据（`nextCursor !== null`）恒为 false —— 又一个静默降级。
   * `conversations.ts` 里对群列表的数字游标已经做了同样的归一，
   * 而这里漏了：同一个坑一处修了一处没修。
   */
  const cursorRaw = root["nextCursor"] ?? root["next_cursor"] ?? root["cursor"]
  const cursor =
    typeof cursorRaw === "number" && Number.isFinite(cursorRaw) ? String(cursorRaw) : str(cursorRaw)
  // 服务端的显式信号优先；缺失时退回"有没有 cursor"。
  const more = root["hasMore"] ?? root["has_more"]
  const nextCursor = cursor === null || cursor === "0" ? null : cursor

  return {
    conversations,
    messages,
    // "0" 是首页标记，不是"下一页是 0"；把它当结束更安全（多跑一轮总比死循环好）。
    nextCursor,
    itemCount: messages.length,
    hasMore: typeof more === "boolean" ? more : nextCursor !== null,
    refusedConversations: [...refused],
  }
}

/**
 * 截断检测。
 *
 * `--limit` 的语义未明确（限会话数还是消息数），所以按最保守处理：
 * 达到 90% 就认为可能被截断。宁可多切几次窗口，也不要静默缺一段数据。
 */
export function looksTruncated(itemCount: number, limit: number): boolean {
  return limit > 0 && itemCount >= Math.floor(limit * 0.9)
}
