/**
 * 仓库卫生的回归测试。
 *
 * 这些断言防的都是**已经发生过或必然会发生**的事故：
 *   · `resources/bin/.dws/`（含真实 token）曾经躺在工作树里
 *   · 复制上游发布目录时一个 `cp -r` 就会把 4 个凭据 JSON 搬进 vendor
 *   · 21MB 二进制被替换成带后门的版本，code review 看不出来
 *
 * 关键是**断言根因而不只是现象**：不是「跑完 dws 没新增文件」（那只说明这次没触发），
 * 而是「相对路径的 dwsConfigDir 直接抛错」（那是唯一的触发条件）。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RuntimeEnv } from "@mycontext/runtime-env"
import { isAppError } from "@mycontext/kernel"

const root = resolve(import.meta.dirname, "../..")

function makeEnv(dwsConfigDir: string): RuntimeEnv {
  return new RuntimeEnv({
    binDir: join(root, "apps/desktop/resources/bin"),
    dwsChannel: "test",
    dwsConfigDir,
    env: { PATH: "" },
  })
}

describe("DWS 配置目录必须是绝对路径（凭据泄漏的根因）", () => {
  /**
   * 实测三组行为：
   *   ① 绝对路径 → 正确写入该目录，不碰 cwd
   *   ② 未设置   → 写 ~/.dws，也不碰 cwd
   *   ③ 相对路径 → **在 cwd 下**建 .dws/（凭据泄漏的唯一成因）
   * 所以正确的修法是在这里 fail-fast，而不是去改 cwd。
   */
  it.each([".dws", "", "relative/path", "./cfg"])(
    "相对路径或空串 %j 直接抛 CONFIG_INVALID",
    (value) => {
      const env = makeEnv(value)
      try {
        env.buildEnv()
        expect.unreachable("应当抛错")
      } catch (error) {
        expect(isAppError(error)).toBe(true)
        if (isAppError(error)) expect(error.code).toBe("CONFIG_INVALID")
      }
    },
  )

  it("绝对路径正常通过并注入 DWS_CONFIG_DIR", () => {
    const absolute = join(root, ".tmp-dws-config")
    const built = makeEnv(absolute).buildEnv()
    expect(built["DWS_CONFIG_DIR"]).toBe(absolute)
    expect(built["DWS_CHANNEL"]).toBe("test")
  })

  /**
   * ★★ 渠道号为空时**不注入**，否则会踩掉继承来的值。
   *
   * 开源发布缺省不带渠道号。无条件写 `DWS_CHANNEL: ""` 会把内部同学在 shell 里
   * export 的那个值覆盖成空串 —— 表现是"明明设了却不生效"，且完全静默。
   * 上游对空串与未设置等价，所以"不注入"对 dws 没有任何副作用。
   */
  it("★★ 渠道号为空时不覆盖继承来的 DWS_CHANNEL", () => {
    const absolute = join(root, ".tmp-dws-config")
    const built = new RuntimeEnv({
      binDir: join(root, "apps/desktop/resources/bin"),
      dwsChannel: "",
      dwsConfigDir: absolute,
      env: { DWS_CHANNEL: "inherited-from-shell", PATH: "/usr/bin" },
    }).buildEnv()
    expect(built["DWS_CHANNEL"]).toBe("inherited-from-shell")
  })

  /**
   * ★★ 自备 dws 优先，随包那份兜底。
   *
   * 随包分发的是开源版；闭源版由用户自己装好再指路径（UI 上填、落设置库）。
   * 两条断言分别对应「设了就用」与「设的失效就退回」——
   * 后者是关键：用户换机器 / 卸载闭源包之后，**静默退回随包版**
   * 比让渠道整个不可用好得多（后者表现是 onboarding 直接走不下去，
   * 而用户不知道是路径的问题）。
   */
  it("★★ dwsBinOverride 指向真实文件时优先于随包那份", () => {
    const custom = join(root, "package.json") // 只要是个真实存在的文件即可
    const resolved = new RuntimeEnv({
      binDir: join(root, "apps/desktop/resources/bin"),
      dwsChannel: "",
      dwsConfigDir: join(root, ".tmp-dws-config"),
      dwsBinOverride: custom,
    }).resolve("dws")
    expect(resolved.path).toBe(custom)
    expect(resolved.source).toBe("env")
  })

  it("★★ override 指向不存在的文件 → 退回随包那份（不是抛错）", () => {
    const resolved = new RuntimeEnv({
      binDir: join(root, "apps/desktop/resources/bin"),
      dwsChannel: "",
      dwsConfigDir: join(root, ".tmp-dws-config"),
      dwsBinOverride: "/nonexistent/definitely/not/here/dws",
    }).resolve("dws")
    expect(resolved.source).toBe("bundled")
    expect(resolved.path).toContain("resources/bin")
  })

  it("★ override 为空串/undefined 视为没设", () => {
    for (const override of ["", undefined]) {
      const resolved = new RuntimeEnv({
        binDir: join(root, "apps/desktop/resources/bin"),
        dwsChannel: "",
        dwsConfigDir: join(root, ".tmp-dws-config"),
        dwsBinOverride: override,
      }).resolve("dws")
      expect(resolved.source).toBe("bundled")
    }
  })

  it("★ 渠道号为空且外部也没有时，压根不出现这个键", () => {
    const absolute = join(root, ".tmp-dws-config")
    const built = new RuntimeEnv({
      binDir: join(root, "apps/desktop/resources/bin"),
      dwsChannel: "",
      dwsConfigDir: absolute,
      env: { PATH: "/usr/bin" },
    }).buildEnv()
    expect("DWS_CHANNEL" in built).toBe(false)
  })
})

describe("vendor 目录不得含凭据", () => {
  const vendorDir = join(root, "vendor")
  const FORBIDDEN = [".dws", "token.json", "identity.json", "profiles.json", "app-dev.json"]

  /**
   * 收集 vendor/ 下的所有名字。
   *
   * ★ 跳过 `venv/`：那是**本机运行时状态**（gitignore），由 pip 装进来的
   * 150+ 个第三方包。扫它只有假阳性 —— numpy 自带的测试数据是 `.pkl.gz`，
   * 撞"不存在压缩包"那条规则，而它是人家包的一部分、不是我们 cp 进来的冗余物。
   *
   * 本测试守的是「**入 git 的** vendor 内容里混进凭据/冗余归档」，
   * 一个不入 git、由包管理器生成的目录不在那个范围内。
   * 解释器本体（`python/<platform>/python`）仍然照扫 —— 它是入 git 的。
   */
  function collect(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out
    for (const entry of readdirSync(dir)) {
      if (entry === "venv") continue
      const full = join(dir, entry)
      out.push(entry)
      if (statSync(full).isDirectory()) collect(full, out)
    }
    return out
  }

  it("不存在 token/identity/profiles/.dws", () => {
    const names = new Set(collect(vendorDir))
    for (const forbidden of FORBIDDEN) {
      expect(names.has(forbidden), `vendor/ 下不应有 ${forbidden}`).toBe(false)
    }
  })

  it("不存在压缩包（与解压目录重复，且让 diff 更不可读）", () => {
    const archives = collect(vendorDir).filter((name) => /\.(zip|tar|tgz|gz)$/i.test(name))
    expect(archives).toEqual([])
  })

  it("内置二进制没有可执行位（防止有人直接运行它而把凭据写进 vendor）", () => {
    const binary = join(vendorDir, "dws/dws-darwin-arm64")
    if (!existsSync(binary)) return // 非 mac arm 的克隆可能没有这个文件
    const mode = statSync(binary).mode & 0o777
    expect(mode & 0o111, `期望 644，实际 ${mode.toString(8)}`).toBe(0)
  })
})

describe("opencode 缺失是预期状态而非异常", () => {
  /**
   * ★ binDir 用**空临时目录**，不是真的 resources/bin。
   *
   * `bundled` 档现在优先于 env/home/path（opencode 走 npm 依赖后，
   * prepare-bin 会把它拷进 resources/bin）。要测 env 逃生阀就必须避开
   * 那份 bundled，否则 bundled 永远赢、env 档测不到。
   */
  const tmpBins: string[] = []
  afterEach(() => {
    for (const d of tmpBins) rmSync(d, { recursive: true, force: true })
    tmpBins.length = 0
  })
  function emptyBinDir(): string {
    const d = mkdtempSync(join(tmpdir(), "mycontext-bin-"))
    tmpBins.push(d)
    return d
  }

  it("tryResolveOpencode 在找不到时返回 null（不抛错）", () => {
    // 空 binDir + 空 PATH + 不存在的显式路径 → 四档全落空（home 档可能真实存在）。
    const env = new RuntimeEnv({
      binDir: emptyBinDir(),
      dwsChannel: "test",
      dwsConfigDir: root,
      env: { PATH: "", MYCONTEXT_OPENCODE_BIN: join(root, "does-not-exist-opencode") },
    })
    // home 档可能真实存在（开发机装了 opencode），因此只断言"不抛错"。
    expect(() => env.tryResolveOpencode()).not.toThrow()
  })

  it("显式指定存在的文件时命中 env 档（binDir 无 bundled 时）", () => {
    // 用一个必然存在的文件冒充：解析层只校验「是文件」，不校验它是不是真的 opencode
    // （那是启动后 initialize 的事）。
    const anyFile = join(root, "package.json")
    const env = new RuntimeEnv({
      binDir: emptyBinDir(),
      dwsChannel: "test",
      dwsConfigDir: root,
      env: { PATH: "", MYCONTEXT_OPENCODE_BIN: anyFile },
    })
    const resolved = env.tryResolveOpencode()
    expect(resolved?.source).toBe("env")
    expect(resolved?.path).toBe(anyFile)
  })
})
