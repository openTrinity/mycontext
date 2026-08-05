/**
 * RuntimeConfigService —— 模型网关的单一真源。
 *
 * 锁住的性质：
 * 1. 三层解析：用户存的覆盖 > kernel loadConfig 默认层；
 * 2. KL 三项留空回退主配置（`klEffective` 给出实际生效值）；
 * 3. 脱敏：apiKey 只给 configured + 后 4 位，明文不出现在视图里；
 * 4. save 后 process.env 被 seed（含 ANTHROPIC_* 别名）；
 * 5. apiKey 三态：undefined 不改、null/"" 清空、字符串写入；
 * 6. 坏数据回退默认层而不抛；
 * 7. adopt 旧的隐藏高级面板配置。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger, loadConfig, type LoadedConfig } from "@mycontext/kernel"
import { openStore, SettingsRepository } from "@mycontext/store"
import { RuntimeConfigService } from "@main/services/runtime-config.service.js"

const dirs: string[] = []
const NOW = "2026-08-02T00:00:00.000Z"

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function memorySecretStore() {
  const store = new Map<string, string>()
  return {
    store,
    read: (key: string) => {
      const v = store.get(key)
      return v === undefined || v === "" ? null : v
    },
    write: (key: string, value: string) => void store.set(key, value),
  }
}

function makeService(defaults?: LoadedConfig, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-rc-"))
  dirs.push(dir)
  const handle = openStore({ path: join(dir, "control.sqlite") })
  const secrets = memorySecretStore()
  const settings = new SettingsRepository(handle.db)
  const service = new RuntimeConfigService({
    settings,
    logger: createLogger("test", { level: "error" }),
    secretStore: secrets,
    defaults: defaults ?? loadConfig(),
    env: env ?? {},
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })
  return { service, secrets, settings, close: () => handle.close() }
}

/** 造一个假网关响应。 */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown } | Error,
): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = ((url: string, init?: RequestInit) => {
    urls.push(String(url))
    const result = handler(String(url), init)
    if (result instanceof Error) return Promise.reject(result)
    return Promise.resolve({
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: () => Promise.resolve(result.body),
      text: () =>
        Promise.resolve(
          typeof result.body === "string" ? result.body : JSON.stringify(result.body),
        ),
    } as unknown as Response)
  }) as unknown as typeof fetch
  return { impl, urls }
}

describe("三层解析", () => {
  it("无覆盖时走 kernel 默认层", () => {
    const ctx = makeService()
    const r = ctx.service.resolved()
    // 默认层：modelMain 默认 glm-5.2，embed text-embedding-v4
    expect(r.modelMain).toBe("glm-5.2")
    expect(r.embedModel).toBe("text-embedding-v4")
    ctx.close()
  })

  it("用户存的覆盖默认层", () => {
    const ctx = makeService()
    ctx.service.save({ modelMain: "claude-opus-4-8", llmBaseUrl: "https://custom" }, NOW)
    const r = ctx.service.resolved()
    expect(r.modelMain).toBe("claude-opus-4-8")
    expect(r.llmBaseUrl).toBe("https://custom")
    ctx.close()
  })

  it("默认层来自 loadConfig 的 env（真实环境变量优先）", () => {
    const defaults = loadConfig({ env: { MYCONTEXT_MODEL_MAIN: "qwen3.7-max" } })
    const ctx = makeService(defaults)
    expect(ctx.service.resolved().modelMain).toBe("qwen3.7-max")
    // view 里 source 标为 env
    expect(ctx.service.view().modelMain.source).toBe("env")
    ctx.close()
  })
})

describe("KL 三项回退主配置", () => {
  it("KL 全空时 klEffective 用主配置", () => {
    const ctx = makeService()
    ctx.service.save(
      { llmBaseUrl: "https://main", modelMain: "glm-5.2", llmApiKey: "sk-main1234" },
      NOW,
    )
    const r = ctx.service.resolved()
    expect(r.klBaseUrl).toBe("https://main")
    expect(r.klModel).toBe("glm-5.2")
    expect(r.klApiKey).toBe("sk-main1234")
    ctx.close()
  })

  it("KL 单独指定时不回退", () => {
    const ctx = makeService()
    ctx.service.save(
      {
        llmBaseUrl: "https://main",
        modelMain: "glm-5.2",
        klModelMain: "claude-sonnet-4-6",
        klLlmApiKey: "sk-kl9999",
      },
      NOW,
    )
    const r = ctx.service.resolved()
    expect(r.klModel).toBe("claude-sonnet-4-6")
    expect(r.klApiKey).toBe("sk-kl9999")
    // base 没单独填 → 回退主配置
    expect(r.klBaseUrl).toBe("https://main")
    const v = ctx.service.view()
    expect(v.klEffective.model).toBe("claude-sonnet-4-6")
    expect(v.klEffective.apiKeyConfigured).toBe(true)
    ctx.close()
  })
})

describe("脱敏", () => {
  it("apiKey 只给 configured + 后 4 位，明文不出现", () => {
    const ctx = makeService()
    ctx.service.save({ llmApiKey: "sk-super-secret-1234" }, NOW)
    const v = ctx.service.view()
    expect(v.llmApiKey.configured).toBe(true)
    expect(v.llmApiKey.tail).toBe("1234")
    expect(JSON.stringify(v)).not.toContain("sk-super-secret")
    ctx.close()
  })

  it("未配置 apiKey → configured false", () => {
    const ctx = makeService()
    expect(ctx.service.view().llmApiKey.configured).toBe(false)
    ctx.close()
  })
})

describe("seedProcessEnv", () => {
  it("save 后主网关写进 env 的 MYCONTEXT_* 与 ANTHROPIC_* 别名", () => {
    const env: NodeJS.ProcessEnv = {}
    const ctx = makeService(loadConfig(), env)
    ctx.service.save({ llmBaseUrl: "https://gw.example", llmApiKey: "sk-abc-7777" }, NOW)
    expect(env["MYCONTEXT_LLM_BASE_URL"]).toBe("https://gw.example")
    expect(env["MYCONTEXT_LLM_API_KEY"]).toBe("sk-abc-7777")
    // ANTHROPIC_* 别名（resolveGatewayModelConfig 优先级更高，必须一起 seed）
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://gw.example")
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("sk-abc-7777")
    ctx.close()
  })
})

describe("apiKey 三态", () => {
  it("undefined 不改，null 清空", () => {
    const ctx = makeService()
    ctx.service.save({ llmApiKey: "sk-original-8888" }, NOW)
    // 只改 baseUrl，apiKey undefined → 保留
    ctx.service.save({ llmBaseUrl: "https://y" }, NOW)
    expect(ctx.service.view().llmApiKey.tail).toBe("8888")
    // null 清空
    ctx.service.save({ llmApiKey: null }, NOW)
    expect(ctx.service.view().llmApiKey.configured).toBe(false)
    ctx.close()
  })
})

describe("坏数据回退", () => {
  it("库里存了坏 JSON → 走默认层不抛", () => {
    const ctx = makeService()
    ctx.settings.set("runtime_llm_config", "{not json", NOW)
    expect(() => ctx.service.resolved()).not.toThrow()
    expect(ctx.service.resolved().modelMain).toBe("glm-5.2")
    ctx.close()
  })
})

describe("adopt 旧高级面板配置", () => {
  it("首次运行搬入旧 baseUrl + apiKey", () => {
    const dir = mkdtempSync(join(tmpdir(), "mycontext-rc-adopt-"))
    dirs.push(dir)
    const handle = openStore({ path: join(dir, "control.sqlite") })
    const settings = new SettingsRepository(handle.db)
    const secrets = memorySecretStore()
    // 预置旧的高级面板配置
    settings.set(
      "advanced_ai_config",
      JSON.stringify({ baseUrl: "https://legacy", harness: {} }),
      NOW,
    )
    secrets.write("advanced_ai_api_key", "sk-legacy-5555")

    const service = new RuntimeConfigService({
      settings,
      logger: createLogger("test", { level: "error" }),
      secretStore: secrets,
      defaults: loadConfig(),
      env: {},
    })
    expect(service.resolved().llmBaseUrl).toBe("https://legacy")
    expect(service.view().llmApiKey.tail).toBe("5555")
    handle.close()
  })
})

/**
 * 网关探测。
 *
 * ★★ 这一组锁的是「把静默失效变成当场可见」这条性质。
 *
 * 模型名/密钥填错在生产上的表现是**几小时后**蒸馏或建图里的
 * `model_not_found` / 401 —— 日志一行、界面无声，而那正是本项目
 * 最怕的失效形态。探测把它提前到用户点按钮那一刻。
 *
 * 所以失败必须**分类**（reason），不是丢一段英文报文：
 * 「key 不对」与「地址连不上」要给的下一步动作完全不同。
 */
describe("网关探测", () => {
  it("成功 → 返回排序后的模型列表", async () => {
    const { impl, urls } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ id: "qwen3.7-plus" }, { id: "glm-5.2" }, { id: "claude-opus-4-8" }] },
    }))
    const ctx = makeService(loadConfig(), {}, impl)
    ctx.service.save({ llmBaseUrl: "https://gw.example", llmApiKey: "sk-ok-1234" }, NOW)
    const result = await ctx.service.probe({})
    expect(result.ok).toBe(true)
    // 排序过：列表要稳定，否则每次探测 chips 顺序都在跳
    expect(result.models).toEqual(["claude-opus-4-8", "glm-5.2", "qwen3.7-plus"])
    expect(urls[0]).toBe("https://gw.example/v1/models")
    ctx.close()
  })

  it("base 带不带 /v1 都规范化到同一个 URL（不让用户去记）", async () => {
    const { impl, urls } = fakeFetch(() => ({ status: 200, body: { data: [] } }))
    const ctx = makeService(loadConfig(), {}, impl)
    await ctx.service.probe({ baseUrl: "https://gw.example/v1/", apiKey: "sk-x" })
    await ctx.service.probe({ baseUrl: "https://gw.example", apiKey: "sk-x" })
    expect(urls).toEqual(["https://gw.example/v1/models", "https://gw.example/v1/models"])
    ctx.close()
  })

  it("401 → unauthorized（不是笼统的失败）", async () => {
    const { impl } = fakeFetch(() => ({
      status: 401,
      body: { error: { message: "Invalid token" } },
    }))
    const ctx = makeService(loadConfig(), {}, impl)
    const result = await ctx.service.probe({ baseUrl: "https://gw.example", apiKey: "sk-bad" })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("unauthorized")
    expect(result.detail).toContain("Invalid token")
    ctx.close()
  })

  it("连不上 → unreachable", async () => {
    const { impl } = fakeFetch(() => new Error("getaddrinfo ENOTFOUND nope.invalid"))
    const ctx = makeService(loadConfig(), {}, impl)
    const result = await ctx.service.probe({ baseUrl: "https://nope.invalid", apiKey: "sk-x" })
    expect(result.reason).toBe("unreachable")
    ctx.close()
  })

  /**
   * ★ URL 填成了控制台首页这类情况：200 但返回 HTML。
   * 报 badResponse 而不是「成功但 0 个模型」—— 后者会让用户以为
   * 网关没模型可用，于是去查网关，而真因是自己 URL 填错了。
   */
  it("200 但不是 OpenAI 兼容形状 → badResponse", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: "<html>console</html>" }))
    const ctx = makeService(loadConfig(), {}, impl)
    const result = await ctx.service.probe({ baseUrl: "https://gw.example", apiKey: "sk-x" })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("badResponse")
    ctx.close()
  })

  it("没填 key → noKey，且**不打网络**", async () => {
    const { impl, urls } = fakeFetch(() => ({ status: 200, body: { data: [] } }))
    const ctx = makeService(loadConfig(), {}, impl)
    const result = await ctx.service.probe({ baseUrl: "https://gw.example" })
    expect(result.reason).toBe("noKey")
    expect(urls).toEqual([])
    ctx.close()
  })

  /** 「不改 key、只测地址」要能表达 —— apiKey 省略时回退已存的那把。 */
  it("省略 apiKey 时用已存的 key", async () => {
    let seenAuth = ""
    const { impl } = fakeFetch((_url, init) => {
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.["Authorization"])
      return { status: 200, body: { data: [{ id: "glm-5.2" }] } }
    })
    const ctx = makeService(loadConfig(), {}, impl)
    ctx.service.save({ llmApiKey: "sk-stored-9999" }, NOW)
    await ctx.service.probe({ baseUrl: "https://gw.example" })
    expect(seenAuth).toBe("Bearer sk-stored-9999")
    ctx.close()
  })
})
