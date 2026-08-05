/**
 * MATCH 表达式转义。
 *
 * 实测未转义时，用户输入直接变成 SQL 错误（也就是 500）：
 *   `环 OR mid:SECRET` → no such column: mid
 *   `-沙箱`            → no such column: 沙箱
 *   `NEAR(沙 箱)`      → 被当 FTS 语法执行
 *   `环*`              → 语义被悄悄改成前缀查询
 *
 * 这不是边缘情况：`*`、`-`、`"`、`:` 在中文输入与正常表达里都很常见。
 * 因此下面的断言重点是「**不抛错**」而不是「返回特定结果」——
 * 特殊字符被当字面量处理后，查不到东西是正常的，查崩了不是。
 */
import { describe, expect, it } from "vitest"
import { hasSpecialChars, quoteToken, toMatchExpr, toQueryTokens } from "@mycontext/retrieval"
import { isAppError } from "@mycontext/kernel"
import { ConversationRepository, FtsIndexRepository, MessageRepository } from "@mycontext/store"
import { toIndexSegment } from "@mycontext/retrieval"
import { openTestVault } from "../../helpers/vault.js"

describe("转义规则", () => {
  it("普通 token 被双引号包裹", () => {
    expect(quoteToken("沙箱")).toBe('"沙箱"')
  })

  it("内部双引号被双写（FTS5 没有反斜杠转义）", () => {
    expect(quoteToken('say "hi"')).toBe('"say ""hi"""')
  })

  it("多 token 用 AND 组合（OR 会让精度归零）", () => {
    // 查「沙箱环境」bigram 化后是一串片段；用 OR 的话任何含「环」的都命中。
    expect(toMatchExpr(["沙箱", "环境"])).toBe('"沙箱" AND "环境"')
  })

  it("空 token 列表抛明确错误码而不是 SqliteError", () => {
    try {
      toMatchExpr([])
      expect.unreachable("应当抛错")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) expect(error.code).toBe("FTS_QUERY_INVALID")
    }
  })

  it("全是空白的 token 被过滤后同样抛错", () => {
    expect(() => toMatchExpr(["  ", "\t"])).toThrow()
  })

  it("hasSpecialChars 只用于诊断，不用于过滤（过滤会改变查询意图）", () => {
    expect(hasSpecialChars("环*")).toBe(true)
    expect(hasSpecialChars("沙箱")).toBe(false)
  })
})

/**
 * 真库回归：这些输入以前会直接抛 SQL 错。
 */
describe("特殊字符查询不报错（真实 FTS5）", () => {
  const SPECIALS = [
    "*",
    "-",
    '"',
    "OR",
    "NEAR(",
    ":",
    "^",
    "(",
    ")",
    "环 OR mid:SECRET",
    "-沙箱",
    "NEAR(沙 箱)",
    "环*",
    "沙箱*环境",
    '沙箱" OR "1"="1',
    "{}",
    "+沙箱",
  ]

  it.each(SPECIALS)("输入 %j 不抛错", (input) => {
    const vault = openTestVault()
    new ConversationRepository(vault.db).upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-1",
      type: "group",
      createdAt: 1,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "msg-1",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "ext-1",
        contentText: "沙箱环境部署完成了",
        sentAt: 1,
        direction: "inbound",
        createdAt: 1,
      },
    ])
    const fts = new FtsIndexRepository(vault.db)
    fts.upsert({
      messageId: "msg-1",
      conversationId: "conv-1",
      seg: toIndexSegment("沙箱环境部署完成了"),
      contentHash: "h1",
      indexedAt: 1,
    })

    const tokens = toQueryTokens(input)
    // 纯符号输入切不出 token → 上层应把它当"空查询"处理，而不是抛给 SQL。
    if (tokens.length === 0) {
      expect(() => toMatchExpr(tokens)).toThrow()
      vault.close()
      return
    }
    expect(() => fts.search(toMatchExpr(tokens))).not.toThrow()
    vault.close()
  })

  it("`环 OR mid:x` 被当字面量：不报错且不误命中（OR 语法没有生效）", () => {
    const vault = openTestVault()
    new ConversationRepository(vault.db).upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-1",
      type: "group",
      createdAt: 1,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "msg-1",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "ext-1",
        contentText: "沙箱环境部署完成了",
        sentAt: 1,
        direction: "inbound",
        createdAt: 1,
      },
    ])
    const fts = new FtsIndexRepository(vault.db)
    fts.upsert({
      messageId: "msg-1",
      conversationId: "conv-1",
      seg: toIndexSegment("沙箱环境部署完成了"),
      contentHash: "h1",
      indexedAt: 1,
    })

    // 「环」在原文里有，「mid」「secret」没有 → AND 组合后不命中。
    // 关键是它**不抛错**：未转义时这里是 `no such column: mid`。
    const hits = fts.search(toMatchExpr(toQueryTokens("环 OR mid:SECRET")))
    expect(hits).toEqual([])
    vault.close()
  })
})
