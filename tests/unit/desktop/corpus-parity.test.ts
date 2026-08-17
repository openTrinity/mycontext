/**
 * 语料口径**同一份定义**：kl-graph 与 forge 共用 `CORPUS_MESSAGE_PREDICATE`。
 *
 * ## 用户原话
 *
 * 「或许 kl-graph 和 forge 的语料都可以合并」
 *
 * ## 上一版我给的是"检测漂移"，这一版是"让漂移不可能"
 *
 * 上一版这个文件断言两侧**各自**含有那几条 SQL —— 那只能在漂移**发生之后**
 * 报出来（发现总在造成不一致之后）。而且它当时没发现两侧**判据本身就不同**：
 *
 * · kl：`content_text <> ''`
 * · forge：`trim(content_text) <> ''`
 *
 * 实测（SQLite，样本 `null` / `''` / `"   "` / `"\n\t "` / 真内容）：
 * kl 选中 3 条、forge 选中 2 条 —— 纯空白消息在图谱侧被收、语料侧被丢。
 *
 * ★ 本机真库上这个分歧**影响 0 行**（37180 条，三种谓词选中数相同），
 * 所以它是**潜在**不一致而非已发生的。修的是判据来源，不需要数据修复。
 * ★★ 还发现两侧**都**不完整：SQLite 的 `trim(x)` 只去空格、不去 `\n`/`\t`，
 * 所以 forge 那句也放过只含换行的消息 —— 合并后的谓词显式给了字符集。
 *
 * 现在两侧都拼同一个导出常量，所以判据只有一处定义。这个文件的断言
 * 因此从"两边字符串一样吗"变成"**两边用的是那个常量吗**" + 谓词的**行为**。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import Database from "better-sqlite3"
import { CORPUS_MESSAGE_PREDICATE, corpusMessagePredicate } from "@mycontext/store"

const MATERIALIZER = "packages/knowledge-feed/src/export-materializer.ts"
const MESSAGES_REPO = "packages/store/src/repositories/messages.ts"
const FEED_SERVICE = "apps/desktop/src/main/services/feed.service.ts"
const FORGE_SERVICE = "apps/desktop/src/main/services/forge.service.ts"

/** 剥注释 —— 否则"搜到字符串"可能命中的是解释这条规则的注释。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

describe("语料谓词：两侧共用同一份定义", () => {
  it("★★★ 两侧都拼 CORPUS_MESSAGE_PREDICATE，而不是各写一遍", () => {
    /**
     * 反证：把任一侧改回手写 SQL（例如 kl 侧写回
     * `"content_text IS NOT NULL", "content_text <> ''"`）→ 这条转红。
     *
     * 这与上一版的关键差别：上一版断言"含有那几条 SQL"，所以手写与共用
     * 都能通过 —— 于是那处 trim 分歧一直没被发现。
     */
    const materializer = stripComments(readFileSync(MATERIALIZER, "utf8"))
    const repo = stripComments(readFileSync(MESSAGES_REPO, "utf8"))
    expect(materializer).toContain("CORPUS_MESSAGE_PREDICATE")
    expect(repo).toContain("CORPUS_MESSAGE_PREDICATE")
  })

  it("★★★ 语料查询里不许再手写空正文 / agent 判据", () => {
    /**
     * 光断言"用了常量"不够：有人可能**同时**用常量又加一条手写的
     * `content_text <> ''`（看起来更保险，实际就是第二个判据源）。
     *
     * ★ 判据落在**语料查询那一段**里，而不是整个文件：
     * `listMentionBackfillCandidates` 有一条 `m.content_text IS NOT NULL`，
     * 那是 @ 回填（它要的是任何含 @ 的消息，**不是**语料），不该被这条管。
     */
    const materializer = stripComments(readFileSync(MATERIALIZER, "utf8"))
    const readMessagesAt = materializer.indexOf("private readMessages(")
    expect(readMessagesAt).toBeGreaterThan(0)
    const messageQuery = materializer.slice(readMessagesAt, readMessagesAt + 1400)
    expect(messageQuery).toContain("CORPUS_MESSAGE_PREDICATE")
    expect(messageQuery.includes("content_text <> ''")).toBe(false)
    expect(messageQuery.includes("origin <> 'agent'")).toBe(false)
  })

  it("★★★ 谓词对纯空白消息：排除（这就是那次真实分歧）", () => {
    /**
     * 拿真 SQLite 跑一遍 —— 断言**行为**而不是字符串。
     *
     * 反证：把常量里的 `trim(content_text)` 改回 `content_text` → 这条转红
     * （纯空白会被选中，就是修复前 kl 侧的行为）。
     */
    const db = new Database(":memory:")
    db.exec(
      "CREATE TABLE messages (content_text TEXT, origin TEXT NOT NULL DEFAULT 'human'," +
        " learning_eligible INTEGER)",
    )
    const insert = db.prepare(
      "INSERT INTO messages (content_text, origin, learning_eligible) VALUES (?, ?, ?)",
    )
    insert.run(null, "human", 1)
    insert.run("", "human", 1)
    insert.run("   ", "human", 1)
    insert.run("\n\t ", "human", 1)
    insert.run("真内容", "human", 1)
    insert.run("数字人说的", "agent", 1) // 要被排除
    const rows = db
      .prepare(`SELECT content_text FROM messages WHERE ${CORPUS_MESSAGE_PREDICATE}`)
      .all() as { content_text: string | null }[]
    expect(rows.map((row) => row.content_text)).toEqual(["真内容"])
    db.close()
  })

  /**
   * ── ★★★ v4 §5.4 的 B 位：**学习范围的资格闸就在这个谓词里** ────────
   *
   * DWD 只打标不筛行之后，越界的消息**照样在 `messages` 里**。而这两个
   * 消费者（`graph-export` 的物化 / `forge pull`）的输入是**整张表** ——
   * 它们那一趟压根不看 changelog 的内容，所以 changelog 上的
   * `eligibility` 过滤对它们**完全无效**。
   *
   * 漏掉这里的后果：`learning_eligible = 0` 的行被写进四件套 → 进图谱
   * → 进画像。**那是超范围，而且不报错。**
   */
  it("★★★ `learning_eligible = 0` 的消息被排除（越界内容不进图谱/画像）", () => {
    const db = new Database(":memory:")
    db.exec(
      "CREATE TABLE messages (id TEXT, content_text TEXT," +
        " origin TEXT NOT NULL DEFAULT 'human', learning_eligible INTEGER)",
    )
    const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)")
    insert.run("in", "范围内", "human", 1)
    insert.run("out", "只因监听而入库的", "human", 0)
    const rows = db.prepare(`SELECT id FROM messages WHERE ${CORPUS_MESSAGE_PREDICATE}`).all() as {
      id: string
    }[]
    expect(rows.map((row) => row.id)).toEqual(["in"])
    db.close()
  })

  it("★★★ `NULL`（打标之前的存量行）算**合格** —— 写成 `= 1` 会让存量图谱变空", () => {
    /**
     * 这一条与上一条方向相反，而它才是最容易写错的那个：
     *
     * `learning_eligible = 1` 与 `learning_eligible IS NOT 0` 在 SQL 里
     * 差几个字符，两者对 `1` / `0` 行为相同 —— **只在 NULL 上分岔**。
     * 而存量库里**每一行都是 NULL**（v30 只加列、不回填）。
     *
     * 于是写成 `= 1` 的后果是：存量用户下一轮重导得到一份**空**的四件套
     * → 图谱与画像清空。而它不报错、不抛异常，看起来只是"这次没数据"。
     *
     * 反证：把 `corpus-predicate.ts` 里的 `IS NOT 0` 改成 `= 1` → 这条转红。
     */
    const db = new Database(":memory:")
    db.exec(
      "CREATE TABLE messages (id TEXT, content_text TEXT," +
        " origin TEXT NOT NULL DEFAULT 'human', learning_eligible INTEGER)",
    )
    const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)")
    insert.run("legacy", "打标之前入库的", "human", null)
    insert.run("tagged", "打标之后的", "human", 1)
    const rows = db.prepare(`SELECT id FROM messages WHERE ${CORPUS_MESSAGE_PREDICATE}`).all() as {
      id: string
    }[]
    expect(rows.map((row) => row.id)).toEqual(["legacy", "tagged"])
    db.close()
  })

  it("★★ 带别名的版本语义一致（有 JOIN 的查询用它，不用字符串替换）", () => {
    /**
     * 提供 `corpusMessagePredicate(alias)` 而不是让调用方 `replace` ——
     * 字符串替换会把 `content_text` 里的子串也换掉。
     *
     * 反证：把函数实现改成漏加一处前缀 → 带 JOIN 的查询报
     * "ambiguous column name"，这条转红。
     */
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE messages (id TEXT, content_text TEXT, origin TEXT NOT NULL DEFAULT 'human',
        learning_eligible INTEGER);
      -- ★ other 也有同名的 learning_eligible：这样"漏加前缀"会报
      --   ambiguous column name，而不是碰巧还能跑
      CREATE TABLE other (id TEXT, content_text TEXT, origin TEXT, learning_eligible INTEGER);
    `)
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("m1", "真内容", "human", 1)
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("m2", "  ", "human", 1)
    db.prepare("INSERT INTO other VALUES (?, ?, ?, ?)").run("m1", "x", "human", 0)
    const rows = db
      .prepare(
        `SELECT m.id FROM messages m JOIN other o ON o.id = m.id
          WHERE ${corpusMessagePredicate("m")}`,
      )
      .all() as { id: string }[]
    expect(rows.map((row) => row.id)).toEqual(["m1"])
    db.close()
  })

  it("★★★ 范围仍走 readCollectionScope（唯一权威，两侧都经过它）", () => {
    /**
     * 共用谓词只管"哪些消息算语料"，**不含**范围（会话白名单 + 时间窗）——
     * 那是 `readCollectionScope`。两者都必须只有一个来源。
     */
    const feed = readFileSync(FEED_SERVICE, "utf8")
    const forge = readFileSync(FORGE_SERVICE, "utf8")
    expect(feed).toContain("readCollectionScope(db)")
    expect(forge).toContain("readCollectionScope(db)")
  })

  it("★★★ 空白名单在两侧都是「零个会话」而不是「不限」", () => {
    /**
     * 修复前真实存在过的 bug：`allow.length === 0` 被解读成全量，
     * 于是"把聊天源关掉"把**全部**聊天记录导进了知识图谱。
     */
    const feed = readFileSync(FEED_SERVICE, "utf8")
    expect(feed).toContain("if (collection.restricted) scope.conversationExternalIds")
    expect(feed.includes("collection.allow.length === 0 ?")).toBe(false)
  })

  it("★★ 蒸馏声明依赖图谱导出（同一批输入 + 有序消费）", () => {
    /**
     * 口径一致只保证"选的是同一批消息"，不保证**顺序**。蒸馏引用图谱的
     * fact，所以还要求它不跑在图谱前面 —— 那是 `dependsOn` 那道闸
     * （行为测试在 tests/integration/ingest/consumer-dependency.test.ts）。
     */
    const ingest = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    expect(ingest).toContain('dependsOn: ["graph-export"]')
  })
})
