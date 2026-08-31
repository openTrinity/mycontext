/**
 * 本地编码助手会话记录读取器。
 *
 * 记录目录可能达到 GB 级，正文读取必须满足三条约束：
 * 1. 会话目录只读首行元数据，不为了列标题扫描整份文件；
 * 2. 正文只扫描与请求时间窗相交的文件；
 * 3. 文件未变化时复用解析结果，避免每两分钟重读历史。
 *
 * 只接收 `event_msg.user_message`。系统/开发者提示、模型回答、推理、工具调用和
 * 命令输出全部排除，既避免把生成内容学成用户事实，也避免把诊断输出带入图库。
 */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { AppError } from "@mycontext/kernel"
import type {
  ChannelConversationItem,
  ChannelConversationList,
  ChannelPullPage,
  ChannelPullSpec,
  ParsedConversationLike,
  ParsedMessageLike,
} from "../../types.js"

const SESSION_SUFFIX = ".jsonl"
const CURSOR_KIND = "codex-local-v1"
const TITLE_LIMIT = 80
const CATALOG_CONCURRENCY = 32
const MESSAGE_CONCURRENCY = 4

interface SessionCatalogEntry {
  id: string
  path: string
  title: string
  createdAt: number
  updatedAt: number
  size: number
}

interface ParsedUserMessage {
  externalId: string
  conversationExternalId: string
  text: string
  sentAt: number
}

interface CachedMessages {
  size: number
  updatedAt: number
  messages: ParsedUserMessage[]
}

interface CursorValue {
  kind: typeof CURSOR_KIND
  sentAt: number
  externalId: string
}

export interface CodexLocalRecordReaderOptions {
  recordsRoot: () => string
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(line) as unknown)
  } catch {
    return null
  }
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function compactTitle(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length <= TITLE_LIMIT ? compact : `${compact.slice(0, TITLE_LIMIT - 1)}…`
}

function messageId(sessionId: string, sentAt: number, text: string, duplicate: number): string {
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(String(sentAt))
    .update("\0")
    .update(text)
    .update("\0")
    .update(String(duplicate))
    .digest("hex")
    .slice(0, 32)
  return `codex-msg-${digest}`
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function decodeCursor(value: string | null): CursorValue | null {
  if (value === null) return null
  try {
    const parsed = object(JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown)
    if (
      parsed["kind"] !== CURSOR_KIND ||
      typeof parsed["sentAt"] !== "number" ||
      typeof parsed["externalId"] !== "string"
    ) {
      return null
    }
    return {
      kind: CURSOR_KIND,
      sentAt: parsed["sentAt"],
      externalId: parsed["externalId"],
    }
  } catch {
    return null
  }
}

function afterCursor(message: ParsedUserMessage, cursor: CursorValue | null): boolean {
  if (cursor === null) return true
  if (message.sentAt !== cursor.sentAt) return message.sentAt > cursor.sentAt
  return message.externalId > cursor.externalId
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next
      next += 1
      const value = values[index]
      if (value !== undefined) result[index] = await transform(value)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => await worker()),
  )
  return result
}

async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      const code = object(error)["code"]
      if (code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith(SESSION_SUFFIX)) found.push(path)
    }
  }
  await walk(root)
  return found
}

async function firstLine(path: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of lines) {
      signal?.throwIfAborted()
      return line
    }
    return null
  } finally {
    lines.close()
  }
}

async function indexedTitles(root: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  try {
    const body = await readFile(join(root, "session_index.jsonl"), "utf8")
    for (const line of body.split("\n")) {
      if (line.trim() === "") continue
      const row = parseJson(line)
      const id = row?.["id"]
      const title = row?.["thread_name"]
      if (typeof id === "string" && typeof title === "string" && title.trim() !== "") {
        titles.set(id, compactTitle(title))
      }
    }
  } catch (error) {
    if (object(error)["code"] !== "ENOENT") throw error
  }
  return titles
}

function sessionMeta(line: string | null): { id: string; createdAt: number } | null {
  if (line === null) return null
  const row = parseJson(line)
  if (row?.["type"] !== "session_meta") return null
  const payload = object(row["payload"])
  /**
   * `id` 是任务主键；`session_id` 在新版本里可能被一组派生任务共享。
   * 反过来优先会把数百个文件折叠成两百多个“会话”，实机探针抓到过。
   */
  const id = payload["id"] ?? payload["session_id"]
  const createdAt = timestamp(payload["timestamp"]) ?? timestamp(row["timestamp"])
  if (typeof id !== "string" || createdAt === null) return null
  return { id, createdAt }
}

export class CodexLocalRecordReader {
  private readonly cache = new Map<string, CachedMessages>()

  constructor(private readonly options: CodexLocalRecordReaderOptions) {}

  async conversations(signal?: AbortSignal): Promise<ChannelConversationList> {
    const catalog = await this.catalog(signal)
    return {
      items: catalog
        .map<ChannelConversationItem>((entry) => ({
          externalId: entry.id,
          title: entry.title,
          kind: "direct",
          memberCount: 2,
          lastMessageAt: entry.updatedAt,
        }))
        .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0)),
      truncated: false,
    }
  }

  async probe(signal?: AbortSignal) {
    const catalog = await this.catalog(signal)
    return {
      conversations: catalog.map((entry) => ({
        externalId: entry.id,
        lastMsgAt: entry.updatedAt,
        unreadCount: null,
      })),
    }
  }

  async pull(spec: ChannelPullSpec): Promise<ChannelPullPage> {
    spec.signal?.throwIfAborted()
    const catalog = await this.catalog(spec.signal)
    const candidates = catalog.filter(
      (entry) => entry.createdAt <= spec.end && entry.updatedAt >= spec.start,
    )
    const messages = (
      await mapConcurrent(
        candidates,
        MESSAGE_CONCURRENCY,
        async (entry) => await this.messages(entry, spec.signal),
      )
    )
      .flat()
      .filter((message) => message.sentAt >= spec.start && message.sentAt <= spec.end)
      .sort((left, right) =>
        left.sentAt === right.sentAt
          ? left.externalId.localeCompare(right.externalId)
          : left.sentAt - right.sentAt,
      )

    const cursor = decodeCursor(spec.cursor)
    const remaining = messages.filter((message) => afterCursor(message, cursor))
    const pageMessages = remaining.slice(0, Math.max(1, spec.limit))
    const hasMore = remaining.length > pageMessages.length
    const last = pageMessages.at(-1)
    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor({ kind: CURSOR_KIND, sentAt: last.sentAt, externalId: last.externalId })
        : null
    const byId = new Map(catalog.map((entry) => [entry.id, entry]))
    const conversationIds = new Set(pageMessages.map((message) => message.conversationExternalId))
    const conversations: ParsedConversationLike[] = [...conversationIds].map((id) => ({
      externalId: id,
      title: byId.get(id)?.title ?? null,
      type: "direct",
      memberCount: 2,
    }))
    const normalized: ParsedMessageLike[] = pageMessages.map((message) => ({
      externalId: message.externalId,
      conversationExternalId: message.conversationExternalId,
      senderExternalId: "local-user",
      senderDisplayName: "本机用户",
      contentText: message.text,
      contentJson: null,
      quotedExternalId: null,
      sentAt: message.sentAt,
      mentions: [],
      hasMedia: false,
    }))

    return {
      conversations,
      messages: normalized,
      nextCursor,
      hasMore,
      itemCount: normalized.length,
      /** 只保留已经通过角色过滤的最小重放形状，绝不复制整份外部会话。 */
      rawPayload: JSON.stringify({
        kind: CURSOR_KIND,
        messages: normalized.map((message) => ({
          externalId: message.externalId,
          conversationExternalId: message.conversationExternalId,
          contentText: message.contentText,
          sentAt: message.sentAt,
        })),
      }),
    }
  }

  private async catalog(signal?: AbortSignal): Promise<SessionCatalogEntry[]> {
    signal?.throwIfAborted()
    const root = this.options.recordsRoot()
    const titles = await indexedTitles(root)
    let paths: string[]
    try {
      paths = [
        ...(await filesBelow(join(root, "sessions"))),
        ...(await filesBelow(join(root, "archived_sessions"))),
      ]
    } catch (error) {
      throw new AppError("CHANNEL_LOCAL_RECORDS_UNAVAILABLE", "读取本地会话目录失败", {
        cause: error,
        messageKey: "errors:channel.localRecordsReadFailed",
      })
    }

    const current = new Set(paths)
    for (const path of this.cache.keys()) {
      if (!current.has(path)) this.cache.delete(path)
    }

    const rows = await mapConcurrent(
      paths,
      CATALOG_CONCURRENCY,
      async (path): Promise<SessionCatalogEntry | null> => {
        signal?.throwIfAborted()
        try {
          const [info, line] = await Promise.all([stat(path), firstLine(path, signal)])
          const meta = sessionMeta(line)
          if (meta === null) return null
          const fallback = `本地任务 · ${new Date(meta.createdAt).toISOString().slice(0, 10)}`
          return {
            id: meta.id,
            path,
            title: titles.get(meta.id) ?? fallback,
            createdAt: meta.createdAt,
            updatedAt: info.mtimeMs,
            size: info.size,
          }
        } catch (error) {
          if (object(error)["code"] === "ENOENT") return null
          throw error
        }
      },
    )
    const byId = new Map<string, SessionCatalogEntry>()
    for (const row of rows) {
      if (row === null) continue
      const previous = byId.get(row.id)
      if (previous === undefined || row.updatedAt >= previous.updatedAt) byId.set(row.id, row)
    }
    return [...byId.values()]
  }

  private async messages(
    entry: SessionCatalogEntry,
    signal?: AbortSignal,
  ): Promise<ParsedUserMessage[]> {
    const cached = this.cache.get(entry.path)
    if (cached?.size === entry.size && cached.updatedAt === entry.updatedAt) return cached.messages

    const messages: ParsedUserMessage[] = []
    const duplicates = new Map<string, number>()
    const lines = createInterface({
      input: createReadStream(entry.path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    })
    try {
      for await (const line of lines) {
        signal?.throwIfAborted()
        const row = parseJson(line)
        if (row?.["type"] !== "event_msg") continue
        const payload = object(row["payload"])
        if (payload["type"] !== "user_message") continue
        const text = payload["message"]
        const sentAt = timestamp(row["timestamp"])
        if (typeof text !== "string" || text.trim() === "" || sentAt === null) continue
        const duplicateKey = `${sentAt}\0${text}`
        const duplicate = duplicates.get(duplicateKey) ?? 0
        duplicates.set(duplicateKey, duplicate + 1)
        messages.push({
          externalId: messageId(entry.id, sentAt, text, duplicate),
          conversationExternalId: entry.id,
          text,
          sentAt,
        })
      }
    } catch (error) {
      if (object(error)["code"] !== "ENOENT") throw error
    } finally {
      lines.close()
    }
    this.cache.set(entry.path, { size: entry.size, updatedAt: entry.updatedAt, messages })
    return messages
  }
}
