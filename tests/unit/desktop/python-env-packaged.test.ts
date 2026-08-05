/**
 * `scripts/lib/python-env.mjs` 的**打包态**行为：不建 venv、不写盘。
 *
 * ## 这条测试防的是一个已经发生过的故障
 *
 * 打包时 `build-python-bundle.mjs` 把 venv 的 site-packages 压平进解释器自己
 * 那份，产物里**只有 `python/`、没有 `venv/`**（理由见那个脚本的头注释：
 * venv 的 `pyvenv.cfg` 里 `home =` 绑死构建机，而修它意味着往 .app 内部写文件）。
 *
 * 而 `isPythonEnvReady` 原来的判据是「`venv/bin/python` 在 + `.mycontext-deps`
 * marker 对」—— 压平态两者都不存在，于是判「没就绪」→ `ensurePythonEnv` 去
 * **建 venv 并联网 pip install**。实测抓到过（打包好的 app 首次启动）：
 *
 * ```
 * 07:58:33 Main:Python | preparing python environment (first run downloads ~24MB…)
 * 07:58:33 Main:Python | setup-python: 创建共用 Python venv…
 * 07:58:35 Main:Python | setup-python: 安装 Python 依赖（首次约 1 分钟、需出网）…
 * ```
 * 而 `.app/Contents/Resources/vendor/python/darwin-arm64/` 里真的多出了 `venv/`。
 *
 * 用户机器上这会以两种方式失败：没网时装不上；`.app` 只读时（Gatekeeper
 * translocation）连目录都建不了。而它**不报错**，只是 kl 永远起不来。
 *
 * ## 为什么用真文件而不是 mock
 *
 * 判据是「磁盘上有没有那个布局」—— mock 掉 `existsSync` 之后测的就只是我们
 * 自己写的 if/else，而真实故障恰恰出在「布局长什么样」这件事上。所以这里在
 * tmpdir 里铺出两种真实布局（压平态 / venv 态）来跑。
 *
 * 不需要真解释器：这几个函数都只做路径判断与字符串拼接，不执行 Python。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * 被测模块是 `.mjs`（与 `pnpm setup:python` 共用同一份实现，刻意不在 TS 侧
 * 重写 —— 两份实现迟早漂移）。vitest 能直接 import 它。
 */
const mod = await import("../../../scripts/lib/python-env.mjs")

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

/** 当前平台的 `vendor/python/<platform>` 段（与 python-runtime.mjs 同规则）。 */
function platformSeg(): string {
  const arch = process.arch === "x64" ? "x64" : process.arch
  return `${process.platform}-${arch}`
}

/**
 * 目录树快照：相对路径 → 内容。用来断言"这次调用没写盘"。
 *
 * 比 mtime 更可靠 —— mtime 的精度在某些文件系统上是秒级，
 * 而测试跑得比那快，改了也可能看不出来。
 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix === "" ? name : `${prefix}/${name}`
      if (statSync(full).isDirectory()) walk(full, rel)
      else out[rel] = readFileSync(full, "utf8")
    }
  }
  walk(root, "")
  return out
}

/**
 * 铺出**压平态**（打包态）布局：解释器 + 依赖装在它自己的 site-packages。
 *
 * `qdrant_client` 是探针 —— kl 的核心依赖（`kl_server.py` 顶部就 import 它），
 * 缺了它这套环境无论如何跑不起来，所以拿它当"依赖装好了"的判据。
 */
function makeFlattened(): string {
  const root = mkdtempSync(join(tmpdir(), "mycontext-pyflat-"))
  dirs.push(root)
  const py = join(root, "vendor", "python", platformSeg(), "python")
  const bin = process.platform === "win32" ? py : join(py, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, process.platform === "win32" ? "python.exe" : "python3"), "")
  const sp = join(py, "lib", "python3.12", "site-packages", "qdrant_client")
  mkdirSync(sp, { recursive: true })
  return root
}

/** 铺出**只有 base 解释器**的布局（site-packages 里只有 pip —— 开发态首次）。 */
function makeBaseOnly(): string {
  const root = mkdtempSync(join(tmpdir(), "mycontext-pybase-"))
  dirs.push(root)
  const py = join(root, "vendor", "python", platformSeg(), "python")
  const bin = process.platform === "win32" ? py : join(py, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, process.platform === "win32" ? "python.exe" : "python3"), "")
  mkdirSync(join(py, "lib", "python3.12", "site-packages", "pip"), { recursive: true })
  return root
}

describe("★★ 打包态（压平的自包含解释器）", () => {
  /**
   * ★★ 最重要的一条：压平态必须判「已就绪」。
   *
   * 判 false 的后果就是那个真实故障 —— 在 .app 里建 venv + 联网装依赖。
   */
  it("★★ 有压平解释器 → isPythonEnvReady 为 true（否则会去建 venv + 联网）", () => {
    expect(mod.isPythonEnvReady(makeFlattened())).toBe(true)
  })

  it("★★ ensurePythonEnv 直接返回那个解释器，不建 venv", async () => {
    const root = makeFlattened()
    const logs: string[] = []
    const python = await mod.ensurePythonEnv(root, (m: string) => logs.push(m))
    expect(python).toContain(join("python", process.platform === "win32" ? "" : "bin"))
    // ★ 反证：一句准备日志都不该有（有就说明它开始装东西了）
    expect(logs).toEqual([])
  })

  /**
   * ★ `relocateVenv` 在打包态**绝不能写盘**：往 .app 内部写会破坏代码签名，
   * 而 Gatekeeper 隔离时那是只读路径。
   */
  it("★ relocateVenv 返回 false（压平态没有 pyvenv.cfg 要改）", () => {
    expect(mod.relocateVenv(makeFlattened())).toBe(false)
  })

  /**
   * ★★ 压平态 `relocateVenv` **一个字节都不能写** —— 断言"没改过任何文件"，
   * 而不只是断言返回 false。
   *
   * 上面那条只看返回值，而这个函数里现在还有 `rewriteVenvScripts`
   * （重写 bin 下 21 个 console-script 的 shebang + 3 个 activate）。
   * 它靠 `hasFlattenedPython` 的提前 return 挡住 —— 一旦有人把新逻辑加在
   * 那个 return **之前**，返回值仍然是 false，测试照样绿，而 .app 内部
   * 已经被写过了：代码签名失效，且 Gatekeeper 隔离时那是只读路径（直接抛）。
   *
   * 所以这里比对整棵目录树的 mtime + 内容快照。
   */
  it("★★ relocateVenv 在压平态不写盘（破坏签名 / 只读路径）", () => {
    const root = makeFlattened()
    // 铺一个 bin 目录（含带绝对路径的假 shebang）——若有人误改，这里会被动
    const fakeBin = join(root, "vendor", "python", platformSeg(), "venv", "bin")
    mkdirSync(fakeBin, { recursive: true })
    const script = join(fakeBin, "pip")
    writeFileSync(script, `#!/somewhere/else/vendor/python/${platformSeg()}/venv/bin/python3\n`)

    const before = snapshot(root)
    mod.relocateVenv(root)
    expect(snapshot(root)).toEqual(before)
  })

  /**
   * ★ 不设 `VIRTUAL_ENV`：那个变量的含义是"当前在某个 venv 里"，而压平态
   * 没有 venv。指向一个不存在的目录会让工具链困惑（pip 拿它当安装目标）。
   */
  it("★ venvEnv 不设 VIRTUAL_ENV，PATH 前插解释器 bin", () => {
    const root = makeFlattened()
    const env = mod.venvEnv(root, { PATH: "/usr/bin" }) as Record<string, string | undefined>
    expect(env["VIRTUAL_ENV"]).toBeUndefined()
    expect((env["PATH"] ?? "").split(process.platform === "win32" ? ";" : ":")[0]).toContain(
      "python",
    )
    // PYTHONHOME/PYTHONPATH 必须删掉而不是设空串（空串会让 CPython 起不来）
    expect("PYTHONHOME" in env).toBe(false)
    expect("PYTHONPATH" in env).toBe(false)
  })

  it("venvPython 指向压平解释器（不是 venv 里那个）", () => {
    const python = mod.venvPython(makeFlattened()) as string
    expect(python).not.toContain("venv")
    expect(python).toContain("python")
  })
})

/**
 * ★★ `installKlWrapper` 在压平态：**不能抛**，且要把 wrapper 放对地方。
 *
 * ## 这一组防的是一个已经发生过的假报警
 *
 * app 的启动路径（`python-env.ts` 的就绪分支）会无条件调 `installKlWrapper`。
 * 它原来往 `venv/bin/kl` 写 —— 而压平态**没有 venv 目录**，于是 ENOENT：
 *
 * ```
 * python environment preparation threw
 * {"detail":"ENOENT: … open '…/vendor/python/darwin-arm64/venv/bin/kl'"}
 * ```
 * 那句异常被上层 catch 成"环境不可用"，状态页显示
 * 「Python 环境没准备好（内置解释器下载失败或依赖装不上）。跑 `pnpm
 * setup:python`…」—— 而环境**完全健康**（同一份解释器手动跑起来，
 * 全部依赖可导入）。给出的建议在打包态也根本没法执行。
 *
 * ## 顺带修的第二件事：压平态原来根本没有裸 `kl`
 *
 * `venvEnv` 把解释器的 `bin/` 前插进 PATH，注释声称裸 `kl` 由此命中 ——
 * 但那个目录里**没有 kl**（打包实测 `ls .../python/bin | grep kl` 为空）。
 * 也就是搜索 agent 的 skill 里跑 `kl` 会 command not found，而 kl-server
 * 自己好得很（主进程用绝对路径 spawn）。这个不对称让它看起来像"检索坏了"。
 */
describe("★★ 打包态的 kl wrapper（installKlWrapper）", () => {
  /** 压平态布局 + 上游的 `kl_cli.py`（不在的话那个函数直接 return）。 */
  function flattenedWithKl(): string {
    const root = makeFlattened()
    mkdirSync(join(root, "kl-graph"), { recursive: true })
    writeFileSync(join(root, "kl-graph", "kl_cli.py"), "")
    return root
  }

  /** 解释器自己的 bin 目录（压平态 wrapper 该落的地方）。 */
  function flattenedBin(root: string): string {
    const py = join(root, "vendor", "python", platformSeg(), "python")
    return process.platform === "win32" ? py : join(py, "bin")
  }

  it("★★ 压平态调它不抛异常（抛了会被报成「环境没准备好」）", () => {
    const root = flattenedWithKl()
    // ★ 断言"不抛"而不是断言返回值：那句 ENOENT 正是假报警的来源
    expect(() => mod.installKlWrapper(root)).not.toThrow()
  })

  it("★★ wrapper 落在解释器自己的 bin 里（不是不存在的 venv/bin）", () => {
    const root = flattenedWithKl()
    mod.installKlWrapper(root)
    // 压平态没有 venv，所以那条路径下什么都不该有
    expect(existsSync(join(root, "vendor", "python", platformSeg(), "venv"))).toBe(false)
    if (process.platform === "win32") return // Windows 还没有压平态产物
    const wrapper = join(flattenedBin(root), "kl")
    expect(existsSync(wrapper)).toBe(true)
    const content = readFileSync(wrapper, "utf8")
    // 指向压平解释器与 kl 代码根 —— 两条都错的话 wrapper 在也没用
    expect(content).toContain(join(root, "kl-graph"))
    expect(content).toContain("kl_cli.py")
    // ★ exec 的解释器不能是 venv 里那条路径（压平态没有 venv）。
    // 判 exec 那一行而不是整个文件：注释里就写着"没有 venv"这几个字。
    const execLine = content.split("\n").find((l) => l.startsWith("exec ")) ?? ""
    expect(execLine).toContain(join("python", "bin", "python3"))
    expect(execLine).not.toContain(`${platformSeg()}/venv`)
  })

  it("★ 那个 bin 目录已在 venvEnv 的 PATH 首段（于是裸 kl 命中它）", () => {
    if (process.platform === "win32") return
    const root = flattenedWithKl()
    mod.installKlWrapper(root)
    const env = mod.venvEnv(root, { PATH: "/usr/bin" }) as Record<string, string | undefined>
    // ★ 这一条把两件事锁在一起：wrapper 写在哪、PATH 前插的是哪
    // （分开写的话任一边改了都不会红，而那正是原来那个"空话注释"的成因）
    expect((env["PATH"] ?? "").split(":")[0]).toBe(flattenedBin(root))
  })

  it("★ 幂等：内容一样时不重写（别每次启动都动 .app 里的文件）", () => {
    if (process.platform === "win32") return
    const root = flattenedWithKl()
    mod.installKlWrapper(root)
    const before = snapshot(root)
    mod.installKlWrapper(root)
    expect(snapshot(root)).toEqual(before)
  })

  /**
   * ★ 只读时也不能抛 —— Gatekeeper 隔离（translocation）会把 .app 挂到一个
   * 随机的只读路径。那时裸 `kl` 不可用是可接受的降级（kl-server 走绝对路径，
   * 完全不受影响），而报成"整个 Python 环境不可用"是错的。
   */
  it("★ 目标目录不可写 → 静默降级，不抛", () => {
    if (process.platform === "win32") return
    const root = flattenedWithKl()
    const bin = flattenedBin(root)
    chmodSync(bin, 0o500) // r-x：能进去、不能写
    try {
      expect(() => mod.installKlWrapper(root)).not.toThrow()
      expect(existsSync(join(bin, "kl"))).toBe(false)
    } finally {
      chmodSync(bin, 0o700) // 改回来，afterEach 才删得掉
    }
  })

  /**
   * ★ 反证：**开发态**（有 venv）的行为一个字都不能变 —— 那条路是日常在用的，
   * wrapper 必须仍然写进 `venv/bin`（那个目录在开发态的 PATH 首段）。
   */
  it("★ 反证：开发态（有 venv）仍写进 venv/bin", () => {
    if (process.platform === "win32") return
    const root = makeBaseOnly() // 没压平 → 走开发态分支
    mkdirSync(join(root, "kl-graph"), { recursive: true })
    writeFileSync(join(root, "kl-graph", "kl_cli.py"), "")
    const venvBin = join(root, "vendor", "python", platformSeg(), "venv", "bin")
    mkdirSync(venvBin, { recursive: true })

    mod.installKlWrapper(root)
    expect(existsSync(join(venvBin, "kl"))).toBe(true)
    // 压平态那个位置不该被写
    expect(existsSync(join(flattenedBin(root), "kl"))).toBe(false)
  })
})

describe("★ 反证：base 解释器不能被误判成压平态", () => {
  /**
   * ★ 开发态 `vendor/python/<plat>/python` 也存在 —— 那是**建 venv 用的基础
   * 解释器**，它的 site-packages 里只有 pip。
   *
   * 只判"解释器文件在"的话，开发态首次 setup 会被误判成"已就绪"，然后拿一个
   * 没装依赖的解释器去跑 kl（表现是 `ModuleNotFoundError: qdrant_client`）。
   * 所以判据必须包含"依赖真的在它自己的 site-packages 里"。
   */
  it("★ 只有 base 解释器（site-packages 里只有 pip）→ 不算就绪", () => {
    expect(mod.isPythonEnvReady(makeBaseOnly())).toBe(false)
  })

  it("★ 那时 venvPython 仍指向 venv 那条路径（开发态语义不变）", () => {
    expect(mod.venvPython(makeBaseOnly()) as string).toContain("venv")
  })

  it("★ 那时 venvEnv 仍设 VIRTUAL_ENV（开发态要激活 venv）", () => {
    const env = mod.venvEnv(makeBaseOnly(), { PATH: "/usr/bin" }) as Record<
      string,
      string | undefined
    >
    expect(env["VIRTUAL_ENV"]).toContain("venv")
  })
})
