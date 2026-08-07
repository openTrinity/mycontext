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
}

function makeService(options: { vaultRoot: string | null; database: string; identity?: boolean }) {
  const trace: Trace = { steps: [], revoked: [], unbound: [], destroyed: [] }
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
