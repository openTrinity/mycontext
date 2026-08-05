#!/usr/bin/env node
/**
 * 数字人**真实端到端**：投递 → 调度 → 出草稿（会花钱）。
 *
 * 走的是生产路径（真 supervisor / 真消费者 / 真 policy / 真落库），
 * 不是重写一遍逻辑 —— 重写的话脚本"通了"也不代表应用里那条路通。
 *
 * 用法：
 *   node scripts/check-persona.mjs                 # 自动挑一个有他人消息的会话
 *   node scripts/check-persona.mjs --conv <id>
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)

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

function findVault() {
  const appSupport = join(homedir(), "Library", "Application Support")
  for (const appName of [
    "MyContextDevelop",
    "MyContextDev",
    "MyContext",
    "InklingsDevelop",
    "InklingsDev",
    "Inklings",
  ]) {
    const vaultsDir = join(appSupport, appName, "vaults")
    if (!existsSync(vaultsDir)) continue
    for (const entry of readdirSync(vaultsDir)) {
      const candidate = join(vaultsDir, entry, "core.sqlite")
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error("未找到 vault。先登录应用并采集一次。")
}

const env = { ...readEnv(), ...process.env }
const convIndex = args.indexOf("--conv")

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-personacheck-"))
const outFile = join(outDir, "check.mjs")
// workspace 用临时目录：不污染真实的 agent workspace
const workspaceRoot = mkdtempSync(join(tmpdir(), "mycontext-persona-ws-"))

try {
  await build({
    entryPoints: [join(root, "scripts/check-persona-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3", "electron"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runPersonaCheck } = await import(`file://${outFile}`)
  const report = await runPersonaCheck({
    dbPath: findVault(),
    workspaceRoot,
    skillsDir: join(root, "apps/desktop/resources/skills"),
    baseUrl: env["MYCONTEXT_LLM_BASE_URL"] ?? "",
    apiKey: env["MYCONTEXT_LLM_API_KEY"] ?? "",
    model: env["MYCONTEXT_MODEL_MAIN"] ?? "qwen3.7-plus",
    ...(convIndex === -1 ? {} : { conversationId: args[convIndex + 1] }),
    now: () => Date.now(),
  })

  console.log(`会话：${report.conversation.title ?? report.conversation.id}`)
  console.log(`  类型 ${report.conversation.kind} · 消息 ${report.conversation.messageCount} 条`)
  console.log(`  agent 可用：${String(report.agentAvailable)}（false = 只出占位草稿）`)
  console.log("")
  console.log("处理前：")
  console.log(
    `  白名单 ${report.before.whitelist} · 待处理 ${report.before.pendingInbox} · 草稿 ${report.before.pendingDrafts}`,
  )
  console.log("")
  console.log(
    `Outbox 投递：接纳 ${report.delivered.processed} 条，准入闸拒 ${report.delivered.skipped} 条`,
  )
  console.log(`调度：dispatched ${report.dispatched}，因并发上限跳过 ${report.skippedBusy}`)
  console.log("")
  console.log("处理后：")
  console.log(
    `  白名单 ${report.after.whitelist} · 待处理 ${report.after.pendingInbox} · 草稿 ${report.after.pendingDrafts}`,
  )
  console.log(`  workspace 物化了 ${report.materializedFiles} 个文件（画像进 agent 上下文）`)
  console.log(`  reply skill 已装入：${String(report.skillInstalled)}`)
  /**
   * 检索工具用了几次。
   *
   * 0 次不一定是错（这一轮可能确实不需要翻旧消息），但它与"工具接错了"
   * 长得一模一样 —— 所以数字要摆出来让人判断，而不是替他判断。
   */
  console.log(
    `  检索工具：调用 ${report.recall.calls} 次，多轮 ${report.recall.rounds} 轮${
      report.recall.calls === 0 ? "（0 次也可能是这轮不需要翻旧消息）" : ""
    }`,
  )
  if (report.toolProbe === null) {
    console.log("  工具探针：跳过（没配模型）")
  } else {
    console.log(
      `  工具探针：真网关调起 ${report.toolProbe.called ? "是" : "否"} · 命中 ${report.toolProbe.hits} 条 · 会话隔离 ${report.toolProbe.isolated ? "成立" : "破了"}`,
    )
  }
  console.log("")
  console.log("运行记录：")
  for (const run of report.runs) {
    const tail = run.error === null ? "" : ` ← ${run.error}`
    console.log(
      `  decision=${run.decision} reason=${run.decisionReason ?? "—"} conf=${run.confidence ?? "—"}${tail}`,
    )
  }
  console.log("")
  console.log("草稿：")
  for (const draft of report.drafts) {
    console.log(`  · (${draft.citations} 条引用，未发原因 ${draft.notSentReason ?? "—"})`)
    console.log(`      ${draft.text}`)
  }

  /**
   * 判据是**草稿真的落库了**。
   *
   * 准入闸命中任何一条都会静默丢弃（那是正确行为），所以
   * "没报错 + 0 条草稿"是这条链路最可能的失败形态 —— 与成功长得一样。
   */
  if (report.delivered.processed === 0) {
    console.error("\n✗ 一条消息都没被接纳 —— 准入闸把全部拒了（检查触发条件与 kill switch）。")
    process.exitCode = 1
  } else if (report.dispatched === 0) {
    console.error("\n✗ 接纳了但没调度 —— supervisor 的 tick 没跑起来。")
    process.exitCode = 1
  } else if (report.drafts.length === 0) {
    console.error("\n✗ 调度了但一条草稿都没有 —— 生成或落库有问题（看 run 的 error）。")
    process.exitCode = 1
  } else if (report.materializedFiles === 0) {
    console.error("\n✗ workspace 里没有文件 —— 画像没物化进 agent 上下文。")
    process.exitCode = 1
  } else if (!report.skillInstalled) {
    /**
     * skill 缺失的表现是"回复不像本人"，没有任何报错 ——
     * 所以单独断言它在，而不是只看总文件数。
     */
    console.error("\n✗ reply skill 没进 workspace —— agent 看不到它（回复会退回内置指引）。")
    process.exitCode = 1
  } else if (report.toolProbe !== null && !report.toolProbe.called) {
    /**
     * ★ 探针一次都没调起来 = 工具在真网关上没接通。
     *
     * 这条不能只是打印一行数字：接不通的表现是"回复变笼统"，
     * 草稿照出、日志无异常 —— 与"这轮不需要检索"完全一样。
     * 探针问的是必须翻历史才能答的问题，所以 0 次只剩这一个解释。
     */
    console.error("\n✗ 检索工具在真网关上一次都没被调起来 —— 工具声明或多轮回传坏了。")
    process.exitCode = 1
  } else if (report.toolProbe !== null && !report.toolProbe.isolated) {
    // 单会话隔离破了是**安全**问题，比功能坏更严重
    console.error("\n✗ 会话隔离破了 —— 限定别的会话时仍能召回本会话的消息。")
    process.exitCode = 1
  } else if (report.toolProbe !== null && report.toolProbe.hits === 0) {
    /**
     * 用的是从这个会话真实消息里取出来的词 —— 它必然在 FTS 索引里。
     * 所以 0 命中不是"这个词冷门"，而是召回链路真的断了
     * （索引没建 / conversationIds 过滤写错 / 分词器变了）。
     */
    console.error("\n✗ 用本会话真实语料里的词都召回不到 —— FTS 索引或召回链路坏了。")
    process.exitCode = 1
  } else {
    console.log("\n✓ 数字人端到端跑通（投递 → 调度 → 草稿，画像已进 workspace）")
  }
} catch (error) {
  console.error("PERSONA_CHECK_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(workspaceRoot, { recursive: true, force: true })
}
