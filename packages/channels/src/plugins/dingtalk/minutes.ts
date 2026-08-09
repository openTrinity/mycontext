/**
 * 钉钉听记（会议转写）的采集。
 *
 * ## 为什么听记是独立一条采集路径，不挂在消息轮询上
 *
 * 三个语义都不一样：
 * · **没有水位** —— `minutes list all` 的 `--start/--end` 是「可选筛选」
 *   而不是水位语义（它不保证"这之后的都给你"），所以「重叠窗口 + 水位」
 *   那套机制在这里没有对应物，用不了 IngestScheduler。
 *   ★ 但它**确实接受**这两个参数，而我们用它们做**范围收窄**
 *   （用户在引导里选的时间范围），见 `list` 里那段注释。
 * · **正文要二次调用** —— list 只给元信息（uuid/title/startTime/duration），
 *   正文得再调 `get summary` 与 `get transcription`。
 * · **变更频率低** —— 会议是稀疏事件（实测该账号 10 条 + hasMore）。
 *   按消息那样 2 分钟一轮是纯浪费。
 *
 * ## ★ `minutes list` 必须带 scope `all`
 *
 * 文档原文：裸 `dws minutes list`「**不会报错**，但返回结果不完整
 * （仅返回最近少量条目，约 913 字节）」，而 `list all` 约 3362 字节。
 * 这是个静默截断 —— 少拿数据但不报错。所以命令里写死 `all`，
 * 且白名单登记的路径也是 `["minutes","list","all"]`（漏了 scope 会被门禁拒绝，
 * 而不是静默拿到残缺数据）。
 *
 * ## ★★ 两条分页都要抽干（这一层只负责转写那条）
 *
 * 两个子命令都是分页的，而首版**两条都只取第一页**：
 *
 * | 命令 | 分页 flag | 结束信号 | 谁负责抽干 |
 * | --- | --- | --- | --- |
 * | `minutes list all` | `--cursor` | `hasMore` + `nextToken` | 采集服务（`runMinutes`） |
 * | `minutes get transcription` | `--cursor` | `hasNext` + `nextToken` | **本文件的 `body()`** |
 *
 * ★ 注意两条的结束信号字段名**不同**（`hasMore` vs `hasNext`）——
 * 同一个二进制的两个子命令，实测如此。认错的表现是恒为 false，
 * 也就是"抽干循环第一页就停"，与从前的行为完全一样且不报错。
 *
 * ★★ **两条的游标都实测是真的**（2026-08-09，开源版 v1.0.57）：
 * · `list all`：22 场会翻 2 页（20 + 2），页指纹互不相同，`hasMore` 诚实收尾；
 * · `get transcription`：三场长会分别翻出 18 / 21 / 25+ 页，每页指纹都不同。
 *
 * 这个"实测过"很重要 —— 同一个 CLI 的 `chat list-all-conversations`
 * 的 `--cursor` 是**假的**（传任何值都返回逐字相同的首页，见
 * conversations.ts 文件头）。所以"有 --cursor flag"不等于"能翻页"，
 * 每条都得单独验。
 *
 * 列表那条为什么不在这一层抽干：它每页都要**落库**（几十场会议攒到最后
 * 再写，中途 stop 就全丢），而落库是服务层的事。转写这条不同 ——
 * 一场会议的多页在语义上是**一份**正文，拼完再返回才对。
 *
 * ## 实测的响应形状
 *
 * 信封由 `DwsCli.json` 剥掉（那层还会检查 `errorCode`）。剥完之后：
 *
 * · `list all` → `{hasMore, itemList[], nextToken}`，item 字段（2026-08-09
 *   实测，开源版 v1.0.57）：`uuid, title, startTime, startTimeISO, endTime,
 *   endTimeISO, durationMicros, flashUserInfo{name}, keywordsInfo{keywords[]},
 *   orgId, orgName, shareUrl, liveType`
 *   —— ★ `startTime`/`endTime` 是 **epoch ms 数字**，而 `*ISO` 是配套的串。
 *   我们读数字那个（`normalizeUnix`），绕开字符串解析。
 * · `get summary` → `{fullSummary}`（markdown，实测 3107 字符，含参与人行）
 * · `get transcription` → `{hasNext, nextToken, paragraphList[]}`，
 *   段落字段 `nickName / paragraph / startTime / endTime / sentenceList[]`
 *   —— ★★ **最后一页的 `hasNext` 是 `undefined` 而不是 `false`**
 *   （那个键不出现）。判据因此必须是 `=== true`，见 `parseMinutesTranscriptionPage`。
 *
 * 注意 `durationMicros` 的单位是**微秒**（实测 1224340000 ≈ 20.4 分钟），
 * 不是毫秒 —— 当毫秒读会把 20 分钟的会议记成 14 天。
 *
 * ## ⚠️ 闭源版拿不到听记（实测，2026-08-09）
 *
 * 同一个身份、同一个企业：
 * · 预置的闭源版 v0.2.99 → `server_error_code: ENTERPRISE_NOT_AUTHORIZED`
 *   （`operation: minutes/list_by_keyword_and_time_range`），**一条都拿不到**；
 * · 开源版 v1.0.57 → 正常返回 22 场会议。
 *
 * 也就是说这不是"企业没开通听记"，而是**两版自带的 OAuth clientId 拿到的
 * scope 不同**。诊断听记问题时第一件事是确认跑的是哪个二进制
 * （`MYCONTEXT_DWS_SOURCE` 会把闭源版顶上去，见 vendor/dws/README.md）。
 *
 * ★ `classifyDwsError` 目前不认 `ENTERPRISE_NOT_AUTHORIZED`，所以它落到
 * 兜底的 `PROCESS_FAILED{retryable:true}` —— 而 `runMinutes` 整段 catch
 * 并只记一条 warn，不进 blockedReason。行为是对的（听记不可用不该停掉消息
 * 采集），但用户看不到原因。要让它可见得在状态页上加一条，那是独立的一步。
 */
import { formatDwsIsoTime, normalizeUnix } from "./time.js"
import type { DwsCli } from "./cli.js"
import type { ChannelMinutes } from "../../types.js"

export type { ChannelMinutes }

/** 一条听记的元信息 + 可选正文。 */
export interface ParsedMinutes {
  externalId: string
  title: string | null
  /** unix ms */
  startedAt: number | null
  durationSec: number | null
  summaryText: string | null
  /** 转写段落的原样 JSON（可能很大，按需读） */
  transcriptJson: string | null
  /** 参与人 / 发言人的原样 JSON */
  speakersJson: string | null
}

export interface ParsedMinutesPage {
  items: ParsedMinutes[]
  nextToken: string | null
  hasMore: boolean
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * 解析 `minutes list all` 的一页。
 *
 * 拿不到 uuid 的条目直接跳过：uuid 是取正文与幂等键的唯一依据，
 * 没有它这条记录既存不进去（UNIQUE 需要 external_id）也取不了正文。
 */
export function parseMinutesList(payload: unknown): ParsedMinutesPage {
  const items: ParsedMinutes[] = []
  if (typeof payload !== "object" || payload === null) {
    return { items, nextToken: null, hasMore: false }
  }
  let root = payload as Record<string, unknown>
  // 兼容"带信封"的输入（重放 raw_records 时会遇到）。
  if ("success" in root && "result" in root) {
    const inner = root["result"]
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      root = inner as Record<string, unknown>
    }
  }

  const list = root["itemList"] ?? root["item_list"] ?? root["items"] ?? root["list"]
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue
      const record = item as Record<string, unknown>
      const externalId = str(record["uuid"]) ?? str(record["id"])
      if (externalId === null) continue

      const rawStart = num(record["startTime"]) ?? num(record["start_time"])
      let startedAt: number | null = null
      if (rawStart !== null) {
        try {
          startedAt = normalizeUnix(rawStart)
        } catch {
          startedAt = null
        }
      }

      // ★ 微秒 → 秒。字段名里的 Micros 是唯一的单位线索。
      const micros = num(record["durationMicros"]) ?? num(record["duration_micros"])
      const durationSec = micros === null ? null : Math.round(micros / 1_000_000)

      // 发言人/关键词：list 阶段能拿到的就先存，省一次调用。
      const flashUser = record["flashUserInfo"]
      const keywords = record["keywordsInfo"]
      const speakers: Record<string, unknown> = {}
      if (flashUser !== undefined) speakers["owner"] = flashUser
      if (keywords !== undefined) speakers["keywords"] = keywords
      const shareUrl = str(record["shareUrl"])
      if (shareUrl !== null) speakers["shareUrl"] = shareUrl

      items.push({
        externalId,
        title: str(record["title"]),
        startedAt,
        durationSec,
        summaryText: null,
        transcriptJson: null,
        speakersJson: Object.keys(speakers).length === 0 ? null : JSON.stringify(speakers),
      })
    }
  }

  const token = str(root["nextToken"]) ?? str(root["next_token"])
  const more = root["hasMore"] ?? root["has_more"]
  return {
    items,
    nextToken: token,
    hasMore: typeof more === "boolean" ? more : token !== null,
  }
}

/** 解析 `minutes get summary` → markdown 正文。 */
export function parseMinutesSummary(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null
  let root = payload as Record<string, unknown>
  if ("success" in root && "result" in root) {
    const inner = root["result"]
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      root = inner as Record<string, unknown>
    }
  }
  return str(root["fullSummary"]) ?? str(root["full_summary"]) ?? str(root["summary"])
}

/** 转写的一页。`nextToken` 为 null 时无法继续翻（即便 `hasNext` 是 true）。 */
export interface ParsedTranscriptionPage {
  paragraphs: unknown[]
  hasNext: boolean
  nextToken: string | null
}

/**
 * 解析 `minutes get transcription` 的一页。
 *
 * ## ★ 为什么抽干必须先解析，不能像从前那样直接 `JSON.stringify` 整个响应
 *
 * 从前只调一次，所以整段原样存进 `transcript_json` 就够了。要翻页就必须
 * 拿到 `nextToken` —— 而它和 `paragraphList` 一样藏在（可能带信封的）
 * 响应里。与 `parseMinutesList` / `parseMinutesSummary` 同一套写法：
 * 兼容"带信封"的输入（重放 raw_records 时会遇到）。
 *
 * ★ 段落数组**不解析内部结构**（`unknown[]`）：导出侧读的是
 * `{nickName, paragraph}`，而那是**导出契约**的知识（见 export-materializer
 * 里对 `minutes_loader.py` 的对齐注释）。在这里定义一遍段落形状就有了
 * 第二个真源，而两处对同一个字段名的假设分叉时不会有任何报错。
 */
export function parseMinutesTranscriptionPage(payload: unknown): ParsedTranscriptionPage {
  const empty: ParsedTranscriptionPage = { paragraphs: [], hasNext: false, nextToken: null }
  if (typeof payload !== "object" || payload === null) return empty
  let root = payload as Record<string, unknown>
  if ("success" in root && "result" in root) {
    const inner = root["result"]
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      root = inner as Record<string, unknown>
    }
  }
  const list = root["paragraphList"] ?? root["paragraph_list"]
  /**
   * ★ 字段名是 `hasNext`（**不是** list 那条的 `hasMore`）—— 同一个二进制的
   * 两个子命令用了两个名字，实测如此（见文件头的响应形状）。
   * 认错的表现是恒为 false → 抽干循环第一页就停 → 与从前的行为一样，
   * 而且不报错。
   *
   * ## ★★ 判据必须是 `=== true`，**不能**写成 `!== false`
   *
   * 实测（2026-08-09，开源版 v1.0.57）：**最后一页的 `hasNext` 是
   * `undefined`，不是 `false`** —— 那个键压根不出现在响应里
   * （三场长会的收尾页都是这样：`hasNext=undefined nextToken=∅`）。
   *
   * 写成 `!== false` 的话最后一页会被判成"还有下一页"，而 `nextToken`
   * 又是空 —— 抽干循环于是要靠"没给游标"那条兜底才停下来。那条守卫确实
   * 在（见 `body`），但依赖它意味着**每场会议都多跑一次注定失败的判断**，
   * 且一旦哪天上游给了个非空的尾游标就变成死循环。
   */
  const more = root["hasNext"] ?? root["has_next"]
  return {
    paragraphs: Array.isArray(list) ? list : [],
    hasNext: more === true,
    nextToken: str(root["nextToken"]) ?? str(root["next_token"]),
  }
}

/**
 * 每页条数。
 *
 * ## ★★ 实测 `--limit` 的**硬顶是 20**（文档没写上限）
 *
 * 2026-08-09 实测（开源版 v1.0.57，22 场会议的账号）：
 *
 * | 传 | 回 |
 * | --- | --- |
 * | 10 | 10 |
 * | 50 / 100 / 200 / 1000 | **全部 20** |
 *
 * 也就是说这里写 50 与写 20 拿到的是同一个东西 —— 而 `--help` 只说了
 * 「不传时默认 10」，没提上限。与 `chat list-all-conversations` 那条
 * （文档说 1000、实际硬顶 100）是同一类文档缺失。
 *
 * ★ 仍然写 20 而不是 50：让这个数字**等于真实行为**。写 50 会让读代码的人
 * 以为一页能拿 50 条，于是"22 场会怎么翻了 2 页"变成一个需要重新实测才能
 * 回答的问题。抽干循环让上限本身不再关键（翻页会补齐），但数字得诚实。
 */
const MINUTES_PAGE_LIMIT = 20

/**
 * 转写最多翻几页。
 *
 * ## ★ 为什么有上限，以及为什么不是上游 help 说的那个数
 *
 * `minutes get transcription --help` 原文：「当用户明确要求查看或分析转写
 * 原文时，应默认拉取全部原文（**自动翻页**）」+「循环拉取累积超过 **12000
 * 字符**时，应暂停并**询问用户**是否继续」。
 *
 * 那 12000 是给**交互式 agent** 的建议（它可以问人）。我们是后台采集，
 * 没有人可问 —— 所以必须自己定一个硬上限，而定在 12000 等于把一场会议
 * 砍成开头**半页**（实测单页就有 26000 字符）。
 *
 * ## ★★ 40 页是按实测规模定的，不是猜的
 *
 * 2026-08-09 实测三场长会（开源版 v1.0.57）：
 *
 * | 时长 | 页数 | 段数 | 字符数 | 抽干 |
 * | --- | --- | --- | --- | --- |
 * | 106 分钟 | 18 | 859 | 464k | ✓ |
 * | 138 分钟 | 21 | 1021 | 551k | ✓ |
 * | 343 分钟 | ≥25 | ≥1250 | ≥648k | 探针自己的上限截断，未知 |
 *
 * 每页**恒 50 段**（最后一页不足）。所以页数 ≈ 会议时长 / 6 分钟。
 * 40 页覆盖得下约 4 小时的会；更长的会被截断，而那时 `hasNext` 留 true
 * 让它可见（第三场那种 343 分钟的马拉松会就落在这里）。
 *
 * 上一版写 20 页 —— 那会让实测的三场会里**两场**被砍掉。
 */
const MAX_TRANSCRIPT_PAGES = 40

/**
 * 转写的字符预算。撞到就停，并把 `hasNext` 保持为 true（截断可见）。
 *
 * ## ★★ 1.2M 而不是 200k —— 上一版那个数与页数上限**互相矛盾**
 *
 * 实测每页恒 50 段 ≈ **26000 字符**（三场会 57 页的均值，方差很小：
 * 23.6k–28.7k）。也就是说 200k 的预算只够 **7-8 页** ——
 * 而页数上限写着 20，那两条永远轮不到页数生效，字符那条会先在第 8 页砍掉。
 * 实测的三场会（18/21/25+ 页）**全部**会被砍掉一半以上。
 *
 * 现在按 `MAX_TRANSCRIPT_PAGES × 单页上界` 定：40 × 30k = 1.2M。
 * 两条上限于是**协调**：正常情况下页数先到（40 页），字符那条只在
 * "单页异常大"时兜底 —— 那正是它该管的事（见下）。
 *
 * ## 为什么两条都要
 *
 * 页数挡住"页很多"，字符挡住"单页极大"。只有页数上限的话，一场响应异常的
 * 会议可能在 40 页里堆出几十 MB 进单个 SQLite 单元格（`transcript_json`
 * 那一列），而那会拖慢每一次读它的查询。
 *
 * ⚠️ 1.2M 字符的 JSON 进单个单元格仍然不小（约 1-2MB）。这是**刻意的
 * 取舍**：完整转写对"这场会谈了什么"有实质价值，而 `minutes` 表只有
 * 几十行。真正的规模问题在 `raw_records`，那边已经不再重复存转写原文
 * （见 `body` 里 rawPayload 的注释）。
 */
const MAX_TRANSCRIPT_CHARS = 1_200_000

export function createDingTalkMinutes(cli: Pick<DwsCli, "json">): ChannelMinutes {
  return {
    async list(spec = {}) {
      // scope `all` 写死：见文件头（裸 list 静默返回残缺数据）。
      const args = ["minutes", "list", "all", "--limit", String(spec.limit ?? MINUTES_PAGE_LIMIT)]
      // ★ 分页 flag 实测叫 `--cursor`（不是 --next-token），首页留空。
      if (spec.cursor !== undefined && spec.cursor !== null && spec.cursor !== "") {
        args.push("--cursor", spec.cursor)
      }
      /**
       * ★★ 时间窗：这是**范围合规**的落点，不是优化。
       *
       * 从前这条命令只取首页，于是"采得太少"这个 bug 顺带掩盖了另一件事：
       * 听记采集**完全不看**用户在引导里选的时间范围。一旦开始抽干历史，
       * 不收窄就会把用户明确排除掉的时间段整段采回来 ——
       * 按 CLAUDE.md 第 5 节那是隐私问题，不是"多采点没坏处"。
       *
       * ★ 格式必须是 **ISO-8601 带偏移**（`--help` 示例：
       * `--start "2026-03-01T00:00:00+08:00"`），所以用 `formatDwsIsoTime`
       * 而**不是** `formatDwsLocalTime` —— 后者产出的是 `chat message
       * list-all` 要的那种不带时区的 naive 串（见 time.ts 文件头对两者的
       * 区分）。喂错的表现是时间窗偏 8 小时，而且不报错。
       *
       * ## ★★ 实测确认它**真的过滤**，且不破坏分页（2026-08-09，v1.0.57）
       *
       * 这一条曾经只是"照 --help 写的"，没有实测 —— 而这个仓库里
       * 「文档说能翻页、实际恒返回首页」已经出过一次
       * （`chat list-all-conversations` 的 `--cursor`）。所以专门验了两件事：
       *
       * | 窗 | 回 | 窗外条数 |
       * | --- | --- | --- |
       * | 近 7 天 | 1 条 | **0** |
       * | 近 90 天 | 12 条 | **0** |
       * | 8-14 天前（历史区间） | 1 条 | **0** |
       *
       * 「窗外条数 0」是关键判据：它证明 `--start/--end` 是真过滤而不是
       * 被忽略的装饰参数（被忽略时会返回全部 22 条，其中大部分在窗外）。
       *
       * 而带窗翻页（近 365 天 + `--limit 10`）实测 10 + 10 + 5 三页正常收尾、
       * `hasMore` 诚实、每页都是新数据 —— 时间窗与分页**可以同时用**。
       */
      if (spec.since !== undefined && spec.since !== null) {
        args.push("--start", formatDwsIsoTime(spec.since))
      }
      if (spec.until !== undefined && spec.until !== null) {
        args.push("--end", formatDwsIsoTime(spec.until))
      }
      const payload = await cli.json<unknown>(
        args,
        spec.signal === undefined ? {} : { signal: spec.signal },
      )
      return { page: parseMinutesList(payload), rawPayload: JSON.stringify(payload) }
    },

    async body(externalId, signal) {
      const options = signal === undefined ? {} : { signal }
      const summaryPayload = await cli.json<unknown>(
        ["minutes", "get", "summary", "--id", externalId],
        options,
      )

      /**
       * ★★ 转写**抽干分页**。
       *
       * ## 从前只取第一页，而那是真实的数据缺失
       *
       * 原注释的取舍是「摘要已覆盖『这场会谈了什么』，逐句转写主要用于精确
       * 引用，全量留给用户点开时按需拉」。但那个"按需拉"的入口**从来没有
       * 实现过**（grep 全仓：没有任何地方会为单场会议补拉后续页），
       * 所以实际效果是一场长会永久只有开头那一段。
       *
       * 而上游是支持的：`--cursor` + 响应的 `hasNext`/`nextToken`
       * （`--help` 甚至写着"应默认拉取全部原文（自动翻页）"）。
       *
       * ## 合并成一页存，而不是存成页数组
       *
       * kl-graph 的 `minutes_loader.py` 拿到多页之后本来就是按 `page_index`
       * 排序再 `"\n".join` 拼成一整段才切 chunk —— 也就是说**合并存与分页存
       * 在图谱侧的结果完全一致**。合并让导出侧零改动（`page_index` 恒 0），
       * 老数据的形状也不变（同样是 `{hasNext, paragraphList}`）。
       *
       * ## ★ `hasNext` 的语义被保住了，所以截断仍然可见
       *
       * 抽干成功 → `hasNext: false`；撞了我们的上限 → `hasNext: true`。
       * 导出侧把它转成 `has_next`（`export-materializer` 那段注释解释了
       * 为什么这个标记必须在数据里：下游会把它当完整转写用，
       * 于是"会议里没提过 X"这类结论会是错的）。
       *
       * ## 三个停止条件，缺一个就是一类病态
       *
       * · `hasNext !== true` —— 正常抽干完；
       * · 页数 / 字符预算 —— 见两个常量的注释；
       * · **`nextToken` 没前进** —— 服务端回同一个游标时不停会原地打转，
       *   把预算烧光换回同一页数据（`conversations.ts` 的群列表循环
       *   踩过同一个坑，那里也有这条守卫）。
       */
      const paragraphs: unknown[] = []
      let cursor: string | null = null
      let pages = 0
      let hasNext = false
      let chars = 0

      while (pages < MAX_TRANSCRIPT_PAGES) {
        const args = ["minutes", "get", "transcription", "--id", externalId]
        if (cursor !== null) args.push("--cursor", cursor)
        const payload = await cli.json<unknown>(args, options)
        const page = parseMinutesTranscriptionPage(payload)
        pages += 1
        paragraphs.push(...page.paragraphs)
        chars += JSON.stringify(page.paragraphs).length
        hasNext = page.hasNext

        if (!page.hasNext) break
        // 服务端说还有，但没给游标 → 翻不动。`hasNext` 留 true（确实没抽干）。
        if (page.nextToken === null) break
        // 游标没前进 → 停，否则下一轮参数完全相同，必然死循环。
        if (page.nextToken === cursor) break
        // 撞字符预算：`hasNext` 此刻是 true，截断因此可见。
        if (chars >= MAX_TRANSCRIPT_CHARS) break
        cursor = page.nextToken
      }

      /**
       * ★ 调用成功但一个段落都没有 → **仍然存一个空壳**（不是 null）。
       *
       * 这里刻意不写成 `paragraphs.length === 0 ? null : ...`，因为
       * `listMissingBody` 靠 `transcript_json IS NULL` 挑工作队列：
       * 存 null 会让这场会议**每轮都被重新取一遍**，而结果永远是空。
       * 存空壳 = 一个终态，语义是「这场会没有转写」（会议没开录音等）。
       *
       * ⚠️ 已知的模糊之处：**「真的没有转写」与「上游响应形状变了」在这里
       * 长得一样** —— 两者都让 `parseMinutesTranscriptionPage` 返回空。
       * 我们分辨不了（命令是成功的：失败会由 `DwsCli.run` 抛出）。
       * 拿 `pages`/`paragraphs.length` 落库正是为了让后者可被发现：
       * 一批会议突然全部 `paragraphList: []` 是形状变了的信号，
       * 而单场空是正常的。
       *
       * `pages` 恒 ≥ 1（循环至少跑一轮），所以这里没有"一页都没取到"的分支
       * —— 首版写过一个 `pages === 0 ? null` 的判断，那是永远不成立的死代码。
       */
      const transcriptJson = JSON.stringify({ hasNext, pages, paragraphList: paragraphs })

      return {
        summaryText: parseMinutesSummary(summaryPayload),
        transcriptJson,
        transcriptPages: pages,
        // 撞上限没抽干 —— 状态页据此显示"有几场会的转写不完整"
        transcriptTruncated: hasNext,
        /**
         * ★ `rawPayload` 只留**摘要**的原始响应 + 转写的抽干统计，
         * 不再留每一页转写的原文。
         *
         * 从前它存的是单页转写的整段原文（实测一页约 26KB）。抽干之后
         * 一场两小时的会有 18-21 页 / **约 50 万字符**，让这一行
         * `raw_records.payload` 达到 0.5-1MB —— 而它与 `transcript_json`
         * 里存的是**同一份内容**。为"可重放"付两倍存储不值得
         * （重放解析 bug 需要的是形状，而形状已经在 transcript_json 里）。
         */
        rawPayload: JSON.stringify({
          summary: summaryPayload,
          transcription: { pages, hasNext, paragraphs: paragraphs.length },
        }),
      }
    },
  }
}
