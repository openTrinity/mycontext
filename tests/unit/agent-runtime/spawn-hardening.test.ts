/**
 * opencode 安全加固不可回退。
 *
 * 实测源码链路：`cli/cmd/acp.ts` 会 `Server.listen()` 起 HTTP server；
 * `server/auth.ts` 的 `required()` 在密码未设时返回 false，于是
 * `httpapi/middleware/authorization.ts` 的三处中间件**整体放行**；
 * `server/cors.ts` 对无 Origin 头 `return true`、对任意 localhost:* 放行。
 * → 本机任意进程/网页都能驱动这个 agent。
 *
 * 对一个「知道本人全部聊天记录、且宿主会替它发消息」的 agent，
 * 这是本地权限提升 —— 因此这几条断言的作用是让**回退变成红灯**：
 * 有人在重构里删掉一行注入，除了这里没有任何信号。
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  assertHardened,
  assertNoPermissionOverrides,
  buildOpencodeSpawn,
  DENY_ALL_PERMISSION,
  KL_SKILL_PERMISSION,
  HOST_TOOL_PREFIX,
  resolveGatewayModelConfig,
  resolveModelName,
  DEFAULT_GATEWAY_MODEL,
  stripPermissionOverrides,
} from "@mycontext/agent-runtime"
import { isAppError } from "@mycontext/kernel"

describe("server password", () => {
  it("每次启动生成不同的随机密码", () => {
    const first = buildOpencodeSpawn({ baseEnv: {} })
    const second = buildOpencodeSpawn({ baseEnv: {} })
    expect(first.serverPassword).not.toBe(second.serverPassword)
    // 32 字节 base64url ≈ 43 字符
    expect(first.serverPassword.length).toBeGreaterThanOrEqual(40)
  })

  it("密码注入进环境变量", () => {
    const spawn = buildOpencodeSpawn({ baseEnv: {} })
    expect(spawn.env["OPENCODE_SERVER_PASSWORD"]).toBe(spawn.serverPassword)
  })

  /**
   * ★「忘了注入」必须是**启动失败**，而不是"启动了但没鉴权" ——
   * 后者外观上完全正常（agent 照常工作），属最难发现的一类失效。
   */
  it("空密码时拒绝启动", () => {
    try {
      buildOpencodeSpawn({ baseEnv: {}, serverPassword: "" })
      expect.unreachable("应当抛错")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) expect(error.code).toBe("CONFIG_INVALID")
    }
  })

  it("assertHardened 在缺密码时报错（防重构中删掉注入）", () => {
    expect(() => assertHardened({ OPENCODE_PERMISSION: '{"*":"deny"}' })).toThrow(/password/)
    expect(() =>
      assertHardened({ OPENCODE_SERVER_PASSWORD: "", OPENCODE_PERMISSION: '{"*":"deny"}' }),
    ).toThrow()
  })
})

describe("hostname 显式传（默认值不是契约）", () => {
  it("args 含 --hostname 127.0.0.1", () => {
    const spawn = buildOpencodeSpawn({ baseEnv: {} })
    expect(spawn.args).toEqual(["acp", "--hostname", "127.0.0.1"])
  })

  it("不指定端口（随机端口比固定端口难被本机脚本猜到）", () => {
    expect(buildOpencodeSpawn({ baseEnv: {} }).args).not.toContain("--port")
  })
})

describe("★ 权限必须是白名单式 deny-all，不是 deny 列表", () => {
  /**
   * 实测 `agent/agent.ts:119` 的 defaults 是 `"*": "allow"` ——
   * 只 deny edit/bash 等于放行 webfetch，而 `tool/webfetch.ts:35`
   * 只校验 http(s) 前缀、**无域名白名单**。
   * 群消息里的一句 injection 就能「读画像 → fetch 到攻击者服务器」，
   * 全程没有一次写操作。
   */
  it("`*` 是 deny", () => {
    expect(DENY_ALL_PERMISSION["*"]).toBe("deny")
  })

  it("只放行带前缀的宿主工具", () => {
    const keys = Object.keys(DENY_ALL_PERMISSION)
    expect(keys).toContain(`${HOST_TOOL_PREFIX}*`)
    // 除了 `*` 与宿主前缀，不该有别的放行项
    expect(keys.sort()).toEqual(["*", `${HOST_TOOL_PREFIX}*`].sort())
  })

  it("注入进环境变量且是合法 JSON", () => {
    const spawn = buildOpencodeSpawn({ baseEnv: {} })
    const parsed = JSON.parse(spawn.env["OPENCODE_PERMISSION"] ?? "{}") as Record<string, string>
    expect(parsed["*"]).toBe("deny")
  })

  it("assertHardened 拒绝 deny 列表形态（`*` 不是 deny 就报错）", () => {
    expect(() =>
      assertHardened({
        OPENCODE_SERVER_PASSWORD: "x".repeat(40),
        // 这是首版的写法：只 deny 写操作 —— 挡不住 webfetch 外泄
        OPENCODE_PERMISSION: JSON.stringify({ edit: "deny", bash: "deny" }),
      }),
    ).toThrow(/白名单/)
  })

  it("完整的加固环境通过校验", () => {
    expect(() => assertHardened(buildOpencodeSpawn({ baseEnv: {} }).env)).not.toThrow()
  })
})

describe("模型配置注入", () => {
  it("有配置时写进 OPENCODE_CONFIG_CONTENT", () => {
    const spawn = buildOpencodeSpawn({ baseEnv: {}, modelConfig: { model: "test-model" } })
    expect(JSON.parse(spawn.env["OPENCODE_CONFIG_CONTENT"] ?? "{}")).toEqual({
      model: "test-model",
    })
  })

  it("无配置时不设该变量（让 opencode 用它自己的默认）", () => {
    expect(buildOpencodeSpawn({ baseEnv: {} }).env["OPENCODE_CONFIG_CONTENT"]).toBeUndefined()
  })

  it("基础环境被继承（PATH 等）", () => {
    const spawn = buildOpencodeSpawn({ baseEnv: { PATH: "/usr/bin", HOME: "/home/x" } })
    expect(spawn.env["PATH"]).toBe("/usr/bin")
    expect(spawn.env["HOME"]).toBe("/home/x")
  })
})

/**
 * ★★ 权限键不能通过注入的 config 绕过 deny-all。
 *
 * `OPENCODE_PERMISSION` 对了**不等于**权限模型生效：实测
 * `Permission.merge` = `rulesets.flat()`（permission/index.ts:200）+ `findLast`
 * （同文件 210 行），而 `agent.ts:293` 把 `cfg.agent.<name>.permission`
 * 追加在 user ruleset **之后** —— 所以注入的 config 里一条
 * `agent.build.permission.webfetch = allow` 就能把 webfetch 翻回放行，
 * 而 `tool/webfetch.ts:35` 无域名白名单（威胁模型 #1 的主要外泄通道）。
 */
describe("★ 注入的 config 不得含权限键", () => {
  it("modelConfig 带 agent.*.permission 时拒绝启动（fail-fast，不静默提权）", () => {
    expect(() =>
      buildOpencodeSpawn({
        baseEnv: {},
        modelConfig: { agent: { build: { permission: { webfetch: "allow" } } } },
      }),
    ).toThrow(/权限键/)
  })

  it("modelConfig 带顶层 permission 时同样拒绝", () => {
    expect(() =>
      buildOpencodeSpawn({ baseEnv: {}, modelConfig: { permission: { "*": "allow" } } }),
    ).toThrow(/权限键/)
  })

  it("modelConfig 带 tools 时也拒绝（config.ts:553 把 tools 转成 permission）", () => {
    expect(() =>
      buildOpencodeSpawn({ baseEnv: {}, modelConfig: { tools: { bash: true } } }),
    ).toThrow(/权限键/)
  })

  /**
   * ★ `mode` 是 `agent` 的废弃别名（schema 相同，且 config.ts:535-542
   * 会把它 merge 进 agent）—— 换这个键名不该能绕过门禁。
   */
  it("★ modelConfig 带 mode.*.permission 时也拒绝（mode 是 agent 的别名）", () => {
    expect(() =>
      buildOpencodeSpawn({
        baseEnv: {},
        modelConfig: { mode: { build: { permission: { webfetch: "allow" } } } },
      }),
    ).toThrow(/权限键/)
  })

  it("干净的 modelConfig 正常通过", () => {
    expect(() =>
      buildOpencodeSpawn({
        baseEnv: {},
        modelConfig: { model: "m", provider: { p: { options: { baseURL: "u" } } } },
      }),
    ).not.toThrow()
  })

  it("assertHardened 也查注入的 config（不只查 OPENCODE_PERMISSION）", () => {
    // 手工拼一个"密码与 deny-all 都对，但 config 里藏了提权"的环境
    const env = {
      OPENCODE_SERVER_PASSWORD: "x".repeat(40),
      OPENCODE_PERMISSION: JSON.stringify(DENY_ALL_PERMISSION),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        agent: { build: { permission: { webfetch: "allow" } } },
      }),
    }
    expect(() => assertHardened(env)).toThrow(/权限键/)
  })

  it("抛的是 CONFIG_INVALID（可被 UI 按错误码翻译）", () => {
    try {
      assertNoPermissionOverrides({ permission: {} })
      expect.unreachable("应该抛错")
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("CONFIG_INVALID")
    }
  })
})

/**
 * ★ 剥的范围**按路径限定**，不是"任意深度的 permission/tools 键"。
 *
 * 两个方向都要钉住：
 * · 少剥 = 静默提权（威胁模型 #1 的外泄通道）；
 * · 多剥 = 静默破坏逃生阀的正当用途（用户配了、没报错、就是不生效），
 *   而逃生阀存在的意义恰是不被破坏。
 */
describe("stripPermissionOverrides", () => {
  it("剥掉权限键但保留其余配置（逃生阀的正当用途不受影响）", () => {
    const { sanitized, stripped } = stripPermissionOverrides({
      model: "keep",
      provider: { p: { options: { baseURL: "u" } } },
      permission: { "*": "allow" },
      agent: { build: { model: "keep-too", permission: { webfetch: "allow" } } },
    })

    expect(sanitized).toEqual({
      model: "keep",
      provider: { p: { options: { baseURL: "u" } } },
      agent: { build: { model: "keep-too" } },
    })
    // 报出被剥的路径，供日志与 UI 提示（不静默）
    expect(stripped).toContain("permission")
    expect(stripped).toContain("agent.build.permission")
  })

  it("agent.<name>.tools 也剥（core/v1/config/agent.ts:69 把它转成 permission）", () => {
    const { sanitized, stripped } = stripPermissionOverrides({
      agent: { build: { model: "m", tools: { webfetch: true } } },
    })
    expect(sanitized).toEqual({ agent: { build: { model: "m" } } })
    expect(stripped).toContain("agent.build.tools")
  })

  /**
   * ★★ `mode` 是 `agent` 的**废弃别名**，schema 相同，
   * 而 `config.ts:535-542` 会把 `mode.<name>` merge 进 `agent.<name>`。
   *
   * 只剥 `agent.*` 的话，把键名换成 `mode` 就能绕过整道清洗 ——
   * 而那条路径在 opencode 里仍然完全有效。
   */
  it("★ mode.<name>.permission / tools 同样剥（mode 是 agent 的废弃别名）", () => {
    const { sanitized, stripped } = stripPermissionOverrides({
      mode: { build: { model: "m", permission: { webfetch: "allow" }, tools: { bash: true } } },
    })
    expect(sanitized).toEqual({ mode: { build: { model: "m" } } })
    expect(stripped).toContain("mode.build.permission")
    expect(stripped).toContain("mode.build.tools")
  })

  /**
   * ★ 不该剥的：`mcp.<name>.tools` 是 MCP server 的工具声明，不是权限配置。
   *
   * 首版按键名全深度剥除，实测把它也剥掉了 —— 用户配了一个 MCP server
   * 并声明了它的工具，我们静默把声明拿掉，表现是"那个 server 的工具都不见了"
   * 且日志里只说"剥掉了权限键"（把人往安全问题上带偏）。
   */
  it("★ 不剥 mcp.<name>.tools（那不是权限配置，剥了会静默破坏逃生阀）", () => {
    const input = {
      mcp: { myserver: { type: "local", command: ["x"], tools: { search: true } } },
    }
    const { sanitized, stripped } = stripPermissionOverrides(input)
    expect(sanitized).toEqual(input)
    expect(stripped).toEqual([])
  })

  it("不剥更深层的同名键（provider.p.options.permission 不是权限配置）", () => {
    const input = { provider: { p: { options: { permission: "whatever" } } } }
    expect(stripPermissionOverrides(input).stripped).toEqual([])
  })

  it("干净配置原样返回且 stripped 为空", () => {
    const input = { model: "m", provider: { p: {} } }
    const { sanitized, stripped } = stripPermissionOverrides(input)
    expect(sanitized).toEqual(input)
    expect(stripped).toEqual([])
  })
})

/**
 * ★ 门禁的失败必须是**显式分类拒绝**，不能是裸 SyntaxError / TypeError。
 *
 * `OPENCODE_CONFIG_CONTENT` 的内容主要来自逃生阀（用户原文 JSON），
 * 所以"畸形"是正常会发生的输入。首版直接 `JSON.parse`，畸形内容抛裸
 * `SyntaxError`（实测 `isAppError=false`）—— 那会绕过 IPC 的错误映射，
 * UI 上只能显示一个未翻译的内部错误，用户既不知道是自己填错了配置、
 * 也不知道该改哪里。
 */
describe("★ assertHardened 的失败一律是 AppError(CONFIG_INVALID)", () => {
  const validPassword = "x".repeat(40)

  it.each([
    ["OPENCODE_PERMISSION 畸形 JSON", { OPENCODE_PERMISSION: "{not json}" }],
    ["OPENCODE_PERMISSION 是 null", { OPENCODE_PERMISSION: "null" }],
    ["OPENCODE_PERMISSION 是数组", { OPENCODE_PERMISSION: "[]" }],
    ["OPENCODE_PERMISSION 是数字", { OPENCODE_PERMISSION: "3" }],
    [
      "OPENCODE_CONFIG_CONTENT 畸形 JSON",
      {
        OPENCODE_PERMISSION: JSON.stringify(DENY_ALL_PERMISSION),
        OPENCODE_CONFIG_CONTENT: '{"model":}',
      },
    ],
  ])("%s → AppError(CONFIG_INVALID) 且带 messageKey", (_label, extra) => {
    try {
      assertHardened({ OPENCODE_SERVER_PASSWORD: validPassword, ...extra })
      expect.unreachable("应该抛错")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (!isAppError(error)) return
      expect(error.code).toBe("CONFIG_INVALID")
      // messageKey 是 UI 能翻译的前提；没有它只能显示内部英文错误
      expect(error.messageKey).toBe("errors:config.invalid")
    }
  })

  it("缺密码 / 缺权限白名单也带 messageKey", () => {
    for (const env of [
      { OPENCODE_PERMISSION: JSON.stringify(DENY_ALL_PERMISSION) },
      { OPENCODE_SERVER_PASSWORD: validPassword },
    ]) {
      try {
        assertHardened(env)
        expect.unreachable("应该抛错")
      } catch (error) {
        expect(isAppError(error) && error.messageKey).toBe("errors:config.invalid")
      }
    }
  })
})

/**
 * ★ env → 网关模型配置：让 opencode 真的说话。
 *
 * 实测过的关键结论（见 resolveGatewayModelConfig 头注释）：走 openai-compatible
 * 内联 provider（不是 anthropic provider），才不依赖被墙的 models.dev 注册表。
 * 这里断言的是**形状**——真进程"能说话"由 acp-e2e 那侧锁定。
 */
describe("resolveGatewayModelConfig", () => {
  it("有 BASE_URL + AUTH_TOKEN → 内联 openai-compatible provider", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-abc",
    }) as {
      provider: Record<string, { npm: string; options: { baseURL: string; apiKey: string } }>
      model: string
      small_model: string
    }
    const provider = config.provider["mycontext"]
    expect(provider?.npm).toBe("@ai-sdk/openai-compatible")
    // ★ baseURL 必须补 /v1（网关根不含它）——实测缺 /v1 时 0-token 静默失败。
    expect(provider?.options.baseURL).toBe("https://gw.example.com/v1")
    // ★ AUTH_TOKEN 转成 provider 的 apiKey（本机没有 ANTHROPIC_API_KEY）。
    expect(provider?.options.apiKey).toBe("sk-abc")
    expect(config.model).toBe("mycontext/claude-sonnet-4-6")
    expect(config.small_model).toBe("mycontext/claude-sonnet-4-6")
  })

  it("base 已带 /v1 时不重复拼", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "https://gw.example.com/v1",
      ANTHROPIC_AUTH_TOKEN: "sk-abc",
    }) as { provider: Record<string, { options: { baseURL: string } }> }
    expect(config.provider["mycontext"]?.options.baseURL).toBe("https://gw.example.com/v1")
  })

  /**
   * ★★ 模型声明必须含 `modalities.input: ["text","image"]`。
   *
   * ## 这一条守的是「数字分身读不了图」的根因
   *
   * opencode 靠这个字段判断模型能不能收图（二进制里
   * `input:{text:!0,audio:!1,image:X,…}`，`X` 就来自这里）。不给 → 默认
   * false → 图在"转成模型请求"那一步被丢掉，**无论**它是 prompt 里的
   * image block 还是 `read` 工具读出的 attachment。
   *
   * ★ 失效方式是**模型自己说**「当前模型不支持图片输入」—— 而那句话不在
   * opencode 的二进制里（搜过），所以看起来像模型的限制，把人引向"换个模型"；
   * 同一个模型经直连（`LlmClient`）能读出同一张图。这就是为什么要在
   * 单测里锁住这个字段：真正的证据（真进程看到图）只在 externals 里，
   * 而那条不在默认门禁里。
   *
   * 实测：去掉这一行 → externals 那条回「不支持图像输入」；加上 → 回 `VZ7QK`。
   */
  it("★★ 模型声明含 modalities.input 含 image（否则 agent 看不到图）", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-abc",
    }) as {
      provider: Record<
        string,
        { models: Record<string, { modalities?: { input?: string[]; output?: string[] } }> }
      >
    }
    const model = config.provider["mycontext"]?.models["claude-sonnet-4-6"]
    expect(model?.modalities?.input, "缺 image 时图会被静默丢掉").toContain("image")
    // 文本当然也要留着 —— 只写 image 会让纯文本那条路一起坏掉
    expect(model?.modalities?.input).toContain("text")
    expect(model?.modalities?.output).toContain("text")
  })

  it("★ 覆盖模型时 modalities 一起跟上（不是只给默认模型加）", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-abc",
      MYCONTEXT_MODEL_MAIN: "gpt-5.6-sol",
    }) as {
      provider: Record<string, { models: Record<string, { modalities?: { input?: string[] } }> }>
    }
    /**
     * ★ 反证：如果 modalities 被写死在 `"claude-sonnet-4-6"` 这个键上，
     * 换模型时这里就是 undefined —— 而那正好是"换个模型试试"最可能发生的
     * 场景（用户看到"不支持图片"的提示就会去换）。
     */
    expect(config.provider["mycontext"]?.models["gpt-5.6-sol"]?.modalities?.input).toContain(
      "image",
    )
  })

  it("ANTHROPIC_API_KEY 作为 AUTH_TOKEN 的兼容回退", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_API_KEY: "sk-fallback",
    }) as { provider: Record<string, { options: { apiKey: string } }> }
    expect(config.provider["mycontext"]?.options.apiKey).toBe("sk-fallback")
  })

  it("MYCONTEXT_MODEL_MAIN 覆盖默认模型", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-abc",
      MYCONTEXT_MODEL_MAIN: "claude-opus-4-6",
    }) as { model: string }
    expect(config.model).toBe("mycontext/claude-opus-4-6")
  })

  /**
   * ★★ 显式传入的模型优先于 env。
   *
   * 这一条锁的是「设置页改了模型立刻生效」。`seedProcessEnv` 只在装配阶段写
   * 一次 `process.env`，而 opencode 是懒启动的 —— 用户改完设置之后子进程才
   * spawn，读到的是那份**旧快照**。所以装配层必须能把 `resolved().modelMain`
   * 显式传进来并**盖过** env。
   *
   * 这条红了的表现是最难查的一类：改了模型、日志也不报错、只是还在用旧的。
   */
  it("★★ 显式传入的模型优先于 env（否则「改了设置不生效」）", () => {
    const config = resolveGatewayModelConfig(
      {
        ANTHROPIC_BASE_URL: "https://gw.example.com",
        ANTHROPIC_AUTH_TOKEN: "sk-abc",
        MYCONTEXT_MODEL_MAIN: "stale-from-env",
      },
      "fresh-from-settings",
    ) as { model: string }
    expect(config.model).toBe("mycontext/fresh-from-settings")
  })

  /**
   * ★ 空串不算"给了值" —— 三档都是这条判据。
   *
   * env 里 `KEY=` 占位很常见，设置里也可能存了个空串。用 `??` 的话空串会被
   * 当成有效模型名拼进 `mycontext/`，opencode 拿着一个空模型 id 去解析，
   * 表现又是那条最难查的"session/prompt 永不返回"（见函数头注释）。
   */
  it("★ 空串的 override / env 都不算有效值（回退到下一档）", () => {
    const base = {
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-abc",
    }
    // override 是空串 → 落到 env
    expect(
      (
        resolveGatewayModelConfig({ ...base, MYCONTEXT_MODEL_MAIN: "from-env" }, "   ") as {
          model: string
        }
      ).model,
    ).toBe("mycontext/from-env")
    // override 与 env 都空 → 落到内置默认
    expect(
      (resolveGatewayModelConfig({ ...base, MYCONTEXT_MODEL_MAIN: "" }, "") as { model: string })
        .model,
    ).toBe(`mycontext/${DEFAULT_GATEWAY_MODEL}`)
  })

  /**
   * ★★ 日志与实际用的模型必须同源。
   *
   * `search.service.ts` 要把"用了哪个模型"写进日志，而它走的是同一个
   * `resolveModelName`。各写一份优先级的话两处会漂移 —— 而漂移的表现是
   * 日志报的模型与实际用的不是一个，那比不报更糟（把排查引向错误方向）。
   */
  it("★★ resolveModelName 与 resolveGatewayModelConfig 给出同一个模型", () => {
    const env = {
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-abc",
      MYCONTEXT_MODEL_MAIN: "env-model",
    }
    for (const override of [undefined, "explicit-model", ""]) {
      const config = resolveGatewayModelConfig(env, override) as { model: string }
      expect(config.model, `override=${JSON.stringify(override)}`).toBe(
        `mycontext/${resolveModelName(env, override)}`,
      )
    }
  })

  it("缺 BASE_URL 或 TOKEN → null（调用方据此降级）", () => {
    expect(resolveGatewayModelConfig({ ANTHROPIC_AUTH_TOKEN: "sk-abc" })).toBeNull()
    expect(resolveGatewayModelConfig({ ANTHROPIC_BASE_URL: "https://gw" })).toBeNull()
    expect(resolveGatewayModelConfig({})).toBeNull()
  })

  /**
   * ★ 回退到 `MYCONTEXT_LLM_*`：**它们本来就是同一个网关**。
   *
   * 这组守的是一次真实事故：`.env.example` 里只有 `MYCONTEXT_LLM_*`，
   * 同事照着配完，搜索 100% 不可用 —— 因为解析只认 `ANTHROPIC_*`，
   * 拿不到就退回 opencode 默认 provider 去查被墙的 models.dev，
   * 表现是 `session/prompt` 永不返回、满 120 秒超时，日志里看不出缺密钥。
   *
   * 让人为同一个网关配两遍是纯重复劳动，所以在这里转名。
   */
  it("只配 MYCONTEXT_LLM_* 也能用（同一个网关，不必配两遍）", () => {
    const config = resolveGatewayModelConfig({
      MYCONTEXT_LLM_BASE_URL: "https://llmapi.example.com",
      MYCONTEXT_LLM_API_KEY: "sk-mycontext",
    }) as {
      provider: Record<string, { options: { baseURL: string; apiKey: string } }>
    }
    expect(config).not.toBeNull()
    expect(config.provider["mycontext"]?.options.baseURL).toBe("https://llmapi.example.com/v1")
    expect(config.provider["mycontext"]?.options.apiKey).toBe("sk-mycontext")
  })

  it("ANTHROPIC_* 优先级高于 MYCONTEXT_LLM_*（可单独给搜索指网关）", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "https://anthropic-gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-anthropic",
      MYCONTEXT_LLM_BASE_URL: "https://llmapi.example.com",
      MYCONTEXT_LLM_API_KEY: "sk-mycontext",
    }) as { provider: Record<string, { options: { baseURL: string; apiKey: string } }> }
    expect(config.provider["mycontext"]?.options.baseURL).toBe(
      "https://anthropic-gw.example.com/v1",
    )
    expect(config.provider["mycontext"]?.options.apiKey).toBe("sk-anthropic")
  })

  it("base 与 key 可以来自不同来源（混配也成立）", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      MYCONTEXT_LLM_API_KEY: "sk-mycontext",
    }) as { provider: Record<string, { options: { baseURL: string; apiKey: string } }> }
    expect(config.provider["mycontext"]?.options.baseURL).toBe("https://gw.example.com/v1")
    expect(config.provider["mycontext"]?.options.apiKey).toBe("sk-mycontext")
  })

  /**
   * ★ 空字符串不算"配了"。
   *
   * `.env.example` 里的占位就是 `MYCONTEXT_LLM_API_KEY=`（空值），照抄之后
   * env 里那个键**存在但为空**。用 `??` 取值会把空串当有效值传给 provider，
   * 最后表现为"配了但认证失败"—— 比直接判缺失更难查。
   */
  it("空串/纯空白当作没配（.env 里的占位不该被当成有效值）", () => {
    expect(
      resolveGatewayModelConfig({
        MYCONTEXT_LLM_BASE_URL: "https://llmapi.example.com",
        MYCONTEXT_LLM_API_KEY: "",
      }),
    ).toBeNull()
    expect(
      resolveGatewayModelConfig({
        ANTHROPIC_BASE_URL: "   ",
        ANTHROPIC_AUTH_TOKEN: "sk-abc",
      }),
    ).toBeNull()
  })

  it("空的 ANTHROPIC_* 会回退到有值的 MYCONTEXT_LLM_*（占位不挡路）", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
      MYCONTEXT_LLM_BASE_URL: "https://llmapi.example.com",
      MYCONTEXT_LLM_API_KEY: "sk-mycontext",
    }) as { provider: Record<string, { options: { baseURL: string; apiKey: string } }> }
    expect(config.provider["mycontext"]?.options.apiKey).toBe("sk-mycontext")
  })

  it("产物能过 assertNoPermissionOverrides（不含提权键）", () => {
    const config = resolveGatewayModelConfig({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-abc",
    })
    expect(() => assertNoPermissionOverrides(config)).not.toThrow()
    // 且能被 buildOpencodeSpawn 接受（注入前门禁不拒）。
    expect(() =>
      buildOpencodeSpawn({ baseEnv: { PATH: "/usr/bin" }, modelConfig: config }),
    ).not.toThrow()
  })
})

/**
 * ★ 精确放行 `kl` 命令（不放开 bash）—— M5 的安全形状。
 *
 * 这里断言的是**我们发出的形状**；「真 opencode 照办（kl 允许、非 kl 拒绝）」
 * 由 tests/externals/opencode-permission.test.ts 的真进程断言锁定。
 */
describe("KL_SKILL_PERMISSION（精确放行 kl）", () => {
  it("`*` 仍是 deny（白名单式，assertHardened 通过）", () => {
    expect(KL_SKILL_PERMISSION["*"]).toBe("deny")
    const spawn = buildOpencodeSpawn({ baseEnv: {}, allowKlCommand: true })
    expect(() => assertHardened(spawn.env)).not.toThrow()
  })

  it("bash 是按命令 glob 的对象：`*` deny，kl / kl * allow", () => {
    const bash = KL_SKILL_PERMISSION.bash as Record<string, string>
    expect(bash["*"]).toBe("deny")
    expect(bash["kl"]).toBe("allow")
    expect(bash["kl *"]).toBe("allow")
    // ★ findLast 语义：`"*":"deny"` 必须排在具体放行之前（对象键序）。
    const keys = Object.keys(bash)
    expect(keys.indexOf("*")).toBeLessThan(keys.indexOf("kl"))
  })

  it("skill 工具放行（否则发现了 kl skill 也调不动）", () => {
    expect(KL_SKILL_PERMISSION.skill).toBe("allow")
  })

  it("不放开整个 bash（bash 不是字符串 'allow'）", () => {
    expect(typeof KL_SKILL_PERMISSION.bash).toBe("object")
  })

  it("allowKlCommand 默认关：纯 deny-all", () => {
    const spawn = buildOpencodeSpawn({ baseEnv: {} })
    const parsed = JSON.parse(spawn.env["OPENCODE_PERMISSION"] ?? "{}") as Record<string, unknown>
    expect(parsed["bash"]).toBeUndefined()
    expect(parsed["skill"]).toBeUndefined()
    expect(parsed).toEqual(DENY_ALL_PERMISSION)
  })

  it("allowKlCommand 开：注入 KL_SKILL_PERMISSION", () => {
    const spawn = buildOpencodeSpawn({ baseEnv: {}, allowKlCommand: true })
    const parsed = JSON.parse(spawn.env["OPENCODE_PERMISSION"] ?? "{}") as Record<string, unknown>
    expect(parsed["skill"]).toBe("allow")
    expect((parsed["bash"] as Record<string, string>)["kl"]).toBe("allow")
  })
})

/**
 * ★ HOME 隔离：搜索 agent 只该看得到我们铺的 kl skill。
 *
 * 这组守的是一个真实的隔离漏洞：env 原来是把整个 `process.env` 原样拷过去的，
 * `HOME` 因此被继承 —— 而 opencode 从 `$HOME/.claude/skills` 发现 skill，于是
 * 用户自己装的**全部** skill 都进了搜索 agent 的视野（真进程实测泄漏 8 个，
 * 其中一个正是专门用来检测隔离失效的探针 `test-leak-skill`）。
 *
 * 真进程实测过四组，只有「HOME 换隔离目录 + XDG_DATA_HOME 指回真实
 * ~/.local/share」既隔离干净、又保住 `session/resume`（session 存储在
 * `~/.local/share/opencode`，搬走会让每轮 resume 失败 → 持续重建 + 回灌，
 * 正是刚修掉的那个"首字慢/自问自答"bug 的成因）。
 */
describe("HOME 隔离（skill 不泄漏）", () => {
  it("给了 agentHome：HOME 与 XDG_CONFIG_HOME 都指进隔离区", () => {
    const spawn = buildOpencodeSpawn({
      baseEnv: { HOME: "/Users/real" },
      agentHome: "/data/agent-home",
    })
    expect(spawn.env["HOME"]).toBe("/data/agent-home")
    expect(spawn.env["XDG_CONFIG_HOME"]).toBe("/data/agent-home/.config")
  })

  it("★ XDG_DATA_HOME 指回真实 HOME —— 否则 session/resume 全灭", () => {
    const spawn = buildOpencodeSpawn({
      baseEnv: { HOME: "/Users/real" },
      agentHome: "/data/agent-home",
    })
    expect(spawn.env["XDG_DATA_HOME"]).toBe("/Users/real/.local/share")
  })

  it("已显式设了 XDG_DATA_HOME 时不覆盖（尊重部署方的选择）", () => {
    const spawn = buildOpencodeSpawn({
      baseEnv: { HOME: "/Users/real", XDG_DATA_HOME: "/custom/data" },
      agentHome: "/data/agent-home",
    })
    expect(spawn.env["XDG_DATA_HOME"]).toBe("/custom/data")
  })

  it("不给 agentHome：保持继承（非搜索场景不强加隔离）", () => {
    const spawn = buildOpencodeSpawn({ baseEnv: { HOME: "/Users/real" } })
    expect(spawn.env["HOME"]).toBe("/Users/real")
    expect(spawn.env["XDG_CONFIG_HOME"]).toBeUndefined()
  })
})

/**
 * ★ 屏蔽用户本地 opencode 污染源。
 *
 * ## 为什么 EXTERNAL_SKILLS 那条必须无条件注
 *
 * 实测 opencode 源码（`~/gits/opencode/packages/opencode/src/skill/index.ts:186-203`）：
 * skill 扫描除了 `Global.home/.claude/skills`（那条由 HOME 隔离挡）**还沿文件
 * 系统父目录 findUp**。workspace 在 `<userData>/agents/persona/<id>`，向上到 `/`
 * 会经过 `/Users/<user>/`，命中 `~/.claude/skills` / `~/.agents/skills`
 * （本机实测 `~/.agents/skills/find-skills` 就存在）—— HOME 换成隔离目录
 * **不改变文件系统**，findUp 挡不住。
 *
 * 唯一稳妥的挡法：从 opencode 的 skill 扫描逻辑里跳过它 ——
 * `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`。
 *
 * ## ★★ 为什么 `OPENCODE_DISABLE_PROJECT_CONFIG` **刻意不注**
 *
 * 它看起来正好挡住 project 侧 `opencode.json` 的 findUp，但源码里它**顺带
 * 把 `AGENTS.md` 的加载也关掉了**：`session/instruction.ts:81` 与 `:123`
 * 两处都在 `if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG)` 里 findUp `AGENTS.md`，
 * 置位后只从 `global.config` 找。
 *
 * 而 `<cwd>/AGENTS.md` 是我们唯一的会话身份入口（会话标题、授权模式、
 * personaNote、`{reply,holdForReview,reviewReason}` 输出协议）。注了它等于
 * 整份丢掉，而且**不报错** —— agent 仍然回答，只是不知道在替谁说话、
 * 也不遵守协议。所以这一条断言的是"**没有**被注"。
 */
describe("★ 屏蔽用户本地 opencode 配置与外部 skill", () => {
  it("★★ 无条件注 OPENCODE_DISABLE_EXTERNAL_SKILLS=1（即使不给 agentHome）", () => {
    // 这条是**唯一**能挡住 findUp 到 ~/.claude/skills 与 ~/.agents/skills 的方法
    const spawn = buildOpencodeSpawn({ baseEnv: {} })
    expect(spawn.env["OPENCODE_DISABLE_EXTERNAL_SKILLS"]).toBe("1")
  })

  it("★★ **不许**注 OPENCODE_DISABLE_PROJECT_CONFIG —— 它会连 AGENTS.md 一起关掉", () => {
    /**
     * 反面断言，锁的是一次真实的回归：我曾为了挡 project opencode.json 注了它，
     * 结果 `session/instruction.ts` 里 `AGENTS.md` 的 findUp 也在同一个 flag
     * 后面，于是会话身份整份丢失（externals 的哨兵串用例当场变红）。
     *
     * 这条断言让"有人又把它加回来"变成红灯 —— 否则那个回归是静默的。
     */
    const spawn = buildOpencodeSpawn({ baseEnv: {} })
    expect(spawn.env["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBeUndefined()
  })

  it("★ agentHome 存在时**仍**注 EXTERNAL_SKILLS（不是二选一）", () => {
    // agentHome 只挡 global.home 那条；父目录 findUp 与它无关
    const spawn = buildOpencodeSpawn({ baseEnv: {}, agentHome: "/data/agent-home" })
    expect(spawn.env["OPENCODE_DISABLE_EXTERNAL_SKILLS"]).toBe("1")
    // 且 HOME 也换了（外部 skill 双保险 —— 环境有一层，扫描逻辑有另一层）
    expect(spawn.env["HOME"]).toBe("/data/agent-home")
  })

  it("★ baseEnv 里的 OPENCODE_DISABLE_EXTERNAL_SKILLS 会被我们覆盖（不允许被关掉）", () => {
    // 用户环境万一显式设了 =0 也不能让 agent 读到外部 skill —— 我们的注入必须**赢**
    const spawn = buildOpencodeSpawn({
      baseEnv: { OPENCODE_DISABLE_EXTERNAL_SKILLS: "0" },
    })
    expect(spawn.env["OPENCODE_DISABLE_EXTERNAL_SKILLS"]).toBe("1")
  })

  it("★ 用户 baseEnv 里的 OPENCODE_DISABLE_PROJECT_CONFIG 原样保留（我们不管它）", () => {
    /**
     * 我们不注它，也不清它 —— 那是用户自己的选择。真要设，AGENTS.md
     * 失效的后果由他自己承担（而我们的默认路径不受影响）。
     */
    const spawn = buildOpencodeSpawn({
      baseEnv: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    })
    expect(spawn.env["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1")
  })
})

/**
 * ★★ 旧的 `MYCONTEXT_SEARCH_MODEL` 不得有任何**读取点**。
 *
 * ## 为什么用 grep 而不是一条行为断言
 *
 * 统一模型名这件事的失败方式是「改了一处漏一处」：漏掉的那处仍然读旧变量，
 * 而旧变量**没有任何人 seed 它** —— 于是那条路悄悄退回写死的兜底默认值。
 * 没有报错、没有日志，只是某一条链路用的模型与其他链路不同，
 * 而症状（"这里的回复风格不一样"）离原因隔了好几层。
 *
 * 行为断言只能覆盖到我想得到的调用点；扫源码能覆盖到**我没想到的那个**。
 * 与 `check:kl-skill-sync` 那类门禁同一个思路：让"漏了一处"变成红灯。
 *
 * 注释与文档里可以留（那是在解释历史），所以只拦真正的读取形态
 * `env["MYCONTEXT_SEARCH_MODEL"]` / `env.MYCONTEXT_SEARCH_MODEL`。
 */
describe("★★ 模型名统一：旧变量不再被读", () => {
  it("★★ 仓库源码里没有 MYCONTEXT_SEARCH_MODEL 的读取点", () => {
    const roots = ["apps", "packages", "scripts"]
    const offenders: string[] = []
    // `env["KEY"]` / `env.KEY` / `process.env["KEY"]` —— 读取的三种写法
    const readPattern = /(?:\[\s*["']MYCONTEXT_SEARCH_MODEL["']\s*\]|\.MYCONTEXT_SEARCH_MODEL\b)/

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".tsbuild" || entry.name === "out") {
          continue
        }
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue
        const text = readFileSync(full, "utf8")
        for (const [index, line] of text.split("\n").entries()) {
          if (readPattern.test(line)) offenders.push(`${full}:${String(index + 1)}`)
        }
      }
    }
    for (const root of roots) walk(root)

    expect(offenders, "这些位置仍在读旧变量，会悄悄用另一个模型").toEqual([])
  })
})
