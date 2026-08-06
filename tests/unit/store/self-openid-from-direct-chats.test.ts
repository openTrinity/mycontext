/**
 * 从**单聊交集**反推本人在消息里用的标识（`openDingTalkId`）。
 *
 * ## 这条路存在的理由
 *
 * 授权成功只给 `corpId + userId`（工号），而消息的发送者字段是
 * `senderOpenDingTalkId` —— 两个互不相通的标识符空间，渠道没有开放
 * 「工号 → 聊天标识」的接口。原来唯一的翻译途径是拿**姓名**去搜人再按工号
 * 精确挑（`resolveSelf`），判定是准的但**失败率高**；失败时用户只能看着
 * 一条红字手动确认，而未确认期间蒸馏拒掉**全部**语料。
 *
 * 单聊定义上只有两人，所以「在我的多个单聊里都出现过的标识」只能是我自己 ——
 * 不存在第三个人同时在我的多个单聊里。**这条判据完全不碰姓名**，
 * 而姓名匹配是灾难性的（实测同名同姓搜出 6 个不同 openDingTalkId）。
 *
 * ## 这个文件锁住的不变量
 *
 * ① 多个单聊 → 交集唯一 → 那就是本人；
 * ② **只有 1 个单聊时必须放弃**（交集是 `{我, 对方}`，无从分辨）——
 *    这是最容易写错成"挑一个"的地方，而挑错的代价是不可逆的画像污染；
 * ③ **群聊不参与**（群里几十个人，交集立刻失去意义）；
 * ④ **单方独白的单聊不进分母** —— 若把"我只收没发"的单聊也算进去，
 *    我自己达不到那个计数而被排除，这条路会**静默**失效；
 * ⑤ 交集不唯一时放弃（多半是会话 type 判错，把群当成了单聊）。
 */
import { describe, expect, it } from "vitest"
import {
  ConversationRepository,
  MessageRepository,
  inferSelfExternalIdFromDirectChats,
  type SqliteDatabase,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CHANNEL = "dingtalk"
/** 本人的聊天标识。全是编的值（真实 openDingTalkId 不进仓库）。 */
const ME = "DFAKESELF0001"

let seq = 0

/**
 * 造一个会话 + 若干条消息。
 *
 * `senders` 就是这个会话里依次发言的人 —— 测试要表达的全部信息就是
 * 「哪个会话里出现过哪些标识」，所以正文一律留空。
 */
function seed(
  db: SqliteDatabase,
  type: "direct" | "group",
  senders: readonly string[],
  externalId = `cidFAKE${String(++seq).padStart(4, "0")}==`,
): string {
  const conversationId = `conv-${externalId}`
  new ConversationRepository(db).upsert({
    id: conversationId,
    channelId: CHANNEL,
    externalId,
    type,
    createdAt: 1,
  })
  new MessageRepository(db).upsertMany(
    senders.map((sender) => {
      seq += 1
      return {
        id: `msg-${String(seq)}`,
        channelId: CHANNEL,
        conversationId,
        externalId: `msgFAKE${String(seq).padStart(4, "0")}==`,
        senderExternalId: sender,
        contentText: "内容",
        sentAt: 1000 + seq,
        direction: "inbound" as const,
        createdAt: 1,
      }
    }),
  )
  return conversationId
}

describe("交集唯一 → 推出本人标识", () => {
  it("★ 三个单聊里都出现的那个标识就是本人（不用姓名）", () => {
    const vault = openTestVault()
    try {
      seed(vault.db, "direct", [ME, "DFAKEA001"])
      seed(vault.db, "direct", [ME, "DFAKEB002"])
      seed(vault.db, "direct", [ME, "DFAKEC003"])

      const result = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(result).toEqual({ ok: true, externalId: ME, directChats: 3 })
    } finally {
      vault.close()
    }
  })

  it("两个单聊就够（这是最小可用规模）", () => {
    const vault = openTestVault()
    try {
      seed(vault.db, "direct", [ME, "DFAKEA001"])
      seed(vault.db, "direct", ["DFAKEB002", ME])

      const result = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.externalId).toBe(ME)
    } finally {
      vault.close()
    }
  })

  it("★ 和同一个人开两个单聊 → 交集含对方 → 放弃；加入第三方后恢复唯一", () => {
    /**
     * 反直觉但重要：和**同一个人**开两个单聊时，对方在这两个里都出现，
     * 于是交集是 `{我, 他}` 两个 → 判定为不唯一 → 放弃。
     * 这正是我们要的行为（宁可放弃也不猜）。再加一个第三方单聊把他排除掉，
     * 唯一性就恢复了 —— 两段一起断言，说明这条自检不是"永远拒绝"。
     */
    const vault = openTestVault()
    try {
      seed(vault.db, "direct", [ME, "DFAKEA001"])
      seed(vault.db, "direct", [ME, "DFAKEA001"])
      const twoWay = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(twoWay.ok).toBe(false)

      seed(vault.db, "direct", [ME, "DFAKEB002"])
      const threeWay = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(threeWay.ok).toBe(true)
      if (threeWay.ok) expect(threeWay.externalId).toBe(ME)
    } finally {
      vault.close()
    }
  })
})

describe("★★ 推不出来时必须放弃，不能挑一个", () => {
  it("只有 1 个单聊 → 放弃（交集是「我 + 对方」，无从分辨）", () => {
    const vault = openTestVault()
    try {
      seed(vault.db, "direct", [ME, "DFAKEA001"])

      const result = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(result).toEqual({
        ok: false,
        reason: "not_enough_direct_chats",
        directChats: 1,
      })
    } finally {
      vault.close()
    }
  })

  it("库里空的 → 放弃（首次授权那一刻就是这个状态）", () => {
    const vault = openTestVault()
    try {
      const result = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe("not_enough_direct_chats")
    } finally {
      vault.close()
    }
  })

  it("★ 群聊不参与 —— 只有群时当作没有可用会话", () => {
    const vault = openTestVault()
    try {
      // 三个群，本人都在里面发过言 —— 但群里人多，交集毫无意义
      seed(vault.db, "group", [ME, "DFAKEA001", "DFAKEB002"])
      seed(vault.db, "group", [ME, "DFAKEC003", "DFAKED004"])
      seed(vault.db, "group", [ME, "DFAKEE005"])

      const result = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(result).toEqual({
        ok: false,
        reason: "not_enough_direct_chats",
        directChats: 0,
      })
    } finally {
      vault.close()
    }
  })

  it("★★ 群被误判成单聊 → 交集不唯一 → 放弃（不静默采用）", () => {
    /**
     * `classifyConversation` 实测踩过坑：某版本 group 层只有四个字段，
     * `conversationType`/`type`/`memberCount` 都不存在，于是 9 个会话
     * **全被判成单聊**。那种情况下这条推断的前提不成立，
     * 所以必须由"交集唯一"这道自检兜住，而不是信任 type。
     */
    const vault = openTestVault()
    try {
      seed(vault.db, "direct", [ME, "DFAKEA001", "DFAKEB002"])
      seed(vault.db, "direct", [ME, "DFAKEA001", "DFAKEB002"])

      const result = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(result.ok).toBe(false)
      if (!result.ok && result.reason === "not_unique") {
        // 我 + 两个同时在场的人 = 3 个候选
        expect(result.candidates).toBe(3)
      } else {
        expect.fail(`期望 not_unique，实际 ${JSON.stringify(result)}`)
      }
    } finally {
      vault.close()
    }
  })
})

describe("★★ 单方独白的单聊不进分母（否则这条路会静默失效）", () => {
  it("「我只收没发」的单聊不该把本人排除掉", () => {
    /**
     * 这是分母定义的关键。若把所有单聊都算进分母，那么"对方发了、我没回"
     * 的会话里没有我 → 我达不到分母 → 交集为空 → 推断失效。
     * 而"有几个只收不发的单聊"是极常见的情形（通知、群发、没回的私聊），
     * 所以这个错误会让整条路在真实库上大面积失灵，且**不报错**。
     */
    const vault = openTestVault()
    try {
      seed(vault.db, "direct", [ME, "DFAKEA001"])
      seed(vault.db, "direct", [ME, "DFAKEB002"])
      // 对方发了两条，我一条没回 —— 这个会话里根本没有 ME
      seed(vault.db, "direct", ["DFAKEC003", "DFAKEC003"])

      const result = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(result).toEqual({ ok: true, externalId: ME, directChats: 2 })
    } finally {
      vault.close()
    }
  })

  it("只有我说话的单聊也不进分母（没有区分力）", () => {
    const vault = openTestVault()
    try {
      seed(vault.db, "direct", [ME, "DFAKEA001"])
      seed(vault.db, "direct", [ME, "DFAKEB002"])
      seed(vault.db, "direct", [ME, ME, ME])

      const result = inferSelfExternalIdFromDirectChats(vault.db, CHANNEL)
      expect(result).toEqual({ ok: true, externalId: ME, directChats: 2 })
    } finally {
      vault.close()
    }
  })
})

describe("渠道隔离", () => {
  it("只看本渠道的会话", () => {
    const vault = openTestVault()
    try {
      seed(vault.db, "direct", [ME, "DFAKEA001"])
      seed(vault.db, "direct", [ME, "DFAKEB002"])

      // 另一个渠道问同一个库 → 没有它的会话，推不出来
      const other = inferSelfExternalIdFromDirectChats(vault.db, "feishu")
      expect(other.ok).toBe(false)
      if (!other.ok) expect(other.directChats).toBe(0)
    } finally {
      vault.close()
    }
  })
})
