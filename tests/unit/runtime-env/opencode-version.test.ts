/**
 * opencode 版本闸的回归测试。
 *
 * ## 为什么这层必须测「版本」而不只是「存在」
 *
 * opencode 的 ACP 前端在 <1.2.23 上调本地 HTTP server 时**不带鉴权头**，
 * 而我们给那个 server 注入了随机 `OPENCODE_SERVER_PASSWORD`（安全加固，
 * 不注的话本机任意网页一个 fetch 就能驱动我们的 session）。于是低版本被
 * 自己的 basic auth 401 掉、`session/new` 报 -32603，ACP **一次都起不来**
 * ——实测同事机器上 1.2.15 就是这样。
 *
 * 所以"找得到"不等于"能用"：低版本找得到但用不了。这里锁住那道版本闸，
 * 且把版本探测做成可注入 —— 真机上装了什么不该决定测试能覆盖哪些分支。
 *
 * ## ★ 反证在最后一条
 *
 * 把门槛调到 `0.0.0`（等于关掉闸）时，"1.2.15 太老"那条**必须变绿**，
 * 从而证明前面那条红是版本闸真的在挡，而不是别的原因恰好返回了 false。
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  MIN_OPENCODE_VERSION,
  RuntimeEnv,
  parseSemver,
  semverGte,
  type OpencodeVersionProbe,
} from "@mycontext/runtime-env"

/** 当前平台的 bundled 文件名（与 prepare-bin / binaries.ts 同规则）。 */
function bundledName(): string {
  const arch = process.arch === "x64" ? "x64" : process.arch
  const suffix = `${process.platform}-${arch}`
  return process.platform === "win32" ? `opencode-${suffix}.exe` : `opencode-${suffix}`
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

/**
 * 造一个只有 bundled opencode 的 binDir，并把 env 清成不会命中 home/path 那几档
 * （否则本机真装了 opencode 会污染结果）。dws 那份不造 —— 这些用例不碰它。
 */
function makeEnv(withBundled: boolean): RuntimeEnv {
  const binDir = mkdtempSync(join(tmpdir(), "mycontext-oc-"))
  dirs.push(binDir)
  if (withBundled) {
    const p = join(binDir, bundledName())
    writeFileSync(p, "#!/bin/sh\necho stub\n")
    chmodSync(p, 0o755)
  }
  return new RuntimeEnv({
    binDir,
    dwsChannel: "test",
    dwsConfigDir: "/tmp/mycontext-test-dws",
    // 清空 PATH + 指一个不存在的 HOME 语义：env 里不给 MYCONTEXT_OPENCODE_BIN，
    // PATH 空 → path 档不命中。home 档读的是 os.homedir()，测试机上可能真有
    // ~/.opencode —— 但只要 bundled 命中就轮不到它（bundled 最优先）。
    env: { PATH: "" },
  })
}

/** 固定返回某个 stdout，不管问的是哪个二进制。 */
function probeReturning(raw: string | null): OpencodeVersionProbe {
  return () => raw
}

describe("semver 解析与比较", () => {
  it("从各种 stdout 形状里抠出三段版本", () => {
    expect(parseSemver("1.18.11")).toEqual([1, 18, 11])
    expect(parseSemver("OpenCode 1.2.23\n")).toEqual([1, 2, 23])
    expect(parseSemver("v1.2.15 (build abc)")).toEqual([1, 2, 15])
    expect(parseSemver("no version here")).toBeNull()
  })

  it("三段式比较：主次修订逐段比，不做字典序", () => {
    expect(semverGte([1, 18, 11], [1, 2, 23])).toBe(true) // 18 > 2，不能按字符串比
    expect(semverGte([1, 2, 23], [1, 2, 23])).toBe(true) // 相等算达标
    expect(semverGte([1, 2, 22], [1, 2, 23])).toBe(false)
    expect(semverGte([2, 0, 0], [1, 99, 99])).toBe(true)
  })
})

describe("★ opencode 版本闸", () => {
  /**
   * ★ 不测「找不到 → missing」这一条：`tryResolveOpencode` 的 home 档读的是
   * `os.homedir()`（真实进程 HOME，注入 env 改不了它），而开发机上普遍装了
   * `~/.opencode` —— 那条会非确定性地命中 home 档而不是 missing。
   * missing 只是 `binary === null` 的一行转发，风险极低；真正要锁的是**版本闸**
   * 的几档转换，它们用 `makeEnv(true)` 全确定。
   */
  it("1.2.15（同事那份）→ too_old，带上实测版本与门槛", () => {
    const r = makeEnv(true).resolveUsableOpencode(probeReturning("1.2.15"))
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === "too_old") {
      expect(r.found).toBe("1.2.15")
      expect(r.required).toBe(MIN_OPENCODE_VERSION)
    } else {
      throw new Error(`期望 too_old，实际 ${JSON.stringify(r)}`)
    }
  })

  it("1.2.23（门槛那一版）→ ok", () => {
    const r = makeEnv(true).resolveUsableOpencode(probeReturning("1.2.23"))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.version).toBe("1.2.23")
  })

  it("1.18.11（我们钉的版本）→ ok，且来源是 bundled", () => {
    const r = makeEnv(true).resolveUsableOpencode(probeReturning("OpenCode 1.18.11"))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.version).toBe("1.18.11")
      expect(r.binary.source).toBe("bundled")
    }
  })

  it("版本读不出来 → unreadable_version（fail closed，不信任它的 ACP）", () => {
    const r = makeEnv(true).resolveUsableOpencode(probeReturning(null))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("unreadable_version")

    const garbage = makeEnv(true).resolveUsableOpencode(probeReturning("not a version"))
    expect(garbage.ok).toBe(false)
    if (!garbage.ok) expect(garbage.reason).toBe("unreadable_version")
  })

  it("bundled 档优先于 env/home/path（不受用户本机那份影响）", () => {
    // 造一个 bundled，同时给一个指向别处的 MYCONTEXT_OPENCODE_BIN。
    const binDir = mkdtempSync(join(tmpdir(), "mycontext-oc-"))
    const other = mkdtempSync(join(tmpdir(), "mycontext-oc-other-"))
    dirs.push(binDir, other)
    const bundled = join(binDir, bundledName())
    writeFileSync(bundled, "#!/bin/sh\n")
    chmodSync(bundled, 0o755)
    const envBin = join(other, "opencode")
    writeFileSync(envBin, "#!/bin/sh\n")
    chmodSync(envBin, 0o755)

    const runtime = new RuntimeEnv({
      binDir,
      dwsChannel: "test",
      dwsConfigDir: "/tmp/mycontext-test-dws",
      env: { PATH: "", MYCONTEXT_OPENCODE_BIN: envBin },
    })
    const resolved = runtime.tryResolveOpencode()
    expect(resolved?.source).toBe("bundled")
    expect(resolved?.path).toBe(bundled)
  })
})

/**
 * ★★ 反证：门槛调到 0.0.0（等于关闸）时，"1.2.15 太老"必须翻成 ok。
 *
 * 不测这条，前面那条 too_old 的红就可能是别的原因（探针返回 null、
 * 解析失败……）恰好也 false —— 而不是版本闸真的在挡。
 * 这里直接用 `semverGte` 复算门槛逻辑，证明判据本身随门槛翻转。
 */
describe("反证：门槛翻转", () => {
  it("门槛降到 0.0.0 时 1.2.15 达标（证明前面的红是版本闸在挡）", () => {
    const found = parseSemver("1.2.15")!
    expect(semverGte(found, parseSemver(MIN_OPENCODE_VERSION)!)).toBe(false)
    expect(semverGte(found, [0, 0, 0])).toBe(true)
  })
})
