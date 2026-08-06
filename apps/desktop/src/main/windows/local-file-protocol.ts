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
 * 一条白名单规则。
 *
 * · `prefix` —— 目录前缀（已 resolve、已补分隔符）；
 * · `mediaOnly` —— 只放行它下面**一层 vaultId** 再进
 *   `media/` `avatars/` `uploads/` 的路径。
 *
 * ## ★★ 为什么需要 `mediaOnly` 这一档
 *
 * 媒体按 vault 隔离之后要放行 `vaults/<id>/{media,avatars,uploads}`，
 * 而"挂哪个 vault"在**注册协议时还不知道**（协议必须在建窗口之前注册，
 * 而 vault 是登录后才挂的）。所以只能放行 `vaults` 根 + 一条形状约束。
 *
 * 如果只放行 `vaults` 根而不加约束，那么 `vaults/<id>/core.sqlite`
 * 也会变成可读 —— 渲染层拼一个 URL 就能把整个业务库拖出来
 * （会话、消息、画像）。那不是一个可接受的暴露面，而它**看不出来**：
 * 图片照常显示，没有任何症状。
 */
interface AllowRule {
  prefix: string
  mediaOnly: boolean
}

/** `vaults/<id>/` 之下允许读的子目录。核心库、图谱、导出都不在其中。 */
const MEDIA_SUBDIRS = new Set(["media", "avatars", "uploads"])

/**
 * 把白名单目录规范化成"可用于前缀比较"的形态。
 *
 * 末尾补分隔符是为了让比较是"目录内"而不是"字符串以此开头"：
 * 没有它的话 `/data/avatars-evil/x.jpg` 会被 `/data/avatars` 前缀命中。
 *
 * @param vaultsRoot vaults 根 —— 它按 `mediaOnly` 规则收窄（见 `AllowRule`）
 * @param legacyRoots 旧的应用级目录（整目录放行；存量数据在里面）
 */
export function normalizeAllowedRoots(
  vaultsRoot: string,
  legacyRoots: readonly string[],
): AllowRule[] {
  const withSep = (root: string): string => {
    const normalized = resolve(root)
    return normalized.endsWith(sep) ? normalized : normalized + sep
  }
  return [
    { prefix: withSep(vaultsRoot), mediaOnly: true },
    ...legacyRoots.map((root) => ({ prefix: withSep(root), mediaOnly: false })),
  ]
}

/**
 * 这个路径允许读吗。**纯函数，提出来是为了能测**。
 *
 * ## ★ 为什么必须 `resolve` 之后再比前缀
 *
 * 不 resolve 的话 `…/avatars/../../../../etc/passwd` 会通过前缀检查
 * （那个串确实以 `/…/avatars/` 开头），而 `net.fetch` 会老老实实
 * 把 /etc/passwd 读出来。`resolve` 把 `..` 折叠掉之后前缀检查才真的成立。
 *
 * ## ★★ 为什么这段值得单独一个函数
 *
 * 它原来内联在 `protocol.handle` 的回调里，也就是**没法测** ——
 * 要测就得起一个 Electron。而它的失效方式是完全静默的：图片回退到兜底，
 * 界面看起来像"这个功能没做"。
 *
 * 实测真踩过：媒体改成按 vault 隔离之后白名单没跟着改，于是新下载的图
 * 全部 403（一次会话 191 条 `local file blocked`），而**老图仍然正常**
 * （它们还在旧的应用级目录下）—— 看起来像"突然坏了一部分"。
 *
 * @returns 允许时给规范化后的绝对路径，不允许给 null
 */
export function resolveAllowedPath(rules: readonly AllowRule[], target: string): string | null {
  const absolute = resolve(target)
  for (const rule of rules) {
    if (!absolute.startsWith(rule.prefix)) continue
    if (!rule.mediaOnly) return absolute
    /**
     * `vaults/<vaultId>/<subdir>/…` —— 第二段必须是允许的子目录。
     *
     * ★ 不判这个的话 `vaults/<id>/core.sqlite` 也可读，
     * 也就是渲染层拼个 URL 就能把整个业务库拖走（见 `AllowRule` 的注释）。
     */
    const [, subdir] = absolute.slice(rule.prefix.length).split(sep)
    if (subdir !== undefined && MEDIA_SUBDIRS.has(subdir)) return absolute
  }
  return null
}

/**
 * 注册协议。必须在 `app.whenReady()` **之后**、创建窗口**之前**调用。
 *
 * 只有白名单之下的文件才会被返回 —— 见文件头"为什么带白名单"，
 * 以及 `resolveAllowedPath` 与 `AllowRule` 的注释。
 */
export function registerLocalFileProtocol(options: {
  /** vaults 根（按 media/avatars/uploads 收窄，见 `AllowRule`） */
  vaultsRoot: string
  /** 旧的应用级目录（整目录放行；库里存着指向它们的绝对路径） */
  legacyRoots: readonly string[]
  logger: Logger
}): void {
  const rules = normalizeAllowedRoots(options.vaultsRoot, options.legacyRoots)

  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    let target: string
    try {
      const url = new URL(request.url)
      // pathname 是百分号编码的，要解回真实路径
      target = normalize(decodeURIComponent(url.pathname))
    } catch {
      return new Response("bad url", { status: 400 })
    }

    const absolute = resolveAllowedPath(rules, target)
    if (absolute === null) {
      options.logger.warn("local file blocked", { path: resolve(target).slice(0, 120) })
      return new Response("forbidden", { status: 403 })
    }

    // net.fetch 走 Chromium 的文件读取（支持 range 请求，图片解码更省内存）
    return net.fetch(pathToFileURL(absolute).toString())
  })
}
