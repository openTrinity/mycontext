/**
 * `ActiveIdentityService`：当前生效的渠道身份，与切换它。
 *
 * ## 这一组锁的是三件容易静默坏掉的事
 *
 * ① **切身份时挂载真的被 await 了**。挂载里有"等图谱服务让出端口"与
 *    "等在途采集收尾"两件必须等的事 —— fire-and-forget 的话新旧两套会重叠。
 * ② **身份的内存态在挂载完成之后才改**。卸载阶段要用**旧**身份去退订事件
 *    （`event stop --all --profile <旧>`），先改就会退订错人，而那条路径
 *    整段吞异常 —— 停错了不会有任何痕迹。
 * ③ **授权路由的三个分支**（已绑过 / 一个都没绑 / 已有别的身份）。
 *    这三条就是"重新授权换组织不再报错"的全部实现。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLogger } from "@mycontext/kernel"
import {
  ChannelIdentityVaultRepository,
  openStore,
  SettingsRepository,
  type StoreHandle,
} from "@mycontext/store"
import { ActiveIdentityService, toChannelProfile } from "@main/services/active-identity.service.js"

const logger = createLogger("test-identity", { level: "error" })
const NOW = new Date("2026-08-06T10:00:00.000Z")

const ACCOUNT = "acct-1"
const BASE_VAULT = "vault-base"
/** ★ 值全是编的（CLAUDE.md §1.2）。形态照真实：corpId 是 ding+32hex，userId 是数字串。 */
const CORP_A = "dingFAKECORP0001"
const CORP_B = "dingFAKECORP0002"
const USER_A = "100001"
const USER_B = "200002"

let dir: string
let store: StoreHandle
let identities: ChannelIdentityVaultRepository
/** 每次 mount 记一条，用来断言顺序与次数。 */
let mounted: string[]

function keyOf(corpId: string, userId: string) {
  return { accountId: ACCOUNT, channelId: "dingtalk", corpId, userId }
}

function makeService(options: { mount?: (vaultId: string) => Promise<void> } = {}) {
  return new ActiveIdentityService({
    identities,
    settings: new SettingsRepository(store.db),
    logger,
    now: () => NOW,
    mount:
      options.mount ??
      ((vaultId) => {
        mounted.push(vaultId)
        return Promise.resolve()
      }),
  })
}

function bind(corpId: string, userId: string, vaultId: string, corpName = "组织甲") {
  identities.bind({
    ...keyOf(corpId, userId),
    vaultId,
    corpName,
    userName: "张三",
    at: NOW.toISOString(),
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mycontext-active-identity-"))
  store = openStore({ path: join(dir, "control.sqlite") })
  identities = new ChannelIdentityVaultRepository(store.db)
  mounted = []
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("钉给渠道命令的 profile", () => {
  /**
   * ★★ 形态是**裸 corpId** —— 而这条断言原来锁的是 `corpId:userId`，是错的。
   *
   * 原来的理由写着"`userId` 只在企业内唯一，单独拿 corpId 寻址会撞车"，
   * 听起来成立，但**没对着 CLI 验过**。重新实测（三次一致，且在全新 seed
   * 的临时目录上复现）：
   *
   * ```
   * --profile <corpId>:<userId>  → authenticated=false「未登录」
   * --profile <corpId>           → authenticated=true，正常返回
   * ```
   *
   * 换真业务命令（`contact user get-self`）结论相同：带冒号那种直接
   * `code=2 category=auth`，裸 corpId 正常返回员工信息。
   *
   * ★ 不会撞车的原因是**配置目录本身已经是隔离边界**：
   * `seedChannelProfile` 保证一个 vault 的 dws-home 里只有当前身份那一条
   * profile（它的 `matchesSeed` 要求 `entries.length === 1`），
   * 所以 corpId 在这个目录里唯一定位一条。`userId` 仍在隔离键里 ——
   * 那是我们区分身份用的，与 CLI 寻址是两件事。
   *
   * ★★ 这个错为什么值得一条断言：带冒号那种被上游归类成 `auth` 错误，
   * 于是界面显示「授权已失效，请重新扫码」—— 而真因是一行字符串拼接。
   * 症状把人指向完全无关的方向（查授权、查 token），扫一百次码也不会好。
   */
  it("★★ 形态是裸 corpId（带 userId 的冒号形态实测「未登录」）", () => {
    expect(toChannelProfile({ corpId: CORP_A, userId: USER_A })).toBe(CORP_A)
  })

  /** ★ 反面：绝不能出现冒号 —— 那正是那个 bug 的形状。 */
  it("★ 不含冒号", () => {
    expect(toChannelProfile({ corpId: CORP_A, userId: USER_A })).not.toContain(":")
  })

  it("未绑身份时给 undefined（不钉，退回 CLI 全局 profile）", () => {
    expect(makeService().currentProfile()).toBeUndefined()
  })

  it("绑了之后给出该身份的 profile", () => {
    bind(CORP_A, USER_A, "vault-a")
    const service = makeService()
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })
    expect(service.currentProfile()).toBe(CORP_A)
  })
})

describe("登录时挑哪个 vault", () => {
  it("还没绑任何身份 → 退回账号的基础 vault（onboarding 要往那个库写）", () => {
    const service = makeService()
    expect(
      service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT }).vaultId,
    ).toBe(BASE_VAULT)
    expect(service.currentIdentity()).toBeNull()
  })

  it("绑过一个 → 用它的 vault", () => {
    bind(CORP_A, USER_A, "vault-a")
    expect(
      makeService().resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT }).vaultId,
    ).toBe("vault-a")
  })

  /**
   * ★ 记住"上次用的那个"：有两个身份时不能每次登录都跳回最近绑定的那个
   * —— 用户会以为自己的数据丢了。
   */
  it("记住上次用的那个（跨进程：settings 里读回来）", async () => {
    bind(CORP_A, USER_A, "vault-a")
    bind(CORP_B, USER_B, "vault-b", "组织乙")

    const first = makeService()
    first.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })
    await first.switchTo(keyOf(CORP_B, USER_B))

    // 新实例 = 模拟重启
    const second = makeService()
    expect(second.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT }).vaultId).toBe(
      "vault-b",
    )
  })

  /**
   * ★ 记的那个身份被解绑之后不能卡住登录 —— 退到"最近用过的"。
   * 不处理的话每次登录都查一次不存在的身份，然后落到基础 vault
   * （那个库可能是空的）—— 表现就是"我的数据全没了"。
   */
  it("记的身份已被解绑 → 退到最近用过的，而不是卡在基础 vault", () => {
    bind(CORP_A, USER_A, "vault-a")
    const first = makeService()
    first.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })
    identities.unbind(keyOf(CORP_A, USER_A))
    bind(CORP_B, USER_B, "vault-b", "组织乙")

    expect(
      makeService().resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT }).vaultId,
    ).toBe("vault-b")
  })

  it("别的账号记的身份不影响这个账号", () => {
    bind(CORP_A, USER_A, "vault-a")
    const first = makeService()
    first.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })
    // 换个账号登录 → 它没有任何身份，该走基础 vault
    expect(
      makeService().resolveOnLogin({ accountId: "acct-2", fallbackVaultId: "vault-other-base" })
        .vaultId,
    ).toBe("vault-other-base")
  })
})

describe("切身份", () => {
  it("挂载被调用，且切完 profile 跟着变", async () => {
    bind(CORP_A, USER_A, "vault-a")
    bind(CORP_B, USER_B, "vault-b", "组织乙")
    const service = makeService()
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })

    await service.switchTo(keyOf(CORP_B, USER_B))
    expect(mounted).toEqual(["vault-b"])
    expect(service.currentProfile()).toBe(CORP_B)
  })

  /**
   * ★★ 身份的内存态必须在**挂载完成之后**才改。
   *
   * 卸载阶段（在 `mount` 里面）要用**旧**身份去退订事件：
   * `dws event stop --all --profile <旧>`。先改的话那条命令会带上**新**身份
   * 的 profile —— 也就是去停另一个身份的订阅（甚至是用户自己终端里正在用的
   * 那个）。而 `unsubscribeAll` 整段吞异常（退出路径不该抛），
   * 所以停错了人**不会有任何痕迹**。
   *
   * 断言方式：在 mount 回调里（= 卸载正在跑的那一刻）读 `currentProfile()`，
   * 它必须还是旧的。
   */
  it("★★ mount 期间 currentProfile 仍是**旧**身份（否则会退订错身份）", async () => {
    bind(CORP_A, USER_A, "vault-a")
    bind(CORP_B, USER_B, "vault-b", "组织乙")
    let seenDuringMount: string | undefined
    const service: ActiveIdentityService = makeService({
      mount: (vaultId) => {
        mounted.push(vaultId)
        seenDuringMount = service.currentProfile()
        return Promise.resolve()
      },
    })
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })

    await service.switchTo(keyOf(CORP_B, USER_B))
    expect(seenDuringMount).toBe(CORP_A)
    // 切完才是新的
    expect(service.currentProfile()).toBe(CORP_B)
  })

  /**
   * ★★★ 但 mount **收到的**身份必须是**新**的 —— 这两件事同时成立。
   *
   * ## 上面那条与这条不矛盾，它们说的是不同的东西
   *
   * · 内存态（`currentProfile()`）在 mount 期间仍是旧的 —— 卸载阶段要用它
   *   去退订，改早了会"退订错身份"（上面那条锁的就是这个）；
   * · 而 mount 的**参数**必须是目标身份 —— 它要把新 vault 的渠道配置目录
   *   seed 成这个 vault 的主人。
   *
   * ## 为什么必须锁住（这是一个真实的越权读取面）
   *
   * 修复前 `startup.ts` 的 `mountVault` 在内部读 `currentIdentity()` 来 seed，
   * 而那时它还是旧身份。后果**不是**显示错乱，是渠道命令按错身份作答 ——
   * "拿着 A 的库去读 B 的会话"，正是 profile-seed 那道主防线要
   * 结构性排除的事，却被一个时序 bug 从内部打开了。而它完全静默：
   * 两边都"有数据"，只是数据属于别人。
   *
   * 实测（本机三个真实 vault，2026-08-09）：库里绑的 user_id 与其
   * dws-home 里 seed 的 user_id **三个全部不一致**，其中两个正好对调。
   *
   * 所以判据从"mount 自己去读"改成"调用方显式传" —— 时序问题在类型层面
   * 就不存在了。这条断言锁的是那个参数。
   */
  it("★★ mount 收到的身份是**目标**身份（seed 不能用旧身份）", async () => {
    bind(CORP_A, USER_A, "vault-a")
    bind(CORP_B, USER_B, "vault-b", "组织乙")
    let seededCorp: string | null | undefined
    let seededUser: string | null | undefined
    const service: ActiveIdentityService = makeService({
      mount: (vaultId, identity) => {
        mounted.push(vaultId)
        seededCorp = identity?.corpId ?? null
        seededUser = identity?.userId ?? null
        return Promise.resolve()
      },
    })
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })

    await service.switchTo(keyOf(CORP_B, USER_B))

    // ★ 目标身份，不是切换前那个
    expect(seededCorp).toBe(CORP_B)
    expect(seededUser).toBe(USER_B)
    // 反面：如果拿的是内存态就会是 A（那正是修复前的行为）
    expect(seededCorp).not.toBe(CORP_A)
  })

  /**
   * ★ 挂载必须被 **await**。
   *
   * 挂载里有"等图谱服务让出 8200"与"等在途采集收尾"两件必须等的事。
   * fire-and-forget 的话 `switchTo` 会在它们还没做完时就返回，
   * 而调用方（界面）据此认为"切好了" —— 新旧两套于是重叠着跑。
   */
  it("★ switchTo 等挂载真的完成才返回", async () => {
    bind(CORP_A, USER_A, "vault-a")
    bind(CORP_B, USER_B, "vault-b", "组织乙")
    let finished = false
    const service = makeService({
      mount: async (vaultId) => {
        mounted.push(vaultId)
        await new Promise((resolve) => setTimeout(resolve, 10))
        finished = true
      },
    })
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })

    await service.switchTo(keyOf(CORP_B, USER_B))
    expect(finished).toBe(true)
  })

  it("切到当前身份是 no-op（不白付一次几十秒的卸载+挂载）", async () => {
    bind(CORP_A, USER_A, "vault-a")
    const service = makeService()
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })

    await service.switchTo(keyOf(CORP_A, USER_A))
    expect(mounted).toEqual([])
  })

  /**
   * ★★ 并发切换不能交错。
   *
   * 两次切换的卸载/挂载穿插会同时踩上两个真问题：图谱服务的端口竞态
   * （新的先起、旧的还没让出 8200），以及退订错身份。
   * 与 `FeedService.inFlightSync` 同一款做法。
   */
  it("★★ 并发 switchTo 不交错（第二次等第一次）", async () => {
    bind(CORP_A, USER_A, "vault-a")
    bind(CORP_B, USER_B, "vault-b", "组织乙")
    const order: string[] = []
    const service = makeService({
      mount: async (vaultId) => {
        order.push(`start:${vaultId}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push(`end:${vaultId}`)
      },
    })
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })

    await Promise.all([
      service.switchTo(keyOf(CORP_B, USER_B)),
      service.switchTo(keyOf(CORP_B, USER_B)),
    ])
    // 交错会得到 start,start,end,end；不交错是 start,end（第二次判成 no-op）
    expect(order).toEqual(["start:vault-b", "end:vault-b"])
  })

  it("切到没绑过的身份 → 抛错，而不是静默建一个新 vault", async () => {
    bind(CORP_A, USER_A, "vault-a")
    const service = makeService()
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })
    await expect(service.switchTo(keyOf(CORP_B, USER_B))).rejects.toThrow()
  })
})

describe("授权后的身份路由（「换组织重新授权」不再是死路）", () => {
  /**
   * ★★ 这一条是那条报错的正解。
   *
   * 原来：换组织重新授权 → 身份守卫抛 SELF_IDENTITY_CONFLICT → 界面只能说
   * "换身份请新建一个账号"。现在：没绑过的身份自动拿到自己的 vault。
   */
  it("授权到一个全新身份、且账号已有别的身份 → 建新 vault", () => {
    bind(CORP_A, USER_A, "vault-a")
    const service = makeService()
    const result = service.bindAuthorized({
      key: keyOf(CORP_B, USER_B),
      corpName: "组织乙",
      baseVaultId: BASE_VAULT,
      newVaultId: () => "vault-new",
    })
    expect(result).toEqual({ vaultId: "vault-new", created: true })
  })

  /**
   * ★ 账号**一个身份都没有**时绑到**基础 vault**，不新建。
   *
   * 那个库里可能已经有采集数据了（共享登录态下采集不依赖身份行，
   * 实测过 messages 有 49 条而身份表 0 行）。新建一个会把那些数据孤立掉 ——
   * 用户看到的是"我采过的东西全没了"。
   */
  it("★ 账号还没有任何身份 → 绑到基础 vault（那个库里可能已有数据）", () => {
    const service = makeService()
    const result = service.bindAuthorized({
      key: keyOf(CORP_A, USER_A),
      corpName: "组织甲",
      baseVaultId: BASE_VAULT,
      newVaultId: () => "vault-should-not-be-used",
    })
    expect(result).toEqual({ vaultId: BASE_VAULT, created: false })
  })

  it("重新授权到**已绑过**的身份 → 用回它的 vault，不新建", () => {
    bind(CORP_A, USER_A, "vault-a")
    const service = makeService()
    const result = service.bindAuthorized({
      key: keyOf(CORP_A, USER_A),
      corpName: "组织甲",
      baseVaultId: BASE_VAULT,
      newVaultId: () => "vault-should-not-be-used",
    })
    expect(result).toEqual({ vaultId: "vault-a", created: false })
  })

  it("重新授权会刷新显示名（组织改名 / 改花名都该跟上）", () => {
    bind(CORP_A, USER_A, "vault-a", "组织甲")
    makeService().bindAuthorized({
      key: keyOf(CORP_A, USER_A),
      corpName: "组织甲（新）",
      userName: "小张",
      baseVaultId: BASE_VAULT,
      newVaultId: () => "unused",
    })
    const found = identities.find(keyOf(CORP_A, USER_A))
    expect(found?.corpName).toBe("组织甲（新）")
    expect(found?.userName).toBe("小张")
  })

  /**
   * ★ 同一组织的两个人是两个 vault。
   *
   * userId 只在企业内唯一，所以"同组织"根本不足以判定是同一个人 ——
   * 而两个人的语料混进同一份画像是不可逆的。
   */
  it("★ 同一组织里的另一个人 → 另一个 vault（userId 才是企业内的判据）", () => {
    bind(CORP_A, USER_A, "vault-a")
    const result = makeService().bindAuthorized({
      key: keyOf(CORP_A, USER_B),
      corpName: "组织甲",
      baseVaultId: BASE_VAULT,
      newVaultId: () => "vault-second-person",
    })
    expect(result).toEqual({ vaultId: "vault-second-person", created: true })
  })
})

describe("登出", () => {
  it("清掉内存态，但**不动**记住的那条（下次登录还要用它恢复）", () => {
    bind(CORP_A, USER_A, "vault-a")
    const service = makeService()
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })
    service.clear()

    expect(service.currentIdentity()).toBeNull()
    expect(service.currentProfile()).toBeUndefined()
    // 新实例仍能恢复到 vault-a
    expect(
      makeService().resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT }).vaultId,
    ).toBe("vault-a")
  })
})
