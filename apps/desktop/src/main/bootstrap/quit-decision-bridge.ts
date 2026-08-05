/**
 * `shell:quit-decision` 通道的**请求-响应配对**。
 *
 * ## 为什么单独一个文件
 *
 * `confirmQuit` 需要"发一个事件，然后等渲染层回话"。Electron 没有
 * main→renderer 的 invoke（只有 renderer→main），所以这一侧必须自己
 * 把「一次 `ipcMain.handle` 调用」桥成一个 promise。
 *
 * 那段桥接与 `quit-flow.ts` 的**判定逻辑**是两回事：
 * · 这里是 IPC 管道细节（注册/摘除/超时/重入）；
 * · 那里是"什么情况下允许退出"。
 *
 * 拆开之后 `quit-flow` 只依赖一个 `awaitDecision(timeoutMs)` 函数，
 * 于是它可以在没有 Electron 的环境里单测（见 tests/unit/desktop/quit-flow.test.ts）。
 *
 * ## 只注册一次，靠一个可变的 pending 槽转发
 *
 * `handleOnce` 看起来更合适，但它有个坑：**超时之后渲染层才回话**时，
 * 那次 invoke 会因为没有 handler 而 reject，渲染层拿到一个
 * "No handler registered" 的报错（它并没有做错什么）。
 * 常驻 handler + pending 槽的话，晚到的回话只是被忽略。
 */
import { ipcMain } from "electron"
import { IPC_CHANNELS, quitDecisionInputSchema } from "@mycontext/ipc-contract"
import type { QuitDecision } from "@mycontext/ipc-contract"
import type { Logger } from "@mycontext/kernel"

export interface QuitDecisionBridge {
  /**
   * 等渲染层回话。超时或未注册返回 `null`。
   *
   * 同一时刻只允许一个等待者：`before-quit` 已经用 `confirming` 挡了
   * 重入（见 index.ts），这里再挡一层是因为"两个等待者共享一个 pending 槽"
   * 会让先来的那个永远等不到（被后来者覆盖）。
   */
  awaitDecision(timeoutMs: number): Promise<QuitDecision | null>
}

export function createQuitDecisionBridge(logger: Logger): QuitDecisionBridge {
  /** 当前在等的那次询问。null = 没人在等（此时来的回话被忽略）。 */
  let pending: ((decision: QuitDecision) => void) | null = null

  ipcMain.handle(IPC_CHANNELS.shellQuitDecision, (_event, payload: unknown) => {
    const parsed = quitDecisionInputSchema.safeParse(payload)
    if (!parsed.success) {
      // 入参非法：不能让它变成"永远等不到" —— 但也不该按确认处理
      // （一个畸形的 payload 不是用户的意思）。记下来、让它走超时。
      logger.warn("ignored malformed quit decision", {
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      })
      return { ok: false as const, error: { code: "IPC_BAD_REQUEST", message: "bad decision" } }
    }

    if (pending === null) {
      // 晚到的回话（我们已经超时并放行了）。忽略，但记一条 ——
      // 频繁出现说明 DECISION_TIMEOUT_MS 给短了。
      logger.info("quit decision arrived with no pending request", parsed.data)
      return { ok: true as const, data: true as const }
    }

    pending(parsed.data)
    return { ok: true as const, data: true as const }
  })

  return {
    awaitDecision(timeoutMs) {
      if (pending !== null) {
        logger.warn("quit decision already pending; refusing second waiter")
        return Promise.resolve(null)
      }

      return new Promise<QuitDecision | null>((resolve) => {
        const timer = setTimeout(() => {
          pending = null
          resolve(null)
        }, timeoutMs)
        /**
         * ★ `unref`：这个定时器不该拖着进程不退。它的作用只是"别等太久"，
         * 如果它自己成了最后一个活着的 handle，Node 会为它多活 N 毫秒 ——
         * 与它的目的正好相反。（同 bootstrap/shutdown.ts 里那几个。）
         */
        timer.unref?.()

        pending = (decision) => {
          clearTimeout(timer)
          pending = null
          resolve(decision)
        }
      })
    },
  }
}
