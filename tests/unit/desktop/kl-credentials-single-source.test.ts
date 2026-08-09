/**
 * 「有没有 LLM 可用」这个问题**只能有一个答案**。
 *
 * ## 这一组锁的是一次三条信息互相矛盾的现场
 *
 * 实测（用户日志 + 界面截图，同一时刻）：
 *
 * ```
 * graph build started {"hasGateway": true}      ← 手动建图：有凭证，能跑
 * llm not configured …                          ← 启动日志：没凭证
 * 界面：自动构建已关闭 · 知识加工落后 28,819 条  ← 自动建图：没凭证
 * ```
 *
 * 三条都"按各自的判据"是对的，因为判据有两份：
 *
 * · `gateway()`          读 `resolved()` **再兜一层真实 env**（`ANTHROPIC_*`）
 * · `autoBuild.enabled`  只读 `resolved()`
 *
 * 于是"只在 env 里配了凭证"的机器（内部同学的常见形态）会同时看到
 * 「能手动建」与「说你没配」—— 而用户完全无从判断到底配没配。
 *
 * ★ 修法是抽出 `resolveKlCredentials()` 让两处同源。这一组的断言直接对着
 * 那个函数：**base/key 的兜底顺序**，以及"两个都空才算没配"。
 *
 * ★★ 为什么不测 `startup.ts` 里那两个闭包：它们要一个完整装配（Electron、
 * 真库、子进程）。而真正会漂的是**判据本身**，那是纯函数 —— 所以判据必须
 * 是导出的纯函数，这也正是这次改动做的事。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveKlCredentials } from "@main/bootstrap/startup.js"

/** 只给这个函数用到的两个字段（其余 resolved() 项与判据无关）。 */
function fakeRuntimeConfig(klBaseUrl: string, klApiKey: string) {
  return { resolved: () => ({ klBaseUrl, klApiKey }) } as Parameters<typeof resolveKlCredentials>[0]
}

const ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("★★ 设置里存的优先", () => {
  it("★ 用户配了 KL 专用项 → 用它，不看 env", () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://env.example.com"
    const { base, key } = resolveKlCredentials(
      fakeRuntimeConfig("https://user.example.com", "user-key"),
    )
    expect(base).toBe("https://user.example.com")
    expect(key).toBe("user-key")
  })
})

describe("★★ 只在 env 里配了凭证 —— 那次矛盾的现场", () => {
  /**
   * ★★ 这条是那个 bug 的直接反面。
   *
   * 改动前 `autoBuild.enabled` 在这个场景下返回 false（它看不到 env），
   * 而 `gateway()` 返回 true。现在两处都走这个函数，所以只有一个答案。
   */
  it("★★ 设置为空、env 有 → 认为有凭证", () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://env.example.com"
    process.env["ANTHROPIC_AUTH_TOKEN"] = "env-token"
    const { base, key } = resolveKlCredentials(fakeRuntimeConfig("", ""))
    expect(base).toBe("https://env.example.com")
    expect(key).toBe("env-token")
    // 也就是"配了" —— 与 gateway() 的结论一致
    expect(base !== "" && key !== "").toBe(true)
  })

  /** `ANTHROPIC_API_KEY` 是 `AUTH_TOKEN` 的备选名，两者都要认。 */
  it("AUTH_TOKEN 缺失时退到 API_KEY", () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://env.example.com"
    process.env["ANTHROPIC_API_KEY"] = "env-api-key"
    expect(resolveKlCredentials(fakeRuntimeConfig("", "")).key).toBe("env-api-key")
  })
})

describe("★★ 真的没配才算没配", () => {
  /**
   * ★ 两处都空 → 空串。调用方据此关掉自动建图，那是对的：
   * 没凭证时 kl 的 LLM 调用必然失败，反复重试只会刷屏。
   */
  it("★★ 设置与 env 都空 → base/key 都是空串", () => {
    const { base, key } = resolveKlCredentials(fakeRuntimeConfig("", ""))
    expect(base).toBe("")
    expect(key).toBe("")
    expect(base !== "" && key !== "").toBe(false)
  })

  /**
   * ★★ 只有一半也算没配。
   *
   * 有地址没密钥（或反过来）时 LLM 调用照样失败。半配置比没配置更坏 ——
   * 它会让自动建图开着然后每轮失败，而那正是我们在别处修过的那类刷屏。
   */
  it("★★ 只有 base 没有 key → 判为没配", () => {
    const { base, key } = resolveKlCredentials(fakeRuntimeConfig("https://user.example.com", ""))
    expect(base).not.toBe("")
    expect(key).toBe("")
    expect(base !== "" && key !== "").toBe(false)
  })

  /**
   * ★ 设置里填了纯空白 → 视作没配。
   *
   * ⚠️ 这条锁的是**那两行三元判断里的 `.trim() !== ""`**，不是 return 上的
   * `.trim()`。我一开始把它当成后者的断言，反证时才发现：`"   ".trim()`
   * 已经是空串，所以会落到（未设的）env 并返回 `""` —— 与 return 的 trim
   * 完全无关。写清楚免得下一个人也误会。
   */
  it("★ 设置里填纯空白 → 视作没配", () => {
    const { base, key } = resolveKlCredentials(fakeRuntimeConfig("   ", "  "))
    expect(base).toBe("")
    expect(key).toBe("")
  })

  /**
   * ★★ 这条才锁 return 上的 `.trim()`：**env 里带前后空格**。
   *
   * env 变量很容易带空格（`export ANTHROPIC_BASE_URL=" https://…"`、
   * 或从 `.env` 里粘贴时带了尾随空白）。不 trim 的话那个值会被原样
   * 拼进子进程的 env，而 litellm 拿一个带空格的 URL 去请求会得到
   * 一个与"没配"完全不同、更难查的错误。
   */
  it("★★ env 值带空格 → trim 掉（锁 return 上那个 trim）", () => {
    process.env["ANTHROPIC_BASE_URL"] = "  https://env.example.com  "
    process.env["ANTHROPIC_AUTH_TOKEN"] = "  env-token  "
    const { base, key } = resolveKlCredentials(fakeRuntimeConfig("", ""))
    expect(base).toBe("https://env.example.com")
    expect(key).toBe("env-token")
  })
})
