/**
 * StorageMaintenanceService —— 存储占用统计 + 缓存清理。
 *
 * ## 这一组锁的是「删的边界」
 *
 * 这个服务会删 userData 下的文件，所以最该被门禁盯住的是**它绝不越界**：
 * · 只清白名单缓存（logs / Electron cache / agent-npm-cache）；
 * · **绝不碰** vaults / control.sqlite（真数据）；
 * · 清日志时**保留当前正在写的那份**；
 * · dryRun 不删任何东西、只算数。
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger } from "@mycontext/kernel"
import { StorageMaintenanceService } from "@main/services/storage-maintenance.service.js"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

/** 铺一个假 userData：几类缓存 + vaults + control + logs（含"当前"日志）。 */
function makeUserData() {
  const root = mkdtempSync(join(tmpdir(), "mc-storage-"))
  dirs.push(root)
  const write = (rel: string, bytes: number) => {
    const full = join(root, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, Buffer.alloc(bytes))
  }
  write("logs/app-2026-08-10.jsonl", 3000)
  write("logs/app-2026-08-13.jsonl", 1000) // 当前正在写的
  write("Cache/data_0", 5000)
  write("Code Cache/js/x", 2000)
  write("agent-npm-cache/_cacache/pkg", 8000)
  write("vaults/v1/core.sqlite", 100000) // 真数据 —— 绝不能被清
  write("control.sqlite", 500)
  const logFile = join(root, "logs", "app-2026-08-13.jsonl")
  const svc = new StorageMaintenanceService({
    logger: createLogger("t", { level: "error" }),
    userDataDir: root,
    logFile,
  })
  return { root, svc, logFile }
}

describe("usage：只读统计", () => {
  it("分出可清类与真数据类，且总量=各类之和", () => {
    const { svc } = makeUserData()
    const u = svc.usage()
    const cat = (k: string) => u.categories.find((c) => c.key === k)?.bytes ?? 0
    expect(cat("logs")).toBe(4000)
    expect(cat("electronCache")).toBe(7000)
    expect(cat("agentNpmCache")).toBe(8000)
    expect(cat("vaults")).toBe(100000)
    expect(cat("control")).toBe(500)
    // 可清 = logs+electron+agentNpm
    expect(u.clearableBytes).toBe(4000 + 7000 + 8000)
    // 总量 = 各类之和（不留黑洞）
    const sum = u.categories.reduce((s, c) => s + c.bytes, 0)
    expect(u.totalBytes).toBe(sum)
  })
})

describe("clearCaches：dryRun 不删、真清有边界", () => {
  it("dryRun 只算不删", () => {
    const { svc, root } = makeUserData()
    const r = svc.clearCaches({ dryRun: true })
    expect(r.dryRun).toBe(true)
    // 缓存/日志都还在
    expect(existsSync(join(root, "Cache/data_0"))).toBe(true)
    expect(existsSync(join(root, "agent-npm-cache/_cacache/pkg"))).toBe(true)
    expect(existsSync(join(root, "logs/app-2026-08-10.jsonl"))).toBe(true)
    // freedBytes = 可清量（含旧日志，不含当前日志）
    expect(r.freedBytes).toBe(3000 + 7000 + 8000)
  })

  it("★★ 真清删掉缓存，但 vaults/control **原样保留**", () => {
    const { svc, root } = makeUserData()
    svc.clearCaches({ dryRun: false })
    // 缓存被删
    expect(existsSync(join(root, "Cache"))).toBe(false)
    expect(existsSync(join(root, "Code Cache"))).toBe(false)
    expect(existsSync(join(root, "agent-npm-cache"))).toBe(false)
    // ★ 真数据一个字节都不能少
    expect(existsSync(join(root, "vaults/v1/core.sqlite"))).toBe(true)
    expect(existsSync(join(root, "control.sqlite"))).toBe(true)
  })

  it("★ 清日志时保留当前正在写的那份，只删旧的", () => {
    const { svc, root, logFile } = makeUserData()
    svc.clearCaches({ dryRun: false })
    expect(existsSync(join(root, "logs/app-2026-08-10.jsonl"))).toBe(false)
    // 当前日志仍在
    expect(existsSync(logFile)).toBe(true)
  })
})
