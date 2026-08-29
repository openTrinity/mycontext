/**
 * 桌面侧旁路 embedding 探测（Electron 路径）。
 *
 * 判据与默认值推导在 `@mycontext/runtime-env`；这里只解析打包/开发目录。
 */
import { app } from "electron"
import { dirname, join } from "node:path"
import {
  formatEmbedStatusText,
  isLocalEmbedUsable,
  probeEmbedModel,
  type EmbedModelProbeResult,
} from "@mycontext/runtime-env"

export interface EmbedSidecarSnapshot {
  probe: EmbedModelProbeResult
  /** 给运行状态页 / 日志的一行说明 */
  statusText: string
  localUsable: boolean
}

/**
 * 打包态：`.app` 同级或可执行文件旁的旁路根。
 * 开发态：不设 sibling（走 repo vendor/models）。
 */
function siblingModelsRoot(packaged: boolean): string | undefined {
  if (!packaged) return undefined
  const exeDir = dirname(app.getPath("exe"))
  if (process.platform === "darwin") {
    // .../MyContext.app/Contents/MacOS/<exe> → .app 的父目录
    return join(exeDir, "..", "..", "..")
  }
  return exeDir
}

/** 启动时探测一次（路径与加速器很少热变）。 */
export function probeEmbedSidecar(options: {
  packaged: boolean
  repoRoot: string
}): EmbedSidecarSnapshot {
  const probe = probeEmbedModel({
    envDir: process.env["MYCONTEXT_EMBED_MODEL_DIR"],
    resourcesPath: options.packaged ? process.resourcesPath : undefined,
    siblingRoot: siblingModelsRoot(options.packaged),
    repoRoot: options.repoRoot,
  })
  return {
    probe,
    localUsable: isLocalEmbedUsable(probe),
    statusText: formatEmbedStatusText(probe),
  }
}

// 给启动装配与单测 re-export，避免再绕一层路径。
export {
  resolveEmbedGateway,
  formatEmbedStatusText,
  formatEmbedGatewayStatus,
  EMBED_MODEL_NAME,
  LOCAL_EMBED_DIM,
} from "@mycontext/runtime-env"
