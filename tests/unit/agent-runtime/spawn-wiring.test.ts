/**
 * ★ 接线门禁：将来把 ACP 接进桌面端时，**必须**走加固后的 spawn。
 *
 * ## 为什么这个测试存在
 *
 * `buildOpencodeSpawn` 做三件不可回退的事（随机 server password、
 * deny-all 权限、显式 `--hostname 127.0.0.1`）。但**现在没有任何机制**
 * 保证未来接线的人会调它 —— 直接 `spawn("opencode", ["acp"])` 一样能跑通，
 * 而且跑起来完全正常：HTTP server 无鉴权、webfetch 放行、
 * 本机任意网页都能驱动这个「知道本人全部聊天记录」的 agent。
 *
 * 这属于典型的静默失效：功能可用，安全没了，没有任何红灯。
 * 所以用源码扫描做门禁 —— 出现 spawn opencode 的代码时，
 * 同一文件里必须能看到 `buildOpencodeSpawn`。
 *
 * ## 为什么扫源码而不是运行时断言
 *
 * 运行时断言要等代码被执行到才报错，而"接线"这件事恰恰发生在
 * 没有端到端测试覆盖的路径上（起真进程、连真 agent）。
 * 源码扫描在 `pnpm verify` 阶段就红，不依赖任何执行路径。
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { assertHardened, buildOpencodeSpawn } from "@mycontext/agent-runtime"

const root = resolve(import.meta.dirname, "../../..")
/** 扫描范围：桌面端主进程 + 各业务包（渲染进程起不了子进程）。 */
const SCAN_ROOTS = ["apps/desktop/src", "packages"]

/**
 * 认得出「起了一个进程」的调用。
 *
 * ★ `spawnDuplex` 必须在列表里 —— **那正是 ACP 的实际接线方式**
 * （见 tests/externals/acp-e2e.test.ts：`new ProcessRunner(logger).spawnDuplex({...})`）。
 * 首版正则是 `\b(spawn|...)\s*\(`，而 `\bspawn` 后面紧跟 `Duplex` 时
 * `\s*\(` 匹配不上 —— 于是真实接线形状返回 false，门禁形同虚设，
 * 而 README / M2-安全边界 / M2-搜索模块 / M2-数字人 四处都拿它当
 * 「未接线也安全」的依据。
 *
 * `spawn` 与 `spawnSync` / `spawnDuplex` 的关系提醒：不要用 `\bspawn\b`
 * 那类"整词"写法去省事 —— 新增一个 `spawnXxx` 变体时它同样会漏。
 * 这里的写法是显式列全 + 允许可选后缀。
 */
const SPAWN_CALLS =
  /\b(spawnDuplex|spawnSync|spawn|execFileSync|execFile|execSync|exec|fork|utilityProcess\.fork)\s*\(/

interface SourceFile {
  path: string
  text: string
}

function collectSources(): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      // 构建产物与依赖不算源码
      if (entry === "node_modules" || entry === ".tsbuild" || entry === "dist") continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry)) continue
      files.push({ path: relative(root, full), text: readFileSync(full, "utf8") })
    }
  }
  for (const scanRoot of SCAN_ROOTS) walk(resolve(root, scanRoot))
  return files
}

/**
 * 剔掉注释行 —— 注释里写 opencode / InlineKnnBackend 不是接线。
 *
 * 只按行首判定（`*` / `//` / `/*`）：这不是一个 TS 解析器，
 * 而"行尾注释里 spawn 了 opencode"这种写法不存在于真实代码里。
 * 宁可偶尔误判成"是接线"（那时人来看一眼），也不要漏掉真实接线。
 */
function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"))
    .join("\n")
}

/** 提到 opencode 的行里，剔掉注释 —— 注释里写 opencode 不是接线。 */
function mentionsOpencodeSpawn(text: string): boolean {
  const code = stripComments(text)
  if (!/opencode/i.test(code)) return false
  return SPAWN_CALLS.test(code)
}

describe("★ spawn opencode 必须经过 buildOpencodeSpawn", () => {
  /**
   * 门禁本体。
   *
   * 当前预期是「没有任何文件 spawn opencode」（ACP 尚未接线）。
   * 接线之后这条测试仍然有效：那个文件里必须出现 `buildOpencodeSpawn`，
   * 否则这里失败并指名道姓。
   */
  it("没有绕过加固的 opencode spawn", () => {
    const offenders = collectSources()
      .filter((file) => mentionsOpencodeSpawn(file.text))
      .filter((file) => !file.text.includes("buildOpencodeSpawn"))
      .map((file) => file.path)

    expect(
      offenders,
      `以下文件 spawn 了 opencode 但没走 buildOpencodeSpawn（会得到一个无鉴权、` +
        `webfetch 放行的 agent 进程）：\n${offenders.join("\n")}`,
    ).toEqual([])
  })

  /**
   * 扫描器自身的负例 —— 不测这条，扫描器写错了会静默"永远通过"。
   * 这是本文件唯一真正危险的失效模式：正则漏匹配与"仓库很干净"外观完全相同。
   */
  it("扫描器能识别出绕过加固的写法（否则门禁是空的）", () => {
    const bypass = `
      import { spawn } from "node:child_process"
      export const child = spawn("opencode", ["acp"])
    `
    expect(mentionsOpencodeSpawn(bypass)).toBe(true)
    expect(bypass.includes("buildOpencodeSpawn")).toBe(false)
  })

  /**
   * ★★ 最重要的一条负例：**ACP 的真实接线形状**。
   *
   * ACP 接的不是 `spawn()` 而是 `spawnDuplex()`（`spawn()` 硬编码
   * `stdin: "ignore"` 且必然超时，承载不了长连 —— 见 acp/client.ts）。
   * 首版的正则匹配不到 `spawnDuplex(`，于是这段真实代码返回 false，
   * 门禁在**唯一会真正发生的接线方式**上是空的。
   *
   * 现有的另一条负例只测了字面量 `spawn("opencode", ...)`，恰好绕过了这个洞 ——
   * 所以这条必须照抄 acp-e2e.test.ts 里的实际写法，包括
   * 「executable 来自一个变量而不是字面量 "opencode"」这个细节。
   */
  it("★ 扫描器认得 ACP 的真实接线形状（spawnDuplex + 变量 executable）", () => {
    const realShape = `
      import { ProcessRunner } from "@mycontext/runtime-env"
      const opencode = tryResolveOpencode()
      const transport = new ProcessRunner(logger).spawnDuplex({
        executable: opencode.path,
        args: ["acp"],
        env: process.env,
        onLine: (line: string) => client.handleLine(line),
      })
    `
    expect(mentionsOpencodeSpawn(realShape)).toBe(true)
    expect(realShape.includes("buildOpencodeSpawn")).toBe(false)
  })

  it("扫描器不把注释里的 opencode 当接线（否则门禁会误报）", () => {
    const commentOnly = `
      /**
       * 实测 opencode 的 acp 子命令会 spawn(...) 一个 HTTP server。
       */
      export const note = 1
    `
    expect(mentionsOpencodeSpawn(commentOnly)).toBe(false)
  })

  it("扫描器认得 execFile / utilityProcess.fork 等其它起进程方式", () => {
    for (const call of [
      'execFile("opencode", ["acp"])',
      'utilityProcess.fork("opencode")',
      'spawnSync("opencode", ["acp"])',
      // spawnDuplex 单独再钉一次：它是 ACP 的实际接线方式
      'runner.spawnDuplex({ executable: opencodePath, args: ["acp"] })',
    ]) {
      expect(mentionsOpencodeSpawn(`export const x = ${call}`), call).toBe(true)
    }
  })
})

/**
 * 接线时的正确用法示例，同时断言「加固产物确实能过 assertHardened」。
 *
 * 放在门禁文件里是刻意的：读到门禁失败的人，下一眼就该看到该怎么写。
 */
describe("接线的正确形状", () => {
  it("buildOpencodeSpawn 的产物满足 assertHardened", () => {
    const spawnSpec = buildOpencodeSpawn({ baseEnv: { PATH: "/usr/bin" } })
    expect(() => assertHardened(spawnSpec.env)).not.toThrow()
    // 参数里带显式 hostname（默认值不是契约）
    expect(spawnSpec.args).toContain("--hostname")
    expect(spawnSpec.args).toContain("127.0.0.1")
  })
})

/**
 * ★ 同形状的第二道门禁：`InlineKnnBackend` 不得出现在主进程。
 *
 * `retrieval/knn.ts` 的注释已经写明「直接在主进程调它会让 8 会话并发
 * 串行约 290ms」（实测 1024 维 5 万条单查询 = 35.7ms 纯 CPU 阻塞），
 * 但那只是注释 —— 没有任何机制阻止接线的人 `new InlineKnnBackend()`
 * 然后在主进程里 `await backend.search(...)`。
 *
 * 而这个错误的表现与 opencode 那条一样：**功能完全正常**，
 * 只是 IPC 停顿 + 采集延迟 + UI 掉帧，且没有任何红灯。
 * worker 化之后（`createWorkerKnnBackend`）这条门禁仍然有效：
 * 主进程该引用的是 worker 后端，不是 Inline 那个。
 */
describe("★ InlineKnnBackend 不得进主进程", () => {
  /** 只扫主进程目录：packages 里（含单测与 worker 实现）用它是正当的。 */
  const MAIN_PROCESS_ROOT = "apps/desktop/src/main"

  it("apps/desktop/src/main 下没有 InlineKnnBackend 的引用", () => {
    const offenders = collectSources()
      .filter((file) => file.path.startsWith(MAIN_PROCESS_ROOT))
      .filter((file) => /\bInlineKnnBackend\b/.test(stripComments(file.text)))
      .map((file) => file.path)

    expect(
      offenders,
      `以下主进程文件引用了 InlineKnnBackend（同步 KNN，实测 5 万条 35.7ms 纯 CPU 阻塞；` +
        `8 会话并发串行约 290ms → IPC 停顿 + 采集延迟 + UI 掉帧）：\n${offenders.join("\n")}\n` +
        `主进程应使用 worker 后端。`,
    ).toEqual([])
  })

  it("扫描器能识别出违规引用（否则门禁是空的）", () => {
    const violation = `
      import { InlineKnnBackend } from "@mycontext/retrieval"
      export const backend = new InlineKnnBackend()
    `
    expect(/\bInlineKnnBackend\b/.test(stripComments(violation))).toBe(true)
  })

  it("注释里提到 InlineKnnBackend 不算违规（否则门禁会误报）", () => {
    const commentOnly = `
      /** 接入前必须先 worker 化 —— 见 InlineKnnBackend 的注释。 */
      export const note = 1
    `
    expect(/\bInlineKnnBackend\b/.test(stripComments(commentOnly))).toBe(false)
  })
})
