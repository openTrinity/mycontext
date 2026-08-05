/**
 * 关闭流程的**分步执行器**。
 *
 * ## 为什么退出需要一个专门的模块（而不是一串 await）
 *
 * `dispose()` 里每一步都在等外部世界：ACP 的 `session/dispose`（走 JSON-RPC
 * 到 opencode 子进程）、DWS 子进程收尾（实测约 0.6s）、kl 子进程的
 * SIGTERM→SIGKILL。这些都可能**永远不返回** —— 而首版是一串裸 `await`、
 * 外面没有任何超时。
 *
 * 后果不是"退出慢"，而是**退不出去**：`before-quit` 已经
 * `preventDefault()` 了，窗口关了、进程还在、Dock 图标赖着不走，
 * 用户唯一的出路是强制退出。而下一次启动会撞上单实例锁
 * （`requestSingleInstanceLock`）直接退出 —— 表现是"应用打不开了"。
 *
 * ## 三条设计（照另一个成熟桌面端的 `lifecycle/shutdown.ts`）
 *
 * 1. **每步独立超时，超时后继续下一步**。一步卡住不该让后面的步骤
 *    也做不了 —— 尤其"关数据库"排在最后，它是唯一有持久化后果的。
 * 2. **晚到的结果也记一条日志**。超时只是"我们不等了"，那个 promise
 *    仍在跑。不记的话事后无从知道它到底是慢还是真的死了。
 * 3. **抛错不打断后续步骤**。一步失败与一步超时对流程的影响一样：
 *    记下来、继续。退出路径上"因为清理失败所以不退出"是最糟的选择。
 *
 * ## ★ 与那个参考实现的一个刻意差异
 *
 * 它只在"更新重启"场景启用分步超时，常规退出**无超时**
 * （注释写的是"避免正常清理步骤被强行打断"）。我们**全都启用** ——
 * 因为我们已经有一个具体的卡死源（`search.shutdown()` 逐 session
 * 走 ACP dispose 且每个都 await），而这个应用没有"更新重启"这个概念。
 *
 * 纯函数 + 注入 logger/clock，所以超时语义可以单测 ——
 * 写在 `index.ts` 里的话要起 Electron 才能测，等于测不了。
 */
import type { Clock, Logger } from "@mycontext/kernel"

/**
 * 各步的超时预算（毫秒）。
 *
 * 取值依据是"这一步正常要多久"，不是随手给的：
 * · `search` —— 逐 session 走 ACP dispose，实测单次约 0.2-1.3s，
 *   会话数可能几十个，给 3s（超了就不管了，opencode 自己会随进程退出而死）；
 * · `klServer` —— **4s**。`DuplexHandle.close()` 的兜底链是
 *   「关 stdin → 0.5s 后 SIGTERM → 3s 后 SIGKILL」（见 process.ts），
 *   也就是最坏 3.5s。原来给 2s 的后果是**每次退出都超时**（实测
 *   `shutdown step timed out {"step":"klServer","durationMs":2001}` 恒定出现）
 *   —— 一条恒定的 warn 等于没有 warn，它会把真正的超时埋掉。
 *   给到 4s 让那条 SIGKILL 兜底能跑完，同时仍远小于硬超时。
 * · `persona` / `distill` —— 等在途的一轮 agent/蒸馏收尾，各 2s；
 * · `dataPlane` —— 等在途的采集轮次（可能正 await 一个 0.6s 的 DWS 子进程），
 *   给 2s；
 * · `db` —— 关库是同步的（better-sqlite3），给 1s 只是防病态情况。
 *
 * 合计约 14s，而硬超时（见 `HARD_EXIT_MS`）是 8s —— 刻意小于合计值：
 * 正常退出远快于各步预算之和（它们不会同时踩上限），
 * 而真出现"每步都拖满"的情况时，用户等 8s 已经够久了。
 */
export const SHUTDOWN_STEP_TIMEOUTS = {
  search: 3_000,
  klServer: 4_000,
  persona: 2_000,
  distill: 2_000,
  dataPlane: 2_000,
  db: 1_000,
} as const

export type ShutdownStep = keyof typeof SHUTDOWN_STEP_TIMEOUTS

/**
 * 整个关闭流程的硬上限。超了就 `app.exit(0)`。
 *
 * 参考实现用 30s。我们取 8s：桌面应用退出时用户正盯着 Dock 图标，
 * 30s 与"卡死了"在体验上没有区别 —— 而我们没有"必须等它写完"的步骤
 * （最坏是丢一轮采集，水位不推进、下次整窗重跑，靠 `payload_hash` 幂等兜住）。
 */
export const HARD_EXIT_MS = 8_000

type StepResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "timed-out" }

async function race<T>(promise: Promise<T>, timeoutMs: number): Promise<StepResult<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race<StepResult<T>>([
      promise
        .then((value): StepResult<T> => ({ status: "completed", value }))
        .catch((error: unknown): StepResult<T> => ({ status: "failed", error })),
      new Promise<StepResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs)
        /**
         * ★ `unref`：这个定时器**不该**拖着进程不退。
         *
         * 它的作用只是"别等太久"，而如果它自己成了最后一个活着的 handle，
         * Node 会为它多活 N 毫秒 —— 那与它的目的正好相反。
         */
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export interface ShutdownRunnerOptions {
  logger: Logger
  clock: Clock
}

/**
 * 跑一步关闭动作。**不抛异常** —— 失败与超时都只记日志。
 *
 * 返回值只用于测试与可观测，调用方通常忽略它：退出路径上
 * "上一步没成功所以不做下一步"是错的（关库排在最后，它最重要）。
 */
export async function runShutdownStep(
  options: ShutdownRunnerOptions,
  step: ShutdownStep,
  operation: () => unknown,
): Promise<"completed" | "failed" | "timed-out"> {
  const timeoutMs = SHUTDOWN_STEP_TIMEOUTS[step]
  const startedAt = options.clock.now()
  options.logger.info("shutdown step started", { step, timeoutMs })

  // `Promise.resolve().then` 让**同步抛出**也变成 rejected promise
  // （否则一个同步抛错的 operation 会直接穿透这个函数）
  const running = Promise.resolve().then(operation)
  const result = await race(running, timeoutMs)
  const durationMs = options.clock.now() - startedAt

  if (result.status === "completed") {
    options.logger.info("shutdown step finished", { step, durationMs })
    return "completed"
  }

  if (result.status === "failed") {
    /**
     * 失败**不往外抛**：退出路径上让一个清理失败带走后面的步骤，
     * 等于"因为关不干净所以不退出"。记下来继续。
     */
    options.logger.warn("shutdown step failed", {
      step,
      durationMs,
      detail: result.error instanceof Error ? result.error.message : String(result.error),
    })
    return "failed"
  }

  options.logger.warn("shutdown step timed out; continuing", { step, timeoutMs, durationMs })
  /**
   * ★ 晚到的结果也要记一条。
   *
   * 超时只意味着"我们不等了"，那个 promise 仍在跑。不记的话事后
   * 无从区分"它慢了 100ms"与"它永远不会返回" —— 而这两件事的
   * 下一步动作完全不同（调预算 vs 查死锁）。
   *
   * 这里**必须** catch：进程可能已经在退出，一个无人处理的 rejection
   * 会改变退出码。
   */
  void running
    .then(() => {
      options.logger.info("shutdown step finished after timeout", {
        step,
        durationMs: options.clock.now() - startedAt,
      })
    })
    .catch((error: unknown) => {
      options.logger.warn("shutdown step failed after timeout", {
        step,
        detail: error instanceof Error ? error.message : String(error),
      })
    })
  return "timed-out"
}
