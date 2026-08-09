/**
 * 当前生效的**渠道身份**，以及切换它。
 *
 * ## ★★ 这一层存在的理由：隔离维度是「渠道身份」而不是「本地账号」
 *
 * 一个人可能在多个组织里各有一个身份（实测本机有两个钉钉 profile）。
 * 原来的隔离键是 `accountId`（`accounts.vault_id` 一对一），于是"换身份"
 * 只能"换本地账号" —— `SelfIdentityRepository.upsert` 撞
 * `SELF_IDENTITY_CONFLICT` 之后，界面能给的唯一出路就是"新建一个账号"。
 * 那是把渠道的身份问题推给了登录体系，而两者本来无关
 * （同一个人、同一次登录，只是换了组织）。
 *
 * 现在：`(accountId, channelId, corpId, userId) → vaultId`，映射在 control 库
 * （`ChannelIdentityVaultRepository`），而"此刻用哪一个"由本服务持有。
 *
 * ## ★ 为什么它只管"是谁"，不管"挂载"
 *
 * 挂载/卸载是一长串有严格顺序的副作用（停采集、卸 agent、停图谱服务、
 * 关库…），那是装配层的职责（`startup.ts` 的 `mountVault`/`unmountVault`）。
 * 混进来会让"记一下当前是谁"变成一个带二十个依赖的方法，也就没法单测了。
 *
 * 所以本服务提供的是**事实与决策**：当前是谁、有哪些可选、该切到哪个 vault；
 * 真正去挂的动作由注入的 `mount` 回调完成。
 *
 * ## ★ `dwsProfile` 是这一层最重要的产出
 *
 * 渠道 CLI 的每条命令都要钉住身份（`--profile <corpId>:<userId>`），
 * 而 `RuntimeEnv` 是启动时构造一次的 —— 它拿的是一个 **getter**，
 * 现读本服务的当前值。不钉的话命令跟着 CLI 的全局 `currentProfile` 走，
 * 那个值会被用户在终端改掉，于是我们拿着 A 的库去读 B 的会话
 * （实测：库里 248 个会话属于组织甲，而采集器在按组织乙列会话）。
 */
import { AppError, type Logger } from "@mycontext/kernel"
import type { ChannelIdentity } from "@mycontext/ipc-contract"
import type {
  ChannelIdentityKey,
  ChannelIdentityVaultRecord,
  ChannelIdentityVaultRepository,
  SettingsRepository,
} from "@mycontext/store"
import { identityKeyString, parseIdentityKeyString } from "@mycontext/store"

/**
 * 记住"上次用的是哪个身份"。落 `app_settings`（应用级）——
 * 它是**这台机器上的偏好**，与任何一个 vault 的内容无关；
 * 放进 vault 会形成"要先知道用哪个 vault 才能读出用哪个 vault"的循环。
 */
const ACTIVE_IDENTITY_KEY = "active_channel_identity"

/**
 * 渠道 CLI 认的身份寻址形态。
 *
 * ## ★★ 是**裸 corpId**，不是 `corpId:userId` —— 后者实测不可用
 *
 * 上游 `--help` 写的是「组织 profile 名或 corpId」，而我先前照它推荐的
 * `corpId:userId` 写，并在注释里记成"实测唯一稳定可用的写法"。
 * 那句话是错的。重新实测（三次一致，且在**全新 seed** 的临时目录上复现）：
 *
 * ```
 * --profile <corpId>:<userId>  → authenticated=false「未登录」
 * --profile <corpId>           → authenticated=true，正常返回
 * ```
 *
 * 换一条真业务命令（`contact user get-self`）结论相同：带冒号那种直接
 * `code=2 category=auth`「未登录」，裸 corpId 正常返回员工信息。
 *
 * ## ★ 为什么这个错**看起来像别的问题**
 *
 * 带冒号那种被上游归类成 `auth` 类错误 —— 也就是界面上会显示
 * 「授权已失效，请重新扫码」。而真实原因是我们把 profile 拼错了，
 * 重新扫码一百次也不会好。这正是本项目最怕的那类：症状指向一个
 * 完全无关的方向（去查授权、去查 token），而根因在一行字符串拼接里。
 *
 * ## ★ 那 `userId` 去哪了
 *
 * 不需要它：一个 `corpId` 在这个配置目录里**只对应一条 profile**
 * （`seedChannelProfile` 保证只 seed 当前身份那一条，见它的 `matchesSeed`），
 * 所以组织本身就唯一定位了身份。`userId` 仍留在隔离键里 ——
 * 那是**我们**区分身份用的，与 CLI 的寻址无关。
 */
export function toChannelProfile(identity: { corpId: string; userId: string }): string {
  return identity.corpId
}

export interface ActiveIdentityServiceOptions {
  identities: ChannelIdentityVaultRepository
  /** control 库的 app_settings —— 记住上次用的身份 */
  settings: SettingsRepository
  logger: Logger
  now: () => Date
  /**
   * 真正去挂载一个 vault（卸旧 + 挂新）。由装配层注入。
   *
   * ★ 必须是 `Promise` 且调用方**必须 await**：卸载里有"等在途采集收尾"
   * 与"等图谱服务让出端口"两件必须等的事（见 startup 的 unmountVault）。
   *
   * ## ★★ 第二个参数是「这个 vault 属于谁」，**不能**让 mount 自己去读
   *
   * 挂载内部要把渠道配置目录 seed 成这个 vault 的身份（身份隔离的主防线）。
   * 而 seed 原来读的是 `currentIdentity()` —— 一个**在挂载完成后才被更新**
   * 的内存态。于是切身份时 seed 拿到的是**上一个**身份（详见 `switch()`）。
   *
   * 显式传进来之后这个时序问题在类型层面就不存在了：mount 不再依赖
   * "调用方有没有先更新内存态"这个不可见的前提。
   *
   * `null` = 这个 vault 还没绑身份（基础 vault，引导流程要往里写），
   * 那时**不 seed** —— 授权本身还没发生，没有"属于谁"可言。
   */
  mount: (vaultId: string, identity: ChannelIdentityVaultRecord | null) => Promise<void>
}

export class ActiveIdentityService {
  private current: ChannelIdentityVaultRecord | null = null
  /**
   * 切换的 in-flight 闸。
   *
   * ★ 两次切换交错会让卸载/挂载的顺序穿插，而那会同时踩上两个真问题：
   * 图谱服务的端口竞态（新的先起、旧的还没让出 8200），以及
   * "退订错身份"（卸载里那条 `event stop --all` 用的是当时的身份 getter）。
   * 与 `FeedService.inFlightSync` 同一款做法。
   */
  private switching: Promise<void> | null = null

  constructor(private readonly options: ActiveIdentityServiceOptions) {}

  /** 当前身份；null = 还没绑任何渠道身份（新账号的正常状态）。 */
  currentIdentity(): ChannelIdentityVaultRecord | null {
    return this.current
  }

  /**
   * 钉给渠道命令的 profile 值；null = 不钉（退回 CLI 全局 profile）。
   *
   * ★ `RuntimeEnv` 拿的是包着这个方法的 getter —— 每条命令现读，
   * 所以切完身份**下一条命令**就用新身份，不必重启。
   */
  currentProfile(): string | undefined {
    const identity = this.current
    return identity === null ? undefined : toChannelProfile(identity)
  }

  /** 某账号下的全部身份（最近用过的在前）。 */
  list(accountId: string, channelId?: string): ChannelIdentityVaultRecord[] {
    return this.options.identities.listByAccount(accountId, channelId)
  }

  /**
   * 给渲染层的身份列表。
   *
   * ★ 与 `list()` 分开是因为**边界不同**：这个要过 IPC，所以
   * **不带 vaultId**（那是存储布局，渲染层不需要知道 —— 与 `AuthSession`
   * 刻意不带 vaultId 同一条原则）。`active` 由这一层算，
   * 免得渲染层再去比一次（两处比会分叉）。
   */
  listView(accountId: string, channelId?: string): ChannelIdentity[] {
    const current = this.current
    return this.list(accountId, channelId).map((row) => ({
      channelId: row.channelId,
      corpId: row.corpId,
      userId: row.userId,
      corpName: row.corpName,
      userName: row.userName,
      active:
        current !== null &&
        current.channelId === row.channelId &&
        current.corpId === row.corpId &&
        current.userId === row.userId,
      lastUsedAt: row.lastUsedAt,
    }))
  }

  /**
   * 登录时选定要挂哪个 vault，并记住它。
   *
   * 选择顺序（前者不可用就退到后者）：
   * ① `app_settings` 里记的"上次用的那个"（且它仍属于这个账号）；
   * ② 这个账号最近用过的那个身份；
   * ③ `null` —— 还没绑过任何身份，用账号的**基础 vault**
   *    （`accounts.vault_id`）。那是"注册了但还没连渠道"的正常状态，
   *    onboarding 状态要往那个库里写。
   *
   * @returns 要挂载的 vaultId（调用方负责真正挂）
   */
  resolveOnLogin(input: { accountId: string; fallbackVaultId: string }): string {
    const remembered = this.readRemembered()
    if (remembered !== null && remembered.accountId === input.accountId) {
      const found = this.options.identities.find(remembered)
      if (found !== null) {
        this.current = found
        this.options.logger.info("active identity restored", {
          channelId: found.channelId,
          corpName: found.corpName,
        })
        return found.vaultId
      }
      // 记的那个身份已被解绑 → 清掉这条记录，别让它每次登录都查一次空
      this.options.settings.delete(ACTIVE_IDENTITY_KEY)
    }

    const [mostRecent] = this.options.identities.listByAccount(input.accountId)
    if (mostRecent !== undefined) {
      this.current = mostRecent
      this.remember(mostRecent)
      this.options.logger.info("active identity picked most recent", {
        channelId: mostRecent.channelId,
        corpName: mostRecent.corpName,
      })
      return mostRecent.vaultId
    }

    // 还没绑过任何渠道身份 —— 用基础 vault（onboarding 要往里写）
    this.current = null
    this.options.logger.info("no channel identity bound; using base vault", {})
    return input.fallbackVaultId
  }

  /** 登出：清掉内存态。**不动** `app_settings` —— 下次登录还要用它恢复。 */
  clear(): void {
    this.current = null
  }

  /**
   * 切到另一个身份。
   *
   * 幂等：已经是它就什么都不做（不白付一次几十秒的卸载+挂载）。
   * 并发安全：in-flight 期间的第二次调用会 await 前一次（见 `switching`）。
   *
   * ★ 身份的内存态在 `mount` **之后**才更新 —— 因为卸载阶段还要用**旧**身份
   * 去退订事件（`event stop --all --profile <旧>`）。先改的话会退订错人，
   * 而那条路径整段吞异常（退出路径不该抛），停错了不会有任何痕迹。
   * 这条顺序在 `identity-switch-order` 那组测试里锁着。
   */
  async switchTo(key: ChannelIdentityKey): Promise<ChannelIdentityVaultRecord> {
    const target = this.options.identities.find(key)
    if (target === null) {
      throw new AppError("CHANNEL_UNKNOWN", "这个身份还没有绑定数据目录", {
        retryable: false,
        context: { channelId: key.channelId },
      })
    }
    if (this.current?.vaultId === target.vaultId) return target

    // 有切换在跑 → 等它，再判一次（等完可能已经是目标了）
    const inFlight = this.switching
    if (inFlight !== null) {
      await inFlight.catch(() => undefined)
      if (this.current?.vaultId === target.vaultId) return target
    }

    const run = (async () => {
      this.options.logger.info("switching channel identity", {
        from: this.current?.corpName ?? null,
        to: target.corpName,
        channelId: target.channelId,
      })
      /**
       * ★★ 目标身份**显式传给** mount —— 不能让它去读 `this.current`。
       *
       * 下面那行 `this.current = target` 在 await 之后（卸载阶段要用旧身份
       * 退订，那是对的）。而 mount 内部要按"这个 vault 属于谁"去 seed 渠道
       * 配置目录 —— 它原来读的正是 `currentIdentity()`，也就是**旧**身份。
       *
       * 实测后果（本机三个 vault 全部错配，两个正好对调）：
       * · vault A 绑身份甲，其 dws-home 被 seed 成身份乙；
       * · vault B 绑身份乙，其 dws-home 被 seed 成身份甲。
       *
       * 这不是显示问题，是**越权读取面**：渠道命令按 seed 出来的身份作答，
       * 于是"拿着 A 的库去读 B 的会话"——正是 profile-seed 那道主防线
       * 要structurally 排除掉的事，却被一个时序 bug 从内部打开了。
       * 而它完全静默：两边都"有数据"，只是数据属于别人。
       */
      await this.options.mount(target.vaultId, target)
      // ★ 挂载完成之后才改内存态（卸载阶段要用旧身份退订）
      this.current = target
      const at = this.options.now().toISOString()
      this.options.identities.markUsed(key, at)
      this.remember(target)
    })()

    this.switching = run
    try {
      await run
    } finally {
      this.switching = null
    }
    return target
  }

  /**
   * 授权成功后把身份落到某个 vault 上。
   *
   * 三种情况（这是"重新授权换组织不再报错"的全部实现）：
   * · 已绑过这个身份 → 返回它的 vault（切过去，不新建）；
   * · 没绑过、且当前账号**一个身份都没有** → 绑到**基础 vault**
   *   （那个库里可能已经有采集数据了，新建会把它孤立掉）；
   * · 没绑过、但已有别的身份 → **新建**一个 vault。
   *
   * @returns 该身份对应的 vaultId 与它是不是新建的
   */
  bindAuthorized(input: {
    key: ChannelIdentityKey
    corpName?: string | null | undefined
    userName?: string | null | undefined
    /** 账号的基础 vault（`accounts.vault_id`） */
    baseVaultId: string
    /** 生成一个新 vaultId（注入以便测试可复现） */
    newVaultId: () => string
  }): { vaultId: string; created: boolean } {
    const existing = this.options.identities.find(input.key)
    const at = this.options.now().toISOString()
    if (existing !== null) {
      // 幂等：刷新显示名与 last_used，不动 vault
      this.options.identities.bind({
        ...input.key,
        vaultId: existing.vaultId,
        corpName: input.corpName ?? existing.corpName,
        userName: input.userName ?? existing.userName,
        at,
      })
      return { vaultId: existing.vaultId, created: false }
    }

    const hasAny = this.options.identities.countByAccount(input.key.accountId) > 0
    const vaultId = hasAny ? input.newVaultId() : input.baseVaultId
    this.options.identities.bind({
      ...input.key,
      vaultId,
      corpName: input.corpName ?? null,
      userName: input.userName ?? null,
      at,
    })
    this.options.logger.info("channel identity bound", {
      channelId: input.key.channelId,
      corpName: input.corpName ?? null,
      // 新建 vault 是个值得留痕的事实（磁盘上多了一份数据）
      created: hasAny,
    })
    return { vaultId, created: hasAny }
  }

  private remember(identity: ChannelIdentityVaultRecord): void {
    this.options.settings.set(
      ACTIVE_IDENTITY_KEY,
      identityKeyString(identity),
      this.options.now().toISOString(),
    )
  }

  private readRemembered(): ChannelIdentityKey | null {
    const raw = this.options.settings.get(ACTIVE_IDENTITY_KEY)
    return raw === null ? null : parseIdentityKeyString(raw)
  }
}
