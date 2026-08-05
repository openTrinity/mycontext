/**
 * 钉钉听记（会议转写）的采集。
 *
 * ## 为什么听记是独立一条采集路径，不挂在消息轮询上
 *
 * 三个语义都不一样：
 * · **没有时间窗过滤** —— `minutes list all` 不接受 start/end，只能全量列 + 翻页。
 *   所以「重叠窗口」那套水位机制在这里没有对应物，用不了 IngestScheduler。
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
 * ## 实测的响应形状
 *
 * 信封由 `DwsCli.json` 剥掉（那层还会检查 `errorCode`）。剥完之后：
 *
 * · `list all` → `{hasMore, itemList[], nextToken}`，item 字段：
 *   `uuid, title, startTime, endTime, durationMicros, flashUserInfo{name},
 *    keywordsInfo{keywords[]}, orgId, orgName, shareUrl, liveType`
 * · `get summary` → `{fullSummary}`（markdown，实测 3107 字符，含参与人行）
 * · `get transcription` → `{hasNext, nextToken, paragraphList[]}`，
 *   段落字段 `nickName / paragraph / startTime / endTime / sentenceList[]`
 *
 * 注意 `durationMicros` 的单位是**微秒**（实测 1224340000 ≈ 20.4 分钟），
 * 不是毫秒 —— 当毫秒读会把 20 分钟的会议记成 14 天。
 */
import { normalizeUnix } from "./time.js"
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

/**
 * 每页条数。
 *
 * ★ 实测 `--limit` **默认只有 10** —— 不显式传的话回溯一次只拿 10 条，
 * 而翻页要多花一次 CLI 调用。50 与消息侧的 PAGE_LIMIT 一致。
 */
const MINUTES_PAGE_LIMIT = 50

export function createDingTalkMinutes(cli: Pick<DwsCli, "json">): ChannelMinutes {
  return {
    async list(spec = {}) {
      // scope `all` 写死：见文件头（裸 list 静默返回残缺数据）。
      const args = ["minutes", "list", "all", "--limit", String(spec.limit ?? MINUTES_PAGE_LIMIT)]
      // ★ 分页 flag 实测叫 `--cursor`（不是 --next-token），首页留空。
      if (spec.cursor !== undefined && spec.cursor !== null && spec.cursor !== "") {
        args.push("--cursor", spec.cursor)
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
       * 转写是**分页**的（实测 `hasNext: true` + `nextToken`），但一期只取第一页。
       *
       * 取全量要循环翻页，而单页实测已 27.9KB —— 一场长会可能有几百 KB。
       * 蒸馏与图谱要的是"这场会谈了什么"，`fullSummary` 已经覆盖，
       * 逐句转写主要用于精确引用。一期先把摘要与首页转写落准，
       * 全量转写留给"用户点开某场会议"时按需拉。
       *
       * ★ 这个截断**必须**在数据里可见：只存第一页却不标注，
       * 下游会把它当完整转写用（"会议里没提过 X" 这类结论就会是错的）。
       * 所以把 `hasNext` / `nextToken` 一起存进 transcriptJson。
       */
      const transcriptPayload = await cli.json<unknown>(
        ["minutes", "get", "transcription", "--id", externalId],
        options,
      )

      return {
        summaryText: parseMinutesSummary(summaryPayload),
        transcriptJson:
          transcriptPayload === undefined || transcriptPayload === null
            ? null
            : JSON.stringify(transcriptPayload),
        rawPayload: JSON.stringify({ summary: summaryPayload, transcription: transcriptPayload }),
      }
    },
  }
}
