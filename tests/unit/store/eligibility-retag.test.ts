/**
 * ★★★ 范围放宽后必须**立刻** bulk 重打标（v4 Critical #1）。
 *
 * ## 它锁的洞
 *
 * 监听已入库、`learning_eligible = 0` 的历史，在用户把会话加进学习范围后，
 * 若只靠下一轮渠道重采 → upsert，则 `onScopeChanged` 立刻跑的
 * `feed.export()` + `rebuildGraph` 吃的是**缺这批语料**的四件套。
 *
 * 用户看到「重建完成」，以为新会话历史已进图谱 —— 实际要等水位重扫。
 * 这是本仓库典型的「成功 + 数据缺」静默降级。
 *
 * 反证：删掉 `retagLearningEligible` 的调用 / 改成 no-op → 本组转红。
 */
import { describe, expect, it } from "vitest"
import {
  ChangelogRepository,
  ConversationRepository,
  CORPUS_MESSAGE_PREDICATE,
  DistillSourceRepository,
  ELIGIBILITY_BITS,
  MessageRepository,
  retagLearningEligible,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const NOW = 1_785_000_000_000
const A = "cidFAKE0001=="
const B = "cidFAKE0002=="

type Vault = ReturnType<typeof openTestVault>

function seedMessage(
  vault: Vault,
  opts: {
    id: string
    externalConv: string
    learningEligible: boolean | null
    sentAt?: number
  },
): void {
  const conversations = new ConversationRepository(vault.db)
  const convId = `conv-${opts.externalConv}`
  conversations.upsert({
    id: convId,
    channelId: CH,
    externalId: opts.externalConv,
    type: "group",
    title: "测试群",
    createdAt: NOW,
  })
  new MessageRepository(vault.db).upsertMany([
    {
      id: opts.id,
      channelId: CH,
      conversationId: convId,
      externalId: `msg-${opts.id}`,
      senderExternalId: "DFAKE0001",
      senderDisplayName: "张三",
      contentText: `正文 ${opts.id}`,
      contentJson: null,
      quotedExternalId: null,
      sentAt: opts.sentAt ?? NOW,
      direction: "inbound",
      isSelf: false,
      hasMedia: false,
      createdAt: NOW,
      mentions: [],
      media: [],
      ...(opts.learningEligible === null ? {} : { learningEligible: opts.learningEligible }),
    },
  ])
}

function setLearningScope(vault: Vault, conversationIds: string[]): void {
  new DistillSourceRepository(vault.db).upsert(
    "chat",
    { enabled: true, scope: { conversationIds } },
    NOW,
  )
}

function corpusCount(vault: Vault): number {
  return (
    vault.db
      .prepare<
        [],
        { c: number }
      >(`SELECT count(*) AS c FROM messages WHERE ${CORPUS_MESSAGE_PREDICATE}`)
      .get()?.c ?? 0
  )
}

describe("★★★ retagLearningEligible：放宽后不经渠道重拉也能进语料", () => {
  it("★★★ 监听入库标 0 的历史，加进学习白名单后立刻变 1 并进 CORPUS 谓词", () => {
    const vault = openTestVault()
    // 先只学 A；B 的消息以「只因监听入库」的形态落库（标 0）
    setLearningScope(vault, [A])
    seedMessage(vault, { id: "mA", externalConv: A, learningEligible: true })
    seedMessage(vault, { id: "mB", externalConv: B, learningEligible: false })
    expect(corpusCount(vault)).toBe(1)

    // 用户把 B 加进学习范围 —— **不**再走 persist / 渠道拉
    setLearningScope(vault, [A, B])
    const report = retagLearningEligible(vault.db, CH, { now: NOW + 1 })

    expect(report.promoted).toBe(1)
    expect(report.changelogEntries).toBe(1)
    expect(corpusCount(vault)).toBe(2)

    const row = vault.db
      .prepare<
        [],
        { learning_eligible: number | null }
      >("SELECT learning_eligible FROM messages WHERE id = 'mB'")
      .get()
    expect(row?.learning_eligible).toBe(1)

    // ★ 必须写 changelog：否则 FTS / 增量消费者不会被叫醒
    const head = new ChangelogRepository(vault.db).head()
    expect(head).toBeGreaterThan(0)
    const entry = vault.db
      .prepare<
        [],
        { entity_id: string; eligibility: number | null }
      >("SELECT entity_id, eligibility FROM knowledge_changelog WHERE entity_id = 'mB'")
      .get()
    expect(entry?.eligibility).toBe(ELIGIBILITY_BITS.learning)
    vault.close()
  })

  it("★★ 已经是 1 的行不重复晋升、不刷 changelog", () => {
    const vault = openTestVault()
    setLearningScope(vault, [A])
    seedMessage(vault, { id: "mA", externalConv: A, learningEligible: true })
    const first = retagLearningEligible(vault.db, CH, { now: NOW })
    expect(first.promoted).toBe(0)
    const headBefore = new ChangelogRepository(vault.db).head()
    const second = retagLearningEligible(vault.db, CH, { now: NOW + 1 })
    expect(second.promoted).toBe(0)
    expect(new ChangelogRepository(vault.db).head()).toBe(headBefore)
    vault.close()
  })

  it("★★ 不在新白名单里的 0 行保持 0（只增不减，也不乱升）", () => {
    const vault = openTestVault()
    setLearningScope(vault, [A])
    seedMessage(vault, { id: "mB", externalConv: B, learningEligible: false })
    const report = retagLearningEligible(vault.db, CH, { now: NOW })
    expect(report.promoted).toBe(0)
    const row = vault.db
      .prepare<
        [],
        { learning_eligible: number | null }
      >("SELECT learning_eligible FROM messages WHERE id = 'mB'")
      .get()
    expect(row?.learning_eligible).toBe(0)
    vault.close()
  })

  it("★ 超出学习 until 的行不晋升", () => {
    const vault = openTestVault()
    new DistillSourceRepository(vault.db).upsert(
      "chat",
      { enabled: true, scope: { conversationIds: [A], until: NOW } },
      NOW,
    )
    seedMessage(vault, {
      id: "mLate",
      externalConv: A,
      learningEligible: false,
      sentAt: NOW + 60_000,
    })
    expect(retagLearningEligible(vault.db, CH, { now: NOW }).promoted).toBe(0)
    vault.close()
  })
})

describe("★★★ applyScopeChange / 接线：放宽路径必须调用重打标", () => {
  it("★★★ ingest.applyScopeChange 源码里调用了 retagLearningEligible", async () => {
    /**
     * 行为级用例在上面；这一条锁**接线**——函数写了但没挂上 = Critical #1
     * 仍然存在（export/rebuild 仍吃旧标签）。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    expect(src).toContain("retagLearningEligible")
    const at = src.indexOf("applyScopeChange(options:")
    expect(at).toBeGreaterThan(0)
    // ★ 必须在 dryRun 之后、return report 之前
    const body = src.slice(at, at + 3500)
    expect(body).toMatch(/retagLearningEligible\s*\(/)
    expect(body).toContain("dryRun")
  })
})
