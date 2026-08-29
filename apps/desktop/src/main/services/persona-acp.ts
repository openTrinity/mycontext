/**
 * 数字分身的 Agent 编排 —— 每个 conversation 一个 `CursorSession`。
 *
 * ## 为什么单独一个文件而不是塞进 persona.service.ts
 *
 * 那个文件已经 2000+ 行，装着管控层接线、判定闸、发送、快照推送。
 * 而这里是一段**可以整块换掉**的东西：Agent 起不来时 PersonaService
 * 退回 `LlmClient` 直连，两者的接口都是"给上下文，出草稿"。
 *
 * ## 隔离
 *
 * · **cwd** —— 每会话一个 workspace；
 * · **会话级 CursorSession** —— conversationId → session，互不串台。
 *
 * ## 图片
 *
 * 当前 `CursorSession.prompt` 只接受文本。带图时**返回 null** 让上层走
 * 直连 LLM（那边能塞多模态）—— 禁止假装 agent 看了图。
 */
import { join, delimiter } from "node:path"
import { mkdirSync } from "node:fs"
import type { Clock, Logger } from "@mycontext/kernel"
import {
  ChatItemReducer,
  CursorSession,
  DEFAULT_CURSOR_MODEL,
  type AgentEvent,
  type ChatItem,
  type CursorRuntimeMode,
  type CursorSessionOptions,
} from "@mycontext/agent-runtime"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { type AgentDirs } from "./agent-dirs.js"

export interface PersonaAcpOptions {
  clock: Clock
  logger: Logger
  /** 保留装配兼容；Cursor 路径不再解析 opencode。 */
  runtime: RuntimeEnv
  processes: ProcessRunner
  dirs: () => AgentDirs | null
  klRoot: string
  klPort: number
  getPythonEnv?: () => Promise<{ python: string; env: NodeJS.ProcessEnv } | null>
  getSkillPaths?: () => readonly string[]
  getProvider?: () => string
  getCursorApiKey?: () => string
  /**
   * Cursor 订阅模型 id。缺省 {@link DEFAULT_CURSOR_MODEL}。
   * 与网关 `modelMain`（直连 Fallback）分离。
   */
  getCursorModel?: () => string
  getCursorRuntime?: () => CursorRuntimeMode
  createCursorSession?: (opts: CursorSessionOptions) => CursorSession
  onTrace?: (input: { conversationId: string; items: readonly ChatItem[]; done: boolean }) => void
}

interface TurnCollector {
  conversationId: string
  turnId: string
  chunks: string[]
  toolNames: string[]
  reducer: ChatItemReducer
  items: Map<string, ChatItem>
}

export class PersonaAcp {
  /** conversationId → CursorSession */
  private readonly agents = new Map<string, CursorSession>()
  private readonly turns = new Map<string, TurnCollector>()
  private turnSeq = 0
  private pythonEnvCache: { value: { python: string; env: NodeJS.ProcessEnv } | null } | null = null

  constructor(private readonly options: PersonaAcpOptions) {}

  private cursorApiKey(): string {
    return this.options.getCursorApiKey?.().trim() ?? ""
  }

  private cursorRuntime(): CursorRuntimeMode {
    return this.options.getCursorRuntime?.() ?? "local"
  }

  available(): boolean {
    return this.cursorApiKey() !== ""
  }

  /**
   * 为什么不可用 —— UI 可操作文案的机器码。`null` = 可用。
   */
  degradedReason(): string | null {
    if (this.cursorApiKey() === "") return "cursor_api_key_missing"
    return null
  }

  async turn(input: {
    conversationId: string
    prompt: string
    images?: readonly { base64: string; mimeType: string; name: string }[]
  }): Promise<(Omit<AcpTurnResult, "text"> & { text: string | null }) | null> {
    if (!this.available()) return null

    /**
     * Ruling：CursorSession 暂不接多模态图 → 带图时降级直连 LLM，
     * 避免 agent 路径假装看过图。
     */
    if (input.images !== undefined && input.images.length > 0) {
      this.options.logger.info("persona cursor skip: images require direct llm path", {
        conversationId: input.conversationId,
        imageCount: input.images.length,
      })
      return null
    }

    const dirs = this.options.dirs()
    if (dirs === null) return null

    const cwd = join(dirs.workspaceRoot, "persona", input.conversationId)
    mkdirSync(cwd, { recursive: true })

    const session = await this.ensureSession(input.conversationId, cwd)
    if (session === null) return null

    const turnId = `turn_${String((this.turnSeq += 1))}`
    const reducer = new ChatItemReducer({
      newId: (seq) => `${turnId}_${seq}`,
      now: () => this.options.clock.now(),
    })
    reducer.beginTurn(turnId)
    const turn: TurnCollector = {
      conversationId: input.conversationId,
      turnId,
      chunks: [],
      toolNames: [],
      reducer,
      items: new Map(),
    }
    this.turns.set(input.conversationId, turn)

    const restore = await this.seedKlEnv()
    try {
      const result = await session.prompt(input.prompt, turnId)
      // turn_end 已由 CursorSession 发出；再补一次 done 推送
      this.emitTrace(turn, [], true)
      const items = [...turn.items.values()].sort((left, right) => left.seq - right.seq)
      this.turns.delete(input.conversationId)

      if (result.error !== undefined && result.error !== "") {
        this.options.logger.warn("persona cursor turn failed", {
          conversationId: input.conversationId,
          detail: result.error,
        })
        return null
      }

      const text = result.text.trim() === "" ? null : result.text
      return {
        text,
        toolNames: turn.toolNames,
        totalTokens: null,
        items,
      }
    } catch (error) {
      this.options.logger.warn("persona cursor turn failed", {
        conversationId: input.conversationId,
        detail: error instanceof Error ? error.message : String(error),
      })
      this.turns.delete(input.conversationId)
      return null
    } finally {
      restore()
    }
  }

  release(conversationId: string): void {
    this.turns.delete(conversationId)
    const session = this.agents.get(conversationId)
    if (session !== undefined) {
      this.agents.delete(conversationId)
      void session.close().catch(() => {})
    }
  }

  async dispose(): Promise<void> {
    const ids = [...this.agents.keys()]
    for (const id of ids) this.release(id)
    this.turns.clear()
  }

  private async ensureSession(conversationId: string, cwd: string): Promise<CursorSession | null> {
    const existing = this.agents.get(conversationId)
    if (existing !== undefined) return existing

    const apiKey = this.cursorApiKey()
    if (apiKey === "") return null

    try {
      const modelId = this.options.getCursorModel?.().trim() || DEFAULT_CURSOR_MODEL
      const opts: CursorSessionOptions = {
        apiKey,
        runtime: this.cursorRuntime(),
        cwd,
        modelId,
        onEvent: (event) => this.onAgentEvent(conversationId, event),
      }
      const session = this.options.createCursorSession?.(opts) ?? new CursorSession(opts)
      this.agents.set(conversationId, session)
      return session
    } catch (error) {
      this.options.logger.warn("persona cursor start failed", {
        conversationId,
        detail: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  private onAgentEvent(conversationId: string, event: AgentEvent): void {
    const turn = this.turns.get(conversationId)
    if (turn === undefined) return
    if (event.type === "text_delta") turn.chunks.push(event.text)
    if (event.type === "tool_call" && !turn.toolNames.includes(event.toolName)) {
      turn.toolNames.push(event.toolName)
    }
    this.emitTrace(turn, [event], false)
  }

  private emitTrace(turn: TurnCollector, events: readonly AgentEvent[], done: boolean): void {
    if (events.length > 0) {
      const result = turn.reducer.apply(events)
      for (const item of result.touched) turn.items.set(item.id, item)
    }
    const items = [...turn.items.values()].sort((a, b) => a.seq - b.seq)
    this.options.onTrace?.({ conversationId: turn.conversationId, items, done })
  }

  private async pythonEnv(): Promise<{ python: string; env: NodeJS.ProcessEnv } | null> {
    if (this.pythonEnvCache !== null) return this.pythonEnvCache.value
    const get = this.options.getPythonEnv
    const value = get === undefined ? null : await get().catch(() => null)
    this.pythonEnvCache = { value }
    return value
  }

  /** 同 Search：Local agent shell 继承 process.env，turn 期间注入 KL 端口。 */
  private async seedKlEnv(): Promise<() => void> {
    const prevPort = process.env["KL_SERVER_PORT"]
    const prevPath = process.env["PATH"]
    process.env["KL_SERVER_PORT"] = String(this.options.klPort)
    const activated = await this.pythonEnv()
    const basePath = activated?.env["PATH"] ?? process.env["PATH"] ?? ""
    process.env["PATH"] = `${basePath}${delimiter}${this.options.klRoot}`
    return () => {
      if (prevPort === undefined) delete process.env["KL_SERVER_PORT"]
      else process.env["KL_SERVER_PORT"] = prevPort
      if (prevPath === undefined) delete process.env["PATH"]
      else process.env["PATH"] = prevPath
    }
  }
}

export interface AcpTurnResult {
  text: string
  toolNames: string[]
  totalTokens: number | null
  items: ChatItem[]
}
