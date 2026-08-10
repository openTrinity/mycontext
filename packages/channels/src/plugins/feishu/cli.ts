/**
 * 飞书官方 CLI 的适配层。
 *
 * CLI 那侧负责 OAuth 与远端 API 的细节；这个包装层负责的是**应用边界**：
 * 隔离的 HOME/配置目录、严格的只读白名单、有界执行、以及宽容的 JSON 信封解析。
 */
import { createHash } from "node:crypto"
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
   * 列出当前用户所在的会话（单聊 + 群）。选采集范围那一步要它。
   *
   * 归 READ：`--help` 自报 `Risk: read`，只返回会话元信息
   * （id / 名称 / 类型 / 状态），**不含任何消息正文**。
   *
   * ★ 必须显式传 `--types=p2p,group`：不传等于只要群
   * （帮助文本："omit = groups only, backward compatible"），
   * 于是单聊一个都列不出来 —— 而单聊往往正是用户想选的。
   *
   * ★ 不用 `+chat-search`（按关键词搜群）：那个要先知道群名，
   * 而这一步的问题恰恰是"我有哪些会话"。
   */
  ["im", "+chat-list"],
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

/**
 * 从 CLI 的输出里抽出 JSON。
 *
 * ## ★★ 为什么不能"找到第一个 `{` 或 `[` 就切"
 *
 * CLI 会往输出里混**给 agent 的使用提示**，而那些提示以 `[AI agent] ` 开头
 * （实测：`auth login` 那条打了一整段"这个命令会阻塞 10 分钟…"）。
 * 前一版按"先试对象、再试数组"的顺序切，于是 `[AI agent] …` 命中了数组分支
 * → `JSON.parse("[AI agent] …")` 抛**原生 SyntaxError**，一路冒到界面上变成
 * `授权失败：Unexpected token 'A', "[AI agent] "... is not valid JSON`。
 *
 * 两个错都在那一版里：
 * ① 切的位置错（`[` 是提示文本的一部分，不是 JSON 的开头）；
 * ② 失败时抛的不是我们的 AppError —— 于是既没有 i18n key，
 *    也把 CLI 的原始输出片段直接糊在了用户界面上。
 *
 * 现在的判据：把**每一个**可能的起点（`{` 与 `[` 的每一次出现）按位置从前往后
 * 试一遍，第一个能整段 parse 成功的就是答案。多花几次 parse（输出通常几 KB），
 * 换掉一整类"提示文本里恰好有括号"的失败。
 */
export function extractLarkJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === "") throw new AppError("PROCESS_FAILED", "飞书 CLI 未返回 JSON")
  try {
    return JSON.parse(trimmed)
  } catch {
    // 落到这里说明有前后缀噪音（提示文本 / notice 行 / 进度输出）
  }

  /**
   * 候选起点：`{` 与 `[` 的每一次出现，按位置排序。
   *
   * ★ 与之对应的结束位置取**最后一个**同类闭括号：JSON 内部也有括号，
   * 取第一个会把对象截断。噪音一般在前面（提示）或后面（notice），
   * 所以"从这个起点到最后一个闭括号"是对的贪心。
   */
  const starts: { index: number; close: string }[] = []
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]
    if (ch === "{") starts.push({ index: i, close: "}" })
    else if (ch === "[") starts.push({ index: i, close: "]" })
  }

  for (const start of starts) {
    const end = trimmed.lastIndexOf(start.close)
    if (end <= start.index) continue
    try {
      return JSON.parse(trimmed.slice(start.index, end + 1))
    } catch {
      // 这个起点不是真的 JSON 开头（多半是提示文本里的括号）—— 试下一个
    }
  }

  /**
   * ★ 一律抛 AppError（带 i18n key），**不要**让原生 SyntaxError 冒出去：
   * 那个 message 会把 CLI 的原始输出片段糊在界面上，而用户完全看不懂。
   *
   * ★ context 里只放**长度**不放内容：输出里可能有会话标题、人名、token。
   */
  throw new AppError("PROCESS_FAILED", "飞书 CLI 返回了无法解析的内容", {
    messageKey: "errors:byCode.PROCESS_FAILED",
    context: { outputLength: trimmed.length, candidates: starts.length },
  })
}

/**
 * 把 CLI 的错误信封翻成**人话**。
 *
 * ## ★★ 为什么必须有这一层
 *
 * CLI 的错误是这个形状（实测）：
 * ```json
 * { "ok": false, "identity": "user", "error": {
 *     "type": "api", "subtype": "invalid_parameters", "code": 9499,
 *     "message": "too many request", "log_id": "2026…",
 *     "troubleshooter": "排查建议查看…https://open.feishu.cn/search?…" } }
 * ```
 * 而 `unwrapLarkEnvelope` 原来取的是 `row.message`（不存在，错误在
 * `row.error` 里），于是它落到"飞书 CLI 请求失败"；更糟的是 CLI 非零退出
 * 那条路把**整份 stdout** 当成了 message —— 于是那一大坨 JSON（含 log_id
 * 与一条排查链接）**原样糊在了用户界面上**。用户完全看不懂，也不知道该做什么。
 *
 * 这里按 `code` 给出"发生了什么 + 该做什么"。
 * ★ 认不出的 code 回落到 CLI 给的 `message`（英文短句，至少比整份 JSON 好），
 * 而**不是**回落到整份 JSON。
 */
export function describeLarkError(payload: unknown): {
  detail: string
  code: number | null
  retryable: boolean
} | null {
  if (typeof payload !== "object" || payload === null) return null
  const row = payload as Record<string, unknown>
  if (row["ok"] !== false) return null
  const err =
    typeof row["error"] === "object" && row["error"] !== null
      ? (row["error"] as Record<string, unknown>)
      : {}
  const code = typeof err["code"] === "number" ? err["code"] : null
  const raw = typeof err["message"] === "string" ? err["message"] : null

  /**
   * ★ 按 code 给人话。判据是"用户看完知不知道该做什么"。
   *
   * 9499（too many request）实测是**飞书服务端侧**的配额，不是我们调太频
   * （两小时里只跑了 7 次采集）。所以文案不能说"我们请求太多"——
   * 那会让用户去改采集周期，而那没用。
   */
  const HUMAN: Record<number, { detail: string; retryable: boolean }> = {
    9499: { detail: "飞书接口限流（服务端配额），稍后会自动重试", retryable: true },
    403: {
      detail: "飞书接口被拒（403）。若在办公网内，可能是域名未在安全策略里放行",
      retryable: true,
    },
  }
  const known = code === null ? undefined : HUMAN[code]
  if (known !== undefined) return { detail: known.detail, code, retryable: known.retryable }

  /**
   * ★ 权限不足单独认：它**不可重试**，而且有明确的用户动作（重新授权）。
   * 把它当成可重试的话采集会一直失败刷日志，而用户不知道要去点授权。
   */
  if (typeof err["subtype"] === "string" && err["subtype"] === "missing_scope") {
    const missing = Array.isArray(err["missing_scopes"])
      ? (err["missing_scopes"] as unknown[]).map(String).join("、")
      : ""
    return {
      detail: `飞书授权缺少权限${missing === "" ? "" : `（${missing}）`}，请重新授权`,
      code,
      retryable: false,
    }
  }

  return {
    detail: raw ?? "飞书接口调用失败",
    code,
    retryable: true,
  }
}

export function unwrapLarkEnvelope(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload
  const row = payload as Record<string, unknown>
  if (row["ok"] === false) {
    // ★ 走 describeLarkError：错误在 `row.error` 里，而不是 `row.message`
    const described = describeLarkError(payload)
    throw new AppError("PROCESS_FAILED", described?.detail ?? "飞书接口调用失败", {
      retryable: described?.retryable ?? true,
      ...(described?.code === null || described?.code === undefined
        ? {}
        : { context: { larkCode: described.code } }),
    })
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
  /**
   * 上一次 `env()` 解析出的「目录指纹 + 配置存在性」。
   *
   * 只为了让下面那条日志**只在变化时**打一条 —— 见它的注释。
   * `null` = 还没解析过（第一次必打，那正是启动时想知道的）。
   */
  private lastEnvSignature: string | null = null

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
    const hasConfig = existsSync(join(configDir, "config.json"))
    const hasMasterKey = existsSync(
      join(cliHome, "Library", "Application Support", "lark-cli", "master.key.file"),
    )
    /**
     * ★★ 每次解析都留痕：`authRoot 指纹` + 配置/主密钥在不在。
     *
     * ## 为什么需要它（一次查不下去的 `not configured`）
     *
     * 实测（打包态，一次真实故障）：飞书的会话列表**正常工作了 16 分钟**
     * （`conversation list merged remote: 4`），然后在一次**重新授权**之后
     * 变成 `not configured` 并再也没恢复：
     *
     *     17:13:19  conversation list merged   remote: 4     ← 还是好的
     *     17:13:21  channel identity bound                   ← 重新授权
     *     17:13:56  lark-cli exitCode 3  not_configured      ← 从此一直坏
     *
     * 而事后用同一个 authRoot 手动跑 `auth status` / `im +chat-list`
     * **完全正常**（配置与 master.key 都在）。也就是说坏的不是"文件没了"，
     * 而是那一小段时间里 CLI 看到的目录与我们以为的不是同一个 ——
     * 而当时**没有任何日志记下每条命令实际用的是哪个目录**，
     * 于是"切身份时 authRoot 指到哪"这个关键事实无从回答。
     *
     * ## 只记指纹与布尔，不记路径
     *
     * 真路径里有用户名（`/Users/<用户名>/…`），那是身份信息（CLAUDE.md §1.1）。
     * 指纹取 sha256 前 8 位：足够区分"换目录了没有"，且不可逆。
     *
     * ## ★ `info` 级，但**只在这三项变化时**打
     *
     * 打包态的 `logLevel` 是 `info`（实测：那份日志里只有 info/warn 两种，
     * debug 一条都没有）—— 用 debug 等于这条日志在真正需要它的环境里不存在，
     * 而它存在的唯一理由就是排查打包态的故障。
     *
     * 而这个方法**每条命令都会调**，无条件 info 会把日志刷满（那正是这轮
     * 反复踩的坑：重复日志把真正的错误埋掉）。所以只在指纹或存在性发生
     * 变化时打一条 —— 那恰好就是"切了目录"或"配置突然没了"这两个
     * 我们要抓的瞬间。
     */
    const signature = `${fingerprint(authRoot)}:${hasConfig ? 1 : 0}${hasMasterKey ? 1 : 0}`
    if (signature !== this.lastEnvSignature) {
      this.lastEnvSignature = signature
      this.options.logger.info("lark cli env resolved", {
        authRootFingerprint: fingerprint(authRoot),
        hasConfig,
        hasMasterKey,
      })
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
      /**
       * ★★ 非零退出时**先试着当错误信封解析** —— 不要把整份 stdout 当 message。
       *
       * CLI 在业务错误时也会非零退出，而它的 stdout 是一份完整 JSON
       * （含 log_id 与一条排查链接）。原来直接塞进 message，于是那一大坨
       * 原样糊在了界面上（实测：用户截图里就是那一坨）。
       */
      const described = (() => {
        try {
          return describeLarkError(extractLarkJson(combined))
        } catch {
          // 连 JSON 都不是（比如进程崩了）→ 下面回落到退出码
          return null
        }
      })()
      throw new AppError(
        "PROCESS_FAILED",
        described?.detail ?? `飞书 CLI 退出码 ${String(result.exitCode)}`,
        {
          retryable: described?.retryable ?? true,
          context: {
            exitCode: result.exitCode,
            command: commandPath(args),
            ...(described?.code === null || described?.code === undefined
              ? {}
              : { larkCode: described.code }),
          },
        },
      )
    }
    return unwrapLarkEnvelope(extractLarkJson(combined)) as T
  }

  /**
   * Pin the CLI master key to our isolated HOME before anything touches the
   * system Keychain.
   *
   * On macOS, `config init` and `auth login` prefer the system Keychain. Our
   * HOME points at the vault, which has no Keychain entry, so the OS puts up a
   * modal — "cannot find the keychain for master.key" with Cancel / Reset to
   * Default. Reset writes into the user's real login keychain (exactly what we
   * avoid: credentials must travel with the vault), and Cancel aborts the flow.
   *
   * The official CLI's supported automation path is `keychain-downgrade`: it
   * keeps the Keychain entry as a backup and makes subsequent processes read the
   * 0600 `master.key.file` under HOME instead.
   *
   * Verified 2026-08 on the bundled CLI: running this in a completely empty
   * isolated HOME succeeds and reports
   *
   *     OK: system Keychain was empty; generated a new master key and wrote it
   *     to …/master.key.file. The OS Keychain was not modified.
   *
   * so it creates its own directories and never touches the Keychain. That is
   * why `FeishuAuth.login` calls this **first**, before `config init` — an
   * earlier comment here claimed it had to run after `config init` ("no config
   * directory before that"), which no longer holds and was the reason the modal
   * appeared at all.
   *
   * Idempotent by design, so it also covers re-authorization (which skips
   * `config init` entirely).
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

/**
 * 目录指纹：sha256 前 8 位。
 *
 * ★ **不记真路径** —— 它形如 `/Users/<用户名>/Library/…`，用户名本身就是
 * 身份信息（CLAUDE.md §1.1）。而排查时要回答的问题只是"这两条命令用的是
 * 同一个目录吗"，指纹足够，且不可逆。
 */
function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8)
}
