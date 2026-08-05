/**
 * `mycontext-file://` 的**纯**部分：scheme 名 + 路径转 URL。
 *
 * ## ★ 为什么和 `local-file-protocol.ts` 分开
 *
 * 那个文件顶层 `import { net, protocol } from "electron"`，而 `electron`
 * 在**普通 Node 进程里根本加载不了**（它是 CommonJS，且只在 Electron
 * 运行时里存在）。
 *
 * 于是任何 import 了它的模块都变成"只能在 Electron 里跑"——
 * 包括 `persona.service.ts`，而 `scripts/check-persona.mjs` 恰恰是用
 * `node` 直接跑那个 service 的。踩到过：
 *
 * ```
 * PERSONA_CHECK_FAILED: Named export 'net' not found.
 * The requested module 'electron' is a CommonJS module…
 * ```
 *
 * 那个报错还很有误导性 —— 它指向 `electron`，而真正的原因是一条
 * **两层之外**的 import 链（service → protocol → electron）。
 *
 * 路径转 URL 这件事本身不需要 Electron（只用到 `node:url`），
 * 所以让它待在一个纯模块里，服务与脚本都能用。
 */
import { pathToFileURL } from "node:url"

export const LOCAL_FILE_SCHEME = "mycontext-file"

/**
 * 把一个本地绝对路径变成渲染层能加载的 URL。
 *
 * 主进程侧的**唯一**转换入口 —— 渲染层不该自己拼这个 scheme
 * （拼错的表现是静默的兜底：`Avatar` 的 onError 切到首字母，
 * 于是"头像功能看起来没做"，见 `local-file-protocol.ts` 的文件头）。
 */
export function toLocalFileUrl(absolutePath: string): string {
  // 用 pathToFileURL 做百分号编码（中文名 / 空格 / `#` 都要转），再换掉 scheme
  const asFileUrl = pathToFileURL(absolutePath).toString()
  return `${LOCAL_FILE_SCHEME}://local${asFileUrl.slice("file://".length)}`
}
