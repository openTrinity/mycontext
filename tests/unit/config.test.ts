import { describe, expect, it } from "vitest"
import { loadConfig, toConfigView } from "@mycontext/kernel"

describe("配置装载优先级", () => {
  it("无任何输入时全部取内置默认", () => {
    const loaded = loadConfig()
    expect(loaded.values.logLevel).toBe("info")
    expect(loaded.values.modelMain).toBe("glm-5.2")
    expect(loaded.meta.logLevel.source).toBe("default")
  })

  it(".env 覆盖默认值", () => {
    const loaded = loadConfig({ dotenv: { MYCONTEXT_LOG_LEVEL: "debug" } })
    expect(loaded.values.logLevel).toBe("debug")
    expect(loaded.meta.logLevel.source).toBe("dotenv")
  })

  it("真实环境变量优先于 .env", () => {
    const loaded = loadConfig({
      dotenv: { MYCONTEXT_LLM_BASE_URL: "https://from-dotenv.example" },
      env: { MYCONTEXT_LLM_BASE_URL: "https://from-env.example" },
    })
    expect(loaded.values.llmBaseUrl).toBe("https://from-env.example")
    expect(loaded.meta.llmBaseUrl.source).toBe("env")
  })

  it("空字符串视为未设置，不覆盖默认值", () => {
    const loaded = loadConfig({
      dotenv: { MYCONTEXT_MODEL_MAIN: "" },
      env: { MYCONTEXT_MODEL_MAIN: "   " },
    })
    expect(loaded.values.modelMain).toBe("glm-5.2")
    expect(loaded.meta.modelMain.source).toBe("default")
  })

  it("布尔项接受常见的假值写法", () => {
    for (const raw of ["0", "false", "no", "off"]) {
      expect(loadConfig({ env: { MYCONTEXT_DEV_TOOLS: raw } }).values.devTools).toBe(false)
    }
    for (const raw of ["1", "true", "yes"]) {
      expect(loadConfig({ env: { MYCONTEXT_DEV_TOOLS: raw } }).values.devTools).toBe(true)
    }
  })

  it("非法枚举值直接报错，不静默回退", () => {
    expect(() => loadConfig({ env: { MYCONTEXT_LOG_LEVEL: "verbose" } })).toThrow(/配置校验失败/)
  })
})

describe("配置视图脱敏", () => {
  it("敏感项不暴露明文，只暴露是否已配置", () => {
    const loaded = loadConfig({ env: { MYCONTEXT_LLM_API_KEY: "sk-super-secret-value" } })
    const view = toConfigView(loaded)
    const apiKey = view.find((entry) => entry.key === "llmApiKey")

    expect(apiKey?.sensitive).toBe(true)
    expect(apiKey?.value).toBeNull()
    expect(apiKey?.configured).toBe(true)
    // 整个视图序列化后都不应出现密钥明文。
    expect(JSON.stringify(view)).not.toContain("sk-super-secret-value")
  })

  it("未配置的敏感项标记为未配置", () => {
    const apiKey = toConfigView(loadConfig()).find((entry) => entry.key === "llmApiKey")
    expect(apiKey?.configured).toBe(false)
  })

  it("非敏感项正常暴露值", () => {
    const view = toConfigView(loadConfig({ env: { MYCONTEXT_MODEL_MAIN: "qwen3.7-max" } }))
    expect(view.find((entry) => entry.key === "modelMain")?.value).toBe("qwen3.7-max")
  })
})

describe("开发服务器端口", () => {
  it("默认不是 Vite 的 5173（避免与其他项目相撞）", () => {
    const loaded = loadConfig()
    expect(loaded.values.devPort).toBe(5273)
    expect(loaded.values.devPort).not.toBe(5173)
  })

  it("可由 .env 或环境变量覆盖，并解析为数字", () => {
    expect(loadConfig({ dotenv: { MYCONTEXT_DEV_PORT: "6100" } }).values.devPort).toBe(6100)
    const overridden = loadConfig({
      dotenv: { MYCONTEXT_DEV_PORT: "6100" },
      env: { MYCONTEXT_DEV_PORT: "7200" },
    })
    expect(overridden.values.devPort).toBe(7200)
    expect(overridden.meta.devPort.source).toBe("env")
  })

  it("非法端口直接报错而不是静默回退", () => {
    expect(() => loadConfig({ env: { MYCONTEXT_DEV_PORT: "not-a-port" } })).toThrow(/配置校验失败/)
    expect(() => loadConfig({ env: { MYCONTEXT_DEV_PORT: "80" } })).toThrow(/配置校验失败/)
    expect(() => loadConfig({ env: { MYCONTEXT_DEV_PORT: "70000" } })).toThrow(/配置校验失败/)
  })
})
