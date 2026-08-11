/**
 * 「清空当前渠道的数据」= 把这个渠道身份**整个归零**。
 *
 * ## 为什么这一层必须有测试
 *
 * 首版做的是"清数据、保留身份与勾选范围"，而实测后果是（本机日志）：
 *
 * ```
 * 07:55:15  channel data wipe done  rows=95172        ← 真删了 9.5 万行
 * 07:55:17  ingest dropped out-of-scope {allowed:72}  ← 2 秒后又开始采
 * 08:00:36  最新一条消息落库                           ← 5 分钟内回来 5000 条
 * ```
 *
 * 身份还确认着、72 个勾选会话还在，于是重挂之后采集立刻按原范围重跑 ——
 * 用户看到的是"点了清空但数据还在涨"，与"按钮没生效"无法区分。
 *
 * 所以这里断言的是那条**顺序**与它的四个后果：退授权、解绑、删目录、重挂。
 * 顺序错了每一样都会静默失效（见 `ChannelDataWipeService` 的文件头）。
 */
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import { openStore, VAULT_MIGRATIONS, type ChannelIdentityKey } from "@mycontext/store"
import { ChannelDataWipeService } from "@main/services/channel-data-wipe.service.js"

const START = 1_700_000_000_000
const KEY: ChannelIdentityKey = {
  accountId: "acct-1",
  channelId: "dingtalk",
  corpId: "dingFAKE0001corp",
  userId: "100200",
}

/** 造一个"长得像真 vault"的目录：库 + 凭据 + 派生产物。 */
function makeVault() {
  const root = mkdtempSync(join(tmpdir(), "wipe-vault-"))
  const database = join(root, "core.sqlite")
  const handle = openStore({ path: database, migrations: VAULT_MIGRATIONS })
  handle.close()
  // 渠道凭据（清空后必须消失）
  mkdirSync(join(root, "channels", "dingtalk", "dws-home"), { recursive: true })
  writeFileSync(join(root, "channels", "dingtalk", "dws-home", "token.json"), "{}")
  // 派生产物
  mkdirSync(join(root, "kl"), { recursive: true })
  writeFileSync(join(root, "kl", "knowledge.db"), "x")
  mkdirSync(join(root, "forge", "database"), { recursive: true })
  writeFileSync(join(root, "forge", "persona-config.json"), "{}")
  return { root, database }
}

interface Trace {
  steps: string[]
  revoked: string[]
  unbound: ChannelIdentityKey[]
  destroyed: string[]
  /** 只删了哪些渠道的子树（多渠道共用 vault 时走这条） */
  subtrees: string[]
}

function makeService(options: {
  vaultRoot: string | null
  database: string
  identity?: boolean
  /** 这个 vault 上还绑着哪些**别的**渠道（非空 = 共用，不能删整个 vault） */
  siblings?: string[]
}) {
  const trace: Trace = { steps: [], revoked: [], unbound: [], destroyed: [], subtrees: [] }
  const service = new ChannelDataWipeService({
    clock: new ManualClock(START),
    logger: createLogger("test-wipe", { level: "error" }),
    currentVault: () =>
      options.vaultRoot === null ? null : { root: options.vaultRoot, database: options.database },
    currentIdentity: () => (options.identity === false ? null : { key: KEY, vaultId: "vault-1" }),
    unmount: async () => {
      trace.steps.push("unmount")
    },
    revokeAuth: async (channelId) => {
      trace.steps.push("revoke")
      trace.revoked.push(channelId)
      return true
    },
    unbindIdentity: (key) => {
      trace.steps.push("unbind")
      trace.unbound.push(key)
    },
    // 默认「这个 vault 只有当前这一个渠道」→ 走 destroyVault（既有断言的前提）
    siblingChannels: () => options.siblings ?? [],
    destroyChannelSubtree: (_vaultId, channelId) => {
      trace.steps.push("destroy-subtree")
      trace.subtrees.push(channelId)
      return 1
    },
    destroyVault: (vaultId) => {
      trace.steps.push("destroy")
      trace.destroyed.push(vaultId)
      // 真的删掉目录 —— 断言"凭据不在了"要看真实文件系统
      if (options.vaultRoot !== null) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("node:fs").rmSync(options.vaultRoot, { recursive: true, force: true })
      }
    },
    remount: async () => {
      trace.steps.push("remount")
    },
  })
  return { service, trace }
}

describe("★★ 清空 = 归零（退授权 + 解绑 + 删目录 + 重挂）", () => {
  it("四步都做了，且**顺序**正确", async () => {
    const vault = makeVault()
    const { service, trace } = makeService({ vaultRoot: vault.root, database: vault.database })

    const result = await service.wipe({ dryRun: false })

    /**
     * ★★ 顺序是硬约束，每一条都对应一个实测过的失效：
     * · unmount 必须最先 —— kl 子进程持着 knowledge.db 的句柄，
     *   macOS 允许删开着的文件，于是"删了但进程还在写旧 inode"；
     * · revoke 必须在 destroy **之前** —— CLI 要读这个 vault 的 profiles
     *   才知道退哪个身份，目录先删了它会去退钥匙串里的全局 current
     *   （可能是另一个身份）；
     * · unbind 在 destroy 之前 —— 反过来的话中间那一刻 control 库里有一条
     *   指向已不存在目录的映射，下次登录会挑中它并新建一个空库。
     */
    expect(trace.steps).toEqual(["unmount", "revoke", "unbind", "destroy", "remount"])
    expect(result.identityUnbound).toBe(true)
    expect(result.authRevoked).toBe(true)
    expect(result.removedPaths).toBe(1)
  })

  it("★★ 退授权带的是**当前身份**的渠道（不是全局 current）", async () => {
    const vault = makeVault()
    const { service, trace } = makeService({ vaultRoot: vault.root, database: vault.database })

    await service.wipe({ dryRun: false })

    expect(trace.revoked).toEqual(["dingtalk"])
  })

  it("★★ 凭据文件真的不在了（那是「退出已授权」的本地一半）", async () => {
    const vault = makeVault()
    const token = join(vault.root, "channels", "dingtalk", "dws-home", "token.json")
    expect(existsSync(token)).toBe(true)
    const { service } = makeService({ vaultRoot: vault.root, database: vault.database })

    await service.wipe({ dryRun: false })

    expect(existsSync(token)).toBe(false)
    expect(existsSync(vault.root)).toBe(false)
  })

  it("解绑用的是四元组键（accountId + channelId + corpId + userId）", async () => {
    const vault = makeVault()
    const { service, trace } = makeService({ vaultRoot: vault.root, database: vault.database })

    await service.wipe({ dryRun: false })

    expect(trace.unbound).toEqual([KEY])
  })

  it("★ 退登失败**不阻止**清空（数据仍要删掉，只是凭据可能还在）", async () => {
    const vault = makeVault()
    const trace: string[] = []
    const service = new ChannelDataWipeService({
      clock: new ManualClock(START),
      logger: createLogger("test-wipe", { level: "error" }),
      currentVault: () => ({ root: vault.root, database: vault.database }),
      currentIdentity: () => ({ key: KEY, vaultId: "vault-1" }),
      unmount: async () => void trace.push("unmount"),
      // 退登失败（子进程超时 / CLI 不支持）
      revokeAuth: async () => false,
      unbindIdentity: () => void trace.push("unbind"),
      // 默认「这个 vault 只有当前这一个渠道」→ 走 destroyVault（既有断言的前提）
      siblingChannels: () => [],
      destroyChannelSubtree: () => 0,
      destroyVault: () => void trace.push("destroy"),
      remount: async () => void trace.push("remount"),
    })

    const result = await service.wipe({ dryRun: false })

    // 如实报"没退掉"，但数据照删、映射照解
    expect(result.authRevoked).toBe(false)
    expect(result.identityUnbound).toBe(true)
    expect(trace).toEqual(["unmount", "unbind", "destroy", "remount"])
  })

  it("★★ 中途抛异常也一定重挂（否则应用留在「登录了但没起服务」）", async () => {
    const vault = makeVault()
    const trace: string[] = []
    const service = new ChannelDataWipeService({
      clock: new ManualClock(START),
      logger: createLogger("test-wipe", { level: "error" }),
      currentVault: () => ({ root: vault.root, database: vault.database }),
      currentIdentity: () => ({ key: KEY, vaultId: "vault-1" }),
      unmount: async () => void trace.push("unmount"),
      revokeAuth: async () => true,
      unbindIdentity: () => void trace.push("unbind"),
      // 默认「这个 vault 只有当前这一个渠道」→ 走 destroyVault（既有断言的前提）
      siblingChannels: () => [],
      destroyChannelSubtree: () => 0,
      destroyVault: () => {
        throw new Error("目录被占用")
      },
      remount: async () => void trace.push("remount"),
    })

    await expect(service.wipe({ dryRun: false })).rejects.toThrow("目录被占用")
    // ★ 重挂在 finally 里 —— 抛了也要跑
    expect(trace).toContain("remount")
  })

  it("没绑身份（基础 vault）→ 不退登不解绑，但仍清目录", async () => {
    const vault = makeVault()
    const { service, trace } = makeService({
      vaultRoot: vault.root,
      database: vault.database,
      identity: false,
    })

    const result = await service.wipe({ dryRun: false })

    expect(result.identityUnbound).toBe(false)
    expect(result.authRevoked).toBe(false)
    expect(trace.steps).toEqual(["unmount", "destroy", "remount"])
  })

  it("未登录时报错而不是静默什么都不做", async () => {
    const { service } = makeService({ vaultRoot: null, database: "" })

    await expect(service.wipe({ dryRun: false })).rejects.toThrow(/尚未登录/)
  })
})

describe("清空：预演", () => {
  it("★ 预演不停服务、不删任何东西，但如实报「将会解除授权」", async () => {
    const vault = makeVault()
    const { service, trace } = makeService({ vaultRoot: vault.root, database: vault.database })

    const result = await service.wipe({ dryRun: true })

    expect(result.dryRun).toBe(true)
    expect(result.removedPaths).toBe(0)
    // 一步都没跑 —— 预演只读（为了报几个数字就停采集是不必要的干扰）
    expect(trace.steps).toEqual([])
    expect(existsSync(vault.root)).toBe(true)
    // 但要让用户看到代价
    expect(result.identityUnbound).toBe(true)
    expect(result.authRevoked).toBe(true)
  })
})

describe("★★ 多渠道共用同一个 vault 时，只清当前渠道", () => {
  /**
   * ## 这一条锁的是一次**真实的数据丢失**
   *
   * control v5 起一个 vault 可以挂多个渠道的身份（索引 `(vault_id, channel_id)`），
   * 而非主渠道的库就落在**这个 vault 目录里面**的 `sources/<channelId>/`。
   * 本机实测：钉钉与飞书两条身份、同一个 `vault_id`。
   *
   * 于是"清空当前渠道"若一律 `destroyVault`（删整个目录）：
   * · 另一个渠道的语料/图谱/导出**全部一起消失**；
   * · 它的身份映射还留在 control 库里指向一个已不存在的目录；
   * · 下次登录 `resolveOnLogin` 挑中它 → `openStore` 新建一个空库 →
   *   用户看到"已授权但什么都没有"的身份，而且永远清不掉。
   *
   * 全程不报错 —— 正是 CLAUDE.md §4 说的那类静默降级。
   */
  it("有别的渠道绑在同一个 vault → 只删这个渠道的子树，**不动整个 vault**", async () => {
    const vault = makeVault()
    const { service, trace } = makeService({
      vaultRoot: vault.root,
      database: vault.database,
      siblings: ["feishu"],
    })

    const result = await service.wipe({ dryRun: false })

    // ★ 关键断言：destroyVault 一次都没被调用
    expect(trace.destroyed).toEqual([])
    expect(trace.steps).not.toContain("destroy")
    // 走的是子树那条，且删的正是**当前身份**那个渠道
    expect(trace.steps).toContain("destroy-subtree")
    expect(trace.subtrees).toEqual([KEY.channelId])
    // vault 目录还在（另一个渠道的东西就在里面）
    expect(existsSync(vault.root)).toBe(true)
    expect(result.removedPaths).toBe(1)
    // 授权仍然只退当前渠道这一个
    expect(trace.revoked).toEqual([KEY.channelId])
  })

  it("只剩自己一个渠道 → 仍然删整个 vault（不留空壳）", async () => {
    const vault = makeVault()
    const { service, trace } = makeService({
      vaultRoot: vault.root,
      database: vault.database,
      siblings: [],
    })

    await service.wipe({ dryRun: false })

    expect(trace.destroyed).toEqual(["vault-1"])
    expect(trace.steps).not.toContain("destroy-subtree")
    expect(existsSync(vault.root)).toBe(false)
  })
})
