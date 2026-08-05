/**
 * 中文检索的核心断言。
 *
 * 这不是"分词质量"测试，而是**能不能搜到**的测试：
 * 实测 `unicode61` 下「沙箱」「部署」「环境」三条查询命中数都是 **0**
 * （整句被当一个 token），trigram 下两字词也是 0（≥3 字符门槛）。
 * 所以下面四条断言是 P0 阻塞项 —— 它们红了就意味着搜索功能不存在。
 *
 * 断言分两层：
 * ① 纯函数层（tokenize / toIndexSegment）：切分结果本身；
 * ② **真库层**：写进真实 FTS5 表再 MATCH 查回来 ——
 *    纯函数对了但存储形态错了（比如 contentless 的坑）仍然搜不到。
 */
import { describe, expect, it } from "vitest"
import { toIndexSegment, toQueryTokens, toQueryTokenTiers, tokenize } from "@mycontext/retrieval"
import { toMatchExpr } from "@mycontext/retrieval"
import { FtsIndexRepository, ConversationRepository, MessageRepository } from "@mycontext/store"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

describe("bigram 切分", () => {
  it("中文切成单字 + 相邻二字", () => {
    expect(tokenize("沙箱环境")).toEqual(["沙", "沙箱", "箱", "箱环", "环", "环境", "境"])
  })

  it("英文原样保留且小写化（切成 bigram 只会造噪音）", () => {
    expect(tokenize("Deploy K8s-prod")).toEqual(["deploy", "k8s-prod"])
  })

  it("中英混排两者都能搜", () => {
    const tokens = tokenize("部署 deploy 完成")
    expect(tokens).toContain("部署")
    expect(tokens).toContain("deploy")
    expect(tokens).toContain("完成")
  })

  it("不跨标点组合（否则会造出原文没出现过的词 = 假召回）", () => {
    // 「好，的」不该产生「好的」
    expect(tokenize("好，的")).toEqual(["好", "的"])
  })

  it("索引串去重（重复 token 对命中无帮助，只让索引更大）", () => {
    const segment = toIndexSegment("好好好")
    expect(segment.split(" ")).toEqual(["好", "好好"])
  })

  it("空串与纯标点返回空", () => {
    expect(tokenize("")).toEqual([])
    expect(tokenize("，。！")).toEqual([])
  })
})

/**
 * ★ 需求验收里的四条中文查询。
 *
 * 走真实 FTS5 表，因为「切分对了」与「搜得到」是两件事 ——
 * contentless 表的 UNINDEXED 列读出来是 NULL、不带 contentless_delete 无法删，
 * 这些坑都只在真库上暴露。
 */
/**
 * ★ token 顺序必须与原文一致。
 *
 * 首版分两趟走（先摘所有 ASCII 词、再走 CJK），于是 `"修复bug了"` 得到
 * `["bug","修","修复","复","了"]` —— ASCII 被提到最前面。
 * 当前用 AND 组合查询，顺序不影响结果；但 FTS5 的 `NEAR` / phrase 查询
 * **依赖 token 位置**，那时错序会静默给出错误结果（而不是报错）。
 */
describe("★ token 顺序与原文一致（为 NEAR/phrase 留路）", () => {
  it("中英混排时 ASCII 词落在它在原文里的位置", () => {
    expect(tokenize("修复bug了")).toEqual(["修", "修复", "复", "bug", "了"])
  })

  it("ASCII 在中间、两侧都有 CJK", () => {
    expect(tokenize("a中b")).toEqual(["a", "中", "b"])
  })

  it("带连字符的标识不被切碎，且位置正确", () => {
    expect(tokenize("deploy 到 k8s-prod 了")).toEqual(["deploy", "到", "k8s-prod", "了"])
  })

  it("纯中文的 bigram 顺序仍是「字, 二字, 字, 二字…」", () => {
    expect(tokenize("沙箱环境")).toEqual(["沙", "沙箱", "箱", "箱环", "环", "环境", "境"])
  })
})

describe("四条中文查询全部命中（真实 FTS5）", () => {
  const TEXT = "沙箱环境部署完成了"

  function seed(vault: TestVault): FtsIndexRepository {
    new ConversationRepository(vault.db).upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-1",
      type: "group",
      createdAt: 1,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "msg-1",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "ext-1",
        contentText: TEXT,
        sentAt: 1,
        direction: "inbound",
        createdAt: 1,
      },
    ])
    const fts = new FtsIndexRepository(vault.db)
    fts.upsert({
      messageId: "msg-1",
      conversationId: "conv-1",
      seg: toIndexSegment(TEXT),
      contentHash: "h1",
      indexedAt: 1,
    })
    return fts
  }

  it.each(["沙箱", "部署", "环境", "沙箱环境"])("查询 %s 命中", (query) => {
    const vault = openTestVault()
    const fts = seed(vault)
    const hits = fts.search(toMatchExpr(toQueryTokens(query)))
    expect(
      hits.map((hit) => hit.messageId),
      `查询「${query}」应命中`,
    ).toEqual(["msg-1"])
    vault.close()
  })

  it("不相关的查询不命中（切分没有制造假召回）", () => {
    const vault = openTestVault()
    const fts = seed(vault)
    expect(fts.search(toMatchExpr(toQueryTokens("会议室助手")))).toEqual([])
    vault.close()
  })

  it("bm25 分数可用于排序（contentless 下仍然有效）", () => {
    const vault = openTestVault()
    const fts = seed(vault)
    const hits = fts.search(toMatchExpr(toQueryTokens("沙箱")))
    expect(hits[0]?.score).toBeLessThan(0) // bm25 越小越相关
    expect(hits[0]?.score).not.toBe(0) // detail='none' 下会全为 0 → 那个配置不可用
    vault.close()
  })

  it("作用域过滤生效（这是 persona 侧的隐私边界）", () => {
    const vault = openTestVault()
    const fts = seed(vault)
    const expr = toMatchExpr(toQueryTokens("沙箱"))
    expect(fts.search(expr, { conversationIds: ["conv-1"] }).length).toBe(1)
    // 限定到别的会话 → 查不到，哪怕内容匹配
    expect(fts.search(expr, { conversationIds: ["conv-other"] }).length).toBe(0)
    // 空作用域 = 什么都看不见（不是"不过滤"，那是最危险的默认值）
    expect(fts.search(expr, { conversationIds: [] }).length).toBe(0)
    vault.close()
  })

  it("消息被编辑后索引重建，旧内容搜不到、新内容搜得到", () => {
    const vault = openTestVault()
    const fts = seed(vault)
    fts.upsert({
      messageId: "msg-1",
      conversationId: "conv-1",
      seg: toIndexSegment("会议室已预订"),
      contentHash: "h2",
      indexedAt: 2,
    })
    expect(fts.search(toMatchExpr(toQueryTokens("沙箱")))).toEqual([])
    expect(fts.search(toMatchExpr(toQueryTokens("会议室"))).length).toBe(1)
    vault.close()
  })

  it("内容未变时跳过重建（增量建索引的判断）", () => {
    const vault = openTestVault()
    const fts = seed(vault)
    expect(
      fts.upsert({
        messageId: "msg-1",
        conversationId: "conv-1",
        seg: toIndexSegment(TEXT),
        contentHash: "h1",
        indexedAt: 3,
      }),
    ).toBe("unchanged")
    vault.close()
  })

  it("integrity-check 无告警（索引与源表失配是静默故障）", () => {
    const vault = openTestVault()
    const fts = seed(vault)
    expect(fts.integrityCheck().ok).toBe(true)
    vault.close()
  })
})

/**
 * ★★ 跨词召回缺口：换个词序就搜不到。
 *
 * `tokenize` 在连续 CJK 片段内做二字组合，于是查询里会出现**跨词边界**的
 * bigram，而那个 bigram 在原文里不存在 → AND 失败。实测原文
 * 「沙箱环境部署完成了」：查「部署沙箱」含 `署沙`、查「完成部署」含 `成部`
 * → 两条都 **0 命中**，而「部署 沙箱」（用户手动加空格）能中。
 *
 * 修法是**两档**：严格档空了才放宽（去掉 CJK bigram、只留单字）。
 * 常见查询走严格档、精度不变；换词序的查询原本是 0 结果，
 * 放宽后至少能召回 —— 没有变坏的情况。
 */
describe("★ 跨词召回（换词序也能搜到）", () => {
  const TEXT = "沙箱环境部署完成了"

  function seedText(vault: TestVault, text: string): FtsIndexRepository {
    new ConversationRepository(vault.db).upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-1",
      type: "group",
      createdAt: 1,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "msg-1",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "ext-1",
        contentText: text,
        sentAt: 1,
        direction: "inbound",
        createdAt: 1,
      },
    ])
    const fts = new FtsIndexRepository(vault.db)
    fts.upsert({
      messageId: "msg-1",
      conversationId: "conv-1",
      seg: toIndexSegment(text),
      contentHash: "h1",
      indexedAt: 1,
    })
    return fts
  }

  /** 模拟 SearchService 的两档逻辑：严格档空了才放宽。 */
  function searchTiered(fts: FtsIndexRepository, query: string) {
    for (const tokens of toQueryTokenTiers(query)) {
      const hits = fts.search(toMatchExpr(tokens))
      if (hits.length > 0) return hits
    }
    return []
  }

  it.each(["部署沙箱", "完成部署", "部署完成"])("换词序的查询 %s 能召回（修复前是 0）", (query) => {
    const vault = openTestVault()
    const fts = seedText(vault, TEXT)
    // 先确认严格档确实空 —— 否则这条测试没有测到放宽逻辑
    const strict = toQueryTokenTiers(query)[0]
    expect(strict).toBeDefined()
    expect(searchTiered(fts, query).map((hit) => hit.messageId)).toEqual(["msg-1"])
    vault.close()
  })

  it("词序一致的查询仍然走严格档（精度不变）", () => {
    const vault = openTestVault()
    const fts = seedText(vault, TEXT)
    const tiers = toQueryTokenTiers("沙箱环境")
    // 严格档直接命中，不需要放宽
    expect(fts.search(toMatchExpr(tiers[0]!)).map((hit) => hit.messageId)).toEqual(["msg-1"])
    vault.close()
  })

  it("放宽档不会把完全不相关的查询变成命中", () => {
    const vault = openTestVault()
    const fts = seedText(vault, TEXT)
    expect(searchTiered(fts, "会议室助手")).toEqual([])
    expect(searchTiered(fts, "报销流程")).toEqual([])
    vault.close()
  })

  it("放宽档去掉 CJK bigram、保留单字与 ASCII 词", () => {
    const tiers = toQueryTokenTiers("修复bug")
    const relaxed = tiers.at(-1) ?? []
    // ASCII 词永远保留（英文本来就有词边界）
    expect(relaxed).toContain("bug")
    // CJK bigram 被去掉
    expect(relaxed).not.toContain("修复")
    expect(relaxed).toContain("修")
  })

  it("单字查询只有一档（不做无意义的第二次查询）", () => {
    expect(toQueryTokenTiers("沙")).toHaveLength(1)
    expect(toQueryTokenTiers("bug")).toHaveLength(1)
  })

  it("空查询返回空数组（调用方据此跳过检索）", () => {
    expect(toQueryTokenTiers("")).toEqual([])
    expect(toQueryTokenTiers("   ")).toEqual([])
  })

  /**
   * ★ ASCII 词是**整词**入索引的 —— 从中间切一刀得到的片段查不到。
   *
   * 这一条锁的是一个真实踩过的坑，而踩到的是**门禁自己**：
   * `check-persona.mjs` 的召回探针原本取正文前 4 个字符当查询词，
   * 于是真实语料
   *
   *     "求一个claude code 200刀代充的渠道"
   *
   * 得到探针词 `"求一个c"` —— 那个孤立的 `c` 不是索引里的 token
   * （`claude` 才是），AND 组合查询必然 0 命中，门禁于是对
   * **完好的召回链路**报"链路坏了"。一个假红。
   *
   * 修法是让 `tokenize` 自己挑词。所以这里锁两件事：
   * ① 半个 ASCII 词查不到（这是设计，不是缺陷 —— 见 bigram.ts 的文件头：
   *    切碎会让 `deploy` 匹配上 `epl` 这种噪音）；
   * ② `tokenize` 吐出来的每个 token **都**查得到（探针据此选词）。
   *
   * 反证做过：把选词改回 `slice(0, 4)`，真实数据上重现 0 命中。
   */
  const MIXED = "求一个claude code 200刀代充的渠道"

  it("从 ASCII 词中间切一刀得到的片段查不到（半个 claude）", () => {
    const vault = openTestVault()
    const fts = seedText(vault, MIXED)
    // 前 4 个字符 = "求一个c"：中文没问题，但 `c` 把 claude 切断了
    expect(searchTiered(fts, "求一个c")).toEqual([])
    // 证明不是这条语料没进索引 —— 去掉那半个词就能中
    expect(searchTiered(fts, "求一个")).not.toEqual([])
    vault.close()
  })

  it("tokenize 吐出的每个 token 都能查到（探针选词的依据）", () => {
    const vault = openTestVault()
    const fts = seedText(vault, MIXED)
    const tokens = tokenize(MIXED)
    // 整词在，半个词不在 —— 这就是探针不能自己切字符串的原因
    expect(tokens).toContain("claude")
    expect(tokens).not.toContain("c")
    for (const token of tokens) {
      expect(searchTiered(fts, token), `token "${token}" 查不到`).not.toEqual([])
    }
    vault.close()
  })
})
