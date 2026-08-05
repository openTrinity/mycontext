/**
 * 日志落盘的**大小上限**。
 *
 * ## ★★ 为什么这是门禁而不是"优化"
 *
 * 落盘从前是"按日期一个文件、无条件 append、没有任何上限"。而实测发生过：
 * 一个互递归 bug（见 `KlServerService.graphExists()` 的注释）让同一条 warn
 * 以 **~15000 行/秒** 打了 3 小时 21 分钟 —— 单个文件 **1.7 GB / 1000 万行**，
 * 而那台机器磁盘本来只剩 25 GiB（95% 满）。
 *
 * ★ 这个上限**不修**任何 bug。它的全部作用是把后果从
 * "磁盘写满 + 谁也不敢打开那个文件" 降级成 "一条 warn 刷屏"：
 * 刷屏看得见，磁盘写满会连带弄坏别的东西（SQLite 写失败、应用起不来），
 * 而那时故障现场已经被埋掉了。
 *
 * 所以这一组锁三件事：撞上限要转档、转档后新文件从头写、
 * **启动时**接手一个已经超限的旧文件也要立刻转档（而不是接着往后写）。
 */
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger } from "@mycontext/kernel"

const dirs: string[] = []

/**
 * ★ 把控制台那一路掐掉。
 *
 * 这一组要写几千条日志才能撞到上限，而 logger 是**双输出**的 ——
 * 不掐的话测试自己就往 stdout 刷几千行，把真正的失败信息淹掉
 * （而"刷屏掩盖真实故障"正是这一组在防的事）。
 */
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true)
  vi.spyOn(console, "error").mockReturnValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function tempLogFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-logcap-"))
  dirs.push(dir)
  return join(dir, "app-test.jsonl")
}

/** 大小检查是每 1024 条一次（见 `SIZE_CHECK_EVERY`），所以要写够那么多条。 */
const ENOUGH_TO_TRIGGER_CHECK = 1100

describe("★★ 日志落盘有大小上限（1.7 GB 事故的第二道防线）", () => {
  it("超过上限 → 转成 .1 并重开一个新文件", () => {
    const filePath = tempLogFile()
    // 上限给 8 KB：几百条就撞到，不必真写 64 MB
    const logger = createLogger("test", { filePath, maxFileBytes: 8 * 1024 })
    for (let i = 0; i < ENOUGH_TO_TRIGGER_CHECK; i += 1) {
      logger.warn("read graph overview failed", { detail: "Maximum call stack size exceeded" })
    }
    expect(existsSync(`${filePath}.1`)).toBe(true)
    // 关键断言：**当前**文件远小于失控总量 —— 上限真的在起作用
    expect(statSync(filePath).size).toBeLessThan(8 * 1024 * 2)
  })

  it("只留一代（.1 会被覆盖，不会攒出 .2/.3 把上限乘 N）", () => {
    const filePath = tempLogFile()
    const logger = createLogger("test", { filePath, maxFileBytes: 4 * 1024 })
    for (let i = 0; i < ENOUGH_TO_TRIGGER_CHECK * 4; i += 1) {
      logger.warn("flood", { i })
    }
    expect(existsSync(`${filePath}.1`)).toBe(true)
    expect(existsSync(`${filePath}.2`)).toBe(false)
  })

  /**
   * ★★ 启动时那个文件可能**已经**超限了（上一次运行留下的 1.7 GB）。
   *
   * 计数从 0 起步的话要再写满 1024 条才转档 —— 也就是"接着往一个
   * 1.7 GB 的文件后面写"，而那正是要避免的场面。所以第一条就查。
   */
  it("接手一个已超限的旧文件 → 第一条就转档，不往后追加", () => {
    const filePath = tempLogFile()
    writeFileSync(filePath, "x".repeat(10 * 1024))
    const logger = createLogger("test", { filePath, maxFileBytes: 4 * 1024 })
    logger.info("first line after restart", {})
    expect(existsSync(`${filePath}.1`)).toBe(true)
    const now = readFileSync(filePath, "utf8")
    expect(now).toContain("first line after restart")
    // 新文件只有这一条，没继承那 10 KB
    expect(now.startsWith("x")).toBe(false)
    expect(now.trimEnd().split("\n")).toHaveLength(1)
  })

  it("正常量级不转档（不该给日常使用加噪音）", () => {
    const filePath = tempLogFile()
    const logger = createLogger("test", { filePath, maxFileBytes: 64 * 1024 * 1024 })
    for (let i = 0; i < ENOUGH_TO_TRIGGER_CHECK; i += 1) logger.info("ordinary", { i })
    expect(existsSync(`${filePath}.1`)).toBe(false)
  })

  /** 上限本身有缺省值：调用方不传也必须受保护（产品里就是不传的）。 */
  it("不传 maxFileBytes 也有缺省上限", () => {
    const filePath = tempLogFile()
    const logger = createLogger("test", { filePath })
    logger.info("hello", {})
    // 缺省 64 MB，这一条当然不会转档；这里断言的是"没抛、照常落盘"
    expect(readFileSync(filePath, "utf8")).toContain("hello")
  })
})
