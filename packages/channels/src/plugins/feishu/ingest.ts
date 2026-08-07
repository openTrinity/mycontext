/**
 * 飞书的**只读**采集：云文档（drive）+ 聊天消息（im），都经官方 CLI。
 *
 * ## 两路并行、各自分页，而游标要能同时记住两路的进度
 *
 * 这个渠道没有"一条流"可翻：`drive +search` 按编辑时间排序、
 * `im +messages-search` 按时间窗搜索，两者的分页机制完全独立。
 * 而契约里的 `cursor` 只有一个字符串 —— 所以它必须是一个**结构化**的值，
 * 同时装着两路各自的位置。
 *
 * 改动前它只装 drive 那一路，于是 IM 的分页恒从头开始（写死 `--page-limit 5`
 * 且不记游标），而 drive 的 `hasMore` 还会**掩盖** IM 的截断：drive 抽干了
 * 就报 `hasMore=false`，上层据此认为"这个时间窗采完了"并推进水位 ——
 * 而 IM 那边可能只翻了 5 页。剩下的消息永久丢失，且日志里一个错都没有。
 *
 * ## 时间范围必须来自 `spec`，不许自己定
 *
 * 用户在引导里选了 7 天就是 7 天。写死一个更大的范围是**隐私问题**
 * （见 CLAUDE.md 第 5 节），不是"多采点没坏处"。
 */
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

/**
 * 一路的分页位置。`token` 是渠道给的 page token，`page` 是我们自己数的页码
 * （用来兜住"服务端一直给 token 却永远翻不完"这种情况，见 `PAGE_LIMIT`）。
 */
interface BranchCursor {
  page: number
  token: string
}

/**
 * 结构化游标：**同时**记住两路的进度。
 *
 * 某一路为 `null` 表示"这一路已经抽干了"。两路都 null → 整个时间窗采完。
 */
interface FeishuCursor {
  kind: "feishu"
  drive: BranchCursor | null
  im: BranchCursor | null
}

/**
 * 单路最多翻多少页。
 *
 * ★ 必须有这个上限，也必须能把"撞上限了"说出来（`truncated`）：
 * 服务端的 `hasMore` 不总是诚实（本仓库在另一个渠道上实测过 276/277 页
 * 都报 `hasMore=false` 却仍给非空游标）。没有上限就是可能永不终止的循环；
 * 有上限而不上报，就是"只采了 20 页却对外说采完了"。
 */
const PAGE_LIMIT = 20

function encodeCursor(cursor: FeishuCursor): string {
  return JSON.stringify(cursor)
}

/**
 * 解析游标。**解析失败一律当"从头开始"，不抛。**
 *
 * ★ 为什么不抛：库里可能躺着上一个版本写下的旧格式游标（这次就换了格式）。
 * 抛的话那个 vault 的飞书采集会永久失败，而修法只能是手工清游标 ——
 * 而"从头开始"最坏只是重复几次 CLI 调用，落库那边有 `payload_hash` 幂等兜住。
 */
function parseCursor(value: string | null): FeishuCursor | null {
  if (value === null) return null
  try {
    const row = object(JSON.parse(value) as unknown)
    const branch = (key: string): BranchCursor | null => {
      const inner = row[key]
      if (typeof inner !== "object" || inner === null) return null
      const b = inner as Record<string, unknown>
      return typeof b["page"] === "number" && typeof b["token"] === "string"
        ? { page: b["page"], token: b["token"] }
        : null
    }
    if (row["kind"] !== "feishu") return null
    return { kind: "feishu", drive: branch("drive"), im: branch("im") }
  } catch {
    return null
  }
}

/**
 * 按用户选定的窗口算 `--edited-since` 的天数。
 *
 * ★ 这是隐私边界：写死 `365d` 时用户选 7 天而我们实际采 365 天。
 * 向上取整 + 至少 1 天：CLI 只接受整天，而取整到 0 会让窗口变成"什么都不采"。
 */
function editedSinceDays(spec: ChannelPullSpec): number {
  return Math.max(1, Math.ceil((spec.end - spec.start) / 86_400_000))
}

/** 一路的采集结果：这一页的内容 + 下一页位置（null = 抽干）+ 是否撞了上限。 */
interface BranchResult {
  page: ChannelPullPage
  next: BranchCursor | null
  truncated: boolean
}

async function pullDrive(
  cli: Pick<LarkCli, "json">,
  spec: ChannelPullSpec,
  cursor: BranchCursor | null,
): Promise<BranchResult> {
  const args = [
    "drive",
    "+search",
    "--query",
    "",
    // ★ 天数来自用户选的窗口，不是写死的 365d（见 editedSinceDays）
    "--edited-since",
    `${String(editedSinceDays(spec))}d`,
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
  const page = cursor?.page ?? 1
  // 撞上限：服务端还说有下一页，但我们不再翻 —— 这件事必须能被上报
  const truncated = token !== null && page >= PAGE_LIMIT
  return {
    page: parseLarkDrivePage(payload, spec.end),
    next: token === null || truncated ? null : { page: page + 1, token },
    truncated,
  }
}

/**
 * 聊天消息一路。
 *
 * ## ★ 为什么这里有个"二次取正文"的环节
 *
 * `+messages-search` 有时只返回 message id 而不带正文（实测），那时要用
 * `+messages-mget` 按 id 批量补。判据是"返回里有没有任何一条带正文"——
 * 不能只看第一条（搜索结果里混着两种形态）。
 *
 * ## ★★ 分页位置要记下来
 *
 * 改动前这里写死 `--page-limit 5` 且**不返回游标**，于是每个时间窗恒只取
 * 前 5 页，而上层看 drive 的 `hasMore` 就推进了水位 —— 剩下的消息永久丢失。
 */
async function pullMessages(
  cli: Pick<LarkCli, "json">,
  spec: ChannelPullSpec,
  cursor: BranchCursor | null,
): Promise<BranchResult> {
  const args = [
    "im",
    "+messages-search",
    "--query",
    "",
    "--start",
    localIso(spec.start),
    "--end",
    localIso(spec.end),
    // ★ 一次只翻一页，位置记进游标 —— 由上层决定要不要继续（那才是抽干的语义）
    "--page-limit",
    "1",
    "--page-size",
    String(Math.min(spec.limit, 50)),
    "--no-reactions",
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
  const page = cursor?.page ?? 1
  const truncated = token !== null && page >= PAGE_LIMIT
  const next = token === null || truncated ? null : { page: page + 1, token }

  const direct = parseLarkMessagePage(payload, spec.end)
  if (direct.messages.some((message) => message.contentText !== null)) {
    return { page: direct, next, truncated }
  }

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
  return {
    page: hydrated.length === 0 ? direct : mergePages(hydrated),
    next,
    truncated,
  }
}

export function createFeishuIngest(cli: Pick<LarkCli, "json">): ChannelIngest {
  return {
    probe: () => Promise.resolve(null),
    /**
     * 拉一页：两路各推进一页，游标同时记住两路的位置。
     *
     * ## ★★ 任一路失败就抛（而不是"两路全失败才抛"）
     *
     * 改动前是后者，后果是：IM 失败 + drive 成功 → 本轮算成功 → **水位推进**
     * → 那个时间窗的聊天消息永久丢失，而日志里一个错都没有。
     * 这正是本仓库最贵的那类 bug（静默数据缺失）。
     *
     * 整轮重试的代价只是重复几次 CLI 调用（落库那边 `payload_hash` 幂等），
     * 而少一批消息是不可恢复的 —— 两者不对称，所以宁可重试。
     */
    async pull(spec: ChannelPullSpec): Promise<ChannelPullPage> {
      const cursor = parseCursor(spec.cursor)
      /**
       * 首页（无游标）时两路都要拉；有游标时**只拉还没抽干的那一路**。
       * 已经 null 的那一路不该再发请求 —— 那既浪费一次 CLI 调用，
       * 也会把已经抽干的一路重新变成"从头开始"。
       */
      const first = cursor === null
      const wantDrive = first || cursor.drive !== null
      const wantIm = first || cursor.im !== null

      const [drive, im] = await Promise.allSettled([
        wantDrive
          ? pullDrive(cli, spec, cursor?.drive ?? null)
          : Promise.resolve<BranchResult | null>(null),
        wantIm
          ? pullMessages(cli, spec, cursor?.im ?? null)
          : Promise.resolve<BranchResult | null>(null),
      ])

      const failures: string[] = []
      for (const [name, result] of [
        ["drive", drive],
        ["im", im],
      ] as const) {
        if (result.status === "rejected") {
          const reason =
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          failures.push(`${name}: ${reason}`)
        }
      }
      if (failures.length > 0) {
        throw new AppError("PROCESS_FAILED", `飞书数据读取失败：${failures.join("；")}`, {
          retryable: true,
          context: {
            driveOk: drive.status === "fulfilled",
            imOk: im.status === "fulfilled",
          },
        })
      }

      const driveResult = drive.status === "fulfilled" ? drive.value : null
      const imResult = im.status === "fulfilled" ? im.value : null
      const pages = [driveResult?.page, imResult?.page].filter(
        (page): page is ChannelPullPage => page !== null && page !== undefined,
      )
      const nextCursor: FeishuCursor = {
        kind: "feishu",
        drive: driveResult?.next ?? null,
        im: imResult?.next ?? null,
      }
      /**
       * ★ `hasMore` 是**两路的或**。只看 drive 的话它抽干时就报"采完了"，
       * 而 IM 那边可能还剩十几页 —— 那正是改动前丢消息的入口。
       */
      const hasMore = nextCursor.drive !== null || nextCursor.im !== null
      return {
        ...mergePages(pages, {
          nextCursor: hasMore ? encodeCursor(nextCursor) : null,
          hasMore,
        }),
        // 任一路撞上限 → 这一轮是被截断的，上层据此提示而不是当成"采完了"
        ...(driveResult?.truncated === true || imResult?.truncated === true
          ? { truncated: true }
          : {}),
      }
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
