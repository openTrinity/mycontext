/**
 * 启动装配。
 *
 * 顺序是刻意的：配置 → 日志（需要 level）→ 数据库（需要路径）→ 服务 → IPC → 窗口。
 * 任一步失败都直接抛出，由 index.ts 统一处理为「启动失败」，
 * 而不是让应用带着半初始化的状态打开窗口。
 */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import Database from "better-sqlite3"
import { app, powerMonitor, shell, type BrowserWindow } from "electron"
import { resolveLanguage } from "@mycontext/i18n"
import { createLogger, systemClock, type Logger } from "@mycontext/kernel"
import {
  AccountRepository,
  ChannelIdentityVaultRepository,
  ConversationRepository,
  openStore,
  SelfIdentityRepository,
  SessionStore,
  OnboardingRepository,
  SettingsRepository,
  VaultStore,
  type ChannelIdentityVaultRecord,
  type SqliteDatabase,
  type StoreHandle,
  type VaultPaths,
} from "@mycontext/store"
import {
  ChannelHost,
  createDingTalkPlugin,
  createFeishuPlugin,
  createRegistry,
  parseScopedChannelId,
  seedChannelProfile,
} from "@mycontext/channels"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { LlmHolder } from "@mycontext/llm"
import { IPC_EVENTS } from "@mycontext/ipc-contract"
import type { KlGraphOverview, KlServerStatus } from "@mycontext/ipc-contract"
import { bootstrapConfig } from "./config.js"
import { resolveAppPaths, type AppPaths } from "./paths.js"
import {
  applyPostAuthIdentity,
  routeAuthorizedIdentity,
  scopedChannelIdFor,
} from "./post-auth-identity.js"
import { ChannelPipelineManager } from "./channel-pipeline.js"
import { ChannelRuntimeRegistry } from "./channel-runtime.js"
import { teardownVault } from "./vault-teardown.js"
import { DwsSourceService } from "../services/dws-source.service.js"
import { ChannelDataWipeService } from "../services/channel-data-wipe.service.js"
import { runShutdownStep } from "./shutdown.js"
import { AuthService } from "../services/auth.service.js"
import { ChannelService } from "../services/channel.service.js"
import { DataPlaneService } from "../services/data-plane.service.js"
import { FeedService } from "../services/feed.service.js"
import { OnboardingService } from "../services/onboarding.service.js"
import { DistillSourceService } from "../services/distill-source.service.js"
import { DistillService } from "../services/distill.service.js"
import {
  ForgeService,
  readForgeWorkContext,
  WORK_LAYER_SKILL_PATH,
} from "../services/forge.service.js"
import { MediaService } from "../services/media.service.js"
import { MultiMediaService } from "../services/multi-media.service.js"
import { PersonaService } from "../services/persona.service.js"
import { PersonaGate } from "../services/persona-gate.js"
import { SearchService } from "../services/search.service.js"
import { KlServerService } from "../services/kl-server.service.js"
import { MultiKlServerService } from "../services/multi-kl-server.service.js"
import { ensurePythonEnv } from "../services/python-env.js"
import { GraphQueryService } from "../services/graph-query.service.js"
import { DashboardTrendsService } from "../services/dashboard-trends.service.js"
import { MultiGraphQueryService } from "../services/multi-graph-query.service.js"
import { AdvancedAiService } from "../services/advanced-ai.service.js"
import { RuntimeConfigService } from "../services/runtime-config.service.js"
import { SecretStore } from "../services/secret-store.js"
import { PreferencesService } from "../services/preferences.service.js"
import { ScryptPasswordHasher } from "../services/password-hasher.js"
import { SigningKeyStore } from "../services/signing-key.service.js"
import { ActiveIdentityService } from "../services/active-identity.service.js"
import { StatusService } from "../services/status.service.js"
import { registerIpc } from "../ipc/register.js"
import { toLocalFileUrl } from "../windows/local-file-url.js"

export interface AppContext {
  paths: AppPaths
  logger: Logger
  /** 控制库：账号与应用级设置 */
  store: StoreHandle
  vaults: VaultStore
  auth: AuthService
  status: StatusService
  channels: ChannelService
  onboarding: OnboardingService
  /** 蒸馏资料源：用户的选择 + 可选会话列表。生命周期跟随 vault */
  distillSources: DistillSourceService
  /** 蒸馏执行（切窗 + 跑任务 + 进度推送） */
  distill: DistillService
  forge: ForgeService
  /** 数字人管控层接线 */
  persona: PersonaService
  /** 媒体与头像下载（按需，不在采集时全下） */
  media: MediaService
  preferences: PreferencesService
  /** 数据面：采集 + Outbox + Feed。生命周期严格跟随 vault */
  dataPlane: DataPlaneService
  /** 搜索模块。生命周期同样跟随 vault */
  search: SearchService
  /** kl 检索服务子进程（懒启动，应用级句柄但数据按 vault 隔离） */
  klServer: Pick<
    KlServerService,
    "status" | "ensureReady" | "stop" | "rebuildGraph" | "optimizeGraph" | "graphOverview"
  >
  /**
   * 图谱只读查询（ego 图 + 事实检索）。与 klServer 分开，见构造处注释。
   *
   * ★ 结构类型而不是具体的 `GraphQueryService`：装配层传的是
   * `MultiGraphQueryService`（按渠道路由），它满足这两个方法但不是那个类的
   * 实例。与 `IpcDependencies.graphQuery` 同一个形状 —— 两处要一致。
   */
  graphQuery: {
    ego(channelId?: string): ReturnType<GraphQueryService["ego"]>
    facts(input: Parameters<GraphQueryService["facts"]>[0]): ReturnType<GraphQueryService["facts"]>
  }
  /** 仪表盘的时序 + 消化漏斗（独立通道 + 按 changelog head 缓存） */
  dashboardTrends: DashboardTrendsService
  /** 隐藏的极客配置页（应用级，不随账号切换） */
  advancedAi: AdvancedAiService
  /** 模型网关运行时配置（用户可见，单一真源） */
  runtimeConfig: RuntimeConfigService
  settings: SettingsRepository
  openDevTools: boolean
  /** 窗口创建后回填，供服务向渲染层推事件 */
  setWindow(window: BrowserWindow | null): void
  /** 停采集与 Feed → 关 vault → 关控制库。**必须 await**（见实现处注释） */
  dispose(): Promise<void>
}

/**
 * 把 `MYCONTEXT_DWS_SOURCE` 解析成**可执行文件**路径。
 *
 * 这个变量与脚本侧同名同义，而那边允许两种写法（`scripts/lib/dws-resolver.mjs`
 * 的 `resolveDwsFromEnv`）：可执行文件本身，或它所在的目录。
 * 运行时 `resolve("dws")` 只能用文件，所以这里就地把目录形态解开 ——
 * 否则 `.env` 里那个值在脚本侧能用、在应用里静默失效，
 * 而"两处语义不一致"正是最难查的一类问题。
 *
 * 解析不出（值为空 / 目录里没有 dws）返回空串 = 当作没配。
 */
function resolveDwsSourceValue(raw: string): string {
  const value = raw.trim()
  if (value === "") return ""
  try {
    if (statSync(value).isDirectory()) {
      const suffix = `${process.platform}-${process.arch}`
      for (const name of [
        process.platform === "win32" ? `dws-${suffix}.exe` : `dws-${suffix}`,
        process.platform === "win32" ? "dws.exe" : "dws",
      ]) {
        const candidate = join(value, name)
        if (statSync(candidate).isFile()) return candidate
      }
      return ""
    }
    return statSync(value).isFile() ? value : ""
  } catch {
    return ""
  }
}

/**
 * kl 那条链要用的凭证（base + key），**含 env 兜底**。
 *
 * ## ★★ 为什么必须只有一处
 *
 * 「有没有 LLM 可用」这个问题原来有两个答案：`gateway()` 兜了一层真实 env，
 * 而 `autoBuild.enabled` 只看 `resolved()`。于是只在 env 里配了凭证的机器上
 * 手动建图能跑、自动建图关着、界面说「未配置」—— 三条信息互相矛盾，
 * 而它们全都"按各自的判据"是对的。
 *
 * 抽成一个函数是为了让那种矛盾**不可能**再出现：兜底与判断读同一个源。
 *
 * ## 兜底的顺序
 *
 * 1. 用户在设置里存的 KL 专用项（`resolved()` 里 KL 留空时已回退主配置）；
 * 2. 真实环境变量里的 `ANTHROPIC_*` —— 覆盖"只配了那个、没配 MYCONTEXT_*"
 *    的情况（内部同学的常见形态）。
 *
 * 两个都空 = 真的没有凭证，那时 kl 的 LLM 调用必然失败，
 * 所以自动建图应当**关着**而不是反复失败重试。
 */
export function resolveKlCredentials(runtimeConfig: RuntimeConfigService): {
  base: string
  key: string
} {
  const r = runtimeConfig.resolved()
  const base = r.klBaseUrl.trim() !== "" ? r.klBaseUrl : (process.env["ANTHROPIC_BASE_URL"] ?? "")
  const key =
    r.klApiKey.trim() !== ""
      ? r.klApiKey
      : (process.env["ANTHROPIC_AUTH_TOKEN"] ?? process.env["ANTHROPIC_API_KEY"] ?? "")
  return { base: base.trim(), key: key.trim() }
}

/**
 * embedding 网关 base 规整成 OpenAI 兼容形态：**恰好以一个 `/v1` 结尾**。
 *
 * litellm 把 base 原样交给 OpenAI SDK，SDK 视其为 API 根并拼 `/embeddings`；
 * SDK 自己的默认根是 `https://api.openai.com/v1` —— `/v1` 属于根本身。
 * DashScope 只提供 `…/compatible-mode/v1/embeddings`，所以：
 * - 缺 `/v1` → 404（litellm.NotFoundError: OpenAIException - Error code: 404）
 * - 用户配的 URL 已带 `/v1` 而这里再拼一个 → `/v1/v1` 同样 404（实测事故）
 *
 * 于是把结尾任意个 `/v1` 收敛成一个，缺则补一个。与 kl 侧
 * `kl_graph/utils/litellm_config.py` 的 `openai_base_url` 同口径
 * （kl 侧对一切入口做防御性兜底，这里是源头修正）。
 */
export function openAiEmbedBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "")
  if (trimmed === "") return ""
  return `${trimmed.replace(/(\/v1)+$/, "")}/v1`
}

export function bootstrapApp(mainDir: string): AppContext {
  const packaged = app.isPackaged
  // 配置要先于 paths：dataDir 覆盖项来自配置。
  const { config, dotenvLoaded, dotenvPath } = bootstrapConfig({ packaged })
  const paths = resolveAppPaths({ dataDirOverride: config.values.dataDir, mainDir })

  const logger = createLogger("Main", {
    level: config.values.logLevel,
    filePath: paths.logFile,
  })
  logger.info("bootstrap start", {
    packaged,
    userData: paths.userData,
    dotenvLoaded,
    // 路径进日志：.env 没生效时第一时间就能看出是没找到还是找错了。
    dotenvPath,
    logLevel: config.values.logLevel,
  })

  // 装配阶段只开控制库：此时还不知道是哪个账号登录，也就没有 vault 可开。
  const store = openStore({ path: paths.controlDatabase, logger: logger.child("Store") })
  const accounts = new AccountRepository(store.db)
  const settings = new SettingsRepository(store.db)
  const sessions = new SessionStore(settings)
  const vaults = new VaultStore({ root: paths.vaultsRoot, logger: logger.child("Vault") })
  /**
   * 渠道身份 → vault 的映射（control 库）。
   *
   * 隔离维度是 `(accountId, channelId, corpId, userId)` —— 见
   * `CONTROL_0004_IDENTITY_VAULTS` 的注释（为什么不是 accountId）。
   */
  const identities = new ChannelIdentityVaultRepository(store.db)

  const onboarding = new OnboardingService()
  const preferences = new PreferencesService(settings)

  /**
   * 模型网关运行时配置：**单一真源**（设置面板 / onboarding / 高级面板同源）。
   * 落 control 库（应用级）而不是 vault —— 「用哪个模型」是这台机器的偏好。
   *
   * ★ 装配阶段就 seed 一次 process.env：两条子进程路（opencode 的
   * `resolveGatewayModelConfig(process.env)`、kl 的 `ANTHROPIC_AUTH_TOKEN`）
   * 都在**登录后**才 spawn，所以这里 seed 一定早于它们，让用户存的覆盖值
   * 从第一次起子进程就生效。
   */
  const secretStore = new SecretStore({ settings, logger: logger.child("Secret") })
  const runtimeConfig = new RuntimeConfigService({
    settings,
    logger: logger.child("RuntimeConfig"),
    secretStore,
    defaults: config,
  })
  runtimeConfig.seedProcessEnv()

  /**
   * 高级 AI 配置：落 control 库（应用级）而不是 vault。
   * 「用哪个模型」是这台机器上的偏好，不该随账号切换而变。
   *
   * ★ baseUrl/apiKey 委托给 runtimeConfig（单一真源）；这里只留极客专属的
   * modelRoles/harness/逃生阀。
   */
  const advancedAi = new AdvancedAiService({
    settings,
    logger: logger.child("AdvancedAi"),
    secretStore,
    runtimeConfig,
  })

  /**
   * 自备 dws 的路径与渠道号（内部同学用闭源版的入口）。
   *
   * 落 control 库（**应用级**）——「这台机器上用哪个 dws」是机器的属性，
   * 不随账号切换而变（与 advanced-ai 同一个口径）。
   */
  const dwsSource = new DwsSourceService({
    settings,
    clock: systemClock,
    logger: logger.child("DwsSource"),
    // 随包那份的路径，仅用于 UI 上展示"没设时用的是哪个"（与 runtime-env
    // 的 fileName 同规则：`dws-<platform>-<arch>`）
    bundledPath: join(
      paths.binDir,
      process.platform === "win32"
        ? `dws-${process.platform}-${process.arch}.exe`
        : `dws-${process.platform}-${process.arch}`,
    ),
    // 渠道号的默认层：内置默认 < .env < 环境变量（见 kernel/config.ts）。
    // 用户在 UI 上存的覆盖它 —— 与 RuntimeConfigService 同一套三层解析。
    fallbackChannel: config.values.dwsChannel,
    /**
     * 自备 dws 路径的默认层（`MYCONTEXT_DWS_SOURCE`）。
     *
     * ★ 这个变量**允许指到目录**（脚本侧 dws-resolver 就是这么用的：
     * "可执行文件本身或它所在的目录"）。运行时只能用文件路径，所以在这里
     * 就地解析成文件 —— 让 `.env` 里的一个值同时喂 `pnpm prepare:bin`
     * 与应用运行时，用户不必写两遍。
     */
    fallbackPath: resolveDwsSourceValue(config.values.dwsSource),
  })

  /**
   * 当前挂载的 vault 的全部磁盘落点。null = 未登录。
   *
   * ## ★★ 为什么是一个可变引用而不是各服务的构造参数
   *
   * 隔离维度是**渠道身份**，而身份可以在运行期切换。凡是派生自聊天记录的
   * 落点（图库、导出、媒体、agent workspace、渠道 CLI 的配置目录…）都必须
   * 跟着当前身份走。装配阶段还不知道会挂哪个身份，所以这里存一份引用，
   * 由挂载/卸载唯一地改它。
   *
   * `VaultStore.paths()` 是那些路径的唯一真源 —— 这里只是"当前是哪一套"。
   */
  let vaultPaths: VaultPaths | null = null

  // 渠道要在 auth 之前装配：登录回调里要挂载数据面，而数据面依赖渠道插件。
  const runtime = new RuntimeEnv({
    binDir: paths.binDir,
    /**
     * 内置 Python 解释器的所在（`<repoRoot>/vendor/python/<plat>/python`）。
     *
     * ★ 给了它，`tryResolvePython()` 才会**优先用内置那份**而不是本机的。
     * 不给的后果实测过：PATH 上第一个 `python3` 是**另一个项目 venv 里的
     * 3.14.5**，于是蒸馏与 persona 判定一直跑在一个跟本项目无关、
     * 且随时可能被那个项目删掉的解释器上。
     */
    repoRoot: paths.repoRoot,
    /**
     * ★ 用 getter：用户在 UI 上改完路径/渠道号应当**立即生效**，
     * 而 `RuntimeEnv` 是启动时构造一次的。`resolve()` / `buildEnv()`
     * 每次调用都现读这两个 option —— 传静态值的话改完得重启，
     * 而"改了没反应"会被当成功能坏了。
     */
    get dwsChannel() {
      return dwsSource.channel()
    },
    get dwsBinOverride() {
      return dwsSource.path() ?? undefined
    },
    /**
     * ★★ 渠道 CLI 的配置目录**按 vault 走** —— 这是身份隔离的主防线。
     *
     * 目录里只 seed 当前身份那一条 profile（见 `seedChannelProfile`），
     * 于是越权读取变成**结构性不可能**：实测在只 seed 组织甲的目录里
     * 拿组织乙的 `--profile` 去问，直接 `organization "…" not found`。
     * 而 `--profile` 钉住只是"我们记得传"，漏一处就是泄漏 —— 两道一起上。
     *
     * ★ 未登录时退回旧的应用级目录：那时没有 vault，而授权流程
     * （`auth login`）本身要能跑 —— 它是"还没有身份"时唯一能做的事。
     * 授权成功后会绑定身份、挂载 vault，之后一律走 vault 内那份。
     */
    get dwsConfigDir() {
      return vaultPaths?.dwsHome ?? paths.legacyDwsHome
    },
    /**
     * ★ 把渠道命令钉在当前身份上（`--profile <corpId>`）。
     * 每条命令现读 —— 切完身份**下一条命令**就用新身份，不必重启。
     *
     * ★★ 显式传 `"dingtalk"`：这个 `RuntimeEnv` 服务的是 **dws**（钉钉的 CLI），
     * 而多渠道并存之后「当前身份」可能是**飞书**的 —— 那时不带渠道会把
     * 飞书的 corpId（字面就是 `"feishu"`）拼进 dws 的命令行，dws 里没有这个
     * profile，于是每条命令报「未登录」（实测：钉钉授权成功、几十秒后变
     * 未连接，而凭据一直是好的）。完整推理见 `currentProfile` 的注释。
     */
    dwsProfile: () => activeIdentity.currentProfile("dingtalk"),
  })
  const processes = new ProcessRunner(logger.child("Process"))
  const dingtalk = createDingTalkPlugin({
    runtime,
    processes,
    logger: logger.child("DingTalk"),
    openExternal: (url) => shell.openExternal(url),
  })
  const feishu = createFeishuPlugin({
    processes,
    logger: logger.child("Feishu"),
    openExternal: (url) => shell.openExternal(url),
    /**
     * ★★ **函数**而不是值 —— 真实目录按 vault 走（`VaultStore.paths()` 的
     * `feishuAuthRoot`），而插件在登录前就装配好了。
     *
     * 改动前这里是空串占位，而 `LarkCli.env()` 会 `resolve("")` ——
     * 那**就是 `process.cwd()`**，于是飞书的 token 与日志被建到进程工作
     * 目录（开发态即仓库目录）里。凭据落盘位置错、且绕过 `.gitignore`。
     * 现在没挂载时它返回空串，`env()` 明确抛 `CHANNEL_NOT_READY`。
     */
    authRoot: () => vaultPaths?.feishuAuthRoot ?? "",
    executable: join(
      paths.binDir,
      process.platform === "win32"
        ? `lark-cli-${process.platform}-${process.arch === "x64" ? "x64" : process.arch}.exe`
        : `lark-cli-${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`,
    ),
  })
  const registry = createRegistry([dingtalk, feishu])

  let window: BrowserWindow | null = null
  /**
   * 当前挂载的 vault 连接（登录时挂、登出时清）。
   *
   * ★ 用一个可变引用而不是把 db 传进各服务的构造：需要它的是
   * `KlServerService` 的两个注入回调（ego 图要认出「我」、要把会话归到
   * 渠道），而那个服务是在**登录之前**装配的 —— 那一刻还没有 vault。
   *
   * `vaultDb()` 返回 null 就是"还没登录"，调用方据此降级。
   */
  let mountedVault: SqliteDatabase | null = null
  const vaultDb = (): SqliteDatabase | null => mountedVault

  const feed = new FeedService({
    clock: systemClock,
    logger: logger.child("Pipeline"),
    // ★ 网关配置全部从 runtimeConfig 现读（函数）：用户在设置里改了之后，
    // 下次 attach（登录）写出的 handoff.json 就反映新值，不必重启。
    embedding: () => ({
      baseUrl: runtimeConfig.resolved().llmBaseUrl,
      model: runtimeConfig.resolved().embedModel,
      // 算法侧写死 2048（改了要重建两套向量库）——这是外部约束不是我们的选择
      dim: 2048,
    }),
    // 本地索引自用 1024 维，**不作为共享产物**（维度不同，给了也用不了）
    localEmbedding: { model: runtimeConfig.resolved().embedModel, dim: 1024 },
    // LLM 网关与模型名（图谱侧的抽取阶段用同一个）。
    // ★ 给的是**裸模型名** —— 他们的 llm_extractor 会自己拼 provider 前缀，
    // 传全名会二次拼接成 model_not_found，而那个错是静默的。
    // 见 packages/knowledge-feed/src/handoff.ts 的 llm.modelNote。
    llm: () => ({
      baseUrl: runtimeConfig.resolved().klBaseUrl,
      model: runtimeConfig.resolved().klModel,
    }),
    /**
     * ★ 自动建图（攒批）。
     *
     * 全部是**函数**而不是值：`klServer` 在下面才构造（它要 feed 的
     * exportDir），而 building / 图存不存在 / 有没有配模型都是随时在变的。
     * 装配时取快照的话，那一轮判断用的是几十分钟前的状态。
     *
     * `enabled` 的判据是**有没有配 LLM**，不是一个独立开关：
     * 建图必须调 LLM 抽取与 embedding，没配 key 时触发它只会失败 ——
     * 那时静默重试比不建更糟（日志刷屏，而用户以为在建）。
     * 用户要关掉自动建图就把 key 摘掉，或者用手动按钮。
     */
    autoBuild: {
      enabled: () => {
        /**
         * ★★ 判据必须与 `gateway()` **同源** —— 这里曾经不是，而后果很难懂。
         *
         * 原来这里只读 `runtimeConfig.resolved()`，而 `gateway()` 在那之后
         * 又兜了一层真实 env（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`）。
         * 于是只在 env 里配了凭证的机器上，同一个问题有两个答案：
         *
         * ```
         * gateway()          → 有凭证  → 手动点建图能跑（hasGateway: true）
         * autoBuild.enabled  → 没凭证  → 自动建图关闭 + 界面说「未配置」
         * ```
         *
         * 实测撞上（用户日志）：`graph build started {hasGateway: true}` 与
         * `llm not configured` 同时出现，而界面说「自动构建已关闭」+
         * 「知识加工落后 28,819 条」。三条信息互相矛盾，用户完全无从判断
         * 到底配没配 —— 而这不是配置问题，是我们两处判据不一致。
         *
         * 现在两处都走 `resolveKlCredentials()`：一处兜底，一处判断，同一个源。
         */
        const { base, key } = resolveKlCredentials(runtimeConfig)
        return base !== "" && key !== ""
      },
      /**
       * ★ 两次建图之间至少隔多久（默认 1h，设置里可配 15min–6h）。
       *
       * **现读**而不是启动时取值：用户在设置页改完应当下一轮就生效。
       * 传静态值的话改完得重启，而"改了没反应"会被当成功能坏了 ——
       * 与上面 `RuntimeEnv` 那两个 getter 同一个理由。
       *
       * ★ 只管**自动**触发：手动点建图按钮走 `rebuildGraph()`，不经过这里。
       * 挡住一次明确的点击就是"点了没反应"，那比多跑一次建图糟得多。
       */
      /**
       * ★ 这里**曾经**有一个 `minIntervalMs`（自动建图的最小间隔，取自
       * 用户可配的采集周期）。rebase 到 main 之后那套节流换了机制 ——
       * 改成按**连续失败次数**退避（`AUTO_BUILD_BACKOFF_MS`：30min/1h/2h），
       * 而 `AutoBuildInput` 里已经没有这个字段。
       *
       * 没有保留一个并行的最小间隔：两套节流各判一次，不一致时的表现是
       * "该建的时候没建"—— 静默且难查。
       */
      ready: () => {
        const status = klServer.status()
        // building 中不再触发（rebuildGraph 自己也会挡，这里省一次无效调用）
        return !status.building
      },
      /**
       * ★★ 必须用 `graphExists()` 而**不是** `graphOverview().available`。
       *
       * 后者会去取 `buildSchedule`，而那条链路（`feed.graphBuildSchedule()`）
       * 又回头调这里的 `graphExists` —— 一个无限互递归，且 `graphOverview()`
       * 的错误分支自己也在环上，所以它连撞栈都不会退出，只会一秒 15000 条地
       * 刷 warn 直到把主进程的事件循环彻底堵死。实测代价见
       * `KlServerService.graphExists()` 的注释（1.7 GB / 1000 万条 / 应用起不来）。
       *
       * 那次的形态特别值得记住：tsc **报过**这个循环（TS7022/7023），
       * 而修法是给 `buildSchedule` 标显式返回类型 —— 类型报错消失了，
       * 运行时的环一个字没动。
       */
      graphExists: () => klServer.graphExists(),
      trigger: async () => {
        const result = await klServer.rebuildGraph(false)
        /**
         * ★ 被主动打断（退出应用时杀了 kl）→ 报 `"cancelled"`，让上层
         * **不计入** `consecutiveFailures`（那会触发 30 分钟退避，而这一轮
         * 根本没失败）。见 `KlGraphBuildResult.cancelled` 的注释。
         *
         * 也不打 warn：关机路径上那条 warn 是纯噪音，而它掩盖了真正的失败。
         */
        if (result.cancelled === true) return "cancelled"
        if (!result.ok) {
          logger.warn("auto graph build failed", { reason: result.reason })
        }
        return result.ok
      },
      /**
       * ★ 首次建图「等够初始跨度」闸的三个信号，都从采集快照现读
       * （见 `decideAutoBuild` 的 `AUTO_BUILD_INITIAL_WINDOW_MS`）。
       *
       * · `firstDataAt` = 已采到的最早数据时刻（`backfill.coveredFrom`）；
       * · `collectionComplete` = backfill 到底且没停滞（历史导入一次就位 → 立刻建）；
       * · `learningRangeMs` = 用户选的范围跨度（`now - backfill.since`）；
       *   没配下界（`since` 为 null）= 不限 = 长范围 → undefined（按 14 天要求）。
       */
      firstDataAt: (): number | null => dataPlane.snapshot().backfill.coveredFrom,
      collectionComplete: (): boolean => {
        const b = dataPlane.snapshot().backfill
        return b.started && b.remainingMs === 0 && b.stalled === null
      },
      learningRangeMs: (): number | undefined => {
        const since = dataPlane.snapshot().backfill.since
        return since === null ? undefined : Math.max(0, systemClock.now() - since)
      },
    },
  })

  const distillSources = new DistillSourceService({
    clock: systemClock,
    logger: logger.child("DistillSource"),
    plugin: dingtalk,
    /**
     * ★★ 其余渠道的插件 —— 会话列表要覆盖**全部**已挂渠道。
     *
     * 少了这个的后果：另一个渠道的会话在引导页/设置页里**一个都选不到**，
     * 于是 `save()` 里那套"按渠道各存一份白名单"永远收到空值，
     * 而用户以为自己已经配好了范围。
     *
     * ★ 函数：管线是登录后才挂的（见 `ChannelPipelineManager`）。
     */
    sourcePlugins: () => pipelines.all().map((item) => registry.get(item.channelId)),
    /** 主渠道 id —— `save()` 用它判"写主库还是某个渠道库"。 */
    primaryChannelId: dingtalk.meta.id,
    /**
     * ★★ 用户改了采集范围 → 立刻把三层派生物对齐到新范围。
     *
     * 这条链是「勾选实时生效」的全部实现，四步的顺序都有理由：
     *
     * 1. `dataPlane.applyScopeChange()` —— 删越界消息（连带 FTS/向量/媒体行，
     *    见 `purgeOutOfScopeMessages`）+ 重置回填下界让放宽后的范围能往回挖。
     *    必须**最先**：下面两步的产物都派生自库里的消息。
     * 2. `feed.export()` —— 重导出四件套。导出物是"库的投影"，
     *    库变了它就过期了，而它正是建图的输入。
     * 3. `klServer.rebuildGraph(fresh = true)` —— **必须 fresh**。
     *    增量建图只会往图里加，删掉的会话留在图里的实体与事实**不会消失**
     *    —— 而数字人检索记忆时读的正是它们。也就是说不 fresh 的话，
     *    用户取消勾选一个群之后，数字人**仍然会引用那个群里的事情**，
     *    而界面上完全看不出来。这是这一整轮修复里最容易漏的一环。
     * 4. `distill.reset()` —— 让画像重蒸（含清 forge 自己的增量水位）。
     *    不清的话它会从上次蒸到的位置续跑，而"已删掉的语料"已经进过画像了。
     *
     * ## 为什么整条链是 `void`（不 await、不阻塞保存）
     *
     * 建图是分钟级。保存范围这个动作在 UI 上是一次点击，让它等几分钟
     * 会表现成"点了没反应"。所以异步跑，进度经 kl 的 `building` 状态与
     * 图谱面板可见 —— 那两处本来就是给"正在建图"用的。
     *
     * ## 失败处置
     *
     * 每一步各自 catch：清理成功而重建失败时，库已经是干净的（隐私边界
     * 已经收紧），只是图谱暂时陈旧 —— 那是可接受的中间态，而让整条链
     * 因为建图失败而回滚会把"已经删掉的越界数据"重新变成不确定状态。
     *
     * ## ★★★ 每一步都必须打在**保存范围的那个渠道**上
     *
     * 这个回调原来是无参的，而三个动作全都不带渠道：
     * `dataPlane.applyScopeChange()` / `feed.export()` /
     * `klServer.rebuildGraph(true)` —— 而这里的 `klServer` 与 `feed` 是
     * **主渠道那两个裸实例**（应用级单例，见它们的构造处）。
     *
     * 于是"在飞书面板保存范围"会：清主渠道的越界语料、重导出主渠道的四件套、
     * **删掉并重建主渠道的图**。实测日志坐实：
     * `[Main:KlServer] graph build started`（没有 `:feishu` 前缀）+
     * `kl graph data wiped for fresh rebuild {dataDir: …/kl}` ——
     * 而飞书的图在 `…/kl/feishu`。
     *
     * 现在按渠道取那一套服务：主渠道用单例，其余渠道从 `pipelines` 里取它
     * 自己的 `feed` / `klServer`。取不到就**明确记错并返回** ——
     * 而不是顺手拿主渠道的（那正是这次事故的形状）。
     */
    onScopeChanged: (channelId: string) => {
      /**
       * ★★ `distill.reset()` 必须**最先**执行，不能排在建图之后。
       *
       * ## 实测踩到的竞争（用户："调了范围之后点开始学习没反应"）
       *
       * ```
       * 13:16:14  scope save received                    ← 用户调范围
       * 13:16:17  distill start requested → planned 18   ← 3 秒后点开始学习
       * 13:16:21  distill reset {clearedTasks: 36}       ← 才轮到 reset，把刚建的一起清了
       * ```
       *
       * 原因是它原来排在第 4 步，而第 3 步 `rebuildGraph(true)` 要**停 server +
       * 删图库**，那要好几秒。于是 reset 落地时用户已经点过按钮了 ——
       * 任务建好又被清空，界面归零，看起来就是"点了没反应"。
       *
       * ★ 提到最前面是安全的：`reset` 是同步且快的（一条 DELETE + 清内存态），
       * 且**不依赖** purge / export / rebuild 的结果。
       *
       * ★★ 但要**先判渠道**：蒸馏只在**支持数字人的渠道**上跑（其余是只读
       * 接入、不进画像），所以只有那种渠道改范围才需要重蒸。不判的话在飞书
       * 面板保存一次范围会把主渠道刚建好的蒸馏任务全清掉。
       *
       * ★ 判据用 `personaSupported` 而不是 `channelId === 主渠道 id`：
       * 两者今天同值，但前者说的是**能力**。将来第二个渠道开数字人时，
       * 改 registry 那一处即可，不必把所有这类比较重读一遍。
       */
      if (runtimes.find(channelId)?.personaSupported === true) {
        try {
          distill.reset()
        } catch (error) {
          logger.warn("scope change distill reset failed", {
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }
      void (async () => {
        /**
         * 这个渠道自己的那套服务。
         *
         * ★ 主渠道走单例（`feed` / `klServer`），其余渠道走它的管线 ——
         * 这个差异是既有装配决定的（主渠道那两个是应用级 + rebind，
         * 非主渠道是每次挂载新建），这里只是按渠道选对象。
         */
        /**
         * ★★★ 从注册表取**那个渠道自己的**一套服务。
         *
         * 这里原来是一段手写的三分支（`channelId === primaryId ? 单例 :
         * pipelines.find(...)`），而那个形状在这个仓库里出现过 **6 次** ——
         * 每一处都要自己记得"主渠道走单例、其余走管线、找不到别落回主渠道"。
         * 漏任何一条的表现都是静默做错对象（详见 `channel-runtime.ts` 文件头）。
         *
         * `find()` 而不是 `require()`：这条链是 fire-and-forget 的
         * （保存范围不等它跑完），抛出去没人接 —— 所以显式判 null 并记 error。
         */
        const runtime = runtimes.find(channelId)
        if (runtime === null) {
          // ★ 宁可什么都不做，也不要拿主渠道的顶上（那会删错渠道的图）
          logger.error("scope change skipped: channel pipeline not mounted", { channelId })
          return
        }
        const channelFeed = runtime.feed
        const channelKl = runtime.klServer
        logger.info("scope change pipeline start", { channelId })
        try {
          const report = dataPlane.applyScopeChange(channelId)
          if (report !== null && report.messages > 0) {
            logger.info("scope change purged out-of-scope corpus", {
              channelId,
              messages: report.messages,
              conversations: report.conversations,
              ftsRows: report.ftsRows,
              mediaAssets: report.mediaAssets,
            })
            /**
             * 媒体**字节**由这一层删（store 不碰文件系统，见 PurgeReport）。
             * 漏删只留下孤儿文件（可观测、可再清），所以逐个 catch 不中断。
             */
            for (const path of report.mediaPaths) {
              try {
                rmSync(path, { force: true })
              } catch {
                /* 孤儿文件不值得让整条链失败 */
              }
            }
          }
        } catch (error) {
          logger.warn("scope change purge failed", {
            channelId,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
        try {
          channelFeed.export()
        } catch (error) {
          logger.warn("scope change re-export failed", {
            channelId,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
        try {
          // fresh = true：见上面第 3 步（增量建图删不掉图里已有的实体/事实）
          await channelKl.rebuildGraph(true)
        } catch (error) {
          logger.warn("scope change graph rebuild failed", {
            channelId,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    },
  })

  /**
   * 蒸馏与数字人共用同一个 LLM 客户端 —— 经 holder 间接持有。
   *
   * 共用是刻意的：并发闸在实例内，两个实例就等于并发上限翻倍 ——
   * 而网关的限流是按 key 算的，翻倍只会让两边一起被限流。holder 任一时刻
   * 只持有一个 client，稳态下这条不变式仍成立。
   *
   * 未配 key 时 `get()` 为 null：蒸馏只跑统计型任务（抽取型显式报错而不是
   * 静默产 0 条），数字人降级成"只出占位草稿"并在 UI 明示。
   *
   * ★ holder 而非一次性 `new LlmClient()`：用户在设置里改了网关后，
   * `runtimeConfig.onChange` 会 `reconfigure` 它 —— 数字人下一条 batch、
   * 蒸馏下一轮就用新配置，**不必重启**（见 provider.ts 的文件头）。
   */
  const llmHolder = new LlmHolder(logger.child("Llm"))
  const reconfigureLlm = (): void => {
    const r = runtimeConfig.resolved()
    llmHolder.reconfigure({ baseUrl: r.llmBaseUrl, apiKey: r.llmApiKey, model: r.modelMain })
  }
  reconfigureLlm()
  if (llmHolder.get() === null) {
    logger.warn("llm not configured; distill extraction and persona drafts will degrade", {})
  }
  /**
   * kl 的网关只在 spawn 那一刻定（`KL_*` env），所以改配置后要**重起它**。
   *
   * ★ 用一个后填的引用而不是把 `onChange` 挪到 klServer 之后：那个回调里还有
   * 别的事（reconfigureLlm + 通知渲染层），而 klServer 的装配依赖一长串在它
   * 之后才准备好的东西。回调只在用户真的改配置时才跑，那时早已装配完。
   *
   * 不修这条的后果实测过：打包态首启没有 `.env`（网关为空）→ kl 带着空 env
   * 起来 → 用户在设置里填完 key，蒸馏/数字人立刻可用，而 kl **一直**用着
   * 空网关，建图卡在 Phase B（`OpenAIException - Connection error`），
   * 抽出 0 个实体。详见 `KlServerService.onGatewayChanged` 的注释。
   */
  let klServerRef: KlServerService | null = null
  runtimeConfig.onChange(() => {
    reconfigureLlm()
    void klServerRef?.onGatewayChanged()
    // ★ 各渠道的 kl 也要重起：它们的网关同样只在 spawn 那一刻定。
    // 漏了的话飞书的图会一直用旧网关建（Phase B 连接错误，抽出 0 个实体）。
    for (const item of pipelines.all()) void item.parts.klServer.onGatewayChanged()
    // 网关变了 → 通知渲染层刷新设置面板（并显示哪些要重启子进程）。
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(IPC_EVENTS.runtimeConfigChanged)
    }
  })

  /**
   * forge 蒸馏引擎（随包分发的 Python 源码）。
   *
   * 解释器**现在也随包**（`vendor/python/`，为 kl 引入的），所以这里解析出来
   * 的第一候选就是它 —— 见 `runtime` 的 `repoRoot` 与 `python.ts` 的
   * `bundledPythonExe`。forge 与 persona.py 是**纯标准库**（逐文件扫过
   * `vendor/forge` 全树与 `templates/persona/scripts/persona.py`：只有 stdlib
   * 加 forge 自己拷进去的 `imruntime.py`），所以它们只要 base 解释器，
   * 不需要 kl 那套 venv + 280MB 依赖的异步准备。
   *
   * 仍然可能是 null（内置那份被裁掉、平台还没准备、且本机也没有）——
   * 那是降级不是错误：`availability()` 会给出人话原因，状态页显示它。
   */
  const forgePython = runtime.tryResolvePython()
  if (forgePython === null) {
    logger.warn("python not found; forge distillation unavailable", {})
  } else {
    logger.info("python resolved for forge", {
      path: forgePython.path,
      version: forgePython.version.join("."),
      source: forgePython.source,
    })
  }
  const forge = new ForgeService({
    clock: systemClock,
    logger: logger.child("Forge"),
    processes,
    forgeDir: paths.forgeDir,
    python: forgePython,
    /**
     * ★ 时区显式给，不让它退回写死的 +08:00。
     *
     * vault 存的是 unix 毫秒，而「几点活跃」「回得快不快」都是本地时间的
     * 问题。`ForgeService` 的兜底是东八区 —— 对这台机器碰巧是对的，
     * 但那让"读运行环境时区"那条注释所警告的问题换了个形式存在：
     * 同一份语料在别的时区跑出来的作息是错的，而**不会报错**。
     *
     * 用 `getTimezoneOffset` 取反：JS 给的是"本地转 UTC 要加多少分钟"
     * （东八区是 -480），而 forge 要的是 UTC 偏移（+480）。
     */
    offsetMinutes: -new Date().getTimezoneOffset(),
    /**
     * ★ locale pack 由应用显式给，不让 forge 的 `auto` 去猜。
     *
     * `auto` 按本人消息的字符集直方图判，而中英混写正好落在它的判定
     * 边界上：实测同一个人补了几天历史之后，Han 从 48.2% 变成 52.1%，
     * 判定结果却从 `zh-CN` 翻成 `null` —— 而 `null` pack 会让所有词级层
     * 缺失（ask 分类、改口/推脱的真实说法），覆盖度从 A 掉到 D。
     * "多采了历史反而更差"这件事在任何界面上都看不出来。
     *
     * `system` 跟随系统语言：那时也解析成一个确定的 pack，而不是让
     * forge 再去猜一次。走 `resolveLanguage`（渲染层选文案用的同一个函数）
     * 而不是在这里自己判 —— 两处各写一份会在某天分叉，而分叉的表现是
     * "界面是中文而画像按英文测的"。forge 只带 `zh-CN` 与 `en` 两个包。
     */
    localeId: resolveLanguage(preferences.language(), app.getLocale()) === "en" ? "en" : "zh-CN",
  })

  const distill = new DistillService({
    clock: systemClock,
    logger: logger.child("Distill"),
    llmProvider: llmHolder,
    getWindow: () => window,
    /**
     * 能不能跑要在**跑之前**就能显示。
     *
     * 缺 Python 时蒸馏根本不会启动，而那时唯一的痕迹是上面那行启动日志
     * —— 用户在界面上只看到「等待中」，无从下手。
     */
    forgeAvailability: () => forge.availability(),
    /**
     * 蒸出新画像 → 让数字人在下一次回消息前重装 skill。
     *
     * ★ 箭头函数（惰性）而不是直接传 `persona.markProfileChanged`：
     * `persona` 在下面才构造 —— 装配这一刻它还不存在。
     *
     * 不接这条线的后果不是报错，是"蒸完了但没生效"：正在聊的会话会继续
     * 用蒸馏前的 workspace，直到 idle（10 分钟）淘汰它。实测踩过 ——
     * 蒸馏 grade A 跑完，10 个 workspace 里的 skill 数全是 0，
     * 而回复照旧走兜底文案。
     */
    onProfileChanged: () => persona.markProfileChanged(),
    /**
     * ★★ 蒸馏完 → 立刻踢一轮图谱同步（否则最多干等 10 分钟）。
     *
     * `GraphSync` 是 10 分钟一轮的定时器，而蒸馏完成不叫醒它。用户点完
     * 「开始学习」时蒸馏几十秒就完了，图谱那边却毫无动静 —— 那就是
     * "点了开始学习不会建图"的真相（没接上，不是坏了）。
     * 同事机器实测：`forge run finished` 09:53:35 → `graph export synced`
     * 09:59:43，中间 6 分钟空白。
     *
     * `void`：这一轮同步是分钟级的（要导出、可能还要建图），不能阻塞
     * 蒸馏的收尾。`tickGraphSync` 自己有 `inFlightSync` 挡并发。
     */
    onCorpusReady: () => void feed.tickGraphSync(),
    /**
     * ★★ 工作层抽取的开关 —— 这就是让 work 层从"代码写好了"变成"真的会跑"
     * 的那一行。
     *
     * ## 为什么是回调而不是一个 boolean
     *
     * 用户在设置页里改这个开关时,`DistillService` 已经构造完了。传值会锁死在
     * 装配那一刻 —— 表现是"打开了开关,但要重启应用才生效",而界面上没有任何
     * 提示说需要重启。回调让每一轮判据现读。
     *
     * ## 为什么默认关
     *
     * 这一层每轮对四个维度各发一次请求、每次上万 token。而蒸馏是在后台跑的
     * （6 小时一轮的定时器 + 用户点「开始学习」），界面上只有一行"正在蒸馏"
     * —— 也就是说**开着它就是在静默花钱**。
     *
     * `preferences.workLayerEnabled()` 未设置/值非法时回落 false（见那里的
     * 注释：一个读值失败就自动开始花钱的开关是不可接受的）。
     */
    llmFacets: () => preferences.workLayerEnabled(),
    /**
     * ★★ playbook 归纳的语料：kl 的图库（**只读**）。
     *
     * 由这一层打开而不是让 distill 自己开：`@mycontext/distill` 不依赖
     * better-sqlite3（native 模块，本仓库的 Electron/Node ABI 反复踩过 ——
     * 实测跑测试时会直接报模块加载失败）。
     *
     * ★ 返回 `null` 的三种情况都是**正常状态**，不是故障：还没登录
     * （没有 vault）、还没建过图、或图库正被建图热切换。
     * 归纳那一层拿到 null 就跳过这一轮。
     */
    openGraphDb: () => {
      const klRoot = vaultPaths?.klRoot
      if (klRoot === undefined || klRoot === "") return null
      const dbPath = join(klRoot, "knowledge.db")
      if (!existsSync(dbPath)) return null
      try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true })
        return { db: db as unknown as SqliteDatabase, close: () => db.close() }
      } catch {
        // 正被热切换（kl 的 hot-swap）—— 下一轮再试
        return null
      }
    },
    /**
     * ★★ 建图在跑时**跳过** playbook 归纳。
     *
     * 实测：建图用 12 并发打同一个 LLM 网关时，归纳这条路**必然** HTTP 524
     * （Cloudflare 前置，源站 100s 内没返回完整响应）。两边抢同一个网关，
     * 而归纳是单次长请求 —— 它必然是输的那一方。
     *
     * 所以串行：跳过一轮比烧一次注定失败的调用好。
     */
    graphBusy: () => klServer.status().building,
  })

  /**
   * kl-server 端口：KlServerService 起在这里，两条 agent 路径（SearchService
   * 与 PersonaService）注入给 opencode 子进程的 kl CLI 都连这里。三处必须
   * 一致，所以抽成一个常量并**在两个消费者之前**声明。
   *
   * 曾经写在 SearchService 之上、PersonaService 之下 —— persona 那时够不到
   * 它（TDZ / used before declaration），也就是把整个装配拆成了两半。
   */
  const klPort = 8200

  /**
   * 媒体与头像。
   *
   * ★ 拿的是 `dingtalk.cli` 而不是整个 plugin：它只需要"能跑白名单内的
   * 命令"这一个能力，给整个 plugin 会让它顺手就能调采集与授权。
   *
   * ★★ 位置在 `PersonaService` **之前**（原来在它之后 ~100 行）——
   * 数字分身起草前要按需下载图片（让 agent 真能看到图），而那需要它。
   * 与上面 `klPort` 那条注释同一个教训：消费者在生产者之前声明的话
   * 拿到的是 TDZ 错误，而这里更糟 —— 用 `() => media` 惰性引用能编译过，
   * 却把"起草时 media 好了没有"变成一个时序问题。
   */
  const media = new MediaService({
    clock: systemClock,
    logger: logger.child("Media"),
    cli: dingtalk.mediaRunner ?? null,
    // 头像能力（契约）。渠道没实现时为 null —— 取头像退化为首字母兜底
    avatars: dingtalk.avatars ?? null,
    channelId: dingtalk.meta.id,
  })

  const persona = new PersonaService({
    clock: systemClock,
    logger: logger.child("Persona"),
    /**
     * ★ 随包的 skill 目录（`kl` 图谱查询）。
     *
     * 这一路以前**没接**到数字分身 —— `skillsDir` 只有搜索在用，
     * 所以数字人从来没有过图谱查询能力，而那不报错：只是那个能力不存在。
     *
     * dev 与打包同一套解析（见 paths.ts 的 `resolveSkillsDir`），
     * 所以这里传 `paths.skillsDir` 就同时覆盖两态。
     */
    skillsDir: paths.skillsDir,
    /**
     * ★ agent 路径：每个 conversation 一个 opencode ACP session。
     *
     * 这四样凑齐才启用（见 PersonaService 的构造）：起不来时
     * `PersonaAcp.turn` 返回 null，`PersonaComposer.compose` 自己落回 LlmClient 直连
     * 并记一条 `via: "llm"` —— 静默降级是这个项目反复出现的那类失效。
     *
     * `agentHome` 不是可选的美化：不给它 opencode 会从 `$HOME/.claude/skills`
     * 读到用户自己装的**全部** skill（搜索侧实测泄漏 8 个）。
     */
    runtime,
    processes,
    klRoot: paths.klRoot,
    klPort,
    /**
     * 数字分身的 agent 进程也用内置 Python 环境。
     *
     * ★★ 与搜索侧同一个旋钮（见那边同名项）。这里**曾经漏了** ——
     * 于是数字分身的 PATH 首段是 klRoot，裸 `kl` 命中上游那个 exec
     * 不存在 `.venv` 的包装脚本，agent 从来没成功查过图谱；而失败被记成
     * `tool_status: success`，日志里零 error（见 `persona-acp.ts` 里
     * `getPythonEnv` 上方那段实测记录）。
     *
     * 与 KlServerService / SearchService 共用同一份准备逻辑，幂等 ——
     * 已就绪时不做任何事，所以三处都调不会重复装依赖。
     */
    getPythonEnv: () => ensurePythonEnv(paths.klRoot, logger.child("Python")),
    /**
     * ★ 共用 holder：用户在设置里改网关后，`runtimeConfig.onChange`
     * 会 `reconfigure` 它，数字人下一条 batch 就用新配置 —— 不必重启。
     */
    llmProvider: llmHolder,
    /**
     * ★ ACP 那条路的模型 —— 与 `llmProvider` 用的是**同一个值**。
     *
     * 统一之前这两条路是两个不同的模型（ACP 读那个只存在于真实 env 的旧变量、
     * 直连读 `modelMain`），而用户在设置页一个都改不动 —— 于是"常态回复"
     * 与"降级回复"风格不同，且查不到原因。
     */
    getModel: () => runtimeConfig.resolved().modelMain,
    getWindow: () => window,
    /**
     * 授权用的 CLI。
     *
     * ★ 与 MediaService 同一个理由：只给 `MediaRunner`（能跑白名单内的
     * 命令），不给整个 plugin —— 那会让这一层顺手就能调采集与登录。
     * `chat chmod` 在 `HOST_APPROVAL_COMMANDS` 里，所以它跑起来一定会
     * 在宿主应用弹一次确认框，绕不过去。
     */
    cli: dingtalk.mediaRunner ?? null,
    /**
     * 判定闸：跑蒸馏产物自带的 `persona.py` 拿「这条能不能自己回」。
     *
     * ★ 与 `forge` 共用**同一个** `forgePython`：两处各解析一次会得到
     * "蒸馏能跑但判定不可得"这种半可用状态，而它的表现是自动发送
     * 全部静默降级 —— 没有任何东西解释为什么。
     *
     * 解释器缺失时 `PersonaGate` 的三个方法一律返回 null，而调用点把
     * null 当降级处理（fail closed，见 persona-gate.ts 的文件头）。
     */
    gate: new PersonaGate({
      logger: logger.child("PersonaGate"),
      processes,
      python: forgePython,
    }),
    /**
     * 发送成功后定向补拉那个会话，把刚发的那条秒级拉回来。
     *
     * ★ 惰性箭头（同 `onProfileChanged`）：`dataPlane` 在下面才构造，
     * 装配这一刻它还不存在，但这个回调要到"用户真发了一条"时才被调，
     * 那时它早已就位。发送 API 只回 taskId、消息不在库里，不补拉的话
     * 要等下一轮 2 分钟的全局轮询才出现（见 `PersonaService.onSentMessage`）。
     *
     * ★ `reason: "self-sent"` —— 这一路**刻意绕过采集范围闸**：那条消息是
     * 用户此刻主动发出的、他正盯着会话等它显示出来。拦掉的表现是
     * "我发出去了但界面上没有"。落库时仍过 `persist` 的闸，所以越界会话里
     * 它不会进语料（见 `IngestService.refreshConversation` 的注释）。
     */
    onSentMessage: (externalId) =>
      void dataPlane.refreshConversation(externalId, { reason: "self-sent" }),
    /**
     * ★ 数字人的**记忆**：知识图谱的只读查询（见 persona-memory.ts 的文件头）。
     *
     * forge 给的是"怎么说"，图谱给的是"说什么" —— 缺了后者，产出是一种可复现的
     * 失效：对方提到一个专有名词，草稿把那个词原样复述一遍，因为模型除了语气
     * 参数什么都没拿到。而图谱里往往已经有那个名词的解释（它是从同一批聊天
     * 记录里抽出来的），只是从来没接进起草。
     *
     * ★ 取函数而不是值：`graphQuery` 在这一行**之后**才构造（它依赖 vault 的
     * 本人身份），而两者的构造顺序不该由这个接线决定。惰性取也顺带让
     * "图还没建"变成一次返回空数组，而不是启动期抛错。
     */
    graph: {
      entitiesByName: (names) => graphQuery.entities(names),
      /**
       * ★ 限会话。全库检索是事实面板的定义，不是记忆的定义 ——
       * 见 `factsInConversation` 的注释（跨会话会让数字人复述本人在这个
       * 会话里从没说过的话）。
       */
      searchFacts: (keyword, conversationExternalId) =>
        graphQuery.factsInConversation(keyword, conversationExternalId, 8),
    },
    /** 查记忆时排除本人的名字 —— `people.md` 已经按人给了语气 */
    getSelfNames: () => {
      const db = vaultDb()
      if (db === null) return []
      try {
        return new SelfIdentityRepository(db).get(dingtalk.meta.id)?.displayNames ?? []
      } catch {
        return []
      }
    },
    /**
     * 起草前把这几条消息挂的图下下来 —— 让 agent 真能看到图。
     *
     * ★ 为什么起草这条路上必须自己下：媒体原本只在"用户看到那一屏时"才下
     * （见 `MediaService.downloadForMessages` 的注释），而起草是后台跑的。
     * 实测库里 1915 张图只有 242 张在本地（13%）——不下就等于绝大多数轮次
     * agent 仍然看不到图。
     *
     * 范围由 persona 侧限到最近几条带图的消息（与送图上限对齐），
     * 所以这里不再加限制。失败不抛：那时 transcript 标「（图片，未下载）」。
     */
    downloadMedia: (messageIds) => media.downloadForMessages(messageIds),
  })

  /**
   * 媒体与头像。
   *
   * ★ 拿的是 `dingtalk.cli` 而不是整个 plugin：它只需要"能跑白名单内的
   * 命令"这一个能力，给整个 plugin 会让它顺手就能调采集与授权。
   */

  const search = new SearchService({
    clock: systemClock,
    logger: logger.child("Search"),
    runtime,
    processes,
    // kl skill 随包分发；建会话时复制进 workspace（harness 按 cwd 发现 skill）
    skillsDir: paths.skillsDir,
    klRoot: paths.klRoot,
    klPort,
    /**
     * ★ 主渠道 id：默认档位（= 存量会话的档位）就是它。
     * 它同时决定"用哪个 HOME"与"要不要开 isolateData"，而两者都影响
     * 存量会话能不能 resume —— 见 `SearchServiceOptions.primaryChannelId`。
     */
    primaryChannelId: dingtalk.meta.id,
    /**
     * 非主渠道档位要连的 kl 端口。★ 函数：端口由 pipeline 在登录后
     * 真探测后分配，装配这一刻还不知道。
     */
    klPortOf: (channelId) => pipelines.portOf(channelId) ?? undefined,
    /** `all` 档注入 `KL_GRAPHS_JSON` 用（让 skill 逐个问每个图）。 */
    klGraphs: () =>
      Object.fromEntries(pipelines.all().map((item) => [item.channelId, item.klPort])),
    /**
     * agent 进程也用内置 Python 环境。
     *
     * ★ 必需：skill 里跑的裸 `kl` 要命中我们在 venv/bin 生成的 wrapper
     * （上游 kl-graph/kl 硬编码了它自己那套不存在的 .venv 路径）。
     * 与 KlServerService 共用同一份准备逻辑，幂等 —— 就绪时不做任何事。
     */
    getPythonEnv: () => ensurePythonEnv(paths.klRoot, logger.child("Python")),
    /**
     * ★ 搜索 agent 用哪个模型 —— 显式给，不靠 env 透传。
     *
     * `save()` 确实会 re-seed `process.env`（见 `seedProcessEnv`），所以 env
     * 那条路**在设置页改完之后也是新的**。显式传的价值在别处：
     *
     * · env 是进程级的全局可写状态,谁都能改;而这里要的是"这一次 spawn
     *   用哪个模型"这个明确的输入。显式传让它成为签名的一部分,
     *   而不是一个隐式约定;
     * · `resolved()` 是三层解析（存的 > `.env` > 内置）的唯一真源,直接读它
     *   就不必依赖"seed 过了"这个前提 —— 而那个前提一旦哪天被破坏
     *   （少一次 re-seed、或 seed 顺序变了）,表现是静默用错模型。
     */
    getModel: () => runtimeConfig.resolved().modelMain,
    getWindow: () => window,
  })

  const klServer = new KlServerService({
    clock: systemClock,
    logger: logger.child("KlServer"),
    processes,
    // kl 侧 checkpoint 的 key（透传成 POST /ingest 的 source_id）
    channelId: dingtalk.meta.id,
    klRoot: paths.klRoot,
    /**
     * ★ 构造时给空串占位 —— 真实目录在**挂载时** `rebind()` 换（按 vault）。
     * 未登录时没有图谱可读，而 `graphExists()` 对空路径走"图不存在"降级。
     */
    dataDir: "",
    exportDir: "",
    port: klPort,
    getWindow: () => window,
    /**
     * ★★ 推送给渲染层时用**多渠道合并后**的状态（含 `perChannel`）。
     *
     * 不接这一条的话：首帧查询走 `appKlServer`（有 perChannel），而之后每次
     * 状态变化推来的是主渠道自己那份（没有）—— 界面在第一次刷新后就退化成
     * "只有一个渠道"，并落进渲染层的回落分支，显示一张标着飞书、
     * 实际是主渠道端口的假卡。用户报过这个。
     *
     * ★ 惰性取值（`appKlServer` 在下面才构造，而它把 `klServer` 当参数）——
     * 直接引用会撞 TDZ；用箭头函数推迟到真正推送的那一刻。
     */
    mergedStatus: (): KlServerStatus => appKlServer.status(),
    /**
     * 准备并**激活** mycontext 的共用 Python 环境（内置解释器 + venv + 依赖）。
     *
     * ★ 为什么必须自己带 Python：本机的指望不上 —— macOS 自带的是 3.9.6，
     * 而 kl 要求 ≥3.10；依赖（约 280MB，含平台绑定的 .so）也不入 git。
     * 不准备就 spawn 的后果是 kl-server `exit 3`，日志里只有退出码，
     * 看不出是缺依赖（真实踩过：同事机器能和 opencode 聊，但 kl 调不通）。
     *
     * 返回的 env 是激活后的（VIRTUAL_ENV / PATH 前插 venv/bin / 清 PYTHONHOME），
     * 会传给 kl 的每个子进程 —— 于是它们里面裸 `python`、`kl` 都在这个 venv 里。
     * 幂等：就绪时不联网、不装东西，也不打日志。
     */
    preparePython: () => ensurePythonEnv(paths.klRoot, logger.child("Python")),
    /**
     * embedding/LLM 走网关（出网边界，UI 明示）。
     *
     * ★ 函数：每次 spawn 现读 `runtimeConfig.resolved()` 的 **KL 三项**
     * （留空回退主配置）。用户在设置里改了网关后，下次 kl 重启就用新值。
     */
    gateway: () => {
      const { base, key } = resolveKlCredentials(runtimeConfig)
      const r = runtimeConfig.resolved()
      return {
        // ★ LLM 传输由 kl 侧 provider 决定（anthropic 拼 /v1/messages、openai 拼
        // /chat/completions），base 照原样传 —— 带不带 /v1 都行，kl 的
        // litellm_base_url 会按传输规整（见 kl_graph/utils/litellm_config.py）。
        // 裸模型名（kl 自己拼 provider 前缀）。见 kl_graph/config.py。
        llmBaseUrl: base,
        // ★ kl 抽取模型：默认回退主模型（glm-5.2，实测 anthropic 模式可抽中文 facts）。
        // 想给 kl 单独指一个模型就在设置里填 KL 模型，或用 KL_LLM_MODEL env 覆盖。
        llmModel: process.env["KL_LLM_MODEL"] ?? r.klModel,
        // ★ embedding 走 OpenAI 兼容：base 要带恰好一个 /v1（litellm 直接 POST
        // {base}/embeddings；用户配好带 /v1 的 URL 时不能再拼，否则 /v1/v1 → 404）。
        embedBaseUrl: openAiEmbedBaseUrl(base),
        embedModel: r.embedModel,
        apiKey: key,
        // ★ 网关（DashScope 兼容）的 text-embedding-v4 默认返回 1024 维，而 kl 默认
        // 建 4096 维集合 —— 维度对不上会在 Qdrant upsert 时崩。配 2048 + 带 dimensions
        // 参数（matryoshka 截断），与 kl 侧实跑验证过的口径一致。
        embeddingDim: 2048,
        sendDimensions: true,
      }
    },
    /**
     * 自动建图的调度快照 → `graphOverview().buildSchedule`（界面上
     * 「下次多久后构建」那一块）。
     *
     * ★ 惰性取（函数而非值）：水位随每一轮采集在变，装配这一刻的快照
     * 到用户打开界面时早已过期 —— 与 `gateway` 同一个理由。
     *
     * ★★ 这里有一条**真实存在的运行期环**，改动前先读完这一段：
     *
     * ```
     * klServer.graphOverview() → 本函数 → feed.graphBuildSchedule()
     *   → autoBuild.graphExists() → klServer.??? ← 这里必须是 graphExists()
     * ```
     *
     * 上面那个 `graphExists` 曾经指向 `graphOverview().available`，于是环闭合，
     * 而且 `graphOverview()` 的 catch 分支自己也在环上 —— 结果是一次调用打出
     * 1000 万条 warn / 1.7 GB 日志、主进程事件循环彻底停摆（"应用启动不起来"）。
     * 现在环在 `KlServerService.graphExists()` 那里断开（它不碰 buildSchedule），
     * 详细的判据与代价记在那个方法的注释里。
     *
     * ★ 所以：`feed.graphBuildSchedule()` 这条链路上的任何一环都**不许**再去
     * 调 `graphOverview()`。要行数就调 `graphExists()`。
     *
     * ★★ 返回类型**必须显式写**：`feed.autoBuild` 里引用了 `klServer`，
     * 而 `klServer` 的构造又引用 `feed` —— 不标注的话 tsc 判定
     * 「circularly references itself」并把这三处全部推成 `any`
     * （TS7022/7023）。那比编译失败更糟：`any` 会让整条链路失去类型检查。
     *
     * ★ 但要记住这个标注**只修类型、不修环**：上面那次事故里 tsc 报的就是
     * 这个循环，而"加显式返回类型"把唯一的告警按掉了，运行时的环留在原地。
     * 类型层面的循环警告是在提示这里的装配有环，不是一个纯粹的标注疏漏。
     *
     * 实现与真实触发判据同源（同一个 `forecastAutoBuild`），
     * 那是"界面说的"与"实际做的"不漂移的唯一办法。
     */
    buildSchedule: (): KlGraphOverview["buildSchedule"] => feed.graphBuildSchedule(),
    /**
     * 清库（`fresh=true`）之后把建图水位清零。
     *
     * ★ 单向调用（kl → feed），不构成环：`feed.autoBuild` 那边引用 klServer，
     * 而这一条只写游标、不回读 kl 的任何状态。见 `FeedService
     * .resetGraphBuildWatermark` 的注释里那次 1.7 GB 日志的事故。
     */
    resetBuildWatermark: (): boolean => feed.resetGraphBuildWatermark(),
  })
  // 回填给上面那个 onChange —— 改网关后重起 kl（见那里的注释）。
  klServerRef = klServer

  /**
   * 非主渠道的 kl / 图库 / 导出管线 —— **登录后**按"用户连了哪几个渠道"现造。
   *
   * ## ★★ 为什么必须是挂载时造，而不是装配时造
   *
   * 改动前飞书那三个服务（FeedService / KlServerService / GraphQueryService）
   * 是在这里 `new` 出来的，路径全给空串占位、等挂载时 `rebind()`。
   * 主渠道那样做成立（它只有一个、rebind 有人调），复制到第二个渠道就断了：
   * **没有任何一处 rebind 飞书那三个** —— 于是 `KL_DATA_DIR` 是空的、
   * 图库查询恒走"图不存在"降级、判断"要不要起飞书 kl"的那张 Map
   * 一次都没被 `set` 过恒返回 false。三条一起构成一条**完全静默**的死链。
   *
   * 现在由 `ChannelPipelineManager` 承担：它在挂载时才知道 vaultId 与端口，
   * 于是"路径"不再需要占位与 rebind —— 构造那一刻就是对的。
   */
  interface ChannelPipelineParts {
    channelId: string
    db: SqliteDatabase
    dbPath: string
    feed: FeedService
    klServer: KlServerService
    graphQuery: GraphQueryService
    /**
     * 这个渠道自己的头像/媒体取法（钉钉走共同群搜索、飞书走
     * `contact +get-user` 的直链）。见 `MultiMediaService` 文件头。
     */
    media: MediaService
    feedDirs: {
      dataRoot: string
      exportRoot: string
      klRoot: string
      handoffFile: string
    }
  }

  /** 网关配置：主渠道与各渠道共用同一份推导（改一处两边都变）。 */
  const klGateway = () => {
    const r = runtimeConfig.resolved()
    const base = r.klBaseUrl.trim() !== "" ? r.klBaseUrl : (process.env["ANTHROPIC_BASE_URL"] ?? "")
    const key =
      r.klApiKey.trim() !== ""
        ? r.klApiKey
        : (process.env["ANTHROPIC_AUTH_TOKEN"] ?? process.env["ANTHROPIC_API_KEY"] ?? "")
    return {
      llmBaseUrl: base,
      llmModel: process.env["KL_LLM_MODEL"] ?? r.klModel,
      embedBaseUrl: openAiEmbedBaseUrl(base),
      embedModel: r.embedModel,
      apiKey: key,
      embeddingDim: 2048,
      sendDimensions: true,
    }
  }

  const pipelines = new ChannelPipelineManager<ChannelPipelineParts>({
    logger: logger.child("ChannelPipeline"),
    /**
     * 从主渠道端口 **+1** 开始扫 —— 8200 由 `klServer` 固定持有。
     * 把它包含进扫描范围的话，主渠道 kl 还在 warmup（还没 listen）时
     * 会被判成空闲，于是第二个渠道分到 8200 并与主渠道抢同一个图库端口。
     */
    basePort: klPort + 1,
    create: async (spec) => {
      const vp = vaults.paths(spec.vaultId)
      const handle = vaults.sourceHandle(spec.vaultId, spec.channelId)
      /**
       * ★★ 每渠道自己的落点，全部收在 `sources/<channelId>/` 下。
       *
       * ## 这里原来的拼法是错的
       *
       * 旧代码是 `join(vp.exportRoot, channelId)` + `join(vp.klRoot, channelId)`，
       * 而 `vp.exportRoot` 已经是 `exports/dws` —— `dws` 是**主渠道 CLI 的
       * 名字**。于是飞书的导出物落在 `exports/dws/feishu`，读起来像
       * "dws 的飞书子目录"，而两者毫无关系。
       *
       * 更糟的是那个目录下本来是**内容类型**的分层
       * （`exports/dws/chat` / `wiki` / `minutes`），于是一个渠道名与三个
       * 内容类型并列成了兄弟。下一个人按那个布局推断"飞书也是一种内容类型"
       * 会写出更多错位。
       *
       * 现在与 `sourcePath`（那个渠道自己的库）同一个命名空间 ——
       * 一个渠道的**全部**东西都在它自己的目录下：
       *   sources/feishu/core.sqlite   ← 库
       *   sources/feishu/exports/      ← 四件套
       *   sources/feishu/kl/           ← 图谱数据
       *   sources/feishu/handoff.json  ← 交接文件
       *
       * 删一个渠道 = 删一个目录，且不可能与别的渠道互相覆盖。
       */
      const feedDirs = {
        dataRoot: vp.root,
        exportRoot: vaults.sourceExportRoot(spec.vaultId, spec.channelId),
        klRoot: vaults.sourceKlRoot(spec.vaultId, spec.channelId),
        /**
         * ★ handoff 也收进那个目录（原来是 vault 根下的
         * `handoff.feishu.json`，与主渠道的 `handoff.json` 并列）。
         * 主渠道那个保持原位 —— 上游按固定路径读它，动它要改他们那侧。
         */
        handoffFile: vaults.sourceHandoffFile(spec.vaultId, spec.channelId),
      }
      /**
       * ★ 清掉**旧布局**留下的目录（`exports/dws/<channelId>` /
       * `kl/<channelId>` / `handoff.<channelId>.json`）。
       *
       * 不做数据迁移而是直接删：那三样全是**可重建的派生物** ——
       * 导出是库的投影、kl 是建图产物、handoff 是一页运行时事实。
       * 实测存量只有 1.3 MB，而下一轮采集/建图会把它们重新生成。
       * 搬过来反而要处理"两处都有、哪个更新"这类问题。
       *
       * ★ 逐个 catch 不中断：删不掉只是留下几个孤儿目录（可观测、可再清），
       * 而让它阻断管线挂载会把一个清理动作变成"这个渠道用不了"。
       */
      for (const stale of [
        join(vp.exportRoot, spec.channelId),
        join(vp.klRoot, spec.channelId),
        join(vp.root, `handoff.${spec.channelId}.json`),
      ]) {
        try {
          rmSync(stale, { recursive: true, force: true })
        } catch (error) {
          logger.warn("stale channel dir cleanup failed", {
            channelId: spec.channelId,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }
      // klServer 要在 feed 的 autoBuild 里被引用，而 feed 又是它的
      // exportDir 来源 —— 与主渠道同款的后填引用（那里有完整推理）。
      let klRef: KlServerService | null = null
      const channelFeed = new FeedService({
        clock: systemClock,
        logger: logger.child(`Pipeline:${spec.channelId}`),
        /**
         * ★ 这个渠道自己的导出固定值。不给的话它的语料会被打上钉钉的
         * workspace id（导出层缺省），两个渠道的会话挂在同一个 workspace
         * 下 —— "来自哪个渠道"在图里就丢了，而且不报错。
         */
        ...(() => {
          const profile = registry.get(spec.channelId).exportProfile
          return profile === undefined ? {} : { exportProfile: profile }
        })(),
        embedding: () => ({
          baseUrl: runtimeConfig.resolved().llmBaseUrl,
          model: runtimeConfig.resolved().embedModel,
          dim: 2048,
        }),
        localEmbedding: { model: runtimeConfig.resolved().embedModel, dim: 1024 },
        llm: () => ({
          baseUrl: runtimeConfig.resolved().klBaseUrl,
          model: runtimeConfig.resolved().klModel,
        }),
        autoBuild: {
          enabled: () => {
            const r = runtimeConfig.resolved()
            return r.klBaseUrl.trim() !== "" && r.klApiKey.trim() !== ""
          },
          ready: () => klRef !== null && !klRef.status().building,
          /**
           * ★ 与主渠道同一条硬规则：必须是 `graphExists()` 而**不是**
           * `graphOverview().available`。后者会取 buildSchedule，而那条链
           * 回头调这里 —— 一个无限互递归（实测 1.7 GB 日志 / 主进程停摆）。
           * 改动前飞书这里正是写的 `graphOverview().available`。
           */
          graphExists: () => klRef?.graphExists() ?? false,
          trigger: async () => {
            if (klRef === null) return false
            const result = await klRef.rebuildGraph(false)
            // 被我们自己打断（退出应用）不算失败 —— 否则下次启动进 30 分钟退避
            if (result.cancelled === true) return "cancelled"
            return result.ok
          },
        },
      })
      const channelKl = new KlServerService({
        clock: systemClock,
        logger: logger.child(`KlServer:${spec.channelId}`),
        processes,
        // 各渠道各自的 checkpoint —— 共用一个会互相覆盖续传进度
        channelId: spec.channelId,
        klRoot: paths.klRoot,
        // ★ 构造这一刻路径就是对的（不再占位 + rebind）
        dataDir: feedDirs.klRoot,
        exportDir: feedDirs.exportRoot,
        port: spec.klPort,
        /**
         * 状态推送由 `MultiKlServerService` 统一负责（它聚合出
         * `perChannel`）。各渠道各推一次的话会互相覆盖同一个 IPC 事件，
         * 而症状是状态页在两个渠道的状态之间闪。
         */
        getWindow: () => null,
        preparePython: () => ensurePythonEnv(paths.klRoot, logger.child("Python")),
        gateway: klGateway,
        buildSchedule: (): KlGraphOverview["buildSchedule"] => channelFeed.graphBuildSchedule(),
        resetBuildWatermark: (): boolean => channelFeed.resetGraphBuildWatermark(),
      })
      klRef = channelKl
      const channelGraph = new GraphQueryService({
        logger: logger.child(`GraphQuery:${spec.channelId}`),
        dataDir: () => feedDirs.klRoot,
        now: () => systemClock.now(),
        sourceChannelId: spec.channelId,
        /**
         * ★★★ 关系（fact↔entity）问**这个渠道自己的** kl。
         *
         * ## 漏了它的表现：非主渠道的关系图恒空，而主渠道是对的
         *
         * SQLite 的 `edges` 表在默认后端（ladybug）下按设计恒空 —— 所以关系
         * 必须问 kl 的 HTTP。主渠道那套装配（下面 `graphQuery`）接了这一条，
         * 而这里**没接**，于是「它认识的人与事」在飞书上永远是空面板，
         * 尽管图真的建好了（实测：`entities=11 facts=13 edges=120`，
         * 而界面上一个点都没有）。
         *
         * ★ 这是「主渠道与非主渠道两套路径」这个形状的又一次复现：加一个
         * 能力要在两处各写一遍，漏一处就是一次静默错位。`ChannelRuntime`
         * 收拢的是**服务实例**，这类逐个 option 的接线还没收 ——
         * 下一轮该把 `GraphQueryService` 的装配也提成一个共用函数。
         *
         * ★ 用 `channelKl`（这个渠道自己那个 kl，端口不同）而不是主渠道的
         * `klServer`：问错 kl 会拿到另一个渠道的关系边，而那比空面板更糟
         * （不报错，只是答错，且答的是"这个人和谁有往来"）。
         */
        factsOfEntity: (entityId) => channelKl.factsOfEntity(entityId),
        // 直连边兜底（fact 交集为空时）—— 见 GraphQueryOptions.neighborsOfEntity
        neighborsOfEntity: (entityId) => channelKl.neighborsOfEntity(entityId),
        /**
         * ★★ 读**这个渠道自己**的身份行。
         *
         * 这里原来是 `() => []`，理由写的是"ego 图只走主渠道，「我是谁」的
         * 判据在主渠道的身份表里"。那个理由是错的：身份表按 `channel_id` 键，
         * 每个渠道有自己的一行，而这个 `GraphQueryService` 查的也是
         * **这个渠道自己的**图库（`feedDirs.klRoot`）。
         *
         * 于是"用飞书的名字在飞书的图里找我" —— 全程不涉及跨渠道 id 映射，
         * 也就没有 `MultiGraphQueryService.ego()` 注释里担心的那个问题
         * （那条担心的是**合并两个渠道的图**，不是"非主渠道不能有 ego 图"）。
         *
         * 空数组的后果是 ego 图恒返回"不知道你在这里叫什么"，而界面把它
         * 显示成一句"关系图只在钉钉上可用" —— 一个假结论。
         *
         * ★ 拿不到（还没授权 / 还没解析）时仍然返回空数组：那时 `ego()` 会
         * 给一句可行动的话，与主渠道未登录时同一个行为。
         */
        getSelfNames: () => {
          try {
            return new SelfIdentityRepository(handle.db).get(spec.channelId)?.displayNames ?? []
          } catch {
            return []
          }
        },
        getChannelByConversation: () => {
          try {
            return new ConversationRepository(handle.db).channelByExternalId()
          } catch {
            return new Map<string, string>()
          }
        },
      })
      /**
       * ★★ 这个渠道**自己的** MediaService（头像取法按渠道不同）。
       *
       * 漏了它的表现就是用户报的"飞书头像没获取"：全局那一个 MediaService
       * 装配时写死了主渠道的 `cli`/`avatars`/`channelId`，于是飞书的
       * `createFeishuAvatars` 写好了却没有任何调用点，而且即使有缓存也
       * 因为 channelId 键对不上而查不到 —— 两层都是静默的。
       *
       * `?? null` 而不是省略：`MediaService` 对 `null` 有明确行为
       * （退化成首字母兜底），而"渠道没实现头像能力"是正常状态。
       */
      const channelPlugin = registry.get(spec.channelId)
      const channelMedia = new MediaService({
        clock: systemClock,
        logger: logger.child(`Media:${spec.channelId}`),
        cli: channelPlugin.mediaRunner ?? null,
        avatars: channelPlugin.avatars ?? null,
        channelId: spec.channelId,
      })
      /**
       * ★★★ **必须 attach** —— 漏了它整条取头像的路会抛 `DB_UNAVAILABLE`。
       *
       * ## 这是"两套路径漏一处"的又一次复现（CDP 抓到的）
       *
       * 主渠道那个 media 单例在 `mountVault` 里 attach（`startup.ts` 那处
       * `media.attach(handle.db, …)`）。而我给非主渠道**新建**的这些
       * MediaService 从没被 attach 过 —— `requireDb()` 于是抛
       * `DB_UNAVAILABLE / 尚未登录`。
       *
       * 表现：飞书头像永远是首字母兜底，而 `contact_avatars` 表**零行**
       * （连一条 miss 都没落）。用户看到的就是"头像还是没显示"。
       * 单测不会红：那些用的是内存库、且直接构造 MediaService 自己 attach。
       *
       * ## ★ 库按渠道分，媒体目录**共用 vault 级**
       *
       * 库必须分（`contact_avatars` 按 `(channel_id, external_id)` 查，
       * 而非主渠道的行本来就在自己那个 `sources/<id>/core.sqlite` 里）。
       * 而落地目录不分：文件名是**内容/URL 的哈希**，同一张图在两个渠道
       * 只存一份；按渠道分目录反而会存两份且互不知道。
       */
      channelMedia.attach(handle.db, {
        media: vp.mediaRoot,
        avatar: vp.avatarRoot,
        upload: vp.uploadRoot,
      })
      return {
        parts: {
          channelId: spec.channelId,
          db: handle.db,
          dbPath: vaults.sourcePath(spec.vaultId, spec.channelId),
          feed: channelFeed,
          klServer: channelKl,
          graphQuery: channelGraph,
          feedDirs,
          media: channelMedia,
        },
        /**
         * 拆除顺序：**先 await 停 kl**（让出端口 + 写掉 pidfile），
         * 再 detach feed。反过来的话下一个 vault 的同名渠道会探到旧进程
         * 还在、按新端口找不到 pidfile，于是把它当"外部进程" adopt ——
         * 而那个进程的 `KL_DATA_DIR` 指着**上一个身份的图库**。
         * 完整推理见 `KlServerService.rebind()`。
         *
         * 库不在这里关：`vaults.close(vaultId)` 会连带关掉全部
         * `<vaultId>:source:*` 句柄（见 `VaultStore.close`）。
         * 这里再关一次等于双关，而第二次会抛。
         */
        dispose: async () => {
          await channelKl.stop().catch(() => undefined)
          await channelFeed.detach().catch(() => undefined)
        },
      }
    },
  })

  const appKlServer = new MultiKlServerService(
    klServer,
    () =>
      pipelines.all().map((item) => ({
        channelId: item.channelId,
        service: item.parts.klServer,
        /**
         * 没采到任何消息的渠道不起 Python/Qdrant（一个 kl 冷启 ~90s + 几百 MB）。
         * 授权了但还没采到第一批时这是对的降级：图谱本来就是空的。
         */
        enabled: () => {
          try {
            return (
              (item.parts.db
                .prepare<[], { count: number }>("SELECT count(*) AS count FROM messages")
                .get()?.count ?? 0) > 0
            )
          } catch {
            return false
          }
        },
      })),
    dingtalk.meta.id,
    logger.child("MultiKl"),
  )

  /**
   * 图谱的**只读查询**（ego 图 + 事实检索）。
   *
   * ★ 与 `klServer` 分开是刻意的：那个是 kl **子进程的 supervisor**
   * （启停 / 健康轮询 / 建图），由维护 kl 那条线的人负责。
   * 而这一层只开图库的只读连接跑 SELECT —— 与进程无关
   * （图库是磁盘产物，建图**期间**也读得到，那时 kl 的 HTTP 端点在忙）。
   *
   * 混在一起的代价这一轮真实发生过：两边同时改那个文件，
   * `stash pop` 撞出冲突，还漏出一个重复的 `ipcMain.handle` 注册。
   */
  const graphQuery = new GraphQueryService({
    logger: logger.child("GraphQuery"),
    // ★ 函数：vault 跟着登录挂，装配这一刻还没有（见 GraphQueryOptions.dataDir）
    dataDir: () => vaultPaths?.klRoot ?? "",
    now: () => systemClock.now(),
    /**
     * ego 图要在实体表里认出「我」—— 判据是本人身份里的显示名。
     *
     * ★ 取函数而不是值：vault 是**跟随登录挂载**的，装配这一刻它还没挂上。
     * 未登录时返回空数组，`ego()` 会给一句"先确认本人身份"。
     */
    getSelfNames: () => {
      const db = vaultDb()
      if (db === null) return []
      try {
        const row = new SelfIdentityRepository(db).get(dingtalk.meta.id)
        return row?.displayNames ?? []
      } catch {
        // 表还不存在（迁移没跑完）→ 空数组，页面照常降级
        return []
      }
    },
    /**
     * `会话 externalId → 渠道 id`。ego 图靠它把关系归到 IM 渠道。
     *
     * kl 的图库里没有渠道字段，但它的 `conversation_id` 就是我们的
     * `conversations.external_id`（实测能对上）—— 所以映射只能从 vault 来。
     */
    getChannelByConversation: () => {
      const db = vaultDb()
      if (db === null) return new Map<string, string>()
      try {
        return new ConversationRepository(db).channelByExternalId()
      } catch {
        return new Map<string, string>()
      }
    },
    /**
     * ★★★ 关系（fact↔entity）必须问 kl —— SQLite 的 `edges` 表在默认后端
     * （ladybug）下按设计恒空。完整推理见 `GraphQueryOptions.factsOfEntity`。
     *
     * 实测：`SELECT COUNT(*) FROM edges` → 0，而同一时刻 `/status` 报
     * `edges: 26558`。不接这条的话「它认识的人与事」永远是空面板。
     */
    factsOfEntity: (entityId) => klServer.factsOfEntity(entityId),
    // 直连边兜底（fact 交集为空时）—— 见 GraphQueryOptions.neighborsOfEntity
    neighborsOfEntity: (entityId) => klServer.neighborsOfEntity(entityId),
    sourceChannelId: dingtalk.meta.id,
  })

  /**
   * 仪表盘的时序 + 漏斗。
   *
   * ★ 与 `graphQuery` 一样取**函数**而不是值（vault 跟着登录挂），
   * 且刻意不并进 `IngestService.snapshot()` —— 那是每批采集都发的热路径，
   * 而按天分桶实测 108ms（完整推理见该服务的文件头注释）。
   */
  const dashboardTrends = new DashboardTrendsService({
    logger: logger.child("DashboardTrends"),
    clock: systemClock,
    db: () => vaultDb(),
    klDataDir: () => vaultPaths?.klRoot ?? "",
  })

  const appGraphQuery = new MultiGraphQueryService(graphQuery, dingtalk.meta.id, () =>
    pipelines.all().map((item) => ({
      channelId: item.channelId,
      facts: (input) => item.parts.graphQuery.facts(input),
      /**
       * ★ 那个渠道自己的 ego 图 —— 界面上是**切换**而不是合并
       * （同一个人在两个渠道没有安全的 id 映射，见 MultiGraphQueryService.ego）。
       */
      ego: () => item.parts.graphQuery.ego(),
    })),
  )

  const dataPlane = new DataPlaneService({
    clock: systemClock,
    logger: logger.child("DataPlane"),
    plugin: dingtalk,
    /**
     * ★ 函数：非主渠道的 `FeedService` 由 pipeline 在登录后现造。
     * 装配时取的话永远是"飞书没有 feed"，于是它的导出物一条都不生成。
     */
    sources: () =>
      pipelines
        .all()
        .map((item) => ({ plugin: registry.get(item.channelId), feed: item.parts.feed })),
    feed,
    getWindow: () => window,
    /**
     * 数字人的入站消费者挂在采集的 tick 上（见 IngestService）。
     *
     * 取的是**函数**而不是实例：`persona.attach` 与 `dataPlane.attach`
     * 的先后由下面的 onSessionChange 决定，传实例会拿到 attach 之前的 null。
     */
    getPersonaSupervisor: () => persona.inboundSupervisor,
    /**
     * 投递成功 → 叫醒调度 + 推快照。
     *
     * 不接这一条的话消息只是"进了队列"：要等 `TICK_MS`（8 秒）才被处理，
     * 而那几秒里界面上「待处理」一动不动 —— 与没收到无法区分。
     */
    onPersonaDelivered: () => persona.onDelivered(),
  })

  /**
   * ★★ 睡眠感知：合盖期间不发起新一轮采集。
   *
   * ## 为什么需要
   *
   * macOS 睡眠期间每 16-18 分钟会 DarkWake 一次（窗口 2-4 秒）跑维护任务，
   * 而 `setInterval` 在那几秒里**照样触发**。于是采集 tick 被唤起，
   * 但网络还没起来 —— 渠道 CLI 的 token 刷新（懒惰刷新，access token 只活
   * 2 小时）恰好撞在这里就会拿不到 token，报 `not_authenticated` + exit 2。
   *
   * 实测 2026-08-08：13:11:01 DarkWake → 13:11:05 `Entering Sleep`，
   * 4 条命令夹在中间全部失败；那批命令的 `command_start`→`command_end`
   * 墙上钟只差 26µs 而 `duration` 报 503ms（进程被冻结的指纹）。
   *
   * ## ★ 与 `recordError` 那道复核是**两道独立的防线**
   *
   * 这一道是省成本的：不发那批注定失败的请求（子进程 + 污染 lastError
   * + 推高退避）。而复核那道是保正确的：万一还是发了并失败了，
   * 也不会被误判成"登录过期"这个终态。少任何一道都还会犯错 ——
   * 只有这一道时，睡眠边界上仍可能漏进一次失败而永久 blocked；
   * 只有复核那道时，每轮睡眠仍会稳定烧掉一批子进程。
   *
   * ## ★ 用 `powerMonitor` 而不是"判断上次 tick 距今多久"
   *
   * 后者是间接证据（长间隔也可能是机器卡、也可能是退避），而
   * `suspend`/`resume` 是系统直接告诉我们的事实。本仓库吃过够多
   * "拿间接信号猜状态"的亏了。
   */
  const onSystemSuspend = (): void => dataPlane.suspendIngest()
  const onSystemResume = (): void => dataPlane.resumeIngest()
  powerMonitor.on("suspend", onSystemSuspend)
  powerMonitor.on("resume", onSystemResume)

  /**
   * 卸载当前 vault：停掉一切在跑的东西，然后关库。
   *
   * ## ★★ 顺序是刻意的，每一步都对应一个真实踩过的坑
   *
   * ```
   * ① agent（search）—— 先撤 token + kill opencode，再 detach
   *                      （换库时旧 agent 不该续命）
   * ② media / distill / persona —— 都持定时器且会写库
   * ③ ★ await klServer.stop() —— **必须 await**（见下）
   * ④ ★ await dataPlane.detach() —— 它会等在途那一轮采集收尾
   * ⑤ 最后才清 vaultPaths / 身份 / mountedVault，再 closeAll()
   * ```
   *
   * ### ③ 为什么 kl 必须 await（切身份时的竞态）
   *
   * kl 绑固定端口 8200，pidfile 放在 dataDir 下。登出时 `void` 无所谓
   * （后面没人再起），但**切身份**时新 vault 会立刻起一个：新目录里没有
   * pidfile → 探到旧进程还活着 → 判成"外部进程" → `adopted=true` →
   * 建图直接报错；而 adopt 成功的分支更糟 —— 那个进程的 `KL_DATA_DIR`
   * 指着**旧身份的图库**，新身份查到的是上一个人的知识。
   *
   * ### ⑤ 为什么身份要**最后**才清
   *
   * `dataPlane.detach()` → `eventStream.stop()` → `unsubscribeAll()` →
   * `dws event stop --all --profile <X>`，而那个 `<X>` 来自身份 getter。
   * 先清的话退订命令不带 profile，按 CLI 全局 profile 退订 —— 可能停掉
   * **另一个身份**的订阅（甚至用户自己终端里正在用的那个）。而
   * `unsubscribeAll` 整段吞异常（退出路径不该抛）→ 停错了不会有任何痕迹。
   *
   * 整个函数**不抛**：每一步失败都记日志并继续。卸载失败而不关库
   * 等于"登出后数据仍可读"，那比丢一条错误日志严重得多。
   */
  /**
   * 当前已挂管线的 `DataPlaneSourceAttachment` 列表。
   *
   * 由 pipeline 派生而不是自己存一份：多一个副本就多一个会过期的真源
   * （改动前那张 `mountedSourceVaults` Map 就是这样 —— 它一次都没被 set 过）。
   */
  const sourceAttachments = () =>
    pipelines.all().map((item) => ({
      channelId: item.channelId,
      db: item.parts.db,
      dbPath: item.parts.dbPath,
      feedDirs: item.parts.feedDirs,
    }))

  /**
   * ★★★ 渠道运行时注册表 —— 主渠道也是其中一条。
   *
   * ## 为什么在这里装
   *
   * 主渠道的 `feed` / `klServer` / `graphQuery` 是**应用级单例**（上面那三个
   * `new`），而它们要到 `mountVault` 才 rebind 到具体 vault 的目录；
   * 非主渠道那些由 `pipelines` 在登录后现造。两者都要"取值时才读" ——
   * 所以 `runtimes` 是个函数（与 `MultiKlServerService.sources` 同一条理由）。
   *
   * ## ★ 主渠道那条的字段从哪来
   *
   * `db` / `dbPath` / `feedDirs` 全部派生自 `vaultPaths`（登录时填的那份），
   * 与 `remountDataPlane` 传给 `dataPlane.attach` 的**完全同源** ——
   * 不是另抄一遍，免得两处慢慢分叉。未登录时 `vaultPaths` 是 null，
   * 那时 `all()` 返回空数组（`require()` 会抛，而那正确：没登录就没有渠道）。
   *
   * 完整设计与它要拆掉的两个前提见 `channel-runtime.ts` 的文件头。
   */
  const runtimes = new ChannelRuntimeRegistry({
    primaryChannelId: dingtalk.meta.id,
    runtimes: () => {
      const db = mountedVault
      const vp = vaultPaths
      if (db === null || vp === null) return []
      return [
        {
          channelId: dingtalk.meta.id,
          plugin: dingtalk,
          db,
          dbPath: vp.database,
          feedDirs: {
            dataRoot: vp.root,
            exportRoot: vp.exportRoot,
            klRoot: vp.klRoot,
            handoffFile: vp.handoffFile,
          },
          feed,
          klServer,
          graphQuery,
          /**
           * ★ 数字人 / 蒸馏只在主渠道上工作 —— 其余渠道是只读接入。
           * 这个判据原来散在三处（渲染层一个常量、主进程多处 `!== dingtalk`、
           * `onScopeChanged` 里一句 if），现在只有这一处。
           */
          personaSupported: true,
          /**
           * ★ 主渠道的 media 就是那个应用级单例 —— 它的装配本来就是
           * 主渠道的能力（`cli`/`avatars`/`channelId` 全取主渠道插件）。
           * 现在它作为"主渠道这条 runtime 的 media"存在，而不再是
           * "全应用唯一的 media"。
           */
          media,
        },
        ...pipelines.all().map((item) => ({
          channelId: item.channelId,
          plugin: registry.get(item.channelId),
          db: item.parts.db,
          dbPath: item.parts.dbPath,
          feedDirs: item.parts.feedDirs,
          feed: item.parts.feed,
          klServer: item.parts.klServer,
          graphQuery: item.parts.graphQuery,
          media: item.parts.media,
          personaSupported: false,
        })),
      ]
    },
  })

  /**
   * 按渠道路由的头像服务（见 `MultiMediaService` 文件头 —— 它修的是
   * "飞书头像取不到"的真根因：全局唯一那个 MediaService 写死了主渠道）。
   *
   * ★ 必须在 `runtimes` 之后构造：它的第三个参数要读 runtime 列表，
   * 而那些非主渠道的 runtime 是登录后才现造的（所以传函数）。
   */
  const mediaByChannel = new MultiMediaService(media, dingtalk.meta.id, () =>
    runtimes.all().map((item) => ({ channelId: item.channelId, media: item.media })),
  )

  /**
   * 管线变动后让数据面重认一次（新渠道要起自己的 `IngestService`）。
   *
   * 走 `attach` 而不是加一个 `addSource`：`attach` 内部会先 detach，
   * 于是"重挂一次"与"启动时挂一次"走的是同一条路 —— 少一条只在
   * 动态新增时才走的分支，也就少一处只在那种时序下才暴露的 bug。
   */
  const remountDataPlane = async (): Promise<void> => {
    const db = mountedVault
    const vp = vaultPaths
    if (db === null || vp === null) return
    /**
     * ★★★ 顺序要紧：**先写范围，再起采集**。
     *
     * 这两行原来是反的（先 `dataPlane.attach` 起采集、再 `distillSources.attach`
     * 写范围），而那之间只隔几百毫秒 —— 却足够让采集器跑完第一轮：
     *
     *     17:48:15  channel pipelines mounted {feishu}
     *     17:48:16  ingest started {feishu}                  ← 采集先跑
     *     17:48:16  collection time window synced {feishu}   ← 范围后写
     *     17:48:20  dropped: 9, kept: 0, allowed: 0, restricted: true
     *
     * `readCollectionScope` 对「表里没有 chat 行」返回"一个都不采"
     * （隐私优先，那是对的），于是那一轮拉到的 9 条全被丢掉。
     * 用户看到「已采集消息 0」而日志里一个错都没有。
     *
     * ★ 这一步是**双保险的第一道**：`IngestService` 那侧已经改成
     * 「范围没就绪时不推水位」（见 `persist` 的 `scopeNotReady`），
     * 所以即使顺序再被人改回去也不会丢数据。但把顺序摆对能让那一轮
     * 压根不发生 —— 少一次白跑的 CLI 调用，也少一条会让人困惑的日志。
     */
    distillSources.attach(
      db,
      pipelines.all().map((item) => ({ channelId: item.channelId, db: item.parts.db })),
    )
    await dataPlane.attach(
      db,
      vp.database,
      {
        dataRoot: vp.root,
        exportRoot: vp.exportRoot,
        klRoot: vp.klRoot,
        handoffFile: vp.handoffFile,
      },
      sourceAttachments(),
    )
  }

  /**
   * 卸载当前 vault。
   *
   * ## ★★ `keepIdentity` 存在的原因：挂载前那次预卸载**不能**清身份
   *
   * `mountVault()` 第一步是幂等地 `await unmountVault()`，而 `releaseVault`
   * 里有 `activeIdentity.clear()` —— 于是启动恢复那条路会**自己把刚恢复的
   * 身份清掉**，再去读它：
   *
   * ```
   * resolveOnLogin()  → this.current = 钉钉身份   （日志 "active identity restored"）
   * mountVault(id)
   *   └ unmountVault() → releaseVault() → clear()  ← 就这一句
   *   └ currentIdentity() → null → "identity_unbound"，不 seed 渠道 profile
   * ```
   *
   * 后果不是"少个字段"，而是**整条采集链路静默停摆**：`dwsProfileArgs()` 恒空
   * → 每条渠道命令都被"还没绑定渠道身份"的守卫拦下。实测（本机 13:30:25）
   * restore 与 `identity_unbound` 相隔 **121ms**，而两条日志各自都像正常的。
   *
   * ★ 为什么切渠道能"修好"：`switchTo()` 在 `await mount()` **之后**有一句
   * `this.current = target`（见 `ActiveIdentityService.switchTo`），自己把被清掉
   * 的补回来了。启动恢复这条路没有那一句 —— 所以表现成"重启后不采，切一下
   * 渠道就好了"。
   *
   * ★ 登出/擦除仍然要清（那才是 `clear()` 的本意），所以默认值是"清"，
   * 只有挂载前的预卸载显式传 `keepIdentity: true`。
   */
  const unmountVault = (options: { keepIdentity?: boolean } = {}): Promise<void> =>
    teardownVault({
      onboarding,
      distillSources,
      search,
      media,
      distill,
      persona,
      klServer,
      dataPlane,
      /**
       * ★★ 清引用 + 关库 —— 由 `teardownVault` 在**最后**调。
       *
       * 顺序不能提前：数据面 detach 时那条 `event stop --all --profile <旧>`
       * 要用身份 getter，先清就会退订错身份（而那条路径吞异常、无痕迹）。
       * 完整推理见 `VaultTeardownDeps.releaseVault` 的注释。
       */
      /**
       * ★ 非主渠道的管线在**关库之前**卸载：`dispose` 里要 `await` 停 kl
       * （它的 `KL_DATA_DIR` 指着这个 vault）与 detach feed，而后者会写库。
       * 顺序反了就是"往已关闭的连接上写"，那条错误没人 catch。
       */
      channelPipelines: pipelines,
      releaseVault: () => {
        mountedVault = null
        vaultPaths = null
        // ★ 见上面 `keepIdentity` 那段：挂载前的预卸载不清身份
        if (options.keepIdentity !== true) activeIdentity.clear()
        vaults.closeAll()
      },
      logger,
    })

  /**
   * 挂载一个 vault：开库 → 按 vault 铺好全部落点 → attach 各服务。
   *
   * ★ 幂等地先卸载：切身份与登录走的是同一条路，而"忘了先卸"的表现是
   * 两个身份的采集器同时在跑（都往各自的库写，但共用一个 8200 端口）。
   *
   * ★★ 每个服务收到的路径都来自 `vaults.paths(vaultId)` 这**一个**对象。
   * 那是刻意的：漏接一个字段是编译错误，而不是"那一类数据仍写在公共目录"
   * 这种静默的跨身份写入（见 `VaultStore.paths()` 的注释）。
   */
  /**
   * @param seedIdentity 这个 vault 属于谁 —— **由调用方给**，不在这里读
   *   `activeIdentity.currentIdentity()`。
   *
   *   ★★ 为什么必须是参数：切身份时 `ActiveIdentityService.switch()` 是
   *   「先 await mount，再更新内存态」（卸载阶段要用旧身份退订，那个顺序是对的）。
   *   于是在这里读 `currentIdentity()` 拿到的是**上一个**身份 —— 新 vault 的
   *   渠道配置目录会被 seed 成别人，而渠道命令按 seed 出来的身份作答。
   *   实测本机三个 vault 全部错配、两个正好对调。
   *
   *   `undefined` = 退回内存态推断。★★ **现在没有任何调用方走这一档** ——
   *   三个调用点（登录、启动恢复、切身份）都显式传。
   *
   *   ⚠️ 这条注释原来写着「`resolveOnLogin()` 在返回前就已经把内存态设好了，
   *   所以那里推断是对的」—— **那个前提是假的**，而它正是那个 bug 的来源：
   *   本函数第一行 `await unmountVault()` 的 `releaseVault` 会
   *   `activeIdentity.clear()`，把"返回前设好的"那份清掉。也就是说这一档
   *   在这里**永远**读到 null，而不是"当前内存态"。
   *
   *   留着这个分支只为让"显式传 `null`"（这个 vault 明确没身份）与"不传"
   *   在类型上仍是两件事；真要有新调用方走它，得先想清楚上面那句。
   */
  const mountVault = async (
    vaultId: string,
    seedIdentity?: ChannelIdentityVaultRecord | null,
  ): Promise<void> => {
    // ★ 预卸载**不清身份** —— 清了下一行就读不到（见 `unmountVault` 的注释）
    await unmountVault({ keepIdentity: true })

    /**
     * ★★ 把内存态**设回**卸载刚清掉的那个身份。
     *
     * 上面那行 `unmountVault()` 的最后一步 `releaseVault` 会
     * `activeIdentity.clear()` —— 那对**登出**是对的，但登录/启动恢复/切身份
     * 走的是同一条挂载路径，于是调用方刚定好的身份被顺带清成 null。
     *
     * ## 为什么"传了 seedIdentity"还不够
     *
     * `seedIdentity` 只喂给下面的 `seedChannelProfile`（渠道配置目录，
     * 身份隔离的**主防线**）。而**钉 `--profile` 那道**读的是
     * `activeIdentity.currentProfile()` → 内存态，两者是两条独立的路。
     * 上一版只修了前者，实测的样子：
     *
     * ```
     * 23:42:51.325  channel profile seeded for vault {channelId: dingtalk}  ← 主防线对了
     * 23:42:52.651  ingest started {channelId: dingtalk}                     ← 数据流起来了
     * 23:42:52.653  ingest tick failed {detail: "还没绑定渠道身份，拒绝执行渠道命令…"}
     * ```
     *
     * 采集/听记/文档三路全灭、事件流一路退避到 60s。
     *
     * ## ★ 为什么设回的位置**必须**是这里
     *
     * 在卸载**之后**（否则又被清掉），且在下面 attach 任何服务**之前**
     * （`dataPlane.attach()` 里就会起采集，而它第一条命令就要钉 profile）。
     * 这中间没有别的窗口 —— 所以这一行的位置本身就是判据。
     *
     * ★ 为什么不改成"`releaseVault` 别清"：那个 `clear()` 是登出语义的一部分
     * （登出后 `currentProfile()` 必须是 undefined）。卸载不知道自己是
     * "要登出"还是"要换个 vault 再挂回来"—— 知道的是调用方。
     *
     * ★ `undefined` 时**不动**内存态：那是"你自己看着办"，而此刻它已被卸载
     * 清空。留着这个区分是为了让"显式传 null"（这个 vault 明确没身份）
     * 仍然能把内存态清干净。
     */
    if (seedIdentity !== undefined) activeIdentity.adopt(seedIdentity)

    const handle = vaults.handle(vaultId)
    const vp = vaults.paths(vaultId)
    // ego 图的两个注入回调与 RuntimeEnv 的 dwsConfigDir getter 都读它
    mountedVault = handle.db
    vaultPaths = vp

    /**
     * ★★ 把渠道 CLI 的配置目录钉死在这个身份上 —— 身份隔离的**主防线**。
     *
     * 必须**显式 seed**，不能只建空目录：实测空目录会让 CLI 就地重建一份
     * profiles，而它取的是钥匙串里那个**全局 current** —— 那个值会被用户
     * 在终端改掉，也就是把要修的问题原样搬进了新目录。
     *
     * 未绑身份（基础 vault）时不 seed：那时还没有"这个 vault 属于谁"，
     * 而授权流程本身要能跑（`dwsConfigDir` 那个 getter 会退回旧目录）。
     */
    /**
     * ★ 身份来源：调用方给的优先，没给才退回内存态。
     *
     * 显式传 `null` 与不传是两件事：前者是"这个 vault 明确没有身份"，
     * 后者是"你自己看着办"。用 `=== undefined` 判而不是 `??` —— 后者会把
     * 显式的 `null` 也当成"没传"，于是又去读那个可能过期的内存态。
     */
    const identity = seedIdentity === undefined ? activeIdentity.currentIdentity() : seedIdentity
    /**
     * ★★★ seed 钉钉的 profile 只能用**钉钉那一行**身份。
     *
     * ## 为什么现在必须显式挑渠道
     *
     * `seedChannelProfile` 是**钉钉专属**的（写的是 dws 的 `profiles.json`，
     * 见 `plugins/dingtalk/profile-seed.ts`）。而从 control v5 起一个 vault
     * 可以挂**多个渠道**的身份（飞书一行、钉钉一行 —— 那正是多渠道并存），
     * 于是 `currentIdentity()` 返回的"这个 vault 的当前身份"**可能是飞书的**。
     *
     * 拿飞书的 `corpId/userId` 去 seed 钉钉的 profile，后果不是报错而是
     * **越权读取面**：dws 会按一个不属于它的身份作答，也就是"拿着 A 的
     * 凭据目录去读 B 的会话"。而这正是 profile-seed 这道防线本身要挡的事
     * （见那个文件的文件头），却会被"vault 里有另一个渠道"从内部打开。
     *
     * 判据：只有当这一行身份**就是主渠道（钉钉）的**才 seed。
     * 飞书的凭据走它自己的隔离目录（`channels/feishu/`，见 `LarkCli.authRoot`），
     * 与 dws 的 profiles.json 无关，所以跳过对它完全无损。
     *
     * ★ 用 `startsWith(dingtalk.meta.id)` 而不是全等：`channelId` 会带
     * 「来源应用」后缀（`dingtalk@src-…`，用户自备 CLI 那种），
     * 全等会把自备那份漏掉、于是它的 profile 永远不被 seed。
     */
    if (identity !== null && identity.channelId.startsWith(dingtalk.meta.id)) {
      const seeded = seedChannelProfile(vp.dwsHome, {
        corpId: identity.corpId,
        userId: identity.userId,
      })
      if (seeded) logger.info("channel profile seeded for vault", { channelId: identity.channelId })
    }

    /**
     * ★★ 没绑身份 → **不起任何拉数据的东西**。
     *
     * ## 为什么这不只是省资源
     *
     * 未绑身份时 `dwsProfile()` 返回 undefined，于是 `dwsProfileArgs()` 给空数组
     * —— 渠道命令**不带 `--profile`**，也就跟着 CLI 的**全局 currentProfile** 走。
     * 而那个值由用户在终端里的最后一次操作决定。
     *
     * 后果是拿着一个**没有身份的基础 vault**去采**某个人**的会话与消息：
     * · 采到的数据落进基础 vault，而它不属于任何身份；
     * · 之后用户真去授权 → 走 `bindAuthorized` 建/挂另一个 vault →
     *   那批数据留在基础 vault 里成为孤儿，既不显示也不清理；
     * · 更糟的是全局 profile 恰好是**另一个组织**时，我们就把别人的
     *   聊天记录采进来了 —— 与 CLAUDE.md §5「不许扩大读取面」直接冲突。
     *
     * 而这一切是**静默**的：探针照跑、日志照记、状态页显示"采集中"。
     *
     * ## 起什么、不起什么
     *
     * 不起：采集/Feed（`dataPlane.attach`）、数字人调度（`persona.start`）、
     * kl 检索子进程（`ensureReady`，约 90s warmup + 常驻内存）——
     * 三者都会 spawn 子进程或按周期拉数据。
     *
     * 仍然做：`attach` 那些**纯本地**的绑定（onboarding / media / search /
     * persona.attach / klServer.rebind）。它们不拉数据，而引导流程要往
     * 这个库里写（选范围、存数字人草稿），设置页也要能读。
     *
     * 绑上身份之后走的是 `switchTo()` → `mount()`，那时这个分支不成立，
     * 三者照常起来 —— 所以这里不需要"补起"的逻辑。
     */
    const dataFlowsAllowed = identity !== null
    if (!dataFlowsAllowed) {
      logger.info("vault has no bound channel identity; skipping data flows", {
        // 不记 vaultId：它是存储布局，日志里给出"为什么不采"就够了
        reason: "identity_unbound",
      })
    }

    onboarding.bind(
      new SettingsRepository(handle.db, "vault_settings"),
      new OnboardingRepository(handle.db),
    )
    /**
     * ★ 范围要写进**每一个**渠道库：`readCollectionScope` 是逐库读的，
     * 只写主库的话其余渠道判成"从没配过 → 不设限"，于是按全量采
     * （用户明明选了 7 天与 10 个会话）。见 `DistillSourceService.save`。
     *
     * 挂载这一刻管线可能还没建好（那是 fire-and-forget 的）——
     * `remountDataPlane` 之后会补一次 attach。
     */
    distillSources.attach(
      handle.db,
      pipelines.all().map((item) => ({ channelId: item.channelId, db: item.parts.db })),
    )
    /**
     * 跑 forge（测量型引擎），产出 skill 包。这是画像的**唯一**来源。
     *
     * 路径按 vault 给：语料是这个账号的，产物也只该被这个账号看到。
     *
     * ★ `since` 由 `DistillService` 给，**不再写死 `null`**。
     *
     * 写死的后果（实测）：引导页那个「30 / 90 / 180 天」选择器选完后
     * `days` 一路传到 `distill.start()` 就被丢掉，forge 永远按增量水位跑
     * （首次跑退化成 `analysisStart` = 库里最早那条消息的日期）。
     * 也就是**选什么都一样**，而 `distill_sources.scope_json` 里却
     * 老实记着用户选的那个 `since` —— 两处不一致，且界面上看不出来。
     *
     * `null` 仍然有意义：那是"不限范围"（自动重蒸走这条，见
     * `DistillService.attach` 里 autoTimer 的注释）。
     *
     * ★ 返回**完整**结果而不是 `{ok, reason}`：`messages` / `turns` /
     * `asks` / `files` / `grade` 是回答"蒸得怎么样"的那五个数，而它们
     * 曾经在这个边界上被丢掉 —— 于是 UI 只能显示「等待中」。
     *
     * `signal` 一路传到 `ProcessRunner.spawn`：不传的话「停止」按钮
     * 对在跑的那一轮完全无效（超时上限加起来近半小时）。
     */
    distill.attach(
      handle.db,
      (signal, onStep, since, windowDays) =>
        forge.run({
          db: handle.db,
          vaultPath: vp.database,
          forgeRoot: vp.forgeRoot,
          skillRoot: vp.skillRoot,
          since: since ?? null,
          /**
           * ★ 测量窗口（`build --window-days`）。与 `since` 是两件事：
           * `since` 管采集下界，这个管 build 看哪一段。只传 `since` 时
           * 语料库里已有的更早历史照样会被测进去 —— 于是「选 30 天」与
           * 「选 180 天」产出相同，与那个已修的 `since` bug 症状一致。
           */
          windowDays: windowDays ?? null,
          ...(signal === undefined ? {} : { signal }),
          // 阶段回调透传：让界面能显示"正在测量"而不是干等一句"正在蒸馏"
          ...(onStep === undefined ? {} : { onStep }),
        }),
      /**
       * 「重新蒸馏」要真的从头来 —— forge 的水位在它自己的派生库里，
       * 不在 vault 里，所以这一步只能由持有路径的这一层给。
       */
      () => forge.resetWatermark(vp.forgeRoot),
      /**
       * ★ work 层产物落进 forge 的 skill 包。
       *
       * 路径与 forge 的 `skillRoots` 必须是**同一个**（`<skillRoot>/persona-persona`）
       * —— 写到别处等于没接上：persona 的 workspace 只装那个包，
       * 而这个文件的全部意义就是被那里的 agent 读到。
       *
       * 已在 forge 配置的 `externalSkillFiles` 里登记（见 `writeConfig`），
       * 所以 `publish` 不会把它当残留删掉、`lock` 也不会锁成只读。
       *
       * `content === null` = 这轮没有够格的结论 → **删掉**旧文件。留着会让
       * agent 读到上一轮的结论，而那份可能正是这轮被判为置信度不足的。
       */
      (content) => {
        const file = join(vp.skillRoot, "persona-persona", WORK_LAYER_SKILL_PATH)
        if (content === null) {
          rmSync(file, { force: true })
          return
        }
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        // 0600：产物含蒸馏出的工作内容，与 vault 同一档（见 vendor/forge/README.md）
        writeFileSync(file, content, { encoding: "utf8", mode: 0o600 })
      },
      /**
       * ★ 攒批判据的「首次」分支读这个，而不是读游标是否为 0。
       *
       * 两者不是一回事：产物可能被删过（换 vault、用户清过 skill 包、上一轮
       * 因置信度不足而删了它），那时游标还在。只看游标会让这些情况**永远
       * 不再产出** —— 而界面上看不出来。
       */
      () => existsSync(join(vp.skillRoot, "persona-persona", WORK_LAYER_SKILL_PATH)),
      /**
       * ★ forge 测出的 ask 频率 → `work.md` 的「别人找他做什么」那一节。
       *
       * 频率**只能**来自这里（测量），内容来自 LLM（抽取）。让 work 层自己
       * 数一遍会造出第二个真源，而两个数并排写在同一行、打架时没有任何
       * 机制决定谁赢 —— 那是最坏的一种不一致：不报错，随机生效。
       */
      () => readForgeWorkContext(vp.forgeRoot),
    )
    /**
     * agent 的三个目录：workspace 与 HOME 按 vault，npm 缓存应用级一份。
     *
     * ★ 缓存不按身份分是一条实测取舍：那是 registry 的只读镜像（325 MB），
     * 按身份各拷一份等于两个身份 650 MB 且首次切换要重新联网（见 `AgentDirs`）。
     */
    const agentDirs = {
      workspaceRoot: vp.agentWorkspaceRoot,
      home: vp.agentHome,
      npmCache: paths.agentNpmCache,
    }
    persona.attach(handle.db, vp.skillRoot, agentDirs)
    media.attach(handle.db, {
      media: vp.mediaRoot,
      avatar: vp.avatarRoot,
      upload: vp.uploadRoot,
    })
    /**
     * ★★ kl 换到这个身份的图库 —— **必须在 `ensureReady()` 之前**。
     *
     * 反过来的话它会带着上一个身份的 `KL_DATA_DIR` 起进程，
     * 而那意味着新身份查到的是上一个人的知识（见 `rebind()` 的注释）。
     * `unmountVault` 已经 await 过 `stop()`，所以这里端口是干净的。
     */
    /**
     * ★★ 非主渠道的采集管线：按**已授权**的渠道挂，一条一个 kl。
     *
     * 判据前移到这里（而不是让 `feed.attach` / `ensureReady` 各自判断）
     * 之后，"没连的渠道不该有任何东西在跑"这件事只有一个落点。
     *
     * ★ 不 await：一条管线要建 FeedService（会导出四件套）与探测端口，
     * 而登录不该等它。失败只记日志 —— 那时主渠道照常可用。
     */
    void (async () => {
      const authorized = await channels.authorizedChannels()
      const others = authorized.filter((id: string) => id !== dingtalk.meta.id)
      if (others.length === 0) {
        await pipelines.mount(vaultId, [])
        return
      }
      await pipelines.mount(vaultId, others)
      // 管线建好之后再让数据面认识它们（IngestService 按 source 起）
      await remountDataPlane()
      /**
       * ★★ 补一次**非主渠道的本人身份** —— 少了这一步它们的 ego 图恒不可用。
       *
       * ## 为什么必须在这里，而不是只在授权时
       *
       * 身份行原来**只有** `applyPostAuthIdentity` 会写（`onAuthorized` 那条路），
       * 也就是只在「本次会话里刚点过重新授权」时。而常态是**上次授权、这次重启**
       * —— 那条路一次都不跑。
       *
       * 实测（本机）：飞书图库里有 14 个实体、kl 就绪在 8201，而
       * `channel_self_identity` **0 行** → `getSelfNames()` 返回空 →
       * 仪表盘上一句「还不知道你在飞书里叫什么」，图整块空白。
       * 图是建好的，只差"我是谁"这一行。
       *
       * 我上一轮把渠道 id 传进了 `applyPostAuthIdentity`（那是对的、也是必须的），
       * 但只修了授权那条路 —— 于是用户不重新授权就永远看不到图。这一步补上。
       *
       * ## ★ 为什么 resolve 之后还要 confirm
       *
       * `is_self` 是在 confirm 时回填的。只 resolve 的话身份表有行、
       * 而消息的归属判定全是 NULL —— 主渠道那边同一个坑踩过（9768 条全被拒）。
       *
       * ★ 已经确认过就不重复 confirm（那会再扫一遍全表回填）。
       *
       * ★ **不 await、失败只记日志**：这是一次子进程调用（`auth status --verify`），
       * 而它失败的原因通常是环境性的（办公网拦了域名、凭据过期）。
       * 那时该降级成"这个渠道的 ego 图不可用"，而不是让整条管线挂载失败 ——
       * 后者会连带把已经建好的 kl 与采集一起拖掉。
       */
      for (const item of pipelines.all()) {
        void (async () => {
          const resolved = await dataPlane.resolveSelf(item.channelId)
          if (!resolved.confirmed) dataPlane.confirmSelf(item.channelId)
          logger.info("channel self identity ready", {
            channelId: item.channelId,
            // ★ 只记数量与布尔，不记名字（那是真实人名）
            openIds: resolved.openIds.length,
            matched: resolved.matchedMessageCount,
          })
        })().catch((error: unknown) => {
          logger.warn("channel self identity unavailable", {
            channelId: item.channelId,
            detail: error instanceof Error ? error.message : String(error),
          })
        })
      }
      /**
       * ★★ 起每条管线自己的 kl —— 少了这一步它们**永远是「未启动」**。
       *
       * 实测症状：状态页上飞书那一栏恒显示「未启动」，而日志里连一条
       * `KlServer:feishu` 都没有 —— 因为 `ensureReady()` 一次都没被调过。
       * 挂载只是把服务**造出来**，起进程是另一件事。
       *
       * ★ 那条 `onAuthorized` 里的 `ensureReady` 覆盖不了这条路径：它只在
       * 「本次会话里刚授权」时跑，而**上次授权、这次重启**走的是这里。
       *
       * fire-and-forget：一个 kl 冷启 ~90s（Qdrant warmup），不能阻塞登录。
       * 失败只降级（那个渠道的图谱查不了），不影响主渠道。
       */
      for (const item of pipelines.all()) {
        void item.parts.klServer.ensureReady().catch(() => undefined)
      }
    })().catch((error: unknown) => {
      logger.error("channel pipelines mount failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    })

    klServer.rebind({ dataDir: vp.klRoot, exportDir: vp.exportRoot })
    // kl-server 随登录懒启动（warmup ~90s，不阻塞登录）。fire-and-forget：
    // ensureReady 内部轮询健康、自己管状态机（starting→ready/failed）并经 IPC
    // 推 UI，绝不能 await（会卡住登录）。失败只降级（搜索落回本地召回），不抛。
    // ★ 未绑身份时不起：90s warmup + 常驻内存，而那个库里还没有任何语料。
    if (dataFlowsAllowed) void klServer.ensureReady().catch(() => undefined)
    /**
     * 数字人调度器随登录启动。
     *
     * 启动它是安全的：回复模式默认 `draft`（只出草稿），且自动发送
     * 还要过白名单与授权门。所以调度器起来了也不会替用户发出任何消息。
     *
     * ★ 注意这里**不再**说"默认 listening = 0 所以不处理任何消息" ——
     * 那个开关已经删了，现在管控层收所有消息（它是订阅者）。
     * 安全性来自"发不发"那一层，不是"收不收"。
     *
     * ★ 未绑身份时不起：它按周期跑、会去渠道取消息与联系人，
     * 而那时命令不带 `--profile`（见上面 `dataFlowsAllowed` 那段）。
     */
    if (dataFlowsAllowed) persona.start()
    search.attach(handle.db, agentDirs)
    /**
     * ★★ 数据面**总是** attach，但没身份时**不起定时器与长连接**。
     *
     * 这两件事的前置条件不同（见 `DataPlaneService.attach` 的注释）：
     * 挂库是"解析身份"的前置（`resolveSelf` 要写身份行、要拿库里的单聊
     * 做交集判据），而拉数据必须等到有身份之后。
     *
     * 整个跳过 attach 的后果（实测，用户日志）：点「用这个身份」时
     * `resolveSelf()` 抛「尚未登录，无法解析身份」——**挂库是获得身份的前置，
     * 而我把它挡在了"要先有身份"后面**。那是这道闸造成的第二个死锁。
     */
    await dataPlane
      .attach(
        handle.db,
        vp.database,
        {
          dataRoot: vp.root,
          exportRoot: vp.exportRoot,
          klRoot: vp.klRoot,
          handoffFile: vp.handoffFile,
        },
        sourceAttachments(),
        { pollingEnabled: dataFlowsAllowed },
      )
      .catch((error: unknown) => {
        // 数据面挂载失败不该阻止登录：用户仍能用设置页与授权，
        // 状态页会显示 lastError。把它变成"登录失败"才是过度反应。
        logger.error("data plane attach failed", {
          detail: error instanceof Error ? error.message : String(error),
        })
      })
  }

  /**
   * 当前**带来源作用域**的渠道 id —— `dingtalk` 或 `dingtalk@src-<hash>`。
   *
   * ## ★★★ 为什么恢复身份时也必须带上它
   *
   * 隔离键的第一段是「哪个 dws 二进制」（见 `source-key.ts`）：实测两个
   * 来源的 CLI 返回**完全相同**的 corpId/userId，不带来源会被判成同一个
   * 身份、共用一个 vault，于是两批语料混进同一份画像。
   *
   * 而那道作用域原来**只在 `onAuthorized` 那一条路上**生效。启动恢复
   * （`resolveOnLogin`）完全不知道当前用的是哪个二进制 —— 于是它会挑到
   * 另一个来源的身份。实测（本机日志 2026-08-09）：
   *
   * ```
   * 23:23:28  active identity restored {channelId: "dingtalk"}   ← 内置那份的身份
   * 23:23:28  vault opened {vaultId: "vaultFAKE-B…"}                ← 内置那份的库
   * 23:25:02+ process {"executable": "…/dws-darwin-arm64"}       ← 跑的却是自制客户端
   * ```
   *
   * 也就是**自制客户端采的数据写进了内置客户端的 vault**，而那一轮往错的库
   * 里写了 8898 条消息。这正是 source-key 要结构性排除的事，被这条路绕开了。
   *
   * ★ 现读 `dwsSource.path()`：用户在设置里换了客户端之后立刻生效，
   * 与 `runtime.resolve("dws")` 的行为一致（那个 getter 也是现读同一个值）。
   */
  const scopedDingtalkChannelId = (): string =>
    scopedChannelIdFor(dingtalk.meta.id, dwsSource.path())

  /**
   * 身份切换器。它只管"当前是谁"，真正的挂载动作由上面那个 `mountVault`
   * 完成（见 `ActiveIdentityService` 的文件头：为什么两者分开）。
   */
  const activeIdentity: ActiveIdentityService = new ActiveIdentityService({
    identities,
    settings,
    logger: logger.child("Identity"),
    now: () => new Date(systemClock.now()),
    mount: (vaultId, identity) => mountVault(vaultId, identity),
  })

  const auth = new AuthService({
    accounts,
    sessions,
    signingKey: new SigningKeyStore({ settings, logger: logger.child("SigningKey") }),
    hasher: new ScryptPasswordHasher(),
    logger: logger.child("Auth"),
    /**
     * 登录态变化时挂/摘 vault 与数据面。
     *
     * 只有一处地方开关，因此不会出现「登录了但 vault 没开」
     * 或「登出了 vault 还开着」——后者意味着账号级数据在登出后仍可读，
     * 而对数据面来说还意味着「已登出的账号仍在被采集、且 Feed 端口仍在暴露它」。
     *
     * ## ★ 挂哪个 vault 由**身份**决定，不再是 `accounts.vault_id`
     *
     * 隔离维度已经是「渠道身份」：一个账号下可以有多个身份，各自一个 vault。
     * `resolveOnLogin` 挑出该用哪个（上次用的 / 最近用过的 / 还没绑过身份时
     * 退回账号的基础 vault），完整规则见那个方法。
     *
     * ★ `void` + `catch`：`AuthService.onSessionChange` 的契约是同步的
     * （它在返回 session 之前调），而挂载现在是异步的（要 await 卸载里
     * 那几步）。挂载失败不该让登录失败 —— 用户仍能用设置页与授权。
     */
    onSessionChange: (next) => {
      if (next === null) {
        void unmountVault().catch((error: unknown) => {
          logger.error("unmount vault failed", {
            detail: error instanceof Error ? error.message : String(error),
          })
        })
        return
      }
      /**
       * ★★ 身份要**显式传给 mount**，不能让它去读内存态。
       *
       * `mountVault` 第一件事是 `await unmountVault()`，而那里的
       * `releaseVault` 会 `activeIdentity.clear()` —— 于是 `resolveOnLogin`
       * 刚设好的身份被随后的卸载清掉，mount 里读到 null → `identity_unbound`
       * → 数据流整个不起。完整推理见 `resolveOnLogin` 的注释。
       */
      const { vaultId, identity: resolved } = activeIdentity.resolveOnLogin({
        accountId: next.accountId,
        fallbackVaultId: next.vaultId,
        // ★ 带上来源作用域，否则会挑到另一个 dws 的身份（见那个 getter 的注释）
        scopedChannelId: scopedDingtalkChannelId(),
      })
      void mountVault(vaultId, resolved).catch((error: unknown) => {
        logger.error("mount vault failed", {
          detail: error instanceof Error ? error.message : String(error),
        })
      })
    },
  })
  // 持久化的会话 token 在装配阶段校验：窗口打开前就定好登录态，
  // 避免渲染层先闪一下登录页再跳进主壳。
  const restored = auth.restoreSession()

  /**
   * 「清空当前渠道的数据」—— 把这个渠道身份**整个归零**。
   *
   * ## ★ 装配位置：必须在 `auth` 与 `activeIdentity` 之后
   *
   * 它要读"当前是哪个身份"（解绑用）与"当前登录的是哪个账号"
   * （重挂时挑新目标用）。放在它们之前会踩 const 的 TDZ。
   *
   * ## 复用三个已有能力，不自己实现
   *
   * · `unmountVault` —— 停服务的顺序里每一步都对应一个实测过的坑
   *   （await 采集收尾、先停 kl 再换 dataDir、退订要用旧身份的 profile），
   *   见 `vault-teardown.ts` 的文件头；
   * · `vaults.destroy` —— 先 close 句柄再删目录（含 WAL/SHM 残留）；
   * · `activeIdentity.resolveOnLogin` —— 解绑之后"该挂哪个"的规则。
   *   自己判会得到第二份同义实现，而两份必然分叉。
   */
  const channelDataWipe = new ChannelDataWipeService({
    clock: systemClock,
    logger: logger.child("DataWipe"),
    currentVault: () => {
      const vp = vaultPaths
      // 判据用 vaultPaths 而不是 mountedVaultId：后者在登出后是过期值（见 releaseVault）
      return vp === null ? null : { root: vp.root, database: vp.database }
    },
    currentIdentity: () => {
      const current = activeIdentity.currentIdentity()
      if (current === null) return null
      return {
        key: {
          accountId: current.accountId,
          channelId: current.channelId,
          corpId: current.corpId,
          userId: current.userId,
        },
        vaultId: current.vaultId,
      }
    },
    unmount: () => unmountVault(),
    /**
     * 退授权：清钥匙串里那份 token（见 `ChannelDataWipeService` 文件头）。
     *
     * ★ 这一步是"清了还是已授权"那个 bug 的修法。删 vault 目录带不走
     * 钥匙串里的密钥，所以必须让渠道 CLI 自己去清。
     */
    revokeAuth: (channelId) => channels.logout(channelId),
    destroyVault: (vaultId) => {
      vaults.destroy(vaultId)
    },
    /**
     * 这个 vault 上除了给定渠道还绑着哪些渠道（多渠道共用 vault 时 > 0）。
     * `listByVaultId` 返回该 vault 的全部身份行，按 channelId 去掉自己。
     * ★ 比较用 `parseScopedChannelId` 剥掉来源段后的裸渠道名：库里存的可能
     * 带 `@src-xxxx` 后缀，直接字符串比会把"同一个渠道的另一来源"当成别的渠道。
     */
    siblingChannels: (vaultId, channelId) => {
      const bare = (id: string): string => parseScopedChannelId(id).channelId
      const self = bare(channelId)
      return identities
        .listByVaultId(vaultId)
        .map((row) => bare(row.channelId))
        .filter((id) => id !== self)
    },
    /**
     * 只删一个渠道在这个 vault 里的子树：`sources/<id>/`（库/导出/图谱/交接）
     * 与 `channels/<id>/`（那份隔离的凭据目录）。用于多渠道共用 vault 的情形
     * —— 见 `ChannelDataWipeOptions.destroyChannelSubtree` 的注释。
     */
    destroyChannelSubtree: (vaultId, channelId) => {
      const bare = parseScopedChannelId(channelId).channelId
      const targets = [
        vaults.sourceRoot(vaultId, bare),
        join(vaults.directory(vaultId), "channels", bare),
      ]
      let removed = 0
      for (const dir of targets) {
        if (!existsSync(dir)) continue
        rmSync(dir, { recursive: true, force: true })
        removed += 1
      }
      logger.info("channel subtree destroyed", { channelId: bare, removed })
      return removed
    },
    unbindIdentity: (key) => {
      identities.unbind(key)
      /**
       * ★ 一并清掉"上次用的是哪个身份"那条记忆。
       *
       * 不清的话下次登录 `resolveOnLogin` 会先查它 —— 虽然那里对
       * 查不到的情况有兜底（删掉记录再往下走），但留着等于让每次登录
       * 都先撞一次空。而且刚被归零的那个身份不该出现在任何"上次用的"里。
       */
      activeIdentity.clear()
    },
    remount: async () => {
      /**
       * 解绑之后重新挑一个 vault 挂上。
       *
       * ★ 走 `resolveOnLogin` 而不是重挂刚才那个：那条规则会在
       * "这个账号还有别的身份"时挑最近用过的，在"一个都没有"时退回
       * 账号的**基础 vault** —— 后者正是"注册了但还没连渠道"的状态，
       * 也就是用户会看到未授权 + 引导流程重新出现。
       */
      const session = auth.currentSession()
      const fallbackVaultId = auth.currentVaultId()
      if (session === null || fallbackVaultId === null) {
        // 没登录（理论上到不了：wipe 已经判过 vaultPaths 非空）
        logger.warn("channel data wipe: no session; nothing to remount", {})
        return
      }
      // ★ 同上：身份显式传给 mount（见 `resolveOnLogin` 的注释）
      const { vaultId, identity: resolved } = activeIdentity.resolveOnLogin({
        accountId: session.accountId,
        fallbackVaultId,
        // ★ 同上：清库后重挂也要认来源
        scopedChannelId: scopedDingtalkChannelId(),
      })
      await mountVault(vaultId, resolved)
    },
  })

  const status = new StatusService({
    paths,
    config,
    dotenvLoaded,
    dotenvPath,
    migrations: store.appliedMigrations,
    accounts,
  })

  const channels = new ChannelService({
    host: new ChannelHost(registry),
    logger: logger.child("Channel"),
    getWindow: () => window,
    /**
     * ★ 授权成功 → 解除采集 blocked、确认本人身份、刷新账号头像与显示名。
     *
     * 实现在 `post-auth-identity.ts`（那里有完整的 why）。三条真实踩过的坑
     * 都在那个文件里锁着：
     * ① 两段必须**各自** try/catch —— 身份解析抛错曾把取头像整段带走；
     * ② 显示名要一起回填 —— `applyChannelProfile` 一直支持它却没人传；
     * ③ 第零步解除采集的 blocked 终态 —— 否则用户重新授权后采集再也不跑。
     *
     * 提成独立文件的理由：留在这个闭包里没法写测试（要测就得把整个
     * `bootstrapApp()` 跑起来：Electron、真 vault、迁移、python env…）。
     */
    onAuthorized: async (channelId, status) => {
      /**
       * ★★ 第一步：把这次授权的身份路由到**它自己的** vault。
       *
       * 必须在 `applyPostAuthIdentity` **之前** —— 后者会 upsert 身份行，
       * 也就是会撞 `SELF_IDENTITY_CONFLICT` 那道守卫。先分流之后，
       * 换组织重新授权走的是"切到那个身份的库"，守卫自然不触发。
       * 完整的三条分支与 why 见 `routeAuthorizedIdentity`。
       */
      const session = auth.currentSession()
      const vaultId = auth.currentVaultId()
      await routeAuthorizedIdentity({
        identity: activeIdentity,
        logger,
        session:
          session === null || vaultId === null
            ? null
            : { accountId: session.accountId, baseVaultId: vaultId },
        newVaultId: () => randomUUID(),
        /**
         * ★★ 带上「来源应用」那一段，而不是裸的 `channelId`。
         *
         * 实测：同一台机器上装了两个不同来源的渠道 CLI（随包的开源版、
         * 用户自备的闭源版），两者 `auth status` 返回的 `corp_id` 与
         * `user_id` **完全相同**（逐字段 sha256 比对，13 个字段全等）。
         * 不带来源的话它们会被判成同一个身份、共用一个 vault ——
         * 而两者的消息面不同，混进一个库就是把两批语料蒸进同一份画像。
         *
         * ★ 内置那份**不加后缀**，所以存量行（`channel_id = "dingtalk"`）
         * 照旧命中、零迁移。完整的 why 见 `source-key.ts`。
         *
         * ★ 读 `dwsSource.path()` 而不是 `runtime` —— 它是同一个值的源头
         * （`RuntimeEnv` 的 `dwsBinOverride` getter 就是读它），
         * 而且这里要的是"**现在**用的是哪个二进制"：用户在 UI 上改过路径
         * 之后立刻生效，与 `resolve()` 的行为一致。
         */
        channelId: scopedChannelIdFor(channelId, dwsSource.path()),
        status,
      })
      /**
       * ★ 非主渠道刚授权 → 立刻挂它的管线并起 kl，不必重启应用。
       *
       * 主渠道不走这里：它的管线是 `mountVault` 里那一套固定服务
       * （`klServer` / `feed` / `graphQuery`），已经随登录挂好了。
       */
      if (channelId !== dingtalk.meta.id) {
        const mounted = await pipelines.mountOne(channelId).catch((error: unknown) => {
          logger.error("channel pipeline mount on authorize failed", {
            channelId,
            detail: error instanceof Error ? error.message : String(error),
          })
          return null
        })
        if (mounted !== null) {
          await remountDataPlane().catch((error: unknown) => {
            logger.error("data plane remount after authorize failed", {
              channelId,
              detail: error instanceof Error ? error.message : String(error),
            })
          })
          // fire-and-forget：warmup ~90s，不能让授权流程等它
          void mounted.klServer.ensureReady().catch(() => undefined)
        }
      }
      await applyPostAuthIdentity(
        { dataPlane, media, auth, logger, toFileUrl: toLocalFileUrl },
        status,
        /**
         * ★ 把渠道传下去 —— 不传的话身份会写到**主渠道**那张表上，
         * 而这次授权的渠道那张表一行都没有（完整后果见
         * `applyPostAuthIdentity` 的 `channelId` 注释：ego 图恒不可用 +
         * `is_self` 不回填）。
         */
        channelId,
      )
    },
  })

  registerIpc({
    auth,
    activeIdentity,
    status,
    channels,
    onboarding,
    distillSources,
    distill,
    persona,
    media,
    mediaByChannel,
    preferences,
    dataPlane,
    search,
    klServer: appKlServer,
    graphQuery: appGraphQuery,
    dashboardTrends,
    advancedAi,
    runtimeConfig,
    dwsSource,
    channelDataWipe,
    logger: logger.child("Ipc"),
  })

  logger.info("bootstrap done", {
    controlVersion: store.appliedVersion,
    accountCount: accounts.count(),
    sessionRestored: restored !== null,
    binDir: paths.binDir,
  })

  return {
    paths,
    logger,
    store,
    vaults,
    auth,
    status,
    channels,
    onboarding,
    distillSources,
    distill,
    forge,
    persona,
    media,
    preferences,
    dataPlane,
    search,
    klServer: appKlServer,
    graphQuery: appGraphQuery,
    dashboardTrends,
    advancedAi,
    runtimeConfig,
    settings,
    openDevTools: config.values.devTools,
    setWindow: (next) => {
      window = next
    },
    dispose: async () => {
      /**
       * 顺序：停采集与 Feed → 关 vault → 关控制库。
       *
       * ## ★ 每一步都过 `runShutdownStep`（分步超时 + 逐步日志）
       *
       * 首版是一串裸 `await`，外面套一个 `try/catch`。两个问题：
       *
       * ① **没有超时**。这些步骤全在等外部世界（ACP 的 session/dispose、
       *    DWS 子进程、kl 子进程），任一步不返回就是**退不出去** ——
       *    而 `before-quit` 已经 preventDefault 了，表现是窗口关了、
       *    进程还在、Dock 图标赖着不走。
       * ② **第一个抛错会跳过后面所有步骤**（同一个 try 块）。而
       *    `store.close()` 排在最后，它是唯一有持久化后果的那一步。
       *
       * 现在每步独立：超时/失败都只记日志并继续，见 `shutdown.ts`。
       *
       * `await` 而不是 `void` 的理由不变：`dataPlane.detach()` 要等在途的
       * 那一轮采集收尾（可能正 await 一个 0.6s 的子进程），不等就关库会抛
       * 一堆 `The database connection is not open` —— 无害但会淹没真正的
       * 退出问题，而且是 unhandledRejection（退出码可能变）。
       */
      const runner = { logger: logger.child("Shutdown"), clock: systemClock }
      /**
       * 先摘掉电源监听：dispose 期间 `dataPlane` 会被 detach，而
       * `powerMonitor` 的监听是**进程级**的（不随 context 走）。不摘的话
       * 合盖会调到一个已经 detach 的数据面上 —— 现在只是 no-op，
       * 但它是个悬着的引用，下次装配就会有两份监听同时在跑。
       */
      powerMonitor.off("suspend", onSystemSuspend)
      powerMonitor.off("resume", onSystemResume)
      // 同步且无外部依赖的两个不值得单独计时
      distillSources.detach()
      media.detach()
      // 先优雅收掉 opencode（撤 token + kill 进程，无孤儿），再 detach。
      await runShutdownStep(runner, "search", () => search.shutdown())
      search.detach()
      await runShutdownStep(runner, "distill", () => distill.detach())
      await runShutdownStep(runner, "persona", () => persona.detach())
      // kl 子进程同样优雅停（SIGTERM→SIGKILL，无孤儿）。
      await runShutdownStep(runner, "klServer", () => appKlServer.stop())
      await runShutdownStep(runner, "dataPlane", () => dataPlane.detach())
      await runShutdownStep(runner, "db", () => {
        vaults.closeAll()
        store.close()
      })
      logger.info("shutdown complete")
    },
  }
}
