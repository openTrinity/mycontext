/**
 * Official Lark/Feishu CLI adapter.
 *
 * The CLI owns OAuth and remote API details. This wrapper owns the application
 * boundary: an isolated HOME/config directory, a strict read-only allowlist,
 * bounded execution, and tolerant JSON envelope parsing.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { AppError, type Logger } from "@mycontext/kernel"
import type { ProcessRunner } from "@mycontext/runtime-env"

const STATUS_TIMEOUT_MS = 30_000
const QUERY_TIMEOUT_MS = 90_000

const READ_COMMANDS: readonly string[][] = [
  ["auth", "status"],
  ["drive", "+search"],
  ["im", "+messages-search"],
  ["im", "+messages-mget"],
]
const INTERACTIVE_COMMANDS: readonly string[][] = [
  ["auth", "login"],
  ["auth", "logout"],
  ["config", "init"],
  ["config", "keychain-downgrade"],
]

function commandPath(args: readonly string[]): string[] {
  const path: string[] = []
  for (const token of args) {
    if (token.startsWith("-")) break
    path.push(token)
  }
  return path
}

function exact(path: readonly string[], allowed: readonly string[][]): boolean {
  return allowed.some(
    (candidate) =>
      candidate.length === path.length && candidate.every((token, index) => path[index] === token),
  )
}

export function assertAllowedLarkCommand(args: readonly string[]): void {
  const path = commandPath(args)
  if (exact(path, READ_COMMANDS) || exact(path, INTERACTIVE_COMMANDS)) return
  throw new AppError("FORBIDDEN", "飞书 CLI 命令不在只读白名单内", {
    messageKey: "errors:byCode.FORBIDDEN",
    context: { args: path.slice(0, 4) },
  })
}

export function extractLarkJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === "") throw new AppError("PROCESS_FAILED", "飞书 CLI 未返回 JSON")
  try {
    return JSON.parse(trimmed)
  } catch {
    const objectStart = trimmed.indexOf("{")
    const objectEnd = trimmed.lastIndexOf("}")
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1))
    }
    const arrayStart = trimmed.indexOf("[")
    const arrayEnd = trimmed.lastIndexOf("]")
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1))
    }
    throw new AppError("PROCESS_FAILED", "飞书 CLI 返回了无法解析的内容")
  }
}

export function unwrapLarkEnvelope(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload
  const row = payload as Record<string, unknown>
  if (row["ok"] === false) {
    const detail = typeof row["message"] === "string" ? row["message"] : "飞书 CLI 请求失败"
    throw new AppError("PROCESS_FAILED", detail, { retryable: true })
  }
  return row["data"] ?? row["body"] ?? payload
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

export function resolveLarkExecutable(explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== "") return explicit
  const fromEnv = process.env["INKLINGS_LARK_BIN"] ?? process.env["LARK_NATIVE_COMMAND"]
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv
  const legacy = join(
    homedir(),
    ".npm-global",
    "lib",
    "node_modules",
    "@larksuite",
    "cli",
    "bin",
    "lark-cli",
  )
  return existsSync(legacy) ? legacy : "lark-cli"
}

export interface LarkCliOptions {
  processes: ProcessRunner
  logger: Logger
  authRoot: string
  executable?: string
  /** Test seam for the macOS-only credential storage migration. */
  platform?: NodeJS.Platform
}

export class LarkCli {
  readonly executable: string

  constructor(private readonly options: LarkCliOptions) {
    this.executable = resolveLarkExecutable(options.executable)
  }

  env(): Record<string, string> {
    const authRoot = resolve(this.options.authRoot)
    const cliHome = join(authRoot, "home")
    const configHome = join(cliHome, ".config")
    const configDir = join(authRoot, "config")
    const logDir = join(authRoot, "logs")
    for (const dir of [authRoot, cliHome, configHome, configDir, logDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
    }
    return {
      ...processEnv(),
      HOME: cliHome,
      USERPROFILE: cliHome,
      XDG_CONFIG_HOME: configHome,
      LARKSUITE_CLI_CONFIG_DIR: configDir,
      LARKSUITE_CLI_LOG_DIR: logDir,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    }
  }

  async json<T>(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    assertAllowedLarkCommand(args)
    const result = await this.options.processes.exec({
      executable: this.executable,
      args,
      env: this.env(),
      timeoutMs: options.timeoutMs ?? (args[0] === "auth" ? STATUS_TIMEOUT_MS : QUERY_TIMEOUT_MS),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      maxOutputBytes: 64 * 1024 * 1024,
    })
    const combined = result.stdout.trim() !== "" ? result.stdout : result.stderr
    if (result.exitCode !== 0) {
      throw new AppError(
        "PROCESS_FAILED",
        combined.trim() || `飞书 CLI 退出码 ${String(result.exitCode)}`,
        {
          retryable: true,
          context: { exitCode: result.exitCode, command: commandPath(args) },
        },
      )
    }
    return unwrapLarkEnvelope(extractLarkJson(combined)) as T
  }

  /**
   * Pin the CLI master key to our isolated HOME before OAuth writes user tokens.
   *
   * On macOS, `config init` prefers the system Keychain. Electron can read the
   * app secret during device-flow setup, then fail only after the browser says
   * success when it tries to persist the user token from another process. The
   * official CLI's supported automation path is `keychain-downgrade`: it keeps
   * the Keychain entry as a backup and makes subsequent processes read the
   * 0600 `master.key.file` under HOME instead.
   *
   * This is intentionally idempotent and runs for every authorization attempt,
   * including re-authorization where `config init` is not called at all.
   */
  async ensureAutomationCredentialAccess(options: { signal?: AbortSignal } = {}): Promise<void> {
    if ((this.options.platform ?? process.platform) !== "darwin") return
    const args = ["config", "keychain-downgrade"]
    assertAllowedLarkCommand(args)
    const result = await this.options.processes.exec({
      executable: this.executable,
      args,
      env: this.env(),
      timeoutMs: STATUS_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      maxOutputBytes: 4 * 1024 * 1024,
    })
    if (result.exitCode === 0) return
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-4_096)
    throw new AppError(
      "PROCESS_FAILED",
      detail || "飞书 CLI 无法把 macOS 主密钥固定到应用数据目录",
      { retryable: true },
    )
  }

  /** First-run CLI application registration. The command blocks until the browser flow completes. */
  async configure(
    onUrl: (url: string) => void,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> {
    const args = ["config", "init", "--new"]
    assertAllowedLarkCommand(args)
    let opened = false
    let output = ""
    const inspect = (chunk: string): void => {
      output = `${output}${chunk}`.slice(-8_192)
      const url = output.match(/https:\/\/open\.feishu\.cn\/page\/cli\?[^\s"']+/)?.[0]
      if (url === undefined || opened) return
      opened = true
      onUrl(url)
    }
    const result = await this.options.processes.spawn({
      executable: this.executable,
      args,
      env: this.env(),
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      maxOutputBytes: 4 * 1024 * 1024,
      onLine: () => undefined,
      onChunk: (chunk) => inspect(chunk),
    })
    if (result.exitCode !== 0) {
      throw new AppError(
        "PROCESS_FAILED",
        result.stderr.trim() || result.stdout.trim() || "飞书 CLI 初始化失败",
        { retryable: true },
      )
    }
    if (!opened) this.options.logger.debug("lark CLI configured without browser URL")
  }
}

export const LARK_COMMAND_ALLOWLIST = {
  read: READ_COMMANDS,
  interactive: INTERACTIVE_COMMANDS,
} as const
