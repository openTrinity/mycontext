/**
 * 授权成功之后的那两件事：确认本人身份、刷新账号的头像与显示名。
 *
 * ## ★ 为什么单独一个文件，而不是留在 `startup.ts` 的回调里
 *
 * 它原来是 `startup.ts` 里一个 90 行的内联闭包，捕获了 `dataPlane` / `media` /
 * `auth` / `logger` 四个上层单例。那个位置**没法写测试** —— 要测它就得把整个
 * `bootstrapApp()` 跑起来（Electron app、真实 vault、迁移、python env…）。
 *
 * 而这段编排恰恰是**必须**有回归门禁的那一类：它的失效方式是静默的
 * （见下面的两段解耦），表现为"重新授权了但头像和昵称没刷新"，而日志里
 * 只有一条关于身份的 warn。提取成一个吃显式依赖的纯函数之后，
 * 那条不变式可以用假依赖锁住（`tests/unit/desktop/channel-auth-identity.test.ts`）。
 */
import { isAppError, type Logger } from "@mycontext/kernel"
import type { AuthStatus } from "@mycontext/channels"

/**
 * 这段编排需要的能力，**按行为**声明而不是收整个 service。
 *
 * 用结构类型（只列真正调到的方法）而不是 `DataPlaneService` 这类具体类：
 * 一是测试里造假依赖不必实现几十个无关方法，二是这段代码到底依赖什么
 * 在签名里就看得见 —— 收整个 service 的话，"它可能碰任何东西"。
 */
export interface PostAuthDeps {
  dataPlane: {
    resolveSelf(): Promise<{
      confirmed: boolean
      openIds: readonly unknown[]
      matchedMessageCount: number
    }>
    confirmSelf(): { backfilled: number; mentionsBackfilled: number }
    /**
     * 解除采集的 blocked 终态（登录过期 / 缺授权）。
     *
     * ## ★★ 为什么授权成功必须调它
     *
     * 采集撞 `SESSION_EXPIRED` 后进入**终态**：设计上不再自动重试
     * （见 `IngestService.recordError` —— 那是对的，重试只会反复失败）。
     * 而解除它的 `clearBlocked()` 原来**唯一**的调用方是状态页那个
     * 「知道了」按钮。
     *
     * 于是：登录过期 → 采集 blocked → 用户去重新授权（**正确**的动作）
     * → 采集仍然 blocked，一次都不再跑。用户做了对的事，系统不认。
     * 而 onboarding 里根本没有那个「知道了」按钮，所以在引导流程里这是个死结。
     *
     * 实测踩到过（本机 2026-08-05 07:24 那个账号）：07:24:28 采集因登录过期
     * 进 blocked，07:25:00 用户重新授权成功，之后 ingest **一条日志都没有** ——
     * vault 里 0 条消息，而引导页显示"采集完成"、蒸馏 0 语料 / 覆盖度 D。
     *
     * 「刚授权成功」正是那个终态该被解除的唯一可靠信号。
     */
    clearBlocked(): void
  }
  media: {
    selfAvatar(options?: { force?: boolean | undefined }): Promise<{
      path: string | null
      reason: string | null
    }>
  }
  auth: {
    applyChannelProfile(incoming: {
      displayName?: string | undefined
      avatarUrl?: string | undefined
    }): { displayNameWritten: boolean; avatarWritten: boolean }
  }
  logger: Pick<Logger, "info" | "warn">
  /** 本地文件路径 → 渲染层可加载的 URL。注入以便测试不依赖 protocol 注册。 */
  toFileUrl: (path: string) => string
}

/**
 * 授权成功 → 把这次授权的身份**路由到它自己的 vault**。
 *
 * ## ★★ 这是"重新授权换组织报错"那条红字的正解
 *
 * 原来的链路是：换组织重新授权 → `SelfIdentityRepository.upsert` 发现
 * `(corpId, userId)` 与库里那行不一致 → 抛 `SELF_IDENTITY_CONFLICT` →
 * 界面只能说"换身份请新建一个账号"。那道守卫**本身是对的**（它挡的是
 * "两个人的语料混进同一份画像"，不可逆），但它给出的出路把渠道的身份问题
 * 推给了登录体系 —— 而两者本来无关：同一个人、同一次登录，只是换了组织。
 *
 * 现在在守卫**之前**先分流：这次授权的身份有自己的 vault 吗？
 * · 有 → 切过去（那个库里就是它的数据，守卫自然不会触发）；
 * · 没有、且这个账号一个身份都没绑过 → 绑到基础 vault（那个库可能已有
 *   采集数据，新建会把它孤立掉）；
 * · 没有、但已有别的身份 → 新建一个 vault，从头开始。
 *
 * 三条分支都在 `ActiveIdentityService.bindAuthorized` 里（那里有单测）。
 *
 * ## ★ 为什么必须在 `applyPostAuthIdentity` 之前跑
 *
 * 后者会 `resolveSelf()` → `upsert` 身份行，也就是**会撞守卫**。
 * 顺序反了的话就回到了原来那条报错路径 —— 只是我们多写了一堆代码。
 *
 * ## ★ 身份键用 `corpId + userId`，不用 openId
 *
 * `userId` 只在**企业内**唯一（同一个人在两家企业下是两个不同的 userId），
 * 所以跨企业唯一要靠 `corpId + userId` 的组合 —— 这也正是渠道 CLI 自己的
 * 多账号体系用的主键（`--profile <corpId>:<userId>`）。
 * openId 是"观察者视角的对端标识"，不是身份主键，且形态各渠道不同。
 *
 * @returns 切换发生了吗（false = 就是当前身份，什么都没动）
 */
export async function routeAuthorizedIdentity(deps: {
  identity: {
    currentIdentity(): { corpId: string; userId: string; vaultId: string } | null
    bindAuthorized(input: {
      key: { accountId: string; channelId: string; corpId: string; userId: string }
      corpName?: string | null | undefined
      userName?: string | null | undefined
      baseVaultId: string
      newVaultId: () => string
    }): { vaultId: string; created: boolean }
    switchTo(key: {
      accountId: string
      channelId: string
      corpId: string
      userId: string
    }): Promise<unknown>
  }
  logger: Pick<Logger, "info" | "warn">
  /** 当前登录账号与它的基础 vault（`accounts.vault_id`） */
  session: { accountId: string; baseVaultId: string } | null
  newVaultId: () => string
  channelId: string
  status: Extract<AuthStatus, { state: "authorized" }>
}): Promise<boolean> {
  const { session } = deps
  if (session === null) {
    // 未登录时也能走授权（那是"还没有身份"时唯一能做的事），但没有 vault 可绑。
    deps.logger.info("authorized while signed out; identity binding deferred", {})
    return false
  }

  const key = {
    accountId: session.accountId,
    channelId: deps.channelId,
    corpId: deps.status.corpId,
    userId: deps.status.userId,
  }
  const current = deps.identity.currentIdentity()
  const bound = deps.identity.bindAuthorized({
    key,
    corpName: deps.status.corpName,
    userName: deps.status.userName,
    baseVaultId: session.baseVaultId,
    newVaultId: deps.newVaultId,
  })

  /**
   * ★ 已经是当前身份 → 什么都不做。
   *
   * "重新授权刷新凭据"是最常见的路径（凭证快过期时用户会点它），
   * 那时切一次 vault 等于白付一次几十秒的卸载+挂载，而且会打断在跑的采集。
   */
  if (current !== null && current.corpId === key.corpId && current.userId === key.userId) {
    return false
  }

  deps.logger.info("routing to identity vault after auth", {
    channelId: key.channelId,
    corpName: deps.status.corpName,
    // 新建 vault 是值得留痕的事实（磁盘上多了一份数据）
    createdVault: bound.created,
  })
  await deps.identity.switchTo(key)
  return true
}

/**
 * 授权成功 → 解析并**确认**本人身份，然后刷新账号的头像与显示名。
 *
 * 身份两步都做（resolve + confirm）而不是只 resolve：`is_self` 是在
 * confirm 时回填的，而蒸馏守卫会拒掉所有 `is_self IS NULL` 的消息。
 * 只 resolve 的话身份表里有行、蒸馏仍然 0 条语料 —— 而进度页显示"完成"。
 * 那个坑真实踩过（9768 条全被拒）。
 *
 * ## ★★ 两段各自 try/catch，第一段失败**不能**吃掉第二段
 *
 * 这个函数体曾经是一条直线：`resolveSelf()` 在最前面裸调，取头像那段在它
 * 后面。于是 `resolveSelf` 一抛异常，**整个函数体连同取头像一起消失**，
 * 由 `channel.service.ts` 那层统一 catch 成一条 warn。
 *
 * 实测踩到过（本机日志 2026-08-05 03:08，连着两次授权）：重新授权到另一个
 * 组织时 `resolveSelf` 抛 `SELF_IDENTITY_CONFLICT`（身份守卫，见
 * `SelfIdentityRepository.upsert`），于是头像**一次都没取**，账号表的
 * `avatar_url` / `display_name` 全程是 NULL，界面上是首字母兜底。用户看到的是
 * "重新授权了，但头像和昵称没刷新"，而日志里只有一条关于身份的 warn ——
 * 完全看不出头像那段根本没执行。
 *
 * 关键点：**取头像不需要"这次授权刚好解析成功"**。`media.selfAvatar()` 自己读
 * `channel_self_identity`，只要库里有一行身份就能干活 —— 而重新授权到同一
 * 身份时，那一行本来就在。也就是说第一段"无事可做"恰恰是第二段最该跑的场景。
 *
 * 所以两段解耦：各自 try/catch，各自记日志，互不阻断。
 *
 * 整个函数**不抛**：授权本身已经成功（用户扫了码、凭据拿到了），
 * 不该被这两件补充动作里的任何一件带崩成"登录失败"。
 */
export async function applyPostAuthIdentity(
  deps: PostAuthDeps,
  status: Extract<AuthStatus, { state: "authorized" }>,
): Promise<void> {
  /**
   * ★★ 第零步：解除采集的 blocked 终态。
   *
   * 完整的 why 在 `PostAuthDeps.dataPlane.clearBlocked` 的注释里。
   * 一句话：采集因登录过期锁死后**只有**状态页那个按钮能解除，而"刚重新
   * 授权成功"才是最该解除它的时刻 —— 否则用户修好了登录态，采集却再也不跑。
   *
   * ★ 放在**最前面**且不进任何 try：它是纯内存赋值（清三个字段），
   * 不可能抛。而放在后面的话，身份解析那段一旦走进异常分支，
   * 这件本该无条件发生的事就要看运气。
   */
  deps.dataPlane.clearBlocked()

  await confirmIdentity(deps)
  await refreshAccountProfile(deps, status)
}

/**
 * 采纳**本机已有的**渠道登录态：落身份行、刷新账号的头像与显示名。
 *
 * ## ★★ 为什么需要它（`onAuthorized` 覆盖不到的那条路）
 *
 * dws 的登录态按**系统用户**共享，不按应用账号：token 的加密密钥在 macOS
 * Keychain（服务名 `dws-cli`），`DWS_CONFIG_DIR` 只隔离 profiles 与日志，
 * **隔离不了 token**（见 `plugins/dingtalk/auth.ts` 文件头，两种隔离手段都实测过）。
 *
 * 后果：新注册一个应用账号，`auth.status()` 拿到的是**上一个账号**授权时留下的
 * token → 界面显示"已连接" → 用户没有理由去点「重新授权」→
 * **`onAuthorized` 从不触发**。而那是唯一会写 `display_name` / `avatar_url`
 * 和落身份行的地方。
 *
 * 实测踩到过（本机 2026-08-05 04:14 注册的账号）：`accounts` 那两列全 NULL、
 * vault 的 `channel_self_identity` 一行都没有，而 `messages` 已经有 49 条 ——
 * 采集照常跑（它不依赖身份），但 `is_self` 全 NULL，蒸馏守卫会以
 * `identity_unconfirmed` 拒掉**全部**语料，而进度页显示"完成"。
 *
 * ## ★★ 为什么是**用户显式触发**，不是登录后自动跑
 *
 * 首版是自动的（登录后 fire-and-forget）。那个设计有两个真问题：
 *
 * 1. **它替用户决定了用哪个身份。** 继承来的登录态可能不是用户想要的那个
 *    组织 —— 而一旦自动写进身份行，用户之后真去授权换组织时会撞
 *    `SELF_IDENTITY_CONFLICT`（身份守卫 fail-closed）。也就是**自动补跑
 *    自己制造了那个冲突**，而用户完全没做过任何选择。
 * 2. **它在用户没操作时 spawn 2-3 次子进程。** 注册完就有几秒的后台
 *    渠道调用，而用户可能压根还没决定要不要连这个渠道
 *    （比如他想先填自有 dws 路径再授权）。
 *
 * 所以现在：检测（`describeAdoptableSession`，纯读、不碰渠道之外的东西）
 * 与执行（本函数）分开，界面上给一个写明组织与账号的按钮，用户点了才跑。
 *
 * 整个函数**不抛**（内部两段各自 catch）。
 *
 * @returns 是否真的采纳了（false = 已经有身份行，或本机没有可用登录态）
 */
export async function adoptExistingSession(
  deps: PostAuthDeps & {
    /** 只读本地那一行，不碰渠道。null = 这个账号还没有身份行。 */
    readSelfIdentity: () => { channelId: string } | null
    /** 查渠道授权态。语义同 `ChannelService.safeStatus`（查不到当未授权，不抛）。 */
    channelStatus: () => Promise<AuthStatus>
  },
): Promise<boolean> {
  const { logger } = deps

  /**
   * ★ 幂等门保留：已经有身份行就什么都不做。
   *
   * 即使这是用户点出来的动作也要判 —— 界面可能是过期的（他在另一个窗口
   * 已经授权过了），而重复落身份会触发一次全表回填扫描。
   */
  if (deps.readSelfIdentity() !== null) return false

  const status = await deps.channelStatus()
  // 登录态没了（过期 / 被别处登出）→ 什么都不做，界面会重新变成未授权。
  if (status.state !== "authorized") return false

  logger.info("adopting existing channel session", { corpName: status.corpName })
  await applyPostAuthIdentity(deps, status)
  /**
   * ★★ 判据是「**身份行真的落下来了**」，不是「跑完没抛」。
   *
   * `applyPostAuthIdentity` 里两段各自 catch（那是对的：取头像失败不该
   * 连带身份也不落），于是它**永远不抛** —— 直接 `return true` 等于
   * 不管成没成都报成功。实测踩到过：`resolveSelf` 被身份闸拒掉、
   * catch 记了一条 warn、这里照样返回 true，界面上表现是
   * **「用这个身份」点了没反应**（乐观更新一闪，刷新后原样）。
   *
   * 重新读一次那一行是廉价的（一次本地 SELECT，与开头那个幂等门同一个查询），
   * 而它把"我以为做成了"换成"确实做成了"。
   */
  const adopted = deps.readSelfIdentity() !== null
  if (!adopted) {
    logger.warn("adopt existing session did not land an identity row", {
      corpName: status.corpName,
    })
  }
  return adopted
}

/**
 * 「本机有一份可以采纳的登录态吗」——**纯查询**，给界面渲染那个入口用。
 *
 * ★ 与 `adoptExistingSession` 分开是刻意的：这个只查状态（一次本地 SELECT
 * 加一次 `auth status`），而那个会 spawn 解析身份与取头像。界面渲染时
 * 要问的是前者，绝不能顺带触发后者 —— 那正是首版自动补跑的毛病。
 *
 * @returns null = 没有可采纳的（已有身份行，或本机未授权）
 */
export async function describeAdoptableSession(deps: {
  readSelfIdentity: () => { channelId: string } | null
  channelStatus: () => Promise<AuthStatus>
}): Promise<{ corpName: string; userName: string } | null> {
  if (deps.readSelfIdentity() !== null) return null
  const status = await deps.channelStatus()
  if (status.state !== "authorized") return null
  return { corpName: status.corpName, userName: status.userName }
}

/** 第一段：身份。失败是"要用户处理"的状态，不阻断第二段。 */
async function confirmIdentity(deps: PostAuthDeps): Promise<void> {
  const { dataPlane, logger } = deps
  try {
    const resolved = await dataPlane.resolveSelf()
    // 已经确认过就不重复 confirm（重复 confirm 会再扫一遍全表回填）——
    // 但**刷新头像/显示名不受此限**，见第二段。
    if (!resolved.confirmed) {
      dataPlane.confirmSelf()
      logger.info("self identity confirmed after auth", {
        openIds: resolved.openIds.length,
        matched: resolved.matchedMessageCount,
      })
    }
  } catch (error) {
    /**
     * 分类与 `channel.service.ts` 那层一致：`AMBIGUOUS`（同名多 ID）与
     * `CONFLICT`（换了身份）都是**预期内**、需要用户在界面上处理的状态，
     * 记 `info`；其余（网络、CLI 挂了）才是真出问题，记 `warn`。
     *
     * 在这里就地 catch 而不是让它冒到上层：上层那个 catch 会连带跳过
     * 第二段 —— 那正是这次要修的 bug。
     */
    const expected =
      isAppError(error) &&
      (error.code === "SELF_IDENTITY_AMBIGUOUS" || error.code === "SELF_IDENTITY_CONFLICT")
    const detail = error instanceof Error ? error.message : String(error)
    if (expected) {
      logger.info("self identity needs user action after auth", { detail })
    } else {
      logger.warn("resolve self identity after auth failed", { detail })
    }
  }
}

/**
 * 第二段：账号的头像与显示名。★ 与第一段解耦（见 `applyPostAuthIdentity`）。
 *
 * ★ 显示名与头像**一起**写，且用 dws 刚给的 `status.userName`（实名）。
 * 原来这里只传头像 —— 而 `applyChannelProfile` 的签名一直支持 `displayName`，
 * 只是没有任何调用方传它，于是账号显示名**永远**不会从渠道回填
 * （与 dws 是否正常无关）。能力齐备而入口缺失。
 *
 * 用实名而不是渠道花名：这是**账号级**身份（登录页、账号切换器都显示它）。
 * 花名留在 `channel_self_identity.display_names_json` 给连接卡片用 ——
 * 那是"渠道里我叫什么"，两个不同的问题。
 *
 * 取不到不是错误（没设头像 / 渠道拿不到都正常），所以吞掉异常。
 * `applyChannelProfile` 内部遵守"manual 永不被覆盖"与"用户设过的名字优先"
 * —— 用户手设过的头像/昵称不会被这里覆盖。
 */
async function refreshAccountProfile(
  deps: PostAuthDeps,
  status: Extract<AuthStatus, { state: "authorized" }>,
): Promise<void> {
  const { media, auth, logger, toFileUrl } = deps
  try {
    /**
     * ★ `force: true` —— 重新授权正是"头像可能变了"的时刻。
     *
     * 缓存对已取到的头像**永不过期**（`needsFetch` 对有 local_path 的行直接
     * 返回 false），所以不 force 的话：首次授权取到一张图之后，用户在钉钉换了
     * 头像、再回来点「重新授权」，看到的还是那张旧图 —— 而这恰恰是用户报的症状。
     *
     * 授权是低频动作（不是每次启动都跑），多付 2-3 次子进程调用换
     * "重新授权后头像真的会更新"，这个交换是划算的。
     */
    const shot = await media.selfAvatar({ force: true })
    if (shot.path === null) {
      logger.info("self avatar unavailable", { reason: shot.reason })
    }
    /**
     * ★ 即使头像没取到也要写显示名 —— 两者是独立的字段。
     *
     * 合成一次调用而不是分两次：`applyChannelProfile` 逐字段判各自的覆盖
     * 规则，而分两次会让"头像取不到"顺带跳过显示名（正是这次要修的那类耦合）。
     */
    const written = auth.applyChannelProfile({
      displayName: status.userName,
      ...(shot.path === null ? {} : { avatarUrl: toFileUrl(shot.path) }),
    })
    logger.info("self profile applied after auth", {
      displayName: written.displayNameWritten,
      avatar: written.avatarWritten,
    })
  } catch (error) {
    logger.warn("apply self profile after auth failed", {
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
