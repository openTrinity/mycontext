/**
 * Feed Server 契约测试。
 *
 * 用真实 HTTP（起在随机端口的 127.0.0.1）而不是直接调方法：
 * 鉴权、状态码、JSON 形状都是**跨团队契约**的一部分，
 * 而这些恰恰是直接调方法测不到的。
 */
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { ChangelogRepository, ConsumerCursorRepository } from "@mycontext/store"
import { FeedServer } from "@mycontext/knowledge-feed"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000
const servers: FeedServer[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop()
})

async function startServer(vault: TestVault, clock: ManualClock) {
  const server = new FeedServer({ db: vault.db, clock, token: "test-token-0123456789" })
  servers.push(server)
  const port = await server.start()
  return { server, base: `http://127.0.0.1:${port}` }
}

function seedChangelog(vault: TestVault, count: number, domain = "chat") {
  const changelog = new ChangelogRepository(vault.db)
  for (let index = 0; index < count; index += 1) {
    changelog.append([
      {
        op: "upsert",
        entityType: "message",
        entityId: `m-${index}`,
        channelId: "dingtalk",
        domain: domain as "chat",
        occurredAt: START + index,
        emittedAt: START + index,
        digest: `d-${index}`,
      },
    ])
  }
}

async function get(base: string, path: string, token = "test-token-0123456789") {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("鉴权（只绑 127.0.0.1 + Bearer）", () => {
  it("无 token → 401", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    const response = await fetch(`${base}/v1/head`)
    expect(response.status).toBe(401)
    vault.close()
  })

  it("错误 token → 401", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    expect((await get(base, "/v1/head", "wrong-token-012345678")).status).toBe(401)
    vault.close()
  })

  it("长度不同的 token 也被拒（timingSafeEqual 前的长度检查）", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    expect((await get(base, "/v1/head", "short")).status).toBe(401)
    vault.close()
  })

  it("未知路径 → 404（但仍先过鉴权）", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    expect((await get(base, "/v1/unknown")).status).toBe(404)
    const unauth = await fetch(`${base}/v1/unknown`)
    expect(unauth.status).toBe(401)
    vault.close()
  })
})

describe("/v1/head（为空轮询而设计：只读一行）", () => {
  it("返回水位、分域水位、消费者 lag 与服务端时间", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    seedChangelog(vault, 5)
    const consumers = new ConsumerCursorRepository(vault.db, clock)
    consumers.register("kl-graph")
    consumers.ack("kl-graph", 3)

    const { base } = await startServer(vault, clock)
    const { status, body } = await get(base, "/v1/head")
    expect(status).toBe(200)
    expect(body["head"]).toBe(5)
    expect(body["domains"]).toEqual({ chat: 5 })
    expect(body["serverTime"]).toBe(START)
    // lag 直接给出来：消费者不用自己算，也不会算错
    expect(body["consumers"]).toMatchObject({ "kl-graph": { ackedSeq: 3, lag: 2 } })
    vault.close()
  })

  it("空库时 head 为 0（不是 null，省掉对方的判空）", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    expect((await get(base, "/v1/head")).body["head"]).toBe(0)
    vault.close()
  })

  /**
   * ★ 分域水位：多个 domain 各自的最大 seq 必须都对。
   *
   * `headByDomain` 从 `GROUP BY domain`（实测 `SCAN USING COVERING INDEX`
   * ——全索引扫描，50 万行 15ms、100 万行 32.7ms）改成了「对 4 个已知 domain
   * 各做一次 `MAX(seq) WHERE domain = ?`」（索引末端 seek，与行数无关）。
   * `/v1/head` 的整个设计卖点是"轻到可以随便调"，一个随库增长的全扫描
   * 把那个前提悄悄抽掉了。
   *
   * 这条断言锁住改写后**语义不变**：每个 domain 的值仍是它自己的最大 seq，
   * 且没有条目的 domain **不出现**（而不是给一个 0 —— 那会让消费者
   * 把"这个域还没数据"与"这个域水位是 0"混起来）。
   */
  it("★ 分域水位：多域各自正确，且空域不出现", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    // chat 3 条（seq 1-3），doc 2 条（seq 4-5）；minutes / contact 一条都没有
    seedChangelog(vault, 3, "chat")
    seedChangelog(vault, 2, "doc")

    const { base } = await startServer(vault, clock)
    const { body } = await get(base, "/v1/head")
    expect(body["head"]).toBe(5)
    // 各域取自己的最大 seq，不是全局 head
    expect(body["domains"]).toEqual({ chat: 3, doc: 5 })
    vault.close()
  })

  it("空库时 domains 为空对象（不是每个域都给 0）", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    expect((await get(base, "/v1/head")).body["domains"]).toEqual({})
    vault.close()
  })
})

/**
 * ★ 带 Origin 的请求一律拒绝（纵深防御，挡 DNS rebinding 一类场景）。
 *
 * Bearer 已经能挡住无凭据请求，但**带 Origin** 意味着请求来自网页 ——
 * 而这个服务没有任何面向网页的用途（消费者是算法侧的 Python / CLI，
 * 它们不会发 Origin）。攻击者页面把某域名解析到 127.0.0.1 时，
 * SOP 不保护我们，所以这道拦是必要的。
 */
describe("★ Origin 拒绝（本机不等于安全）", () => {
  it("带 Origin 的请求 → 403（即使 token 正确）", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    const response = await fetch(`${base}/v1/head`, {
      headers: {
        authorization: "Bearer test-token-0123456789",
        origin: "http://evil.example",
      },
    })
    expect(response.status).toBe(403)
    vault.close()
  })

  it("localhost 的 Origin 也拒绝（不给「本机网页」开口子）", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    const response = await fetch(`${base}/v1/head`, {
      headers: {
        authorization: "Bearer test-token-0123456789",
        origin: "http://localhost:3000",
      },
    })
    expect(response.status).toBe(403)
    vault.close()
  })

  it("不带 Origin 的正常客户端照常工作（算法侧不受影响）", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    expect((await get(base, "/v1/head")).status).toBe(200)
    vault.close()
  })
})

describe("/v1/changes", () => {
  it("按 since 增量返回，升序", async () => {
    const vault = openTestVault()
    seedChangelog(vault, 5)
    const { base } = await startServer(vault, new ManualClock(START))
    const { body } = await get(base, "/v1/changes?since=2&limit=10")
    const changes = body["changes"] as { seq: number }[]
    expect(changes.map((row) => row.seq)).toEqual([3, 4, 5])
    expect(body["hasMore"]).toBe(false)
    vault.close()
  })

  it("hasMore 明确告知还有更多（省掉一次探测请求）", async () => {
    const vault = openTestVault()
    seedChangelog(vault, 10)
    const { base } = await startServer(vault, new ManualClock(START))
    const { body } = await get(base, "/v1/changes?since=0&limit=3")
    expect((body["changes"] as unknown[]).length).toBe(3)
    expect(body["hasMore"]).toBe(true)
    expect(body["head"]).toBe(10)
    vault.close()
  })

  it("按 domain 过滤", async () => {
    const vault = openTestVault()
    seedChangelog(vault, 3, "chat")
    seedChangelog(vault, 2, "contact")
    const { base } = await startServer(vault, new ManualClock(START))
    const chat = await get(base, "/v1/changes?since=0&domain=chat")
    expect((chat.body["changes"] as unknown[]).length).toBe(3)
    const contact = await get(base, "/v1/changes?since=0&domain=contact")
    expect((contact.body["changes"] as unknown[]).length).toBe(2)
    vault.close()
  })

  it("非法 since → 400（而不是当成 0 返回全量）", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    expect((await get(base, "/v1/changes?since=-1")).status).toBe(400)
    expect((await get(base, "/v1/changes?since=abc")).status).toBe(400)
    vault.close()
  })

  it("limit 被上限截断（防一次拉爆内存）", async () => {
    const vault = openTestVault()
    seedChangelog(vault, 50)
    const clock = new ManualClock(START)
    const server = new FeedServer({
      db: vault.db,
      clock,
      token: "test-token-0123456789",
      maxPageSize: 10,
    })
    servers.push(server)
    const port = await server.start()
    const { body } = await get(`http://127.0.0.1:${port}`, "/v1/changes?since=0&limit=1000")
    expect((body["changes"] as unknown[]).length).toBe(10)
    vault.close()
  })

  /**
   * ★★ limit 必须与 since 一样严格校验（首版只校验了 since，形成不一致）。
   *
   * 实测两个后果：
   * · `limit=abc` → `NaN` → better-sqlite3 抛 `datatype mismatch` → **500**
   *   （客户端参数错误被报成服务端故障，跨团队排查时会指向错误的方向）；
   * · `limit=-5` → SQLite 把负 LIMIT 视为**无限制**（实测返回全表）
   *   → 一次拉走整个 changelog，**绕过分页上限**。
   */
  it("★ 非法 limit → 400（不是 500，也不是绕过上限）", async () => {
    const vault = openTestVault()
    seedChangelog(vault, 30)
    const { base } = await startServer(vault, new ManualClock(START))

    // 修复前：NaN 传进 SQLite → datatype mismatch → 500
    expect((await get(base, "/v1/changes?since=0&limit=abc")).status).toBe(400)
    // 修复前：负数被 SQLite 当"无限制" → 返回全表
    expect((await get(base, "/v1/changes?since=0&limit=-5")).status).toBe(400)
    expect((await get(base, "/v1/changes?since=0&limit=0")).status).toBe(400)
    // 小数同样拒绝：LIMIT 只接受整数
    expect((await get(base, "/v1/changes?since=0&limit=1.5")).status).toBe(400)
    vault.close()
  })

  it("★ limit=-5 不会返回全表（分页上限不可绕过）", async () => {
    const vault = openTestVault()
    seedChangelog(vault, 30)
    const { base } = await startServer(vault, new ManualClock(START))
    const response = await get(base, "/v1/changes?since=0&limit=-5")
    // 400 且**没有** changes 字段：绝不能把 30 条整表吐出去
    expect(response.status).toBe(400)
    expect(response.body["changes"]).toBeUndefined()
    vault.close()
  })

  it("不传 limit 时用默认页大小（仍受 maxPageSize 夹住）", async () => {
    const vault = openTestVault()
    seedChangelog(vault, 20)
    const clock = new ManualClock(START)
    const server = new FeedServer({
      db: vault.db,
      clock,
      token: "test-token-0123456789",
      maxPageSize: 7,
    })
    servers.push(server)
    const port = await server.start()
    const { status, body } = await get(`http://127.0.0.1:${port}`, "/v1/changes?since=0")
    expect(status).toBe(200)
    expect((body["changes"] as unknown[]).length).toBe(7)
    vault.close()
  })
})

describe("/v1/ack", () => {
  it("POST 推进游标，首次 ack 即注册消费者", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    seedChangelog(vault, 5)
    const { base } = await startServer(vault, clock)

    const response = await fetch(`${base}/v1/ack`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ consumerId: "kl-graph", seq: 4 }),
    })
    expect(response.status).toBe(200)
    expect(new ConsumerCursorRepository(vault.db, clock).get("kl-graph")?.ackedSeq).toBe(4)
    vault.close()
  })

  it("GET → 405（ack 会改状态，不该允许幂等方法之外的误用）", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    expect((await get(base, "/v1/ack")).status).toBe(405)
    vault.close()
  })

  it("body 缺字段 → 400", async () => {
    const vault = openTestVault()
    const { base } = await startServer(vault, new ManualClock(START))
    const response = await fetch(`${base}/v1/ack`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ seq: 1 }),
    })
    expect(response.status).toBe(400)
    vault.close()
  })

  /**
   * 历史已被裁剪时，新消费者必须走全量而不是从 0 增量 ——
   * 后者会得到一份**静默缺数据**的索引。
   */
  it("历史已裁剪时新消费者被标 needs_full_rebuild", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    seedChangelog(vault, 10)
    // 模拟裁剪：删掉前 5 条
    new ChangelogRepository(vault.db).pruneUpTo(5)
    const { base } = await startServer(vault, clock)

    await fetch(`${base}/v1/ack`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ consumerId: "late-comer", seq: 0 }),
    })
    const consumer = new ConsumerCursorRepository(vault.db, clock).get("late-comer")
    expect(consumer?.needsFullRebuild).toBe(true)
    vault.close()
  })
})

describe("自动生成的 token", () => {
  it("未指定时生成一个足够长的随机 token", async () => {
    const vault = openTestVault()
    const server = new FeedServer({ db: vault.db, clock: new ManualClock(START) })
    servers.push(server)
    await server.start()
    expect(server.token.length).toBeGreaterThanOrEqual(32)
    vault.close()
  })
})
