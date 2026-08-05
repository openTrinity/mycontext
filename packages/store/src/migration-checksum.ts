/**
 * 迁移 checksum 的两种判据。
 *
 * ## 为什么需要两种
 *
 * 原本只有一种：`sha256(整个 SQL 模板字符串)`。它算进了 SQL 里的 `--` 注释，
 * 于是**改注释就等于改迁移** —— 而这已经打挂过两次开发环境：
 *
 * · v9 的注释里加了一个 `'model'`（步骤列表）；
 * · v2 的注释里有一行示例姓名，被一次全仓脱敏 sweep 换成了化名。
 *
 * 两次都是「schema 一字未改，但每个已迁移的 vault 启动即 DB_MIGRATION_FAILED」。
 * 第一次靠把注释还原成 byte-identical 修掉了，但那条路第二次就走不通：
 * v2 在历史上有**三个**原文变体（本机不同 vault 各记一个），三者互斥，
 * 还原任一版都会打挂另外两个，而且其中两版含真实姓名 —— 脱敏 sweep 正是为了
 * 去掉它们。也就是说「还原成产出 actual 的那一版」在有脱敏冲突时**无解**。
 *
 * 结论是判据本身错了：这道校验想守的不变式是**「schema 没被偷偷改过」**
 * （防止不同机器的库结构 drift），而注释不是 schema。所以：
 *
 * · `schemaChecksum` —— 剥掉注释、折叠空白后再 hash。这是**判据**。
 * · `rawChecksum`    —— 原样 hash。保留它是因为**旧库里记的就是这个值**，
 *                       它仍然是最快的「完全没变」判定路径。
 *
 * 实测：v2 三个变体的 `rawChecksum` 两两不同，而 `schemaChecksum` 完全一致
 * （`ac7ac75f…`）；v9 两个变体同理（`9db81336…`）。且这条不变式在全历史成立
 * —— 39 个历史 blob、23 个 SQL 常量，语义有差异的常量数为 0。
 * 这条由 `scripts/check-migration-checksums.mjs` 持续守着。
 *
 * ## ★ 剥注释必须按词法做，不能用正则
 *
 * 迁移里有 5 处 SQL **字符串字面量内部含 `--`**（`v2` / `v4` / `v5` / `v7`，
 * 形如 `resource TEXT NOT NULL DEFAULT ',     -- '`）。一个
 * `replace(/--.*$/gm, "")` 会把字面量从中间截断，产出**语法不合法**的 SQL ——
 * 而它只在「恰好有这种字面量」的迁移上出错，看起来像随机失败。
 *
 * 所以下面是个小状态机：单引号串、双引号标识符、`[...]` 标识符里的注释符
 * 一律当普通字符。三种都有测试锁住（见 migration-chain.test.ts）。
 */
import { createHash } from "node:crypto"

/**
 * 单趟扫描：剥注释，并按 `normalize` 决定是否同时规范化空白。
 *
 * 规范化必须与剥注释在**同一趟**里做，不能先剥再对结果跑正则 ——
 * 那个正则分不清 `DEFAULT 'a, b'` 里的逗号与 SQL 结构里的逗号，
 * 会把两个**语义不同**的默认值（`'a, b'` / `'a,b'`）算成同一个 hash。
 * 字面量必须原样保留，只有字面量**之外**的空白才是排版。
 */
function scan(sql: string, normalize: boolean): string {
  let out = ""
  let index = 0
  /** 规范化模式下待输出的空白：真正写出去之前先看下一个 token 是什么。 */
  let pendingSpace = false

  /** 自定界符号：两侧的空白纯属排版，去掉不改语义。 */
  const isDelimiter = (char: string | undefined): boolean =>
    char !== undefined && "(),;".includes(char)

  const emit = (text: string): void => {
    if (normalize && pendingSpace) {
      // 前一个 token 与当前 token 之间要不要留一个空格
      if (!isDelimiter(text[0]) && !isDelimiter(out.at(-1))) out += " "
      pendingSpace = false
    }
    out += text
  }

  while (index < sql.length) {
    const char = sql[index]

    // 字符串字面量与引号标识符：整段原样抄过去（内部空白与注释符都不动）。
    if (char === "'" || char === '"' || char === "[") {
      const close = char === "[" ? "]" : char
      let literal = char
      index += 1
      while (index < sql.length) {
        if (sql[index] === close) {
          // `''` / `""` 是转义的引号，不是结束（`[]` 无此语法）。
          if (close !== "]" && sql[index + 1] === close) {
            literal += close + close
            index += 2
            continue
          }
          literal += close
          index += 1
          break
        }
        literal += sql[index]
        index += 1
      }
      emit(literal)
      continue
    }

    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1
      // 注释位置补一个空白而不是直接删：`a --c\nb` 删成 `ab` 会粘成一个 token。
      if (normalize) pendingSpace = true
      else out += "\n"
      continue
    }

    if (char === "/" && sql[index + 1] === "*") {
      index += 2
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1
      index += 2
      if (normalize) pendingSpace = true
      else out += " "
      continue
    }

    if (normalize && char !== undefined && /\s/.test(char)) {
      pendingSpace = true
      index += 1
      continue
    }

    emit(char ?? "")
    index += 1
  }

  return normalize ? out.trim() : out
}

/**
 * 按 SQLite 词法剥掉行注释（`--`）与块注释（斜杠星 … 星斜杠）。
 *
 * 字符串字面量（`'…'`，含 `''` 转义）、引号标识符（`"…"`）与方括号标识符
 * （`[…]`）内部的注释符原样保留 —— 它们不是注释。
 *
 * 注释位置补一个空白（行注释补 `\n`、块注释补空格）而不是直接删：
 * `a --c\nb` 删成 `ab` 会把两个 token 粘成一个。
 */
export function stripSqlComments(sql: string): string {
  return scan(sql, false)
}

/**
 * 剥注释 + 规范化空白。
 *
 * 两件事都要做：只折叠空白不够 —— `CREATE TABLE a (x)` 与
 * `CREATE  TABLE a (\n  x\n)` 折叠后仍差 `( x )` 与 `(x)` 的那几个空格。
 * `( ) , ;` 在 SQL 里是自定界的（两侧空白纯属排版），去掉安全，
 * 于是「重排缩进」这件事真的不改 checksum。
 *
 * 字面量内部的空白**不动**（见 `scan` 的注释）。
 */
function normalizeSql(sql: string): string {
  return scan(sql, true)
}

/**
 * 语义 checksum —— **当前判据**，也是新记录写入的值。
 *
 * 同一个 schema 的不同注释/缩进写法会得到同一个值。
 */
export function schemaChecksum(sql: string): string {
  return createHash("sha256").update(normalizeSql(sql)).digest("hex").slice(0, 32)
}

/**
 * 原文 checksum —— 历史判据，仍是「完全没变」的快速路径。
 *
 * 语义与最初的实现逐字节一致，因此已有库里记的值仍然能直接对上。
 */
export function rawChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 32)
}
