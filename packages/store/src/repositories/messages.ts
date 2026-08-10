/**
 * 消息仓储。
 *
 * 幂等键 `(channel_id, external_id)`：同一条消息重复采集只会 upsert 同一行。
 * 采集刻意让两层轮询的时间窗重叠（对抗时钟偏差与服务端延迟），
 * 因此「重复拉到同一条」是**常态**，不是异常路径。
 */
import { createHash } from "node:crypto"
import type { SqliteDatabase } from "../database.js"
import type { MessageInput, MessageRow } from "./types.js"

/**
 * 媒体行 id 的稳定后缀。
 *
 * ★ **必须由 resourceId 推导，不能用随机数/时间戳。** 唯一索引
 * `(message_id, resource_id)` 会挡住重复插入，但 `id` 是主键 ——
 * 随机 id 让每次重拉都变成"新主键 + 冲突的唯一键"，靠 DO NOTHING 兜住是
 * 侥幸而非设计；而一旦哪天唯一索引被改动，随机 id 会立刻变成行膨胀。
 * 直接把 id 也做成内容确定的，两层就都幂等了。
 *
 * resourceId 实测含 `@ $ + / =` 等字符（是 base64 变体），不能直接进 id 字符串，
 * 所以取 hash 前 16 位。
 */
function hashResource(resourceId: string): string {
  return createHash("sha256").update(resourceId).digest("hex").slice(0, 16)
}

interface MessageDbRow {
  id: string
  channel_id: string
  conversation_id: string
  external_id: string
  sender_actor_id: string | null
  sender_external_id: string | null
  sender_display_name: string | null
  content_text: string | null
  content_json: string | null
  quoted_external_id: string | null
  thread_id: string | null
  sent_at: number
  direction: "inbound" | "outbound"
  is_self: number | null
  origin: "human" | "agent"
  has_media: number
  raw_record_id: string | null
  revision: number
  created_at: number
}

function toMessage(row: MessageDbRow): MessageRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    externalId: row.external_id,
    senderActorId: row.sender_actor_id,
    senderExternalId: row.sender_external_id,
    senderDisplayName: row.sender_display_name,
    contentText: row.content_text,
    contentJson: row.content_json,
    quotedExternalId: row.quoted_external_id,
    threadId: row.thread_id,
    sentAt: row.sent_at,
    direction: row.direction,
    // ★ 三态：null 保持 null（未判定），不塌缩成 false。
    //   把未判定当"不是本人"会永久丢失人格语料，之后没有信号能纠回来。
    isSelf: row.is_self === null ? null : row.is_self === 1,
    origin: row.origin,
    hasMedia: row.has_media === 1,
    rawRecordId: row.raw_record_id,
    revision: row.revision,
    createdAt: row.created_at,
  }
}

export interface MessageUpsertResult {
  /** 本次真正写入或内容有变化的行（Outbox 只为这些发变更） */
  changed: MessageRow[]
  /** 内容完全一致而被跳过的条数 */
  unchanged: number
}

export class MessageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 批量 upsert。
   *
   * 返回「哪些行真的变了」而不是简单的成功计数：Outbox 只该为**实质变化**
   * 发变更条目，否则重叠窗口会让每轮采集都产生一批无意义的 seq，
   * 而下游（建索引、蒸馏、图谱）会照单全收地重算。
   */
  upsertMany(inputs: readonly MessageInput[]): MessageUpsertResult {
    const insert = this.db.prepare(
      `INSERT INTO messages
         (id, channel_id, conversation_id, external_id, sender_actor_id, sender_external_id,
          sender_display_name, content_text, content_json, quoted_external_id, thread_id,
          sent_at, direction, is_self, origin, has_media, raw_record_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, external_id) DO UPDATE SET
         content_text        = excluded.content_text,
         content_json        = excluded.content_json,
         sender_actor_id     = COALESCE(excluded.sender_actor_id, messages.sender_actor_id),
         sender_display_name = COALESCE(excluded.sender_display_name,
                                        messages.sender_display_name),
         quoted_external_id  = COALESCE(excluded.quoted_external_id,
                                        messages.quoted_external_id),
         has_media           = MAX(messages.has_media, excluded.has_media),
         -- is_self 一旦判定过就不再被覆盖为 null（回填 job 走 markSelf）
         is_self             = COALESCE(messages.is_self, excluded.is_self),
         -- 内容变了才 +1：revision 是"这条被编辑过几次"，不是"被采集过几次"
         revision            = messages.revision +
                               CASE WHEN COALESCE(messages.content_text, '')
                                       IS NOT COALESCE(excluded.content_text, '')
                                    THEN 1 ELSE 0 END
       WHERE COALESCE(messages.content_text, '') IS NOT COALESCE(excluded.content_text, '')
          OR COALESCE(messages.content_json, '') IS NOT COALESCE(excluded.content_json, '')`,
    )
    const mentionInsert = this.db.prepare(
      `INSERT OR REPLACE INTO message_mentions (message_id, actor_external_id, is_self)
       VALUES (?, ?, ?)`,
    )
    /**
     * 媒体：`ON CONFLICT DO NOTHING` 而不是 REPLACE。
     *
     * REPLACE 会把已下载的行（`path` / `sha256` / `downloaded_at` 有值）
     * 覆盖回未下载状态 —— 重叠窗口每轮都会重拉同一条消息，
     * 于是"下载好的图片过几分钟又变成未下载"，而这个回退是静默的。
     * 元数据本身不会变（resourceId 是不可变的平台 ID），所以已存在即跳过。
     */
    const mediaInsert = this.db.prepare(
      `INSERT INTO media_assets
         (id, message_id, kind, resource_id, resource_kind, mime, bytes, original_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, resource_id) DO NOTHING`,
    )

    const changed: MessageRow[] = []
    let unchanged = 0

    for (const input of inputs) {
      const info = insert.run(
        input.id,
        input.channelId,
        input.conversationId,
        input.externalId,
        input.senderActorId ?? null,
        input.senderExternalId ?? null,
        input.senderDisplayName ?? null,
        input.contentText ?? null,
        input.contentJson ?? null,
        input.quotedExternalId ?? null,
        input.threadId ?? null,
        input.sentAt,
        input.direction,
        input.isSelf === null || input.isSelf === undefined ? null : input.isSelf ? 1 : 0,
        input.origin ?? "human",
        (input.hasMedia ?? false) ? 1 : 0,
        input.rawRecordId ?? null,
        input.createdAt,
      )

      if (info.changes === 0) {
        unchanged += 1
        continue
      }

      // 取回**库里那一行**而不是回显入参：冲突分支下 id 与部分字段会保留旧值，
      // 而下游（Outbox、快通道）必须拿到真实的行，否则会去查一个不存在的 id。
      const stored = this.findByExternalId(input.channelId, input.externalId)
      if (stored === null) continue
      changed.push(stored)

      for (const mention of input.mentions ?? []) {
        mentionInsert.run(stored.id, mention.actorExternalId, mention.isSelf ? 1 : 0)
      }

      for (const asset of input.media ?? []) {
        if (asset.resourceId === "") continue // 空 ID 进不了唯一键，跳过
        mediaInsert.run(
          `med_${stored.id}_${asset.resourceKind}_${hashResource(asset.resourceId)}`,
          stored.id,
          asset.kind,
          asset.resourceId,
          asset.resourceKind,
          asset.mime ?? null,
          asset.bytes ?? null,
          asset.originalName ?? null,
        )
      }
    }

    return { changed, unchanged }
  }

  findByExternalId(channelId: string, externalId: string): MessageRow | null {
    const row = this.db
      .prepare<
        [string, string],
        MessageDbRow
      >("SELECT * FROM messages WHERE channel_id = ? AND external_id = ?")
      .get(channelId, externalId)
    return row === undefined ? null : toMessage(row)
  }

  findById(id: string): MessageRow | null {
    const row = this.db
      .prepare<[string], MessageDbRow>("SELECT * FROM messages WHERE id = ?")
      .get(id)
    return row === undefined ? null : toMessage(row)
  }

  /**
   * 群成员 —— 从**发过言的人**归并出来（钉钉没有"取群成员列表"的接口，
   * 见 [[dws-silent-failure-pattern]] 那类：有接口名但取不到真数据）。
   *
   * ## ★ 它是"发过言的人"，不是"群花名册"，而这个区别要说清
   *
   * 一个 500 人群里可能只有 40 个人发过言，另外 460 个从没说过话 ——
   * 我们的库里只有前 40 个（消息是唯一的数据来源）。所以调用方在
   * UI 上要写明"发过言的 N 人"而不是"成员 N 人"，否则用户会拿它
   * 与钉钉里的群人数对不上，然后以为漏采了。
   *
   * 按发言次数降序：最活跃的排在前面，那通常就是用户找人时先想到的。
   * `count` 一并返回 —— 它是"这个人在这个群里有多活跃"的直接量，
   * 而那正是筛选群成员时的隐含排序依据。
   *
   * `is_self = 0`（而不是 `<> 1`）：`is_self` 可能是 NULL（身份还没确认），
   * 那些不能当"别人" —— 与 `findPeerExternalId` 同一个判断。
   */
  groupMembers(
    conversationId: string,
    limit = 500,
  ): { externalId: string; displayName: string | null; messageCount: number }[] {
    return this.db
      .prepare<[string, number], { external_id: string; display_name: string | null; c: number }>(
        `SELECT sender_external_id AS external_id,
                -- 花名会变，取**最近一次**用的那个（MAX(sent_at) 那行）
                (SELECT m2.sender_display_name FROM messages m2
                  WHERE m2.sender_external_id = m.sender_external_id
                    AND m2.conversation_id = m.conversation_id
                  ORDER BY m2.sent_at DESC LIMIT 1) AS display_name,
                count(*) AS c
           FROM messages m
          WHERE m.conversation_id = ?
            AND m.is_self = 0
            AND m.sender_external_id IS NOT NULL
          GROUP BY m.sender_external_id
          ORDER BY c DESC
          LIMIT ?`,
      )
      .all(conversationId, limit)
      .map((row) => ({
        externalId: row.external_id,
        displayName: row.display_name,
        messageCount: row.c,
      }))
  }

  /**
   * 会话内的 like 搜索 —— 用户要"精确搜聊天记录并跳到那条"。
   *
   * ## ★ 为什么是 LIKE 而不是走 FTS
   *
   * FTS（`messages_fts`）是给**全局语义检索**用的，它按 bigram 建索引，
   * 命中的是"包含这些词的消息"，顺序按相关度。而这里用户要的是
   * "在这个群里找我记得的那句话" —— 他记得的是**字面**（"沙箱环境"），
   * 而 LIKE `%沙箱环境%` 精确匹配连续子串，正是他期望的。
   * FTS 会把"沙箱"和"环境"分开命中一堆无关消息，比 LIKE 更差。
   *
   * ## ★ 返回**时间正序**，且带 id —— 跳转要用
   *
   * 调用方点一条结果要跳到消息流里那条的位置，所以必须给 `id`。
   * 正序（旧→新）与消息流的排列一致，读结果列表时不用在脑子里翻转。
   *
   * `content_text` 已由采集层归一（图片是 `[图片]` 之类占位），
   * 所以搜"图片"不会命中图片消息 —— 那是对的，用户搜的是文字。
   */
  searchInConversation(
    conversationId: string,
    query: string,
    limit = 50,
  ): { id: string; contentText: string; senderDisplayName: string | null; sentAt: number }[] {
    const trimmed = query.trim()
    if (trimmed === "") return []
    // 转义 LIKE 的通配符，否则用户搜 "50%" 会变成"任意"
    const escaped = trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    return this.db
      .prepare<
        [string, string, number],
        {
          id: string
          content_text: string | null
          sender_display_name: string | null
          sent_at: number
        }
      >(
        `SELECT id, content_text, sender_display_name, sent_at
           FROM messages
          WHERE conversation_id = ?
            AND content_text LIKE '%' || ? || '%' ESCAPE '\\'
          ORDER BY sent_at ASC
          LIMIT ?`,
      )
      .all(conversationId, escaped, limit)
      .map((row) => ({
        id: row.id,
        contentText: row.content_text ?? "",
        senderDisplayName: row.sender_display_name,
        sentAt: row.sent_at,
      }))
  }

  /** 会话内最近 N 条，按时间正序返回（供上下文组装：模型读的是对话顺序）。 */
  recentInConversation(conversationId: string, limit: number): MessageRow[] {
    return this.db
      .prepare<
        [string, number],
        MessageDbRow
      >("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sent_at DESC LIMIT ?")
      .all(conversationId, limit)
      .map(toMessage)
      .reverse()
  }

  /**
   * 时间窗内的候选消息（**候选**，不是"已过守卫"）。
   *
   * 两个过滤在 SQL 里，因为它们对应的拒因不需要计数也不需要提示：
   * · 空正文（`empty_content`）；
   * · `origin = 'agent'`（数字人自产，永久排除以防自我强化漂移）。
   *
   * ## ★ `is_self IS NULL` **不能**在这里滤掉
   *
   * 那是最诱人的一条（能少搬很多行），但它会把
   * `identity_unconfirmed` 这个拒因**藏起来**：滤掉之后 runner 拿到 0 行，
   * 于是原因退化成"本窗口没有消息" —— 而真正的原因是"身份没确认"，
   * 那是一个用户**能自己修**的问题。少了这个提示，用户只看到
   * "蒸馏完成，0 条结论"，无从下手。
   *
   * 所以交给 `filterDistillable` 判，让"为什么被拒"有统一的计数出口。
   * `is_bot_channel` 同理（那还是 conversations 上的列，且可能被手改过）。
   *
   * 按时间**正序**返回：作息统计与"上一条是谁说的"都依赖对话顺序。
   *
   * ## ★★ 但**取样**取的是窗口内**最近**的 N 条，不是最早的 N 条
   *
   * 这两句话不矛盾：SQL 里按 `sent_at DESC` 取够 `limit` 条，再在内存里
   * 翻回正序。返回给调用方的仍是正序。
   *
   * 为什么必须这样：原来是 `ORDER BY sent_at ASC LIMIT ?`，也就是一个窗口
   * 只喂**最早的** N 条。实测本机库 30 天窗 + limit 400 时：
   *
   * ```
   * 7 月有 14097 条可蒸语料 → 只看到最早的 400 条（2.8%）
   * ```
   *
   * 而且每一轮重跑喂进去的都是**同一批**最早的消息 —— 于是「跑很久 +
   * 很贵 + 结论永远不变」三件事同时成立，而没有任何一处报错。
   * 取最近的那一批则至少与当前的工作状态相关（同 forge 的时间衰减那条：
   * 半年前的习惯不该与本周等权）。
   */
  distillableInWindow(spec: {
    start: number
    end: number
    limit: number
    /**
     * 会话白名单 —— ★ 是 **external_id**（引导页 `distill_sources` 存的就是它），
     * **不是** `messages.conversation_id`（内部 PK）。
     *
     * 这里过去直接 `conversation_id IN (?)`，而传进来的是 external_id ——
     * 两者永不相等 → 匹配 0 行（`vault.py:186-208` 记着同一个坑）。所以这里
     * 走子查询把 external_id 翻成内部 id 再过滤。空/不传 = 不限。
     */
    conversationExternalIds?: readonly string[]
  }): MessageRow[] {
    const ids = spec.conversationExternalIds ?? []
    const scopeClause =
      ids.length === 0
        ? ""
        : ` AND conversation_id IN (SELECT id FROM conversations WHERE external_id IN (${ids
            .map(() => "?")
            .join(",")}))`
    return (
      this.db
        .prepare<(number | string)[], MessageDbRow>(
          `SELECT * FROM messages
          WHERE sent_at >= ? AND sent_at < ?
            AND content_text IS NOT NULL AND trim(content_text) <> ''
            AND origin <> 'agent'${scopeClause}
          ORDER BY sent_at DESC
          LIMIT ?`,
        )
        .all(spec.start, spec.end, ...ids, spec.limit)
        .map(toMessage)
        /**
         * ★ 翻回正序。SQL 取的是最近 N 条（见方法注释），但调用方要的是对话顺序
         * —— `routineCandidates` 的作息统计与 `workflow` 的「先 A 再 B」都依赖它。
         * 少这一步不会报错，只会让抽出来的流程步骤是倒着的。
         */
        .reverse()
    )
  }

  /**
   * 某会话（按 external_id）库里最新一条消息的 `sent_at`；null = 一条都没有。
   *
   * 给发送后定向补拉用：从"我们已有的最新一条"往新拉，只补增量、不重扫历史。
   * 一条都没有时返回 null，调用方退回一个合理的默认下界（如"最近几分钟"）。
   */
  latestSentAtByExternalId(channelId: string, conversationExternalId: string): number | null {
    const row = this.db
      .prepare<[string, string], { latest: number | null }>(
        `SELECT MAX(m.sent_at) AS latest
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.channel_id = ? AND c.external_id = ?`,
      )
      .get(channelId, conversationExternalId)
    return row?.latest ?? null
  }

  /**
   * **全部**会话各自库里最新一条的 `sent_at`（按 external_id 索引）。
   *
   * ## ★ 为什么要批量版而不是循环调上面那个
   *
   * 轮转扫描（L1.5）的判据是「渠道说的 `lastMsgCreateAt` 是否晚于我们库里
   * 该会话的最新一条」，而它每轮要对**全部**会话做这个比较（实测这台机器
   * 173 个）。逐个查是 173 次 prepare+get —— better-sqlite3 是**同步**的，
   * 那就是 173 次主进程阻塞，而这一轮 30 秒就跑一次。
   *
   * 一次 GROUP BY 拿全部：实测 173 个会话 / 5 万条消息约 1ms。
   * 「一次查询 + 内存比对」也让"扫全部会话"这件事的成本与会话数**解耦** ——
   * 那是这个扫描能做到 30 秒一轮的前提（见 `IngestService.tickActiveScan`）。
   *
   * 没有任何消息的会话**不出现在结果里**（GROUP BY 的自然行为）——
   * 调用方据此把它当"一条都没有"，那正是最该补的那种。
   */
  latestSentAtByChannel(channelId: string): Map<string, number> {
    const rows = this.db
      .prepare<[string], { external_id: string; latest: number | null }>(
        `SELECT c.external_id AS external_id, MAX(m.sent_at) AS latest
           FROM conversations c
           JOIN messages m ON m.conversation_id = c.id
          WHERE c.channel_id = ?
          GROUP BY c.id`,
      )
      .all(channelId)
    const out = new Map<string, number>()
    for (const row of rows) {
      if (row.latest !== null) out.set(row.external_id, row.latest)
    }
    return out
  }

  /**
   * 本人身份确认后的回填。
   *
   * 按 `sender_external_id` 匹配而不是姓名：实测本人在群里显示花名
   * （与组织内姓名不一致），且同名同姓能搜出 6 个不同 ID ——
   * 姓名匹配会造成灾难性误判，而画像被污染是不可逆的。
   *
   * ★ `direction` 必须跟着一起改。
   *
   * 采集时身份未确认 → `is_self` 为 null → direction 一律按 inbound 落库。
   * 只回填 is_self 的话会留下一批 `is_self=1 且 direction='inbound'` 的行
   * （实测 376 条里 23 条），两个字段互相矛盾。
   * 现在没人读 direction（蒸馏与导出都读 is_self），所以它不会立刻出错 ——
   * 这恰恰是它危险的地方：等到有人按 direction 统计"我发了多少条"时
   * 会得到 0，而那时已经很难联想到是几个月前的回填漏了一列。
   */
  backfillSelf(channelId: string, selfExternalIds: readonly string[]): number {
    if (selfExternalIds.length === 0) return 0
    const placeholders = selfExternalIds.map(() => "?").join(",")
    const info = this.db
      .prepare(
        `UPDATE messages
            SET is_self   = CASE WHEN sender_external_id IN (${placeholders}) THEN 1 ELSE 0 END,
                direction = CASE WHEN sender_external_id IN (${placeholders})
                                 THEN 'outbound' ELSE direction END
          WHERE channel_id = ? AND is_self IS NULL AND sender_external_id IS NOT NULL`,
      )
      .run(...selfExternalIds, ...selfExternalIds, channelId)
    return info.changes
  }

  /**
   * 身份确认后回填历史消息的「@我」。
   *
   * ## 为什么需要单独回填
   *
   * 「@我」的判定要拿 content 里的 `@真名(花名)` 与**本人名字集合**比对，
   * 而名字集合来自身份解析。采集发生在确认之前时，`selfDisplayNames` 是空集
   * → 一条 mention 都不会落。于是「@我」只对**确认之后**采到的消息生效，
   * 历史消息永远不会触发数字人 —— 而这个缺失是静默的
   * （表里就是没有那些行，看不出"本该有"）。
   *
   * 调用方传入**已抽取好**的 `(messageId, matched)` 列表：抽取逻辑在
   * `@mycontext/channels`（L2），store 是 L3，不能反向依赖。
   * 这也让"怎么算命中"只有一处定义。
   */
  backfillSelfMentions(entries: readonly { messageId: string; selfExternalId: string }[]): number {
    if (entries.length === 0) return 0
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO message_mentions (message_id, actor_external_id, is_self)
       VALUES (?, ?, 1)`,
    )
    let written = 0
    for (const entry of entries) {
      insert.run(entry.messageId, entry.selfExternalId)
      written += 1
    }
    return written
  }

  /**
   * 取待回填「@我」的候选：有正文、且还没有本人 mention 记录的消息。
   *
   * 只回 `id` 与 `contentText`：抽取在渠道层做，这里不该知道 @ 长什么样。
   */
  listMentionBackfillCandidates(
    channelId: string,
    limit: number,
  ): { id: string; contentText: string | null }[] {
    return this.db
      .prepare<[string, number], { id: string; content_text: string | null }>(
        `SELECT m.id, m.content_text FROM messages m
          WHERE m.channel_id = ?
            AND m.content_text IS NOT NULL
            AND m.content_text LIKE '%@%'
            AND NOT EXISTS (
              SELECT 1 FROM message_mentions mm
               WHERE mm.message_id = m.id AND mm.is_self = 1
            )
          ORDER BY m.sent_at DESC LIMIT ?`,
      )
      .all(channelId, limit)
      .map((row) => ({ id: row.id, contentText: row.content_text }))
  }

  /** 标记为数字人自产：这些消息**永久排除蒸馏**（防自我强化漂移）。 */
  markAgentOrigin(id: string): void {
    this.db.prepare("UPDATE messages SET origin = 'agent' WHERE id = ?").run(id)
  }

  /**
   * 按平台 id 认领数字人自己发出去的消息。返回真正改到的条数。
   *
   * ## ★ 为什么必须按 `external_id` 而不是本地 id
   *
   * 发送的那一刻这条消息**还不在 `messages` 里** —— 我们只拿到平台返回的
   * `openMessageId`（记进了 `dh_send_attempts.sent_message_external_id`）。
   * 它要等下一轮采集把它拉回来才落库，那时才有本地 id。所以只能在采集
   * 之后按平台 id 对账，而这是**唯一**可行的接法。
   *
   * ## 为什么这件事非做不可
   *
   * 钉钉客户端上那条「通过 AI 发送」的角标**没有从 OpenAPI 透出来**：
   * 核对过 1429 条真实消息对象，字段只有 content / createTime /
   * openConversationId / openMessageId / sender / senderOpenDingTalkId 六个
   * （`chat message search-advanced --only-robot-messages` 过滤的是**机器人**
   * 消息，与"用户通过 AI 发送"不是一回事）。所以来源只能由我们自己记。
   *
   * 不记的后果是**自我强化漂移**：数字人的回复被当成本人的真实语料再蒸一遍，
   * 于是它开始模仿自己。forge 的 vault 适配器专门读 `origin='agent'` 来排除
   * 它们（`agent_sent_ids()`），而那是它相对 dws 适配器唯一的优势 ——
   * dws 那边只能靠本地日志重建，换台机器就丢了。
   *
   * ## 幂等
   *
   * `AND origin <> 'agent'` 让重复对账返回 0 而不是反复写同一行 ——
   * 调用方（Outbox 消费者）可能因为抢占重放同一批。
   */
  claimAgentOrigin(channelId: string, externalIds: readonly string[]): number {
    if (externalIds.length === 0) return 0
    const placeholders = externalIds.map(() => "?").join(",")
    const result = this.db
      .prepare(
        `UPDATE messages SET origin = 'agent'
          WHERE channel_id = ? AND origin <> 'agent'
            AND external_id IN (${placeholders})`,
      )
      .run(channelId, ...externalIds)
    return result.changes
  }

  count(): number {
    return this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM messages").get()?.c ?? 0
  }

  /** 未判定 is_self 的条数：状态页据此提示「请先确认身份，否则无法蒸馏」。 */
  countUnjudged(): number {
    return (
      this.db
        .prepare<[], { c: number }>("SELECT count(*) AS c FROM messages WHERE is_self IS NULL")
        .get()?.c ?? 0
    )
  }

  /** 数字人自产消息占比：Dashboard 用它作为画像漂移的预警信号。 */
  agentRatio(): number {
    const row = this.db
      .prepare<
        [],
        { total: number; agent: number }
      >("SELECT count(*) AS total, SUM(CASE WHEN origin = 'agent' THEN 1 ELSE 0 END) AS agent FROM messages")
      .get()
    if (row === undefined || row.total === 0) return 0
    return (row.agent ?? 0) / row.total
  }

  /** @我 的消息（数字人触发条件之一）。 */
  hasSelfMention(messageId: string): boolean {
    const row = this.db
      .prepare<
        [string],
        { c: number }
      >("SELECT count(*) AS c FROM message_mentions WHERE message_id = ? AND is_self = 1")
      .get(messageId)
    return (row?.c ?? 0) > 0
  }
}
