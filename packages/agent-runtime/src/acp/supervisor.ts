/**
 * ACP session 的生命周期管理。
 *
 * ## 一个进程承载多 session
 *
 * 已核对 opencode 1.15.5：`initialize` 返回 `loadSession: true` 且
 * `sessionCapabilities` 含 `{ close, fork, list, resume }`。
 *
 * **单进程省下的是 Node 运行时 + 启动时间 + 端口句柄，不是 N 份会话状态** ——
 * 实测 `InstanceState` 是按 directory 的 `ScopedCache`
 * （`effect/instance-state.ts:48`），而我们给每个会话一个独立 workspace，
 * 所以单进程内仍有 N 份 instance state。选型不变（一会话一进程仍然更贵），
 * 但不要以为它省掉了会话状态的内存。
 *
 * ## resume 优先于 load
 *
 * 实测 `loadSession` 末尾会 `replayMessages(events, messages)` 把该 session
 * 的**全部**历史以 `*_chunk` 通知推回来；`resumeSession` 不 replay
 * 且只取最近 20 条。我们的 UI 读自己的库，不需要 agent 把历史吐回来 ——
 * 吐回来反而要去重。所以默认 resume，失败才降级。
 *
 * ## 降级重建
 *
 * `acp_session_id` 可为空是本设计最关键的一点：它把「我们的会话」与
 * 「opencode 的 session」解耦。session 失效时，**用户看到的历史一条不少**
 * （渲染的是我们的库），只是继续对话时后台静默重建并回灌上下文。
 *
 * ★ 实测纠正过一处：**进程被杀不会让 session 失效**。
 * opencode 的 session 落在磁盘上（`~/.local/share/opencode/storage/session/`
 * + `opencode.db`），SIGKILL 掉进程后新进程拿旧 id 仍能 resume 成功。
 * 所以真实的失效场景是**磁盘态丢失**：清缓存 / 换机器 / 升级改了存储格式 /
 * 被它自己的保留策略清掉。写清这一点是为了让下一个人不去为
 * "进程重启要恢复"这个不存在的问题写恢复逻辑。
 *
 * 注意 `embeddedContext` 是 `promptCapabilities` 下的**prompt 内容能力**
 * （service.ts:119），**不是 `newSession` 的参数** —— 历史回灌只能作为
 * 下一次 `session/prompt` 的 content block，且要标记为"上下文回灌"
 * 以免被 reducer 当成用户可见消息落库。
 */
import type { Logger } from "@mycontext/kernel"
import type { AcpClient } from "./client.js"
import type { McpAuth } from "../mcp/auth.js"

/**
 * ★ `type` 只能是 `"http"`（或 `"sse"`），**不是 `"remote"`**。
 *
 * 这一个字符串值花了一次真进程联调才定下来，值得把结论写在这里：
 * opencode 的 `mcpConfig()`（service.ts:1005）**输出** `type:"remote"` ——
 * 那是它转发给自己 SDK 的**内部**形状。而 ACP **线上**的入参 schema 要求
 * `"http" | "sse"`。读源码那一半会读出错误的答案。
 *
 * 实测（opencode 1.15.5）：
 * · `type:"remote"` → `-32602 Invalid params`（`expected "http"` / `expected "sse"`）
 * · 省略 `type`      → 同样 -32602（它去按 local 校验，抱怨缺 command/args/env）
 * · `type:"http"`    → session 建成
 *
 * 传错的后果是**静默的**：`session/new` 整个失败 → Supervisor 落到降级重建 →
 * 也失败 → agent 手上一个检索工具都没有。而"模型没用工具"看起来像模型笨，
 * 不像配置错。
 */
export interface McpServerSpec {
  type: "http"
  name: string
  url: string
  headers: { name: string; value: string }[]
}

export interface SessionRecord {
  /** 我们的会话 id（UI 与路由用它） */
  id: string
  /** opencode 侧的 id。**可为空**：未建 / 已失效 */
  acpSessionId: string | null
  /** workspace 路径（resume/load 的必需参数） */
  cwd: string
  kind: "search" | "persona"
  /** 作用域：persona → conversationId；search → 我们的 sessionId */
  scopeId: string
}

export interface AcpSupervisorOptions {
  client: AcpClient
  mcpAuth: McpAuth
  /** 宿主 MCP server 的端口（工具的唯一注入通道） */
  mcpPort: number
  logger?: Logger
  /**
   * 是否给 agent 注入宿主 MCP 工具。
   *
   * 缺省 `true`（保持既有行为：注入一个 http server）。
   * 搜索第一期 kl 走 opencode **skill**（`kl` CLI）而非宿主 MCP 工具，
   * 此时传 `false` → `mcpServersFor` 返回空数组，agent 靠 skill + 自身推理检索。
   * ★ 关掉的是"注入哪些工具"，**不是** `type:"http"` 那个字段值（那个有真进程
   * 测试守着，恒不变）—— 空数组和一个 http server 是同一段代码的两个分支。
   */
  hostToolsEnabled?: boolean
  /** 更新我们库里的 acp_session_id */
  onSessionIdChanged: (recordId: string, acpSessionId: string) => void
  /** 进入/退出 replay 抑制窗口 */
  beginReplaySuppression: (recordId: string) => () => void
}

export interface EnsureSessionResult {
  acpSessionId: string
  /** 是否走了降级重建（调用方据此决定要不要回灌历史） */
  rebuilt: boolean
}

export class AcpSupervisor {
  /** 待回灌上下文的 session（降级重建后，下一次 prompt 时带上历史） */
  private readonly pendingContextReplay = new Set<string>()

  constructor(private readonly options: AcpSupervisorOptions) {}

  /**
   * 确保 session 可用。
   *
   * 顺序：resume（不 replay，省去去重）→ 失败则 new + 标记待回灌。
   */
  async ensureSession(record: SessionRecord): Promise<EnsureSessionResult> {
    if (record.acpSessionId !== null) {
      // 无论 resume 还是 load，都进抑制窗口：即使 resume 号称不 replay，
      // 「号称」不是契约 —— 而抑制窗口的成本只是几个事件不落库。
      const endSuppression = this.options.beginReplaySuppression(record.id)
      try {
        await this.options.client.request("session/resume", {
          sessionId: record.acpSessionId,
          cwd: record.cwd,
          // ★ 每次都要重传 mcpServers：token 会轮换，而旧 token 已被撤销
          mcpServers: this.mcpServersFor(record),
        })
        return { acpSessionId: record.acpSessionId, rebuilt: false }
      } catch (error) {
        this.options.logger?.warn("acp session resume failed, rebuilding", {
          sessionId: record.acpSessionId,
          detail: error instanceof Error ? error.message : String(error),
        })
      } finally {
        endSuppression()
      }
    }

    const created = (await this.options.client.request<{ sessionId: string }>("session/new", {
      cwd: record.cwd,
      mcpServers: this.mcpServersFor(record),
    })) satisfies { sessionId: string }

    this.options.onSessionIdChanged(record.id, created.sessionId)
    // 下次 prompt 时把我们库里的历史作为 content block 回灌。
    this.pendingContextReplay.add(created.sessionId)
    return { acpSessionId: created.sessionId, rebuilt: true }
  }

  /** 该 session 是否需要回灌历史（降级重建后为 true，回灌一次后清除）。 */
  needsContextReplay(acpSessionId: string): boolean {
    return this.pendingContextReplay.has(acpSessionId)
  }

  markContextReplayed(acpSessionId: string): void {
    this.pendingContextReplay.delete(acpSessionId)
  }

  /**
   * 宿主工具的**唯一**注入通道。
   *
   * 实测 ACP 侧只支持两种形态：HTTP/SSE（url + headers）或
   * local stdio（command + args + env）。传空数组 = agent 手上一个检索工具都没有。
   *
   * 走 HTTP 而不是 local stdio 的理由：与 Feed Server 同构（同一套鉴权与
   * 生命周期）、工具实现能直接读 SQLite、且不增加子进程数。
   * `type` 的取值见 `McpServerSpec` 上的注释 —— 那一个字段值不能猜。
   *
   * ★ token 按 **scopeId** 签发（persona → conversationId），不是按 kind：
   * 共用 token 会让 local_recall 对任一 agent 全库可见 →
   * 群聊里的一句 injection 就能召回单聊内容。
   */
  private mcpServersFor(record: SessionRecord): McpServerSpec[] {
    // 默认注入（hostToolsEnabled 未显式给或为 true）；显式 false → agent 无宿主工具。
    if (this.options.hostToolsEnabled === false) return []
    return [
      {
        type: "http",
        name: "mycontext",
        url: `http://127.0.0.1:${this.options.mcpPort}/mcp`,
        headers: [
          {
            name: "Authorization",
            value: `Bearer ${this.options.mcpAuth.issue({
              kind: record.kind,
              scopeId: record.scopeId,
            })}`,
          },
        ],
      },
    ]
  }

  /**
   * 释放 session。
   *
   * ★ 必须**自己**撤 token：实测 `closeSession`（acp/service.ts:339-348）
   * 只做 `session.remove` + `registeredMcp.delete` + `sessionSnapshots.delete`
   * + `abortBackingSession`，**没有 `mcp.disconnect`** ——
   * 不主动撤的话，被淘汰会话的 MCP 连接与 token 会存活到进程退出
   * （连接泄漏 + token 永不轮换）。
   */
  async dispose(record: SessionRecord): Promise<void> {
    if (record.acpSessionId !== null) {
      await this.options.client
        .request("session/close", { sessionId: record.acpSessionId })
        .catch(() => {
          // 关不掉也要继续撤 token：token 泄漏比一个僵尸 session 更危险。
        })
      this.pendingContextReplay.delete(record.acpSessionId)
    }
    // 撤销要带 kind：search 与 persona 的 scopeId 来自不同命名空间但共用
    // 一张签发表，只按 scopeId 撤会误撤另一类同名 scope 的 token。
    this.options.mcpAuth.revoke({ kind: record.kind, scopeId: record.scopeId })
  }
}
