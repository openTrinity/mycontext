#!/usr/bin/env node
/**
 * 门禁：桌面端产物里不得残留裸的 `@mycontext/*` import。
 *
 * ## 为什么这条门禁必须存在
 *
 * 它对应一个真实发生过、且**所有其它门禁都放过**的故障：
 *
 * `electron.vite.config.ts` 里曾有两份**手写**的包清单
 * （`externalizeDepsPlugin({ exclude })` 与 `resolve.alias`），
 * 只列了 M1c 时主进程用到的 5 个包。之后新增的 `ingest` / `retrieval` /
 * `knowledge-feed` / `agent-runtime` 没人想起来补，于是：
 *
 *   ① 不在 exclude 里 → 被**外置**；
 *   ② 产物里留下裸的 `import … from "@mycontext/ingest"`；
 *   ③ 运行时按 pnpm 软链找到 `packages/ingest/package.json` 的
 *      `"main": "./src/index.ts"`；
 *   ④ 那个 TS 文件写的是 `export … from "./normalizer.js"`
 *      —— TS NodeNext 写法，`.js` 编译期指向 `.ts`。这些包**没有预编译
 *      dist**，磁盘上没有 `normalizer.js` → `ERR_MODULE_NOT_FOUND`。
 *
 * **`pnpm verify` 当时是全绿的**（1191 单测 / 6 条门禁），
 * 因为没有任何测试加载构建产物 —— 而 `pnpm dev` 起不来。
 *
 * ## 为什么不是扩展 check-package-wiring
 *
 * 那条门禁查的是「包名有没有出现在清单里」，是**代理指标**。
 * 配置现在改成从文件系统推导，已经没有清单可查了 ——
 * 但推导逻辑本身也可能写错（比如 glob 漏了某种目录形态）。
 * 这条门禁查的是**真正要成立的那件事**：产物能不能被 Node 解析。
 * 代理指标会随实现变化而失效，不变式不会。
 *
 * ## 需要先构建
 *
 * 产物不存在时**跳过而不是报错**：`pnpm verify` 不含 build
 * （构建慢且需要 Electron ABI 的原生模块）。CI 里 build 之后会再跑一次它。
 * 跳过时明确打印跳过了什么 —— 静默跳过的门禁等于没有门禁。
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

/** 产物 → 该产物允许外置的模块（native 模块必须外置，无法内联）。 */
const ARTIFACTS = [
  { path: "apps/desktop/out/main/index.js", label: "主进程" },
  { path: "apps/desktop/out/preload/index.cjs", label: "preload" },
]

/**
 * 裸 specifier 的匹配。
 *
 * 同时覆盖 ESM 与 CJS：main 产物是 ESM（`import … from "x"`），
 * preload 是 CJS（`require("x")`）。只查一种会让另一种悄悄溜过去。
 */
const BARE_SPECIFIER = /(?:from|require\(|import\()\s*["'](@mycontext\/[a-z0-9-]+)["']/g

const problems = []
const checked = []
const skipped = []

for (const artifact of ARTIFACTS) {
  const full = resolve(root, artifact.path)
  if (!existsSync(full)) {
    skipped.push(artifact.path)
    continue
  }
  const source = readFileSync(full, "utf8")
  const bare = [...new Set([...source.matchAll(BARE_SPECIFIER)].map((match) => match[1]))].sort()
  checked.push(artifact.path)
  for (const name of bare) {
    problems.push(
      `${artifact.path}（${artifact.label}）残留裸 import：${name}\n` +
        `      → 该包被 externalizeDepsPlugin 外置了，运行时会解析到它的 src/index.ts，\n` +
        `        而那里的 "./x.js" 相对导入在磁盘上不存在（无预编译 dist）→ 启动即崩。\n` +
        `        检查 apps/desktop/electron.vite.config.ts 的 discoverWorkspacePackages()`,
    )
  }
}

if (problems.length > 0) {
  console.error(`桌面端产物检查未通过，${problems.length} 处：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

if (skipped.length > 0) {
  console.log(
    `桌面端产物检查：跳过 ${skipped.length} 个未构建的产物（${skipped.join("、")}）` +
      `${checked.length > 0 ? `；已检查 ${checked.length} 个` : "；先跑 pnpm build 才能检查"}`,
  )
} else {
  console.log(`桌面端产物检查通过：${checked.length} 个产物无残留裸 @mycontext/* import`)
}
