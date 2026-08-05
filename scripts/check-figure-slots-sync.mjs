#!/usr/bin/env node
/**
 * 门禁：`slots.generated.ts` 与 `@dicebear/*` 的 schema 无漂移。
 *
 * 「同步过了」与「忘了同步」**外观完全相同** —— 界面照常工作，
 * 只是少了新变体 / 多了已被上游删掉的变体。而多出来的那些是**静默失效**：
 * DiceBear 对不存在的变体不抛错，那一格点下去只是部件消失
 * （实测 `hair:["variant99"]` 的产物与 `hair:[]` 逐字节相同）。
 * 于是"漂移了"表现为"某几个格子点了没反应"，没人会想到去重跑生成器。
 *
 * ## ★ 「没装」与「装了但打不开」必须用不同的退出码
 *
 * 这两件事都会让解析失败，但它们的正确反应相反：
 * · 同事还没 `pnpm i` → **前提不存在** → 打印一行 + `exit 0`；
 * · 装上了但 import 抛 / schema 读不到 → **前提存在但我打不开**
 *   → `exit 1`，这是真的坏了。
 *
 * ## ★★ 判据必须是「包目录在不在」，不能靠 catch 错误类型
 *
 * 解析走 `createRequire` 锚定到 `packages/design`，而 `req.resolve()`
 * 在**没装**时抛的也是 `MODULE_NOT_FOUND` —— 与"装了但入口坏了"
 * 混在同一个错误类型里。照"catch 到就 exit 0"写会得到一个
 * **任何失败都放过**的假门禁，而那正是"跳过比失败更糟"的形状：
 * 门禁看起来在工作，实际什么都没保证。
 *
 * ## ★★★ 指纹必须含**变体名与顺序**，不能只含变体数
 *
 * 这一段是被**变异测试**逼出来的。上一版的指纹是 `key(变体数,opt)`，
 * 于是它宣称要拦的那类漂移它**拦不住**。实测四组变异（改产物、重跑门禁）：
 *
 * | 变异                                        | 旧门禁 | 现在   |
 * | ------------------------------------------- | ------ | ------ |
 * | `variant63` 改名为 `BOGUS_RENAMED`（数不变）| exit 0 | exit 1 |
 * | 交换两个变体的顺序                          | exit 0 | exit 1 |
 * | `micah.mouth` 的 `nervous` 改成 `nervouz`   | exit 0 | exit 1 |
 * | 删掉 `toggleOnly: true`                     | exit 0 | exit 1 |
 * | 删掉一个变体（数变了）                      | exit 1 | exit 1 |
 *
 * 只有最后一行是旧门禁真的能拦的。而**改名恰好就是文件头描述的那个形态**：
 * 上游改一个拼写（`tound` → `round` 是很现实的修错字），或我们自己手改产物，
 * 变体数一个都不变，那一格却变成非法值被 DiceBear 静默忽略 ——
 * "某几个格子点了没反应"。同源的教训见记忆
 * `gates-that-skip-are-worse-than-gates-that-fail`：门禁看起来在工作，
 * 实际什么都没保证，而"保证过"与"没保证"外观完全相同。
 *
 * 所以现在指纹对**完整变体数组按原序**取哈希，并纳入
 * `optional` / `probabilityKey` / `toggleOnly`。
 * **改动本文件的指纹算法后必须重跑上面那四组变异确认它们真的变红**
 * —— 否则等于没改（这条也是被这次变异测试证明出来的）。
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { STYLE_PACKAGES } from "./lib/figure-style-packages.mjs"

const root = resolve(import.meta.dirname, "..")
const designDir = join(root, "packages/design")
const generated = join(designDir, "src/components/figure/slots.generated.ts")

/**
 * ★ `STYLE_PACKAGES` 是**共享**的（`lib/figure-style-packages.mjs`），
 * 而下面的 `expected` 判据仍然是抄的 —— 这两件事**不矛盾**，见那个文件的注释：
 * 抄判据能让"判据被改了"变成漂移（有反证价值），抄纯数据只会让
 * "加一个风格漏改一处"变成新的失效点（没有反证价值）。
 */
const COLOR_PATTERN = "^(transparent|[a-fA-F0-9]{6})$"

/**
 * 变体数组的指纹。**按原序**取哈希 —— 顺序也是要锁的东西
 * （上游给的是展示顺序，重排会让用户看到的第 7 个不是他上次挑的那个）。
 *
 * 截到 12 个 hex（48 bit）是为了让报错读得懂：对一个漂移门禁来说，
 * 碰撞概率远低于"报错太长没人读"的成本。变体数照旧一起打印 ——
 * 最常见的漂移（上游加了几个变体）看数字就知道发生了什么，
 * 不用去比哈希。
 */
function fingerprintVariants(variants) {
  return createHash("sha256").update(JSON.stringify(variants)).digest("hex").slice(0, 12)
}

/** 一个槽位的完整指纹：名字 + 变体数 + 变体名/顺序的哈希 + 三个属性。 */
function fingerprintSlot({ key, variants, optional, probabilityKey, toggleOnly }) {
  const parts = [
    `${key}(${String(variants.length)}:${fingerprintVariants(variants)}`,
    optional ? ",opt" : "",
    probabilityKey === undefined ? "" : `,prob=${probabilityKey}`,
    toggleOnly === true ? ",toggle" : "",
    ")",
  ]
  return parts.join("")
}

/**
 * ★ 前提检查：包目录在不在（**不是** try/catch）。
 * 见文件头 —— 靠错误类型区分会把"真没装"与"装了打不开"混成一件事。
 */
const missing = Object.values(STYLE_PACKAGES)
  .concat("@dicebear/core")
  .filter((name) => !existsSync(join(designDir, "node_modules", name, "package.json")))

if (missing.length > 0) {
  console.log(`形象槽位漂移检查跳过：@dicebear 依赖尚未安装（${missing.join(" ")}），请先 pnpm i`)
  process.exit(0)
}

if (!existsSync(generated)) {
  console.error(`形象槽位清单不存在：${generated}\n请运行 pnpm sync:figure-slots`)
  process.exit(1)
}

/**
 * 从这里往下，**任何**失败都是 `exit 1`：包目录已经确认存在，
 * 所以打不开就是真的坏了（上游改了导出结构 / 装坏了 / node_modules 半成品）。
 */
const req = createRequire(pathToFileURL(resolve(designDir, "package.json")))

async function loadSchema(packageName) {
  let mod
  try {
    mod = await import(pathToFileURL(req.resolve(packageName)).href)
  } catch (error) {
    console.error(
      [
        `无法载入 ${packageName} —— 但它的目录是存在的，所以这不是"没装"。`,
        `  原因：${error instanceof Error ? error.message : String(error)}`,
        "  可能是上游改了包入口，或 node_modules 处于半成品状态。",
        "  修法：先 pnpm i --force，仍失败则读一遍该包的 exports 字段。",
      ].join("\n"),
    )
    process.exit(1)
  }
  if (mod.schema?.properties === undefined) {
    console.error(
      [
        `${packageName} 没有 schema.properties —— 上游结构变了。`,
        "  scripts/sync-figure-slots.mjs 的读法要跟着改，改完重跑 pnpm sync:figure-slots。",
      ].join("\n"),
    )
    process.exit(1)
  }
  return mod.schema
}

const coreSchema = await loadSchema("@dicebear/core")
const coreKeys = Object.keys(coreSchema.properties)

/**
 * 现场算出的期望清单。
 *
 * ★ 这段判据与生成器里的 `classify` 是**同一套逻辑抄了两遍**，
 * 而那是**刻意**的：门禁 import 生成器再比对，就只能证明
 * "生成器自己前后一致"，改错了判据两边会一起错、门禁照绿
 * —— 那种门禁等于没有。抄一遍才能让"判据被改了"变成漂移。
 * 所以改生成器的判据时，**这里也要改**，而门禁会先红一次提醒你。
 */
function expected(styleId, schema) {
  const props = schema.properties
  const styleKeys = new Set(Object.keys(props))
  // 差集而不是 core 全集：thumbs / funEmoji 自己的 schema 里就有
  // backgroundColor，用全集排会把这两个风格唯一的定制维度排掉
  const coreOnly = new Set(coreKeys.filter((key) => !styleKeys.has(key)))

  const slots = []
  const colorSlots = []
  for (const [key, definition] of Object.entries(props)) {
    if (coreOnly.has(key) || key.endsWith("Probability")) continue
    if (definition?.items?.pattern === COLOR_PATTERN) {
      colorSlots.push(key)
      continue
    }
    const variants = definition?.items?.enum
    if (!Array.isArray(variants)) continue
    const probabilityKey = `${key}Probability`
    const optional = Object.hasOwn(props, probabilityKey)
    if (variants.length <= 1 && !optional) continue
    slots.push(
      fingerprintSlot({
        key,
        variants,
        optional,
        // 这三个属性也进指纹：删掉 toggleOnly 会让一个开关变成一格网格，
        // 而那在旧指纹下 exit 0（实测）
        ...(optional ? { probabilityKey } : {}),
        ...(variants.length === 1 && optional ? { toggleOnly: true } : {}),
      }),
    )
  }
  return `${styleId}: slots=[${slots.join(" ")}] colors=[${colorSlots.join(" ")}]`
}

const lines = []
for (const [styleId, packageName] of Object.entries(STYLE_PACKAGES)) {
  lines.push(expected(styleId, await loadSchema(packageName)))
}

/**
 * 从产物里读回同样的形状。
 *
 * 用**正则**解析而不是 import 生成物：门禁是 `.mjs`，import 一个 `.ts`
 * 要拉一整条 TS 转译链（而 `check:*` 全都是零依赖的纯 node 脚本）。
 * 解析范围只限定在 `FIGURE_SLOTS` 的那个字面量里，格式由 prettier 固定。
 */
const source = readFileSync(generated, "utf8")
const body = source.slice(source.indexOf("export const FIGURE_SLOTS = {"))
const actual = []
for (const styleId of Object.keys(STYLE_PACKAGES)) {
  const start = body.indexOf(`\n  ${styleId}: {`)
  if (start === -1) {
    console.error(`产物里缺少风格 ${styleId}\n请运行 pnpm sync:figure-slots`)
    process.exit(1)
  }
  // 到下一个风格（或字面量结束）为止
  const rest = body.slice(start + 1)
  const nextIndex = Object.keys(STYLE_PACKAGES)
    .map((other) => (other === styleId ? -1 : rest.indexOf(`\n  ${other}: {`)))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0]
  const block = rest.slice(0, nextIndex ?? rest.indexOf("\n} as const"))

  const slots = []
  /**
   * 逐个槽位对象解析出**全部**指纹要素。
   *
   * 尾部的 `([\s\S]*?)\},` 捕获 `optional` 之后可选的
   * `probabilityKey` / `toggleOnly` —— 槽位对象里没有嵌套花括号，
   * 所以第一个 `},` 就是这个对象的结尾。
   * 单行形态（`{ key: "ears", variants: [...], optional: false },`）
   * 与 prettier 折成多行的形态都能吃。
   */
  for (const match of block.matchAll(
    /\{\s*key:\s*"([^"]+)",\s*variants:\s*\[([\s\S]*?)\],\s*optional:\s*(true|false),?([\s\S]*?)\},/g,
  )) {
    // ★ 取变体**名字**而不只是数数 —— 只数个数时"改名"这类漂移放行（实测）
    const variants = [...(match[2] ?? "").matchAll(/"([^"]*)"/g)].map((item) => item[1])
    const tail = match[4] ?? ""
    const probabilityKey = /probabilityKey:\s*"([^"]+)"/.exec(tail)?.[1]
    slots.push(
      fingerprintSlot({
        key: match[1],
        variants,
        optional: match[3] === "true",
        ...(probabilityKey === undefined ? {} : { probabilityKey }),
        ...(/toggleOnly:\s*true/.test(tail) ? { toggleOnly: true } : {}),
      }),
    )
  }
  const colorMatch = /colorSlots:\s*\[([\s\S]*?)\]/.exec(block)
  const colorSlots = [...(colorMatch?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1])
  actual.push(`${styleId}: slots=[${slots.join(" ")}] colors=[${colorSlots.join(" ")}]`)
}

const drift = lines.filter((line, index) => line !== actual[index])
if (drift.length > 0) {
  console.error("形象槽位清单与 @dicebear schema 不一致（界面会少几个变体，而那不会报错）：")
  for (const [index, line] of lines.entries()) {
    if (line === actual[index]) continue
    console.error(`  schema：${line}`)
    console.error(`  产物：  ${actual[index] ?? "（缺失）"}`)
  }
  console.error("请运行 pnpm sync:figure-slots")
  process.exit(1)
}

console.log(`形象槽位清单与 schema 一致（${String(lines.length)} 个风格）`)
