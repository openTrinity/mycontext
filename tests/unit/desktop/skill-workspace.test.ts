/**
 * ★ kl skill 必须真的到达 agent —— 通过 opencode 的 `skills.paths` 配置。
 *
 * ## 为什么这条门禁必须存在
 *
 * skill 的链路有**四段**，断任何一段的表现都一样：「图谱查不了」，
 * 而且**都不报错**：
 *
 * ① `kl-graph/.claude/skills/kl/` —— 算法团队那份代码里有没有（`sync:kl-graph`）；
 * ② `apps/desktop/resources/skills/kl/` —— 同步到打包资源了没有（`sync:kl-skill`，
 *    已有 `check:kl-skill-sync` 守着）；
 * ③ **`SearchService` 起 opencode 时把资源目录塞进 `skills.paths`** ——
 *    这条门禁盯的正是它；
 * ④ opencode 从 `skills.paths` 扫 SKILL.md（是二进制的行为，我们信它但不测它）。
 *
 * ## 为什么不再是"拷进 cwd"
 *
 * 曾经的实现是每建一个 search / persona workspace 就 `cpSync` 一份 kl 过去。
 * 实测本机 61 个会话 = 61 份 kl 副本；蒸馏更新还要等下次 createAgent 才生效。
 * 现在走 opencode 的 `skills.paths` 直接指目录 —— **一处 skill，多处使用**。
 *
 * 这条测试**不启进程**：验的是"我们把配置构造对了"，opencode 是否真按
 * 配置扫描是二进制的行为（在 externals 端到端里覆盖）。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type { DuplexSpec, DuplexHandle, ResolvedBinary } from "@mycontext/runtime-env"
import { SearchService } from "@main/services/search.service.js"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000
const REPO_ROOT = resolve(import.meta.dirname, "../../..")
/** 真实的 skill 资源目录（`pnpm sync:kl-skill` 的落点）。 */
const SKILLS_RESOURCE = join(REPO_ROOT, "apps/desktop/resources/skills")

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-skill-"))
  dirs.push(dir)
  return dir
}

/**
 * 装个假 opencode：spawn 时把它收到的 env 记下来，不再实际读写。
 *
 * ★ 用真的 spawnDuplex 会去起 opencode，而这里锁的是**我们**怎么拼参数。
 */
function makeCapturingProcesses() {
  const captured: { env: Record<string, string> }[] = []
  const processes = {
    spawnDuplex: (spec: DuplexSpec): DuplexHandle => {
      captured.push({ env: { ...spec.env } })
      // 从不发消息、也不响应 —— 这些测试不推进到 acp 握手
      const handle: DuplexHandle = {
        async writeLine() {},
        async close() {},
        get alive() {
          return true
        },
        pid: 999,
      }
      return handle
    },
  } as unknown as ConstructorParameters<typeof SearchService>[0]["processes"]
  return { processes, captured }
}

function makeService(options: { skillsDir?: string; opencodePath?: string } = {}) {
  const vault = openTestVault()
  const workspaceRoot = tempDir()
  const { processes, captured } = makeCapturingProcesses()
  const resolved: ResolvedBinary = {
    name: "opencode",
    path: options.opencodePath ?? "/fake/opencode",
    platform: "darwin-arm64",
    source: "path",
  }
  const runtime = {
    tryResolveOpencode: () => resolved,
    // SearchService 现在走版本闸：给一个达标结果，否则 startAgent 会降级不 spawn。
    resolveUsableOpencode: () => ({ ok: true as const, binary: resolved, version: "1.18.11" }),
  } as unknown as ConstructorParameters<typeof SearchService>[0]["runtime"]
  const service = new SearchService({
    clock: new ManualClock(START),
    logger: createLogger("test-search", { level: "error" }),
    runtime,
    processes,
    workspaceRoot,
    ...(options.skillsDir === undefined ? {} : { skillsDir: options.skillsDir }),
    klRoot: "/fake/kl-graph",
    klPort: 8200,
    getWindow: () => null,
  })
  service.attach(vault.db)
  return { vault, service, workspaceRoot, captured }
}

describe("★ SearchService.create 不再 cpSync skill 到 cwd", () => {
  it("★★ 建会话时 `<cwd>/.opencode/skills/` 里**没有** kl 副本", () => {
    const { vault, service, workspaceRoot } = makeService({ skillsDir: SKILLS_RESOURCE })
    try {
      const session = service.create("上周的会议聊了什么")
      const cwd = join(workspaceRoot, "search", session.id)
      // 关键断言：这个曾经必须存在的路径，现在必须**不**存在
      // （若还存在，就说明 cpSync 那条路又被接回来了）
      expect(existsSync(join(cwd, ".opencode", "skills", "kl", "SKILL.md"))).toBe(false)
    } finally {
      vault.close()
    }
  })

  /**
   * 缺失是能力降级 —— 建会话仍然要成功。
   * 与旧行为一致：agent 有没有图谱能力不影响本地检索。
   */
  it("skillsDir 不存在时建会话仍成功（降级而不是崩）", () => {
    const { vault, service } = makeService({ skillsDir: join(tmpdir(), "definitely-not-here") })
    try {
      expect(() => service.create("查询")).not.toThrow()
    } finally {
      vault.close()
    }
  })

  it("完全不传 skillsDir 也不崩（可选依赖）", () => {
    const { vault, service } = makeService()
    try {
      expect(() => service.create("查询")).not.toThrow()
    } finally {
      vault.close()
    }
  })
})

describe("★ 起 opencode 时 `skills.paths` 里有 kl 资源目录", () => {
  it("★★ OPENCODE_CONFIG_CONTENT 的 skills.paths 包含 skillsDir", async () => {
    const { vault, service, captured } = makeService({ skillsDir: SKILLS_RESOURCE })
    try {
      // create() 只落库不起进程；起进程要走到 turn（会 await session/new 的响应）。
      // 这个测试不推进握手 —— 只要 spawnDuplex 被调过一次就有 captured。
      const session = service.create("查询")
      // 触发 turn（fake transport 不响应会超时 —— 但我们在此之前已经拿到 spawn 参数）
      const turnPromise = service.prompt(session.id, "查询").catch(() => undefined)
      // 等一个微任务让 startAgent 走到 spawnDuplex
      await new Promise((r) => setTimeout(r, 20))
      expect(captured.length).toBeGreaterThan(0)
      const env = captured[0]!.env
      expect(env["OPENCODE_CONFIG_CONTENT"]).toBeTruthy()
      const config = JSON.parse(env["OPENCODE_CONFIG_CONTENT"]!) as {
        skills?: { paths?: string[] }
      }
      // 关键断言
      expect(config.skills?.paths).toContain(SKILLS_RESOURCE)
      // 避免 hang：主动 fail-fast 让 promise 有机会走完
      await Promise.race([turnPromise, new Promise((r) => setTimeout(r, 50))])
    } finally {
      vault.close()
    }
  })
})

describe("★ skill 资源目录本身要是齐的（前两段链路）", () => {
  it("resources/skills/kl/SKILL.md 存在（pnpm sync:kl-skill 的产物）", () => {
    const path = join(SKILLS_RESOURCE, "kl", "SKILL.md")
    expect(
      existsSync(path),
      "缺 kl skill 资源 —— 跑 `pnpm sync:kl-skill`。不同步的表现是「图谱查不了」且无报错。",
    ).toBe(true)
  })

  it("skill 里有 kl 的命令说明（不是一个空壳）", () => {
    const text = readFileSync(join(SKILLS_RESOURCE, "kl", "SKILL.md"), "utf8")
    // 这几个是 agent 真正会用到的入口
    expect(text).toContain("kl ask")
    expect(text).toContain("kl search")
  })

  it("kl-graph/ 里有 skill 源（sync:kl-skill 的输入）", () => {
    const source = join(REPO_ROOT, "kl-graph/.claude/skills/kl/SKILL.md")
    expect(existsSync(source), `缺 kl-graph 里的 skill 源：${dirname(source)}`).toBe(true)
  })
})
