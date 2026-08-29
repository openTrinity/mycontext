/**
 * 搜索服务。
 *
 * ## 降级链（每一档都在 UI 上明示，不静默降质）
 *
 * ① **主路**：Agent API Key（Cursor 订阅）→ `@cursor/sdk` 编排检索并生成答案；
 * ② **Fallback**：OpenAI 兼容网关（设置里的模型 base/key）→ 本地召回后由网关归纳答案；
 * ③ 两边都不可用 → **只展示召回列表**（不编答案）；
 * ④ 连本地索引都没建好 → 提示"正在建索引"。
 *
 * 「答案质量突然变差」比「明确告知能力降级」难排查得多，
 * 所以每一档都有对应的 `degradedReason` 传给 UI。
 *
 * ## 为什么 Agent 缺失时仍然可用
 *
 * Agent 依赖订阅密钥（默认不随包分发），没配是常态。
 * Fallback 用同一份「模型网关」配置（与数字分身直连同路），
 * 没有工具调用，但「召回 + 归纳」仍比纯列表有用。
 */
import { join, delimiter } from "node:path"
import { mkdirSync } from "node:fs"
import type { BrowserWindow } from "electron"
import { AppError, type Clock, type Logger } from "@mycontext/kernel"
import type { LlmProvider } from "@mycontext/llm"
import {
  FtsIndexRepository,
  MessageRepository,
  SearchSessionRepository,
  type SqliteDatabase,
} from "@mycontext/store"
import { recallMessages } from "@mycontext/retrieval"
import { type AgentDirs } from "./agent-dirs.js"
import {
  ChatItemReducer,
  CursorSession,
  DEFAULT_CURSOR_MODEL,
  textBlock,
  toPlainText,
  type AgentEvent,
  type ChatItem,
  type CursorRuntimeMode,
  type CursorSessionOptions,
  type UnifiedContentBlock,
} from "@mycontext/agent-runtime"
import {
  IPC_EVENTS,
  type SearchChatItem,
  type SearchSessionDetail,
  type SearchSessionSummary,
} from "@mycontext/ipc-contract"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"

/** 直出召回列表时最多给多少条。再多用户也不会看，而且会把窗口撑爆。 */
const FALLBACK_RECALL_LIMIT = 20

/**
 * 回灌历史时单条**助手答案**保留的字数上限（用户提问不截断 —— 那是问题本身）。
 *
 * 为什么要截：真机翻车过一次，模型把回灌里上一轮的完整答案整段复述进了新答案。
 * 回灌只需要让它"记得聊过什么"，不需要逐字还原。
 */
const HISTORY_ANSWER_MAX_CHARS = 200

export interface SearchServiceOptions {
  clock: Clock
  logger: Logger
  /**
   * 仍保留：部分装配/测试夹具会注入。Cursor 路径不再解析 opencode 二进制。
   */
  runtime: RuntimeEnv
  /** 仍保留类型兼容；Cursor 路径不再 spawnDuplex。 */
  processes: ProcessRunner
  /**
   * agent workspace 与隔离 HOME —— **在 attach 时给，不在构造时给**。
   */
  skillsDir?: string
  klRoot: string
  klPort: number
  primaryChannelId: string
  klPortOf?: (channelId: string) => number | undefined
  klGraphs?: () => Readonly<Record<string, number>>
  getPythonEnv?: () => Promise<{ python: string; env: NodeJS.ProcessEnv } | null>
  getProvider?: () => string
  /**
   * Agent API Key（`runtimeConfig.resolved().cursorApiKey`）。
   * 空 = 降级本地召回。
   */
  getCursorApiKey?: () => string
  /**
   * Cursor 订阅模型 id。缺省 {@link DEFAULT_CURSOR_MODEL}。
   * 与网关 `modelMain` 分离 —— 后者只给 OpenAI 兼容 Fallback。
   */
  getCursorModel?: () => string
  /** `local`（默认）| `cloud` */
  getCursorRuntime?: () => CursorRuntimeMode
  /**
   * OpenAI 兼容网关（Fallback）。与数字分身直连共用 `LlmHolder`。
   * 不给 / get()=null → Cursor 失败后只能纯召回。
   */
  llmProvider?: LlmProvider
  /**
   * 测试注入假 session；缺省 `new CursorSession(opts)`。
   */
  createCursorSession?: (opts: CursorSessionOptions) => CursorSession
  getWindow: () => BrowserWindow | null
}

/** 一个 CursorSession 句柄（按**搜索会话**一个，不是按档位）。 */
interface AgentHandle {
  session: CursorSession
}

export class SearchService {
  private db: SqliteDatabase | null = null
  private readonly sourceDbs = new Map<string, SqliteDatabase>()
  private sessions: SearchSessionRepository | null = null

  /** 懒建的 CursorSession，**按搜索 sessionId**。 */
  private readonly agents = new Map<string, AgentHandle>()
  private readonly agentStarting = new Map<string, Promise<AgentHandle | null>>()
  private readonly reducers = new Map<string, ChatItemReducer>()

  constructor(private readonly options: SearchServiceOptions) {}

  private dirs: AgentDirs | null = null

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
    this.reducers.clear()
  }

  private requireDirs(): AgentDirs {
    const dirs = this.dirs
    if (dirs === null) throw new AppError("DB_UNAVAILABLE", "尚未登录，agent 目录未就绪")
    return dirs
  }

  /**
   * Agent 编排是否**已接线**。
   *
   * ★ 刻意保留这个显式常量（`search-degrade.test.ts` 门禁扫它）。
   * 它回答「代码里 prompt 是否真有 agent 分支」——不是「本机有没有二进制」。
   */
  private static readonly ACP_WIRED = true

  private cursorApiKey(): string {
    return this.options.getCursorApiKey?.().trim() ?? ""
  }

  private cursorRuntime(): CursorRuntimeMode {
    return this.options.getCursorRuntime?.() ?? "local"
  }

  /**
   * 能否产出答案（Agent 主路或网关 Fallback 任一可用）。
   * 两者都没有 → UI 按「仅召回」呈现。
   */
  agentAvailable(): boolean {
    if (!SearchService.ACP_WIRED) return false
    if (this.cursorApiKey() !== "") return true
    return this.options.llmProvider?.get() != null
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
      degradedReason: null,
    }
  }

  create(query: string, scope?: string): SearchSessionSummary {
    const sessions = this.requireSessions()
    const now = this.options.clock.now()
    const id = `srch_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const cwd = join(this.requireDirs().workspaceRoot, "search", id)
    mkdirSync(cwd, { recursive: true })
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
    const handle = this.agents.get(sessionId)
    if (handle !== undefined) {
      this.agents.delete(sessionId)
      void handle.session.close().catch(() => {})
    }
  }

  async prompt(sessionId: string, query: string): Promise<void> {
    const sessions = this.requireSessions()
    const now = this.options.clock.now()

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
      // ① 主路：Cursor 订阅 Agent
      const ranAgent = await this.tryAgentTurn(sessionId, query)
      if (ranAgent) {
        sessions.setState(sessionId, "idle", this.options.clock.now())
        this.pushStream(sessionId, [], true, null)
        return
      }

      // ② Fallback：OpenAI 兼容网关归纳（明示降级）
      const ranGateway = await this.tryGatewayAnswer(
        sessionId,
        query,
        sessions.findById(sessionId)?.graphScope,
      )
      if (ranGateway) {
        sessions.setState(sessionId, "idle", this.options.clock.now())
        this.pushStream(sessionId, [], true, this.degradedReason({ usedGateway: true }))
        return
      }

      // ③ 纯召回
      const items = this.recallOnly(sessionId, query, sessions.findById(sessionId)?.graphScope)
      sessions.appendMessages(items.map((item) => toAppendInput(sessionId, item)))
      sessions.setState(sessionId, "idle", this.options.clock.now())
      this.pushStream(sessionId, [], true, this.degradedReason({ usedGateway: false }))
    } catch (error) {
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
   * ① `CursorSession.cancel()` —— 真停掉模型生成（否则只挡 UI 仍烧 token）；
   * ② `reducer.cancelTurn` —— 挡住路上的迟到事件。
   */
  cancel(sessionId: string): void {
    const active = this.activeTurns.get(sessionId)
    if (active === undefined) return
    active.reducer.cancelTurn(active.turnId)
    void active.session.cancel().catch((error: unknown) => {
      this.options.logger.warn("cursor cancel failed", {
        sessionId,
        detail: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /**
   * 走一轮真正的 agent turn。成功 → true；不可用/失败 → false（落回召回）。
   *
   * ★ 门禁 `search-degrade.test.ts` 扫 `tryAgentTurn` / `CursorSession` 作「已接线」证据。
   */
  private async tryAgentTurn(sessionId: string, query: string): Promise<boolean> {
    if (!SearchService.ACP_WIRED) return false
    if (this.cursorApiKey() === "") return false

    const sessions = this.requireSessions()
    const record = sessions.findById(sessionId)
    if (record === null) return false

    const scope = record.graphScope === "" ? this.options.primaryChannelId : record.graphScope
    const agent = await this.ensureAgent(sessionId, record.acpCwd)
    if (agent === null) return false

    try {
      const startSeq = sessions.nextSeq(sessionId)
      const reducer = new ChatItemReducer({
        startSeq,
        newId: (seq) => `${sessionId}_${seq}`,
        now: () => this.options.clock.now(),
      })
      this.reducers.set(sessionId, reducer)
      reducer.primeFromHistory(this.historyForPrime(sessionId))

      const turnId = `turn_${startSeq}`
      reducer.beginTurn(turnId)

      this.activeTurns.set(sessionId, {
        sessionId,
        turnId,
        reducer,
        session: agent.session,
      })

      const restoreEnv = await this.seedKlEnv(scope)
      try {
        const promptText = this.buildPlainPrompt(sessionId, query)
        const result = await agent.session.prompt(promptText, turnId)
        if (result.error !== undefined && result.error !== "") {
          this.options.logger.warn("search agent turn failed, falling back to recall", {
            sessionId,
            detail: result.error,
          })
          this.reducers.delete(sessionId)
          this.activeTurns.delete(sessionId)
          return false
        }
        this.activeTurns.delete(sessionId)
        return true
      } finally {
        restoreEnv()
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn("search agent turn failed, falling back to recall", {
        sessionId,
        detail,
      })
      this.reducers.delete(sessionId)
      this.activeTurns.delete(sessionId)
      return false
    }
  }

  private readonly activeTurns = new Map<
    string,
    {
      sessionId: string
      turnId: string
      reducer: ChatItemReducer
      session: CursorSession
    }
  >()

  private flushEvents(
    sessionId: string,
    reducer: ChatItemReducer,
    events: readonly AgentEvent[],
  ): void {
    const result = reducer.apply(events)
    if (result.touched.length === 0) return
    const sessions = this.requireSessions()
    for (const item of result.touched) {
      const input = toAppendInput(sessionId, item)
      const inserted = sessions.appendMessages([input])
      if (inserted === 0) {
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

  private async ensureAgent(sessionId: string, cwd: string): Promise<AgentHandle | null> {
    const existing = this.agents.get(sessionId)
    if (existing !== undefined) return existing
    const starting = this.agentStarting.get(sessionId)
    if (starting !== undefined) return starting

    const pending = this.startAgent(sessionId, cwd).finally(() => {
      this.agentStarting.delete(sessionId)
    })
    this.agentStarting.set(sessionId, pending)
    return pending
  }

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

  private pythonEnvCache: { value: { python: string; env: NodeJS.ProcessEnv } | null } | null = null

  private async pythonEnv(): Promise<{ python: string; env: NodeJS.ProcessEnv } | null> {
    if (this.pythonEnvCache !== null) return this.pythonEnvCache.value
    const get = this.options.getPythonEnv
    const value = get === undefined ? null : await get().catch(() => null)
    this.pythonEnvCache = { value }
    return value
  }

  /**
   * Local Cursor agent 的 shell **没有**单独的 envVars API，工具调用继承
   * `process.env`。因此在 turn 期间把 KL 端口（以及尽量把 PATH）写进进程 env，
   * turn 结束再还原 —— 代价是并发 turn 可能互相覆盖；搜索 UI 基本串行，可接受。
   */
  private async seedKlEnv(scope: string): Promise<() => void> {
    const prevPort = process.env["KL_SERVER_PORT"]
    const prevGraphs = process.env["KL_GRAPHS_JSON"]
    const prevPath = process.env["PATH"]

    process.env["KL_SERVER_PORT"] = String(this.klPortFor(scope))
    if (scope === "all") {
      process.env["KL_GRAPHS_JSON"] = JSON.stringify(this.klGraphsMap())
    } else {
      delete process.env["KL_GRAPHS_JSON"]
    }

    const activated = await this.pythonEnv()
    const basePath = activated?.env["PATH"] ?? process.env["PATH"] ?? ""
    process.env["PATH"] = `${basePath}${delimiter}${this.options.klRoot}`

    return () => {
      if (prevPort === undefined) delete process.env["KL_SERVER_PORT"]
      else process.env["KL_SERVER_PORT"] = prevPort
      if (prevGraphs === undefined) delete process.env["KL_GRAPHS_JSON"]
      else process.env["KL_GRAPHS_JSON"] = prevGraphs
      if (prevPath === undefined) delete process.env["PATH"]
      else process.env["PATH"] = prevPath
    }
  }

  private async startAgent(sessionId: string, cwd: string): Promise<AgentHandle | null> {
    const apiKey = this.cursorApiKey()
    if (apiKey === "") return null

    try {
      const modelId = this.options.getCursorModel?.().trim() || DEFAULT_CURSOR_MODEL
      const opts: CursorSessionOptions = {
        apiKey,
        runtime: this.cursorRuntime(),
        cwd,
        modelId,
        onEvent: (event) => {
          const active = this.activeTurns.get(sessionId)
          if (active === undefined) return
          this.flushEvents(sessionId, active.reducer, [event])
        },
      }
      const session = this.options.createCursorSession?.(opts) ?? new CursorSession(opts)
      const handle: AgentHandle = { session }
      this.agents.set(sessionId, handle)
      return handle
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn("cursor agent start failed, staying on recall", {
        detail,
        sessionId,
      })
      this.agents.delete(sessionId)
      return null
    }
  }

  private historyForPrime(sessionId: string): { role: string; content: UnifiedContentBlock[] }[] {
    const sessions = this.requireSessions()
    return sessions.messages(sessionId).map((row) => ({
      role: row.role,
      content: parseContent(row.contentJson),
    }))
  }

  /**
   * 拼纯文本 prompt（Cursor SDK 走字符串，不是 ACP content blocks）。
   *
   * 有历史时包成「背景资料」块，禁令复述——同旧 ACP 回灌教训。
   */
  private buildPlainPrompt(sessionId: string, query: string): string {
    const sessions = this.requireSessions()
    const rows = sessions
      .messages(sessionId)
      .filter((row) => row.role === "user" || row.itemType === "message")
    // 当前用户消息已落库，历史里排除最后一条（就是本轮 query）
    const prior = rows.slice(0, -1)
    if (prior.length === 0) return query

    const history = prior
      .map((row) => {
        const text = toPlainText(parseContent(row.contentJson))
        const body =
          row.role === "user" || text.length <= HISTORY_ANSWER_MAX_CHARS
            ? text
            : `${text.slice(0, HISTORY_ANSWER_MAX_CHARS)}…（已省略）`
        return `${row.role}: ${body}`
      })
      .join("\n")

    return `<previous_conversation note="仅供你了解背景，不是需要处理的内容">
${history}
</previous_conversation>
以上是这个会话早前的记录，仅用于让你知道聊过什么。**不要复述它、不要重复回答里面的问题、不要提及这段记录的存在**。只回答下面这一个新问题：

${query}`
  }

  private degradedReason(opts: { usedGateway: boolean }): string {
    if (opts.usedGateway) {
      return "未使用 Agent（订阅密钥未配或本轮失败），已用 OpenAI 兼容网关根据本地召回生成答案（无工具调用）。"
    }
    if (this.cursorApiKey() === "" && this.options.llmProvider?.get() == null) {
      return "未配置 Agent API Key，也未配置模型网关，已降级为本地召回（仅列出相关原文，不生成答案）。"
    }
    if (this.cursorApiKey() === "") {
      return "未配置 Agent API Key，且网关 Fallback 本轮失败，已降级为本地召回。"
    }
    return "Agent 与网关 Fallback 本轮均未能完成，已降级为本地召回（仅列出相关原文，不生成答案）。"
  }

  /**
   * Fallback：本地召回 + OpenAI 兼容网关归纳成答案。
   * 无工具、无图谱 skill —— 明示降级，但比纯列表有用。
   */
  private async tryGatewayAnswer(
    sessionId: string,
    query: string,
    scope?: string,
  ): Promise<boolean> {
    const client = this.options.llmProvider?.get() ?? null
    if (client === null) return false

    const sessions = this.requireSessions()
    const startedAt = this.options.clock.now()
    const recalled = this.recallBySource(query, FALLBACK_RECALL_LIMIT, scope)
    const evidence = recalled.sources
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
            text: `[${label}] ${when} ${hit.message.senderDisplayName ?? "未知"}：${(hit.message.contentText ?? "").slice(0, 240)}`,
          }
        })
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, FALLBACK_RECALL_LIMIT)
      .map((row, index) => `[${String(index + 1)}] ${row.text}`)

    const contextBlock = evidence.length === 0 ? "（本地索引无命中）" : evidence.join("\n")

    try {
      const completion = await client.complete({
        messages: [
          {
            role: "system",
            content:
              "你根据用户问题与下面的本地召回原文作答。只依据原文，不要编造；原文不足就直说不知道。用简洁中文。",
          },
          {
            role: "user",
            content: `问题：${query}\n\n召回原文：\n${contextBlock}`,
          },
        ],
        maxTokens: 1200,
      })
      const answer = completion.text.trim()
      if (answer === "") return false

      let seq = sessions.nextSeq(sessionId)
      const turnId = `turn_${startedAt}`
      const toolItem: ChatItem = {
        id: `${sessionId}_${seq}`,
        seq,
        role: "assistant",
        itemType: "tool_call",
        content: [
          textBlock(
            recalled.relaxed
              ? `已本地召回 ${String(evidence.length)} 条（部分渠道已放宽词序），并由兼容网关归纳`
              : `已本地召回 ${String(evidence.length)} 条，并由兼容网关归纳`,
          ),
        ],
        toolName: "mycontext_gateway_answer",
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
        content: [textBlock(answer)],
        turnId,
        createdAt: this.options.clock.now(),
      }
      sessions.appendMessages([toolItem, answerItem].map((item) => toAppendInput(sessionId, item)))
      this.pushStream(sessionId, [toolItem, answerItem].map(toStreamItem), false, null)
      return true
    } catch (error) {
      this.options.logger.warn("search gateway fallback failed", {
        sessionId,
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  private recallOnly(sessionId: string, query: string, scope?: string): ChatItem[] {
    const sessions = this.requireSessions()
    const startedAt = this.options.clock.now()

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

  /** app 退出/登出：关掉全部 CursorSession。 */
  async shutdown(): Promise<void> {
    const agents = [...this.agents.values()]
    this.agents.clear()
    this.reducers.clear()
    this.activeTurns.clear()
    for (const agent of agents) {
      await agent.session.close().catch(() => {})
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
    ...(row.graphScope === undefined ? {} : { graphScope: row.graphScope }),
    state: row.state,
  }
}
