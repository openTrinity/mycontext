/**
 * 钉钉渠道的授权实现（基于预置的 dws CLI）。
 *
 * 授权方式两种，实测都可用：
 *   loopback（默认）— dws 起本机 127.0.0.1 监听，浏览器授权后自动回写 token
 *   device        — 打印授权码 + 验证页，适合无浏览器环境
 *
 * OAuth 登录后还必须完成 PAT 推荐权限确认。DWS 只在交互式 TTY 中为裸
 * `auth login` 自动进入范围选择；本应用的子进程没有 TTY，因此必须显式传
 * `--recommend -f table`。table 模式会输出 PAT URL并等待用户确认，JSON
 * 模式则把 PAT pending 当结构化错误立即返回。
 *
 * ⚠️ 登录态共享：token 的加密密钥存在 macOS Keychain（服务名 dws-cli），
 * 按系统用户存一份。DWS_CONFIG_DIR 只能隔离 profiles 与日志，**隔离不了 token**
 * （两种隔离手段都实测过）。因此本应用与用户终端里的 dws 共享同一登录态，
 * 这一点必须在 UI 上讲清楚，且不提供「退出授权」（会误伤用户终端）。
 */
import { AppError, type Logger } from "@mycontext/kernel"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import type { AuthContext, AuthStatus, ChannelAuth } from "../../types.js"
import { assertAllowedCommand } from "./cli.js"
import {
  extractAuthUrl,
  extractDeviceCode,
  extractDeviceExpiry,
  extractDeviceVerifyUrl,
  extractPatAuthorizationUrl,
  parseAuthStatus,
} from "./parse.js"

/**
 * OAuth 最长约 5 分钟，随后 PAT 自身允许等待 10 分钟。
 * 总超时必须覆盖两个串行阶段，否则用户正在范围页确认时会被宿主提前杀掉。
 */
const LOGIN_TIMEOUT_MS = 16 * 60 * 1000
/** status 查询超时：本地命令 + 可能的 token 刷新网络请求。 */
const STATUS_TIMEOUT_MS = 20_000

/**
 * 上游**拒绝写入本地登录态**时的错误特征。
 *
 * ## ★★ 为什么要单独识别它 —— 「请重试」会把人钉在一面墙上
 *
 * 实测（v1.0.56 / v1.0.57，真实机器）：本地存在一个**旧格式的 token 槽**
 * （`token.json` 里只有 `updated_at`、没有任何 token 字段）而同组织下的
 * profile 又对不上时，`auth login` 直接 `exit=2` 并输出：
 *
 * ```
 * [AUTH] dingtalk login failed: 本地登录态无法安全更新:
 * legacy token slot "auth-token" does not safely match the only profile
 * in organization "…"; refusing to overwrite a potentially unique old login
 * ```
 *
 * 这是上游**主动的安全拒绝**（怕覆盖掉一份可能唯一的旧登录），不是
 * 「没检测到登录态」。归到 `authNotDetected`（「请重试」）的后果是：
 * 用户点一次撞一次,exit code 永远是 2 —— 而真正的解法是带 `--profile`
 * 在终端跑一次 login，把那个旧槽显式迁移掉。
 *
 * 判据用**两段特征词**而不是整句：上游的中文前缀（"本地登录态无法安全更新"）
 * 与英文主体分属不同版本/语言，只匹配一段会在另一种形态上漏掉。
 * 两个词任一命中即算 —— 宁可多提示一次可执行的修复，也不要让用户
 * 在「请重试」上打转。
 */
const LEGACY_TOKEN_SLOT_MARKERS: readonly string[] = [
  "refusing to overwrite",
  "does not safely match",
  "本地登录态无法安全更新",
]

/** 这次 login 失败是不是「上游拒绝覆盖旧登录槽」。 */
function isLegacyTokenSlotRefusal(detail: string): boolean {
  return LEGACY_TOKEN_SLOT_MARKERS.some((marker) => detail.includes(marker))
}

/**
 * 造「拒绝覆盖旧登录槽」那个错误。
 *
 * 抽出来是因为它有**两个**触发点，而它们的形状完全不同（见 login 里的注释）：
 * · `spawn` 非零退出 —— 走 resolve，错误文本在 `stderr` 里；
 * · `spawn` 抛错（超时/杀进程等）—— 走 catch，文本在 `error.message` 里。
 *
 * 首版只挂在 catch 上，于是**真实那条路径（resolve）完全没被覆盖** ——
 * 表现就是修了却还报「请重试」。
 */
function legacyTokenSlotError(detail: string, cause?: unknown): AppError {
  return new AppError("CHANNEL_AUTH_LEGACY_TOKEN_SLOT", `钉钉拒绝覆盖本地既有登录态：${detail}`, {
    ...(cause === undefined ? {} : { cause }),
    // 终态：exit code 恒为 2，重试一百次都一样（见 markers 上方那段）
    retryable: false,
    messageKey: "errors:channel.authLegacyTokenSlot",
  })
}

export interface DingTalkAuthOptions {
  runtime: RuntimeEnv
  processes: ProcessRunner
  logger: Logger
  /** 打开系统浏览器；由主进程注入（packages 不依赖 electron） */
  openExternal: (url: string) => Promise<void>
}

export class DingTalkAuth implements ChannelAuth {
  constructor(private readonly options: DingTalkAuthOptions) {}

  describeStepKeys(): string[] {
    return [
      "channels:dingtalk.steps.openBrowser",
      "channels:dingtalk.steps.scanQr",
      "channels:dingtalk.steps.confirmScope",
      "channels:dingtalk.steps.backToApp",
    ]
  }

  async status(): Promise<AuthStatus> {
    return this.queryStatus({ pinned: true })
  }

  /**
   * 查授权状态。`pinned` 决定问的是**哪个身份**。
   *
   * ## ★★ 两种问法都需要，而混用任一个都会坏
   *
   * · `pinned: true`（默认，`status()`）—— 问「**当前挂载 vault 绑的那个身份**
   *   现在有效吗」。界面上的组织名、有效期、采集的读取范围都必须是这个，
   *   否则就回到了"拿着 A 的库读 B 的数据"那个越权读取面。
   *
   * · `pinned: false`（`login()` 收尾时用）—— 问「**刚刚扫码登进来的是谁**」。
   *   这一步**不能**钉：用户添加第二个身份时，那个新身份还没有 vault、
   *   更没有映射行，钉住的是**旧**身份 —— 于是"授权成功"返回的是旧组织的
   *   信息，上层据此判定"身份没变"，新身份被静默丢掉。用户扫了码、
   *   看到成功、而什么都没发生。
   *
   * 刚登录时 CLI 的全局 profile 正好就是新登进来的那个（登录会把它切过去），
   * 所以不钉恰好问到对的人。
   */
  private async queryStatus(options: { pinned: boolean }): Promise<AuthStatus> {
    const binary = this.options.runtime.resolve("dws")
    const args = ["auth", "status", "-f", "json"]
    // ★ 门禁：auth 走的是自己的 processes.exec（不经 DwsCli），
    // 首版因此完全绕过白名单 —— 门禁不能只覆盖一条调用路径。
    assertAllowedCommand(args)
    /**
     * ★★ 钉住身份 —— 与 `DwsCli.run` 是**同一件事，必须两处都做**。
     *
     * 这个文件曾经因为"走的是自己的 exec 而不是 DwsCli"整条路径绕过了白名单
     * 门禁（见文件头与 cli.ts 的「门禁不能只覆盖一条调用路径」）。钉身份
     * 面临一模一样的结构：只改 `DwsCli` 的话，会话列表钉住了而**授权状态没有**
     * —— 于是界面显示的组织仍然是 CLI 全局 profile 那个，而采集按绑定身份走。
     * 两个数字打在同一张卡片上互相矛盾，且没有任何报错。
     */
    const finalArgs = options.pinned
      ? [...args, ...this.options.runtime.dwsProfileArgs()]
      : [...args]
    const result = await this.options.processes.exec({
      executable: binary.path,
      args: finalArgs,
      env: this.options.runtime.buildEnv(),
      timeoutMs: STATUS_TIMEOUT_MS,
    })

    // 刻意不看 exit code：未授权时 DWS 可能 exit 0 且 body 里 authenticated:false，
    // 也可能非 0 + body 带 error。两种都由 parseAuthStatus 归一处理。
    const status = parseAuthStatus(result.stdout || result.stderr)
    this.options.logger.debug("dws auth status", {
      state: status.state,
      exitCode: result.exitCode,
      pinned: options.pinned,
    })
    return status
  }

  async login(ctx: AuthContext): Promise<AuthStatus> {
    const binary = this.options.runtime.resolve("dws")
    ctx.onProgress({ phase: "starting" })

    const args = ["auth", "login"]
    if (ctx.mode === "device") args.push("--device")
    // loopback 由我们自己开浏览器：dws 自带的打开行为在打包应用里不一定可靠，
    // 而且我们要把 URL 同时显示给用户作为手动兜底。
    args.push("--no-browser")
    // 非 TTY 下裸 auth login 只拿 OAuth token，不会进入 PAT 范围授权。
    // table 输出让 DWS 打印范围页 URL并留在轮询中，由本应用负责打开浏览器。
    args.push("--recommend", "-f", "table")
    // ★ 同 status()：这条路径也要过门禁。
    // `auth login` 在 cli.ts 里归入 INTERACTIVE_COMMANDS —— 允许执行但**不加 `-y`**
    // （它等的是真人扫码，不是确认提示，加 `-y` 只会让人误以为能无人值守）。
    assertAllowedCommand(args)

    let loginBrowserOpened = false
    let scopeBrowserOpened = false
    let deviceCode: string | undefined
    let verifyUrl: string | undefined
    let deviceExpiry: number | undefined

    const emitDeviceIfReady = () => {
      if (deviceCode === undefined || verifyUrl === undefined) return
      ctx.onProgress({
        phase: "device-code",
        userCode: deviceCode,
        verifyUrl,
        expiresInSeconds: deviceExpiry ?? 900,
      })
    }

    /**
     * 子进程的结果要在 try 之外用（非零退出的判定在下面），所以声明在这里。
     * 走到那句判定时它必然已赋值 —— catch 的每条分支都 throw。
     */
    let login: Awaited<ReturnType<ProcessRunner["spawn"]>>

    try {
      login = await this.options.processes.spawn({
        executable: binary.path,
        args,
        env: this.options.runtime.buildEnv(),
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal: ctx.signal,
        onLine: (line) => {
          if (ctx.mode === "loopback") {
            const url = extractAuthUrl(line)
            if (url !== undefined && !loginBrowserOpened) {
              loginBrowserOpened = true
              ctx.onProgress({ phase: "browser-opened", url })
              void this.options.openExternal(url).catch((error: unknown) => {
                // 打不开浏览器不算失败：UI 上仍有可复制的 URL。
                this.options.logger.warn("open browser failed", {
                  error: error instanceof Error ? error.message : String(error),
                })
              })
            }
          } else {
            const code = extractDeviceCode(line)
            if (code !== undefined) deviceCode = code
            const verify = extractDeviceVerifyUrl(line)
            if (verify !== undefined) verifyUrl = verify
            const expiry = extractDeviceExpiry(line)
            if (expiry !== undefined) deviceExpiry = expiry
            emitDeviceIfReady()
          }

          const scopeUrl = extractPatAuthorizationUrl(line)
          if (scopeUrl !== undefined && !scopeBrowserOpened) {
            scopeBrowserOpened = true
            ctx.onProgress({ phase: "scope-authorization", url: scopeUrl })
            void this.options.openExternal(scopeUrl).catch((error: unknown) => {
              this.options.logger.warn("open PAT authorization page failed", {
                error: error instanceof Error ? error.message : String(error),
              })
            })
          }

          if (/等待|轮询|waiting/i.test(line)) ctx.onProgress({ phase: "waiting" })
        },
      })
    } catch (error) {
      if (error instanceof AppError && error.code === "PROCESS_CANCELLED") {
        ctx.onProgress({ phase: "cancelled" })
        throw error
      }
      const detail = error instanceof Error ? error.message : String(error)
      /**
       * ★★ 上游拒绝覆盖旧登录槽 → 单独报，**不要**走 `authFailed` 的泛化文案。
       *
       * 这类失败**不是 retryable**：exit code 恒为 2，点一百次重试都一样
       * （见 `LEGACY_TOKEN_SLOT_MARKERS` 上方那段）。标 `retryable: true`
       * 会让 UI 继续摆一个「重试」按钮，把用户钉在一面墙上 ——
       * 而真正的出路是带 `--profile` 在终端跑一次 login 完成迁移。
       */
      if (isLegacyTokenSlotRefusal(detail)) {
        ctx.onProgress({
          phase: "failed",
          messageKey: "errors:channel.authLegacyTokenSlot",
          detail,
        })
        throw legacyTokenSlotError(detail, error)
      }
      ctx.onProgress({ phase: "failed", messageKey: "errors:channel.authFailed", detail })
      throw new AppError("CHANNEL_AUTH_FAILED", `钉钉授权失败：${detail}`, {
        cause: error,
        retryable: true,
        messageKey: "errors:channel.authFailed",
        messageParams: { detail },
      })
    }

    /**
     * ★★ `spawn` 非零退出走的是 **resolve**，不是 throw —— 所以必须在这里判。
     *
     * `ProcessRunner.run()` 对非零退出只打一条 `process non-zero exit` 警告然后
     * `resolve(result)`（见 runtime-env/src/process.ts）。也就是说上面那个
     * `catch` 只能接到"起不来 / 超时 / 被取消"，**接不到 `exit=2`**。
     *
     * 这一条是首版修复漏掉的那半边：识别逻辑只挂在 catch 上，而真实的
     * 「拒绝覆盖旧登录槽」走的恰恰是这条 resolve 路径 —— 于是流程继续往下，
     * 落到下面那个"复查 status → 未授权"的分支，报出
     * 「授权流程结束但未检测到有效登录态，请重试」。修了却还是那句话，
     * 正是因为修在了一条不会执行的分支上。
     *
     * ★ 只在**识别得出**时拦：非零退出还有别的原因（用户在浏览器里放弃、
     * 网络断了），那些交给下面的 status 复查 —— 它是"授权到底成没成"
     * 唯一可信的判据（见下一段），比 exit code 准。
     */
    const loginOutput = `${login.stderr}\n${login.stdout}`
    /**
     * ★ 判据**不再要求非零退出**。
     *
     * 原来是 `login.exitCode !== 0 && isLegacyTokenSlotRefusal(...)`。而实测撞到
     * 一种上游**退出码为 0、却没有把凭据写进来**的形态（见下面第二次复查那段：
     * `token.json` 只有 `updated_at`）。带着退出码这个前置条件，这道判据在那种
     * 形态上永远不成立 —— 于是流程一路报"成功"，几十秒后界面变未连接。
     *
     * 只看输出里有没有那几个特征词：它们来自上游明确的拒绝信息，
     * 命中了就是"这次登录没落地"，与退出码是几无关。
     */
    if (isLegacyTokenSlotRefusal(loginOutput)) {
      /**
       * detail 取输出的尾部：整段可能很长，而 UI 只需要那句原因。
       * 不放整段是因为它可能含组织 id 这类标识符。
       *
       * ★ 从 `loginOutput`（stderr + stdout）取而不是只取 stderr：
       * 判据已经不要求非零退出，而退出码为 0 的那种形态下拒绝信息可能
       * 打在 stdout 上 —— 只看 stderr 会得到一个空 detail，
       * 于是界面上是一句没有任何线索的失败。
       */
      const detail = loginOutput.trim().slice(-400)
      this.options.logger.warn("dws login refused to overwrite existing session", {
        exitCode: login.exitCode,
      })
      ctx.onProgress({
        phase: "failed",
        messageKey: "errors:channel.authLegacyTokenSlot",
        detail,
      })
      throw legacyTokenSlotError(detail)
    }

    /**
     * 不以子进程 exit code 判定成功：复查 status 才是唯一可信的结论。
     *
     * ★★ 这一次复查**不钉身份**（`pinned: false`）—— 见 `queryStatus` 的注释。
     * 一句话：这里要问的是"刚扫码登进来的是**谁**"，而添加第二个身份时
     * 那个人还没有 vault、没有映射行，钉住的会是**旧**身份。那样返回的
     * 是旧组织的信息，上层判定"身份没变"，新身份被静默丢掉 ——
     * 用户扫了码、看到"成功"，而什么都没发生。
     */
    const status = await this.queryStatus({ pinned: false })
    if (status.state !== "authorized") {
      ctx.onProgress({ phase: "failed", messageKey: "errors:channel.authNotDetected" })
      throw new AppError("CHANNEL_AUTH_FAILED", "授权流程结束但未检测到有效登录态，请重试", {
        retryable: true,
        messageKey: "errors:channel.authNotDetected",
      })
    }

    /**
     * ★★★ 再用**采集实际会用的口径**（钉住身份）复查一次。
     *
     * ## 为什么必须有第二次（"连上了，过一会儿又显示未连接"的根因）
     *
     * 上面那次复查是 `pinned: false` —— 不带 `--profile`，也就跟着渠道 CLI 的
     * **全局 currentProfile** 走。而采集/会话列表用的全是 `pinned: true`
     * （带 `--profile`，指向这个 vault 的隔离目录）。两者读的是**两套凭据**。
     *
     * 实测（打包态真机，这次撞到的形状）：
     * · 隔离目录里的 `token.json` 在授权那一刻确实被写了，但内容**只有
     *   `updated_at`、一个 token 字段都没有**（47 字节空壳）——
     *   那正是本文件 `LEGACY_TOKEN_SLOT_MARKERS` 上方记的「旧格式 token 槽」，
     *   上游对它会**拒绝写入**（怕覆盖一份可能唯一的旧登录）；
     * · 而机器上的全局 profile（用户以前在终端登录过的）是**有效的**，
     *   于是第一次复查通过 → 我们报「授权成功」；
     * · 随后每条带 profile 的命令都 `exitCode 2 / 未登录`
     *   （`contact/get_current_user_profile`、`im/list_all_conversations`…），
     *   界面几十秒后变成"未连接"。
     *
     * 用户看到的就是"点了登录，过一会儿又掉了"，而日志里授权那一段全是成功。
     *
     * ## 判据：钉住之后**仍然**是 authorized 才算真的成了
     *
     * 这一次不通过就是「凭据没能写进这个身份的目录」。归
     * `authLegacyTokenSlot`（而不是 `authNotDetected`「请重试」）—— 重试一百次
     * 都一样，出路是带 `--profile` 在终端跑一次 login 把旧槽迁移掉。
     * 那句提示已经存在，之前只挂在 `exitCode !== 0` 那条分支上，
     * 而这次上游**没有非零退出**，所以从没被触发过。
     *
     * ★ 顺序上放在第一次复查**之后**：第一次回答的是"刚扫码登进来的是谁"
     * （那时新身份可能还没有 vault 映射，不能钉 —— 见 `queryStatus` 的注释），
     * 第二次回答的是"这个身份自己的目录里凭据到位了吗"。两个问题都要答。
     *
     * ★ 没绑身份时 `dwsProfileArgs()` 返回空数组，此时两次复查等价 ——
     * 那是"首次授权、还没有映射行"的正常情形，不该因此判失败。
     * 所以只在**真的钉上了**（有 profile 参数）时才把它当门禁。
     */
    if (this.options.runtime.hasPinnedIdentity()) {
      const pinnedStatus = await this.queryStatus({ pinned: true })
      if (pinnedStatus.state !== "authorized") {
        this.options.logger.warn("login succeeded globally but not for the pinned identity", {
          globalState: status.state,
          pinnedState: pinnedStatus.state,
        })
        ctx.onProgress({
          phase: "failed",
          messageKey: "errors:channel.authLegacyTokenSlot",
          detail: "",
        })
        throw legacyTokenSlotError(
          "登录没有写进这个身份的凭据目录（多半是本机存在一份旧格式的登录态，" +
            "上游拒绝覆盖它）。请在终端带 --profile 跑一次 dws auth login 完成迁移后重试。",
        )
      }
      ctx.onProgress({ phase: "succeeded", status: pinnedStatus })
      return pinnedStatus
    }

    ctx.onProgress({ phase: "succeeded", status })
    return status
  }

  /**
   * 退出授权（`dws auth logout`）。
   *
   * ## ★★ 为什么删目录不够、必须调它
   *
   * token 的密钥在**系统钥匙串**里，不在 `DWS_CONFIG_DIR` 那个目录里。
   * 实测（见 `profile-seed.ts` 文件头）：全新空目录跑 `auth status` 仍返回
   * `authenticated: true` —— CLI 会就地从钥匙串重建一份 `profiles.json`。
   *
   * 也就是说「删掉 vault 目录」**不等于退出授权**：清空之后下一次
   * `auth status` 照样是已授权，而那正是用户报的"清了还是已授权状态"。
   * 要真的退出，只能让 CLI 自己去清钥匙串里那份 token。
   *
   * ## 钉身份
   *
   * 带 `--profile`：这台机器上可能有多个身份，不钉的话退的是 CLI 的
   * 全局 current —— 可能是**另一个**身份（甚至用户自己终端里正在用的那个）。
   *
   * ## 不抛
   *
   * 返回是否真的退成功。失败只降级成"凭据还在"，由调用方决定怎么说 ——
   * 而让整个清空动作因为退登失败而回滚是更坏的选择：那时数据已经删了。
   */
  async logout(): Promise<boolean> {
    const binary = this.options.runtime.resolve("dws")
    const args = ["auth", "logout"]
    // ★ 门禁：这个文件走自己的 processes.exec（不经 DwsCli），必须显式调
    assertAllowedCommand(args)
    /**
     * ★★ 没绑身份 → **不退**。这条漏了会退掉用户终端里的登录态。
     *
     * `dwsProfileArgs()` 在没绑身份时返回空数组，于是 `auth logout` 不带
     * `--profile`，按渠道 CLI 的**全局 currentProfile** 执行 —— 而 token 的
     * 密钥在系统钥匙串里、按系统用户存一份（见文件头），也就是**与用户
     * 自己终端里的 dws 共用**。
     *
     * 后果：应用这边"清理一下自己的登录态"，实际把用户在终端里正在用的
     * 那份退掉了。而我们的原则是只动用户在这个应用里授权过的那个身份 ——
     * 没有身份时就没有我们该退的东西。
     *
     * 返回 false（= "没退成"）而不是抛：调用方（清数据流程）会据此决定
     * 提示什么，而"本来就没有可退的"不是错误。
     */
    if (!this.options.runtime.hasPinnedIdentity()) {
      this.options.logger.info("skip logout: no bound identity", {})
      return false
    }
    try {
      const result = await this.options.processes.exec({
        executable: binary.path,
        args: [...args, ...this.options.runtime.dwsProfileArgs()],
        env: this.options.runtime.buildEnv(),
        timeoutMs: STATUS_TIMEOUT_MS,
      })
      /**
       * 复查 status 才是可信结论（与 `login` 同一条纪律：不看 exit code）。
       * 退成功 = 现在问它是未授权。
       */
      const after = await this.queryStatus({ pinned: true })
      const ok = after.state !== "authorized"
      this.options.logger.info("dws auth logout", { exitCode: result.exitCode, ok })
      return ok
    } catch (error) {
      this.options.logger.warn("dws auth logout failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }
}
