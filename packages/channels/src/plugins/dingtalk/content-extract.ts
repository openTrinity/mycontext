/**
 * 从消息 `content` 文本里抽取结构化信息（媒体、@提及）。
 *
 * ## 为什么必须从文本里抽，而不是读字段
 *
 * 实测 `chat message list-all` 返回的消息**只有这些字段**：
 * `content, createTime, emotionReplyList, forwardMessages, openConversationId,
 *  openMessageId, quotedMessage, sender, senderOpenDingTalkId`
 *
 * **没有 `msgType`、没有 `atUsers`、没有 `mediaId` 字段。**
 * 媒体与 @ 全部内嵌在 `content` 的文本标记里。
 *
 * 这直接推翻了首版 `parseOneMessage` 的两处判定：
 * · `hasMedia` 查 `msgType === "image"` → **恒为 false**（字段不存在）；
 * · `parseMentions` 读 `atUsers` → **恒为空数组**（字段不存在）。
 * 两处都是静默失效：不报错，只是媒体和 @ 永远采不到。
 * 实测 1688 条消息里有 200 条图片、164 条带 mediaId、524 条含 @。
 */

/** 媒体资源。一期只记元数据，不下载字节（`path` 为 NULL 即表示未下载）。 */
export interface ParsedMedia {
  kind: "image" | "file" | "audio" | "video"
  /** 平台侧资源 ID（mediaId 或 fileId） */
  resourceId: string
  /**
   * 用哪个命令取：mediaId 走 `chat message download-media`，fileId 走 `drive download`。
   *
   * 类型是 `string` 而不是这两个字面量的联合 —— 这一列要跨渠道存
   * （飞书的资源标识体系完全不同），在渠道无关的契约里收紧成钉钉的两个值
   * 会让下一个渠道无法复用。取值范围由各渠道自己的解析器负责。
   */
  resourceKind: string
  /** 文件名（仅 file 有） */
  originalName: string | null
}

/**
 * 抽取媒体。
 *
 * ## 判据是 `mediaId=` / `fileId:` 而**不是**中文标签
 *
 * 实测 content 里的方括号标记绝大多数是**表情符号**而非媒体：
 * `[狗子]` 22 次、`[忍者]` 19 次、`[地球]` 14 次、`[一脸苦笑]` 13 次……
 * 按「有方括号就是媒体」判会把表情全当成媒体（噪声压倒信号）。
 *
 * 真正的判据是**资源 ID 的存在**：
 * · `[图片消息](mediaId=@lQLPKG-foZGeBQ...)` —— 实测 200 条图片**全部**带 mediaId（0 例外）；
 * · `[文件] .env fileId: 4lgGw3P8vzw9zZ... 注意：如需下载使用dws drive download命令下载`
 *
 * 用 ID 而不用标签还有一个好处：标签是**本地化文本**（"图片消息"），
 * 而 `mediaId=` 是协议标识。换语言环境标签会变，判据不会。
 */
export function extractMedia(content: string | null): ParsedMedia[] {
  if (content === null || content === "") return []
  const out: ParsedMedia[] = []

  // `(mediaId=<id>)` —— id 里出现 `@` `$` `-` `_` 等，实测不含 `)`。
  for (const match of content.matchAll(/\(mediaId=([^)\s]+)\)/g)) {
    const resourceId = match[1]
    if (resourceId === undefined || resourceId === "") continue
    out.push({
      // 一期只区分图片与文件：实测语料里没有 audio/video 样本，
      // 猜一个 kind 不如留给二期见到真实样本再加（错的 kind 比缺失更难查）。
      kind: "image",
      resourceId,
      resourceKind: "mediaId",
      originalName: null,
    })
  }

  // `[文件] <name> fileId: <id>` —— 文件名在标记与 fileId 之间。
  for (const match of content.matchAll(/\[文件\]\s*(.*?)\s*fileId:\s*(\S+)/g)) {
    const resourceId = match[2]
    if (resourceId === undefined || resourceId === "") continue
    const name = (match[1] ?? "").trim()
    out.push({
      kind: "file",
      resourceId,
      resourceKind: "fileId",
      originalName: name === "" ? null : name,
    })
  }

  return out
}

/**
 * 抽取 @ 提及的**显示文本**。
 *
 * 实测格式是 `@真名(花名)`，例如 `@吴敏(吴敏)` `@李明(小李)` `@张伟(小张)`。
 * 82 个不同形态、524 条消息命中。
 *
 * ★ 返回的是**显示名，不是 ID** —— 这是个硬约束而不是偷懒：
 * 显示名无法安全映射到 openDingTalkId（实测同名同姓有 5+ 个不同 ID，
 * 这正是 `self-identity.ts` 整套绕法的由来）。把猜的 ID 写进
 * `message_mentions.actor_external_id` 会让数字人的「@我」触发误判 ——
 * 而误判的方向是**替别人回消息**，代价远大于漏一条。
 *
 * 所以调用方只用它做一件事：与**本人已知的名字集合**比对（本人的名字唯一且已确认，
 * 不存在歧义）。对其他人的 @ 不落 mentions 表 —— 原文完整保留在
 * `content_text` 里，蒸馏与图谱都读得到，只是少一个索引维度。
 *
 * ## 括号嵌套
 *
 * 实测存在 `@小郭(林序（青禾）)` —— 花名内部还有全角括号。
 * 因此括号内的匹配用 `[^)]*` 允许全角括号，只在遇到**半角** `)` 时结束。
 */
export function extractMentionTexts(content: string | null): string[] {
  if (content === null || content === "") return []
  const out: string[] = []
  // @ 后的名字部分：不含空白与括号；可选的 `(别名)` 部分允许内含全角括号。
  for (const match of content.matchAll(/@([^\s(（[\]]{1,24})(?:\(([^)]{0,24})\))?/g)) {
    const primary = match[1]
    if (primary === undefined || primary === "") continue
    out.push(primary)
    const alias = match[2]
    if (alias !== undefined && alias !== "") out.push(alias)
  }
  return [...new Set(out)]
}

/**
 * 判断这条消息是否 @ 了本人。
 *
 * `selfNames` 应包含 orgUserName（真名）、nick（昵称）、flowerName（花名）——
 * 实测本人在群里显示的是**花名**（`小周`），而 @ 用的是 `@真名(花名)`，
 * 两种形态都要能命中，所以两边都比对。
 *
 * 空集合时返回 false（不是"匹配一切"）：身份未解析出来时宁可不触发，
 * 也不能对全部消息都判成"@我了"。
 */
export function mentionsSelf(
  mentionTexts: readonly string[],
  selfNames: ReadonlySet<string>,
): boolean {
  if (selfNames.size === 0) return false
  return mentionTexts.some((text) => selfNames.has(text))
}
