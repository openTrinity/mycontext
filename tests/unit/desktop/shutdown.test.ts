/**
 * 关闭流程的分步执行器。
 *
 * ## ★ 这里锁的是「退不出去」这一类失效
 *
 * `dispose()` 的每一步都在等外部世界（ACP 的 session/dispose 走 JSON-RPC
 * 到 opencode 子进程、DWS 子进程收尾约 0.6s、kl 子进程的 SIGTERM）。
 * 首版是一串裸 `await` 套一个 `try/catch`，两个后果：
 *
 * ① **没有超时** —— 任一步不返回就是退不出去。而 `before-quit` 已经
 *    `preventDefault()` 了：窗口关了、进程还在、Dock 图标赖着不走，
 *    而下一次启动会撞单实例锁直接退出（表现是"应用打不开了"）。
 * ② **第一个抛错跳过后面所有步骤**（同一个 try 块）—— 而 `store.close()`
 *    排在最后，它是唯一有持久化后果的那一步。
 *
 * 所以这四条行为都要锁死：超时后继续、失败后继续、晚到的结果被记录、
 * 同步抛出也能被接住。
 *
 * 用假时钟与假 logger（纯函数 + 注入），所以不需要起 Electron。
 */
import { describe, expect, it, vi } from "vitest"
import type { Clock, Logger } from "@mycontext/kernel"
import { runShutdownStep, HARD_EXIT_MS, SHUTDOWN_STEP_TIMEOUTS } from "@main/bootstrap/shutdown"

interface Entry {
  level: "info" | "warn" | "error" | "debug"
  message: string
  fields?: Record<string, unknown>
}

/** 记下每条日志。退出路径上"发生了什么"只能靠日志回答。 */
function fakeLogger(): { logger: Logger; entries: Entry[] } {
  const entries: Entry[] = []
  const push = (level: Entry["level"]) => (message: string, fields?: Record<string, unknown>) => {
    entries.push(fields === undefined ? { level, message } : { level, message, fields })
  }
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => logger,
  }
  return { logger, entries }
}

/** 只推进"读到的时间"，不参与超时判定（超时用真定时器 + vi 假计时器）。 */
function fakeClock(startMs = 1_000): Clock {
  let now = startMs
  return {
    now: () => {
      now += 5
      return now
    },
  } as Clock
}

function runner() {
  const { logger, entries } = fakeLogger()
  return { options: { logger, clock: fakeClock() }, entries }
}

describe("★ 正常完成", () => {
  it("同步动作 → completed，并记开始与结束", async () => {
    const { options, entries } = runner()
    const result = await runShutdownStep(options, "db", () => undefined)
    expect(result).toBe("completed")
    expect(entries.map((e) => e.message)).toEqual([
      "shutdown step started",
      "shutdown step finished",
    ])
  })

  it("异步动作 → completed", async () => {
    const { options } = runner()
    const result = await runShutdownStep(options, "persona", () => Promise.resolve("ok"))
    expect(result).toBe("completed")
  })
})

describe("★ 失败不打断后续步骤", () => {
  it("异步 reject → failed（**不抛出**，否则后面的步骤全被跳过）", async () => {
    const { options, entries } = runner()
    const result = await runShutdownStep(options, "search", () =>
      Promise.reject(new Error("acp 挂了")),
    )
    expect(result).toBe("failed")
    const warn = entries.find((e) => e.level === "warn")
    expect(warn?.message).toBe("shutdown step failed")
    // 原因要记下来 —— 退出路径上没有第二次机会看它
    expect(warn?.fields?.["detail"]).toBe("acp 挂了")
  })

  it("★ **同步**抛出也要被接住（裸 throw 会穿透整个 dispose）", async () => {
    const { options } = runner()
    const result = await runShutdownStep(options, "klServer", () => {
      throw new Error("同步炸了")
    })
    expect(result).toBe("failed")
  })

  it("连续两步：前一步失败，后一步照常跑（这就是分步的意义）", async () => {
    const { options } = runner()
    const first = await runShutdownStep(options, "search", () => Promise.reject(new Error("x")))
    const second = await runShutdownStep(options, "db", () => undefined)
    expect(first).toBe("failed")
    expect(second).toBe("completed")
  })
})

describe("★ 超时后继续，且晚到的结果要留痕", () => {
  it("永不 settle 的动作 → timed-out（不是挂死）", async () => {
    vi.useFakeTimers()
    try {
      const { options, entries } = runner()
      // 永远不返回 —— 正是 ACP dispose 卡住时的形状
      const promise = runShutdownStep(options, "search", () => new Promise<void>(() => undefined))
      await vi.advanceTimersByTimeAsync(SHUTDOWN_STEP_TIMEOUTS.search + 10)
      expect(await promise).toBe("timed-out")
      const warn = entries.find((e) => e.level === "warn")
      expect(warn?.message).toBe("shutdown step timed out; continuing")
      expect(warn?.fields?.["timeoutMs"]).toBe(SHUTDOWN_STEP_TIMEOUTS.search)
    } finally {
      vi.useRealTimers()
    }
  })

  it("★ 超时之后才完成的动作要补一条日志（否则分不清「慢」与「死」）", async () => {
    vi.useFakeTimers()
    try {
      const { options, entries } = runner()
      /**
       * `let settle: (() => void) | null = null` 会被 TS 窄化成 `never`
       * （赋值发生在回调里，控制流分析看不到）。用一个显式的容器绕开 ——
       * 加 `as` 会把这个真实的类型信息盖住。
       */
      const gate: { settle: (() => void) | undefined } = { settle: undefined }
      const promise = runShutdownStep(
        options,
        "dataPlane",
        () =>
          new Promise<void>((resolve) => {
            gate.settle = resolve
          }),
      )
      await vi.advanceTimersByTimeAsync(SHUTDOWN_STEP_TIMEOUTS.dataPlane + 10)
      expect(await promise).toBe("timed-out")

      // 它其实只是慢 —— 晚到了
      gate.settle?.()
      await vi.advanceTimersByTimeAsync(1)
      expect(entries.some((e) => e.message === "shutdown step finished after timeout")).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("★ 超时之后才失败的动作也要 catch（无人处理的 rejection 会改退出码）", async () => {
    vi.useFakeTimers()
    try {
      const { options, entries } = runner()
      const gate: { fail: ((error: Error) => void) | undefined } = { fail: undefined }
      const promise = runShutdownStep(
        options,
        "distill",
        () =>
          new Promise<void>((_resolve, reject) => {
            gate.fail = reject
          }),
      )
      await vi.advanceTimersByTimeAsync(SHUTDOWN_STEP_TIMEOUTS.distill + 10)
      expect(await promise).toBe("timed-out")

      gate.fail?.(new Error("晚到的错误"))
      await vi.advanceTimersByTimeAsync(1)
      expect(entries.some((e) => e.message === "shutdown step failed after timeout")).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("★ 超时预算本身", () => {
  it("每一步都有预算（漏配会让那一步无超时 = 回到首版的卡死）", () => {
    for (const step of ["search", "klServer", "persona", "distill", "dataPlane", "db"] as const) {
      expect(SHUTDOWN_STEP_TIMEOUTS[step]).toBeGreaterThan(0)
    }
  })

  /**
   * 硬超时刻意**小于**各步预算之和：正常退出远快于"每步都拖满"，
   * 而真拖满时用户已经等了 8 秒 —— 再等下去与卡死没有区别。
   */
  it("硬超时小于各步之和（它是兜底，不是各步的上界）", () => {
    const total = Object.values(SHUTDOWN_STEP_TIMEOUTS).reduce((sum, ms) => sum + ms, 0)
    expect(HARD_EXIT_MS).toBeLessThan(total)
    // 但也不能太小 —— 否则正常退出会被它打断
    expect(HARD_EXIT_MS).toBeGreaterThanOrEqual(5_000)
  })
})
