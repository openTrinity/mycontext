#!/usr/bin/env node
/**
 * 门禁：`typography-*` 组合类必须**真实存在**。
 *
 * ## 为什么值得一条门禁
 *
 * `packages/design` 的排版类是一张固定表（`styles/typography.css`）。
 * 写一个**不在表里**的名字时：
 *   · Tailwind 不认识它（不是 utility，也没有对应 CSS 规则）；
 *   · 那个 className 原样进 DOM，**没有任何样式**；
 *   · 于是那段文字退回浏览器默认字号 —— 16px、字重 400。
 *
 * 关键是**没有任何报错**：lint 过、typecheck 过、单测过，
 * 而界面上所有数字一样大、一样粗。实测踩到：仪表盘与知识图谱两页
 * 写了 6 个不存在的名字（`typography-heading-md-600` /
 * `typography-body-xs-400` / `typography-body-sm-500` …），
 * 表现就是"这一页看起来很丑、没有层次" —— 而原因不在配色也不在间距。
 *
 * 这正是本仓库反复出现的那类失效（静默降级），所以按老规矩写门禁而不是靠记。
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const root = join(import.meta.dirname, "..")
const CSS = join(root, "packages/design/src/styles/typography.css")
const SKIP = new Set(["node_modules", ".git", "dist", "out", ".tsbuild", "coverage"])

/** 表里真实定义的那些类名。 */
const defined = new Set(
  [...readFileSync(CSS, "utf8").matchAll(/^\.(typography-[a-z0-9-]+)\s*\{/gm)].map((m) => m[1]),
)
if (defined.size === 0) {
  console.error("✗ 没能从 typography.css 里解析出任何类名 —— 门禁自己坏了")
  process.exit(1)
}

/** 扫源码里用到的名字。只扫 tsx/ts（css 里就是定义处）。 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(path)
  }
  return out
}

const bad = []
for (const file of [...walk(join(root, "apps")), ...walk(join(root, "packages"))]) {
  const text = readFileSync(file, "utf8")
  for (const match of text.matchAll(/typography-[a-z0-9-]+/g)) {
    const cls = match[0]
    if (defined.has(cls)) continue
    /**
     * 注释里提到不存在的名字是合法的（我们**就是**在解释它不存在）。
     * 判据：这一行是否以注释标记开头 —— 够用且不会误杀，
     * 因为真正的用法总在 `className=…` 里。
     */
    const line = text.slice(0, match.index).split("\n").length
    const lineText = text.split("\n")[line - 1] ?? ""
    if (/^\s*(\*|\/\/|\/\*)/.test(lineText)) continue
    bad.push(`${relative(root, file)}:${line}: ${cls}`)
  }
}

if (bad.length > 0) {
  console.error(`排版类检查未通过，${bad.length} 处用了**不存在**的组合类：`)
  for (const line of bad) console.error(`  - ${line}`)
  console.error("")
  console.error("这些 className 不会生成任何样式（文字会退回浏览器默认字号，且不报错）。")
  console.error(`可用的类：${[...defined].sort().join(", ")}`)
  console.error("表里没有你要的档位时**给表加一档**（连注释说明为什么），不要写裸 text-[NNpx]。")
  process.exit(1)
}

/**
 * ★★ 第二条：**渲染层不许写裸 `text-[NNpx]`**。
 *
 * ## 为什么这也是一条门禁
 *
 * `typography.css` 的文件头第一句就是"避免各处散写 text-[13px]"，
 * 而实测仓库里有 **22 处**在那样写 —— 包括表里根本没有的档位
 * （28px / 48px / 11px）。这不报错、不违反上面那条（它只查捏造的
 * token 名），后果是**排版表失去权威**：改一档字号时那 22 处不跟着变，
 * 于是同一个视觉层级在不同页面是不同大小的，而"这一页看起来没设计感"
 * 正是这么来的。
 *
 * 讽刺的是**原来这条门禁自己在鼓励它**：失败提示的最后一句写着
 * 「token 表里没有的字号请写显式 text-[NNpx]」。所以那句话也一起改了 ——
 * 正确做法是给表加一档（像这次的 `body-reading-400`），
 * 而不是在调用点绕开表。
 *
 * ## 只查渲染层（`apps/**` 的 renderer），不查 `packages/design`
 *
 * 设计系统内部的组件（Button/Input/Avatar 的尺寸档）**就是**定义
 * 那些尺寸的地方 —— 它们按 `size` prop 给不同字号，那不是"绕开表"，
 * 那是在实现表。对它们设这条规则等于要求每个控件尺寸都进排版表，
 * 而控件字号与文本层级是两套东西。
 *
 * 判据是"渲染层不该自己决定字号"，所以范围就是渲染层。
 */
const RAW_SIZE = /text-\[\d+px\]/g
const rawSites = []
for (const file of walk(join(root, "apps"))) {
  if (!file.includes(`${sep}renderer${sep}`)) continue
  const text = readFileSync(file, "utf8")
  for (const match of text.matchAll(RAW_SIZE)) {
    const line = text.slice(0, match.index).split("\n").length
    const lineText = text.split("\n")[line - 1] ?? ""
    // 与上面同一个理由：注释里提到它是合法的（我们就是在解释它）
    if (/^\s*(\*|\/\/|\/\*)/.test(lineText)) continue
    rawSites.push(`${relative(root, file)}:${line}: ${match[0]}`)
  }
}

if (rawSites.length > 0) {
  console.error(`排版检查未通过：渲染层有 ${rawSites.length} 处裸字号，绕开了排版表：`)
  for (const line of rawSites) console.error(`  - ${line}`)
  console.error("")
  console.error("裸 px 不报错，但会让排版表失去权威 —— 改一档字号时这些地方不跟着变，")
  console.error("于是同一个视觉层级在不同页面是不同大小的。")
  console.error(`请改用组合类：${[...defined].sort().join(", ")}`)
  console.error("确实缺一档时**给 typography.css 加一档**并写清为什么，那才是可复用的修法。")
  process.exit(1)
}

console.log(`排版类检查通过：${defined.size} 个组合类，无凭空捏造的名字；渲染层无裸字号`)
