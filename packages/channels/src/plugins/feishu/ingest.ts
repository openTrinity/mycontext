/** Read-only Drive + IM discovery through the official Lark CLI. */
import { AppError } from "@mycontext/kernel"
import type {
  ChannelIdentity,
  ChannelIngest,
  ChannelPullPage,
  ChannelPullSpec,
} from "../../types.js"
import type { LarkCli } from "./cli.js"
import {
  parseLarkAuthStatus,
  parseLarkDrivePage,
  parseLarkIdentity,
  parseLarkMessagePage,
} from "./parse.js"

function localIso(ms: number): string {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")
  const mm = String(Math.abs(offset) % 60).padStart(2, "0")
  const local = new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
  return `${local}${sign}${hh}:${mm}`
}

function mergePages(
  pages: readonly ChannelPullPage[],
  cursor: { nextCursor: string | null; hasMore: boolean } = {
    nextCursor: null,
    hasMore: false,
  },
): ChannelPullPage {
  const conversations = new Map(
    pages.flatMap((page) => page.conversations).map((row) => [row.externalId, row]),
  )
  const messages = new Map(
    pages.flatMap((page) => page.messages).map((row) => [row.externalId, row]),
  )
  return {
    conversations: [...conversations.values()],
    messages: [...messages.values()],
    nextCursor: cursor.nextCursor,
    hasMore: cursor.hasMore,
    itemCount: messages.size,
    rawPayload: JSON.stringify(pages.map((page) => JSON.parse(page.rawPayload) as unknown)),
  }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function nextPageToken(payload: unknown): string | null {
  const row = object(payload)
  for (const key of ["page_token", "pageToken", "next_page_token", "nextPageToken"]) {
    const value = row[key]
    if (typeof value === "string" && value !== "") return value
  }
  return null
}

function messageIds(payload: unknown): string[] {
  const value = object(payload)["message_ids"]
  return Array.isArray(value) ? value.map(String).filter((id) => id.startsWith("om_")) : []
}

function driveCursor(page: number, token: string): string {
  return JSON.stringify({ kind: "feishu-drive", page, token })
}

function parseDriveCursor(value: string | null): { page: number; token: string } | null {
  if (value === null) return null
  try {
    const row = object(JSON.parse(value) as unknown)
    return row["kind"] === "feishu-drive" &&
      typeof row["page"] === "number" &&
      typeof row["token"] === "string"
      ? { page: row["page"], token: row["token"] }
      : null
  } catch {
    return null
  }
}

async function pullDrive(
  cli: Pick<LarkCli, "json">,
  spec: ChannelPullSpec,
  cursor: { page: number; token: string } | null,
): Promise<{ page: ChannelPullPage; nextCursor: string | null; hasMore: boolean }> {
  const args = [
    "drive",
    "+search",
    "--query",
    "",
    "--edited-since",
    "365d",
    "--sort",
    "edit_time",
    "--page-size",
    String(Math.min(spec.limit, 50)),
    "--format",
    "json",
    "--as",
    "user",
  ]
  if (cursor !== null) args.push("--page-token", cursor.token)
  const payload = await cli.json<unknown>(
    args,
    spec.signal === undefined ? {} : { signal: spec.signal },
  )
  const token = nextPageToken(payload)
  const pageNumber = cursor?.page ?? 1
  const hasMore = token !== null && pageNumber < 20
  return {
    page: parseLarkDrivePage(payload, spec.end),
    nextCursor: hasMore && token !== null ? driveCursor(pageNumber + 1, token) : null,
    hasMore,
  }
}

async function pullMessages(
  cli: Pick<LarkCli, "json">,
  spec: ChannelPullSpec,
): Promise<ChannelPullPage> {
  const payload = await cli.json<unknown>(
    [
      "im",
      "+messages-search",
      "--query",
      "",
      "--start",
      localIso(spec.start),
      "--end",
      localIso(spec.end),
      "--page-limit",
      "5",
      "--page-size",
      String(Math.min(spec.limit, 50)),
      "--no-reactions",
      "--format",
      "json",
      "--as",
      "user",
    ],
    spec.signal === undefined ? {} : { signal: spec.signal },
  )
  const direct = parseLarkMessagePage(payload, spec.end)
  if (direct.messages.some((message) => message.contentText !== null)) return direct

  const ids = [...new Set(messageIds(payload))]
  const hydrated: ChannelPullPage[] = []
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50)
    const body = await cli.json<unknown>(
      [
        "im",
        "+messages-mget",
        "--message-ids",
        batch.join(","),
        "--no-reactions",
        "--format",
        "json",
        "--as",
        "user",
      ],
      spec.signal === undefined ? {} : { signal: spec.signal },
    )
    hydrated.push(parseLarkMessagePage(body, spec.end))
  }
  return hydrated.length === 0 ? direct : mergePages(hydrated)
}

export function createFeishuIngest(cli: Pick<LarkCli, "json">): ChannelIngest {
  return {
    probe: () => Promise.resolve(null),
    async pull(spec: ChannelPullSpec): Promise<ChannelPullPage> {
      // The shared channel cursor carries Drive pagination. IM search performs
      // its own bounded pagination and is only repeated when the next time
      // window begins.
      const cursor = parseDriveCursor(spec.cursor)
      if (cursor !== null) {
        const drive = await pullDrive(cli, spec, cursor)
        return mergePages([drive.page], drive)
      }

      const [drive, im] = await Promise.allSettled([
        pullDrive(cli, spec, null),
        pullMessages(cli, spec),
      ])
      const pages: ChannelPullPage[] = []
      if (drive.status === "fulfilled") pages.push(drive.value.page)
      if (im.status === "fulfilled") pages.push(im.value)
      if (pages.length === 0) {
        const reasons = [drive, im]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) =>
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          )
        throw new Error(`飞书数据读取失败：${reasons.join("；")}`)
      }
      return mergePages(
        pages,
        drive.status === "fulfilled"
          ? { nextCursor: drive.value.nextCursor, hasMore: drive.value.hasMore }
          : undefined,
      )
    },
  }
}

export function createFeishuIdentity(cli: Pick<LarkCli, "json">): ChannelIdentity {
  return {
    async resolveSelf() {
      const payload = await cli.json<unknown>(["auth", "status", "--json", "--verify"])
      const status = parseLarkAuthStatus(payload)
      const identity = parseLarkIdentity(payload)
      if (status.state !== "authorized" || identity === null) {
        throw new AppError("CHANNEL_AUTH_FAILED", "飞书身份不可用，请重新授权")
      }
      return {
        userId: identity.openId,
        openIds: [{ kind: "open_id", value: identity.openId }],
        displayNames: [identity.userName],
        corpId: identity.tenantKey,
        corpName: identity.tenantName,
        /**
         * 飞书只有一条路：`auth status --verify` 直接给出本人身份。
         *
         * 钉钉那边有三条（get-self / 按姓名搜 / 单聊交集兜底），所以那个字段
         * 用来回答「这次的身份是怎么得出的」；飞书恒为 `get-self` ——
         * 语义上等价（都是"平台直接告诉我们我是谁"），而不是"我们推断的"。
         */
        source: "get-self" as const,
      }
    },
  }
}
