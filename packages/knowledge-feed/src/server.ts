/**
 * Feed Server：给算法团队的增量拉取接口。
 *
 * ## 为什么是拉而不是推
 *
 * 他们的既定模式就是轮询，而拉取模式唯一的短板是**空轮询开销** ——
 * `/v1/head` 专门为此设计：只读一行 `MAX(seq)`，消费者 `lag == 0` 就直接睡，
 * 连 `/v1/changes` 都不发。这样他们可以把间隔调到 10s 而几乎不产生负载。
 * 短板补齐后，第一期不做推送（推送要处理重连、背压、乱序，成本高得多）。
 *
 * ## 安全边界
 *
 * 只绑 `127.0.0.1` + Bearer。**与宿主 MCP server 的 token 不同源、不得互认**：
 * 前者给算法团队的进程用，后者给 agent 用，两者的权限范围完全不同 ——
 * 互认会让「agent 能调 Feed」这条我们没设计过的路径悄悄成立。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { AppError, type Clock, type Logger } from "@mycontext/kernel"
import {
  ChangelogRepository,
  ConsumerCursorRepository,
  type SqliteDatabase,
} from "@mycontext/store"

export interface FeedServerOptions {
  db: SqliteDatabase
  clock: Clock
  logger?: Logger
  /** 0 = 随机端口（推荐：固定端口更容易被本机脚本猜到） */
  port?: number
  /** 缺省时自动生成。生成的值通过 `token` 读出来写进 handoff.json */
  token?: string
  /** 单次 changes 的条数上限 */
  maxPageSize?: number
}

interface RouteContext {
  url: URL
  request: IncomingMessage
  response: ServerResponse
}

/** 不传 `limit` 时的默认页大小。仍会被 `maxPageSize` 夹一次。 */
const DEFAULT_PAGE_SIZE = 500

export class FeedServer {
  private server: Server | null = null
  private readonly changelog: ChangelogRepository
  private readonly consumers: ConsumerCursorRepository
  readonly token: string

  constructor(private readonly options: FeedServerOptions) {
    this.changelog = new ChangelogRepository(options.db)
    this.consumers = new ConsumerCursorRepository(options.db, options.clock)
    this.token = options.token ?? randomBytes(32).toString("base64url")
  }

  /** 实际监听的端口（随机端口时启动后才知道）。 */
  get port(): number {
    const address = this.server?.address()
    return typeof address === "object" && address !== null ? address.port : 0
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        this.handle(request, response).catch((error: unknown) => {
          this.options.logger?.warn("feed request failed", {
            detail: (error as Error).message,
          })
          this.json(response, 500, { error: "internal" })
        })
      })
      server.on("error", reject)
      // ★ 只绑回环地址。默认值不是契约，显式传。
      server.listen(this.options.port ?? 0, "127.0.0.1", () => {
        this.server = server
        resolve(this.port)
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    if (server === null) return Promise.resolve()
    this.server = null
    return new Promise((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")

    // ★ 浏览器发起的跨源请求一律拒绝（在鉴权之前）。
    //
    // 这是纵深防御：Bearer 已经能挡住无凭据的请求，但**带 Origin 头**
    // 意味着请求来自一个网页而不是算法侧的脚本 —— 我们的消费者
    // （Python / CLI）永远不带 Origin。拒绝它挡的是 DNS rebinding 一类场景：
    // 攻击者页面把某域名解析到 127.0.0.1，再用 fetch 打我们的端口。
    // 那种场景下 SOP 不保护我们，而"本机就安全"这个假设正是我们在别处
    // 刻意不接受的（见 opencode 的无鉴权 HTTP server）。
    if (!this.originAllowed(request)) {
      this.json(response, 403, { error: "forbidden_origin" })
      return
    }

    if (!this.authorized(request)) {
      this.json(response, 401, { error: "unauthorized" })
      return
    }

    const context: RouteContext = { url, request, response }
    switch (url.pathname) {
      case "/v1/head":
        this.head(context)
        return
      case "/v1/changes":
        this.changes(context)
        return
      case "/v1/ack":
        await this.ack(context)
        return
      case "/v1/snapshot":
        this.snapshot(context)
        return
      default:
        this.json(response, 404, { error: "not_found" })
    }
  }

  /**
   * 只接受**不带 Origin** 的请求。
   *
   * 非浏览器客户端（算法侧的 Python / curl / CLI）不会发 Origin 头；
   * 带了 Origin 就说明是网页发起的，而这个服务没有任何面向网页的用途。
   * 所以判据是"有没有"而不是"是不是白名单里的域" —— 后者需要维护一张
   * 永远不该有内容的白名单。
   */
  private originAllowed(request: IncomingMessage): boolean {
    return request.headers.origin === undefined
  }

  /**
   * Bearer 校验。
   *
   * 用 `timingSafeEqual` 而不是 `===`：token 比较的时序差异可以被用来逐字节
   * 猜测。虽然这是本机服务，但"本机就安全"这个假设正是我们在别处刻意不接受的
   * （见 opencode 的无鉴权 HTTP server）。
   */
  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? ""
    const provided = header.startsWith("Bearer ") ? header.slice(7) : ""
    const expected = this.token
    if (provided.length !== expected.length) return false
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  }

  /**
   * 水位。
   *
   * 刻意做得极轻（一次 MAX(seq) + 一次全表小查询）：
   * 消费者会高频调它，重了就等于逼他们把间隔调长，那又回到延迟问题。
   */
  private head(context: RouteContext): void {
    const head = this.changelog.head()
    const consumers = Object.fromEntries(
      this.consumers.list().map((consumer) => [
        consumer.consumerId,
        {
          ackedSeq: consumer.ackedSeq,
          lag: head - consumer.ackedSeq,
          needsFullRebuild: consumer.needsFullRebuild,
        },
      ]),
    )
    this.json(context.response, 200, {
      head,
      domains: this.changelog.headByDomain(),
      consumers,
      serverTime: this.options.clock.now(),
    })
  }

  private changes(context: RouteContext): void {
    const since = Number(context.url.searchParams.get("since") ?? "0")
    const domain = context.url.searchParams.get("domain") ?? undefined

    if (!Number.isFinite(since) || since < 0) {
      this.json(context.response, 400, { error: "invalid_since" })
      return
    }

    /**
     * ★ limit 必须与 since 一样严格校验。
     *
     * 首版只做 `Math.min(Number(raw), maxPageSize)`，实测两个后果：
     * · `limit=abc` → `NaN` → better-sqlite3 抛 `datatype mismatch`
     *   → 走 500（而不是 400）：客户端的参数错误被报成服务端故障；
     * · `limit=-5` → SQLite 把负 LIMIT 视为**无限制**（实测返回全表）
     *   → 一次拉走整个 changelog，**绕过分页上限**。
     *   分页上限本来是防止一次请求把整库读走的，绕过它就等于没有。
     */
    const maxPageSize = this.options.maxPageSize ?? 1000
    const rawLimit = context.url.searchParams.get("limit")
    const parsedLimit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit)
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      this.json(context.response, 400, { error: "invalid_limit" })
      return
    }
    const limit = Math.min(parsedLimit, maxPageSize)

    const rows = this.changelog.changesSince(since, limit, domain)
    this.json(context.response, 200, {
      changes: rows,
      // 明确给出「还有没有更多」，省掉一次探测请求
      hasMore: rows.length === limit,
      head: this.changelog.head(),
    })
  }

  private async ack(context: RouteContext): Promise<void> {
    if (context.request.method !== "POST") {
      this.json(context.response, 405, { error: "method_not_allowed" })
      return
    }
    const body = (await readJsonBody(context.request)) as {
      consumerId?: unknown
      seq?: unknown
    }
    const consumerId = typeof body.consumerId === "string" ? body.consumerId : ""
    const seq = typeof body.seq === "number" ? body.seq : Number.NaN
    if (consumerId === "" || !Number.isFinite(seq)) {
      this.json(context.response, 400, { error: "invalid_body" })
      return
    }

    // 首次 ack 即注册：告知当前最小保留 seq，让「历史已被裁剪」的情况
    // 走全量重建而不是从 0 增量（后者会得到静默缺数据的索引）。
    this.consumers.register(consumerId, { minRetainedSeq: this.oldestRetainedSeq() })
    this.consumers.ack(consumerId, seq)
    this.json(context.response, 200, { ok: true, ackedSeq: seq })
  }

  /**
   * 全量快照的入口。
   *
   * 一期只返回「去哪里取物化文件」而不是把全量数据塞进 HTTP 响应：
   * 全量可能是几十万条，走文件比走一次巨大的 JSON 响应可靠得多
   * （中断可续、可校验、可离线检查）。
   */
  private snapshot(context: RouteContext): void {
    this.json(context.response, 200, {
      head: this.changelog.head(),
      // 由 ExportMaterializer 产出，路径经 handoff.json 告知
      hint: "read exported files under KL_DWS_EXPORT_DIR",
      serverTime: this.options.clock.now(),
    })
  }

  private oldestRetainedSeq(): number {
    const rows = this.changelog.changesSince(0, 1)
    return rows[0]?.seq ?? 0
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    })
    response.end(payload)
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length
    // ack 的 body 只有两个字段；给 64KB 上限挡住异常请求。
    if (bytes > 64 * 1024) throw new AppError("IPC_BAD_REQUEST", "请求体过大")
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new AppError("IPC_BAD_REQUEST", "请求体不是合法 JSON")
  }
}
