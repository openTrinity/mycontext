/**
 * 退出确认流的**判定逻辑**。
 *
 * ## 这里锁的四件事
 *
 * ① **勾了"下次别问"就不该再问**。回归风险：偏好读取失败时错误地
 *    走"suppressed=true"分支——那让用户永远看不到确认框，也就没机会取消。
 * ② **取消要真的取消**。渲染层回 `confirmed:false` → confirmQuit 返回
 *    false，调用侧才有依据不跑 dispose。这是"⌘Q 反悔"的唯一挂靠点。
 * ③ **渲染层不回话时放行**。白屏 / 崩溃 / 事件被异常吃掉都会走到这里。
 *    之前踩过一次的形状是"提问出不来结果连退出也走不下去" ——
 *    用户唯一的出路是强制退出。
 * ④ **无窗口时回落原生框**（macOS 关窗不退应用，此时 ⌘Q 仍会来）。
 *
 * 用假的 dialog / preferences / logger / awaitDecision（纯函数 + 注入），
 * 所以不需要起 Electron。
 */
import { describe, expect, it, vi } from "vitest"

/**
 * ★ Mock 必须**在 import 被测模块之前**注册。
 *
 * `quit-flow` 顶层 `import { app, dialog } from "electron"`，
 * vitest 会把 vi.mock 提升到文件顶部，但那前提是它写在被测模块的 import
 * 之前。写成"先 import 再 mock"实测会拿到真 electron 而在 Node 里跑不起来。
 */
vi.mock("electron", () => ({
  app: { getLocale: () => "zh-CN" },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
  },
}))

import { dialog } from "electron"
import type { BrowserWindow } from "electron"
import { confirmQuit, DECISION_TIMEOUT_MS } from "@main/bootstrap/quit-flow"
import type { PreferencesService } from "@main/services/preferences.service"
import type { QuitDecision } from "@mycontext/ipc-contract"

interface Entry {
  level: string
  message: string
}

function fakeLogger() {
  const entries: Entry[] = []
  const push = (level: string) => (message: string) => {
    entries.push({ level, message })
  }
  return {
    logger: {
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      debug: push("debug"),
      child() {
        return this
      },
    },
    entries,
  }
}

/**
 * 只暴露 confirmQuit 用到的方法。用真实类型做 cast，避免测试与实现的
 * 方法名漂移——哪天把 `setQuitConfirmSuppressed` 改名，编译会先红。
 */
function fakePreferences(overrides: {
  suppressed?: boolean
  language?: "zh" | "en" | "system"
  setSpy?: (value: boolean) => void
}): PreferencesService {
  return {
    language: () => overrides.language ?? "zh",
    quitConfirmSuppressed: () => overrides.suppressed ?? false,
    setQuitConfirmSuppressed: (value: boolean) => {
      overrides.setSpy?.(value)
      return true as const
    },
    setLanguage: () => true as const,
  } as unknown as PreferencesService
}

/** 假窗口：只需要 `isDestroyed` 与 `webContents.send` 两件事。 */
function fakeWindow(sent: string[]): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string) => sent.push(channel),
    },
  } as unknown as BrowserWindow
}

/** 有窗口时的标配依赖，`decision` 决定渲染层回什么（null = 不回话）。 */
function depsWithRenderer(
  decision: QuitDecision | null,
  prefs = fakePreferences({}),
  onTimeout?: (ms: number) => void,
) {
  const { logger, entries } = fakeLogger()
  const sent: string[] = []
  return {
    deps: {
      preferences: prefs,
      logger,
      getWindow: () => fakeWindow(sent),
      awaitDecision: (timeoutMs: number) => {
        onTimeout?.(timeoutMs)
        return Promise.resolve(decision)
      },
    },
    entries,
    sent,
  }
}

const showMessageBox = vi.mocked(dialog.showMessageBox)

describe("★ 已勾抑制 → 不问、直接放行", () => {
  it("suppressed=true 时既不推事件也不弹原生框", async () => {
    showMessageBox.mockClear()
    const { deps, sent } = depsWithRenderer(null, fakePreferences({ suppressed: true }))
    expect(await confirmQuit(deps)).toBe(true)
    expect(sent).toEqual([])
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})

describe("★ 有窗口 → 让渲染层画确认框（不走原生 messageBox）", () => {
  it("推 shell:quit-requested 给渲染层，且**不**调 showMessageBox", async () => {
    showMessageBox.mockClear()
    const { deps, sent } = depsWithRenderer({ confirmed: true, dontAskAgain: false })
    expect(await confirmQuit(deps)).toBe(true)
    expect(sent).toEqual(["mycontext:shell/quit-requested"])
    // 这条是本次改动的核心：原生灰框不该再出现在正常路径上
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it("用户选『取消』→ 返回 false（调用侧据此不走 dispose）", async () => {
    const { deps } = depsWithRenderer({ confirmed: false, dontAskAgain: false })
    expect(await confirmQuit(deps)).toBe(false)
  })

  it("『退出』+ 勾『下次别问』→ 落盘 suppressed=true", async () => {
    let stored: boolean | null = null
    const prefs = fakePreferences({ setSpy: (v) => (stored = v) })
    const { deps } = depsWithRenderer({ confirmed: true, dontAskAgain: true }, prefs)
    expect(await confirmQuit(deps)).toBe(true)
    expect(stored).toBe(true)
  })

  it("取消时即便带了 dontAskAgain 也**不落盘**（自相矛盾的组合）", async () => {
    let stored: boolean | null = null
    const prefs = fakePreferences({ setSpy: (v) => (stored = v) })
    const { deps } = depsWithRenderer({ confirmed: false, dontAskAgain: true }, prefs)
    expect(await confirmQuit(deps)).toBe(false)
    expect(stored).toBe(null)
  })

  it("落盘抛错也**不阻塞退出**（最坏是下次还问一次）", async () => {
    const prefs = fakePreferences({})
    prefs.setQuitConfirmSuppressed = () => {
      throw new Error("db 关了")
    }
    const { deps, entries } = depsWithRenderer({ confirmed: true, dontAskAgain: true }, prefs)
    expect(await confirmQuit(deps)).toBe(true)
    expect(entries.some((e) => e.level === "warn")).toBe(true)
  })

  it("★ 渲染层不回话 → 放行（否则表现是「⌘Q 没反应」）", async () => {
    const { deps, entries } = depsWithRenderer(null)
    expect(await confirmQuit(deps)).toBe(true)
    expect(entries.some((e) => e.level === "warn" && /did not answer/.test(e.message))).toBe(true)
  })

  it("等待用的是 DECISION_TIMEOUT_MS（漏传会变成无限等 = 退不出去）", async () => {
    let seen: number | null = null
    const { deps } = depsWithRenderer({ confirmed: true, dontAskAgain: false }, undefined, (ms) => {
      seen = ms
    })
    await confirmQuit(deps)
    expect(seen).toBe(DECISION_TIMEOUT_MS)
  })

  it("awaitDecision 抛错 → 放行", async () => {
    const { logger, entries } = fakeLogger()
    const ok = await confirmQuit({
      preferences: fakePreferences({}),
      logger,
      getWindow: () => fakeWindow([]),
      awaitDecision: () => Promise.reject(new Error("bridge 挂了")),
    })
    expect(ok).toBe(true)
    expect(entries.some((e) => e.level === "warn")).toBe(true)
  })
})

describe("★ 没有窗口 → 回落原生框（macOS 关窗不退应用）", () => {
  it("走 showMessageBox，选『退出』→ true", async () => {
    showMessageBox.mockClear()
    showMessageBox.mockResolvedValueOnce({
      response: 0,
      checkboxChecked: false,
    } as Awaited<ReturnType<typeof dialog.showMessageBox>>)
    const { logger } = fakeLogger()
    const ok = await confirmQuit({
      preferences: fakePreferences({}),
      logger,
      getWindow: () => null,
      // 无窗口路径不该用到它
      awaitDecision: () => Promise.reject(new Error("不该被调用")),
    })
    expect(ok).toBe(true)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it("选『取消』→ false", async () => {
    showMessageBox.mockResolvedValueOnce({
      response: 1,
      checkboxChecked: false,
    } as Awaited<ReturnType<typeof dialog.showMessageBox>>)
    const { logger } = fakeLogger()
    const ok = await confirmQuit({
      preferences: fakePreferences({}),
      logger,
      getWindow: () => null,
      awaitDecision: () => Promise.resolve(null),
    })
    expect(ok).toBe(false)
  })

  it("原生框自己抛错 → 仍放行（否则退不出去）", async () => {
    showMessageBox.mockRejectedValueOnce(new Error("dialog 挂了"))
    const { logger, entries } = fakeLogger()
    const ok = await confirmQuit({
      preferences: fakePreferences({}),
      logger,
      getWindow: () => null,
      awaitDecision: () => Promise.resolve(null),
    })
    expect(ok).toBe(true)
    expect(entries.some((e) => e.level === "warn")).toBe(true)
  })
})
