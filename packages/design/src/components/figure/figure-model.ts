/**
 * 形象定制的数据模型与**校验**。纯逻辑，无 React。
 *
 * ## 为什么校验必须我们自己做
 *
 * DiceBear 对非法选项**静默忽略，从不抛错**（实测）：
 *
 * | 输入                                          | 行为                        |
 * | --------------------------------------------- | --------------------------- |
 * | `hair: ["variant99"]`（不存在的变体）         | 不抛，产物 == `hair: []`    |
 * | 把 notionists 的 `lips` 喂给 lorelei          | 不抛，静默忽略              |
 * | `hairColor: ["红色"]`（非法格式）             | 不抛                        |
 *
 * 好消息是**不会白屏**。坏消息是这正是本仓库反复踩的那类静默失效：
 * 一个换过风格的用户会看到自己精心配的部件**悄悄消失一半**，
 * 而界面上没有任何提示 —— "换个风格头发没了没人告诉我"与"功能坏了"
 * 在用户侧不可区分。
 *
 * 所以 `sanitizeFigure` 不只过滤，还要**把丢掉了什么返回出去**，
 * 让调用方能告诉用户"换风格后有 3 件没保留"。
 */
import { FIGURE_SLOTS, type FigureSlot, type FigureStyleSlots } from "./slots.generated.js"
/**
 * ★ 只做**类型**导入（`import type` 而不是 `import { type … }`）。
 *
 * `persona-figure.tsx` 要 import 本模块的 `figureToOptions`，如果这里
 * 反过来在**运行时**依赖它，两个模块就成环。ESM 虽然能处理环，但
 * 初始化顺序会变成一件要靠"函数体在调用时才求值"来兜的事 ——
 * 那种依赖很脆，改动一行就可能变成 `undefined`。
 * `verbatimModuleSyntax: true` 下 `import type` 会被完全擦除，因此无环。
 */
import type { FigureStyle } from "../persona-figure.js"

/**
 * 风格名不认识时落到哪个风格。
 *
 * **不 import `DEFAULT_FIGURE_STYLE`** —— 那会造成上面说的运行时环。
 * 取生成物的第一个 key 是等价的：生成器按 `FIGURE_STYLES` 的顺序输出，
 * 而 `DEFAULT_FIGURE_STYLE` 就定义为 `FIGURE_STYLES[0]`。
 * 这条对应关系由 `figure-model.test.ts` 的一条断言锁住 ——
 * 否则将来有人改了生成器的输出顺序，这里会静默指向另一个风格。
 */
const FALLBACK_STYLE = Object.keys(FIGURE_SLOTS)[0] as FigureStyle

/** 颜色槽的合法格式，与 DiceBear schema 的 `items.pattern` 一致。 */
const COLOR_RE = /^(transparent|[a-fA-F0-9]{6})$/

/** 圆角的取值范围（core 选项 `radius`，单位是百分比）。 */
const RADIUS_MIN = 0
const RADIUS_MAX = 50

/**
 * 由 `config.background` **独占**的 DiceBear option key。
 *
 * ## ★ 为什么必须有这么一张表
 *
 * `thumbs` / `funEmoji` 自己的 schema 里**就有** `backgroundColor`
 * （那是刻意保留的，见生成器判据 1 —— 用 core 全集做排除表会把这两个
 * 风格唯一的定制维度排掉）。于是同一个 option key 有了**两个**来源：
 * 风格级 `colors.backgroundColor` 与 core 级 `background.color`。
 *
 * 而 `figureToOptions` 在 `colors` **之后**写 background，所以后者
 * 无条件胜出 —— 实测配置存成
 * `{"background":{"color":"77311d"},"colors":{"backgroundColor":"ffedef"}}`
 * 时产物用的是 `77311d`。UI 上两处都渲染成了控件，用户在「颜色」区
 * 选的背景色**点了没反应**：选中态会亮、配置会存、预览完全不动。
 * 讽刺的是这两个风格正是"仅预设 + 背景色"路线，背景色是它们
 * 唯一的定制维度。这与仓库反复记录的那类静默失效同形。
 *
 * 所以这里给它**唯一一个归属**：`background.color`。
 * 表本身导出，让门禁能断言"同一个 key 不得有两个入口"，
 * 而不是靠人记得这件事。
 */
export const BACKGROUND_OWNED_KEYS: readonly string[] = ["backgroundColor"]

/**
 * 这个风格的 `transparent` 背景**是不是空操作**。
 *
 * ## ★★ 为什么必须问这一句
 *
 * 实测 `backgroundColor: ["transparent"]` 与**完全不写**的产物：
 *
 * | 风格                                | 逐字节相同 | schema 自带 backgroundColor 默认值 |
 * | ----------------------------------- | ---------- | --------------------------------- |
 * | notionists / lorelei / micah / bottts | **是**   | 无                                |
 * | funEmoji / thumbs                   | 否         | 有（6 个 / 5 个色）               |
 *
 * 道理是：那四个风格本来就没有背景，"透明"与"没有背景"是同一件事。
 * 而 UI 把「透明」与「跟随默认」并列成**两个各自会亮的控件** ——
 * 用户点「透明」时选中态会亮、配置会存、**画面一动不动**。
 * 这与 `BACKGROUND_OWNED_KEYS` 那一段记的是同一个形态
 * （"选中态会亮、配置会存、预览完全不动"），只是换了一个实例。
 *
 * ## ★ 判据取「schema 里有没有 backgroundColor」，不是写死风格名
 *
 * `colorSlots` 含 `backgroundColor` ⟺ 该风格 schema 自己声明了这个属性
 * （生成器用的是**差集**，见它的判据 1）⟺ 它有一组默认背景色可以被
 * "透明"覆盖掉。三者是同一件事，所以这里读生成物而不是写
 * `["thumbs", "funEmoji"]` —— 后者在上游给某个风格加上背景色时会**静默过期**，
 * 而那正是"漂移了没人知道"。
 */
export function figureSupportsTransparentBackground(style: FigureStyle): boolean {
  return slotsOf(style).colorSlots.includes("backgroundColor")
}

/**
 * 该风格**真正可用**的颜色槽 —— 剔除已由背景区统一管的那些。
 *
 * ★ 不改生成物：`FIGURE_SLOTS[style].colorSlots` 是上游 schema 的忠实
 * 转录（`figure-pinning.test.ts` 有一条断言锁着 thumbs/funEmoji 的
 * `backgroundColor` 必须在里面，那条锁的是生成器的"差集而非全集"判据）。
 * 剔除只发生在**消费侧**，而且校验与 UI 都走这一个函数 ——
 * 两边各自剔除就会出现"UI 不显示但校验放行"这种更难查的不一致。
 */
function usableColorSlots(table: FigureStyleSlots): readonly string[] {
  return table.colorSlots.filter((key) => !BACKGROUND_OWNED_KEYS.includes(key))
}

/**
 * 用户的逐槽位定制。
 *
 * **只存被显式改过的槽位** —— 未出现的键仍由 seed 决定。
 * 这让"部分定制"天然成立（用户只改了头发，其余保持原样），
 * 也让旧数据不需要迁移：没有这个字段时行为与改动前逐字节一致。
 */
export interface FigureConfig {
  /**
   * 槽位 → 选中的变体名。
   *
   * ★ 值为 `null` 表示「显式不要」，与"键不存在"**必须可区分**：
   * 键不存在 = 由 seed 决定（可能随机长出胡子），
   * `null` = 用户明确说了不要胡子。
   * 这与 `onboarding_progress` 里 `skipped` 与 `pending` 必须可区分同理。
   */
  slots?: Record<string, string | null> | undefined
  /** 风格级颜色槽 → 6 位 hex（不带 #）或 `"transparent"` */
  colors?: Record<string, string> | undefined
  /**
   * core 级选项（六个风格通用）。
   *
   * ★ 刻意**只开** `color` / `radius` 两个字段，不做成开放式 `Record`：
   * core 还有 `randomizeIds`，实测打开它会让**同参数两次渲染产出不同字符串**
   * —— 那会同时击穿 `PersonaFigure` 的 memo 与门禁里"同 seed 字节相同"
   * 的断言，且表现为"测试偶发红"，最容易被人加 retry 糊过去。
   * 不给它入口，就没人能把它写进库。
   */
  background?: { color?: string | undefined; radius?: number | undefined } | undefined
}

/** 一个风格的槽位表。风格名不认识时落到缺省 —— 与 `readPersonaIdentity` 同一个判断。 */
function slotsOf(style: FigureStyle): FigureStyleSlots {
  /**
   * ★ 这里**刻意**把 `as const` 的字面量类型放宽成 `FigureStyleSlots`。
   *
   * 生成物用 `as const satisfies Record<string, FigureStyleSlots>`：
   * `satisfies` 让"生成器写出了不符合接口的东西"变成编译错误（这是我们要的），
   * 而 `as const` 让每个变体名都是字面量类型 —— 于是
   * `slot.variants.includes(value)` 会被推成 `includes(never)`，
   * `slot.probabilityKey` 在没有该字段的那个联合分支上不存在。
   * 那些窄类型对**生成器**有价值（写错会红），对**消费方**只是噪声：
   * 我们要处理的本来就是运行时来的任意字符串。
   *
   * 放宽只在这一个函数里做，所有消费方都经过它。
   */
  const table: Record<string, FigureStyleSlots> = FIGURE_SLOTS
  /**
   * ★ 用 `Object.hasOwn` 而不是 `table[style] ?? table[FALLBACK_STYLE]`。
   *
   * 后者对**原型链上的键**不成立：`table["constructor"]` 不是 undefined
   * （它是 `Object.prototype.constructor`），所以 `??` 不触发回落，
   * 返回的东西上没有 `.slots` —— 实测 `sanitizeFigure("constructor", …)`
   * 直接抛 `Cannot read properties of undefined (reading 'find')`。
   * `"bogus"` 能正确回落，所以这不是设计问题，是漏了一种输入：
   * 本函数的注释承诺了"风格名不认识时落到缺省"，而它对
   * `constructor` / `toString` / `hasOwnProperty` 做不到。
   *
   * 今天所有调用方都经 `FIGURE_STYLES.find` 过滤故不可达，但库里那个串
   * 是用户数据，而"不可达"是**当前调用方**的性质、不是本函数的性质。
   */
  const entry = Object.hasOwn(table, style) ? table[style] : undefined
  return entry ?? table[FALLBACK_STYLE] ?? { slots: [], colorSlots: [] }
}

/** 该风格里 key 对应的槽位定义；不存在返回 undefined。 */
export function findSlot(style: FigureStyle, key: string): FigureSlot | undefined {
  return slotsOf(style).slots.find((slot) => slot.key === key)
}

/** 该风格可进抽屉的槽位（顺序 = 生成物顺序 = 上游 schema 顺序）。 */
export function figureSlotsFor(style: FigureStyle): readonly FigureSlot[] {
  return slotsOf(style).slots
}

/**
 * 该风格可定制的颜色槽。
 *
 * notionists 实测为空 —— 对它来说背景色是唯一的颜色维度。
 * `backgroundColor` **不在**返回值里（见 `BACKGROUND_OWNED_KEYS`）：
 * 它由背景区统一管，两处都给控件会让其中一处点了没反应。
 */
export function figureColorSlotsFor(style: FigureStyle): readonly string[] {
  return usableColorSlots(slotsOf(style))
}

/**
 * 一个颜色槽**依附于哪个可选部件**；不依附于任何可选部件返回 undefined。
 *
 * ## ★★ 为什么这个函数是正确性要求，不是润色
 *
 * 颜色槽只在它染的那个部件**存在时**才有效果。实测（200 个 seed，
 * 未钉住部件时颜色改动的可见率）：
 *
 * | 颜色槽                       | 生效率  | 显式关掉部件后 |
 * | ---------------------------- | ------- | -------------- |
 * | lorelei.glassesColor         | 17/200  | **0/50**       |
 * | lorelei.earringsColor        | 23/200  | —              |
 * | lorelei.hairAccessoriesColor | 13/200  | —              |
 * | lorelei.frecklesColor        | 11/200  | —              |
 * | micah.facialHairColor        | 17/200  | —              |
 * | lorelei.hairColor（对照）    | 200/200 | —              |
 *
 * 也就是说这四五个色板**九成的点击是逐字节空操作**，而用户明确
 * 关掉眼镜之后 `glassesColor` 的生效率是**零**。界面上它与
 * `hairColor` 长得一模一样、点了一样会亮 —— 这正是
 * `BACKGROUND_OWNED_KEYS` 那一段论证过的形态的又一个实例
 * （那次只修了背景色一个）。
 *
 * ## ★ 归属靠**命名规则**推出来，不写死一张表
 *
 * `<部件>Color` → 部件 `<部件>`，再试单复数（micah 是 `earringColor`
 * 而槽位叫 `earrings`）。写死表意味着上游加一个颜色槽就要同步改表，
 * 漏了就静默回到"点了没反应"；推导则会自动覆盖新槽位。
 * 推不出来（`skinColor` / `baseColor` / `shapeColor`）就是**不依附**，
 * 实测那些确实 200/200 恒生效。
 *
 * ## 已知未覆盖的一种：靠**变体**而不是概率门控
 *
 * `micah.eyeShadowColor` 实测 73/200 —— 它依附的 `eyes` 是必填槽位，
 * 但只有 `eyesShadow` / `smilingShadow` 两个变体画眼影
 * （实测这两个 30/30、其余三个 0/30）。这个函数**不报告**它，
 * 于是它按"恒生效"渲染。这是一个真实的取舍：判断"哪些变体画了眼影"
 * 只能靠逐变体渲染比对，那张表没法从 schema 推出来，写死则会静默过期
 * —— 而误报（说它可能不生效，其实生效）比漏报更烦人。
 */
export function figureColorSlotOwner(style: FigureStyle, colorKey: string): FigureSlot | undefined {
  const stem = colorKey.replace(/Color$/, "")
  if (stem === colorKey || stem === "") return undefined
  const table = slotsOf(style)
  // 单复数都试：micah 的 `earringColor` 染的是槽位 `earrings`
  const candidates = [stem, `${stem}s`, stem.replace(/s$/, "")]
  const owner = table.slots.find((slot) => candidates.includes(slot.key))
  // 只有**可选**部件才有"可能不存在"的问题；必填部件（hair / eyes）恒在
  return owner?.optional === true ? owner : undefined
}

/**
 * 把库里读出来的**任意** JSON 收敛成当前风格真的认识的配置。
 *
 * 丢弃：当前风格不认识的槽位、不在变体表里的值、格式非法的颜色、
 * 越界的圆角。丢掉的 key 从 `dropped` 返回。
 *
 * ## ★ 最容易写漏的一处：同名不同义
 *
 * `hair` 在 notionists 有 64 个变体、在 lorelei 只有 48 个
 * （实测 `variant57` 只在 notionists 合法）。所以"槽位名两边都有"
 * **不等于**"值可以直接搬" —— 必须**逐值**查变体表，不能只比 key 集合。
 * 只比 key 的后果是：切风格后 hair 保留了，但用户看到的是另一个发型，
 * 或者（值超出范围时）干脆没有头发。
 */
export function sanitizeFigure(
  style: FigureStyle,
  raw: unknown,
): { config: FigureConfig; dropped: string[] } {
  const dropped: string[] = []
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config: {}, dropped }
  }
  const record = raw as { slots?: unknown; colors?: unknown; background?: unknown }
  const table = slotsOf(style)
  /** 剔掉背景区独占的那些 —— 与 UI 走同一个函数，避免两边判断不一致 */
  const usable = usableColorSlots(table)

  const slots: Record<string, string | null> = {}
  if (typeof record.slots === "object" && record.slots !== null && !Array.isArray(record.slots)) {
    for (const [key, value] of Object.entries(record.slots as Record<string, unknown>)) {
      const slot = table.slots.find((item) => item.key === key)
      if (slot === undefined) {
        // 这个风格没有这个槽位（notionists 的 lips 喂给 lorelei）
        dropped.push(key)
        continue
      }
      if (value === null) {
        // 「显式不要」只对可选槽位有意义 —— 必填槽位没法"不要眼睛"
        if (slot.optional) slots[key] = null
        else dropped.push(key)
        continue
      }
      // ★ 逐值查变体表，不能只比 key（同名不同域，见上）
      if (typeof value !== "string" || !slot.variants.includes(value)) {
        dropped.push(key)
        continue
      }
      slots[key] = value
    }
  } else if (record.slots !== undefined) {
    dropped.push("slots")
  }

  const colors: Record<string, string> = {}
  /**
   * 从旧配置里迁移过来的背景色。
   *
   * ★ 见**上方** `BACKGROUND_OWNED_KEYS` 那一段：`colors.backgroundColor`
   * 曾经是一个**真的会生效**的入口（只写它、不写 `background.color` 时，
   * 产物用的就是它）。所以现在把它收归背景区之后，**不能直接丢** ——
   * 丢了就是一次真实的数据丢失：用户在「颜色」区选的背景色会消失，
   * 而界面只会说一句"有 1 件没保留"，没人能从那句话反推出发生了什么。
   *
   * 迁移到 `background.color` 之后**渲染结果逐字节相同**
   * （同一个 option key、同一个值），所以这是一次无可见变化的搬家，
   * 不是"保留"也不是"丢弃"，因此**不进 `dropped`**。
   */
  let migratedBackground: string | undefined
  if (
    typeof record.colors === "object" &&
    record.colors !== null &&
    !Array.isArray(record.colors)
  ) {
    for (const [key, value] of Object.entries(record.colors as Record<string, unknown>)) {
      const legal = typeof value === "string" && COLOR_RE.test(value)
      /**
       * 背景色专属键：合法就搬进 background，不合法才算丢。
       *
       * ★ 这里**不需要**再查一次 `transparent` 的风格门槛：进这个分支的
       * 前提就是 `table.colorSlots.includes("backgroundColor")`，而那与
       * `figureSupportsTransparentBackground` 是**同一个判断**
       * （见那个函数的注释）。也就是说能走到这里的风格，`transparent`
       * 本来就是生效的。多写一次不会更安全，只会让读者以为这是两件事。
       */
      if (BACKGROUND_OWNED_KEYS.includes(key) && table.colorSlots.includes(key)) {
        if (legal) migratedBackground = value as string
        else dropped.push(key)
        continue
      }
      if (!usable.includes(key)) {
        dropped.push(key)
        continue
      }
      if (!legal) {
        dropped.push(key)
        continue
      }
      colors[key] = value as string
    }
  } else if (record.colors !== undefined) {
    dropped.push("colors")
  }

  /**
   * 背景是 core 选项，**六个风格通用**，所以不查 colorSlots。
   * 只认 `color` / `radius` 两个字段（见 `FigureConfig.background` 的注释）。
   */
  let background: { color?: string; radius?: number } | undefined
  const rawBackground = record.background
  if (
    typeof rawBackground === "object" &&
    rawBackground !== null &&
    !Array.isArray(rawBackground)
  ) {
    const bg = rawBackground as { color?: unknown; radius?: unknown }
    const next: { color?: string; radius?: number } = {}
    if (bg.color !== undefined) {
      /**
       * ★ `transparent` 只对**它真的有效**的风格算合法值。
       *
       * 见 `figureSupportsTransparentBackground`：对 notionists / lorelei /
       * micah / bottts 它与不写逐字节相同。放行的话库里会存着一个
       * 逐字节无效果的值，而 UI（那四个风格下不给这一格）会显示
       * 「跟随默认」选中 —— 存的与显示的不一致，且没人能从界面上看出来。
       *
       * 进 `dropped` 是对的：从 thumbs 切到 notionists 时用户**确实**
       * 丢了一个设置（那个风格上它是生效的），该告诉他。
       */
      const legalColor =
        typeof bg.color === "string" &&
        COLOR_RE.test(bg.color) &&
        (bg.color !== "transparent" || figureSupportsTransparentBackground(style))
      if (legalColor) next.color = bg.color as string
      else dropped.push("background.color")
    }
    if (bg.radius !== undefined) {
      if (
        typeof bg.radius === "number" &&
        Number.isFinite(bg.radius) &&
        bg.radius >= RADIUS_MIN &&
        bg.radius <= RADIUS_MAX
      ) {
        next.radius = Math.round(bg.radius)
      } else dropped.push("background.radius")
    }
    if (Object.keys(next).length > 0) background = next
  } else if (rawBackground !== undefined) {
    dropped.push("background")
  }

  /**
   * 迁移过来的旧 `colors.backgroundColor` 落进 background。
   *
   * ★ **不覆盖**已显式存在的 `background.color`：那才是现在唯一的入口，
   * 用户最后一次在背景区点的就是它。改动前 `figureToOptions` 也是
   * background 胜出，所以这条保持了产物不变。
   */
  if (migratedBackground !== undefined && background?.color === undefined) {
    background = { ...(background ?? {}), color: migratedBackground }
  }

  /**
   * 空对象不写进 config —— 这样 `figureIsEmpty` 能判出"什么都没定制"，
   * 而 `{slots:{}}` 与 `{}` 在语义上确实相同。
   * `exactOptionalPropertyTypes: true` 下要用展开而不是赋 undefined。
   */
  return {
    config: {
      ...(Object.keys(slots).length === 0 ? {} : { slots }),
      ...(Object.keys(colors).length === 0 ? {} : { colors }),
      ...(background === undefined ? {} : { background }),
    },
    dropped,
  }
}

/** 什么都没定制 —— 用它决定是否给 `PersonaFigure` 传 `custom`（不传 = 走老路）。 */
export function figureIsEmpty(config: FigureConfig | undefined): boolean {
  if (config === undefined) return true
  return (
    Object.keys(config.slots ?? {}).length === 0 &&
    Object.keys(config.colors ?? {}).length === 0 &&
    config.background === undefined
  )
}

/**
 * `FigureConfig` → `createAvatar` 的 options。
 *
 * ## ★ 可选槽位的三态映射（这是**正确性要求**，不是保险）
 *
 * | `config.slots[key]` | 含义         | 生成的 options                                |
 * | ------------------- | ------------ | --------------------------------------------- |
 * | 键不存在            | 由 seed 决定 | **什么都不写**（连概率也不写）                |
 * | `null`              | 用户明确不要 | `{ [probabilityKey]: 0 }`                     |
 * | `"variantNN"`       | 用户明确要   | `{ [key]: ["variantNN"], [probabilityKey]: 100 }` |
 *
 * 第三行的 `100` 是**必需的**。实测（300 个 seed）：只写
 * `{glasses:["variant03"]}` 而不写 `glassesProbability:100` 时，那件眼镜
 * 出不出现**仍然由 seed 决定** —— 因为四个概率槽的 schema 默认值是
 * `beard:10 bodyIcon:75 gesture:10 glasses:20`（不是 100）。
 *
 * 表现是"我明明选了眼镜，改了个名字眼镜就没了"（改名 → 换 seed →
 * 重新掷骰子，80% 的概率不出现）。这条有专门的单测，且**跨 20 个 seed**
 * —— 只比两个 seed 时有约 1/16 的概率两边掷出同一组开关而侥幸通过。
 */
export function figureToOptions(style: FigureStyle, config: FigureConfig): Record<string, unknown> {
  const table = slotsOf(style)
  const usable = usableColorSlots(table)
  const options: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(config.slots ?? {})) {
    const slot = table.slots.find((item) => item.key === key)
    if (slot === undefined) continue
    if (value === null) {
      // 「不要」= 概率置 0。
      // 不用"把变体设成空数组"：虽然实测空数组也能让部件消失，
      // 但那走的是 DiceBear "非法输入静默回落"的路径 ——
      // 不该依赖一个静默回落的行为来实现一个正常功能。
      if (slot.probabilityKey !== undefined) options[slot.probabilityKey] = 0
      continue
    }
    options[key] = [value]
    // ★ 见上方三态表：选中时必须同时锁概率，否则有无仍由 seed 决定
    if (slot.probabilityKey !== undefined) options[slot.probabilityKey] = 100
  }

  for (const [key, value] of Object.entries(config.colors ?? {})) {
    /**
     * ★ 用 `usableColorSlots` 而不是 `table.colorSlots`。
     *
     * 差别只在 `backgroundColor` 上，而那一个差别就是整个 bug：
     * 用全表时它既能从这里写、又能从下面的 background 写，
     * 后写的静默覆盖前者 —— 用户在「颜色」区选的背景色点了没反应。
     * 现在它**只有一个**归属（background），这里不再接受它。
     * 正常路径下 `sanitizeFigure` 已经把它搬走了，这条是纵深防御：
     * 手改过的库数据可以直接进到这里。
     */
    if (!usable.includes(key)) continue
    options[key] = [value]
  }

  /**
   * 背景**最后写**，且它是 `backgroundColor` 的唯一来源。
   *
   * 顺序在这里已经不重要了（上面不会再写这个 key），但仍然放在最后 ——
   * 让"谁赢"这件事在代码上只有一种可能的读法。
   */
  const background = config.background
  if (background?.color !== undefined) options["backgroundColor"] = [background.color]
  if (background?.radius !== undefined) options["radius"] = background.radius

  return options
}

/**
 * 只改一个槽位，其余保持不动。
 *
 * 抽屉里点一件就走这里 —— 抽出来是因为"点一件只应改一格"是
 * 一条要被测试锁住的语义（点头发把眼睛也换了是个真实的失效形态）。
 */
export function withSlot(
  config: FigureConfig,
  key: string,
  value: string | null | undefined,
): FigureConfig {
  const slots = { ...(config.slots ?? {}) }
  // undefined = 回到「由 seed 决定」，也就是把这个键删掉
  if (value === undefined) delete slots[key]
  else slots[key] = value
  return {
    ...config,
    ...(Object.keys(slots).length === 0 ? { slots: undefined } : { slots }),
  }
}

/** 只改一个颜色槽。 */
export function withColor(
  config: FigureConfig,
  key: string,
  value: string | undefined,
): FigureConfig {
  const colors = { ...(config.colors ?? {}) }
  if (value === undefined) delete colors[key]
  else colors[key] = value
  return {
    ...config,
    ...(Object.keys(colors).length === 0 ? { colors: undefined } : { colors }),
  }
}

/** 只改背景（color / radius 之一）。 */
export function withBackground(
  config: FigureConfig,
  patch: { color?: string | undefined; radius?: number | undefined },
): FigureConfig {
  const next = { ...(config.background ?? {}), ...patch }
  // 值为 undefined 的键要真的删掉，否则 exactOptionalPropertyTypes 下
  // `{color: undefined}` 与"没有 color"在类型上相同、在 Object.keys 上不同
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    if (next[key] === undefined) delete next[key]
  }
  return {
    ...config,
    ...(Object.keys(next).length === 0 ? { background: undefined } : { background: next }),
  }
}

/**
 * 精选预设 —— 给"我不想逐件调"的用户一键到位。
 *
 * ## 为什么预设只用**语义化命名**的变体
 *
 * 每条预设都是手挑的，而挑的时候只能看变体名。语义化命名的槽位
 * （micah 的 `eyes: smiling`、bottts 的 `face: round01`）挑起来是有把握的；
 * `variant37` 这种纯编号只能靠渲染出来看，那不是能在代码里做的判断。
 * 所以纯编号槽位一律**留给 seed**（不写进预设），预设只钉那些
 * 名字本身就说明了长相的槽位 —— 于是每条预设仍然"每次打开都一样"
 * （被钉住的部分），但不假装钉住了看不见的部分。
 *
 * 每条预设都用 `sanitizeFigure` 过一遍才会被 UI 用上（见 FigureStudio），
 * 所以这里写错一个变体名不会静默生效 —— 会在门禁里红。
 */
export const FIGURE_PRESETS: readonly {
  /** i18n key 的尾段：`personaStep.figure.presets.<id>` */
  readonly id: string
  readonly style: FigureStyle
  readonly config: FigureConfig
}[] = [
  {
    // 干净利落：不要胡子、不要眼镜、不要手势，只留一张脸
    id: "clean",
    style: "notionists",
    config: {
      slots: { beard: null, glasses: null, gesture: null, bodyIcon: null },
      background: { color: "f1f4dc", radius: 50 },
    },
  },
  {
    // 书生气：戴眼镜 + 有手势
    id: "scholar",
    style: "notionists",
    config: {
      slots: { glasses: "variant01", gesture: "ok", beard: null },
      background: { color: "d2eff3", radius: 50 },
    },
  },
  {
    // 插画风 + 暖色背景。lorelei 的槽位全是纯编号，所以只钉颜色
    id: "warm",
    style: "lorelei",
    config: {
      colors: { hairColor: "77311d", skinColor: "f9c9b6" },
      slots: { freckles: "variant01", glasses: null },
      background: { color: "ffeba4", radius: 50 },
    },
  },
  {
    // 极简：lorelei 去掉一切可选件
    id: "minimal",
    style: "lorelei",
    config: {
      slots: { beard: null, earrings: null, freckles: null, glasses: null, hairAccessories: null },
      colors: { hairColor: "000000" },
      background: { color: "ffffff", radius: 50 },
    },
  },
  {
    // 微笑：micah 的槽位是语义化的，可以直接钉出"在笑"
    id: "friendly",
    style: "micah",
    config: {
      slots: { eyes: "smiling", mouth: "smile", eyebrows: "up", facialHair: null },
      colors: { baseColor: "f9c9b6", hairColor: "77311d" },
      background: { color: "d2eff3", radius: 50 },
    },
  },
  {
    // 机器人：bottts 的语义化变体名（round01 / happy / smile01）挑得有把握
    id: "robot",
    style: "bottts",
    config: {
      slots: { face: "round01", eyes: "happy", mouth: "smile01", texture: null },
      colors: { baseColor: "1e88e5" },
      background: { color: "0a5b83", radius: 50 },
    },
  },
]
