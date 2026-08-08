/**
 * ★★ 渠道 CLI **拒绝覆盖**本地既有登录态时，必须报成一个**可操作**的错误。
 *
 * ## 这一组锁的是一次真实的"把用户钉在墙上"
 *
 * 实测（v1.0.56 / v1.0.57，真实机器，2026-08-08）：本地存在一个旧格式的
 * token 槽（`token.json` 里只有 `updated_at`、没有任何 token 字段），
 * 而同组织下的 profile 又对不上时，`auth login` 直接 `exit=2`：
 *
 * ```
 * [AUTH] dingtalk login failed: 本地登录态无法安全更新:
 * legacy token slot "auth-token" does not safely match the only profile
 * in organization "…"; refusing to overwrite a potentially unique old login
 * ```
 *
 * 修复前这个失败被归进 `authNotDetected`（「授权流程结束但未检测到有效
 * 登录态，**请重试**」）。而它的 exit code 恒为 2 —— 点一百次撞一百次，
 * 真正的出路是带 `--profile` 在终端跑一次 login 完成迁移。
 *
 * 所以这里锁两件事：
 * · 错误码单独成一类（`CHANNEL_AUTH_LEGACY_TOKEN_SLOT`）；
 * · **`retryable: false`** —— 否则 UI 继续摆一个没用的「重试」按钮。
 *
 * ## ★ 为什么按"特征词"匹配而不是整句
 *
 * 上游的中文前缀与英文主体分属不同版本/语言形态，只匹配一段会在另一种
 * 形态上漏掉（漏掉的表现就是退回那句"请重试"）。所以三个词任一命中即算，
 * 下面逐个形态各有一条断言。
 */
import { describe, expect, it } from "vitest"
import { DingTalkAuth } from "@mycontext/channels"
import { AppError } from "@mycontext/kernel"
import { RuntimeEnv } from "@mycontext/runtime-env"

const NOOP_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOGGER
  },
}

function stubbedRuntime(): RuntimeEnv {
  const runtime = new RuntimeEnv({
    binDir: "/fake/bin",
    dwsChannel: "",
    dwsConfigDir: "/fake/absolute/dws-home",
    dwsProfile: () => undefined,
    env: {},
  })
  Object.defineProperty(runtime, "resolve", {
    value: () => ({ path: "/fake/dws", source: "bundled" }),
    configurable: true,
  })
  return runtime
}

/**
 * 造一个 `login` 会以 `stderr` 失败的 auth。
 *
 * `spawn` 抛错模拟真实的非零退出（`ProcessRunner` 在 exit≠0 时抛 AppError），
 * 因为被测的分支正在那个 catch 里。
 */
function authFailingWith(detail: string): DingTalkAuth {
  return new DingTalkAuth({
    runtime: stubbedRuntime(),
    processes: {
      spawn: async () => {
        throw new AppError("PROCESS_FAILED", detail)
      },
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ success: true, authenticated: false }),
        stderr: "",
        timedOut: false,
      }),
    } as never,
    logger: NOOP_LOGGER as never,
    openExternal: async () => {},
  })
}

/** 最小可用的 `AuthContext`。progress 收进数组供断言。 */
function ctxCollecting(phases: string[]) {
  return {
    mode: "loopback" as const,
    onProgress: (event: { phase: string }) => {
      phases.push(event.phase)
    },
  }
}

describe("DingTalkAuth 识别「拒绝覆盖旧登录槽」", () => {
  /** 三种真实形态。★ 组织 id 是编的（CLAUDE.md §1.2）。 */
  const FORMS: readonly { name: string; detail: string }[] = [
    {
      name: "英文主体（refusing to overwrite）",
      detail:
        'legacy token slot "auth-token" does not safely match the only profile ' +
        'in organization "dingFAKECORP0001"; refusing to overwrite a potentially unique old login',
    },
    {
      name: "只有 does not safely match",
      detail: 'legacy token slot "auth-token" does not safely match the only profile',
    },
    {
      name: "中文前缀",
      detail: "本地登录态无法安全更新: legacy token slot 与当前 profile 不匹配",
    },
  ]

  for (const form of FORMS) {
    it(`${form.name} → CHANNEL_AUTH_LEGACY_TOKEN_SLOT 且 retryable=false`, async () => {
      const phases: string[] = []
      const auth = authFailingWith(form.detail)

      await expect(auth.login(ctxCollecting(phases) as never)).rejects.toMatchObject({
        code: "CHANNEL_AUTH_LEGACY_TOKEN_SLOT",
        /**
         * ★★ 这一条是这组测试的重点。
         * 标 true 会让 UI 摆一个「重试」按钮，而 exit code 恒为 2 ——
         * 那个按钮点多少次都一样，只会让用户以为是自己没点对。
         */
        retryable: false,
      })
      expect(phases).toContain("failed")
    })
  }

  /**
   * ★ 反面：**普通**授权失败仍然走 `CHANNEL_AUTH_FAILED` 且 retryable。
   *
   * 没有这条的话，一个过宽的匹配（比如把 "login failed" 也算进特征词）
   * 会把所有授权失败都变成"不可重试"，而那类失败恰恰重试就能好。
   */
  it("普通失败仍是 CHANNEL_AUTH_FAILED 且 retryable=true", async () => {
    const phases: string[] = []
    const auth = authFailingWith("dingtalk login failed: 网络超时")

    await expect(auth.login(ctxCollecting(phases) as never)).rejects.toMatchObject({
      code: "CHANNEL_AUTH_FAILED",
      retryable: true,
    })
  })

  /**
   * ★ 取消不能被误判成"拒绝写入"。
   *
   * `PROCESS_CANCELLED` 在 catch 里有更早的一条分支（用户主动取消，
   * 要原样抛出让 UI 显示"已取消"）。如果特征词匹配跑到了它前面，
   * 用户点"取消"会看到一句"请去终端迁移登录态"——完全不相干。
   */
  it("用户取消仍抛 PROCESS_CANCELLED", async () => {
    const auth = new DingTalkAuth({
      runtime: stubbedRuntime(),
      processes: {
        spawn: async () => {
          throw new AppError("PROCESS_CANCELLED", "cancelled")
        },
      } as never,
      logger: NOOP_LOGGER as never,
      openExternal: async () => {},
    })
    const phases: string[] = []
    await expect(auth.login(ctxCollecting(phases) as never)).rejects.toMatchObject({
      code: "PROCESS_CANCELLED",
    })
    expect(phases).toContain("cancelled")
  })
})
