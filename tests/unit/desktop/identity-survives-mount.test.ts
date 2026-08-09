/**
 * 登录/启动时身份**必须活着传到 mount**。
 *
 * ## 这一组锁的是一个"两行日志自相矛盾"的现场
 *
 * 用户报「采集未运行」，而库里明明一切就绪：
 *
 * ```
 * channel_self_identity  1 行，confirmed_at 有值
 * messages               27670 条，其中 is_self=1 有 12832 条，IS NULL 有 0 条
 * ```
 *
 * 也就是**身份早就确认了**（他授权过、也确认过，不该再被要求确认）。
 * 而日志里紧挨着的两行互相矛盾：
 *
 * ```
 * 14:58:43.130  active identity restored {channelId: dingtalk, corpName: …}
 * 14:58:43.233  vault has no bound channel identity {reason: identity_unbound}
 * ```
 *
 * ## 根因：mount 的第一件事把刚设好的身份清掉了
 *
 * `mountVault()` 第一行是 `await unmountVault()`，而卸载的最后一步
 * `releaseVault` 里有 `activeIdentity.clear()`。于是：
 *
 * ```
 * resolveOnLogin()  → this.current = found     ← 设好了
 * mountVault(id)    → unmountVault()           ← 又清掉了
 *                   → currentIdentity() = null ← mount 读到 null
 *                   → dataFlowsAllowed = false → 采集/事件流整个不起
 * ```
 *
 * ★ `mountVault` 的 `seedIdentity` 参数本来就是为这件事设计的
 * （那里的注释写着「为什么必须是参数：不能让 mount 去读一个会被卸载清掉的
 * 内存态」）—— 只是登录与启动恢复这两条路**忘了传**。
 *
 * 所以修法是让 `resolveOnLogin` 把身份**一起返回**，调用方显式传下去。
 * 这一组的断言就锁那个返回值：它必须与 `currentIdentity()` 一致，
 * 且在"没绑过"时是 null。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLogger } from "@mycontext/kernel"
import type { ChannelIdentityVaultRecord } from "@mycontext/store"
import {
  ChannelIdentityVaultRepository,
  openStore,
  SettingsRepository,
  type StoreHandle,
} from "@mycontext/store"
import { ActiveIdentityService } from "@main/services/active-identity.service.js"

const logger = createLogger("test-identity-mount", { level: "error" })
const NOW = new Date("2026-08-09T10:00:00.000Z")
const ACCOUNT = "acct-1"
const BASE_VAULT = "vault-base"
/** ★ 值全是编的（CLAUDE.md §1.2），形态照真实。 */
const CORP = "dingFAKECORP0001"
const USER = "100001"

let dir: string
let store: StoreHandle
let identities: ChannelIdentityVaultRepository

function keyOf() {
  return { accountId: ACCOUNT, channelId: "dingtalk", corpId: CORP, userId: USER }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mycontext-identity-mount-"))
  store = openStore({ path: join(dir, "control.sqlite") })
  identities = new ChannelIdentityVaultRepository(store.db)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * 造一个**会像真 mountVault 那样先清内存态**的服务。
 *
 * ★★ 这是本组的关键：`mount` 回调里调 `clear()` 复刻了
 * `mountVault → unmountVault → releaseVault → activeIdentity.clear()`。
 * 不复刻这一步的话，测试跑在一个比生产更宽容的世界里 —— 那正是这个 bug
 * 能活到用户手上的原因。
 */
function makeService(onMount: (vaultId: string) => void) {
  const service: ActiveIdentityService = new ActiveIdentityService({
    identities,
    settings: new SettingsRepository(store.db),
    logger,
    now: () => NOW,
    mount: (vaultId) => {
      service.clear() // ← 复刻真实的 releaseVault
      onMount(vaultId)
      return Promise.resolve()
    },
  })
  return service
}

describe("★★ resolveOnLogin 要把身份一起交出来", () => {
  /**
   * ★★ 这条是那个 bug 的直接反面。
   *
   * 反证：让 `resolveOnLogin` 只返回 vaultId（调用方只能去读内存态）→
   * 那个值在 mount 内部被 clear 之后就是 null，于是数据流不起。
   */
  it("★★ 绑过身份 → 返回值里带着那个身份（不必去读内存态）", () => {
    identities.bind({
      ...keyOf(),
      vaultId: "vault-a",
      corpName: "组织甲",
      userName: "张三",
      at: NOW.toISOString(),
    })
    const service = makeService(() => undefined)

    const { vaultId, identity } = service.resolveOnLogin({
      accountId: ACCOUNT,
      fallbackVaultId: BASE_VAULT,
    })

    expect(vaultId).toBe("vault-a")
    expect(identity).not.toBeNull()
    expect(identity?.corpId).toBe(CORP)
    expect(identity?.userId).toBe(USER)
  })

  /**
   * ★★★ **即便 mount 把内存态清掉，调用方手上那份仍然有效。**
   *
   * 这条模拟真实时序：拿到返回值 → 调 mount（内部 clear）→
   * 那份返回值必须还能用。这正是生产里"传给 mountVault 的 seedIdentity"。
   */
  it("★★★ mount 清掉内存态之后，返回的那份身份仍可用", async () => {
    identities.bind({
      ...keyOf(),
      vaultId: "vault-a",
      corpName: "组织甲",
      userName: "张三",
      at: NOW.toISOString(),
    })
    const service = makeService(() => undefined)
    const { identity } = service.resolveOnLogin({
      accountId: ACCOUNT,
      fallbackVaultId: BASE_VAULT,
    })

    /**
     * 复刻 mountVault 的开头：它 `await unmountVault()`，而卸载最后一步
     * `releaseVault` 会 `activeIdentity.clear()`。
     *
     * ⚠️ 这里**直接调 `clear()`** 而不是 `switchTo()`：我第一版用了后者，
     * 而它是幂等的 —— 目标就是当前 vault 时直接返回、根本不 mount，
     * 于是 clear 从未发生、断言反而红了。测试要复刻的是"卸载会清内存态"
     * 这一件事，不是绕一圈去触发它。
     */
    service.clear()

    // 内存态被清了（生产里就是这样）……
    expect(service.currentIdentity()).toBeNull()
    // ……但调用方早就拿到了那份身份，数据流照样能起
    expect(identity?.corpId).toBe(CORP)
  })

  /**
   * ★ 真的没绑过 → identity 为 null，那时**应该**判 unbound。
   *
   * 这条保证上面那个修复没有把"新账号"也误判成有身份 ——
   * 那会让引导流程往一个不属于任何身份的 vault 里写数据。
   */
  it("★ 没绑过任何身份 → identity 为 null（此时 unbound 是对的）", () => {
    const service = makeService(() => undefined)
    const { vaultId, identity } = service.resolveOnLogin({
      accountId: ACCOUNT,
      fallbackVaultId: BASE_VAULT,
    })
    expect(vaultId).toBe(BASE_VAULT)
    expect(identity).toBeNull()
  })

  /** ★ 返回的身份与内存态**同一个对象**（不是两份可能漂的副本）。 */
  it("★ 返回值与 currentIdentity() 一致", () => {
    identities.bind({
      ...keyOf(),
      vaultId: "vault-a",
      corpName: "组织甲",
      userName: "张三",
      at: NOW.toISOString(),
    })
    const service = makeService(() => undefined)
    const { identity } = service.resolveOnLogin({
      accountId: ACCOUNT,
      fallbackVaultId: BASE_VAULT,
    })
    expect(identity).toEqual(service.currentIdentity())
  })

  /**
   * ★★★ **`restored` 那一档也要交出身份** —— 而它正是用户撞上的那一条。
   *
   * 上面三条走的是「挑最近用过的」（`listByAccount`）分支，因为测试没写过
   * `app_settings`。而生产里的真实路径是**读回上次记住的那个**
   * （`readRemembered` → `find`），日志里那句 `active identity restored`
   * 就是它。
   *
   * 我第一版漏了这一档，反证时才发现：把 `restored` 分支的 identity 改成
   * null，四条**全绿** —— 也就是那个分支完全没被锁住。而它恰恰是出事的那条。
   *
   * 这里先 `switchTo` 一次把身份写进 settings（那会调 `remember()`），
   * 再用一个新实例模拟重启。
   */
  it("★★★ restored 分支（读回上次记住的）也带着身份", async () => {
    identities.bind({
      ...keyOf(),
      vaultId: "vault-a",
      corpName: "组织甲",
      userName: "张三",
      at: NOW.toISOString(),
    })
    identities.bind({
      accountId: ACCOUNT,
      channelId: "dingtalk",
      corpId: "dingFAKECORP0002",
      userId: "200002",
      vaultId: "vault-b",
      corpName: "组织乙",
      userName: "李四",
      at: NOW.toISOString(),
    })

    // 先切到 vault-b —— switchTo 会 remember() 它
    const first = makeService(() => undefined)
    first.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })
    await first.switchTo({
      accountId: ACCOUNT,
      channelId: "dingtalk",
      corpId: "dingFAKECORP0002",
      userId: "200002",
    })

    // 新实例 = 重启：这次走 restored 分支
    const second = makeService(() => undefined)
    const { vaultId, identity } = second.resolveOnLogin({
      accountId: ACCOUNT,
      fallbackVaultId: BASE_VAULT,
    })

    expect(vaultId).toBe("vault-b")
    expect(identity).not.toBeNull()
    expect(identity?.corpId).toBe("dingFAKECORP0002")
  })
})

/**
 * 造一个**完整复刻真 `mountVault`** 的服务：卸载清掉内存态，
 * 然后按传进来的 `seedIdentity` 设回（`activeIdentity.adopt`）。
 *
 * ★★ 与上面那个 `makeService` 的差别就是这次修复本身：那个只复刻了
 * `clear()`（卸载），于是它锁得住"调用方手上那份还在"，
 * 却锁不住"**内存态**也回来了"。而 `currentProfile()` 读的是内存态。
 */
function makeRealisticService(seen: { profileDuringIngest: string | undefined }) {
  /**
   * ★ 这就是 `startup.ts` 的 `mountVault` 那三步，顺序照抄：
   * ① `await unmountVault()` → `releaseVault` → `clear()`；
   * ② `if (seedIdentity !== undefined) activeIdentity.adopt(seedIdentity)`（本次修复）；
   * ③ attach 各服务 —— `dataPlane.attach()` 在这里就起采集。
   */
  const mountVault = (
    _vaultId: string,
    seedIdentity?: ChannelIdentityVaultRecord | null,
  ): Promise<void> => {
    service.clear() // ① releaseVault
    if (seedIdentity !== undefined) service.adopt(seedIdentity) // ② 设回
    /**
     * ③ 模拟 `dataPlane.attach()`：它在 mount **内部**就起采集，而采集的
     * 第一条渠道命令要钉 `--profile`（读 `currentProfile()`）。所以判据必须在
     * **这个时刻**取，而不是 mount 返回之后 —— 那时再对也已经晚了一整轮。
     */
    seen.profileDuringIngest = service.currentProfile()
    return Promise.resolve()
  }
  const service: ActiveIdentityService = new ActiveIdentityService({
    identities,
    settings: new SettingsRepository(store.db),
    logger,
    now: () => NOW,
    mount: (vaultId, identity) => mountVault(vaultId, identity),
  })
  return { service, mountVault }
}

describe("★★★ 挂载完成后 currentProfile 必须能钉住（渠道命令的唯一来源）", () => {
  /**
   * ★★★ **这一条是第二次修复的直接反面。**
   *
   * 上一版只把身份传给了 `seedIdentity`（渠道配置目录 seed 对了），
   * 而内存态仍然是空的。于是实测：
   *
   * ```
   * channel profile seeded for vault {channelId: dingtalk}   ← 主防线对了
   * ingest started {channelId: dingtalk}                      ← 数据流起来了
   * ingest tick failed {detail: "还没绑定渠道身份，拒绝执行渠道命令…"}
   * ```
   *
   * 采集/听记/文档三路全灭、事件流退避到 60s，每 10 秒刷一条 warn。
   *
   * ★ 判据是 `currentProfile()` 而不是 `currentIdentity()`：前者是
   * `dwsProfileArgs()` 的**唯一**来源，也就是渠道命令那道闸真正读的东西。
   */
  it("★★★ 登录挂载完 → currentProfile 有值（否则每条渠道命令都被拒）", async () => {
    identities.bind({
      ...keyOf(),
      vaultId: "vault-a",
      corpName: "组织甲",
      userName: "张三",
      at: NOW.toISOString(),
    })
    const seen = { profileDuringIngest: undefined as string | undefined }
    const { service, mountVault } = makeRealisticService(seen)

    const { vaultId, identity } = service.resolveOnLogin({
      accountId: ACCOUNT,
      fallbackVaultId: BASE_VAULT,
    })
    // 生产里就是这么调的（startup.ts 的两个 mountVault 调用点）
    await mountVault(vaultId, identity)

    expect(service.currentProfile()).toBe(CORP)
    expect(service.currentProfile()).not.toBeUndefined()
  })

  /**
   * ★★ 而且要在 **mount 内部**（采集起来的那一刻）就已经钉得上。
   *
   * mount 返回之后才对是不够的：`dataPlane.attach()` 在 mount 里面就起采集，
   * 那时 profile 读不到的话第一轮直接被拒（实测日志里 `ingest started` 与
   * `ingest tick failed` 相差 2 毫秒）。
   */
  it("★★ mount 内部起采集的那一刻就已经钉得上", async () => {
    identities.bind({
      ...keyOf(),
      vaultId: "vault-a",
      corpName: "组织甲",
      userName: "张三",
      at: NOW.toISOString(),
    })
    const seen = { profileDuringIngest: undefined as string | undefined }
    const { service, mountVault } = makeRealisticService(seen)
    const { vaultId, identity } = service.resolveOnLogin({
      accountId: ACCOUNT,
      fallbackVaultId: BASE_VAULT,
    })

    await mountVault(vaultId, identity)

    expect(seen.profileDuringIngest).toBe(CORP)
  })

  /**
   * ★ 反面：没绑身份（基础 vault）时 profile 必须**仍然是 undefined**。
   *
   * 这条保证上面那个修复没把"未授权"也变成"能钉住" —— 那会让引导阶段
   * 拿着一个不属于任何人的 profile 去跑渠道命令，正是那道闸要挡的事。
   */
  it("★ 没绑身份 → 挂载完 profile 仍是 undefined（那道闸该拦住）", async () => {
    const seen = { profileDuringIngest: undefined as string | undefined }
    const { service, mountVault } = makeRealisticService(seen)
    const { vaultId, identity } = service.resolveOnLogin({
      accountId: ACCOUNT,
      fallbackVaultId: BASE_VAULT,
    })

    await mountVault(vaultId, identity)

    expect(service.currentProfile()).toBeUndefined()
  })

  /**
   * ★★ `adopt(null)` 要真的清干净 —— 那是**登出**语义。
   *
   * 登出后 `currentProfile()` 仍有值的话，退出登录之后还能按身份跑渠道命令。
   */
  it("★★ adopt(null) 之后 profile 是 undefined（登出语义）", () => {
    identities.bind({
      ...keyOf(),
      vaultId: "vault-a",
      corpName: "组织甲",
      userName: "张三",
      at: NOW.toISOString(),
    })
    const seen = { profileDuringIngest: undefined as string | undefined }
    // ★ 这条不经过 mount：它锁的是 adopt(null) 本身的语义（登出）
    const { service } = makeRealisticService(seen)
    service.resolveOnLogin({ accountId: ACCOUNT, fallbackVaultId: BASE_VAULT })
    expect(service.currentProfile()).toBe(CORP)

    service.adopt(null)
    expect(service.currentProfile()).toBeUndefined()
  })
})
