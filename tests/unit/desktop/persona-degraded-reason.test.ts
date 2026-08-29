/**
 * 降级横幅说的是**真实原因**（Agent Key / LLM），不是「模型配没配」的代称。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { LlmClient, staticLlmProvider } from "@mycontext/llm"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PersonaService } from "../../../apps/desktop/src/main/services/persona.service.js"
import { explainDegradedReason } from "../../../apps/desktop/src/renderer/features/persona/decision-reason.js"

const NOW = 1_785_000_000_000
const logger = createLogger("test", { level: "error" })

function workingLlm(): LlmClient {
  return new LlmClient({
    baseUrl: "https://example.invalid",
    apiKey: "k",
    model: "m",
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "好" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  })
}

function makeService(options: { llm: LlmClient | null; agentKey: boolean }) {
  return new PersonaService({
    clock: new ManualClock(NOW),
    logger,
    workspaceRoot: mkdtempSync(join(tmpdir(), "mycontext-degraded-")),
    llmProvider: staticLlmProvider(options.llm),
    getWindow: () => null,
    runtime: {} as RuntimeEnv,
    processes: {} as ProcessRunner,
    getCursorApiKey: () => (options.agentKey ? "sk-test" : ""),
    getCursorRuntime: () => "local",
  })
}

describe("★★ snapshot 报的是真实降级原因，不是「LLM 配没配」的代称", () => {
  it("★★ 模型配好了但无 Agent Key → cursor_api_key_missing", () => {
    const service = makeService({ llm: workingLlm(), agentKey: false })
    expect(service.degradedReason()).toBe("cursor_api_key_missing")
  })

  it("★ 模型没配时它优先 —— 那是更根本的一层", () => {
    const service = makeService({ llm: null, agentKey: false })
    expect(service.degradedReason()).toBe("llm_not_configured")
  })

  it("★ 两侧都就绪 → null（横幅不显示）", () => {
    const service = makeService({ llm: workingLlm(), agentKey: true })
    expect(service.degradedReason()).toBeNull()
  })

  it("★★ snapshot 把它带出去", () => {
    const service = makeService({ llm: workingLlm(), agentKey: false })
    const snapshot = service.snapshot()
    expect(snapshot.agentAvailable).toBe(true)
    expect(snapshot.degradedReason).toBe("cursor_api_key_missing")
  })
})

describe("★★ 每个原因有自己的文案，且**不**回退到关于模型的那句", () => {
  const t = (key: string): string => key

  it("★★ agent 相关原因都不指向「去配模型」", () => {
    for (const reason of [
      "cursor_api_key_missing",
      "opencode_missing",
      "opencode_version_unreadable",
      "opencode_too_old:1.1.0<1.2.23",
    ]) {
      const text = explainDegradedReason(reason, t)
      expect(text).not.toBe("degradedReasons.llmNotConfigured")
    }
  })

  it("cursor_api_key_missing → agentKeyMissing", () => {
    expect(explainDegradedReason("cursor_api_key_missing", t)).toBe(
      "degradedReasons.agentKeyMissing",
    )
  })

  it("历史 opencode_* 码 → 同样落到 Agent Key 文案（不再暗示装二进制）", () => {
    expect(explainDegradedReason("opencode_missing", t)).toBe("degradedReasons.agentKeyMissing")
    expect(explainDegradedReason("opencode_version_unreadable", t)).toBe(
      "degradedReasons.agentKeyMissing",
    )
    expect(explainDegradedReason("opencode_too_old:1.1.0<1.2.23", t)).toBe(
      "degradedReasons.agentKeyMissing",
    )
  })
})
