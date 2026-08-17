/**
 * 改了勾选之后**已有数据**要跟着走 —— 这一层测的是"实时生效"。
 *
 * ## 为什么单独一个文件
 *
 * `ingest-scope-gate.test.ts` 测的是前向闸（从现在起不再采越界的）。
 * 而用户取消勾选一个会话时，那个会话的历史消息**已经在库里**、已经在
 * FTS 索引里、已经被导进知识图谱。只有前向闸的话，用户的动作在他能
 * 观察到的每个地方都没有效果：搜得到、蒸得到、数字人检索事实照样引用。
 * 那与"这个勾选框是装饰"没有区别。
 *
 * 反方向同样要测：**放宽**范围（勾了新会话 / 把下界往前挪）时，回填下界
 * 已经等于旧的 `since`，`nextBackfillWindow` 会返回 null —— 表现是
 * "我勾了这个群，但它只有今天的消息，历史永远补不回来"。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type { ChannelPlugin, ChannelPullPage, ChannelPullSpec } from "@mycontext/channels"
import {
  ConversationRepository,
  DistillSourceRepository,
  FtsIndexRepository,
  MessageRepository,
  purgeOutOfScopeMessages,
  readCollectionRequest,
  AttentionScopeRepository,
} from "@mycontext/store"
import { IngestService } from "@main/services/ingest.service.js"
import { DistillSourceService } from "@main/services/distill-source.service.js"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"
const A = "cidFAKE0001=="
const B = "cidFAKE0002=="

function emptyPage(): ChannelPullPage {
  return {
    conversations: [],
    messages: [],
    nextCursor: null,
    hasMore: false,
    itemCount: 0,
    rawPayload: "{}",
  }
}

function makePlugin() {
  return {
    meta: { id: CHANNEL },
    ingest: {
      probe: async () => null,
      pull: async (_spec: ChannelPullSpec) => emptyPage(),
      pullConversation: async () => emptyPage(),
    },
  } as unknown as ChannelPlugin
}

/** 两个会话，各 2 条消息 + FTS 索引行。模拟"已经采了一阵"的库。 */
function seed(vault: TestVault): void {
  const conversations = new ConversationRepository(vault.db)
  const messages = new MessageRepository(vault.db)
  const fts = new FtsIndexRepository(vault.db)
  for (const externalId of [A, B]) {
    conversations.upsert({
      id: `conv-${externalId}`,
      channelId: CHANNEL,
      externalId,
      type: "group",
      title: "群",
      memberCount: 3,
      isSelfInvolved: true,
      isBotChannel: false,
      lastMessageAt: START,
      createdAt: START,
    })
  }
  let n = 0
  for (const externalId of [A, B]) {
    for (const offset of [0, 1_000]) {
      n += 1
      const id = `msg-${n}`
      messages.upsertMany([
        {
          id,
          channelId: CHANNEL,
          conversationId: `conv-${externalId}`,
          externalId: `msgFAKE${String(n).padStart(4, "0")}==`,
          senderActorId: null,
          senderExternalId: "DFAKE0001peer",
          senderDisplayName: "张三",
          contentText: `内容 ${n}`,
          contentJson: null,
          quotedExternalId: null,
          threadId: null,
          sentAt: START + offset,
          direction: "inbound",
          isSelf: false,
          origin: "human",
          hasMedia: false,
          rawRecordId: null,
          createdAt: START,
        },
      ])
      fts.upsert({
        messageId: id,
        conversationId: `conv-${externalId}`,
        seg: `内容 ${n}`,
        contentHash: `hash-${n}`,
        indexedAt: START,
      })
    }
  }
}

function countMessages(vault: TestVault, externalId: string): number {
  return (
    vault.db
      .prepare<[string], { c: number }>(
        `SELECT count(*) AS c FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.external_id = ?`,
      )
      .get(externalId)?.c ?? 0
  )
}

/** FTS **虚表**里的行数。它不受 FK cascade 影响 —— 见 purge-scope.ts 文件头。 */
function ftsVirtualRows(vault: TestVault): number {
  return vault.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM messages_fts").get()?.c ?? 0
}

function setScope(vault: TestVault, picked: string[] | undefined, since?: number): void {
  new DistillSourceRepository(vault.db).upsert(
    "chat",
    {
      enabled: true,
      scope: {
        ...(since === undefined ? {} : { since }),
        ...(picked === undefined ? {} : { conversationIds: picked }),
      },
    },
    START,
  )
}

function makeService(vault: TestVault) {
  const service = new IngestService({
    db: vault.db,
    clock: new ManualClock(START + 60_000),
    logger: createLogger("test-scope-change", { level: "error" }),
    plugin: makePlugin(),
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()
  return service
}

describe("★★ 取消勾选之后，那个会话的已有语料被清掉", () => {
  it("只剩勾选会话的消息（连带 FTS 虚表行）", () => {
    const vault = openTestVault()
    seed(vault)
    setScope(vault, [A, B])
    expect(ftsVirtualRows(vault)).toBe(4)

    // 用户把 B 取消勾选
    setScope(vault, [A])
    makeService(vault).applyScopeChange()

    expect(countMessages(vault, A)).toBe(2)
    expect(countMessages(vault, B)).toBe(0)
    /**
     * ★★ 这一条是重点：`messages_fts` 是 FTS5 虚表，FK cascade **对它无效**。
     * 顺序写反（先删 messages）的话虚表里那两行会永久留下 ——
     * 可检索的正文还在，而再也没有代码能删掉它（rowid 的唯一来源已被
     * cascade 带走）。见 purge-scope.ts 文件头。
     */
    expect(ftsVirtualRows(vault)).toBe(2)
    vault.close()
  })

  it("★ 会话**目录**保留（用户要能把它再勾回来）", () => {
    const vault = openTestVault()
    seed(vault)
    setScope(vault, [A])
    makeService(vault).applyScopeChange()

    expect(new ConversationRepository(vault.db).findByExternalId(CHANNEL, B)).not.toBeNull()
    vault.close()
  })

  it("时间下界收窄 → 早于新下界的消息也被清", () => {
    const vault = openTestVault()
    seed(vault)
    // 两个会话都勾着，但下界推到所有消息之后
    setScope(vault, [A, B], START + 10_000)
    makeService(vault).applyScopeChange()

    expect(countMessages(vault, A)).toBe(0)
    expect(countMessages(vault, B)).toBe(0)
    vault.close()
  })

  it("预演只数不删", () => {
    const vault = openTestVault()
    seed(vault)
    setScope(vault, [A])
    const report = makeService(vault).applyScopeChange({ dryRun: true })

    expect(report.messages).toBe(2)
    expect(report.dryRun).toBe(true)
    // 库没动
    expect(countMessages(vault, B)).toBe(2)
    vault.close()
  })

  it("幂等：再清一次不再删任何东西", () => {
    const vault = openTestVault()
    seed(vault)
    setScope(vault, [A])
    const service = makeService(vault)
    service.applyScopeChange()
    const second = service.applyScopeChange()

    expect(second.messages).toBe(0)
    vault.close()
  })

  it("★ 显式选了「不限」（只配时间不配会话）时什么都不删 —— 那时「越界」没有定义", () => {
    const vault = openTestVault()
    seed(vault)
    // 有 chat 行但不带 conversationIds = 不限会话
    setScope(vault, undefined, START - 86_400_000)
    const report = purgeOutOfScopeMessages(
      vault.db,
      CHANNEL,
      readCollectionRequest(vault.db, "chat", CHANNEL),
    )

    expect(report.messages).toBe(0)
    expect(countMessages(vault, A)).toBe(2)
    expect(countMessages(vault, B)).toBe(2)
    vault.close()
  })
})

describe("★ 放宽范围之后历史能补回来（回填下界被重置）", () => {
  it("勾了新会话 → 回填游标清掉，下一轮重新往回挖", () => {
    const vault = openTestVault()
    seed(vault)
    setScope(vault, [A], START - 86_400_000)
    const service = makeService(vault)
    // 假装回填已经达成了旧下界（游标存在）
    vault.db
      .prepare(
        `INSERT INTO sync_cursors (scope, cursor, window_start, window_end, watermark,
             page_count, truncated, status, attempts, updated_at)
         VALUES (?, NULL, NULL, NULL, ?, 0, 0, 'idle', 0, ?)`,
      )
      .run(`${CHANNEL}:chat:backfill`, START - 86_400_000, START)

    // 用户又勾上 B，并把下界往前挪
    setScope(vault, [A, B], START - 30 * 86_400_000)
    service.applyScopeChange()

    const row = vault.db
      .prepare<[string], { c: number }>("SELECT count(*) AS c FROM sync_cursors WHERE scope = ?")
      .get(`${CHANNEL}:chat:backfill`)
    /**
     * 游标行被删掉 = 回填从"库里最早那条"重新往回走（与首次回填同一条
     * 路径，少一个特殊分支）。不删的话 `nextBackfillWindow` 会因为
     * `earliest <= since` 直接返回 null，新勾的会话永远只有增量。
     */
    expect(row?.c).toBe(0)
    vault.close()
  })
})

describe("★★ 保存范围时才通知（引导页一次点九个源，不能触发九次重建）", () => {
  function makeSourceService(vault: TestVault) {
    let calls = 0
    const service = new DistillSourceService({
      clock: new ManualClock(START),
      logger: createLogger("test-source", { level: "error" }),
      plugin: makePlugin(),
      onScopeChanged: () => {
        calls += 1
      },
    })
    service.attach(vault.db)
    return { service, calls: () => calls }
  }

  it("chat 范围真的变了 → 通知一次", () => {
    const vault = openTestVault()
    const { service, calls } = makeSourceService(vault)
    service.save({ kind: "chat", enabled: true, scope: { conversationIds: [A] } })
    expect(calls()).toBe(1)
    vault.close()
  })

  it("★ 同样的范围再存一次 → 不通知（否则每点下一步都重建一次图）", () => {
    const vault = openTestVault()
    const { service, calls } = makeSourceService(vault)
    service.save({ kind: "chat", enabled: true, scope: { conversationIds: [A, B] } })
    service.save({ kind: "chat", enabled: true, scope: { conversationIds: [A, B] } })
    expect(calls()).toBe(1)
    vault.close()
  })

  it("★ 勾选顺序变了但集合相同 → 不通知（引导页每次重新构造数组）", () => {
    const vault = openTestVault()
    const { service, calls } = makeSourceService(vault)
    service.save({ kind: "chat", enabled: true, scope: { conversationIds: [A, B] } })
    service.save({ kind: "chat", enabled: true, scope: { conversationIds: [B, A] } })
    expect(calls()).toBe(1)
    vault.close()
  })

  it("非 chat 源 → 不通知（它们的范围不参与采集闸）", () => {
    const vault = openTestVault()
    const { service, calls } = makeSourceService(vault)
    service.save({ kind: "mail", enabled: true, scope: { since: START } })
    service.save({ kind: "calendar", enabled: false, scope: {} })
    expect(calls()).toBe(0)
    vault.close()
  })

  it("把 chat 源关掉也是范围变更（那意味着一条都不采）", () => {
    const vault = openTestVault()
    const { service, calls } = makeSourceService(vault)
    service.save({ kind: "chat", enabled: true, scope: { conversationIds: [A] } })
    service.save({ kind: "chat", enabled: false, scope: { conversationIds: [A] } })
    expect(calls()).toBe(2)
    vault.close()
  })
})

/**
 * ── ★★★ 清理的判据是**采集面**，不是学习范围（v4 §3.3）────────────────
 *
 * DWD 只打标不筛行之后，库里**故意**留着一类行：「只因监听范围而入库的」。
 * 它们是分身要盯的新消息，而它们**本来就不在学习白名单里**。
 *
 * 拿学习范围当清理判据会把它们判成越界并**真删**（连带 FTS / 向量 / 媒体）：
 *
 *   用户监听的那个群 → 每保存一次范围就被清空一次 → 分身随即失去上下文
 *
 * 而它不报错。这一组锁的就是"那些行必须活下来"。
 */
describe("★★★ 监听范围里的会话：不在学习白名单里，也不许被清掉", () => {
  it("★★★ B 只在监听范围里 → 取消它的学习勾选后，它的消息**仍在**", () => {
    /**
     * 反证：把 `applyScopeChange` 里那个 `collectionRequest()` 改回
     * `collectionScope()`（学习范围）→ 这条转红，B 的 2 条被删。
     *
     * ★ 这一条与本文件第一组（"取消勾选就该清掉"）**不矛盾**：
     * 那一组里 B 两个范围都没有 —— 而"两个范围都不要"才叫越界。
     */
    const vault = openTestVault()
    seed(vault)
    // 学习范围只勾 A；而 B 在监听范围里（用户明确要分身盯着它）
    setScope(vault, [A])
    const attention = new AttentionScopeRepository(vault.db)
    attention.setMode(CHANNEL, "explicit", START)
    attention.add(CHANNEL, [{ conversationExternalId: B, enabledAt: START }], START)

    makeService(vault).applyScopeChange()

    expect(countMessages(vault, A)).toBe(2)
    // ★★★ B 活着 —— 它在采集面内（学习 ∪ 监听）
    expect(countMessages(vault, B)).toBe(2)
    // FTS 也不该被动（4 行全在）
    expect(ftsVirtualRows(vault)).toBe(4)
    vault.close()
  })

  it("★★★ 监听会话**豁免上界** —— 学习范围只学到某天，它之后的新消息仍留着", () => {
    /**
     * ## 这是那第一个洞在清理侧的镜像
     *
     * 用户选「学到某一天为止」，同时让分身盯着某个群。那个群在 `until`
     * 之后的新消息**该留**（他的两个选择都没要求删它）。
     *
     * 前向闸（`isWithinCollectionWindow`）已经对这一格豁免了。清理侧不豁免
     * 的话两者互相拆台：闸放进来、清理删掉，每轮都在删刚采的 ——
     * 而现象是"分身的上下文总是只有几分钟"。
     *
     * 反证：把 `purge-scope.ts` 里上界那一格的 `NOT IN (attentionScoped)`
     * 删掉 → 这条转红。
     */
    const vault = openTestVault()
    seed(vault)
    // 学习范围：两个会话都勾，但上界卡在所有消息**之前**
    new DistillSourceRepository(vault.db).upsert(
      "chat",
      { enabled: true, scope: { conversationIds: [A, B], until: START - 1 } },
      START,
    )
    // B 在监听范围里
    const attention = new AttentionScopeRepository(vault.db)
    attention.setMode(CHANNEL, "explicit", START)
    attention.add(CHANNEL, [{ conversationExternalId: B, enabledAt: START }], START)

    makeService(vault).applyScopeChange()

    // A 只受学习范围管 → 它的消息晚于 until → 被清
    expect(countMessages(vault, A)).toBe(0)
    // ★★★ B 受监听范围保护 → 豁免上界 → 留着
    expect(countMessages(vault, B)).toBe(2)
    vault.close()
  })

  it("★★ 监听会话被**关掉**之后就不再豁免（关掉 = 以后别管它）", () => {
    /**
     * `disable` 只置 `active = 0`（不删行，重开时 `enabled_at` 还在）。
     * 而采集面只取 `active` 的行 —— 于是一个关掉的会话回到"只受学习范围管"。
     *
     * ★ 这一条锁的是"豁免不是永久的"：否则用户关掉监听之后，
     * 那个会话仍然永远躲过清理，而配置上已经没有任何一处说要留它。
     */
    const vault = openTestVault()
    seed(vault)
    setScope(vault, [A])
    const attention = new AttentionScopeRepository(vault.db)
    attention.setMode(CHANNEL, "explicit", START)
    attention.add(CHANNEL, [{ conversationExternalId: B, enabledAt: START }], START)
    attention.disable(CHANNEL, B, START + 1)

    makeService(vault).applyScopeChange()

    expect(countMessages(vault, A)).toBe(2)
    // 两个范围都不要它了 → 那才叫越界
    expect(countMessages(vault, B)).toBe(0)
    vault.close()
  })
})
