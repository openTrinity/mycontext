/**
 * 飞书官方 CLI 的适配层。
 *
 * CLI 那侧负责 OAuth 与远端 API 的细节；这个包装层负责的是**应用边界**：
 * 隔离的 HOME/配置目录、严格的只读白名单、有界执行、以及宽容的 JSON 信封解析。
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { AppError, type Logger } from "@mycontext/kernel"
import type { ProcessRunner } from "@mycontext/runtime-env"

const STATUS_TIMEOUT_MS = 30_000
const QUERY_TIMEOUT_MS = 90_000

/**
 * 只读命令白名单。**这是安全边界，不是建议。**
 *
 * ## 判据是「完整命令」而不是前缀
 *
 * `exact()` 逐段全等比对 —— 前缀匹配会放行整棵子树（放行 `im` 就等于
 * 放行 `im send`）。与钉钉那边同一条规则（见 dingtalk/cli.ts）。
 *
 * ## `+` 前缀是什么
 *
 * 官方 CLI 用 `+` 标记它的**聚合命令**（一条命令内部串起若干次 API 调用并
 * 把结果合成一份，如"搜一页 → 逐条取正文 → 合并"）。裸命令（不带 `+`）
 * 是单次 API 直调。两者是不同的命令名，所以白名单里必须写全 —— 放行
 * `+messages-search` 不会顺带放行 `messages-search`，反之亦然。
 *
 * ## 加命令的规矩
 *
 * 逐条加、写清它做什么、为什么归 READ。**PII 类命令不进白名单**
 * （花名册、手机号反查、离职名单、合同/银行卡/家庭信息）——
 * 见 CLAUDE.md 第 5 节。
 */
const READ_COMMANDS: readonly string[][] = [
  /** 读当前授权态与本人身份（`--verify` 时会真打一次远端校验）。纯读。 */
  ["auth", "status"],
  /**
   * 云文档搜索（按编辑时间排序）。返回文档元信息与摘要片段，不改动任何文档。
   * 采集侧用它枚举"这段时间里我动过哪些文档"。
   */
  ["drive", "+search"],
  /**
   * 聊天消息搜索（按时间窗）。只读自己可见的消息 —— 服务端按当前用户的
   * 可见性裁剪，我们不传任何"以他人身份"的参数。
   */
  ["im", "+messages-search"],
  /**
   * 按 message id 批量取正文。搜索有时只返回 id 不带正文，用它补齐。
   * 归 READ：只接受 id 列表，不能用来枚举（拿不到 id 就取不到东西）。
   */
  ["im", "+messages-mget"],
]

/**
 * 需要用户在终端/浏览器里交互的命令。
 *
 * ★ 与 READ 分开列而不是合成一个大白名单：这几条**会改本机状态**
 * （写凭据、初始化配置、降级钥匙串存储），只该由授权流程调用。
 * 混在一起的话"只读边界"这句话就不再成立，而它是这个渠道的核心承诺。
 */
const INTERACTIVE_COMMANDS: readonly string[][] = [
  /** 设备码授权。会写入 token。 */
  ["auth", "login"],
  /** 撤销本机凭据。 */
  ["auth", "logout"],
  /** 首次初始化配置目录（我们指定的隔离目录）。 */
  ["config", "init"],
  /**
   * 把凭据存储从系统钥匙串降级到文件。
   *
   * ★ 必需：钥匙串是**按机器用户**的，而我们要的是**按身份**隔离
   * （凭据必须跟着 vault 走，见 `authRoot`）。存进钥匙串就没法隔离了。
   */
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
  /**
   * 凭据/配置/日志的隔离根目录。
   *
   * ## ★★ 为什么是**函数**而不是值
   *
   * 它按 vault 分（凭据必须跟着身份走，与 `dwsHome` 同一条理由），
   * 而插件是在**登录之前**装配的 —— 那一刻还不知道会挂哪个身份。
   * 取值的话装配层只能传一个占位串，而那个占位串会一路走到
   * `resolve()`：**空串 `resolve("")` 就是 `process.cwd()`**，
   * 于是飞书的 token 与日志被建到进程工作目录（开发态就是仓库目录）里。
   * 那既是一次凭据落盘位置错误，也会让 `.gitignore` 之外多出真实 token。
   *
   * 与 `RuntimeEnv.dwsProfile` / `GraphQueryOptions.dataDir` 同一个惰性模式：
   * 每条命令**现读**，切完身份下一条命令就用新目录，不必重建插件。
   */
  authRoot: () => string
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
    const root = this.options.authRoot()
    /**
     * ★ 空串是接线漏了，**必须抛**而不是 `resolve("")` 兜底成 cwd。
     *
     * 兜底的后果是凭据静默落进进程工作目录（见 `authRoot` 的注释）——
     * 而那类错误的表现是"能用"，只在某天有人发现仓库里多了一个
     * 装着 token 的目录时才暴露。
     */
    if (root.trim() === "") {
      throw new AppError("CHANNEL_NOT_READY", "飞书凭据目录未就绪（尚未挂载身份）", {
        messageKey: "errors:channel.notReady",
      })
    }
    const authRoot = resolve(root)
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
