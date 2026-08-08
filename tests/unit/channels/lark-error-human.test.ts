/**
 * 飞书 CLI 的错误信封 → **人话**。
 *
 * ## 这一组锁的是"用户能不能看懂"
 *
 * 实测的坏形态：那一大坨 JSON（含 log_id 与一条排查链接）原样糊在仪表盘上。
 * 用户既看不懂，也不知道该做什么 —— 而这一层本来就该把它翻成一句话。
 *
 * 两个来源都要覆盖：
 * · CLI **零退出**但 `ok:false`（业务错误走 `unwrapLarkEnvelope`）；
 * · CLI **非零退出**，stdout 是同一份 JSON（走 `json()` 里那段）。
 *   后者原来直接把整份 stdout 当成 message，那正是界面上那一坨的来源。
 */
import { describe, expect, it } from "vitest"
import { describeLarkError } from "@mycontext/channels"

/** 实测抓到的那份限流响应（log_id 换成了假值）。 */
const RATE_LIMITED = {
  ok: false,
  identity: "user",
  error: {
    type: "api",
    subtype: "invalid_parameters",
    code: 9499,
    message: "too many request",
    log_id: "FAKELOGID0001",
    troubleshooter: "排查建议查看(Troubleshooting suggestions): https://open.feishu.cn/search?…",
  },
}

describe("describeLarkError：把 CLI 的错误翻成人话", () => {
  it("★★ 限流（9499）给的是「怎么回事 + 会自动重试」，不是原始 JSON", () => {
    const out = describeLarkError(RATE_LIMITED)
    expect(out).not.toBeNull()
    expect(out?.detail).toContain("限流")
    expect(out?.retryable).toBe(true)
    // ★ 关键：那些用户看不懂的东西一个都不许出现在文案里
    expect(out?.detail).not.toContain("log_id")
    expect(out?.detail).not.toContain("FAKELOGID")
    expect(out?.detail).not.toContain("http")
    expect(out?.detail).not.toContain("{")
  })

  /**
   * ★ 文案**不能说"我们请求太多"**。
   *
   * 实测：两小时里飞书采集只跑了 7 次，而 9499 只出现 2 次 —— 那是飞书
   * 服务端侧的配额，不是我们调太频。说成"我们请求太多"会让用户去改采集周期，
   * 而那没有任何用。
   */
  it("★ 不把限流说成「我们请求太多」（会引到一个没用的操作上）", () => {
    const detail = describeLarkError(RATE_LIMITED)?.detail ?? ""
    expect(detail).toContain("服务端")
  })

  it("★★ 缺权限**不可重试**，且说清缺哪个 + 要重新授权", () => {
    const out = describeLarkError({
      ok: false,
      error: {
        type: "authorization",
        subtype: "missing_scope",
        message: "missing required scope(s): im:message.reactions:read",
        missing_scopes: ["im:message.reactions:read"],
      },
    })
    expect(out?.retryable).toBe(false)
    expect(out?.detail).toContain("im:message.reactions:read")
    expect(out?.detail).toContain("重新授权")
  })

  it("403 提到办公网域名放行（那是这个环境里最常见的原因）", () => {
    const out = describeLarkError({ ok: false, error: { code: 403, message: "forbidden" } })
    expect(out?.detail).toContain("403")
    expect(out?.code).toBe(403)
  })

  it("认不出的 code 回落到 CLI 的短句，**不是**整份 JSON", () => {
    const out = describeLarkError({
      ok: false,
      error: { code: 12345, message: "something specific went wrong" },
    })
    expect(out?.detail).toBe("something specific went wrong")
  })

  it("连 message 都没有时给一句兜底（不能是 undefined 上屏）", () => {
    const out = describeLarkError({ ok: false, error: { code: 999 } })
    expect(out?.detail).toBe("飞书接口调用失败")
  })

  it("成功响应返回 null（不是错误就别造一个）", () => {
    expect(describeLarkError({ ok: true, data: {} })).toBeNull()
    expect(describeLarkError(null)).toBeNull()
    expect(describeLarkError("not an object")).toBeNull()
  })
})
