/**
 * 逐会话读消息被服务端拒绝 → **落对的持久标记**，不再每 2 分钟重撞。
 *
 * ## 这一组锁的是一次真实日志里的两个 bug
 *
 * 来源是用户贴来的运行日志（2026-08-17）：
 *
 * ```
 * WARN  process non-zero exit … server_error_code: "11056"
 * WARN  ingest refreshConversation failed {"detail":"渠道命令失败（exit 1）"}   ← ★ 没落标记
 * WARN  process non-zero exit … "peerUid is required" … server_error_code: "1001"
 * WARN  ingest conversation marked unreadable {"reason":"confidential"}        ← ★ 归因错了
 * ```
 *
 * 两个问题，性质不同：
 *
 * | # | 现象 | 后果 |
 * |---|---|---|
 * | ① | `11056` / `130003` **压根没分类** → 兜底判成可重试 | 每 2 分钟重撞、永不落标记（刷屏） |
 * | ② | `1001` 被上游复用于三件事，代码一律记成 `confidential` | 33 个单聊被说成"保密会话"，用户会去问对方 |
 *
 * ★ ② 的**结果**（跳过这个会话）是对的，错的是**为什么**。而归因错的代价
 * 很具体：界面照它说话会让用户去找对方，而问题在我们这边。
 *
 * ## ★ 为什么全都过一遍 `classifyDwsError`
 *
 * 手写 AppError 等于把"分类正确"这个前提假设掉，而那恰恰是出事的地方
 * （与 `ingest-enterprise-not-authorized.test.ts` 同一条理由）。
 * 这里喂真实 stderr fixture，拿分类器的真实产物当输入。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import { classifyDwsError, type ChannelPlugin } from "@mycontext/channels"
import { ConversationRepository, DistillSourceRepository } from "@mycontext/store"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault, type TestVault } from "../../helpers/vault.js"
import {
  REAL_ERR_CONV_LIST_BASE_NULL,
  REAL_ERR_CONV_NOT_A_MEMBER,
  REAL_ERR_DIRECT_PEER_UID_REQUIRED,
} from "../../fixtures/dingtalk-real-payloads.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"
const GROUP = "cidFAKE0001=="

/**
 * 一个会话 + 一条对端消息（单聊要靠它解析出对端 openId）。
 *
 * ★ 必须有那条消息：`findPeerExternalId` 查不到对端时 `refreshConversation`
 * 直接返回 0，压根走不到发命令那一步 —— 那样这组测试会**恒绿**。
 */
function seed(vault: TestVault, type: "group" | "direct"): void {
  /**
   * ★★ 必须把这个会话放进采集面 —— 否则 `refreshConversation` 在**范围闸**
   * 那一步就 `return 0`，压根走不到发命令那一步，于是整组测试恒绿。
   *
   * （这正是"先确认门禁真的会红"那条纪律要防的：我第一版漏了这段，
   * 5 条用例全红并报 `calls = 0`，才发现是闸挡在前面。）
   */
  new DistillSourceRepository(vault.db).upsert(
    "chat",
    { enabled: true, scope: { conversationIds: [GROUP] } },
    START,
  )
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: CHANNEL,
    externalId: GROUP,
    type,
    title: "测试会话",
    createdAt: START,
  })
  vault.db
    .prepare(
      `INSERT INTO messages
         (id, channel_id, conversation_id, external_id, sender_external_id, content_text,
          sent_at, direction, is_self, origin, created_at)
       VALUES ('m1', ?, 'conv-1', 'msgFAKE0001==', 'DFAKE0001peer', '在吗',
               ?, 'inbound', 0, 'human', ?)`,
    )
    .run(CHANNEL, START, START)
}

function setup(stderr: string, type: "group" | "direct") {
  const vault = openTestVault()
  seed(vault, type)
  let calls = 0
  const plugin = {
    meta: { id: CHANNEL },
    ingest: {
      probe: async () => null,
      pull: async () => ({
        conversations: [],
        messages: [],
        nextCursor: null,
        hasMore: false,
        itemCount: 0,
        rawPayload: "{}",
      }),
      pullConversation: async () => {
        calls += 1
        // ★ 真实分类器的真实产物 —— 见文件头
        throw classifyDwsError(stderr) ?? new Error("分类器没认出这段真实输出")
      },
    },
  } as unknown as ChannelPlugin

  const service = new IngestService({
    db: vault.db,
    clock: new ManualClock(START),
    logger: createLogger("test-conv-rejected", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()
  return {
    service,
    vault,
    get calls() {
      return calls
    },
    reason: () =>
      new ConversationRepository(vault.db).unreadableByExternalId(CHANNEL).get(GROUP) ?? null,
    close: () => vault.close(),
  }
}

describe("★★★ 11056：服务端拒绝 → 终态 + 持久标记（修无限重撞）", () => {
  it("★★★ 一次之后落标记，且 reason 不是 confidential", async () => {
    /**
     * 反证：把 `11056` 从 `SERVER_ERROR_CODES` 里删掉 → 它落到兜底
     * `PROCESS_FAILED{retryable:true}` → `markUnreadable` 那一支走不到
     * → `reason()` 是 null → 这条转红。而那正是修复前的状态。
     */
    const h = setup(REAL_ERR_CONV_LIST_BASE_NULL, "group")

    await h.service.refreshConversation(GROUP)

    expect(h.reason()).toBe("server_rejected")
    h.close()
  })

  it("★★★ 落标记之后**不再发命令**（这才是刷屏的反面）", async () => {
    /**
     * 只断言"落了标记"会漏掉"标记落了但照样每轮发命令"那种情况 ——
     * 而用户感知到的正是后者（日志里每 2 分钟一串 WARN）。
     */
    const h = setup(REAL_ERR_CONV_LIST_BASE_NULL, "group")

    await h.service.refreshConversation(GROUP)
    expect(h.calls).toBe(1)

    await h.service.refreshConversation(GROUP)
    await h.service.refreshConversation(GROUP)
    await h.service.refreshConversation(GROUP)

    // 仍然是 1 —— 持久标记挡住了后面三轮
    expect(h.calls).toBe(1)
    h.close()
  })
})

describe("★★★ 130003：本人不在会话里 → 终态 + 自己的 reason", () => {
  it("★★ reason 是 not_a_member（不是保密、也不是跨组织）", async () => {
    /**
     * 三者的**出路完全不同**：不在群里无解、保密无解但原因在对方、
     * 跨组织授权一次就能读。混成一个会让界面说错话。
     */
    const h = setup(REAL_ERR_CONV_NOT_A_MEMBER, "group")

    await h.service.refreshConversation(GROUP)

    expect(h.reason()).toBe("not_a_member")
    h.close()
  })
})

describe("★★★ 1001 + peerUid：单聊缺标识，**不许**说成保密会话", () => {
  it("★★★ reason 是 peer_id_unavailable", async () => {
    /**
     * ## 这一条锁的是那个归因错误
     *
     * 实测本机库里 **33 个单聊**被标成 `confidential`，而它们全都有对端
     * openId、格式正常、以前也读得到 —— 拿真实 openId 直接跑渠道 CLI
     * 复现过：`1001` + `peerUid is required`。
     *
     * 反证有两处，都会让这条转红：
     * ① 删掉 `SERVER_CODE_VARIANTS` 里那一格 → 落整码表 → `confidential`；
     * ② 把 `markUnreadable` 那里改回按错误码归因 → 同样 `confidential`。
     */
    const h = setup(REAL_ERR_DIRECT_PEER_UID_REQUIRED, "direct")

    await h.service.refreshConversation(GROUP)

    expect(h.reason()).toBe("peer_id_unavailable")
    // ★★ 显式反面：这个词绝不能出现（它会让用户去问对方）
    expect(h.reason()).not.toBe("confidential")
    h.close()
  })

  it("★★ 仍然是终态（跳过是对的，只是原因要说对）", async () => {
    const h = setup(REAL_ERR_DIRECT_PEER_UID_REQUIRED, "direct")

    await h.service.refreshConversation(GROUP)
    await h.service.refreshConversation(GROUP)

    expect(h.calls).toBe(1)
    h.close()
  })
})
