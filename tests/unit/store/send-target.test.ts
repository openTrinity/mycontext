/**
 * 单聊发送目标解析的门禁。
 *
 * ## ★ 为什么这件事需要一组门禁（我在这里错过一次，且错得很安静）
 *
 * `chat message send` 的目标三选一：群聊 `--group <openConversationId>`、
 * 单聊 `--open-dingtalk-id <对端 openDingTalkId>`。我原来在
 * `persona.service.ts` 里写死了「单聊也用 `conversations.external_id`」，
 * 并在注释里给了理由：「实测单聊的 external_id 与 openDingTalkId 同形」。
 *
 * **那句是错的。** 实测真实库 52 个单聊：
 *
 * | 值                              | 形状              | 是什么     |
 * | ------------------------------- | ----------------- | ---------- |
 * | `conversations.external_id`     | `cid…`，47 字符   | **会话** id |
 * | `messages.sender_external_id`   | `D…`，33-34 字符  | **人** 的 id |
 *
 * 两者既不同形也不同长。而传错之后服务端回的是：
 *
 * > 单聊时 receiverUid 不能为空，群聊时 openCid 或 cid 不能为空
 *
 * 注意这句话的欺骗性：它说一个我们**压根没传**的参数（`receiverUid`）为空，
 * 而我们明明传了 `--open-dingtalk-id`。真实含义是「你给的串我不认成一个人」。
 * 于是「点发送」100% 失败，且错误信息把人引向参数名而不是参数**值**。
 *
 * 这一组锁的是那个**判据**（单聊要另查对端），而不是某一次的修复。
 */
import { describe, expect, it } from "vitest"
import { ConversationRepository, MessageRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = new Date(2026, 6, 1, 15, 0, 0).getTime()

/**
 * 造一个单聊 + 双方各一条消息。
 *
 * ID 的**形状照真实数据**（cid… 47 字符 / D… 33 字符）：形状不真的话
 * "拿错了哪一个"在断言里看不出来 —— 两个假串都是 `x1`/`x2` 时
 * 断言 `toBe("x2")` 通过了也不能说明它拿的是"人"而不是"会话"。
 */
function seedDirect(): { vault: ReturnType<typeof openTestVault>; peer: string; cid: string } {
  const vault = openTestVault()
  const cid = `cid${"A".repeat(44)}`
  const peer = `D${"B".repeat(32)}`

  new ConversationRepository(vault.db).upsert({
    id: "conv-direct",
    channelId: "dingtalk",
    externalId: cid,
    type: "direct",
    title: "某同事",
    createdAt: NOW,
  })
  new MessageRepository(vault.db).upsertMany([
    {
      id: "m-self",
      channelId: "dingtalk",
      conversationId: "conv-direct",
      externalId: "ext-self",
      // 本人那条**先**插入：实现取的是"第一条非本人消息"，
      // 若它误取了 LIMIT 1 而漏了 is_self=0，这条会先被拿到 → 红。
      senderExternalId: `D${"S".repeat(32)}`,
      contentText: "在吗",
      sentAt: NOW - 1000,
      direction: "outbound",
      isSelf: true,
      createdAt: NOW,
    },
    {
      id: "m-peer",
      channelId: "dingtalk",
      conversationId: "conv-direct",
      externalId: "ext-peer",
      senderExternalId: peer,
      contentText: "在",
      sentAt: NOW,
      direction: "inbound",
      isSelf: false,
      createdAt: NOW,
    },
  ])
  return { vault, peer, cid }
}

describe("★ 单聊发送目标：必须是对端的人，不是会话 id", () => {
  it("拿到的是对端 openDingTalkId，且**不是** conversations.external_id", () => {
    const { vault, peer, cid } = seedDirect()
    const resolved = new ConversationRepository(vault.db).findPeerExternalId("conv-direct")

    expect(resolved).toBe(peer)
    /**
     * ★ 这条反向断言是这一组的核心。
     *
     * 只断言 `=== peer` 的话，"实现返回了 cid 而 cid 恰好等于 peer" 这种
     * 造数据失误会让门禁假绿。显式钉住"不等于会话 id"，
     * 于是我原来那个 bug（返回 external_id）无论怎么改造数据都必红。
     */
    expect(resolved).not.toBe(cid)
    expect(resolved?.startsWith("D")).toBe(true)
  })

  it("跳过本人的消息（本人那条排在前面也不能被选中）", () => {
    const { vault, peer } = seedDirect()
    // seed 里本人那条 sentAt 更早、插入更早 —— 都不该影响结果
    expect(new ConversationRepository(vault.db).findPeerExternalId("conv-direct")).toBe(peer)
  })

  /**
   * ★★ 一个单聊里有**两套对端 openId** 时必须挑主对端（消息最多那个）。
   *
   * ## 这条锁的是一次真实的"发错人"
   *
   * openDingTalkId 的定义是「**当前用户视角下**的目标用户唯一标识，
   * 不可跨用户共享」。所以同一个人在不同观察者视角下是**不同**的 openId，
   * 而一个会话里可能同时躺着两个视角采到的消息（用户换过 CLI／换过身份）。
   *
   * 实测本机 143 个单聊里正好有 1 个是这样（用户自己两个身份之间的单聊）：
   * ```
   * D0AUGT…aw(33)  is_self=0  21 条  ← 主对端，历史都是跟他聊的
   * DMvqYy…  (34)  is_self=0   2 条  ← 同一个人的另一套 openId
   * ```
   * 而实现原来是 `LIMIT 1` **无 ORDER BY** —— 挑哪个由 SQLite 决定。
   * 实测它挑中了只有 2 条的那个，于是「发给 A 的消息进了 B 的对话」，
   * 而两个 openId 的**显示名相同**，界面上看不出任何异常。
   *
   * ★ 断言"取次数最多的"而不是"取某个具体值"：那才是判据本身。
   */
  it("★★ 有两套对端 openId 时取消息最多的那个（无序 LIMIT 1 会挑错人）", () => {
    const { vault } = seedDirect()
    const messages = new MessageRepository(vault.db)
    /** 主对端：再补 4 条，让它总数 5 条。 */
    const main = `D${"B".repeat(32)}`
    /** 同一个人的另一套 openId（34 字符，与真实数据同形），只 1 条但**更新**。 */
    const alt = `D${"Z".repeat(33)}`
    messages.upsertMany([
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `m-main-${String(i)}`,
        channelId: "dingtalk",
        conversationId: "conv-direct",
        externalId: `ext-main-${String(i)}`,
        senderExternalId: main,
        contentText: "历史消息",
        sentAt: NOW - 10_000 + i,
        direction: "inbound" as const,
        isSelf: false,
        createdAt: NOW,
      })),
      {
        id: "m-alt",
        channelId: "dingtalk",
        conversationId: "conv-direct",
        externalId: "ext-alt",
        senderExternalId: alt,
        contentText: "另一套视角的那条",
        // ★ 刻意**更新**：只按时间排的话会挑中它，那正是要排除的实现
        sentAt: NOW + 999_999,
        direction: "inbound" as const,
        isSelf: false,
        createdAt: NOW,
      },
    ])

    const resolved = new ConversationRepository(vault.db).findPeerExternalId("conv-direct")
    expect(resolved).toBe(main)
    expect(resolved).not.toBe(alt)
  })

  /**
   * ★ 次数并列时取**最近还在说话**的那套 openId。
   *
   * 两套各一条时"谁是主对端"无从判断，那时"现在还在用的那个"是更好的猜 ——
   * 而更要紧的是它**确定**：同一个会话每次问都得到同一个答案。
   * 不确定本身就是上面那个 bug 的成因。
   */
  it("★ 次数并列 → 取 sent_at 更晚的（结果必须确定）", () => {
    const { vault } = seedDirect()
    const newer = `D${"Z".repeat(33)}`
    new MessageRepository(vault.db).upsertMany([
      {
        id: "m-newer",
        channelId: "dingtalk",
        conversationId: "conv-direct",
        externalId: "ext-newer",
        senderExternalId: newer,
        contentText: "更近的那条",
        sentAt: NOW + 5000,
        direction: "inbound",
        isSelf: false,
        createdAt: NOW,
      },
    ])
    // seed 里主对端只有 1 条（sentAt = NOW），新加的也 1 条但更晚
    const resolved = new ConversationRepository(vault.db).findPeerExternalId("conv-direct")
    expect(resolved).toBe(newer)
  })

  /**
   * 群聊返回 null —— 群聊走的是 `--group <openConversationId>`，
   * 不需要"某个人"。这里锁的是**别顺手给群聊也返回一个人**：
   * 那会让群聊消息被发成一条私聊，而"发错地方"比"发不出去"糟得多。
   */
  it("群聊返回 null（群聊用 --group，不需要人）", () => {
    const vault = openTestVault()
    new ConversationRepository(vault.db).upsert({
      id: "conv-group",
      channelId: "dingtalk",
      externalId: `cid${"G".repeat(44)}`,
      type: "group",
      title: "某群",
      memberCount: 9,
      createdAt: NOW,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "gm-1",
        channelId: "dingtalk",
        conversationId: "conv-group",
        externalId: "ext-g1",
        senderExternalId: `D${"C".repeat(32)}`,
        contentText: "大家好",
        sentAt: NOW,
        direction: "inbound",
        isSelf: false,
        createdAt: NOW,
      },
    ])
    expect(new ConversationRepository(vault.db).findPeerExternalId("conv-group")).toBeNull()
  })

  /**
   * 对方从没说过话的单聊 → null。
   *
   * 这不是异常而是真实存在的状态（我发过消息、对方没回）。此时调用方
   * 必须失败而**不是**退回用 cid 猜 —— 退回去只会把一个明确的
   * "找不到对端"变回那句含义不明的 `receiverUid 不能为空`。
   */
  it("对方从没说过话 → null（调用方据此失败，而不是拿 cid 顶上）", () => {
    const vault = openTestVault()
    new ConversationRepository(vault.db).upsert({
      id: "conv-silent",
      channelId: "dingtalk",
      externalId: `cid${"Z".repeat(44)}`,
      type: "direct",
      title: "没回过我的人",
      createdAt: NOW,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "sm-1",
        channelId: "dingtalk",
        conversationId: "conv-silent",
        externalId: "ext-s1",
        senderExternalId: `D${"S".repeat(32)}`,
        contentText: "在吗",
        sentAt: NOW,
        direction: "outbound",
        isSelf: true,
        createdAt: NOW,
      },
    ])
    expect(new ConversationRepository(vault.db).findPeerExternalId("conv-silent")).toBeNull()
  })
})
