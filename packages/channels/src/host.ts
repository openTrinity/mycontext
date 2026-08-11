/**
 * 渠道注册表与宿主。
 *
 * 用显式数组而不是文件系统扫描：启动确定、可类型检查、打包后不会因动态 require
 * 的路径问题失效。新增渠道 = 在 createRegistry 里加一行。
 */
import { AppError } from "@mycontext/kernel"
import type { AuthMode, AuthProgress, AuthStatus, ChannelId, ChannelPlugin } from "./types.js"
import { parseScopedChannelId } from "./source-key.js"

export interface ChannelRegistry {
  list(): ChannelPlugin[]
  get(id: string): ChannelPlugin
}

export function createRegistry(plugins: ChannelPlugin[]): ChannelRegistry {
  const byId = new Map<string, ChannelPlugin>(plugins.map((plugin) => [plugin.meta.id, plugin]))
  return {
    list: () => [...plugins],
    get: (id) => {
      /**
       * ★★★ 查表前**剥掉来源段**（`dingtalk@src-…` → `dingtalk`）。
       *
       * 隔离键的第一段是「哪个 dws 二进制」（见 `source-key.ts`），所以库里
       * 存的 `channel_id` 可能带作用域。而**插件是按渠道注册的** ——
       * 一个钉钉插件服务所有来源，注册表里只有裸 `dingtalk`。
       *
       * 不剥的后果实测抓到过（CDP 端到端跑「清空当前渠道的数据」）：
       *
       * ```
       * channel logout failed {"channelId":"dingtalk@src-…","detail":"未知渠道：dingtalk@src-…"}
       * channel data wipe done {"rows":44008,"identityUnbound":true,"authRevoked":false}
       * ```
       *
       * 数据删了、身份解绑了，而**授权没退** —— 钥匙串里的 token 还在，
       * 于是清空之后 `auth status` 仍返回 authorized。那正是用户报的
       * "清了还是已授权状态"。
       *
       * ★ 为什么修在注册表而不是各个调用点：`logout` / `status` /
       * `startLogin` / `cancelLogin` 全都走 `get()`，逐个调用点去剥必然漏
       * （这次就漏了 logout 这一条），而且漏掉的那条**不会报错**，
       * 只会在某个具体动作上静默失效。
       *
       * ★ `parseScopedChannelId` 对不带作用域的值是恒等的
       * （`"dingtalk"` → `"dingtalk"`），所以这一行对存量调用零影响。
       */
      const plugin = byId.get(parseScopedChannelId(id).channelId)
      if (plugin === undefined) {
        throw new AppError("CHANNEL_UNKNOWN", `未知渠道：${id}`, {
          messageKey: "errors:channel.unknown",
          messageParams: { id },
          context: { id },
        })
      }
      return plugin
    },
  }
}

export interface StartLoginInput {
  channelId: string
  mode: AuthMode
  onProgress: (progress: AuthProgress) => void
}

/**
 * 渠道宿主：本阶段只负责授权的编排与并发保护。
 *
 * 授权态**不落库**：DWS 自己持有凭据，我们每次读它。缓存只放内存并带 TTL，
 * 避免设置页每次渲染都 spawn 一个子进程；也避免两份状态不一致这种最难查的问题。
 */
export class ChannelHost {
  private readonly cache = new Map<string, { status: AuthStatus; at: number }>()
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly registry: ChannelRegistry,
    private readonly options: { cacheTtlMs?: number; now?: () => number } = {},
  ) {}

  private get ttl(): number {
    return this.options.cacheTtlMs ?? 30_000
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  list(): ChannelPlugin[] {
    return this.registry.list()
  }

  async status(channelId: string, options: { refresh?: boolean } = {}): Promise<AuthStatus> {
    const cached = this.cache.get(channelId)
    if (options.refresh !== true && cached !== undefined && this.now - cached.at < this.ttl) {
      return cached.status
    }
    const status = await this.registry.get(channelId).auth.status()
    this.cache.set(channelId, { status, at: this.now })
    return status
  }

  /**
   * 退出某个渠道的授权。
   *
   * ★ **必须清缓存**：`status()` 有 TTL 缓存，不清的话退登之后界面上
   * 还会显示"已授权"直到缓存过期 —— 而那正是"点了清空但还是已授权"
   * 这类问题最容易复发的地方。
   *
   * 渠道没实现 logout 时返回 false（不抛）：调用方据此如实告知
   * "数据清了但凭据还在"，而不是假装退成功了。
   */
  async logout(channelId: string): Promise<boolean> {
    const auth = this.registry.get(channelId).auth
    if (auth.logout === undefined) return false
    const ok = await auth.logout()
    this.cache.delete(channelId)
    return ok
  }

  /**
   * 退出授权，并（`switchAccount` 为真时）连 app 绑定一起清 —— 让用户下一次
   * 授权能换成**另一个账号**。见 `ChannelAuth.resetForAccountSwitch`。
   *
   * ★ 与 `logout` 一样必须清 status 的 TTL 缓存：不清的话界面在缓存过期前
   * 仍显示"已授权"，用户会以为没生效而反复点（这是修过一次的形态）。
   *
   * @returns 是否真的清掉了（渠道不支持 / 本来就没配置 → false，不是错误）
   */
  async resetAuth(channelId: string, switchAccount: boolean): Promise<boolean> {
    const auth = this.registry.get(channelId).auth
    const ok =
      switchAccount && auth.resetForAccountSwitch !== undefined
        ? await auth.resetForAccountSwitch()
        : auth.logout !== undefined
          ? await auth.logout()
          : false
    this.cache.delete(channelId)
    return ok
  }

  /** 是否有渠道已授权：Onboarding 的判定依据。 */
  async hasAnyAuthorized(): Promise<boolean> {
    for (const plugin of this.registry.list()) {
      if (!plugin.meta.available) continue
      try {
        const status = await this.status(plugin.meta.id)
        if (status.state === "authorized") return true
      } catch {
        // 单个渠道查询失败不影响判定（当作未授权），避免把用户卡在启动流程外。
      }
    }
    return false
  }

  /**
   * 已授权的渠道 id 列表。
   *
   * ## ★ 为什么不让 `hasAnyAuthorized` 复用它
   *
   * 那个有**短路**：只要有一个已授权就立刻返回，不再去查剩下的。而查一次授权态
   * 是一次子进程调用（钉钉要 spawn dws、飞书要 spawn lark-cli，实测各 0.3-1s），
   * 登录路径上每次渲染设置页都会走它 —— 改成"先收集全部再判断"等于把那条路
   * 从「查一个」变成「查全部」。两个方法的判据相同但**代价模型不同**，
   * 合并会让便宜的那条变贵。
   *
   * 失败当未授权（与 `hasAnyAuthorized` 同口径）：这个结果用来决定"挂几条采集
   * 管线 / 起几个 kl"，把一个查不到状态的渠道算成已连，会挂出一条注定失败的管线。
   */
  async authorizedChannels(): Promise<string[]> {
    const ids: string[] = []
    for (const plugin of this.registry.list()) {
      if (!plugin.meta.available) continue
      try {
        const status = await this.status(plugin.meta.id)
        if (status.state === "authorized") ids.push(plugin.meta.id)
      } catch {
        // 与 hasAnyAuthorized 同口径：查不到就当未授权，不把启动流程卡住。
      }
    }
    return ids
  }

  isLoginInProgress(channelId: string): boolean {
    return this.running.has(channelId)
  }

  /**
   * 启动授权。同一渠道同时只允许一个流程：
   * 两个 dws auth login 并发会争抢同一个回调端口与凭据文件。
   */
  async startLogin(input: StartLoginInput): Promise<AuthStatus> {
    if (this.running.has(input.channelId)) {
      throw new AppError("CHANNEL_AUTH_IN_PROGRESS", "该渠道正在授权中", {
        messageKey: "errors:channel.authInProgress",
        context: { channelId: input.channelId },
      })
    }

    const plugin = this.registry.get(input.channelId)
    const controller = new AbortController()
    this.running.set(input.channelId, controller)

    try {
      const status = await plugin.auth.login({
        mode: input.mode,
        signal: controller.signal,
        onProgress: input.onProgress,
      })
      this.cache.set(input.channelId, { status, at: this.now })
      return status
    } finally {
      this.running.delete(input.channelId)
    }
  }

  cancelLogin(channelId: string): boolean {
    const controller = this.running.get(channelId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /** 授权状态变化后主动失效缓存（如授权成功、用户手动刷新）。 */
  invalidate(channelId?: ChannelId | string): void {
    if (channelId === undefined) this.cache.clear()
    else this.cache.delete(channelId)
  }
}
