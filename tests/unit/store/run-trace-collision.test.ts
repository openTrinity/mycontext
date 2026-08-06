/**
 * `dh_run_trace` 的行主键必须**按 run 隔离**。
 *
 * ## 这一组锁的是一个已经在真实库里造成数据丢失的 bug
 *
 * 症状：数字分身「历史处理结果」点开「看处理过程」，几乎每一条都显示
 * 「这一轮没有留下过程」。当时的解释是"走了直连降级那条路"—— 而那是错的：
 * 那些轮次**真的走了 ACP、也真的写进过库**，是被后来的轮次**删掉了**。
 *
 * 机制：过程项的 id 由 reducer 的 `newId: (seq) => `${turnId}_${seq}`` 生成，
 * `turnId` 来自 `PersonaAcp.turnSeq` —— 一个**进程内**自增计数器
 * （`persona-acp.ts:225`）。应用一重启它就回到 0，于是新装机的第一轮又叫
 * `turn_1`、它的第一个 item 又叫 `turn_1_1`。而 `dh_run_trace.id` 是
 * PRIMARY KEY，`INSERT OR REPLACE` 于是把**上一次装机那一行整行改嫁**：
 * `run_id` 被改写成新 runId，旧 run 一行不剩。
 *
 * 实测指纹（修复前，两个本机 vault 都对得上）：
 * · 21 轮 run 只剩 13 轮有痕迹，且最新 3 轮的 id 是 `turn_1_1`/`turn_2_1`/`turn_3_1`；
 * · 另一个库里某 run 的 seq 是 2,3,4 —— seq=1 那行被后来的 `turn_1_1` 抢走了。
 *
 * ## ★ 为什么必须按「跨进程重启」来写这条断言
 *
 * 同一个进程内 `turnSeq` 不会重复，所以任何"连续跑两轮"的测试都是绿的
 * —— 这正是它此前没被发现的原因。这里刻意**复用同一个 item id**
 * 去模拟重启，那是真实场景里唯一会发生的那一种。
 *
 * 断言的落点是**旧 run 的痕迹还在**，而不是"新 run 写成功了"：
 * 后者在修复前也是绿的（它抢到了那一行）。
 */
import { describe, expect, it } from "vitest"
import { ConversationRepository, PersonaRunRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = new Date(2026, 6, 1, 15, 0, 0).getTime()

function seed() {
  const vault = openTestVault()
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cidFAKE0001==",
    type: "group",
    title: "测试群",
    memberCount: 5,
    createdAt: NOW,
  })
  return vault
}

/** 建一轮 run —— `dh_run_trace.run_id` 的外键要求它先在。 */
function addRun(runs: PersonaRunRepository, id: string, at: number): void {
  runs.insertRun(
    {
      id,
      conversationId: "conv-1",
      triggerMessageId: null,
      draftText: "回复正文",
      confidence: null,
      decision: "auto_sent",
      decisionReason: null,
      latencyMs: 1200,
      costTokens: 800,
      error: null,
    },
    at,
  )
}

/**
 * 一条过程项。`id` 由调用方给 —— 这一组的全部意义就在于**故意传重复的 id**
 * （模拟应用重启后 turnSeq 归零）。
 */
function traceItem(id: string, text: string, seq = 1) {
  return {
    id,
    seq,
    role: "assistant",
    itemType: "message",
    contentJson: JSON.stringify([{ kind: "text", text }]),
    turnId: id.replace(/_\d+$/, ""),
    createdAt: NOW,
  }
}

describe("dh_run_trace 的行主键按 run 隔离", () => {
  it("★★ 重启后 turnSeq 归零 → 旧 run 的过程**不能**被新 run 顶掉", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    addRun(runs, "run-old", NOW)
    addRun(runs, "run-new", NOW + 1000)

    // 第一次装机的第一轮：reducer 给出 turn_1_1
    runs.appendTrace("run-old", [traceItem("turn_1_1", "旧那一轮想的是这个")])
    // 应用重启，turnSeq 从 0 起 → 又是 turn_1_1（真实场景里唯一会重复的那种）
    runs.appendTrace("run-new", [traceItem("turn_1_1", "新那一轮想的是那个")])

    const old = runs.traceForRun("run-old")
    /**
     * ★ 这一条是整组的核心。修复前它是 0 —— 那一行被 `INSERT OR REPLACE`
     * 改嫁给了 run-new，于是界面上旧那一轮显示"这一轮没有留下过程"，
     * 而它明明留过。
     */
    expect(old).toHaveLength(1)
    expect(old[0]?.contentJson).toContain("旧那一轮想的是这个")

    // 新那一轮也要在（两者共存，不是"换成谁赢"）
    const fresh = runs.traceForRun("run-new")
    expect(fresh).toHaveLength(1)
    expect(fresh[0]?.contentJson).toContain("新那一轮想的是那个")
  })

  it("同一 run 重复落同一个 item → 覆盖而不是长出两行（OR REPLACE 的原意仍在）", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    addRun(runs, "run-1", NOW)

    // 轮末快照写了一次，重试又写了一次（工具状态从 pending 变 success 那种）
    runs.appendTrace("run-1", [traceItem("turn_1_1", "第一版")])
    runs.appendTrace("run-1", [traceItem("turn_1_1", "更完整的那一版")])

    const rows = runs.traceForRun("run-1")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.contentJson).toContain("更完整的那一版")
  })

  it("多个 item 的 run：seq 齐全，不会被别的 run 抢掉中间某一行", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    addRun(runs, "run-old", NOW)
    addRun(runs, "run-new", NOW + 1000)

    runs.appendTrace("run-old", [
      traceItem("turn_1_1", "先想", 1),
      traceItem("turn_1_2", "再查", 2),
      traceItem("turn_1_3", "最后答", 3),
    ])
    // 重启后新那一轮只产一个 item —— 修复前它会精准抢走 seq=1 那行，
    // 于是旧 run 的 seq 变成 2,3（真实库里抓到的正是这个形状）
    runs.appendTrace("run-new", [traceItem("turn_1_1", "新的第一句", 1)])

    expect(runs.traceForRun("run-old").map((row) => row.seq)).toEqual([1, 2, 3])
  })
})
