/**
 * 统一错误类型。
 *
 * 所有跨层抛出的错误都应是 AppError：带稳定的 code（供上层判定与 i18n）、
 * retryable（供重试策略）与可选的用户可见文案键。禁止裸 throw string。
 */

/**
 * 全部错误码。
 *
 * 是值而不只是类型：i18n 的测试要能遍历它，确认每个码都有兜底译文。
 * 只有类型的话，新增一个码而忘了配文案，不会有任何东西报警。
 */
export const ERROR_CODES = [
  "CONFIG_INVALID",
  "DB_MIGRATION_FAILED",
  "DB_UNAVAILABLE",
  "AUTH_EMAIL_TAKEN",
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_WEAK_PASSWORD",
  "AUTH_INVALID_EMAIL",
  "AUTH_NOT_SIGNED_IN",
  "IPC_BAD_REQUEST",
  // 预置运行时与外部进程
  "RUNTIME_BINARY_MISSING",
  "PROCESS_FAILED",
  "PROCESS_TIMEOUT",
  "PROCESS_CANCELLED",
  // IM 渠道授权
  "CHANNEL_UNKNOWN",
  "CHANNEL_AUTH_IN_PROGRESS",
  "CHANNEL_AUTH_FAILED",
  /**
   * 渠道 CLI **拒绝覆盖**本地既有登录态（旧格式 token 槽与 profile 对不上）。
   *
   * 与 `CHANNEL_AUTH_FAILED` 分开是因为**可操作性完全不同**：那个是
   * "这次没成,再试试";这个是上游的安全拒绝,exit code 恒为 2,
   * 重试一百次都一样 —— 出路是带 `--profile` 在终端跑一次 login 完成迁移。
   * 合并成一个码就只能给出「请重试」,而那句话会把用户钉在一面墙上。
   */
  "CHANNEL_AUTH_LEGACY_TOKEN_SLOT",
  "CHANNEL_UNSUPPORTED",
  /** 渠道的资源还没就绪（如凭据目录尚未随 vault 挂载）。接线漏了，不是用户错误。 */
  "CHANNEL_NOT_READY",
  /** 找不到可用的 kl 端口（本机端口被占满）。 */
  "CHANNEL_PIPELINE_NO_PORT",
  // 数据面：解析与身份
  /** 本人身份无法唯一确定（同名多 ID）；宁可不蒸馏也不能把别人的消息当本人语料 */
  "SELF_IDENTITY_AMBIGUOUS",
  /**
   * 这个 vault 已绑定另一个身份（`channel + corpId + userId` 不一致）。
   *
   * fail-closed：换身份时**不静默覆盖**身份行 —— 库里躺着上一个身份采的
   * 会话与消息，覆盖后 `is_self` 会拿新身份的 openId 去判旧身份的消息，
   * 于是「哪些是本人说的」整批错位，而那正是蒸馏语料的唯一来源。
   * 实测踩到过：一个库里 39 个会话有 28 个属于组织 A，身份行被覆盖成组织 B
   * 之后 749 条消息被标成 `is_self=1` —— 全是错的。
   */
  "SELF_IDENTITY_CONFLICT",
  /**
   * 钉住的那个渠道身份在本机**没有登录态**（上游报「组织未找到」）。
   *
   * ## 为什么必须独立一个码，而不是落到兜底的 `PROCESS_FAILED`
   *
   * 渠道命令一律用 `--profile <corpId>:<userId>` 钉住当前 vault 绑定的身份
   * （见 `RuntimeEnvOptions.dwsProfile`）。而那个身份可能已经不在本机了 ——
   * 用户在终端跑过 `dws auth logout`，或换了台机器只拷了应用数据。
   *
   * 实测那时是 exit 3 + `{"error":{"category":"validation",
   * "message":"organization \"…\" not found"}}`。而 `classifyDwsError` 原本
   * 对 code 3 没有任何分支，于是它落到兜底的 `PROCESS_FAILED` +
   * `retryable: true` —— 也就是**一场无限重试风暴**：每一轮采集都失败、
   * 每一次都判定"可以重试"，日志刷屏而用户什么都不知道。
   *
   * 终态（`retryable: false`）：重试永远好不了，唯一出路是重新授权到这个身份
   * （或切到另一个身份）。与 `SESSION_EXPIRED` 分开是因为处置不同 ——
   * 那个是"这个身份的凭据过期了，重新扫码"，这个是"这个身份在本机根本不存在"。
   */
  "CHANNEL_IDENTITY_UNAVAILABLE",
  /** 外部数据格式与预期不符（时间串、分页结构等） */
  "PARSE_FAILED",
  // 外部会话与授权：这两个都是**终态**，重试永远好不了
  /** 渠道登录态过期，需要用户重新扫码 */
  "SESSION_EXPIRED",
  /** 缺少宿主侧授权（如发送权限），需要用户在宿主 UI 中确认 */
  "PERMISSION_REQUIRED",
  /** 宿主侧撤销了已授予的权限 */
  "GRANT_REVOKED",
  /**
   * 服务端**拒绝读取这个资源**，且不是靠授权能解决的（如保密群）。
   *
   * 与 `PERMISSION_REQUIRED` 的区别是"用户能不能做点什么"：
   * 后者提示用户去授权，而这个**没有任何补救动作** ——
   * 唯一正确的处置是永久跳过并记成「不可读」。
   * 实测来源：`server_error_code=1001`「该群为保密群，无法获取消息记录」。
   *
   * 分开一个码是必要的：混进 `PERMISSION_REQUIRED` 会让 UI 提示用户
   * 「去来源应用确认授权」，而那个操作对保密群永远无效 —— 用户会反复试。
   */
  "RESOURCE_FORBIDDEN",
  // Agent 与检索
  /** Agent 请求了不被允许的能力（写文件、非白名单工具等） */
  "FORBIDDEN",
  /** 全文检索表达式无法安全构造（不应发生；转义层的兜底） */
  "FTS_QUERY_INVALID",
  // 蒸馏
  /** 结论没有证据支撑，拒绝入库 —— 可信度与可审计的底线 */
  "DISTILL_NO_EVIDENCE",
  "INTERNAL",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface AppErrorOptions {
  /** 是否值得重试（网络/瞬时故障为 true，参数错误为 false） */
  retryable?: boolean
  /** 用户可见文案的 i18n key；缺省时由 UI 按 code 兜底 */
  messageKey?: string
  /**
   * messageKey 的插值参数。
   *
   * 参数必须单独传而不是在这里拼进 message：拼好的字符串没法翻译，
   * 而「口令至少需要 8 位」这类文案的数字在两种语言里位置都不同。
   * 只放可展示的值（数量、路径、外部工具的原始输出），不放密钥。
   */
  messageParams?: Record<string, string | number>
  /** 结构化上下文，写日志用；不得包含密钥或消息正文 */
  context?: Record<string, unknown>
  cause?: unknown
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly messageKey: string | undefined
  readonly messageParams: Record<string, string | number> | undefined
  readonly context: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "AppError"
    this.code = code
    this.retryable = options.retryable ?? false
    this.messageKey = options.messageKey
    this.messageParams = options.messageParams
    this.context = options.context
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/** 把任意 throw 出来的东西收敛成 AppError，避免上层拿到 unknown。 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value
  if (value instanceof Error) {
    return new AppError("INTERNAL", value.message, { cause: value })
  }
  return new AppError("INTERNAL", String(value))
}
