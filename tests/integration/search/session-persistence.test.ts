/**
 * 搜索会话的持久化与「历史不因 opencode 失效而丢」。
 *
 * ★ 核心场景：opencode 换了机器 / 清了缓存 / 升级导致 acp_session_id 失效，
 *   用户点开老会话**仍能看到全部历史并继续对话**。
 *
 * 这条能成立的唯一原因是 `acp_session_id` 可为空 + UI 渲染读我们的库。
 * 反过来（把 opencode 的 session 当唯一真源）会让「换台机器历史就没了」
 * 变成常态 —— 那是用户完全无法接受也无法理解的。
 */
import { describe, expect, it } from "vitest"
import { SearchSessionRepository } from "@mycontext/store"
import { ChatItemReducer, textBlock } from "@mycontext/agent-runtime"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000

function seedSession(vault: TestVault): SearchSessionRepository {
  const repository = new SearchSessionRepository(vault.db)
  repository.create({
    id: "sess-1",
    acpCwd: "/ws/search/sess-1",
    title: "沙箱环境相关",
    createdAt: START,
  })
  return repository
}

function appendTen(repository: SearchSessionRepository): void {
  repository.appendMessages(
    Array.from({ length: 10 }, (_, index) => ({
      id: `item-${index + 1}`,
      sessionId: "sess-1",
      seq: index + 1,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      itemType: "message",
      contentJson: JSON.stringify([textBlock(`历史消息 ${index}`)]),
      createdAt: START + index,
    })),
  )
}

describe("会话与消息", () => {
  it("创建后可查回，acp_session_id 初始为空", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    const session = repository.findById("sess-1")
    expect(session?.title).toBe("沙箱环境相关")
    // ★ 未建 ACP session 时为空 —— 这不是"坏了"，是正常初态
    expect(session?.acpSessionId).toBeNull()
    expect(session?.state).toBe("idle")
    vault.close()
  })

  it("追加消息后条数同步到会话行（侧栏要显示它）", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    appendTen(repository)
    expect(repository.messageCount("sess-1")).toBe(10)
    expect(repository.findById("sess-1")?.messageCount).toBe(10)
    vault.close()
  })

  it("消息按 seq 排序返回（渲染顺序的唯一依据）", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    // 刻意乱序插入
    repository.appendMessages([
      {
        id: "b",
        sessionId: "sess-1",
        seq: 2,
        role: "assistant",
        itemType: "message",
        contentJson: "[]",
        createdAt: START,
      },
      {
        id: "a",
        sessionId: "sess-1",
        seq: 1,
        role: "user",
        itemType: "message",
        contentJson: "[]",
        createdAt: START,
      },
    ])
    expect(repository.messages("sess-1").map((row) => row.seq)).toEqual([1, 2])
    vault.close()
  })

  it("同 seq 重复写入被吃掉（replay 抑制的第三道防线）", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    appendTen(repository)
    const again = repository.appendMessages([
      {
        id: "different-id",
        sessionId: "sess-1",
        seq: 5,
        role: "assistant",
        itemType: "message",
        contentJson: JSON.stringify([textBlock("重复的")]),
        createdAt: START,
      },
    ])
    expect(again).toBe(0)
    expect(repository.messageCount("sess-1")).toBe(10)
    vault.close()
  })

  it("nextSeq 接续已有最大值（重启后不从 1 覆盖）", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    appendTen(repository)
    expect(repository.nextSeq("sess-1")).toBe(11)
    vault.close()
  })

  it("tool_call 的状态可原地更新（running → success）", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    repository.appendMessages([
      {
        id: "tool-1",
        sessionId: "sess-1",
        seq: 1,
        role: "assistant",
        itemType: "tool_call",
        contentJson: "[]",
        toolName: "mycontext_local_recall",
        toolStatus: "running",
        createdAt: START,
      },
    ])
    repository.updateMessage("tool-1", { toolStatus: "success" })
    expect(repository.messages("sess-1")[0]?.toolStatus).toBe("success")
    vault.close()
  })
})

describe("★ opencode session 失效后历史仍完整", () => {
  it("acp_session_id 被清空，10 条历史一条不少", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    appendTen(repository)
    repository.updateAcpSessionId("sess-1", "acp-abc")

    // 模拟：opencode 换机器 / 清缓存 → 那个 session id 不存在了
    repository.updateAcpSessionId("sess-1", null)

    expect(repository.findById("sess-1")?.acpSessionId).toBeNull()
    // ★ UI 渲染读的是我们的库，所以历史完好
    expect(repository.messages("sess-1").length).toBe(10)
    vault.close()
  })

  it("重建后换成新的 acp id，历史条数不变", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    appendTen(repository)
    repository.updateAcpSessionId("sess-1", "acp-old")
    repository.updateAcpSessionId("sess-1", "acp-new")

    expect(repository.findById("sess-1")?.acpSessionId).toBe("acp-new")
    expect(repository.messages("sess-1").length).toBe(10)
    vault.close()
  })

  /**
   * ★★ 端到端的那条验收：重进会话 + opencode replay 全部历史 →
   * 落库条数仍是 10（不是 20）。
   *
   * 这里把 reducer 与仓储接起来测，因为「reducer 抑制了」与
   * 「库里没多出行」是两件事 —— 中间还有一层 appendMessages。
   */
  it("★ 重进会话后 opencode replay 全部历史，库里仍是 10 行", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    appendTen(repository)

    // 用库里已有的历史预热 reducer 的去重集合
    const history = repository.messages("sess-1").map((row) => ({
      role: row.role,
      content: JSON.parse(row.contentJson) as { kind: "text"; text: string }[],
    }))
    const reducer = new ChatItemReducer({
      startSeq: repository.nextSeq("sess-1"),
      newId: (seq) => `new-item-${seq}`,
      now: () => START,
    })
    reducer.primeFromHistory(history)

    // 重进会话：抑制窗口内 opencode 把 10 条历史以 chunk 推回来
    const endSuppression = reducer.beginReplaySuppression()
    for (const item of history) {
      const first = item.content[0]
      reducer.apply([
        { type: "text_delta", turnId: "replay", text: first?.text ?? "" },
        { type: "turn_end", turnId: "replay" },
      ])
    }
    endSuppression()

    // reducer 一条都没产出 → 没有东西要落库
    const produced = reducer.snapshot()
    expect(produced.length).toBe(0)
    repository.appendMessages(
      produced.map((item) => ({
        id: item.id,
        sessionId: "sess-1",
        seq: item.seq,
        role: item.role,
        itemType: item.itemType,
        contentJson: JSON.stringify(item.content),
        createdAt: item.createdAt,
      })),
    )

    // ★ 仍然是 10 行
    expect(repository.messageCount("sess-1")).toBe(10)
    vault.close()
  })
})

describe("侧栏列表", () => {
  it("置顶的排在前面，其余按最近活跃", () => {
    const vault = openTestVault()
    const repository = new SearchSessionRepository(vault.db)
    for (const [id, at] of [
      ["old", START],
      ["recent", START + 10_000],
      ["pinned", START - 10_000],
    ] as const) {
      repository.create({ id, acpCwd: `/ws/${id}`, createdAt: at })
      repository.setState(id, "idle", at)
    }
    repository.setPinned("pinned", true)

    expect(repository.listActive().map((row) => row.id)).toEqual(["pinned", "recent", "old"])
    vault.close()
  })

  it("归档的不在列表里（但数据还在，用户可能只是想挪走）", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    repository.archive("sess-1", START + 1000)
    expect(repository.listActive()).toEqual([])
    expect(repository.findById("sess-1")).not.toBeNull()
    vault.close()
  })

  it("删除会话级联删掉消息（不留孤儿）", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    appendTen(repository)
    repository.remove("sess-1")
    expect(repository.findById("sess-1")).toBeNull()
    expect(repository.messages("sess-1")).toEqual([])
    vault.close()
  })

  it("重命名生效", () => {
    const vault = openTestVault()
    const repository = seedSession(vault)
    repository.rename("sess-1", "改了个名字")
    expect(repository.findById("sess-1")?.title).toBe("改了个名字")
    vault.close()
  })
})
