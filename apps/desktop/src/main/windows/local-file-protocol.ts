/**
 * `mycontext-file://` —— 让渲染层能加载本地图片。
 *
 * ## ★ 为什么不能直接用 `file://`
 *
 * 实测（CDP 探针）：渲染层的 origin 是 `http://localhost:5273`（dev）或
 * `file://…/index.html`（打包），而从一个 `http://` 页面加载 `file://`
 * 资源被 Chromium **直接拦掉** —— `<img>` 的 `onerror` 触发，
 * 控制台里连请求都看不到。
 *
 * 这个失败是**完全静默**的：`Avatar` 的 `onError` 会切到首字母兜底，
 * 于是界面看起来"头像功能没做"，而文件其实已经躺在磁盘上了。
 * 实测踩到：23 个头像下载成功、界面上 `img` 数量是 **0**。
 *
 * ## 为什么是自定义协议而不是关掉 webSecurity
 *
 * `webSecurity: false` 能让 `file://` 加载成功，但它同时关掉了同源策略、
 * CORS 与混合内容拦截 —— 为了显示头像而把整个渲染层的安全边界拆掉，
 * 代价完全不成比例。
 *
 * 自定义协议只开一个口子，而且**带白名单**：只有落在我们那几个目录下的
 * 路径才给（见 `ALLOWED_PREFIXES`）。渲染层拼一个
 * `mycontext-file:///etc/passwd` 会被拒。
 *
 * ## 为什么不用 data URI
 *
 * 一张头像 800KB，转 base64 是 1.1MB 字符串。一屏 20 个人就是 20MB
 * 走 IPC 并留在 JS 堆里 —— 而这些文件本来就在本地，让浏览器自己读
 * 是零拷贝的。
 *
 * ## ★ 为什么 `toLocalFileUrl` 不在这个文件里
 *
 * 这个文件顶层 import 了 `electron`，于是它**只能在 Electron 里加载**。
 * 而路径转 URL 那件事服务层也要用，服务层还要能被 `node` 脚本直接跑
 * （`scripts/check-persona.mjs`）。所以纯函数在 `local-file-url.ts`。
 */
import { net, protocol } from "electron"
import { normalize, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { Logger } from "@mycontext/kernel"
import { LOCAL_FILE_SCHEME } from "./local-file-url.js"

export { LOCAL_FILE_SCHEME, toLocalFileUrl } from "./local-file-url.js"

/**
 * 声明协议特权。**必须在 `app.whenReady()` 之前**调用（Electron 的硬要求）。
 *
 * 不声明 `standard` 的话这个 scheme 会被当成"不透明"的：没有 origin、
 * 不走正常的资源加载路径，`<img>` 直接拿到 `ERR_UNKNOWN_URL_SCHEME`。
 * `supportFetchAPI` 让 `protocol.handle` 的 Response 形态生效。
 * `bypassCSP` 是必要的：渲染层的 CSP 里没有（也不该有）这个 scheme。
 */
export function registerLocalFilePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        // 只读本地图片，不需要 stream（那是给视频 range 请求的）
        stream: false,
      },
    },
  ])
}

/**
 * 注册协议。必须在 `app.whenReady()` **之后**、创建窗口**之前**调用。
 *
 * `allowedRoots` 是白名单目录（`<userData>/avatars` 等）。
 * 只有它们之下的文件才会被返回 —— 见文件头"为什么带白名单"。
 */
export function registerLocalFileProtocol(options: {
  allowedRoots: readonly string[]
  logger: Logger
}): void {
  /**
   * 白名单用**规范化后**的绝对路径，且末尾补分隔符。
   *
   * 补分隔符是为了让前缀比较是"目录内"而不是"字符串以此开头"：
   * 没有它的话 `/data/avatars-evil/x.jpg` 会被 `/data/avatars` 前缀命中。
   */
  const roots = options.allowedRoots.map((root) => {
    const normalized = resolve(root)
    return normalized.endsWith(sep) ? normalized : normalized + sep
  })

  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    let target: string
    try {
      const url = new URL(request.url)
      // pathname 是百分号编码的，要解回真实路径
      target = normalize(decodeURIComponent(url.pathname))
    } catch {
      return new Response("bad url", { status: 400 })
    }

    /**
     * ★ 白名单检查用 `resolve` 之后的路径。
     *
     * 不 resolve 的话 `…/avatars/../../../../etc/passwd` 会通过前缀检查
     * （那个串确实以 `/…/avatars/` 开头），而 `net.fetch` 会老老实实
     * 把 /etc/passwd 读出来。normalize + resolve 把 `..` 折叠掉之后
     * 前缀检查才真的成立。
     */
    const absolute = resolve(target)
    if (!roots.some((root) => absolute.startsWith(root))) {
      options.logger.warn("local file blocked", { path: absolute.slice(0, 120) })
      return new Response("forbidden", { status: 403 })
    }

    // net.fetch 走 Chromium 的文件读取（支持 range 请求，图片解码更省内存）
    return net.fetch(pathToFileURL(absolute).toString())
  })
}
