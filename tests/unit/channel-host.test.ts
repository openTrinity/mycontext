/**
 * 渠道宿主与二进制解析测试。
 *
 * 用 fake 插件而不是真实 dws：这里验证的是编排逻辑（缓存、并发保护、
 * 单渠道失败不拖垮整体），与外部进程无关；真实链路另由手动验证覆盖。
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChannelHost, createRegistry } from "@mycontext/channels"
import type { AuthStatus, ChannelPlugin } from "@mycontext/channels"
import { RuntimeEnv } from "@mycontext/runtime-env"

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

interface FakeOptions {
  id?: string
  available?: boolean
  status?: () => Promise<AuthStatus>
  login?: () => Promise<AuthStatus>
}

function fakePlugin(options: FakeOptions = {}): ChannelPlugin {
  return {
    meta: {
      id: (options.id ?? "dingtalk") as ChannelPlugin["meta"]["id"],
      labelKey: "channels:test.label",
      descriptionKey: "channels:test.description",
      available: options.available ?? true,
    },
    capabilities: {
      chatTypes: ["group"],
      ingest: ["poll"],
      changeProbe: true,
      media: false,
      sendAs: ["self"],
      domains: ["chat"],
    },
    auth: {
      describeStepKeys: () => ["channels:test.steps.first"],
      status: options.status ?? (() => Promise.resolve(AUTHORIZED)),
      login: options.login ?? (() => Promise.resolve(AUTHORIZED)),
    },
  }
}

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-bin-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe("ChannelHost：状态缓存", () => {
  it("TTL 内复用缓存，避免每次渲染都 spawn 子进程", async () => {
    const status = vi.fn(() => Promise.resolve(AUTHORIZED))
    const host = new ChannelHost(createRegistry([fakePlugin({ status })]), { cacheTtlMs: 1000 })

    await host.status("dingtalk")
    await host.status("dingtalk")
    expect(status).toHaveBeenCalledTimes(1)
  })

  it("refresh 为 true 时跳过缓存", async () => {
    const status = vi.fn(() => Promise.resolve(AUTHORIZED))
    const host = new ChannelHost(createRegistry([fakePlugin({ status })]), { cacheTtlMs: 1000 })

    await host.status("dingtalk")
    await host.status("dingtalk", { refresh: true })
    expect(status).toHaveBeenCalledTimes(2)
  })

  it("TTL 过期后重新查询", async () => {
    const status = vi.fn(() => Promise.resolve(AUTHORIZED))
    let clock = 0
    const host = new ChannelHost(createRegistry([fakePlugin({ status })]), {
      cacheTtlMs: 1000,
      now: () => clock,
    })

    await host.status("dingtalk")
    clock = 1500
    await host.status("dingtalk")
    expect(status).toHaveBeenCalledTimes(2)
  })

  it("invalidate 后强制重查", async () => {
    const status = vi.fn(() => Promise.resolve(AUTHORIZED))
    const host = new ChannelHost(createRegistry([fakePlugin({ status })]))
    await host.status("dingtalk")
    host.invalidate("dingtalk")
    await host.status("dingtalk")
    expect(status).toHaveBeenCalledTimes(2)
  })
})

describe("ChannelHost：并发保护", () => {
  it("同一渠道不允许并发登录（会争抢回调端口与凭据文件）", async () => {
    let release: (() => void) | undefined
    const login = () =>
      new Promise<AuthStatus>((resolve) => {
        release = () => resolve(AUTHORIZED)
      })
    const host = new ChannelHost(createRegistry([fakePlugin({ login })]))

    const first = host.startLogin({ channelId: "dingtalk", mode: "loopback", onProgress: () => {} })
    await expect(
      host.startLogin({ channelId: "dingtalk", mode: "loopback", onProgress: () => {} }),
    ).rejects.toMatchObject({ code: "CHANNEL_AUTH_IN_PROGRESS" })

    release?.()
    await first
    // 上一个结束后可以再次登录
    expect(host.isLoginInProgress("dingtalk")).toBe(false)
  })

  it("登录失败后也会释放占用（否则再也点不动授权）", async () => {
    const host = new ChannelHost(
      createRegistry([fakePlugin({ login: () => Promise.reject(new Error("boom")) })]),
    )
    await expect(
      host.startLogin({ channelId: "dingtalk", mode: "loopback", onProgress: () => {} }),
    ).rejects.toThrow()
    expect(host.isLoginInProgress("dingtalk")).toBe(false)
  })

  it("cancelLogin 对没有进行中的流程返回 false", () => {
    const host = new ChannelHost(createRegistry([fakePlugin()]))
    expect(host.cancelLogin("dingtalk")).toBe(false)
  })
})

describe("ChannelHost：Onboarding 判定", () => {
  it("任一渠道已授权即为 true", async () => {
    const host = new ChannelHost(createRegistry([fakePlugin()]))
    await expect(host.hasAnyAuthorized()).resolves.toBe(true)
  })

  it("全部未授权则为 false", async () => {
    const host = new ChannelHost(
      createRegistry([fakePlugin({ status: () => Promise.resolve({ state: "unauthorized" }) })]),
    )
    await expect(host.hasAnyAuthorized()).resolves.toBe(false)
  })

  it("单个渠道查询抛错时按未授权处理，不把用户卡在启动流程外", async () => {
    const host = new ChannelHost(
      createRegistry([fakePlugin({ status: () => Promise.reject(new Error("dws missing")) })]),
    )
    await expect(host.hasAnyAuthorized()).resolves.toBe(false)
  })

  it("跳过未开放的渠道（其 status 是桩，查了也无意义）", async () => {
    const status = vi.fn(() => Promise.resolve(AUTHORIZED))
    const host = new ChannelHost(
      createRegistry([fakePlugin({ id: "feishu", available: false, status })]),
    )
    await expect(host.hasAnyAuthorized()).resolves.toBe(false)
    expect(status).not.toHaveBeenCalled()
  })

  it("未知渠道抛明确错误", () => {
    const host = new ChannelHost(createRegistry([fakePlugin()]))
    // 断言的是运行时行为：registry.get() 的参数是 string（外部输入可能是任意值），
    // 而 meta.id 是 ChannelId 联合。用 String() 绕开「字面量与联合无交集」的
    // 编译期告警 —— 那个告警是对的，但这里测的正是"运行时收到了不该有的值"。
    const unknown = String("nope")
    expect(() => host.list().find((plugin) => String(plugin.meta.id) === unknown)).not.toThrow()
    expect(() => createRegistry([fakePlugin()]).get(unknown)).toThrow(/未知渠道/)
  })
})

/**
 * `authorizedChannels()`：挂几条采集管线 / 起几个 kl 的判据。
 *
 * 与上面那组的区别是 `hasAnyAuthorized` 只要一个"是"，而这个要**全集**。
 * 所以短路优化在这里是错的 —— 第一条测试就锁住"每个可用渠道都真查过"。
 */
describe("ChannelHost：已授权渠道列表", () => {
  it("只返回已授权的，且失败的渠道当未授权（不挂一条注定失败的管线）", async () => {
    const host = new ChannelHost(
      createRegistry([
        fakePlugin({ id: "dingtalk" }),
        fakePlugin({ id: "feishu", status: () => Promise.reject(new Error("lark-cli missing")) }),
      ]),
    )
    await expect(host.authorizedChannels()).resolves.toEqual(["dingtalk"])
  })

  it("未授权的不进列表", async () => {
    const host = new ChannelHost(
      createRegistry([
        fakePlugin({ id: "dingtalk", status: () => Promise.resolve({ state: "unauthorized" }) }),
        fakePlugin({ id: "feishu" }),
      ]),
    )
    await expect(host.authorizedChannels()).resolves.toEqual(["feishu"])
  })

  it("★ 不短路：第一个已授权之后仍继续查（否则永远只挂一条管线）", async () => {
    const second = vi.fn(() => Promise.resolve(AUTHORIZED))
    const host = new ChannelHost(
      createRegistry([
        fakePlugin({ id: "dingtalk" }),
        fakePlugin({ id: "feishu", status: second }),
      ]),
    )
    await expect(host.authorizedChannels()).resolves.toEqual(["dingtalk", "feishu"])
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("跳过未开放的渠道（与 hasAnyAuthorized 同口径）", async () => {
    const status = vi.fn(() => Promise.resolve(AUTHORIZED))
    const host = new ChannelHost(
      createRegistry([fakePlugin({ id: "feishu", available: false, status })]),
    )
    await expect(host.authorizedChannels()).resolves.toEqual([])
    expect(status).not.toHaveBeenCalled()
  })

  it("全都没连时返回空数组（而不是 null —— 调用方要能直接遍历）", async () => {
    const host = new ChannelHost(
      createRegistry([fakePlugin({ status: () => Promise.resolve({ state: "unauthorized" }) })]),
    )
    await expect(host.authorizedChannels()).resolves.toEqual([])
  })
})

describe("RuntimeEnv：二进制解析", () => {
  const options = (binDir: string) => ({
    binDir,
    dwsChannel: "channel-code",
    dwsConfigDir: "/tmp/dws-home",
  })

  it("缺失时报错并给出期望路径与准备命令（只说「文件不存在」没法操作）", () => {
    const env = new RuntimeEnv(options(tempDir()))
    try {
      env.resolve("dws")
      throw new Error("应当抛错")
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain("缺少预置可执行文件")
      expect(message).toContain("pnpm prepare:bin")
      expect((error as { code?: string }).code).toBe("RUNTIME_BINARY_MISSING")
    }
  })

  it("存在时返回带平台后缀的绝对路径", () => {
    const dir = tempDir()
    const name =
      process.platform === "win32"
        ? `dws-${process.platform}-arm64.exe`
        : `dws-${process.platform}-${process.arch}`
    writeFileSync(join(dir, name), "#!/bin/sh\n")
    chmodSync(join(dir, name), 0o755)

    const resolved = new RuntimeEnv(options(dir)).resolve("dws")
    expect(resolved.path).toBe(join(dir, name))
    expect(resolved.platform).toContain(process.platform)
  })

  it("丢失可执行位时自动补上（extraResources 解出的文件常见）", () => {
    const dir = tempDir()
    const name = `dws-${process.platform}-${process.arch}`
    writeFileSync(join(dir, name), "#!/bin/sh\n")
    chmodSync(join(dir, name), 0o644)

    expect(() => new RuntimeEnv(options(dir)).resolve("dws")).not.toThrow()
  })

  it("buildEnv 注入渠道号与配置目录", () => {
    const env = new RuntimeEnv(options(tempDir())).buildEnv()
    expect(env["DWS_CHANNEL"]).toBe("channel-code")
    expect(env["DWS_CONFIG_DIR"]).toBe("/tmp/dws-home")
  })

  it("buildEnv 的额外变量可覆盖默认值", () => {
    const env = new RuntimeEnv(options(tempDir())).buildEnv({ DWS_CHANNEL: "override" })
    expect(env["DWS_CHANNEL"]).toBe("override")
  })
})

describe("★★★ 带来源作用域的 channelId 也要能查到插件", () => {
  /**
   * ★★★ 这一组锁的是「清空渠道数据不退授权」那个 bug 的根因。
   *
   * ## 现场（CDP 端到端跑那颗按钮，2026-08-10）
   *
   * ```
   * channel logout failed {"channelId":"dingtalk@src-…","detail":"未知渠道：dingtalk@src-…"}
   * channel data wipe done {"rows":44008,"identityUnbound":true,"authRevoked":false}
   * ```
   *
   * 数据删了（44008 行）、身份解绑了、vault 目录也删了，而**授权没退** ——
   * token 在系统钥匙串里，于是清空之后 `auth status` 仍返回 authorized。
   * 那正是用户报的"清了还是已授权状态"。
   *
   * ## 根因：库里的 channelId 带作用域，注册表里的不带
   *
   * 隔离键的第一段是「哪个 dws 二进制」（`source-key.ts`），所以身份行里存的是
   * `dingtalk@src-<hash>`。而**插件是按渠道注册的** —— 一个钉钉插件服务所有
   * 来源，注册表里只有裸 `dingtalk`。
   *
   * ★ 修在注册表的 `get()` 而不是各调用点：`logout` / `status` / `startLogin`
   * / `cancelLogin` 全都走它，逐个调用点去剥必然漏（这次就漏了 logout），
   * 而漏掉的那条**不报错**，只在某个具体动作上静默失效。
   */
  it("★★★ get(带作用域) 能查到那个渠道的插件", () => {
    const registry = createRegistry([fakePlugin({ id: "dingtalk" })])
    expect(registry.get("dingtalk@src-3f2a1b8c").meta.id).toBe("dingtalk")
  })

  /** ★ 不带作用域仍然照旧（这一行对存量调用必须零影响）。 */
  it("★ get(裸 channelId) 不受影响", () => {
    const registry = createRegistry([fakePlugin({ id: "dingtalk" })])
    expect(registry.get("dingtalk").meta.id).toBe("dingtalk")
  })

  /**
   * ★★ 真正不存在的渠道**仍要抛** —— 剥作用域不等于放宽校验。
   *
   * 剥完还是查不到就是真的没这个插件（打错了 / 没注册），
   * 那时静默返回一个别的插件会比报错糟得多。
   */
  it("★★ 剥完仍查不到 → 照旧抛 CHANNEL_UNKNOWN", () => {
    const registry = createRegistry([fakePlugin({ id: "dingtalk" })])
    expect(() => registry.get("feishu@src-3f2a1b8c")).toThrow(/未知渠道/)
    expect(() => registry.get("nope")).toThrow(/未知渠道/)
  })

  /**
   * ★★ `logout` 这条**实测失效的那条路**要通。
   *
   * 判据是"插件的 logout 真的被调到了" —— 而不只是 `get()` 不抛。
   */
  it("★★ host.logout(带作用域) 真的调到插件的 logout", async () => {
    let logoutCalled = 0
    const plugin = fakePlugin({ id: "dingtalk" })
    const withLogout: ChannelPlugin = {
      ...plugin,
      auth: {
        ...plugin.auth,
        logout: () => {
          logoutCalled += 1
          return Promise.resolve(true)
        },
      },
    }
    const host = new ChannelHost(createRegistry([withLogout]))
    const ok = await host.logout("dingtalk@src-3f2a1b8c")
    expect(ok).toBe(true)
    expect(logoutCalled).toBe(1)
  })
})
