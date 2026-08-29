/**
 * 本地旁路 embedding HTTP 服务生命周期。
 *
 * 模型就位且有加速器时，随应用拉起
 * `python -m kl_graph.utils.local_embed_server`（OpenAI 兼容 `/v1/embeddings`）。
 * 起不来（缺依赖 / 端口占用 / 立刻退出）→ 明示，**不**假装 ready。
 *
 * 与 kl-server 同款：`spawnDuplex` 无限期存活 + 主动 close；warmup 等 `/health`。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import {
  LOCAL_EMBED_PORT_DEFAULT,
  localEmbedBaseUrl,
  type ProcessRunner,
  type DuplexHandle,
} from "@mycontext/runtime-env"

const WARMUP_TIMEOUT_MS = 120_000
const HEALTH_POLL_MS = 500

export type EmbedServerState = "stopped" | "starting" | "ready" | "failed"

export interface EmbedServerServiceOptions {
  clock: Clock
  logger: Logger
  processes: ProcessRunner
  /** kl-graph 根（`-m kl_graph...` 的 cwd / PYTHONPATH） */
  klRoot: string
  /** 已探测到的模型目录（绝对路径；空 = 不起） */
  modelDir: string | null
  /** 监听端口；默认 8100 */
  port?: number
  preparePython: () => Promise<{ python: string; env: NodeJS.ProcessEnv } | null>
  /** 可注入健康探测（单测） */
  probeHealth?: (port: number) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
}

export class EmbedServerService {
  private state: EmbedServerState = "stopped"
  private handle: DuplexHandle | null = null
  private starting: Promise<boolean> | null = null
  private lastError: string | null = null
  private readonly port: number
  private readonly stderrTail: string[] = []

  constructor(private readonly options: EmbedServerServiceOptions) {
    this.port = options.port ?? LOCAL_EMBED_PORT_DEFAULT
  }

  getState(): EmbedServerState {
    return this.state
  }

  /** ready 时给网关用的 base（含 `/v1`）。 */
  baseUrl(): string | null {
    return this.state === "ready" ? localEmbedBaseUrl(this.port) : null
  }

  statusText(): string | null {
    if (this.state === "ready") return `本地向量服务就绪（127.0.0.1:${String(this.port)}）`
    if (this.state === "starting") return "本地向量服务启动中…"
    if (this.state === "failed") {
      return this.lastError !== null
        ? `本地向量服务未就绪：${this.lastError}`
        : "本地向量服务未就绪"
    }
    return null
  }

  async ensureReady(): Promise<boolean> {
    if (this.state === "ready" && this.handle?.alive === true) return true
    if (this.starting !== null) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async stop(): Promise<void> {
    const handle = this.handle
    this.handle = null
    this.state = "stopped"
    this.lastError = null
    if (handle !== null) {
      await handle.close().catch(() => {})
    }
  }

  private async start(): Promise<boolean> {
    const modelDir = this.options.modelDir
    if (modelDir === null || modelDir === "") {
      this.fail("未配置旁路模型目录")
      return false
    }

    // 已有人听着（上次崩溃残留或手动起的）→ 直接认
    if (await this.healthy()) {
      this.state = "ready"
      this.options.logger.info("embed server already healthy", { port: this.port })
      return true
    }

    const prepared = await this.options.preparePython()
    if (prepared === null) {
      this.fail("Python 环境不可用，无法起本地向量服务")
      return false
    }

    this.state = "starting"
    this.stderrTail.length = 0
    this.options.logger.info("embed server starting", { port: this.port })

    try {
      const handle = this.options.processes.spawnDuplex({
        executable: prepared.python,
        args: ["-m", "kl_graph.utils.local_embed_server"],
        env: {
          ...prepared.env,
          MYCONTEXT_EMBED_MODEL_DIR: modelDir,
          KL_LOCAL_EMBED_MODEL_PATH: modelDir,
          KL_EMBED_PORT: String(this.port),
          KL_EMBED_MODEL: process.env["KL_EMBED_MODEL"] ?? "Qwen3-Embedding-8B",
        },
        cwd: this.options.klRoot,
        onLine: (line) => this.options.logger.debug("embed server stdout", { line }),
        onStderr: (line) => {
          this.stderrTail.push(line)
          if (this.stderrTail.length > 30) this.stderrTail.shift()
          this.options.logger.debug("embed server stderr", { line })
        },
        onExit: (info) => {
          if (this.handle !== handle) return
          this.handle = null
          if (this.state === "stopped") return
          const detail =
            this.stderrTail.slice(-5).join(" | ") ||
            `exit ${String(info.code ?? info.signal ?? "?")}`
          this.fail(detail)
        },
      })
      this.handle = handle
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      return false
    }

    return this.awaitHealthy()
  }

  private async awaitHealthy(): Promise<boolean> {
    const sleep = this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    const deadline = this.options.clock.now() + WARMUP_TIMEOUT_MS
    while (this.options.clock.now() < deadline) {
      if (this.state === "failed" || this.state === "stopped") return false
      if (this.handle !== null && this.handle.alive !== true) {
        this.fail(this.stderrTail.slice(-5).join(" | ") || "进程已退出")
        return false
      }
      if (await this.healthy()) {
        this.state = "ready"
        this.lastError = null
        this.options.logger.info("embed server ready", { port: this.port })
        return true
      }
      await sleep(HEALTH_POLL_MS)
    }
    await this.handle?.close().catch(() => {})
    this.handle = null
    this.fail("启动超时（未在时限内通过 /health）")
    return false
  }

  private async healthy(): Promise<boolean> {
    const probe = this.options.probeHealth ?? defaultProbeHealth
    return probe(this.port)
  }

  private fail(reason: string): void {
    this.state = "failed"
    this.lastError = reason
    this.options.logger.warn("embed server failed", { detail: reason })
  }
}

async function defaultProbeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(1_500),
    })
    return res.ok
  } catch {
    return false
  }
}
