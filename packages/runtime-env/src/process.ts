/**
 * 子进程执行器。
 *
 * 三种形态：
 *   exec()         一次性命令，收齐输出后返回（auth status 这类）
 *   spawn()        长驻命令，逐行回调输出（auth login 这类，要边等边把进度推给 UI）
 *   spawnDuplex()  **双向**长连（ACP：stdin/stdout 上跑 JSON-RPC），无超时、可写、带背压
 *
 * 统一保证：超时（前两种）、输出上限、可取消、日志脱敏。
 * 所有外部进程调用都必须走这里，否则「某处忘了设超时」会变成应用挂死。
 *
 * 为什么 spawnDuplex 要单独一种形态而不是给 spawn 加参数：
 * 前两种的核心不变式是「一定会结束」（有 timeout、收齐输出就 resolve），
 * 而 ACP 连接的核心不变式恰好相反 ——「一直活着直到我们主动关」。
 * 把两者塞进一个函数，就会得到一个「有时会超时杀掉你的长连接」。
 */
import { spawn as nodeSpawn } from "node:child_process"
import type { ChildProcess, ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { AppError, redact, type Logger } from "@mycontext/kernel"

/** 输出上限：DWS 的 JSON 输出通常 < 10KB，8MB 足够且能挡住异常刷屏。 */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

export interface ExecSpec {
  executable: string
  args: string[]
  env: Record<string, string>
  /**
   * 工作目录。
   *
   * 缺省时由调用方决定（Node 默认继承本进程 cwd）。
   * **不要传二进制所在目录**：某些外部程序会在 cwd 下写配置与凭据，
   * 而那个目录同时是构建产物目录 —— 本仓库已经因此泄漏过一次 token。
   */
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  /** 是否因超时被终止 */
  timedOut: boolean
}

export interface SpawnSpec extends ExecSpec {
  /** 每收到一行 stdout/stderr 调用一次（已按行切分，去掉行尾换行） */
  onLine: (line: string, stream: "stdout" | "stderr") => void
  /** 授权 URL 等可能在进程阻塞前不换行；这类协议需要直接观察 chunk。 */
  onChunk?: (chunk: string, stream: "stdout" | "stderr") => void
}

/**
 * 双向长连的规格。
 *
 * 刻意不继承 ExecSpec 的 timeoutMs：长连没有「正常耗时」这个概念，
 * 允许传一个超时只会诱导有人填一个数字然后在第 31 秒被杀掉。
 */
export interface DuplexSpec {
  executable: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  /** stdout 逐行回调（ndjson 每行一个 JSON-RPC 消息） */
  onLine: (line: string) => void
  /** stderr 逐行回调：外部进程的诊断输出，只记日志不参与协议 */
  onStderr?: (line: string) => void
  /** 进程退出（正常或崩溃）。调用方据此决定是否重启 */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void
  /** 单行上限：一条协议消息过大通常意味着对端出问题了，而不是我们该扩缓冲 */
  maxLineBytes?: number
}

/** 双向长连的句柄。生命周期由调用方掌握 —— 这正是与 spawn() 的区别。 */
export interface DuplexHandle {
  /**
   * 写一行（自动补 `\n`）。
   *
   * 返回 Promise 是为了**背压**：内核缓冲满时 `write` 会返回 false，
   * 此时必须等 `drain` 而不是继续塞 —— 否则内存里会堆起一个无界队列，
   * 而这个问题只在对端变慢时才出现（也就是最不该雪上加霜的时候）。
   */
  writeLine(line: string): Promise<void>
  /** 主动关闭：先关 stdin 让对端优雅退出，超时未退再杀。 */
  close(): Promise<void>
  /** 进程是否仍在运行 */
  readonly alive: boolean
  readonly pid: number | undefined
}

export class ProcessRunner {
  constructor(private readonly logger: Logger) {}

  /** 一次性执行并收集全部输出。 */
  exec(spec: ExecSpec): Promise<ExecResult> {
    return this.run(spec)
  }

  /**
   * 长驻执行，逐行回调。
   * 解析进度（授权码、URL）靠调用方在 onLine 里做，本层不理解语义。
   */
  spawn(spec: SpawnSpec): Promise<ExecResult> {
    return this.run(spec, spec.onLine, spec.onChunk)
  }

  /**
   * 双向长连（stdin 可写、stdout 逐行读、无超时）。
   *
   * 现有 run() 硬编码 `stdio: ["ignore", "pipe", "pipe"]` —— stdin 被丢弃，
   * 承载不了 ACP 这种在 stdin/stdout 上跑 JSON-RPC 的协议。
   */
  spawnDuplex(spec: DuplexSpec): DuplexHandle {
    this.logger.debug("duplex process start", {
      executable: spec.executable,
      args: spec.args,
      cwd: spec.cwd,
    })

    let child: ChildProcess
    try {
      child = nodeSpawn(spec.executable, spec.args, {
        env: spec.env,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      throw new AppError("PROCESS_FAILED", `无法启动进程：${spec.executable}`, {
        cause: error,
        messageKey: "errors:process.spawnFailed",
        context: { executable: spec.executable },
      })
    }

    const stdin = child.stdin as Writable
    const stdout = child.stdout as Readable
    const stderr = child.stderr as Readable
    const maxLineBytes = spec.maxLineBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    let alive = true

    // 行缓冲：ndjson 的一条消息可能跨多个 chunk 到达，也可能一个 chunk 含多条。
    const buffers = { stdout: "", stderr: "" }
    const consume = (
      chunk: string,
      stream: "stdout" | "stderr",
      emit: (line: string) => void,
    ): void => {
      const merged = buffers[stream] + chunk
      const lines = merged.split(/\r?\n/)
      buffers[stream] = lines.pop() ?? ""
      if (Buffer.byteLength(buffers[stream]) > maxLineBytes) {
        // 单行超限：对端出问题了。丢掉这行残余并告警，而不是无界增长。
        this.logger.warn("duplex line exceeded limit, dropping partial", {
          executable: spec.executable,
          maxLineBytes,
        })
        buffers[stream] = ""
      }
      for (const line of lines) {
        if (line !== "") emit(line)
      }
    }

    stdout.setEncoding("utf8")
    stderr.setEncoding("utf8")
    stdout.on("data", (chunk: string) => consume(chunk, "stdout", spec.onLine))
    stderr.on("data", (chunk: string) =>
      consume(chunk, "stderr", (line) => {
        spec.onStderr?.(line)
        this.logger.debug("duplex stderr", { line: redact({ line }) })
      }),
    )

    // stdin 关闭后再写会抛 EPIPE；长连里这是「对端已退出」的常态，
    // 不该让它变成未捕获异常把主进程带走。
    stdin.on("error", (error) => {
      this.logger.debug("duplex stdin error", { detail: (error as Error).message })
    })

    child.on("error", (error) => {
      alive = false
      this.logger.warn("duplex process error", {
        executable: spec.executable,
        detail: error.message,
      })
      spec.onExit?.({ code: null, signal: null })
    })

    child.on("exit", (code, signal) => {
      alive = false
      this.logger.debug("duplex process exit", { executable: spec.executable, code, signal })
      spec.onExit?.({ code, signal })
    })

    return {
      get alive() {
        return alive
      },
      get pid() {
        return child.pid
      },
      writeLine(line: string): Promise<void> {
        if (!alive) {
          return Promise.reject(
            new AppError("PROCESS_FAILED", "进程已退出，无法写入", {
              context: { executable: spec.executable },
            }),
          )
        }
        return new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => reject(error)
          // write 返回 false = 内核缓冲已满，必须等 drain 再继续（背压）。
          const flushed = stdin.write(`${line}\n`, "utf8", (error) => {
            if (error !== undefined && error !== null) onError(error)
          })
          if (flushed) {
            resolve()
            return
          }
          stdin.once("drain", () => resolve())
        })
      },
      close(): Promise<void> {
        if (!alive) return Promise.resolve()
        return new Promise<void>((resolve) => {
          // 先关 stdin：ACP 对端读到 EOF 会自己优雅退出，比直接 SIGTERM 干净。
          const force = setTimeout(() => {
            if (alive) child.kill("SIGKILL")
          }, 3000)
          child.once("exit", () => {
            clearTimeout(force)
            resolve()
          })
          stdin.end()
          setTimeout(() => {
            if (alive) child.kill("SIGTERM")
          }, 500)
        })
      },
    }
  }

  private run(
    spec: ExecSpec,
    onLine?: (line: string, stream: "stdout" | "stderr") => void,
    onChunk?: (chunk: string, stream: "stdout" | "stderr") => void,
  ): Promise<ExecResult> {
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    // 命令与参数写进日志（参数里不应含密钥；仍然过 redact 兜底）。
    this.logger.debug("process start", {
      executable: spec.executable,
      args: spec.args,
      timeoutMs,
    })

    return new Promise<ExecResult>((resolve, reject) => {
      // stdin 设为 ignore，故类型是 ByStdio<null, Readable, Readable>
      let child: ChildProcessByStdio<null, Readable, Readable>
      try {
        child = nodeSpawn(spec.executable, spec.args, {
          env: spec.env,
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (error) {
        reject(
          new AppError("PROCESS_FAILED", `无法启动进程：${spec.executable}`, {
            cause: error,
            messageKey: "errors:process.spawnFailed",
            context: { executable: spec.executable },
          }),
        )
        return
      }

      let stdout = ""
      let stderr = ""
      let bytes = 0
      let timedOut = false
      let settled = false
      // 行缓冲：进程输出不保证按行到达，跨 chunk 的半行要拼起来。
      const partial = { stdout: "", stderr: "" }

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        spec.signal?.removeEventListener("abort", onAbort)
        fn()
      }

      const kill = () => {
        // 先 SIGTERM 给进程收尾机会，2 秒后仍在则 SIGKILL。
        child.kill("SIGTERM")
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        }, 2000)
      }

      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)

      const onAbort = () => {
        kill()
        finish(() =>
          reject(
            new AppError("PROCESS_CANCELLED", "操作已取消", {
              messageKey: "errors:process.cancelled",
              context: { executable: spec.executable },
            }),
          ),
        )
      }
      spec.signal?.addEventListener("abort", onAbort, { once: true })

      const consume = (chunk: string, stream: "stdout" | "stderr") => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > maxOutputBytes) {
          kill()
          finish(() =>
            reject(
              new AppError("PROCESS_FAILED", "进程输出超过上限，已终止", {
                messageKey: "errors:process.outputLimit",
                context: { executable: spec.executable, maxOutputBytes },
              }),
            ),
          )
          return
        }
        if (stream === "stdout") stdout += chunk
        else stderr += chunk

        onChunk?.(chunk, stream)

        if (onLine === undefined) return
        const merged = partial[stream] + chunk
        const lines = merged.split(/\r?\n/)
        partial[stream] = lines.pop() ?? ""
        for (const line of lines) onLine(line, stream)
      }

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => consume(chunk, "stdout"))
      child.stderr.on("data", (chunk: string) => consume(chunk, "stderr"))

      child.on("error", (error) => {
        finish(() =>
          reject(
            new AppError("PROCESS_FAILED", `进程执行失败：${error.message}`, {
              cause: error,
              messageKey: "errors:process.failed",
              messageParams: { detail: error.message },
              context: { executable: spec.executable },
            }),
          ),
        )
      })

      child.on("close", (code) => {
        // 收尾：把缓冲里剩下的半行也交出去。
        if (onLine !== undefined) {
          for (const stream of ["stdout", "stderr"] as const) {
            if (partial[stream] !== "") onLine(partial[stream], stream)
          }
        }

        finish(() => {
          if (timedOut) {
            reject(
              new AppError("PROCESS_TIMEOUT", `进程超时（${timeoutMs}ms）已终止`, {
                retryable: true,
                messageKey: "errors:process.timeout",
                messageParams: { ms: timeoutMs },
                context: { executable: spec.executable, timeoutMs },
              }),
            )
            return
          }
          const result: ExecResult = { exitCode: code ?? -1, stdout, stderr, timedOut: false }
          this.logger.debug("process done", {
            executable: spec.executable,
            exitCode: result.exitCode,
            // 输出可能含身份信息，只记长度；需要看内容时开 debug 单独打脱敏片段。
            stdoutBytes: stdout.length,
            stderrBytes: stderr.length,
          })
          if (result.exitCode !== 0) {
            this.logger.warn("process non-zero exit", {
              executable: spec.executable,
              exitCode: result.exitCode,
              stderr: redact({ tail: stderr.slice(-400) }),
            })
          }
          resolve(result)
        })
      })
    })
  }
}
