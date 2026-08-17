/**
 * 学习范围的**收窄告知**（v4 阶段 A）。
 *
 * ## ★★★ 这个文件锁的是什么
 *
 * 「只增不减」有**一个刻意的例外**：`widen` 的第一格（`无 → 有`）允许
 * "从不限收窄到具体列表"。那一格不能删 —— 否则非主渠道那种
 * "有 since、没有 conversationIds" 的库**永远设不了白名单**，
 * 而那是超范围采集（CLAUDE.md §5），比收窄糟得多。
 *
 * 但它有一个后果：**下游（图谱 / 画像）已经学过的那部分不会跟着收窄** ——
 * 它们是增量的，"输入变少"对它们不等于"把已有的删掉"。
 *
 * 而这个不一致**不可能靠代码自动消除**（唯一的清空入口是手动重建，
 * 几十分钟且不可中断）。所以正确的处置是**让用户知情** ——
 * 静默留一个"配置说没学过、产出说学过"的矛盾才是最糟的（CLAUDE.md §4）。
 *
 * 三组断言：
 * ① 只有那一格算收窄（其余五格不许误报 —— 每次保存都弹的确认等于没有确认）；
 * ② 收窄的**行为不变**（仍然允许，只是报出来）；
 * ③ 首次配置不算收窄（以前什么都没配过，没有"以前选的"可言）。
 */
import { describe, expect, it } from "vitest"
import { mergeScopeOnlyGrowingDetailed } from "../../../apps/desktop/src/main/services/distill-source.service.js"

const NOW = 1_785_000_000_000

describe("★★★ 只有「从不限收窄到具体列表」那一格算收窄", () => {
  it("★★★ `无 → 有`（会话）→ narrowed，且**行为不变**（仍然收下）", () => {
    /**
     * ★ 两条断言必须同时成立：
     * · `narrowed: true` —— 用户要知情；
     * · `scope.conversationIds` 是新列表 —— 行为**不许**变
     *   （改了飞书永远设不了白名单）。
     */
    const result = mergeScopeOnlyGrowingDetailed({ since: NOW }, { conversationIds: ["A", "B"] })
    expect(result.narrowed).toBe(true)
    expect(result.narrowedFields).toEqual(["conversationIds"])
    expect(result.scope.conversationIds).toEqual(["A", "B"])
  })

  it("★★★ `无 → 有`（文档空间）同样算收窄", () => {
    const result = mergeScopeOnlyGrowingDetailed({ since: NOW }, { partitions: ["wikiFAKE01"] })
    expect(result.narrowed).toBe(true)
    expect(result.narrowedFields).toEqual(["partitions"])
  })

  it("★★ 多个维度同时收窄 → 都报出来（界面要说清是哪一类）", () => {
    /**
     * ★ 为什么要"哪几个维度"而不是一个布尔：用户接下来的判断不同 ——
     * 为一个会话重建图谱与为一整个知识库重建，值不值得完全不同。
     */
    const result = mergeScopeOnlyGrowingDetailed(
      { since: NOW },
      { conversationIds: ["A"], partitions: ["W"], chatKinds: ["group"] },
    )
    expect(result.narrowed).toBe(true)
    expect([...result.narrowedFields].sort()).toEqual([
      "chatKinds",
      "conversationIds",
      "partitions",
    ])
  })

  it("★★★ `有 → 有`（并集）→ **不算**收窄", () => {
    /**
     * 那一格取并集（只增），所以它在结构上不可能缩小。
     * 误报会让每次加会话都弹一次确认。
     */
    const result = mergeScopeOnlyGrowingDetailed(
      { conversationIds: ["A"] },
      { conversationIds: ["B"] },
    )
    expect(result.narrowed).toBe(false)
    expect([...(result.scope.conversationIds ?? [])].sort()).toEqual(["A", "B"])
  })

  it("★★★ `有 → 无`（放宽到不限）→ **不算**收窄", () => {
    const result = mergeScopeOnlyGrowingDetailed({ conversationIds: ["A"] }, { since: NOW })
    expect(result.narrowed).toBe(false)
    // ★ 而它确实放宽了（那个键消失 = 不设限）
    expect(result.scope.conversationIds).toBeUndefined()
  })

  it("★★★ 时间那两个字段**永远不算**收窄（它们在结构上不可能缩小）", () => {
    /**
     * `since` 只能变早（`Math.min`）、`until` 只能变晚（`Math.max`）。
     * 把它们算进来会让每次改时间范围都弹一次确认 —— 而那是最常见的操作。
     */
    const later = mergeScopeOnlyGrowingDetailed({ since: NOW - 1000 }, { since: NOW })
    expect(later.narrowed).toBe(false)
    // ★ 而合并结果取更早的那个（只增不减仍然生效）
    expect(later.scope.since).toBe(NOW - 1000)

    const earlier = mergeScopeOnlyGrowingDetailed({ until: NOW }, { until: NOW - 1000 })
    expect(earlier.narrowed).toBe(false)
    expect(earlier.scope.until).toBe(NOW)
  })
})

describe("★★★ 首次配置不算收窄", () => {
  it("★★★ 库里没有这一行（`before === undefined`）→ 不报 narrowed", () => {
    /**
     * 以前什么都没配过，没有"以前选的"可言。报 true 会让**新装机第一次保存**
     * 就看到一句"这会缩小范围"的确认 —— 那是错的归因，而且它会训练用户
     * 忽略这个提示（下次真的收窄时他也不看了）。
     */
    const result = mergeScopeOnlyGrowingDetailed(undefined, { conversationIds: ["A", "B"] })
    expect(result.narrowed).toBe(false)
    expect(result.scope.conversationIds).toEqual(["A", "B"])
  })

  it("★★ 空 scope → 空 scope：不报", () => {
    expect(mergeScopeOnlyGrowingDetailed({}, {}).narrowed).toBe(false)
  })
})

describe("★★ 旧签名仍在（既有调用方与测试在用）", () => {
  it("★★★ `mergeScopeOnlyGrowing` 返回的仍是**裸 scope**", async () => {
    /**
     * 改签名要同时改那几处调用方，而它们不关心 `narrowed`。
     * 保留薄封装的代价是一个函数名，换来的是零调用方改动。
     */
    const { mergeScopeOnlyGrowing } = await import(
      "../../../apps/desktop/src/main/services/distill-source.service.js"
    )
    const scope = mergeScopeOnlyGrowing({ conversationIds: ["A"] }, { conversationIds: ["B"] })
    // ★ 直接是 scope，不是 {scope, narrowed}
    expect([...(scope.conversationIds ?? [])].sort()).toEqual(["A", "B"])
    expect((scope as { narrowed?: unknown }).narrowed).toBeUndefined()
  })
})

describe("★★★ 界面必须把这件事说出来（反证：静默是最糟的）", () => {
  it("★★★ 保存结果带 narrowed，且面板真的读它", async () => {
    /**
     * ## 为什么锁这一条
     *
     * 服务层报了 `narrowed` 而界面不读 = 那个字段是装饰性的，
     * 而用户仍然处在"配置说没学过、产出说学过"的静默矛盾里。
     *
     * 这正是 v2/v3 反复修的形状：**声明写着一件事，代码里没有任何地方
     * 执行它**。所以判据落在"面板读了它"这个事实上。
     */
    const { readFileSync } = await import("node:fs")
    const panel = readFileSync(
      "apps/desktop/src/renderer/features/shell/collection-scope-panel.tsx",
      "utf8",
    )
    // ★ 读了返回值里那个字段
    expect(panel).toContain("result.narrowed")
    // ★★ 而且把出路说出来了（"重建"这个词必须出现 —— 只报告问题不给出路没用）
    expect(panel).toContain("narrowed.body")
  })

  it("★★★ 那个出路必须是**能点的按钮**，不只是一句话", async () => {
    /**
     * ## 这一条是补一个漏（而漏的形状值得记住）
     *
     * 上一条只断言"`narrowed.body` 这个 key 出现了" —— 也就是**文案里
     * 提到了重建**。而实际代码里那一块只有一个「知道了，暂不重建」按钮，
     * 旁边的注释却写着"给出路而不是只报告问题"。**注释说了谎，
     * 而门禁只检查了文案。**
     *
     * ★ 危害不是"少一个按钮"：文案写"**暂不**重建"本身就暗示了另一个选项
     * 存在，于是用户会去找它 —— 而它在另一个模块（图谱面板）里。
     * 一句"需要重建"配一个只能关掉的按钮，比不提这件事更让人无从下手。
     *
     * ★★ 判据落在**调用**上（`rebuild.mutate` + `fresh: true`），
     * 不是落在按钮文案上：文案可以改、可以国际化，而"真的会触发重建"
     * 是那个出路存在的唯一证据。
     *
     * ★★★ `fresh: true` 必须一起锁：增量建图只会往图里加，
     * 被移出范围的会话留在图里的实体与事实**不会消失** ——
     * 那恰恰是这条提示要解决的问题。传 false 等于按钮点了没用。
     */
    const { readFileSync } = await import("node:fs")
    const panel = readFileSync(
      "apps/desktop/src/renderer/features/shell/collection-scope-panel.tsx",
      "utf8",
    )
    expect(panel).toContain("useKlGraphBuild")
    expect(panel).toMatch(/rebuild\.mutate\(\{\s*fresh:\s*true/)
    /**
     * ★ 必须带渠道：不带的话在飞书那栏点重建会把**钉钉**的图删了重烧
     * （那次事故记在 `useKlGraphBuild` 与 `onScopeChanged` 的注释里）。
     */
    expect(panel).toMatch(/rebuild\.mutate\(\{[^}]*channelId/)
  })
})
