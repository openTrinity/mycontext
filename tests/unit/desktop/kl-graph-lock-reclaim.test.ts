/**
 * 图库锁被孤儿握着时的**自愈** —— 用户报的那个飞书报错。
 *
 * ## 用户报的
 *
 *     kl-server 进程退出（code=3）：RuntimeError: Cannot start with graph
 *     backend 'ladybug': Could not set lock on file:
 *     …/sources/feishu/kl/graph.ladybug (Resource temporarily unavailable)
 *
 * ## 根因（实测，非推断）
 *
 * `lsof` 查出一个 **4 小时前**的孤儿 kl-server 仍握着**飞书那份**
 * `graph.ladybug` 的文件锁（它同时监听 8201）。于是每个新的飞书 kl-server
 * 一起来就撞锁 exit 3。
 *
 * ## 为什么原有的自愈救不了它（两处缺口）
 *
 * ① **凭证缺口**：接管判据是 pidfile，而 pidfile 是 spawn **成功之后**才写的。
 *    飞书这侧从来没成功过 → `sources/feishu/kl/` 下根本没有 pidfile →
 *    `readPidfile()` 返回 null → 直接放弃。
 *    **越是启动失败的那一侧，越拿不到自愈所需的凭证** —— 自我锁死。
 * ② **触发缺口**：`reclaimOrphan()` 只在"端口被占"分支里调。孤儿可能
 *    锁还握着而 HTTP 端口已死（或监听的是别的端口）→ 端口探测 false →
 *    直接 spawn → 撞锁。
 *
 * 修法：加一条**按锁持有者**的接管，并在 spawn 前**无条件**跑一次。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

const SERVICE = "apps/desktop/src/main/services/kl-server.service.ts"

/** 剥注释 —— 判据必须落在真代码上，不是解释它的注释。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

describe("图库锁自愈：pidfile 缺失时按锁持有者接管", () => {
  it("★★★ 没有 pidfile 时走锁持有者那条路（而不是直接放弃）", () => {
    /**
     * 反证：把 `if (record === null) return await this.reclaimGraphLockHolder()`
     * 改回 `if (record === null) return false` → 这条转红，
     * 而那正是用户遇到的"重启也不好"。
     */
    const src = stripComments(readFileSync(SERVICE, "utf8"))
    const at = src.indexOf("private async reclaimOrphan(")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, at + 600)
    expect(body).toContain("if (record === null) return await this.reclaimGraphLockHolder()")
  })

  it("★★★ spawn 之前**无条件**跑一次（端口探测救不了锁被占）", () => {
    /**
     * 孤儿可能锁还握着、端口已死。那时 `adopted` 为 false，
     * 于是原来的接管根本不会被调用。
     *
     * 反证：把 spawn 前那句 `await this.reclaimGraphLockHolder()` 删掉 → 转红。
     */
    const src = stripComments(readFileSync(SERVICE, "utf8"))
    const spawnAt = src.indexOf("mkdirSync(this.dataDir, { recursive: true })")
    expect(spawnAt).toBeGreaterThan(0)
    // 必须在建目录（spawn 前置）之前就检查过锁
    const before = src.slice(0, spawnAt)
    expect(before).toContain("await this.reclaimGraphLockHolder()")
  })

  it("★★★ 只杀**我们自己的** kl_server（外部进程不碰）", () => {
    /**
     * 杀错进程比"图谱服务起不来"糟得多。三条判据都要成立：
     * 锁真的被占 + pid 活着 + 命令行里有 `kl_server`。
     *
     * 反证：把 `cmd.includes("kl_server")` 那条删掉 → 转红（会去杀任何
     * 打开了这个文件的进程，比如用户拿编辑器看了一眼）。
     */
    const src = stripComments(readFileSync(SERVICE, "utf8"))
    const at = src.indexOf("private async reclaimGraphLockHolder(")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, at + 2600)
    expect(body).toContain('cmd.includes("kl_server")')
    expect(body).toContain("process.kill(pid, 0)")
    // 不许在判据不成立时也发 SIGTERM
    const killAt = body.indexOf('process.kill(pid, "SIGTERM")')
    expect(killAt).toBeGreaterThan(body.indexOf('cmd.includes("kl_server")'))
  })

  it("★★★ 等待判据是「进程消失」，不是端口释放", () => {
    /**
     * 孤儿监听的可能是另一个端口（实测飞书那次它在 8201，而撞的是文件锁），
     * 用端口探测会把"锁还没放开"误判成"已释放"。
     *
     * 反证：把等待循环换成 `probeExisting(this.port)` → 转红。
     */
    const src = stripComments(readFileSync(SERVICE, "utf8"))
    const at = src.indexOf("private async reclaimGraphLockHolder(")
    const body = src.slice(at, at + 3000)
    // 循环里用 signal 0 判存活
    const loopAt = body.indexOf("while (this.options.clock.now() < deadline)")
    expect(loopAt).toBeGreaterThan(0)
    const loop = body.slice(loopAt, loopAt + 400)
    expect(loop).toContain("process.kill(pid, 0)")
    expect(loop.includes("probeExisting")).toBe(false)
  })

  it("★★ 不碰自己（pid === process.pid 直接返回）", () => {
    const src = stripComments(readFileSync(SERVICE, "utf8"))
    const at = src.indexOf("private async reclaimGraphLockHolder(")
    const body = src.slice(at, at + 1600)
    expect(body).toContain("pid === process.pid")
  })

  it("★★ lsof 失败不抛（不在 / 没权限 / 文件没被占都当「没有孤儿」）", () => {
    /**
     * 这条路是**自愈**，不是正确性依赖。它自己出错不该让 kl 起不来。
     */
    const src = stripComments(readFileSync(SERVICE, "utf8"))
    const at = src.indexOf("private async reclaimGraphLockHolder(")
    const body = src.slice(at, at + 1600)
    expect(body).toContain("} catch {")
    expect(body).toContain("return false")
  })

  it("★★ 锁路径按 vault/渠道隔离（用 this.dataDir，不写死主渠道）", () => {
    /**
     * 写死主渠道路径的话，飞书那侧永远查的是钉钉的锁 —— 而那正是
     * 这个 bug 的形状（一个共用的判据来源）。
     *
     * 反证：把 `join(this.dataDir, "graph.ladybug")` 换成写死路径 → 转红。
     */
    const src = stripComments(readFileSync(SERVICE, "utf8"))
    const at = src.indexOf("private async reclaimGraphLockHolder(")
    const body = src.slice(at, at + 800)
    expect(body).toContain('join(this.dataDir, "graph.ladybug")')
  })
})
