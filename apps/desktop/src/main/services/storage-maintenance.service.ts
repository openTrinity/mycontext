/**
 * StorageMaintenanceService — 存储占用与缓存清理（应用级）。
 *
 * ## 它回答用户的三个问题
 *
 * 「数据存哪、为什么这么大、怎么清一下」。实测一台开发机的 userData
 * （`MyContextDevelop`）3.7G，构成：
 *
 * ```
 * vaults           1.8G   真语料/图库/画像 —— **真数据，绝不在这里清**
 * agent-npm-cache  1.0G   opencode 的 npm 只读镜像 —— 可清、会自动重下
 * Cache/Code Cache 857M   Electron/Chromium 的 HTTP/代码缓存 —— 可清、自动重建
 * logs             61M    jsonl 日志 —— 可清（保留当前正在写的那份）
 * ```
 *
 * ## ★★ 安全姿态：只删**白名单**，绝不递归删 userData 根
 *
 * 这个服务会删 userData 下的文件，所以它的边界必须写死、可审计：
 *
 * · 能清的只有 `CLEARABLE_DIRS` 里那几个**固定子目录名**（相对 userData 根）；
 * · `vaults` / `control.sqlite` / `shared` **永远不在清单里** —— 那是真数据，
 *   要清走 `channelDataWipe` 那条带确认的独立入口；
 * · 删之前每个目标都 `realpath` 校验它**确实在 userData 根之内**（防符号链接
 *   或算错的路径把删除面扩到根之外）；
 * · 日志目录特殊：**保留当前正在写的那份**（`logFile`），只删轮转下来的旧日志
 *   —— 否则删掉正在写的句柄会让当天日志错乱。
 *
 * ## dryRun 默认 true
 *
 * 与 `ChannelDataWipeService` 同一个约定：先算"能释放多少"、把数字给用户看、
 * 确认后再真删。契约层 `clearCachesInputSchema.dryRun` 默认 true。
 */
import { existsSync, readdirSync, rmSync, statSync, realpathSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import type { Logger } from "@mycontext/kernel"
import type { ClearCachesResult, StorageUsage } from "@mycontext/ipc-contract"

/** 可清理类别 → userData 根下的子路径（目录或文件名）。 */
type ClearableKey = "logs" | "electronCache" | "agentNpmCache"

/**
 * 可清理项的**固定**落点（相对 userData 根）。
 *
 * ★ 写死而不是"扫目录挑大的"：删除面必须是可审计的静态清单，不能由运行时
 * 数据决定删什么。Electron 缓存有好几个目录名（都由 Chromium 建、可重建）。
 */
const CLEARABLE: Record<ClearableKey, readonly string[]> = {
  logs: ["logs"],
  electronCache: ["Cache", "Code Cache", "GPUCache", "DawnWebGPUCache", "DawnGraphiteCache"],
  agentNpmCache: ["agent-npm-cache"],
}

/** 只读展示但**不清**的真数据项（相对 userData 根）。 */
const PROTECTED: { key: "vaults" | "control"; path: string }[] = [
  { key: "vaults", path: "vaults" },
  { key: "control", path: "control.sqlite" },
]

export interface StorageMaintenanceOptions {
  logger: Logger
  /** userData 根（`AppPaths.userData`）。 */
  userDataDir: string
  /** 当前正在写的日志文件绝对路径（`AppPaths.logFile`）—— 清日志时保留它。 */
  logFile: string
}

/** 递归算一个路径的字节数；不存在 → 0。整段吞错（占用统计不该让任何流程崩）。 */
function pathBytes(target: string): number {
  let total = 0
  let stat
  try {
    stat = statSync(target)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  let entries: string[]
  try {
    entries = readdirSync(target)
  } catch {
    return 0
  }
  for (const name of entries) total += pathBytes(join(target, name))
  return total
}

export class StorageMaintenanceService {
  constructor(private readonly options: StorageMaintenanceOptions) {}

  /** 各类占用（只读）。 */
  usage(): StorageUsage {
    const root = this.options.userDataDir
    const categories: StorageUsage["categories"] = []

    let clearableBytes = 0
    for (const key of Object.keys(CLEARABLE) as ClearableKey[]) {
      const bytes = CLEARABLE[key].reduce((sum, rel) => sum + pathBytes(join(root, rel)), 0)
      categories.push({ key, bytes })
      clearableBytes += bytes
    }

    let protectedBytes = 0
    for (const { key, path } of PROTECTED) {
      const bytes = pathBytes(join(root, path))
      categories.push({ key, bytes })
      protectedBytes += bytes
    }

    // 其它（根下未被上面任一类覆盖的剩余）—— 让"总量 = 各类之和"，不留黑洞。
    const accounted = new Set<string>([
      ...Object.values(CLEARABLE).flat(),
      ...PROTECTED.map((p) => p.path),
    ])
    let otherBytes = 0
    try {
      for (const name of readdirSync(root)) {
        if (accounted.has(name)) continue
        otherBytes += pathBytes(join(root, name))
      }
    } catch {
      // 根读不到（极少见）→ other 记 0，不崩
    }
    categories.push({ key: "other", bytes: otherBytes })

    const totalBytes = clearableBytes + protectedBytes + otherBytes
    return { userDataDir: root, totalBytes, clearableBytes, categories }
  }

  /**
   * 清可安全重建的那几类。`dryRun` 时只算不删。
   *
   * 删除前对每个目标做两道校验：① 解析后的真实路径**必须**在 userData 根之内；
   * ② 只删白名单里的固定名。任一不满足就跳过并告警 —— 宁可少清一项，
   * 也不越界删。
   */
  clearCaches(input: { dryRun: boolean }): ClearCachesResult {
    const root = this.options.userDataDir
    const byCategory: ClearCachesResult["byCategory"] = []
    let freedBytes = 0

    for (const key of Object.keys(CLEARABLE) as ClearableKey[]) {
      let categoryBytes = 0
      for (const rel of CLEARABLE[key]) {
        const target = join(root, rel)
        if (!existsSync(target)) continue
        if (!this.withinRoot(target, root)) {
          this.options.logger.warn("storage clear skipped: target escapes userData root", { rel })
          continue
        }
        if (key === "logs") {
          categoryBytes += this.clearLogsDir(target, input.dryRun)
        } else {
          categoryBytes += pathBytes(target)
          if (!input.dryRun) this.safeRemove(target)
        }
      }
      byCategory.push({ key, bytes: categoryBytes })
      freedBytes += categoryBytes
    }

    this.options.logger.info(input.dryRun ? "storage clear (dry-run)" : "storage cleared", {
      freedBytes,
      byCategory: byCategory.map((c) => `${c.key}:${c.bytes}`).join(","),
    })
    return { dryRun: input.dryRun, freedBytes, byCategory }
  }

  /**
   * 清日志目录，但**保留当前正在写的那份**（`logFile`）。
   *
   * 删正在写的句柄会让当天日志错乱（writer 仍持着 fd），所以按文件名逐个删、
   * 跳过当前那份。返回释放的字节数。
   */
  private clearLogsDir(dir: string, dryRun: boolean): number {
    const keep = this.options.logFile
    let freed = 0
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return 0
    }
    for (const name of entries) {
      const full = join(dir, name)
      if (resolve(full) === resolve(keep)) continue // 保留当前正在写的
      freed += pathBytes(full)
      if (!dryRun) this.safeRemove(full)
    }
    return freed
  }

  /** 目标解析后必须仍在 userData 根之内（防符号链接/相对逃逸）。 */
  private withinRoot(target: string, root: string): boolean {
    try {
      const realRoot = realpathSync(root)
      const realTarget = realpathSync(target)
      return realTarget === realRoot || realTarget.startsWith(realRoot + sep)
    } catch {
      return false
    }
  }

  /** 删一个文件/目录，吞错（清理是尽力而为，删不掉某项不该让整个动作失败）。 */
  private safeRemove(target: string): void {
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (error) {
      this.options.logger.warn("storage clear: remove failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
