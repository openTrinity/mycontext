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

/** 渠道 CLI 认的身份寻址形态。上游 `--help` 推荐 `corpId:userId`，实测唯一稳定可用的写法。 */
export function toChannelProfile(identity: {
  corpId: string
  userId: string
}): string {
  return `${identity.corpId}:${identity.userId}`
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
   */
  mount: (vaultId: string) => Promise<void>
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

  /** 某账号下的全部身份（界面上的身份切换列表）。最近用过的在前。 */
  list(accountId: string, channelId?: string): ChannelIdentityVaultRecord[] {
    return this.options.identities.listByAccount(accountId, channelId)
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
      await this.options.mount(target.vaultId)
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
