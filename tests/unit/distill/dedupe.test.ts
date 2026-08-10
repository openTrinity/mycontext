/**
 * 去重与稳定 key 的门禁。
 *
 * ## 这个文件锁的是一次「合并层从未触发」的静默失效
 *
 * `mergeFacet` 的三态（补充 / 确认 / 矛盾）只有在**同一件事落到同一行**时
 * 才会被调到，而那要求 `key` 稳定。原来 key 是模型每个窗口自己编的英文串，
 * 于是实测本机库（33924 条消息、273 条结论）里：
 *
 * ```
 * revision = 1 的有 260 条 / 273   → 三态几乎从未跑过
 * artifacts 里「发截图」有 11 条各自独立
 * ```
 *
 * 后果不报错：产物涨到 37KB，而「有 20 句话都这么说」这个最有价值的信号
 * （`confirm` 分支会累加置信度）永久丢失。
 *
 * 所以这里的断言分两组：
 * · **稳定性** —— 同一内容必须永远得到同一个 key（否则每轮又是新行）；
 * · **收敛性** —— 那 11 条 screenshot 结论必须真的合起来。
 */
import { describe, expect, it } from "vitest"
import { candidateKey, facetKey, findSimilar, similarity } from "@mycontext/distill"
import type { FacetCandidate } from "@mycontext/distill"

function candidate(facet: string, value: unknown): FacetCandidate {
  return {
    facet,
    scope: "global",
    scopeRef: "",
    key: "ignored",
    value,
    confidence: 0.8,
    evidence: ["m1"],
    source: "llm",
  }
}

describe("稳定 key", () => {
  it("★ 同一内容 → 同一个 key（可复现，否则每轮又是一行新记录）", () => {
    const text = "报告 bug 时附截图作为证据，文字描述极简"
    expect(facetKey(text)).toBe(facetKey(text))
  })

  /**
   * ★ 词序**不完全**无关 —— 这里要说清楚实际边界，别许一个做不到的承诺。
   *
   * `tokenize` 会切出相邻二字（CJK bigram），而调换语序会改变**哪些相邻对
   * 存在**（「先看日志再复现」有 `日志`，「再复现先看日志」在切分点上变成
   * `志再`）。所以纯 key 相等这件事对中文语序调换**不成立**。
   *
   * 真正兜住这类改写的是相似度那一档（`findSimilar`）：单字 token 大量重合，
   * 重叠系数仍然过阈值，于是照样合到同一行。这个用例锁的就是这条路径 ——
   * 而不是一个更漂亮但不真实的"key 完全相等"。
   */
  it("★ 中文语序调换：key 会变，但相似度仍然把它们判为同一条", () => {
    const left = "先看日志再复现"
    const right = "再复现先看日志"
    expect(similarity(left, right)).toBeGreaterThan(0.35)
    const existing = [{ facet: "workflow", key: facetKey(left), value: left }]
    expect(findSimilar(candidate("workflow", right), existing)).toBe(facetKey(left))
  })

  it("★★ 完全不同的内容不能撞成同一个 key（误合会让两条真结论双双降置信）", () => {
    expect(facetKey("超过 50 行的函数会要求拆")).not.toBe(facetKey("接口必须支持分页且上限 100"))
  })

  it("★ 只有标点/表情的正文也得到确定性 key，而不是空串", () => {
    // 空 key 会让所有这类结论撞成同一行（UNIQUE 命中），把无关的东西合并
    const key = facetKey("……！！")
    expect(key).not.toBe("")
    expect(key).toBe(facetKey("……！！"))
  })

  it("★★ tasks 的 key 只看 task 与 askKind，不看 from/trigger", () => {
    /**
     * `from` / `trigger` 是同一件事的**举例**，每个窗口举的例子都不同。
     * 算进 key 就等于让同一个任务在每个窗口都是新行 —— 实测 `tasks` 38 条里
     * 有 6 条都是「review / 合 MR」，只是 trigger 不同。
     */
    const left = candidate("tasks", {
      task: "review 代码",
      askKind: "help_request",
      from: "同组前端",
      trigger: "MR 链接 + 一句话",
    })
    const right = candidate("tasks", {
      task: "review 代码",
      askKind: "help_request",
      from: "跨组同事",
      trigger: "MR链接 + 拉群@提及",
    })
    expect(candidateKey(left)).toBe(candidateKey(right))
  })
})

describe("★★ 近义结论收敛（这是准确性与成本的同一个根因）", () => {
  /** 实测产物里 `artifacts` 那 11 条 screenshot 结论中的几条（原文摘录）。 */
  const SCREENSHOTS = [
    "发截图时一定附带一句话观察或提问，不会只甩图片",
    "发截图时一定附带一句话观察或提问，不会只甩图片消息",
    "报告问题或讨论UI布局时，会附带截图说明",
  ]

  it("改写过的同一条结论会被路由到已有那一行", () => {
    const existing = [
      { facet: "artifacts", key: facetKey(SCREENSHOTS[0] ?? ""), value: SCREENSHOTS[0] },
    ]
    const hit = findSimilar(candidate("artifacts", SCREENSHOTS[1]), existing)
    expect(hit).toBe(existing[0]?.key)
  })

  it("★ 跨 facet 不合并 —— workflow 的「先…再…」与 knowhow 的「必须…」是两件事", () => {
    /**
     * 那两个 facet 的分工判据（有顺序 vs 有断言）是 `llm-map.LLM_FACETS`
     * 特意划开的，合并会把它抹掉。
     */
    const existing = [{ facet: "workflow", key: "k1", value: "先看日志再复现问题" }]
    expect(findSimilar(candidate("knowhow", "先看日志再复现问题"), existing)).toBeNull()
  })

  it("★★ 不相干的结论不会被误合（宁可漏合 —— 误合会吃掉真结论）", () => {
    const existing = [{ facet: "knowhow", key: "k1", value: "超过 50 行的函数会要求拆" }]
    expect(findSimilar(candidate("knowhow", "接口必须支持分页且上限 100"), existing)).toBeNull()
  })

  it("命中多条时取**最相似**的那一条（否则结果取决于库里的行顺序）", () => {
    const existing = [
      { facet: "artifacts", key: "loose", value: "报告问题时会附带截图说明" },
      { facet: "artifacts", key: "exact", value: SCREENSHOTS[0] },
    ]
    expect(findSimilar(candidate("artifacts", SCREENSHOTS[1]), existing)).toBe("exact")
  })

  it("similarity：同一句话 = 1，毫无共同词 = 0", () => {
    expect(similarity("附截图说明", "附截图说明")).toBe(1)
    expect(similarity("abc", "xyz")).toBe(0)
  })
})

/**
 * ★★ 阈值调优的**回归锁**：这些对子取自本机真实结论，人工判过。
 *
 * ## 为什么值得单独一组
 *
 * 第一版（Jaccard 0.5）在真库上只合掉 9 条；改成重叠系数 0.35 之后合掉 78 条，
 * 但逐对审计发现明确误合 —— 两句都短、共享的是「必须 / 先 / 相关」这类
 * 中文虚词，比值就过了阈值：
 *
 * ```
 * 0.35  「核心 AI 助手路由必须先能用」 ←→ 「合 main 前必须先通过 review」
 * ```
 *
 * 最终判据是**比值 ≥ 0.5 且绝对共享 ≥ 8 个 token**（网格搜索：在这组标注上
 * 误合 0/12，真重复命中 4/6）。这一组把那个结论钉住 —— 谁再动阈值，
 * 这里会先红。
 */
describe("★★ 阈值回归（对子取自真实语料，人工标注过）", () => {
  const shouldMerge: readonly [string, string][] = [
    [
      "展示页面/设计进度时，用截图（图片消息）回复而非纯文字描述",
      "展示 UI 改动时附带截图，不只用文字描述",
    ],
    [
      "当一个任务被阻塞等待时，见缝插针推进另一个任务，然后回来验证第一个任务的结果。",
      "当主任务阻塞等待时，见缝插针做次要任务，然后去对应 tag 验证次要任务结果，不空等",
    ],
    [
      "报告问题或确认预期时，发截图配一句话结论，不写长段文字说明",
      "报告问题或讨论UI布局时，会附带截图说明",
    ],
  ]

  /** ★ 这些**必须不合** —— 每一条都是第一版真的误合过的。 */
  const shouldNotMerge: readonly [string, string][] = [
    ["核心 AI 助手路由必须先能用，聊天路由可以先不管", "合 main 前必须先通过 review"],
    ["做模型蒸馏相关工作", "负责订阅相关业务模型，包括取消订阅读取模型"],
    [
      "install 命令必须谨慎控制，不能让用户在不知情的情况下电脑上被装一堆软件",
      "发版必须有对应的发版命令",
    ],
    ["超过 50 行的函数会要求拆", "接口必须支持分页且上限 100"],
    ["接到需求先列边界条件问产品", "排查线上问题先看监控面板"],
  ]

  it("★★ 真重复被合到一起", () => {
    for (const [left, right] of shouldMerge) {
      const existing = [{ facet: "artifacts", key: facetKey(left), value: left }]
      expect(
        findSimilar(candidate("artifacts", right), existing),
        `没合上：${left.slice(0, 20)} / ${right.slice(0, 20)}`,
      ).not.toBeNull()
    }
  })

  it("★★ 两件不同的事**不能**被合（短句共享虚词是最常见的误合来源）", () => {
    for (const [left, right] of shouldNotMerge) {
      const existing = [{ facet: "knowhow", key: facetKey(left), value: left }]
      expect(
        findSimilar(candidate("knowhow", right), existing),
        `误合了：${left.slice(0, 20)} / ${right.slice(0, 20)}`,
      ).toBeNull()
    }
  })
})
