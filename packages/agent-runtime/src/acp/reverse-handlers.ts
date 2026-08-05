/**
 * ACP 的**反向**调用 handler。
 *
 * ACP 是双向 JSON-RPC：agent 侧也会调 client。实测
 * `acp/permission.ts:55-58` 在 client 未实现 `requestPermission` 时
 * **直接 `reply(..., "reject")`**（catch 分支同样 reject）——
 * 也就是说不实现这个 handler，**所有需要授权的工具调用都会被静默拒绝**，
 * 表现为「agent 什么都不做」，而日志里什么都没有。
 *
 * ## 授权模型
 *
 * 宿主侧的工具白名单是**唯一真正的把关**（只读工具本来就无副作用），
 * 所以这里对白名单内的工具直接放行，不把决策权交给 opencode 的 permission 机制。
 *
 * ## ★ 工具名必须带前缀
 *
 * 实测 ACP 的 `requestPermission` 传的 `toolName` 是 `permission.permission`，
 * 与内建的 `read` / `edit` / `bash` **同命名空间**。
 * 不加 `mycontext_` 前缀的话，「放行 read」= 放行 opencode 的文件读工具 ——
 * 白名单会与内建工具碰撞，而这个碰撞在日志里看不出来。
 */
import { basename, isAbsolute, resolve, sep } from "node:path"
import { realpathSync } from "node:fs"
import { AppError } from "@mycontext/kernel"
import { HOST_TOOL_PREFIX } from "../spawn-hardening.js"

/** 宿主提供的只读工具全名。全部带前缀，且**没有任何写操作**。 */
export const HOST_TOOLS = {
  localRecall: `${HOST_TOOL_PREFIX}local_recall`,
  klQuery: `${HOST_TOOL_PREFIX}kl_query`,
  dwsQuery: `${HOST_TOOL_PREFIX}dws_query`,
  imRealtime: `${HOST_TOOL_PREFIX}im_realtime`,
  citationPin: `${HOST_TOOL_PREFIX}citation_pin`,
  /** 仅数字人可用：读本人画像。搜索侧**没有**这个工具 */
  profileRead: `${HOST_TOOL_PREFIX}profile_read`,
} as const

export type HostToolName = (typeof HOST_TOOLS)[keyof typeof HOST_TOOLS]

/** 按 agent 类型给的工具白名单。差异是刻意的：搜索不该能读画像。 */
export const TOOL_ALLOWLIST: Record<"search" | "persona", readonly string[]> = {
  search: [
    HOST_TOOLS.localRecall,
    HOST_TOOLS.klQuery,
    HOST_TOOLS.dwsQuery,
    HOST_TOOLS.imRealtime,
    HOST_TOOLS.citationPin,
  ],
  persona: [
    HOST_TOOLS.localRecall,
    HOST_TOOLS.klQuery,
    HOST_TOOLS.imRealtime,
    HOST_TOOLS.profileRead,
  ],
}

export function isAllowlistedTool(kind: "search" | "persona", toolName: string): boolean {
  return TOOL_ALLOWLIST[kind].includes(toolName)
}

/**
 * 判断 `path` 解析后是否仍落在 `workspaceRoot` 内。
 *
 * ## 为什么不能用字符串判断
 *
 * 首版是 `normalized.includes("../") || normalized.startsWith("/")`。
 * 实测漏两类（都是"看起来明显"但字符串规则挡不住的形状）：
 * · 裸 `".."` —— 不含 `"../"` 子串，但 `resolve("/ws/search/s1", "..")`
 *   = `/ws/search`，**逃出了 workspace**；
 * · `"./.."` —— 同理。
 *
 * 正确做法只有一条：**先 resolve 再做前缀包含判定**。
 * 字符串黑名单永远在追赶新形状（`..%2f`、`....//`、Windows 的 `..\\`），
 * 而 resolve 后的路径是唯一的事实。
 *
 * 唯一需要在 resolve **之前**做的归一是把 `\` 当分隔符：
 * POSIX 的 `node:path` 把它当普通字符，会把逃逸路径变成一个合法文件名。
 *
 * ## ★ 绝对路径：按**是否落在 workspace 内**判，不是一律拒绝
 *
 * 首版一律拒绝绝对路径。但 ACP 的 `fs/read_text_file` 传的**就是绝对路径**
 * （对照 opencode 的 `acp/tool.ts:286`：`if (isAbsolute(value)) return value`
 * —— 绝对路径原样透传，相对路径才拼 cwd）。一律拒绝的表现会是
 * 「agent 读不到自己 workspace 里的画像」**且没有任何报错** ——
 * 那正是我们在别处反复防的那类静默失效。
 *
 * 安全属性不受影响：判据始终是 realpath 后的前缀包含，
 * `/etc/passwd` 与隔壁会话的目录照样被拒。放行的只是
 * 「指向本 workspace 内某个文件的绝对路径」，而那本来就该能读。
 *
 * Windows 盘符形式（`C:/...`）仍然一律拒绝：POSIX 的 `isAbsolute` 认不出它，
 * 于是它会被当成相对路径拼到 workspace 后面，得到一个荒谬但"在内"的判定。
 *
 * ## 还要挡 symlink
 *
 * agent workspace 里的 md 是我们生成的，但**会话目录同级就是别的会话的画像**
 * —— 那是 R5 单聊隐私边界。一个指向 `../other-session/` 的 symlink
 * 在纯路径判定下完全合法，所以要对最终路径取 `realpath`。
 *
 * 文件不存在时 `realpathSync` 会抛（读一个不存在的文件本来就该失败）；
 * 但父目录存在与否不该影响判定结果，所以逐级回退到最近的存在祖先再判。
 */
export function isInsideWorkspace(workspaceRoot: string, path: string): boolean {
  if (path === "" || workspaceRoot === "") return false

  // ★ 反斜杠一律按分隔符处理，不管当前平台。
  //
  // POSIX 的 `node:path` 把 `\` 当**普通字符**，于是 `..\other\x.md` 在 mac/Linux 上
  // 会被 resolve 成 workspace 里一个名叫 `..\other\x.md` 的文件 —— 前缀判定说"在内"，
  // 但这条路径在 Windows 上是逃逸。判定必须与平台无关（同一份画像包会跨平台读），
  // 所以先把 `\` 归一成 `/` 再判。
  const normalized = path.replaceAll("\\", "/")

  // Windows 盘符形式（`C:/...`）直接拒：POSIX 的 isAbsolute 认不出它，
  // 于是它会被当相对路径拼到 workspace 后面 —— 判定"在内"但语义完全错了。
  if (/^[a-zA-Z]:/.test(normalized)) return false

  const root = realpathIfPossible(resolve(workspaceRoot))
  // 绝对路径不拼 workspaceRoot（`resolve` 本来也会忽略前面的段），
  // 相对路径以 workspaceRoot 为基准 —— 两者都交给下面同一条前缀判定。
  const target = isAbsolute(normalized)
    ? realpathIfPossible(resolve(normalized))
    : realpathIfPossible(resolve(workspaceRoot, normalized))
  return target === root || target.startsWith(root + sep)
}

/**
 * 取 realpath；路径尚不存在时回退到最近的存在祖先。
 *
 * 直接 try/catch 返回原路径是不够的：symlink 在**祖先目录**上时
 * （`workspace/link-to-elsewhere/a.md`，其中 a.md 还不存在）
 * 会因为整条路径不存在而跳过 realpath，symlink 就绕过去了。
 *
 * ★ 用 `basename` 取"被剥掉的那一段"，不用 `current.slice(parent.length + 1)`：
 * 后者在 parent 为 `/` 时会多切一个字符（`/` 的长度是 1，`+1` 就吃掉了首字母），
 * 实测 `/foo-does-not-exist-xyz` → `oo-does-not-exist-xyz`。
 * 当前 workspaceRoot 不会落在根目录下，所以那个 off-by-one 还没表现成误判 ——
 * 但这是安全函数，不该留一条"恰好没被触发"的错误分支。
 */
function realpathIfPossible(absolutePath: string): string {
  let current = absolutePath
  const trailing: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return trailing.length === 0 ? real : resolve(real, ...trailing.reverse())
    } catch {
      const parent = resolve(current, "..")
      // 到根了还不存在：没有可解析的祖先，原样返回。
      if (parent === current) return absolutePath
      trailing.push(basename(current))
      current = parent
    }
  }
}

export type PermissionOutcome =
  | { outcome: "selected"; optionId: "always" | "once" }
  | { outcome: "cancelled" }

export interface ReverseHandlerOptions {
  kind: "search" | "persona"
  /** 每次工具调用记一行审计（tool / scope / 参数摘要）。没有它「agent 查了什么」事后无法回答 */
  onToolAudit?: (entry: { toolName: string; allowed: boolean }) => void
}

/**
 * 反向 handler 集合。
 *
 * 三层禁写里的第一层（另两层是 `OPENCODE_PERMISSION` 的 deny-all
 * 与宿主 MCP server 的 SQL 作用域强制）。
 */
export function createReverseHandlers(options: ReverseHandlerOptions) {
  return {
    /**
     * 工具授权请求。
     *
     * 白名单内 → `always`（只读工具无副作用，每次问用户是纯骚扰）；
     * 白名单外 → `cancelled`（**拒绝**而不是询问用户：
     * 让用户面对一个他无法判断的技术问题，只会训练他一路点"允许"）。
     */
    requestPermission(request: { toolName: string }): PermissionOutcome {
      const allowed = isAllowlistedTool(options.kind, request.toolName)
      options.onToolAudit?.({ toolName: request.toolName, allowed })
      return allowed ? { outcome: "selected", optionId: "always" } : { outcome: "cancelled" }
    },

    /**
     * 写文件请求：**一律拒绝**。
     *
     * agent 的 workspace 里只有 materialize 出来的 md（本来就是给它看的），
     * 它没有任何需要写文件的正当理由。而「能写文件」意味着它能改自己的
     * 系统提示 —— 那是 prompt injection 最想要的能力。
     */
    writeTextFile(): never {
      throw new AppError("FORBIDDEN", "Agent 不允许写文件", {
        messageKey: "errors:byCode.FORBIDDEN",
      })
    },

    /**
     * 读文件请求。
     *
     * 允许但**限定在 workspace 内**：路径逃逸会让它读到别的会话的画像目录，
     * 而那是 R5 单聊隐私边界的一部分。
     *
     * 判定实际使用 `workspaceRoot`（首版收下这个参数却从未用它，
     * 只对 path 做字符串匹配 —— 于是裸 `".."` 与 `"./.."` 都能逃出去）。
     * 见 `isInsideWorkspace`。
     */
    readTextFile(request: { path: string; workspaceRoot: string }): { allowed: boolean } {
      return { allowed: isInsideWorkspace(request.workspaceRoot, request.path) }
    },
  }
}
