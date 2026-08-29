/**
 * 旁路向量模型（Qwen3-Embedding-8B）探测。
 *
 * 权重不进 git，按发版旁路资源分发（见 `docs/design/runtime-stack-migration.md` B2）。
 * 本模块只做「目录是否像模型 + 加速器粗检」，不下载、不起推理进程。
 *
 * 无模型或无加速器时调用方必须**明示**并禁止静默空跑建图——这里只给判据。
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

/** 旁路模型目录名（与 `scripts/prepare-embed-model.mjs` / vendor/models README 一致）。 */
export const EMBED_MODEL_NAME = "Qwen3-Embedding-8B"

/** 本地 8B 输出维度（固定；不走 matryoshka 截断）。 */
export const LOCAL_EMBED_DIM = 4096

/** 本地 OpenAI 兼容服务默认端口（与 kl_cli `KL_EMBED_PORT` 默认一致）。 */
export const LOCAL_EMBED_PORT_DEFAULT = 8100

export type EmbedAccelerator = "cuda" | "mps" | "none"

/**
 * 探测结果原因码（UI / 日志映射用；不要把商标名写进用户可见文案）。
 *
 * - `ready`：模型就位且有可用加速器假设
 * - `model_missing`：候选目录都没有权重/config
 * - `accelerator_none`：模型可能在，但无 CUDA/MPS 可用路径
 */
export type EmbedProbeReason = "ready" | "model_missing" | "accelerator_none"

export interface EmbedModelProbeResult {
  modelReady: boolean
  /** 命中的模型目录；未命中时为 null */
  modelDir: string | null
  accelerator: EmbedAccelerator
  reason: EmbedProbeReason
}

export interface EmbedModelProbeOptions {
  /** 显式模型目录（通常 `MYCONTEXT_EMBED_MODEL_DIR`） */
  envDir?: string | undefined
  /** 打包态 `process.resourcesPath` → `resources/models/<name>` */
  resourcesPath?: string | undefined
  /**
   * 安装目录旁的 `models/` 父目录。
   * 例如 `.app` 同级、或可执行文件旁单独分发的旁路包根。
   */
  siblingRoot?: string | undefined
  /** 开发态 / Resources 镜像根（含 `vendor/models`） */
  repoRoot?: string | undefined
  /** 可注入：单测不用碰真平台 */
  platform?: NodeJS.Platform
  /** 可注入：是否认为本机有 nvidia-smi（默认真探测） */
  hasNvidiaSmi?: () => boolean
}

/**
 * 目录是否「像」一个 HuggingFace / 权重布局的模型根。
 *
 * 有 `config.json` 或常见权重后缀即通过——不校验完整性（那是发版清单的事）。
 */
export function looksLikeModelDir(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    const entries = readdirSync(dir)
    return (
      entries.includes("config.json") ||
      entries.some((e) => e.endsWith(".safetensors") || e.endsWith(".bin") || e.endsWith(".gguf"))
    )
  } catch {
    return false
  }
}

/** 候选模型目录（顺序即优先级）。 */
export function embedModelCandidates(options: EmbedModelProbeOptions): string[] {
  const out: string[] = []
  const env = options.envDir?.trim()
  if (env) out.push(env)
  if (options.resourcesPath) {
    out.push(join(options.resourcesPath, "models", EMBED_MODEL_NAME))
  }
  if (options.siblingRoot) {
    out.push(join(options.siblingRoot, "models", EMBED_MODEL_NAME))
  }
  if (options.repoRoot) {
    out.push(join(options.repoRoot, "vendor", "models", EMBED_MODEL_NAME))
    out.push(join(options.repoRoot, "models", EMBED_MODEL_NAME))
  }
  return out
}

/**
 * 粗检加速器：darwin 假定 MPS 可用；linux/win 看 `nvidia-smi` 是否在 PATH。
 *
 * ★ 不要求真能跑通推理——那是 sidecar / vLLM 启动时的事。这里只挡
 * 「明显没有 GPU 工具链却假装本地 embed 就绪」的静默路径。
 */
export function probeEmbedAccelerator(
  options: {
    platform?: NodeJS.Platform
    hasNvidiaSmi?: () => boolean
  } = {},
): EmbedAccelerator {
  const platform = options.platform ?? process.platform
  if (platform === "darwin") return "mps"
  const check =
    options.hasNvidiaSmi ??
    (() => {
      try {
        const r = spawnSync("nvidia-smi", ["-L"], {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        })
        return r.status === 0
      } catch {
        return false
      }
    })
  return check() ? "cuda" : "none"
}

/** 本机 OpenAI 兼容 embedding base（恰好一个 `/v1`）。 */
export function localEmbedBaseUrl(port: number = LOCAL_EMBED_PORT_DEFAULT): string {
  return `http://127.0.0.1:${port}/v1`
}

/**
 * 探测旁路模型 + 加速器。
 *
 * `modelReady` 只看目录；`reason === "ready"` 还要求加速器不是 `none`。
 */
export function probeEmbedModel(options: EmbedModelProbeOptions = {}): EmbedModelProbeResult {
  const candidates = embedModelCandidates(options)
  const hit = candidates.find(looksLikeModelDir) ?? null
  const accelerator = probeEmbedAccelerator({
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.hasNvidiaSmi !== undefined ? { hasNvidiaSmi: options.hasNvidiaSmi } : {}),
  })

  if (hit === null) {
    return {
      modelReady: false,
      modelDir: null,
      accelerator,
      reason: "model_missing",
    }
  }
  if (accelerator === "none") {
    return {
      modelReady: true,
      modelDir: hit,
      accelerator,
      reason: "accelerator_none",
    }
  }
  return {
    modelReady: true,
    modelDir: hit,
    accelerator,
    reason: "ready",
  }
}

/** 本地旁路是否可被桌面当作默认 embedding 后端。 */
export function isLocalEmbedUsable(probe: EmbedModelProbeResult): boolean {
  return probe.reason === "ready"
}

export type EmbedGatewayMode = "local" | "remote" | "unavailable"

export interface EmbedGatewayConfigSlice {
  embedBaseUrl: string
  embedModel: string
  embeddingDim: number
  sendDimensions: boolean
}

export interface ResolveEmbedGatewayInput {
  probe: EmbedModelProbeResult
  /** 已规整的网关 OpenAI 兼容 embed base（可空） */
  gatewayEmbedBaseUrl: string
  /** 设置里的 embedding 模型名 */
  gatewayEmbedModel: string
  /** 显式覆盖（`KL_EMBED_BASE_URL` 或已拉起的本地服务 URL） */
  overrideEmbedBaseUrl?: string | undefined
  /**
   * 本地 HTTP 服务是否已 ready。
   * `true` 才把旁路探测结果当成默认可写的 local 后端——避免「模型在盘上但
   * 服务没起来」时仍把 KL_EMBED 指到 127.0.0.1 导致建图连失败。
   */
  localServing?: boolean | undefined
  /** 仅本地默认 URL 用 */
  embedPort?: number | undefined
}

export interface ResolvedEmbedGateway {
  config: EmbedGatewayConfigSlice
  mode: EmbedGatewayMode
}

function normalizeEmbedBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "")
  if (trimmed === "") return ""
  return `${trimmed.replace(/(\/v1)+$/, "")}/v1`
}

function remoteEmbedConfig(base: string, embedModel: string): EmbedGatewayConfigSlice {
  return {
    embedBaseUrl: normalizeEmbedBaseUrl(base),
    embedModel,
    // 远程兼容口历史上用 matryoshka 截到 2048；本地 8B 才是 4096。
    embeddingDim: 2048,
    sendDimensions: true,
  }
}

/**
 * 用户把 OpenAI 兼容网关指到本机（如 `llama serve --embeddings :8020`）时：
 * 不是云厂商的 matryoshka 口，固定出 4096、禁止带 `dimensions`。
 * 若仍按 remote 的 2048 写 zvec，Phase A upsert 会 dimension mismatch。
 */
function loopbackGatewayEmbedConfig(
  base: string,
  embedModel: string,
): EmbedGatewayConfigSlice {
  return {
    embedBaseUrl: normalizeEmbedBaseUrl(base),
    embedModel,
    embeddingDim: LOCAL_EMBED_DIM,
    sendDimensions: false,
  }
}

function resolveEmbedPort(explicit: number | undefined, envPort: string | undefined): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return explicit
  }
  if (envPort === undefined || envPort === "") return LOCAL_EMBED_PORT_DEFAULT
  const n = Number(envPort)
  return Number.isFinite(n) && n > 0 ? n : LOCAL_EMBED_PORT_DEFAULT
}

/**
 * 决定写入 kl 的 embedding 片段。
 *
 * 优先级：
 * 1. 非 loopback 显式覆盖 → remote
 * 2. loopback 显式覆盖 **且** `localServing===true` → local
 *    （loopback 覆盖但服务未起 → **忽略**，避免钉死 8100 死端口）
 * 3. 旁路探测可用且服务已 ready → local
 * 4. 远程 OpenAI 兼容网关 → remote（本地失败时的 Fallback）
 * 5. 不可用
 */
export function resolveEmbedGateway(
  input: ResolveEmbedGatewayInput,
  env: { embedPort?: string | undefined } = {},
): ResolvedEmbedGateway {
  const override = input.overrideEmbedBaseUrl?.trim() ?? ""
  if (override !== "") {
    if (isLoopbackEmbedUrl(override)) {
      /**
       * ★ 本地服务没起来时绝不能认 loopback 覆盖。
       * 常见事故：env 里残留 `KL_EMBED_BASE_URL=http://127.0.0.1:8100/v1`，
       * 旁路进程起失败后仍把 kl 指到死端口，远程 Fallback 永远走不到。
       */
      if (input.localServing === true) {
        return {
          mode: "local",
          config: {
            embedBaseUrl: normalizeEmbedBaseUrl(override),
            embedModel: EMBED_MODEL_NAME,
            embeddingDim: LOCAL_EMBED_DIM,
            sendDimensions: false,
          },
        }
      }
      // fall through → 远程网关
    } else {
      return {
        mode: "remote",
        config: remoteEmbedConfig(override, input.gatewayEmbedModel),
      }
    }
  }

  if (isLocalEmbedUsable(input.probe) && input.localServing === true) {
    const port = resolveEmbedPort(input.embedPort, env.embedPort)
    return {
      mode: "local",
      config: {
        embedBaseUrl: localEmbedBaseUrl(port),
        embedModel: EMBED_MODEL_NAME,
        embeddingDim: LOCAL_EMBED_DIM,
        sendDimensions: false,
      },
    }
  }

  const gateway = input.gatewayEmbedBaseUrl.trim()
  if (gateway !== "") {
    // 旁路未起时 loopback 覆盖会被忽略并落到这里；若网关本身也是
    // 127.0.0.1（用户自建 embedding），仍必须用本地维度，不能当云 API。
    if (isLoopbackEmbedUrl(gateway)) {
      return {
        mode: "remote",
        config: loopbackGatewayEmbedConfig(gateway, input.gatewayEmbedModel),
      }
    }
    return {
      mode: "remote",
      config: remoteEmbedConfig(gateway, input.gatewayEmbedModel),
    }
  }

  return {
    mode: "unavailable",
    config: {
      embedBaseUrl: "",
      embedModel: input.gatewayEmbedModel || EMBED_MODEL_NAME,
      embeddingDim: LOCAL_EMBED_DIM,
      sendDimensions: false,
    },
  }
}

function isLoopbackEmbedUrl(url: string): boolean {
  try {
    const host = new URL(url.includes("://") ? url : `http://${url}`).hostname
    return host === "127.0.0.1" || host === "localhost" || host === "::1"
  } catch {
    return /127\.0\.0\.1|localhost/.test(url)
  }
}

/** 主进程 / 日志用的一行中文状态（无第三方商标堆砌）。 */
export function formatEmbedStatusText(probe: EmbedModelProbeResult): string {
  switch (probe.reason) {
    case "ready":
      return `本地向量模型就绪（${probe.accelerator}）`
    case "model_missing":
      return "本地向量模型未就位（旁路权重缺失）—— 建图需远程 embedding 或安装旁路模型"
    case "accelerator_none":
      return "本地向量模型已找到但无可用 GPU 加速—— 已禁用本地 embedding，禁止静默空跑"
    default: {
      const _exhaustive: never = probe.reason
      return _exhaustive
    }
  }
}

/**
 * 综合「探测 + 本机服务态 + 最终 gateway 模式」的一行状态。
 *
 * 本地失败但已回落远程时必须**明示** Fallback，禁止只显示「本地未就绪」
 * 让人以为建图也被掐死了。
 */
export function formatEmbedGatewayStatus(input: {
  decided: ResolvedEmbedGateway
  probe: EmbedModelProbeResult
  /** EmbedServerService.statusText()；ready/failed/starting */
  localServerText?: string | null | undefined
}): string {
  const { decided, probe, localServerText } = input
  if (decided.mode === "local") {
    return localServerText?.trim() || formatEmbedStatusText(probe)
  }
  if (decided.mode === "remote") {
    const model = decided.config.embedModel
    const localBit = localServerText?.trim()
    if (localBit !== undefined && localBit !== "") {
      return `${localBit}；已回落 OpenAI 兼容向量 API（${model}）`
    }
    if (probe.reason !== "ready") {
      return `${formatEmbedStatusText(probe)}；使用 OpenAI 兼容向量 API（${model}）`
    }
    return `使用 OpenAI 兼容向量 API（${model}）`
  }
  return localServerText?.trim() || formatEmbedStatusText(probe)
}
