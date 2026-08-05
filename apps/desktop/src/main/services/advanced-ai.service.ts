/**
 * 高级 AI 配置的持久化。
 *
 * 落在 `control.sqlite` 的 `app_settings`（应用级而非账号级）：
 * 「用哪个模型」是这台机器上的偏好，不该随账号切换而变。
 *
 * ## apiKey 的处理
 *
 * 存进 keychain（与会话签名密钥同一套机制），库里只存**后 4 位**用于展示。
 * 不回显完整 key 是刻意的：UI 上能看到完整 key 就意味着任何能截图的人
 * 都能拿到它，而"改一次配置"并不需要先看到旧值。
 *
 * ## ★ 与发送门禁的边界
 *
 * 这里配的是"用什么脑子"，**不是"能不能动手"**。
 * 换模型不该让数字人绕过授权门或草稿模式 —— 那两者由 policy 与 SendGuard
 * 独立判定，完全不读这份配置。
 */
import { AppError, type Logger } from "@mycontext/kernel"
import { stripPermissionOverrides } from "@mycontext/agent-runtime"
import type { SettingsRepository } from "@mycontext/store"

const SETTING_KEY = "advanced_ai_config"

export interface AdvancedAiConfig {
  baseUrl: string
  /** 六个模型角色 → model id */
  modelRoles: Record<string, string>
  /** 每个模块用哪个 harness */
  harness: Record<string, string>
  /**
   * 逃生阀：直接注入 harness 的原文配置 JSON。
   *
   * 覆盖上面所有推导。给一个受控的原文注入口，
   * 比让极客去改我们的代码或猜环境变量名要好。
   */
  rawConfigJson: string | null
}

/** 传给 UI 的形态：apiKey 只给后 4 位。 */
export interface AdvancedAiConfigView extends AdvancedAiConfig {
  apiKeyTail: string | null
}

export interface SaveAdvancedAiInput {
  baseUrl: string
  /** null = 不改（UI 不回显旧 key，所以"没填"必须与"清空"可区分） */
  apiKey: string | null
  modelRoles: Record<string, string>
  harness: Record<string, string>
  rawConfigJson: string | null
}

export interface AdvancedAiServiceOptions {
  settings: SettingsRepository
  logger: Logger
  /** 读写 keychain 的密钥（注入以便测试与替换实现） */
  secretStore: {
    read(key: string): string | null
    write(key: string, value: string): void
  }
  /**
   * baseUrl/apiKey 的**单一真源**。
   *
   * ★ 高级面板不再自己存 baseUrl/apiKey —— 它与设置面板、onboarding 改的
   * 是同一份网关配置（需求要求单一真源）。这里只留极客专属的
   * modelRoles/harness/逃生阀。embedding 默认模型也从真源取。
   */
  runtimeConfig: {
    resolved(): { llmBaseUrl: string; embedModel: string }
    view(): { llmApiKey: { configured: boolean; tail: string | null } }
    save(
      patch: { llmBaseUrl?: string | undefined; llmApiKey?: string | null | undefined },
      nowIso: string,
    ): unknown
  }
}

export class AdvancedAiService {
  constructor(private readonly options: AdvancedAiServiceOptions) {}

  read(): AdvancedAiConfigView {
    const raw = this.options.settings.get(SETTING_KEY)
    const resolved = this.options.runtimeConfig.resolved()
    const stored: Omit<AdvancedAiConfig, "baseUrl"> =
      raw === null
        ? {
            modelRoles: { "embedding.local": resolved.embedModel },
            harness: { search: "opencode-acp", persona: "opencode-acp" },
            rawConfigJson: null,
          }
        : (() => {
            // 旧记录里可能还带 baseUrl —— 忽略它，baseUrl 现在由真源给。
            const { baseUrl: _legacy, ...rest } = JSON.parse(raw) as AdvancedAiConfig
            return rest
          })()

    // baseUrl / apiKeyTail 都来自真源（单一数据源）
    const tail = this.options.runtimeConfig.view().llmApiKey.tail
    return {
      baseUrl: resolved.llmBaseUrl,
      ...stored,
      apiKeyTail: tail,
    }
  }

  save(input: SaveAdvancedAiInput, nowIso: string): void {
    // 逃生阀在这里再校验一次：UI 可能被绕过（IPC 直接调）。
    let strippedKeys: string[] = []
    let rawConfigJson = input.rawConfigJson
    if (rawConfigJson !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(rawConfigJson)
      } catch (error) {
        throw new AppError("CONFIG_INVALID", "逃生阀配置不是合法 JSON", {
          cause: error,
          messageKey: "errors:config.invalid",
          messageParams: { detail: (error as Error).message },
        })
      }

      // ★ 剥掉权限键后再落盘。
      //
      // 逃生阀整份注入 OPENCODE_CONFIG_CONTENT，而 opencode 的
      // `agent.<name>.permission` 会**覆盖**我们注入的 deny-all
      // （实测 merge = rulesets.flat() + findLast，agent 段追加在 user 段之后）。
      // 于是 `{"agent":{"build":{"permission":{"webfetch":"allow"}}}}` 就能把
      // webfetch 从 deny 翻回 allow —— 而 webfetch 无域名白名单，
      // 正是「读画像 → 外传」这条外泄通道。
      //
      // 在**存**的时候就剥（而不是只在读的时候）：库里不留一份"看起来被接受了"
      // 的提权配置，避免将来某条新的读路径漏掉清洗。
      const { sanitized, stripped } = stripPermissionOverrides(parsed)
      strippedKeys = stripped
      if (stripped.length > 0) rawConfigJson = JSON.stringify(sanitized)
    }

    // baseUrl/apiKey 转发真源（单一数据源）；本地只存极客专属项。
    // ★ 语义翻译：本面板的 apiKey=null 意为「不改」；真源的「不改」是
    // undefined（真源的 null 是「清空」）。所以 null→undefined。
    this.options.runtimeConfig.save(
      {
        llmBaseUrl: input.baseUrl,
        ...(input.apiKey === null ? {} : { llmApiKey: input.apiKey }),
      },
      nowIso,
    )
    const config: Omit<AdvancedAiConfig, "baseUrl"> = {
      modelRoles: input.modelRoles,
      harness: input.harness,
      rawConfigJson,
    }
    this.options.settings.set(SETTING_KEY, JSON.stringify(config), nowIso)

    // 记的是"改了哪些字段"，不是值 —— baseUrl 可能含内网地址，apiKey 更不能记。
    this.options.logger.info("advanced ai config updated", {
      roles: Object.keys(input.modelRoles).length,
      hasEscapeHatch: input.rawConfigJson !== null,
      apiKeyChanged: input.apiKey !== null,
    })

    // 剥掉过权限键要**显式告警**（不静默）：用户以为自己配生效了，
    // 而实际被拿掉了 —— 这个落差必须在日志里可见。
    if (strippedKeys.length > 0) {
      this.options.logger.warn("advanced ai escape hatch: permission keys stripped", {
        keys: strippedKeys,
      })
    }
  }

  /**
   * 给 agent 进程用的 harness 配置。
   *
   * 逃生阀存在时**整份覆盖**推导结果 —— 那正是它的用途：
   * 「你的抽象不够用时我要能绕过它」。
   *
   * ★ 但**权限键除外**：`save()` 已经在落盘时剥过一次，这里再剥一次，
   * 挡的是「库里已经存了一份旧的提权配置」（修复前存进去的）
   * 与「将来有人新增一条写入路径绕过了 save()」两种情况。
   * 权限模型不该依赖"每条写入路径都记得清洗"。
   */
  buildHarnessConfig(): unknown {
    const config = this.read()
    if (config.rawConfigJson !== null) {
      return stripPermissionOverrides(JSON.parse(config.rawConfigJson)).sanitized
    }
    return {
      provider: {
        mycontext: {
          options: { baseURL: config.baseUrl },
        },
      },
      model: config.modelRoles["harness.search"] ?? undefined,
    }
  }
}
