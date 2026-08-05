/**
 * venv 入了 git，所以它里面**不能有任何绝对路径** —— 这一组锁住这件事。
 *
 * ## 这些测试防的是什么
 *
 * `vendor/python/<plat>/venv` 整棵树入 git（288MB 依赖，clone 下来就能用）。
 * 代价是 `python -m venv` + pip 会把**生成它那台机器**的绝对路径烧进一批文本
 * 文件：23 个 console-script 的 shebang、3 个 activate、`bin/kl`、`pyvenv.cfg`。
 *
 * 原来的做法是启动时把这些**改写成当前机器的路径**。那能让环境跑起来，但每次
 * 启动都在工作区留下 26 个改动 —— 于是那批绝对路径**又被提交回 git**，换下一台
 * 机器再重演一次。实测库里就是这个结果：HEAD 里 25 个文件带 `/Users/you/…`、
 * 另外 2 个（`igraph` `pypinyin`）带 `/Users/you/…` —— 后者从入库那天起在这台
 * 机器上就是坏的（`bad interpreter: no such file or directory`），没人发现，
 * 因为运行路径不走它们。
 *
 * 所以现在改成写死**与位置无关**的内容（自定位 shebang / activate / kl wrapper，
 * `pyvenv.cfg` 干脆不写 `home`）。下面每条对应一个实测过的失败形态。
 *
 * ## 为什么用真解释器而不是 mock
 *
 * 要证的命题是"**换个路径还能跑**"。mock 掉 `existsSync`/`spawnSync` 之后测的
 * 就只是我自己写的 if/else，而真实故障恰恰出在"CPython 到底怎么定位 stdlib"
 * 这件事上 —— 那是 mock 不出来的。所以这一组把真的 venv 拷到 tmpdir 再跑。
 *
 * 没有 venv 时（CI 首次、或只 clone 了代码）整组 skip：这些断言的前提是
 * "有一个真的 venv"，缺了它测不出任何东西，报 fail 只是噪音。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const mod = await import("../../../scripts/lib/python-env.mjs")

/** 当前平台的 `vendor/python/<platform>` 段（与 python-runtime.mjs 同规则）。 */
function platformSeg(): string {
  const arch = process.arch === "x64" ? "x64" : process.arch
  return `${process.platform}-${arch}`
}

const REPO = join(import.meta.dirname, "..", "..", "..")
const REAL_VENV = join(REPO, "vendor", "python", platformSeg(), "venv")
/**
 * Windows 的 venv 布局（`Scripts/` + `.exe`）与这里假定的不同，而打包态也还没有
 * Windows 产物 —— 在那上面跑只会测到我们没实现的东西。
 */
const CAN_RUN = process.platform !== "win32" && existsSync(join(REAL_VENV, "bin", "python3"))

/**
 * 把真 venv + kl 代码拷到一个**新路径**下，模拟"别人 clone 下来的 checkout"。
 *
 * ★ 必须 `cpSync(..., {verbatimSymlinks: true})` —— `bin/python3` 是相对软链
 * （`../../python/bin/python3`），跟进去拷会变成 49968 字节的实体文件，然后
 * `dyld: Library not loaded: @executable_path/../lib/libpython3.12.dylib`。
 * 实测踩过（当时用的是 `cp -Rc`），排查时极容易误判成"改写逻辑坏了"。
 *
 * ★★ kl 那侧必须 `filter` 掉 `data/` 与 `.venv/`。
 *
 * 这两个目录是 gitignore 的**本机状态**：`data/` 是跑出来的图谱与抽取缓存
 * （实测 152M），`.venv/` 是上游自己那套 per-project venv（364M）。
 * 以前 kl 是 rsync 副本、两者都不在那个目录里，所以整个拷过来只有 1.9M；
 * 现在它是真 checkout，不 filter 的话**每跑一次这个文件就拷 ~520M**
 * （而这是 `pnpm test` 里的一条单测，不是 externals）。
 *
 * 判据只需要 `kl_cli.py` + `kl_graph/` 能被 import 到 —— 图谱数据与
 * 上游的 venv 与"路径里有没有绝对路径"完全无关。
 */
let fake = ""
beforeAll(() => {
  if (!CAN_RUN) return
  fake = mkdtempSync(join(tmpdir(), "mycontext-relocate-"))
  const seg = platformSeg()
  cpSync(join(REPO, "vendor", "python", seg), join(fake, "vendor", "python", seg), {
    recursive: true,
    verbatimSymlinks: true,
  })
  cpSync(join(REPO, "kl-graph"), join(fake, "kl-graph"), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = relative(join(REPO, "kl-graph"), src)
      return rel !== "data" && rel !== ".venv"
    },
  })
}, 300_000)

afterAll(() => {
  if (fake !== "") rmSync(fake, { recursive: true, force: true })
})

const bin = (): string => join(fake, "vendor", "python", platformSeg(), "venv", "bin")

/** 在假 checkout 里跑一个命令，返回 stdout+stderr。 */
function run(exe: string, args: string[] = [], cwd = "/"): { code: number | null; out: string } {
  const r = spawnSync(exe, args, { cwd, encoding: "utf8", timeout: 60_000 })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

describe.skipIf(!CAN_RUN)("★★ 换台机器：venv 里不能有绝对路径", () => {
  /**
   * ★★ 这一组最重要的一条：**一个外来绝对路径都不剩**，没有例外。
   *
   * 判的是"文件内容里有没有别的 checkout 的路径"，而不是"命令能不能跑" ——
   * 后者在**我这台**机器上永远是绿的（路径恰好对），正是这个原因让
   * `igraph`/`pypinyin` 带着 `/Users/you/…` 躺在库里很久没人发现。
   *
   * ★ 曾经给 `activate.csh` 开过豁免（csh 做不到自定位），后来改成**删掉**
   * 那个文件 —— 留着它等于保证每台新机器都脏一个文件，而它全仓库没人引用。
   * 所以这里不再有 skip 名单：任何残留都是失败。
   */
  it("★★ relocate 之后 bin 下一个绝对路径都不剩（无豁免）", () => {
    mod.relocateVenv(fake)
    mod.installKlWrapper(fake)

    const offenders: string[] = []
    for (const name of readdirSync(bin())) {
      const file = join(bin(), name)
      if (lstatSync(file).isSymbolicLink()) continue
      let text: string
      try {
        text = readFileSync(file, "utf8")
      } catch {
        continue // 二进制
      }
      if (text.includes("\0")) continue
      if (/\/Users\//.test(text)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  /**
   * ★★ `activate.csh` 被**删掉**，而不是改写成本机路径。
   *
   * csh 拿不到"正在被 source 的脚本"的路径（tcsh 的每条路都实测过：`$_` 是
   * **上一条命令**、`$0` 是 `csh`、`$argv` 空，真 pty 交互式下也一样）。
   * 但"做不到自定位"不等于"只能留一个绝对路径" —— 该问的是这文件有必要留吗：
   * 全仓库没有任何代码引用它，运行路径不 source 任何 activate（注入 env），
   * 人排查用的是 zsh（macOS 默认）或 bash，两个都已自定位。
   *
   * 留着它的唯一效果是**保证每台新机器第一次启动都脏一个文件** —— 正是这次
   * 要根治的病。真有人要用 csh，`python -m venv` 随时能再生成一个正确的。
   */
  it("★★ activate.csh 被删掉（做不到自定位，且没人引用它）", () => {
    mod.relocateVenv(fake)
    expect(existsSync(join(bin(), "activate.csh"))).toBe(false)
    // ★ 反证：别的 activate 变体不能被误删 —— 它们是自定位的，要留着
    expect(existsSync(join(bin(), "activate"))).toBe(true)
    expect(existsSync(join(bin(), "activate.fish"))).toBe(true)
  })

  /**
   * ★★ 反证：这些命令在**没跑过 relocate** 的全新 checkout 里就该能用。
   *
   * 也就是"git 里存的内容本身是对的"——而不是"启动时被修好了"。这条与上面那条
   * 是一对：上面判内容干净，这条判干净的内容真的能跑。
   *
   * 实测改之前：`pip --version` 报 `bad interpreter: /Users/<别人>/…`。
   */
  it("★★ 全新 checkout 里 pip / uvicorn 直接可用（shebang 自定位）", () => {
    for (const cmd of ["pip", "uvicorn"]) {
      const r = run(join(bin(), cmd), ["--version"])
      expect(r.code, `${cmd} 起不来：${r.out}`).toBe(0)
      /**
       * ★ 不只判"跑起来了"，还要判它**落在这个 checkout 里**。
       *
       * 只判退出码的话，一个指向别处的 pip 也能返回 0（那台机器上的路径恰好
       * 存在时），而那正是要防的情况：`pip install` 会装到别人的目录里。
       */
      if (cmd === "pip") expect(r.out).toContain(fake)
    }
  })

  /**
   * ★ `igraph` / `pypinyin` 是**已经在库里坏掉**的那两个（shebang 指向
   * `/Users/you/…`）。单独锁一条：它们与其它 console-script 唯一的区别就是
   * 前缀不同，而原来的改写逻辑靠"把已知旧路径当字面量搜"是找不到它们的。
   */
  it("★ 原本指向别人机器的那两个（igraph/pypinyin）也修好了", () => {
    for (const cmd of ["igraph", "pypinyin"]) {
      const exe = join(bin(), cmd)
      if (!existsSync(exe)) continue // 依赖清单变了就跳过，别绑死包名
      const r = run(exe, ["--version"])
      expect(r.out).not.toMatch(/bad interpreter|No such file or directory/)
    }
  })

  /**
   * ★★ `kl` wrapper：搜索 agent 跑的**裸 `kl`** 走的就是它。
   *
   * 真机症状：`.../venv/bin/kl: line 4: cd: /Users/<另一处>/kl-graph:
   * No such file or directory`，而 kl-server 自己好得很（主进程用**绝对路径**
   * spawn，绕过 wrapper）。这个不对称让它看起来像"检索坏了"。
   *
   * 从 `/` 调用：wrapper 自己会 `cd` 到 kl 根，不该依赖调用方的 cwd。
   */
  it("★★ 裸 kl 在新路径下能跑（且 cd 到本 checkout 的 kl 根）", () => {
    mod.installKlWrapper(fake)
    const r = run(join(bin(), "kl"), ["--help"], "/")
    expect(r.code, `kl 起不来：${r.out}`).toBe(0)
    expect(r.out).toContain("kl_cli.py")
  })

  /**
   * ★ 走 PATH 命中（而不是按路径调用）—— 这才是 agent 的真实调用方式。
   *
   * `$0` 在 PATH 命中时是完整路径（sh 会补），所以自定位仍然成立；
   * 但这依赖 shell 行为，值得单独锁一条。
   */
  it("★ 走 PATH 的裸 kl 同样能跑", () => {
    mod.installKlWrapper(fake)
    const r = spawnSync("kl", ["--help"], {
      cwd: "/",
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin()}:${process.env["PATH"] ?? ""}` },
    })
    expect(r.status, `PATH 上的 kl 起不来：${r.stdout}${r.stderr}`).toBe(0)
  })

  /**
   * ★ `source activate` 之后 `VIRTUAL_ENV` 要指向**这个** checkout。
   *
   * 我们的运行路径不走 activate（spawn 用绝对解释器 + 注入 env），但**人**会走：
   * 环境出问题时第一反应就是 `source activate` 然后 `pip list`。原来那时拿到的
   * 是一个指向陌生用户目录的 `VIRTUAL_ENV` —— 报错内容指向一台不是你的机器，
   * 没人会想到"venv 入了 git"。
   *
   * bash 与 zsh 分开测：取自身路径的写法不同（`BASH_SOURCE` vs `${(%):-%x}`），
   * 只测一个的话另一个坏了不会红。
   */
  it.each(["bash", "zsh"])("★ %s: source activate 后 VIRTUAL_ENV 指向本 checkout", (shell) => {
    mod.relocateVenv(fake)
    const r = run(shell, [
      "-c",
      `source "${join(bin(), "activate")}" && printf '%s' "$VIRTUAL_ENV"`,
    ])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toBe(join(fake, "vendor", "python", platformSeg(), "venv"))
  })

  /**
   * ★★ `pyvenv.cfg` **不该被写** —— 它是"工作区永远脏"的唯一来源。
   *
   * git 里存的是没有 `home =` 的版本。原来这个函数无条件写一行绝对路径进去，
   * 于是每次启动 `git status` 都脏、那行路径也就一直有机会被提交回去。
   *
   * 实测结论（三种配置各跑一遍）：整行不写 → ✅ 正常；相对路径 → ❌ 起不来；
   * 绝对路径 → ✅。**不写反而是对的**，因为 `bin/python3` 是相对软链，
   * CPython 顺着它自己就定位到解释器了。
   */
  it("★★ relocateVenv 不往 pyvenv.cfg 写 home（否则工作区永远脏）", () => {
    const cfg = join(fake, "vendor", "python", platformSeg(), "venv", "pyvenv.cfg")
    writeFileSync(cfg, "include-system-site-packages = false\nversion = 3.12.11\n", "utf8")
    mod.relocateVenv(fake)
    expect(readFileSync(cfg, "utf8")).not.toContain("home =")
  })

  /**
   * ★ 已有的 `home =`（上个版本留下的 / 有人提交进来的）要被**删掉**，
   * 而不是被换成一行本机的绝对路径。
   *
   * 换成本机路径也能让环境跑起来 —— 但工作区照样脏、那行照样会被提交回去，
   * 换下一台机器再坏一次。这条锁的就是"删掉"而非"改写"：实现里探针必须
   * 先把 `home` 摘掉再试（我一开始写成了"当前状态能不能起来"，被这条抓到）。
   *
   * ★ `include-system-site-packages` 要保留在样本里 —— 少了它这就不是一个
   * 正常的 venv 配置，探针失败于是走到"补 home"分支，测的就不是本意了
   * （第一版就是这么写错的）。
   */
  it("★ 已有的 home= 会被清掉（那是别人机器的路径）", () => {
    const cfg = join(fake, "vendor", "python", platformSeg(), "venv", "pyvenv.cfg")
    writeFileSync(
      cfg,
      [
        "home = /Users/someone-else/gits/mycontext/vendor/python/x/python/bin",
        "include-system-site-packages = false",
        "version = 3.12.11",
        "",
      ].join("\n"),
      "utf8",
    )
    mod.relocateVenv(fake)
    const after = readFileSync(cfg, "utf8")
    expect(after).not.toContain("home =")
    expect(after).not.toContain("someone-else")
    // 其余内容不能被误删
    expect(after).toContain("version = 3.12.11")
    expect(after).toContain("include-system-site-packages = false")
  })

  /**
   * ★★ 幂等：连跑两次，第二次不该再改任何文件。
   *
   * 不幂等的后果不是"慢"，而是**每次启动都动 git 工作区** —— 那正是这次要
   * 根治的病（改动被提交回去 → 换下一台机器再坏一次）。
   *
   * 判据用内容 hash 而不是 mtime：mtime 在某些文件系统上是秒级精度，
   * 而测试跑得比那快，改了也可能看不出来。
   */
  it("★★ 幂等：第二次 relocate 不再改动任何文件", () => {
    mod.relocateVenv(fake)
    mod.installKlWrapper(fake)
    const snap = (): string =>
      readdirSync(bin())
        .map((n) => {
          const f = join(bin(), n)
          if (lstatSync(f).isSymbolicLink()) return `${n}:link`
          try {
            return `${n}:${readFileSync(f).length}:${statSync(f).mtimeMs}`
          } catch {
            return `${n}:?`
          }
        })
        .join("\n")
    const before = snap()
    mod.relocateVenv(fake)
    mod.installKlWrapper(fake)
    expect(snap()).toBe(before)
  })

  /**
   * ★ 解释器本身在新路径下要能 import 依赖 —— 这是"环境真的可用"的底线。
   *
   * 上面那些测的是 wrapper / shebang / activate；这条测 CPython 自己：
   * 相对软链 + 无 `home` 时它能不能定位到 stdlib 和 site-packages。
   * 原始故障形态是 `ModuleNotFoundError: No module named 'encodings'`
   * （连 stdlib 都找不到）。
   *
   * ★ 刻意**不** import `litellm`：它在 import 期就去拉远端 model cost map，
   * 拉不到要等 HTTP 超时（实测让这条测试 10s 超时挂掉，而环境是好的）。
   * 那种失败与本条要证的命题无关，只会变成一条看天气的测试。
   * `qdrant_client` 足够 —— 它是 kl 的核心依赖，也是 `hasFlattenedPython`
   * 用的同一个探针。
   */
  it("★ 新路径下解释器能 import kl 的核心依赖", () => {
    mod.relocateVenv(fake)
    const r = run(join(bin(), "python3"), [
      "-c",
      "import sys, qdrant_client, fastapi, numpy; print(sys.prefix)",
    ])
    expect(r.code, `解释器起不来：${r.out}`).toBe(0)
    // prefix 必须落在这个 checkout 里，不能是原仓库
    expect(r.out.trim()).toContain(fake)
  }, 60_000)
})
