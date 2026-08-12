/**
 * 语料口径**一致性**：kl-graph 与 forge 必须选出同一批消息。
 *
 * ## 用户原话
 *
 * 「或许 kl-graph 和 forge 的语料都可以合并」
 *
 * ## 探查结论：**选择层已经是同一套判据**，缺的是"锁住它别漂移"
 *
 * 两条路各自读库（一个物化成 `records.jsonl` 喂 kl，一个切成
 * `distill_tasks` 窗口喂 forge），但**筛消息的三条判据完全相同**：
 *
 * | 判据 | kl-graph（`export-materializer`） | forge（`MessageRepository`） |
 * |---|---|---|
 * | 学习范围 | `exportScope()` → `readCollectionScope` | `readCollectionScope`（forge.service） |
 * | 空正文 | `content_text IS NOT NULL AND <> ''` | 同（带 `trim`） |
 * | 数字人自产 | `origin <> 'agent'` | `origin <> 'agent'` |
 *
 * 所以**不该**把它们物理合成一个导出器：sink 本来就不同（jsonl 快照 vs
 * 任务窗口），强行合并只会让一个消费者的形状迁就另一个。
 *
 * 真正的风险是**漂移**：某天有人给一侧加了个过滤（比如"排除某类卡片消息"）
 * 而另一侧没加，于是图谱里有的事实、画像里没有对应语料。那种不一致
 * **不会报错**，只会让蒸馏引用一个图谱里存在而语料里缺失的 fact。
 *
 * 这个文件就是那道闸：三条判据任一侧被改，测试转红。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

const MATERIALIZER = "packages/knowledge-feed/src/export-materializer.ts"
const MESSAGES_REPO = "packages/store/src/repositories/messages.ts"
const FEED_SERVICE = "apps/desktop/src/main/services/feed.service.ts"
const FORGE_SERVICE = "apps/desktop/src/main/services/forge.service.ts"

/**
 * 剥掉注释再断言。
 *
 * ★ 不剥的话"搜到字符串"可能命中的是**解释这条规则的注释**，而不是
 * 真会执行的 SQL —— 本文件第一版就是这样：删掉 SQL 之后测试照样绿。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

describe("语料口径：两条路必须用同一套判据", () => {
  it("★★★ 都排除数字人自产语料（origin <> 'agent'）", () => {
    /**
     * 不排的话数字人自己发的话会被当本人语料再蒸一遍 → **自我强化漂移**
     * （它越来越像自己的输出，而不是像本人）。
     *
     * 反证：删掉任一侧的那行 → 这条转红。
     */
    /**
     * ★★ 判据必须落在**真的会执行的 SQL** 上，不能只搜字符串。
     *
     * 我第一版写成 `expect(src).toContain("origin <> 'agent'")` —— 反证
     * （删掉那行 SQL）**照样绿**，因为同一个文件的注释里也写着这个字符串
     * （"· `origin <> 'agent'` —— 排除数字人自己发的话"）。
     * 本仓库已经踩过同一个坑（`useFetchSelfAvatar` 那次也是注释命中）。
     *
     * 所以这里先剥掉注释再断言。
     */
    const materializer = stripComments(readFileSync(MATERIALIZER, "utf8"))
    const repo = stripComments(readFileSync(MESSAGES_REPO, "utf8"))
    expect(materializer).toContain("origin <> 'agent'")
    expect(repo).toContain("origin <> 'agent'")
    // 自查：剥注释这一步真的有效（否则上面两条又变成搜注释）
    expect(materializer.includes("排除数字人自己发的话")).toBe(false)
  })

  it("★★★ 都按 readCollectionScope 取学习范围（唯一权威）", () => {
    /**
     * 各自算一遍范围就会漂移。`collection-scope.ts` 的文件头写明它是
     * 唯一权威 —— 这条锁住两侧都真的经过它。
     *
     * 反证：把 `feed.service.ts` 里的 `readCollectionScope` 换成手写
     * "从 distill_sources 读 scope_json" → 这条转红。
     */
    const feed = readFileSync(FEED_SERVICE, "utf8")
    const forge = readFileSync(FORGE_SERVICE, "utf8")
    expect(feed).toContain("readCollectionScope(db)")
    expect(forge).toContain("readCollectionScope(db)")
  })

  it("★★ 都排除空正文（否则图谱有节点、画像没语料）", () => {
    /**
     * ★★ 判据必须落在**消息那条查询**上，不是"文件里出现过这个字符串"。
     *
     * 我第二版剥了注释仍然没有判别力：`export-materializer` 里
     * **两处**都有 `content_text IS NOT NULL` —— 一处是文档导出（522 行），
     * 一处才是消息（755 行）。删掉消息那条之后断言仍命中文档那条，
     * 于是照样绿。判据因此改成"消息的 clause 数组里有它"。
     *
     * 反证：删掉 `readMessages` 的 `"content_text IS NOT NULL"` → 转红（已实测）。
     */
    const materializer = stripComments(readFileSync(MATERIALIZER, "utf8"))
    const repo = stripComments(readFileSync(MESSAGES_REPO, "utf8"))
    const readMessagesAt = materializer.indexOf("private readMessages(")
    expect(readMessagesAt).toBeGreaterThan(0)
    const messageQuery = materializer.slice(readMessagesAt, readMessagesAt + 1400)
    expect(messageQuery).toContain("content_text IS NOT NULL")
    expect(messageQuery).toContain("origin <> 'agent'")
    expect(repo).toContain("content_text IS NOT NULL")
  })

  it("★★★ 空白名单在两侧都是「零个会话」而不是「不限」", () => {
    /**
     * 这是修复前真实存在过的 bug：`allow.length === 0` 被解读成全量，
     * 于是"把聊天源关掉"把**全部**聊天记录导进了知识图谱 ——
     * 与用户意图正好相反且不报错。
     *
     * 判据：`restricted` 时**总是**传白名单（哪怕是空数组）。
     */
    const feed = readFileSync(FEED_SERVICE, "utf8")
    expect(feed).toContain("if (collection.restricted) scope.conversationExternalIds")
    // 不许写成"空了就不传"（那等于退回不限）
    expect(feed.includes("collection.allow.length === 0 ?")).toBe(false)
  })

  it("★★ 蒸馏声明依赖图谱导出（引用 fact 的前提）", () => {
    /**
     * 口径一致只保证"选的是同一批消息"，不保证**顺序**。蒸馏引用图谱的
     * fact，所以还要求它不跑在图谱前面 —— 那是 `dependsOn` 那道闸
     * （行为测试在 tests/integration/ingest/consumer-dependency.test.ts）。
     *
     * 两道闸合起来才是"语料合并"这件事的完整形状：
     * **同一批输入 + 有序消费**。
     */
    const ingest = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    expect(ingest).toContain('dependsOn: ["graph-export"]')
  })
})
