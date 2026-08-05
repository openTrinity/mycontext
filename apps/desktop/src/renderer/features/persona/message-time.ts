/**
 * 消息时间的显示规则。
 *
 * ## 为什么不是一律 `HH:mm`
 *
 * 首版每条都显示 `14:28`。在一个三天没人说话的群里，那个数字读起来像
 * "刚刚"—— 而它可能是上周三的。数字人处理的是"最近的"消息，
 * 而"最近"在不同节奏的会话里完全不是一个意思，所以时间必须**自明**。
 *
 * 规则与钉钉/微信一致（用户已经熟悉这套）：
 * · 今天 → `14:28`
 * · 昨天 → `昨天 14:28`
 * · 今年 → `6月3日 14:28`
 * · 往年 → `2025年6月3日`（往年的具体分钟已经没有意义）
 *
 * ## 为什么是纯函数 + 注入 now
 *
 * "今天"是一个**相对**判断，而它的边界（午夜）正是最容易写错的地方。
 * 注入 `now` 让跨天/跨年/闰年这些边界能被穷举测 ——
 * 用 `Date.now()` 的话这些用例只能在特定日期跑。
 */

/** 日期分隔线上的日期（按天分组用）。 */
export function dayLabel(ms: number, now: number): string {
  const date = new Date(ms)
  const today = new Date(now)
  const days = calendarDaysBetween(date, today)
  if (days === 0) return "今天"
  if (days === 1) return "昨天"
  if (date.getFullYear() === today.getFullYear()) {
    return `${String(date.getMonth() + 1)}月${String(date.getDate())}日`
  }
  return `${String(date.getFullYear())}年${String(date.getMonth() + 1)}月${String(date.getDate())}日`
}

/**
 * 单条消息的时间。
 *
 * 与 `dayLabel` 分开：日期分隔线已经说了"哪一天"，所以同一天的消息
 * 只需要 `HH:mm`。但**引用块**与 hover 提示需要一个自明的完整时间 ——
 * 那时用 `fullLabel`。
 */
export function timeLabel(ms: number, now: number): string {
  const date = new Date(ms)
  const today = new Date(now)
  const days = calendarDaysBetween(date, today)
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 0) return hm
  if (days === 1) return `昨天 ${hm}`
  if (date.getFullYear() === today.getFullYear()) {
    return `${String(date.getMonth() + 1)}月${String(date.getDate())}日 ${hm}`
  }
  /**
   * 往年**不显示分钟**。
   *
   * "2025年6月3日 14:28" 里的分钟对用户没有任何用（他不会去核对
   * 一年前某条消息的具体分钟），而它让这一行长了 6 个字符 ——
   * 在一个本来就窄的时间位上，那 6 个字符会挤掉别的信息。
   */
  return `${String(date.getFullYear())}年${String(date.getMonth() + 1)}月${String(date.getDate())}日`
}

/** 完整时间（hover 提示用）。任何情况下都自明。 */
export function fullLabel(ms: number): string {
  const date = new Date(ms)
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/**
 * 侧栏那一列的时间 —— 比 `timeLabel` 更短。
 *
 * ## ★ 为什么不能复用 `timeLabel`
 *
 * 侧栏每行的时间挤在名字右边，可用宽度约 40px。而 `timeLabel` 在
 * "今年但不是昨天"那一档给的是 `6月3日 14:28`（10 个字符）——
 * 它会把会话名挤掉一半，而名字比精确到分钟重要得多。
 *
 * 所以这一档只给日期，规则与钉钉/微信侧栏一致（用户已经熟悉）：
 * · 今天 → `14:28`
 * · 昨天 → `昨天`
 * · 今年 → `6/3`
 * · 往年 → `2025/6/3`
 *
 * ★ 用 `/` 而不是 `月日`：`6/3` 是 3 个字符而 `6月3日` 是 4 个（中文字更宽），
 * 在这个宽度上那是显示得下与显示不下的差别。
 *
 * `now` 默认取当前时间：侧栏不需要注入（它不做跨天边界的断言，
 * 而那些边界规则已经在 `calendarDaysBetween` 里测过了）。
 */
export function formatRailTime(ms: number, now: number = Date.now()): string {
  const date = new Date(ms)
  const today = new Date(now)
  const days = calendarDaysBetween(date, today)
  if (days === 0) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 1) return "昨天"
  if (date.getFullYear() === today.getFullYear()) {
    return `${String(date.getMonth() + 1)}/${String(date.getDate())}`
  }
  return `${String(date.getFullYear())}/${String(date.getMonth() + 1)}/${String(date.getDate())}`
}

/** 按天分组的 key（同一天的消息归一组）。用本地日期，不是 UTC。 */
export function dayKey(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/**
 * 相差几个**日历日**（不是 24 小时的整数倍）。
 *
 * ★ 这个区别是这个文件里最容易写错的地方：
 * 23:59 与次日 00:01 只差 2 分钟，但它们是**两天** ——
 * 用 `(a - b) / 86400000` 会算出 0，于是次日凌晨的消息显示成"今天"。
 *
 * 所以先把两个时间各自归零到当天 00:00 再比。
 */
function calendarDaysBetween(earlier: Date, later: Date): number {
  const a = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate()).getTime()
  const b = new Date(later.getFullYear(), later.getMonth(), later.getDate()).getTime()
  /**
   * 用 `Math.round` 而不是 `floor`：夏令时切换的那两天里，两个午夜之间
   * 相差 23 或 25 小时，`floor` 会把 25 小时算成 1 天（对）但把
   * 23 小时算成 0 天（错 —— 那明明是昨天）。
   */
  return Math.round((b - a) / 86_400_000)
}
