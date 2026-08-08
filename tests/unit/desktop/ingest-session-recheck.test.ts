/**
 * `SESSION_EXPIRED` 进 blocked 之前必须先用 `auth status` 复核。
 *
 * ## 为什么需要这一层测试
 *
 * 渠道 CLI 的 token 刷新是**懒惰**的：access token 只活 2 小时，到点后由
 * "下一条命令"就地走 refresh，而 refresh 要发网络请求。于是存在一个不归
 * 我们控制的窗口 —— **刷新恰好撞上睡眠或断网**。这时 CLI 报的是
 * `not_authenticated` + exit 2，与"refresh token 真的过期了"**完全同形**。
 *
 * 实测（2026-08-08 本机）：系统 `Entering Sleep` 与那 4 条失败命令同一秒
 * （13:11:05）；CLI 侧 `auth_token_present:false` 在 6756 条命令里只出现过
 * 这 4 次。而 `blockedReason` 一置位，6 处闸门全部静默 return，采集
 * **停了 2.5 小时** —— 登录却从头到尾都是好的。
 *
 * 所以判据是「去问权威来源」：`auth status` 仍 authorized ⇒ 瞬时故障。
 * 这条判据很容易在重构时被改回"exit 2 就是终态"，故在此固化。
 */
import { describe, expect, it } from "vitest"
import { AppError, createLogger, ManualClock } from "@mycontext/kernel"
import type { AuthStatus, ChannelPlugin } from "@mycontext/channels"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"

/** CLI 未登录时的原样错误 —— 与 `classifyDwsError` 对 exit 2 的产物一致。 */
function sessionExpired(): AppError {
  return new AppError("SESSION_EXPIRED", "渠道登录已过期，需要重新授权", {
    retryable: false,
    context: { code: 2 },
  })
}

const AUTHORIZED: AuthStatus = {
  state: "authorized",
  corpId: "dingFAKE0001",
  corpName: "示例组织",
  userId: "10001",
  userName: "张三",
  accessExpiresAt: "2026-01-01T00:00:00+08:00",
  refreshExpiresAt: "2026-01-31T00:00:00+08:00",
  daysUntilRefreshExpiry: 30,
}

/**
 * 探针一抛就走进 `recordError`。
 *
 * @param authStatus 复核时 `auth status` 的应答；传 `"throw"` 模拟复核本身失败
 *   （网络还没恢复 / 命令超时）。
 */
function setup(options: { error: unknown; authStatus: AuthStatus | "throw" }): {
  service: IngestService
  authCalls: number
  close: () => void
} {
  const vault = openTestVault()
  let authCalls = 0
  const plugin = {
    meta: { id: CHANNEL },
    auth: {
      status: async () => {
        authCalls += 1
        if (options.authStatus === "throw") throw new Error("dial tcp: no such host")
        return options.authStatus
      },
    },
    ingest: {
      probe: async () => {
        throw options.error
      },
    },
  } as unknown as ChannelPlugin

  const service = new IngestService({
    db: vault.db,
    clock: new ManualClock(START),
    logger: createLogger("test-session-recheck", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()
  return {
    service,
    get authCalls() {
      return authCalls
    },
    close: () => vault.close(),
  }
}

describe("★★ SESSION_EXPIRED 先复核再决定是否 block", () => {
  it("★★ auth status 仍 authorized（刷新被睡眠打断）→ 不进 blocked，采集继续", async () => {
    const h = setup({ error: sessionExpired(), authStatus: AUTHORIZED })

    await h.service.tickProbe()

    /**
     * 这一条是本文件的核心：登录是好的，那次 exit 2 只是 token 刷新
     * 撞上了睡眠。置了 blocked 就等于让一次瞬时故障永久停采。
     */
    expect(h.service.snapshot().blockedReason).toBeNull()
    // 复核确实去问了权威来源，而不是靠猜时间窗
    expect(h.authCalls).toBe(1)
    // lastError 仍要留着：状态页要能看出"刚刚失败过一轮"
    expect(h.service.snapshot().lastError).not.toBeNull()
    h.close()
  })

  it("★ auth status 报 expired（refresh token 真过期）→ 照旧进 blocked", async () => {
    const h = setup({ error: sessionExpired(), authStatus: { state: "expired" } })

    await h.service.tickProbe()

    expect(h.service.snapshot().blockedReason).toBe("session_expired")
    h.close()
  })

  it("★ 复核本身失败（网络还没恢复）→ 保持 blocked，不退回无限重试", async () => {
    const h = setup({ error: sessionExpired(), authStatus: "throw" })

    await h.service.tickProbe()

    /**
     * 拿不到"登录是好的"这个证明时不能放行：那会退回到
     * `classifyDwsError` 注释里那场无限重试风暴。宁可要求用户介入一次。
     */
    expect(h.service.snapshot().blockedReason).toBe("session_expired")
    h.close()
  })

  it("★ PERMISSION_REQUIRED 不复核（缺 scope 与登录态无关）", async () => {
    const h = setup({
      error: new AppError("PERMISSION_REQUIRED", "缺少授权，需要在来源应用中确认", {
        retryable: false,
      }),
      authStatus: AUTHORIZED,
    })

    await h.service.tickProbe()

    expect(h.service.snapshot().blockedReason).toBe("permission_required")
    /**
     * 复核对它无意义：登录好得很，缺的是 scope。多打一条 `auth status`
     * 只是白起一个子进程 —— 而那是每轮采集都要付的成本。
     */
    expect(h.authCalls).toBe(0)
    h.close()
  })
})
