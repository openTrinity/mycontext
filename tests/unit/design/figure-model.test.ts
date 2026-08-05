/**
 * `figure-model.ts` 的纯函数测试。
 *
 * 分工：本文件测**我们自己的逻辑**（三态映射、丢弃与保留、单点修改的
 * 局部性、旧数据兼容）；`figure-pinning.test.ts` 测的是
 * **DiceBear 的行为契约**（pin 是否真的生效）。
 * 分开是因为后者是"上游会不会变"的问题，而前者是"我们写对了没有"。
 */
import { describe, expect, it } from "vitest"
import {
  FIGURE_SLOTS,
  FIGURE_STYLES,
  DEFAULT_FIGURE_STYLE,
  figureColorSlotsFor,
  figureIsEmpty,
  figureSlotsFor,
  figureToOptions,
  findSlot,
  sanitizeFigure,
  withBackground,
  withColor,
  withSlot,
  type FigureConfig,
} from "@mycontext/design"

describe("生成物与缺省风格的对应关系", () => {
  it("FIGURE_SLOTS 的第一个 key 就是 DEFAULT_FIGURE_STYLE", () => {
    /**
     * ★ 这条锁的是 `figure-model.ts` 里的 `FALLBACK_STYLE`。
     *
     * 那个常量取的是 `Object.keys(FIGURE_SLOTS)[0]` —— 之所以不直接
     * import `DEFAULT_FIGURE_STYLE`，是为了避免与 `persona-figure.tsx`
     * 形成运行时循环依赖（那个文件要 import 本模块的 `figureToOptions`）。
     * 两者相等是**生成器按 FIGURE_STYLES 顺序输出**的结果，
     * 而那是一个会被改掉的实现细节 —— 没有这条断言，
     * 将来有人改了输出顺序，未知风格会静默落到另一个风格上。
     */
    expect(Object.keys(FIGURE_SLOTS)[0]).toBe(DEFAULT_FIGURE_STYLE)
  })

  it("★★ 生成物覆盖**每一个** FIGURE_STYLES（少一个会静默落到 notionists）", () => {
    /**
     * ## 这条锁的是扩展路径（加一个新风格）
     *
     * `slotsOf` 对认不出的风格**静默回落**到生成物的第一个 key，而那对
     * "库里存着一个我们不认识的串"是**正确**的处理（上面那两条测的就是它）。
     * 但对"`FIGURE_STYLES` 里有、生成物里没有"却是一次静默失效：
     * 实测 `sanitizeFigure("pixelart", {slots:{lips:…, gesture:…}})` 的
     * `dropped` 是**空的**、options 照写 —— 也就是用户选了新风格，
     * 界面拿 notionists 的槽位表给他，而没有任何一处会报错。
     *
     * 漂移门禁（`check-figure-slots-sync.mjs`）拦不住这一类：它遍历的是
     * `STYLE_PACKAGES` 的键，一个只加进 `FIGURE_STYLES` 而忘了加进
     * 生成器的风格根本不在它的视野里。
     *
     * 判据是**两个集合相等**，不是"生成物非空"—— 后者在漏了一个风格时
     * 照样为真。
     */
    expect([...Object.keys(FIGURE_SLOTS)].sort()).toEqual([...FIGURE_STYLES].sort())
  })

  it("未知风格落回缺省而不是抛错", () => {
    // 库里可能存着一个我们不认识的风格串（手改过的 payload / 降级过的版本）
    const unknown = "totally-not-a-style" as never
    expect(figureSlotsFor(unknown)).toEqual(figureSlotsFor(DEFAULT_FIGURE_STYLE))
    expect(figureColorSlotsFor(unknown)).toEqual(figureColorSlotsFor(DEFAULT_FIGURE_STYLE))
  })

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"])(
    "原型链上的键 %s 也要落回缺省（不能抛）",
    (key) => {
      /**
       * ★ 这条锁的是 `slotsOf` 用 `Object.hasOwn` 而不是 `table[style] ?? …`。
       *
       * `??` 对原型链上的键**不触发回落**：`table["constructor"]` 是
       * `Object.prototype.constructor`（不是 undefined），于是返回的东西上
       * 没有 `.slots` —— 实测 `sanitizeFigure("constructor", …)` 直接抛
       * `Cannot read properties of undefined (reading 'find')`。
       *
       * `"bogus"` 那条断言**测不到**这个（它能正确回落），所以这两条
       * 必须同时存在：一个测"不认识的名字"，一个测"名字恰好是原型上的键"。
       * 判据是"与缺省风格的结果相同"而不是"没抛" —— 后者在函数返回
       * 一个空表时也成立。
       */
      const style = key as never
      expect(figureSlotsFor(style)).toEqual(figureSlotsFor(DEFAULT_FIGURE_STYLE))
      expect(sanitizeFigure(style, { slots: { hair: "variant07" } })).toEqual(
        sanitizeFigure(DEFAULT_FIGURE_STYLE, { slots: { hair: "variant07" } }),
      )
      expect(figureToOptions(style, { slots: { hair: "variant07" } })).toEqual(
        figureToOptions(DEFAULT_FIGURE_STYLE, { slots: { hair: "variant07" } }),
      )
    },
  )
})

describe("sanitizeFigure：脏数据不许让页面打不开", () => {
  it.each([
    ["字符串", "not an object"],
    ["数组", [1, 2, 3]],
    ["null", null],
    ["数字", 42],
    ["undefined", undefined],
  ])("%s 收敛成空配置且不抛", (_label, raw) => {
    expect(sanitizeFigure("notionists", raw)).toEqual({ config: {}, dropped: [] })
  })

  it("slots 不是对象时整体丢弃并报出", () => {
    expect(sanitizeFigure("notionists", { slots: 42 }).dropped).toEqual(["slots"])
    expect(sanitizeFigure("notionists", { colors: "红" }).dropped).toEqual(["colors"])
    expect(sanitizeFigure("notionists", { background: 7 }).dropped).toEqual(["background"])
  })

  it("槽位值不是字符串时被丢掉", () => {
    expect(sanitizeFigure("notionists", { slots: { hair: 123 } }).dropped).toContain("hair")
  })

  it("必填槽位不接受 null（没法「不要眼睛」）", () => {
    /**
     * `eyes` 在 notionists 上没有 `eyesProbability` —— 也就是说
     * DiceBear 没有提供"不要眼睛"这个能力。收下一个 null 的后果是
     * `figureToOptions` 什么都写不出来，于是用户以为自己关掉了
     * 一个部件，实际什么都没变（"点了没反应"的一种）。
     */
    const { config, dropped } = sanitizeFigure("notionists", { slots: { eyes: null } })
    expect(dropped).toContain("eyes")
    expect(config.slots?.["eyes"]).toBeUndefined()
  })

  it("可选槽位接受 null（那是「显式不要」）", () => {
    const { config, dropped } = sanitizeFigure("notionists", { slots: { beard: null } })
    expect(dropped).toEqual([])
    expect(config.slots?.["beard"]).toBeNull()
  })

  it("圆角越界被丢掉，合法值被四舍五入", () => {
    expect(sanitizeFigure("notionists", { background: { radius: 80 } }).dropped).toContain(
      "background.radius",
    )
    expect(sanitizeFigure("notionists", { background: { radius: -1 } }).dropped).toContain(
      "background.radius",
    )
    expect(sanitizeFigure("notionists", { background: { radius: Number.NaN } }).dropped).toContain(
      "background.radius",
    )
    expect(
      sanitizeFigure("notionists", { background: { radius: 20.4 } }).config.background,
    ).toEqual({ radius: 20 })
  })

  it("空子对象不写进 config（让 figureIsEmpty 判得出「什么都没定制」）", () => {
    expect(sanitizeFigure("notionists", { slots: {}, colors: {}, background: {} }).config).toEqual(
      {},
    )
  })

  it("部分合法时保留合法的那些，只报丢掉的", () => {
    /**
     * 这是最常见的真实情形（切风格）。全丢或全留都是错的：
     * 全丢 = 用户白配一场；全留 = 那些非法值被 DiceBear 静默忽略。
     */
    const { config, dropped } = sanitizeFigure("notionists", {
      slots: { hair: "variant07", lips: "variant99", nonexistent: "x" },
    })
    expect(config.slots).toEqual({ hair: "variant07" })
    expect(dropped.sort()).toEqual(["lips", "nonexistent"])
  })
})

describe("★★ 同一个 option key 不得有两个入口", () => {
  /**
   * ## 这一组锁的是什么
   *
   * `thumbs` / `funEmoji` 自己的 schema 里**就有** `backgroundColor`
   * （生成器刻意保留 —— 用 core 全集排会把这两个风格唯一的定制维度排掉，
   * `figure-pinning.test.ts` 有一条断言锁着那件事）。于是同一个 option key
   * 曾经有**两个**来源：风格级 `colors.backgroundColor` 与 core 级
   * `background.color`，而 `figureToOptions` 后写 background、
   * **无条件覆盖**前者。
   *
   * 实测那个 bug：UI 上「颜色」区 18 个色块、「背景」区 19 个色块都在，
   * 用户在颜色区选一个 → 选中态会亮、配置会存、**预览完全不动**。
   * 讽刺的是这两个风格走的正是"仅预设 + 背景色"路线，
   * 背景色是它们唯一的定制维度。
   *
   * 判据是**结构性**的（"没有 key 同时出现在两个来源里"），不是
   * "thumbs 的 colorSlots 里没有 backgroundColor" —— 后者只锁住了
   * 今天这一个 key，将来上游再加一个 core 同名的颜色槽时不会红。
   */
  it("没有任何风格的 colorSlots 与 background 争同一个 key", () => {
    /**
     * ★ 两边都从**实际行为**算出来，不读 `BACKGROUND_OWNED_KEYS`。
     *
     * 反证时发现的问题：上一版这条断言写成"colorSlots 里的 key 不在
     * `BACKGROUND_OWNED_KEYS` 里"，于是把那个常量改成 `[]` 时它
     * **恒真通过** —— 一条能被"把清单清空"绕过的结构性断言等于没有。
     * （那次反证靠另外三条断言才变红，但不能指望下一次也有。）
     *
     * 现在的判据是：`figureToOptions` 从 `colors` 能写出的 key 集合，
     * 与它从 `background` 能写出的 key 集合，**必须不相交**。
     * 这个量只随真实行为变化，清空清单会让它立刻变红。
     */
    const fromBackground = Object.keys(
      figureToOptions(DEFAULT_FIGURE_STYLE, { background: { color: "ffffff", radius: 20 } }),
    )
    expect(fromBackground).toContain("backgroundColor")

    for (const style of FIGURE_STYLES) {
      const slots = figureColorSlotsFor(style)
      // 喂全部颜色槽，看 options 里真的出现了哪些 key
      const colors = Object.fromEntries(slots.map((key) => [key, "ffffff"]))
      const fromColors = Object.keys(figureToOptions(style, { colors }))
      for (const key of fromColors) {
        expect(fromBackground, `${style}: ${key} 同时能从颜色区与背景区写`).not.toContain(key)
      }
    }
  })

  it("thumbs / funEmoji：背景色只从 background 写，颜色区不再接受它", () => {
    // 直接喂一个"两边都有"的配置 —— 手改过的库数据就是这个形状
    const options = figureToOptions("thumbs", {
      colors: { backgroundColor: "ffedef" } as Record<string, string>,
      background: { color: "77311d" },
    })
    expect(options["backgroundColor"]).toEqual(["77311d"])
    // funEmoji 的 backgroundColor 是它唯一的颜色槽 → 收归背景后颜色区为空
    expect(figureColorSlotsFor("funEmoji")).toEqual([])
  })

  it("★ 旧配置里的 colors.backgroundColor 要**迁移**而不是丢掉", () => {
    /**
     * 这条与上面那条互为反面，必须同时存在。
     *
     * 只有上面那条时，"直接把 backgroundColor 从 colors 里删掉"这个
     * 实现也会通过 —— 而那是一次**真实的数据丢失**：
     * `colors.backgroundColor` 曾经是个会生效的入口（只写它、不写
     * `background.color` 时产物用的就是它），用户在颜色区选的背景色
     * 会凭空消失，界面只会说一句"有 1 件没保留"。
     *
     * 判据是"搬过去了、且不算丢" —— `dropped` 为空是关键：
     * 迁移后渲染逐字节相同（同一个 option key、同一个值），
     * 那不是"没保留"，说成没保留是在误报。
     */
    const { config, dropped } = sanitizeFigure("thumbs", {
      colors: { backgroundColor: "ffedef", eyesColor: "000000" },
    })
    expect(dropped).toEqual([])
    expect(config.background?.color).toBe("ffedef")
    expect(config.colors?.["backgroundColor"]).toBeUndefined()
    // 其余颜色槽不受影响
    expect(config.colors?.["eyesColor"]).toBe("000000")
    // 迁移后产物与"当年那个会生效的入口"完全一致
    expect(figureToOptions("thumbs", config)).toEqual({
      backgroundColor: ["ffedef"],
      eyesColor: ["000000"],
    })
  })

  it("迁移不覆盖显式的 background.color（那才是现在唯一的入口）", () => {
    const { config } = sanitizeFigure("thumbs", {
      colors: { backgroundColor: "ffedef" },
      background: { color: "77311d" },
    })
    expect(config.background?.color).toBe("77311d")
  })

  it("非法的 colors.backgroundColor 仍然算丢（迁移不是放宽校验）", () => {
    expect(sanitizeFigure("thumbs", { colors: { backgroundColor: "#ffedef" } }).dropped).toContain(
      "backgroundColor",
    )
  })
})

describe("figureToOptions：可选槽位的三态", () => {
  it("三态各自的 options（这张表就是正确性定义）", () => {
    // 键不存在 → 什么都不写（由 seed 决定）
    expect(figureToOptions("notionists", {})).toEqual({})
    // null → 概率 0
    expect(figureToOptions("notionists", { slots: { beard: null } })).toEqual({
      beardProbability: 0,
    })
    // 选中 → 变体 + 概率 100
    expect(figureToOptions("notionists", { slots: { beard: "variant01" } })).toEqual({
      beard: ["variant01"],
      beardProbability: 100,
    })
  })

  it("必填槽位选中时不写概率（它没有概率槽）", () => {
    expect(figureToOptions("notionists", { slots: { eyes: "variant01" } })).toEqual({
      eyes: ["variant01"],
    })
  })

  it("颜色与背景走各自的 key，背景色是 core 的 backgroundColor", () => {
    expect(
      figureToOptions("lorelei", {
        colors: { hairColor: "77311d" },
        background: { color: "f1f4dc", radius: 50 },
      }),
    ).toEqual({
      hairColor: ["77311d"],
      backgroundColor: ["f1f4dc"],
      radius: 50,
    })
  })

  it("当前风格不认识的槽位/颜色不出现在 options 里", () => {
    /**
     * 双保险：正常路径上数据已经过了 `sanitizeFigure`，但这个函数
     * 也可能被直接调（测试、将来的调用方）。写出一个 lorelei 不认识的
     * key 不会报错，只会被静默忽略 —— 那种"多写了也没事"的宽容
     * 会让 bug 藏得更久。
     */
    expect(figureToOptions("lorelei", { slots: { lips: "variant11" } })).toEqual({})
    expect(figureToOptions("notionists", { colors: { hairColor: "77311d" } })).toEqual({})
  })
})

describe("单点修改只改那一格", () => {
  it("withSlot 不动别的槽位", () => {
    /**
     * "点头发把眼睛也换了"是一个真实的失效形态，而它在界面上表现为
     * "我明明只点了头发" —— 用户会以为是随机的。
     */
    const before: FigureConfig = { slots: { hair: "variant07", eyes: "variant02" } }
    const after = withSlot(before, "hair", "variant30")
    expect(after.slots).toEqual({ hair: "variant30", eyes: "variant02" })
    // 原对象不被改（下游有 memo 依赖引用/内容对应关系）
    expect(before.slots).toEqual({ hair: "variant07", eyes: "variant02" })
  })

  it("withSlot 传 undefined = 回到「由 seed 决定」（删键）", () => {
    const after = withSlot({ slots: { hair: "variant07", eyes: "variant02" } }, "hair", undefined)
    expect(after.slots).toEqual({ eyes: "variant02" })
  })

  it("删到空时 slots 变 undefined 而不是 {}", () => {
    // 否则 figureIsEmpty 判不出"什么都没定制"，"重置"按钮看起来没生效
    const after = withSlot({ slots: { hair: "variant07" } }, "hair", undefined)
    expect(after.slots).toBeUndefined()
    expect(figureIsEmpty(after)).toBe(true)
  })

  it("withColor / withBackground 同样只改一处", () => {
    const base: FigureConfig = { colors: { hairColor: "000000", skinColor: "f9c9b6" } }
    expect(withColor(base, "hairColor", "77311d").colors).toEqual({
      hairColor: "77311d",
      skinColor: "f9c9b6",
    })
    const bg: FigureConfig = { background: { color: "f1f4dc", radius: 50 } }
    expect(withBackground(bg, { radius: 20 }).background).toEqual({ color: "f1f4dc", radius: 20 })
  })

  it("withBackground 传 undefined 真的删掉那个键", () => {
    /**
     * `exactOptionalPropertyTypes: true` 下 `{color: undefined}` 与
     * "没有 color" 在类型上等价、在 `Object.keys` 上不等价 ——
     * 留着 undefined 键会让 `background` 永远非空，于是"跟随默认"
     * 这一格点了之后 `figureIsEmpty` 仍然是 false。
     */
    const after = withBackground({ background: { color: "f1f4dc" } }, { color: undefined })
    expect(after.background).toBeUndefined()
  })
})

describe("旧数据兼容（这是「没弄坏老用户」的断言）", () => {
  it("没有 figureCustom 时 options 为空 —— 与加这个字段之前逐字节一致", () => {
    /**
     * 库里现有的 payload 形如 `{"name":"小小周","figureSeed":"小小周|0#0"}`。
     * 空 options 意味着传给 `createAvatar` 的仍然只有 `{seed, size}`。
     */
    expect(figureToOptions("notionists", sanitizeFigure("notionists", undefined).config)).toEqual(
      {},
    )
    expect(figureIsEmpty(undefined)).toBe(true)
    expect(figureIsEmpty({})).toBe(true)
    expect(figureIsEmpty({ slots: { hair: "variant07" } })).toBe(false)
    // 「显式不要」也算定制过 —— 它是一个真实的用户决定
    expect(figureIsEmpty({ slots: { beard: null } })).toBe(false)
  })
})

describe("findSlot", () => {
  it("认识的返回定义，不认识的返回 undefined", () => {
    expect(findSlot("notionists", "hair")?.variants).toHaveLength(64)
    expect(findSlot("notionists", "lips")?.optional).toBe(false)
    expect(findSlot("notionists", "beard")?.probabilityKey).toBe("beardProbability")
    expect(findSlot("lorelei", "lips")).toBeUndefined()
  })
})

describe("★ 落库的配置**天然有界**（不需要在 schema 上加上限）", () => {
  /**
   * ## 审查提到的"`figureCustom` 无大小上界"实测是不成立的
   *
   * 担心的是：`contract.ts` 的 `payload: z.unknown()` 不限大小，
   * 于是一个手改过的 payload 能把任意大的对象写进 SQLite 的 `TEXT`。
   *
   * 但**写入侧的值来自 `sanitizeFigure` 的产物**，而它是白名单式的：
   * 只有当前风格槽位表里存在的 key 才会进 `config`。实测喂 5000 个
   * 垃圾键，`config.slots` 是 **0** 个（全进 `dropped`）；把 10 个合法
   * 槽位也一起塞满，`config.slots` 是 **10** 个（= 该风格的槽位数）。
   *
   * 也就是说上界是**生成物的槽位数**（最多 11 个，lorelei），
   * 而那不是一个需要额外校验的量。在 schema 上再加一个键数上限，
   * 只会多一处与生成物不同步的判据 —— 上游加一个槽位就会让合法数据
   * 被拒，而那种失效表现为"我明明选了它却存不下"。
   *
   * 所以不加上限，改为**把"产物有界"这条性质锁住**：
   * 它才是让上限不必要的原因，一旦有人把 `sanitizeFigure` 改成
   * "认不出的键原样保留"，这条会红。
   */
  it("5000 个垃圾键 → 产物一个都不留（白名单，不是黑名单）", () => {
    const slots: Record<string, string> = {}
    for (let index = 0; index < 5000; index += 1) slots[`junk${String(index)}`] = "variant01"
    const { config, dropped } = sanitizeFigure("notionists", { slots })
    expect(config.slots).toBeUndefined()
    // 而且它们是**被报告**的，不是被静默吞掉
    expect(dropped).toHaveLength(5000)
  })

  it("垃圾 + 合法混在一起 → 产物不超过该风格的槽位数", () => {
    const slots: Record<string, string> = {}
    for (let index = 0; index < 500; index += 1) slots[`junk${String(index)}`] = "variant01"
    for (const slot of FIGURE_SLOTS.notionists.slots) {
      slots[slot.key] = slot.variants[0] as string
    }
    const { config } = sanitizeFigure("notionists", { slots })
    const kept = Object.keys(config.slots ?? {}).length
    /**
     * 判据是"不超过槽位数"而不是"恰好等于" —— 后者会在上游加一个
     * 槽位时红，而那时功能是好的。上界本身才是要锁的东西。
     */
    expect(kept).toBeLessThanOrEqual(FIGURE_SLOTS.notionists.slots.length)
    // 同时要真的留下了东西（否则"上界"可以靠全丢来满足）
    expect(kept).toBeGreaterThan(0)
  })

  it("颜色槽同样有界", () => {
    const colors: Record<string, string> = {}
    for (let index = 0; index < 500; index += 1) colors[`junk${String(index)}Color`] = "000000"
    const { config } = sanitizeFigure("lorelei", { colors })
    expect(config.colors).toBeUndefined()
  })
})
