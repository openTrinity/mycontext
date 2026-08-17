/**
 * **DWD 只打标、不筛行**（v4 阶段 D）—— 资格标签在真库上的行为。
 *
 * ## ★★★ 这个文件锁的是一处**分层错误**的修复
 *
 * `persist()` 那道闸原来在 DWD 的**写入侧**按**一个下游**（学习侧）的口径
 * 把行筛掉。而 `messages` 是多个下游共用的明细层：
 *
 * | 下游 | 要什么 |
 * |---|---|
 * | fts / graph / distill | 学习范围内的 |
 * | ★ 数字分身 | 监听范围内的 —— 含"超出学习 `until`"的新消息 |
 * | ★ 界面（消息历史） | 全部（用户要看的是完整对话） |
 *
 * 在写入侧按第一类的口径筛，另外两类就**永久**拿不到那些数据。
 *
 * 四组断言：
 * ① 落库时打标（0 / 1 / NULL 三态都能表达）；
 * ② ★★★ 标签**只增不减**（`MAX` 语义）—— 范围只增，标签就不会 1 → 0；
 * ③ ★★★ `NULL` 视为**合格**（`IS NOT 0`，不是 `= 1`）；
 * ④ changelog 的 `eligibility` 位图 + 消费者按标签取那一段。
 */
import { describe, expect, it } from "vitest"
import {
  ChangelogRepository,
  ConversationRepository,
  ELIGIBILITY_BITS,
  MessageRepository,
  eligibilityOf,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const NOW = 1_785_000_000_000
const CID = "cidFAKE0001=="

type Vault = ReturnType<typeof openTestVault>

function seedConversation(vault: Vault): string {
  new ConversationRepository(vault.db).upsert({
    id: "conv1",
    channelId: CH,
    externalId: CID,
    type: "group",
    title: "测试群",
    createdAt: NOW,
  })
  return "conv1"
}

/** 造一条消息。`learningEligible` 不传 = 没打过标（存量路径）。 */
function message(
  index: number,
  learningEligible?: boolean,
): Parameters<MessageRepository["upsertMany"]>[0][number] {
  return {
    id: `m${index}`,
    channelId: CH,
    conversationId: "conv1",
    externalId: `msgFAKE${String(index).padStart(4, "0")}`,
    senderExternalId: "DFAKE0001",
    senderDisplayName: "张三",
    contentText: `第 ${index} 条`,
    contentJson: null,
    quotedExternalId: null,
    sentAt: NOW + index,
    direction: "inbound" as const,
    isSelf: false,
    hasMedia: false,
    createdAt: NOW,
    mentions: [],
    media: [],
    ...(learningEligible === undefined ? {} : { learningEligible }),
  }
}

describe("资格标签：落库时打标（三态）", () => {
  it("★★★ 越界的消息**照样入库**，只是标 0（这是整个阶段 D 的实质）", () => {
    /**
     * 反证：把 `persist` 改回"越界就丢"（或让 `upsertMany` 忽略这个字段）
     * → 这条转红。而那正是改动前的行为：分身与界面永久拿不到这些行。
     */
    const vault = openTestVault()
    seedConversation(vault)
    const repo = new MessageRepository(vault.db)
    repo.upsertMany([message(1, true), message(2, false)])

    const rows = repo.recentInConversation("conv1", 10)
    // ★ 两条都在库里 —— 这就是"只打标、不筛行"
    expect(rows).toHaveLength(2)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get("m1")?.learningEligible).toBe(true)
    expect(byId.get("m2")?.learningEligible).toBe(false)
    vault.close()
  })

  it("★★ 不传标签 → 落库为 `NULL`（没打过标，与 0 必须可区分）", () => {
    /**
     * `NULL` 的语义是"这一行是打标之前入库的，我们不知道当时的资格"。
     * 它与 `0`（"明确不在学习范围内"）**必须**可区分：下面那一组的
     * `IS NOT 0` 对两者的处置完全相反。
     *
     * ★ 反证：给列加 `DEFAULT 0` → 这条转红（而那个默认值的后果是
     * 存量库的图谱下一轮清空）。
     */
    const vault = openTestVault()
    seedConversation(vault)
    const repo = new MessageRepository(vault.db)
    repo.upsertMany([message(1)])

    expect(repo.recentInConversation("conv1", 10)[0]?.learningEligible).toBeNull()
    const raw = vault.db
      .prepare<
        [],
        { learning_eligible: number | null }
      >("SELECT learning_eligible FROM messages WHERE id = 'm1'")
      .get()
    expect(raw?.learning_eligible).toBeNull()
    vault.close()
  })
})

describe("★★★ 标签只增不减（`MAX` 语义）—— 与「范围只增不减」同一个不变式", () => {
  it("★★★ 已经标 1 的行，再以 0 落一次仍是 1", () => {
    /**
     * ## 为什么必须是这个方向
     *
     * 范围只增不减 ⇒ `learning_eligible` 只 0 → 1 ⇒ 图谱/画像只增
     * ⇒ **不存在孤儿 fact** ⇒ 不需要"从图里删掉某些 fact"这个能力。
     *
     * 这条不变式是那整条推理的地基。若标签能 1 → 0，那么：
     * 图里有那条 fact、而库说"这条不该学" —— 一个静默的矛盾，
     * 且唯一的消除手段是手动重建（50 min 且不可续传）。
     *
     * ★ 现实中怎么会以 0 再落一次：重叠窗口重采同一条消息，而那一刻
     * 范围读出来是坏 JSON / 或那一批走了另一条没算标签的路径。
     *
     * 反证：把 upsert 里的 `MAX(...)` 改成 `excluded.learning_eligible`
     * → 这条转红。
     */
    const vault = openTestVault()
    seedConversation(vault)
    const repo = new MessageRepository(vault.db)
    repo.upsertMany([message(1, true)])
    repo.upsertMany([message(1, false)])

    expect(repo.recentInConversation("conv1", 10)[0]?.learningEligible).toBe(true)
    vault.close()
  })

  it("★★ 反方向**可以**：标 0 的行后来放宽了范围 → 变 1", () => {
    /**
     * 这是"范围只增"落到数据上的样子：用户把一个群加进学习范围之后，
     * 那个群**已经在库里**的消息在下一轮重采时标签升为 1，
     * 于是学习侧下一轮就能看到它们 —— **不需要重新去渠道拉**。
     *
     * ★ 这一条同时是"为什么值得把越界数据也入库"的收益证明。
     */
    const vault = openTestVault()
    seedConversation(vault)
    const repo = new MessageRepository(vault.db)
    repo.upsertMany([message(1, false)])
    repo.upsertMany([message(1, true)])

    expect(repo.recentInConversation("conv1", 10)[0]?.learningEligible).toBe(true)
    vault.close()
  })

  it("★★ `NULL` 行再以 0 落一次 → 变 0（NULL 不是最宽）", () => {
    /**
     * `MAX(COALESCE(旧, 0), COALESCE(新, 0))` 把 NULL 当 0 参与比较。
     * 于是 NULL + 0 = 0：一条存量行被明确判为越界之后，标签落实成 0。
     *
     * ★ 这与"读侧把 NULL 视为合格"**不矛盾**：读侧那条是给
     * **还没被重新打标过**的存量行兜底，而这里已经有了明确结论。
     */
    const vault = openTestVault()
    seedConversation(vault)
    const repo = new MessageRepository(vault.db)
    repo.upsertMany([message(1)])
    repo.upsertMany([message(1, false)])

    expect(repo.recentInConversation("conv1", 10)[0]?.learningEligible).toBe(false)
    vault.close()
  })
})

describe("★★★ changelog 的资格位图：消费者按标签取自己那一段", () => {
  it("★★★ `requiresBit` 过滤掉标 0 的那一条", () => {
    const vault = openTestVault()
    const log = new ChangelogRepository(vault.db)
    log.append([
      {
        op: "upsert",
        entityType: "message",
        entityId: "m1",
        channelId: CH,
        domain: "chat",
        eligibility: eligibilityOf({ learning: true }),
        occurredAt: NOW,
        emittedAt: NOW,
        payloadRef: null,
        digest: "d1",
      },
    ])
    log.append([
      {
        op: "upsert",
        entityType: "message",
        entityId: "m2",
        channelId: CH,
        domain: "chat",
        eligibility: eligibilityOf({ learning: false }),
        occurredAt: NOW,
        emittedAt: NOW,
        payloadRef: null,
        digest: "d2",
      },
    ])

    // 学习侧：只拿到标 1 的
    const learning = log.changesSince(0, 10, "chat", ELIGIBILITY_BITS.learning)
    expect(learning.map((entry) => entry.entityId)).toEqual(["m1"])
    // ★ 不带 bit（分身 / 界面）：两条都拿到 —— 那正是"多下游共用"的意思
    expect(log.changesSince(0, 10, "chat").map((entry) => entry.entityId)).toEqual(["m1", "m2"])
    vault.close()
  })

  it("★★★ `eligibility IS NULL`（存量条目）对学习侧算**合格**", () => {
    /**
     * ## 这一条与下一组是阶段 D 最容易写错的地方
     *
     * `(eligibility & 1) != 0` 单独一句会把 NULL 排除掉（SQL 里
     * `NULL & 1` 是 NULL，`NULL != 0` 是 NULL，也就是**不为真**）。
     * 而存量库里**每一条** changelog 都是 NULL（v30 只加列、不回填）。
     *
     * 后果：存量用户的学习侧下一轮从 changelog 里拿到**零条** ——
     * FTS 停止建索引、蒸馏停止推进，而没有任何一处报错。
     *
     * 反证：把 `changelog.ts` 里那句 `OR eligibility IS NULL` 删掉
     * → 这条转红。
     */
    const vault = openTestVault()
    const log = new ChangelogRepository(vault.db)
    log.append([
      {
        op: "upsert",
        entityType: "message",
        entityId: "legacy",
        channelId: CH,
        domain: "chat",
        // ★ 不给 eligibility —— 存量路径的形状
        occurredAt: NOW,
        emittedAt: NOW,
        payloadRef: null,
        digest: "d0",
      },
    ])

    const learning = log.changesSince(0, 10, "chat", ELIGIBILITY_BITS.learning)
    expect(learning.map((entry) => entry.entityId)).toEqual(["legacy"])
    vault.close()
  })

  it("★ 位图的算法只有一份（`eligibilityOf`），且 learning 是 bit 0", () => {
    /**
     * 抄错这个算法的后果是消费者取错段，而它不报错。所以判据放在
     * 唯一那份实现上，而不是让每个调用点各写一个字面量。
     */
    expect(eligibilityOf({ learning: true })).toBe(ELIGIBILITY_BITS.learning)
    expect(eligibilityOf({ learning: false })).toBe(0)
    expect(ELIGIBILITY_BITS.learning).toBe(1)
  })
})

describe("★★★ 「标签变宽」必须算作变化 —— 否则放宽范围对历史数据无效", () => {
  it("★★★ 内容不变、标签 0 → 1：那一行必须出现在 `changed` 里", () => {
    /**
     * ## 这一条锁的是一个我实测到的**真 bug**（不是设想）
     *
     * upsert 的 `WHERE` 原来只判**内容**。于是用户把一个群加进学习范围之后：
     *
     * ```
     * 那个群已在库里的消息 → 内容没变 → WHERE 为假 → UPDATE 整条不跑
     *   ⇒ learning_eligible 永远停在 0
     *   ⇒ 学习侧永远看不到它们
     * ```
     *
     * 表现是「我把这个群加进学习范围了，可它的历史消息一条都没学」，
     * 而唯一的出路会变成"删库重采" —— 那正是 v4 要消灭的东西
     * （数据本来就在库里，放宽范围应当立刻生效）。
     *
     * ★ `changed` 非空还有第二层意义：`persistBatch` 只为 `changed` 发
     * changelog seq，所以这一行同时决定"学习侧会不会被叫醒去重算"。
     *
     * 反证：把 upsert 的 WHERE 里那句标签判据删掉 → 这条转红。
     */
    const vault = openTestVault()
    seedConversation(vault)
    const repo = new MessageRepository(vault.db)
    repo.upsertMany([message(1, false)])

    // 同一条消息、同样的内容，只是这一轮它在学习范围内了
    const second = repo.upsertMany([message(1, true)])
    expect(second.changed.map((row) => row.id)).toEqual(["m1"])
    // ★ 取回的是**库里那一行**，标签已经是新值（下游据此写 eligibility）
    expect(second.changed[0]?.learningEligible).toBe(true)
    vault.close()
  })

  it("★★★ 反向：标签 1、传入 0 → **不算**变化（否则每轮重发全部 seq）", () => {
    /**
     * 判据必须是"**结果值**与现有值不同"，不是"传入值与现有值不同"。
     *
     * 写成后者的后果：重叠窗口每轮重采同一批消息，而其中已合格的那些
     * 每轮都被判成"变了" ⇒ 每轮产生一批新 seq ⇒ 下游把全部消息反复
     * 重算（建索引、蒸馏、图谱）。那是文件头警告的那件事，
     * 而它表现为"很贵 + 结论不变"，不报错。
     */
    const vault = openTestVault()
    seedConversation(vault)
    const repo = new MessageRepository(vault.db)
    repo.upsertMany([message(1, true)])

    const second = repo.upsertMany([message(1, false)])
    expect(second.changed).toEqual([])
    expect(second.unchanged).toBe(1)
    vault.close()
  })

  it("★★ 这一批**没算标签**（NULL）时也不算变化 —— 存量行的标签不许被抹掉", () => {
    /**
     * 场景：一条已经标 1 的消息被另一条**没打标**的路径重采
     * （回填 / 单测 / 定向补拉）。那一趟对"资格"没有结论，
     * 所以正确处置是**什么都不改**。
     *
     * ★ 而我第一版写的 `MAX(COALESCE(旧,0), COALESCE(新,0))` 在
     * 「旧 = NULL、新 = NULL」这一格会得到 **0** —— 实测确认过。
     * 也就是存量库里被编辑过的消息会逐条掉出学习语料，且不报错。
     */
    const vault = openTestVault()
    seedConversation(vault)
    const repo = new MessageRepository(vault.db)
    repo.upsertMany([message(1, true)])

    expect(repo.upsertMany([message(1)]).changed).toEqual([])
    expect(repo.recentInConversation("conv1", 10)[0]?.learningEligible).toBe(true)
    vault.close()
  })

  it("★★★ 存量行（NULL）+ 内容被编辑 + 这一批没算标签 → 标签**仍是** NULL", () => {
    /**
     * 这是上一条那个 bug 的**最危险形态**，因为它在存量库上是常态：
     *
     * ```
     * 存量行 le=NULL  →  内容被编辑（WHERE 因内容为真，UPDATE 会跑）
     *   ★ 旧写法：MAX(COALESCE(NULL,0), COALESCE(NULL,0)) = 0
     *   ⇒ NULL（读侧算合格）变成 0（读侧不算合格）
     *   ⇒ 那条消息**掉出**图谱与画像语料，而没人知道
     * ```
     *
     * 反证：把合并规则改回 `MAX(COALESCE(...), COALESCE(...))` → 这条转红。
     */
    const vault = openTestVault()
    seedConversation(vault)
    const repo = new MessageRepository(vault.db)
    repo.upsertMany([message(1)])

    // 内容变了（编辑过的消息），而这一趟没算标签
    repo.upsertMany([{ ...message(1), contentText: "编辑后的内容" }])
    expect(repo.recentInConversation("conv1", 10)[0]?.learningEligible).toBeNull()
    vault.close()
  })
})
