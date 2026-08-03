/**
 * 两个 Outbox 消费者的门禁。
 *
 * ## ★ 锁住的核心是"消费者只入队/投递，不处理"
 *
 * 两个消费者都持着租约，而它们下游的工作是**几十秒**的调用
 * （LLM 蒸馏 / agent 生成）。在 handler 里跑会让租约在处理期间过期
 * → 被抢占 → 同一批消息被处理两遍：
 * · 蒸馏：重复花钱；
 * · 数字人：**可能重复发送**（不可逆的社交后果，比花钱严重）。
 *
 * 所以断言 handler 是**同步返回**的（不 await 任何长活儿），
 * 以及它只写队列/任务表而不动结论/草稿。
 *
 * ## required 的取值是相反的，那是刻意的
 *
 * · distill `required: true` —— 落后时不能裁历史（画像语料丢了是永久损失）；
 * · persona `required: false` —— 允许裁（三天前没回的消息现在回也没意义）。
 * 判据是"丢了能不能补回来"。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import {
  ChangelogRepository,
  ConversationRepository,
  DistillTaskRepository,
  MessageRepository,
  PersonaConfigRepository,
  type ChangelogRow,
} from "@mycontext/store"
import { createDistillHandler, DISTILL_CONSUMER_ID, ALL_FACETS } from "@mycontext/distill"
import {
  PersonaSupervisor,
  createPersonaInboxHandler,
  PERSONA_CONSUMER_ID,
} from "@mycontext/persona"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_785_000_000_000
const logger = createLogger("Test", { level: "error" })

/** 造一个 vault，放一个会话与若干条消息，并把变更写进 changelog。 */
function seed(options: {
  messages: { id: string; sentAt: number; isSelf: boolean }[]
  channelId?: "dingtalk" | "feishu"
}) {
  const vault = openTestVault()
  const channelId = options.channelId ?? "dingtalk"
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId,
    externalId: "cid-1",
    type: "group",
    title: "沙箱项目群",
    memberCount: 12,
    createdAt: NOW,
  })
  new MessageRepository(vault.db).upsertMany(
    options.messages.map((item) => ({
      id: item.id,
      channelId,
      conversationId: "conv-1",
      externalId: `ext-${item.id}`,
      senderExternalId: item.isSelf ? "me" : "other",
      senderDisplayName: item.isSelf ? "我" : "小李",
      contentText: "有内容",
      sentAt: item.sentAt,
      direction: item.isSelf ? ("outbound" as const) : ("inbound" as const),
      isSelf: item.isSelf,
      createdAt: NOW,
    })),
  )

  // append 接的是**数组**（批量写是刻意的：与 persistBatch 同一个事务）
  new ChangelogRepository(vault.db).append(
    options.messages.map((item) => ({
      op: "upsert" as const,
      entityType: "message" as const,
      entityId: item.id,
      channelId,
      domain: "chat" as const,
      occurredAt: item.sentAt,
      emittedAt: NOW,
      digest: `d-${item.id}`,
    })),
  )
  return vault
}

function batchOf(vault: ReturnType<typeof openTestVault>): ChangelogRow[] {
  return new ChangelogRepository(vault.db).changesSince(0, 500)
}

describe("★ distill 消费者：只入队，不跑蒸馏", () => {
  it("一批消息落在同一个窗口 → 只入队一组任务（不是每条一组）", () => {
    const vault = seed({
      messages: Array.from({ length: 20 }, (_, index) => ({
        id: `m${String(index)}`,
        // 全部落在同一天 → 同一个 7 天窗口
        sentAt: NOW + index * 60_000,
        isSelf: index % 3 === 0,
      })),
    })
    const handler = createDistillHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      logger,
      newId: (() => {
        let n = 0
        return () => `task-${String(n++)}`
      })(),
    })

    const result = handler(batchOf(vault))
    expect(result.processed).toBe(20)

    /**
     * ★ 一组任务（每个 facet 一个），不是 20 × facet 数。
     *
     * 逐条入队会产生 20×N 次 enqueue（都被幂等挡掉，但白跑那么多次查询）。
     * 更重要的是：窗口如果不对齐，每条消息会算出略微不同的起点，
     * 于是同一段时间被切成无数**重叠**的窗口 —— 那会让蒸馏重复花钱。
     *
     * ★ 从 `ALL_FACETS` 取数而不是写死：facet 集合改过一次（LLM 那半从
     * 「抽整个画像」换成「只抽 forge 测不了的工作维度」），写死的常量
     * 会让这条测试在一次合理的改动后变红，而修法看起来就是"改掉期望值"
     * —— 那会顺手盖住真正的回归（窗口没对齐导致任务数暴涨）。
     */
    const tasks = new DistillTaskRepository(vault.db)
    const progress = tasks.progress()
    expect(progress.total).toBe(ALL_FACETS.length)
    expect(progress.pending).toBe(ALL_FACETS.length)
    vault.close()
  })

  it("窗口按绝对时间对齐：跨窗口的消息产生两组任务", () => {
    const vault = seed({
      messages: [
        { id: "m1", sentAt: NOW, isSelf: false },
        // 往后 10 天 → 必然落到下一个 7 天窗口
        { id: "m2", sentAt: NOW + 10 * 86_400_000, isSelf: false },
      ],
    })
    const handler = createDistillHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      logger,
      newId: (() => {
        let n = 0
        return () => `t-${String(n++)}`
      })(),
    })
    handler(batchOf(vault))
    // 两个窗口 × 每窗一组
    expect(new DistillTaskRepository(vault.db).progress().total).toBe(ALL_FACETS.length * 2)
    vault.close()
  })

  it("★ 重复消费同一批 → 不产生重复任务（幂等）", () => {
    const vault = seed({ messages: [{ id: "m1", sentAt: NOW, isSelf: false }] })
    const handler = createDistillHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      logger,
      newId: (() => {
        let n = 0
        return () => `t-${String(n++)}`
      })(),
    })
    const batch = batchOf(vault)
    handler(batch)
    handler(batch)
    /**
     * 幂等是抢占安全的前提：租约过期后新持有者会从 `acked_seq` **重放**。
     * 不幂等的话每次抢占都把那段时间重蒸一遍。
     */
    expect(new DistillTaskRepository(vault.db).progress().total).toBe(ALL_FACETS.length)
    vault.close()
  })

  it("非 message 与 delete 都跳过（计 skipped，不告警）", () => {
    const vault = seed({ messages: [{ id: "m1", sentAt: NOW, isSelf: false }] })
    new ChangelogRepository(vault.db).append([
      {
        op: "upsert",
        entityType: "minutes",
        entityId: "mn1",
        channelId: "dingtalk",
        domain: "minutes",
        occurredAt: NOW,
        emittedAt: NOW,
        digest: "d-mn1",
      },
      {
        op: "delete",
        entityType: "message",
        entityId: "m1",
        channelId: "dingtalk",
        domain: "chat",
        occurredAt: NOW,
        emittedAt: NOW,
        digest: "d-del",
      },
    ])
    const handler = createDistillHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      logger,
      // 每次不同的 id：常量 id 会撞 distill_tasks 的主键
      newId: (() => {
        let n = 0
        return () => `t-${String(n++)}`
      })(),
    })
    const result = handler(batchOf(vault))
    // 1 条 upsert 处理了，minutes 与 delete 各跳过一条
    expect(result.processed).toBe(1)
    expect(result.skipped).toBe(2)
    vault.close()
  })

  it("★ handler 同步返回（同上：在里面跑蒸馏会让租约过期后被抢占）", () => {
    const vault = seed({ messages: [{ id: "m1", sentAt: NOW, isSelf: false }] })
    const handler = createDistillHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      logger,
      newId: (() => {
        let n = 0
        return () => `t-${String(n++)}`
      })(),
    })
    const result = handler(batchOf(vault))
    expect(result).not.toBeInstanceOf(Promise)
    vault.close()
  })

  it("consumerId 是稳定的字符串（改了等于换了个消费者，游标会从 0 重来）", () => {
    expect(DISTILL_CONSUMER_ID).toBe("distill")
  })
})

describe("★ persona 消费者：只投递，不处理", () => {
  /**
   * 造一个 supervisor，记录 `handleBatch` 与 `tick` 的调用。
   *
   * ★ `batchWindowMs: 0` —— 合并窗口关掉。
   *
   * 不关的话"handler 里偷偷 tick"这件事会被窗口吃掉（tick 拿到空批次），
   * 于是断言"没处理"恒真、恒绿 —— 那条门禁就等于没有。
   * 关掉窗口之后，只要 handler 里调了 tick，`handleBatch` 就会真的被调到。
   */
  function makeSupervisor(vault: ReturnType<typeof openTestVault>) {
    const handled: string[][] = []
    const supervisor = new PersonaSupervisor({
      db: vault.db,
      clock: new ManualClock(NOW),
      logger,
      createAgent: () => Promise.resolve(),
      disposeAgent: () => Promise.resolve(),
      handleBatch: (_conversationId, messageIds) => {
        handled.push([...messageIds])
        return Promise.resolve()
      },
      batchWindowMs: 0,
    })
    return { supervisor, handled }
  }

  it("未监听 → 全部被准入闸拒（默认安全）", () => {
    const vault = seed({ messages: [{ id: "m1", sentAt: NOW, isSelf: false }] })
    const { supervisor, handled } = makeSupervisor(vault)
    const handler = createPersonaInboxHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
    })

    const result = handler(batchOf(vault))
    /**
     * ★ 默认不监听是**安全默认**：数字人以本人身份发消息，
     * 误发的社交成本不可逆。所以"装好就开始替你说话"绝不能是默认行为。
     */
    expect(result.processed).toBe(0)
    expect(result.skipped).toBe(1)
    expect(handled).toHaveLength(0)
    vault.close()
  })

  it("开了监听 + trigger=all → 他人消息被接纳，本人消息仍被拒", () => {
    /**
     * ★ 本人那条排在**前面**，而这个顺序是被测语义要求的。
     *
     * 原来是 `m1`(他人, NOW) → `m2`(本人, NOW+1000`)。后来加了
     * `already_answered` 闸（supervisor.ts：本人在那条消息**之后**发过话
     * 就不必再回），于是 `m1` 被判成"你已经自己回过了" —— 两条全被拒，
     * 用例红。
     *
     * 那个闸本身是对的（它拦的是"用户已经自己答了，数字人还要再答一遍"），
     * 所以要改的是这里的数据：把本人那条挪到前面，`m1` 就是一条
     * **还没被回应**的他人消息 —— 那才是这条用例想验的东西。
     *
     * 顺带把它变成一条更强的断言：`already_answered` 与 `is_self` 是
     * 两个不同的拒因，混在一起时"他人消息被接纳"这半句根本没被验证。
     */
    const vault = seed({
      messages: [
        { id: "m0", sentAt: NOW - 1000, isSelf: true },
        { id: "m1", sentAt: NOW, isSelf: false },
      ],
    })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "all" }, NOW)
    const { supervisor, handled } = makeSupervisor(vault)
    const handler = createPersonaInboxHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
    })

    const result = handler(batchOf(vault))
    // 他人那条被接纳（m1），本人发的不需要数字人回（m0，它代表的就是本人）
    expect(result.processed).toBe(1)
    expect(result.skipped).toBe(1)
    // ★ 仍然没有处理 —— 只是入队
    expect(handled).toHaveLength(0)
    vault.close()
  })

  it("★ 飞书消息不进入钉钉数字分身", () => {
    const vault = seed({
      channelId: "feishu",
      messages: [{ id: "m1", sentAt: NOW, isSelf: false }],
    })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "all" }, NOW)
    const { supervisor } = makeSupervisor(vault)
    const handler = createPersonaInboxHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
      channelIds: ["dingtalk"],
    })

    expect(handler(batchOf(vault))).toEqual({ processed: 0, skipped: 1 })
    vault.close()
  })

  /**
   * ★★ 用户已经自己回过了 → 数字人不该再回（`already_answered`）。
   *
   * 这一条是上面那个 fixture 顺序踩出来的：它原来是"他人消息 + 本人后续
   * 回复"，而那恰好就是 `already_answered` 的形状 —— 但没有任何用例
   * **显式**锁它。补一条，于是那个闸将来被删掉会有东西红。
   */
  it("★ 本人在那条消息之后回过话 → 那条不再入队（already_answered）", () => {
    const vault = seed({
      messages: [
        { id: "m1", sentAt: NOW, isSelf: false },
        // 本人随后自己回了 → 数字人没必要再答一遍
        { id: "m2", sentAt: NOW + 1000, isSelf: true },
      ],
    })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "all" }, NOW)
    const { supervisor, handled } = makeSupervisor(vault)
    const handler = createPersonaInboxHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
    })

    const result = handler(batchOf(vault))
    // 两条都不入队：m1 已被本人回过，m2 是本人自己发的
    expect(result.processed).toBe(0)
    expect(result.skipped).toBe(2)
    expect(handled).toHaveLength(0)
    vault.close()
  })

  /**
   * ★ handler **必须同步返回**（不是 Promise）。
   *
   * 这是"只投递不处理"最可靠的机器可查形式。
   *
   * 前一条断言 `handled` 为空看起来更直接，但它拦不住
   * `void supervisor.tick()` —— 那种写法下 tick 在微任务里跑，
   * 同步断言时 `handled` 仍然是空的，于是门禁恒绿。
   * 而"返回的不是 Promise"这一条，任何在 handler 里 await 长活儿的写法
   * 都会破掉（要么改签名，要么忘了 await 而丢掉租约续期）。
   */
  it("★ handler 同步返回 —— 在里面 await 长活儿会让租约过期", () => {
    const vault = seed({ messages: [{ id: "m1", sentAt: NOW, isSelf: false }] })
    const { supervisor } = makeSupervisor(vault)
    const handler = createPersonaInboxHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
    })
    const result = handler(batchOf(vault))
    expect(result).not.toBeInstanceOf(Promise)
    expect(typeof result.processed).toBe("number")
    vault.close()
  })

  it("★ trigger=mention 且没 @我 → 被拒（这是正确行为，不是 bug）", () => {
    const vault = seed({ messages: [{ id: "m1", sentAt: NOW, isSelf: false }] })
    // 默认 triggerMode 就是 mention
    const { supervisor } = makeSupervisor(vault)
    const handler = createPersonaInboxHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
    })
    expect(handler(batchOf(vault)).processed).toBe(0)
    vault.close()
  })

  it("「@我」从 message_mentions 读（不重新解析正文）", () => {
    const vault = seed({ messages: [{ id: "m1", sentAt: NOW, isSelf: false }] })
    /**
     * 解析在 channels 层做过一次（含花名匹配与全角括号那些边界）。
     * 消费者再解析一遍就有两处定义，早晚不一致 —— 所以它读表。
     */
    vault.db
      .prepare(
        "INSERT INTO message_mentions (message_id, actor_external_id, is_self) VALUES (?, ?, 1)",
      )
      .run("m1", "me")

    const { supervisor } = makeSupervisor(vault)
    const handler = createPersonaInboxHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
    })
    expect(handler(batchOf(vault)).processed).toBe(1)
    vault.close()
  })

  it("kill switch 生效时全部被拒", () => {
    const vault = seed({ messages: [{ id: "m1", sentAt: NOW, isSelf: false }] })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "all" }, NOW)
    const { supervisor } = makeSupervisor(vault)
    supervisor.setKillSwitch(true)
    const handler = createPersonaInboxHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
    })
    expect(handler(batchOf(vault)).processed).toBe(0)
    vault.close()
  })

  it("consumerId 稳定", () => {
    expect(PERSONA_CONSUMER_ID).toBe("persona-inbox")
  })
})
