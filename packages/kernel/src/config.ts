/**
 * 应用配置：schema + 三层装载 + 来源标记。
 *
 * 装载优先级（后者覆盖前者）：
 *   1. 内置默认（保证零配置可启动）
 *   2. .env 文件（仅开发态，由调用方读入后传进来）
 *   3. 真实环境变量（最高优先级）
 *
 * 每一项都带 source，UI 可以显示「此项由环境变量注入」，
 * 便于排查「我改了 .env 为什么没生效」这类问题。
 */
import { z } from "zod"
import { AppError } from "./errors.js"
import { LOG_LEVELS } from "./logger.js"

export const CONFIG_SOURCES = ["default", "dotenv", "env"] as const
export type ConfigSource = (typeof CONFIG_SOURCES)[number]

/** 配置项定义：环境变量名 → 配置字段。 */
interface ConfigDefinition {
  env: string
  /** 内置默认值（字符串形态，由 coerce 转成目标类型） */
  default: string
  sensitive: boolean
}

const DEFINITIONS = {
  logLevel: { env: "MYCONTEXT_LOG_LEVEL", default: "info", sensitive: false },
  dataDir: { env: "MYCONTEXT_DATA_DIR", default: "", sensitive: false },
  devTools: { env: "MYCONTEXT_DEV_TOOLS", default: "0", sensitive: false },
  devPort: { env: "MYCONTEXT_DEV_PORT", default: "5273", sensitive: false },
  /**
   * DWS 渠道号（上游的 `channelCode`，走 `x-dws-channel` 请求头）。
   *
   * ## ★ 缺省为空 —— 开源发布不能带渠道号
   *
   * 渠道号是**分发方标识**，不是功能开关。它绑定的是「哪个渠道被某个组织
   * 授权」，把它写进公开仓库既没有意义（别人不该以我们的渠道身份调用），
   * 也不安全。所以默认值是空串，由分发方按需注入。
   *
   * ## 空值到底会怎样（实测 + 读上游源码，2026-08-04）
   *
   * 上游三处读它，**全部对「空串」与「未设置」走同一分支**：
   * `runner.go` / `oauth_helpers.go` 都是 `if v := os.Getenv(...); v != ""`
   * —— 空值只是**不发那个请求头**，不是错误。
   *
   * 真正决定「要不要渠道号」的是**服务端对该组织的配置**
   * （`classifyDenialReason`：只有 `channelScope == "specified"` 时，
   * 空渠道号才被判 `channel_required`；`channelScope == "all"` 时无所谓）。
   *
   * 实测本组织（channelScope=all）：11 条读命令在**完全不设**渠道号时
   * 全部 success，且数据量与设了渠道号时**逐项相同**
   * （未读 12=12、`list-all` 50 条/6 会话=50 条/6 会话）。
   *
   * 所以校验**不能**用 `min(1)`：那会让「没配渠道号」变成启动即
   * CONFIG_INVALID，而实际上不配是完全可用的默认姿态。
   * 组织若真被限定了渠道，症状是授权阶段的 `channel_required`
   * （有明确原因码，不是静默失效），那时再注入。
   */
  dwsChannel: {
    env: "MYCONTEXT_DWS_CHANNEL",
    default: "",
    sensitive: false,
  },
  /**
   * 自备 dws 可执行文件的路径（或它所在的目录）。**优先于随包那份。**
   *
   * 随包分发的是开源版（npm 依赖 `dingtalk-workspace-cli`）；闭源版不随仓库
   * 分发，只能由用户自己装好再指路径。两个入口是等价的：
   * · 这个变量 / `.env`（开发与 CI 用，不必碰 UI）；
   * · UI 上填（落 `control.sqlite`，见 desktop 的 dws-source service）。
   *
   * ★ 与 UI 值的优先级：**UI 值优先**。理由是"最后一次显式操作"应该生效 ——
   * 用户在界面上改完却被一个几个月前写在 `.env` 里的值盖住，那是无从排查的。
   * UI 上清空即退回本变量，本变量也空则退回随包那份（见 dws-source service）。
   *
   * 与脚本侧的 `MYCONTEXT_DWS_SOURCE` 同名同义（scripts/lib/dws-resolver.mjs），
   * 所以 `.env` 里写一次，`pnpm prepare:bin` 与应用运行时都认。
   */
  dwsSource: {
    env: "MYCONTEXT_DWS_SOURCE",
    default: "",
    sensitive: false,
  },
  llmBaseUrl: { env: "MYCONTEXT_LLM_BASE_URL", default: "", sensitive: false },
  llmApiKey: { env: "MYCONTEXT_LLM_API_KEY", default: "", sensitive: true },
  modelMain: { env: "MYCONTEXT_MODEL_MAIN", default: "glm-5.2", sensitive: false },
  /**
   * 主模型访问网关用的协议（litellm 传输）。
   *
   * ★ 默认 `openai`（OpenAI 兼容口，绝大多数网关都讲）。opencode 子进程与直连
   * `LlmClient` 都按它切传输：anthropic → `/v1/messages`（`@ai-sdk/anthropic`），
   * openai → `/v1/chat/completions`（`@ai-sdk/openai-compatible`）。
   * 用户在设置里改，或用 `MYCONTEXT_MODEL_PROVIDER=anthropic` 覆盖。
   */
  modelProvider: { env: "MYCONTEXT_MODEL_PROVIDER", default: "openai", sensitive: false },
  embedModel: { env: "MYCONTEXT_EMBED_MODEL", default: "text-embedding-v4", sensitive: false },
  /**
   * 嵌入（embedding）网关，独立于主 LLM 网关。
   *
   * ★ 默认派生自主 LLM 网关；个别网关（如 StepFun）没有 embedding 端点时，
   * 用它单独指向一个 OpenAI 兼容的嵌入服务。值应带恰好一个 /v1。
   */
  embedBaseUrl: { env: "MYCONTEXT_EMBED_BASE_URL", default: "", sensitive: false },
  /**
   * 嵌入网关的 key。独立 embedding 网关（MYCONTEXT_EMBED_BASE_URL）时必填；
   * 空 = 与 LLM 网关共用一把 key（原行为）。
   */
  embedApiKey: { env: "MYCONTEXT_EMBED_API_KEY", default: "", sensitive: true },
  /**
   * KL（知识图谱）建索引专用的网关。留空则回退主配置（见 RuntimeConfigService）。
   *
   * ★ 单独一路的理由：换主模型时不该顺带把 kl 的抽取也换坏（历史上只有部分模型能在
   * 中文上抽出 facts）。默认全空（回退主配置），高级用户要单独指网关/模型时才填。
   */
  klLlmBaseUrl: { env: "MYCONTEXT_KL_LLM_BASE_URL", default: "", sensitive: false },
  klLlmApiKey: { env: "MYCONTEXT_KL_LLM_API_KEY", default: "", sensitive: true },
  klModelMain: { env: "MYCONTEXT_KL_MODEL_MAIN", default: "", sensitive: false },
  /**
   * KL 抽取访问网关用的协议（litellm 传输）。
   *
   * ★ 默认 `openai` —— 这是本项目与 kl-graph 自身默认（`anthropic`）**故意的分歧**：
   * kl-graph 给上游用户保守默认成 anthropic，而 MyContext 随包/常见网关是 OpenAI 兼容
   * 口（如 `…/compatible-mode/v1`）。桌面端不设这个值时，kl 会用它自己的默认 `anthropic`
   * 去发 `/v1/messages` → 对 OpenAI 兼容网关 404（真实踩过的报错）。所以这里默认断言
   * openai，并经 `KlGatewayConfig.llmProvider` → `KL_LLM_PROVIDER` 传给 kl；用户要走
   * anthropic 网关时在设置里改，或用 `MYCONTEXT_KL_PROVIDER=anthropic` 覆盖。
   */
  klProvider: { env: "MYCONTEXT_KL_PROVIDER", default: "openai", sensitive: false },
} satisfies Record<string, ConfigDefinition>

export type ConfigKey = keyof typeof DEFINITIONS

export const appConfigSchema = z.object({
  logLevel: z.enum(LOG_LEVELS),
  dataDir: z.string(),
  devTools: z.boolean(),
  devPort: z.number().int().min(1024).max(65535),
  // ★ 刻意**不加** min(1)：空渠道号是可用的默认姿态（见 DEFINITIONS 里的长注释），
  // 加了会让开源发布（不带渠道号）启动即 CONFIG_INVALID。
  dwsChannel: z.string(),
  // 同理：空 = 用随包那份，是绝大多数人的姿态。
  dwsSource: z.string(),
  llmBaseUrl: z.string(),
  llmApiKey: z.string(),
  modelMain: z.string().min(1),
  modelProvider: z.enum(["openai", "anthropic"]),
  embedModel: z.string().min(1),
  // 嵌入网关：可空（空 = 派生自主 LLM 网关）。
  embedBaseUrl: z.string(),
  // 嵌入网关 key：可空（空 = 与 LLM 网关共用）。
  embedApiKey: z.string(),
  klLlmBaseUrl: z.string(),
  klLlmApiKey: z.string(),
  // KL 三项都可留空（回退主配置），所以模型这项**不**加 min(1)。
  klModelMain: z.string(),
  // 协议只有两个合法值。内联写死不引 ipc-contract（那是错误的依赖方向）——
  // 两个 2 值枚举保持一致，漂移风险低。
  klProvider: z.enum(["openai", "anthropic"]),
})

export type AppConfig = z.infer<typeof appConfigSchema>

export interface ConfigEntryMeta {
  key: ConfigKey
  envName: string
  source: ConfigSource
  sensitive: boolean
}

export interface LoadedConfig {
  values: AppConfig
  meta: Record<ConfigKey, ConfigEntryMeta>
}

export interface LoadConfigInput {
  /** 真实环境变量（通常是 process.env） */
  env?: Record<string, string | undefined>
  /** .env 文件解析结果（仅开发态传入） */
  dotenv?: Record<string, string | undefined>
}

const BOOLEAN_FALSE = new Set(["0", "false", "no", "off", ""])

function coerce(key: ConfigKey, raw: string): unknown {
  if (key === "devTools") return !BOOLEAN_FALSE.has(raw.trim().toLowerCase())
  if (key === "devPort") {
    const parsed = Number.parseInt(raw.trim(), 10)
    // 交给 schema 报「不是合法端口」，比这里静默回退到默认值更容易发现配置写错。
    return Number.isNaN(parsed) ? raw.trim() : parsed
  }
  return raw.trim()
}

export function loadConfig(input: LoadConfigInput = {}): LoadedConfig {
  const env = input.env ?? {}
  const dotenv = input.dotenv ?? {}

  const raw: Record<string, unknown> = {}
  const meta = {} as Record<ConfigKey, ConfigEntryMeta>

  for (const key of Object.keys(DEFINITIONS) as ConfigKey[]) {
    const definition = DEFINITIONS[key]
    let value = definition.default
    let source: ConfigSource = "default"

    // 空字符串视为「未设置」：.env.example 里留空的项不应覆盖默认值。
    const fromDotenv = dotenv[definition.env]
    if (fromDotenv !== undefined && fromDotenv.trim() !== "") {
      value = fromDotenv
      source = "dotenv"
    }
    const fromEnv = env[definition.env]
    if (fromEnv !== undefined && fromEnv.trim() !== "") {
      value = fromEnv
      source = "env"
    }

    raw[key] = coerce(key, value)
    meta[key] = { key, envName: definition.env, source, sensitive: definition.sensitive }
  }

  const parsed = appConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")
    throw new AppError("CONFIG_INVALID", `配置校验失败：${detail}`, {
      messageKey: "errors:config.invalid",
      messageParams: { detail },
      context: { issues: parsed.error.issues.length },
    })
  }

  return { values: parsed.data, meta }
}

/** 供 UI 展示的配置视图：敏感项只暴露「是否已配置」，不暴露明文。 */
export interface ConfigViewEntry {
  key: ConfigKey
  envName: string
  source: ConfigSource
  sensitive: boolean
  /** 非敏感项的值（布尔转字符串）；敏感项固定为 null */
  value: string | null
  /** 敏感项是否已配置 */
  configured: boolean
}

export function toConfigView(loaded: LoadedConfig): ConfigViewEntry[] {
  return (Object.keys(DEFINITIONS) as ConfigKey[]).map((key) => {
    const entry = loaded.meta[key]
    // 值可能是 string / boolean / number，统一转成展示文本。
    const asText = String(loaded.values[key])
    return {
      key,
      envName: entry.envName,
      source: entry.source,
      sensitive: entry.sensitive,
      value: entry.sensitive ? null : asText,
      configured: asText.length > 0,
    }
  })
}
