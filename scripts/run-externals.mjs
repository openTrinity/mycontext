#!/usr/bin/env node
/**
 * 运行需要外部依赖的测试（opencode / dws / kl / LLM 网关）。
 *
 * 为什么单独一条命令而不是塞进 `pnpm test`：
 * `pnpm test` 必须**全 hermetic**（无网络、无外部进程、无真实模型），
 * 否则门禁会在同事机器上随机变红（"我这没装 opencode"）。
 * 而"门禁偶尔红"的最终结果是所有人学会忽略它。
 *
 * 这里的测试文件自己用 `describe.skipIf(!hasOpencode)` 之类跳过，
 * 但本脚本会**显式报告跳过了什么** —— 静默跳过等于没测，
 * 与"忘了写测试"是同一类静默失效。
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { resolveOpencodeBinary } from "./lib/opencode-resolver.mjs"

const root = resolve(import.meta.dirname, "..")

/** 探测各外部依赖是否可用，并把结论打出来。 */
function probe() {
  const opencode = resolveOpencodeBinary()
  const dws = join(root, "apps/desktop/resources/bin", `dws-${process.platform}-${process.arch}`)
  const klRepo = join(root, "kl-graph")

  return [
    {
      name: "opencode",
      ok: opencode !== null,
      detail: opencode?.path ?? "未安装（Agent 测试将跳过）",
      env: "MYCONTEXT_HAS_OPENCODE",
    },
    {
      name: "dws",
      ok: existsSync(dws),
      detail: existsSync(dws) ? dws : "未准备（跑 pnpm prepare:bin）",
      env: "MYCONTEXT_HAS_DWS",
    },
    {
      name: "kl-graph",
      ok: existsSync(join(klRepo, "kl_graph")),
      detail: existsSync(join(klRepo, "kl_graph")) ? klRepo : "未接入（E 阶段）",
      env: "MYCONTEXT_HAS_KL",
    },
  ]
}

const deps = probe()
console.log("外部依赖探测：")
for (const dep of deps) {
  console.log(`  ${dep.ok ? "✓" : "·"} ${dep.name}：${dep.detail}`)
}

const unavailable = deps.filter((dep) => !dep.ok)
if (unavailable.length > 0) {
  console.log(
    `\n注意：${unavailable.length} 个依赖不可用，相关测试会被跳过 ——` +
      `跳过的测试等于没测，联调前请补齐（${unavailable.map((d) => d.name).join(" / ")}）。`,
  )
}

const env = { ...process.env }
for (const dep of deps) env[dep.env] = dep.ok ? "1" : "0"

/** 跳过统计用的中间产物。写到 tmp 而不是仓库里，免得漏进 git。 */
const jsonPath = join(tmpdir(), `mycontext-externals-${String(process.pid)}.json`)

const result = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "tests/externals",
    "--reporter",
    "json",
    "--outputFile",
    jsonPath,
    "--reporter",
    "default",
  ],
  {
    cwd: root,
    env,
    stdio: "inherit",
  },
)

/**
 * ★ 依赖可用却仍然跳过 = 失败，不是"跳过"。
 *
 * 上面那段只报「依赖装没装」，而实测栽在另一种情况上：kl-graph **装着**
 * （`kl_graph/` 在），但某组测试的 `skipIf` 判的是上游已经**删掉**的文件
 * （`kl_graph/adapters/dws_message_adapter.py`）→ 5 条静默跳过，
 * 输出里只有一行 "5 skipped"，看起来像"环境没装 python"。
 *
 * 于是这里补上判据：**依赖都可用时，一条都不该跳**。
 * 这条断言能抓的正是"skipIf 的门槛本身失效了"——
 * 而那类失效不会红、只会安静地少测一整组。
 */
if (unavailable.length === 0 && existsSync(jsonPath)) {
  try {
    const report = JSON.parse(readFileSync(jsonPath, "utf8"))
    const skipped = (report.testResults ?? []).flatMap((file) =>
      (file.assertionResults ?? [])
        .filter((test) => test.status === "pending" || test.status === "skipped")
        .map((test) => `${file.name?.split("/").pop() ?? "?"} › ${test.title}`),
    )
    if (skipped.length > 0) {
      console.error(
        `\n✗ 全部外部依赖可用，却仍有 ${skipped.length} 条测试被跳过 —— ` +
          `很可能是某个 skipIf 的门槛引用了已不存在的文件（上游重构后常见）。\n` +
          skipped.map((line) => `    · ${line}`).join("\n"),
      )
      rmSync(jsonPath, { force: true })
      process.exit(1)
    }
  } catch (error) {
    console.error(
      "跳过统计读取失败（不影响测试结论）：",
      error instanceof Error ? error.message : error,
    )
  }
}
rmSync(jsonPath, { force: true })
process.exit(result.status ?? 1)
