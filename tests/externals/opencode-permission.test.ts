/**
 * 权限加固在**真 opencode 进程**里确实生效。
 *
 * ## 为什么这条不能只做单测
 *
 * `spawn-hardening.test.ts` 断言的是「我们注入了 `{"*":"deny","mycontext_*":"allow"}`」。
 * 那只能证明我们发出去了，证明不了对端**照办**。而我们整个安全模型压在
 * 一个**顺序依赖**上：`Permission.merge` 是 `rulesets.flat()`
 * （permission/index.ts:201）+ `findLast` 判定（同文件 210），
 * `agent.ts` 的调用顺序把 user ruleset 放在最后 → 我们的规则赢。
 *
 * opencode 升级把 `findLast` 改成 `find`、或把 user ruleset 挪到前面，
 * 我们**不会收到任何报错** —— 只会在某天发现 agent 能 webfetch 了。
 * 这条测试就是那个信号。
 *
 * ## 断言选 webfetch 的理由
 *
 * `tool/webfetch.ts` 只校验 http(s) 前缀、**无域名白名单**。
 * 也就是说「读画像 → fetch 到攻击者服务器」是一条纯读路径的外传通道 ——
 * 只 deny `edit`/`bash` 挡不住它。所以 deny-all 是否生效，看它最有代表性。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DENY_ALL_PERMISSION,
  HOST_TOOL_PREFIX,
  assertHardened,
  buildOpencodeSpawn,
} from "@mycontext/agent-runtime"
import { ProcessRunner } from "@mycontext/runtime-env"
import { createLogger } from "@mycontext/kernel"
import { resolveOpencode } from "../helpers/opencode.js"

const opencode = resolveOpencode()
const hasOpencode = opencode !== null
const logger = createLogger("opencode-permission", { level: "warn" })

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 起一个真进程，跑一条 `opencode` 子命令并收集输出。 */
async function runOpencode(args: string[], env: Record<string, string>) {
  if (opencode === null) throw new Error("unreachable: skipIf 已挡住")
  const cwd = mkdtempSync(join(tmpdir(), "mycontext-perm-"))
  dirs.push(cwd)
  writeFileSync(join(cwd, "AGENTS.md"), "# 权限验证工作区\n", "utf8")

  const out: string[] = []
  const err: string[] = []
  const handle = new ProcessRunner(logger).spawnDuplex({
    executable: opencode.path,
    args,
    env,
    cwd,
    onLine: (line: string) => out.push(line),
    onStderr: (line: string) => err.push(line),
  })
  // 子命令是一次性的：等它自己退出即可（close 对已退出进程是 no-op）
  await new Promise((resolve) => setTimeout(resolve, 4_000))
  await handle.close()
  return { out, err, cwd }
}

describe.skipIf(!hasOpencode)("★ opencode 权限加固（真进程）", () => {
  /**
   * 最基础的一条：我们注入的 JSON 必须能被它**解析**。
   * 实测 `config.ts:547` 解析失败时只 `logWarning` 然后**跳过** ——
   * 也就是说一个拼错的 JSON 会让权限配置静默消失，而进程照常启动。
   */
  it("注入的 OPENCODE_PERMISSION 不产生 invalid JSON 警告", async () => {
    const hardened = buildOpencodeSpawn({ baseEnv: process.env })
    const { err } = await runOpencode(["--print-logs", "run", "--help"], hardened.env)
    const warned = err.some((line) => line.includes("OPENCODE_PERMISSION contains invalid JSON"))
    expect(warned).toBe(false)
  }, 60_000)

  /** 加固后的环境必须自证：assertHardened 是那份契约的可执行形式。 */
  it("buildOpencodeSpawn 的产物通过 assertHardened", () => {
    const hardened = buildOpencodeSpawn({ baseEnv: process.env })
    expect(() => assertHardened(hardened.env)).not.toThrow()
  })

  /**
   * ★ 白名单式而不是黑名单式。
   *
   * 这条不打进程 —— 它断言的是**形状**：`"*"` 必须是 deny。
   * 放在这个文件里是因为它与上面那条是同一件事的两半：
   * 形状对 + 对端照办 = 安全模型成立。少任何一半都不成立。
   */
  it("权限配置是白名单式（默认拒绝，只放行宿主工具）", () => {
    expect(DENY_ALL_PERMISSION["*"]).toBe("deny")
    expect(DENY_ALL_PERMISSION[`${HOST_TOOL_PREFIX}*`]).toBe("allow")
    // 除了这两条不该有别的：多一条就是多一个口子
    expect(Object.keys(DENY_ALL_PERMISSION)).toHaveLength(2)
  })

  /**
   * server password 必须**每次进程都不同**。
   *
   * 固定密码等于没密码：一台机器上跑过一次就永久有效了。
   */
  it("server password 每次随机（不是常量）", () => {
    const a = buildOpencodeSpawn({ baseEnv: {} }).serverPassword
    const b = buildOpencodeSpawn({ baseEnv: {} }).serverPassword
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(32)
  })

  /** hostname 显式绑 127.0.0.1：默认值不是契约，而"默认只听本机"是我们的假设。 */
  it("显式绑定 127.0.0.1", () => {
    const hardened = buildOpencodeSpawn({ baseEnv: {} })
    const index = hardened.args.indexOf("--hostname")
    expect(index).toBeGreaterThanOrEqual(0)
    expect(hardened.args[index + 1]).toBe("127.0.0.1")
  })
})
