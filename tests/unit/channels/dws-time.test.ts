/**
 * 时间归一的往返测试。
 *
 * 关键是**跨时区一致**：`new Date("2026-07-28 10:53:49")` 在 +08 机器与
 * UTC 机器上会得到相差 8 小时的两个时间戳，而这个 bug 在开发机上永远看不到。
 * 因此这里显式改 `process.env.TZ` 跑同一份 fixture。
 *
 * 往返也必须测：`list-all --start/--end` 要求同格式回传，
 * 只有解析没有格式化时调用方会自己拼（大概率用 toLocaleString），
 * 那又把环境依赖引回来了。
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  DINGTALK_TIME_SPEC,
  formatDwsLocalTime,
  formatLocalTime,
  normalizeUnix,
  parseDwsLocalTime,
  parseLocalTime,
} from "@mycontext/channels"
import { isAppError } from "@mycontext/kernel"

/** 实测样本：这是 `chat message list-all` 真实返回的 createTime 形态。 */
const SAMPLE = "2026-07-28 10:53:49"
/** 手算的期望值：2026-07-28 10:53:49 +08:00 == 2026-07-28T02:53:49Z */
const EXPECTED_MS = Date.parse("2026-07-28T02:53:49.000Z")

const originalTz = process.env["TZ"]

afterEach(() => {
  if (originalTz === undefined) delete process.env["TZ"]
  else process.env["TZ"] = originalTz
})

describe("解析（固定 +08:00，不依赖运行环境）", () => {
  it("样本解析出正确的 unix ms", () => {
    expect(parseDwsLocalTime(SAMPLE)).toBe(EXPECTED_MS)
  })

  it.each(["UTC", "Asia/Shanghai", "America/New_York", "Europe/London"])(
    "TZ=%s 下结果相同",
    (tz) => {
      process.env["TZ"] = tz
      expect(parseDwsLocalTime(SAMPLE)).toBe(EXPECTED_MS)
    },
  )

  it("接受 ISO 风格的 T 分隔", () => {
    expect(parseDwsLocalTime("2026-07-28T10:53:49")).toBe(EXPECTED_MS)
  })

  it("格式不符时抛 PARSE_FAILED（而不是静默返回 0 或 NaN）", () => {
    // 算法侧的同类实现解析失败时 `return 0`，会把消息时间静默置成 1970 ——
    // 图谱上的时间维度直接失真且无人察觉。我们必须抛错。
    for (const bad of ["", "not-a-time", "2026/07/28 10:53:49", "2026-07-28", "20260728105349"]) {
      try {
        parseDwsLocalTime(bad)
        expect.unreachable(`应当抛错：${bad}`)
      } catch (error) {
        expect(isAppError(error)).toBe(true)
        if (isAppError(error)) expect(error.code).toBe("PARSE_FAILED")
      }
    }
  })
})

describe("格式化与往返", () => {
  it("格式化回原串", () => {
    expect(formatDwsLocalTime(EXPECTED_MS)).toBe(SAMPLE)
  })

  it("parse → format → parse 两次 ms 相同", () => {
    const first = parseDwsLocalTime(SAMPLE)
    const formatted = formatDwsLocalTime(first)
    expect(parseDwsLocalTime(formatted)).toBe(first)
  })

  it.each(["UTC", "Asia/Shanghai", "America/New_York"])("TZ=%s 下往返仍闭合", (tz) => {
    process.env["TZ"] = tz
    const ms = parseDwsLocalTime(SAMPLE)
    expect(parseDwsLocalTime(formatDwsLocalTime(ms))).toBe(ms)
    expect(formatDwsLocalTime(ms)).toBe(SAMPLE)
  })

  it("跨年/跨月边界补零正确（外部命令会拒收格式不对的串）", () => {
    const newYear = parseDwsLocalTime("2027-01-01 00:00:00")
    expect(formatDwsLocalTime(newYear)).toBe("2027-01-01 00:00:00")
    const singleDigits = parseDwsLocalTime("2026-03-05 09:08:07")
    expect(formatDwsLocalTime(singleDigits)).toBe("2026-03-05 09:08:07")
  })
})

describe("按渠道注入偏移（换渠道不改解析器）", () => {
  it("同一串在不同偏移下得到不同 ms", () => {
    const utc = parseLocalTime(SAMPLE, { offsetMinutes: 0 })
    const shanghai = parseLocalTime(SAMPLE, DINGTALK_TIME_SPEC)
    expect(utc - shanghai).toBe(8 * 60 * 60 * 1000)
  })

  it("非整小时偏移（如 +05:30）也正确", () => {
    const spec = { offsetMinutes: 5 * 60 + 30 }
    const ms = parseLocalTime(SAMPLE, spec)
    expect(formatLocalTime(ms, spec)).toBe(SAMPLE)
  })
})

describe("已是 unix 值的字段", () => {
  it("毫秒原样保留", () => {
    expect(normalizeUnix(1_785_207_229_147)).toBe(1_785_207_229_147)
  })

  it("秒被放大到毫秒", () => {
    expect(normalizeUnix(1_785_207_229)).toBe(1_785_207_229_000)
  })

  it("非法值抛错而不是产出一个 1970 的时间", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeUnix(bad)).toThrow()
    }
  })
})
