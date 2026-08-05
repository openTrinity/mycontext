#!/usr/bin/env node
/**
 * 门禁：每个 packages/* 都注册到了必需的几份手工清单里。
 *
 * 为什么需要：`vitest.config.ts` 的 `resolve.alias` 是**逐个包列出的显式白名单**
 * （不是通配），`tests/tsconfig.json` 的 `paths` 是第二份手工表，
 * 根 `tsconfig.json` 的 `references` 是第三份。加一个包要同批改三处，
 * 而漏任一处的表现是：
 *   · 漏 vitest alias  → 测试里 import 该包报 `Cannot find package`
 *   · 漏 tests paths   → 测试代码类型解析失败
 *   · 漏 references    → `tsc -b` 根本不编译该包
 *
 * 本轮要新增 7 个包（≈21 处配置改动）。「第 8 个包一定会漏」是可以预测的，
 * 而检查逻辑只有几十行 —— 这是 R18（静默失效类）的标准处理：
 * 凡是「忘了也不报错到很久以后」的事，写门禁而不是靠人记。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

/** 实际存在的包（有 package.json 的目录）。 */
function discoverPackages() {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(root, "packages", name, "package.json")))
    .sort()
}

function read(file) {
  return readFileSync(join(root, file), "utf8")
}

/**
 * 用正则而不是 JSON.parse / TS 解析。
 *
 * `vitest.config.ts` 是 TypeScript（含 `resolve()` 调用），
 * 两份 tsconfig 是 JSONC（带注释）—— 都不能直接 parse。
 * 我们只需要「这个包名出现在这份清单里没有」，正则足够且不引依赖。
 */
function declaredInVitest() {
  const source = read("vitest.config.ts")
  return new Set([...source.matchAll(/"@mycontext\/([a-z0-9-]+)"/g)].map((m) => m[1]))
}

function declaredInTestsTsconfig() {
  const source = read("tests/tsconfig.json")
  return new Set([...source.matchAll(/"@mycontext\/([a-z0-9-]+)"/g)].map((m) => m[1]))
}

function declaredInRootReferences() {
  const source = read("tsconfig.json")
  return new Set([...source.matchAll(/"path"\s*:\s*"packages\/([a-z0-9-]+)"/g)].map((m) => m[1]))
}

const packages = discoverPackages()
const checks = [
  {
    file: "vitest.config.ts",
    declared: declaredInVitest(),
    fix: (name) =>
      `在 resolve.alias 里加："@mycontext/${name}": resolve(root, "packages/${name}/src/index.ts")`,
  },
  {
    file: "tests/tsconfig.json",
    declared: declaredInTestsTsconfig(),
    fix: (name) =>
      `在 compilerOptions.paths 里加："@mycontext/${name}": ["../packages/${name}/src/index.ts"]`,
  },
  {
    file: "tsconfig.json",
    declared: declaredInRootReferences(),
    fix: (name) => `在 references 里加：{ "path": "packages/${name}" }`,
  },
]

const problems = []
for (const check of checks) {
  const missing = packages.filter((name) => !check.declared.has(name))
  for (const name of missing) {
    problems.push(`${check.file}：缺少 packages/${name}\n      → ${check.fix(name)}`)
  }
  // 反向：清单里列了但包不存在（改名/删包后的残留，会让 tsc -b 直接失败）
  const stale = [...check.declared].filter((name) => !packages.includes(name))
  for (const name of stale) {
    problems.push(`${check.file}：登记了不存在的 packages/${name}（改名或删包后的残留）`)
  }
}

if (problems.length > 0) {
  console.error(`包注册检查未通过，${problems.length} 处：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`包注册检查通过：${packages.length} 个包在 3 份清单中均已登记`)
