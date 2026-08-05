/**
 * 蒸馏 runner 的门禁。
 *
 * ## 三条不可退化的性质
 *
 * 1. **切窗幂等** —— 增量蒸馏每轮都会重算"该蒸哪些窗口"，不幂等的话
 *    每轮把同一段重蒸一遍。蒸馏是花钱的，白跑的代价是真实的。
 * 2. **空窗口标 skipped 而不是 done** —— 两者在进度页上必须能区分：
 *    全 skipped 说明"没语料"或"身份没确认"，全 done 说明真蒸出了东西。
 *    混成一种的话"蒸馏完成但画像是空的"看起来就完全正常。
 * 3. **一个任务失败只影响它自己** —— 让一个失败带走整轮的话，
 *    一次限流就等于整次蒸馏白跑。
 *
 * 另外锁"没配 LLM 时抽取型任务**抛错**而不是静默产出 0 条"：
 * 静默的话用户会看到"蒸馏完成，画像里只有作息统计"，
 * 而完全想不到是少配了一个 key。
 */
import { describe, expect, it, vi } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { DistillRunner, ALL_FACETS } from "@mycontext/distill"
import {
  ConversationRepository,
  DistillTaskRepository,
  MessageRepository,
  ProfileFacetRepository,
} from "@mycontext/store"
import { LlmClient } from "@mycontext/llm"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_785_000_000_000
const logger = createLogger("Test", { level: "error" })

/** 造 vault：一个会话 + n 条他人消息 + m 条本人消息。 */
function seed(options: { others: number; selves: number; botChannel?: boolean }) {
  const vault = openTestVault()
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cid-1",
    type: "group",
    title: "沙箱项目群",
    memberCount: 12,
    createdAt: NOW,
  })
  if (options.botChannel === true) {
    vault.db.prepare("UPDATE conversations SET is_bot_channel = 1 WHERE id = 'conv-1'").run()
  }

  // upsertMany 收的是 readonly 数组，所以这里用可变的元素类型自己声明
  const rows: Parameters<MessageRepository["upsertMany"]>[0][number][] = []
  for (let index = 0; index < options.others; index += 1) {
    rows.push({
      id: `o${String(index)}`,
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: `ext-o${String(index)}`,
      senderExternalId: "other",
      senderDisplayName: "小李",
      contentText: `他说第 ${String(index)} 句`,
      sentAt: NOW + index * 60_000,
      direction: "inbound",
      isSelf: false,
      createdAt: NOW,
    })
  }
  for (let index = 0; index < options.selves; index += 1) {
    rows.push({
      id: `s${String(index)}`,
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: `ext-s${String(index)}`,
      senderExternalId: "me",
      senderDisplayName: "我",
      contentText: `我说第 ${String(index)} 句`,
      // 与他人消息交错：让"本人紧跟他人"的时延样本产生
      sentAt: NOW + index * 60_000 + 5000,
      direction: "outbound",
      isSelf: true,
      createdAt: NOW,
    })
  }
  new MessageRepository(vault.db).upsertMany(rows)
  return vault
}

/** 造一个返回固定 JSON 的假 LLM（不打网络）。 */
function fakeLlm(response: string): LlmClient {
  return new LlmClient({
    baseUrl: "https://fake.invalid",
    apiKey: "k",
    model: "m",
    sleep: () => Promise.resolve(),
    fetchImpl: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: response } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        text: () => Promise.resolve(""),
      } as unknown as Response),
  })
}

function makeRunner(
  vault: ReturnType<typeof openTestVault>,
  llm: LlmClient | null,
  ids = (() => {
    let n = 0
    return () => `id-${String(n++)}`
  })(),
) {
  return new DistillRunner({
    db: vault.db,
    clock: new ManualClock(NOW + 30 * 86_400_000),
    logger,
    llm,
    selfNames: ["我"],
    newId: ids,
  })
}

describe("★ 切窗幂等", () => {
  it("同一段时间跑两次 plan → 第二次一个都不新建", () => {
    const vault = seed({ others: 5, selves: 5 })
    const runner = makeRunner(vault, null)
    const until = NOW + 30 * 86_400_000

    const first = runner.plan({ since: NOW, until, windowDays: 7 })
    const second = runner.plan({ since: NOW, until, windowDays: 7 })

    expect(first.created).toBeGreaterThan(0)
    /**
     * ★ 第二次 created 必须是 0。
     * 不幂等的话每一轮增量蒸馏都会把同一段重蒸一遍 —— 真金白银。
     */
    expect(second.created).toBe(0)
    expect(second.total).toBe(first.total)
    vault.close()
  })

  it("每个窗口切出全部 facet（6 个：5 个 LLM + 1 个统计）", () => {
    const vault = seed({ others: 1, selves: 1 })
    const runner = makeRunner(vault, null)
    // 一个 7 天窗口
    runner.plan({ since: NOW, until: NOW + 3 * 86_400_000, windowDays: 7 })
    expect(new DistillTaskRepository(vault.db).progress().total).toBe(ALL_FACETS.length)
    vault.close()
  })

  it("since 为 null 时用库里最早的消息（不是 0 —— 那会切出几十年空窗口）", () => {
    const vault = seed({ others: 3, selves: 3 })
    const runner = makeRunner(vault, null)
    const result = runner.plan({ since: null, until: NOW + 3 * 86_400_000, windowDays: 7 })
    // 消息都在 NOW 附近 → 只该有一个窗口
    expect(result.total).toBe(ALL_FACETS.length)
    vault.close()
  })
})

describe("★ 空窗口标 skipped 而不是 done", () => {
  it("身份未确认（is_self 全 null）→ skipped，且原因说清怎么修", async () => {
    const vault = openTestVault()
    new ConversationRepository(vault.db).upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-1",
      type: "group",
      title: "群",
      memberCount: 3,
      createdAt: NOW,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "m1",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "ext-m1",
        senderExternalId: "someone",
        senderDisplayName: "某人",
        contentText: "有内容",
        sentAt: NOW,
        direction: "inbound",
        // ★ 未判定
        createdAt: NOW,
      },
    ])

    const runner = makeRunner(vault, fakeLlm('{"items":[]}'))
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    const results = await runner.runBatch(10)

    // 全部 skipped（不是 done，也不是 failed）
    expect(results.every((item) => item.state === "skipped")).toBe(true)
    const progress = new DistillTaskRepository(vault.db).progress()
    expect(progress.done).toBe(0)
    expect(progress.skipped).toBe(ALL_FACETS.length)
    /**
     * ★ 原因要**可执行**。
     * 只记"0 条语料"的话用户不知道该做什么；而"去确认身份"是一个动作。
     */
    expect(progress.lastError).toContain("身份未确认")
    vault.close()
  })

  it("机器人群被守卫拒 → skipped（这是预期行为）", async () => {
    const vault = seed({ others: 5, selves: 5, botChannel: true })
    const runner = makeRunner(vault, fakeLlm('{"items":[]}'))
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    const results = await runner.runBatch(10)
    expect(results.every((item) => item.state === "skipped")).toBe(true)
    vault.close()
  })
})

describe("★ 结论真的落库，且证据能验回原文", () => {
  it("LLM 抽出的结论进 profile_facets，证据是真 message_id", async () => {
    const vault = seed({ others: 10, selves: 10 })
    const response = JSON.stringify({
      items: [{ key: "formality", value: "偏随意", confidence: 0.8, evidence: [1, 2] }],
    })
    const runner = makeRunner(vault, fakeLlm(response))
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    await runner.runBatch(10)

    const facets = new ProfileFacetRepository(vault.db)
    const row = facets.find("tone", "global", "", "formality")
    expect(row).not.toBeNull()
    const evidence = JSON.parse(row?.evidenceJson ?? "[]") as string[]
    expect(evidence.length).toBeGreaterThan(0)
    // ★ 证据必须是库里真实存在的 message_id
    const messages = new MessageRepository(vault.db)
    for (const id of evidence) {
      expect(messages.findById(id)).not.toBeNull()
    }
    vault.close()
  })

  it("统计型任务不调 LLM 也能出结论（没配 key 也该有一部分画像）", async () => {
    const vault = seed({ others: 30, selves: 30 })
    const runner = makeRunner(vault, null)
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    const results = await runner.runBatch(10)

    const routines = results.find((item) => item.facet === "routines")
    expect(routines?.state).toBe("done")
    expect(routines?.written).toBeGreaterThan(0)
    // 其余（LLM 型）全 failed —— 见下面那条
    expect(results.filter((item) => item.state === "failed").length).toBeGreaterThan(0)
    vault.close()
  })
})

describe("★ 没配 LLM 时抽取型任务抛错，而不是静默产出 0 条", () => {
  it("failed 而不是 skipped，且原因里有配置项名", async () => {
    const vault = seed({ others: 10, selves: 10 })
    const runner = makeRunner(vault, null)
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    const results = await runner.runBatch(10)

    const tone = results.find((item) => item.facet === "tone")
    /**
     * ★ 必须是 failed。
     * skipped 会与"这段没语料"混在一起，而后者不需要用户做任何事 ——
     * 于是"少配了一个 key"这件事永远不会被发现。
     */
    expect(tone?.state).toBe("failed")
    expect(tone?.error).toContain("LLM")
    vault.close()
  })
})

describe("★ 一个任务失败只影响它自己", () => {
  it("第一个任务抛错，其余照跑", async () => {
    const vault = seed({ others: 10, selves: 30 })
    let call = 0
    const flaky = new LlmClient({
      baseUrl: "https://fake.invalid",
      apiKey: "k",
      model: "m",
      maxRetries: 0,
      sleep: () => Promise.resolve(),
      fetchImpl: () => {
        call += 1
        // 第一次调用返回坏 JSON（解析必抛），之后正常
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  message: {
                    content:
                      call === 1
                        ? "not json at all"
                        : JSON.stringify({
                            items: [{ key: "k", value: "v", confidence: 0.7, evidence: [1] }],
                          }),
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          text: () => Promise.resolve(""),
        } as unknown as Response)
      },
    })

    const runner = makeRunner(vault, flaky)
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    const results = await runner.runBatch(10)

    // 有一个 failed，但也有 done —— 失败没有带走整轮
    expect(results.filter((item) => item.state === "failed")).toHaveLength(1)
    expect(results.filter((item) => item.state === "done").length).toBeGreaterThan(0)
    vault.close()
  })

  it("失败的任务会被 claimBatch 再取到（attempts 未超上限）", async () => {
    const vault = seed({ others: 10, selves: 10 })
    const runner = makeRunner(vault, null)
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    await runner.runBatch(10)

    const tasks = new DistillTaskRepository(vault.db)
    // failed 的还能被取出重试（限流/抖动重试一次通常就好了）
    expect(tasks.claimBatch(10).length).toBeGreaterThan(0)
    vault.close()
  })
})

describe("合并走 mergeFacet（不是覆盖）", () => {
  it("同一个键第二次跑 → 是 update 且留了历史版本", async () => {
    const vault = seed({ others: 10, selves: 10 })
    const facets = new ProfileFacetRepository(vault.db)

    // 第一轮
    const first = makeRunner(
      vault,
      fakeLlm(
        JSON.stringify({
          items: [{ key: "formality", value: "偏随意", confidence: 0.8, evidence: [1] }],
        }),
      ),
    )
    first.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    await first.runBatch(10)
    const before = facets.find("tone", "global", "", "formality")

    // 第二轮：清任务重跑，值变了
    new DistillTaskRepository(vault.db).clear()
    const second = makeRunner(
      vault,
      fakeLlm(
        JSON.stringify({
          items: [{ key: "formality", value: "偏正式", confidence: 0.9, evidence: [2] }],
        }),
      ),
    )
    second.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    await second.runBatch(10)

    const after = facets.find("tone", "global", "", "formality")
    expect(after?.id).toBe(before?.id)
    expect(after?.revision).toBe(2)
    /**
     * 值不同 = 矛盾 → **保留双结论并降置信**，交用户裁决。
     * 自动取新的会让画像随最后一轮蒸馏漂移，而用户永远看不到它变过。
     */
    expect(after?.conflictJson).not.toBeNull()
    expect(facets.revisions(after?.id ?? "")).toHaveLength(1)
    vault.close()
  })

  it("用户手改的结论不会被 LLM 覆盖", async () => {
    const vault = seed({ others: 10, selves: 10 })
    const facets = new ProfileFacetRepository(vault.db)
    facets.write(
      {
        id: "user-1",
        facet: "tone",
        scope: "global",
        scopeRef: "",
        key: "formality",
        value: "用户写的",
        confidence: 1,
        evidence: ["o0"],
        source: "user",
      },
      NOW,
    )

    const runner = makeRunner(
      vault,
      fakeLlm(
        JSON.stringify({
          items: [{ key: "formality", value: "模型写的", confidence: 0.9, evidence: [1] }],
        }),
      ),
    )
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    const results = await runner.runBatch(10)

    /**
     * ★ 没有这条的话，用户在审阅页改完一句话，下一轮蒸馏就把它改回去了 ——
     * 而用户不会再改第二次，他会关掉这个功能。
     */
    expect(JSON.parse(facets.find("tone", "global", "", "formality")?.valueJson ?? '""')).toBe(
      "用户写的",
    )
    expect(results.find((item) => item.facet === "tone")?.skippedByMerge).toBe(1)
    vault.close()
  })
})

describe("时区显式传（统计不能读运行环境）", () => {
  it("offsetMinutes 影响活跃时段直方图", async () => {
    const vault = seed({ others: 5, selves: 30 })
    const spy = vi.fn()
    void spy

    const shanghai = new DistillRunner({
      db: vault.db,
      clock: new ManualClock(NOW + 30 * 86_400_000),
      logger,
      llm: null,
      selfNames: [],
      offsetMinutes: 480,
      newId: (() => {
        let n = 0
        return () => `sh-${String(n++)}`
      })(),
    })
    shanghai.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    await shanghai.runBatch(10)

    const row = new ProfileFacetRepository(vault.db).find("routines", "global", "", "active_hours")
    const value = JSON.parse(row?.valueJson ?? "{}") as { offsetMinutes?: number }
    // 偏移进了结论本身 —— 否则读结论的人无法知道"14 点"是哪个时区的 14 点
    expect(value.offsetMinutes).toBe(480)
    vault.close()
  })
})
