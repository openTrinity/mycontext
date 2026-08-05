/**
 * 用户身份：显示名兜底 + 头像来源判据。
 *
 * ## ★ 为什么「manual 永不被覆盖」必须有断言
 *
 * 渠道授权是个**周期性**动作（token 过期要重新授权）。如果回填规则写错，
 * 后果是"用户设的头像过几天自己变回渠道那张" —— 而这个过程：
 * · 没有任何报错；
 * · 用户不会盯着自己的头像等它变，往往过很久才发现；
 * · 发现后也很难联想到是"授权时被覆盖了"。
 *
 * 而正确的判据是 `avatar_source` 而**不是** `avatar_url` 是否为空 ——
 * 用户手动**清空**头像（"我就要首字母"）同样是一个选择，
 * 只看 url 会让下次授权把它填回来。这两条各有一个用例。
 */
import { describe, expect, it } from "vitest"
import { avatarInitial, avatarPaletteIndex } from "@mycontext/design"
import { resolveDisplayName } from "@mycontext/ipc-contract"
import { AccountRepository, openStore, CONTROL_MIGRATIONS } from "@mycontext/store"

function openControl() {
  const handle = openStore({ path: ":memory:", migrations: CONTROL_MIGRATIONS })
  const accounts = new AccountRepository(handle.db)
  accounts.create({
    id: "acc-1",
    vaultId: "vault-1",
    emailCanonical: "me@example.com",
    emailDisplay: "Me@Example.com",
    passwordHash: "h",
    salt: "s",
    hashParams: "p",
    createdAt: "2026-07-29T00:00:00.000Z",
  })
  return { handle, accounts }
}

describe("显示名兜底", () => {
  it.each([
    [{ displayName: "王强", email: "shen@example.com" }, "王强"],
    // 未设显示名 → 取 email 的 @ 前缀（不是整个 email：侧栏会把域名截断，
    // 而域名恰好是最没信息量的那部分）
    [{ displayName: null, email: "shen@example.com" }, "shen"],
    [{ displayName: "", email: "shen@example.com" }, "shen"],
    // 只有空白也算没设
    [{ displayName: "   ", email: "shen@example.com" }, "shen"],
    // 前后空格要 trim（用户粘贴时常带）
    [{ displayName: " 小王 ", email: "shen@example.com" }, "小王"],
  ])("%j → %s", (input, expected) => {
    expect(resolveDisplayName(input)).toBe(expected)
  })

  it("email 形态异常时不返回空串（宁可显示原值也不显示空白）", () => {
    expect(resolveDisplayName({ displayName: null, email: "@nolocal" })).toBe("@nolocal")
  })
})

describe("头像兜底：首字母与底色", () => {
  it("中文取第一个字（不转拼音 —— 用户认「王」比认「W」快）", () => {
    expect(avatarInitial("王强")).toBe("王")
  })

  it("英文取首字母并大写", () => {
    expect(avatarInitial("wang")).toBe("W")
  })

  it("空白 / 空串给 ?（不能渲染成空白圆圈）", () => {
    expect(avatarInitial("")).toBe("?")
    expect(avatarInitial("   ")).toBe("?")
  })

  it("★ emoji 不被截成半个代理对（否则渲染成乱码方块）", () => {
    // "👩‍💻" 是多码点组合字符：按 code unit 切会得到残缺代理对
    const initial = avatarInitial("👩‍💻 小王")
    expect(initial).not.toContain("�")
    expect(initial.length).toBeGreaterThan(0)
  })

  it("★★ 同一显示名底色稳定（随机会让人以为头像在闪/加载失败）", () => {
    const first = avatarPaletteIndex("王强")
    for (let round = 0; round < 20; round += 1) {
      expect(avatarPaletteIndex("王强")).toBe(first)
    }
  })

  it("不同名字会分散到不同底色（不是所有人一个颜色）", () => {
    const names = ["王强", "吴敏", "李明", "陈静", "赵磊", "徐亮", "朱琳"]
    const buckets = new Set(names.map((name) => avatarPaletteIndex(name)))
    // 7 个名字至少落到 3 个桶：全撞一个桶说明 hash 实际没在工作
    expect(buckets.size).toBeGreaterThanOrEqual(3)
  })
})

describe("★★ 头像来源：manual 永不被渠道覆盖", () => {
  it("首次授权可以填（source 为 null）", () => {
    const { handle, accounts } = openControl()
    try {
      const result = accounts.applyChannelProfile("acc-1", {
        displayName: "王强",
        avatarUrl: "https://example.invalid/channel.png",
      })
      expect(result.avatarWritten).toBe(true)
      const account = accounts.findById("acc-1")
      expect(account?.avatarUrl).toBe("https://example.invalid/channel.png")
      expect(account?.avatarSource).toBe("channel")
      expect(account?.displayName).toBe("王强")
    } finally {
      handle.close()
    }
  })

  it("同为 channel 来源时可以更新（换了工牌照）", () => {
    const { handle, accounts } = openControl()
    try {
      accounts.applyChannelProfile("acc-1", { avatarUrl: "https://example.invalid/old.png" })
      const result = accounts.applyChannelProfile("acc-1", {
        avatarUrl: "https://example.invalid/new.png",
      })
      expect(result.avatarWritten).toBe(true)
      expect(accounts.findById("acc-1")?.avatarUrl).toBe("https://example.invalid/new.png")
    } finally {
      handle.close()
    }
  })

  it("★ 用户手动设过之后，授权**不覆盖**", () => {
    const { handle, accounts } = openControl()
    try {
      accounts.updateProfile("acc-1", { avatarUrl: "https://example.invalid/mine.png" })
      expect(accounts.findById("acc-1")?.avatarSource).toBe("manual")

      const result = accounts.applyChannelProfile("acc-1", {
        avatarUrl: "https://example.invalid/channel.png",
      })
      expect(result.avatarWritten).toBe(false)
      // 还是用户那张
      expect(accounts.findById("acc-1")?.avatarUrl).toBe("https://example.invalid/mine.png")
    } finally {
      handle.close()
    }
  })

  /**
   * ★★ `manual` + **空值** 当成"没设过"，渠道可以填。
   *
   * ## 这一条与它的前身相反，理由记在这里
   *
   * 原来断言的是"手动清空之后渠道也不该填回来"（判据只看 `source`）。
   * 那条规则在真实数据上产生了一个死锁：实测本机两个账号里有一个是
   * `avatar_url=NULL, avatar_source='manual'`，于是渠道**永久**填不进去
   * —— 表现是"我自己的头像永远是首字母，点重新获取也没用"。
   *
   * 而那个状态**不是**用户"明确不要头像"的意思：设置页的保存按钮总是
   * 同时提交 `displayName` 与 `avatarUrl`，所以只改名字（头像框是空的）
   * 就会写下 `source='manual'` + NULL。它是改名字的副作用。
   *
   * 即便真是手动清空过：NULL 的头像与"没有头像"在**显示上完全一样**
   * （都是首字母兜底），所以填进去不覆盖任何用户能看见的选择。
   * 真要表达"就是不要头像"需要一个独立的布尔字段，而不是靠 NULL 的双重含义。
   *
   * 判据因此是「**有没有一张用户自己设的图**」，而不是「source 是不是 manual」。
   * 见 `AccountRepository.applyChannelProfile` 的注释。
   */
  it("★★ manual 但头像是空的 → 渠道可以填（那是改名字的副作用，不是「不要头像」）", () => {
    const { handle, accounts } = openControl()
    try {
      accounts.updateProfile("acc-1", { avatarUrl: null })
      const account = accounts.findById("acc-1")
      expect(account?.avatarUrl).toBeNull()
      // 清空同样被记成 manual —— 这一点没变
      expect(account?.avatarSource).toBe("manual")

      const result = accounts.applyChannelProfile("acc-1", {
        avatarUrl: "https://example.invalid/channel.png",
      })
      // ★ 与前身相反：空值时**要**填，否则那个账号永久没有头像
      expect(result.avatarWritten).toBe(true)
      expect(accounts.findById("acc-1")?.avatarUrl).toBe("https://example.invalid/channel.png")
    } finally {
      handle.close()
    }
  })

  it("显示名与头像分开判（改过名字仍能从渠道拿头像）", () => {
    const { handle, accounts } = openControl()
    try {
      accounts.updateProfile("acc-1", { displayName: "我的花名" })
      const result = accounts.applyChannelProfile("acc-1", {
        displayName: "王强",
        avatarUrl: "https://example.invalid/channel.png",
      })
      // 名字不覆盖（用户设的优先），但头像填进来了
      expect(result.displayNameWritten).toBe(false)
      expect(result.avatarWritten).toBe(true)
      expect(accounts.findById("acc-1")?.displayName).toBe("我的花名")
    } finally {
      handle.close()
    }
  })

  it("渠道没给头像时不写（当前钉钉就是这种情况）", () => {
    const { handle, accounts } = openControl()
    try {
      // 实测 DWS 的 get-self / search 都不返回头像 → 这是**真实**路径
      const result = accounts.applyChannelProfile("acc-1", { displayName: "王强" })
      expect(result.avatarWritten).toBe(false)
      const account = accounts.findById("acc-1")
      expect(account?.avatarUrl).toBeNull()
      // source 保持 null：没写过就不该标来源
      expect(account?.avatarSource).toBeNull()
      // 但名字填上了 —— 这是钉钉能给的那一半
      expect(account?.displayName).toBe("王强")
    } finally {
      handle.close()
    }
  })

  it("账号不存在时安全返回（不抛错）", () => {
    const { handle, accounts } = openControl()
    try {
      const result = accounts.applyChannelProfile("nope", { avatarUrl: "x" })
      expect(result).toEqual({ displayNameWritten: false, avatarWritten: false })
    } finally {
      handle.close()
    }
  })

  it("库里出现未知 source 时按「未设」处理（降级回滚/手改过的库）", () => {
    const { handle, accounts } = openControl()
    try {
      handle.db.prepare("UPDATE accounts SET avatar_source = 'weird' WHERE id = ?").run("acc-1")
      expect(accounts.findById("acc-1")?.avatarSource).toBeNull()
      // 未知值不等于 manual → 允许渠道填
      expect(
        accounts.applyChannelProfile("acc-1", { avatarUrl: "https://example.invalid/c.png" })
          .avatarWritten,
      ).toBe(true)
    } finally {
      handle.close()
    }
  })
})
