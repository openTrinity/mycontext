/**
 * 主进程入口：只负责 Electron 生命周期，装配逻辑在 bootstrap/startup.ts。
 */
import { join } from "node:path"
import { app, dialog } from "electron"
import type { BrowserWindow } from "electron"
import { bootstrapApp, type AppContext } from "./bootstrap/startup.js"
import { resolveAppName } from "./bootstrap/paths.js"
import { HARD_EXIT_MS } from "./bootstrap/shutdown.js"
import { confirmQuit, emitQuitting } from "./bootstrap/quit-flow.js"
import {
  createQuitDecisionBridge,
  type QuitDecisionBridge,
} from "./bootstrap/quit-decision-bridge.js"
import { createMainWindow, resolvePreloadPath, resolveRendererFile } from "./windows/main-window.js"
import {
  registerLocalFilePrivileges,
  registerLocalFileProtocol,
} from "./windows/local-file-protocol.js"

// 必须在任何 Electron 路径解析之前设名：Chromium 会在启动早期就按当前 name
// 写入 Local State 等文件。pnpm workspace 下最近的 package.json name 是
// "@mycontext/desktop"，不先纠正会生成 "Application Support/@mycontext/desktop"。
app.setName(resolveAppName(app.isPackaged))

let context: AppContext | null = null
let mainWindow: BrowserWindow | null = null
/** 关闭流程是否已跑完（`before-quit` 需要它来决定是否放行退出）。 */
let disposed = false
/**
 * 清理是否**正在进行**。
 *
 * 与 `disposed`（已跑完）是两个不同的状态，都需要：
 * · `disposed` —— 放行第二次 `before-quit`；
 * · `quitting` —— 让 `window-all-closed` 在清理期间闭嘴。
 *
 * 关窗会触发 `window-all-closed`，而清理的第一件事就是窗口没了 ——
 * 非 macOS 上那里会再调一次 `app.quit()`，于是 `before-quit` 二次进入。
 * 有 `disposed` 挡着不会重复清理，但会多打一轮日志且时序更难读。
 * （参考实现里叫 `getIsQuitting()`，它在 `window-all-closed` 里
 * 第一条就是这个判断。）
 */
let quitting = false
/**
 * 确认对话框是否正在展示。
 *
 * 与 `quitting` 分开的理由：**没确认之前不该关任何东西**，所以
 * `window-all-closed` 不应该被这个态影响；它只是防止 ⌘Q 双击弹两个框。
 */
let confirming = false
/**
 * 退出确认的回话通道（渲染层 → 主进程）。whenReady 里建。
 *
 * 可能为 null 的窗口期：装配还没跑完时用户就按了 ⌘Q。那时 `context`
 * 也还是 null，`before-quit` 的第一行就 return 放行了 —— 所以这里
 * 读到 null 的分支实际到不了，但类型上要挡住。
 */
let quitDecisions: QuitDecisionBridge | null = null

/**
 * ★ 全局兜底：未处理的 Promise 拒绝必须留下痕迹。
 *
 * 主进程里有多条 `void somePromise()` 的火并忘路径（登录/登出回调、
 * 定时器触发的采集轮次）。其中任何一条 reject 都会在 Node ≥15 下
 * **默认让进程崩掉**，而崩溃前不会写我们的日志文件 —— 表现是"应用突然消失"
 * 且事后无从排查。实测的具体形状：logout 时关库撞上在途采集，抛
 * `The database connection is not open`。
 *
 * 那个具体 bug 已在 ingest.service / startup 里修掉（`stop()` 会 await
 * 在途的 tick），但兜底仍要有：**下一条**这样的路径不该以崩溃告知我们。
 * 装在文件顶层而不是 whenReady 里 —— 装配阶段自己也可能抛。
 */
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  // context 可能还没建好（装配阶段），所以 console 是唯一始终可用的通道。
  console.error("MYCONTEXT_UNHANDLED_REJECTION", message, stack)
  context?.logger.error("unhandled rejection", {
    detail: message,
    ...(stack === undefined ? {} : { stack }),
  })
})

/** 同理：同步的未捕获异常也不该静默带走进程。 */
process.on("uncaughtException", (error) => {
  console.error("MYCONTEXT_UNCAUGHT_EXCEPTION", error)
  context?.logger.error("uncaught exception", { detail: error.message, stack: error.stack })
})

/**
 * ★ 协议特权必须在 `app.whenReady()` **之前**声明 —— Electron 的硬要求
 * （ready 之后调用会抛）。所以它在模块顶层，与单实例锁并列。
 */
registerLocalFilePrivileges()

// 单实例：多开会有两个进程争抢同一个 SQLite 文件。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  app.on("window-all-closed", () => {
    // 清理期间窗口本来就会全关掉 —— 那时不该再触发一次退出
    if (quitting) return
    // macOS 习惯是关窗不退出；其余平台关窗即退出。
    if (process.platform !== "darwin") app.quit()
  })

  app.on("activate", () => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      if (context !== null) mainWindow = openWindow(context)
    } else {
      mainWindow.show()
    }
  })

  /**
   * 退出前：先问一次（可跳过），再关干净。
   *
   * `before-quit` 是**同步**事件——我们做的两件事都是异步的（问用户 +
   * 跑 dispose），所以必须 `preventDefault()`、把工作放到 handler 之外去做，
   * 完成后再自己调一次 `app.quit()`。
   *
   * 事件的三种进入时机与对应分支：
   *
   * ① 用户第一次 ⌘Q（`disposed=false && confirming=false && quitting=false`）
   *    → preventDefault、confirming=true、走 `confirmQuit`（它让**渲染层**
   *    弹一个设计系统风格的确认框，见 quit-flow.ts 文件头）。
   *    · 用户取消 → confirming=false，其它状态原样，窗口继续用；
   *    · 用户确认 → emit `shell:quitting`、quitting=true、跑 `ctx.dispose()`、
   *      跑完 disposed=true、再 `app.quit()`。
   *
   * ② 确认框展示期间用户又按 ⌘Q（`confirming=true`）
   *    → preventDefault、直接 return。避免第二次询问覆盖掉第一次的
   *    pending 槽（那会让第一次永远等不到回话）。
   *
   * ③ dispose 收尾时调的那次 `app.quit()`（`disposed=true`）
   *    → 早退出、放行。这一次不再进业务分支。
   *
   * ## 硬超时兜底：`dispose()` 自己也可能不返回
   *
   * `dispose()` 内部每一步都有超时（见 `bootstrap/shutdown.ts`），
   * 但那挡不住"某一步的超时定时器自己没生效"或"步骤之间的代码卡住"
   * 这类情况。而我们已经 `preventDefault()` 了 —— 一旦不返回就是
   * **永远退不出去**：窗口关了、进程还在、Dock 图标赖着不走，
   * 而下一次启动会撞单实例锁直接退出（表现是"应用打不开了"）。
   *
   * 所以再套一层进程级的硬超时：到点直接 `app.exit(0)`。
   * `exit` 而不是 `quit` —— 后者会再走一遍事件循环（包括我们正卡着的
   * 这个 handler），而这里要的是**立刻结束**。
   *
   * 定时器 `unref()`：它不该成为"最后一个活着的 handle"而拖着进程多活 8 秒。
   */
  app.on("before-quit", (event) => {
    if (disposed || context === null) return
    if (confirming || quitting) {
      // 用户第二次按 ⌘Q：正在问 / 正在关，别再插一脚
      event.preventDefault()
      return
    }
    event.preventDefault()

    const ctx = context
    const quitLogger = ctx.logger.child("QuitFlow")
    confirming = true

    void confirmQuit({
      preferences: ctx.preferences,
      logger: quitLogger,
      getWindow: () => mainWindow,
      awaitDecision: (timeoutMs) =>
        quitDecisions === null
          ? // 装配未完成（`context` 也必为 null，实际到不了这里）——
            // 返回 null 让 confirmQuit 走"问不出来 → 放行"。
            Promise.resolve(null)
          : quitDecisions.awaitDecision(timeoutMs),
    }).then((allowed) => {
      confirming = false
      if (!allowed) return

      // 用户确认了。context 从这里开始被拿走并不再回填。
      context = null
      quitting = true
      emitQuitting({ logger: quitLogger, getWindow: () => mainWindow })

      const hardExit = setTimeout(() => {
        console.error("MYCONTEXT_SHUTDOWN_HARD_TIMEOUT", { ms: HARD_EXIT_MS })
        ctx.logger.error("shutdown hard timeout; forcing exit", { ms: HARD_EXIT_MS })
        app.exit(0)
      }, HARD_EXIT_MS)
      hardExit.unref?.()

      void ctx
        .dispose()
        .catch((error: unknown) => {
          console.error("MYCONTEXT_DISPOSE_FAILED", error)
        })
        .finally(() => {
          clearTimeout(hardExit)
          disposed = true
          app.quit()
        })
    })
  })

  app
    .whenReady()
    .then(() => {
      context = bootstrapApp(import.meta.dirname)
      /**
       * 退出确认的回话通道。在建窗口**之前**注册：渲染层一挂上就可能
       * 收到 `shell:quit-requested`（用户在首屏就按 ⌘Q），那时它要能回话。
       */
      quitDecisions = createQuitDecisionBridge(context.logger.child("QuitFlow"))
      /**
       * ★ 自定义协议必须在建窗口**之前**注册。
       *
       * 之后注册的话第一批 `<img src="mycontext-file://…">` 会拿到
       * `ERR_UNKNOWN_URL_SCHEME` —— 而那个失败是静默的（图片回退到兜底），
       * 表现是"第一次进页面没头像，刷新一下就有了"。
       */
      registerLocalFileProtocol({
        /**
         * ★★ 媒体与头像**按身份隔离**之后落在
         * `vaults/<vaultId>/{media,avatars,uploads}` 下。
         *
         * 放行的是 vaults 根 + 一条形状约束（只允许那三个子目录，
         * 见 `AllowRule`）—— 因为"挂哪个 vault"在注册协议时还不知道
         * （协议必须在建窗口之前注册，而 vault 是登录后才挂的）。
         *
         * ★ 那条约束不是装饰：不加的话 `vaults/<id>/core.sqlite` 也可读，
         * 渲染层拼个 URL 就能把整个业务库拖走，而这**没有任何症状**。
         *
         * ★ 漏了 vaults 根的表现（实测）：新下载的图片全部 broken，而
         * **老图仍然正常**（它们还在旧的应用级目录下）—— 看起来像
         * "突然坏了一部分"，最难查的那种。一次会话 191 条 `local file blocked`。
         */
        vaultsRoot: context.paths.vaultsRoot,
        /**
         * 旧落点，为**存量**保留：库里存的是绝对路径
         * （`media_assets.path` / `contact_avatars.local_path`），
         * 所以迁移刻意没搬这两个目录 —— 搬了那些行就全部失效，
         * 而失效的表现是"图片永久显示不出来"。
         */
        legacyRoots: [
          join(context.paths.userData, "avatars"),
          join(context.paths.userData, "media"),
          join(context.paths.userData, "uploads"),
        ],
        logger: context.logger.child("LocalFile"),
      })
      mainWindow = openWindow(context)
      // 回填窗口：渠道授权进度需要往渲染层推事件。
      context.setWindow(mainWindow)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error("MYCONTEXT_STARTUP_FAILED", error)
      // 启动失败必须让用户看到原因：静默退出会让问题无从下手。
      dialog.showErrorBox("MyContext 启动失败", message)
      app.exit(1)
    })
}

function openWindow(ctx: AppContext): BrowserWindow {
  const mainDir = import.meta.dirname
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const window = createMainWindow({
    preloadPath: resolvePreloadPath(mainDir),
    devServerUrl,
    rendererFile: resolveRendererFile(mainDir),
    openDevTools: ctx.openDevTools,
    logger: ctx.logger.child("Window"),
  })
  window.on("closed", () => {
    mainWindow = null
    ctx.setWindow(null)
  })
  return window
}
