/**
 * 本人身份的**隔离与守卫**。
 *
 * ## 这个文件锁住的核心不变量
 *
 * 隔离维度是 `channel + corpId + userId`：先按渠道分（每个渠道一行身份），
 * 渠道内再由「组织 + 工号」确定是哪一个身份。
 *
 * ① **换了身份必须抛错，不能静默覆盖。** 首版是无条件
 *    `ON CONFLICT(channel_id) DO UPDATE` —— 重新授权到另一个组织/另一个人时
 *    直接覆盖，而库里已经躺着上一个身份采的会话。后果不是报错而是**判错**：
 *    `is_self` 拿新身份去判旧数据，「哪些是本人说的」整批错位，
 *    而那是蒸馏语料的唯一来源。实测踩到过：一个库里 39 个会话有 28 个属于
 *    组织 A，身份被覆盖成组织 B 之后 749 条消息被标成 `is_self=1`，全是错的。
 * ② **同一身份下刷新是正常的**（改花名、补第二个 openId），不能一起挡掉。
 * ③ **渠道之间互不影响** —— 接飞书时钉钉那行不该被碰。
 *
 * ## 为什么判据是 `(corpId, userId)` 而不是 openId
 *
 * openId 是**渠道专有形态**（钉钉一个 `openDingTalkId`，飞书三套
 * open_id/union_id/user_id，语义还不一样）。把它写进渠道无关的这一层，
 * 接下一个渠道时必须改这里。而「组织 + 组织内成员编号」是所有 IM 都有的
 * 概念，语义稳定。
 */
import { describe, expect, it } from "vitest"
import { SelfIdentityRepository } from "@mycontext/store"
import { isAppError } from "@mycontext/kernel"
import { openTestVault } from "../../helpers/vault.js"

const CHANNEL = "dingtalk"

/** 一个身份的基线。`corpId + userId` 是判据，其余字段是附属信息。 */
function identity(overrides: Partial<Parameters<SelfIdentityRepository["upsert"]>[0]> = {}) {
  return {
    channelId: CHANNEL,
    userId: "100001",
    openIds: [{ kind: "openDingTalkId", value: "D_AAA" }],
    displayNames: ["小王"],
    corpId: "corp-A",
    corpName: "组织A",
    ...overrides,
  }
}

describe("身份写入", () => {
  it("首次写入后能读回来", () => {
    const vault = openTestVault()
    try {
      const repo = new SelfIdentityRepository(vault.db)
      repo.upsert(identity())
      const stored = repo.get(CHANNEL)
      expect(stored?.userId).toBe("100001")
      expect(stored?.corpId).toBe("corp-A")
      // 解析出来 ≠ 用户确认过：confirmedAt 必须还是空
      expect(stored?.confirmedAt).toBeNull()
    } finally {
      vault.close()
    }
  })

  /**
   * ★ 同一身份下的刷新是**正常**的，不能被守卫挡掉。
   *
   * 花名会改、第二个 openId 可能后来才解析出来 —— 这些都不是"换了个人"。
   */
  it("★ 同一身份可以刷新花名与 openIds", () => {
    const vault = openTestVault()
    try {
      const repo = new SelfIdentityRepository(vault.db)
      repo.upsert(identity())
      expect(() =>
        repo.upsert(
          identity({
            displayNames: ["小王", "阿王"],
            openIds: [
              { kind: "openDingTalkId", value: "D_AAA" },
              { kind: "unionId", value: "D_BBB" },
            ],
          }),
        ),
      ).not.toThrow()

      const stored = repo.get(CHANNEL)
      expect(stored?.displayNames).toEqual(["小王", "阿王"])
      expect(stored?.openIds).toHaveLength(2)
    } finally {
      vault.close()
    }
  })
})

/**
 * ★★ 这一组是本文件的重点：换身份必须**硬失败**。
 *
 * 静默覆盖的代价不可逆 —— 两个人的语料混进同一份画像之后，
 * 没有任何信号能把它们分回去（而画像的结论会作为下一轮的基线继续放大）。
 */
describe("★★ 换身份必须抛 SELF_IDENTITY_CONFLICT", () => {
  it("换组织（corpId 变）→ 抛错且不覆盖", () => {
    const vault = openTestVault()
    try {
      const repo = new SelfIdentityRepository(vault.db)
      repo.upsert(identity())
      expect(() => repo.upsert(identity({ corpId: "corp-B", corpName: "组织B" }))).toThrow()
      // ★ 原来那行必须原样保留 —— 抛错却已经写坏了是最糟的情况
      expect(repo.get(CHANNEL)?.corpId).toBe("corp-A")
    } finally {
      vault.close()
    }
  })

  it("换工号（userId 变）→ 抛错且不覆盖", () => {
    const vault = openTestVault()
    try {
      const repo = new SelfIdentityRepository(vault.db)
      repo.upsert(identity())
      expect(() => repo.upsert(identity({ userId: "999999" }))).toThrow()
      expect(repo.get(CHANNEL)?.userId).toBe("100001")
    } finally {
      vault.close()
    }
  })

  it("错误码是 SELF_IDENTITY_CONFLICT 且不可重试（UI 要按码给出路）", () => {
    const vault = openTestVault()
    try {
      const repo = new SelfIdentityRepository(vault.db)
      repo.upsert(identity())
      try {
        repo.upsert(identity({ corpId: "corp-B" }))
        expect.unreachable("应该抛错")
      } catch (error) {
        expect(isAppError(error) && error.code).toBe("SELF_IDENTITY_CONFLICT")
        expect(isAppError(error) && error.retryable).toBe(false)
      }
    } finally {
      vault.close()
    }
  })

  /** context 里只记组织名与工号 —— openId 是标识符，不该进日志。 */
  it("★ 抛错时的 context 不含 openId", () => {
    const vault = openTestVault()
    try {
      const repo = new SelfIdentityRepository(vault.db)
      repo.upsert(identity())
      try {
        repo.upsert(identity({ corpId: "corp-B" }))
        expect.unreachable("应该抛错")
      } catch (error) {
        const context = JSON.stringify(isAppError(error) ? error.context : {})
        expect(context).not.toContain("D_AAA")
      }
    } finally {
      vault.close()
    }
  })

  /**
   * ★ 花名变了**不算**换身份 —— 否则用户改个花名就被锁死，
   * 而那与"两个人的语料混在一起"完全不是一回事。
   */
  it("★ 只有花名不同时不抛错", () => {
    const vault = openTestVault()
    try {
      const repo = new SelfIdentityRepository(vault.db)
      repo.upsert(identity())
      expect(() => repo.upsert(identity({ displayNames: ["完全不同的花名"] }))).not.toThrow()
    } finally {
      vault.close()
    }
  })
})

/**
 * ★ 先按渠道分：接飞书时钉钉那行不该被碰。
 *
 * 这条锁住"隔离的第一层是 channel" —— 两个渠道各自一行身份，
 * 各自独立地受上面那套守卫保护。
 */
describe("★ 渠道之间互不影响", () => {
  it("写飞书身份不影响钉钉那行", () => {
    const vault = openTestVault()
    try {
      const repo = new SelfIdentityRepository(vault.db)
      repo.upsert(identity())
      repo.upsert({
        channelId: "feishu",
        userId: "fs-1",
        openIds: [{ kind: "unionId", value: "on_xxx" }],
        displayNames: ["小王"],
        corpId: "corp-X",
        corpName: "飞书组织",
      })

      expect(repo.get(CHANNEL)?.corpId).toBe("corp-A")
      expect(repo.get("feishu")?.corpId).toBe("corp-X")
    } finally {
      vault.close()
    }
  })

  it("同一个人在两个渠道下工号不同也各自成立", () => {
    const vault = openTestVault()
    try {
      const repo = new SelfIdentityRepository(vault.db)
      repo.upsert(identity())
      // 飞书那边工号体系完全不同 —— 不该与钉钉那行比较
      expect(() =>
        repo.upsert({
          channelId: "feishu",
          userId: "ou_9f8e7d",
          openIds: [],
          displayNames: [],
          corpId: "corp-X",
          corpName: "飞书组织",
        }),
      ).not.toThrow()
    } finally {
      vault.close()
    }
  })
})
