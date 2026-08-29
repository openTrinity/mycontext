/**
 * Cursor Agent 会话封装：只换对话/工具循环，对上仍吐 `AgentEvent`。
 */
import { Agent, type SDKAgent, type Run, CursorAgentError } from "@cursor/sdk"
import type { AgentEvent } from "../chat-item.js"
import { mapSdkMessage } from "./map-sdk-message.js"

export type CursorRuntimeMode = "local" | "cloud"

/** Cursor 订阅侧默认模型（Agent 主路用；与网关 `modelMain` 无关）。 */
export const DEFAULT_CURSOR_MODEL = "composer-2.5"

export interface CursorSessionOptions {
  /**
   * User API Key。可省略：此时由 SDK 回落 `CURSOR_API_KEY` / `~/.cursor/sdk/auth.json`
   * （含本机 `cursor-agent login` 桥接铸造的 key）。**不要**传空串 —— SDK 会拒绝回落。
   */
  apiKey?: string
  runtime: CursorRuntimeMode
  /** local 必填；cloud 可省略 */
  cwd?: string
  /**
   * Cursor 模型 id。缺省 {@link DEFAULT_CURSOR_MODEL}。
   * **不要**把 OpenAI 兼容网关的 `modelMain`（尤其是 embedding 模型名）传进来。
   */
  modelId?: string
  onEvent?: (event: AgentEvent) => void
}

export class CursorSession {
  private agent: SDKAgent | null = null
  private currentRun: Run | null = null

  constructor(private readonly options: CursorSessionOptions) {}

  async ensure(): Promise<void> {
    if (this.agent !== null) return
    const model = { id: this.options.modelId?.trim() || DEFAULT_CURSOR_MODEL }
    const apiKey = this.options.apiKey?.trim()
    const auth = apiKey !== undefined && apiKey !== "" ? { apiKey } : {}
    if (this.options.runtime === "cloud") {
      this.agent = await Agent.create({
        ...auth,
        model,
        cloud: {},
      })
      return
    }
    const cwd = this.options.cwd
    if (cwd === undefined || cwd === "") {
      throw new Error("Cursor local runtime 需要 cwd")
    }
    this.agent = await Agent.create({
      ...auth,
      model,
      local: { cwd },
    })
  }

  /**
   * 发一轮用户消息，流式映射为 AgentEvent；结束时补 `turn_end`。
   * @returns 终端文本（若有）
   */
  async prompt(message: string, turnId: string): Promise<{ text: string; error?: string }> {
    await this.ensure()
    const agent = this.agent
    if (agent === null) throw new Error("Cursor agent 未初始化")

    const emit = (event: AgentEvent): void => {
      this.options.onEvent?.(event)
    }

    try {
      const run = await agent.send(message, {
        model: { id: this.options.modelId?.trim() || DEFAULT_CURSOR_MODEL },
      })
      this.currentRun = run
      let text = ""
      for await (const msg of run.stream()) {
        for (const event of mapSdkMessage(msg, turnId)) {
          if (event.type === "text_delta") text += event.text
          emit(event)
        }
      }
      const result = await run.wait()
      this.currentRun = null
      if (result.status === "error") {
        const errMsg = result.error?.message ?? "Cursor run failed"
        emit({ type: "error", turnId, message: errMsg })
        emit({ type: "turn_end", turnId })
        return { text, error: errMsg }
      }
      if (result.result && text === "") text = result.result
      if (result.usage) {
        emit({
          type: "turn_end",
          turnId,
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
        })
      } else {
        emit({ type: "turn_end", turnId })
      }
      return { text }
    } catch (err) {
      this.currentRun = null
      const message =
        err instanceof CursorAgentError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      emit({ type: "error", turnId, message })
      emit({ type: "turn_end", turnId })
      return { text: "", error: message }
    }
  }

  async cancel(): Promise<void> {
    const run = this.currentRun
    if (run === null) return
    try {
      await run.cancel()
    } catch {
      // 取消失败不抬到调用方：UI 已按取消路径走
    }
  }

  async close(): Promise<void> {
    await this.cancel()
    const agent = this.agent
    this.agent = null
    if (agent !== null) {
      try {
        agent.close()
      } catch {
        // ignore
      }
    }
  }
}
