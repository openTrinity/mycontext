#!/usr/bin/env node
/**
 * 门禁：**注入浏览器的模板字符串里不许有裸反引号**。
 *
 * ## 为什么值得一条门禁
 *
 * CDP 探针（`probe-*.mjs`）的写法是把一段代码塞进模板字符串、
 * 交给 `Runtime.evaluate` 在页面里跑：
 *
 *     const probe = await evaluate(`
 *       (() => { ... 几百行 ... })()
 *     `)
 *
 * 那几百行里写注释是必要的（它们解释每条判据为什么这么量）。
 * 而中文技术注释里最自然的写法是用反引号强调类名 —— `` `border-t` ``、
 * `` `items-end` ``。**那会把模板字符串提前截断。**
 *
 * ## 它为什么难查
 *
 * 报错是 `SyntaxError: missing ) after argument list`，行号指向
 * **模板开始的那一行**（`const probe = await evaluate(`），
 * 而不是那个越界的反引号所在的行。几百行里逐行找一个反引号，
 * 而它看起来完全正常。
 *
 * 我在 `probe-dashboard-ui.mjs` 上踩过**五次**同一个坑。
 *
 * ## ★ 为什么这条检查必须在**外部**文件里
 *
 * 第一版我把自检写进探针自己（启动时扫一遍自己的源码）——
 * 那**不管用**：一旦有裸反引号，模块在**解析阶段**就失败了，
 * 运行期的自检函数根本没机会执行。反证时确认了这一点：
 * 塞一个裸反引号进去，跑出来仍是那句无用的 SyntaxError。
 *
 * 所以检查得由**别的进程**读文本 —— 就是这个脚本。
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const SCRIPTS = join(import.meta.dirname)

/**
 * 找出一个文件里所有"**注入浏览器**用的模板字符串"区间。
 *
 * 判据（两条都要满足）：
 * 1. 起始行以 `evaluate(\`` 或 `expression: \`` 结尾 —— 也就是那几个
 *    真的把代码交给 CDP 执行的调用；
 * 2. 到**单独一行**的 `` \`) `` / `` \`, `` 为止。
 *
 * ## ★ 为什么不扫所有模板字符串
 *
 * 第一版判据是"任何以反引号结尾的行"，于是 `sync-figure-slots.mjs`
 * 那种**代码生成器**被误报了三处 —— 它拼的模板里本来就有嵌套模板
 * （`` return `  ${id}: { ... }` ``），那是完全正常的写法。
 *
 * 误报比漏报更糟：一条老是红的门禁会被人加 skip，然后它就永远不响了。
 * 所以只认"注入执行"这一种形态 —— 那是唯一会被截断且极难查的场景。
 *
 * ★ 纯文本扫描（不做 JS 词法分析）是刻意的：parser 面对已经坏掉的文件
 * 同样只会抛 SyntaxError（就是我们要替代的那个）。
 * 文本扫描的好处正是"文件坏了也能给出行号"。
 */
function templateRanges(lines) {
  const ranges = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    // 只认注入执行的那几种调用形态
    if (!/(?:evaluate\(|expression:\s*)`$/.test(line)) continue
    for (let j = i + 1; j < lines.length; j += 1) {
      const close = (lines[j] ?? "").trim()
      if (close === "`)" || close === "`," || close === "`") {
        ranges.push([i, j])
        i = j
        break
      }
    }
  }
  return ranges
}

const offenders = []
for (const name of readdirSync(SCRIPTS)) {
  if (!name.endsWith(".mjs")) continue
  const path = join(SCRIPTS, name)
  const lines = readFileSync(path, "utf8").split("\n")
  for (const [from, to] of templateRanges(lines)) {
    for (let i = from + 1; i < to; i += 1) {
      const line = lines[i] ?? ""
      // 未被 \ 转义的反引号
      if (/(?<!\\)`/.test(line)) {
        offenders.push({ file: name, line: i + 1, text: line.trim().slice(0, 78) })
      }
    }
  }
}

if (offenders.length > 0) {
  console.error("✗ 注入用的模板字符串里有**裸反引号**，它会把字符串提前截断：\n")
  for (const o of offenders) {
    console.error(`  ${o.file}:${String(o.line)}`)
    console.error(`    ${o.text}`)
  }
  console.error(
    "\n那样 node 会报 `missing ) after argument list`，而行号指向模板开头 ——" +
      "\n与真正出错的这一行无关，所以极难查。修法：把注释里的反引号去掉，" +
      "\n或写成 \\` 转义。",
  )
  process.exit(1)
}

console.log("模板字符串检查通过：注入代码里没有裸反引号")
