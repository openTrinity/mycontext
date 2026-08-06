/**
 * 渠道配置目录的 seed —— 身份隔离的**主防线**。
 *
 * ## 为什么这一层比 `--profile` 强
 *
 * `--profile` 钉住是"我们记得传"：有三条独立的起进程路径，漏一处就是
 * 一次越权读取。而目录隔离是结构性的 —— 目录里只有这一个身份，
 * 拿另一个身份的 `--profile` 去问会直接
 * `organization "…" not found`（实测）。
 *
 * 两道一起上，与 `vault.ts` 文件头那条推理同构：隔离靠文件系统，
 * 不靠每处调用都自觉。
 *
 * ## ★ 实测前提（决定了这个函数写什么）
 *
 * ```
 * 全新空目录跑 auth status → authenticated=true，corp = 钥匙串里那个**全局 current**
 *   ⇒ 所以"建个空目录"不隔离，它会把要修的问题原样搬进新目录
 * 只 seed {corpId,userId,clientId} + 两个指针 → auth status 拿到完整 5 个必需字段
 *   ⇒ 所以 seed 很薄；组织名/真名/有效期由 CLI 自己从钥匙串补齐
 * ```
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedChannelProfile } from "@mycontext/channels"

/** ★ 值全是编的（CLAUDE.md §1.2）。形态照真实：corpId 是 ding+hex，userId 是数字串。 */
const CORP_A = "dingFAKECORP0001"
const USER_A = "100001"
const CORP_B = "dingFAKECORP0002"
const USER_B = "200002"

let dir: string
const file = () => join(dir, "profiles.json")
const read = () =>
  JSON.parse(readFileSync(file(), "utf8")) as {
    version: number
    primaryProfile: string
    currentProfile: string
    profiles: { corpId: string; userId: string; clientId?: string; corpName?: string }[]
  }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mycontext-dws-home-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("seed 出一个只认单个身份的目录", () => {
  it("写出 profiles.json，只有一个条目", () => {
    expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })).toBe(true)
    const parsed = read()
    expect(parsed.profiles).toHaveLength(1)
    expect(parsed.profiles[0]).toMatchObject({ corpId: CORP_A, userId: USER_A })
  })

  /**
   * ★★ 两个指针都必须指向这个身份。
   *
   * `currentProfile` 决定"不带 `--profile` 时按谁答"。只写 `primaryProfile`
   * 的话 CLI 仍按 current 那个答 —— 而那正是被修的那个 bug 的形态
   * （实测：primary=组织甲 而 current=组织乙，于是库里绑甲、读的是乙）。
   */
  it("★★ primaryProfile 与 currentProfile 都指向它（只写 primary 不够）", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    const parsed = read()
    const expected = `${CORP_A}:${USER_A}`
    expect(parsed.primaryProfile).toBe(expected)
    expect(parsed.currentProfile).toBe(expected)
  })

  /**
   * ★ 寻址形态是 `corpId:userId` —— 与 `--profile` 用的是同一种写法。
   * `userId` 只在企业内唯一，单独用它在多组织下会撞车。
   */
  it("指针形态是 corpId:userId", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    expect(read().currentProfile).toBe(`${CORP_A}:${USER_A}`)
  })

  it("clientId 给了就写、没给就不写（缺它 CLI 用默认值，仍能解析出身份）", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A, clientId: "fakeclientid0001" })
    expect(read().profiles[0]?.clientId).toBe("fakeclientid0001")

    rmSync(file())
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    expect(read().profiles[0]).not.toHaveProperty("clientId")
  })

  it("目录不存在时自己建（挂载新 vault 时它必然还不存在）", () => {
    const nested = join(dir, "channels", "dingtalk", "dws-home")
    expect(seedChannelProfile(nested, { corpId: CORP_A, userId: USER_A })).toBe(true)
    expect(
      JSON.parse(readFileSync(join(nested, "profiles.json"), "utf8")) as { profiles: unknown[] },
    ).toMatchObject({ profiles: [{ corpId: CORP_A }] })
  })

  /**
   * ★ 权限 600：文件里是身份标识（corpId/userId）。不是凭据（token 在钥匙串），
   * 但也没有任何理由让同机其他用户读到。
   */
  it("权限收紧到 600", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })
})

describe("幂等：内容已对就不重写", () => {
  /**
   * ★ 为什么必须幂等：每次挂载都会调它，而 CLI 可能正拿着那个文件。
   * 无谓的写入还会让"这个文件什么时候被改过"这条线索失真。
   */
  it("同一个身份第二次 seed 返回 false（没写）", () => {
    expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })).toBe(true)
    expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })).toBe(false)
  })

  /**
   * ★★ 判据只看我们关心的三件事，**不比整个文件**。
   *
   * CLI 会往里补 `corpName` / `status` / 时间戳等字段。逐字节比对会让每次
   * 挂载都判成"要重写"，于是把 CLI 自己补的东西反复擦掉 ——
   * 而那些字段正是 `auth status` 能给出完整信息的来源。
   */
  it("★★ CLI 补了别的字段之后仍判为已就绪（不擦掉它补的东西）", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    // 模拟 CLI 回填
    const enriched = read()
    const first = enriched.profiles[0]
    if (first !== undefined) {
      first.corpName = "组织甲"
      Object.assign(first, { status: "active", lastLoginAt: "2026-08-06T10:00:00+08:00" })
    }
    writeFileSync(file(), JSON.stringify(enriched, null, 2), "utf8")

    expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })).toBe(false)
    // 它补的字段还在
    expect(read().profiles[0]?.corpName).toBe("组织甲")
  })
})

describe("★★ 任何「不是恰好只有这一个身份」的状态都要被重写", () => {
  /**
   * 这一组是隔离的核心：下面每一种状态若被当成 OK，就是一次隔离失效。
   */
  it("换了身份 → 重写（切身份时必须真的换掉）", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    expect(seedChannelProfile(dir, { corpId: CORP_B, userId: USER_B })).toBe(true)
    const parsed = read()
    expect(parsed.profiles).toHaveLength(1)
    expect(parsed.profiles[0]?.corpId).toBe(CORP_B)
  })

  /**
   * ★★ 多了一个身份 → 必须重写。
   *
   * CLI 在这个目录里跑过 `auth login` 之后会把新登录的身份也加进来。
   * 不重写的话这个 vault 的目录里就有两个身份了 —— 结构性隔离当场失效，
   * 而症状是"切到 A 却读到 B 的会话"。
   */
  it("★★ 目录里多了一个身份 → 重写成只剩这一个", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    const parsed = read()
    parsed.profiles.push({ corpId: CORP_B, userId: USER_B })
    writeFileSync(file(), JSON.stringify(parsed, null, 2), "utf8")

    expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })).toBe(true)
    expect(read().profiles).toHaveLength(1)
    expect(read().profiles[0]?.corpId).toBe(CORP_A)
  })

  /**
   * ★★ 指针被改到别人身上 → 必须重写。
   *
   * 这是最隐蔽的一种：条目还是那一个，但 `currentProfile` 指向了别处
   * （CLI 的 `profile switch` 会这么干，实测 `--dry-run` 也会）。
   * 那时不带 `--profile` 的命令会按那个"别处"答。
   */
  it("★★ currentProfile 被指到别人 → 重写", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    const parsed = read()
    parsed.currentProfile = `${CORP_B}:${USER_B}`
    writeFileSync(file(), JSON.stringify(parsed, null, 2), "utf8")

    expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })).toBe(true)
    expect(read().currentProfile).toBe(`${CORP_A}:${USER_A}`)
  })

  it("primaryProfile 被指到别人 → 重写", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    const parsed = read()
    parsed.primaryProfile = `${CORP_B}:${USER_B}`
    writeFileSync(file(), JSON.stringify(parsed, null, 2), "utf8")
    expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })).toBe(true)
  })

  it("同组织不同人 → 重写（userId 才是企业内的判据）", () => {
    seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })
    expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_B })).toBe(true)
    expect(read().profiles[0]?.userId).toBe(USER_B)
  })

  it("文件坏了 / 不是 JSON / 是数组 → 重写（首次或需要修复，不是错误）", () => {
    mkdirSync(dir, { recursive: true })
    for (const bad of ["not json at all", "[]", "null", '{"profiles":"oops"}']) {
      writeFileSync(file(), bad, "utf8")
      expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })).toBe(true)
      expect(read().profiles).toHaveLength(1)
    }
  })

  it("profiles 为空数组 → 重写（空目录被 CLI 初始化过但没登录）", () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file(), JSON.stringify({ version: 1, profiles: [] }), "utf8")
    expect(seedChannelProfile(dir, { corpId: CORP_A, userId: USER_A })).toBe(true)
  })
})
