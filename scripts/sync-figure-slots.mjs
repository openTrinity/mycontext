#!/usr/bin/env node
/**
 * 从 `@dicebear/*` 的 schema 生成形象槽位清单
 * → `packages/design/src/components/figure/slots.generated.ts`。
 *
 * 做法与 `sync-brand-icons.mjs` 同构：**上游是源，`.ts` 是产物**。
 *
 * ## 为什么必须生成而不是手写
 *
 * 每个风格的槽位名与变体数完全不同（notionists 有 `lips`/`gesture`，
 * lorelei 有 `mouth`/`freckles` + 10 个颜色槽），六个风格合计 ~250 个变体名。
 * 手抄一定会抄错，而**抄错的表现是静默的**：DiceBear 对非法变体
 * 不抛错，只是让那个部件消失（实测 `hair:["variant99"]` 的产物
 * 与 `hair:[]` 逐字节相同）。所以"抄错了"与"就是没头发"在界面上无法区分。
 *
 * ## ★ 解析锚点必须钉在 packages/design
 *
 * 六个 `@dicebear/*` 装在 `packages/design/node_modules/`，不在仓库根。
 * 从根目录直接 `import("@dicebear/notionists")` 实测 `ERR_MODULE_NOT_FOUND`。
 * 因此用 `createRequire` 把解析锚点钉到那个包的 package.json 上。
 *
 * 用法：pnpm sync:figure-slots
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { STYLE_PACKAGES } from "./lib/figure-style-packages.mjs"

const root = resolve(import.meta.dirname, "..")
const outFile = join(root, "packages/design/src/components/figure/slots.generated.ts")

/**
 * 风格 id → npm 包名在 `lib/figure-style-packages.mjs`，**与漂移门禁共享**。
 *
 * 那张表是纯数据（id 是我们的驼峰、包名是上游的连字符，不能互相推导），
 * 抄它不带来反证价值、只会让"加一个风格漏改一处"变成新的失效点。
 * 而下面 `classify` 的**判据**在门禁里仍然各写一遍 —— 那个是刻意的，
 * 理由见共享文件与门禁的注释。
 */

/** 颜色槽的判据：schema 里 `items.pattern` 是那个 hex 正则。 */
const COLOR_PATTERN = "^(transparent|[a-fA-F0-9]{6})$"

const req = createRequire(pathToFileURL(resolve(root, "packages/design/package.json")))

/** 载入一个 DiceBear 包的 schema。解析锚点见文件头。 */
async function loadSchema(packageName) {
  const mod = await import(pathToFileURL(req.resolve(packageName)).href)
  const schema = mod.schema
  if (schema?.properties === undefined) {
    throw new Error(`${packageName} 没有 schema.properties —— 上游结构变了，生成器要跟着改`)
  }
  return schema
}

const coreSchema = await loadSchema("@dicebear/core")
const coreKeys = Object.keys(coreSchema.properties)

/** 跳过的非枚举属性（写进生成物头部注释，见下方 `skipped`）。 */
const skipped = []

/**
 * 被"单变体且无概率槽"判据过滤掉的槽位。
 *
 * ★ 和 `skipped` 一样**动态收集**，不写死散文。
 * 上一版把这一行写成硬编码的 `notionists.base micah.base thumbs.shape`，
 * 而紧挨着的 `skipped` 是 `${skipped.join(" ")}` 生成的 —— 两者语义同级，
 * 硬编码那份会随上游变化而腐烂（上游加一个单变体槽位，注释就开始骗人，
 * 且没有任何东西会红）。
 */
const filtered = []

/**
 * 把一个风格的 schema 归类成 slots / colorSlots。
 *
 * ★ 四个判据（每一条都对应一个实测过的反例，改动前请先读注释）：
 *
 * 1. **core 排除表是「差集」而不是「core 全集」**。
 *    `thumbs` 与 `funEmoji` 自己的 schema 里**就有** `backgroundColor`
 *    （实测，且带默认值）。用 core 全集去排，会把这两个风格
 *    **唯一**的定制维度排掉 —— 而它们走的正是"仅预设 + 背景色"路线，
 *    结果 UI 上什么都不剩。所以只排 core **独有**的 key。
 *
 * 2. **单变体槽位的过滤要带概率条件**。`variants.length <= 1` 且
 *    **无**对应 `<key>Probability` → 过滤（实测只有三个：
 *    `notionists.base` / `micah.base` / `thumbs.shape`）。
 *    但 `variants.length === 1` 且**有**概率槽 → **保留**，它是
 *    "要不要雀斑 / 要不要发饰"这种真开关（实测 lorelei 的 `freckles` /
 *    `hairAccessories`，prob 0 vs 100 产物不同），标 `toggleOnly` 让 UI
 *    渲染成开关而不是一格网格。一律过滤会砍掉两个用户想得到的定制项。
 *
 * 3. **非枚举属性显式跳过并记录**。`thumbs` 有六个
 *    `{type:"array", items:{type:"integer"}, maxItems:2}` 形状的属性
 *    （`faceOffsetX/Y` `faceRotation` `shapeOffsetX/Y` `shapeRotation`
 *    —— 是取值**区间的上下界**，DiceBear 在区间内按 seed 取随机值）。
 *    按 `items.enum` 取变体时它们会得到 undefined。不显式记录的话，
 *    将来有人会想不通"thumbs 为什么只有 3 个槽位"。
 *
 * 4. **变体名原样转录、保持上游顺序**。实测五个风格含语义化命名
 *    （`mrT` / `dannyPhantom` / `happy01` / `hat` / `variant1W10`），
 *    且 `micah.nose` 有上游拼写错误 `tound`（应为 round）。
 *    **不得**用 `/^variant(\d+)$/` 解析或重排序，**不得**"顺手修"拼写
 *    —— 改了就与 schema 不符，那个变体会变成非法值并被静默忽略。
 *    notionists / lorelei 的 hair 是**倒序**的（`variant63, variant62, …`），
 *    那就是上游给的展示顺序，照抄。
 */
function classify(styleId, schema) {
  const props = schema.properties
  const styleKeys = new Set(Object.keys(props))
  // 判据 1：差集。只排 core 独有的 key
  const coreOnly = new Set(coreKeys.filter((key) => !styleKeys.has(key)))

  const slots = []
  const colorSlots = []

  for (const [key, definition] of Object.entries(props)) {
    if (coreOnly.has(key)) continue
    // `*Probability` 不是槽位，它是槽位的属性 —— 由下面的 probabilityKey 引用
    if (key.endsWith("Probability")) continue

    if (definition?.items?.pattern === COLOR_PATTERN) {
      colorSlots.push(key)
      continue
    }

    const variants = definition?.items?.enum
    if (!Array.isArray(variants)) {
      // 判据 3：非枚举属性
      skipped.push(`${styleId}.${key}`)
      continue
    }

    const probabilityKey = `${key}Probability`
    const optional = Object.hasOwn(props, probabilityKey)

    // 判据 2：单变体 + 无概率槽 → 过滤（记下来写进产物头部注释）
    if (variants.length <= 1 && !optional) {
      filtered.push(`${styleId}.${key}`)
      continue
    }

    slots.push({
      key,
      // 判据 4：原样转录，保持原序
      variants: [...variants],
      optional,
      ...(optional ? { probabilityKey } : {}),
      // 单变体 + 有概率槽 = 有/无开关，不是一格网格
      ...(variants.length === 1 && optional ? { toggleOnly: true } : {}),
    })
  }

  return { slots, colorSlots }
}

const styles = {}
for (const [styleId, packageName] of Object.entries(STYLE_PACKAGES)) {
  styles[styleId] = classify(styleId, await loadSchema(packageName))
}

/**
 * 生成物里**刻意不写**"人类可读名"字段。
 *
 * 一个自然的冲动是给每个变体生成 `label: "Mr T"` —— 不要做。
 * ① 变体名含第三方角色名（`mrT` / `dannyPhantom` / `fonze` / `dougFunny`
 *    分别是 Mr. T / Danny Phantom / Fonzie / Doug Funnie），把它们抄进
 *    我们自己的源码与文案会引入不必要的商标面（作为 DiceBear 的数据
 *    原样转录是不可避免的，写进我们的文案不是）；
 * ② UI 已决定变体格只显缩略图 + 序号，根本不需要这个字段。
 */
function renderSlot(slot) {
  const parts = [
    `key: ${JSON.stringify(slot.key)}`,
    `variants: [${slot.variants.map((v) => JSON.stringify(v)).join(", ")}]`,
    `optional: ${String(slot.optional)}`,
  ]
  if (slot.probabilityKey !== undefined) {
    parts.push(`probabilityKey: ${JSON.stringify(slot.probabilityKey)}`)
  }
  if (slot.toggleOnly === true) parts.push("toggleOnly: true")
  return `      { ${parts.join(", ")} },`
}

const body = Object.entries(styles)
  .map(([styleId, { slots, colorSlots }]) => {
    const slotLines = slots.map(renderSlot).join("\n")
    const colorLine =
      colorSlots.length === 0
        ? "    colorSlots: [],"
        : `    colorSlots: [${colorSlots.map((c) => JSON.stringify(c)).join(", ")}],`
    return `  ${styleId}: {\n    slots: [\n${slotLines}\n    ],\n${colorLine}\n  },`
  })
  .join("\n")

const source = `/**
 * 形象槽位清单 —— 由 scripts/sync-figure-slots.mjs 从 @dicebear/* 的 schema 生成。
 *
 * **请勿手改**：改了会被 check:figure-slots-sync 门禁拦住。
 * 升级任何 @dicebear/* 之后重跑 pnpm sync:figure-slots。
 *
 * ## 读这份产物之前要知道的三件事
 *
 * 1. **变体名不是统一格式**，也不是我们能改的。实测含语义化命名
 *    （notionists.hair 的最后一个是 "hat"、lorelei.mouth 是 happy01…sad09、
 *    micah.hair 是 fonze/mrT/dougFunny）与上游拼写错误
 *    （micah.nose 的 "tound" 应为 round）。**照抄，不许修** ——
 *    改了就与 schema 不符，那个变体会变成非法值并被 DiceBear 静默忽略。
 *    UI 因此**不把变体名当可见文案**，只显缩略图 + 序号。
 *
 * 2. **变体顺序是上游的展示顺序**（notionists / lorelei 的 hair 是倒序的），
 *    不要重排。
 *
 * 3. \`optional: true\` 的槽位靠 \`probabilityKey\` 控制有无。
 *    选中一件时必须**同时**写 \`probability: 100\` —— 那四个概率槽的
 *    schema 默认值是 10/75/10/20（不是 0 或 100），只写变体不写概率时
 *    "这件到底出不出现"仍然由 seed 掷骰子决定。详见 figure-model.ts。
 *
 * 跳过的非枚举属性（取值区间的上下界，非枚举，UI 无从表达）：
 * ${skipped.join(" ")}
 *
 * 过滤掉的单变体无开关槽位：${filtered.join(" ")}
 * （判据是"单变体**且**无概率槽"—— lorelei.freckles / hairAccessories
 *  也是单变体，但它们有概率槽，是真开关，故保留并标 toggleOnly）
 */

/** 一个可选择的槽位（头发 / 眼睛 / 眼镜…）。 */
export interface FigureSlot {
  /** schema 里的属性名，同时是 i18n key 的尾段 */
  readonly key: string
  /** 变体名，**上游原序** */
  readonly variants: readonly string[]
  /** 有对应的 \`<key>Probability\` → 可以"不要" */
  readonly optional: boolean
  readonly probabilityKey?: string
  /** 单变体 + 可选 = 有/无开关，UI 渲染成 switch 而不是一格网格 */
  readonly toggleOnly?: boolean
}

export interface FigureStyleSlots {
  readonly slots: readonly FigureSlot[]
  /** 风格级颜色槽（6 位 hex 或 transparent）。notionists 实测为空 */
  readonly colorSlots: readonly string[]
}

export const FIGURE_SLOTS = {
${body}
} as const satisfies Record<string, FigureStyleSlots>
`

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, source)

/**
 * 生成后立刻跑一遍 prettier。
 *
 * 否则产物过不了 format:check，而且「跑生成器」与「跑 format」会各自
 * 改一遍文件，diff 里就看不出到底是上游 schema 变了还是格式变了。
 */
const format = spawnSync("pnpm", ["exec", "prettier", "--write", outFile], {
  cwd: root,
  stdio: "ignore",
})
if (format.status !== 0) {
  console.error(`prettier 格式化失败，请手动执行：pnpm exec prettier --write ${outFile}`)
  process.exit(format.status ?? 1)
}

for (const [styleId, { slots, colorSlots }] of Object.entries(styles)) {
  console.log(`${styleId}: ${String(slots.length)} 槽位 / ${String(colorSlots.length)} 颜色槽`)
}
console.log(`跳过的非枚举属性：${skipped.length === 0 ? "（无）" : skipped.join(" ")}`)
console.log(`过滤掉的单变体无开关槽位：${filtered.length === 0 ? "（无）" : filtered.join(" ")}`)
console.log(`已生成 ${outFile}`)
