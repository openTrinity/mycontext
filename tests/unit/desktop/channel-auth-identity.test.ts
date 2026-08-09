/**
 * 授权成功后自动确认身份的门禁。
 *
 * ## ★ 为什么这件事值得一组门禁
 *
 * `is_self` 只在**身份确认之后**才回填，而蒸馏守卫会拒掉所有
 * `is_self IS NULL` 的消息（`filterDistillable` 的 `identity_unconfirmed`）。
 * 也就是不确认身份 → 蒸馏 **100% 无语料**，而进度页显示「完成，0 条结论」。
 *
 * 那个坑真实踩过：9768 条消息全被拒。它的可怕之处是**外观正常** ——
 * 没有报错、没有告警，只是画像永远是空的。
 *
 * 原来的设计是让用户自己去状态页点一次「确认身份」，也就是给一条必经之路
 * 加了一道没人知道要走的门。现在授权成功就自动做。
 *
 * ## 这里测的是编排，不是 DWS
 *
 * 用假 plugin 与假回调 —— 要验的是"授权成功才调、失败不调、
 * 回调抛错不让登录失败"这几条编排性质。真实的身份解析另有覆盖。
 */
import { describe, expect, it } from "vitest"
import { createLogger, AppError } from "@mycontext/kernel"
import { ChannelHost, createRegistry } from "@mycontext/channels"
import type { AuthStatus, ChannelPlugin } from "@mycontext/channels"
import { ChannelService } from "../../../apps/desktop/src/main/services/channel.service.js"
import {
  applyPostAuthIdentity,
  adoptExistingSession,
  describeAdoptableSession,
  type PostAuthDeps,
} from "../../../apps/desktop/src/main/bootstrap/post-auth-identity.js"

const logger = createLogger("Test", { level: "error" })

const AUTHORIZED: AuthStatus = {
  state: "authorized",
  corpId: "c1",
  corpName: "测试企业",
  userId: "u1",
  userName: "测试用户",
  accessExpiresAt: "2026-08-01T00:00:00Z",
  refreshExpiresAt: "2026-08-27T00:00:00Z",
  daysUntilRefreshExpiry: 29,
}

/**
 * 造一个最小可用的假渠道。
 *
 * 方法名是 `login`（不是 `startLogin`）—— 那是 `ChannelAuth` 的真实契约；
 * `startLogin` 是 `ChannelHost` 那一层的名字。第一版写错了，
 * 表现是 `plugin.auth.login is not a function`。
 */
function fakePlugin(
  login: (ctx: { onProgress?: (p: { phase: string }) => void }) => Promise<AuthStatus>,
): ChannelPlugin {
  return {
    meta: { id: "dingtalk", name: "钉钉", available: true },
    capabilities: { sendAs: ["self"] },
    auth: {
      describeStepKeys: () => [],
      status: () => Promise.resolve(AUTHORIZED),
      login,
    },
  } as unknown as ChannelPlugin
}

function makeService(
  login: (ctx: { onProgress?: (p: { phase: string }) => void }) => Promise<AuthStatus>,
  onAuthorized?: (
    channelId: string,
    status: Extract<AuthStatus, { state: "authorized" }>,
  ) => Promise<void>,
) {
  return new ChannelService({
    host: new ChannelHost(createRegistry([fakePlugin(login)])),
    logger,
    getWindow: () => null,
    ...(onAuthorized === undefined ? {} : { onAuthorized }),
  })
}

describe("★ 授权成功 → 自动确认身份（不让用户去别的页面点一下）", () => {
  it("授权成功时调回调，且带上 channelId", async () => {
    const calls: string[] = []
    const service = makeService(
      () => Promise.resolve(AUTHORIZED),
      (channelId) => {
        calls.push(channelId)
        return Promise.resolve()
      },
    )

    const status = await service.startLogin("dingtalk", "loopback")
    expect(status.state).toBe("authorized")
    expect(calls).toEqual(["dingtalk"])
  })

  /**
   * ★ 没授权成功就**不该**调。
   *
   * 未授权时去解析身份必然失败（没有凭据），而那次失败会写进日志、
   * 看起来像一个真问题。更糟的是：如果实现里顺手 confirm 了，
   * 会把一个**空的**身份确认掉 —— 那时 `is_self` 回填成全 false，
   * 蒸馏拿到的语料全是"别人说的"。
   */
  it("未授权时不调回调", async () => {
    const calls: string[] = []
    const service = makeService(
      () => Promise.resolve({ state: "unauthorized" }),
      (channelId) => {
        calls.push(channelId)
        return Promise.resolve()
      },
    )

    await service.startLogin("dingtalk", "loopback")
    expect(calls).toEqual([])
  })

  /**
   * ★ 回调抛错**不能**让登录失败。
   *
   * 授权本身已经成功了 —— 用户扫了码、凭据拿到了。而身份解析是一个
   * 可以稍后重试的补充步骤（状态页仍有那个入口，同名多 ID 时**必须**
   * 走那条人工路）。抛出去的话用户看到"登录失败"，而他其实已经登录上了
   * —— 那比缺一个 is_self 糟得多（他会重扫一次，然后还是"失败"）。
   */
  it("回调抛错时登录仍然算成功", async () => {
    const service = makeService(
      () => Promise.resolve(AUTHORIZED),
      () => Promise.reject(new Error("SELF_IDENTITY_AMBIGUOUS：同名 6 个 ID")),
    )

    const status = await service.startLogin("dingtalk", "loopback")
    expect(status.state).toBe("authorized")
  })

  /**
   * ★ 身份**歧义**是预期分支，不是失败 —— 登录成功、且 `startLogin` 不抛。
   *
   * 同名多 ID 时 `resolveSelf` 抛 `SELF_IDENTITY_AMBIGUOUS`（AppError）。
   * 这时**不能**替用户猜一个，得让他在 onboarding / 状态页自己确认。
   * 关键不变式：这条分支下授权仍算成功（用户已经登录上了），
   * 而"未确认"这个状态由 `confirmed_at` 仍为 null → 快照 `selfConfirmed=false`
   * 表达，UI 据此就地给确认入口。这里锁住"歧义不把登录带崩"这一条。
   *
   * 曾经它和普通异常一样被降级成 `warn` 吞掉，外观与"正常授权"完全相同 ——
   * 于是 onboarding 照常打勾、蒸馏静默拒掉全部语料。
   */
  it("身份歧义（SELF_IDENTITY_AMBIGUOUS）时登录仍成功且不抛", async () => {
    const service = makeService(
      () => Promise.resolve(AUTHORIZED),
      () =>
        Promise.reject(
          new AppError("SELF_IDENTITY_AMBIGUOUS", "按 userId 精确匹配到 6 条记录（期望 1 条）"),
        ),
    )

    const status = await service.startLogin("dingtalk", "loopback")
    expect(status.state).toBe("authorized")
  })

  it("没接回调时照常工作（飞书那种只有契约桩的渠道）", async () => {
    const service = makeService(() => Promise.resolve(AUTHORIZED))
    const status = await service.startLogin("dingtalk", "loopback")
    expect(status.state).toBe("authorized")
  })

  /**
   * 回调是 `await` 的 —— 登录返回时身份**已经**落库了。
   *
   * 不 await 的话渲染层收到 authorized 就去读身份，而那时解析可能还没跑完
   * → 读到空 → 界面显示"未确认身份"，而一秒后它其实好了。
   * 那种"刷新一下就好了"的界面状态是最难归因的一类。
   */
  it("回调被 await（登录返回时身份已经落库）", async () => {
    const order: string[] = []
    const service = makeService(
      () => Promise.resolve(AUTHORIZED),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push("身份落库")
      },
    )

    await service.startLogin("dingtalk", "loopback")
    order.push("登录返回")
    expect(order).toEqual(["身份落库", "登录返回"])
  })
})

describe("★ 进度事件仍然照发（回调不该挡住它）", () => {
  it("授权过程中的 progress 一条不少", async () => {
    const phases: string[] = []
    const service = new ChannelService({
      host: new ChannelHost(
        createRegistry([
          fakePlugin((ctx) => {
            ctx.onProgress?.({ phase: "starting" })
            ctx.onProgress?.({ phase: "awaiting-scan" })
            return Promise.resolve(AUTHORIZED)
          }),
        ]),
      ),
      logger,
      getWindow: () =>
        ({
          isDestroyed: () => false,
          webContents: {
            send: (_channel: string, payload: { progress: { phase: string } }) => {
              phases.push(payload.progress.phase)
            },
          },
        }) as never,
      onAuthorized: () => Promise.resolve(),
    })

    await service.startLogin("dingtalk", "loopback")
    expect(phases).toEqual(["starting", "awaiting-scan"])
  })
})

/**
 * ★★ 授权后刷新账号头像/显示名 —— 与"身份解析成不成功"**解耦**。
 *
 * ## 这组门禁锁的是一个真实故障
 *
 * 症状：用户在应用里点「重新授权」换了组织，界面上的头像还是首字母兜底、
 * 显示名是空的。
 *
 * 根因：`applyPostAuthIdentity` 原来是一条直线 —— `resolveSelf()` 裸调在最
 * 前面，取头像那段在它后面。于是 `resolveSelf` 一抛异常（重新授权到另一个
 * 组织时身份守卫抛 `SELF_IDENTITY_CONFLICT`），**整个函数体连同取头像一起
 * 消失**，由 `ChannelService` 那层统一 catch 成一条 warn。
 *
 * 本机日志实证（2026-08-05 03:08，连着两次授权）：只有两条关于身份的 warn，
 * 一条 `self avatar fetched` 都没有；而库里 `contact_avatars` 那张图明明取到了
 * （另一次触发写的），账号表的 `avatar_url` / `display_name` 全程 NULL。
 *
 * 之所以必须有门禁：这个故障**外观完全正常** —— 授权成功、onboarding 打勾、
 * 日志里只有一条看起来无关的身份 warn。回归时不会有人发现。
 */
describe("★★ 身份解析失败**不能**吃掉头像/显示名的刷新", () => {
  /** 记录假依赖被怎么调的 */
  interface Spy {
    avatarCalls: { force?: boolean | undefined }[]
    profileCalls: { displayName?: string | undefined; avatarUrl?: string | undefined }[]
    clearBlockedCalls: number
  }

  /**
   * 造一套假依赖。
   *
   * `resolveSelf` 的行为由参数决定 —— 这组测试的全部重点就是
   * "第一段怎么失败，第二段还得跑"。
   */
  function makeDeps(
    resolveSelf: () => Promise<{
      confirmed: boolean
      openIds: readonly unknown[]
      matchedMessageCount: number
    }>,
    avatarPath: string | null = "/tmp/self.jpg",
  ): { deps: PostAuthDeps; spy: Spy } {
    const spy: Spy = { avatarCalls: [], profileCalls: [], clearBlockedCalls: 0 }
    return {
      spy,
      deps: {
        dataPlane: {
          resolveSelf,
          confirmSelf: () => ({ backfilled: 0, mentionsBackfilled: 0 }),
          clearBlocked: () => {
            spy.clearBlockedCalls += 1
          },
        },
        media: {
          selfAvatar: (options = {}) => {
            spy.avatarCalls.push(options)
            return Promise.resolve({
              path: avatarPath,
              reason: avatarPath === null ? "not_set" : null,
            })
          },
        },
        auth: {
          applyChannelProfile: (incoming) => {
            spy.profileCalls.push(incoming)
            return { displayNameWritten: true, avatarWritten: incoming.avatarUrl !== undefined }
          },
        },
        logger,
        toFileUrl: (path) => `mycontext-file://local${path}`,
      },
    }
  }

  /**
   * ★ 这一条就是那个 bug 的回归锁。
   *
   * `SELF_IDENTITY_CONFLICT` = 重新授权到了另一个组织/工号（身份守卫 fail-closed）。
   * 那时身份表**不会**被覆盖（刻意的，见 `SelfIdentityRepository.upsert`），
   * 但头像与显示名照样该刷新 —— 它们是账号级字段，与"库里躺着谁的语料"无关。
   */
  it("resolveSelf 抛 SELF_IDENTITY_CONFLICT 时，头像与显示名仍然刷新", async () => {
    const { deps, spy } = makeDeps(() =>
      Promise.reject(new AppError("SELF_IDENTITY_CONFLICT", "这个账号已绑定另一个身份")),
    )

    await applyPostAuthIdentity(deps, AUTHORIZED)

    expect(spy.avatarCalls).toHaveLength(1)
    expect(spy.profileCalls).toEqual([
      { displayName: "测试用户", avatarUrl: "mycontext-file://local/tmp/self.jpg" },
    ])
  })

  /** 同名多 ID（歧义）同理 —— 也是"要用户处理"，不该连带吃掉头像。 */
  it("resolveSelf 抛 SELF_IDENTITY_AMBIGUOUS 时，头像与显示名仍然刷新", async () => {
    const { deps, spy } = makeDeps(() =>
      Promise.reject(new AppError("SELF_IDENTITY_AMBIGUOUS", "匹配到 6 条记录")),
    )

    await applyPostAuthIdentity(deps, AUTHORIZED)

    expect(spy.profileCalls).toHaveLength(1)
  })

  /** 非 AppError（网络挂了、CLI 崩了）也不该阻断第二段。 */
  it("resolveSelf 抛普通异常时，头像与显示名仍然刷新", async () => {
    const { deps, spy } = makeDeps(() => Promise.reject(new Error("ECONNRESET")))

    await applyPostAuthIdentity(deps, AUTHORIZED)

    expect(spy.profileCalls).toHaveLength(1)
  })

  /**
   * ★ 头像取不到时**仍然**写显示名 —— 两个字段独立。
   *
   * 原来只传头像，所以"没设头像"会顺带让显示名也永远是 NULL。
   */
  it("头像取不到时仍然写显示名（不带 avatarUrl）", async () => {
    const { deps, spy } = makeDeps(
      () => Promise.resolve({ confirmed: true, openIds: [], matchedMessageCount: 0 }),
      null,
    )

    await applyPostAuthIdentity(deps, AUTHORIZED)

    expect(spy.profileCalls).toEqual([{ displayName: "测试用户" }])
  })

  /**
   * ★ 显示名用的是 dws 给的**实名**（`status.userName`），不是渠道花名。
   *
   * 账号级身份（登录页、账号切换器）该显示实名；花名留在
   * `channel_self_identity.display_names_json` 给连接卡片用。
   */
  it("显示名取 status.userName（dws 的实名）", async () => {
    const { deps, spy } = makeDeps(() =>
      Promise.resolve({ confirmed: false, openIds: ["o1"], matchedMessageCount: 12 }),
    )

    await applyPostAuthIdentity(deps, { ...AUTHORIZED, userName: "林知白" })

    expect(spy.profileCalls[0]?.displayName).toBe("林知白")
  })

  /**
   * ★ 取头像必须 `force` —— 缓存对已取到的头像永不过期。
   *
   * 不 force 的话：首次授权取到一张图，用户在钉钉换了头像、回来点「重新授权」，
   * 看到的还是旧图。而"重新授权"恰恰是头像可能变了的时刻。
   */
  it("取头像时带 force（否则重新授权拿到的是缓存里那张旧图）", async () => {
    const { deps, spy } = makeDeps(() =>
      Promise.resolve({ confirmed: true, openIds: [], matchedMessageCount: 0 }),
    )

    await applyPostAuthIdentity(deps, AUTHORIZED)

    expect(spy.avatarCalls[0]?.force).toBe(true)
  })

  /** 第二段自己抛也不该让整个回调抛（授权已经成功了）。 */
  it("刷新账号信息抛错时整个回调不抛", async () => {
    const { deps } = makeDeps(() =>
      Promise.resolve({ confirmed: true, openIds: [], matchedMessageCount: 0 }),
    )
    const failing: PostAuthDeps = {
      ...deps,
      media: { selfAvatar: () => Promise.reject(new Error("dws 超时")) },
    }

    await expect(applyPostAuthIdentity(failing, AUTHORIZED)).resolves.toBeUndefined()
  })

  /** 已确认过就不重复 confirm（重复 confirm 会再扫一遍全表回填）。 */
  it("已确认的身份不重复 confirm，但头像照样刷新", async () => {
    let confirmed = 0
    const { deps, spy } = makeDeps(() =>
      Promise.resolve({ confirmed: true, openIds: [], matchedMessageCount: 0 }),
    )
    const counting: PostAuthDeps = {
      ...deps,
      dataPlane: {
        ...deps.dataPlane,
        confirmSelf: () => {
          confirmed += 1
          return { backfilled: 0, mentionsBackfilled: 0 }
        },
      },
    }

    await applyPostAuthIdentity(counting, AUTHORIZED)

    expect(confirmed).toBe(0)
    expect(spy.profileCalls).toHaveLength(1)
  })

  /**
   * ★★ 授权成功必须解除采集的 blocked 终态。
   *
   * ## 这条锁的是第三个真实故障
   *
   * 采集撞 `SESSION_EXPIRED` 后进入终态、不再自动重试（那是对的）。而解除它的
   * `clearBlocked()` 原来**唯一**的调用方是状态页那个「知道了」按钮 ——
   * 于是"登录过期 → 用户去重新授权 → 采集仍然 blocked"，用户做了对的事
   * 系统不认。onboarding 里没有那个按钮，所以在引导流程里这是个死结。
   *
   * 实测（本机 2026-08-05）：07:24:28 采集因登录过期 blocked，07:25:00 授权成功，
   * 之后 ingest 一条日志都没有 —— vault 里 0 条消息，而引导页显示"采集完成"。
   */
  it("★ 授权成功后解除采集的 blocked 终态", async () => {
    const { deps, spy } = makeDeps(() =>
      Promise.resolve({ confirmed: true, openIds: [], matchedMessageCount: 0 }),
    )

    await applyPostAuthIdentity(deps, AUTHORIZED)

    expect(spy.clearBlockedCalls).toBe(1)
  })

  /**
   * ★★ 即使身份解析抛错也要解除 —— 这才是最需要它的场景。
   *
   * 「登录过期」本身常常就伴随身份解析失败（拿不到凭据、或换了组织撞
   * `SELF_IDENTITY_CONFLICT`）。如果解除动作被放在身份那段之后、或包在
   * 同一个 try 里，那么恰恰在"采集 blocked 且身份也有问题"这个最糟的组合下
   * 它不会执行 —— 而用户已经重新授权成功了。
   */
  it("★ 身份解析抛错时**仍然**解除 blocked", async () => {
    const { deps, spy } = makeDeps(() =>
      Promise.reject(new AppError("SELF_IDENTITY_CONFLICT", "这个账号已绑定另一个身份")),
    )

    await applyPostAuthIdentity(deps, AUTHORIZED)

    expect(spy.clearBlockedCalls).toBe(1)
  })
})

/**
 * ★★ 采纳本机已有的登录态 —— `onAuthorized` 到不了的那条路。
 *
 * ## 这组门禁锁的是第二个真实故障
 *
 * 症状：新注册一个应用账号，**进来就是"已连接钉钉"**，但头像和显示名都是空的。
 *
 * 根因：dws 的 token 按**系统用户**存（密钥在 macOS Keychain，
 * `DWS_CONFIG_DIR` 隔离不了它 —— 见 `plugins/dingtalk/auth.ts` 文件头）。
 * 于是新账号一进来 `auth.status()` 就返回 authorized（那是上一个账号留下的
 * 登录态）→ 用户没有任何理由去点「重新授权」→ **`onAuthorized` 从不触发**。
 *
 * 本机实证（2026-08-05 04:14 注册的账号）：`accounts` 的 display_name /
 * avatar_url 全 NULL、vault 的 `channel_self_identity` 一行都没有，
 * 而 `messages` 已经 49 条 —— 采集不依赖身份所以照常跑，但 `is_self` 全 NULL，
 * 蒸馏会拒掉**全部**语料而进度页显示"完成"。
 *
 * ## ★ 这是**用户显式触发**的，不是登录后自动跑
 *
 * 首版自动跑，两个真问题：它替用户选定了身份（之后他真去换组织时反被
 * 身份守卫拦住 —— 冲突是自动补跑自己制造的），且在用户没操作时就 spawn
 * 2-3 次子进程。所以现在检测（`describeAdoptableSession`，纯读）与执行
 * （`adoptExistingSession`）分开，界面上给按钮。
 *
 * 与上一组的区别：上一组测"授权时第一段失败别拖累第二段"，
 * 这一组测"没触发授权回调时，用户点了采纳要能把身份补上"。
 */
describe("★★ 采纳本机已有的登录态", () => {
  interface BackfillSpy {
    resolveCalls: number
    statusCalls: number
    profileCalls: number
    clearBlockedCalls: number
  }

  /**
   * 造一套假依赖。
   *
   * `identityRow` = `readSelfIdentity()` 的返回：null 表示"这个账号还没有
   * 身份行"，那正是要补跑的条件。
   */
  function makeBackfillDeps(
    identityRow: { channelId: string } | null,
    status: AuthStatus,
  ): {
    deps: Parameters<typeof adoptExistingSession>[0]
    spy: BackfillSpy
  } {
    const spy: BackfillSpy = {
      resolveCalls: 0,
      statusCalls: 0,
      profileCalls: 0,
      clearBlockedCalls: 0,
    }
    /**
     * ★ 身份行是**可变**的：`resolveSelf` 成功之后它就存在了。
     *
     * 原来这个桩是个常量 null，于是它表达不了"落库成功"这件事 ——
     * 而 `adoptExistingSession` 现在正是**重读这一行**来判断到底成没成
     * （不再"跑完没抛就报成功"，见那里的注释）。
     *
     * 用真实语义建模：一开始是入参给的那个值，resolveSelf 跑成功后变成有行。
     */
    let row = identityRow
    return {
      spy,
      deps: {
        dataPlane: {
          resolveSelf: () => {
            spy.resolveCalls += 1
            // 真实行为：resolveSelf 内部 upsert 身份行
            row = { channelId: "dingtalk" }
            return Promise.resolve({ confirmed: false, openIds: ["o1"], matchedMessageCount: 3 })
          },
          confirmSelf: () => ({ backfilled: 3, mentionsBackfilled: 0 }),
          clearBlocked: () => {
            spy.clearBlockedCalls += 1
          },
        },
        media: { selfAvatar: () => Promise.resolve({ path: "/tmp/a.jpg", reason: null }) },
        auth: {
          applyChannelProfile: () => {
            spy.profileCalls += 1
            return { displayNameWritten: true, avatarWritten: true }
          },
        },
        logger,
        toFileUrl: (path) => `mycontext-file://local${path}`,
        readSelfIdentity: () => row,
        channelStatus: () => {
          spy.statusCalls += 1
          return Promise.resolve(status)
        },
      },
    }
  }

  /**
   * ★ 这一条就是那个 bug 的回归锁：没有身份行 + 渠道已授权 → 采纳要真的落库。
   */
  it("缺身份行且渠道已授权 → 采纳（写身份 + 头像 + 显示名）", async () => {
    const { deps, spy } = makeBackfillDeps(null, AUTHORIZED)

    const ran = await adoptExistingSession(deps)

    expect(ran).toBe(true)
    expect(spy.resolveCalls).toBe(1)
    expect(spy.profileCalls).toBe(1)
  })

  /**
   * ★ 幂等门：已经有身份行就**不采纳**。
   *
   * 即使这是用户点出来的也要判 —— 界面可能是过期的（他在另一个窗口已经
   * 授权过了），而重复落身份会触发一次全表回填扫描。而且它必须
   * **连渠道状态都不查**（那也是一次子进程调用）。
   */
  it("已有身份行 → 不采纳，且连渠道状态都不查", async () => {
    const { deps, spy } = makeBackfillDeps({ channelId: "dingtalk" }, AUTHORIZED)

    const ran = await adoptExistingSession(deps)

    expect(ran).toBe(false)
    expect(spy.statusCalls).toBe(0)
    expect(spy.resolveCalls).toBe(0)
  })

  /** 未授权 → 没有可采纳的东西（界面上那个入口也不该出现）。 */
  it("缺身份行但渠道未授权 → 不采纳", async () => {
    const { deps, spy } = makeBackfillDeps(null, { state: "unauthorized" })

    const ran = await adoptExistingSession(deps)

    expect(ran).toBe(false)
    expect(spy.resolveCalls).toBe(0)
  })

  /** 登录态过期同理：那要用户重新扫码，采纳帮不上。 */
  it("渠道登录态已过期 → 不采纳", async () => {
    const { deps, spy } = makeBackfillDeps(null, { state: "expired", corpName: "测试企业" })

    const ran = await adoptExistingSession(deps)

    expect(ran).toBe(false)
    expect(spy.resolveCalls).toBe(0)
  })

  /**
   * ★ 采纳内部失败**不能**抛给调用方，但要**如实返回 false**。
   *
   * 不抛的理由不变：身份解析失败是预期内的（同名多 ID、换了组织都会抛），
   * 而这是个 IPC handler 背后的动作 —— 抛出去只会变成一个界面上的红字，
   * 而头像那段其实可能已经成功了。
   *
   * ★★ 但原来这里断言的是 `resolves.toBe(true)` —— 那把「点了没反应」
   * 这个 bug 当成契约锁住了：解析失败、身份行没落下来，却报告成功。
   * 实测症状就是「用这个身份」按钮点下去乐观更新一闪、刷新后原样，
   * 而日志里只有一条 warn。
   *
   * 现在判据是"身份行真的在了吗"（见 `adoptExistingSession` 的注释），
   * 所以失败路径返回 false，界面据此能继续提示而不是假装成功。
   */
  it("★★ 采纳内部抛错 → 不往外抛，但如实返回 false（不能假装成功）", async () => {
    const { deps } = makeBackfillDeps(null, AUTHORIZED)
    const failing = {
      ...deps,
      dataPlane: {
        ...deps.dataPlane,
        // 失败 → 身份行不会被写出来（桩里那次赋值不发生）
        resolveSelf: () => Promise.reject(new AppError("SELF_IDENTITY_CONFLICT", "换了身份")),
      },
    }

    await expect(adoptExistingSession(failing)).resolves.toBe(false)
  })

  /**
   * ★★ 检测与执行必须**分开** —— 这是这次改动的核心不变式。
   *
   * `describeAdoptableSession` 是界面渲染时调的，它绝不能触发身份解析或
   * 取头像（那会 spawn 子进程）。首版把两件事合在一起自动跑，于是用户
   * 一注册就有几秒的后台渠道调用，还被替他选定了身份。
   */
  it("★ describeAdoptableSession 只查询，绝不触发解析或取头像", async () => {
    const { deps, spy } = makeBackfillDeps(null, AUTHORIZED)

    const info = await describeAdoptableSession({
      readSelfIdentity: deps.readSelfIdentity,
      channelStatus: deps.channelStatus,
    })

    expect(info).toEqual({ corpName: "测试企业", userName: "测试用户" })
    // 这两个为 0 就是"没碰渠道解析、没取头像"
    expect(spy.resolveCalls).toBe(0)
    expect(spy.profileCalls).toBe(0)
  })

  it("已有身份行时没有可采纳的（界面不显示那个入口）", async () => {
    const { deps } = makeBackfillDeps({ channelId: "dingtalk" }, AUTHORIZED)

    const info = await describeAdoptableSession({
      readSelfIdentity: deps.readSelfIdentity,
      channelStatus: deps.channelStatus,
    })

    expect(info).toBeNull()
  })

  it("渠道未授权时没有可采纳的", async () => {
    const { deps } = makeBackfillDeps(null, { state: "unauthorized" })

    const info = await describeAdoptableSession({
      readSelfIdentity: deps.readSelfIdentity,
      channelStatus: deps.channelStatus,
    })

    expect(info).toBeNull()
  })
})
