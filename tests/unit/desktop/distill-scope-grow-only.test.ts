/**
 * 学习范围**只增不减**（`mergeScopeOnlyGrowing`）。
 *
 * ## 用户要的
 *
 * 「这些关心范围对业务领域现在不能变小，不能取消不选以前不选的，只能增多，
 *   这是消费者业务决定的吧。」
 *
 * 判据正是"消费者已经消费过"：图谱建过、蒸馏抽过那些会话，范围一缩小就与
 * 已有产出永久不一致（图里还有那个人，而范围说不该有）。
 *
 * ## ★★★ 这个文件存在的真正理由：`undefined` 有**两种**含义
 *
 * 四个字段的 `undefined` 在**读**的时候都表示"不设限"（见 `collection-scope.ts`
 * 的 `isConversationInScope`：`!scope.restricted` 直接 `return true`）。
 * 于是"只增不减"看起来只有一条规则：不设限最宽，任一边最宽则结果最宽。
 *
 * 那条规则在**写**的时候是错的，因为库里的 `undefined` 分不清两件事：
 *
 * · 「用户选了不限」—— 这时它确实最宽，新来的具体值不许收窄它；
 * · 「这个字段从没被记过」—— 这时它只是**没有信息**。
 *
 * 后者不是假设出来的，有两个真实来源：`list()` 对每个 kind 合成 `scope: {}`；
 * `syncTimeWindowToSources()` 给非主渠道写的 chat 行**刻意不带**
 * `conversationIds`。按"最宽"处理它们，白名单与时间范围就**永远设不进去** ——
 * 而那是超范围采集，且完全静默。
 *
 * 实现因此按**字段**分三格（见 `widen` 的注释表）。下面的断言把三格都钉住，
 * 尤其是"没记过 → 收下"那一格 —— 我第一版把它写反，靠 8 条既有断言转红才发现。
 */
import { describe, expect, it } from "vitest"
import { mergeScopeOnlyGrowing } from "../../../apps/desktop/src/main/services/distill-source.service.js"

describe("mergeScopeOnlyGrowing：会话白名单", () => {
  it("★ 取消勾选 → 保留旧的（这就是「不能取消以前选的」）", () => {
    /**
     * 反证：把实现改成 `return incoming` → 这条转红。
     * 而 `return incoming` 正是修复前的行为（整体覆盖写）。
     */
    const merged = mergeScopeOnlyGrowing(
      { conversationIds: ["cidFAKE01", "cidFAKE02", "cidFAKE03"] },
      { conversationIds: ["cidFAKE01"] },
    )
    expect(merged.conversationIds?.slice().sort()).toEqual(["cidFAKE01", "cidFAKE02", "cidFAKE03"])
  })

  it("★ 新勾选 → 并进去（增多是允许的）", () => {
    const merged = mergeScopeOnlyGrowing(
      { conversationIds: ["cidFAKE01"] },
      { conversationIds: ["cidFAKE01", "cidFAKE09"] },
    )
    expect(merged.conversationIds?.slice().sort()).toEqual(["cidFAKE01", "cidFAKE09"])
  })

  it("★ 并集去重（同一个 id 两边都有，不许出现两次）", () => {
    const merged = mergeScopeOnlyGrowing(
      { conversationIds: ["cidFAKE01", "cidFAKE02"] },
      { conversationIds: ["cidFAKE02", "cidFAKE03"] },
    )
    expect(merged.conversationIds).toHaveLength(3)
  })

  it("★★★ 库里**没记过**白名单 + 这次传具体列表 → 收下（这是唯一能收窄的一格）", () => {
    /**
     * ── 这一条记录了本次实现里最贵的一次判断错误 ──────────────
     *
     * 我第一版把这里断言成 `toBeUndefined()`，理由是"`undefined` 是不设限、
     * 也就是最宽，任一边最宽则结果最宽"。那个推理**在这一格上是错的**，
     * 而且错得很贵：它让白名单**永远设不进去**。
     *
     * 实测（8 条既有断言转红）暴露了两个"库里天然是 undefined"的来源：
     *
     * · `DistillSourceRepository.list()` 对每个 kind 都合成一行，`scope` 是 `{}`；
     * · `syncTimeWindowToSources()` 挂载时给每个非主渠道库写一行 chat，
     *   而它**刻意不带 `conversationIds`**（那是别的渠道的 external_id，
     *   复制过去会按一批不存在的 id 过滤 → 恒零，比超采更糟）。
     *
     * 所以飞书那一行天然"有 since、没有 conversationIds"。把它当成
     * "用户选了全部会话"，飞书就**永远**无法设白名单 —— 每次保存都被上一次的
     * `undefined` 吸收。那是超范围采集（CLAUDE.md 第 5 节），静默的。
     *
     * ★ 与用户要求不冲突：要求是"不能取消**以前选的**"，而这一格里以前
     * 什么都没选。这条路径上 purge 仍会跑，隐私那一侧仍然成立。
     *
     * 反证：把 `widen` 的第一行改回 `if (before === undefined) return undefined`
     * → 这条转红，而那正是我写错的那一版。
     */
    const merged = mergeScopeOnlyGrowing({}, { conversationIds: ["cidFAKE01"] })
    expect(merged.conversationIds).toEqual(["cidFAKE01"])
  })

  it("★★★ 但**已经有**白名单时，绝不许被换成更小的一份", () => {
    /**
     * 上一条放开了"从没记过 → 收下"，这一条守住真正的规则边界：
     * 一旦库里有了限制，`incoming` 只能让它变宽。
     *
     * 反证：把 `widen` 的最后一行改成 `return incoming` → 红。
     * 而 `return incoming` 正是修复前的整体覆盖写。
     */
    const merged = mergeScopeOnlyGrowing(
      { conversationIds: ["cidFAKE01", "cidFAKE02"] },
      { conversationIds: ["cidFAKE09"] },
    )
    expect(merged.conversationIds?.slice().sort()).toEqual(["cidFAKE01", "cidFAKE02", "cidFAKE09"])
  })

  it("★★ 反过来：库里有列表 + 这次传「不设限」→ 变成不设限（放宽是允许的）", () => {
    const merged = mergeScopeOnlyGrowing({ conversationIds: ["cidFAKE01"] }, {})
    expect(merged.conversationIds).toBeUndefined()
  })

  it("★ 库里从没配过（before undefined）→ 原样收下，不许凭空造限制", () => {
    /**
     * 首次保存时 `repo.list()` 找不到那行。若这里误把 `undefined` 当"空集合"
     * 处理，首次保存会得到 `conversationIds: []` —— 而空数组是**一个都不采**
     * （`restricted=true` 且 `allow` 为空），于是引导走完却零采集。
     */
    const merged = mergeScopeOnlyGrowing(undefined, { conversationIds: ["cidFAKE01"] })
    expect(merged.conversationIds).toEqual(["cidFAKE01"])
    const unrestricted = mergeScopeOnlyGrowing(undefined, {})
    expect(unrestricted.conversationIds).toBeUndefined()
  })
})

describe("mergeScopeOnlyGrowing：时间边界（方向相反，容易写成同一个）", () => {
  it("★★ 下界 since 只能**变早**（往回学更多历史）", () => {
    /**
     * 反证：把 `Math.min` 改成 `Math.max` → 红。
     * 那个改动的真实后果是用户把"从 1 月开始"改成"从 6 月开始"时，
     * 1–6 月那段已经学过的历史被排除在范围外。
     */
    const later = mergeScopeOnlyGrowing({ since: 1000 }, { since: 5000 })
    expect(later.since).toBe(1000) // 挡住变晚
    const earlier = mergeScopeOnlyGrowing({ since: 5000 }, { since: 1000 })
    expect(earlier.since).toBe(1000) // 放行变早
  })

  it("★★ 上界 until 只能**变晚**（方向与 since 相反）", () => {
    /**
     * 反证：把 `Math.max` 改成 `Math.min` → 红。
     * 两个字段的"宽"方向相反，而实现里它们只差一个函数名 ——
     * 这一条与上一条必须都在，抄错一个还有另一个兜着。
     */
    const earlier = mergeScopeOnlyGrowing({ until: 9000 }, { until: 5000 })
    expect(earlier.until).toBe(9000) // 挡住变早
    const later = mergeScopeOnlyGrowing({ until: 5000 }, { until: 9000 })
    expect(later.until).toBe(9000) // 放行变晚
  })

  it("★★★ 时间字段：库里没记过 → 收下；库里记过而这次不限 → 放宽", () => {
    /**
     * ★ 「库里没记过 → 收下」这半格对时间字段尤其要紧：引导页选的时间范围
     * 走的就是这条路（首次保存时库里那行是 `list()` 合成的 `{}`）。
     * 断言成"仍然不设限"会让**引导里选的时间范围整个失效**，
     * 而界面上看不出来 —— 它会安静地按"不限"去采。
     */
    expect(mergeScopeOnlyGrowing({}, { since: 5000 }).since).toBe(5000)
    expect(mergeScopeOnlyGrowing({}, { until: 5000 }).until).toBe(5000)
    // 记过之后传"不限" → 放宽，允许
    expect(mergeScopeOnlyGrowing({ since: 5000 }, {}).since).toBeUndefined()
    expect(mergeScopeOnlyGrowing({ until: 5000 }, {}).until).toBeUndefined()
  })

  it("★ since 的 null 三态：`isSentAtInScope` 里 null 与 undefined 都放行", () => {
    /**
     * `collection-scope.ts` 判的是 `typeof scope.since === "number"` ——
     * 所以 `null` 也是"不设限"。只判 `undefined` 的实现会把 `null` 当成
     * 一个可比较的值（`Math.min(null, 5000)` === 0，那是 1970 年）。
     *
     * 反证：把实现里的 `typeof ... === "number"` 改成 `!== undefined` → 红。
     */
    // 库里是 null（不设限）→ 这次给了具体值，按"没记过"处理 → 收下
    expect(mergeScopeOnlyGrowing({ since: null } as never, { since: 5000 }).since).toBe(5000)
    // 反向：库里有下界，这次传 null（不限）→ 放宽
    expect(mergeScopeOnlyGrowing({ since: 5000 }, { since: null } as never).since).toBeUndefined()
  })
})

describe("mergeScopeOnlyGrowing：chatKinds（单聊/群聊档位）", () => {
  it("★ 取消一个档位 → 保留（与会话白名单同一条规则）", () => {
    const merged = mergeScopeOnlyGrowing(
      { chatKinds: ["direct", "group"] },
      { chatKinds: ["group"] },
    )
    expect(merged.chatKinds?.slice().sort()).toEqual(["direct", "group"])
  })

  it("★★ 库里没记过档位 → 收下；记过之后传不限 → 放宽", () => {
    expect(mergeScopeOnlyGrowing({}, { chatKinds: ["group"] }).chatKinds).toEqual(["group"])
    expect(mergeScopeOnlyGrowing({ chatKinds: ["group"] }, {}).chatKinds).toBeUndefined()
  })
})

/**
 * ── ★★★ 接线：`save()` 存的是 `merged` 而不是 `input` ──────────────
 *
 * 上面全部通过、而 `save()` 里若把 `merged` 换回 `input`，纯函数一条都不红。
 * 这正是本仓库反复出现的形状：**两头都锁了、中间那根线是裸的**
 * （曾经删掉传值那一行，1023 条测试一条都没红）。
 *
 * 所以这里直接对源码断言两根线：存进库的值、以及派生链的判据。
 */
describe("接线：save 用 merged，派生链的判据也用 merged", () => {
  it("★★ repo.upsert 存的是 merged", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    /**
     * ★ v4 阶段 A 起走 `mergeScopeOnlyGrowingDetailed`（它多返回一个
     * `narrowed` —— 那是"这次收窄了"的告知开关）。锚点跟着改，
     * 而这条断言要锁的事实**没变**：存进库的必须是 `merged`。
     */
    const idx = src.indexOf("const mergeResult = mergeScopeOnlyGrowingDetailed(")
    expect(idx).toBeGreaterThan(0)
    // ★ 窗口放宽到 2600：那一段现在多了收窄告知的日志与注释
    const after = src.slice(idx, idx + 2600)
    /**
     * 反证：把 `scope: merged` 改回 `scope: input.scope` → 红。
     * 而红之前的状态正是"并集算对了但没存"—— 用户取消勾选照旧生效。
     */
    expect(after).toContain("scope: merged")
    expect(after.includes("scope: input.scope")).toBe(false)
  })

  it("★★ scopeChanged 比的是 merged —— 否则一次空保存会重建整张图", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    const idx = src.indexOf('if (input.kind === "chat" && scopeChanged(')
    expect(idx).toBeGreaterThan(0)
    const call = src.slice(idx, idx + 200)
    /**
     * 取消勾选之后 `input` 与 `merged` 分叉：`input` 变小、`merged` 没变。
     * 拿 `input` 比 → 判"范围变了" → 触发 `rebuildGraph(fresh=true)`，
     * 那是**分钟级**的全量重建，而这次保存实际什么都没改。
     *
     * 反证：把 `{ enabled: input.enabled, scope: merged }` 换回 `input` → 红。
     */
    expect(call).toContain("scope: merged")
  })

  it("★ 清越界那条链**没有被删掉** —— 隐私边界仍然可达", async () => {
    /**
     * 「只增不减」让 purge 在默认路径上恒查不到东西。那是它应有的样子，
     * 不是可以删掉它的理由：显式的「清空当前渠道数据」走的是同一条链，
     * 而放宽范围时那一步还负责**重置回填下界**（不跑则新放开的历史永远挖不回来）。
     *
     * 反证：把 `onScopeChanged` 那一行删掉 → 红。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    expect(src).toContain("onScopeChanged?.(input.channelId)")
    const startup = readFileSync("apps/desktop/src/main/bootstrap/startup.ts", "utf8")
    expect(startup).toContain("applyScopeChange")
  })
})
