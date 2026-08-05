/**
 * 记忆检索 —— 起草前把「对方提到的东西是什么」从图谱里查出来。
 *
 * ## 这一组守什么
 *
 * 失效形态是可复现的：对方提到一个专有名词，草稿把那个词**原样复述**一遍，
 * 因为模型除了语气参数什么都没拿到。语气对、要回的点也都回到了，但内容是空的
 * —— 而语气越像，这种空洞越难被察觉。
 *
 * 所以这一层的价值判据不是"查得到多少"，而是**查到的能不能安全地用本人语气
 * 说出去**。低置信度的事实用越像本人的语气说，对方越会信 —— 置信度门槛因此是
 * 这一组里最要紧的断言。
 *
 * ## ★ 夹具是**编的**，不是从本机语料抄的
 *
 * 用 `阿狸` / `小柚` 这类明显虚构的名字，而不是真实会话里的昵称。理由与
 * forge 的 `scan --scope fixtures` 同一条：一旦真名进了源码，它与"编出来的
 * 例子"在 diff 里长得一模一样，而后来的人无从分辨哪些能改。
 * 结构性质（无空格语言、2 字昵称嵌在更长片段里）完整保留 —— 那才是被验的东西。
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "@mycontext/kernel"
import {
  candidateTerms,
  MIN_CONFIDENCE,
  PersonaMemory,
  type MemorySource,
} from "../../../apps/desktop/src/main/services/persona-memory.js"

const logger = createLogger("Test", { level: "error" })

/** 一个可编排的图谱替身。`entities` 是名字→提及数，`facts` 是名字→事实。 */
function fakeGraph(
  entities: Record<string, number>,
  facts: Record<string, Array<{ text: string; confidence: number }>>,
  type = "Person",
): MemorySource {
  return {
    entitiesByName: (names) =>
      names
        .filter((name) => name in entities)
        .map((name) => ({ name, type, mentions: entities[name] ?? 0 })),
    searchFacts: (keyword) => facts[keyword] ?? [],
  }
}

/** 这一组用例统一用的会话 id（记忆限本会话，所以是必需参数）。 */
const CONV = "conv-ext-1"

describe("candidateTerms", () => {
  it("按标点切出候选（无分词语言没有空格，所以不能只靠空白）", () => {
    const terms = candidateTerms("这是啥情况，阿狸真好看！", [])
    expect(terms).toContain("这是啥情况")
    expect(terms).toContain("阿狸真好看")
  })

  it("拉丁词与产品名也能切出来", () => {
    expect(candidateTerms("someproduct 上线了吗", [])).toContain("someproduct")
  })

  it("★ 排除本人与对方的名字（people.md 已经按人给了语气）", () => {
    const terms = candidateTerms("小柚 你看下阿狸", ["小柚"])
    expect(terms).not.toContain("小柚")
  })

  it("纯数字与纯标点不是实体", () => {
    const terms = candidateTerms("123 ？？？ 4567", [])
    expect(terms).toHaveLength(0)
  })

  it("★★ 昵称嵌在更长片段里时也要能被切出来（滑窗）", () => {
    /**
     * 这是整层曾经**静默失效**的那一条：图谱的 `entitiesByName` 是精确
     * `IN (...)` 匹配，而无分词语言里一个 2 字昵称通常嵌在更长的片段内部
     * （标点切不开它）。不滑窗的话那种句子永远匹配不到实体，
     * 查得到的只剩恰好被标点独立出来的名字。
     */
    expect(candidateTerms("阿狸真乖啊", [])).toContain("阿狸")
  })

  it("★ 长句子被滑窗切成短候选，而**整句**本身不进候选", () => {
    /**
     * 滑窗必然让一个长句子产出一堆短候选 —— 那是对的，它们最终都要过实体表
     * 这一关，非实体一律落空。这里守的是另一件事：**整句不进候选**
     * （超过 MAX_TERM_LENGTH），而每个候选都短到可能是个名字。
     * 否则我们会拿一整句话去查实体表。
     */
    const long = "这是一个非常非常长的句子完全不可能是任何实体的名字"
    const terms = candidateTerms(long, [])
    expect(terms).not.toContain(long)
    expect(terms.every((term) => [...term].length <= 6)).toBe(true)
  })
})

describe("PersonaMemory.lookup", () => {
  it("★ 查到够置信的事实 → 带出来（这是整层的目的）", () => {
    const memory = new PersonaMemory({
      logger,
      source: fakeGraph(
        { 阿狸: 40 },
        {
          阿狸: [
            { text: "阿狸五个月大", confidence: 0.95 },
            { text: "小柚是阿狸的主人", confidence: 0.85 },
          ],
        },
      ),
    })
    const hits = memory.lookup("阿狸真乖啊", [], CONV)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.term).toBe("阿狸")
    expect(hits[0]?.facts).toEqual(["阿狸五个月大", "小柚是阿狸的主人"])
  })

  it("★★ 低置信度的事实**不进**提示词（用本人语气说错话比不说更糟）", () => {
    const memory = new PersonaMemory({
      logger,
      source: fakeGraph(
        { 阿狸: 40 },
        { 阿狸: [{ text: "阿狸可能要搬走了", confidence: MIN_CONFIDENCE - 0.1 }] },
      ),
    })
    expect(memory.lookup("阿狸真乖啊", [], CONV)).toHaveLength(0)
  })

  it("★ 实体存在但没有够置信的事实 → 不放（名字本身不是内容）", () => {
    const memory = new PersonaMemory({ logger, source: fakeGraph({ 阿狸: 40 }, {}) })
    expect(memory.lookup("阿狸真乖啊", [], CONV)).toHaveLength(0)
  })

  it("图谱里不是实体的词不查事实（省掉 N 次 FTS）", () => {
    const queried: string[] = []
    const memory = new PersonaMemory({
      logger,
      source: {
        entitiesByName: () => [],
        searchFacts: (keyword) => {
          queried.push(keyword)
          return []
        },
      },
    })
    expect(memory.lookup("换个心情 确实 好吧", [], CONV)).toHaveLength(0)
    expect(queried, "非实体不该触发事实检索").toHaveLength(0)
  })

  it("★ 图谱不可用 → 空数组（降级，不是抛错）", () => {
    const memory = new PersonaMemory({ logger, source: null })
    expect(memory.lookup("阿狸", [], CONV)).toHaveLength(0)
  })

  it("★ 查询抛错 → 空数组，起草照常（记忆是增强不是前提）", () => {
    const memory = new PersonaMemory({
      logger,
      source: {
        entitiesByName: () => {
          throw new Error("图库损坏")
        },
        searchFacts: () => [],
      },
    })
    expect(() => memory.lookup("阿狸", [], CONV)).not.toThrow()
    expect(memory.lookup("阿狸", [], CONV)).toHaveLength(0)
  })

  it("提及数高的优先，且限制词数（不让记忆段挤掉对话）", () => {
    const facts = Object.fromEntries(
      ["a实体", "b实体", "c实体", "d实体"].map((name) => [
        name,
        [{ text: `${name}的事实`, confidence: 0.9 }],
      ]),
    )
    const memory = new PersonaMemory({
      logger,
      source: fakeGraph({ a实体: 5, b实体: 99, c实体: 50, d实体: 20 }, facts),
    })
    const hits = memory.lookup("a实体 b实体 c实体 d实体", [], CONV)
    // 最多 3 个，且按提及数降序
    expect(hits.map((hit) => hit.term)).toEqual(["b实体", "c实体", "d实体"])
  })

  /**
   * ★★ 泛化的系统/工具名不该带记忆进来。
   *
   * 真机踩到的那一条：抽取器把一个普通英文词当成 `System` 实体（5 次提及），
   * 于是任何提到它的消息都拖进一批**无关**事实 —— 而那些事实置信度都在 0.85
   * 以上，也就是置信度门槛挡不住。后果不是"多几行噪声"，而是一段与本人
   * 无关的工作内容被以本人语气带进私聊。
   */
  it("★★ System 类实体不进记忆（泛化词的事实与对话无关）", () => {
    const memory = new PersonaMemory({
      logger,
      source: fakeGraph(
        { chat: 5 },
        { chat: [{ text: "某个 chat 的标题太长导致样式问题", confidence: 0.95 }] },
        "System",
      ),
    })
    expect(memory.lookup("用 chat 试了下", [], CONV)).toHaveLength(0)
  })

  it("Person / Project 类照常带出来（白名单不能把真人也挡掉）", () => {
    for (const type of ["Person", "Project", "Organization"]) {
      const memory = new PersonaMemory({
        logger,
        source: fakeGraph(
          { 阿狸: 40 },
          { 阿狸: [{ text: "阿狸五个月大", confidence: 0.9 }] },
          type,
        ),
      })
      expect(memory.lookup("阿狸真乖啊", [], CONV), type).toHaveLength(1)
    }
  })

  it("★ 提及数太少的实体不查（多半是抽错的一次性片段）", () => {
    const memory = new PersonaMemory({
      logger,
      source: fakeGraph({ 阿狸: 2 }, { 阿狸: [{ text: "阿狸五个月大", confidence: 0.9 }] }),
    })
    expect(memory.lookup("阿狸真乖啊", [], CONV)).toHaveLength(0)
  })

  it("★ 反面：提及数下限单独用不够 —— 真人的中位提及数与噪声实体相当", () => {
    /**
     * 真机分布里「真人的中位提及数」与「泛化词实体的提及数」是同一个量级。
     * 所以两道过滤必须**叠加**；只留提及数那一条会连真人一起切掉。
     */
    const person = new PersonaMemory({
      logger,
      source: fakeGraph(
        { 阿狸: 5 },
        { 阿狸: [{ text: "阿狸五个月大", confidence: 0.9 }] },
        "Person",
      ),
    })
    expect(person.lookup("阿狸真乖啊", [], CONV), "刚过下限的真人要留下").toHaveLength(1)
  })

  it("★★ 拿不到会话 id → 不查（宁可没有记忆，也不跨会话取）", () => {
    /**
     * 图谱是全库的。会话 id 缺失时如果"那就全库查"，等于让数字人以本人语气
     * 说出一段本人在这个会话里从没说过的话 —— 见 `factsInConversation` 的注释。
     * 所以这里 fail closed。
     */
    const memory = new PersonaMemory({
      logger,
      source: fakeGraph({ 阿狸: 40 }, { 阿狸: [{ text: "阿狸真乖", confidence: 0.95 }] }),
    })
    expect(memory.lookup("阿狸真乖啊", [], "")).toHaveLength(0)
    // 对照：给了会话 id 就正常
    expect(memory.lookup("阿狸真乖啊", [], CONV)).toHaveLength(1)
  })

  it("★ 会话 id 原样传给查询层（限会话是查询层执行的）", () => {
    const seen: string[] = []
    const memory = new PersonaMemory({
      logger,
      source: {
        entitiesByName: (names) =>
          names.filter((n) => n === "阿狸").map((name) => ({ name, type: "Person", mentions: 40 })),
        searchFacts: (_keyword, conv) => {
          seen.push(conv)
          return [{ text: "阿狸真乖", confidence: 0.95 }]
        },
      },
    })
    memory.lookup("阿狸真乖啊", [], CONV)
    expect(seen).toEqual([CONV])
  })
})
