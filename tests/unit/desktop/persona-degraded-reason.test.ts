/**
 * 降级横幅说的是**真实原因**。
 *
 * ## 这一组锁的是一次"主动误导"的回归
 *
 * 顶栏下面那条横幅原来只看 `agentAvailable`，而那个判据只查 LLM
 * （`llmProvider.get() !== null`）。于是**opencode 缺失 / 版本读不出来**
 * 这一类降级：
 *
 * · `agentAvailable` 是 `true`（模型确实配了）→ 横幅**根本不显示**；
 * · 而草稿实际走的是直连（没有工具调用、没有事实检索）—— 能力静默变差。
 *
 * 真实故障：同事的日志里是 `opencode_version_unreadable`，
 * 而他看到的界面既没有横幅、也无从得知为什么草稿变差了。反过来在
 * 另一种排列下横幅会显示「未配置模型，去设置里配好」——
 * 而他的模型本来就配好了（`llm holder reconfigured, model: gpt-5.6-sol`）。
 * 让用户去改一个改不了的东西，比不告诉他更糟。
 *
 * 所以这里锁两件互相独立的事：
 * ① `snapshot().degradedReason` 是**真实**原因（不是"LLM 配没配"的代称）；
 * ② 每个原因都有**自己的**文案，且不回退到那句关于模型的话。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { LlmClient, staticLlmProvider } from "@mycontext/llm"
import type { DuplexHandle, DuplexSpec, ResolvedBinary } from "@mycontext/runtime-env"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PersonaService } from "../../../apps/desktop/src/main/services/persona.service.js"
import { explainDegradedReason } from "../../../apps/desktop/src/renderer/features/persona/decision-reason.js"

const NOW = 1_785_000_000_000
const logger = createLogger("test", { level: "error" })

/** 能出内容的 LLM —— 用来把"模型配了"与"agent 可用"分开。 */
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

/**
 * 造一个带 acp 的 PersonaService。
 *
 * `runtime` + `processes` 都给才会建 `PersonaAcp`（见 persona.service.ts 的
 * 构造注释）—— 而这一组测的恰恰是"agent 这一侧不可用"，所以必须给，
 * 否则 `this.acp` 是 null，`degradedReason()` 永远只能报 LLM 那一档。
 */
function makeService(options: {
  llm: LlmClient | null
  opencode: "ok" | "missing" | "unreadable_version" | "too_old"
}) {
  const resolved: ResolvedBinary = {
    name: "opencode",
    path: "/fake/opencode",
    platform: "darwin-arm64",
    source: "path",
  }
  const resolution =
    options.opencode === "ok"
      ? { ok: true as const, binary: resolved, version: "1.18.11" }
      : options.opencode === "too_old"
        ? {
            ok: false as const,
            reason: "too_old" as const,
            binary: resolved,
            found: "1.1.0",
            required: "1.2.23",
          }
        : options.opencode === "missing"
          ? { ok: false as const, reason: "missing" as const }
          : { ok: false as const, reason: "unreadable_version" as const, binary: resolved }

  const runtime = {
    tryResolveOpencode: () => (options.opencode === "missing" ? null : resolved),
    resolveUsableOpencode: () => resolution,
  } as unknown as NonNullable<ConstructorParameters<typeof PersonaService>[0]["runtime"]>
  const processes = {
    // 这一组不跑 turn，只查 degradedReason（它走 resolveOnce，不 spawn）。
    spawnDuplex: (_spec: DuplexSpec): DuplexHandle => {
      throw new Error("这组测试不该起进程")
    },
  } as unknown as NonNullable<ConstructorParameters<typeof PersonaService>[0]["processes"]>

  return new PersonaService({
    clock: new ManualClock(NOW),
    logger,
    workspaceRoot: mkdtempSync(join(tmpdir(), "mycontext-degraded-")),
    llmProvider: staticLlmProvider(options.llm),
    getWindow: () => null,
    runtime,
    processes,
  })
}

describe("★★ snapshot 报的是真实降级原因，不是「LLM 配没配」的代称", () => {
  it("★★ 模型配好了但 opencode 版本读不出来 → 原因是 agent 那一侧", () => {
    const service = makeService({ llm: workingLlm(), opencode: "unreadable_version" })
    /**
     * ★ 这条是那次故障的直接回归锁。
     *
     * 反证：把 `degradedReason()` 改回只看 llmProvider 时，它返回 null
     * （因为模型配了），这里必红 —— 而 null 正是"横幅不显示"的意思，
     * 也就是那个静默降级的状态。
     */
    expect(service.degradedReason()).toBe("opencode_version_unreadable")
  })

  it("★ opencode 缺失 → opencode_missing（而不是说模型没配）", () => {
    const service = makeService({ llm: workingLlm(), opencode: "missing" })
    expect(service.degradedReason()).toBe("opencode_missing")
  })

  it("★ 版本太老 → 带上实际版本与要求（用户据此知道要升到哪）", () => {
    const service = makeService({ llm: workingLlm(), opencode: "too_old" })
    expect(service.degradedReason()).toBe("opencode_too_old:1.1.0<1.2.23")
  })

  it("★ 模型没配时它优先 —— 那是更根本的一层（agent 路径也要用模型）", () => {
    const service = makeService({ llm: null, opencode: "missing" })
    expect(service.degradedReason()).toBe("llm_not_configured")
  })

  it("★ 两侧都就绪 → null（横幅不显示）", () => {
    const service = makeService({ llm: workingLlm(), opencode: "ok" })
    expect(service.degradedReason()).toBeNull()
  })

  it("★★ snapshot 把它带出去 —— 渲染层只能看到 snapshot", () => {
    const service = makeService({ llm: workingLlm(), opencode: "unreadable_version" })
    const snapshot = service.snapshot()
    /**
     * ★ 顺带锁住那个**互相矛盾**的组合本身：
     * `agentAvailable` 为 true（模型配了）而 `degradedReason` 非 null。
     * 这不是 bug —— 恰恰是"横幅必须看后者"的理由。
     * 用前者当判据时这个状态下横幅一个字都不显示。
     */
    expect(snapshot.agentAvailable, "模型配好了，所以这一项是 true").toBe(true)
    expect(snapshot.degradedReason, "但 agent 那侧不可用 —— 横幅要靠这个").toBe(
      "opencode_version_unreadable",
    )
  })
})

describe("★★ 每个原因有自己的文案，且**不**回退到关于模型的那句", () => {
  /** 记录键而不是渲染文案：这一层测的是选路，不是翻译内容。 */
  const t = (key: string): string => key

  it("★★ agent 那三类都不指向「去配模型」", () => {
    for (const reason of [
      "opencode_missing",
      "opencode_version_unreadable",
      "opencode_too_old:1.1.0<1.2.23",
    ]) {
      const key = explainDegradedReason(reason, t)
      /**
       * ★ 判据是"**不是** llmNotConfigured"，因为那正是旧行为
       * —— 一句听起来合理但会让用户白忙一场的话。
       */
      expect(key, `${reason} 不该指向模型配置`).not.toBe("degradedReasons.llmNotConfigured")
      expect(key, `${reason} 必须有登记的文案`).toMatch(/^degradedReasons\./)
    }
  })

  it("★ 模型没配那一档仍然说模型（那句话在这个原因下是对的）", () => {
    expect(explainDegradedReason("llm_not_configured", t)).toBe("degradedReasons.llmNotConfigured")
  })

  it("★ 未登记的原因原样显示，**不**兜底成关于模型的那句", () => {
    /**
     * 兜底会把一个我们还没见过的原因显示成一句错话，让用户按它去做
     * 一件没用的事。原样显示一个陌生枚举串至少能被搜到、能被问出来。
     */
    expect(explainDegradedReason("acp_turn_empty", t)).toBe("acp_turn_empty")
  })
})
