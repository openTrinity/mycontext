/**
 * 飞书云文档采集 —— 走 `ChannelDocuments` 契约。
 *
 * ## ★★ 这个文件替换掉的东西是一个正在污染数据的错形状
 *
 * 改动前云文档走的是**消息**那条路（`parseLarkDrivePage`）：一个合成的
 * 假会话 `feishu:drive`（`type: "group"`），每篇文档当一条 message。
 * 后果是四处污染，而**没有任何一处报错**：
 *
 * · **会话列表**里多出一个不存在的"群"，用户能在采集范围里勾选它；
 * · **FTS 索引**把文档正文当聊天正文，检索结果里混着"某人在某群说"；
 * · **消息水位**被文档的编辑时间推进 —— 文档比消息新时，那段时间的真实
 *   消息会被当成"已经采过"；
 * · **图谱**里生出以那个假群为端点的会话边。
 *
 * `documents` 表本来就存在（钉钉那侧在用），契约也齐（`list` / `body` /
 * `readableExtensions`）。所以这一步不是"新增能力"，是把数据放回它该在的地方。
 *
 * ## ★ 正文这一半目前拿不到（如实标注，不假装）
 *
 * `drive +search` 返回的是**摘要片段**（`summary` / `snippet`），不是正文。
 * 而"能不能用另一条命令取正文"这件事需要真机飞书账号验证（本机没有
 * `@larksuite/cli`、也没有账号）。所以 `body()` 现在恒返回 `contentText: null`
 * —— 那与钉钉的表格/脑图同一个口径：**「有这个东西但没取到内容」必须与
 * 「没有这个东西」可区分**（见 `ParsedDocumentLike.contentText` 的注释）。
 *
 * 摘要片段没有被丢掉：它进 `title` 之后的元信息里（`docType`），
 * 检索仍能靠标题命中这篇文档，只是拿不到全文。
 *
 * 接正文时要做的两件事写在 `body()` 里。
 */
import type { ChannelDocuments } from "../../types.js"
import type { LarkCli } from "./cli.js"
import { parseLarkDriveDocuments } from "./parse.js"

/**
 * 单次列举最多翻多少页。
 *
 * 与 `ingest.ts` 的 `PAGE_LIMIT` 同一个理由：服务端的分页信号不总是诚实，
 * 而没有上限就是可能永不终止的循环。撞上限时必须报 `truncated`
 * —— 否则下游会把"只列了 20 页"当成"一共这么多"。
 */
const PAGE_LIMIT = 20

/** 一页最多取多少条（CLI 侧的上限，给大了它自己会截）。 */
const PAGE_SIZE = 50

/**
 * 按用户选定的窗口算 `--edited-since` 的天数。
 *
 * ★ 与 `ingest.ts` 里那个同源（隐私边界：用户选 7 天就是 7 天）。
 * 这里没有 `spec.start/end` —— `ChannelDocuments.list` 的契约里没有时间窗
 * （见那个接口的注释：文档枚举没有时间窗语义）。所以取一个**保守**的
 * 默认，并把它写清楚：这不是"我们想采一年"，是这条命令必须给一个值。
 *
 * ★ 为什么是 30 而不是 365：改动前写死 365d。文档的价值随时间衰减得比
 * 消息快（一年前的文档多半已经被新版本取代），而少采的代价是"某篇老文档
 * 搜不到"，多采的代价是用户没同意的数据进了本地库。两者不对称。
 */
const DEFAULT_EDITED_SINCE_DAYS = 30

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function nextPageToken(payload: unknown): string | null {
  const row = record(payload)
  for (const key of ["page_token", "pageToken", "next_page_token", "nextPageToken"]) {
    const value = row[key]
    if (typeof value === "string" && value !== "") return value
  }
  return null
}

/** 游标：`{page, token}` 的 JSON。解析失败当"从头开始"，不抛（见 ingest.ts 同款）。 */
function parseCursor(value: string | null | undefined): { page: number; token: string } | null {
  if (value === null || value === undefined) return null
  try {
    const row = record(JSON.parse(value) as unknown)
    return typeof row["page"] === "number" && typeof row["token"] === "string"
      ? { page: row["page"], token: row["token"] }
      : null
  } catch {
    return null
  }
}

export function createFeishuDocuments(cli: Pick<LarkCli, "json">): ChannelDocuments {
  return {
    async list(spec = {}) {
      const cursor = parseCursor(spec.cursor)
      const args = [
        "drive",
        "+search",
        "--query",
        "",
        "--edited-since",
        `${String(DEFAULT_EDITED_SINCE_DAYS)}d`,
        "--sort",
        "edit_time",
        "--page-size",
        String(Math.min(spec.limit ?? PAGE_SIZE, PAGE_SIZE)),
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
      // 撞上限：服务端还说有下一页，但我们不再翻 —— 必须能上报（见 PAGE_LIMIT）
      const truncated = token !== null && page >= PAGE_LIMIT
      return {
        items: parseLarkDriveDocuments(payload),
        nextToken:
          token === null || truncated ? null : JSON.stringify({ page: page + 1, token }),
        hasMore: token !== null && !truncated,
        truncated,
        rawPayload: JSON.stringify(payload),
      }
    },

    /**
     * 取一篇文档的正文 —— **目前恒为 null**。
     *
     * ## ★ 为什么是 null 而不是"把摘要当正文"
     *
     * `drive +search` 给的是摘要片段（几十到几百字，带高亮标记）。把它写进
     * `contentText` 的话，下游（FTS / 图谱切块 / 蒸馏）会把它当**全文**处理
     * —— 而那意味着一篇长文档在图谱里只留下几句话，且**看不出是残缺的**。
     * `null` 是诚实的："有这篇文档，但没取到内容"（与钉钉的表格同口径）。
     *
     * ## 接正文时要做两件事
     *
     * 1. **实测**（V2）：`drive` 子命令里有没有取正文的（`+read` / `+export`
     *    之类）。需要真机飞书账号 —— 本机既没有 `@larksuite/cli` 也没有账号。
     * 2. 那条命令要**逐条加进白名单**（`cli.ts` 的 `READ_COMMANDS`），
     *    并按 `extension` 决定哪些类型值得调（`readableExtensions`）。
     *
     * 不抛：`ChannelDocuments.body` 的契约明写"某一篇取不到是常态而非错误"。
     */
    body() {
      return Promise.resolve({ contentText: null, rawPayload: null })
    },

    /**
     * 哪些后缀**可能**读到正文。
     *
     * ★ 现在是**空数组**，而那不是偷懒 —— 它是"一篇都读不到"的准确表达，
     * 而且有实际作用：采集侧的正文队列按它过滤 SQL（见
     * `ChannelDocuments.readableExtensions` 的注释）。空数组 = 队列里一篇
     * 都不排，于是**每轮的正文配额不会被白占**。
     *
     * 不给这个字段的后果是"不过滤"——那时队列每轮都塞满永远取不到正文的
     * 文档，而 `body()` 内部跳过只是不发命令，配额已经花掉了。
     */
    readableExtensions: [],
  }
}
