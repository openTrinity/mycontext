/**
 * 搜索服务。
 *
 * ## 降级链（每一档都在 UI 上明示，不静默降质）
 *
 * ① opencode 可用 → ACP agent 编排检索并生成答案；
 * ② opencode 缺失/起不来/turn 失败 → **直接展示召回列表**（带命中高亮），不编答案；
 * ③ 连本地索引都没建好 → 提示"正在建索引"。
 *
 * 「答案质量突然变差」比「明确告知能力降级」难排查得多，
 * 所以每一档都有对应的 `degradedReason` 传给 UI。
 *
 * ## 为什么 agent 缺失时仍然可用
 *
 * 实测 opencode 二进制 102MB 且不随包分发（见 §1.5），
 * 因此"没装"是**常态**而不是异常。第二档虽然不生成答案，
 * 但「按相关性排序的原文列表 + 可跳转」本身就有完整的产品价值。
 *
 * ## ACP 接线（M2）
 *
 * `prompt()` 先尝试走 agent turn（懒启动一个 opencode 进程 + 一个 `AcpClient`，
 * 每个 session 一个 `ChatItemReducer`）；**任一步失败都落回第二档 recallOnly**，
 * 并把降级原因带给 UI。落用户消息 → setState(streaming) → 产 items → 落库 →
 * setState(idle) 的骨架与落库/推流形状**保持不变**（见 §3.2）——
 * 只是产 items 的来源从 FTS 换成 ACP 事件流。
 */
import { join, delimiter } from "node:path"
import { mkdirSync } from "node:fs"
import type { BrowserWindow } from "electron"
import { AppError, type Clock, type Logger } from "@mycontext/kernel"
import {
  FtsIndexRepository,
  MessageRepository,
  SearchSessionRepository,
  type SqliteDatabase,
} from "@mycontext/store"
import { recallMessages } from "@mycontext/retrieval"
import { agentHomeFor, type AgentDirs } from "./agent-dirs.js"
import {
  AcpClient,
  AcpSupervisor,
  ChatItemReducer,
  McpAuth,
  buildOpencodeSpawn,
  createReverseHandlers,
  mapSessionUpdate,
  resolveGatewayModelConfig,
  resolveModelName,
  textBlock,
  toPlainText,
  type AgentEvent,
  type ChatItem,
  type UnifiedContentBlock,
} from "@mycontext/agent-runtime"
import {
  IPC_EVENTS,
  type SearchChatItem,
  type SearchSessionDetail,
  type SearchSessionSummary,
} from "@mycontext/ipc-contract"
import type {
  DuplexHandle,
  OpencodeResolution,
  ProcessRunner,
  RuntimeEnv,
} from "@mycontext/runtime-env"
import { createAgentResolver, probeBinaryVersion } from "@mycontext/runtime-env"

/** 直出召回列表时最多给多少条。再多用户也不会看，而且会把窗口撑爆。 */
const FALLBACK_RECALL_LIMIT = 20

/**
 * 宿主 MCP server 端口。第一期 kl 走 opencode **skill**（`kl` CLI），
 * 不注入宿主工具（`hostToolsEnabled:false`），所以这个端口目前不会被真正连上 ——
 * 但 `AcpSupervisor` 的构造仍需要它（`type:"http"` 那段代码恒在，只是不产出 server）。
 */
const HOST_MCP_PORT = 47_999

/**
 * **协议动作**的超时（`initialize` / `session/new` / `session/dispose`）。
 *
 * 这些要么毫秒级返回，要么就是真的坏了（opencode 没起来 / 协议不匹配）。
 * 30s 足够宽松，同时保证一个起不来的子进程不会让调用方永久挂住。
 *
 * ★ `session/prompt`**不**走这个值 —— 见 `ACP_METHOD_TIMEOUTS`。
 */
const ACP_PROTOCOL_TIMEOUT_MS = 30_000

/**
 * 按方法覆盖超时。`null` = 不设限。
 *
 * ## ★★ 为什么 agent turn 不该有墙钟超时
 *
 * 原来整个 client 共用一个 120s，实测的后果是**掐掉快要成功的长查询**：
 * 一次跨消息+文档的汇总问题跑了 8 次检索，116s 时第 8 条命令还在跑，
 * 120s 到点整轮被拒 → 降级成「本地召回」，页面上只剩两段原文。
 * 而本地其实已经搜到了要的东西（85 条 PPL、248 个商机），
 * 只是没来得及归纳成答案。
 *
 * 一轮 agent turn 的耗时取决于模型决定调几次工具，那不是我们能预估的量 ——
 * 按一个猜出来的秒数掐它，掐掉的是"慢但有效"，而不是"坏了"。
 *
 * ## 那靠什么终止
 *
 * 靠**事实**而不是推测：子进程死了 / 连接断了 → `AcpClient.close()`
 * 会拒掉所有在途请求（见那里的注释）；用户不想等了 → 关窗口 / 停服务。
 * 这与 `KlServerService.awaitIngest` 删掉墙钟超时是同一个判断
 * （那条也曾把正常建图误报成「超时失败」并触发 30 分钟退避）。
 *
 * 代价是"卡住时界面一直显示在搜" —— 但那与事实一致（模型确实还在跑），
 * 比谎报一个失败并把已搜到的数据丢掉要诚实。
 */
const ACP_METHOD_TIMEOUTS = { "session/prompt": null } as const

/**
 * 回灌历史时单条**助手答案**保留的字数上限（用户提问不截断 —— 那是问题本身）。
 *
 * 为什么要截：真机翻车过一次，模型把回灌里上一轮的完整答案整段复述进了新答案
 * （见 `buildPromptBlocks` 的注释）。回灌只需要让它"记得聊过什么"，不需要逐字
 * 还原；短摘要既够用，也大幅降低被整段抄走的诱惑。
 */
const HISTORY_ANSWER_MAX_CHARS = 200

export interface SearchServiceOptions {
  clock: Clock
  logger: Logger
  runtime: RuntimeEnv
  /** 外部进程统一走它（超时/取消/日志脱敏），opencode 也不例外 */
  processes: ProcessRunner
  /**
   * agent workspace 与隔离 HOME —— **在 attach 时给，不在构造时给**。
   *
   * ★ 这两个目录按 vault 分（workspace 里有 transcript 片段 = 聊天内容）。
   * 构造时锁死的话，切身份后新会话仍落在上一个身份的目录里，
   * 而那个错误是静默的（agent 能跑、结果也出来，只是文件写在别人那儿）。
   *
   * 首版这里是 `workspaceRoot: string` + `agentHome?: string` 两个构造参数，
   * 而 `attach(db)` 只换 db —— 于是 `create()` 里读到的永远是构造时那份。
   * 见 `AgentDirs`。
   */
  /**
   * 随包分发的 skill 目录（`kl` 等）。**应用级** —— 它是随包的只读资源，
   * 与身份无关（走 `skills.paths` 指目录，不拷进 workspace）。
   */
  skillsDir?: string
  /**
   * kl-graph 代码根（含可执行的 `kl`）。用于把 klRoot 前插进 opencode 进程的
   * PATH，让 skill 里的裸 `kl` 命中它。skill 内容本身由 `skillsDir` 提供
   * （单一来源 + `check:kl-skill-sync` 门禁），这里只负责让 `kl` 命令可执行。
   */
  klRoot: string
  /** 主渠道 kl-server 的端口（默认档位与 `all` 档都连它）。 */
  klPort: number
  /**
   * 主渠道的 id。默认档位（= 存量会话的档位）就是它。
   *
   * ★ 为什么要显式给而不是写死 `"dingtalk"`：这个判据同时决定
   * 「用哪个 HOME」与「要不要开 isolateData」，而两者都影响**存量会话
   * 能不能 resume**。写死一个字符串的话，哪天主渠道换了名字，
   * 所有存量会话会静默降级一次而没人知道原因。
   */
  primaryChannelId: string
  /**
   * 某个非主渠道的 kl 端口（`channelId → port`）。
   *
   * ★ **函数**：端口由 `ChannelPipelineManager` 在登录后真探测后分配，
   * 而本服务在装配阶段就构造好了。返回 undefined = 那个渠道没挂管线
   * （没连 / 还在挂载中）→ 退回主渠道端口。
   */
  klPortOf?: (channelId: string) => number | undefined
  /** 全部已挂渠道的 kl 端口（`all` 档注入 `KL_GRAPHS_JSON` 用）。 */
  klGraphs?: () => Readonly<Record<string, number>>
  /**
   * 取激活后的 Python 环境（`VIRTUAL_ENV` + `PATH` 前插 venv/bin）。
   *
   * agent 进程需要它：skill 里跑的裸 `kl` 要命中我们生成的 wrapper
   * （上游那个硬编码了不存在的 `.venv/bin/python`）。
   * 返回 null = 环境不可用，agent 仍能起（只是查不了图谱）。
   */
  getPythonEnv?: () => Promise<{ python: string; env: NodeJS.ProcessEnv } | null>
  /**
   * 搜索 agent 用哪个模型（`runtimeConfig.resolved().modelMain`）。
   *
   * ★ 回调而不是值：opencode 是懒启动的单例进程，而用户可能在那之前
   * 或之后改设置。传值会锁死在构造那一刻 —— 表现是"改了模型不生效"。
   *
   * 不给 = 退回 env（`MYCONTEXT_MODEL_MAIN`）再退回内置默认。
   */
  getModel?: () => string
  /**
   * 搜索 agent 用哪个协议（`runtimeConfig.resolved().mainProvider`）。
   * 不给 = 退回 env（`MYCONTEXT_MODEL_PROVIDER`）再退回 openai。与 getModel 同理由。
   */
  getProvider?: () => string
  getWindow: () => BrowserWindow | null
}

/**
 * 一个 opencode 进程 + 它的 ACP client 的句柄。
 *
 * 一个进程承载全部 search session（实测多 session 省 5.1×），
 * 所以这是**单例懒启动**：第一次有 prompt 才起。
 */
interface AgentHandle {
  transport: DuplexHandle
  client: AcpClient
  supervisor: AcpSupervisor
  serverPassword: string
}

export class SearchService {
  private db: SqliteDatabase | null = null
  /**
   * 渠道知识库保持物理隔离：这里仅保存只读查询入口，绝不把数据复制进主库。
   * key 是 channelId（当前为 feishu；主库固定视为 dingtalk）。
   */
  private readonly sourceDbs = new Map<string, SqliteDatabase>()
  private sessions: SearchSessionRepository | null = null

  /**
   * 懒启动的 opencode 句柄。null = 还没起（或已 dispose）。
   * 起失败时保持 null（下次 prompt 再试），并让本轮落回 recallOnly。
   */
  /**
   * 懒启动的 opencode 句柄，**按档位一个**。
   *
   * ## ★★ 为什么必须按档位分进程，而不是一个进程查多个图
   *
   * kl 的连接目标是 `KL_SERVER_PORT`，而那是 **spawn 那一刻的 env** ——
   * 一个进程起来之后改不了。而每个档位要连的 kl 不同（一渠道一个 kl）。
   * 所以"这次搜索查哪些图"这件事只能落在进程边界上。
   *
   * ★ 每个档位还必须有**自己的 HOME**：opencode 的 session 存储在
   * `$XDG_DATA_HOME/opencode/opencode.db`，实测两个 opencode 共用一个数据
   * 目录时后起的那个撞在 `CREATE TABLE workspace` 上直接起不来。
   * 见 `agentHomeFor` 与 `applyHomeIsolation` 的 `isolateData`。
   */
  private readonly agents = new Map<string, AgentHandle>()
  /** 正在进行的 ensureAgent，**按档位**（避免并发 prompt 起多个进程）。 */
  private readonly agentStarting = new Map<string, Promise<AgentHandle | null>>()

  /**
   * 每个 session 一个 reducer（流式聚合按 session 隔离；跨轮续 seq）。
   * key = 我们库里的 sessionId（不是 acpSessionId）。
   */
  private readonly reducers = new Map<string, ChatItemReducer>()

  /**
   * token 签发器。按 scopeId（= sessionId）签发，dispose 时按 scope 撤。
   * 第一期不注入宿主工具，但 supervisor 构造需要它。
   */
  private readonly mcpAuth: McpAuth

  constructor(private readonly options: SearchServiceOptions) {
    this.mcpAuth = new McpAuth({ clock: options.clock })
  }

  /** opencode 解析 + 版本闸，**成功后**缓存（见 PersonaAcp 里同款注释）。 */
  /** 当前 vault 的 agent 目录（attach 时给）。未登录时 null。 */
  private dirs: AgentDirs | null = null
  private opencodeResolver: (() => OpencodeResolution) | null = null

  private resolveOpencode(): OpencodeResolution {
    this.opencodeResolver ??= createAgentResolver(this.options.runtime, probeBinaryVersion)
    return this.opencodeResolver()
  }

  attach(
    db: SqliteDatabase,
    dirs: AgentDirs,
    sources: readonly { channelId: string; db: SqliteDatabase }[] = [],
  ): void {
    this.db = db
    this.dirs = dirs
    this.sourceDbs.clear()
    for (const source of sources) this.sourceDbs.set(source.channelId, source.db)
    this.sessions = new SearchSessionRepository(db)
  }

  detach(): void {
    this.db = null
    this.dirs = null
    this.sourceDbs.clear()
    this.sessions = null
    // 换库（登出/切 vault）时旧 session 的流式状态作废。
    this.reducers.clear()
  }

  /**
   * 当前 vault 的 agent 目录。
   *
   * ★ 未 attach 时抛错而不是退回一个应用级目录：那种兜底会让"忘了 attach"
   * 表现成"workspace 落在了公共目录"—— 一次静默的跨身份写入。
   */
  private requireDirs(): AgentDirs {
    const dirs = this.dirs
    if (dirs === null) throw new AppError("DB_UNAVAILABLE", "尚未登录，agent 目录未就绪")
    return dirs
  }

  /**
   * ACP 编排是否**已接线**。
   *
   * ★ 刻意保留这个显式常量（`search-degrade.test.ts` 门禁扫它）。
   *
   * 它回答的是「代码里 prompt 是否真有 agent 分支」——**不是**「本机装没装
   * opencode」。装了 opencode（能力具备）但本轮 ensureAgent 失败时，UI 仍要
   * 看到降级横幅，那个判据跟着**运行时实际路径**走（见 `pushStream` 的
   * `degradedReason`），不是这个常量。
   *
   * 接线完成后这里是 true：prompt 里确有 `ensureAgent`/`ensureSession`/`acp` 调用。
   */
  private static readonly ACP_WIRED = true

  /**
   * Agent 运行时是否**可能**可用（= UI 是否该默认按"有 agent"呈现）。
   *
   * opencode 装没装只是**必要条件**之一，不是本轮实际路径 —— 见 `ACP_WIRED`
   * 与 `prompt()` 里随流带下去的 `degradedReason`。
   */
  agentAvailable(): boolean {
    return SearchService.ACP_WIRED && this.resolveOpencode().ok
  }

  list(): SearchSessionSummary[] {
    const sessions = this.sessions
    if (sessions === null) return []
    return sessions.listActive().map(toSummary)
  }

  detail(sessionId: string): SearchSessionDetail {
    const sessions = this.requireSessions()
    const session = sessions.findById(sessionId)
    if (session === null) {
      throw new AppError("IPC_BAD_REQUEST", "会话不存在", { context: { sessionId } })
    }
    return {
      session: toSummary(session),
      items: sessions.messages(sessionId).map((row) => ({
        id: row.id,
        seq: row.seq,
        role: row.role,
        itemType: row.itemType as SearchChatItem["itemType"],
        contentJson: row.contentJson,
        toolName: row.toolName,
        toolStatus: row.toolStatus as SearchChatItem["toolStatus"],
        turnId: row.turnId,
        createdAt: row.createdAt,
      })),
      agentAvailable: this.agentAvailable(),
      // detail 是"打开会话时的静态快照"：这里给不出"上一轮走了哪条路"
      // （那是 prompt 期间的运行时事实，随 searchStream 带下去）。null = 不主动标降级。
      degradedReason: null,
    }
  }

  /**
   * 建会话。
   *
   * 标题取查询的前 40 字符 —— 一期不用模型生成标题：
   * 那要多一次调用、多一次失败路径，而截断的查询已经足够辨认。
   * 用户可以重命名。
   */
  /**
   * 建会话。`scope` 决定它去问哪几个图（见 `createSearchSessionInputSchema`）。
   *
   * ★ 不给就是主渠道 —— 与迁移 v24 的 DEFAULT 一致。两处的缺省必须相同，
   * 否则"新建的会话"与"迁移填的存量会话"档位不一样，而看不出来。
   */
  create(query: string, scope?: string): SearchSessionSummary {
    const sessions = this.requireSessions()
    const now = this.options.clock.now()
    const id = `srch_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const cwd = join(this.requireDirs().workspaceRoot, "search", id)
    mkdirSync(cwd, { recursive: true })
    /**
     * ★ 不再 cpSync skill 到 cwd —— 走 `skills.paths` 指目录。
     *
     * opencode 起进程时会拿到 `OPENCODE_CONFIG_CONTENT.skills.paths`，直接
     * 从 `resources/skills/` 扫 `kl/SKILL.md`；skill 缺失只记一次 warn，
     * 不影响会话创建（本地检索仍可用）。
     */
    if (this.options.skillsDir === undefined || this.options.skillsDir === "") {
      this.options.logger.warn("skills dir missing; graph query unavailable")
    }

    const created = sessions.create({
      id,
      acpCwd: cwd,
      title: query.slice(0, 40),
      createdAt: now,
      graphScope: scope ?? this.options.primaryChannelId,
    })
    return toSummary(created)
  }

  rename(sessionId: string, title: string): void {
    this.requireSessions().rename(sessionId, title)
  }

  setPinned(sessionId: string, pinned: boolean): void {
    this.requireSessions().setPinned(sessionId, pinned)
  }

  remove(sessionId: string): void {
    this.requireSessions().remove(sessionId)
    this.reducers.delete(sessionId)
  }

  /**
   * 提交一个查询。
   *
   * 先尝试 agent turn（§3.2）；agent 不可用/失败则落回第二档 recallOnly，
   * 并把降级原因带给 UI。**落库与推事件的形状不变** —— 这是把 ChatItem
   * 同时作为落库形态与渲染形态的收益。
   */
  async prompt(sessionId: string, query: string): Promise<void> {
    const sessions = this.requireSessions()
    const now = this.options.clock.now()

    // 用户消息先落库：这样刷新页面也看得到自己刚问的问题。
    const userSeq = sessions.nextSeq(sessionId)
    sessions.appendMessages([
      {
        id: `${sessionId}_${userSeq}`,
        sessionId,
        seq: userSeq,
        role: "user",
        itemType: "message",
        contentJson: JSON.stringify([textBlock(query)]),
        createdAt: now,
      },
    ])
    sessions.setState(sessionId, "streaming", now)
    this.pushStream(sessionId, [], false, null)

    try {
      // ① 先试 agent turn。返回 false = agent 不可用/中途失败 → 落回召回。
      const ranAgent = await this.tryAgentTurn(sessionId, query)
      if (ranAgent) {
        sessions.setState(sessionId, "idle", this.options.clock.now())
        this.pushStream(sessionId, [], true, null)
        return
      }

      /**
       * ② 第二档降级：只做召回，不生成答案。
       *
       * ★ 按会话的档位过滤召回源 —— 否则"只搜钉钉"的会话在降级时会看到
       * 飞书的消息，而用户看不出这一轮走的是哪条路（两条路的结果长得一样）。
       */
      const items = this.recallOnly(sessionId, query, sessions.findById(sessionId)?.graphScope)
      sessions.appendMessages(items.map((item) => toAppendInput(sessionId, item)))
      sessions.setState(sessionId, "idle", this.options.clock.now())
      this.pushStream(sessionId, [], true, this.degradedReason())
    } catch (error) {
      // ③ 任一步抛错（含召回本身失败）：落 error item + setState(error)。
      const detail = error instanceof Error ? error.message : String(error)
      const errorSeq = sessions.nextSeq(sessionId)
      sessions.appendMessages([
        {
          id: `${sessionId}_${errorSeq}`,
          sessionId,
          seq: errorSeq,
          role: "system",
          itemType: "error",
          contentJson: JSON.stringify([textBlock(detail)]),
          createdAt: this.options.clock.now(),
        },
      ])
      sessions.setState(sessionId, "error", this.options.clock.now())
      this.pushStream(sessionId, [], true, null)
      this.options.logger.warn("search prompt failed", { sessionId, detail })
    }
  }

  /**
   * 用户点了"停止"：取消该 session 当前正在跑的 turn。
   *
   * 两件事都要做，缺一不可：
   *
   * ① **告诉 opencode 停下** —— `session/cancel` 通知（ACP 里取消是通知不是请求，
   *    没有响应可等）。发到 `acpSessionId` 而不是我们库里的 sessionId。
   * ② `reducer.cancelTurn(turnId)` —— 挡住取消瞬间可能已在路上的 update，
   *    它们不该再落库/推流。
   *
   * ★ 为什么必须有 ①（这是原实现的 bug）：原来只做了 ②，注释里写着"ACP 侧的
   * 取消第一期先不发，opencode 那轮会自然结束"。但那意味着**模型仍在全速生成、
   * 继续烧 token**，只是我们把结果丢掉——用户点了停止，UI 停了，账单没停。
   * 真进程实测（对照组）：同一个任务不取消跑完 9.4s / 102 条 update / 2817 tokens；
   * 发 `session/cancel` 后 prompt 在**取消那一刻**就 resolve（6.0s）、
   * 之后 **0** 条新 update、usage **0** token。也就是说这个通知真的有效，
   * 而不发就是白烧。
   *
   * 发通知**不 await**：它是 fire-and-forget 的写管道操作，而 `cancel` 是 IPC
   * 同步返回的（契约是 `Promise<true>`，语义为"已受理"）。写失败只记日志——
   * 此时 ② 已经生效，UI 该停的已经停了，不该因为管道抖动把取消变成报错。
   *
   * 只对**当前活跃 turn** 生效；没有活跃 turn 时是 no-op。
   * turn 结束时 `prompt()` 仍会 setState(idle) 收尾。
   */
  cancel(sessionId: string): void {
    /**
     * 表按 `acpSessionId` 索引，而这里收到的是**我们库里的** sessionId ——
     * 遍历找。会话数是个位数（搜索）到十位数（数字分身 maxResident=8），
     * 为此再维护一张反查表只会多一个会漂的状态。
     */
    const active = [...this.activeTurns.values()].find((t) => t.sessionId === sessionId)
    if (active === undefined) return
    active.reducer.cancelTurn(active.turnId)
    void active.client
      .notify("session/cancel", { sessionId: active.acpSessionId })
      .catch((error: unknown) => {
        this.options.logger.warn("acp cancel notify failed", {
          sessionId,
          detail: error instanceof Error ? error.message : String(error),
        })
      })
  }

  /**
   * 走一轮真正的 agent turn。成功产出并落库 → 返回 true；
   * agent 不可用 / 起不来 / turn 中途失败 → 返回 false（由 prompt 落回召回）。
   *
   * 失败**不抛**（抛会走到 error 档，而"agent 起不来"应当是降级不是报错）——
   * 只有落库/推流这类"我们自己"的错误才该冒泡到 prompt 的 catch。
   */
  private async tryAgentTurn(sessionId: string, query: string): Promise<boolean> {
    if (!SearchService.ACP_WIRED) return false
    if (!this.resolveOpencode().ok) return false

    const sessions = this.requireSessions()
    const record = sessions.findById(sessionId)
    if (record === null) return false

    /**
     * ★ 档位来自**这个会话**（建会话时定的），不是全局配置。
     * 读不到就用主渠道 —— 那是存量会话的行为。
     */
    const scope = record.graphScope === "" ? this.options.primaryChannelId : record.graphScope
    const agent = await this.ensureAgent(scope)
    if (agent === null) return false

    try {
      // (a) 每轮**新建**一个 reducer，startSeq 从库里 maxSeq+1 续。
      //
      // ★ 必须新建、不能复用上一轮的：reducer 内部维护自己的 seq 计数器
      // （从构造时的 startSeq 起自增），复用的话它还停在上一轮的尾号，
      // 忽略这一轮的 startSeq —— 第 2 轮起 assistant 的 seq/id 会与本轮**用户
      // 消息**撞号，INSERT OR IGNORE 撞后走 updateMessage，把用户问题的内容
      // 覆盖成答案（实测级数据损坏）。历史去重集合每轮都用 primeFromHistory
      // 从库重灌，所以新建不丢任何跨轮需要的状态。
      //
      // 在 ensureSession **之前**建：resume 的抑制窗口回调按 sessionId 找 reducer
      // （见 startAgent 的 beginReplaySuppression），要能找到这一轮的这个。
      const startSeq = sessions.nextSeq(sessionId)
      const reducer = new ChatItemReducer({
        startSeq,
        newId: (seq) => `${sessionId}_${seq}`,
        now: () => this.options.clock.now(),
      })
      this.reducers.set(sessionId, reducer)
      // 用库里已有 items 预热去重集合（replay 尾巴才认得出是历史）。
      reducer.primeFromHistory(this.historyForPrime(sessionId))

      // (b) 确保 ACP session 就绪（resume→new 降级；rebuilt 时待回灌历史）。
      const ensured = await agent.supervisor.ensureSession({
        id: record.id,
        acpSessionId: record.acpSessionId,
        cwd: record.acpCwd,
        kind: "search",
        scopeId: record.id,
      })

      // (c) turnId 贯穿本轮所有 update（ACP 通知只带 sessionId，不带 turnId）。
      const turnId = `turn_${startSeq}`

      // ★ 登记本轮为「我们自己发起的」turn：它的流式输出豁免 replay 警戒期的
      // 扣留。不加这一句，每一轮（第 2 轮起都要先 resume）本轮答案的前 5 秒
      // （宽限期）会被扣住不外泄 —— 表现是发完问题干等十几秒才见第一个动静。
      // 见 ChatItemReducer.beginTurn 的注释。
      reducer.beginTurn(turnId)

      // (d) 按 acpSessionId 登记本轮：进程级 onNotification 转发器据此把
      //     session/update 送到对的 session/turn/reducer（见 activeTurns）。
      //     同时记下 acpSessionId + client —— `cancel()` 要靠它们真发
      //     `session/cancel` 给 opencode（见 cancel 的说明）。
      this.activeTurns.set(ensured.acpSessionId, {
        sessionId,
        turnId,
        reducer,
        acpSessionId: ensured.acpSessionId,
        client: agent.client,
      })

      // (e) 降级重建后回灌历史：把库里对话作为额外上下文块拼进本次 prompt。
      const promptBlocks = this.buildPromptBlocks(sessionId, query, agent, ensured.acpSessionId)

      // (f) 发 prompt。
      //
      // ★ 这里**不**再套 beginReplaySuppression：resume 的历史尾巴由
      // ensureSession 自己的抑制窗口 + reducer 的宽限期（replayGraceMs）挡住,
      // 而本轮的**实时答案**恰恰在 prompt 请求进行中通过 session/update 到达 ——
      // 若把它也罩进抑制窗口，`emit` 会因 inReplayWindow 直接返回 null,
      // 答案一个字都不会落库（实测：assistant message 消失）。
      await agent.client.request("session/prompt", {
        sessionId: ensured.acpSessionId,
        prompt: promptBlocks,
      })

      // (g) turn_end 不是某条 update，而是 prompt 响应 resolve（§11.3）——
      // 手动合成喂给 reducer 定稿，再把定稿项落库 + 推流。
      this.flushEvents(sessionId, reducer, [{ type: "turn_end", turnId }])
      this.activeTurns.delete(ensured.acpSessionId)
      return true
    } catch (error) {
      // agent 中途失败：降级不是报错。清掉本轮 reducer（半截状态不可信），落回召回。
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn("search agent turn failed, falling back to recall", {
        sessionId,
        detail,
      })
      this.reducers.delete(sessionId)
      /**
       * ★ 只清**这一个** session 的登记，不清整张表。
       *
       * 单例时代这里是 `activeTurn = null`，语义恰好等价。改成表之后
       * 照抄成 `activeTurns.clear()` 就会在并发下把别的会话正在跑的 turn
       * 一起抹掉 —— 那些 turn 的 update 随后全被丢弃，表现是"另一个会话
       * 突然不回了"，而它自己那一侧没有任何错误。
       *
       * 失败可能发生在 `ensureSession` 之前（那时还没登记），所以按 id 删
       * 而不是断言存在 —— `Map.delete` 对不存在的键是 no-op。
       */
      for (const [key, turn] of this.activeTurns) {
        if (turn.sessionId === sessionId) this.activeTurns.delete(key)
      }
      return false
    }
  }

  /**
   * 正在流式的 turn，**按 `acpSessionId` 索引**。
   *
   * ## ★ 为什么是一张表而不是单个 activeTurn
   *
   * 曾经是 `activeTurn: {...} | null`，理由写着「search 的 prompt 是串行的
   * （一个用户、一次一问），同一时刻只有一个 turn 在跑」——对搜索成立。
   *
   * 但数字分身**天生并发**：管控层的 `maxResident` 默认 8，8 个会话可能同时
   * 来消息，各自一个 opencode session。单例在那时的表现不是报错，而是
   * **串台**：后登记的 turn 覆盖前一个，于是 A 会话的回答被写进 B 会话的
   * 对话流 —— 而两边都不会有任何异常。
   *
   * ACP 的 `session/update` 只带 `sessionId`（不带 turnId，见
   * session-update-mapper 的文件头），所以 `acpSessionId` 就是天然的分派键。
   *
   * ## 键是 acpSessionId，不是我们库里的 sessionId
   *
   * 通知里带的是 **ACP 的** session id，两者不是一个东西。用我们的 id 当键
   * 就得先做一次反查，而那张反查表又是一个会漂的状态。
   *
   * `client` 存进来是给 `cancel()` 用的：取消要发 `session/cancel` 到
   * ACP 的 session 上，而 client 是发通知的口子。
   */
  private readonly activeTurns = new Map<
    string,
    {
      sessionId: string
      turnId: string
      reducer: ChatItemReducer
      acpSessionId: string
      client: AcpClient
    }
  >()

  /** 收到一条 ACP 通知：按 sessionId 找到对的 turn → 映射 → reducer → 落库推流。 */
  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return
    /**
     * ★ 从 params 里取 `sessionId` 来分派。
     *
     * 取不到时**丢弃**而不是投给"唯一那个 turn" —— 后者在并发下就是串台，
     * 而串台比丢一条 update 糟得多（丢了顶多少一段流式文本，串台会把
     * 别人的回答写进这个会话）。
     */
    const acpSessionId = (params as { sessionId?: unknown } | null)?.sessionId
    if (typeof acpSessionId !== "string") return
    const active = this.activeTurns.get(acpSessionId)
    if (active === undefined) return
    const events = mapSessionUpdate(params, active.turnId)
    if (events.length === 0) return
    this.flushEvents(active.sessionId, active.reducer, events)
  }

  /** 把一批 AgentEvent 过 reducer，touched 项增量落库并推流给 UI。 */
  private flushEvents(
    sessionId: string,
    reducer: ChatItemReducer,
    events: readonly AgentEvent[],
  ): void {
    const result = reducer.apply(events)
    if (result.touched.length === 0) return
    const sessions = this.requireSessions()
    // INSERT OR IGNORE + 有则更新：reducer 的 touched 既含新建也含流式更新的项。
    for (const item of result.touched) {
      const input = toAppendInput(sessionId, item)
      const inserted = sessions.appendMessages([input])
      if (inserted === 0) {
        // 已存在 → 更新可变字段（流式增长的内容/工具状态/用量）。
        // exactOptionalPropertyTypes：只放非 null 的键，别塞 undefined。
        const patch: { contentJson?: string; toolStatus?: string; usageJson?: string } = {
          contentJson: input.contentJson,
        }
        if (input.toolStatus != null) patch.toolStatus = input.toolStatus
        if (input.usageJson != null) patch.usageJson = input.usageJson
        sessions.updateMessage(item.id, patch)
      }
    }
    this.pushStream(sessionId, result.touched.map(toStreamItem), false, null)
  }

  /**
   * 懒启动 opencode + AcpClient + AcpSupervisor（单例）。
   *
   * 起失败返回 null（保持 agent=null，下次再试）；并发调用共享同一次启动。
   * ★ 必须走 `buildOpencodeSpawn`（spawn-wiring 门禁扫源码），且反向 handler
   * 必须实现（不实现的话工具调用被静默拒绝）。
   */
  private async ensureAgent(scope: string): Promise<AgentHandle | null> {
    const existing = this.agents.get(scope)
    if (existing !== undefined) return existing
    const starting = this.agentStarting.get(scope)
    if (starting !== undefined) return starting

    const pending = this.startAgent(scope).finally(() => {
      this.agentStarting.delete(scope)
    })
    this.agentStarting.set(scope, pending)
    return pending
  }

  /**
   * 这个档位要连的 kl 端口。
   *
   * · 单渠道档（`dingtalk` / `feishu` / …）→ 那个渠道的 kl；
   * · `all` → 主渠道的端口（**同时**注入 `KL_GRAPHS_JSON` 让 skill 知道
   *   全部图的端口，见 `startAgent`）。
   *
   * 找不到那个渠道的端口时退回主渠道：那时该档位查不到它想查的图，
   * 但**仍能查到主渠道的** —— 比整个搜索起不来好。
   */
  /**
   * `all` 档要注入的全部图端口。
   *
   * 没接 `klGraphs` 时只给主渠道那一个 —— 那时 `all` 退化成"只查主渠道"，
   * 而这是**诚实的降级**（我们确实只知道一个图的位置）。
   */
  private klGraphsMap(): Readonly<Record<string, number>> {
    const graphs = this.options.klGraphs?.()
    return graphs === undefined || Object.keys(graphs).length === 0
      ? { [this.options.primaryChannelId]: this.options.klPort }
      : { [this.options.primaryChannelId]: this.options.klPort, ...graphs }
  }

  private klPortFor(scope: string): number {
    if (scope === "all" || scope === this.options.primaryChannelId) return this.options.klPort
    return this.options.klPortOf?.(scope) ?? this.options.klPort
  }

  /**
   * 激活后的 Python 环境（缓存一次）。
   *
   * 缓存是因为 `getPythonEnv` 可能要下载/装依赖 —— 那是**一次性**的事，
   * 而 startAgent 每次 agent 重起都会调到。null 也缓存（避免反复重试
   * 一个注定失败的准备过程，那会让每次 prompt 都卡几秒）。
   */
  private pythonEnvCache: { value: { python: string; env: NodeJS.ProcessEnv } | null } | null = null

  private async pythonEnv(): Promise<{ python: string; env: NodeJS.ProcessEnv } | null> {
    if (this.pythonEnvCache !== null) return this.pythonEnvCache.value
    const get = this.options.getPythonEnv
    const value = get === undefined ? null : await get().catch(() => null)
    this.pythonEnvCache = { value }
    return value
  }

  private async startAgent(scope: string): Promise<AgentHandle | null> {
    const usable = this.resolveOpencode()
    // 版本闸没过就降级（太老的 opencode 起 ACP 一路 -32603，见 binaries.ts）。
    if (!usable.ok) return null
    const resolved = usable.binary

    try {
      // 从本机 env 解析网关模型配置（按 provider 选内联 provider：anthropic →
      // @ai-sdk/anthropic、否则 @ai-sdk/openai-compatible，两者都内联 models
      // 绕开 models.dev 注册表——见 resolveGatewayModelConfig 的头注释）。
      // 解析不到（没配网关）时不传 modelConfig，并**显式告警**（见下）。
      // ★ 模型名与协议由装配层显式给（`getModel`/`getProvider`），env 只是兜底。
      const model = this.options.getModel?.()
      const modelConfig = resolveGatewayModelConfig(
        process.env,
        model,
        this.options.getProvider?.(),
      )

      /**
       * ★ 没配网关时**直接拒绝启动**，不是"告警后照常起"。
       *
       * 这是同事机器上"搜索完全没法用"的真实根因，而它极难排查：
       * `resolveGatewayModelConfig` 两组来源（`MYCONTEXT_LLM_*` 与
       * `ANTHROPIC_*`）都拿不到时返回 null，我们不传 modelConfig，
       * opencode 退回它自己的默认 provider，那条路要查**被墙的 models.dev
       * 注册表**—— 拉不到时它不报错，只是 `session/prompt` 一直不返回。
       *
       * 原来靠 120s 超时兜底：用户等两分钟看到「超时」，虽然信息误导
       * （真因是没配密钥）但至少会结束。而 `session/prompt` 现在**不设限**
       * （见 `ACP_METHOD_TIMEOUTS`）—— 同一条路会永久挂住。
       *
       * 所以判据前移：起进程之前就知道"没有模型可用"，那时抛错让调用方
       * 走降级（落回本地召回），用户立刻看到结果 + 一条可照做的提示。
       */
      if (modelConfig === null) {
        this.options.logger.warn(
          "search agent has no gateway model config; refusing to start agent. " +
            "Set MYCONTEXT_LLM_BASE_URL + MYCONTEXT_LLM_API_KEY in .env (see .env.example)",
          { hasLlmBaseUrl: process.env["MYCONTEXT_LLM_BASE_URL"] !== undefined },
        )
        /**
         * ★★ 直接**拒绝启动** agent，而不是起了再等它超时。
         *
         * 这条 throw 是把 `session/prompt` 改成不设限（见 `ACP_METHOD_TIMEOUTS`）
         * 的**必要配套**，不是顺手加的防御：
         *
         * 原来这里只 warn 然后照常起 agent，靠那个 120s 超时兜底 ——
         * 用户等两分钟看到「超时」，虽然信息误导（真因是没配密钥），
         * 但至少**会结束**。去掉超时之后同一条路就变成**永久挂住**，
         * 那比原来的坏体验更糟。
         *
         * 而"没有模型可用"根本不需要等：它在起进程之前就是已知事实。
         * 抛出去让调用方走降级（落回本地召回）——用户立刻看到结果，
         * 日志里有上面那条可照做的提示。
         */
        throw new AppError(
          "CONFIG_INVALID",
          "搜索需要 LLM 网关：请在设置里配置模型（或在 .env 里给 MYCONTEXT_LLM_BASE_URL + MYCONTEXT_LLM_API_KEY）",
        )
      } else {
        // 成功路径也留一条：出问题时第一个要确认的就是"到底用了哪个模型"。
        // ★ 走同一个 `resolveModelName`（而不是在这里重算优先级）：日志报的
        // 模型与实际用的必须是同一个，否则它会把排查引向错误的方向。
        this.options.logger.info("search agent model configured", {
          model: resolveModelName(process.env, model),
        })
      }

      /**
       * agent 进程的环境。
       *
       * ★ 基底是**激活后的 Python 环境**（若可用）：`PATH` 首段是内置 venv 的
       * bin，里面有我们生成的 `kl` wrapper。这一点是必需的 ——
       * 上游 `kl-graph/kl` 硬编码了它自己那套 `.venv/bin/python`，
       * 在我们这里不存在，agent 跑裸 `kl` 会得到
       * `No such file or directory: .../.venv/bin/python`（实测）。
       *
       * klRoot 仍然前插，但排在 venv/bin **之后**：那里还有别的可执行
       * （`kl_cli.py` 之类），而 `kl` 这个名字必须命中我们的 wrapper。
       */
      const activated = await this.pythonEnv()
      const basePath = activated?.env["PATH"] ?? process.env["PATH"] ?? ""
      const baseEnv: NodeJS.ProcessEnv = {
        ...(activated?.env ?? process.env),
        PATH: `${basePath}${delimiter}${this.options.klRoot}`,
        // 注入 KL_SERVER_PORT 让 kl CLI 连到这个档位对应的那个 kl。
        KL_SERVER_PORT: String(this.klPortFor(scope)),
        /**
         * ★ `all` 档额外告知**全部**图的端口，让 skill 能逐个问。
         *
         * 只给 `KL_SERVER_PORT` 的话 `all` 档退化成"只查主渠道" ——
         * 那是一个静默的错答案（用户选了混合检索，拿到的是单渠道结果）。
         */
        ...(scope === "all" ? { KL_GRAPHS_JSON: JSON.stringify(this.klGraphsMap()) } : {}),
      }
      // ★ agentHome：把 opencode 的 HOME 换成我们的空目录，否则它会从
      // `$HOME/.claude/skills` 读到用户自己装的全部 skill（隔离漏洞）。
      /**
       * ★ agentHome 按 vault 走（见 AgentDirs）；npm 缓存留在应用级一份。
       * 两个旋钮必须**一起**给：只给前者的话缓存会跟着隔离 HOME 走，
       * 每个身份各攒一份 325 MB。
       */
      const dirs = this.requireDirs()
      /**
       * ★ 档位各自一个 HOME，且**默认档位映射到原目录**（零迁移：
       * 已有会话仍 resume 得上）。见 `agentHomeFor`。
       *
       * `isolateData` 只对非默认档位开：那几个档位是新的（没有存量会话），
       * 而默认档位一开就会让所有存量会话各降级重建一次。
       */
      const isDefaultScope = scope === this.options.primaryChannelId
      const homeOption = {
        agentHome: agentHomeFor(dirs.home, scope),
        npmCache: dirs.npmCache,
        ...(isDefaultScope ? {} : { isolateData: true }),
      }
      /**
       * ★ 走 `skills.paths` 指目录，不再靠 create() 时 cpSync。
       *
       * `skillsDir`（bundled kl）由 paths.ts 提供绝对路径。opencode 的
       * `skills.paths` 直接读它，无需把内容拷进 search workspace。
       */
      const skillsDir = this.options.skillsDir
      const skillOption =
        skillsDir !== undefined && skillsDir !== "" ? { skillPaths: [skillsDir] } : {}
      const hardened = buildOpencodeSpawn(
        modelConfig !== null
          ? { baseEnv, modelConfig, allowKlCommand: true, ...homeOption, ...skillOption }
          : { baseEnv, allowKlCommand: true, ...homeOption, ...skillOption },
      )
      // 反向 handler：search kind 的白名单（无 profile_read）。
      const handlers = createReverseHandlers({
        kind: "search",
        onToolAudit: (entry) =>
          this.options.logger.debug("agent tool audit", {
            toolName: entry.toolName,
            allowed: entry.allowed,
          }),
      })

      const transport = this.options.processes.spawnDuplex({
        executable: resolved.path,
        args: hardened.args,
        env: hardened.env,
        // cwd 不传二进制目录：opencode 会在 cwd 下写配置/凭据（见 DuplexSpec 注释）。
        // 每个 session 有自己的 acpCwd，进程级 cwd 用 workspaceRoot 即可。
        cwd: dirs.workspaceRoot,
        onLine: (line: string) => client.handleLine(line),
        onStderr: (line: string) => this.options.logger.debug("opencode stderr", { line }),
        onExit: (info) => {
          this.options.logger.warn("opencode exited", { code: info.code, signal: info.signal })
          // 进程没了：句柄作废，下次 prompt 重新懒启动。
          if (this.agents.get(scope)?.transport === transport) this.agents.delete(scope)
        },
      })

      const client = new AcpClient({
        transport,
        logger: this.options.logger.child("Acp"),
        onNotification: (method, params) => this.onNotification(method, params),
        reverseHandlers: {
          "session/request_permission": (params) =>
            handlers.requestPermission(params as { toolName: string }),
          "fs/read_text_file": (params) =>
            handlers.readTextFile({
              path: (params as { path?: string }).path ?? "",
              workspaceRoot: dirs.workspaceRoot,
            }),
          "fs/write_text_file": () => handlers.writeTextFile(),
        },
        requestTimeoutMs: ACP_PROTOCOL_TIMEOUT_MS,
        methodTimeouts: ACP_METHOD_TIMEOUTS,
      })

      // ACP 握手：initialize 必须先成功，否则 session/new 会被拒。
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      })

      const supervisor = new AcpSupervisor({
        client,
        mcpAuth: this.mcpAuth,
        mcpPort: HOST_MCP_PORT,
        logger: this.options.logger.child("AcpSup"),
        // ★ 第一期 kl 走 skill，不注入宿主 MCP 工具。
        hostToolsEnabled: false,
        onSessionIdChanged: (recordId, acpSessionId) => {
          this.sessions?.updateAcpSessionId(recordId, acpSessionId)
        },
        // 抑制窗口交给该 session 的 reducer（resume/replay 时挡历史尾巴）。
        beginReplaySuppression: (recordId) => {
          const reducer = this.reducers.get(recordId)
          return reducer !== undefined ? reducer.beginReplaySuppression() : () => {}
        },
      })

      const handle: AgentHandle = {
        transport,
        client,
        supervisor,
        serverPassword: hardened.serverPassword,
      }
      this.agents.set(scope, handle)
      return handle
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn("opencode start failed, staying on recall", { detail, scope })
      this.agents.delete(scope)
      return null
    }
  }

  /** 库里已有 items → primeFromHistory 需要的 {role, content} 形状。 */
  private historyForPrime(sessionId: string): { role: string; content: UnifiedContentBlock[] }[] {
    const sessions = this.requireSessions()
    return sessions.messages(sessionId).map((row) => ({
      role: row.role,
      content: parseContent(row.contentJson),
    }))
  }

  /**
   * 拼本次 prompt 的 content blocks。
   *
   * 降级重建（needsContextReplay）时把库里历史作为上下文回灌 —— 否则用户会
   * 看到"它忘了刚才说的话"。回灌一次后标记已回灌。
   *
   * ## ★ 回灌必须写成"背景资料"，不能写成"待续的对话"
   *
   * 真机翻车过一次：回灌用的是裸文本（`（以下是此前的对话，供你参考）\n` + 历史），
   * 模型把这段**当成要输出的内容整段复述**了 —— 它先把上一轮的完整答案抄一遍，
   * 自己补上「（以上是此前的对话，供你参考）」「现在，继续回答用户的问题：」，
   * 再把用户的历史问题也抄一遍，最后才说
   * `Based on the previous conversation context, I already ran queries on this`。
   * 用户看到的是一条自问自答、像跑了两轮的怪答案（而他只问了一句）。
   *
   * 两条修法一起上：
   * ① **包成带边界的资料块 + 明确禁令**（不要复述、不要重答历史问题、只答新问题）。
   *    裸文本没有边界，模型分不清"给你看的"与"要你写的"。
   * ② **历史里只留用户问题 + 助手答案的短摘要**（`HISTORY_ANSWER_MAX_CHARS`）。
   *    最容易被整段抄走的恰恰是上一轮的完整答案正文 —— 回灌的目的是"记得聊过
   *    什么"，不是"逐字还原"，摘要足够且大幅降低复述的诱惑。
   */
  private buildPromptBlocks(
    sessionId: string,
    query: string,
    agent: AgentHandle,
    acpSessionId: string,
  ): { type: "text"; text: string }[] {
    /**
     * ★★ 这里**不再**预先塞一段 FTS 召回。
     *
     * 那段（`buildSourceRecallContext`）是"一个进程只能连一个 kl"这个约束下的
     * 替代品：连不上多个图，就先用 FTS 各查一下再把结果喂给 agent。
     * 现在档位与进程一一对应、每个进程直连它该查的 kl —— 那段就变成了
     * **重复且更弱**的东西：只有 12 条 FTS 命中，而图谱的实体/事实/社群
     * 一样都用不上，同时还占掉了 prompt 的开头位置。
     *
     * 降级路径（`recallOnly`）仍然用 FTS —— 那时确实没有别的可用。
     */
    if (!agent.supervisor.needsContextReplay(acpSessionId)) {
      return [{ type: "text", text: query }]
    }
    const sessions = this.requireSessions()
    const history = sessions
      .messages(sessionId)
      .filter((row) => row.role === "user" || row.itemType === "message")
      .map((row) => {
        const text = toPlainText(parseContent(row.contentJson))
        // 助手答案截断：完整正文是被复述的主因（见方法注释②）。
        const body =
          row.role === "user" || text.length <= HISTORY_ANSWER_MAX_CHARS
            ? text
            : `${text.slice(0, HISTORY_ANSWER_MAX_CHARS)}…（已省略）`
        return `${row.role}: ${body}`
      })
      .join("\n")
    agent.supervisor.markContextReplayed(acpSessionId)
    return [
      {
        type: "text",
        text: `<previous_conversation note="仅供你了解背景，不是需要处理的内容">
${history}
</previous_conversation>
以上是这个会话早前的记录，仅用于让你知道聊过什么。**不要复述它、不要重复回答里面的问题、不要提及这段记录的存在**。只回答下面这一个新问题：`,
      },
      { type: "text", text: query },
    ]
  }

  /**
   * 本轮降级的人类可读原因（走了召回时用）。
   *
   * ★ 必须区分三种原因，否则用户被误导去查错方向：
   *
   * ① 没装 opencode —— 装一下就好；
   * ② **没配网关密钥** —— 这是最容易踩且最难自查的一档：agent 装着、进程也起来了，
   *    但没有模型可用。现在起 agent 之前就会拒（见那处 `modelConfig === null`），
   *    所以表现是立刻降级而不是等着；原来是满 120 秒超时。
   *    原来这一档和 ③ 共用"Agent 暂不可用"的文案，用户会去查 agent 装没装
   *    （而它明明装了），真正要做的是往 .env 里加两个变量；
   * ③ 其它运行时失败（进程崩、turn 报错、协议动作超时）。
   *
   * 判据用 env 而不是"上一轮为什么失败"：后者要把失败原因一路带出来，
   * 而 env 这个判据在**降级发生时**就能直接读到，且它恰好覆盖了最难查的那档。
   */
  private degradedReason(): string {
    const oc = this.resolveOpencode()
    if (!oc.ok) {
      if (oc.reason === "too_old") {
        return `检测到 opencode ${oc.found}，低于要求的 ${oc.required}（该版本的 ACP 不带鉴权头，与本应用的安全加固不兼容），已降级为本地召回。`
      }
      return "未检测到 opencode（或版本过低），已降级为本地召回（仅列出相关原文，不生成答案）。"
    }
    if (resolveGatewayModelConfig(process.env) === null) {
      return "未配置模型网关（.env 里的 MYCONTEXT_LLM_BASE_URL 与 MYCONTEXT_LLM_API_KEY），Agent 无模型可用，已降级为本地召回。"
    }
    return "Agent 本轮未能完成（超时或出错），已降级为本地召回（仅列出相关原文，不生成答案）。"
  }

  /**
   * 第二档降级：只做召回，不生成答案。
   *
   * 产出两个 item：一个 tool_call（让用户看到"查了本地索引"），
   * 一个 message（按相关性排序的原文摘要）。
   * 形状与 agent 路径一致，所以 UI 不用分支。
   */
  private recallOnly(sessionId: string, query: string, scope?: string): ChatItem[] {
    const sessions = this.requireSessions()
    const startedAt = this.options.clock.now()

    /**
     * ★ 召回走 `@mycontext/retrieval` 的 `recallMessages` —— **与数字人
     * agent 共用同一份实现**。
     *
     * 两档词元（严格 → 落空放宽）的理由与实测成本都写在那个函数的文件头。
     * 这里刻意不再复制一份逻辑：两份实现早晚不一致，而"两处检索口径不同"
     * 这种 bug 极难发现（两边都返回结果，只是不是同一批）。
     */
    const recalled = this.recallBySource(query, FALLBACK_RECALL_LIMIT, scope)
    const lines = recalled.sources
      .flatMap((source) => {
        const label =
          source.channelId === "dingtalk"
            ? "钉钉"
            : source.channelId === "feishu"
              ? "飞书"
              : source.channelId
        return source.hits.map((hit) => {
          const when = new Date(hit.message.sentAt).toISOString().slice(0, 16).replace("T", " ")
          return {
            score: hit.score,
            text: `[${label}] ${when} ${hit.message.senderDisplayName ?? "未知"}：${(hit.message.contentText ?? "").slice(0, 160)}`,
          }
        })
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, FALLBACK_RECALL_LIMIT)
      .map((row, index) => `[${String(index + 1)}] ${row.text}`)

    let seq = sessions.nextSeq(sessionId)
    const turnId = `turn_${startedAt}`
    const toolItem: ChatItem = {
      id: `${sessionId}_${seq}`,
      seq,
      role: "assistant",
      itemType: "tool_call",
      // 放宽档命中时明示 —— 本模块的原则是「降级必须可见」,
      // 悄悄放宽会让用户以为这就是精确结果。
      content: [
        textBlock(
          recalled.relaxed
            ? `已分别查询钉钉和飞书，汇总命中 ${String(lines.length)} 条（部分渠道已放宽词序）`
            : `已分别查询钉钉和飞书，汇总命中 ${String(lines.length)} 条`,
        ),
      ],
      toolName: "mycontext_local_recall",
      toolStatus: "success",
      turnId,
      createdAt: startedAt,
    }
    seq += 1
    const answerItem: ChatItem = {
      id: `${sessionId}_${seq}`,
      seq,
      role: "assistant",
      itemType: "message",
      content: [
        textBlock(
          lines.length === 0
            ? "本地索引里没有找到相关消息。"
            : `以下是本地索引里最相关的记录：\n\n${lines.join("\n")}`,
        ),
      ],
      turnId,
      createdAt: this.options.clock.now(),
    }
    return [toolItem, answerItem]
  }

  /**
   * 逐库召回。
   *
   * ★ `scope` 决定查哪几个库：档位说"只钉钉"时，飞书的消息**不该**出现在
   * 降级召回里 —— 那与 agent 路径的语义不一致，而用户看不出这一轮走的是
   * 哪条路（两条路的结果长得一样）。
   *
   * `undefined` / `"all"` = 全部库（`recallOnly` 在拿不到会话记录时会这样调）。
   */
  private recallBySource(
    query: string,
    perSourceLimit: number,
    scope?: string,
  ): {
    relaxed: boolean
    sources: Array<{
      channelId: string
      hits: ReturnType<typeof recallMessages>["hits"]
    }>
  } {
    const primaryId = this.options.primaryChannelId
    const all: Array<{ channelId: string; db: SqliteDatabase }> = [
      { channelId: primaryId, db: this.requireDb() },
      ...[...this.sourceDbs.entries()].map(([channelId, sourceDb]) => ({
        channelId,
        db: sourceDb,
      })),
    ]
    const databases =
      scope === undefined || scope === "all"
        ? all
        : all.filter((entry) => entry.channelId === scope)
    let relaxed = false
    const sources = databases.map(({ channelId, db }) => {
      try {
        const result = recallMessages(
          { fts: new FtsIndexRepository(db), messages: new MessageRepository(db) },
          query,
          { limit: perSourceLimit },
        )
        relaxed ||= result.relaxed
        return { channelId, hits: result.hits }
      } catch (error) {
        this.options.logger.warn("isolated source recall failed", {
          channelId,
          detail: error instanceof Error ? error.message : String(error),
        })
        return { channelId, hits: [] }
      }
    })
    return { relaxed, sources }
  }

  private pushStream(
    sessionId: string,
    items: readonly SearchChatItem[],
    done: boolean,
    degradedReason: string | null,
  ): void {
    const window = this.options.getWindow()
    if (window === null || window.isDestroyed()) return
    window.webContents.send(IPC_EVENTS.searchStream, { sessionId, items, done, degradedReason })
  }

  /**
   * app 退出/登出：dispose 所有 session（撤 token）+ kill opencode（无孤儿）。
   */
  async shutdown(): Promise<void> {
    const agents = [...this.agents.values()]
    this.agents.clear()
    this.reducers.clear()
    if (agents.length === 0) return
    /**
     * 逐 session 撤 token（dispose 自己会 revoke），再逐进程 close。
     *
     * ★ 每个档位一个进程，所以两层循环都要走完 —— 漏一个就是一个孤儿
     * opencode 继续占着它的 HOME 与端口（退出应用后仍在跑）。
     *
     * 撤 token 时在**所有**进程上试：会话是哪个档位建的这件事这里不查库
     * （库可能已经关了），而 dispose 一个不存在的 session 是无害的。
     */
    if (this.sessions !== null) {
      for (const row of this.sessions.listActive()) {
        if (row.acpSessionId === null) continue
        for (const agent of agents) {
          await agent.supervisor
            .dispose({
              id: row.id,
              acpSessionId: row.acpSessionId,
              cwd: row.acpCwd,
              kind: "search",
              scopeId: row.id,
            })
            .catch(() => {})
        }
      }
    }
    for (const agent of agents) {
      agent.client.close()
      await agent.transport.close().catch(() => {})
    }
  }

  private requireSessions(): SearchSessionRepository {
    if (this.sessions === null) throw new AppError("DB_UNAVAILABLE", "尚未登录")
    return this.sessions
  }

  private requireDb(): SqliteDatabase {
    if (this.db === null) throw new AppError("DB_UNAVAILABLE", "尚未登录")
    return this.db
  }
}

/** ChatItem → 落库输入。 */
function toAppendInput(
  sessionId: string,
  item: ChatItem,
): {
  id: string
  sessionId: string
  seq: number
  role: "user" | "assistant" | "system"
  itemType: string
  contentJson: string
  toolName?: string | null
  toolStatus?: string | null
  turnId?: string | null
  usageJson?: string | null
  createdAt: number
} {
  return {
    id: item.id,
    sessionId,
    seq: item.seq,
    role: item.role,
    itemType: item.itemType,
    contentJson: JSON.stringify(item.content),
    toolName: item.toolName ?? null,
    toolStatus: item.toolStatus ?? null,
    turnId: item.turnId ?? null,
    usageJson: item.usage !== undefined ? JSON.stringify(item.usage) : null,
    createdAt: item.createdAt,
  }
}

/** ChatItem → 推流用的 SearchChatItem（渲染形态）。 */
function toStreamItem(item: ChatItem): SearchChatItem {
  return {
    id: item.id,
    seq: item.seq,
    role: item.role,
    itemType: item.itemType,
    contentJson: JSON.stringify(item.content),
    toolName: item.toolName ?? null,
    toolStatus: item.toolStatus ?? null,
    turnId: item.turnId ?? null,
    createdAt: item.createdAt,
  }
}

/** 库里 contentJson → UnifiedContentBlock[]（畸形则退化为空）。 */
function parseContent(json: string): UnifiedContentBlock[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as UnifiedContentBlock[]) : []
  } catch {
    return []
  }
}

function toSummary(row: {
  id: string
  title: string | null
  pinned: boolean
  messageCount: number
  lastActiveAt: number
  createdAt: number
  state: "idle" | "streaming" | "error"
  graphScope?: string
}): SearchSessionSummary {
  return {
    id: row.id,
    title: row.title,
    pinned: row.pinned,
    messageCount: row.messageCount,
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
    // 侧栏要显示"这个会话搜的是哪些渠道"
    ...(row.graphScope === undefined ? {} : { graphScope: row.graphScope }),
    state: row.state,
  }
}
