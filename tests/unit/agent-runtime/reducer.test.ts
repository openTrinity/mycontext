/**
 * ChatItem 归约与 replay 抑制。
 *
 * ★ 最重要的一条：**重进一个已有 10 条消息的会话后，落库行数仍是 10。**
 *
 * 实测 opencode 的 `loadSession` 末尾会 `replayMessages()` 把该 session 的
 * **全部**历史以 `*_chunk` 通知推回来。我们的 UI 读自己的库，
 * 不抑制的话历史会翻倍 —— 而这是「功能看起来正常，只是数据重复」的静默失效。
 */
import { describe, expect, it } from "vitest"
import { ChatItemReducer, textBlock, toPlainText, type AgentEvent } from "@mycontext/agent-runtime"

/**
 * 时钟每次读都 +1ms —— 所以默认 5s 宽限期在单测里不会自然超时。
 * 需要"宽限期已过"的用例传 `replayGraceMs: 0`。
 */
function makeReducer(startSeq = 1, replayGraceMs?: number) {
  let now = 1_700_000_000_000
  return new ChatItemReducer({
    startSeq,
    newId: (seq) => `item-${seq}`,
    now: () => {
      now += 1
      return now
    },
    ...(replayGraceMs === undefined ? {} : { replayGraceMs }),
  })
}

function textEvents(turnId: string, texts: readonly string[]): AgentEvent[] {
  return texts.map((text) => ({ type: "text_delta" as const, turnId, text }))
}

describe("流式归约", () => {
  it("同一 turn 的连续 delta 落在同一个 item 上", () => {
    const reducer = makeReducer()
    reducer.apply(textEvents("t1", ["沙箱", "环境", "部署完成"]))
    const items = reducer.snapshot()
    expect(items.length).toBe(1)
    expect(items[0]?.content).toEqual([textBlock("沙箱环境部署完成")])
  })

  it("turn_end 后新的 delta 开新 item（不会粘到上一轮）", () => {
    const reducer = makeReducer()
    reducer.apply(textEvents("t1", ["第一轮"]))
    reducer.apply([{ type: "turn_end", turnId: "t1" }])
    reducer.apply(textEvents("t1", ["第二轮"]))
    expect(reducer.snapshot().length).toBe(2)
  })

  it("thought 与 message 互斥（思考不该出现在答案里）", () => {
    const reducer = makeReducer()
    reducer.apply([
      { type: "thought_delta", turnId: "t1", text: "让我想想" },
      { type: "text_delta", turnId: "t1", text: "答案是" },
    ])
    const items = reducer.snapshot()
    expect(items.map((item) => item.itemType)).toEqual(["thought", "message"])
  })

  it("turn_end 记账 token 用量", () => {
    const reducer = makeReducer()
    reducer.apply(textEvents("t1", ["答案"]))
    reducer.apply([
      { type: "turn_end", turnId: "t1", usage: { inputTokens: 100, outputTokens: 20 } },
    ])
    expect(reducer.snapshot()[0]?.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
  })
})

describe("工具调用", () => {
  it("call → result 更新同一个 item 的状态", () => {
    const reducer = makeReducer()
    reducer.apply([
      { type: "tool_call", turnId: "t1", callId: "c1", toolName: "mycontext_local_recall" },
    ])
    expect(reducer.snapshot()[0]?.toolStatus).toBe("running")

    reducer.apply([
      { type: "tool_result", turnId: "t1", callId: "c1", status: "success", summary: "命中 3 条" },
    ])
    const items = reducer.snapshot()
    expect(items.length).toBe(1)
    expect(items[0]?.toolStatus).toBe("success")
    expect(items[0]?.toolName).toBe("mycontext_local_recall")
  })

  /**
   * ★ label 把通道名换成动作描述。
   *
   * opencode 在 `tool_call` 那步只给通道名（一律 `bash`），动作描述要到
   * `tool_call_update` 才有。不回填的话界面上是一列 `bash / bash / bash`。
   */
  it("result 带 label → 覆盖通道名为动作描述", () => {
    const reducer = makeReducer()
    reducer.apply([{ type: "tool_call", turnId: "t1", callId: "c1", toolName: "bash" }])
    expect(reducer.snapshot()[0]?.toolName).toBe("bash")

    reducer.apply([
      {
        type: "tool_result",
        turnId: "t1",
        callId: "c1",
        status: "success",
        label: "Query kl for today's dinner discussion",
      },
    ])
    expect(reducer.snapshot()[0]?.toolName).toBe("Query kl for today's dinner discussion")
  })

  it("label 与现名相同时不改（同名覆盖等于白写）", () => {
    const reducer = makeReducer()
    reducer.apply([{ type: "tool_call", turnId: "t1", callId: "c1", toolName: "bash" }])
    reducer.apply([
      { type: "tool_result", turnId: "t1", callId: "c1", status: "success", label: "bash" },
    ])
    expect(reducer.snapshot()[0]?.toolName).toBe("bash")
  })

  it("没有 label 时保留原工具名", () => {
    const reducer = makeReducer()
    reducer.apply([
      { type: "tool_call", turnId: "t1", callId: "c1", toolName: "mycontext_kl_query" },
    ])
    reducer.apply([{ type: "tool_result", turnId: "t1", callId: "c1", status: "success" }])
    expect(reducer.snapshot()[0]?.toolName).toBe("mycontext_kl_query")
  })

  /**
   * 乱序：result 先于 call 到达（网络乱序）。
   * 丢弃 result 是错的 —— 那会让"工具跑过了"这件事永久不可见。
   */
  it("result 先到时建占位项，call 到了补工具名", () => {
    const reducer = makeReducer()
    reducer.apply([{ type: "tool_result", turnId: "t1", callId: "c1", status: "error" }])
    expect(reducer.snapshot().length).toBe(1)
    expect(reducer.snapshot()[0]?.toolStatus).toBe("error")

    reducer.apply([
      { type: "tool_call", turnId: "t1", callId: "c1", toolName: "mycontext_kl_query" },
    ])
    const items = reducer.snapshot()
    expect(items.length).toBe(1)
    expect(items[0]?.toolName).toBe("mycontext_kl_query")
    // 状态不被 call 覆盖回 running
    expect(items[0]?.toolStatus).toBe("error")
  })

  it("多个工具调用各自独立", () => {
    const reducer = makeReducer()
    reducer.apply([
      { type: "tool_call", turnId: "t1", callId: "c1", toolName: "a" },
      { type: "tool_call", turnId: "t1", callId: "c2", toolName: "b" },
      { type: "tool_result", turnId: "t1", callId: "c2", status: "success" },
    ])
    const items = reducer.snapshot()
    expect(items.length).toBe(2)
    expect(items.find((item) => item.toolName === "c1")).toBeUndefined()
    expect(items.find((item) => item.toolName === "b")?.toolStatus).toBe("success")
    expect(items.find((item) => item.toolName === "a")?.toolStatus).toBe("running")
  })
})

describe("取消守卫", () => {
  it("取消后到达的事件全部丢弃", () => {
    const reducer = makeReducer()
    reducer.apply(textEvents("t1", ["开始"]))
    reducer.cancelTurn("t1")
    reducer.apply(textEvents("t1", ["这段不该出现"]))

    const items = reducer.snapshot()
    expect(items.length).toBe(1)
    expect(items[0]?.content).toEqual([textBlock("开始")])
  })

  it("取消一个 turn 不影响其它 turn", () => {
    const reducer = makeReducer()
    reducer.cancelTurn("t1")
    reducer.apply(textEvents("t1", ["丢弃"]))
    reducer.apply(textEvents("t2", ["保留"]))
    expect(reducer.snapshot().length).toBe(1)
  })
})

describe("★ replay 抑制窗口", () => {
  it("窗口内的事件不产生 item（只校对不落库）", () => {
    const reducer = makeReducer()
    const end = reducer.beginReplaySuppression()
    reducer.apply(textEvents("t1", ["历史消息"]))
    expect(reducer.snapshot()).toEqual([])
    expect(reducer.suppressed).toBeGreaterThan(0)
    end()
  })

  it("窗口结束后恢复正常落库", () => {
    const reducer = makeReducer()
    const end = reducer.beginReplaySuppression()
    reducer.apply(textEvents("t1", ["历史"]))
    end()
    reducer.apply(textEvents("t2", ["新消息"]))
    expect(reducer.snapshot().length).toBe(1)
  })

  it("嵌套窗口：内层结束不会提前把外层关掉（resume 失败后立刻 load）", () => {
    const reducer = makeReducer()
    const outer = reducer.beginReplaySuppression()
    const inner = reducer.beginReplaySuppression()
    inner()
    expect(reducer.inReplayWindow).toBe(true)
    outer()
    expect(reducer.inReplayWindow).toBe(false)
  })

  it("重复调用 end 是幂等的（不会把计数减到负）", () => {
    const reducer = makeReducer()
    const end = reducer.beginReplaySuppression()
    end()
    end()
    expect(reducer.inReplayWindow).toBe(false)
  })

  /**
   * ★★ 这是需求验收里的那条断言。
   *
   * 场景：库里已有 10 条消息，用户重进会话 → opencode replay 全部历史。
   * 断言：新落库的 item 数为 **0**（不是 10，也不是 20）。
   */
  it("★ 重进已有 10 条消息的会话后，新增落库行数为 0", () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      role: "assistant",
      content: [textBlock(`历史消息 ${index}`)],
    }))

    const reducer = makeReducer(11) // 从第 11 条开始
    reducer.primeFromHistory(history)

    // 模拟 replay：opencode 把 10 条历史以 chunk 形式推回来
    const end = reducer.beginReplaySuppression()
    for (const item of history) {
      const first = item.content[0]
      reducer.apply([
        {
          type: "text_delta",
          turnId: `replay-${item.content.length}`,
          text: first !== undefined && first.kind === "text" ? first.text : "",
        },
        { type: "turn_end", turnId: `replay-${item.content.length}` },
      ])
    }
    end()

    expect(reducer.snapshot().length).toBe(0)
  })

  /**
   * 第二道防线：抑制窗口**关闭后**才到达的 replay 尾巴。
   *
   * `UNIQUE(session_id, seq)` 只防同 seq，不防"同内容换新 seq"——
   * 所以窗口关闭后的**宽限期**内还要与历史内容比对一次。
   */
  it("宽限期内到达的同内容事件仍被挡住（replay 尾巴）", () => {
    const reducer = makeReducer()
    reducer.primeFromHistory([{ role: "assistant", content: [textBlock("已经有的内容")] }])
    // 真实流程：primeFromHistory → 进抑制窗口做 resume/load → 关窗
    reducer.beginReplaySuppression()()

    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "已经有的内容" },
      { type: "turn_end", turnId: "t1" },
    ])
    expect(reducer.snapshot().length).toBe(0)

    // 不同内容仍然正常落库
    reducer.apply([{ type: "text_delta", turnId: "t2", text: "全新的内容" }])
    expect(reducer.snapshot().length).toBe(1)
  })

  /**
   * ★ 逐 delta 的 replay 也必须被 primeFromHistory 挡住。
   *
   * 修复前：`primeFromHistory` 存的是**整句** hash，而 replay 是逐 delta 回来的，
   * 首个 delta 的 hash 与整句 hash 对不上 → 实测 replay 一条历史消息照样落库
   * （suppressed=0）。文件头承诺的「重进后库里行数不变」在流式路径下不成立。
   * 修复后：判定在 turn_end 定稿时做，此时内容已拼完整，能与整句 hash 对上。
   */
  it("★ 历史消息以多个 delta 形式 replay 回来时仍被挡住", () => {
    const reducer = makeReducer()
    reducer.primeFromHistory([{ role: "assistant", content: [textBlock("好的，已处理")] }])
    reducer.beginReplaySuppression()()

    // replay 是逐 delta 的：单个 delta 的 hash 与整句 hash 对不上
    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "好的" },
      { type: "text_delta", turnId: "t1", text: "，已处理" },
      { type: "turn_end", turnId: "t1" },
    ])

    expect(reducer.snapshot().length).toBe(0)
    expect(reducer.suppressed).toBeGreaterThan(0)
  })

  /**
   * ★★ 警戒期内被挡下的 item **从未外泄**，所以调用方不需要回滚。
   *
   * 上一版的做法是先按 delta 进 `touched`（调用方据此增量渲染与写库）、
   * 定稿判重后再通过 `retracted` 要求调用方回滚 —— 而全仓库**没有任何消费者**
   * 实现那个回滚，接线者一漏就会留下孤儿行。
   *
   * 现在警戒期内的流式 item 定稿前不进 `touched`：判为 replay 就直接消失，
   * 判为新内容就在定稿那一批整条放出。
   */
  it("★ 警戒期内被挡下的 item 从未出现在 touched 里（无需回滚）", () => {
    const reducer = makeReducer()
    reducer.primeFromHistory([{ role: "assistant", content: [textBlock("好的，已处理")] }])
    reducer.beginReplaySuppression()()

    // 第一批：delta 到达 —— 警戒期内**不外泄**（定稿前调用方看不到）
    const streaming = reducer.apply([{ type: "text_delta", turnId: "t1", text: "好的" }])
    expect(streaming.touched).toEqual([])

    // 第二批：补完 + 定稿 → 判为 replay，整条丢弃
    const finalized = reducer.apply([
      { type: "text_delta", turnId: "t1", text: "，已处理" },
      { type: "turn_end", turnId: "t1" },
    ])
    expect(finalized.touched).toEqual([])
    expect(reducer.snapshot().length).toBe(0)
    // retracted 仅作可观测（调用方可忽略）
    expect(finalized.retracted.length).toBe(1)
  })

  /** 警戒期内的**新**内容要在定稿那一批整条放出，不能一起被扣住不放。 */
  it("警戒期内的新内容在定稿时整条放出", () => {
    const reducer = makeReducer()
    reducer.primeFromHistory([{ role: "assistant", content: [textBlock("旧的")] }])
    reducer.beginReplaySuppression()()

    expect(reducer.apply([{ type: "text_delta", turnId: "t1", text: "全新" }]).touched).toEqual([])
    const finalized = reducer.apply([
      { type: "text_delta", turnId: "t1", text: "的内容" },
      { type: "turn_end", turnId: "t1" },
    ])
    expect(finalized.touched.length).toBe(1)
    expect(finalized.touched[0]?.content).toEqual([textBlock("全新的内容")])
  })

  /**
   * ★★★ 本轮**我们自己发起**的 turn 必须逐 delta 立刻外泄，不受宽限期拖累。
   *
   * 这条守的是一个真实的"看起来很慢"的 bug：每一轮（第 2 轮起）都要先
   * `session/resume`，而 resume 的抑制窗口一关就进入 5s 宽限期；紧接着（几毫秒内）
   * 就发 `session/prompt`。于是**本轮真实答案的前 5 秒流式输出全被扣在警戒期里**
   * ——用户发完问题要干等十几秒才看到第一个动静（叠加模型自身约 3.8s 首字延迟），
   * 主观上就是"卡住了/内容被截断"。
   *
   * 而这段扣留是**没有必要**的：警戒期的假设是"这些字大概率是历史回放"，
   * 可一旦我们已经为这个 turn 发出了 prompt，它的输出定义上就是新内容，不可能是
   * replay。`beginTurn(turnId)` 就是把这个事实告诉 reducer。
   */
  it("★ beginTurn 标记的 turn 在宽限期内也逐 delta 立刻外泄", () => {
    const reducer = makeReducer()
    reducer.primeFromHistory([{ role: "assistant", content: [textBlock("上一轮的答案")] }])
    // resume 的抑制窗口开→关，宽限期开始计时
    reducer.beginReplaySuppression()()

    // 我们为 t2 发出了 prompt —— 它的输出不可能是 replay
    reducer.beginTurn("t2")

    // 首个 delta 就该外泄（这正是"首字延迟"消失的地方）
    const first = reducer.apply([{ type: "text_delta", turnId: "t2", text: "新" }])
    expect(first.touched.length).toBe(1)
    expect(first.touched[0]?.content).toEqual([textBlock("新")])

    // 后续 delta 继续增量外泄
    const second = reducer.apply([{ type: "text_delta", turnId: "t2", text: "答案" }])
    expect(second.touched.length).toBe(1)
    expect(second.touched[0]?.content).toEqual([textBlock("新答案")])
  })

  /**
   * ★ 但 beginTurn 只豁免**那一个** turn —— 同期到达的 replay 尾巴仍要被挡。
   *
   * 这是上一条的对偶：豁免不能变成"把警戒期整个关掉"，否则 resume 的历史尾巴
   * 又会重新落库（那是宽限期存在的唯一理由）。
   */
  it("★ beginTurn 不豁免其它 turn：同期的 replay 尾巴仍被挡住", () => {
    const reducer = makeReducer()
    reducer.primeFromHistory([{ role: "assistant", content: [textBlock("历史内容")] }])
    reducer.beginReplaySuppression()()
    reducer.beginTurn("t2")

    // 旧 turn（resume 的尾巴）—— 仍走警戒期那套：定稿判重后整条丢弃
    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "历史内容" },
      { type: "turn_end", turnId: "t1" },
    ])
    // 本轮的新内容照常外泄
    reducer.apply([
      { type: "text_delta", turnId: "t2", text: "本轮答案" },
      { type: "turn_end", turnId: "t2" },
    ])

    const kept = reducer.snapshot().map((i) => i.content)
    expect(kept).toEqual([[textBlock("本轮答案")]])
  })

  /**
   * ★★★ 警戒期**之外**的重复回复必须完整保留。
   *
   * 这是上一版引入的回归：内容 hash 去重原先是永久且全局的，
   * 实测两轮各自完整回复「收到」→ 第二条被 retract、snapshot 只剩 1 条。
   * 而「收到 / 好的 / 知道了 / 嗯」是中文对话里对**不同问题**的正常重复回复，
   * 它们永久消失，用户只看到"这次没回我"。
   */
  it("★ 警戒期外两轮完整重复的回复都保留（不是 replay，是正常重复）", () => {
    // replayGraceMs: 0 → 窗口一关就退出警戒期
    const reducer = makeReducer(1, 0)
    reducer.beginReplaySuppression()()

    for (const turnId of ["t1", "t2"]) {
      reducer.apply([
        { type: "text_delta", turnId, text: "收到" },
        { type: "turn_end", turnId },
      ])
    }

    const texts = reducer
      .snapshot()
      .map((item) => item.content.map((b) => (b.kind === "text" ? b.text : "")).join(""))
    expect(texts).toEqual(["收到", "收到"])
    expect(reducer.suppressed).toBe(0)
  })

  /** 从未进过抑制窗口时也不去重（没有 replay 就没有要挡的东西）。 */
  it("从未 replay 过时，重复内容照常落库", () => {
    const reducer = makeReducer()
    reducer.primeFromHistory([{ role: "assistant", content: [textBlock("嗯")] }])

    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "嗯" },
      { type: "turn_end", turnId: "t1" },
    ])
    expect(reducer.snapshot().length).toBe(1)
  })

  /**
   * 历史里有两条相同内容时，replay 回来的两条都该被挡住吗？——**不**。
   *
   * 库里本来就有两条，挡掉两条才对；挡一条会让我们比库里少一条。
   * 所以 `matchedHistoryHashes` 记的是"这条历史已被匹配过"，
   * 而 primeFromHistory 用 Set 存 hash → 相同内容只有一个条目。
   * 这条用例钉住的是**当前行为**：同内容的第二次 replay 会被放行落库。
   * 这是刻意的取舍 —— 放行的代价是偶尔多一行，挡掉的代价是少一行本人说过的话。
   */
  it("同内容的第二次 replay 被放行（宁可多一行，不可少一行）", () => {
    const reducer = makeReducer()
    reducer.primeFromHistory([{ role: "assistant", content: [textBlock("重复的历史")] }])
    reducer.beginReplaySuppression()()

    for (const turnId of ["r1", "r2"]) {
      reducer.apply([
        { type: "text_delta", turnId, text: "重复的历史" },
        { type: "turn_end", turnId },
      ])
    }
    expect(reducer.snapshot().length).toBe(1)
  })
})

/**
 * ★ 流式首 delta 不参与去重 —— 中文高频开头的回归防线。
 *
 * 修复前 `emit()` 对**第一个** text_delta 就做内容 hash 去重，
 * 实测 t1="好的"+"，已处理"、t2="好的"+"，明天发布" → 第二轮输出「，明天发布」，
 * 「好的」被判成重复丢掉（suppressed=1）。
 * 「好的 / 嗯 / 是的 / 收到」是中文极高频开头，这个 bug 稳定复现且极难归因
 * （用户只看到回复缺了头两个字）。
 */
describe("★ 首 delta 不被去重（中文高频开头）", () => {
  it("两轮回复以相同的字开头时，第二轮完整保留", () => {
    const reducer = makeReducer()
    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "好的" },
      { type: "text_delta", turnId: "t1", text: "，已处理" },
      { type: "turn_end", turnId: "t1" },
    ])
    reducer.apply([
      { type: "text_delta", turnId: "t2", text: "好的" },
      { type: "text_delta", turnId: "t2", text: "，明天发布" },
      { type: "turn_end", turnId: "t2" },
    ])

    const texts = reducer
      .snapshot()
      .map((item) => item.content.map((b) => (b.kind === "text" ? b.text : "")).join(""))
    expect(texts).toEqual(["好的，已处理", "好的，明天发布"])
    expect(reducer.suppressed).toBe(0)
  })

  it("多轮共用同一个开头（嗯/收到）都不丢字", () => {
    const reducer = makeReducer()
    const replies = ["嗯，我看下", "嗯，已经改好了", "嗯，明天同步"]
    replies.forEach((reply, index) => {
      reducer.apply([
        { type: "text_delta", turnId: `t${index}`, text: "嗯" },
        { type: "text_delta", turnId: `t${index}`, text: reply.slice(1) },
        { type: "turn_end", turnId: `t${index}` },
      ])
    })

    const texts = reducer
      .snapshot()
      .map((item) => item.content.map((b) => (b.kind === "text" ? b.text : "")).join(""))
    expect(texts).toEqual(replies)
  })

  /**
   * 整句完全相同的**历史 replay** 仍然要被挡住（挡 replay 的能力没被削弱）。
   *
   * 与上面「警戒期外重复回复都保留」成对：差别不是"内容一不一样"，
   * 而是**这条内容在不在历史里、现在是不是警戒期**。
   */
  it("警戒期内 replay 一条历史整句时仍被挡住（只放开正常重复）", () => {
    const reducer = makeReducer()
    reducer.primeFromHistory([{ role: "assistant", content: [textBlock("好的，已处理")] }])
    reducer.beginReplaySuppression()()

    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "好的" },
      { type: "text_delta", turnId: "t1", text: "，已处理" },
      { type: "turn_end", turnId: "t1" },
    ])

    expect(reducer.snapshot().length).toBe(0)
    expect(reducer.suppressed).toBe(1)
  })
})

describe("其它事件类型", () => {
  it("plan 渲染成勾选列表", () => {
    const reducer = makeReducer()
    reducer.apply([
      {
        type: "plan",
        turnId: "t1",
        entries: [
          { text: "查本地索引", done: true },
          { text: "查图谱", done: false },
        ],
      },
    ])
    const item = reducer.snapshot()[0]
    expect(item?.itemType).toBe("plan")
    const first = item?.content[0]
    expect(first !== undefined && first.kind === "text" ? first.text : "").toContain(
      "[x] 查本地索引",
    )
  })

  it("citation 产生可点的引用块", () => {
    const reducer = makeReducer()
    reducer.apply([{ type: "citation", turnId: "t1", ordinal: 1, label: "沙箱项目群" }])
    expect(reducer.snapshot()[0]?.content[0]).toEqual({
      kind: "citation",
      ordinal: 1,
      label: "沙箱项目群",
    })
  })

  it("error 作为 system item（与 assistant 正文区分开）", () => {
    const reducer = makeReducer()
    reducer.apply([{ type: "error", turnId: "t1", message: "模型不可用" }])
    const item = reducer.snapshot()[0]
    expect(item?.itemType).toBe("error")
    expect(item?.role).toBe("system")
  })
})

describe("序号", () => {
  it("从 startSeq 开始递增（接续库里已有的最大 seq）", () => {
    const reducer = makeReducer(42)
    reducer.apply([{ type: "text_delta", turnId: "t1", text: "a" }])
    reducer.apply([{ type: "turn_end", turnId: "t1" }])
    reducer.apply([{ type: "text_delta", turnId: "t2", text: "b" }])
    expect(reducer.snapshot().map((item) => item.seq)).toEqual([42, 43])
  })

  it("snapshot 按 seq 排序（渲染顺序的唯一依据）", () => {
    const reducer = makeReducer()
    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "一" },
      { type: "turn_end", turnId: "t1" },
      { type: "text_delta", turnId: "t2", text: "二" },
    ])
    const seqs = reducer.snapshot().map((item) => item.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
  })
})

/**
 * ★★★ 工具调用间隙的纯占位 delta 不能建 item。
 *
 * 实测 opencode 在**每次工具调用前**会吐一个 `...` 的 `agent_message_chunk`。
 * 而 `appendStream` 按 turnId 索引、一个 turn 只有一条 assistant message ——
 * 于是第一个 `...` 就把 message item 建出来、**提前占掉一个 seq**，后续所有
 * tool_call 的 seq 都比它大。真正的答案最后追加进这条早已存在的 item。
 *
 * 两个用户可见的症状是同一个根因：
 * ① 答案开头挂着一串点（实测点数恒为 3 的倍数：4 次工具 → 12 个点；
 *    而**没有工具调用的轮次一个点都没有**，这是决定性证据）；
 * ② 答案"跑到了工具卡上面"—— 用户原话是「一开始在上面，agent 开始说话以后
 *    变到下面了」，其实是答案被钉在了工具之前的那个 seq 上。
 *
 * 所以占位 delta 必须**直接丢弃、不建 item**：让 message 在真正开始说话时
 * 才创建，自然排到所有工具之后，开头也就没有那串点了。
 */
describe("★ 工具间隙的占位 delta", () => {
  it("纯占位 delta 不建 item（答案不含前置点、且排在工具之后）", () => {
    const reducer = makeReducer()
    // 真实序列：占位 → 工具 → 占位 → 工具 → 真答案
    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "..." },
      { type: "tool_call", turnId: "t1", callId: "c1", toolName: "bash" },
      { type: "text_delta", turnId: "t1", text: "..." },
      { type: "tool_call", turnId: "t1", callId: "c2", toolName: "bash" },
      { type: "text_delta", turnId: "t1", text: "这是真正的答案" },
      { type: "turn_end", turnId: "t1" },
    ])

    const items = reducer.snapshot()
    const message = items.find((i) => i.itemType === "message")
    expect(message).toBeDefined()
    // ① 开头没有那串点
    expect(toPlainText(message!.content)).toBe("这是真正的答案")
    // ② 答案排在两个工具之后（渲染顺序只看 seq）
    const toolSeqs = items.filter((i) => i.itemType === "tool_call").map((i) => i.seq)
    expect(toolSeqs).toHaveLength(2)
    expect(message!.seq).toBeGreaterThan(Math.max(...toolSeqs))
  })

  it("正文里的省略号照常保留（不能误伤合法内容）", () => {
    const reducer = makeReducer()
    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "他说" },
      { type: "text_delta", turnId: "t1", text: "……" },
      { type: "text_delta", turnId: "t1", text: "然后就走了" },
      { type: "turn_end", turnId: "t1" },
    ])
    const message = reducer.snapshot().find((i) => i.itemType === "message")
    expect(toPlainText(message!.content)).toBe("他说……然后就走了")
  })

  it("整轮只有占位 → 不产出空 message", () => {
    const reducer = makeReducer()
    reducer.apply([
      { type: "text_delta", turnId: "t1", text: "..." },
      { type: "text_delta", turnId: "t1", text: "   " },
      { type: "turn_end", turnId: "t1" },
    ])
    expect(reducer.snapshot().filter((i) => i.itemType === "message")).toEqual([])
  })

  it("thought 不做占位过滤（思考流的省略号是它自己的节奏）", () => {
    const reducer = makeReducer()
    reducer.apply([
      { type: "thought_delta", turnId: "t1", text: "..." },
      { type: "turn_end", turnId: "t1" },
    ])
    expect(reducer.snapshot().filter((i) => i.itemType === "thought")).toHaveLength(1)
  })
})
