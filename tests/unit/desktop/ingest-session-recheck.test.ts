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

/**
 * ★★ 已经 blocked 之后的**出路** —— 上面那组管"要不要进去"，这组管"怎么出来"。
 *
 * ## 为什么两组都要有：进得去出不来，等于永久停采
 *
 * 上面那组保证「瞬时故障不进 blocked」。但 refresh token 真过期时它**应该**
 * 进 blocked（那条断言就在上面）。问题是进去之后怎么出来 —— 修复前
 * `blockedReason` 只能由 `clearBlocked()` 清掉，而它的调用方只有状态页那个
 * 关闭按钮、IPC 重试、post-auth 钩子。**定时轮询不重新探活。**
 *
 * 于是这条真实链路会永久卡住（实测，2026-08-08 本机日志）：
 *
 * 1. 睡眠期间 refresh 真的失败到过期 → 进 blocked（符合预期）；
 * 2. 用户在终端 / 别处重新授权，CLI 把 token 刷好了；
 * 3. **没有人调 `clearBlocked()`** → 六处闸门继续全关：
 *    ```
 *    ingest round skipped {"reason":"blocked","route":"pull","blockedReason":"session_expired"}
 *    ingest round skipped {"reason":"blocked","route":"documents","blockedReason":"session_expired"}
 *    ```
 *    而同一时刻手工 `auth status` 是 `authenticated: true, refreshed: true`。
 *    登录早就好了，只有应用还卡着，界面显示「未连接」。
 *
 * 用户唯一的出路是重启应用或恰好找到那个提示去点一下 —— 而两者都不该是
 * 「登录已经好了」的必要条件。
 */
describe("★★ blocked 之后能自愈（登录恢复即解闸）", () => {
  /** 与 `SESSION_RECHECK_INTERVAL_MS` 同值。写死一份是刻意的：那个常量变了这里要红。 */
  const RECHECK_MS = 5 * 60_000

  /**
   * 造一个**登录态可切换**的 setup：`state` 改了下一次 `auth status` 就变答案。
   *
   * 与上面那个 `setup` 分开是因为这组要的是"先坏后好"，
   * 而那个的 `authStatus` 在构造时就定死了。
   */
  function healable(): {
    service: IngestService
    clock: ManualClock
    state: { authorized: boolean; probeFails: boolean }
    authCalls: () => number
    close: () => void
  } {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const state = { authorized: false, probeFails: true }
    let authCalls = 0
    const plugin = {
      meta: { id: CHANNEL },
      auth: {
        status: async () => {
          authCalls += 1
          return state.authorized ? AUTHORIZED : { state: "expired" as const }
        },
      },
      ingest: {
        probe: async () => {
          if (state.probeFails) throw sessionExpired()
          return null
        },
      },
    } as unknown as ChannelPlugin

    const service = new IngestService({
      db: vault.db,
      clock,
      logger: createLogger("test-session-heal", { level: "error" }),
      plugin,
      dbPath: vault.path,
      autoStart: false,
    })
    service.start()
    return { service, clock, state, authCalls: () => authCalls, close: () => vault.close() }
  }

  it("★★ 登录恢复 + 到了复核间隔 → 自动解闸，不需要用户点任何东西", async () => {
    const h = healable()

    // ① refresh token 真过期 → 进 blocked（上面那组已断言这是对的行为）
    await h.service.tickProbe()
    expect(h.service.snapshot().blockedReason).toBe("session_expired")

    // ② 用户重新授权了，但还没到复核间隔 —— 仍然闸住（节流生效）
    h.state.authorized = true
    h.state.probeFails = false
    h.clock.advance(RECHECK_MS - 1)
    await h.service.tickProbe()
    expect(h.service.snapshot().blockedReason).toBe("session_expired")

    // ③ 过了复核间隔 → 自动解闸
    h.clock.advance(2)
    await h.service.tickProbe()
    expect(h.service.snapshot().blockedReason).toBeNull()

    h.close()
  })

  it("★ 登录仍然无效时保持闸住（复核过 ≠ 放行）", async () => {
    const h = healable()
    await h.service.tickProbe()
    expect(h.service.snapshot().blockedReason).toBe("session_expired")

    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(RECHECK_MS + 1)
      await h.service.tickProbe()
      expect(h.service.snapshot().blockedReason).toBe("session_expired")
    }
    h.close()
  })

  /**
   * ★ 复核必须**节流** —— 它是一次真实子进程调用（实测 0.3–2s）。
   *
   * 探针是最高频的那一路，不节流就等于每轮都为一个已知失效的账号
   * 烧一个子进程，而答案不会变。
   */
  it("★ 同一复核窗口内多轮只问一次 auth status", async () => {
    const h = healable()
    await h.service.tickProbe()
    const afterFirst = h.authCalls()

    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(1_000)
      await h.service.tickProbe()
    }
    expect(h.authCalls()).toBe(afterFirst)
    h.close()
  })
})
