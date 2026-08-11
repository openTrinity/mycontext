/**
 * 渠道授权编排（主进程侧）。
 *
 * 职责：把 ChannelHost 的能力包装成 IPC 友好的形态——
 * 汇总渠道摘要、把授权进度推给渲染层、管理取消。
 *
 * 进度用事件推而不是让渲染层轮询：授权过程有「拿到 URL」「等待确认」
 * 这类中间态，轮询会漏掉也会延迟。
 */
import type { BrowserWindow } from "electron"
import type { Logger } from "@mycontext/kernel"
import { isAppError } from "@mycontext/kernel"
import { IPC_EVENTS, type ChannelSummary } from "@mycontext/ipc-contract"
import type { AuthMode, AuthStatus, ChannelHost } from "@mycontext/channels"

export interface ChannelServiceOptions {
  host: ChannelHost
  logger: Logger
  /** 取当前主窗口，用于推事件；窗口可能已关闭故为可空 */
  getWindow: () => BrowserWindow | null
  /**
   * 授权成功后立刻解析并落库本人身份。
   *
   * ## ★ 为什么要在这里做，而不是等用户去状态页点一下
   *
   * `is_self` 只在身份确认之后才回填，而**蒸馏守卫会拒掉所有
   * `is_self IS NULL` 的消息**（`filterDistillable` 的 `identity_unconfirmed`）。
   * 也就是说不确认身份 → 蒸馏 100% 无语料，而进度页显示"完成，0 条结论"。
   * 那个坑真实踩过（9768 条消息全被拒）。
   *
   * 而"刚授权完"正是解析身份最合适的时刻：凭据刚拿到、用户还在场。
   * 让用户事后去另一个页面点一次确认，等于给一条必经之路加了一道
   * 没人知道要走的门。
   *
   * 可选：飞书那种只有契约桩的渠道没有 identity 能力，那时不接这个回调。
   *
   * ## ★ 为什么第二个参数是**已授权态**的 status
   *
   * 回调要回填账号的显示名，而那个名字的唯一权威来源是 dws 刚返回的
   * `userName`（实名，见 `parse.ts` 的 `parseAuthStatus`）。让回调自己再去
   * 查一次等于对同一次授权发两次命令，且两次之间状态可能已变。
   *
   * 传**收窄到 `authorized`** 的那一支而不是整个联合：调用点已经判过
   * `state === "authorized"`，把判别结果带过来，回调里就不需要再判一次空
   * （`corpId`/`userId`/`userName` 在这一支里都是必有的）。
   */
  onAuthorized?: (
    channelId: string,
    status: Extract<AuthStatus, { state: "authorized" }>,
  ) => Promise<void>
}

export class ChannelService {
  constructor(private readonly options: ChannelServiceOptions) {}

  /** 渠道列表 + 各自授权状态，供设置页与 Onboarding 渲染。 */
  async list(): Promise<ChannelSummary[]> {
    const summaries: ChannelSummary[] = []
    for (const plugin of this.options.host.list()) {
      // 未开放的渠道不去查状态（飞书的 status 是桩），避免无意义的开销与误导。
      const status: AuthStatus = plugin.meta.available
        ? await this.safeStatus(plugin.meta.id)
        : { state: "unauthorized" }

      summaries.push({
        id: plugin.meta.id,
        labelKey: plugin.meta.labelKey,
        descriptionKey: plugin.meta.descriptionKey,
        available: plugin.meta.available,
        stepKeys: plugin.auth.describeStepKeys(),
        status,
        loginInProgress: this.options.host.isLoginInProgress(plugin.meta.id),
        /**
         * ★ 直接取 plugin 的值，**不在这里重新推导**。
         *
         * 「这个渠道能不能以本人身份发消息」的真源是插件自己
         * （`ChannelCapabilities.sendAs`）。这一层若写成
         * `sendAs: plugin.meta.id === "dingtalk" ? ["self"] : []`
         * 就等于在这里造了第二份判据 —— 而那正是渲染层原来的病
         * （七处各写一份 `=== "dingtalk"`）。
         */
        capabilities: {
          sendAs: [...plugin.capabilities.sendAs],
          domains: [...plugin.capabilities.domains],
          isolatedCredentials: plugin.capabilities.isolatedCredentials,
        },
      })
    }
    return summaries
  }

  /**
   * 查询状态。单个渠道查询失败不抛给 UI：
   * 设置页需要能渲染出「其他渠道正常 + 这个渠道异常」，而不是整页报错。
   *
   * ★ `public` 而不是 `private`：登录后要判"本机是否已有登录态"
   * （`startup.ts` 的补跑身份那段），而那个判断需要的正是这套
   * "查不到就当未授权、不抛"的语义 —— 让调用方自己 try/catch
   * 会得到第二份同义实现，而两份会分叉。
   */
  async safeStatus(channelId: string): Promise<AuthStatus> {
    try {
      return await this.options.host.status(channelId)
    } catch (error) {
      this.options.logger.warn("channel status failed", {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      })
      return { state: "unauthorized" }
    }
  }

  status(channelId: string, refresh: boolean): Promise<AuthStatus> {
    return this.options.host.status(channelId, { refresh })
  }

  /**
   * 退出某个渠道的授权（清掉钥匙串里那份 token）。
   *
   * ★ 为什么「清空渠道数据」必须调它：token 在**系统钥匙串**里，不在
   * vault 目录下。删目录之后 CLI 会从钥匙串重建 profiles，`auth status`
   * 照样返回已授权 —— 那正是用户报的"清了还是已授权状态"。
   *
   * 返回是否真的退出了。**不抛**：退登失败只是"凭据还在"，
   * 而让整个清空动作因此回滚是更坏的选择（那时数据已经删了）。
   */
  async logout(channelId: string): Promise<boolean> {
    try {
      const ok = await this.options.host.logout(channelId)
      this.options.logger.info("channel logout", { channelId, ok })
      return ok
    } catch (error) {
      this.options.logger.warn("channel logout failed", {
        channelId,
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * 退出授权 / 切换账号（`switchAccount` 为真时连 app 绑定一起清）。
   *
   * 用户在界面上有两颗按钮：「退出授权」= 只清凭据；「切换账号」= 还要清掉
   * app 绑定，否则下一次授权仍会拿回同一个账号（见 `ChannelHost.resetAuth`）。
   *
   * 与 `logout` 一样**不抛**：失败降级成 `false`，由界面呈现"没退掉"。
   */
  async resetAuth(channelId: string, switchAccount: boolean): Promise<boolean> {
    try {
      const ok = await this.options.host.resetAuth(channelId, switchAccount)
      this.options.logger.info("channel auth reset", { channelId, switchAccount, ok })
      return ok
    } catch (error) {
      this.options.logger.warn("channel auth reset failed", {
        channelId,
        switchAccount,
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async startLogin(channelId: string, mode: AuthMode): Promise<AuthStatus> {
    this.options.logger.info("channel login start", { channelId, mode })
    const status = await this.options.host.startLogin({
      channelId,
      mode,
      onProgress: (progress) => {
        // 进度里可能含授权 URL（带 client_id 等），属于可公开信息；
        // 但不记录到日志正文，只记 phase。
        this.options.logger.debug("channel auth progress", { channelId, phase: progress.phase })
        const window = this.options.getWindow()
        if (window === null || window.isDestroyed()) return
        window.webContents.send(IPC_EVENTS.channelAuthProgress, { channelId, progress })
      },
    })

    /**
     * ★ 授权成功 → 立刻解析并落库身份。
     *
     * 失败**不**让整个登录失败：授权本身已经成功了，而身份解析是一个
     * 可以稍后重试的补充步骤（状态页仍然有那个入口）。
     * 抛出去的话用户会看到"登录失败"，而他其实已经登录上了 ——
     * 那比缺一个 is_self 糟得多。
     */
    if (status.state === "authorized" && this.options.onAuthorized !== undefined) {
      try {
        await this.options.onAuthorized(channelId, status)
      } catch (error) {
        /**
         * ★ 身份**歧义**是一个预期内的状态，不是失败。
         *
         * 同名多 ID 时 `resolveSelf` 抛 `SELF_IDENTITY_AMBIGUOUS`（实测按姓名
         * 搜能返回 6 个不同 ID）—— 这时**不能**替用户猜一个，得让他自己确认。
         *
         * 曾经这里把它和其它异常一样降级成 `warn` 吞掉：授权照常返回成功、
         * onboarding 也照常把 channel 步记完成，而 `is_self` 全表保持 null →
         * 蒸馏静默拒掉全部语料。用户全程看不到任何提示。
         *
         * 现在把它记成 `info`（这是正常分支，不是错误），并**不**再当失败处理。
         * 「未确认」这个状态本就可被 UI 观测：`confirmSelf` 没跑 → `confirmed_at`
         * 仍 null → 快照 `selfConfirmed=false`。onboarding 的 channel 步据此
         * 就地显示确认入口（软门：不自动打勾，但跳过/继续始终可用）。
         *
         * 其它异常（网络、CLI 失败等）仍走 `warn` —— 那些才是真的"出问题了"。
         */
        if (isAppError(error) && error.code === "SELF_IDENTITY_AMBIGUOUS") {
          this.options.logger.info("self identity needs manual confirmation after auth", {
            channelId,
          })
        } else {
          this.options.logger.warn("resolve self identity after auth failed", {
            channelId,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    return status
  }

  cancelLogin(channelId: string): boolean {
    this.options.logger.info("channel login cancel", { channelId })
    return this.options.host.cancelLogin(channelId)
  }

  /**
   * 已授权的渠道 id 列表 —— 挂几条采集管线 / 起几个 kl 的判据。
   * 与 `hasAnyAuthorized` 分开的理由见 `ChannelHost.authorizedChannels`。
   */
  authorizedChannels(): Promise<string[]> {
    return this.options.host.authorizedChannels()
  }

  hasAnyAuthorized(): Promise<boolean> {
    return this.options.host.hasAnyAuthorized()
  }
}
