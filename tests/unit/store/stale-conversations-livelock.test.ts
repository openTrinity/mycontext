/**
 * 对账集合（`staleConversations`）不能造出一个**永不收敛**的补采队列。
 *
 * ## ★ 这里锁的是一个真实的活锁，不是理论风险
 *
 * 实测日志形态（连续三轮，每轮间隔 ~50 秒）：
 *
 * ```
 * reconciling stale {"staleCount":4, start:…, end:…}   ← 窗宽恒为 7.000 天
 * … 40 行 marked conversations unreadable …
 * reconciliation done {"staleCount":4, "pages":40, "recovered":0}
 * directed reconciliation done {"attempted":4, "recovered":0}
 * ```
 *
 * 烧满 `RECONCILE_MAX_PAGES`(40) 的预算、一条都没补回来，下一轮从同一起点重跑。
 * 真机数据（252 个会话）里那 4 个"落后"会话的构成是：
 * · 3 个已判定不可读（保密群）—— 服务端拒绝读，永远补不回来；
 * · 1 个 `last_msg_at = 0` 的毒丸行 —— 把对账窗口钉死在 7 天。
 * 也就是这个查询 75% 的产出是**结构性永远补不上**的噪音。
 *
 * 两条排除加上之后：4 → 1，窗口从「恒定 7 天 / 8131 条 / 82 页」塌缩到 ~1.5 小时。
 *
 * ## 为什么必须有测试守着
 *
 * 活锁的表现和"正常在补历史"**在日志上只差一个 `recovered` 的数字**。
 * 没有断言的话，下一次有人为了"多补一点"把排除条件去掉，
 * 症状会在几个月后以"应用一直在转但图谱不更新"的形式回来。
 */
import { describe, expect, it } from "vitest"
import { ConversationRepository, ProbeSnapshotRepository } from "@mycontext/store"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const CHANNEL = "dingtalk"
const NOW = new Date(2026, 7, 6, 20, 0, 0).getTime()

/** 建一个会话 + 它的探针快照。`oursLastMsgAt = null` 表示我们库里一条消息都没有。 */
function seed(
  vault: TestVault,
  input: {
    externalId: string
    probeLastMsgAt: number
    unreadable?: string
  },
): void {
  new ConversationRepository(vault.db).upsert({
    id: `conv_${input.externalId}`,
    channelId: CHANNEL,
    externalId: input.externalId,
    type: "group",
    title: null,
    lastMessageAt: input.probeLastMsgAt,
    createdAt: NOW,
  })
  if (input.unreadable !== undefined) {
    new ConversationRepository(vault.db).markUnreadable(
      CHANNEL,
      input.externalId,
      input.unreadable,
      NOW,
    )
  }
  new ProbeSnapshotRepository(vault.db).upsert({
    channelId: CHANNEL,
    conversationExternalId: input.externalId,
    lastMsgAt: input.probeLastMsgAt,
    unreadCount: 1,
    observedAt: NOW,
  })
}

describe("★ 对账集合排除结构性补不上的会话", () => {
  it("不可读会话（保密群）不进补采队列 —— 服务端拒绝就是拒绝", () => {
    const vault = openTestVault()
    // 库里一条消息都没有 + 探针说有更新 → 旧判据下必然入选
    seed(vault, { externalId: "cidFAKE0001==", probeLastMsgAt: NOW, unreadable: "confidential" })
    const stale = new ProbeSnapshotRepository(vault.db).staleConversations(CHANNEL)
    expect(stale).toEqual([])
    vault.close()
  })

  it("cross_org 同理（不是保密群才排除，是所有已判定不可读的）", () => {
    const vault = openTestVault()
    seed(vault, { externalId: "cidFAKE0002==", probeLastMsgAt: NOW, unreadable: "cross_org" })
    expect(new ProbeSnapshotRepository(vault.db).staleConversations(CHANNEL)).toEqual([])
    vault.close()
  })

  it("★ last_msg_at = 0 的毒丸行不入选 —— 它会把对账窗口钉死在 7 天", () => {
    const vault = openTestVault()
    seed(vault, { externalId: "cidFAKE0003==", probeLastMsgAt: 0 })
    expect(new ProbeSnapshotRepository(vault.db).staleConversations(CHANNEL)).toEqual([])
    vault.close()
  })

  it("负数时间戳同样是坏值（用 <= 0 而不是 = 0 判）", () => {
    const vault = openTestVault()
    seed(vault, { externalId: "cidFAKE0004==", probeLastMsgAt: -1 })
    expect(new ProbeSnapshotRepository(vault.db).staleConversations(CHANNEL)).toEqual([])
    vault.close()
  })

  it("★ 真正可读、真正落后的会话仍然报得出来（排除不能变成掩盖）", () => {
    const vault = openTestVault()
    seed(vault, { externalId: "cidFAKE0005==", probeLastMsgAt: NOW })
    const stale = new ProbeSnapshotRepository(vault.db).staleConversations(CHANNEL)
    expect(stale).toHaveLength(1)
    expect(stale[0]?.conversationExternalId).toBe("cidFAKE0005==")
    expect(stale[0]?.oursLastMsgAt).toBeNull()
    vault.close()
  })

  it("混合场景：3 个不可读 + 1 个毒丸 + 1 个真落后 → 只剩那 1 个（真机构成）", () => {
    const vault = openTestVault()
    seed(vault, { externalId: "cidFAKE0101==", probeLastMsgAt: NOW, unreadable: "confidential" })
    seed(vault, { externalId: "cidFAKE0102==", probeLastMsgAt: NOW, unreadable: "confidential" })
    seed(vault, { externalId: "cidFAKE0103==", probeLastMsgAt: NOW, unreadable: "cross_org" })
    seed(vault, { externalId: "cidFAKE0104==", probeLastMsgAt: 0, unreadable: "confidential" })
    seed(vault, { externalId: "cidFAKE0105==", probeLastMsgAt: NOW })

    const stale = new ProbeSnapshotRepository(vault.db).staleConversations(CHANNEL)
    expect(stale.map((row) => row.conversationExternalId)).toEqual(["cidFAKE0105=="])
    vault.close()
  })
})
