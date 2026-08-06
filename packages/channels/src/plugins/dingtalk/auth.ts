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
    const binary = this.options.runtime.resolve("dws")
    const args = ["auth", "status", "-f", "json"]
    // ★ 门禁：auth 走的是自己的 processes.exec（不经 DwsCli），
    // 首版因此完全绕过白名单 —— 门禁不能只覆盖一条调用路径。
    assertAllowedCommand(args)
    const result = await this.options.processes.exec({
      executable: binary.path,
      args,
      env: this.options.runtime.buildEnv(),
      timeoutMs: STATUS_TIMEOUT_MS,
    })

    // 刻意不看 exit code：未授权时 DWS 可能 exit 0 且 body 里 authenticated:false，
    // 也可能非 0 + body 带 error。两种都由 parseAuthStatus 归一处理。
    const status = parseAuthStatus(result.stdout || result.stderr)
    this.options.logger.debug("dws auth status", {
      state: status.state,
      exitCode: result.exitCode,
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

    try {
      await this.options.processes.spawn({
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
      ctx.onProgress({ phase: "failed", messageKey: "errors:channel.authFailed", detail })
      throw new AppError("CHANNEL_AUTH_FAILED", `钉钉授权失败：${detail}`, {
        cause: error,
        retryable: true,
        messageKey: "errors:channel.authFailed",
        messageParams: { detail },
      })
    }

    // 不以子进程 exit code 判定成功：复查 status 才是唯一可信的结论。
    const status = await this.status()
    if (status.state !== "authorized") {
      ctx.onProgress({ phase: "failed", messageKey: "errors:channel.authNotDetected" })
      throw new AppError("CHANNEL_AUTH_FAILED", "授权流程结束但未检测到有效登录态，请重试", {
        retryable: true,
        messageKey: "errors:channel.authNotDetected",
      })
    }

    ctx.onProgress({ phase: "succeeded", status })
    return status
  }
}
