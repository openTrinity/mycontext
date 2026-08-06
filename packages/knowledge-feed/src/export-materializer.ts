/**
 * 导出物化：把我们库里的数据写成 kl-graph 的**标准四件套**。
 *
 * ## 契约（照 loader 的实际读法对齐，不是照文档）
 *
 * kl-graph 的每个 source 目录都是同一个形状（见其 `loaders/base.py` 文件头）：
 *
 * ```
 * <exportDir>/chat/     manifest.json + scopes.jsonl + records.jsonl + resources.jsonl
 * <exportDir>/minutes/  同上
 * ```
 *
 * 三种行的信封：
 * · scope    `{id, type, parent_id, data}`              —— 容器/层级
 * · record   `{id, scope_id, type, data}`               —— 内容项
 * · resource `{id, kind, uri, local_path, refs, data}`  —— 附件
 *
 * ## ★ 为什么不能沿用首版的 `chat/messages/<title>_<cid>.json`
 *
 * 那个形状是照**旧版**上游写的。现版 `message_loader.load_all_messages()`
 * 读的是 `<chat_dir>/records.jsonl` 里 `type == "message"` 的行，
 * 再用 `rec["scope_id"]` 去 `scopes.jsonl` 里查会话标题。
 * 喂它一堆 `<title>_<cid>.json`，`iter_records` 找不到 `records.jsonl`
 * → 返回空迭代器 → **ingest 跑完但 messages 是 0**，且不报错。
 *
 * 又一个静默失效，所以下面每个字段都对着 loader 源码核过（见各处注释）。
 *
 * ## ★ createTime 必须带时区偏移（实测差 8 小时）
 *
 * 他们的 `to_unix_ms()` 对 naive 串 `"YYYY-MM-DD HH:MM:SS"` 会补 **UTC**
 * （`dt.replace(tzinfo=timezone.utc)`），而我们的时间是 DWS 的 **+08:00** 本地时。
 * 实测同一条消息：他们算出 1785236029000，真值是 1785207229000 —— 差 **8 小时**，
 * 且**不报错**。图谱的时间维度整体平移，timeline 与社区演化跟着错，没有一处会红。
 *
 * 修法不是改他们的 loader（那是他们的代码），而是**不给有歧义的串**：
 * `createTime` 写成 `"2026-07-28T10:53:49+08:00"`，他们的
 * `datetime.fromisoformat` 分支就能解析对 —— 他们**零改动**即正确。
 *
 * 两个字段都给：
 * · `createTime` ISO-8601 **带偏移**（无歧义，他们的 loader 直接读这个）
 * · `timestampMs` 我们已归一的权威值（数字，完全绕开字符串解析）
 *
 * `to_unix_ms` 对**数字**输入是 `n >= 1e12 ? n : n*1000`，所以凡是我们能给
 * 数字的地方（听记的 `start_time`）就直接给数字 —— 那条路径完全绕开了 strptime。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { AppError, type Clock, type Logger } from "@mycontext/kernel"
import {
  ConversationRepository,
  MediaAssetRepository,
  type ConversationRow,
  type SqliteDatabase,
} from "@mycontext/store"

/** 顶层 workspace scope 的 id。与上游 `export_chat.py` 的 `WORKSPACE_ID` 同值。 */
const WORKSPACE_ID = "workspace:ali-ding"

export interface ExportedMessage {
  openMessageId: string
  openConversationId: string
  content: string
  /** 原串，保证对方零改动可跑 */
  /**
   * ISO-8601 **带时区偏移**（`"2026-07-28T10:53:49+08:00"`）。
   *
   * 带偏移不是可选的讲究：不带时，他们的 `to_unix_ms` 会当成 UTC，
   * 整批时间平移 8 小时且不报错（见文件头）。
   */
  createTime: string
  /** ★ 权威值：已归一的 unix ms。推荐读这个 */
  timestampMs: number
  sender: string
  senderOpenDingTalkId: string | null
  quotedMessage?: { openMessageId: string }
  /** 我们额外给的：本人标记，便于他们区分「我说的」与「别人说的」 */
  isSelf: boolean | null
}

export interface ExportSourceCounts {
  name: string
  scopes: number
  records: number
  resources: number
}

export interface ExportResult {
  /** 写出的 source 目录（`chat` / `minutes` / `wiki`） */
  sources: ExportSourceCounts[]
  totalMessages: number
  totalMinutes: number
  /** 导出的文档篇数（**只导有正文的**，见 materializeWiki） */
  totalDocuments: number
  /** 导出时的 Outbox 水位：对方据此知道这份快照对应到哪个 seq */
  headSeq: number
}

export interface ExportOptions {
  db: SqliteDatabase
  clock: Clock
  /** 导出根目录（对应 KL_DWS_EXPORT_DIR） */
  exportDir: string
  /**
   * 时间格式化函数（按渠道注入，避免这里依赖 channels 包造成横向依赖）。
   *
   * ★ 必须产出**带时区偏移**的串（钉钉传 `formatDwsIsoTime`）。
   * 传一个不带偏移的会让下游把时间当 UTC 解析 —— 见文件头。
   */
  formatTime: (ms: number) => string
  logger?: Logger
  /** 每个会话最多导出多少条（防止单文件过大） */
  maxPerConversation?: number
  /**
   * ★ 用户在引导里选的采集范围 —— **知识图谱只吃这个范围里的语料**。
   *
   * ## 为什么必须有它（这修的是一个真 bug）
   *
   * 在此之前 kl-graph 是**全库全时段**导出：`readMessages` 只过
   * `content_text <> ''`，`listRecent(10_000)` 取全部会话，`since` 一处都没读。
   * 后果是用户取消勾选 30 个群，那 30 个群**照样进知识图谱**，数字人检索
   * 事实时会引用它们 —— "选了没用"里最实质的一条。
   *
   * `undefined` = 不限（导出全库，兼容没配范围的老库）。给了就：
   * · `conversationExternalIds` 非空 → 只导出白名单里的会话；
   * · `since` / `until` → 只导出这个时间窗内的消息。
   *
   * ★ 白名单是 **external_id**（引导存的就是它），不是内部 PK ——
   * `vault.py:186-208` 记着这个坑被踩过（按 `id` 匹配 0/39，按 `external_id` 32/39）。
   */
  scope?: {
    /**
     * 会话白名单（external_id）。
     *
     * `undefined` = 不限会话。**空数组 = 零个会话**（用户配了范围但一个都
     * 没勾，或把聊天源关掉了）—— 不是"不限"。见 `run()` 里那段注释：
     * 修复前把空数组当不限，于是"我一个都不要"被执行成"全都要"。
     */
    conversationExternalIds?: readonly string[]
    /** 下界（unix ms）。undefined = 不限。 */
    since?: number
    /** 上界（unix ms）。undefined = 到现在。 */
    until?: number
  }
}

interface MessageExportRow {
  message_id: string
  external_id: string
  content_text: string | null
  sent_at: number
  sender_display_name: string | null
  sender_external_id: string | null
  quoted_external_id: string | null
  is_self: number | null
}

/** 一个 source 目录的三个 JSONL + manifest 的累加器。 */
class SourceWriter {
  private readonly scopes: string[] = []
  private readonly records: string[] = []
  private readonly resources: string[] = []
  private readonly scopeTypes = new Set<string>()
  private readonly recordTypes = new Set<string>()
  private readonly resourceKinds = new Set<string>()
  private readonly seenScopeIds = new Set<string>()

  constructor(
    private readonly dir: string,
    private readonly name: string,
  ) {}

  scope(entry: { id: string; type: string; parentId: string | null; data: unknown }): void {
    // 同一个 scope 可能被多条 record 引用；只写一次 ——
    // 对方按 id 建 map，重复行不会出错但会让 manifest 的计数虚高。
    if (this.seenScopeIds.has(entry.id)) return
    this.seenScopeIds.add(entry.id)
    this.scopeTypes.add(entry.type)
    this.scopes.push(
      JSON.stringify({
        id: entry.id,
        type: entry.type,
        parent_id: entry.parentId,
        data: entry.data,
      }),
    )
  }

  record(entry: { id: string; scopeId: string; type: string; data: unknown }): void {
    this.recordTypes.add(entry.type)
    this.records.push(
      JSON.stringify({
        id: entry.id,
        scope_id: entry.scopeId,
        type: entry.type,
        data: entry.data,
      }),
    )
  }

  resource(entry: {
    id: string
    kind: string
    uri: string | null
    localPath: string | null
    refs: unknown[]
    data: unknown
  }): void {
    this.resourceKinds.add(entry.kind)
    this.resources.push(
      JSON.stringify({
        id: entry.id,
        kind: entry.kind,
        uri: entry.uri,
        local_path: entry.localPath,
        refs: entry.refs,
        data: entry.data,
      }),
    )
  }

  get counts(): { scopes: number; records: number; resources: number } {
    return {
      scopes: this.scopes.length,
      records: this.records.length,
      resources: this.resources.length,
    }
  }

  /**
   * 落盘。
   *
   * ★ `manifest.json` **最后**写。上游 `DatasetWriter.finish()` 的语义是
   * 「manifest 存在 ⇔ 这个 bundle 完整」—— 中途崩掉时不该留下一个
   * 看起来完整的 manifest 指向半份数据。
   */
  flush(exportedAt: number): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, "scopes.jsonl"), joinLines(this.scopes), "utf8")
    writeFileSync(join(this.dir, "records.jsonl"), joinLines(this.records), "utf8")
    writeFileSync(join(this.dir, "resources.jsonl"), joinLines(this.resources), "utf8")
    writeFileSync(
      join(this.dir, "manifest.json"),
      `${JSON.stringify(
        {
          source: "mycontext",
          dataset: this.name,
          scope_types: [...this.scopeTypes].sort(),
          record_types: [...this.recordTypes].sort(),
          resource_kinds: [...this.resourceKinds].sort(),
          counts: this.counts,
          exported_at: exportedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    )
  }
}

/** JSONL：每行一个对象。空集合写空文件（不是一个孤零零的换行）。 */
function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

/**
 * 会话的 scope id。
 *
 * ## ★ 仍然清洗 —— 它来自渠道
 *
 * 首版把 conversationId 拼进**文件名**，实测 `"../../../../etc/evil"`
 * 能让落点逃出导出目录。现在 id 只进 JSON 内容，风险小得多，
 * 但对方可能拿它去拼路径（他们的 media 目录就是这么组织的），所以照旧清洗。
 */
function scopeIdFor(conversationExternalId: string): string {
  const safe = conversationExternalId.replaceAll(/[/\\:*?"<>|\r\n]/g, "_").replace(/^\.+$/, "_")
  return `chat:${safe === "" ? "unknown" : safe}`
}

export class ExportMaterializer {
  constructor(private readonly options: ExportOptions) {}

  /**
   * 全量物化。
   *
   * 产出 `<exportDir>/chat/`、`<exportDir>/minutes/`、`<exportDir>/wiki/`
   * 三个 source 目录，每个都是标准四件套。
   * `KL_DWS_EXPORT_DIR` 直接指向 `<exportDir>`。
   *
   * ★ 目录名必须叫 `wiki` 而不是 `doc`：kl 侧按**目录名**挑 loader
   * （`config.py` 的 `WIKI_DIR`），叫 `doc` 会落到通用 flattener 那条路 ——
   * 那条路不会按标题做 heading-aware 切块，长文档会被切得很碎。
   */
  run(): ExportResult {
    const exportedAt = this.options.clock.now()
    const root = resolve(this.options.exportDir)
    mkdirSync(root, { recursive: true })

    const chat = this.materializeChat(root, exportedAt)
    const minutes = this.materializeMinutes(root, exportedAt)
    const wiki = this.materializeWiki(root, exportedAt)

    const headSeq =
      this.options.db
        .prepare<[], { seq: number | null }>("SELECT MAX(seq) AS seq FROM knowledge_changelog")
        .get()?.seq ?? 0

    const result: ExportResult = {
      sources: [
        { name: "chat", ...chat.counts },
        { name: "minutes", ...minutes.counts },
        { name: "wiki", ...wiki.counts },
      ],
      totalMessages: chat.messages,
      totalMinutes: minutes.items,
      totalDocuments: wiki.items,
      headSeq,
    }

    this.options.logger?.info("export materialized", {
      messages: result.totalMessages,
      minutes: result.totalMinutes,
      documents: result.totalDocuments,
      headSeq,
    })

    return result
  }

  /** `<exportDir>/chat/` —— 会话 scope + message record + 媒体 resource。 */
  private materializeChat(
    root: string,
    exportedAt: number,
  ): { counts: { scopes: number; records: number; resources: number }; messages: number } {
    const dir = join(root, "chat")
    // 落点校验：exportDir 由配置注入，仍然断一次它没被拼出去。
    if (!resolve(dir).startsWith(root + sep)) {
      throw new AppError("CONFIG_INVALID", "导出落点逃出导出目录", {
        messageKey: "errors:config.invalid",
        messageParams: { detail: dir },
      })
    }

    const writer = new SourceWriter(dir, "chat")
    // 顶层 workspace scope：与上游 export_chat.py 一致，会话都挂在它下面。
    writer.scope({
      id: WORKSPACE_ID,
      type: "workspace",
      parentId: null,
      data: { name: "钉钉工作区", source: "mycontext" },
    })

    const allConversations = new ConversationRepository(this.options.db).listRecent(10_000)
    /**
     * ★ 会话白名单：只导出用户勾选的那些（external_id 匹配）。
     *
     * 判据是**白名单存在与否**（`undefined`），不是"它非不空"。
     * 修复前写的是 `allow === undefined || allow.length === 0 ? 全部 : 过滤`
     * —— 于是一个**空**白名单（用户一个都没勾 / 把聊天源关掉了）被解读成
     * "不限"，把全部会话导进了知识图谱。方向正好相反，而且不报错。
     *
     * 上游 `FeedService.exportScope` 现在只在真的设了范围时才传这个键，
     * 所以这里可以安全地把"传了空数组"当作"零个会话"。
     */
    const allow = this.options.scope?.conversationExternalIds
    const conversations =
      allow === undefined
        ? allConversations
        : allConversations.filter((c) => allow.includes(c.externalId))
    const media = new MediaAssetRepository(this.options.db)
    let messageCount = 0

    for (const conversation of conversations) {
      const rows = this.readMessages(conversation)
      if (rows.length === 0) continue

      const scopeId = scopeIdFor(conversation.externalId)
      writer.scope({
        id: scopeId,
        type: "chat",
        parentId: WORKSPACE_ID,
        data: {
          // `scope_title()` 读 data.title（其次 node.name / name）
          title: conversation.title,
          // 上游 `chat_kind` 取 "direct" | "group"；我们的 type 同值
          chat_kind: conversation.type,
          openConversationId: conversation.externalId,
          memberCount: conversation.memberCount,
          is_bot_channel: conversation.isBotChannel,
        },
      })

      for (const row of rows) {
        // record.data 就是 message_loader 直接读的那个 payload。
        const data: ExportedMessage = {
          openMessageId: row.external_id,
          openConversationId: conversation.externalId,
          content: row.content_text ?? "",
          createTime: this.options.formatTime(row.sent_at),
          timestampMs: row.sent_at,
          sender: row.sender_display_name ?? "unknown",
          senderOpenDingTalkId: row.sender_external_id,
          isSelf: row.is_self === null ? null : row.is_self === 1,
        }
        if (row.quoted_external_id !== null) {
          data.quotedMessage = { openMessageId: row.quoted_external_id }
        }
        const recordId = `${scopeId}:${row.external_id}`
        writer.record({ id: recordId, scopeId, type: "message", data })
        messageCount += 1

        // 媒体：一期只有元数据（没下载字节）→ `local_path` 为 null。
        // 仍然写出来，让对方知道"这条消息有一张图"，即使取不到字节。
        for (const asset of media.listByMessage(row.message_id)) {
          writer.resource({
            id: `media:${asset.id}`,
            kind: asset.kind,
            // 平台侧标识；没有可直接解析的 URL（要走 CLI 下载）
            uri: `dingtalk://${asset.resourceKind}/${asset.resourceId}`,
            // ★ null = 未下载字节。让"有资源但没取到"与"没有资源"可区分
            localPath: asset.path,
            refs: [{ type: "record", id: recordId }],
            data: {
              resource_kind: asset.resourceKind,
              resource_id: asset.resourceId,
              original_name: asset.originalName,
              downloaded: asset.path !== null,
            },
          })
        }
      }
    }

    writer.flush(exportedAt)
    return { counts: writer.counts, messages: messageCount }
  }

  /**
   * `<exportDir>/wiki/` —— 文档 scope + 正文 record。
   *
   * 字段照 `wiki_loader.py` 的读法逐条对齐（读它的**代码**而不是字段名 ——
   * 听记那边就是靠这个才发现 `data.text` 对转写是坏的）：
   *
   * · record `type: "document_unit"`，正文在 `data.text`（markdown）、
   *   链接在 `data.docUrl`；
   * · 标题与 node 元信息在**关联的 scope** 里（`scopes.jsonl`），
   *   loader 走 `scope_title(scope)` 与 `scope.data.node.nodeId`；
   * · ★ scope id 的形状是 `document:wiki/<nodeId>` —— loader 的兜底逻辑
   *   `scope_id.rsplit("/", 1)[-1]` 靠它取 nodeId。不按这个形状拼的话
   *   `node_id` 会变成整个 scope id，于是 chunk id 变形、去重失效。
   *
   * ## ★ 只导**有正文**的文档
   *
   * 没正文的（表格 / 脑图 / 还没补到）进去只会产出一个空 chunk ——
   * `wiki_loader` 自己也会 `if not body: continue` 跳过，
   * 但我们导过去就等于让对方每轮多读几十行无用记录。
   * 而"库里有 80 篇、导了 30 篇"这个落差由 `totalDocuments` 报出来。
   */
  private materializeWiki(
    root: string,
    exportedAt: number,
  ): { counts: { scopes: number; records: number; resources: number }; items: number } {
    const dir = join(root, "wiki")
    const writer = new SourceWriter(dir, "wiki")
    const rows = this.options.db
      .prepare<
        [],
        {
          external_id: string
          title: string | null
          content_text: string | null
          url: string | null
          doc_type: string | null
          extension: string | null
          workspace_id: string | null
          updated_at: number | null
          created_at: number | null
        }
      >(
        `SELECT external_id, title, content_text, url, doc_type, extension,
                workspace_id, updated_at, created_at
           FROM documents
          WHERE content_text IS NOT NULL AND content_text != ''
          ORDER BY updated_at DESC`,
      )
      .all()

    let items = 0
    for (const row of rows) {
      // ★ 形状必须是 `document:wiki/<nodeId>`（见方法注释里 loader 的兜底）。
      const scopeId = `document:wiki/${row.external_id}`
      writer.scope({
        id: scopeId,
        type: "document",
        parentId: null,
        data: {
          // `scope_title()` 读 data.title
          title: row.title,
          // loader 走 data.node.nodeId 取 node id —— 给全，别只靠 scope id 兜底
          node: {
            nodeId: row.external_id,
            docType: row.doc_type,
            extension: row.extension,
            workspaceId: row.workspace_id,
          },
          // 给**数字** epoch ms：他们的 to_unix_ms 对数字原样返回，
          // 绕开 naive 串被当 UTC 那个 8 小时偏移（见 chat 那侧的注释）。
          updated_at: row.updated_at,
          created_at: row.created_at,
        },
      })
      writer.record({
        id: `${scopeId}:body`,
        scopeId,
        type: "document_unit",
        data: {
          // ★ 正文走 data.text（markdown）—— loader 读的就是这个键
          text: row.content_text,
          docUrl: row.url,
          title: row.title,
        },
      })
      items += 1
    }

    writer.flush(exportedAt)
    return { counts: writer.counts, items }
  }

  /**
   * `<exportDir>/minutes/` —— 会议 scope + 摘要/转写 record。
   *
   * 字段照 `minutes_loader.py` 的读法对齐：
   * · scope `type: "meeting"`，`data.title` / `data.start_time`；
   * · 摘要 record `type: "document_unit"` + `data.kind: "minutes_summary"`；
   * · 转写 record 同 type、`kind: "minutes_transcription_page"`，
   *   正文必须走 `data.segments[]`（`{nickName, paragraph}`）——
   *   上游注释明确写了 flattened `data.text` 对这类 record 是**坏的**
   *   （只剩 `[<ms>]` 标记与空发言人行），所以只给 text 会得到一堆噪声。
   */
  private materializeMinutes(
    root: string,
    exportedAt: number,
  ): { counts: { scopes: number; records: number; resources: number }; items: number } {
    const dir = join(root, "minutes")
    const writer = new SourceWriter(dir, "minutes")
    const rows = this.options.db
      .prepare<
        [],
        {
          external_id: string
          title: string | null
          started_at: number | null
          duration_sec: number | null
          summary_text: string | null
          transcript_json: string | null
          speakers_json: string | null
        }
      >(
        `SELECT external_id, title, started_at, duration_sec,
                summary_text, transcript_json, speakers_json
           FROM minutes ORDER BY started_at DESC`,
      )
      .all()

    let items = 0
    for (const row of rows) {
      const scopeId = `minutes:${row.external_id}`
      const speakers = parseJson<{
        shareUrl?: string
        keywords?: { keywords?: string[] }
        owner?: { name?: string }
      }>(row.speakers_json)

      writer.scope({
        id: scopeId,
        type: "meeting",
        parentId: null,
        data: {
          title: row.title,
          // 给**数字** epoch ms：to_unix_ms 对数字是原样返回，
          // 完全绕开 strptime 的本地时区问题（见文件头）。
          start_time: row.started_at,
          duration_sec: row.duration_sec,
          share_url: speakers?.shareUrl ?? null,
          owner: speakers?.owner?.name ?? null,
        },
      })
      items += 1

      if (row.summary_text !== null && row.summary_text !== "") {
        writer.record({
          id: `${scopeId}:summary`,
          scopeId,
          type: "document_unit",
          data: {
            kind: "minutes_summary",
            text: row.summary_text,
            title: row.title,
            start_time: row.started_at,
          },
        })
      }

      // 转写：`transcript_json` 存的是 `get transcription` 的整个响应
      // （`{hasNext, nextToken, paragraphList[]}`）→ 转成 loader 要的 segments。
      const transcript = parseJson<{
        hasNext?: boolean
        paragraphList?: { nickName?: string; paragraph?: string }[]
      }>(row.transcript_json)
      const paragraphs = transcript?.paragraphList ?? []
      if (paragraphs.length > 0) {
        writer.record({
          id: `${scopeId}:transcript:0`,
          scopeId,
          type: "document_unit",
          data: {
            kind: "minutes_transcription_page",
            page_index: 0,
            segments: paragraphs.map((item) => ({
              nickName: item.nickName ?? "unknown",
              paragraph: item.paragraph ?? "",
            })),
            title: row.title,
            start_time: row.started_at,
            // ★ 截断必须在数据里可见：一期只取了第一页转写。
            // 不标的话下游会把它当完整转写用（"会议里没提过 X" 这类结论就会错）。
            has_next: transcript?.hasNext === true,
          },
        })
      }

      const keywords = speakers?.keywords?.keywords ?? []
      if (keywords.length > 0) {
        writer.record({
          id: `${scopeId}:keywords`,
          scopeId,
          type: "generic_record",
          data: { kind: "minutes_keywords", keywords, title: row.title },
        })
      }
    }

    writer.flush(exportedAt)
    return { counts: writer.counts, items }
  }

  private readMessages(conversation: ConversationRow): MessageExportRow[] {
    const limit = this.options.maxPerConversation ?? 50_000
    const scope = this.options.scope
    /**
     * ★ 三条过滤，全是这次修的"选了没用"：
     * · `sent_at >= since` / `< until` —— 只导出用户选的时间窗；
     * · `origin <> 'agent'` —— **排除数字人自己发的话**。不排的话它会被
     *   当本人语料再蒸一遍 → 自我强化漂移（forge 的 vault 适配器也靠
     *   origin 排除它们，两边口径一致）。
     * 用可选片段拼 SQL：没配 scope 时退回原样（全库），兼容老库。
     */
    const clauses: string[] = [
      "conversation_id = ?",
      "content_text IS NOT NULL",
      "content_text <> ''",
      "origin <> 'agent'",
    ]
    const params: (string | number)[] = [conversation.id]
    if (scope?.since !== undefined) {
      clauses.push("sent_at >= ?")
      params.push(scope.since)
    }
    if (scope?.until !== undefined) {
      clauses.push("sent_at < ?")
      params.push(scope.until)
    }
    params.push(limit)
    return this.options.db
      .prepare<(string | number)[], MessageExportRow>(
        `SELECT id AS message_id, external_id, content_text, sent_at, sender_display_name,
                sender_external_id, quoted_external_id, is_self
           FROM messages
          WHERE ${clauses.join(" AND ")}
          ORDER BY sent_at
          LIMIT ?`,
      )
      .all(...params)
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null || raw === "") return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
