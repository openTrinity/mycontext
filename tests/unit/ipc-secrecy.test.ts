/**
 * IPC 契约的**保密性**不变式：渲染进程拿不到任何长期凭据。
 *
 * ## 为什么单独测这个
 *
 * 「渲染层能拿到什么」是一条安全边界，但它的失效方式极其安静：
 * 某个面板需要显示一点信息，顺手往 schema 里加一个字段，
 * 一切照常工作 —— 只是从那一刻起，一次 XSS 就能偷走那个凭据。
 * 没有断言的话，这类改动在评审里看起来只是"多了一个字段"。
 *
 * `authSessionSchema` 已经刻意只放过期时间而不放 token
 * （contract.ts:100 的注释），但 `feedInfoSchema` 首版**把 Feed token
 * 原样递给了渲染层**并在数据面板展示 —— 同一份原则在两个地方不一致，
 * 而不一致的那一侧就是缺口。这组断言把原则固定成机器可查的东西。
 *
 * ## 做法：喂进去再看吐出来什么
 *
 * 不 introspect schema 的内部结构（那要依赖 zod 的私有形状，且 zod
 * 不是本仓库根依赖），而是**塞一份带凭据的对象进去解析** ——
 * zod 默认 strip 未声明的键，所以"解析后还在"就等价于"schema 声明了它"。
 * 这比读内部结构更贴近真实：它测的正是 IPC 实际会传出去的那份数据。
 */
import { describe, expect, it } from "vitest"
import { authSessionSchema, feedInfoSchema } from "@mycontext/ipc-contract"

/**
 * 会被当成"长期凭据本身"的键名。
 *
 * `tokenReady` / `apiKeyTail` 这类**派生**字段是允许的：
 * 前者只是布尔、后者只有后 4 位（不足以复用），所以这里用精确键名而不是模糊匹配。
 */
const SECRET_KEYS = [
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "secret",
  "password",
  "serverPassword",
  "feedToken",
] as const

/** 往一份合法载荷里掺入全部凭据键，返回解析后**仍然存活**的那些。 */
function survivingSecrets(
  schema: { parse: (input: unknown) => unknown },
  validPayload: Record<string, unknown>,
): string[] {
  const polluted: Record<string, unknown> = { ...validPayload }
  for (const key of SECRET_KEYS) polluted[key] = `LEAKED-${key}`

  const parsed = schema.parse(polluted) as Record<string, unknown>
  return SECRET_KEYS.filter((key) => key in parsed)
}

const VALID_FEED_INFO = {
  running: true,
  baseUrl: "http://127.0.0.1:1/v1",
  tokenReady: true,
  head: 3,
  consumers: [],
}

describe("★ 渲染层拿不到长期凭据", () => {
  it("feedInfoSchema 不把任何凭据传给渲染层", () => {
    expect(survivingSecrets(feedInfoSchema, VALID_FEED_INFO)).toEqual([])
  })

  it("feedInfoSchema 只给 tokenReady（能力仍然可用）", () => {
    const parsed = feedInfoSchema.parse(VALID_FEED_INFO)
    expect(parsed.tokenReady).toBe(true)
    expect(parsed).not.toHaveProperty("token")
  })

  it("authSessionSchema 不把任何凭据传给渲染层（既有原则，一并锁住）", () => {
    const valid = {
      accountId: "acc-1",
      email: "me@example.com",
      signedInAt: "2026-07-29T00:00:00.000Z",
      // 只有过期时间，没有 token 本身
      tokens: { expiresAt: "2026-08-28T00:00:00.000Z" },
      // 身份三件套：都是**展示用**的公开信息，不是凭据。
      // 头像 URL 值得单独说一句：它指向一张图，拿到它不能代表任何人 ——
      // 与 token 的区别是「能不能用来冒充」，不是「是不是一串字符」。
      displayName: "王强",
      avatarUrl: "https://example.invalid/a.png",
      avatarSource: "manual" as const,
    }
    // 只断言凭据键不存活；其余字段由该 schema 自己的测试覆盖
    expect(survivingSecrets(authSessionSchema, valid)).toEqual([])
  })

  /**
   * 探针自身的负例。
   *
   * 不测这条，`survivingSecrets` 写错（比如 parse 抛错被吞掉）会让上面几条
   * **静默永远通过** —— 而"断言是空的"与"断言通过"外观完全相同。
   */
  it("探针能抓出真的泄漏（否则断言是空的）", () => {
    // 一个故意声明了 token 的假 schema：passthrough 语义
    const leakySchema = {
      parse: (input: unknown) => {
        const record = input as Record<string, unknown>
        return { running: record["running"], token: record["token"] }
      },
    }
    expect(survivingSecrets(leakySchema, VALID_FEED_INFO)).toContain("token")
  })
})
