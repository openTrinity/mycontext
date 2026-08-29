/**
 * 旁路 embedding 模型探测：缺目录 / 假 fixture 有 config.json。
 *
 * 不碰真权重、不跑 nvidia-smi（加速器可注入）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  EMBED_MODEL_NAME,
  LOCAL_EMBED_DIM,
  looksLikeModelDir,
  probeEmbedModel,
  isLocalEmbedUsable,
  localEmbedBaseUrl,
  resolveEmbedGateway,
  formatEmbedGatewayStatus,
} from "@mycontext/runtime-env"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

describe("looksLikeModelDir", () => {
  it("目录不存在 → false", () => {
    expect(looksLikeModelDir("/nonexistent/mycontext-embed-never")).toBe(false)
  })

  it("空目录 → false", () => {
    const d = tempDir("mycontext-embed-empty-")
    expect(looksLikeModelDir(d)).toBe(false)
  })

  it("有 config.json → true", () => {
    const d = tempDir("mycontext-embed-cfg-")
    writeFileSync(join(d, "config.json"), "{}", "utf8")
    expect(looksLikeModelDir(d)).toBe(true)
  })

  it("有 .safetensors → true", () => {
    const d = tempDir("mycontext-embed-st-")
    writeFileSync(join(d, "model-00001-of-00002.safetensors"), "", "utf8")
    expect(looksLikeModelDir(d)).toBe(true)
  })
})

describe("probeEmbedModel", () => {
  it("候选全缺 → model_missing，modelReady=false", () => {
    const repo = tempDir("mycontext-embed-repo-")
    const probe = probeEmbedModel({
      repoRoot: repo,
      platform: "linux",
      hasNvidiaSmi: () => true,
    })
    expect(probe.modelReady).toBe(false)
    expect(probe.modelDir).toBeNull()
    expect(probe.reason).toBe("model_missing")
    expect(probe.accelerator).toBe("cuda")
    expect(isLocalEmbedUsable(probe)).toBe(false)
  })

  it("vendor 下假 fixture（config.json）+ CUDA → ready", () => {
    const repo = tempDir("mycontext-embed-hit-")
    const modelDir = join(repo, "vendor", "models", EMBED_MODEL_NAME)
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(modelDir, "config.json"), '{"hidden_size":4096}', "utf8")

    const probe = probeEmbedModel({
      repoRoot: repo,
      platform: "linux",
      hasNvidiaSmi: () => true,
    })
    expect(probe.modelReady).toBe(true)
    expect(probe.modelDir).toBe(modelDir)
    expect(probe.accelerator).toBe("cuda")
    expect(probe.reason).toBe("ready")
    expect(isLocalEmbedUsable(probe)).toBe(true)
  })

  it("模型就位但无 nvidia-smi → accelerator_none", () => {
    const repo = tempDir("mycontext-embed-nogpu-")
    const modelDir = join(repo, "vendor", "models", EMBED_MODEL_NAME)
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(modelDir, "config.json"), "{}", "utf8")

    const probe = probeEmbedModel({
      repoRoot: repo,
      platform: "linux",
      hasNvidiaSmi: () => false,
    })
    expect(probe.modelReady).toBe(true)
    expect(probe.accelerator).toBe("none")
    expect(probe.reason).toBe("accelerator_none")
    expect(isLocalEmbedUsable(probe)).toBe(false)
  })

  it("darwin 假定 mps，有模型 → ready", () => {
    const repo = tempDir("mycontext-embed-mps-")
    const modelDir = join(repo, "vendor", "models", EMBED_MODEL_NAME)
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(modelDir, "config.json"), "{}", "utf8")

    const probe = probeEmbedModel({
      repoRoot: repo,
      platform: "darwin",
      hasNvidiaSmi: () => false,
    })
    expect(probe.accelerator).toBe("mps")
    expect(probe.reason).toBe("ready")
  })

  it("MYCONTEXT_EMBED_MODEL_DIR 优先于 vendor", () => {
    const repo = tempDir("mycontext-embed-env-")
    const vendor = join(repo, "vendor", "models", EMBED_MODEL_NAME)
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, "config.json"), "{}", "utf8")

    const override = tempDir("mycontext-embed-override-")
    writeFileSync(join(override, "config.json"), '{"from":"env"}', "utf8")

    const probe = probeEmbedModel({
      envDir: override,
      repoRoot: repo,
      platform: "darwin",
    })
    expect(probe.modelDir).toBe(override)
  })

  it("packaged resources/models 候选", () => {
    const resources = tempDir("mycontext-embed-res-")
    const modelDir = join(resources, "models", EMBED_MODEL_NAME)
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(modelDir, "config.json"), "{}", "utf8")

    const probe = probeEmbedModel({
      resourcesPath: resources,
      repoRoot: tempDir("mycontext-embed-empty-repo-"),
      platform: "darwin",
    })
    expect(probe.modelDir).toBe(modelDir)
    expect(probe.reason).toBe("ready")
  })
})

describe("localEmbedBaseUrl", () => {
  it("默认 8100/v1", () => {
    expect(localEmbedBaseUrl()).toBe("http://127.0.0.1:8100/v1")
  })
})

describe("resolveEmbedGateway", () => {
  it("本地 ready 且服务已起 → dim 4096、sendDimensions=false、本机 URL", () => {
    const decided = resolveEmbedGateway({
      probe: {
        modelReady: true,
        modelDir: "/tmp/fake",
        accelerator: "mps",
        reason: "ready",
      },
      gatewayEmbedBaseUrl: "https://gw.example/v1",
      gatewayEmbedModel: "text-embedding-v4",
      localServing: true,
    })
    expect(decided.mode).toBe("local")
    expect(decided.config.embeddingDim).toBe(LOCAL_EMBED_DIM)
    expect(decided.config.sendDimensions).toBe(false)
    expect(decided.config.embedModel).toBe(EMBED_MODEL_NAME)
    expect(decided.config.embedBaseUrl).toBe("http://127.0.0.1:8100/v1")
  })

  it("模型在盘上但服务未起 → 回退远程网关（禁止指空端口）", () => {
    const decided = resolveEmbedGateway({
      probe: {
        modelReady: true,
        modelDir: "/tmp/fake",
        accelerator: "mps",
        reason: "ready",
      },
      gatewayEmbedBaseUrl: "https://gw.example/v1",
      gatewayEmbedModel: "text-embedding-v4",
      localServing: false,
    })
    expect(decided.mode).toBe("remote")
    expect(decided.config.embedBaseUrl).toBe("https://gw.example/v1")
  })

  it("本机 loopback 覆盖 → local 维度（4096）", () => {
    const decided = resolveEmbedGateway({
      probe: {
        modelReady: true,
        modelDir: "/tmp/fake",
        accelerator: "cuda",
        reason: "ready",
      },
      gatewayEmbedBaseUrl: "",
      gatewayEmbedModel: "text-embedding-v4",
      overrideEmbedBaseUrl: "http://127.0.0.1:8100/v1",
      localServing: true,
    })
    expect(decided.mode).toBe("local")
    expect(decided.config.embeddingDim).toBe(LOCAL_EMBED_DIM)
    expect(decided.config.sendDimensions).toBe(false)
  })

  it("loopback 覆盖但服务未起 → 忽略覆盖、回落远程（禁止钉死端口）", () => {
    const decided = resolveEmbedGateway({
      probe: {
        modelReady: true,
        modelDir: "/tmp/fake",
        accelerator: "mps",
        reason: "ready",
      },
      gatewayEmbedBaseUrl: "https://gw.example/v1",
      gatewayEmbedModel: "text-embedding-v4",
      overrideEmbedBaseUrl: "http://127.0.0.1:8100/v1",
      localServing: false,
    })
    expect(decided.mode).toBe("remote")
    expect(decided.config.embedBaseUrl).toBe("https://gw.example/v1")
    expect(decided.config.embeddingDim).toBe(2048)
    expect(decided.config.sendDimensions).toBe(true)
    expect(decided.config.embedModel).toBe("text-embedding-v4")
  })

  it("模型缺失但有网关 → remote 回退 2048", () => {
    const decided = resolveEmbedGateway({
      probe: {
        modelReady: false,
        modelDir: null,
        accelerator: "none",
        reason: "model_missing",
      },
      gatewayEmbedBaseUrl: "https://gw.example/compatible-mode/v1",
      gatewayEmbedModel: "text-embedding-v4",
    })
    expect(decided.mode).toBe("remote")
    expect(decided.config.embeddingDim).toBe(2048)
    expect(decided.config.sendDimensions).toBe(true)
    expect(decided.config.embedBaseUrl).toBe("https://gw.example/compatible-mode/v1")
  })

  it("旁路未起、网关是本机 embedding 口 → 4096 且不发 dimensions", () => {
    const decided = resolveEmbedGateway({
      probe: {
        modelReady: false,
        modelDir: null,
        accelerator: "none",
        reason: "model_missing",
      },
      gatewayEmbedBaseUrl: "http://127.0.0.1:8020/v1",
      gatewayEmbedModel: "Qwen/Qwen3-Embedding-8B-GGUF:Q4_K_M",
      localServing: false,
    })
    expect(decided.mode).toBe("remote")
    expect(decided.config.embedBaseUrl).toBe("http://127.0.0.1:8020/v1")
    expect(decided.config.embeddingDim).toBe(LOCAL_EMBED_DIM)
    expect(decided.config.sendDimensions).toBe(false)
    expect(decided.config.embedModel).toBe("Qwen/Qwen3-Embedding-8B-GGUF:Q4_K_M")
  })

  it("无本地且无网关 → unavailable", () => {
    const decided = resolveEmbedGateway({
      probe: {
        modelReady: false,
        modelDir: null,
        accelerator: "mps",
        reason: "model_missing",
      },
      gatewayEmbedBaseUrl: "",
      gatewayEmbedModel: "text-embedding-v4",
    })
    expect(decided.mode).toBe("unavailable")
    expect(decided.config.embedBaseUrl).toBe("")
  })

  it("KL_EMBED_BASE_URL 覆盖优先于本地", () => {
    const decided = resolveEmbedGateway({
      probe: {
        modelReady: true,
        modelDir: "/tmp/fake",
        accelerator: "cuda",
        reason: "ready",
      },
      gatewayEmbedBaseUrl: "",
      gatewayEmbedModel: "text-embedding-v4",
      overrideEmbedBaseUrl: "https://override.example/v1",
    })
    expect(decided.mode).toBe("remote")
    expect(decided.config.embedBaseUrl).toBe("https://override.example/v1")
  })
})

describe("formatEmbedGatewayStatus", () => {
  const probeReady = {
    modelReady: true,
    modelDir: "/tmp/fake",
    accelerator: "mps" as const,
    reason: "ready" as const,
  }

  it("本地失败且已回落远程 → 明示 Fallback", () => {
    const decided = resolveEmbedGateway({
      probe: probeReady,
      gatewayEmbedBaseUrl: "https://gw.example/v1",
      gatewayEmbedModel: "text-embedding-v4",
      localServing: false,
    })
    const text = formatEmbedGatewayStatus({
      decided,
      probe: probeReady,
      localServerText: "本地向量服务未就绪：缺 sentence-transformers",
    })
    expect(text).toContain("已回落 OpenAI 兼容向量 API")
    expect(text).toContain("text-embedding-v4")
    expect(text).toContain("缺 sentence-transformers")
  })

  it("无本地尝试、直接远程 → 使用兼容 API", () => {
    const decided = resolveEmbedGateway({
      probe: {
        modelReady: false,
        modelDir: null,
        accelerator: "none",
        reason: "model_missing",
      },
      gatewayEmbedBaseUrl: "https://gw.example/v1",
      gatewayEmbedModel: "text-embedding-v4",
    })
    const text = formatEmbedGatewayStatus({
      decided,
      probe: {
        modelReady: false,
        modelDir: null,
        accelerator: "none",
        reason: "model_missing",
      },
    })
    expect(text).toContain("使用 OpenAI 兼容向量 API")
    expect(text).toContain("text-embedding-v4")
  })
})
