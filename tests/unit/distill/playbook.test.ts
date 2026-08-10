/**
 * playbook 归纳的门禁。
 *
 * ## 这个文件锁四类性质，每类都对应一个真实的失效
 *
 * 1. **取样判据** —— 第一版按「消息数最多」挑，实测归纳出 **0 条**：
 *    最话密的单聊里没有任何流程痕迹（那 12 个 chunk 顺序词合计 9 个、链接 0）。
 *    改成按流程密度挑之后，同一个模型 4 个 chunk 就出 3 条。
 *    **取样错了会让整层看起来"做不到"** —— 而那是最容易误判成"方案不成立"的。
 * 2. **结构校验** —— playbook 是**给下游执行**的，一条编出来的流程会被 agent
 *    照着做。所以 < 2 步、缺产出、证据映射不上的一律整条作废。
 * 3. **归因** —— 本人没发言的 chunk 不进候选（归纳别人的流程 = 一份自信且
 *    错误的画像，同 `assertSelfAttributed` 那条）。
 * 4. **覆盖率** —— 必须报，且三个数分别可读。这是唯一能让"换个人跑失效了"
 *    被看见的信号。
 *
 * 纯函数为主（`processScore` / `selectSources` / `validatePlaybook`），
 * 归纳那一步用假 client（不打网络）。
 */
import { describe, expect, it } from "vitest"
import {
  inducePlaybooks,
  processScore,
  resolvePlaybookEvidence,
  selectSources,
  validatePlaybook,
  type PlaybookSource,
} from "@mycontext/distill"
import { LlmClient } from "@mycontext/llm"
import { createLogger } from "@mycontext/kernel"

function source(over: Partial<PlaybookSource> & { id: string }): PlaybookSource {
  return { content: "普通闲聊内容", size: 10, selfSpoke: true, ...over }
}

/** 造一个返回固定 JSON 的假 client（不打网络）。 */
function fakeClient(response: string): LlmClient {
  return new LlmClient({
    baseUrl: "https://fake.invalid",
    apiKey: "k",
    model: "m",
    sleep: () => Promise.resolve(),
    logger: createLogger("T", { level: "error" }),
    fetchImpl: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: response } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        text: () => Promise.resolve(""),
      } as unknown as Response),
  })
}

describe("★★ 取样判据：流程密度，不是消息数", () => {
  it("★★ 顺序词与链接都算流程信号", () => {
    // 链接算进去：在 IM 里交付物就是一条链接，而「有交付物」是阶段的标志
    expect(processScore("先看日志再复现")).toBeGreaterThan(0)
    expect(processScore("看这个 https://example.com/mr/1")).toBeGreaterThan(0)
    expect(processScore("英文也认 first do this then that")).toBeGreaterThan(0)
  })

  it("★★ 没有流程痕迹的段落得 0 分（这正是第一版归纳出 0 条的原因）", () => {
    expect(processScore("行吧 好的 收到 哈哈")).toBe(0)
  })

  it("★★ 本人没发言的 chunk 不进候选（归纳别人的流程 = 错的画像）", () => {
    const picked = selectSources(
      [source({ id: "a", content: "先做 A 再做 B", selfSpoke: false })],
      10,
    )
    expect(picked).toHaveLength(0)
  })

  it("★ 太短的 chunk 不进候选（装不下一个完整来回）", () => {
    expect(selectSources([source({ id: "a", content: "先 A 再 B", size: 2 })], 10)).toHaveLength(0)
  })

  it("★ 0 分的不进候选 —— 喂进去只会得到空结果（实测）", () => {
    expect(selectSources([source({ id: "a", content: "收到收到" })], 10)).toHaveLength(0)
  })

  it("★ 按密度降序：成本花在最可能有产出的语料上", () => {
    const picked = selectSources(
      [
        source({ id: "low", content: "先看一下" }),
        source({ id: "high", content: "先看日志，然后复现，最后 https://a/1 https://a/2" }),
      ],
      10,
    )
    expect(picked[0]?.id).toBe("high")
  })
})

describe("★★ 结构校验：编出来的流程必须被丢掉", () => {
  const sources = [source({ id: "c1" }), source({ id: "c2" })]
  const valid = {
    name: "打包发版",
    trigger: "自己决定发新版",
    stages: [
      { action: "改配置", output: "配置文件" },
      { action: "打包", output: "安装包" },
    ],
    evidence: [1],
  }

  it("合格的能过，且 evidence 映射成真实 chunk id", () => {
    const book = validatePlaybook(valid, sources)
    expect(book?.name).toBe("打包发版")
    expect(book?.evidence).toEqual(["c1"])
  })

  it("★★ 只有 1 步 → 作废（那是一句陈述，不是序列）", () => {
    expect(validatePlaybook({ ...valid, stages: [valid.stages[0]] }, sources)).toBeNull()
  })

  it("★★ 有阶段缺产出 → **整条**作废，不是跳过那一步", () => {
    /**
     * 跳过那一步的话，剩下的流程读起来仍然像完整的 —— 而那是一份错的流程，
     * 下游会照着执行。所以整条丢掉。
     */
    const book = validatePlaybook(
      { ...valid, stages: [valid.stages[0], { action: "打包", output: "" }] },
      sources,
    )
    expect(book).toBeNull()
  })

  it("★★ evidence 映射不到真实 chunk → 整条作废", () => {
    expect(validatePlaybook({ ...valid, evidence: [99] }, sources)).toBeNull()
    expect(validatePlaybook({ ...valid, evidence: [] }, sources)).toBeNull()
  })

  it("★ 名字或触发为空 → 作废（匹配不上任何消息，等于没有）", () => {
    expect(validatePlaybook({ ...valid, name: "" }, sources)).toBeNull()
    expect(validatePlaybook({ ...valid, trigger: "  " }, sources)).toBeNull()
  })

  it("resolvePlaybookEvidence 去重且保序", () => {
    expect(resolvePlaybookEvidence([1, 1, 2], sources)).toEqual(["c1", "c2"])
  })
})

describe("★★ 归纳的四种「没有 playbook」要能区分", () => {
  const candidates = [
    source({ id: "c1", content: "先看日志，然后复现，最后提 MR https://a/1" }),
    source({ id: "c2", content: "先确认环境，再跑构建 https://a/2" }),
  ]

  it("★ 模型返回空数组 → 0 条 + 覆盖率仍然报出来（正常状态，不是故障）", async () => {
    const result = await inducePlaybooks(candidates, {
      client: fakeClient('{"playbooks":[]}'),
      selfNames: ["我"],
    })
    expect(result.playbooks).toHaveLength(0)
    // ★ 覆盖率必须有：那是"归纳过但没结果"与"根本没跑"的分界
    expect(result.coverage.candidates).toBe(2)
    expect(result.coverage.eligible).toBe(2)
    expect(result.calls).toBe(1)
  })

  it("★★ coverage.candidates 只数**本人参与**的（否则产物文案在说假话）", async () => {
    /**
     * 实测踩到：产物写「从 2149 段本人参与的对话里」，而本人参与的只有 1700 段。
     * 读图那层刻意把全部 chunk 都返回（只标 selfSpoke），所以这里要自己筛。
     */
    const mixed = [
      source({ id: "mine", content: "先看日志再复现 https://a/1" }),
      source({ id: "theirs", content: "先看日志再复现 https://a/2", selfSpoke: false }),
    ]
    const result = await inducePlaybooks(mixed, {
      client: fakeClient('{"playbooks":[]}'),
      selfNames: ["我"],
    })
    expect(result.coverage.candidates).toBe(1)
  })

  it("★ 一条候选都没有 → 不调模型（省钱），覆盖率报 0", async () => {
    const result = await inducePlaybooks([source({ id: "x", content: "收到" })], {
      client: fakeClient('{"playbooks":[]}'),
      selfNames: ["我"],
    })
    expect(result.calls).toBe(0)
    expect(result.coverage.eligible).toBe(0)
  })

  it("★★ 返回的不是 JSON → **抛**（这一轮没跑成 ≠ 确实没有套路）", async () => {
    /**
     * 这两件事必须分开：前者该保留上一版产物，后者该删。
     * 混起来的后果是一次网关抖动就让产物消失，而那看起来与"他没有套路"一样。
     */
    await expect(
      inducePlaybooks(candidates, {
        client: fakeClient("这不是 JSON"),
        selfNames: ["我"],
      }),
    ).rejects.toThrow()
  })

  it("★ 结构不合格的被计数（模型没听 prompt，要有人去调）", async () => {
    const result = await inducePlaybooks(candidates, {
      client: fakeClient(
        JSON.stringify({
          playbooks: [
            {
              name: "只有一步",
              trigger: "t",
              stages: [{ action: "a", output: "o" }],
              evidence: [1],
            },
          ],
        }),
      ),
      selfNames: ["我"],
    })
    expect(result.playbooks).toHaveLength(0)
    expect(result.droppedInvalid).toBe(1)
  })

  it("★ 成本按每批 usage 累加（不是读 client 的生命周期累计）", async () => {
    const result = await inducePlaybooks(candidates, {
      client: fakeClient('{"playbooks":[]}'),
      selfNames: ["我"],
      batchSize: 1,
    })
    // 两批各 150 → 300；若读 client 累计会是 150+300=450
    expect(result.calls).toBe(2)
    expect(result.costTokens).toBe(300)
  })
})
