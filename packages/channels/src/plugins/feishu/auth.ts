/**
 * 飞书授权：走官方 CLI 的**设备码**流程。
 *
 * ## 为什么是设备码而不是 loopback 回调
 *
 * CLI 自己持有 OAuth 客户端与回调实现，我们只能驱动它 —— 而它给的是
 * 「打开这个链接 + 输入这个码」。好处是我们完全不接触 token：
 * 凭据由 CLI 写进我们指定的隔离目录（见 `LarkCli.env()`），
 * 这一层只解析它的输出并转成契约里的 `AuthProgress`。
 */
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
  /**
   * 凭据/配置的隔离根目录 —— **函数**，见 `LarkCliOptions.authRoot`。
   * 按 vault 分，而插件在登录前就装配好了，所以只能现读。
   */
  authRoot: () => string
  /** 测试与非标准安装可以指定 CLI 的确切路径。 */
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
      /**
       * ★★★ 把 master key 钉到隔离 HOME —— **必须是第一步**。
       *
       * ## 为什么提到这里（原来它在等浏览器之后）
       *
       * macOS 上 `config init` / `auth login` 会优先找系统钥匙串里的
       * `master.key`。而我们把 HOME 重定向到了 vault 下的隔离目录，
       * 那里没有钥匙串条目 —— 于是**系统弹出模态框**
       * 「找不到用于储存 "master.key" 的钥匙串」，两个按钮是
       * 「取消」与「还原为默认」：
       *
       * · 点「还原为默认」= 往用户真实的登录钥匙串里写，
       *   那正是我们要避免的（凭据必须跟着 vault 走，两个身份不能共用）；
       * · 点「取消」= 授权流程从这里断掉。
       *
       * 用户看到的就是一个突然冒出来的系统安全弹窗，而它出现在
       * 「点了开始授权」之后、浏览器打开之前。
       *
       * ## 为什么现在可以放在最前面（实测，2026-08）
       *
       * 原注释说"必须在 `config init` 之后，那之前没有配置目录"。
       * **那条结论已经过期** —— 当前 CLI 版本在一个完全空的隔离目录里
       * 直接跑 `config keychain-downgrade` 就能成功：
       *
       *     OK: system Keychain was empty; generated a new master key and
       *     wrote it to …/home/Library/Application Support/lark-cli/master.key.file.
       *     The OS Keychain was not modified.
       *
       * 它自己会建目录、自己生成 key、且明确不碰系统钥匙串。
       * 所以"先降级再做任何别的事"既可行，也是唯一能挡住那个弹窗的位置
       * —— 弹窗的成因就是"在还没有 master.key.file 时去问钥匙串"。
       *
       * ★ 幂等，所以两条路径（首次配置 / 重新授权）都从这里过一次就够。
       */
      await this.cli.ensureAutomationCredentialAccess({ signal: ctx.signal })
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

      /*
       * ★ 钥匙串降级已经在 `login()` 的**第一步**做过了（见那里的长注释）。
       *
       * 这里原来是它的唯一调用点，注释写着"必须在 config init 之后、
       * OAuth 写凭据之前"。前半句已被实测推翻（空目录下也能跑），而把它留在
       * 这个位置的代价是：`config init` / `auth login` 在它之前就去问了
       * 系统钥匙串 → 弹出「找不到钥匙串」的系统模态框。
       *
       * 不在这里重复调用：它是幂等的，但每次都要 spawn 一个子进程，
       * 而这条路径上已经有一次成功的降级了。
       */
      /**
       * ★★ 必须带 `--json` —— 不带的话一次**成功的**授权会被判成失败。
       *
       * 不带 `--json` 时这条命令的 stdout 是给人看的（实测，依次是）：
       * ① 一整段以 `[AI agent] ` 开头的使用提示（讲"本命令最长阻塞 10 分钟"
       *    以及要怎么生成二维码，几百字，里面**有括号**）；
       * ② 一行 `等待用户授权...`；
       * ③ 最后才是那份 JSON。
       *
       * 而 `extractLarkJson` 是"逐个候选起点试到能整段 parse 为止"的贪心 ——
       * 提示文本里的括号会先命中，于是抛「飞书 CLI 返回了无法解析的内容」。
       *
       * 实测证据（本机 CLI 日志 2026-08-08 17:16）：这一步之前
       * `/open-apis/authen/v2/oauth/token` 已经 **status=200**，
       * `auth status --verify` 也显示 `grantedAt 17:16:32` / `tokenStatus valid`
       * / scope 里带上了 `im:message.reactions:read` —— 也就是**授权真的成功了**，
       * 只是我们把它的输出读错，然后给用户弹了一条红字。
       *
       * 带 `--json` 之后 stdout 就是干净的一份 JSON（同一条命令对比过）。
       */
      await this.cli.json<unknown>(["auth", "login", "--device-code", grant.deviceCode, "--json"], {
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
