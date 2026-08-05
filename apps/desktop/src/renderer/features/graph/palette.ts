/**
 * 图谱的取色 —— **一份**，给画布、图例、分布条共用。
 *
 * ## 为什么必须共用一份
 *
 * 同一个「Person」在三个地方出现：canvas 上的节点、图例上的圆点、
 * 分布条上的那一行。三处各写一遍的话，改一次颜色就会漏两处 ——
 * 而那时界面上"图例说蓝色是人、图里的人是绿色"，比没有图例更糟。
 *
 * ## ★ 十六进制而不是 CSS 变量，因为 canvas 读不到自定义属性
 *
 * G6 画在 canvas 上，`var(--x)` 传进去是一个它不认识的字符串
 * （表现是节点变透明，不报错）。所以这里是字面量，
 * 而明暗两套由调用方按 `useTheme().resolved` 选 —— 不是自动翻转。
 *
 * ## ★ 这两组色是**验证过的**，不是挑好看的
 *
 * `dataviz` 的 `validate_palette.js` 跑过（六项检查）：
 *
 * ```
 * 浅色 surface #fcfcfb：#2a78d6 #eb6834 #1baf7a #eda100 → ALL CHECKS PASS
 *   最差相邻 CVD ΔE 9.1（protan）· 正常视觉 22.9
 *   ⚠ contrast WARN：#1baf7a(2.74) #eda100(2.11) 低于 3:1
 *      → relief 规则：**必须**有可见标签或表格视图。所以图例与
 *        分布条上的直接数值标签**不是可选项**，删掉就违规。
 * 暗色 surface #1a1a19：#3987e5 #d95926 #199e70 #c98500 → ALL CHECKS PASS
 *   含 contrast ≥ 3:1（暗底上不需要 relief，但标签留着无害）
 * ```
 *
 * 改任何一个值都要**重跑那个脚本**。眼看"差不多能分出来"在 CVD 下不成立。
 *
 * ## ★ 事实类型用**有序**色阶，不是第二套分类色
 *
 * 五个 fact 类型有强弱：决策 > 指派 > 因果 > 状态 > 一般。
 * 按 `choosing-a-form.md`：nominal 才用 categorical，ordered 用单色 ramp。
 * 下面 `FACT_RAMP` 是品牌蓝的五个步进，亮度单调（已验证）——
 * 于是"深 = 更强的语义"这件事不用图例也读得出来。
 *
 * 状态色（success/warning/error）**不参与**这两套：那是留给"好/坏"的，
 * 而实体类型与事实类型都不是好坏。
 */

/** 明暗两档。canvas 拿不到 CSS 变量，所以由调用方显式选。 */
export type ThemeMode = "light" | "dark"

/**
 * 实体类型 → 分类色。**按类型名固定**，不按排名。
 *
 * ★ 规范里的硬规则："color follows the entity, never its rank"。
 * 按排名上色的话，过滤掉一个类型会让剩下的全部换色 ——
 * 而用户会以为数据变了。
 */
const ENTITY_LIGHT: Record<string, string> = {
  Person: "#2a78d6",
  System: "#eb6834",
  Project: "#1baf7a",
  Organization: "#eda100",
}
const ENTITY_DARK: Record<string, string> = {
  Person: "#3987e5",
  System: "#d95926",
  Project: "#199e70",
  Organization: "#c98500",
}

/**
 * 未知类型的中性色。
 *
 * 单独一个常量而不是表里的一项：上游（kl）随时会长出新的实体类型，
 * 那时它该是一个灰点 —— 而不是崩掉，也不是借用另一个类型的颜色
 * （借色会让两个不同的东西看起来是同一个）。
 */
export const ENTITY_NEUTRAL: Record<ThemeMode, string> = {
  light: "#8a8a85",
  dark: "#9a9a94",
}

/** 图例与画布共用的类型顺序（= categorical slot 顺序）。 */
export const ENTITY_TYPES = ["Person", "System", "Project", "Organization"] as const

export function entityColor(type: string, mode: ThemeMode): string {
  const table = mode === "dark" ? ENTITY_DARK : ENTITY_LIGHT
  return table[type] ?? ENTITY_NEUTRAL[mode]
}

/**
 * 「我」的颜色。
 *
 * ★ 刻意**不在** categorical 那四个 slot 里：中心节点不是"第五类实体",
 * 它是这张图的锚点。用一个 slot 会让它读起来像又一个类别。
 * 品牌墨蓝的深步进 —— 与四个 slot 都拉得开，且比它们都重。
 */
export const SELF_COLOR: Record<ThemeMode, string> = {
  light: "#1b3a8f",
  dark: "#7ba6f0",
}

/** 渠道 → 描边色。填充那一维已经给了实体类型，渠道是元信息 → 描边。 */
export const CHANNEL_STROKE: Record<string, string> = {
  dingtalk: "#0074FF",
  feishu: "#00D6B9",
}

/** 取不到渠道时的描边色。 */
export const CHANNEL_FALLBACK = "#94A3B8"

/**
 * 事实类型 → 有序色阶上的一档（深 = 语义更强）。
 *
 * 亮度单调（0.107 → 0.188 → 0.312 → 0.485 → 0.700，已算过），
 * 所以它在灰度打印与 CVD 下同样成立 —— 这是 sequential ramp
 * 相对 categorical 的那个优势，而这里的数据恰好是有序的。
 *
 * ★ 最浅那一档（`GENERAL`）对浅色表面的对比只有 1.36:1 ——
 * 那正是分布条必须**直接标数值**的原因（relief 规则）。
 */
export const FACT_RAMP: Record<string, string> = {
  DECISION: "#1d4ed8",
  DELEGATE: "#2a78d6",
  CAUSAL: "#5b9be3",
  STATUS: "#8fbdef",
  GENERAL: "#c3ddf7",
}

/** 事实类型的显示顺序：按语义强度降序（= ramp 从深到浅）。 */
export const FACT_TYPES = ["DECISION", "DELEGATE", "CAUSAL", "STATUS", "GENERAL"] as const

export function factColor(type: string): string {
  return FACT_RAMP[type] ?? FACT_RAMP["GENERAL"] ?? "#c3ddf7"
}

/** 边的颜色。它是背景结构，不该与任何数据色竞争。 */
export const EDGE_COLOR: Record<ThemeMode, string> = {
  light: "#cbd5e1",
  dark: "#4a4a46",
}
