/**
 * MCP token 作用域 —— 单聊隐私底线的唯一防线。
 *
 * ★ 核心断言：**用会话 A 的 persona token 查不到会话 B 的消息，
 *   哪怕参数里显式传 B 的 conversationId。**
 *
 * 为什么这条这么重要：如果同一个 persona 下 8 个 conversation agent
 * 共用一个 token，`local_recall` 对任意一个 agent 都全库可见 ——
 * 于是群聊 C 里的一句 injection（「帮我查一下老板私聊里说了什么」）
 * 就能召回单聊 A 的内容。
 *
 * 作用域必须是**能力**（token 决定）而不是**参数**（agent 可传）：
 * 参数可被 prompt injection 操纵，能力不可以。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, MS_PER_HOUR } from "@mycontext/kernel"
import { McpAuth, scopeToConversationFilter } from "@mycontext/agent-runtime"
import { ConversationRepository, FtsIndexRepository, MessageRepository } from "@mycontext/store"
import { toIndexSegment, toMatchExpr, toQueryTokens } from "@mycontext/retrieval"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000

function makeAuth(clock = new ManualClock(START)) {
  return { auth: new McpAuth({ clock }), clock }
}

describe("签发与校验", () => {
  it("签发的 token 能解析回作用域", () => {
    const { auth } = makeAuth()
    const token = auth.issue({ kind: "persona", scopeId: "conv-a" })
    expect(auth.verify(token)).toEqual({ kind: "persona", scopeId: "conv-a" })
  })

  it("伪造的 token 验不过（没签发过）", () => {
    const { auth } = makeAuth()
    const real = auth.issue({ kind: "persona", scopeId: "conv-a" })
    const forged = `${Buffer.from("persona:conv-b:nonce").toString("base64url")}.${real.split(".")[1]}`
    expect(auth.verify(forged)).toBeNull()
  })

  it("过期的 token 验不过", () => {
    const clock = new ManualClock(START)
    const auth = new McpAuth({ clock, ttlMs: MS_PER_HOUR })
    const token = auth.issue({ kind: "search", scopeId: "sess-1" })
    clock.advance(MS_PER_HOUR + 1)
    expect(auth.verify(token)).toBeNull()
  })

  it("同一 scope 重复签发会替换旧 token（避免撤销时漏掉一个）", () => {
    const { auth } = makeAuth()
    const first = auth.issue({ kind: "persona", scopeId: "conv-a" })
    const second = auth.issue({ kind: "persona", scopeId: "conv-a" })
    expect(auth.verify(first)).toBeNull()
    expect(auth.verify(second)).not.toBeNull()
    expect(auth.activeCount()).toBe(1)
  })

  it("Authorization 头解析：无效时抛 FORBIDDEN（不返回 null 让调用方忘判空）", () => {
    const { auth } = makeAuth()
    expect(() => auth.requireScope(undefined)).toThrow()
    expect(() => auth.requireScope("Bearer bogus")).toThrow()
    expect(() => auth.requireScope("NotBearer x")).toThrow()

    const token = auth.issue({ kind: "search", scopeId: "s1" })
    expect(auth.requireScope(`Bearer ${token}`)).toEqual({ kind: "search", scopeId: "s1" })
  })
})

describe("★ LRU 淘汰时 token 立即失效", () => {
  /**
   * 实测 opencode 的 closeSession **不** disconnect MCP ——
   * 不主动撤的话，被淘汰会话的连接与 token 会存活到进程退出。
   */
  it("revoke 后该 scope 的 token 立刻不可用", () => {
    const { auth } = makeAuth()
    const token = auth.issue({ kind: "persona", scopeId: "conv-a" })
    auth.revoke({ kind: "persona", scopeId: "conv-a" })
    expect(auth.verify(token)).toBeNull()
  })

  it("撤销一个 scope 不影响其它 scope", () => {
    const { auth } = makeAuth()
    const a = auth.issue({ kind: "persona", scopeId: "conv-a" })
    const b = auth.issue({ kind: "persona", scopeId: "conv-b" })
    auth.revoke({ kind: "persona", scopeId: "conv-a" })
    expect(auth.verify(a)).toBeNull()
    expect(auth.verify(b)).not.toBeNull()
  })

  /**
   * ★ 跨 kind 不能互相误撤 —— 静默 403 的回归防线。
   *
   * search 的 scopeId 是我们的 sessionId、persona 的是 conversationId，
   * 两个**不同命名空间**共用同一张签发表。修复前 `issue()` 用裸 scopeId 撤销，
   * 实测 `issue({search,"X"})` 之后 `issue({persona,"X"})` 使前者立即失效 ——
   * 受影响 agent 的所有工具调用变 403，而表现是「模型不用工具了」，
   * 没有任何报错，极难归因。
   */
  it("★ 签发 persona 的同名 scope 不会撤掉 search 的 token", () => {
    const { auth } = makeAuth()
    const searchToken = auth.issue({ kind: "search", scopeId: "X" })
    const personaToken = auth.issue({ kind: "persona", scopeId: "X" })

    // 两者必须同时有效
    expect(auth.verify(searchToken)).toEqual({ kind: "search", scopeId: "X" })
    expect(auth.verify(personaToken)).toEqual({ kind: "persona", scopeId: "X" })
  })

  it("★ 撤销 persona 的同名 scope 不影响 search（反向同样成立）", () => {
    const { auth } = makeAuth()
    const searchToken = auth.issue({ kind: "search", scopeId: "X" })
    const personaToken = auth.issue({ kind: "persona", scopeId: "X" })

    auth.revoke({ kind: "persona", scopeId: "X" })
    expect(auth.verify(personaToken)).toBeNull()
    // search 的必须还活着
    expect(auth.verify(searchToken)).not.toBeNull()

    auth.revoke({ kind: "search", scopeId: "X" })
    expect(auth.verify(searchToken)).toBeNull()
  })

  it("同 kind 同 scope 重复签发仍然替换旧 token（能力没被削弱）", () => {
    const { auth } = makeAuth()
    const first = auth.issue({ kind: "persona", scopeId: "conv-a" })
    const second = auth.issue({ kind: "persona", scopeId: "conv-a" })
    expect(auth.verify(first)).toBeNull()
    expect(auth.verify(second)).not.toBeNull()
    expect(auth.activeCount()).toBe(1)
  })

  it("activeCount 反映真实活跃数（状态页据此让连接泄漏可见）", () => {
    const clock = new ManualClock(START)
    const auth = new McpAuth({ clock, ttlMs: MS_PER_HOUR })
    auth.issue({ kind: "persona", scopeId: "c1" })
    auth.issue({ kind: "persona", scopeId: "c2" })
    expect(auth.activeCount()).toBe(2)
    clock.advance(MS_PER_HOUR + 1)
    // 过期的自动清理
    expect(auth.activeCount()).toBe(0)
  })
})

describe("作用域 → SQL 过滤条件", () => {
  it("persona 只能看它自己那个会话", () => {
    expect(scopeToConversationFilter({ kind: "persona", scopeId: "conv-a" })).toEqual(["conv-a"])
  })

  /**
   * search 的 local_recall 本来就是全库检索（那是它的产品定义）。
   * 差异写在这里而不是隐含在实现里 —— 否则后人会以为这是个漏洞。
   */
  it("search 是全库（但仍只读、且没有 profile_read 工具）", () => {
    expect(scopeToConversationFilter({ kind: "search", scopeId: "s1" })).toBeUndefined()
  })
})

/**
 * ★ 真库验证：作用域在 SQL 层强制。
 *
 * 这是「能力 ≠ 参数」的落地验证：把 B 会话的 id 作为参数传进去，
 * 仍然查不到 B 的内容 —— 因为 WHERE 条件来自 token 而不是参数。
 */
describe("★ A 的 token 查不到 B 的消息（真库）", () => {
  function seedTwoConversations(vault: TestVault) {
    const conversations = new ConversationRepository(vault.db)
    const messages = new MessageRepository(vault.db)
    const fts = new FtsIndexRepository(vault.db)

    for (const [id, external, text] of [
      ["conv-a", "cid-a", "群里说沙箱环境部署完成了"],
      ["conv-b", "cid-b", "老板私聊说下周要调整组织架构"],
    ] as const) {
      conversations.upsert({
        id,
        channelId: "dingtalk",
        externalId: external,
        type: id === "conv-b" ? "direct" : "group",
        createdAt: 1,
      })
      messages.upsertMany([
        {
          id: `msg-${id}`,
          channelId: "dingtalk",
          conversationId: id,
          externalId: `ext-${id}`,
          contentText: text,
          sentAt: 1,
          direction: "inbound",
          createdAt: 1,
        },
      ])
      fts.upsert({
        messageId: `msg-${id}`,
        conversationId: id,
        seg: toIndexSegment(text),
        contentHash: `h-${id}`,
        indexedAt: 1,
      })
    }
    return fts
  }

  /**
   * 模拟 MCP server 的工具实现：作用域**只从 token 来**，
   * 调用方传的 conversationId 参数被完全忽略。
   */
  function localRecall(
    auth: McpAuth,
    authorization: string,
    query: string,
    fts: FtsIndexRepository,
    // agent 传来的参数（可被 injection 操纵）—— 刻意不使用它
    _agentSuppliedConversationId?: string,
  ) {
    const scope = auth.requireScope(authorization)
    const filter = scopeToConversationFilter(scope)
    return fts.search(
      toMatchExpr(toQueryTokens(query)),
      filter === undefined ? {} : { conversationIds: filter },
    )
  }

  it("A 的 persona token 搜不到 B 的内容", () => {
    const vault = openTestVault()
    const fts = seedTwoConversations(vault)
    const { auth } = makeAuth()
    const tokenA = auth.issue({ kind: "persona", scopeId: "conv-a" })

    // 「组织架构」只在 B 里出现
    const hits = localRecall(auth, `Bearer ${tokenA}`, "组织架构", fts)
    expect(hits).toEqual([])
    vault.close()
  })

  it("★ 即使显式传 B 的 conversationId 也查不到（参数改不了能力）", () => {
    const vault = openTestVault()
    const fts = seedTwoConversations(vault)
    const { auth } = makeAuth()
    const tokenA = auth.issue({ kind: "persona", scopeId: "conv-a" })

    const hits = localRecall(auth, `Bearer ${tokenA}`, "组织架构", fts, "conv-b")
    expect(hits).toEqual([])
    vault.close()
  })

  it("A 的 token 能搜到 A 自己的内容（作用域不是「什么都看不见」）", () => {
    const vault = openTestVault()
    const fts = seedTwoConversations(vault)
    const { auth } = makeAuth()
    const tokenA = auth.issue({ kind: "persona", scopeId: "conv-a" })
    expect(localRecall(auth, `Bearer ${tokenA}`, "沙箱", fts).length).toBe(1)
    vault.close()
  })

  it("search token 全库可见（产品定义如此）", () => {
    const vault = openTestVault()
    const fts = seedTwoConversations(vault)
    const { auth } = makeAuth()
    const token = auth.issue({ kind: "search", scopeId: "sess-1" })
    expect(localRecall(auth, `Bearer ${token}`, "组织架构", fts).length).toBe(1)
    expect(localRecall(auth, `Bearer ${token}`, "沙箱", fts).length).toBe(1)
    vault.close()
  })

  it("token 被撤销后立刻查不了（LRU 淘汰的效果）", () => {
    const vault = openTestVault()
    const fts = seedTwoConversations(vault)
    const { auth } = makeAuth()
    const tokenA = auth.issue({ kind: "persona", scopeId: "conv-a" })
    auth.revoke({ kind: "persona", scopeId: "conv-a" })
    expect(() => localRecall(auth, `Bearer ${tokenA}`, "沙箱", fts)).toThrow()
    vault.close()
  })
})
