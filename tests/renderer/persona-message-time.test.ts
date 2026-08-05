/**
 * 智能时间显示的门禁。
 *
 * ## 为什么这个纯函数值得穷举测
 *
 * 它要回答的是"这条消息是什么时候的"，而**错了不会报错** ——
 * 只是把上周三的消息显示成"14:28"，读起来像刚刚。数字人处理的是
 * "最近的"消息，而这个判断直接影响用户对"最近"的理解。
 *
 * ## ★ 两条边界是这里的全部难点
 *
 * 1. **午夜**：23:59 与次日 00:01 只差 2 分钟，但它们是**两天**。
 *    用 `(a - b) / 86400000` 会算出 0 → 次日凌晨的消息显示成"今天"。
 * 2. **跨年**：12月31日 与 1月1日 差 1 天，但年份不同 ——
 *    "昨天"仍然对（用户就是那么说的），而再往前一天要显示年份。
 */
import { describe, expect, it } from "vitest"
import { dayKey, dayLabel, fullLabel, timeLabel } from "@renderer/features/persona/message-time"

/** 2026-07-30 15:00 周四。 */
const NOW = new Date(2026, 6, 30, 15, 0, 0).getTime()

function at(year: number, month: number, day: number, hour = 14, minute = 28): number {
  return new Date(year, month - 1, day, hour, minute, 0).getTime()
}

describe("★ 单条消息的时间", () => {
  it("今天 → 只有 HH:mm（日期分隔线已经说了哪一天）", () => {
    expect(timeLabel(at(2026, 7, 30, 9, 5), NOW)).toBe("09:05")
  })

  it("昨天 → 带「昨天」", () => {
    expect(timeLabel(at(2026, 7, 29), NOW)).toBe("昨天 14:28")
  })

  it("今年更早 → 月日 + 时间", () => {
    expect(timeLabel(at(2026, 6, 3), NOW)).toBe("6月3日 14:28")
  })

  it("★ 往年 → 带年份，且**不显示分钟**", () => {
    /**
     * 一年前某条消息的具体分钟对用户没有用，而它让这一行长 6 个字符 ——
     * 在本来就窄的时间位上会挤掉别的信息。
     */
    expect(timeLabel(at(2025, 6, 3), NOW)).toBe("2025年6月3日")
  })

  it("★ 午夜边界：23:59 与次日 00:01 是两天，不是「今天」", () => {
    // 今天凌晨 00:01 → 今天
    expect(timeLabel(at(2026, 7, 30, 0, 1), NOW)).toBe("00:01")
    /**
     * 昨天 23:59 与"现在"只差 15 小时（不到一天），但它是**昨天**。
     * 用毫秒差除以 86400000 会算出 0 → 显示成"23:59"，
     * 读起来像今天凌晨的消息。
     */
    expect(timeLabel(at(2026, 7, 29, 23, 59), NOW)).toBe("昨天 23:59")
  })

  it("★ 跨年的「昨天」仍然是昨天", () => {
    const newYear = new Date(2027, 0, 1, 10, 0, 0).getTime()
    // 2026-12-31 是 2027-01-01 的昨天 —— 尽管年份不同
    expect(timeLabel(at(2026, 12, 31, 22, 0), newYear)).toBe("昨天 22:00")
    // 再往前一天就该显示年份了
    expect(timeLabel(at(2026, 12, 30, 22, 0), newYear)).toBe("2026年12月30日")
  })

  it("闰年 2月29日 不会算错", () => {
    const marchFirst = new Date(2028, 2, 1, 12, 0, 0).getTime()
    // 2028 是闰年，2月29日 存在且是 3月1日 的昨天
    expect(timeLabel(at(2028, 2, 29, 8, 0), marchFirst)).toBe("昨天 08:00")
  })
})

describe("日期分隔线", () => {
  it("今天 / 昨天用词，今年只给月日", () => {
    expect(dayLabel(NOW, NOW)).toBe("今天")
    expect(dayLabel(at(2026, 7, 29), NOW)).toBe("昨天")
    expect(dayLabel(at(2026, 6, 3), NOW)).toBe("6月3日")
  })

  it("往年带年份（不然「6月3日」是哪一年的说不清）", () => {
    expect(dayLabel(at(2025, 6, 3), NOW)).toBe("2025年6月3日")
  })
})

describe("分组 key 与完整时间", () => {
  it("同一天的两条消息 key 相同，跨天不同", () => {
    expect(dayKey(at(2026, 7, 30, 0, 1))).toBe(dayKey(at(2026, 7, 30, 23, 59)))
    expect(dayKey(at(2026, 7, 30, 23, 59))).not.toBe(dayKey(at(2026, 7, 31, 0, 1)))
  })

  it("★ key 用本地日期而不是 UTC（用户说的「今天」是他那个时区的）", () => {
    // 本地 2026-07-30 08:00 在 UTC 是 07-30 00:00（+08）；两者都该是 07-30
    expect(dayKey(at(2026, 7, 30, 8, 0))).toBe("2026-07-30")
  })

  it("完整时间任何情况下都自明（hover 提示用）", () => {
    expect(fullLabel(at(2025, 1, 5, 9, 7))).toBe("2025-01-05 09:07")
  })
})
