/**
 * 监听范围**真的门控两条投递路** —— 用真库 + 真 handler 跑一遍。
 *
 * ## ★★★ 为什么这个文件被重写过（上一版有一个致命的形状问题）
 *
 * 上一版的 `routeOne()` 是**把生产代码的判据组合抄了一遍**：它自己读
 * `activeCount`、自己调 `routeToAttention`、自己 `bump`。于是它锁住的是
 * "那三个零件各自能用"，而**不是**"它们真的挂在投递路上了"。
 *
 * 这个区别不是理论上的。当时的事实是：路由只挂在**快通道**
 * （`ingest.service.ts` 的 `inbound.message` 回调）上，而慢兜底
 * （`persona-inbox` 消费者）**整条绕过监听范围** —— `inbox-consumer.ts`
 * 全文零引用 `attention_scope`。那一版的 5 条用例**全绿**，
 * 因为它们一条都没走过真正的投递函数。
 *
 * 而慢兜底恰恰是真机上主要生效的那条：`inbound.message` 只在
 * `backfill !== true` 且 `changed.length > 0` 时 emit，本机历史早已采完
 * （实测 62 个连续页全是 `changed:0 / unchanged:51`）。
 *
 * 所以现在这个文件**直接调 `createPersonaInboxHandler`**（慢兜底的真
 * handler，v4 起是**唯一**的投递入口），断言
 * "范围外的消息没有进 Mailbox"。判据是：**删掉 `deliverMessage` 里的
 * 路由，这些用例必须转红**。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import {
  AttentionCoverageRepository,
  AttentionScopeRepository,
  ChangelogRepository,
  ConversationRepository,
  MessageRepository,
  PersonaConfigRepository,
  toDayBucket,
  type ChangelogRow,
} from "@mycontext/store"
import { PersonaSupervisor, createPersonaInboxHandler } from "@mycontext/persona"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const IN_SCOPE = "cidFAKE0001=="
const OUT_SCOPE = "cidFAKE0002=="
const NOW = 1_785_000_000_000
const logger = createLogger("Test", { level: "error" })

type Vault = ReturnType<typeof openTestVault>

/**
 * 造一个会话 + 一条**他人发的**入向消息，并写进 changelog。
 *
 * ★ `isSelf: false` + 一条更早的本人消息**都不加**：`admit()` 里的
 * `already_answered` 闸会把"本人在这条之后说过话"判成不必再回。这里只要
 * 一条干净的他人消息，让路由成为**唯一**可能的拒因 —— 否则用例绿了也
 * 说不清是路由拦的还是准入拦的。
 */
function seedMessage(
  vault: Vault,
  input: { messageId: string; convExternalId: string; sentAt: number },
): void {
  const convId = `conv-${input.convExternalId}`
  new ConversationRepository(vault.db).upsert({
    id: convId,
    channelId: CH,
    externalId: input.convExternalId,
    type: "group",
    title: "沙箱项目群",
    memberCount: 12,
    createdAt: NOW,
  })
  new MessageRepository(vault.db).upsertMany([
    {
      id: input.messageId,
      channelId: CH,
      conversationId: convId,
      externalId: `ext-${input.messageId}`,
      senderExternalId: "other",
      senderDisplayName: "小李",
      contentText: "有内容",
      sentAt: input.sentAt,
      direction: "inbound",
      isSelf: false,
      createdAt: NOW,
    },
  ])
  new ChangelogRepository(vault.db).append([
    {
      op: "upsert",
      entityType: "message",
      entityId: input.messageId,
      channelId: CH,
      domain: "chat",
      occurredAt: input.sentAt,
      emittedAt: NOW,
      digest: `d-${input.messageId}`,
    },
  ])
  /**
   * ★ `triggerMode: "all"` —— 让准入闸**放行**。
   *
   * 缺省触发模式对群聊是 `mention`，于是一条没 @我 的消息会被 `admit()`
   * 拒掉。那时"范围内的消息被放行"这半句根本没被验证（两侧都是 0），
   * 而这个文件的全部意义正是那半句。
   */
  new PersonaConfigRepository(vault.db).upsert(convId, { triggerMode: "all" }, NOW)
}

/** 造一个只记 `handleBatch` 的 supervisor（合并窗口关掉，见下）。 */
function makeSupervisor(vault: Vault) {
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

function batchOf(vault: Vault): ChangelogRow[] {
  return new ChangelogRepository(vault.db).changesSince(0, 500)
}

function coverageOf(vault: Vault, at: number) {
  return new AttentionCoverageRepository(vault.db).summarize(CH, toDayBucket(at), toDayBucket(at))
}

/** 把一批会话加进监听范围。 */
function watch(vault: Vault, convExternalIds: readonly string[], enabledAt: number): void {
  new AttentionScopeRepository(vault.db).add(
    CH,
    convExternalIds.map((conversationExternalId) => ({ conversationExternalId, enabledAt })),
    NOW,
  )
}

describe("★★★ 慢兜底路径（persona-inbox 消费者）真的过监听范围", () => {
  /**
   * 这一组是本次修复的**核心门禁**。
   *
   * 上一版路由只在快通道，这条路整条绕过范围 —— 而这里的每一条用例
   * 在那一版上都会失败（消息会被投进 Mailbox）。
   */
  function runSlowPath(vault: Vault) {
    const { supervisor, handled } = makeSupervisor(vault)
    const handler = createPersonaInboxHandler({
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
      channelIds: [CH],
    })
    return { result: handler(batchOf(vault)), handled }
  }

  it("★★★ 范围外的新消息 → 慢兜底也拦住，并记 skipped", () => {
    const vault = openTestVault()
    watch(vault, [IN_SCOPE], NOW - 1000)
    seedMessage(vault, { messageId: "msgFAKE01", convExternalId: OUT_SCOPE, sentAt: NOW })

    const { result, handled } = runSlowPath(vault)
    expect(result.processed).toBe(0)
    expect(result.skipped).toBe(1)
    expect(handled).toHaveLength(0)
    // 记账两侧都要有：只记放行的话"范围设窄了"与"没消息"不可区分
    expect(coverageOf(vault, NOW)).toMatchObject({ routed: 0, skipped: 1 })
    vault.close()
  })

  it("★★★ 范围内的新消息 → 慢兜底放行，并记 routed", () => {
    const vault = openTestVault()
    watch(vault, [IN_SCOPE], NOW - 1000)
    seedMessage(vault, { messageId: "msgFAKE02", convExternalId: IN_SCOPE, sentAt: NOW })

    const { result } = runSlowPath(vault)
    expect(result.processed).toBe(1)
    expect(coverageOf(vault, NOW)).toMatchObject({ routed: 1, skipped: 0 })
    vault.close()
  })

  it("★★★ 早于 enabledAt 的消息 → 慢兜底拦住（监听只管实时流）", () => {
    /**
     * 一次历史回填会灌进几万条旧消息，而它们走的**正是**慢兜底
     * （回填路径 `backfill: true` 压根不 emit `inbound.message`）。
     * 没有这条判据时分身会对着三个月前的消息起草回复
     * —— 本仓库实测过 19 天前的群消息被起草。
     *
     * ## ★★ 为什么消息只早 1 分钟，而不是用一条 30 天前的
     *
     * 我第一版写的是 `NOW - 30 天`，用例绿 —— 但**不是路由拦的**：
     * `admit()` 里的 `MAX_GROUP_DRAFTABLE_AGE_MS`（群 24h）会先把它拦掉。
     * 实测：把路由那道 if 改成永真放行之后，这条用例**照样绿** ——
     * 也就是它压根没在验路由，而这个文件的全部意义就是验路由。
     *
     * 改成 1 分钟前（远在 24h 内）之后，`before_enabled_at` 成为**唯一**
     * 可能的拒因，于是"删掉路由 ⇒ 这条必须转红"才成立。
     */
    const vault = openTestVault()
    watch(vault, [IN_SCOPE], NOW)
    const justBefore = NOW - 60_000
    seedMessage(vault, { messageId: "msgFAKE03", convExternalId: IN_SCOPE, sentAt: justBefore })

    const { result, handled } = runSlowPath(vault)
    expect(result.processed).toBe(0)
    expect(handled).toHaveLength(0)
    // ★ 按**消息的业务时间**分桶，不是按记账时刻
    expect(coverageOf(vault, justBefore)).toMatchObject({ skipped: 1 })
    vault.close()
  })

  it("★★ 关掉之后同一会话的新消息 → 慢兜底拦住（收回真的生效）", () => {
    const vault = openTestVault()
    // 再加一个别的会话，保证 activeCount > 0（否则会走"名单为空→放行"）
    watch(vault, [IN_SCOPE, "cidFAKE0009=="], NOW - 1000)
    new AttentionScopeRepository(vault.db).disable(CH, IN_SCOPE, NOW)
    seedMessage(vault, { messageId: "msgFAKE04", convExternalId: IN_SCOPE, sentAt: NOW })

    const { result } = runSlowPath(vault)
    expect(result.processed).toBe(0)
    expect(coverageOf(vault, NOW)).toMatchObject({ skipped: 1 })
    vault.close()
  })

  it("★★★ 名单为空 → 放行（否则是一次静默功能回归）", () => {
    /**
     * 存量用户 `attention_scope` 是空表。判成"什么都不关心"会让分身
     * 整个静默 —— 用户看到"它不理人了"，日志里一个错都没有。
     *
     * ★ 空名单时**不记账**：那时的 routed/skipped 不代表用户配置的效果，
     * 记进去会让"范围设窄了"与"还没配范围"在覆盖面上同形。
     */
    const vault = openTestVault()
    seedMessage(vault, { messageId: "msgFAKE05", convExternalId: OUT_SCOPE, sentAt: NOW })

    const { result } = runSlowPath(vault)
    expect(result.processed).toBe(1)
    expect(coverageOf(vault, NOW)).toMatchObject({ routed: 0, skipped: 0, days: 0 })
    vault.close()
  })
})

describe("★★ 快通道与慢兜底的判据必须一致", () => {
  /**
   * 两条路各写一遍判据的后果是"快通道收了、慢兜底拒了" —— 两边都不报错，
   * 只是行为不同，而这种不一致极难发现。所以这里对**同一条范围外消息**
   * 同时跑两条路，断言两者给出相同的结论。
   *
   * ★ 这条用例是"路由必须放在 `deliverMessage` 里"这个设计决定的门禁：
   * 把路由挪回任何一条路的调用点外面，它就会转红。
   */
  it("★★★ 范围外消息：唯一那条投递路拒掉它（v4 §4）", () => {
    /**
     * ## 这一条这一轮**换了方向**
     *
     * 原来它断言"两条路都拒"（快通道 + 慢兜底）。快通道已删（v4 §4）——
     * 投递只剩 changelog 那一条，于是"两条路会不会分叉"这个风险
     * 从结构上消失了，而这条断言变成"唯一那条真的拦得住"。
     *
     * ★ 那个结构性保证由 `attention-scope.test.ts` 的
     * 「`deliverMessage` 只有一个调用者」锁住；这里锁**行为**。
     */
    const vault = openTestVault()
    watch(vault, [IN_SCOPE], NOW - 1000)
    seedMessage(vault, { messageId: "msgFAKE06", convExternalId: OUT_SCOPE, sentAt: NOW })

    const { supervisor, handled } = makeSupervisor(vault)
    const deps = {
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
      channelIds: [CH],
    }
    expect(createPersonaInboxHandler(deps)(batchOf(vault)).processed).toBe(0)
    expect(handled).toHaveLength(0)
    vault.close()
  })

  it("★★★ `Mailbox` 的 message_id 去重**仍要留**（消费者重放要幂等）", () => {
    /**
     * ## 为什么删掉快通道之后这一条还有意义
     *
     * 去重原来防的是"两条路投同一条"。而它现在防的是**另一件事**：
     * 消费者的租约被抢占后**从 `acked_seq` 重放**（`consumer.ts` 那套），
     * 于是同一批消息会被再投一遍。
     *
     * 去重坏掉的表现是同一条消息被处理两遍 → **可能重复发送**
     * （不可逆的社交后果，比重复花钱严重）。
     *
     * ★ 所以这条断言的形状是"跑两遍同一批，第二遍 processed 为 0"。
     */
    const vault = openTestVault()
    watch(vault, [IN_SCOPE], NOW - 1000)
    seedMessage(vault, { messageId: "msgFAKE07", convExternalId: IN_SCOPE, sentAt: NOW })

    const { supervisor } = makeSupervisor(vault)
    const deps = {
      db: vault.db,
      clock: new ManualClock(NOW),
      supervisor,
      logger,
      channelIds: [CH],
    }
    const handler = createPersonaInboxHandler(deps)
    // ★ 第一遍收下
    expect(handler(batchOf(vault)).processed).toBe(1)
    // ★★ 第二遍（模拟租约抢占后的重放）→ 去重挡住
    expect(handler(batchOf(vault)).processed).toBe(0)
    vault.close()
  })
})
