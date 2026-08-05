/**
 * dws 的两项本机配置：**用哪个可执行文件** + **用哪个渠道号**。
 *
 * ## 为什么需要它
 *
 * 随包分发的是**开源版**（npm 依赖 `dingtalk-workspace-cli`，Apache-2.0）。
 * 闭源版不随仓库分发，只能由用户自己装好再把路径给进来。这个 service 就是
 * 那个入口：UI 上填一次，落 `control.sqlite` 的 `app_settings`。
 *
 * 落**应用级**而不是账号级：「这台机器上用哪个 dws」是机器的属性，
 * 不该随账号切换而变（与 advanced-ai 同一个口径）。
 *
 * ## 渠道号（`DWS_CHANNEL`）是**自有 dws 的附属项**
 *
 * 它不是一个并列的独立开关，而是"用了自有 dws 之后**可能**还要配的东西" ——
 * 因为渠道号绑定的是**分发方身份**（上游把它当 `channelCode` 发给服务端，
 * 与那份二进制内置的 OAuth clientId 是配套的）。
 *
 * 随包的开源版用它自己的内置身份，我们不给它配渠道号（也不该配 ——
 * 开源发布带渠道号等于让别人以我们的渠道身份调用）。所以：
 * **只有指定了自有 dws 的人才需要这一项**，UI 上它嵌在路径下面，
 * 没填路径时不显示。
 *
 * ### ★ 渠道号**无法在本地校验**，这是它与路径的根本差异
 *
 * 路径能验（spawn 一次看有没有版本号）。渠道号不能 —— 它对不对只有
 * **服务端在授权时**才知道（上游 `classifyDenialReason`：只有组织把
 * `channelScope` 设成 `specified` 时才比对 `allowedChannels`）。
 *
 * 所以这里只做**格式**校验。填错的后果是授权阶段报 `CHANNEL_NOT_ALLOWED`
 * （终态、有明确文案，见 cli.ts 的归类），而不是静默失效 ——
 * 那条归类正是为这个场景准备的。
 *
 * 缺省为空，且**空是完全可用的姿态**（实测 `channelScope=all` 的组织不带
 * 渠道号时 11 条读命令全部成功、数据量逐项相同）。所以 UI 上它必须表现成
 * "一般不用填"，而不是一个待填项。
 *
 * ## ★ 保存时必须**真跑一次**，不能只判文件在不在
 *
 * 这条链路的失效方式是"看起来一切正常"：文件在、有可执行位、`codesign --verify`
 * 说 valid，只在真正 spawn 时被内核杀掉（macOS 对 ad-hoc 签名的 Mach-O 会这样，
 * 见 scripts/prepare-bin.mjs 里 installExecutable 的长注释）。
 *
 * 而用户在 UI 上填路径比开发者跑脚本更容易填错 —— 填成安装包、填成同名目录、
 * 填成一个 shell wrapper 都可能。所以这里**更**需要那道验证：
 * 保存前 spawn 一次 `--version`，拿不到版本号就拒绝保存并说清原因。
 *
 * 不做这件事的代价不是"多一次失败"，而是**症状跑到几百行之外**：
 * onboarding 会说「授权流程结束但未检测到有效登录态」，而根因在一个路径上。
 *
 * ## ★ 判据是「能跑出版本号」，不是 exit code 为 0
 *
 * `dws --version` 正常返回 0，但我们要抓的是 SIGKILL / ENOENT / EACCES
 * 这类"这个文件根本跑不了"。所以看的是**有没有输出版本号**：
 * 一个跑得起来的 dws 必然打印 `dws version x.y.z`。
 */
import { statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { AppError, type Clock, type Logger } from "@mycontext/kernel"
import { probeBinaryVersion } from "@mycontext/runtime-env"
import type { SettingsRepository } from "@mycontext/store"
import type { DwsSourceView } from "@mycontext/ipc-contract"

const SETTING_KEY = "dws_source_path"
const CHANNEL_KEY = "dws_channel_code"

/**
 * 渠道号的格式约束。
 *
 * 只挡明显填错的（带空格、太长、非 ASCII）——**不**猜它的具体形态：
 * 实测见过 40 位十六进制串，也有产品名式的短串（上游文档里举的例子），
 * 收紧成某一种会把另一种拒掉，而那时用户完全没有出路。
 *
 * 上游自己对这个值不做格式校验（`os.Getenv` 拿到就当 header 发），
 * 所以我们比它更严只会造成假拒绝。
 */
const CHANNEL_MAX_LENGTH = 200
const CHANNEL_PATTERN = /^[\x21-\x7e]+$/

export interface DwsSourceServiceOptions {
  settings: SettingsRepository
  clock: Clock
  logger: Logger
  /** 随包那份的路径（最终兜底），也用于在 UI 上展示"没设时用的是哪个"。 */
  bundledPath: string
  /**
   * `.env` / 环境变量里的 `MYCONTEXT_DWS_SOURCE`（`loadConfig` 解析后的值）。
   *
   * ★ 优先级：**UI 值 > 这个 > 随包那份**。
   * "最后一次显式操作"应该生效 —— 用户在界面上改完却被一个几个月前写在
   * `.env` 里的值盖住，那是无从排查的。UI 上清空即退回这一层。
   *
   * 空串 = 没配（与 loadConfig 口径一致）。
   */
  fallbackPath: string
  /** 读随包那份的版本（诊断展示用）。注入以便测试。 */
  probeVersion?: (binPath: string) => string | null
  /**
   * 渠道号的**默认层**：`loadConfig` 解析出来的值
   * （内置默认 < .env < 环境变量，见 kernel/config.ts）。
   *
   * 用户在 UI 上存的覆盖它 —— 与 RuntimeConfigService 同一套三层解析：
   * 开发者配 `.env` 零 UI 就能跑，打包用户在 UI 上存的优先。
   */
  fallbackChannel: string
}

/** 跑 `--version` 取首行（`dws version x.y.z (…)`）。跑不起来返回 null。 */
export function probeDwsVersion(binPath: string): string | null {
  const raw = probeBinaryVersion(binPath)
  if (raw === null) return null
  const line = raw.trim().split("\n")[0] ?? ""
  return line === "" ? null : line
}

export class DwsSourceService {
  constructor(private readonly options: DwsSourceServiceOptions) {}

  /**
   * **实际生效**的自备 dws 路径（都没配则 null → 用随包那份）。
   *
   * 三层：UI 存的（非空）> `.env`/环境变量 > null。
   * 见 `fallbackPath` 的注释解释为什么 UI 优先。
   *
   * ★ 这里**不判文件在不在** —— 那是 `view()` / `resolve()` 的事。
   * 这个方法回答"配的是哪条路径"，两件事分开才让"设了但失效"可表达。
   */
  path(): string | null {
    const stored = this.options.settings.get(SETTING_KEY)
    if (stored !== null && stored.trim() !== "") return stored.trim()
    if (this.options.fallbackPath.trim() !== "") return this.options.fallbackPath.trim()
    return null
  }

  /** UI 上存的那条（不含 `.env` 层）。视图要用它区分两个来源。 */
  private storedPath(): string | null {
    const stored = this.options.settings.get(SETTING_KEY)
    return stored === null || stored.trim() === "" ? null : stored.trim()
  }

  /**
   * **实际生效**的渠道号。运行时（`buildEnv`）用它。
   *
   * ## ★ 用户填的那个**只在自有 dws 生效时**才生效
   *
   * 渠道号与二进制内置的 OAuth 身份是配套的（见文件头）。把它用在随包的
   * 开源版上是**错的配对**：那份用自己的内置 clientId，配上别人的渠道号
   * 只会让服务端拒绝，而症状是授权阶段一个费解的错误。
   *
   * 所以路径失效 / 被清掉时，用户填的渠道号自动**不生效**（回落到默认层），
   * 而不是继续跟着随包版走。这与 `view()` 里"路径没了就退回 bundled"
   * 是同一个判据，两处必须一致。
   *
   * 默认层（`.env` / 环境变量）不受此限制：那是分发方在部署时注入的，
   * 它自己知道配的是哪份二进制。
   */
  channel(): string {
    const custom = this.path()
    if (custom !== null && isRunnableFile(custom)) {
      const stored = this.options.settings.get(CHANNEL_KEY)
      if (stored !== null && stored.trim() !== "") return stored.trim()
    }
    return this.options.fallbackChannel
  }

  /**
   * 给 UI 的视图：设了什么、那个文件现在还在不在、以及**实际生效**的是哪个。
   *
   * `effective` 是三态里最有用的一条：用户换了台机器之后路径会失效，
   * 那时 UI 必须说清"你设的那个找不到了，现在用的是随包版" ——
   * 而不是继续显示那条路径让人以为它在生效。
   */
  view(): DwsSourceView {
    const configured = this.path()
    const usable = configured !== null && isRunnableFile(configured)
    const effectivePath = usable ? configured : this.options.bundledPath
    const probe = this.options.probeVersion ?? probeDwsVersion
    return {
      /** UI 上存的那条（不含 `.env` 层）—— 输入框回显它 */
      configuredPath: this.storedPath(),
      /**
       * `.env` / 环境变量里那条；null = 没配。
       *
       * 与 `configuredPath` 分开，UI 才能说清"这条是从 .env 来的，
       * 不是你在这儿填的" —— 否则开发者在 `.env` 里配了却看到输入框是空的，
       * 会以为配置丢了，然后在 UI 上再填一遍。
       */
      pathFromDefaults:
        this.options.fallbackPath.trim() === "" ? null : this.options.fallbackPath.trim(),
      /** 设了但用不了（文件没了 / 权限没了）—— UI 要显式提示已退回随包版 */
      configuredMissing: configured !== null && !usable,
      effectiveSource: usable ? "custom" : "bundled",
      effectiveVersion: probe(effectivePath),
      /**
       * 渠道号回显**完整值**（与 apiKey 不同）：它是分发方标识而不是密钥，
       * 看不到旧值反而没法确认"我填的是不是那个"。
       */
      channelCode: this.options.settings.get(CHANNEL_KEY) ?? null,
      /** 默认层也给出来：UI 要能区分"我填的"与"从 .env/环境变量来的" */
      channelFromDefaults:
        this.options.fallbackChannel === "" ? null : this.options.fallbackChannel,
      /**
       * 用户填的渠道号**此刻是否生效**。
       *
       * 只有用了自有 dws 时才生效（见 `channel()`）。单独一个字段是因为
       * "填了但没生效"必须能说出来 —— 否则用户填完看不出任何变化，
       * 会以为保存失败了。
       */
      channelActive: usable,
    }
  }

  /**
   * 保存。两项独立：`undefined` = 这一项不改，`null`/空串 = 清除。
   *
   * ## ★ 为什么是 patch 而不是"整份覆盖"
   *
   * 两项的生命周期完全不同：路径是"装了闭源版才填"，渠道号是"组织限定了
   * 渠道才填"，绝大多数人两项都不填、少数人只填一项。整份覆盖会让
   * "只想改渠道号"的请求把路径顺手清掉 —— 而那是静默的数据丢失。
   */
  save(patch: {
    path?: string | null | undefined
    channelCode?: string | null | undefined
  }): DwsSourceView {
    const at = new Date(this.options.clock.now()).toISOString()

    if (patch.path !== undefined) this.savePath(patch.path, at)
    if (patch.channelCode !== undefined) this.saveChannel(patch.channelCode, at)

    return this.view()
  }

  /**
   * 路径：拒绝的三种情况都给可操作的原因。
   *
   * · 相对路径 —— 相对谁？主进程的 cwd 不是用户以为的那个目录；
   * · 不是文件 —— 填成目录/不存在；
   * · 跑不起来 —— 见文件头，这是最要紧的一条。
   */
  private savePath(input: string | null, at: string): void {
    const value = input === null ? "" : input.trim()

    if (value === "") {
      this.options.settings.delete(SETTING_KEY)
      this.options.logger.info("dws source cleared; falling back to bundled")
      return
    }

    if (!isAbsolute(value)) {
      throw new AppError("CONFIG_INVALID", "请填绝对路径（相对路径会相对应用的工作目录解析）", {
        messageKey: "errors:dwsSource.notAbsolute",
      })
    }

    if (!isRunnableFile(value)) {
      throw new AppError("CONFIG_INVALID", "这个路径不是一个文件（也可能不存在）", {
        messageKey: "errors:dwsSource.notFile",
      })
    }

    // ★ 真跑一次 —— 这道检查是这个 service 的全部意义，见文件头。
    const probe = this.options.probeVersion ?? probeDwsVersion
    const version = probe(value)
    if (version === null) {
      throw new AppError("CONFIG_INVALID", "这个文件跑不起来，没能读到版本号", {
        messageKey: "errors:dwsSource.notRunnable",
      })
    }

    this.options.settings.set(SETTING_KEY, value, at)
    // 只记版本号，不记路径 —— 路径里常含用户名
    this.options.logger.info("dws source saved", { version })
  }

  /**
   * 渠道号：**只校验格式**，不判"这个渠道号有效吗"。
   *
   * 后者只有服务端在授权时才知道（见文件头）。填错的后果是授权阶段
   * 报 `CHANNEL_NOT_ALLOWED`（终态、有明确文案），不是静默失效。
   */
  private saveChannel(input: string | null, at: string): void {
    const value = input === null ? "" : input.trim()

    if (value === "") {
      this.options.settings.delete(CHANNEL_KEY)
      this.options.logger.info("dws channel cleared")
      return
    }

    if (value.length > CHANNEL_MAX_LENGTH || !CHANNEL_PATTERN.test(value)) {
      throw new AppError("CONFIG_INVALID", "渠道号格式不对（不能有空格，且只能是可见 ASCII）", {
        messageKey: "errors:dwsSource.channelInvalid",
      })
    }

    this.options.settings.set(CHANNEL_KEY, value, at)
    // ★ 不记渠道号本身：它是分发方标识，日志会被贴到 issue 里
    this.options.logger.info("dws channel saved", { length: value.length })
  }
}

/** 文件存在且可执行。 */
function isRunnableFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
