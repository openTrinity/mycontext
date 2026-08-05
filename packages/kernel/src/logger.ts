/**
 * 分类日志器。
 *
 * - message 用英文短语 + 结构化字段（便于 grep 与后续接采集）
 * - 字段一律先过 redact()：密钥不落盘
 * - 双输出：控制台（人读）+ 可选 JSONL 文件（排障）
 * - 落盘有**大小上限**（见 `MAX_LOG_FILE_BYTES`）：那是一道保险，不是优化
 *
 * 本阶段不引入第三方日志库：Node 内建能力已足够，且避免过早绑定 API 面。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { redact } from "./redact.js"

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * 单个日志文件的上限。超了就转成 `.1` 并重开一个新的（只留一代）。
 *
 * ## ★★ 为什么必须有这个上限
 *
 * 这里曾经是"按日期一个文件、无条件 append、没有任何上限"。
 * 而实测发生过：一个互递归 bug（见 `KlServerService.graphExists()`）让同一条
 * warn 以 **~15000 行/秒** 打了 3 小时 21 分钟 —— 单个文件 **1.7 GB**、
 * 1000 万行，而那台机器磁盘本来就只剩 25 GiB（95% 满）。
 *
 * ★ 这个上限**不修**任何 bug，它只把后果从"磁盘写满 + 谁也不敢打开那个文件"
 * 降级成"一条 warn 刷屏"。刷屏是能看见的，磁盘写满会连带弄坏别的东西
 * （SQLite 写失败、Electron 起不来），而那时故障现场已经被埋掉了。
 *
 * 64 MB：正常一天的日志实测 1.3 MB 量级（见 `app-2026-08-04.jsonl`），
 * 留 ~50 倍裕量 —— 正常使用永远撞不到，失控时几秒就撞到。
 */
const MAX_LOG_FILE_BYTES = 64 * 1024 * 1024

/**
 * 多少条检查一次文件大小。
 *
 * 每条都 `statSync` 会给正常路径加一次系统调用（日志在热路径上），
 * 而失控场景下 1024 条只是几十毫秒 —— 上限精度对这个用途毫无意义，
 * "别写到 1.7 GB"才是目的。
 */
const SIZE_CHECK_EVERY = 1024

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  child(category: string): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  /** JSONL 落盘路径；不传则只输出控制台 */
  filePath?: string
  /** 便于测试注入 */
  now?: () => Date
  /**
   * 覆盖单文件上限（字节）。测试用 —— 真实值见 `MAX_LOG_FILE_BYTES`。
   * 0 或负数 = 不限（那是从前的行为，不要在产品里用）。
   */
  maxFileBytes?: number
}

interface LoggerRuntime {
  level: LogLevel
  filePath: string | undefined
  now: () => Date
  fileBroken: boolean
  maxFileBytes: number
  /** 距上次查大小又写了多少条（见 `SIZE_CHECK_EVERY`）。 */
  sinceSizeCheck: number
}

/**
 * 到上限就把当前文件转成 `.1`（覆盖上一代）并让调用方重开一个新的。
 *
 * ★ 只留一代而不是留 N 代：留多代在失控场景下等于把上限乘 N ——
 * 而这个机制存在的全部意义就是"别把盘写满"。真要留历史应该按天归档，
 * 那是另一件事（`app-<日期>.jsonl` 已经按天分了）。
 *
 * ★ 转档失败**不停止落盘**：只把计数清零，下一批再试。转不动的原因
 * 通常是权限或文件被占，而那时"继续往老文件写"仍然比"从此不记日志"好。
 */
function rotateIfTooBig(runtime: LoggerRuntime, filePath: string): void {
  if (runtime.maxFileBytes <= 0) return
  runtime.sinceSizeCheck += 1
  if (runtime.sinceSizeCheck < SIZE_CHECK_EVERY) return
  runtime.sinceSizeCheck = 0
  try {
    if (statSync(filePath).size < runtime.maxFileBytes) return
    renameSync(filePath, `${filePath}.1`)
  } catch {
    // 文件还不存在（statSync 抛）或转不动 —— 两种都不该影响这一条的落盘。
  }
}

function write(
  runtime: LoggerRuntime,
  level: LogLevel,
  category: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[runtime.level]) return

  const safeFields = fields === undefined ? undefined : (redact(fields) as Record<string, unknown>)
  const timestamp = runtime.now().toISOString()

  const consoleLine = `${timestamp} ${level.toUpperCase().padEnd(5)} [${category}] ${message}`
  const suffix = safeFields === undefined ? "" : ` ${JSON.stringify(safeFields)}`
  // 只有 error 走 stderr，其余走 stdout：避免开发时正常日志污染错误流。
  if (level === "error") console.error(consoleLine + suffix)
  else process.stdout.write(consoleLine + suffix + "\n")

  if (runtime.filePath === undefined || runtime.fileBroken) return
  try {
    rotateIfTooBig(runtime, runtime.filePath)
    const record = { timestamp, level, category, message, ...(safeFields ?? {}) }
    appendFileSync(runtime.filePath, JSON.stringify(record) + "\n")
  } catch {
    // 落盘失败不能拖垮应用；标记后不再重试，控制台仍然可用。
    runtime.fileBroken = true
  }
}

function build(runtime: LoggerRuntime, category: string): Logger {
  return {
    debug: (message, fields) => write(runtime, "debug", category, message, fields),
    info: (message, fields) => write(runtime, "info", category, message, fields),
    warn: (message, fields) => write(runtime, "warn", category, message, fields),
    error: (message, fields) => write(runtime, "error", category, message, fields),
    child: (sub) => build(runtime, `${category}:${sub}`),
  }
}

export function createLogger(category: string, options: LoggerOptions = {}): Logger {
  const runtime: LoggerRuntime = {
    level: options.level ?? "info",
    filePath: options.filePath,
    now: options.now ?? (() => new Date()),
    fileBroken: false,
    maxFileBytes: options.maxFileBytes ?? MAX_LOG_FILE_BYTES,
    /**
     * ★ 从 `SIZE_CHECK_EVERY` 起步，也就是**第一条就查一次大小**。
     *
     * 从 0 起步的话，一个已经超上限的文件（上次运行留下的）要再写满
     * 1024 条才会被转档 —— 而"启动时接着往一个 1.7 GB 的文件后面写"
     * 正是这次要避免的场面。
     */
    sinceSizeCheck: SIZE_CHECK_EVERY,
  }
  if (runtime.filePath !== undefined) {
    try {
      mkdirSync(dirname(runtime.filePath), { recursive: true })
    } catch {
      runtime.fileBroken = true
    }
  }
  return build(runtime, category)
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value)
}
