/**
 * 内置 forge 引擎的完整性与可运行性。
 *
 * ## 为什么「文件在」不够
 *
 * forge 是随包分发的 **Python 源码**，由主进程 spawn 执行。它的失效方式与
 * 二进制不同：
 *
 *   · 少一个模块 → `ModuleNotFoundError`，只在真正跑蒸馏时才炸；
 *   · 上游升级后 `sources/__init__.py` 的注册表被覆盖 → `vault` 源消失，
 *     而它是本仓库加的，`rsync --delete` 不会删文件但会覆盖那张表；
 *   · 语法用了 3.10+ 的写法 → 在 macOS 自带的 3.9 上直接语法失败。
 *
 * 三者都不会被「文件存在」或 typecheck 发现，所以在这里**真的去 import**。
 */
import { existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { RuntimeEnv } from "@mycontext/runtime-env"

const root = resolve(import.meta.dirname, "../..")
const vendorForge = join(root, "vendor/forge")

/** 解析出的解释器；没有就跳过需要执行的断言（缺 Python 是预期状态）。 */
const python = new RuntimeEnv({
  binDir: join(root, "apps/desktop/resources/bin"),
  dwsChannel: "test",
  dwsConfigDir: "/tmp/mycontext-forge-test",
}).tryResolvePython()

/**
 * 跑 vendor/forge 里的 Python。
 *
 * ★ `-B` + `PYTHONDONTWRITEBYTECODE`：**不允许写 `__pycache__`**。
 *
 * 不加的话这个测试会把字节码缓存写进 vendor/forge/，而 `check:vendor-clean`
 * 明确禁止那个目录出现执行副产物 —— 于是 `pnpm verify` 里「测试」与「门禁」
 * 互相拆台：测试先跑并留下缓存，门禁随后必然失败。两个都是对的规则，
 * 冲突出在这里，所以修在这里。
 *
 * 两条同时给：`-B` 管这个进程，环境变量管它可能起的子进程
 * （`forge selftest` 会 spawn 自己）。
 */
function runForge(args: string[]) {
  return spawnSync(python!.path, ["-B", ...args], {
    cwd: vendorForge,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  })
}

describe("vendor/forge 的形状", () => {
  it("引擎入口与关键模块都在", () => {
    for (const rel of [
      "forge/__main__.py",
      "forge/analyze.py",
      "forge/decide.py",
      "forge/ingest.py",
      "forge/signals.json",
      "forge/sources/__init__.py",
      "forge/sources/vault.py",
      "forge/locales/zh-CN.json",
      "templates/persona/scripts/persona.py",
      "VERSION",
      "SHA256SUMS",
    ]) {
      expect(existsSync(join(vendorForge, rel)), `缺少 ${rel}`).toBe(true)
    }
  })

  it("VERSION 与 signals.json 的 rulesVersion 一致", () => {
    // 不一致意味着有人升级了引擎却没更新 VERSION —— 而 rulesVersion 会进
    // 派生数字的版本串，对不上就无法判断「这份画像是哪套规则算出来的」。
    const version = readFileSync(join(vendorForge, "VERSION"), "utf8").trim()
    const signals = JSON.parse(readFileSync(join(vendorForge, "forge/signals.json"), "utf8")) as {
      rulesVersion: string
    }
    expect(version).toBe(signals.rulesVersion)
  })

  it("字节码缓存不入 git（执行副产物）", () => {
    /**
     * 断言 **git 跟踪状态**而不是「盘上有没有」。
     *
     * 盘上必然会有：本文件下面那几条断言就要执行 forge，一执行就生成
     * `__pycache__`。若按存在性判断，这条测试的结果会取决于**测试执行顺序**
     * ——先跑它就绿、后跑就红。那种测试比没有更糟：它会被人加 `--no-cache`
     * 之类的办法「修」掉，而真正要防的事（缓存被提交进仓库）没人再看。
     *
     * `git ls-files` 只列被跟踪的文件，正好是 .gitignore 与
     * check:vendor-clean 两道防线要守住的那个集合。
     */
    const tracked = spawnSync("git", ["ls-files", "vendor/forge"], {
      cwd: root,
      encoding: "utf8",
    })
    // 不在 git 仓库里（如从 tarball 解出来跑测试）就跳过，而不是假绿。
    if (tracked.status !== 0) return
    const offenders = tracked.stdout
      .split("\n")
      .filter((line) => line.includes("__pycache__") || line.endsWith(".pyc"))
    expect(offenders, `这些执行副产物被 git 跟踪了：\n${offenders.join("\n")}`).toEqual([])
  })
})

describe.skipIf(python === null)("vendor/forge 真的能跑", () => {
  it("引擎可以被 import（少模块或语法不兼容会在这里暴露）", () => {
    const result = runForge([
      "-c",
      "from forge import analyze, decide, ingest, relations, store, compose, publish, report",
    ])
    expect(result.status, result.stderr).toBe(0)
  })

  it("vault 源仍然注册着（上游升级最容易覆盖掉的那张表）", () => {
    // `vault` 是本仓库加的源。上游改了 sources/__init__.py 的注册表后，
    // 表现是蒸馏报「unknown message source 'vault'」——而那已经是运行时了。
    const result = runForge(["-m", "forge", "sources"])
    expect(result.status, result.stderr).toBe(0)
    const payload = JSON.parse(result.stdout) as { sources: { kind: string }[] }
    expect(payload.sources.map((s) => s.kind)).toContain("vault")
  })

  it("vault 源声明自己不能发送、不能实时读", () => {
    // 声明成能发，persona 的 send 就会去找 PATH 上那个 dws ——
    // 而那个 CLI 登录的是**另一个人**，消息会真的发出去。
    const result = runForge([
      "-c",
      "import json;from forge.sources import get_source_class;" +
        "print(json.dumps(get_source_class('vault').static_capabilities()))",
    ])
    expect(result.status, result.stderr).toBe(0)
    const caps = JSON.parse(result.stdout) as Record<string, unknown>
    expect(caps["send"]).toBe(false)
    expect(caps["tail"]).toBe(false)
    // 反过来，@提及是真表查询，必须声明为有 —— 否则群里问到本人头上的消息
    // 会全部退化成按显示名在正文里猜。
    expect(caps["mentions"]).toBe(true)
  })

  /**
   * ★★ 画像目录名（slug）必须由「组织 + 成员」共同决定，不能只用成员 id。
   *
   * 成员 id 单独用**不能稳定标识一个人**：钉钉那个是**组织内工号**，
   * 同一个人在不同组织里工号不同，而不同的人在两个组织里工号可能相同。
   * 两个方向的错都在真实数据上出现过：
   * · 同一人换组织 → 工号变 → 语料被劈成两份画像；
   * · 两个不同的人 → 工号相同 → **撞进同一个 slug**，两人语料混一起。
   *
   * 后者不可逆：画像的结论会作为下一轮的基线继续放大。
   *
   * 哈希 `orgId + userId` 与应用侧的隔离键（channel + 组织 + 成员）对齐，
   * 一个画像目录才 1:1 对应一个身份。
   */
  it("★★ slug 由组织+成员共同决定（同工号不同组织不能撞）", () => {
    const result = runForge([
      "-c",
      "from forge.common import slug_from_self_id as s;" +
        // 同一个工号、两个不同组织 —— 必须是两个 slug
        "print(s('100001','org-A'));print(s('100001','org-B'))",
    ])
    expect(result.status, result.stderr).toBe(0)
    const [a, b] = result.stdout.trim().split("\n")
    expect(a).not.toBe(b)
    expect(a).toMatch(/^user-[0-9a-f]{10}$/)
  })

  it("★ 同一身份的 slug 稳定（否则每次蒸馏都换目录）", () => {
    const result = runForge([
      "-c",
      "from forge.common import slug_from_self_id as s;" +
        "print(s('100001','org-A'));print(s('100001','org-A'))",
    ])
    expect(result.status, result.stderr).toBe(0)
    const [a, b] = result.stdout.trim().split("\n")
    expect(a).toBe(b)
  })

  /**
   * ★ 没有组织维度的渠道（或 jsonl 源里操作者不知道组织）要能退回单参数 ——
   * 凭空编一个租户比缺一个维度更糟。
   */
  it("★ 组织为空时退回「只用成员 id」的旧行为", () => {
    const result = runForge([
      "-c",
      "from forge.common import slug_from_self_id as s;" +
        "print(s('100001'));print(s('100001',''))",
    ])
    expect(result.status, result.stderr).toBe(0)
    const [a, b] = result.stdout.trim().split("\n")
    expect(a).toBe(b)
  })

  /** vault 源要把组织 id 透出来（叫 orgId —— 渠道中立，不用某家的字段名）。 */
  it("★ vault 源的 identity 里有 orgId 字段", () => {
    const result = runForge([
      "-c",
      "import inspect;from forge.sources import vault;" +
        "print('orgId' in inspect.getsource(vault.VaultSource.identity))",
    ])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe("True")
  })

  it("解析出的解释器版本满足引擎要求", () => {
    expect(python).not.toBeNull()
    const result = runForge(["-c", "print('ok')"])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe("ok")
  })
})
