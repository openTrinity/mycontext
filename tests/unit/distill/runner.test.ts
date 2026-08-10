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
import { DistillRunner, ALL_FACETS, facetKey } from "@mycontext/distill"
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

  it("每个窗口切出全部 facet（断言用 ALL_FACETS，不写死个数）", () => {
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
      items: [
        {
          key: "triage_steps",
          value: "接到需求先列边界条件问产品",
          confidence: 0.8,
          /**
           * ★ 证据必须落在**本人**的消息上（`#2` = `s0`，见 seed 的交错顺序）。
           *
           * 用 `[1, 2]` 会被 `assertSelfAttributed` 拒掉 —— `#1` 是 `o0`（他人），
           * 而 `workflow` 问的是「**他**怎么做」，所以要求全部证据是本人的。
           * 那道守卫存在的理由见 `guards.ts`：实测有 61 条结论把别人的话
           * 当成了本人的做法。
           */
          evidence: [2],
        },
      ],
    })
    const runner = makeRunner(vault, fakeLlm(response))
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    await runner.runBatch(10)

    const facets = new ProfileFacetRepository(vault.db)
    /**
     * ★★ 按 facet 取，**不按模型给的 key** 取。
     *
     * key 现在由本地词法从正文算出（`reduce/dedupe.facetKey`），模型给的
     * `triage_steps` 不再参与定位 —— 那正是「同一件事每轮一个新 key、
     * 于是 `mergeFacet` 从未触发」那个 bug 的修法。
     */
    const rows = facets.listByFacet("workflow", "global", "")
    expect(rows).toHaveLength(1)
    const row = rows[0]
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

    const workflow = results.find((item) => item.facet === "workflow")
    /**
     * ★ 必须是 failed。
     * skipped 会与"这段没语料"混在一起，而后者不需要用户做任何事 ——
     * 于是"少配了一个 key"这件事永远不会被发现。
     */
    expect(workflow?.state).toBe("failed")
    expect(workflow?.error).toContain("LLM")
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
          items: [
            {
              key: "triage_steps",
              value: "接到需求先列边界条件问产品",
              confidence: 0.8,
              // ★ `#2` = `s0`（本人）—— 见上一个用例里那段说明
              evidence: [2],
            },
          ],
        }),
      ),
    )
    first.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    await first.runBatch(10)
    const before = facets.listByFacet("workflow", "global", "")[0]
    expect(before).toBeDefined()

    /**
     * 第二轮：清任务重跑，值变了。
     *
     * ★ 用**同一句话加一点**而不是完全换一句（原来是「偏正式」）。
     *
     * 这个用例要锁的性质是「同一个维度第二次跑走 update 而不是插新行」，
     * 而定位现在靠**词法相似度**（`reduce/dedupe.findSimilar`）。
     * 完全换词的两句话在新实现下是**两件不同的事**，各占一行 ——
     * 那是刻意的取舍（见 `dedupe.ts`：宁可漏合，误合会让两条真结论
     * 双双降置信而消失）。所以这里给一句改写，它才是这个用例想描述的场景。
     */
    new DistillTaskRepository(vault.db).clear()
    const second = makeRunner(
      vault,
      fakeLlm(
        JSON.stringify({
          items: [
            {
              key: "triage_steps",
              value: "接到需求先列边界条件问产品，再评估范围",
              confidence: 0.9,
              evidence: [4],
            },
          ],
        }),
      ),
    )
    second.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    await second.runBatch(10)

    const rows = facets.listByFacet("workflow", "global", "")
    // ★ 仍然只有一行 —— 这就是「合并真的发生了」
    expect(rows).toHaveLength(1)
    const after = rows[0]
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
    const value = "接到需求先列边界条件问产品"
    facets.write(
      {
        id: "user-1",
        facet: "workflow",
        scope: "global",
        scopeRef: "",
        /**
         * ★ key 用**算出来的**那个（与 runner 同一个函数），不写字面量。
         *
         * runner 现在按词法 key 定位，所以用户那一行必须落在同一个 key 上，
         * 否则这个用例测的是"两行互不相干"而不是"用户手改优先"。
         */
        key: facetKey(value),
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
          // 同一句话（于是命中用户那一行），但模型想把值改掉
          items: [{ key: "triage_steps", value, confidence: 0.9, evidence: [2] }],
        }),
      ),
    )
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    const results = await runner.runBatch(10)

    /**
     * ★ 没有这条的话，用户在审阅页改完一句话，下一轮蒸馏就把它改回去了 ——
     * 而用户不会再改第二次，他会关掉这个功能。
     */
    expect(
      JSON.parse(facets.find("workflow", "global", "", facetKey(value))?.valueJson ?? '""'),
    ).toBe("用户写的")
    expect(results.find((item) => item.facet === "workflow")?.skippedByMerge).toBe(1)
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

/**
 * ★★ facet 集合变更之后，库里按**旧**名字建的任务必须被丢掉。
 *
 * ## 这一组锁的是一个实测踩到的静默失效
 *
 * facet 集合是代码里的常量。本机库里曾有 48 条 pending 任务，facet 名是
 * 换集合**之前**的那套（`identity` / `tone` / `persona` / `expertise` /
 * `relations`）。它们不会自己消失，而留着的后果全都不报错：
 *
 * · 进度条把它们算进 `total`，永远显示"还有 40 个没跑"；
 * · runner 认领到一条之后不知道怎么处理那个 facet；
 * · 而最要命的是**"排空"永远不成立** → `work.md` 永远不产出，日志里一个错都没有。
 */
describe("★★ 陈旧 facet 的任务要被丢掉", () => {
  /** 直接插一条任意 facet 的任务 —— 绕过 runner，那正是"旧版本写的行"的形态。 */
  function insertTask(
    vault: ReturnType<typeof seed>,
    facet: string,
    state: "pending" | "done" | "running" | "failed" | "skipped",
  ): void {
    vault.db
      .prepare(
        `INSERT INTO distill_tasks(id,facet,scope,scope_ref,window_start,window_end,
           state,attempts,created_at,updated_at)
         VALUES(?,?,'global','',?,?,?,0,?,?)`,
      )
      .run(`t-${facet}-${state}`, facet, NOW, NOW + 1000, state, NOW, NOW)
  }

  it("★★ 未完成的旧 facet 任务被删，当前 facet 的不动", () => {
    const vault = seed({ others: 1, selves: 1 })
    for (const facet of ["identity", "tone", "persona", "expertise", "relations"]) {
      insertTask(vault, facet, "pending")
    }
    insertTask(vault, ALL_FACETS[0] ?? "ownership", "pending")

    const tasks = new DistillTaskRepository(vault.db)
    expect(tasks.dropUnknownFacets(ALL_FACETS)).toBe(5)
    // 当前 facet 的那条还在 —— 删多了会把正常任务一起清掉
    expect(tasks.progress().total).toBe(1)
    vault.close()
  })

  /**
   * ★ `done` / `skipped` 是**历史记录**，删掉它们会让"这段语料抽过了"凭空消失，
   * 于是下一轮重抽一遍同一段 —— 那是要花钱的。
   */
  it("★ 已完成的旧 facet 任务保留（那是历史，删了会导致重抽付费）", () => {
    const vault = seed({ others: 1, selves: 1 })
    insertTask(vault, "identity", "done")
    insertTask(vault, "tone", "skipped")
    insertTask(vault, "persona", "pending")

    const tasks = new DistillTaskRepository(vault.db)
    expect(tasks.dropUnknownFacets(ALL_FACETS), "只该删那条 pending").toBe(1)
    expect(tasks.progress().total).toBe(2)
    vault.close()
  })

  it("没有陈旧任务时什么都不做（幂等，可以每次挂载都跑）", () => {
    const vault = seed({ others: 1, selves: 1 })
    const runner = makeRunner(vault, null)
    runner.plan({ since: NOW, until: NOW + 3 * 86_400_000, windowDays: 7 })
    const tasks = new DistillTaskRepository(vault.db)
    const before = tasks.progress().total
    expect(tasks.dropUnknownFacets(ALL_FACETS)).toBe(0)
    expect(tasks.progress().total).toBe(before)
    vault.close()
  })

  /**
   * ★★ 空清单不该清库。
   *
   * 那只可能是调用方传错了（比如 import 出了问题拿到空数组）。按它执行
   * 会把**全部**任务删掉 —— 一次由 bug 触发的静默数据删除。
   */
  it("★★ 传空清单时不删任何东西（防止 import 出错导致清库）", () => {
    const vault = seed({ others: 1, selves: 1 })
    insertTask(vault, "identity", "pending")
    const tasks = new DistillTaskRepository(vault.db)
    expect(tasks.dropUnknownFacets([])).toBe(0)
    expect(tasks.progress().total).toBe(1)
    vault.close()
  })
})

/**
 * ★★ 成本必须是**本任务增量**，不是 client 的生命周期累计。
 *
 * ## 这一组锁的是一次「成本失去度量」的静默失效
 *
 * 原来 runner 记的是 `llm.usage().totalTokens` —— 而那是 `LlmClient` 的累计量
 * （只加不减、从不清零）。实测本机库里的形状：
 *
 * ```
 * routines（纯统计，零模型调用）12 个任务共记 1070 万 token
 * 同一 facet 的任务逐个递增：230891 → 319303 → 458700 → 602428 …
 * sum(cost_tokens) = 4847 万，纯属虚构
 * ```
 *
 * 后果不是报错，而是"这一轮比上一轮省了多少"这个问题**无法回答** ——
 * 而这一层存在的前提就是它贵得需要被盯着（见 `work-refresh.ts` 的攒批判据）。
 */
describe("★★ cost_tokens 是本任务增量", () => {
  it("★★ 纯统计的 routines 记 0（它一次模型都没调）", async () => {
    const vault = seed({ others: 30, selves: 30 })
    // 给一个能用的 llm，确保"记 0"不是因为没有 client
    const runner = makeRunner(vault, fakeLlm('{"items":[]}'))
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    const results = await runner.runBatch(10)
    const routines = results.find((item) => item.facet === "routines")
    expect(routines?.costTokens).toBe(0)
    // 落库的那一行也必须是 0（进度页读的是库，不是这个返回值）
    const row = vault.db
      .prepare(
        "SELECT cost_tokens AS c FROM distill_tasks WHERE facet = 'routines' AND state = 'done'",
      )
      .get() as { c: number | null } | undefined
    expect(row?.c ?? 0).toBe(0)
    vault.close()
  })

  it("★★ 多个抽取任务各记自己的量，而不是逐个递增的累计值", async () => {
    const vault = seed({ others: 10, selves: 10 })
    /**
     * `fakeLlm` 每次回 `total_tokens: 15`，一个 facet 一批 → 每个抽取任务
     * 应当恰好记 15。若读的是 client 累计，它们会是 15 / 30 / 45 / 60 …
     */
    const runner = makeRunner(vault, fakeLlm('{"items":[]}'))
    runner.plan({ since: NOW, until: NOW + 86_400_000, windowDays: 7 })
    const results = await runner.runBatch(10)
    const llmCosts = results
      .filter((item) => item.facet !== "routines")
      .map((item) => item.costTokens)
    expect(llmCosts.length).toBeGreaterThan(1)
    for (const cost of llmCosts) expect(cost).toBe(15)
    vault.close()
  })
})
