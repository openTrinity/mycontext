/**
 * 中文分词：写入侧 bigram 切分。
 *
 * ## 为什么必须自己切（这是 P0，不是优化）
 *
 * 实测（SQLite 3.53.2）：
 * · `tokenize='unicode61'` 存「沙箱环境部署完成了」后 `MATCH '沙箱'` 命中 **0**
 *   —— unicode61 不切 CJK，整句被当成**一个 token**。
 * · `tokenize='trigram'` 下 `MATCH '沙箱环'` 命中，但 `MATCH '沙箱'` 仍为 0
 *   （trigram 要求 ≥3 字符）。而中文两字词（沙箱/部署/发布/上线）
 *   恰恰是搜索里最高频的形态。
 *
 * 切成「单字 + 相邻二字」后，`沙箱`/`环境`/`部署`/`沙箱环境` 全部命中。
 *
 * ## 为什么单字也要留
 *
 * 只存 bigram 的话，单字查询（「谁」「钱」「bug」）会完全搜不到。
 * 单字召回偏多是可接受的 —— 靠向量与 RRF 融合排序收敛，
 * 而「搜不到」是没法靠排序补救的。
 *
 * ## 英文与数字
 *
 * ASCII 词按空白/标点切分后**原样保留**（不 bigram 化）：
 * 英文本来就有词边界，切成 bigram 只会让 `deploy` 匹配上 `epl` 这种噪音。
 */

/** CJK 统一汉字 + 扩展 A + 兼容 + 假名 + 谚文：这些是需要 bigram 的字符。 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/

/**
 * ASCII 词字符：字母数字下划线连字符
 * （保留连字符是为了 `k8s-prod` 这类标识不被切碎）。
 *
 * 逐字符判定而不是整词正则：`tokenize` 单趟按位置扫描，
 * 这样 ASCII 与 CJK 的 token 顺序才能与原文一致（见 tokenize 的注释）。
 */
const ASCII_WORD_CHAR = /[A-Za-z0-9_+#.-]/

function isCjk(char: string): boolean {
  return CJK.test(char)
}

/**
 * 把一段文本切成可检索的 token 列表。
 *
 * 同一个函数用于**写入与查询**：两侧不一致（比如查询侧忘了 bigram）
 * 会让检索静默失效 —— 存进去的是 `沙 沙箱 箱`，查的是 `沙箱环境`，
 * 一个都对不上，而这看起来只是"搜不到结果"。
 *
 * ## token 顺序与原文一致
 *
 * 首版分两趟走（先摘所有 ASCII 词、再走 CJK），于是 `"修复bug了"`
 * 得到 `["bug","修","修复","复","了"]` —— ASCII 被提到了最前面。
 * 当前用 AND 组合查询，顺序不影响结果；但 FTS5 的 `NEAR` / phrase 查询
 * **依赖 token 位置**，那时错序会静默给出错误结果。
 * 所以这里改成**单趟按位置扫描**：现在没成本，将来不埋坑。
 */
export function tokenize(text: string): string[] {
  if (text === "") return []
  const tokens: string[] = []

  // CJK 片段的缓冲：只在片段内部做二字组合 —— 跨标点组合
  // （「好，的」→「好的」）会造出原文根本没出现过的词，那是假召回。
  let run: string[] = []
  const flushCjk = (): void => {
    for (let index = 0; index < run.length; index += 1) {
      const char = run[index]
      if (char !== undefined) tokens.push(char)
      const next = run[index + 1]
      if (char !== undefined && next !== undefined) tokens.push(char + next)
    }
    run = []
  }

  // ASCII 词的缓冲：英文本来就有词边界，原样保留（小写化，让检索大小写无关），
  // 不 bigram 化 —— 否则 `deploy` 会匹配上 `epl` 这种噪音。
  let word = ""
  const flushWord = (): void => {
    if (word !== "") {
      tokens.push(word.toLowerCase())
      word = ""
    }
  }

  // ★ 单趟扫描：遇到类型切换就把另一种的缓冲吐出去，
  // 这样 token 的相对顺序与原文严格一致。
  for (const char of text) {
    if (isCjk(char)) {
      flushWord()
      run.push(char)
      continue
    }
    if (ASCII_WORD_CHAR.test(char)) {
      flushCjk()
      word += char
      continue
    }
    // 分隔符（空白 / 标点）：两种缓冲都收尾
    flushWord()
    flushCjk()
  }
  flushWord()
  flushCjk()

  return tokens
}

/**
 * 写入侧：把原文变成存进 FTS `seg` 列的串。
 *
 * 存的**不是原文**：contentless 表不保存内容，snippet 要从
 * `messages.content_text` 取原句（用户看到的必须是原文，不是 bigram 串）。
 * 去重是为了体积 —— 重复 token 对 FTS 的命中没有帮助，只让索引更大。
 */
export function toIndexSegment(text: string): string {
  return [...new Set(tokenize(text))].join(" ")
}

/**
 * 查询侧：把用户输入切成 token 列表。
 *
 * 与写入用同一个 `tokenize`，只是不去重也不拼串 ——
 * 调用方（`match-expr`）需要逐 token 转义后用 AND 组合。
 */
export function toQueryTokens(query: string): string[] {
  return [...new Set(tokenize(query))]
}

/**
 * 查询侧：给出**从严到宽**的两档 token 列表。
 *
 * ## ★ 为什么需要放宽档（跨词召回缺口）
 *
 * `tokenize` 在连续 CJK 片段内部做二字组合，于是查询里会出现**跨词边界**的
 * bigram —— 而那个 bigram 在原文里不存在。实测原文「沙箱环境部署完成了」：
 *
 * | 查询 | 严格档（全部 token AND） | 说明 |
 * | --- | --- | --- |
 * | `沙箱环境` | 1 命中 | 词序与原文一致 |
 * | `部署沙箱` | **0 命中** | 查询含 `署沙`，原文没有 |
 * | `完成部署` | **0 命中** | 查询含 `成部`，原文没有 |
 * | `部署 沙箱` | 1 命中 | 用户手动加了空格 |
 *
 * 也就是说**换个词序就搜不到**，用户得自己加空格 —— 而没人会这么做。
 * 这不是精度问题，是「明明有却找不到」。
 *
 * ## 两档而不是直接放宽
 *
 * 直接只用单字 AND 会掉精度（查「沙箱」会命中"沙滩上的箱子"）。
 * 所以：**先跑严格档，只有它返回空时才跑放宽档**。
 * 常见查询（词序与原文一致）走严格档，精度不变；
 * 换词序的查询原本是 0 结果，放宽后至少能召回 —— 没有变坏的情况。
 *
 * @returns `[严格档, 放宽档]`；两档相同时只返回一档（避免重复查询）。
 *   放宽档 = 去掉 CJK bigram，只留单字与 ASCII 词
 *   （ASCII 词永远保留：英文本来就有词边界，放宽它没有意义）。
 */
export function toQueryTokenTiers(query: string): string[][] {
  const strict = [...new Set(tokenize(query))]
  if (strict.length === 0) return []

  // CJK bigram = 长度 2 且两个字符都是 CJK。单字与 ASCII 词都要留。
  const relaxed = strict.filter(
    (token) => !(token.length === 2 && isCjk(token[0] ?? "") && isCjk(token[1] ?? "")),
  )

  if (relaxed.length === 0 || relaxed.length === strict.length) return [strict]
  return [strict, relaxed]
}
