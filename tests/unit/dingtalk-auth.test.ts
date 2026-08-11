/**
 * DWS 授权输出解析测试。
 *
 * fixture 全部来自对真实 `dws-darwin-arm64` 的实测输出（已授权、device 登录、
 * loopback 登录），未授权/异常形态无法实测（跑 `auth logout` 会清掉真实登录态），
 * 因此那几条按「DWS 可能的返回形态」构造，并统一断言落到安全的一侧：
 * 宁可判成未授权多问一次，也不能把未授权误判成已授权。
 */
import { describe, expect, it } from "vitest"
import {
  daysUntil,
  DingTalkAuth,
  extractAuthUrl,
  extractDeviceCode,
  extractDeviceExpiry,
  extractDeviceVerifyUrl,
  extractJsonObject,
  extractPatAuthorizationUrl,
  parseAuthStatus,
} from "@mycontext/channels"
import type { AuthProgress } from "@mycontext/channels"
import { createLogger } from "@mycontext/kernel"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"

const NOW = new Date("2026-07-28T11:20:00.000Z")

/** 实测输出：已授权 */
const AUTHORIZED = JSON.stringify({
  success: true,
  authenticated: true,
  refreshed: true,
  token_valid: true,
  refresh_token_valid: true,
  expires_at: "2026-07-28T21:17:54.333966+08:00",
  refresh_expires_at: "2026-08-27T19:17:54.333966+08:00",
  corp_id: "dingexampleorgid0001",
  corp_name: "（公司）",
  user_id: "100001",
  user_name: "高鹏",
})

describe("parseAuthStatus：已授权", () => {
  it("解析出组织、用户与两个到期时间", () => {
    const status = parseAuthStatus(AUTHORIZED, NOW)
    expect(status).toMatchObject({
      state: "authorized",
      corpId: "dingexampleorgid0001",
      corpName: "（公司）",
      userId: "100001",
      userName: "高鹏",
    })
  })

  it("算出距重新授权的剩余天数（向下取整）", () => {
    const status = parseAuthStatus(AUTHORIZED, NOW)
    // NOW=07-28T11:20Z，refresh 到期 08-27T11:17:54Z：差 30 天欠 2 分钟，
    // 向下取整为 29。刻意不四舍五入——「还剩 30 天」比实际多算会让提醒晚一天。
    expect(status.state === "authorized" && status.daysUntilRefreshExpiry).toBe(29)
  })

  it("容忍输出里混有非 JSON 的日志行", () => {
    const noisy = `● 正在检查登录态...\n${AUTHORIZED}\n`
    expect(parseAuthStatus(noisy, NOW).state).toBe("authorized")
  })
})

describe("parseAuthStatus：未授权与异常", () => {
  it("authenticated 为 false 且无身份痕迹 → unauthorized", () => {
    const raw = JSON.stringify({ success: true, authenticated: false })
    expect(parseAuthStatus(raw, NOW)).toEqual({ state: "unauthorized" })
  })

  it("body 带 error 即视为未授权（哪怕 exit code 是 0）", () => {
    const raw = JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "not logged in" } })
    expect(parseAuthStatus(raw, NOW)).toEqual({ state: "unauthorized" })
  })

  it("空输出 / 非法 JSON → unauthorized，不抛错", () => {
    expect(parseAuthStatus("", NOW)).toEqual({ state: "unauthorized" })
    expect(parseAuthStatus("panic: runtime error", NOW)).toEqual({ state: "unauthorized" })
    expect(parseAuthStatus("{ not json", NOW)).toEqual({ state: "unauthorized" })
  })

  it("已授权但关键字段缺失 → 不敢当作可用", () => {
    const raw = JSON.stringify({
      authenticated: true,
      refresh_expires_at: "2026-08-27T19:17:54+08:00",
      corp_name: "（公司）",
      // 缺 corp_id / user_id
    })
    expect(parseAuthStatus(raw, NOW).state).not.toBe("authorized")
  })
})

describe("parseAuthStatus：过期", () => {
  /**
   * ★★ 实测抓的：**per-vault 目录里某个身份的凭据过期**时的真实输出。
   *
   * 每个身份一份 profiles 目录之后，"这个身份过期了而别的还好"变成了
   * 常见状态。而它的 payload **没有** `corp_name` / `user_name`
   * （上游只在 message 里提了一句 profile 标识）：
   * ```
   * { success:true, authenticated:false,
   *   reason:"token_refresh_failed",
   *   message:"Token 刷新失败: 旧版登录态已无法由当前认证服务刷新…" }
   * ```
   *
   * 补 `reason` 判据之前它退化成 `unauthorized` —— 安全性没问题
   * （fail-closed 那一侧），但界面会说「授权钉钉」而不是「重新授权」，
   * 也就是把"这个身份需要续期"说成了"你还没连过钉钉"，
   * 而用户明明看得到那个身份就在列表里。
   *
   * ★ 值已脱敏（CLAUDE.md §1.2），形状与字段照实测。
   */
  it("★★ reason=token_refresh_failed 且**没有**组织名/真名 → 仍判 expired", () => {
    const raw = JSON.stringify({
      success: true,
      authenticated: false,
      reason: "token_refresh_failed",
      message:
        'Token 刷新失败: 旧版登录态已无法由当前认证服务刷新；本地 profile 已保留…\nprofile: "dingFAKECORP0001:100001": MCP token exchange failed',
      hint: "请重新运行 dws auth login 完成授权。",
    })
    // 名字缺就缺（`expired` 的两个字段本来可选，界面对它们有兜底）
    expect(parseAuthStatus(raw, NOW)).toEqual({ state: "expired" })
  })

  /**
   * ★ 反证：**别的** reason 不该被顺手当成"登录过"。
   *
   * 比如 `http_401` 是**请求**失败（网关拒了），它不构成"这台机器登录过
   * 这个身份"的证据 —— 判成 expired 会让界面说「重新授权」，
   * 而用户可能根本没连过。这条锁住 `EXPIRED_REASONS` 是个**白名单**
   * 而不是"有 reason 就算登录过"。
   */
  it("★ 其它 reason（http_401 等）仍判 unauthorized，不放宽成 expired", () => {
    const raw = JSON.stringify({
      success: true,
      authenticated: false,
      reason: "http_401",
    })
    expect(parseAuthStatus(raw, NOW)).toEqual({ state: "unauthorized" })
  })

  it("refresh_token_valid 为 false → expired 并保留身份用于提示", () => {
    const raw = JSON.stringify({
      authenticated: true,
      refresh_token_valid: false,
      refresh_expires_at: "2026-06-01T00:00:00+08:00",
      corp_name: "（公司）",
      user_name: "高鹏",
      corp_id: "c",
      user_id: "u",
    })
    expect(parseAuthStatus(raw, NOW)).toEqual({
      state: "expired",
      corpName: "（公司）",
      userName: "高鹏",
    })
  })

  it("refresh 到期时间已过 → expired（即使 authenticated 仍为 true）", () => {
    const raw = JSON.stringify({
      authenticated: true,
      refresh_token_valid: true,
      refresh_expires_at: "2026-07-01T00:00:00+08:00",
      corp_id: "c",
      corp_name: "（公司）",
      user_id: "u",
      user_name: "高鹏",
    })
    expect(parseAuthStatus(raw, NOW).state).toBe("expired")
  })

  it("未认证但有身份痕迹 → expired（提示「重新授权」比「去授权」准确）", () => {
    const raw = JSON.stringify({ authenticated: false, corp_name: "（公司）" })
    expect(parseAuthStatus(raw, NOW)).toEqual({ state: "expired", corpName: "（公司）" })
  })
})

describe("daysUntil", () => {
  it("向下取整，过期返回负数", () => {
    expect(daysUntil("2026-07-30T11:20:00.000Z", NOW)).toBe(2)
    expect(daysUntil("2026-07-27T11:20:00.000Z", NOW)).toBe(-1)
  })

  it("非法时间返回 0 而不是 NaN（NaN 会让 UI 显示「NaN 天后过期」）", () => {
    expect(daysUntil("not-a-date", NOW)).toBe(0)
  })
})

describe("extractJsonObject", () => {
  it("从横幅 + JSON 的混合输出里取出对象", () => {
    expect(extractJsonObject('banner\n{"a":1}\ntail')).toEqual({ a: 1 })
  })

  it("没有对象时返回 undefined", () => {
    expect(extractJsonObject("no json here")).toBeUndefined()
  })
})

describe("登录输出解析（fixture 来自实测）", () => {
  it("从 loopback 输出里提取授权 URL", () => {
    const line =
      "  https://login.dingtalk.com/oauth2/auth?client_id=dingmbw5n9ktkkbbjv3g&prompt=consent&redirect_uri=http%3A%2F%2F127.0.0.1%3A63940%2Fcallback&response_type=code&scope=openid+corpid"
    expect(extractAuthUrl(line)).toContain("client_id=dingmbw5n9ktkkbbjv3g")
    expect(extractAuthUrl("无关行")).toBeUndefined()
  })

  it("从 DWS PAT 输出里提取授权范围页 URL", () => {
    const url =
      "https://open-dev.dingtalk.com/fe/old?hash=%23%2FpersonalAuthorization%3FflowId%3Dflow-1%26userCode%3DABCD-EFGH#/personalAuthorization?flowId=flow-1&userCode=ABCD-EFGH"
    expect(extractPatAuthorizationUrl(`  授权链接: ${url}`)).toBe(url)
    expect(extractPatAuthorizationUrl(`\u001b[36m授权链接: ${url}\u001b[0m`)).toBe(url)
    expect(
      extractPatAuthorizationUrl("https://example.com/not-an-authorization-page"),
    ).toBeUndefined()
  })

  it("从 device 输出里提取授权码（带表格边框）", () => {
    expect(extractDeviceCode("  │    授权码: GFZP-MCVP                    │")).toBe("GFZP-MCVP")
    expect(extractDeviceCode("授权码：ABCD-1234")).toBe("ABCD-1234")
  })

  it("也能从 verify URL 里回退提取授权码", () => {
    const line = "https://login.dingtalk.com/oauth2/device/verify.htm?user_code=GFZP-MCVP"
    expect(extractDeviceCode(line)).toBe("GFZP-MCVP")
  })

  it("提取 verify URL 并去掉粘连的表格边框", () => {
    const line = "  │    https://login.dingtalk.com/oauth2/device/verify.htm?user_code=GFZP-MCVP  │"
    expect(extractDeviceVerifyUrl(line)).toBe(
      "https://login.dingtalk.com/oauth2/device/verify.htm?user_code=GFZP-MCVP",
    )
  })

  it("提取授权码有效期", () => {
    expect(extractDeviceExpiry("  │  授权码将在 900 秒后过期。  │")).toBe(900)
    expect(extractDeviceExpiry("无关行")).toBeUndefined()
  })

  it("不把普通文本误当成授权码", () => {
    expect(extractDeviceCode("Step 1: 请求设备授权码...")).toBeUndefined()
  })
})

describe("DingTalkAuth：OAuth 后继续完成 PAT 范围授权", () => {
  it("显式启用推荐权限，并依次打开登录页与授权范围页", async () => {
    const loginUrl =
      "https://login.dingtalk.com/oauth2/auth?client_id=test&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback"
    const scopeUrl =
      "https://open-dev.dingtalk.com/fe/old#/personalAuthorization?flowId=flow-1&userCode=ABCD-EFGH"
    const opened: string[] = []
    const progress: AuthProgress[] = []
    let spawnArgs: string[] = []
    let timeoutMs = 0

    const processes = {
      spawn: async (spec: {
        args: string[]
        timeoutMs?: number
        onLine: (line: string, stream: "stdout" | "stderr") => void
      }) => {
        spawnArgs = spec.args
        timeoutMs = spec.timeoutMs ?? 0
        spec.onLine(loginUrl, "stderr")
        spec.onLine(`授权链接: ${scopeUrl}`, "stderr")
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
      },
      exec: async () => ({
        exitCode: 0,
        stdout: AUTHORIZED,
        stderr: "",
        timedOut: false,
      }),
    } as unknown as ProcessRunner
    const runtime = {
      resolve: () => ({ name: "dws", path: "/tmp/dws", platform: "test", source: "bundled" }),
      buildEnv: () => ({}),
      /**
       * ★ 没绑身份 —— 这条用例测的是**首次授权**（还没有 vault 映射行）。
       *
       * `login()` 在钉住了身份时会再用 `pinned: true` 复查一次（那是
       * "报成功、随后全部未登录"那个 bug 的门禁，见 auth.ts 里那段）。
       * 首次授权这一档两次复查等价，所以给 false 保持这条用例原来的语义。
       */
      hasPinnedIdentity: () => false,
    } as unknown as RuntimeEnv
    const auth = new DingTalkAuth({
      runtime,
      processes,
      logger: createLogger("DingTalkAuthTest", { level: "error" }),
      openExternal: (url) => {
        opened.push(url)
        return Promise.resolve()
      },
    })

    const status = await auth.login({
      mode: "loopback",
      signal: new AbortController().signal,
      onProgress: (event) => progress.push(event),
    })

    expect(status.state).toBe("authorized")
    expect(spawnArgs).toEqual(["auth", "login", "--no-browser", "--recommend", "-f", "table"])
    expect(timeoutMs).toBeGreaterThan(15 * 60 * 1000)
    expect(opened).toEqual([loginUrl, scopeUrl])
    expect(progress).toContainEqual({ phase: "scope-authorization", url: scopeUrl })
  })
})
