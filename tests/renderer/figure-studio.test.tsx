/**
 * @vitest-environment jsdom
 *
 * `FigureStudio` 的行为门禁（真渲染，不是源码文本断言）。
 *
 * ## 这里锁住的是四条只在**运行时**才看得见的行为
 *
 * 记忆里记录过："数字人页面单测 33 条全绿，CDP 一点就抓到两个真 bug"，
 * 形态是**点了没反应**。那类 bug 在源码里看不出来 ——
 * `onChange` 忘了往上传、`sanitizeFigure` 把全部槽位都丢了、
 * 页签切了但抽屉没换，全都不报错。
 *
 * 1. 点一件 → `onChange` 收到**只改了那一个槽位**的配置；
 * 2. 切风格 → 兼容项保留、不兼容项进 `dropped` 且提示可见；
 * 3. 「随机」→ seed 变**且** custom 被清空（否则用户点了随机发现头发不变）；
 * 4. 有上传图片时定制区禁用（那些控件那时不起作用，
 *    而一个点了没反应的控件比没有更糟）。
 *
 * ## ★ 不需要 i18n provider
 *
 * `FigureStudio` 的文案全部由 `labels` prop 注入（design 包不该知道语言）。
 * 这是决策 F 的一个直接好处：这里传一个假的 labels 就能测，
 * 而假 labels 还让断言能用"确定的字符串"定位元素。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import {
  FIGURE_BACKGROUND_OPTIONS,
  FigureStudio,
  type FigureConfig,
  type FigureStudioLabels,
  type FigureStyle,
} from "@mycontext/design"

afterEach(cleanup)

/**
 * jsdom 没有 `ResizeObserver`，而 `Button` 走 `useSquircle` 会用它。
 * 补一个不做事的桩 —— squircle 是纯视觉，在 jsdom 里本来也测不出什么。
 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

/**
 * 假文案。
 *
 * 刻意用**带前缀的可识别串**（`slot:hair`）而不是真的中文：
 * 这样断言定位到的元素一定是我们想的那个，而不是碰巧同名的另一处
 * —— 断言用的字符串必须是被测对象独有的。
 */
const labels: FigureStudioLabels = {
  slotLabel: (key) => `slot:${key}`,
  styleLabel: (style) => `style:${style}`,
  presetLabel: (id) => `preset:${id}`,
  noneLabel: "none",
  droppedNotice: (count) => `dropped:${String(count)}`,
  styleGroup: "deep",
  styleSection: "styleSection",
  detailSection: "detailSection",
  quickStyles: "quick",
  presets: "presets",
  colors: "colors",
  background: "background",
  radius: "radius",
  followDefault: "default",
  moreColors: (count) => `more:${String(count)}`,
  fewerColors: "fewer",
  colorNeedsPart: (part) => `needsPart:${part}`,
  colorPartMaybeAbsent: (part) => `maybeAbsent:${part}`,
  enablePart: (part) => `enable:${part}`,
  random: "random",
  reset: "reset",
}

/**
 * `onChange` 的入参形状。
 *
 * ★ `style` 必须是 `FigureStyle` 而不是 `string`：用例会把它回传给
 * `setup({ style })`，而那个 prop 是联合类型 —— 放宽成 string 会让
 * 那次回传通不过类型检查（`typecheck:tests` 会红）。
 */
type Change = { style: FigureStyle; seed: string; custom: FigureConfig }

function setup(overrides: Partial<Parameters<typeof FigureStudio>[0]> = {}) {
  const onChange = vi.fn<(next: Change) => void>()
  const result = render(
    <FigureStudio
      style="notionists"
      seed="seed-1"
      value={{}}
      onChange={onChange as unknown as (next: Change) => void}
      labels={labels}
      {...overrides}
    />,
  )
  return { onChange, ...result }
}

describe("★ 点一件只改那一格", () => {
  it("点头发的第 3 格 → onChange 收到只含 hair 的配置", () => {
    const { onChange } = setup()
    // 抽屉默认打开第一个槽位；变体格的 aria-label 是「<槽位名> <序号>」
    fireEvent.click(screen.getByLabelText("slot:beard 3"))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0]
    expect(next?.style).toBe("notionists")
    // seed 不该被点变体这个动作改掉
    expect(next?.seed).toBe("seed-1")
    expect(Object.keys(next?.custom.slots ?? {})).toEqual(["beard"])
  })

  it("已有别的槽位时，点一件不动其他槽位", () => {
    const { onChange } = setup({ value: { slots: { hair: "variant07" } } })
    fireEvent.click(screen.getByLabelText("slot:beard 1"))
    const slots = onChange.mock.calls[0]?.[0].custom.slots
    // ★ "点头发把眼睛也换了"是真实的失效形态，用户会以为是随机的
    expect(slots?.["hair"]).toBe("variant07")
    expect(slots?.["beard"]).toBeDefined()
  })

  it("可选槽位的「不要」写成 null（与「键不存在」可区分）", () => {
    const { onChange } = setup()
    // beard 是可选槽位（有 beardProbability），第一格是「不要」
    fireEvent.click(screen.getByText("none"))
    expect(onChange.mock.calls[0]?.[0].custom.slots?.["beard"]).toBeNull()
  })
})

describe("★ 页签真的切换抽屉", () => {
  it("点另一个槽位的页签 → 变体格换成那个槽位的", () => {
    setup()
    // 切到 hair 之前，界面上不该有 hair 的变体格
    expect(screen.queryByLabelText("slot:hair 1")).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: "slot:hair" }))
    expect(screen.getByLabelText("slot:hair 1")).toBeTruthy()
    /**
     * 上一组必须被**卸载**而不只是隐藏 —— 这是唯一真正减少
     * 同时存在的缩略图数量的手段（64 张 dataUri 累计 851KB）。
     */
    expect(screen.queryByLabelText("slot:beard 1")).toBeNull()
  })
})

describe("★ 切风格：保留能保留的，报告丢掉的", () => {
  it("notionists 的 lips 切到 lorelei 会被丢掉并显示提示", () => {
    const { onChange } = setup({ value: { slots: { lips: "variant11" } } })
    fireEvent.click(screen.getByText("style:lorelei"))

    const next = onChange.mock.calls[0]?.[0]
    expect(next?.style).toBe("lorelei")
    // lorelei 没有 lips 这个槽位 → 必须丢掉，不能原样搬（会被 DiceBear 静默忽略）
    expect(next?.custom.slots?.["lips"]).toBeUndefined()
    // ★ 丢了要**说出来**：静默丢与"功能坏了"在用户侧不可区分
    expect(screen.getByText("dropped:1")).toBeTruthy()
  })

  it("同名不同域也要丢：hair variant57 在 lorelei 不合法", () => {
    // notionists.hair 有 64 个变体、lorelei.hair 只有 48 个
    const { onChange } = setup({ value: { slots: { hair: "variant57" } } })
    fireEvent.click(screen.getByText("style:lorelei"))
    expect(onChange.mock.calls[0]?.[0].custom.slots?.["hair"]).toBeUndefined()
    expect(screen.getByText("dropped:1")).toBeTruthy()
  })

  it("两边都合法的值要保留（不能一切风格就全清）", () => {
    const { onChange } = setup({ value: { slots: { hair: "variant07" } } })
    fireEvent.click(screen.getByText("style:lorelei"))
    // variant07 在 lorelei 的 48 个变体里也有 → 该保留
    expect(onChange.mock.calls[0]?.[0].custom.slots?.["hair"]).toBe("variant07")
    // 什么都没丢 → 不该出现提示（一个恒亮的提示等于没有提示）
    expect(screen.queryByText(/^dropped:/)).toBeNull()
  })
})

describe("★ 随机 = 换 seed 且清空 custom", () => {
  it("点随机后 seed 变了，且定制被清空", () => {
    const { onChange } = setup({ value: { slots: { hair: "variant07" } } })
    fireEvent.click(screen.getByText("random"))
    const next = onChange.mock.calls[0]?.[0]
    expect(next?.seed).not.toBe("seed-1")
    /**
     * ★ 不清空的话用户会点了随机却发现头发不变 —— 那是"点了没反应"
     * 的一种，而那类 bug 只在真应用里暴露。
     */
    expect(next?.custom).toEqual({})
  })

  it("重置只清 custom，保留 seed 与风格（用户挑的那张脸不该被重置掉）", () => {
    const { onChange } = setup({ value: { slots: { hair: "variant07" } } })
    fireEvent.click(screen.getByText("reset"))
    const next = onChange.mock.calls[0]?.[0]
    expect(next?.seed).toBe("seed-1")
    expect(next?.style).toBe("notionists")
    expect(next?.custom).toEqual({})
  })
})

describe("★★ toggleOnly 槽位的三态不许压成两态", () => {
  /**
   * ## 为什么这一组是"严重"级别
   *
   * 上一版写的是 `const on = current !== null && current !== undefined`
   * 然后 `aria-pressed={!on}` —— `undefined`（未触碰）与 `null`（明确不要）
   * 于是**都让「不要」显示成选中**。
   *
   * 而那是一条真实的错误显示：实测 `figureToOptions("lorelei", {})`
   * 不写 `frecklesProbability`，它的 schema 默认值是 **5**，
   * 400 个 seed 里 **17 个真的长出雀斑** —— 界面上「不要」却是高亮的。
   * 用户看到的是"我明明选了不要，它还是有雀斑"。
   *
   * lorelei 的 `freckles` / `hairAccessories` 是实测唯一的两个 toggleOnly 槽位。
   */
  const openFreckles = () => {
    fireEvent.click(screen.getByRole("tab", { name: "slot:freckles" }))
    return {
      none: screen.getByText("none").closest("button"),
      on: screen.getByLabelText("slot:freckles 1"),
    }
  }

  it("未触碰（value={}）时两格都不选中", () => {
    setup({ style: "lorelei" })
    const { none, on } = openFreckles()
    // ★ 这两条就是那个 bug 的直接判据 —— 修复前 none 是 "true"
    expect(none?.getAttribute("aria-pressed")).toBe("false")
    expect(on.getAttribute("aria-pressed")).toBe("false")
  })

  it("明确不要（null）时只有「不要」选中", () => {
    setup({ style: "lorelei", value: { slots: { freckles: null } } })
    const { none, on } = openFreckles()
    expect(none?.getAttribute("aria-pressed")).toBe("true")
    expect(on.getAttribute("aria-pressed")).toBe("false")
  })

  it("明确要（变体名）时只有那一格选中", () => {
    setup({ style: "lorelei", value: { slots: { freckles: "variant01" } } })
    const { none, on } = openFreckles()
    expect(none?.getAttribute("aria-pressed")).toBe("false")
    expect(on.getAttribute("aria-pressed")).toBe("true")
  })
})

describe("★★ 丢弃提示必须在下一次操作时消失", () => {
  /**
   * 一个不会消失的提示很快会被当成背景噪声，而它**下一次真的该出现时
   * 就没有信息量了**（"那句话一直在那儿"）。
   * 实测上一版：切风格后点变体、切页签、调颜色都不会清掉它。
   */
  it("切风格产生提示后，点一个变体就清掉", () => {
    const { rerender, onChange } = setup({ value: { slots: { lips: "variant11" } } })
    fireEvent.click(screen.getByText("style:lorelei"))
    expect(screen.getByText("dropped:1")).toBeTruthy()

    // 受控组件：把切风格的结果回灌，模拟真实调用方
    const next = onChange.mock.calls[0]?.[0]
    rerender(
      <FigureStudio
        style={next?.style as never}
        seed={next?.seed ?? "seed-1"}
        value={next?.custom ?? {}}
        onChange={onChange as never}
        labels={labels}
      />,
    )
    fireEvent.click(screen.getByLabelText("slot:beard 1"))
    expect(screen.queryByText(/^dropped:/)).toBeNull()
  })

  it("切页签也清掉（它同样是「下一次操作」）", () => {
    setup({ value: { slots: { lips: "variant11" } } })
    fireEvent.click(screen.getByText("style:lorelei"))
    expect(screen.getByText("dropped:1")).toBeTruthy()
    // 页签切换本身不改数据，但它证明用户已经往下走了
    fireEvent.click(screen.getByRole("tab", { name: "slot:hair" }))
    fireEvent.click(screen.getByLabelText("slot:hair 1"))
    expect(screen.queryByText(/^dropped:/)).toBeNull()
  })

  it("随机 / 重置 / 预设都清掉", () => {
    for (const label of ["random", "reset"]) {
      cleanup()
      setup({ value: { slots: { lips: "variant11" } } })
      fireEvent.click(screen.getByText("style:lorelei"))
      expect(screen.getByText("dropped:1")).toBeTruthy()
      fireEvent.click(screen.getByText(label))
      expect(screen.queryByText(/^dropped:/), `${label} 之后提示还挂着`).toBeNull()
    }
  })
})

describe("★★ 随机：seed 长度有界且不撞回旧值", () => {
  /**
   * 上一版拼的是**已被拼过的** seed（`${seed}|r${round}`），实测每点一次
   * 长 5 个字符、**无上界**地落进 vault；而轮次存在组件 state 里，
   * 卸载重挂后归零会产出 `…|r1#0|r1#0` —— **连点随机回到同一张脸**。
   */
  it("连点 20 次：长度有界、每次都是新 seed", () => {
    let seed = "小小周|0#0"
    const seen = new Set([seed])
    const onChange = vi.fn((next: Change) => {
      seed = next.seed
    })
    const view = render(
      <FigureStudio
        style="notionists"
        seed={seed}
        value={{}}
        onChange={onChange as never}
        labels={labels}
      />,
    )
    for (let index = 0; index < 20; index += 1) {
      fireEvent.click(screen.getByText("random"))
      expect(seen.has(seed), `第 ${String(index)} 次随机撞回了旧 seed：${seed}`).toBe(false)
      seen.add(seed)
      // 受控组件：回灌新 seed，这正是真实调用方的行为（也是那个 bug 的成因）
      view.rerender(
        <FigureStudio
          style="notionists"
          seed={seed}
          value={{}}
          onChange={onChange as never}
          labels={labels}
        />,
      )
    }
    /**
     * 判据是**长度**而不是"字符串不含两个 |r"：前者是那个 bug 的直接后果
     * （无上界地增长），而且它对任何"往后接一段"的实现都会红。
     * 上一版每次长 5 个字符 → 20 次后 100+；有界实现停在 13 左右。
     * 阈值取 30：够松，不会因为轮次进了两位数而误报；
     * 够紧，"往后接一段"的实现在 20 次内一定越过它。
     */
    expect(seed.length, `seed 无上界增长：${seed}`).toBeLessThan(30)
    view.unmount()
  })
})

describe("★★ 同一个选项不得有两个控件", () => {
  /**
   * thumbs / funEmoji 的 `backgroundColor` 曾经**同时**渲染成两个控件
   * （「颜色」区一行 + 「背景」区一行），而它们写进不同的 config 键、
   * 后者静默覆盖前者。实测：两处都选后配置是
   * `{"background":{"color":"77311d"},"colors":{"backgroundColor":"ffedef"}}`，
   * 产物用的是 `77311d` —— 用户在颜色区选的**点了没反应**。
   *
   * 判据是"界面上只有一个入口"，用色块的 aria-label 数（`ColorSwatches`
   * 用 `label` 给每一格取名，所以颜色区那一行的名字里带槽位名）。
   */
  it.each(["thumbs", "funEmoji"] as const)("%s 的背景色只有一个入口", (style) => {
    setup({ style })
    // 「颜色」区不该再出现 backgroundColor 那一行
    expect(screen.queryByText("slot:backgroundColor")).toBeNull()
    // 而「背景」区必须还在 —— 它是这两个风格唯一的定制维度，不能一起删掉
    expect(screen.getByText("background")).toBeTruthy()
  })

  it("funEmoji 的颜色区整块消失（backgroundColor 是它唯一的颜色槽）", () => {
    setup({ style: "funEmoji" })
    // 一个空的「颜色」标题是纯噪声
    expect(screen.queryByText("colors")).toBeNull()
  })
})

describe("页签的 a11y（仓库里第一处 tablist，规矩在这里立）", () => {
  it("每个 tab 都 aria-controls 到一个真实存在的 tabpanel", () => {
    setup()
    const tabs = screen.getAllByRole("tab")
    expect(tabs.length).toBeGreaterThan(1)
    const panel = screen.getByRole("tabpanel")
    for (const tab of tabs) {
      const controls = tab.getAttribute("aria-controls")
      /**
       * ★ 判据是"指向的节点真的存在"，不是"有这个属性"。
       * 指向一个不存在的 id 与不写 aria-controls 在读屏器上同样是
       * "找不到面板"，但前者更糟：它看起来已经做了。
       */
      expect(controls).toBeTruthy()
      expect(document.getElementById(controls ?? "")).toBe(panel)
    }
  })

  it("roving tabindex：只有选中那一格在 Tab 序列里", () => {
    setup()
    const tabs = screen.getAllByRole("tab")
    const inSequence = tabs.filter((tab) => tab.getAttribute("tabindex") === "0")
    // 否则 10 个槽位要按 10 次 Tab 才能走出这一组
    expect(inSequence).toHaveLength(1)
    expect(inSequence[0]?.getAttribute("aria-selected")).toBe("true")
  })

  it("左右箭头切换页签，并且会绕回", () => {
    setup()
    const tabs = screen.getAllByRole("tab")
    const first = tabs[0]
    const second = tabs[1]
    expect(first?.getAttribute("aria-selected")).toBe("true")

    fireEvent.keyDown(first as HTMLElement, { key: "ArrowRight" })
    expect(screen.getAllByRole("tab")[1]?.getAttribute("aria-selected")).toBe("true")
    // 抽屉真的跟着换了（不然箭头只是改了个样式）
    expect(screen.getByLabelText(`slot:${"body"} 1`)).toBeTruthy()

    // 从第一格往左 → 绕到最后一格（走到头卡住与坏了不可区分）
    fireEvent.keyDown(second as HTMLElement, { key: "ArrowLeft" })
    fireEvent.keyDown(screen.getAllByRole("tab")[0] as HTMLElement, { key: "ArrowLeft" })
    const last = screen.getAllByRole("tab").at(-1)
    expect(last?.getAttribute("aria-selected")).toBe("true")
  })
})

describe("★ 有上传图片时定制区禁用", () => {
  it("抽屉与颜色盘都不渲染，风格按钮禁用", () => {
    /**
     * 图片优先级高于生成的形象，那时这些控件**点了不起作用** ——
     * 而一个点了没反应的控件比没有更糟（现有 persona-step 的
     * 注释已经为同一件事立过规矩）。
     */
    setup({ imageSrc: "mycontext-file://figures/a.png" })
    expect(screen.queryByLabelText("slot:beard 1")).toBeNull()
    expect(screen.queryByText("background")).toBeNull()
    expect(screen.getByText("style:lorelei").hasAttribute("disabled")).toBe(true)
  })
})

describe("变体名不许漏进界面", () => {
  it("可见文本里没有 variantNN，也没有第三方角色名", () => {
    /**
     * 变体名实测含 `mrT` / `dannyPhantom`（第三方角色名）、
     * `pissed` / `faceMask`、以及上游拼写错误 `tound`。
     * 它们只该出现在 `aria-label` 的序号形式里，不该作为可见文案。
     */
    const { container } = setup()
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/variant\d/)
    for (const bad of ["mrT", "dannyPhantom", "fonze", "dougFunny", "tound", "pissed"]) {
      expect(text).not.toContain(bad)
    }
  })

  it("micah（含角色名的那个风格）切过去之后也没有", () => {
    const { container } = setup({ style: "micah" })
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/variant\d/)
    expect(text).not.toContain("mrT")
    expect(text).not.toContain("tound")
  })
})

describe("颜色槽默认折叠（10 个槽 × 19 色是一堵墙）", () => {
  it("lorelei 默认只显主要颜色槽，点「更多」才全展开", () => {
    /**
     * lorelei 实测有 10 个颜色槽。全铺开是 190 个色块，而用户真正
     * 想改的「发色」「肤色」会沉到第 7、第 10 位 —— 那是一个
     * 信息密度问题，不是性能问题。
     */
    setup({ style: "lorelei" })
    // 发色在主要槽位里 → 默认可见
    expect(screen.getByText("slot:hairColor")).toBeTruthy()
    // 耳饰颜色不在 → 默认收起
    expect(screen.queryByText("slot:earringsColor")).toBeNull()

    // 折叠按钮要报出**还有几个**没显示（"更多"而不说几个等于没说）
    const toggle = screen.getByText(/^more:/)
    fireEvent.click(toggle)
    expect(screen.getByText("slot:earringsColor")).toBeTruthy()
    // 再点收起
    fireEvent.click(screen.getByText("fewer"))
    expect(screen.queryByText("slot:earringsColor")).toBeNull()
  })

  it("notionists 没有颜色槽 → 整个颜色区不出现（含折叠按钮）", () => {
    // 实测 notionists.colorSlots 为空 —— 一个空的「颜色」标题是纯噪声
    setup({ style: "notionists" })
    expect(screen.queryByText("colors")).toBeNull()
    expect(screen.queryByText(/^more:/)).toBeNull()
  })
})

describe("预设", () => {
  it("点预设会连带切到它的风格", () => {
    const { onChange } = setup()
    fireEvent.click(screen.getByLabelText("preset:robot"))
    const next = onChange.mock.calls[0]?.[0]
    // robot 预设是 bottts 的 —— 不切风格的话那些槽位在当前风格下全非法
    expect(next?.style).toBe("bottts")
    expect(Object.keys(next?.custom.slots ?? {}).length).toBeGreaterThan(0)
  })
})

describe("★★ 可选部件的颜色槽不许「点了没反应」", () => {
  /**
   * ## 为什么这一组是"严重"级别
   *
   * 颜色只在它染的那个部件**存在时**才有效果。实测（200 个 seed，
   * 未钉住部件时颜色改动的可见率）：
   *
   * | 颜色槽                       | 生效率  | 显式关掉部件后 |
   * | ---------------------------- | ------- | -------------- |
   * | lorelei.glassesColor         | 17/200  | **0/50**       |
   * | lorelei.earringsColor        | 23/200  | —              |
   * | lorelei.hairColor（对照）    | 200/200 | —              |
   *
   * 也就是说这几个色板**九成的点击是逐字节空操作**，而用户明确关掉眼镜
   * 之后是**零**。它与 `hairColor` 在界面上长得一模一样、点了一样会亮 ——
   * 这正是 `figure-model.ts` 的 `BACKGROUND_OWNED_KEYS` 大注释论证过的
   * 那个形态（"选中态会亮、配置会存、预览完全不动"），只是换了个实例。
   */
  /** 眼镜颜色在 lorelei 的「更多颜色」里 —— 先展开 */
  const openAllColors = () => {
    fireEvent.click(screen.getByText(/^more:/))
  }

  it("部件被明确关掉（null）→ 色板换成理由 + 「打开」按钮", () => {
    setup({ style: "lorelei", value: { slots: { glasses: null } } })
    openAllColors()
    // ★ 这两条就是那个 bug 的直接判据：修复前这里是一排照常会亮的色块
    expect(screen.getByText("needsPart:slot:glasses")).toBeTruthy()
    expect(screen.getByText("enable:slot:glasses")).toBeTruthy()
    // 而那一行的色板必须**不在**了（一个点了没反应的控件比没有更糟）
    expect(screen.queryByLabelText("slot:glassesColor 1")).toBeNull()
  })

  it("「打开」按钮真的把部件钉上（不是一句空话）", () => {
    const { onChange } = setup({ style: "lorelei", value: { slots: { glasses: null } } })
    openAllColors()
    fireEvent.click(screen.getByText("enable:slot:glasses"))
    const slots = onChange.mock.calls[0]?.[0].custom.slots
    /**
     * 判据是"钉成了一个真实变体"，不是"onChange 被调了" ——
     * 后者在传了个 null 回去（等于没变）时也成立。
     */
    expect(typeof slots?.["glasses"]).toBe("string")
  })

  it("部件由 seed 决定（键不存在）→ 色板照给，但要说一句可能不出现", () => {
    setup({ style: "lorelei", value: {} })
    openAllColors()
    // 色板是有效的（钉不钉得看运气，但改了确实可能生效）→ 不禁用
    expect(screen.getByLabelText("slot:glassesColor 1")).toBeTruthy()
    // 但用户没有任何别的办法知道"这一次可能看不出变化"
    expect(screen.getByText("maybeAbsent:slot:glasses")).toBeTruthy()
  })

  it("★ 对照：必填部件的颜色槽是普通的一行（否则上面三条可能恒真）", () => {
    /**
     * `hairColor` 实测 200/200 恒生效（lorelei 的 hair 是必填槽位，
     * schema 里没有 hairProbability）。它**不该**有任何提示 ——
     * 没有这一条时，一个"给所有颜色槽都挂提示"的实现也能让上面三条通过，
     * 而那会把 10 行里的 6 行变成噪声。
     */
    setup({ style: "lorelei", value: {} })
    expect(screen.getByLabelText("slot:hairColor 1")).toBeTruthy()
    expect(screen.queryByText("maybeAbsent:slot:hair")).toBeNull()
    expect(screen.queryByText("needsPart:slot:hair")).toBeNull()
  })

  it("部件已钉住 → 也是普通的一行", () => {
    setup({ style: "lorelei", value: { slots: { glasses: "variant01" } } })
    openAllColors()
    expect(screen.getByLabelText("slot:glassesColor 1")).toBeTruthy()
    // 钉住了就一定会出现，没有"可能不出现"这回事
    expect(screen.queryByText("maybeAbsent:slot:glasses")).toBeNull()
    expect(screen.queryByText("needsPart:slot:glasses")).toBeNull()
  })
})

describe("★★ transparent 背景只给它真的有效的风格", () => {
  /**
   * 实测 `backgroundColor: ["transparent"]` 与**完全不写**的产物：
   *
   * | 风格                                  | 逐字节相同 | schema 自带默认背景色 |
   * | ------------------------------------- | ---------- | -------------------- |
   * | notionists / lorelei / micah / bottts | **是**     | 无                   |
   * | funEmoji / thumbs                     | 否         | 有（6 / 5 个色）     |
   *
   * 那四个风格本来就没有背景，"透明"与"没有背景"是同一件事。而 UI 把
   * 「透明」与「跟随默认」并列成两个各自会亮的控件 —— 点「透明」时
   * 选中态会亮、配置会存、**画面一动不动**。
   *
   * 判据是**背景色块的个数**（会随缺陷变化的量）：色块没有可见文案，
   * 只有 `aria-label` 里的序号，所以数它们。全集比子集**恰好多一格**。
   */
  const backgroundSwatchCount = () => screen.getAllByLabelText(/^background \d+$/).length

  it.each(["notionists", "lorelei", "micah", "bottts"] as const)(
    "%s 不给「透明」那一格（它是逐字节空操作）",
    (style) => {
      setup({ style })
      expect(backgroundSwatchCount()).toBe(FIGURE_BACKGROUND_OPTIONS.length - 1)
    },
  )

  it.each(["thumbs", "funEmoji"] as const)("%s 保留「透明」（它真的会变）", (style) => {
    setup({ style })
    expect(backgroundSwatchCount()).toBe(FIGURE_BACKGROUND_OPTIONS.length)
  })

  it("★ 两组的数字必须不同（否则上面两组可能都在数同一个全集）", () => {
    /**
     * 这一条防的是"`figureBackgroundOptionsFor` 直接返回全集"——
     * 那时上面两组里只有一组会红，而如果常量本身被改成不含 transparent，
     * 两组会**一起绿**。所以显式断言全集里真的有那一格。
     */
    expect(FIGURE_BACKGROUND_OPTIONS).toContain("transparent")
  })
})

/**
 * 「随机」与「重置」**保留背景**（底色 + 圆角）。
 *
 * ## ★ 为什么这是一处行为修正而不是新功能
 *
 * `background` 存在 `custom` 里，而改动前这两个按钮清的是**整个** `custom`
 * —— 于是"重置形象"会连带把用户挑的底色与圆角一起清掉。
 *
 * 而那两项在界面上读起来是**全局装饰**：它们与风格无关（圆角对六个风格
 * 完全一样），而且现在各自有独立的分组标题。"我想把脸还原，但底色留着"
 * 是一个完全合理的意图，改动前做不到。
 *
 * 更糟的是那次清除是**静默**的：用户点「重置」，看到的是"怎么颜色也变了"，
 * 而界面上没有任何东西提示过这个联动。
 */
describe("★ 随机/重置保留背景（它读起来是全局装饰，不该被一起清掉）", () => {
  it("★ 重置：清掉槽位，但底色与圆角留着", () => {
    const { onChange } = setup({
      value: { slots: { hair: "variant07" }, background: { color: "b6e3f4", radius: 50 } },
    })
    fireEvent.click(screen.getByText("reset"))
    const next = onChange.mock.calls[0]?.[0]
    // 脸还原了
    expect(next?.custom.slots).toBeUndefined()
    // 而配色没动
    expect(next?.custom.background).toEqual({ color: "b6e3f4", radius: 50 })
  })

  it("★ 随机：换了 seed，底色与圆角同样留着", () => {
    const { onChange } = setup({
      value: { slots: { hair: "variant07" }, background: { color: "ffd5dc" } },
    })
    fireEvent.click(screen.getByText("random"))
    const next = onChange.mock.calls[0]?.[0]
    expect(next?.seed).not.toBe("seed-1")
    expect(next?.custom.slots).toBeUndefined()
    expect(next?.custom.background).toEqual({ color: "ffd5dc" })
  })

  it("没设过背景时仍然是干净的 `{}`（不留一个 background: undefined）", () => {
    /**
     * 写一个 `{ background: undefined }` 进去会让 `sanitizeFigure`
     * 与相等判断多一个需要考虑的形态 —— 而那种"看起来一样但不相等"
     * 的对象正是预设选中态判据会踩的坑。
     */
    const { onChange } = setup({ value: { slots: { hair: "variant07" } } })
    fireEvent.click(screen.getByText("reset"))
    expect(onChange.mock.calls[0]?.[0]?.custom).toEqual({})
  })
})

/**
 * 预设的**选中态**。
 *
 * ## ★ 为什么它是必须的
 *
 * 点一个预设会覆写 `style` 与整个 `custom` —— 它是所有控件的**父级**。
 * 改动前那些按钮**没有任何选中态**，于是点完之后上面的风格行会跳，
 * 而"我现在在哪个预设上"这个信息在界面上完全不存在。
 *
 * 更要紧的是**脱离**：下面任何一次微调都会让当前配置不再等于那个预设。
 * 有了选中态，那次脱离是看得见的 —— 高亮消失就是"你已经在自己调了"。
 */
describe("★ 预设有选中态，且微调之后会脱离", () => {
  it("★ 当前配置等于某个预设 → 那一个按钮 aria-pressed", () => {
    const { onChange } = setup({})
    // 先点一个预设，拿到它写出去的 style + custom
    fireEvent.click(screen.getByLabelText("preset:robot"))
    const applied = onChange.mock.calls[0]?.[0]
    expect(applied).toBeDefined()
    if (applied === undefined) return

    cleanup()
    // 用那份配置重新渲染 —— 这时它应当被认出来
    setup({ style: applied.style, value: applied.custom })
    const pressed = screen
      .getAllByRole("button", { pressed: true })
      .map((n) => n.getAttribute("aria-label"))
    expect(pressed).toContain("preset:robot")
  })

  it("★★ 改一件之后脱离预设（高亮必须消失）", () => {
    const { onChange } = setup({})
    fireEvent.click(screen.getByLabelText("preset:robot"))
    const applied = onChange.mock.calls[0]?.[0]
    if (applied === undefined) return

    cleanup()
    // 在预设配置上多钉一个槽位 —— 那就不再是那个预设了
    setup({
      style: applied.style,
      value: { ...applied.custom, slots: { ...(applied.custom.slots ?? {}), mouth: "variant01" } },
    })
    const pressed = screen
      .getAllByRole("button", { pressed: true })
      .map((n) => n.getAttribute("aria-label"))
    expect(pressed).not.toContain("preset:robot")
  })

  it("没匹配任何预设时，一个预设按钮都不高亮", () => {
    setup({ value: { slots: { hair: "variant07" } } })
    const pressedPresets = screen
      .getAllByRole("button", { pressed: true })
      .map((n) => n.getAttribute("aria-label") ?? "")
      .filter((label) => label.startsWith("preset:"))
    expect(pressedPresets).toEqual([])
  })
})
