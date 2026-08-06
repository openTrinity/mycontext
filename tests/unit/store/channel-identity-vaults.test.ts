/**
 * 渠道身份 → vault 映射的隔离断言。
 *
 * ## 这一组锁的是"隔离维度"本身
 *
 * 隔离键从 `accountId` 改成 `(accountId, channelId, corpId, userId)`，
 * 而每一条断言对应一种**如果键选错了就会发生的真实后果**：
 *
 * · 同组织不同人共用一个 vault → 两个人的语料蒸进同一份画像（不可逆）；
 * · 不同渠道同 corpId 撞车 → 接飞书那天钉钉的数据被读成飞书的；
 * · 同一身份重复绑生成新 vault → 每次重新授权数据凭空一分为二；
 * · 一个 vault 被两个身份绑 → 就是"没隔离"，只是换了个入口。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ChannelIdentityVaultRepository,
  identityKeyString,
  openStore,
  parseIdentityKeyString,
  type ChannelIdentityKey,
  type StoreHandle,
} from "@mycontext/store"

let dir: string
let store: StoreHandle
let repository: ChannelIdentityVaultRepository

const ACCOUNT = "acct-1"
/** 组织 A 的两个人。★ 值全是编的（CLAUDE.md §1.2）。 */
const CORP_A = "dingFAKECORP0001"
const USER_A1 = "FAKEUSER0001"
const USER_A2 = "FAKEUSER0002"
const CORP_B = "dingFAKECORP0002"

function key(overrides: Partial<ChannelIdentityKey> = {}): ChannelIdentityKey {
  return {
    accountId: ACCOUNT,
    channelId: "dingtalk",
    corpId: CORP_A,
    userId: USER_A1,
    ...overrides,
  }
}

function bind(k: ChannelIdentityKey, vaultId: string, names?: { corp?: string; user?: string }) {
  repository.bind({
    ...k,
    vaultId,
    corpName: names?.corp ?? "组织甲",
    userName: names?.user ?? "张三",
    at: "2026-08-06T00:00:00.000Z",
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mycontext-identity-vaults-"))
  store = openStore({ path: join(dir, "control.sqlite") })
  repository = new ChannelIdentityVaultRepository(store.db)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("隔离维度是「渠道 + 组织 + 组织内的人」", () => {
  it("同一组织里的两个人是两个 vault", () => {
    bind(key({ userId: USER_A1 }), "vault-a1")
    bind(key({ userId: USER_A2 }), "vault-a2")

    expect(repository.find(key({ userId: USER_A1 }))?.vaultId).toBe("vault-a1")
    expect(repository.find(key({ userId: USER_A2 }))?.vaultId).toBe("vault-a2")
  })

  it("同一个人在两个组织里是两个 vault", () => {
    bind(key({ corpId: CORP_A }), "vault-a")
    bind(key({ corpId: CORP_B }), "vault-b")

    expect(repository.find(key({ corpId: CORP_A }))?.vaultId).toBe("vault-a")
    expect(repository.find(key({ corpId: CORP_B }))?.vaultId).toBe("vault-b")
  })

  /**
   * ★ 飞书位：`channel_id` 必须在键里。
   *
   * 不在的话，将来接飞书时一个恰好相同的 corpId 会让两个渠道的数据
   * 共用一个 vault —— 而那不会报错，只会让钉钉的会话出现在飞书的界面里。
   */
  it("不同渠道即使 corpId/userId 完全相同，也是两个 vault", () => {
    bind(key({ channelId: "dingtalk" }), "vault-dingtalk")
    bind(key({ channelId: "feishu" }), "vault-feishu")

    expect(repository.find(key({ channelId: "dingtalk" }))?.vaultId).toBe("vault-dingtalk")
    expect(repository.find(key({ channelId: "feishu" }))?.vaultId).toBe("vault-feishu")
  })

  it("不同账号的同一个渠道身份互不可见（本地登录仍是外层边界）", () => {
    bind(key({ accountId: "acct-1" }), "vault-1")
    expect(repository.find(key({ accountId: "acct-2" }))).toBeNull()
  })

  it("没绑过的身份返回 null，而不是抛错或给一个兜底 vault", () => {
    expect(repository.find(key())).toBeNull()
  })
})

describe("绑定是幂等的", () => {
  /**
   * ★ 重复绑不能产生第二个 vault。
   *
   * 每次重新授权都会走一遍绑定（那是对的：要刷新 last_used_at 与显示名）。
   * 若那时新建一个 vault，用户的数据会在每次重新授权后凭空一分为二 ——
   * 而旧那份仍在磁盘上占着，看起来就是"我的消息少了一半"。
   */
  it("同一个身份重复绑仍指向同一个 vault", () => {
    bind(key(), "vault-a")
    bind(key(), "vault-a")

    expect(repository.find(key())?.vaultId).toBe("vault-a")
    expect(repository.countByAccount(ACCOUNT)).toBe(1)
  })

  it("重复绑会刷新显示名（组织改名 / 改花名都该跟上）", () => {
    bind(key(), "vault-a", { corp: "组织甲", user: "张三" })
    bind(key(), "vault-a", { corp: "组织甲（新）", user: "小张" })

    const found = repository.find(key())
    expect(found?.corpName).toBe("组织甲（新）")
    expect(found?.userName).toBe("小张")
  })

  /**
   * ★★ 一个 vault 只能属于一个身份 —— 这是隔离的核心不变式。
   *
   * 静默改绑等于让两个身份的数据进同一个库。让它在这一层就抛，
   * 比等到写 `channel_self_identity` 时才被那道 fail-closed 守卫发现要早得多
   * —— 那时已经有消息落库了。
   */
  it("另一个身份绑到已被占用的 vault 会抛错，不静默改绑", () => {
    bind(key({ userId: USER_A1 }), "vault-shared")
    expect(() => bind(key({ userId: USER_A2 }), "vault-shared")).toThrow()

    // 抛错之后第一个身份的绑定必须完好（不是半写状态）
    expect(repository.find(key({ userId: USER_A1 }))?.vaultId).toBe("vault-shared")
    expect(repository.find(key({ userId: USER_A2 }))).toBeNull()
  })
})

describe("按 vaultId 反查（渠道命令钉住身份的起点）", () => {
  /**
   * ★ 挂载时只知道 vaultId，而钉住身份需要 `corpId:userId`。
   * 这条路断了的表现就是"钉不住" —— 渠道命令退回全局 profile，
   * 也就是修之前那个越权读取面。
   */
  it("能从 vaultId 反查出身份", () => {
    bind(key(), "vault-a")
    const found = repository.findByVaultId("vault-a")
    expect(found?.corpId).toBe(CORP_A)
    expect(found?.userId).toBe(USER_A1)
    expect(found?.channelId).toBe("dingtalk")
  })

  it("没绑过的 vault 反查返回 null（基础 vault 就是这个状态）", () => {
    expect(repository.findByVaultId("vault-never-bound")).toBeNull()
  })
})

describe("身份列表与最近使用", () => {
  it("按账号列出全部身份，可按渠道过滤", () => {
    bind(key({ channelId: "dingtalk", corpId: CORP_A }), "v1")
    bind(key({ channelId: "dingtalk", corpId: CORP_B }), "v2")
    bind(key({ channelId: "feishu", corpId: CORP_A }), "v3")

    expect(repository.listByAccount(ACCOUNT)).toHaveLength(3)
    expect(repository.listByAccount(ACCOUNT, "dingtalk")).toHaveLength(2)
    expect(repository.listByAccount(ACCOUNT, "feishu").map((r) => r.vaultId)).toEqual(["v3"])
  })

  it("最近用过的排在前面", () => {
    bind(key({ corpId: CORP_A }), "v-old")
    bind(key({ corpId: CORP_B }), "v-new")
    repository.markUsed(key({ corpId: CORP_A }), "2026-08-07T00:00:00.000Z")

    expect(repository.listByAccount(ACCOUNT).map((r) => r.vaultId)).toEqual(["v-old", "v-new"])
  })

  it("解绑只删映射行（vault 目录的删除必须显式做，不在这一层）", () => {
    bind(key(), "vault-a")
    repository.unbind(key())
    expect(repository.find(key())).toBeNull()
    expect(repository.countByAccount(ACCOUNT)).toBe(0)
  })
})

describe("身份键的字符串形态", () => {
  it("往返一致", () => {
    const k = key({ corpId: CORP_B, userId: USER_A2 })
    expect(parseIdentityKeyString(identityKeyString(k))).toEqual(k)
  })

  /**
   * ★ 分隔符不能是 `:` —— 那是渠道 CLI `--profile` 的语法分隔符。
   * 用同一个符号会诱使人把这个键原样当 profile 传下去，
   * 而它多带了 accountId 与 channelId 两段（传下去就是个不存在的组织）。
   */
  it("不用 `:` 做分隔（避免与渠道 profile 语法混用）", () => {
    expect(identityKeyString(key())).not.toContain(":")
  })

  it("段数不对时返回 null，不给一个半对的键", () => {
    expect(parseIdentityKeyString("a b c")).toBeNull()
    expect(parseIdentityKeyString("a b c d e")).toBeNull()
    expect(parseIdentityKeyString("a b  d")).toBeNull()
    expect(parseIdentityKeyString("")).toBeNull()
  })
})
