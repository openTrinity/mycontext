/**
 * 授权后的**身份路由** —— 这一组锁的是截图里那条红字的正解。
 *
 * ## 原来为什么会报错
 *
 * 换组织重新授权 → `SelfIdentityRepository.upsert` 发现 `(corpId, userId)`
 * 与库里那行不一致 → 抛 `SELF_IDENTITY_CONFLICT` → 界面只能说
 * "换身份请新建一个账号"。那道守卫本身是对的（挡的是"两个人的语料混进
 * 同一份画像"，不可逆），但它把渠道的身份问题推给了登录体系。
 *
 * 现在在守卫**之前**先分流到该身份自己的 vault。这一组就锁那个分流：
 * 三条分支 + 一条顺序（路由必须在 upsert 之前）。
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "@mycontext/kernel"
import type { AuthStatus } from "@mycontext/channels"
import { routeAuthorizedIdentity } from "@main/bootstrap/post-auth-identity.js"

const logger = createLogger("test-routing", { level: "error" })

const ACCOUNT = "acct-1"
const BASE_VAULT = "vault-base"
/** ★ 值全是编的（CLAUDE.md §1.2）。corpId 形态 ding+hex，userId 是数字串。 */
const CORP_A = "dingFAKECORP0001"
const CORP_B = "dingFAKECORP0002"
const USER_A = "100001"
const USER_B = "200002"

function authorized(corpId: string, userId: string, corpName = "组织甲") {
  return {
    state: "authorized",
    corpId,
    corpName,
    userId,
    userName: "张三",
    accessExpiresAt: "2026-08-06T17:00:00+08:00",
    refreshExpiresAt: "2026-09-05T15:00:00+08:00",
    daysUntilRefreshExpiry: 30,
  } satisfies Extract<AuthStatus, { state: "authorized" }>
}

/**
 * 假身份服务：记录 bindAuthorized / switchTo 的调用，便于断言分支与顺序。
 *
 * 用假的而不是真 `ActiveIdentityService`：那个已经有自己的 20 条单测，
 * 这一组要验的是**编排**（谁在谁之前、参数怎么传），
 * 真实现会把"路由错了"与"绑定逻辑错了"混成一个红。
 */
function fakeIdentity(
  options: {
    current?: { corpId: string; userId: string; vaultId: string } | null
    bindResult?: { vaultId: string; created: boolean }
  } = {},
) {
  const calls = { bind: [] as unknown[], switch: [] as unknown[] }
  return {
    calls,
    currentIdentity: () => options.current ?? null,
    bindAuthorized: (input: unknown) => {
      calls.bind.push(input)
      return options.bindResult ?? { vaultId: "vault-new", created: true }
    },
    switchTo: (key: unknown) => {
      calls.switch.push(key)
      return Promise.resolve(undefined)
    },
  }
}

const session = { accountId: ACCOUNT, baseVaultId: BASE_VAULT }

describe("★★ 换组织重新授权 → 切到那个身份的 vault（不再报错）", () => {
  it("授权到一个与当前不同的身份 → 真的切过去了", async () => {
    const identity = fakeIdentity({
      current: { corpId: CORP_A, userId: USER_A, vaultId: "vault-a" },
      bindResult: { vaultId: "vault-b", created: true },
    })
    const switched = await routeAuthorizedIdentity({
      identity,
      logger,
      session,
      newVaultId: () => "vault-b",
      channelId: "dingtalk",
      status: authorized(CORP_B, USER_B, "组织乙"),
    })

    expect(switched).toBe(true)
    expect(identity.calls.switch).toEqual([
      { accountId: ACCOUNT, channelId: "dingtalk", corpId: CORP_B, userId: USER_B },
    ])
  })

  /**
   * ★ 身份键是 `corpId + userId` 的组合。
   *
   * `userId` 只在**企业内**唯一（同一个人在两家企业下是两个不同的 userId），
   * 所以单独拿它寻址会在多组织下撞车。这也是渠道 CLI 自己多账号体系的主键。
   */
  it("★ 绑定用的键是 (accountId, channelId, corpId, userId) 四元组", async () => {
    const identity = fakeIdentity()
    await routeAuthorizedIdentity({
      identity,
      logger,
      session,
      newVaultId: () => "vault-x",
      channelId: "dingtalk",
      status: authorized(CORP_A, USER_A),
    })
    expect(identity.calls.bind[0]).toMatchObject({
      key: { accountId: ACCOUNT, channelId: "dingtalk", corpId: CORP_A, userId: USER_A },
      baseVaultId: BASE_VAULT,
    })
  })

  /**
   * ★★ 重新授权到**同一个**身份是 no-op。
   *
   * "凭证快过期了点一下重新授权"是最常见的路径。那时切一次 vault 等于白付
   * 一次几十秒的卸载+挂载，还会打断在跑的采集 —— 而用户什么都没换。
   */
  it("★★ 重新授权到当前身份 → 不切（不白付一次卸载+挂载）", async () => {
    const identity = fakeIdentity({
      current: { corpId: CORP_A, userId: USER_A, vaultId: "vault-a" },
      bindResult: { vaultId: "vault-a", created: false },
    })
    const switched = await routeAuthorizedIdentity({
      identity,
      logger,
      session,
      newVaultId: () => "should-not-be-used",
      channelId: "dingtalk",
      status: authorized(CORP_A, USER_A),
    })

    expect(switched).toBe(false)
    expect(identity.calls.switch).toEqual([])
    // ★ 但**仍然** bind 了一次 —— 那是在刷新显示名与 last_used
    expect(identity.calls.bind).toHaveLength(1)
  })

  /**
   * ★ 同组织的另一个人也要切。
   *
   * 只比 corpId 的话这条会被当成"同一个身份"—— 而那意味着两个人的会话
   * 进同一个库，也就是画像被污染。userId 才是企业内的判据。
   */
  it("★ 同组织不同人 → 也要切（userId 才是企业内的判据）", async () => {
    const identity = fakeIdentity({
      current: { corpId: CORP_A, userId: USER_A, vaultId: "vault-a" },
      bindResult: { vaultId: "vault-a2", created: true },
    })
    const switched = await routeAuthorizedIdentity({
      identity,
      logger,
      session,
      newVaultId: () => "vault-a2",
      channelId: "dingtalk",
      status: authorized(CORP_A, USER_B),
    })
    expect(switched).toBe(true)
  })
})

describe("首次授权（还没有任何身份）", () => {
  /**
   * ★ 当前没有身份 → 按 `bindAuthorized` 给的 vault 走。
   *
   * 那个方法会在"账号一个身份都没绑过"时返回**基础 vault**
   * （因为那个库里可能已经有采集数据了 —— 共享登录态下采集不依赖身份行，
   * 实测过 messages 有 49 条而身份表 0 行；新建会把它孤立掉）。
   */
  it("当前无身份 → 绑定并切过去", async () => {
    const identity = fakeIdentity({
      current: null,
      bindResult: { vaultId: BASE_VAULT, created: false },
    })
    const switched = await routeAuthorizedIdentity({
      identity,
      logger,
      session,
      newVaultId: () => "unused",
      channelId: "dingtalk",
      status: authorized(CORP_A, USER_A),
    })
    expect(switched).toBe(true)
    expect(identity.calls.switch).toHaveLength(1)
  })
})

describe("未登录时授权", () => {
  /**
   * ★ 未登录也能走授权流程（那是"还没有身份"时唯一能做的事），
   * 但那时没有账号、也就没有 vault 可绑 —— 必须**安静地跳过**而不是抛。
   *
   * 抛的话授权会被上层记成失败，而用户其实已经扫码成功了。
   */
  it("没有 session → 不绑不切，也不抛", async () => {
    const identity = fakeIdentity()
    const switched = await routeAuthorizedIdentity({
      identity,
      logger,
      session: null,
      newVaultId: () => "unused",
      channelId: "dingtalk",
      status: authorized(CORP_A, USER_A),
    })
    expect(switched).toBe(false)
    expect(identity.calls.bind).toEqual([])
    expect(identity.calls.switch).toEqual([])
  })
})
