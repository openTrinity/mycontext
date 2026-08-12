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
import { parseLarkAuthStatus, parseLarkIdentity, parseLarkMessagePage,
  readFeishuTenantKey,
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
    return { kind: "feishu", im: branch("im") }
  } catch {
    return null
  }
}

/** 一路的采集结果：这一页的内容 + 下一页位置（null = 抽干）+ 是否撞了上限。 */
interface BranchResult {
  page: ChannelPullPage
  next: BranchCursor | null
  truncated: boolean
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
  selfOpenId: string | null,
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

  const direct = parseLarkMessagePage(payload, spec.end, selfOpenId)
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
    hydrated.push(parseLarkMessagePage(body, spec.end, selfOpenId))
  }
  return {
    page: hydrated.length === 0 ? direct : mergePages(hydrated),
    next,
    truncated,
  }
}

export function createFeishuIngest(cli: Pick<LarkCli, "json">): ChannelIngest {
  /**
   * 本人 open_id —— 只给**单聊会话名**那条推导用（见 `parseLarkMessagePage`）。
   *
   * ## ★ 为什么在这里取，而不是让上层传进来
   *
   * `ChannelIngest` 的契约里没有"本人身份"这一项，而加一个参数会让所有渠道
   * 都要回答"你的本人 id 是什么" —— 那是 `ChannelIdentity` 的职责。
   * 飞书这边它恰好很便宜：`auth status` 是已经在白名单里的只读命令，
   * 而它的响应里就带着 open_id。
   *
   * ★ **进程内缓存一次**：`pull` 每页都会调，而本人 id 在一次会话里不会变。
   * 不缓存的话每翻一页多起一次子进程（实测一个时间窗能翻 20 页）。
   *
   * ★ 取不到就返回 null 并**记住这个 null**（`resolved` 标记），不反复重试：
   * 拿不到的原因通常是稳定的（没授权 / 网络被拦），而每页重试一次
   * 会把一个"少个会话名"的小问题变成"每页多一次失败的子进程调用"。
   * null 时那条推导退化成只看 `chat_partner.open_id`，与改动前一致。
   */
  let cachedSelfOpenId: string | null = null
  let selfResolved = false
  const selfOpenId = async (): Promise<string | null> => {
    if (selfResolved) return cachedSelfOpenId
    selfResolved = true
    try {
      const payload = await cli.json<unknown>(["auth", "status", "--json", "--verify"])
      cachedSelfOpenId = parseLarkIdentity(payload)?.openId ?? null
    } catch {
      // 拿不到本人 id 不该让采集失败 —— 它只影响会话名，不影响消息本身
      cachedSelfOpenId = null
    }
    return cachedSelfOpenId
  }

  return {
    probe: () => Promise.resolve(null),
    /**
     * 拉一页聊天消息。
     *
     * ## ★ 云文档**不在**这条路上（改动前在）
     *
     * 它现在走 `ChannelDocuments`（见 `documents.ts`）。改动前两者混在这里，
     * 而文档被伪装成一个假群的消息 —— 其中最严重的一条是**消息水位被文档的
     * 编辑时间推进**：文档比消息新时，那段时间的真实消息会被当成已经采过。
     *
     * 分开之后这条路只有一个分支，`hasMore` 就是它自己的分页信号，
     * 不会再被另一路的状态掩盖。
     */
    async pull(spec: ChannelPullSpec): Promise<ChannelPullPage> {
      const cursor = parseCursor(spec.cursor)
      const result = await pullMessages(cli, spec, cursor?.im ?? null, await selfOpenId())
      const nextCursor: FeishuCursor = { kind: "feishu", im: result.next }
      const hasMore = result.next !== null
      return {
        ...result.page,
        nextCursor: hasMore ? encodeCursor(nextCursor) : null,
        hasMore,
        // 撞分页上限 → 这一轮是被截断的，不是"采完了"（见 PAGE_LIMIT）
        ...(result.truncated ? { truncated: true } : {}),
      }
    },
  }
}

/**
 * 从 `contact +get-user` 的响应里取 `tenant_key`（组织 id）。
 *
 * ## ★ 层级是实测出来的
 *
 * 真实响应：`{ ok, identity, data: { user: { …, tenant_key } } }`
 * —— 人在 **`data.user`** 下（`/entity` 那类接口是 `results`，别混）。
 * 同时兼容"信封已被拆掉"的两种形状，上游改层级时不至于静默变成
 * 「未知组织」（那正是这次要修的症状）。
 */

export function createFeishuIdentity(cli: Pick<LarkCli, "json">): ChannelIdentity {
  return {
    async resolveSelf() {
      const payload = await cli.json<unknown>(["auth", "status", "--json", "--verify"])
      const status = parseLarkAuthStatus(payload)
      const identity = parseLarkIdentity(payload)
      if (status.state !== "authorized" || identity === null) {
        throw new AppError("CHANNEL_AUTH_FAILED", "飞书身份不可用，请重新授权")
      }
      /**
       * ★★ 组织 id（`tenant_key`）**必须另外取一次** —— `auth status` 里没有。
       *
       * ## 实测（本机，飞书已授权）
       *
       * `auth status --json --verify` 的 `identities.user` 只有
       * `status / available / verified / message / openId / userName /
       *  tokenStatus / scope / expiresAt / refreshExpiresAt / grantedAt`
       * —— **没有 tenantKey，也没有任何组织名字段**。
       * 而 `contact +get-user` 有真的 `tenant_key`（实测 16 字符）。
       *
       * ## 为什么这不只是界面上一句话
       *
       * `corpId` 是身份隔离键 `(accountId, channelId, corpId, userId)` 的一段。
       * 取不到时 `parseLarkIdentity` 会派生 `unknown-tenant:<openId 前 12 位>`
       * —— 唯一性有了，但那个值**跟着人走而不是跟着组织走**：同一个人在
       * 两个组织里会撞成同一个键，两个组织的数据共用一个 vault。
       * 所以拿到真 `tenant_key` 是**正确性**问题，不只是显示问题
       * （用户看到的「未知组织」是它的表面症状）。
       *
       * ★ 取不到就沿用派生值、**不抛**：这一步失败不该让整个身份解析失败，
       * 那会把"已授权"变成一条走不通的路。
       */
      let tenantKey = identity.tenantKey
      try {
        const user = await cli.json<unknown>([
          "contact",
          "+get-user",
          "--as",
          "user",
          "--format",
          "json",
        ])
        const real = readFeishuTenantKey(user)
        if (real !== null) tenantKey = real
      } catch {
        // 沿用 parseLarkIdentity 的派生值（形如 `unknown-tenant:…`）
      }
      return {
        userId: identity.openId,
        openIds: [{ kind: "open_id", value: identity.openId }],
        displayNames: [identity.userName],
        corpId: tenantKey,
        /**
         * ★ 组织**名**：两条命令都不给（实测 `get-user` 的字段里只有
         * `tenant_key`，没有 tenant name）。所以**不编**一个假名字，
         * 而是显示 `tenant_key` 的短码 —— 用户至少能分辨"这是哪个组织"，
         * 且两个组织不会都显示成「未知组织」。
         * 连 `tenant_key` 都拿不到时才回落到 parse 层那句「未知组织」。
         */
        corpName: tenantKey.startsWith("unknown-tenant:")
          ? identity.tenantName
          : `组织 ${tenantKey.slice(0, 8)}`,
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
