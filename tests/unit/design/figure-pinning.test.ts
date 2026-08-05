/**
 * 反证型门禁：**pin 真的生效**，且校验真的在过滤。
 *
 * ## 为什么这个文件的断言要这么挑
 *
 * DiceBear 对非法选项**从不抛错**（实测：不存在的变体、跨风格的槽位、
 * 非法颜色格式，全都静默忽略）。所以"没报错"是一条**恒真**断言 ——
 * 它在功能完好时通过，在功能完全坏掉时也通过。
 * 这里的每条断言都必须是**会随缺陷变化的量**。
 *
 * ## ★★ 「seed 不再影响产物」的断言必须跨多个 seed
 *
 * 四个概率槽的 schema 默认值是 `beard:10 bodyIcon:75 gesture:10 glasses:20`
 * —— 也就是说不显式钉住概率时，"这件到底出不出现"仍由 seed 掷骰子决定。
 * 4 个开关最多 2⁴=16 种组合，所以**只比两个 seed 时有约 1/16 的概率
 * 两边掷出同一组开关而侥幸相等**。
 *
 * 一条靠运气通过的断言比没有断言更糟：它让人以为这件事已经被锁住了。
 * 所以下面用 20 个 seed 并断言 `new Set(...).size`。
 */
import { describe, expect, it } from "vitest"
import { createAvatar } from "@dicebear/core"
import * as notionists from "@dicebear/notionists"
import {
  FIGURE_PRESETS,
  FIGURE_SLOTS,
  figureToOptions,
  sanitizeFigure,
  type FigureStyleSlots,
} from "@mycontext/design"

/** 20 个 seed。两个不够 —— 见文件头。 */
const SEEDS = Array.from({ length: 20 }, (_, index) => `seed-${String(index)}`)

function render(options: Record<string, unknown>, seed = "seed-0"): string {
  return createAvatar(notionists, { seed, ...options }).toString()
}

/** 20 个 seed 下产出多少种**不同**的产物。1 = 真正的 seed 无关。 */
function distinct(options: Record<string, unknown>): number {
  return new Set(SEEDS.map((seed) => render(options, seed))).size
}

/**
 * ★ 每次从**工厂函数**展开新对象。
 *
 * 共享一个可变对象会让这些测试互相污染 —— 而那种污染的表现是
 * "反证时不该红的断言也红了"，会把人引到错误的结论上。
 */
const enumOnly = (): Record<string, unknown> => ({
  base: ["variant01"],
  beard: ["variant01"],
  body: ["variant01"],
  bodyIcon: ["electric"],
  brows: ["variant01"],
  eyes: ["variant01"],
  gesture: ["ok"],
  glasses: ["variant01"],
  hair: ["variant01"],
  lips: ["variant01"],
  nose: ["variant01"],
})

/**
 * 全钉死 = 11 个枚举槽 **+ 4 个概率槽**。
 *
 * 概率槽**不能省**（这是本文件最重要的一条）：只钉枚举槽时
 * 20+ 个 seed 会产出多达十几种不同产物。
 * 注：这里钉的是 schema 里全部 11 个枚举槽，含会被 UI 过滤掉的 `base`
 * —— 测的是 DiceBear 的行为，要钉全，不能只钉进 UI 的那 10 个。
 */
const fullPin = (): Record<string, unknown> => ({
  ...enumOnly(),
  beardProbability: 100,
  bodyIconProbability: 100,
  gestureProbability: 100,
  glassesProbability: 100,
})

describe("pin 真的生效（针对 DiceBear 静默忽略非法值）", () => {
  it("① 两个不同的合法 pin → 产物必然不同", () => {
    // 判据不能是"没抛错"（DiceBear 从不抛，那条恒真）
    expect(render({ hair: ["variant07"] })).not.toBe(render({ hair: ["variant30"] }))
  })

  it("② 全钉死（含概率槽）后 seed 不再影响产物", () => {
    expect(distinct(fullPin())).toBe(1)
  })

  it("②b 反面：不钉概率槽时 seed 仍然影响产物", () => {
    /**
     * ★ 这条与 ② **互为反面**，必须同时存在。
     *
     * 只有 ② 时，那条断言在"钉概率"与"不钉概率"两种实现下**都会通过**
     * （后者靠 1/16 的运气）—— 一条在缺陷存在时仍为真的断言等于没有断言。
     * 有了 ②b，"把 ② 里的概率槽简化掉"这个改动会让 ② 变红而 ②b 仍绿。
     */
    expect(distinct(enumOnly())).toBeGreaterThan(1)
  })

  it("⑦ 确定性护栏：同 seed 两次渲染字节相同", () => {
    /**
     * 这条锁的是 core 选项 `randomizeIds` 保持关闭。
     * 实测 `randomizeIds:true` 时**同参数两次渲染产出不同字符串** ——
     * 它一旦被打开，本文件的一批断言与 `PersonaFigure` 的 memo 会同时
     * 变成随机红，而那种红看起来像"测试不稳定"，最容易被加 retry 糊过去。
     * `FigureConfig.background` 刻意不给它入口。
     */
    expect(render({}, "seed-A")).toBe(render({}, "seed-A"))
    expect(render({ randomizeIds: true }, "s")).not.toBe(render({ randomizeIds: true }, "s"))
  })
})

describe("sanitizeFigure 真的在过滤", () => {
  it("③ 不存在的变体被丢掉并报出", () => {
    const { config, dropped } = sanitizeFigure("notionists", { slots: { hair: "variant99" } })
    expect(dropped).toContain("hair")
    expect(config.slots?.["hair"]).toBeUndefined()
  })

  it("★ 注入串必须被我们自己的校验丢掉（不依赖上游的转义）", () => {
    /**
     * ## 为什么这条断言的判据在**我们**这边
     *
     * 实测 DiceBear **会**转义注入内容：把 `" onload="alert(1)` 与
     * `</svg><script>` 喂进颜色槽，在真实解析器下 `[onload]` 数为 0、
     * `script` 数为 0，`rect fill` 被解析成 `#fff`。也就是说
     * `COLOR_RE` 今天**不是**唯一防线。
     *
     * 但那是**上游的**行为，而上游可以改（它没有为此承诺过任何契约）。
     * 一条"渲染出来没有 onload"的断言测的是 DiceBear 的转义策略，
     * 它哪天变了我们才知道 —— 那时 `COLOR_RE` 会**默默**成为唯一防线，
     * 而没有任何测试在看着它。
     *
     * 所以判据取"经 sanitize 后必被 drop"：那是**我们**的逻辑，
     * 谁把 `COLOR_RE` 放宽了（比如为了支持 `#rrggbb` 而加个 `#?`）
     * 这条就红。
     */
    const payloads = [
      '" onload="alert(1)',
      "</svg><script>alert(1)</script>",
      "url(javascript:alert(1))",
      "#fff",
      "red",
      "f9c9b6 ",
      "f9c9b",
      "f9c9b6f9",
      "javascript:alert(1)",
    ]
    for (const payload of payloads) {
      const { config, dropped } = sanitizeFigure("lorelei", {
        colors: { hairColor: payload },
        background: { color: payload },
      })
      expect(dropped, `颜色槽收下了 ${JSON.stringify(payload)}`).toContain("hairColor")
      expect(dropped, `背景色收下了 ${JSON.stringify(payload)}`).toContain("background.color")
      expect(config.colors?.["hairColor"]).toBeUndefined()
      expect(config.background?.color).toBeUndefined()
    }
    // 反面：合法值不许被这套校验顺手丢掉（否则上面那条恒真）
    expect(sanitizeFigure("lorelei", { colors: { hairColor: "f9c9b6" } }).dropped).toEqual([])
    expect(sanitizeFigure("lorelei", { colors: { hairColor: "transparent" } }).dropped).toEqual([])
  })

  it("★ 槽位名/变体名里的注入串同样被丢掉", () => {
    // 槽位走的是"必须在变体表里"，比正则更严 —— 但要有断言看着
    const { config, dropped } = sanitizeFigure("notionists", {
      slots: { "<script>": "x", hair: "</svg><script>alert(1)</script>" },
    })
    expect(dropped.sort()).toEqual(["<script>", "hair"])
    expect(config.slots).toBeUndefined()
  })

  it("④ 跨风格残留：notionists 的 lips/gesture 喂给 lorelei 要被丢掉", () => {
    expect(sanitizeFigure("lorelei", { slots: { lips: "variant11" } }).dropped).toContain("lips")
    expect(sanitizeFigure("lorelei", { slots: { gesture: "ok" } }).dropped).toContain("gesture")
  })

  it("⑤ 同名不同域：hair variant57 在 notionists 合法、在 lorelei 不合法", () => {
    /**
     * ★ 这是最容易写漏的一处。`hair` 在两个风格里**都有**，
     * 所以只比 key 集合会让这个值原样搬过去 —— 而 lorelei 只有 48 个
     * 变体，`variant57` 超出范围会被 DiceBear 静默忽略，
     * 表现是"切了风格头发就没了，而且没人告诉我"。
     */
    expect(sanitizeFigure("notionists", { slots: { hair: "variant57" } }).dropped).toEqual([])
    expect(sanitizeFigure("lorelei", { slots: { hair: "variant57" } }).dropped).toContain("hair")
  })

  it("非法颜色格式被丢掉（带 # 的 hex 是非法值）", () => {
    // schema 的 pattern 是 ^(transparent|[a-fA-F0-9]{6})$ —— `#` 不合法
    expect(sanitizeFigure("lorelei", { colors: { hairColor: "#77311d" } }).dropped).toContain(
      "hairColor",
    )
    expect(sanitizeFigure("lorelei", { colors: { hairColor: "77311d" } }).dropped).toEqual([])
  })
})

describe("可选槽位的概率必须被钉住", () => {
  it("⑥ 选中一件时 figureToOptions 必须写 probability=100", () => {
    const options = figureToOptions("notionists", { slots: { glasses: "variant03" } })
    expect(options["glassesProbability"]).toBe(100)
    expect(options["glasses"]).toEqual(["variant03"])
  })

  it("⑥b 「不要」时写 probability=0，且不写变体", () => {
    const options = figureToOptions("notionists", { slots: { glasses: null } })
    expect(options["glassesProbability"]).toBe(0)
    expect(options["glasses"]).toBeUndefined()
  })

  it("⑥c 键不存在时什么都不写（保持由 seed 决定）", () => {
    /**
     * 三态的第一态。写了概率就等于替用户做了决定，
     * 而"我没碰过这一项"与"我明确不要"必须可区分
     * （与 onboarding_progress 里 pending vs skipped 同理）。
     */
    const options = figureToOptions("notionists", { slots: {} })
    expect(options["glassesProbability"]).toBeUndefined()
    expect(options["glasses"]).toBeUndefined()
  })

  it("⑥d prob=100 与 prob=0 的产物必须不同（证明开关真的接上了）", () => {
    const base = fullPin()
    expect(render({ ...base, glasses: ["variant03"], glassesProbability: 100 })).not.toBe(
      render({ ...base, glasses: ["variant03"], glassesProbability: 0 }),
    )
  })

  it("⑥e 三态在 20 个 seed 下的行为：可能变 / 恒有 / 恒无", () => {
    /**
     * 这条是 R16 的直接断言 —— "我选了眼镜，改个名字眼镜没了"。
     *
     * ## ★ 底座为什么是 enumOnly 而不是 fullPin
     *
     * `fullPin` 自己就带 `glassesProbability: 100`，会**盖住**
     * `figureToOptions` 有没有写那个概率 —— 于是把
     * "选中时写 probability=100" 这段逻辑删掉，这条断言照样通过。
     * 实测确认过：用 fullPin 做底座时，删掉那段逻辑此断言仍绿。
     *
     * 换成 `enumOnly`（钉住其余枚举槽但**不钉任何概率**）之后，
     * 这一件的有无就完全取决于 `figureToOptions` 写了什么 ——
     * 那才是我们要测的量。
     */
    const bare = () => {
      const base = enumOnly()
      // 把另外三个概率槽钉住，让唯一的变量是 glasses
      return {
        ...base,
        beardProbability: 100,
        bodyIconProbability: 100,
        gestureProbability: 100,
      }
    }
    const withOn = figureToOptions("notionists", { slots: { glasses: "variant03" } })
    const withOff = figureToOptions("notionists", { slots: { glasses: null } })
    // 恒有 / 恒无：20 个 seed 只有一种产物
    expect(distinct({ ...bare(), ...withOn })).toBe(1)
    expect(distinct({ ...bare(), ...withOff })).toBe(1)
    /**
     * 而"没碰过"那一态**必须**随 seed 变 —— 这是 R16 的反面：
     * `glassesProbability` 的默认值是 20，所以不写它时眼镜有 80% 的
     * 概率不出现。这条同时证明了上面两条不是恒真的。
     */
    expect(distinct(bare())).toBeGreaterThan(1)
  })
})

describe("生成物的 core 排除表是差集而不是全集", () => {
  it("⑧ thumbs / funEmoji 的 backgroundColor 必须在它们自己的 colorSlots 里", () => {
    /**
     * ★ 结论 4 的反例锁。这两个风格自己的 schema 里**就有**
     * `backgroundColor`，而它们走"仅预设 + 背景色"路线 ——
     * 用 core 全集做排除表会把它们**唯一**的定制维度排掉，
     * 结果 UI 上什么都不剩。实测那个 bug 会让 funEmoji 的
     * colorSlots 变成空数组。
     */
    expect(FIGURE_SLOTS.thumbs.colorSlots).toContain("backgroundColor")
    expect(FIGURE_SLOTS.funEmoji.colorSlots).toContain("backgroundColor")
  })

  it("任何风格都不含 core 独有的 key", () => {
    // seed / size / randomizeIds 被当成槽位的话，用户会看到一个叫 seed 的抽屉
    const coreOnly = ["seed", "size", "randomizeIds", "flip", "rotate", "scale", "clip"]
    for (const table of Object.values(FIGURE_SLOTS)) {
      for (const key of coreOnly) {
        expect(table.slots.map((slot) => slot.key)).not.toContain(key)
        expect(table.colorSlots).not.toContain(key)
      }
    }
  })
})

describe("生成器的过滤判据", () => {
  it("过滤后的可用槽位数与 colorSlots 数（实测基准）", () => {
    const shape = Object.fromEntries(
      Object.entries(FIGURE_SLOTS).map(([style, table]) => [
        style,
        [table.slots.length, table.colorSlots.length],
      ]),
    )
    expect(shape).toEqual({
      notionists: [10, 0],
      lorelei: [11, 10],
      micah: [10, 10],
      funEmoji: [2, 1],
      bottts: [6, 1],
      thumbs: [3, 4],
    })
  })

  it("单变体槽位：无概率槽的被过滤，有概率槽的保留为 toggleOnly", () => {
    /**
     * ★ "一律过滤单变体"会砍掉 lorelei 的 freckles / hairAccessories
     * 两个真实定制项（实测它们 prob 0 vs 100 的产物不同 ——
     * 那是"要不要雀斑"这种真开关）。
     */
    const notionistsKeys = FIGURE_SLOTS.notionists.slots.map((slot) => slot.key)
    expect(notionistsKeys).not.toContain("base")
    expect(FIGURE_SLOTS.micah.slots.map((slot) => slot.key)).not.toContain("base")
    expect(FIGURE_SLOTS.thumbs.slots.map((slot) => slot.key)).not.toContain("shape")

    /**
     * ★ 这里要把 `as const` 的字面量类型放宽成 `FigureStyleSlots`。
     *
     * 生成物用 `as const satisfies …`：`satisfies` 让"生成器写出了不符合
     * 接口的东西"变成编译错误（那是我们要的），而 `as const` 让每个槽位
     * 成为一个**独立的对象类型** —— 于是 `slot.toggleOnly` 在那些
     * 没有该字段的联合分支上"不存在"，`tsc` 会报 TS2339。
     * 运行时完全没问题（读一个不存在的属性得到 undefined），
     * 只是类型太窄。放宽只在这一处做，与 `figure-model.ts` 的 `slotsOf` 同理。
     */
    const table: Record<string, FigureStyleSlots> = FIGURE_SLOTS
    const toggles = Object.entries(table).flatMap(([style, entry]) =>
      entry.slots.filter((slot) => slot.toggleOnly === true).map((slot) => `${style}.${slot.key}`),
    )
    expect(toggles.sort()).toEqual(["lorelei.freckles", "lorelei.hairAccessories"])
  })

  it("变体名原样转录：不修上游拼写，不重排顺序", () => {
    const hair = FIGURE_SLOTS.notionists.slots.find((slot) => slot.key === "hair")
    // 64 个里最后一个不是编号而是 "hat"
    expect(hair?.variants).toHaveLength(64)
    expect(hair?.variants.at(-1)).toBe("hat")
    // 上游的顺序是倒序 —— 那就是它给的展示顺序，不许重排
    expect(hair?.variants[0]).toBe("variant63")
    // micah.nose 的 "tound" 是上游拼写错误（应为 round）。**不许修** ——
    // 改了就与 schema 不符，那个变体会变成非法值并被静默忽略
    const nose = FIGURE_SLOTS.micah.slots.find((slot) => slot.key === "nose")
    expect(nose?.variants).toContain("tound")
    expect(nose?.variants).not.toContain("round")
  })

  it("thumbs 的非枚举属性没有变成槽位", () => {
    // faceOffsetX/Y 之类是"取值区间的上下界"，UI 无从表达
    const keys = FIGURE_SLOTS.thumbs.slots.map((slot) => slot.key)
    expect(keys.filter((key) => /Offset|Rotation/.test(key))).toEqual([])
  })
})

describe("预设都是合法的（手写常量会写错变体名）", () => {
  it("每条预设过 sanitizeFigure 后不丢任何一项", () => {
    /**
     * 预设是**手写**的，而手写的变体名会错（`micah.nose` 的正确拼写是
     * 上游的 `tound` 而不是 `round`）。写错的表现是那一项被静默丢掉
     * —— 用户点了预设，得到一个"少了点什么"的形象。
     * 这条断言让"写错了"在 CI 就红。
     *
     * 从 design 包 import 真正在用的那份常量，不抄一份 ——
     * 抄了就只能锁住副本，而副本永远是对的。
     */
    for (const preset of FIGURE_PRESETS) {
      const { dropped } = sanitizeFigure(preset.style, preset.config)
      expect(dropped, `预设 ${preset.id} 有不合法的项`).toEqual([])
    }
  })

  it("每条预设都真的改变了产物（空预设是一个静默的无操作）", () => {
    /**
     * 一条 `dropped` 为空但**全部**被丢光的预设（比如整个 config 写成
     * 了另一个风格的槽位名）也会通过上面那条 —— 因为 `{}` 的 dropped
     * 也是空。所以再断言它真的有效果。
     */
    for (const preset of FIGURE_PRESETS) {
      const options = figureToOptions(
        preset.style,
        sanitizeFigure(preset.style, preset.config).config,
      )
      expect(Object.keys(options).length, `预设 ${preset.id} 什么都没改`).toBeGreaterThan(0)
    }
  })
})
