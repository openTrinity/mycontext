/** User OAuth through the official Lark CLI device flow. */
import { AppError, type Logger } from "@mycontext/kernel"
import type { ProcessRunner } from "@mycontext/runtime-env"
import type { AuthContext, AuthStatus, ChannelAuth } from "../../types.js"
import { LarkCli } from "./cli.js"
import { LARK_AUTH_SCOPES, parseLarkAuthStatus, parseLarkDeviceGrant } from "./parse.js"

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export interface FeishuPluginOptions {
  processes: ProcessRunner
  logger: Logger
  openExternal: (url: string) => Promise<void>
  /** Isolated credential/config root under Electron userData. */
  authRoot: string
  /** Tests and non-standard installations can point at an exact official CLI. */
  executable?: string
}

export class FeishuAuth implements ChannelAuth {
  constructor(
    private readonly options: FeishuPluginOptions,
    private readonly cli = new LarkCli(options),
  ) {}

  describeStepKeys(): string[] {
    return [
      "channels:feishu.steps.openBrowser",
      "channels:feishu.steps.confirm",
      "channels:feishu.steps.backToApp",
    ]
  }

  async status(): Promise<AuthStatus> {
    try {
      const payload = await this.cli.json<unknown>(["auth", "status", "--json", "--verify"])
      return parseLarkAuthStatus(payload)
    } catch (error) {
      this.options.logger.debug("lark auth status unavailable", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return { state: "unauthorized" }
    }
  }

  async login(ctx: AuthContext): Promise<AuthStatus> {
    ctx.onProgress({ phase: "starting" })
    try {
      const loginArgs = [
        "auth",
        "login",
        "--scope",
        LARK_AUTH_SCOPES.join(","),
        "--no-wait",
        "--json",
      ]
      let initial: unknown
      try {
        initial = await this.cli.json<unknown>(loginArgs, { signal: ctx.signal })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (!/not configured/i.test(detail)) throw error
        await this.cli.configure(
          (url) => {
            ctx.onProgress({ phase: "browser-opened", url })
            void this.options.openExternal(url).catch(() => undefined)
          },
          { signal: ctx.signal, timeoutMs: LOGIN_TIMEOUT_MS },
        )
        initial = await this.cli.json<unknown>(loginArgs, { signal: ctx.signal })
      }
      const grant = parseLarkDeviceGrant(initial)
      if (grant === null) {
        throw new AppError("CHANNEL_AUTH_FAILED", "飞书 CLI 没有返回授权链接或设备码")
      }

      if (ctx.mode === "device") {
        ctx.onProgress({
          phase: "device-code",
          userCode: grant.userCode,
          verifyUrl: grant.verifyUrl,
          expiresInSeconds: grant.expiresInSeconds,
        })
      } else {
        ctx.onProgress({ phase: "browser-opened", url: grant.verifyUrl })
        // 等待系统确认浏览器请求已提交，再进入 device-code 轮询。
        // 首次配置会先打开应用选择页；若这里 fire-and-forget，第二次 open
        // 可能被 macOS 丢在前一个请求后面，用户只能靠界面的手动链接继续。
        await this.options.openExternal(grant.verifyUrl).catch((error: unknown) => {
          this.options.logger.warn("open Feishu authorization page failed", {
            detail: error instanceof Error ? error.message : String(error),
          })
        })
      }
      ctx.onProgress({ phase: "waiting" })

      // Do this after config/device initialization but before the successful
      // OAuth response writes user credentials. Re-authorization skips
      // `config init`, so keeping it in the shared path is essential.
      await this.cli.ensureAutomationCredentialAccess({ signal: ctx.signal })
      await this.cli.json<unknown>(["auth", "login", "--device-code", grant.deviceCode], {
        signal: ctx.signal,
        timeoutMs: LOGIN_TIMEOUT_MS,
      })
      const status = await this.status()
      if (status.state !== "authorized") {
        throw new AppError("CHANNEL_AUTH_FAILED", "授权完成，但没有检测到所需的飞书只读权限")
      }
      ctx.onProgress({ phase: "succeeded", status })
      return status
    } catch (error) {
      if (error instanceof AppError && error.code === "PROCESS_CANCELLED") {
        ctx.onProgress({ phase: "cancelled" })
        throw error
      }
      const detail = error instanceof Error ? error.message : String(error)
      ctx.onProgress({ phase: "failed", messageKey: "errors:channel.authFailed", detail })
      throw new AppError("CHANNEL_AUTH_FAILED", `飞书授权失败：${detail}`, {
        cause: error,
        retryable: true,
        messageKey: "errors:channel.authFailed",
        messageParams: { detail },
      })
    }
  }
}
