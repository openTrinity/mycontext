/**
 * 渠道时间格式的解析与格式化。
 *
 * ## 为什么不能用 `new Date(str)`
 *
 * DWS 的 `createTime` 是「2026-07-28 10:53:49」这种**不带时区**的本地时间串。
 * `new Date(str)` 会按**运行机器**的时区解析：开发机在 +08 看不出问题，
 * CI 在 UTC 上同一条消息就偏 8 小时 —— 而这个 bug 在开发机上永远不会暴露。
 * 更糟的是它会让同一份数据在不同机器上落成不同时间戳，时间线永久错乱。
 *
 * 所以显式按渠道的固定偏移解析，不依赖运行环境 TZ。
 *
 * ## 为什么要成对提供反向格式化
 *
 * `chat message list-all` 的 `--start/--end` **要求同样格式回传**（实测必填）。
 * 只有解析没有格式化的话，调用方会自己拼 —— 大概率用 `toLocaleString()`，
 * 那又把时区依赖引回来了。成对提供 + 测往返一致性才闭合。
 *
 * ## 渠道差异
 *
 * 偏移与格式是**按渠道注入**的（`ChannelTimeSpec`），不是全局常量：
 * 飞书的 API 返回 unix 秒，只需乘 1000；换渠道时不该改解析器。
 */
import { AppError } from "@mycontext/kernel"

export interface ChannelTimeSpec {
  /**
   * 无时区时间串对应的 UTC 偏移（分钟）。
   * 钉钉的企业环境固定 +08:00 → 480。
   */
  offsetMinutes: number
}

/** 钉钉：企业时区固定 +08:00。 */
export const DINGTALK_TIME_SPEC: ChannelTimeSpec = { offsetMinutes: 8 * 60 }

const LOCAL_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/

/**
 * 「yyyy-MM-dd HH:mm:ss」→ unix ms。
 *
 * 用 `Date.UTC` 再减偏移，而不是 `new Date(y, m, d, ...)` ——
 * 后者用的是运行环境时区，正是我们要避开的东西。
 */
export function parseLocalTime(value: string, spec: ChannelTimeSpec): number {
  const match = LOCAL_TIME_PATTERN.exec(value.trim())
  if (match === null) {
    throw new AppError("PARSE_FAILED", `无法解析时间串：${value}`, {
      messageKey: "errors:byCode.PARSE_FAILED",
      context: { value },
    })
  }
  const [, year, month, day, hour, minute, second] = match
  return (
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ) -
    spec.offsetMinutes * 60_000
  )
}

/**
 * unix ms → 「yyyy-MM-dd HH:mm:ss」。
 *
 * 手工格式化 UTC 分量而不是 `toLocaleString()`：后者的输出格式依赖
 * 运行环境的 locale（有的环境给「2026/7/28 上午10:53:49」），
 * 而这个串是要**回传给外部命令**的，格式错了会被拒。
 */
export function formatLocalTime(ms: number, spec: ChannelTimeSpec): string {
  const shifted = new Date(ms + spec.offsetMinutes * 60_000)
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0")
  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  )
}

/** 钉钉专用的便捷包装（调用点最多，避免每处都传 spec）。 */
export function parseDwsLocalTime(value: string): number {
  return parseLocalTime(value, DINGTALK_TIME_SPEC)
}

export function formatDwsLocalTime(ms: number): string {
  return formatLocalTime(ms, DINGTALK_TIME_SPEC)
}

/**
 * unix ms →「yyyy-MM-ddTHH:mm:ss+08:00」（ISO-8601 **带偏移**）。
 *
 * ## 为什么需要这个而不是复用 `formatLocalTime`
 *
 * 那个函数产出的是 **DWS 的线上格式**（`--start` / `--end` 要求同形），
 * 不能改 —— 但它是**不带时区的**，也就是说这个串本身**有歧义**：
 * 拿到它的人只能猜时区。实测他们的 `to_unix_ms` 就把 naive 串当成 **UTC**：
 *
 * | 输入 | 他们解析出 | 真值（+08 的 10:53:49） |
 * | --- | --- | --- |
 * | `"2026-07-28 10:53:49"` | 1785236029000 | 1785207229000 |
 * | `"2026-07-28T10:53:49+08:00"` | 1785207229000 | 1785207229000 |
 *
 * 差 **8 小时**，而且**不报错** —— 图谱的时间维度整体平移，
 * timeline 与社区演化跟着错，没有任何一处会红。
 *
 * 修法不是去改他们的 loader（改不改是他们的事），而是**别给有歧义的串**：
 * 带上偏移，同一个函数就能解析对。这是"把正确性放进数据"而不是
 * "依赖对方按我们的假设解释数据"。
 */
export function formatIsoWithOffset(ms: number, spec: ChannelTimeSpec): string {
  const naive = formatLocalTime(ms, spec).replace(" ", "T")
  const total = spec.offsetMinutes
  const sign = total < 0 ? "-" : "+"
  const abs = Math.abs(total)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${naive}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 钉钉专用包装。导出给外部消费者的时间一律走这个（见上）。 */
export function formatDwsIsoTime(ms: number): string {
  return formatIsoWithOffset(ms, DINGTALK_TIME_SPEC)
}

/**
 * 已经是 unix 值的字段（`lastMsgCreateAt` 等）。
 *
 * 秒与毫秒都可能出现，靠数量级判断：2001-09-09 之后的秒级时间戳 > 1e9，
 * 而毫秒级 > 1e12。取 1e11 作为分界既不会把 1970 年代的毫秒值误判，
 * 也不会把 5138 年的秒值误判 —— 两者都不在我们的取值范围内。
 */
export function normalizeUnix(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError("PARSE_FAILED", `不是有效的时间戳：${value}`, {
      messageKey: "errors:byCode.PARSE_FAILED",
      context: { value },
    })
  }
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
}
