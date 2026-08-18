/**
 * 模型网关的运行时配置 —— **单一真源**。
 *
 * 设置面板、onboarding 第 2 步、以及隐藏的「高级 AI」面板，改的都是这一份。
 * 落 `control.sqlite` 的 `app_settings`（应用级，不随账号切换）+ keychain（apiKey）。
 *
 * ## 三层解析
 *
 * 每个字段：`用户在设置里存的(非空) ?? kernel loadConfig 的默认层`。
 * loadConfig 内部已经是 `内置默认 < .env < 真实环境变量` —— 那整套作为「默认层」
 * 原样保留，用户存的覆盖值叠加在最上面。所以：开发者只配 `.env` 零 UI 就能跑，
 * 打包用户在设置里存的值优先。
 *
 * ## KL 三项的回退
 *
 * `kl*` 留空表示「回退主配置」。`klEffective()` 给出**真正会用到**的值
 * （已解析回退），供 UI 显示「当前实际用 X」，也供 kl-server 的 gateway getter 取。
 *
 * ## 为什么要 seed process.env
 *
 * 两条子进程路（opencode 的 `resolveGatewayModelConfig(process.env)`、
 * kl 的 `ANTHROPIC_AUTH_TOKEN`）都是**每次 spawn 现读 process.env**。
 * 启动时 seed、改配置时 re-seed，这两条路就自动变成「下次 spawn 生效」——
 * 一行消费点都不用改。见 `seedProcessEnv` 的注释。
 */
import type { LoadedConfig, Logger } from "@mycontext/kernel"
import type {
  ModelProvider,
  RuntimeConfigView,
  RuntimeConfigApply,
  RuntimeConfigProbe,
} from "@mycontext/ipc-contract"
import type { SettingsRepository } from "@mycontext/store"

/** 落库的非敏感覆盖项（apiKey 走 keychain，不在这里）。 */
interface StoredOverrides {
  llmBaseUrl?: string
  modelMain?: string
  /** 主模型协议覆盖。缺省 = 走默认层（kernel 默认 openai）。 */
  mainProvider?: ModelProvider
  embedModel?: string
  klLlmBaseUrl?: string
  klModelMain?: string
  /** 知识库协议覆盖。缺省 = 走默认层（kernel 默认 openai）。 */
  klProvider?: ModelProvider
}

/** 进程内消费者要的明文解析结果。 */
export interface ResolvedRuntimeConfig {
  llmBaseUrl: string
  llmApiKey: string
  modelMain: string
  /** 主模型协议（默认层 ?? 用户覆盖）。opencode 子进程与直连 LlmClient 都按它切传输。 */
  mainProvider: ModelProvider
  embedModel: string
  /** KL 三项已解析回退后的**实际生效**值 */
  klBaseUrl: string
  klApiKey: string
  klModel: string
  /** KL 抽取协议（默认层 ?? 用户覆盖）。传给 kl 的 `KL_LLM_PROVIDER`。 */
  klProvider: ModelProvider
}

/** 保存输入：字符串三态见 contract 的 saveRuntimeConfigInputSchema。 */
export interface SaveRuntimeConfigPatch {
  llmBaseUrl?: string | undefined
  llmApiKey?: string | null | undefined
  modelMain?: string | undefined
  /** 主模型协议。undefined = 不改。 */
  mainProvider?: ModelProvider | undefined
  embedModel?: string | undefined
  klLlmBaseUrl?: string | undefined
  klLlmApiKey?: string | null | undefined
  klModelMain?: string | undefined
  /** 知识库协议。undefined = 不改。 */
  klProvider?: ModelProvider | undefined
}

export interface RuntimeConfigServiceOptions {
  settings: SettingsRepository
  logger: Logger
  secretStore: {
    read(key: string): string | null
    write(key: string, value: string): void
  }
  /** 默认层：kernel 的 loadConfig（含 .env / 真实 env） */
  defaults: LoadedConfig
  /** 便于测试注入；缺省用真实 process.env */
  env?: NodeJS.ProcessEnv
  /** 探测网关用的 fetch。注入以便测试不打真网络 */
  fetchImpl?: typeof fetch
}

const SETTING_KEY = "runtime_llm_config"
const LLM_API_KEY_SECRET = "runtime_llm_api_key"
const KL_API_KEY_SECRET = "runtime_kl_api_key"

/** 旧的隐藏高级面板存储位（首次运行 adopt 用）。 */
const LEGACY_ADVANCED_KEY = "advanced_ai_config"
const LEGACY_ADVANCED_API_KEY_SECRET = "advanced_ai_api_key"

type FieldSource = RuntimeConfigView["llmBaseUrl"]["source"]

interface DiscoveredModels {
  provider: ModelProvider
  providers: ModelProvider[]
  modelProviders: Record<string, ModelProvider[]>
  models: string[]
}

type EmbeddingProbeFailureReason =
  | "embeddingUnavailable"
  | "embeddingUnauthorized"
  | "embeddingBadResponse"
  | "embeddingDimensionMismatch"

export class RuntimeConfigService {
  private readonly listeners = new Set<(resolved: ResolvedRuntimeConfig) => void>()

  constructor(private readonly options: RuntimeConfigServiceOptions) {
    this.adoptLegacyIfNeeded()
  }

  /** 探测用的 fetch（测试可注入）。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  /** 明文解析结果。进程内消费者（LlmHolder、kl gateway getter）用它。 */
  resolved(): ResolvedRuntimeConfig {
    const stored = this.readStored()
    const d = this.options.defaults.values

    const pick = (override: string | undefined, fallback: string): string => {
      const trimmed = override?.trim() ?? ""
      return trimmed !== "" ? trimmed : fallback
    }

    const llmBaseUrl = pick(stored.llmBaseUrl, d.llmBaseUrl)
    const llmApiKey = this.options.secretStore.read(LLM_API_KEY_SECRET) ?? d.llmApiKey
    const modelMain = pick(stored.modelMain, d.modelMain)
    const mainProvider: ModelProvider = stored.mainProvider ?? d.modelProvider
    const embedModel = pick(stored.embedModel, d.embedModel)

    // KL 三项：存的(非空) ?? env 默认层 ?? 回退主配置。
    const klBaseRaw = pick(stored.klLlmBaseUrl, d.klLlmBaseUrl)
    const klApiRaw = this.options.secretStore.read(KL_API_KEY_SECRET) ?? d.klLlmApiKey
    const klModelRaw = pick(stored.klModelMain, d.klModelMain)
    /**
     * ★ 协议独立于 base/model/key 的「回退主配置」逻辑：`用户存的 ?? 默认层`
     * （kernel 默认 openai，见 config.ts 的长注释）。主模型与知识库各自一份，
     * 两条子进程/直连路都按各自的 provider 切传输。
     */
    const klProvider: ModelProvider = stored.klProvider ?? d.klProvider

    return {
      llmBaseUrl,
      llmApiKey,
      modelMain,
      mainProvider,
      embedModel,
      klBaseUrl: klBaseRaw.trim() !== "" ? klBaseRaw : llmBaseUrl,
      klApiKey: klApiRaw.trim() !== "" ? klApiRaw : llmApiKey,
      klModel: klModelRaw.trim() !== "" ? klModelRaw : modelMain,
      klProvider,
    }
  }

  /** 脱敏视图。apiKey 只给「是否已配置」+ 后 4 位。 */
  view(): RuntimeConfigView {
    const stored = this.readStored()
    const d = this.options.defaults
    const resolved = this.resolved()

    const plain = (
      override: string | undefined,
      key: "llmBaseUrl" | "modelMain" | "embedModel" | "klLlmBaseUrl" | "klModelMain",
    ): { value: string; source: FieldSource } => {
      const trimmed = override?.trim() ?? ""
      if (trimmed !== "") return { value: trimmed, source: "user" }
      return { value: d.values[key], source: this.defaultSource(key) }
    }

    const secret = (
      secretKey: string,
      defaultKey: "llmApiKey" | "klLlmApiKey",
    ): { configured: boolean; tail: string | null; source: FieldSource } => {
      const fromSecret = this.options.secretStore.read(secretKey)
      if (fromSecret !== null && fromSecret !== "") {
        return {
          configured: true,
          tail: fromSecret.length >= 4 ? fromSecret.slice(-4) : null,
          source: "user",
        }
      }
      const fromDefault = d.values[defaultKey]
      return {
        configured: fromDefault !== "",
        // 默认层的 key（env/.env 明文）不回显后 4 位：那也是密钥
        tail: null,
        source: this.defaultSource(defaultKey),
      }
    }

    return {
      llmBaseUrl: plain(stored.llmBaseUrl, "llmBaseUrl"),
      llmApiKey: secret(LLM_API_KEY_SECRET, "llmApiKey"),
      modelMain: plain(stored.modelMain, "modelMain"),
      mainProvider: {
        value: resolved.mainProvider,
        source: stored.mainProvider !== undefined ? "user" : this.defaultSource("modelProvider"),
      },
      embedModel: plain(stored.embedModel, "embedModel"),
      klLlmBaseUrl: plain(stored.klLlmBaseUrl, "klLlmBaseUrl"),
      klLlmApiKey: secret(KL_API_KEY_SECRET, "klLlmApiKey"),
      klModelMain: plain(stored.klModelMain, "klModelMain"),
      klProvider: {
        value: resolved.klProvider,
        // 存了就是用户覆盖，否则来源同其它默认层字段（env/dotenv/default）。
        source: stored.klProvider !== undefined ? "user" : this.defaultSource("klProvider"),
      },
      klEffective: {
        baseUrl: resolved.klBaseUrl,
        model: resolved.klModel,
        apiKeyConfigured: resolved.klApiKey !== "",
        provider: resolved.klProvider,
      },
    }
  }

  /**
   * 保存。落库 + 写 keychain → re-seed process.env → 通知 listeners。
   * 返回哪些消费点已即时生效、哪些要重启子进程（UI 分级横幅用）。
   */
  save(patch: SaveRuntimeConfigPatch, nowIso: string): RuntimeConfigApply {
    const stored = this.readStored()

    // 只作用于**自由串**字段（mainProvider/klProvider 是枚举，单独处理，见下）。
    type StringKey = Exclude<keyof StoredOverrides, "mainProvider" | "klProvider">
    const merge = (key: StringKey, value: string | undefined): void => {
      if (value === undefined) return
      // 空串 = 清空这一项（回退默认层）；非空 = 覆盖
      if (value.trim() === "") delete stored[key]
      else stored[key] = value.trim()
    }
    merge("llmBaseUrl", patch.llmBaseUrl)
    merge("modelMain", patch.modelMain)
    merge("embedModel", patch.embedModel)
    merge("klLlmBaseUrl", patch.klLlmBaseUrl)
    merge("klModelMain", patch.klModelMain)
    // 协议是枚举而非自由串，不走 trim-and-delete 的 merge：undefined = 不改，
    // 给了就覆盖（两个合法值之一，由 contract 的 schema 保证）。
    if (patch.mainProvider !== undefined) stored.mainProvider = patch.mainProvider
    if (patch.klProvider !== undefined) stored.klProvider = patch.klProvider

    this.options.settings.set(SETTING_KEY, JSON.stringify(stored), nowIso)

    // apiKey 三态：undefined 不改，null/"" 清空，字符串写入。
    this.writeSecret(LLM_API_KEY_SECRET, patch.llmApiKey)
    this.writeSecret(KL_API_KEY_SECRET, patch.klLlmApiKey)

    this.seedProcessEnv()

    const resolved = this.resolved()
    for (const listener of this.listeners) listener(resolved)

    // 记「改了哪些字段」，不记值（baseUrl 可能含内网地址，apiKey 更不能记）。
    this.options.logger.info("runtime config updated", {
      fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined),
    })

    return {
      // 进程内消费者（数字人直连、autoBuild 判定）下一次调用就用新值
      appliedNow: true,
      // 两条子进程路要重启才生效（env 在 spawn 时定死）
      needsRestart: ["agent", "klServer"],
    }
  }

  /**
   * 探测网关、**识别协议**并验证 embedding。
   *
   * ## ★ 为什么要有这个动作
   *
   * 模型名/密钥填错**不会当场报错** —— 它在几小时后的蒸馏或建图里表现为
   * `model_not_found` / 401，而那些错是静默的（日志一行，界面无声）。
   * 这正是本项目最怕的失效形态。一次探测把它变成「现在当场告诉你」。
   *
   * 同一次请求顺带给出**可选模型列表** + **识别到的协议** —— 于是模型名可以从
   * "猜着填"变成"从列表里挑"，协议也不用用户去猜（同事踩过的坑：给了
   * OpenAI 兼容 URL 却被当 Anthropic 发 → 404）。
   * models 解析成功后，用建图的真实参数请求 `/v1/embeddings`，验证 Phase A
   * 实际依赖的向量模型与 2048 维输出。
   *
   * ## 为什么先 openai 后 anthropic
   *
   * 应用侧网关基本都是 OpenAI 兼容口（`/chat/completions`、`/embeddings`）。所以
   * 先用 `Authorization: Bearer` 试 OpenAI 形态；只有当它以**传输不对**的信号
   * （404 / 非 401·403 的 4xx）失败时，才换 `x-api-key` + `anthropic-version`
   * 头再试一次 Anthropic 口。401/403 是「地址对、密钥不对」，不该触发换协议重试。
   * 网络层失败（超时/DNS/拒连）两种协议都会一样失败，所以不重试，直接 unreachable。
   *
   * ## 用草稿值而不是已存配置
   *
   * 用户是在"还没保存"的状态下点测试的（先测通再存才是自然顺序）。
   * `apiKey` 或 `embedModel` 省略时使用当前已解析的值。
   *
   * 失败一律**归类**（见 contract 的 reason 枚举）而不是把原文怼给用户：
   * models 阶段失败返回空列表；embedding 阶段失败保留已发现的模型与协议。
   */
  async probe(input: {
    baseUrl?: string | undefined
    apiKey?: string | undefined
    embedModel?: string | undefined
  }): Promise<RuntimeConfigProbe> {
    const resolved = this.resolved()
    const base = (input.baseUrl ?? "").trim() !== "" ? input.baseUrl!.trim() : resolved.llmBaseUrl
    const key = (input.apiKey ?? "").trim() !== "" ? input.apiKey!.trim() : resolved.llmApiKey
    const embedModel =
      (input.embedModel ?? "").trim() !== "" ? input.embedModel!.trim() : resolved.embedModel

    if (base.trim() === "") {
      return this.probeFail("unreachable", null)
    }
    if (key.trim() === "") {
      return this.probeFail("noKey", null)
    }

    // base 可能带或不带 /v1（两种都有人填）—— 规范化，不让用户去记。
    const root = base.replace(/\/+$/, "").replace(/\/v1$/, "")
    const modelsUrl = `${root}/v1/models`

    try {
      // ── 第 1 试：OpenAI 兼容口 ──
      const openai = await this.fetchImpl(modelsUrl, {
        headers: { Authorization: `Bearer ${key}` },
        // 8 秒：探测是用户**在等**的动作，不能像后台请求那样给 90 秒
        signal: AbortSignal.timeout(8_000),
      })

      if (openai.ok) {
        const parsed = await this.parseModels(openai, "openai")
        if (parsed !== null) {
          return this.probeEmbedding(root, key, embedModel, parsed)
        }
        // 200 但形状不对：多半 URL 填到了控制台首页（返回 HTML）。
        return this.probeFail("badResponse", null)
      }

      // 401/403 = 地址对、密钥不对：换协议也没用，直接归类。
      if (openai.status === 401 || openai.status === 403) {
        const detail = (await openai.text().catch(() => "")).slice(0, 300)
        this.options.logger.info("gateway probe failed", {
          status: openai.status,
          reason: "unauthorized",
        })
        return this.probeFail("unauthorized", detail === "" ? null : detail)
      }

      // ── 第 2 试：Anthropic 口（仅在 OpenAI 口报「传输不对」信号时）──
      const anthropic = await this.fetchImpl(modelsUrl, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(8_000),
      })

      if (anthropic.ok) {
        const parsed = await this.parseModels(anthropic, "anthropic")
        if (parsed !== null) {
          return this.probeEmbedding(root, key, embedModel, parsed)
        }
        return this.probeFail("badResponse", null)
      }

      // 两种口都没通：按 Anthropic 口的状态归类（401/403 → 密钥问题，其余 → 地址不像模型服务）。
      const detail = (await anthropic.text().catch(() => "")).slice(0, 300)
      const reason =
        anthropic.status === 401 || anthropic.status === 403 ? "unauthorized" : "badResponse"
      this.options.logger.info("gateway probe failed", {
        openaiStatus: openai.status,
        anthropicStatus: anthropic.status,
        reason,
      })
      return this.probeFail(reason, detail === "" ? null : detail)
    } catch (error) {
      // 超时 / DNS / 拒连都归 unreachable —— 对用户是同一个下一步（检查地址）
      const detail = error instanceof Error ? error.message.slice(0, 300) : null
      this.options.logger.info("gateway probe unreachable", { detail })
      return this.probeFail("unreachable", detail)
    }
  }

  /** 用建图的真实参数验证 OpenAI 兼容向量接口。 */
  private async probeEmbedding(
    root: string,
    key: string,
    embedModel: string,
    discovered: DiscoveredModels,
  ): Promise<RuntimeConfigProbe> {
    const url = `${root}/v1/embeddings`

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: embedModel,
          input: ["probe"],
          encoding_format: "float",
          dimensions: 2048,
        }),
        signal: AbortSignal.timeout(8_000),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : null
      this.options.logger.info("embedding probe failed", {
        reason: "embeddingUnavailable",
        detail,
      })
      return this.embeddingProbeFail("embeddingUnavailable", detail, discovered)
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300)
      const reason =
        response.status === 401 || response.status === 403
          ? "embeddingUnauthorized"
          : "embeddingUnavailable"
      this.options.logger.info("embedding probe failed", { status: response.status, reason })
      return this.embeddingProbeFail(reason, detail === "" ? null : detail, discovered)
    }

    const dimension = await this.parseEmbeddingDimension(response)
    if (dimension === null) {
      this.options.logger.info("embedding probe failed", { reason: "embeddingBadResponse" })
      return this.embeddingProbeFail("embeddingBadResponse", null, discovered)
    }
    if (dimension !== 2048) {
      this.options.logger.info("embedding probe failed", {
        reason: "embeddingDimensionMismatch",
        expectedDimension: 2048,
        actualDimension: dimension,
      })
      return this.embeddingProbeFail(
        "embeddingDimensionMismatch",
        `Expected 2048 dimensions, received ${dimension}`,
        discovered,
      )
    }

    this.options.logger.info("gateway probe ok", {
      providers: discovered.providers,
      provider: discovered.provider,
      models: discovered.models.length,
      embedModel,
      embeddingDimension: dimension,
    })
    return { ok: true, reason: null, ...discovered, detail: null }
  }

  /** 读取 OpenAI embedding 响应中第一条有限数值向量的维度。 */
  private async parseEmbeddingDimension(response: Response): Promise<number | null> {
    const body = (await response.json().catch(() => null)) as unknown
    if (typeof body !== "object" || body === null) return null

    const data = (body as { data?: unknown }).data
    if (!Array.isArray(data) || data.length === 0) return null
    const first = data[0]
    if (typeof first !== "object" || first === null) return null

    const embedding = (first as { embedding?: unknown }).embedding
    if (!Array.isArray(embedding)) return null
    if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value)))
      return null
    return embedding.length
  }

  /** embedding 探测失败仍保留已解析的模型与协议信息。 */
  private embeddingProbeFail(
    reason: EmbeddingProbeFailureReason,
    detail: string | null,
    discovered: DiscoveredModels,
  ): RuntimeConfigProbe {
    return { ok: false, reason, ...discovered, detail }
  }

  /** 探测失败的统一形状（各字段空着）。 */
  private probeFail(
    reason: RuntimeConfigProbe["reason"],
    detail: string | null,
  ): RuntimeConfigProbe {
    return {
      ok: false,
      reason,
      provider: null,
      providers: [],
      modelProviders: {},
      detail,
      models: [],
    }
  }

  /**
   * 从 `/v1/models` 响应体解析出 `{provider, providers, modelProviders, models}`。
   * 形状不对返回 null。
   *
   * ## ★★ 协议识别以 `supported_endpoint_types` 为准，不靠信封形状猜
   *
   * 之前这里只看响应信封是 OpenAI 形（`{data:[{id}]}`）还是 Anthropic 形
   * （`{data:[{type:"model"}]}`）来定一个协议 —— 但很多网关（如本机 mulerun）
   * 的 `/v1/models` 会**逐模型**标 `supported_endpoint_types`，多数 claude/glm/kimi
   * 都是 `["anthropic","openai"]` 两者都支持。只看信封会把这种网关一律报成
   * "openai 单一"，于是 anthropic chip 永远点不亮 —— 那正是本次要修的 bug。
   *
   * 所以：优先聚合每个模型的 `supported_endpoint_types`（只认我们支持的
   * anthropic/openai 两种）得到网关支持的协议全集；网关不给这个字段时（老网关）
   * 才回退到 `viaHeader`（能用哪种头连通就至少支持那个），不假装支持没验证过的。
   *
   * `provider`（推荐默认）：网关支持 anthropic 就优先 anthropic（claude 类走原生
   * 协议信息更全），否则 openai。
   */
  private async parseModels(
    response: Response,
    viaHeader: ModelProvider,
  ): Promise<DiscoveredModels | null> {
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null
    if (body === null || !Array.isArray(body.data)) return null

    const items = body.data as unknown[]
    const modelProviders: Record<string, ModelProvider[]> = {}
    const gatewayProviders = new Set<ModelProvider>()

    for (const item of items) {
      if (typeof item !== "object" || item === null) continue
      const id = (item as { id?: unknown }).id
      if (typeof id !== "string") continue
      const rawTypes = (item as { supported_endpoint_types?: unknown }).supported_endpoint_types
      if (Array.isArray(rawTypes)) {
        // 只留我们支持的两种协议（网关可能还标 gemini/image-generation 等，忽略）。
        const supported = rawTypes.filter(
          (t): t is ModelProvider => t === "anthropic" || t === "openai",
        )
        if (supported.length > 0) {
          modelProviders[id] = supported
          for (const p of supported) gatewayProviders.add(p)
        }
      }
    }

    const models = items
      .map((item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : null,
      )
      .filter((id): id is string => id !== null)
      .sort((a, b) => a.localeCompare(b))

    // 网关没给 supported_endpoint_types（老网关）→ 回退到连通的那个协议。
    if (gatewayProviders.size === 0) gatewayProviders.add(viaHeader)

    const providers = [...gatewayProviders].sort()
    // 推荐默认：支持 anthropic 就优先它（原生协议信息更全），否则 openai。
    const provider: ModelProvider = gatewayProviders.has("anthropic") ? "anthropic" : "openai"

    return { provider, providers, modelProviders, models }
  }

  /**
   * 把解析后的主网关写进 process.env 的**全部相关名**。
   *
   * 为什么连 `ANTHROPIC_*` 也写：`resolveGatewayModelConfig` 的优先级是
   * `ANTHROPIC_* > MYCONTEXT_LLM_*`（那是 opencode 自己的约定），只 seed
   * `MYCONTEXT_*` 会被真实 env 里残留的 `ANTHROPIC_*` 压过。文档已明说
   * 「它们本来就是同一个网关」，写成一致值是正确且符合原意的。
   *
   * ★ 只在解析值**非空**时写：空值不去 clobber 真实 env 里已有的
   * `ANTHROPIC_BASE_URL`（用户可能只配了那个而没配 MYCONTEXT_*）——
   * 那种情况应当让它继续透传，而不是被我们用空串盖掉。
   */
  seedProcessEnv(): void {
    const env = this.options.env ?? process.env
    const resolved = this.resolved()
    const set = (key: string, value: string): void => {
      if (value.trim() !== "") env[key] = value
    }
    set("MYCONTEXT_LLM_BASE_URL", resolved.llmBaseUrl)
    set("MYCONTEXT_LLM_API_KEY", resolved.llmApiKey)
    set("ANTHROPIC_BASE_URL", resolved.llmBaseUrl)
    set("ANTHROPIC_AUTH_TOKEN", resolved.llmApiKey)
    /**
     * ★ 模型名也要 seed —— 否则 `.env` 里那一行是句谎话。
     *
     * `resolveGatewayModelConfig`（opencode 子进程的模型配置）从 env 读
     * `MYCONTEXT_MODEL_MAIN`，而 `bootstrap/config.ts` **刻意不写 process.env**
     * （见它的文件头：为了让优先级判定只由 `loadConfig` 决定）。少了这一行，
     * dotenv 里的模型名就停在 `config.values` 里到不了子进程，于是子进程
     * 永远用写死的兜底默认值 —— 而"配了但不生效"是最难查的一类问题。
     *
     * 只是这还不够：env 是进程级全局状态，谁都能改，而"这一次 spawn 用哪个
     * 模型"该是个明确的输入。所以装配层另外把 `resolved().modelMain` 显式传给
     * 两处 spawn（见 `startup.ts` 的 `getModel`）—— 那条路不依赖"seed 过了"
     * 这个前提，而这一行让**没走那条路的调用方**（单测、脚本）也拿到正确值。
     */
    set("MYCONTEXT_MODEL_MAIN", resolved.modelMain)
    /**
     * ★ 主模型协议也 seed —— 与模型名同一个理由：opencode 子进程的
     * `resolveGatewayModelConfig` 从 env 读它来决定内联 provider 用
     * `@ai-sdk/anthropic` 还是 `@ai-sdk/openai-compatible`。没这一行的话
     * 用户在设置里切了 anthropic 也到不了子进程（除非 getModel 那条显式路
     * 也带上，见 startup.ts）。装配层同样会显式传，这一行是给单测/脚本兜底。
     */
    set("MYCONTEXT_MODEL_PROVIDER", resolved.mainProvider)
  }

  /** 订阅配置变化（LlmHolder 重配 / 向渲染层推事件）。返回取消订阅。 */
  onChange(listener: (resolved: ResolvedRuntimeConfig) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private readStored(): StoredOverrides {
    const raw = this.options.settings.get(SETTING_KEY)
    if (raw === null || raw === "") return {}
    try {
      const parsed = JSON.parse(raw) as StoredOverrides
      return typeof parsed === "object" && parsed !== null ? parsed : {}
    } catch {
      // 手改坏的库不该让配置读取抛 —— 回退空覆盖（即走默认层）。
      this.options.logger.warn("runtime config store unreadable, using defaults", {})
      return {}
    }
  }

  private writeSecret(secretKey: string, value: string | null | undefined): void {
    if (value === undefined) return
    // 空串/null 都视为清空：写空串（SecretStore.read 会把空当未配置）
    this.options.secretStore.write(secretKey, value ?? "")
  }

  /** loadConfig 的来源标记（default/dotenv/env）—— 视图直接用。 */
  private defaultSource(key: keyof LoadedConfig["values"]): FieldSource {
    const meta = this.options.defaults.meta[key as keyof LoadedConfig["meta"]]
    return (meta?.source ?? "default") as FieldSource
  }

  /**
   * 首次运行：若真源无存储值，而旧的隐藏高级面板里存过 baseUrl/apiKey，
   * 一次性搬进真源 —— 避免用户「在高级面板配过、升级后又要重配一遍」。
   */
  private adoptLegacyIfNeeded(): void {
    if (this.options.settings.get(SETTING_KEY) !== null) return
    const legacyRaw = this.options.settings.get(LEGACY_ADVANCED_KEY)
    if (legacyRaw === null) return
    try {
      const legacy = JSON.parse(legacyRaw) as { baseUrl?: unknown }
      const baseUrl = typeof legacy.baseUrl === "string" ? legacy.baseUrl.trim() : ""
      const legacyKey = this.options.secretStore.read(LEGACY_ADVANCED_API_KEY_SECRET)
      if (baseUrl === "" && (legacyKey === null || legacyKey === "")) return
      const adopted: StoredOverrides = baseUrl !== "" ? { llmBaseUrl: baseUrl } : {}
      this.options.settings.set(SETTING_KEY, JSON.stringify(adopted), new Date().toISOString())
      if (legacyKey !== null && legacyKey !== "") {
        this.options.secretStore.write(LLM_API_KEY_SECRET, legacyKey)
      }
      this.options.logger.info("adopted legacy advanced-ai gateway into runtime config", {
        hasBaseUrl: baseUrl !== "",
        hasApiKey: legacyKey !== null && legacyKey !== "",
      })
    } catch {
      // 旧值坏了就不搬 —— 用户在新面板重配即可。
    }
  }
}
