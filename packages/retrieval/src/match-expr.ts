/**
 * FTS5 MATCH 表达式的安全构造。
 *
 * ## 为什么必须逐 token 转义（这是线上事故级别的问题，不是边缘情况）
 *
 * 实测把用户输入直接拼进 MATCH：
 *   · `环 OR mid:SECRET` → **`no such column: mid`**（抛错 = 500）
 *   · `-沙箱`            → **`no such column: 沙箱`**
 *   · `NEAR(沙 箱)`      → 被当 FTS 语法执行（语义被悄悄改了）
 *   · `环*`              → 变成前缀查询（用户没要求这个）
 *
 * 逐 token 用 `"…"` 包裹（内部 `"` 转成 `""`）后，三条**全部变回普通字面量、
 * 不再报错**（已实测）。用户输入一个 `*` 或 `-` 就 500 是必然会发生的事，
 * 因为这些字符在中文输入法与正常表达里都很常见。
 *
 * ## 单一入口
 *
 * 全仓库构造 MATCH 表达式只允许经过这个函数。理由与「所有子进程都走
 * ProcessRunner」一样：一处漏了就等于没做，而漏的那处只在用户输入特殊字符时才炸。
 */
import { AppError } from "@mycontext/kernel"

/** FTS5 里有语法含义的字符。命中它们时**不是**过滤掉，而是靠引号变成字面量。 */
const FTS_SPECIAL = /["*():^{}\-+]/

/**
 * 把一个 token 转成 FTS5 的字符串字面量。
 *
 * 用双引号包裹 + 内部 `"` 双写 —— 这是 FTS5 唯一的转义机制
 * （它没有反斜杠转义）。
 */
export function quoteToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`
}

/**
 * 把 token 列表组合成 MATCH 表达式。
 *
 * 多个 token 之间用 `AND`：查「沙箱环境」时 bigram 化成
 * `沙 沙箱 箱 箱环 环 环境 境` —— 用 OR 会让任何含「环」的消息都命中，
 * 精度直接归零；用 AND 才是「这些片段都出现过」。
 *
 * @throws AppError(FTS_QUERY_INVALID) 当 token 列表为空。
 *   空表达式在 FTS5 里是语法错误，让它在这里带上明确错误码，
 *   而不是把一个 SqliteError 抛给上层去猜。
 */
export function toMatchExpr(tokens: readonly string[]): string {
  const usable = tokens.filter((token) => token.trim() !== "")
  if (usable.length === 0) {
    throw new AppError("FTS_QUERY_INVALID", "检索词为空，无法构造 MATCH 表达式", {
      messageKey: "errors:byCode.FTS_QUERY_INVALID",
    })
  }
  return usable.map(quoteToken).join(" AND ")
}

/**
 * 判断一个 token 是否含 FTS 语法字符。
 *
 * 只用于诊断/日志（"用户输入里有特殊字符"），**不用于过滤** ——
 * 过滤会悄悄改变用户的查询意图，而引号转义不会。
 */
export function hasSpecialChars(token: string): boolean {
  return FTS_SPECIAL.test(token)
}
