/**
 * 退出确认 + 优雅退出的**信号编排**。
 *
 * ## 分两件事
 *
 * ① 问一次「真要退出吗」：给用户"我是不是不小心按了 ⌘Q"的挽回机会，
 *    并允许勾"下次别问了"。
 *
 * ② 用户确认后先推 `shell:quitting` 事件给渲染层：现有 `dispose()`
 *    平均 0.5-2s（见 shutdown.ts 的预算），期间窗口还挂着但已不再响应
 *    业务操作——不加提示的话表现是"点哪都没反应"。有个遮罩告诉用户
 *    "正在优雅退出"，那 1 秒钟就从"卡了"变成"在关闭"。
 *
 * ## ★ 确认框画在**渲染层**，不用 `dialog.showMessageBox`
 *
 * 首版用的是原生 `showMessageBox`。它能用，但**永远长得像另一个程序**：
 * 字体、圆角、按钮排布、复选框样式全由 OS 决定，mac 上还带一个巨大的
 * 应用图标。而这是用户按 ⌘Q 时唯一看到的界面 —— 一个与应用设计系统
 * 毫无关系的系统灰框出现在这里，观感上就是"应用之外的东西"。
 *
 * 所以现在的流程是：主进程发 `shell:quit-requested` → 渲染层用
 * `<Dialog>` + 设计系统画一个 → 用户选完走 `shell:quit-decision` 回话。
 *
 * ## 但原生框仍留着，作为**回落**
 *
 * 两种情况下渲染层问不出来：
 * · **没有窗口**（macOS 关窗不退应用，此时 ⌘Q 仍会来）；
 * · **渲染层不回话**（白屏、崩溃、JS 异常吃掉了事件）。
 *
 * 前者直接走原生框；后者靠 `DECISION_TIMEOUT_MS` 兜——超时按
 * **确认退出**处理。选"确认"而不是"取消"：用户明确按了 ⌘Q，
 * 而渲染层坏掉的时候他更需要的是能退出去，不是被一个不显示的确认框
 * 挡在里面（那表现就是"⌘Q 没反应"）。
 *
 * ## 不做"退出中反悔"
 *
 * 参考的那个成熟桌面端有一个 `cancelQuitAndReinit`，能在清理过程中让
 * 用户反悔（重开数据库、重建 auth manager）。我们不做：dispose 里第一件事
 * 是关子进程（search / kl / dws），那些没法再拉起而继续用；
 * 给一个中间态的取消按钮只会让人以为能取消。
 */
import { app, dialog, type BrowserWindow, type MessageBoxOptions } from "electron"
import { IPC_EVENTS } from "@mycontext/ipc-contract"
import type { QuitDecision } from "@mycontext/ipc-contract"
import type { Logger } from "@mycontext/kernel"
import type { PreferencesService } from "../services/preferences.service.js"

/**
 * 等渲染层回话的上限。
 *
 * 3 秒：正常情况下事件到弹窗只有一帧的事（渲染层已经跑着），这个值
 * 只在渲染层**坏掉**时才会走到。给太长（比如 10s）会让"⌘Q 没反应"
 * 持续到用户去强制退出；给太短会在主线程正好卡一下时误判。
 */
export const DECISION_TIMEOUT_MS = 3_000

/**
 * 回落用的原生文案（仅"没有窗口"时用得到）。
 *
 * 主进程不装配 i18n（见 packages/i18n/src/index.ts 文件头：它只在渲染层
 * 初始化），而这条路径上渲染层根本不存在、没人能替我们翻。所以就地放两语，
 * 按已存的语言偏好选。**只有这一份** —— 正常路径的文案在 i18n 包的
 * `common.json` 里（`quit.confirmTitle` 那几条），由渲染层翻。
 */
interface FallbackCopy {
  title: string
  message: string
  detail: string
  quit: string
  cancel: string
  checkbox: string
}

const FALLBACK_COPY: Record<"zh" | "en", FallbackCopy> = {
  zh: {
    title: "退出 MyContext",
    message: "确定退出 MyContext 吗？",
    detail: "正在进行的采集轮次、数字分身草稿与搜索回答会立刻中断。",
    quit: "退出",
    cancel: "取消",
    checkbox: "下次不再提醒",
  },
  en: {
    title: "Quit MyContext",
    message: "Quit MyContext?",
    detail: "In-flight ingestion, persona drafts, and streaming search will be interrupted.",
    quit: "Quit",
    cancel: "Cancel",
    checkbox: "Don't ask again",
  },
}

/** system → 跟系统语言（`app.getLocale()` 给 zh-CN / en-US 之类）。 */
function pickFallbackCopy(preference: "zh" | "en" | "system"): FallbackCopy {
  if (preference === "zh") return FALLBACK_COPY.zh
  if (preference === "en") return FALLBACK_COPY.en
  return app.getLocale().toLowerCase().startsWith("zh") ? FALLBACK_COPY.zh : FALLBACK_COPY.en
}

export interface QuitFlowDeps {
  preferences: PreferencesService
  logger: Logger
  /**
   * 事件推送目标。给个 getter 而不是直接传 window：这个模块的生命周期
   * 与 app 一样长，而窗口可能已经被关掉了（macOS 关窗不退应用）——
   * 每次读的时候才决定推到谁。
   */
  getWindow(): BrowserWindow | null
  /**
   * 等渲染层的决定。由 index.ts 注入（它持有 ipcMain 的那条 handler）。
   *
   * 注入而不是在这里直接 `ipcMain.handleOnce`：那样这个模块就同时是
   * 通道的注册方与消费方，而通道注册统一在 `ipc/register.ts` 与
   * `index.ts`。更重要的是注入之后这段判定逻辑**可以单测**
   * （不需要真的 ipcMain）。
   */
  awaitDecision(timeoutMs: number): Promise<QuitDecision | null>
}

/**
 * 问一次。返回是否允许退出。
 *
 * 三条不变式：
 * · 已勾"下次别问" → 直接放行，不弹任何东西；
 * · 问不出来（无窗口 / 渲染层不回话 / 抛错）→ **放行**。
 *   绝不能因为"提问失败"而退不出去；
 * · 用户勾了"下次别问"且确认 → 落盘（落盘失败只记日志，不阻塞退出）。
 */
export async function confirmQuit(deps: QuitFlowDeps): Promise<boolean> {
  if (deps.preferences.quitConfirmSuppressed()) {
    deps.logger.info("quit confirm suppressed; proceeding")
    return true
  }

  const window = deps.getWindow()
  const decision =
    window !== null && !window.isDestroyed() ? await askRenderer(deps) : await askNative(deps, null)

  if (decision === null) return true // 问不出来 → 放行（见函数头）
  if (!decision.confirmed) {
    deps.logger.info("quit cancelled by user")
    return false
  }

  if (decision.dontAskAgain) {
    try {
      deps.preferences.setQuitConfirmSuppressed(true)
      deps.logger.info("quit confirm suppressed by user")
    } catch (error) {
      // 落盘失败不阻塞退出——最坏就是下次还问一次
      deps.logger.warn("failed to persist quit confirm suppression", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return true
}

/**
 * 让渲染层弹自己画的确认框，等它回话。
 *
 * 返回 `null` = 问不出来（超时 / 推送失败），由调用方按"放行"处理。
 */
async function askRenderer(deps: QuitFlowDeps): Promise<QuitDecision | null> {
  const window = deps.getWindow()
  if (window === null || window.isDestroyed()) return null

  try {
    window.webContents.send(IPC_EVENTS.shellQuitRequested)
  } catch (error) {
    deps.logger.warn("failed to request quit confirmation from renderer", {
      detail: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  try {
    const decision = await deps.awaitDecision(DECISION_TIMEOUT_MS)
    if (decision === null) {
      // 渲染层没回话：白屏 / 崩溃 / 事件被异常吃掉。放行，见文件头。
      deps.logger.warn("renderer did not answer quit confirmation; proceeding", {
        timeoutMs: DECISION_TIMEOUT_MS,
      })
      return null
    }
    return decision
  } catch (error) {
    deps.logger.warn("quit confirmation failed; proceeding", {
      detail: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * 原生框回落。只在**没有窗口**时走到（macOS 关窗不退应用）。
 *
 * 返回 `null` = 连原生框也弹不出来 → 放行。
 */
async function askNative(
  deps: QuitFlowDeps,
  window: BrowserWindow | null,
): Promise<QuitDecision | null> {
  const copy = pickFallbackCopy(deps.preferences.language())
  const options: MessageBoxOptions = {
    type: "question",
    // mac 把默认按钮放右、cancel 放左；其它平台默认按钮在左。
    // 给 buttons 之后用 defaultId/cancelId 显式绑，避免踩系统差异。
    buttons: [copy.quit, copy.cancel],
    defaultId: 0,
    cancelId: 1,
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    checkboxLabel: copy.checkbox,
    checkboxChecked: false,
    noLink: true,
  }

  try {
    const result =
      window !== null && !window.isDestroyed()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)
    return { confirmed: result.response === 0, dontAskAgain: result.checkboxChecked }
  } catch (error) {
    deps.logger.warn("native quit dialog failed; proceeding", {
      detail: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * 推 `shell:quitting` 事件。渲染层挂遮罩用。
 *
 * 只发一次、不带 payload：这不是状态同步，就是"开始了"这一记提示。
 * 发不出去（窗口没了）静默——那种情况用户看不见渲染层，也不需要遮罩。
 */
export function emitQuitting(deps: Pick<QuitFlowDeps, "logger" | "getWindow">): void {
  const window = deps.getWindow()
  if (window === null || window.isDestroyed()) return
  try {
    window.webContents.send(IPC_EVENTS.shellQuitting)
  } catch (error) {
    deps.logger.warn("failed to emit shell:quitting", {
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
