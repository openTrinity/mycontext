/**
 * handoff.json 的形状。
 *
 * 这份文件是我们与算法团队之间**唯一**的运行时事实来源 —— 端口、token、
 * 共享目录、两个网关。字段名或结构一变，他们的 `kl-env.mjs`
 * 就读不到（而 `?? ""` 的兜底会让它静默变成空串）。
 */
import { describe, expect, it } from "vitest"
import { buildHandoffManifest } from "@mycontext/knowledge-feed"

const NOW = 1_785_207_229_147

function build(overrides: Partial<Parameters<typeof buildHandoffManifest>[0]> = {}) {
  return buildHandoffManifest({
    dataRoot: "/tmp/vault-a",
    dwsExportDir: "/tmp/vault-a/exports/dws",
    klDataDir: "/tmp/vault-a/kl",
    feedPort: 47_123,
    feedToken: "feed-token-abc",
    embeddingBaseUrl: "https://gateway.example/v1",
    embeddingModel: "text-embedding-v4",
    embeddingDim: 2048,
    localEmbeddingModel: "text-embedding-v4",
    localEmbeddingDim: 1024,
    llmBaseUrl: "https://gateway.example",
    llmModel: "claude-sonnet-4-6",
    nowMs: NOW,
    ...overrides,
  })
}

describe("handoff manifest", () => {
  it("Feed 端点都是 127.0.0.1 上的绝对 URL", () => {
    const manifest = build()
    expect(manifest.feed.baseUrl).toBe("http://127.0.0.1:47123/v1")
    for (const url of Object.values(manifest.feed.endpoints)) {
      expect(url.startsWith("http://127.0.0.1:47123/v1/")).toBe(true)
    }
  })

  /** 绑 127.0.0.1 是安全边界的一部分 —— 不能变成 0.0.0.0 或 localhost。 */
  it("不含 0.0.0.0 或 localhost", () => {
    const serialized = JSON.stringify(build())
    expect(serialized).not.toContain("0.0.0.0")
    expect(serialized).not.toContain("localhost")
  })

  it("共享目录按约定派生", () => {
    const manifest = build()
    expect(manifest.shared.dwsExportDir).toBe("/tmp/vault-a/exports/dws")
    expect(manifest.shared.klDataDir).toBe("/tmp/vault-a/kl")
  })

  /**
   * ★ 两套维度必须都在，且**不相等**。
   *
   * 相等的话说明有人"顺手统一了" —— 那是好事，但必须同时改
   * 对接文档的 embedding 边界一节，否则文档会开始说谎。
   */
  it("两套 embedding 维度都写明（2048 给他们 / 1024 我们自用）", () => {
    const manifest = build()
    expect(manifest.embedding.dim).toBe(2048)
    expect(manifest.localEmbedding.dim).toBe(1024)
    expect(manifest.localEmbedding.note).toContain("不作为共享产物")
  })

  /**
   * ★ 模型名必须是**裸名**（不带 provider 前缀）。
   *
   * 他们的 `llm_extractor.py:200` 自己拼 `f"anthropic/{model}"`。
   * 传全名 → `anthropic/anthropic/xxx` → `model_not_found`，
   * 而那个错**被 `extract_one` 吞掉并写进缓存**：退出码 0、
   * 看起来跑完了、什么都没抽出来，重跑还会命中空缓存。
   *
   * 我们真踩过这个坑（花了一轮联调）。这条断言让它不会再发生。
   */
  it("LLM 模型名不带 provider 前缀", () => {
    expect(build().llm.model).not.toContain("/")
  })

  it("带全名时这条断言会红（说明它真的在防这件事）", () => {
    expect(build({ llmModel: "anthropic/claude-sonnet-4-6" }).llm.model).toContain("/")
  })

  /** 那个坑的说明要随 manifest 一起给 —— 文档会没人读，manifest 他们一定看。 */
  it("modelNote 说清了前缀与静默失败", () => {
    const note = build().llm.modelNote
    expect(note).toContain("不要带 anthropic/ 前缀")
    expect(note).toContain("LLM errors")
  })

  it("env 变量名齐全（他们直接 export）", () => {
    const manifest = build()
    expect(manifest.embedding.envNames).toEqual({
      baseUrl: "KL_EMBED_BASE_URL",
      apiKey: "KL_EMBED_API_KEY",
      model: "KL_EMBED_MODEL",
    })
    expect(manifest.llm.envNames).toEqual({
      baseUrl: "KL_LLM_BASE_URL",
      model: "KL_LLM_MODEL",
      apiKey: "ANTHROPIC_AUTH_TOKEN",
    })
  })

  /** 时间用注入的，不用 Date.now() —— 否则这份文件的内容不可复现。 */
  it("generatedAt 用注入的时间", () => {
    expect(build().generatedAt).toBe(NOW)
  })
})
