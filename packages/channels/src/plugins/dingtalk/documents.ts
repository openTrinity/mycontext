/**
 * 钉钉文档（知识库 wiki + 钉盘 drive）的采集。
 *
 * ## ★ 为什么这条路以前被判成"做不到"，而其实做得到
 *
 * 之前的结论是：「消息里的 `fileId` 与 `doc read` 要的 `--node` **不是同一套
 * ID**，而 fileId → node 没有直接命令，所以文档正文采不了」。
 *
 * 前半句是对的，后半句的**方向错了** —— 它假设文档只能从「消息里的附件」
 * 出发去反查。实测另有两个**独立的枚举入口**，它们直接给出 `nodeId`：
 *
 * · `dws drive recent`   → 最近访问/编辑过的文档（我的视角，含个人空间）
 * · `dws wiki space list` + `wiki node list` → 知识库（团队视角，可递归）
 *
 * 而 `doc read --node <nodeId>` 直接返回**干净的 Markdown**。
 * 也就是说：不必从 fileId 反查，改从"我能看到哪些文档"正向枚举即可。
 *
 * 教训与 `event` 那条同源：**判断「某件事做不到」之前要把命令树走一遍**，
 * 而不是只沿着当前手上那个 ID 往下推。
 *
 * ## 实测的响应形状（信封已由 `DwsCli.json` 剥掉）
 *
 * · `drive recent -f json` → `{hasMore, nextCursor?, recentItems[]}`，item：
 *   `nodeId, name, nodeType('file'|'folder'), contentType('ALIDOC'|'OTHER'…),
 *    extension('adoc'|'axls'|'dingfm'…), docUrl, createTime, updateTime,
 *    accessTime, operateType`
 *   —— ★ 时间是 **ISO-8601 带偏移**的串（`2026-07-31T14:55:50.591+08:00`），
 *   不是 epoch。
 * · `wiki space list -f json` → `{hasMore, nextPageToken, wikiSpaces[]}`，
 *   space：`workspaceId, name, description, spaceUrl, createTime, updateTime`
 *   —— ★ 这里的时间**是 epoch ms 数字**（与 drive 相反）。
 * · `wiki node list --workspace <id> [--folder <nodeId>]` →
 *   `{hasMore, nextPageToken?, nodes[]}`，node：
 *   `nodeId, name, nodeType, hasChildren, docUrl, createTime, updateTime,
 *    workspaceId, contentType, extension`
 * · `doc read --node <id>` → `{nodeId, title, markdown, docUrl, success}`
 *
 * ★ **两处时间格式不一致**（drive 给 ISO 串、wiki 给 epoch 数字）是这个
 * 二进制的真实行为，不是笔误。所以 `normalizeUnix` 两种都要吃 ——
 * 少吃一种的表现是 `updated_at` 为 null，而下游按时间窗过滤就会漏掉它。
 *
 * ## 只读正文，不下载附件字节
 *
 * `nodeType === "folder"` 只用来递归，不产出文档行。而非 ALIDOC 的条目
 * （`extension: 'axls'` 表格 / `'dingfm'` 脑图 / 上传的 pdf 等）`doc read`
 * 未必给得出 markdown —— 那时**记元信息、正文留 null**，
 * 与媒体那条"只记 ID 不下字节"同一个口径：
 * 「有这个文档但没取到正文」与「没有这个文档」在库里必须可区分。
 */
import { normalizeUnix } from "./time.js"
import type { DwsCli } from "./cli.js"
import type { ChannelDocuments } from "../../types.js"

/**
 * 时间字段 → unix ms，**两种形态都吃**，取不到就 null。
 *
 * ## ★ 为什么必须自己写一个而不是直接用 `normalizeUnix`
 *
 * 那个函数只吃**数字**（秒/毫秒靠数量级判断）且取不到就**抛**。
 * 而这条链路上实测有两种形态，来自同一个二进制的两个子命令：
 * · `drive recent` → ISO-8601 **带偏移**的串（`2026-07-31T14:55:50.591+08:00`）
 * · `wiki space list` / `node list` → **epoch ms 数字**（`1784389250000`）
 *
 * 带偏移的 ISO 串用 `Date.parse` 是安全的（偏移在串里，不依赖运行环境 TZ）
 * —— 这与 `time.ts` 拒绝 `new Date(str)` 并不矛盾：那条规则针对的是
 * **不带时区**的 naive 串（`2026-07-28 10:53:49`），那种才会按机器 TZ 解析。
 *
 * 取不到返回 null 而不是抛：文档的时间是**可观测性字段**（排序、增量过滤），
 * 缺一个不该让整轮采集失败。而它为 null 时下游按时间窗过滤会跳过它 ——
 * 所以宁可让"时间未知"显式为 null，也不要猜一个 now 进去。
 */
function toUnixMs(value: unknown): number | null {
  if (typeof value === "number") {
    try {
      return normalizeUnix(value)
    } catch {
      return null
    }
  }
  if (typeof value !== "string" || value.trim() === "") return null
  // ★ 只接受**带时区**的 ISO 串（Z 或 ±HH:MM）；naive 串按机器 TZ 解析是错的。
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) return null
  const parsed = Date.parse(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

/** 一篇文档的元信息 + 可选正文。 */
export interface ParsedDocument {
  externalId: string
  /** `wiki` = 知识库节点；`drive` = 钉盘/最近访问 */
  origin: "wiki" | "drive"
  title: string | null
  /** 钉钉侧的 docType（`ALIDOC` / `OTHER`…），进 documents.doc_type */
  docType: string | null
  /** 文件后缀（`adoc` / `axls` / `dingfm`…）—— 决定 doc read 拿不拿得到正文 */
  extension: string | null
  url: string | null
  /** 所属知识库 id（drive 来源为 null） */
  workspaceId: string | null
  /** unix ms */
  updatedAt: number | null
  createdAt: number | null
  /** Markdown 正文；null = 没取（或这类文档取不到） */
  contentText: string | null
}

export interface ParsedDocumentPage {
  items: ParsedDocument[]
  nextToken: string | null
  hasMore: boolean
}

/**
 * `doc read` 能给出 Markdown 的后缀白名单。
 *
 * ★ 白名单而不是黑名单：新出现的后缀默认**不去调** `doc read`。
 * 反过来（默认调、失败再跳过）的代价是每轮对几十个表格/脑图各白跑一次
 * CLI 调用（每次 0.3-0.8s），而结果永远是空。
 *
 * `adoc` 是钉钉文档、`amd` 是 Markdown 文档 —— 实测这两类 `markdown`
 * 字段有内容。表格（`axls`）与脑图（`dingfm`）不在其中。
 */
const READABLE_EXTENSIONS: ReadonlySet<string> = new Set(["adoc", "amd", "md", "adocx"])

/** 递归知识库时的最大深度。防目录成环或超深树把一轮采集拖死。 */
const MAX_WIKI_DEPTH = 4
/** 单个知识库最多列几个节点。同样是防御性上限。 */
const MAX_NODES_PER_SPACE = 500

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 一条 drive/wiki 条目 → `ParsedDocument`（不含正文）。
 *
 * 两个来源的字段名基本一致（都有 nodeId/name/nodeType/docUrl），
 * 所以共用一个映射；差异只在时间格式，而 `normalizeUnix` 两种都吃。
 */
function toDocument(raw: unknown, origin: ParsedDocument["origin"]): ParsedDocument | null {
  const record = asRecord(raw)
  if (record === null) return null
  const externalId = str(record["nodeId"]) ?? str(record["node_id"])
  if (externalId === null) return null
  return {
    externalId,
    origin,
    title: str(record["name"]) ?? str(record["title"]),
    docType: str(record["contentType"]) ?? str(record["content_type"]),
    extension: str(record["extension"]),
    url: str(record["docUrl"]) ?? str(record["doc_url"]),
    workspaceId: str(record["workspaceId"]) ?? str(record["workspace_id"]),
    // ★ drive 给 ISO 带偏移的串、wiki 给 epoch ms 数字 —— 两种都要吃。
    updatedAt: toUnixMs(record["updateTime"] ?? record["update_time"]),
    createdAt: toUnixMs(record["createTime"] ?? record["create_time"]),
    contentText: null,
  }
}

/** `nodeType === "folder"` 的条目只用来递归，不当文档。 */
function isFolder(raw: unknown): boolean {
  const record = asRecord(raw)
  return str(record?.["nodeType"]) === "folder"
}

export interface DingTalkDocumentsOptions {
  cli: Pick<DwsCli, "json">
}

export class DingTalkDocuments {
  constructor(private readonly options: DingTalkDocumentsOptions) {}

  /**
   * 列最近访问/编辑过的文档（`drive recent`）。
   *
   * ★ 为什么用 `recent` 而不是 `drive list`：后者要 `--space` 且按目录列，
   * 而"我最近碰过哪些文档"正是画像与图谱最想要的那部分（个人视角、
   * 天然按相关性排序）。`--limit` 实测硬顶 20，所以要靠 cursor 翻页。
   */
  async listRecent(
    spec: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ page: ParsedDocumentPage; rawPayload: string }> {
    const args = ["drive", "recent"]
    // 0=最近访问（含打开+编辑）。不传时它也默认 0，显式写出来让意图可读。
    args.push("--operate-type", "0")
    if (spec.limit !== undefined) args.push("--limit", String(Math.min(spec.limit, 20)))
    if (spec.cursor !== null && spec.cursor !== undefined && spec.cursor !== "") {
      args.push("--cursor", spec.cursor)
    }
    const payload = await this.options.cli.json<unknown>(
      args,
      spec.signal === undefined ? {} : { signal: spec.signal },
    )
    const record = asRecord(payload)
    const items: ParsedDocument[] = []
    for (const entry of arr(record?.["recentItems"] ?? record?.["recent_items"])) {
      if (isFolder(entry)) continue
      const doc = toDocument(entry, "drive")
      if (doc !== null) items.push(doc)
    }
    return {
      page: {
        items,
        nextToken: str(record?.["nextCursor"] ?? record?.["next_cursor"]),
        hasMore: record?.["hasMore"] === true,
      },
      rawPayload: JSON.stringify(payload),
    }
  }

  /**
   * 列全部知识库（`wiki space list`）。
   *
   * 翻页键是 `nextPageToken`（不是 drive 的 `nextCursor`）—— 又一处
   * 命名不一致，所以两边各写各的读法而不是抽一个"通用分页"。
   */
  async listSpaces(spec: { cursor?: string | null; signal?: AbortSignal } = {}): Promise<{
    spaces: { workspaceId: string; name: string | null }[]
    nextToken: string | null
    hasMore: boolean
    rawPayload: string
  }> {
    const args = ["wiki", "space", "list"]
    if (spec.cursor !== null && spec.cursor !== undefined && spec.cursor !== "") {
      args.push("--cursor", spec.cursor)
    }
    const payload = await this.options.cli.json<unknown>(
      args,
      spec.signal === undefined ? {} : { signal: spec.signal },
    )
    const record = asRecord(payload)
    const spaces: { workspaceId: string; name: string | null }[] = []
    for (const entry of arr(record?.["wikiSpaces"] ?? record?.["wiki_spaces"])) {
      const item = asRecord(entry)
      const workspaceId = str(item?.["workspaceId"] ?? item?.["workspace_id"])
      if (workspaceId === null) continue
      spaces.push({ workspaceId, name: str(item?.["name"]) })
    }
    return {
      spaces,
      nextToken: str(record?.["nextPageToken"] ?? record?.["next_page_token"]),
      hasMore: record?.["hasMore"] === true,
      rawPayload: JSON.stringify(payload),
    }
  }

  /**
   * 递归列一个知识库下的文档节点。
   *
   * ## ★ 为什么要递归，以及为什么有硬上限
   *
   * `wiki node list` 只给**直接子节点**，文件夹要靠 `--folder` 再列一层。
   * 实测根目录下大量条目是 `nodeType: "folder"`（"版本冲刺" / "产品说明文档"），
   * 不递归的话拿到的文档数会接近 0 —— 而那是一个静默的空结果。
   *
   * 但递归必须有界：`MAX_WIKI_DEPTH` 防成环/超深树，
   * `MAX_NODES_PER_SPACE` 防一个巨大的知识库把这一轮采集吃满。
   * 撞上限时**返回已拿到的 + `truncated: true`** —— 截断要可见，
   * 否则下游会把"只采了 500 篇"当成"一共 500 篇"。
   */
  async listWikiNodes(
    workspaceId: string,
    spec: { signal?: AbortSignal } = {},
  ): Promise<{ items: ParsedDocument[]; truncated: boolean; rawPayloads: string[] }> {
    const items: ParsedDocument[] = []
    const rawPayloads: string[] = []
    let truncated = false
    /** 待展开的文件夹：`null` = 根目录。 */
    const queue: { folder: string | null; depth: number }[] = [{ folder: null, depth: 0 }]

    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) break
      if (items.length >= MAX_NODES_PER_SPACE) {
        truncated = true
        break
      }
      const args = ["wiki", "node", "list", "--workspace", workspaceId]
      if (next.folder !== null) args.push("--folder", next.folder)
      let value: unknown
      try {
        value = await this.options.cli.json<unknown>(
          args,
          spec.signal === undefined ? {} : { signal: spec.signal },
        )
        rawPayloads.push(JSON.stringify(value))
      } catch {
        /**
         * 单个文件夹列不出来（权限 / 已删）只跳过它，不让整个知识库失败。
         * 上层据 `items.length` 判断这一轮有没有收获；而"部分成功"
         * 比"整个知识库为空"更接近事实。
         */
        continue
      }
      const record = asRecord(value)
      for (const entry of arr(record?.["nodes"])) {
        const item = asRecord(entry)
        const nodeId = str(item?.["nodeId"])
        if (isFolder(entry)) {
          // 文件夹只递归，不当文档行
          if (nodeId !== null && next.depth + 1 < MAX_WIKI_DEPTH) {
            queue.push({ folder: nodeId, depth: next.depth + 1 })
          }
          continue
        }
        const doc = toDocument(entry, "wiki")
        if (doc !== null) items.push({ ...doc, workspaceId })
      }
    }
    return { items, truncated, rawPayloads }
  }

  /**
   * 取一篇文档的 Markdown 正文（`doc read --node`）。
   *
   * 返回 `null` 有两种情况，调用方**不需要**区分（都当"没有正文"）：
   * · 这类文档取不到 markdown（表格 / 脑图 / 上传的二进制）；
   * · 调用失败（权限 / 已删）。
   *
   * ★ 但**要先按后缀过滤**再调（见 `READABLE_EXTENSIONS`）：
   * 不过滤的话每轮会对几十个表格各白跑一次 CLI，而结果永远是空。
   */
  async readBody(
    doc: Pick<ParsedDocument, "externalId" | "extension">,
    signal?: AbortSignal,
  ): Promise<{ contentText: string | null; rawPayload: string | null }> {
    const extension = (doc.extension ?? "").toLowerCase()
    if (extension !== "" && !READABLE_EXTENSIONS.has(extension)) {
      return { contentText: null, rawPayload: null }
    }
    try {
      const payload = await this.options.cli.json<unknown>(
        ["doc", "read", "--node", doc.externalId],
        signal === undefined ? {} : { signal },
      )
      const record = asRecord(payload)
      return { contentText: str(record?.["markdown"]), rawPayload: JSON.stringify(payload) }
    } catch {
      return { contentText: null, rawPayload: null }
    }
  }
}

/** 这个后缀的文档能不能读到 Markdown 正文（导出侧也要用同一判据）。 */
export function isReadableDocExtension(extension: string | null): boolean {
  const value = (extension ?? "").toLowerCase()
  return value === "" || READABLE_EXTENSIONS.has(value)
}

/**
 * 装成渠道无关的 `ChannelDocuments`。
 *
 * ## ★ 一条流里合并两个子域（drive + wiki），而不是暴露两个方法
 *
 * 上层要回答的问题是「我能看到哪些文档」，而"它来自个人空间还是团队知识库"
 * 是**钉钉特有**的划分 —— 让宿主去分别调两个方法、再自己合并，就等于把
 * 这份知识漏到渠道层外面（与头像那处同一个教训）。
 *
 * 所以：`cursor === null`（首轮）时先跑 wiki 全量递归 + drive 首页；
 * 之后的 cursor 只翻 drive（wiki 没有跨库游标，一轮递归完就完了）。
 * 游标里带一个前缀标明它是 drive 的，避免与将来别的子域混淆。
 */
export function createDingTalkDocuments(cli: Pick<DwsCli, "json">): ChannelDocuments {
  const docs = new DingTalkDocuments({ cli })
  /** drive 游标的前缀。裸游标直接透出去的话，将来加子域会分不清它属于谁。 */
  const DRIVE_PREFIX = "drive:"

  return {
    async list(spec = {}) {
      const items: ParsedDocument[] = []
      const raws: string[] = []
      let truncated = false
      const cursor = spec.cursor ?? null
      const isFirstRound = cursor === null || cursor === ""

      /**
       * 首轮才跑知识库：`wiki node list` 没有跨库游标，一次递归就是全量。
       * 后续轮只翻 drive —— 否则每翻一页 drive 都要把整棵 wiki 树重列一遍。
       */
      if (isFirstRound) {
        try {
          const spaces = await docs.listSpaces(
            spec.signal === undefined ? {} : { signal: spec.signal },
          )
          raws.push(spaces.rawPayload)
          for (const space of spaces.spaces) {
            const nodes = await docs.listWikiNodes(
              space.workspaceId,
              spec.signal === undefined ? {} : { signal: spec.signal },
            )
            items.push(...nodes.items)
            raws.push(...nodes.rawPayloads)
            if (nodes.truncated) truncated = true
          }
          /**
           * `hasMore` 为真说明还有更多知识库没列到。**要报 truncated** ——
           * 这一轮只覆盖了前若干个库，而"少了几个库"在结果里看不出来。
           */
          if (spaces.hasMore) truncated = true
        } catch {
          /**
           * 知识库整段失败（没开通 / 无权限）不影响 drive 那半边。
           * 不抛是刻意的：文档采集是**增益**，一个子域不可用不该让另一个也停。
           */
          truncated = true
        }
      }

      const driveCursor = isFirstRound
        ? null
        : cursor.startsWith(DRIVE_PREFIX)
          ? cursor.slice(DRIVE_PREFIX.length)
          : cursor
      const recent = await docs.listRecent({
        cursor: driveCursor,
        ...(spec.limit === undefined ? {} : { limit: spec.limit }),
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      })
      items.push(...recent.page.items)
      raws.push(recent.rawPayload)

      return {
        items,
        nextToken:
          recent.page.nextToken === null ? null : `${DRIVE_PREFIX}${recent.page.nextToken}`,
        hasMore: recent.page.hasMore,
        truncated,
        // 整批原始响应一起进 raw_records（可重放）。分开存会让一轮里
        // 的多次调用各占一行，而它们在语义上是同一次"列文档"。
        rawPayload: JSON.stringify(raws),
      }
    },

    body(doc, signal) {
      return docs.readBody(doc, signal)
    },

    /**
     * 与 `readBody` 的前置过滤**同一个集合** —— 见契约里那段注释：
     * 那边挡的是"别发无谓的 CLI 调用"，这边挡的是"别占正文配额"。
     * 两处必须一致，所以都读 `READABLE_EXTENSIONS`。
     */
    readableExtensions: [...READABLE_EXTENSIONS],
  }
}
