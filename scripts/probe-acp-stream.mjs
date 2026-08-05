#!/usr/bin/env node
/**
 * ACP 流的**原始 dump** —— 用来看「响应帧到底夹在哪」。
 *
 * ## 为什么这个脚本必须留下
 *
 * 它是唯一能看见「`session/prompt` 的响应在 chunk **中间**返回」这件事的工具。
 * 那件事直接造成过一条落库的坏草稿（`{"reply": "哈哈好", "holdForReview": false,`
 * —— 40 个字符，在 `false,` 后硬断）。单测能锁住修好之后不回退
 * （`tests/unit/desktop/persona-acp.test.ts` 那条回归锁用的就是这里 dump 出来的顺序），
 * 但**发现**这件事只能靠真进程 —— mock transport 的时序是我们自己编的。
 *
 * 删掉它下次还得重写一遍，而重写的人未必知道要看"响应在第几行"。
 *
 * ## 两种用法
 *
 * ```bash
 * node scripts/probe-acp-stream.mjs                      # 默认 prompt，dump + 打印
 * node scripts/probe-acp-stream.mjs "自定义 prompt"
 * node scripts/probe-acp-stream.mjs --assert-complete     # 门禁模式：读早了就 exit 1
 * ```
 *
 * `--assert-complete` 断言的是**等流稳定之后拿到的文本是完整的**
 * （能 `JSON.parse` 出带 `reply` 的信封）—— 也就是 `PersonaAcp.settleStream`
 * 依赖的那个前提在真进程上成立。拿不到完整信封就 exit 1。
 *
 * ★ 它**不**拿"响应是否夹在流中间"当失败条件。那件事是**上游时序**，
 * 每次跑都可能不同（实测：带工具调用的那轮响应在第 18 行，纯文本那轮在最后）。
 * 把它当失败条件的话，门禁绿就等于"这次恰好没触发"，那是个假信号；
 * 而它红了也不代表我们的代码坏了。所以它只作为**信息**打印出来 ——
 * 打印本身有价值：它是当初发现这个 bug 的唯一线索。
 *
 * 会真的调模型（花钱），所以不进默认门禁。
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const assertComplete = args.includes("--assert-complete")
const promptArg = args.find((a) => !a.startsWith("--"))

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

function readEnv() {
  const path = join(root, ".env")
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "")
  }
  return out
}

/**
 * ★ 默认 prompt 要求**长**输出。
 *
 * 短回复时流在响应前就发完了 —— 那时探针会显示 SAME，看起来"没问题"。
 * 这个 bug 是长度/时序相关的，所以默认就往会暴露它的那一侧压。
 */
const DEFAULT_PROMPT =
  "请用中文写一段大约 150 字的自我介绍，然后只输出一个 JSON 对象：" +
  '{"reply":"<那段介绍>","holdForReview":false,"reviewReason":""}'

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-acpprobe-"))
const outFile = join(outDir, "probe.mjs")

await build({
  entryPoints: [join(root, "scripts/probe-acp-stream-entry.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3", "electron"],
  alias: workspaceAlias(),
  logLevel: "silent",
})

const env = { ...readEnv(), ...process.env }
const { runAcpProbe } = await import(`file://${outFile}`)

const report = await runAcpProbe({
  env,
  workspaceRoot: mkdtempSync(join(tmpdir(), "mycontext-acpprobe-ws-")),
  skillsDir: join(root, "apps/desktop/resources/skills"),
  klRoot: join(root, "kl-graph"),
  klPort: 8200,
  prompt: promptArg ?? DEFAULT_PROMPT,
})

const dumpPath = join(root, "acp-stream-dump.json")
writeFileSync(dumpPath, JSON.stringify(report, null, 2), "utf8")

/**
 * 把响应帧在 chunk 序列里的位置打出来 —— 这一行就是整个脚本的存在理由。
 */
const timeline = []
for (const line of report.rawLines) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    continue
  }
  if (msg.id !== undefined && msg.method === undefined) {
    timeline.push(`RESPONSE id=${String(msg.id)}`)
  } else if (msg.method === "session/update") {
    const update = msg.params?.update
    if (update?.sessionUpdate === "agent_message_chunk") {
      timeline.push(`chunk ${JSON.stringify(update.content?.text ?? "")}`)
    }
  }
}
console.log("--- 时间线（响应帧 vs chunk）---")
for (const [index, entry] of timeline.entries()) console.log(`  ${String(index)} ${entry}`)

const atResponse = report.collectedAtResponse
const settled = report.collected
console.log("")
console.log(`响应那一刻：${String(atResponse.length)} 字符`)
console.log(`等稳定之后：${String(settled.length)} 字符`)
console.log(JSON.stringify(settled))
console.log(`stopReason=${JSON.stringify(report.stopReason)}`)
console.log(`dump → ${dumpPath}`)

if (settled === atResponse) {
  console.log("")
  console.log("SAME —— 本次所有 chunk 都在响应前到达（短回复时常见，不代表时序安全）")
} else {
  const tail = settled.slice(atResponse.length)
  console.log("")
  console.log(`DIFFERENT —— 响应先返回，之后还到了 ${String(tail.length)} 字符：`)
  console.log(`  ${JSON.stringify(tail)}`)
  console.log("→ 在响应处直接读会拿到**半截**文本。这就是 settleStream 存在的理由。")
}

if (!assertComplete) process.exit(0)

/**
 * ★ 门禁判据：**等稳定之后的文本是一个完整信封**。
 *
 * 为什么不拿「响应夹在流中间」当判据：那是上游时序，每次跑都可能不同
 * （实测同一天两轮，一轮响应在第 18 行、一轮在最后一行）。用它当判据
 * 会让门禁绿等于"这次恰好没触发" —— 一个假信号。
 *
 * 完整信封才是我们真正依赖的性质：不管响应什么时候回来，等流稳定之后
 * 都能拿到可解析的 `{reply,…}`。它红了就是**真的**有问题。
 */
const failures = []
if (settled.trim() === "") failures.push("等稳定之后仍然是空文本（0-token 或流没接上）")
else {
  let parsed = null
  try {
    parsed = JSON.parse(settled)
  } catch {
    failures.push(
      `等稳定之后的文本不是合法 JSON（很可能仍是半截）：${JSON.stringify(settled.slice(-80))}`,
    )
  }
  if (parsed !== null && typeof parsed.reply !== "string") {
    failures.push("解析出来了但没有 string 型的 `reply` 字段")
  }
}

if (failures.length > 0) {
  console.error("")
  console.error("✗ ACP 流收尾断言失败：")
  for (const failure of failures) console.error(`  · ${failure}`)
  /**
   * 「跑不起来/断言不成立必须 exit 1」—— 静默 exit 0 的门禁比没有门禁更糟，
   * 因为它给出的是"已验证"的假信号。
   */
  process.exit(1)
}

console.log("")
console.log("✓ 等流稳定之后拿到的是完整信封（settleStream 的前提在真进程上成立）")
