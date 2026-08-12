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
import {
  LARK_AUTH_SCOPES,
  parseLarkAuthStatus,
  parseLarkDeviceGrant,
  readFeishuTenantKey,
  readFeishuTenantName,
} from "./parse.js"

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
      const status = parseLarkAuthStatus(payload)
      /**
       * ★★★ 组织 id 要**再取一次** —— `auth status` 的响应里没有它。
       *
       * ## 这是"修在了另一条路上"的一次真实教训（CDP 端到端抓到的）
       *
       * 上一轮我把 `contact +get-user` 加进了 `createFeishuIdentity()`
       * 的 `resolveSelf()`。那条路是**采集侧**解析本人身份用的。
       * 而界面上显示的组织名走的是**这里**（`status()` →
       * `parseLarkAuthStatus`），两条路各自解析同一件事。
       *
       * 结果：单测绿、`resolveSelf` 也确实跑过（日志有
       * `self identity resolved`），而界面上仍是「未知组织」——
       * 因为界面用的是没修的那一条。CDP 探针量出 `corpId` 长度 27
       * （= `unknown-tenant:` 15 + openId 前 12 位）才暴露。
       *
       * ## 为什么不把两条合并
       *
       * 它们的**代价模型**不同：`status()` 在设置页每次渲染都会走
       * （带 30s TTL 缓存），而 `resolveSelf()` 只在授权后与手动确认时走。
       * 合并会让便宜的那条变贵。所以这里补一次同样的取值，
       * 而不是让 `status()` 去调 `resolveSelf()`。
       *
       * ★ 只在**已授权**且拿到的是派生值时才去问 —— 派生值的前缀
       * `unknown-tenant:` 就是"没读到真租户"的标记（见 `parseLarkIdentity`）。
       * 已经有真值时不多花一次子进程调用。
       *
       * ★ 失败**不影响授权态**：拿不到就沿用派生值。这一步失败不该把
       * "已授权"变成"未授权"。
       */
      if (status.state === "authorized") {
        /**
         * ★ 两件事分开判，因为它们**各自可能缺**：
         *
         * · `corpId` 是派生值（`unknown-tenant:` 前缀）→ 去 `get-user` 补真
         *   `tenant_key`（那是身份隔离键的一段，见 `parseLarkIdentity`）；
         * · `corpName` 是「未知组织」或短码 → 去租户接口补**可读的名字**。
         *
         * 合成一个 `if` 的话，某天上游给了 tenantKey 却仍不给名字时，
         * 名字那一支就永远不会去补 —— 界面回到显示短码。
         * 这正是本轮踩过的形状（判据搭在了另一件事上）。
         */
        let corpId = status.corpId
        let corpName = status.corpName
        if (corpId.startsWith("unknown-tenant:")) {
          try {
            const user = await this.cli.json<unknown>([
              "contact",
              "+get-user",
              "--as",
              "user",
              "--format",
              "json",
            ])
            const tenantKey = readFeishuTenantKey(user)
            if (tenantKey !== null) corpId = tenantKey
          } catch (error) {
            this.options.logger.debug("lark tenant key lookup failed; keeping derived corpId", {
              detail: error instanceof Error ? error.message : String(error),
            })
          }
        }
        /**
         * 组织名：`parseLarkIdentity` 在读不到时给的是「未知组织」——
         * 那就是"要去补"的标记。拿到真名就用，拿不到才回落 tenant_key 短码
         * （**不编**一个假名字，两个组织至少能分辨）。
         */
        if (corpName === "未知组织") {
          corpName =
            (await this.readTenantName()) ??
            (corpId.startsWith("unknown-tenant:") ? corpName : `组织 ${corpId.slice(0, 8)}`)
        }
        if (corpId !== status.corpId || corpName !== status.corpName) {
          return { ...status, corpId, corpName }
        }
      }
      return status
    } catch (error) {
      this.options.logger.debug("lark auth status unavailable", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return { state: "unauthorized" }
    }
  }

  /**
   * 可读的**组织名**。
   *
   * ## ★★ 为什么单独一次调用（而不是从已有响应里挖）
   *
   * 实测把三条都问过了，组织名**都没有**：`auth status --json --verify`
   * 只有 `appId` 与 `identities.*`；`contact +get-user` 有 `tenant_key`
   * 但没有名字；`contact --help` 里没有任何 tenant 命令。
   * 它只在 `GET /open-apis/tenant/v2/tenant/query` 里。
   *
   * 我一度据此下结论"拿不到组织名、只能显示 tenant_key 短码"，并把那句
   * 写进了注释与界面 —— **那个结论是错的**（只查了 shortcut 层没查 API 层），
   * 是用户看到界面上一串短码时指出来的。所以这里记下判据的来源。
   *
   * ## ★ `--as bot`
   *
   * 实测用 user 身份打这个接口报 `99991668 user access token not support`
   * —— 这是**应用**维度的信息，不属于某个人。
   *
   * 拿不到返回 `null`（调用点回落短码）：这一步失败不该影响授权态。
   */
  private async readTenantName(): Promise<string | null> {
    try {
      const payload = await this.cli.json<unknown>([
        "api",
        "GET",
        "/open-apis/tenant/v2/tenant/query",
        "--as",
        "bot",
      ])
      return readFeishuTenantName(payload)
    } catch (error) {
      this.options.logger.debug("lark tenant name unavailable", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return null
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
        /**
         * ★★★ 「还没绑应用」有**三种**错误形态，只认一种会把用户堵死。
         *
         * 飞书授权是两步：① 绑一个 CLI 应用（`config init`）② 拿登录态
         * （`auth login`）。这个 catch 就是"第 ① 步还没做"的补做入口 ——
         * 判据漏一种形态，那种形态下用户就**永远走不到第 ① 步**，
         * 每次点「重新授权」都撞在同一句英文报错上，界面上没有任何出路。
         *
         * ## 实测三种形态（本机，逐个造出来验过）
         *
         * | config.json    | login 报的 message                            |
         * |----------------|-----------------------------------------------|
         * | 不存在         | `not configured`                              |
         * | `{"apps":[]}`  | `not configured`                              |
         * | `{"apps":[{}]}`| `…missing a required parameter: client_id.`   |
         *
         * 第三种是「文件在、但里面的应用条目残缺」。原来的
         * `/not configured/` 只覆盖前两种 —— 而第三种**恰恰是
         * `config remove` 可能留下的形态**（实测 remove 之后文件仍在，
         * 内容是 `{"apps": []}`；若中途失败就会停在更残缺的状态）。
         *
         * `client_id` 是 OAuth 里应用的身份 —— 缺它，本质就是"没有应用"。
         * 所以三种形态在语义上是同一件事，判据必须都收进来。
         *
         * ★ `config` 类的 `invalid_config` / `malformed` 也一并收：
         * 那是 CLI 对同一件事的第三套措辞（`config show` 实测会这么报）。
         */
        const needsApp =
          /not[ _]configured|no app configured|missing a required parameter: client_id|invalid[ _]config|malformed config/i.test(
            detail,
          )
        if (!needsApp) throw error
        this.options.logger.info("lark app binding missing; running app setup first", {})
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

  /**
   * 退出授权 —— 清掉**这个身份目录里**的 token。
   *
   * ## ★ 为什么必须有它（原来整个方法都不存在）
   *
   * `ChannelAuth.logout` 是可选方法，飞书原来没实现 → `ChannelHost.logout()`
   * 对飞书恒返回 `false`。连带两个真实后果：
   * · 「清空当前渠道登录用户数据」永远报 `authRevoked: false`，token 留在盘上；
   * · 界面上没有任何「退出授权」的出路，用户只能去一个他找不到的隔离 HOME
   *   里手敲命令（i18n 里那句提示正是这么写的，已同步改掉）。
   *
   * ## ★ 与钉钉的差别：**不需要**「没绑身份就不退」那道守卫
   *
   * 钉钉的 token 密钥在系统钥匙串、**按系统用户存一份**，也就是与用户自己
   * 终端里的 CLI 共用 —— 所以它必须先确认"有我们自己绑的身份"才敢退，
   * 否则会把用户终端里正在用的登录态退掉（`dingtalk/auth.ts` 里那段长注释）。
   *
   * 飞书不同：`LarkCli.env()` 把 `HOME`/`XDG_CONFIG_HOME`/配置目录/master key
   * **全部**重定向到 `<vault>/channels/feishu/` 下（`cli.ts` 的 `env()`），且
   * `keychain-downgrade` 明确不碰系统钥匙串。凭据是**关在这个 vault 里的**，
   * 退它不会影响用户终端。所以这里直退，不需要守卫。
   *
   * ## ★ 判据用 CLI 自报的 `loggedOut`，不看 exit code
   *
   * 实测（隔离空环境）：未配置时 `auth logout --json` 返回
   * `{ok:true, loggedOut:false, reason:"not_configured"}` —— **exit 0 且不抛**。
   * 也就是说 exit code 在这里没有区分力（"本来就没登录"与"退成功"都是 0），
   * 必须读 `loggedOut` 字段。这与本仓库"不看退出码、看它自己报的状态"
   * 是同一条纪律。
   *
   * @returns 是否真的退掉了（本来就没登录 → `false`，且**不是**错误）
   */
  async logout(): Promise<boolean> {
    try {
      const payload = await this.cli.json<unknown>(["auth", "logout", "--json"])
      const loggedOut =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)["loggedOut"] === true
          : false
      this.options.logger.info("lark auth logout", { loggedOut })
      return loggedOut
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      /**
       * ★ 「本来就没登录」不是失败（与 `resetForAccountSwitch` 同一判断）。
       *
       * 实测日志：清过一次之后再点，CLI 报 `not configured` 并 exit 1，
       * 于是这里返回 false、界面呈现"没退掉"——而那一刻的实际状态
       * 正是"已经退了"。用户看到失败就会反复点。
       *
       * 判据用 CLI 自己的话；其余才是真失败（网络、权限、文件占用…）。
       */
      if (/not[ _]configured|no app configured/i.test(detail)) {
        this.options.logger.info("lark already signed out; nothing to revoke", {})
        return true
      }
      this.options.logger.warn("lark auth logout failed", { detail })
      return false
    }
  }

  /**
   * 为「切换账号 / 换 app」做准备：把这个身份目录的 **token + app 配置**都清掉。
   *
   * ## ★ 为什么单清 token 不够（这是"切不了 app"的根因）
   *
   * `login()` 只在 catch 到 `not configured` 时才走 `configure()`
   * （`config init --new` = 让用户重选 app）。而 `auth logout` **不动**
   * `config.json` 里已绑定的 app —— 配置还在，`login()` 就永远走不到那个
   * 分支，于是"重新授权"每次都用同一个 app、拿回同一个账号。
   *
   * `config remove` 是 CLI 自己提供的出路，help 原文
   * "Remove app configuration (clears all tokens and config)"（实测确认）。
   * 清完再 `login()`，`not configured` 成立 → 用户能重新选 app、扫另一个账号。
   *
   * ## ★ 只在用户显式要求时调
   *
   * 它是破坏性的（CLI 的 help 自己带一句"Do NOT remove profiles unless the
   * user explicitly asks"）。所以这个方法**不进任何自动路径**：只由界面上
   * 「切换账号」那颗按钮触发，而普通「重新授权」仍走原来的 `login()`
   * （刷新当前账号的 token，不动 app 绑定）。
   *
   * @returns 是否清掉了（没配置过 → `false`，不是错误）
   */
  async resetForAccountSwitch(): Promise<boolean> {
    // 先退 token：`config remove` 自己也会清，但先退一步能让"已登录"这个
    // 状态在任何一步失败时都不至于留着（宁可多退一次，也不要留下活 token）
    await this.logout()
    /**
     * ★★ 用 `run()` 而不是 `json()` —— 这条命令**不输出 JSON**。
     *
     * 实测（本机，飞书已配置）：
     *
     * ```
     * $ lark-cli config remove
     * OK: Configuration removed        ← 纯文本，退出码 0
     * ```
     *
     * 原来走 `json()`，于是 `extractLarkJson` 抛"无法解析的内容"，真实日志：
     *
     * ```
     * lark config remove failed {"detail":"飞书 CLI 返回了无法解析的内容"}
     * channel auth reset {"switchAccount":true,"ok":false}
     * ```
     *
     * **配置其实已经清掉了**（后续每条命令都变 `not_configured`），
     * 界面却说失败 —— 用户反复点，而每次都真的又执行了一遍破坏性动作。
     * 这是"成功被当失败"，与静默降级同源：界面状态与真实状态脱节。
     */
    const { exitCode, output } = await this.cli.run(["config", "remove"])
    /**
     * ★ 判据是**做完之后的实际状态**，不是这条命令的退出码。
     *
     * 目标状态 = "没有 app 配置了"。达到它的路径有三种，实测都见过：
     * · exit 0 + `OK: Configuration removed`  —— 刚清掉
     * · 非零 + `no app configured`            —— 本来就没有（连点两次）
     * · 非零 + `not configured`               —— 同上，另一种措辞
     *
     * 三种都是**目标已达成**。所以不看退出码，看输出里有没有这三种迹象；
     * 只有都不匹配才是真失败（文件被占用、权限不足等）。
     */
    if (exitCode === 0 || /no app configured|not[ _]configured|removed/i.test(output)) {
      this.options.logger.info("lark app binding cleared", { exitCode })
      return true
    }
    this.options.logger.warn("lark config remove failed", { exitCode, detail: output.slice(0, 200) })
    return false
  }
}
