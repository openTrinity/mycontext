/**
 * 高级 AI 配置的边界。
 *
 * ★ 硬约束：这一页配的是"用什么脑子"，**不是"能不能动手"**。
 *   换模型、换 harness、甚至用逃生阀注入任意 JSON，都不该影响
 *   发送门禁与自动回复策略 —— 那两者由独立的 policy / SendGuard 判定。
 *
 * 这条约束现在就测，而不是等 D 阶段的 SendGuard 落地才测：
 * 那时再补，会发现配置已经被某处读进了发送路径（"顺手加个开关"），
 * 而拆回来的成本比一开始就守住高得多。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger, loadConfig } from "@mycontext/kernel"
import { openStore, SettingsRepository } from "@mycontext/store"
import { AdvancedAiService } from "@main/services/advanced-ai.service.js"
import { RuntimeConfigService } from "@main/services/runtime-config.service.js"

const dirs: string[] = []
const NOW = "2026-07-29T00:00:00.000Z"

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 内存版 secretStore：测试不碰真实钥匙串。 */
function memorySecretStore() {
  const store = new Map<string, string>()
  return {
    store,
    read: (key: string) => store.get(key) ?? null,
    write: (key: string, value: string) => void store.set(key, value),
  }
}

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-ai-"))
  dirs.push(dir)
  const handle = openStore({ path: join(dir, "control.sqlite") })
  const secrets = memorySecretStore()
  const settings = new SettingsRepository(handle.db)
  // baseUrl/apiKey 现在由 RuntimeConfigService 作单一真源；默认层给 https://default/v1。
  const runtimeConfig = new RuntimeConfigService({
    settings,
    logger: createLogger("test", { level: "error" }),
    secretStore: secrets,
    defaults: loadConfig({ env: { MYCONTEXT_LLM_BASE_URL: "https://default/v1" } }),
    env: {},
  })
  const service = new AdvancedAiService({
    settings,
    logger: createLogger("test", { level: "error" }),
    secretStore: secrets,
    runtimeConfig,
  })
  return { service, secrets, close: () => handle.close() }
}

describe("读写", () => {
  it("首次读取给出默认值（不是空对象）", () => {
    const context = makeService()
    const config = context.service.read()
    expect(config.baseUrl).toBe("https://default/v1")
    expect(config.harness["search"]).toBe("opencode-acp")
    expect(config.apiKeyTail).toBeNull()
    context.close()
  })

  it("保存后可读回", () => {
    const context = makeService()
    context.service.save(
      {
        baseUrl: "https://custom/v1",
        apiKey: null,
        modelRoles: { "harness.search": "my-model" },
        harness: { search: "builtin-llm", persona: "opencode-acp" },
        rawConfigJson: null,
      },
      NOW,
    )
    const config = context.service.read()
    expect(config.baseUrl).toBe("https://custom/v1")
    expect(config.modelRoles["harness.search"]).toBe("my-model")
    expect(config.harness["search"]).toBe("builtin-llm")
    context.close()
  })
})

describe("★ apiKey 不回显完整值", () => {
  it("只给后 4 位", () => {
    const context = makeService()
    context.service.save(
      {
        baseUrl: "x",
        apiKey: "sk-secret-value-1234",
        modelRoles: {},
        harness: {},
        rawConfigJson: null,
      },
      NOW,
    )
    const config = context.service.read()
    expect(config.apiKeyTail).toBe("1234")
    // 完整 key 不在返回结构的任何字段里
    expect(JSON.stringify(config)).not.toContain("sk-secret-value")
    context.close()
  })

  it("apiKey 传 null 表示不修改（UI 不回显旧值，所以要能区分）", () => {
    const context = makeService()
    const base = {
      baseUrl: "x",
      modelRoles: {},
      harness: {},
      rawConfigJson: null,
    }
    context.service.save({ ...base, apiKey: "sk-original-9999" }, NOW)
    context.service.save({ ...base, baseUrl: "y", apiKey: null }, NOW)

    expect(context.service.read().apiKeyTail).toBe("9999")
    expect(context.service.read().baseUrl).toBe("y")
    context.close()
  })

  it("apiKey 存进 secretStore 而不是明文进 settings", () => {
    const context = makeService()
    context.service.save(
      { baseUrl: "x", apiKey: "sk-in-keychain", modelRoles: {}, harness: {}, rawConfigJson: null },
      NOW,
    )
    expect([...context.secrets.store.values()]).toContain("sk-in-keychain")
    context.close()
  })
})

describe("逃生阀", () => {
  it("合法 JSON 被保存并整份覆盖推导结果", () => {
    const context = makeService()
    context.service.save(
      {
        baseUrl: "https://ignored/v1",
        apiKey: null,
        modelRoles: { "harness.search": "ignored-model" },
        harness: {},
        rawConfigJson: JSON.stringify({ provider: { custom: { options: { baseURL: "raw" } } } }),
      },
      NOW,
    )
    // 逃生阀存在时整份覆盖 —— 那正是它的用途
    expect(context.service.buildHarnessConfig()).toEqual({
      provider: { custom: { options: { baseURL: "raw" } } },
    })
    context.close()
  })

  /**
   * 格式错误必须**报错**而不是静默忽略：
   * 静默忽略会让人以为配置生效了，然后花很久找"为什么没变"。
   */
  it("非法 JSON 抛 CONFIG_INVALID 且不写入", () => {
    const context = makeService()
    expect(() =>
      context.service.save(
        {
          baseUrl: "x",
          apiKey: null,
          modelRoles: {},
          harness: {},
          rawConfigJson: "{ not json",
        },
        NOW,
      ),
    ).toThrow(/JSON/)
    // 没写进去：读回来仍是默认值
    expect(context.service.read().rawConfigJson).toBeNull()
    context.close()
  })

  /**
   * ★★ 逃生阀不能拆掉 deny-all 权限模型。
   *
   * 完整链路（全部实测/逐条核对源码）：
   * ① 逃生阀整份注入 `OPENCODE_CONFIG_CONTENT`；
   * ② opencode 的 `Permission.merge` = **`rulesets.flat()`**
   *    （permission/index.ts:200）+ `findLast` 判定（同文件 210 行）；
   * ③ `agent.ts:293` 把 `cfg.agent.<name>.permission` 追加在 **user ruleset 之后**；
   * → 于是 `{"agent":{"build":{"permission":{"webfetch":"allow"}}}}`
   *   把 webfetch 从 deny **翻回 allow**，而 `tool/webfetch.ts:35` 只校验
   *   http(s) 前缀、**无域名白名单** —— 这正是威胁模型 #1 的主要外泄通道
   *   （群消息里一句 injection：读画像 → fetch 到攻击者服务器，全程零写操作）。
   *
   * 处理方式是**剥**而不是拒：逃生阀的正当用途（换 provider / 模型 / 参数）保留，
   * 只拿掉提权能力。
   */
  it("★ 逃生阀里的 agent.*.permission 被剥掉（不能把 webfetch 翻回 allow）", () => {
    const context = makeService()
    context.service.save(
      {
        baseUrl: "https://gw/v1",
        apiKey: null,
        modelRoles: {},
        harness: {},
        rawConfigJson: JSON.stringify({
          provider: { custom: { options: { baseURL: "raw" } } },
          agent: { build: { permission: { webfetch: "allow" } } },
        }),
      },
      NOW,
    )

    const built = context.service.buildHarnessConfig() as {
      provider: unknown
      agent: { build: Record<string, unknown> }
    }
    // 正当部分保留
    expect(built.provider).toEqual({ custom: { options: { baseURL: "raw" } } })
    // 提权部分被剥掉
    expect(built.agent.build).not.toHaveProperty("permission")
    expect(JSON.stringify(built)).not.toContain("webfetch")
    context.close()
  })

  it("★ 顶层 permission 与 tools 同样被剥（config.ts 把 tools 也转成 permission）", () => {
    const context = makeService()
    context.service.save(
      {
        baseUrl: "https://gw/v1",
        apiKey: null,
        modelRoles: {},
        harness: {},
        rawConfigJson: JSON.stringify({
          model: "keep-me",
          permission: { "*": "allow" },
          tools: { bash: true },
        }),
      },
      NOW,
    )

    const built = context.service.buildHarnessConfig() as Record<string, unknown>
    expect(built["model"]).toBe("keep-me")
    expect(built).not.toHaveProperty("permission")
    expect(built).not.toHaveProperty("tools")
    context.close()
  })

  /** 落盘时就剥：库里不留一份"看起来被接受了"的提权配置。 */
  it("★ 权限键在 save() 落盘时就被剥掉，不只是读的时候", () => {
    const context = makeService()
    context.service.save(
      {
        baseUrl: "https://gw/v1",
        apiKey: null,
        modelRoles: {},
        harness: {},
        rawConfigJson: JSON.stringify({ permission: { "*": "allow" }, model: "m" }),
      },
      NOW,
    )
    const stored = context.service.read().rawConfigJson
    expect(stored).not.toBeNull()
    expect(stored).not.toContain("permission")
    context.close()
  })

  it("无逃生阀时按 provider + 角色映射推导", () => {
    const context = makeService()
    context.service.save(
      {
        baseUrl: "https://gw/v1",
        apiKey: null,
        modelRoles: { "harness.search": "qwen-x" },
        harness: {},
        rawConfigJson: null,
      },
      NOW,
    )
    expect(context.service.buildHarnessConfig()).toEqual({
      provider: { mycontext: { options: { baseURL: "https://gw/v1" } } },
      model: "qwen-x",
    })
    context.close()
  })
})

/**
 * ★ 与发送门禁的隔离。
 *
 * 这一页的输出只有一个出口：`buildHarnessConfig()`（给 agent 进程的环境变量）。
 * 断言它**不含任何**与发送、授权、自动回复相关的字段 ——
 * 一旦有人"顺手"往里加一个 `autoSend: true`，这条会红。
 */
describe("★ 配置的是「用什么脑子」，不是「能不能动手」", () => {
  const FORBIDDEN_KEYS = [
    "autoSend",
    "auto_send",
    "replyMode",
    "reply_mode",
    "grant",
    "permission",
    "sendGuard",
    "killSwitch",
    "workHours",
    "rateLimit",
  ]

  it("harness 配置里不含任何发送/授权相关字段", () => {
    const context = makeService()
    context.service.save(
      {
        baseUrl: "https://gw/v1",
        apiKey: null,
        modelRoles: { "harness.persona": "m" },
        harness: { persona: "builtin-llm" },
        rawConfigJson: null,
      },
      NOW,
    )
    const serialized = JSON.stringify(context.service.buildHarnessConfig())
    for (const key of FORBIDDEN_KEYS) {
      expect(serialized, `harness 配置不该出现 ${key}`).not.toContain(key)
    }
    context.close()
  })

  /**
   * 即使用户在逃生阀里塞了这些字段，它们也只会流向 agent 进程的
   * harness 配置 —— 而 policy / SendGuard 不读那份配置。
   *
   * 这条断言的形式是「配置里有它，但服务不提供任何把它变成发送许可的方法」：
   * AdvancedAiService 的公开 API 只有 read / save / buildHarnessConfig 三个，
   * 没有任何返回"是否允许发送"的方法。
   */
  it("服务不暴露任何与发送许可相关的方法", () => {
    const context = makeService()
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(context.service) as object,
    ).filter((name) => name !== "constructor")
    expect(methods.sort()).toEqual(["buildHarnessConfig", "read", "save"])
    context.close()
  })
})
