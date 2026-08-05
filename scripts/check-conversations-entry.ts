/**
 * 会话列表的真实调用核验（会调 DWS CLI）+ 与本地表的差集。
 *
 * 单测用的是录下来的 fixture —— 那只能证明「解析与我录的形状一致」，
 * 证明不了「渠道现在还是那个形状」。而这个命令的分页行为本身就与它的
 * `--help` 不一致（见 conversations.ts 文件头），也就是说**文档不可信**，
 * 只有真跑才知道。所以留这个脚本：接口一变，这里第一时间红。
 *
 * 同时它量两个数字，那是两个设计决定的唯一依据：
 * · 合并比单命令多出多少 → 「值不值得多调两次 CLI」；
 * · 本地表里有多少是渠道**列不出来**的 → 「为什么不能只用渠道那一路」。
 */
import { existsSync } from "node:fs"
import { createDingTalkConversations, DwsCli } from "@mycontext/channels"
import { createLogger } from "@mycontext/kernel"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { openStore, VAULT_MIGRATIONS } from "@mycontext/store"

export interface ConversationCheckReport {
  /** 三路各自的条数（合并前） */
  windowCount: number
  mutedWindowCount: number
  groupCount: number
  /** 合并后 */
  merged: number
  direct: number
  group: number
  truncated: boolean
  /** 有最后消息时间的条数（群列表那一路没有该字段） */
  withTimestamp: number
  /** 合并相对单命令多出多少 —— 「值不值得多调两次」的度量 */
  gainOverSingleCall: number
  /** 本地 conversations 表的条数；没找到库时为 null */
  localCount: number | null
  /** 本地有、渠道三路**都没返回**的条数 —— 「为什么必须合本地」的度量 */
  localOnly: number | null
  elapsedMs: number
}

function readLocalIds(dbPath: string | undefined): Set<string> | null {
  if (dbPath === undefined || !existsSync(dbPath)) return null
  const handle = openStore({ path: dbPath, migrations: VAULT_MIGRATIONS })
  try {
    const rows = handle.db
      .prepare<[], { external_id: string }>("SELECT external_id FROM conversations")
      .all()
    return new Set(rows.map((row) => row.external_id))
  } finally {
    handle.close()
  }
}

export async function runConversationCheck(options: {
  binDir: string
  dwsHome: string
  dbPath?: string
  now: () => number
}): Promise<ConversationCheckReport> {
  const logger = createLogger("ConvCheck", { level: "warn" })
  const runtime = new RuntimeEnv({ binDir: options.binDir, dwsConfigDir: options.dwsHome })
  const cli = new DwsCli({ runtime, processes: new ProcessRunner(logger), logger })

  /**
   * 分别数三路：只看合并结果的话，某一路挂了（返回 0 条）也照样"有数据" ——
   * 只是少了一大块，没人会注意。那正是要防的静默退化。
   */
  const raw = async (args: string[]): Promise<Record<string, unknown>> => {
    const payload = await cli.json<unknown>(args, {})
    return typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {}
  }

  const startedAt = options.now()

  const windowPayload = await raw(["chat", "list-all-conversations", "--limit", "100"])
  const mutedPayload = await raw([
    "chat",
    "list-all-conversations",
    "--limit",
    "100",
    "--exclude-muted",
  ])
  const groupPayload = await raw(["chat", "group", "list-all", "--limit", "100"])

  const arrayLen = (value: unknown): number => (Array.isArray(value) ? value.length : 0)

  const result = await createDingTalkConversations(cli).list()
  const elapsedMs = options.now() - startedAt

  const localIds = readLocalIds(options.dbPath)
  const remoteIds = new Set(result.items.map((item) => item.externalId))

  return {
    windowCount: arrayLen(windowPayload["conversations"]),
    mutedWindowCount: arrayLen(mutedPayload["conversations"]),
    groupCount: arrayLen(groupPayload["groups"]),
    merged: result.items.length,
    direct: result.items.filter((item) => item.kind === "direct").length,
    group: result.items.filter((item) => item.kind === "group").length,
    truncated: result.truncated,
    withTimestamp: result.items.filter((item) => item.lastMessageAt !== null).length,
    gainOverSingleCall: result.items.length - arrayLen(windowPayload["conversations"]),
    localCount: localIds?.size ?? null,
    localOnly: localIds === null ? null : [...localIds].filter((id) => !remoteIds.has(id)).length,
    elapsedMs,
  }
}
