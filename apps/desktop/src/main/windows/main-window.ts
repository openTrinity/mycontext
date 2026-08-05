/**
 * 主窗口。
 *
 * macOS：无边框 + hiddenInset 交通灯 + vibrancy，窗口装饰交给渲染层，
 * 与设计系统的整体观感一致。Windows/Linux 保留原生标题栏（第二期再统一）。
 *
 * 背景色：mac 下用全透明让 vibrancy 透出，其余平台用不透明色避免首帧闪白。
 */
import { BrowserWindow, nativeTheme, shell } from "electron"
import { join } from "node:path"
import type { Logger } from "@mycontext/kernel"

const IS_MAC = process.platform === "darwin"

export interface CreateWindowOptions {
  preloadPath: string
  devServerUrl: string | undefined
  rendererFile: string
  openDevTools: boolean
  logger: Logger
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: IS_MAC ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#1f1f1f" : "#fcfcfc",
    titleBarStyle: IS_MAC ? "hiddenInset" : "default",
    // mac 专属选项整体条件展开：exactOptionalPropertyTypes 下不能传 undefined。
    ...(IS_MAC
      ? {
          vibrancy: "sidebar" as const,
          transparent: true,
          trafficLightPosition: { x: 16, y: 16 },
        }
      : {}),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 首帧就绪后再显示：避免用户看到空白窗口。
  window.once("ready-to-show", () => {
    window.show()
    if (options.openDevTools) window.webContents.openDevTools({ mode: "detach" })
  })

  // 外部链接交给系统浏览器，不在应用内开新窗口。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url)
    return { action: "deny" }
  })

  if (options.devServerUrl !== undefined) {
    void window.loadURL(options.devServerUrl)
    options.logger.debug("renderer loaded from dev server", { url: options.devServerUrl })
  } else {
    void window.loadFile(options.rendererFile)
    options.logger.debug("renderer loaded from file", { file: options.rendererFile })
  }

  return window
}

export function resolvePreloadPath(mainDir: string): string {
  return join(mainDir, "../preload/index.cjs")
}

export function resolveRendererFile(mainDir: string): string {
  return join(mainDir, "../renderer/index.html")
}
