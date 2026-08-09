/**
 * 启动装配。
 *
 * 顺序是刻意的：配置 → 日志（需要 level）→ 数据库（需要路径）→ 服务 → IPC → 窗口。
 * 任一步失败都直接抛出，由 index.ts 统一处理为「启动失败」，
 * 而不是让应用带着半初始化的状态打开窗口。
 */
import { randomUUID } from "node:crypto"
import { rmSync, statSync } from "node:fs"
import { join } from "node:path"
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
  type SqliteDatabase,
  type StoreHandle,
  type VaultPaths,
} from "@mycontext/store"
import {
  ChannelHost,
  createDingTalkPlugin,
  createFeishuPlugin,
  createRegistry,
  scopedChannelId,
  seedChannelProfile,
  sourceKeyOf,
} from "@mycontext/channels"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { LlmHolder } from "@mycontext/llm"
import { IPC_EVENTS } from "@mycontext/ipc-contract"
import type { KlGraphOverview } from "@mycontext/ipc-contract"
import { bootstrapConfig } from "./config.js"
import { resolveAppPaths, type AppPaths } from "./paths.js"
import { applyPostAuthIdentity, routeAuthorizedIdentity } from "./post-auth-identity.js"
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
import { ForgeService } from "../services/forge.service.js"
import { MediaService } from "../services/media.service.js"
import { PersonaService } from "../services/persona.service.js"
import { PersonaGate } from "../services/persona-gate.js"
import { SearchService } from "../services/search.service.js"
import { KlServerService } from "../services/kl-server.service.js"
import { ensurePythonEnv } from "../services/python-env.js"
import { GraphQueryService } from "../services/graph-query.service.js"
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
  klServer: KlServerService
  /** 图谱只读查询（ego 图 + 事实检索）。与 klServer 分开，见构造处注释 */
  graphQuery: GraphQueryService
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
     * ★ 把渠道命令钉在当前身份上（`--profile <corpId>:<userId>`）。
     * 每条命令现读 —— 切完身份**下一条命令**就用新身份，不必重启。
     */
    dwsProfile: () => activeIdentity.currentProfile(),
  })
  const processes = new ProcessRunner(logger.child("Process"))
  const dingtalk = createDingTalkPlugin({
    runtime,
    processes,
    logger: logger.child("DingTalk"),
    openExternal: (url) => shell.openExternal(url),
  })
  const registry = createRegistry([dingtalk, createFeishuPlugin()])

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
        const r = runtimeConfig.resolved()
        return r.klBaseUrl.trim() !== "" && r.klApiKey.trim() !== ""
      },
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
    },
  })

  const distillSources = new DistillSourceService({
    clock: systemClock,
    logger: logger.child("DistillSource"),
    plugin: dingtalk,
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
     */
    onScopeChanged: () => {
      void (async () => {
        try {
          const report = dataPlane.applyScopeChange()
          if (report !== null && report.messages > 0) {
            logger.info("scope change purged out-of-scope corpus", {
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
            detail: error instanceof Error ? error.message : String(error),
          })
        }
        try {
          feed.export()
        } catch (error) {
          logger.warn("scope change re-export failed", {
            detail: error instanceof Error ? error.message : String(error),
          })
        }
        try {
          // fresh = true：见上面第 3 步（增量建图删不掉图里已有的实体/事实）
          await klServer.rebuildGraph(true)
        } catch (error) {
          logger.warn("scope change graph rebuild failed", {
            detail: error instanceof Error ? error.message : String(error),
          })
        }
        try {
          distill.reset()
        } catch (error) {
          logger.warn("scope change distill reset failed", {
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
     * `PersonaAcp.turn` 返回 null，`generateDraft` 自己落回 LlmClient 直连
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
     * ★ 共用 holder：用户在设置里改网关后，`runtimeConfig.onChange`
     * 会 `reconfigure` 它，数字人下一条 batch 就用新配置 —— 不必重启。
     */
    llmProvider: llmHolder,
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
     * agent 进程也用内置 Python 环境。
     *
     * ★ 必需：skill 里跑的裸 `kl` 要命中我们在 venv/bin 生成的 wrapper
     * （上游 kl-graph/kl 硬编码了它自己那套不存在的 .venv 路径）。
     * 与 KlServerService 共用同一份准备逻辑，幂等 —— 就绪时不做任何事。
     */
    getPythonEnv: () => ensurePythonEnv(paths.klRoot, logger.child("Python")),
    getWindow: () => window,
  })

  const klServer = new KlServerService({
    clock: systemClock,
    logger: logger.child("KlServer"),
    processes,
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
      const r = runtimeConfig.resolved()
      // KL base/key 留空时 resolved 已回退主配置；再兜一层真实 env 里的
      // ANTHROPIC_*（用户只配了那个而没配 MYCONTEXT_* 的情况）。
      const base =
        r.klBaseUrl.trim() !== "" ? r.klBaseUrl : (process.env["ANTHROPIC_BASE_URL"] ?? "")
      const key =
        r.klApiKey.trim() !== ""
          ? r.klApiKey
          : (process.env["ANTHROPIC_AUTH_TOKEN"] ?? process.env["ANTHROPIC_API_KEY"] ?? "")
      return {
        // ★ LLM 走 Anthropic 模式：base 不含 /v1（litellm 自己拼 /v1/messages），
        // 裸模型名（kl 的 extractor 自己拼 anthropic/ 前缀）。见 kl_graph/config.py。
        llmBaseUrl: base,
        // ★ kl 抽取模型：默认回退主模型（glm-5.2，实测 anthropic 模式可抽中文 facts）。
        // 想给 kl 单独指一个模型就在设置里填 KL 模型，或用 KL_LLM_MODEL env 覆盖。
        llmModel: process.env["KL_LLM_MODEL"] ?? r.klModel,
        // ★ embedding 走 OpenAI 兼容：base 要带 /v1（litellm 直接 POST {base}/embeddings）。
        embedBaseUrl: base === "" ? "" : `${base.replace(/\/$/, "")}/v1`,
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
  })

  const dataPlane = new DataPlaneService({
    clock: systemClock,
    logger: logger.child("DataPlane"),
    plugin: dingtalk,
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
  const unmountVault = (): Promise<void> =>
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
      releaseVault: () => {
        mountedVault = null
        vaultPaths = null
        activeIdentity.clear()
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
   *   `undefined` = 由本函数按当前内存态推断（登录初始化那两条路径：
   *   `resolveOnLogin()` 在返回前就已经把内存态设好了，所以那里推断是对的）。
   */
  const mountVault = async (
    vaultId: string,
    seedIdentity?: { channelId: string; corpId: string; userId: string } | null,
  ): Promise<void> => {
    await unmountVault()

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
    if (identity !== null) {
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
    distillSources.attach(handle.db)
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
      (signal, onStep, since) =>
        forge.run({
          db: handle.db,
          vaultPath: vp.database,
          forgeRoot: vp.forgeRoot,
          skillRoot: vp.skillRoot,
          since: since ?? null,
          ...(signal === undefined ? {} : { signal }),
          // 阶段回调透传：让界面能显示"正在测量"而不是干等一句"正在蒸馏"
          ...(onStep === undefined ? {} : { onStep }),
        }),
      /**
       * 「重新蒸馏」要真的从头来 —— forge 的水位在它自己的派生库里，
       * 不在 vault 里，所以这一步只能由持有路径的这一层给。
       */
      () => forge.resetWatermark(vp.forgeRoot),
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
    if (dataFlowsAllowed) {
      await dataPlane
        .attach(handle.db, vp.database, {
          dataRoot: vp.root,
          exportRoot: vp.exportRoot,
          klRoot: vp.klRoot,
          handoffFile: vp.handoffFile,
        })
        .catch((error: unknown) => {
          // 数据面挂载失败不该阻止登录：用户仍能用设置页与授权，
          // 状态页会显示 lastError。把它变成"登录失败"才是过度反应。
          logger.error("data plane attach failed", {
            detail: error instanceof Error ? error.message : String(error),
          })
        })
    }
  }

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
      const vaultId = activeIdentity.resolveOnLogin({
        accountId: next.accountId,
        fallbackVaultId: next.vaultId,
      })
      void mountVault(vaultId).catch((error: unknown) => {
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
      const vaultId = activeIdentity.resolveOnLogin({
        accountId: session.accountId,
        fallbackVaultId,
      })
      await mountVault(vaultId)
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
        channelId: scopedChannelId(channelId, sourceKeyOf(dwsSource.path() ?? undefined)),
        status,
      })
      await applyPostAuthIdentity(
        { dataPlane, media, auth, logger, toFileUrl: toLocalFileUrl },
        status,
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
    preferences,
    dataPlane,
    search,
    klServer,
    graphQuery,
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
    klServer,
    graphQuery,
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
      await runShutdownStep(runner, "klServer", () => klServer.stop())
      await runShutdownStep(runner, "dataPlane", () => dataPlane.detach())
      await runShutdownStep(runner, "db", () => {
        vaults.closeAll()
        store.close()
      })
      logger.info("shutdown complete")
    },
  }
}
