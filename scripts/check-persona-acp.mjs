#!/usr/bin/env node
/**
 * 数字分身**生产路径**端到端（真 ACP + 真画像 + 真 kl，会花钱）。
 *
 * ## 与 `check-persona.mjs` 的分工
 *
 * 那个走 LlmClient 直连（它的 entry 里 `runtime: {} as never`）。
 * 这个走 **ACP**，也就是用户实际用的那条路 —— 于是它能验到直连验不到的两件事：
 * · 半截 JSON（`PersonaAcp.settleStream`）；
 * · `AGENTS.md` 的工具声明（`tools: "agent"` → 明说能查 kl 图谱）。
 *
 * ## ★ 只读：自动跑在 vault 的**副本**上
 *
 * 这个脚本会写 `dh_drafts` / `dh_agent_runs`，在真 vault 上跑会污染草稿箱。
 * 所以它自己复制一份到临时目录，绝不碰原文件。
 *
 * ```bash
 * node scripts/check-persona-acp.mjs --conv <id> --ask "你最喜欢哪个歌手"
 * ```
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)

function arg(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

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

/** 找 vault + 它的 forge 产物目录。两者必须同源（同一个 vaultId）。 */
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
      const db = join(vaultsDir, entry, "core.sqlite")
      const forgeSkills = join(vaultsDir, entry, "forge", "skills")
      // 要的是**已经蒸馏过**的那个 vault：没有产物就验不到判定层与画像
      if (existsSync(db) && existsSync(forgeSkills)) {
        return {
          db,
          forgeSkillRoot: forgeSkills,
          agentHome: join(appSupport, appName, "agent-home"),
        }
      }
    }
  }
  throw new Error("没找到**已蒸馏**的 vault（需要 <vault>/forge/skills）")
}

const env = { ...readEnv(), ...process.env }
const found = findVault()

/**
 * ★ 复制 vault —— 连 -wal 一起。
 *
 * 只拷 core.sqlite 会丢掉 WAL 里还没 checkpoint 的那部分（也就是最近的消息），
 * 而"最近的消息"恰恰是这个探针要用的上下文。
 */
const copyDir = mkdtempSync(join(tmpdir(), "mycontext-persona-acp-vault-"))
const dbCopy = join(copyDir, "core.sqlite")
copyFileSync(found.db, dbCopy)
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(`${found.db}${suffix}`)) copyFileSync(`${found.db}${suffix}`, `${dbCopy}${suffix}`)
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-personaacp-"))
const outFile = join(outDir, "check.mjs")
const workspaceRoot = mkdtempSync(join(tmpdir(), "mycontext-persona-acp-ws-"))

try {
  await build({
    entryPoints: [join(root, "scripts/check-persona-acp-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: {
      ...workspaceAlias(),
      /**
       * ★ electron 换成一个桩，而不是标成 external。
       *
       * `PersonaService` → `media.service.ts` → `import { dialog } from "electron"`。
       * 标 external 时 esbuild 保留那个**具名** import，而 electron 是 CJS ——
       * 纯 node 里 `import { dialog }` 直接 SyntaxError（脚本根本起不来）。
       *
       * 这条路径不会碰 dialog（不导出媒体、不弹框），所以给个空对象即可。
       * 注意：**不能**因此认为"electron 相关代码被验过了" —— 它只是没被走到。
       */
      electron: join(root, "scripts/lib/electron-stub.mjs"),
    },
    logLevel: "silent",
  })

  const { runPersonaAcpCheck } = await import(`file://${outFile}`)
  const report = await runPersonaAcpCheck({
    dbPath: dbCopy,
    workspaceRoot,
    skillsDir: join(root, "apps/desktop/resources/skills"),
    forgeSkillRoot: found.forgeSkillRoot,
    klRoot: join(root, "kl-graph"),
    klPort: 8200,
    agentHome: found.agentHome,
    baseUrl: env["MYCONTEXT_LLM_BASE_URL"] ?? "",
    apiKey: env["MYCONTEXT_LLM_API_KEY"] ?? "",
    model: env["MYCONTEXT_MODEL_MAIN"] ?? "qwen3.7-plus",
    conversationId: arg("--conv", ""),
    question: arg("--ask", "你最喜欢哪个歌手"),
    env,
  })

  console.log(`会话：${report.conversation.title ?? report.conversation.id}`)
  console.log(`问题：${report.question}`)
  console.log("")
  console.log(`ACP 可用：${String(report.acpAvailable)}`)
  console.log(`走的路径：${report.via.join(", ") || "(没生成)"}`)
  console.log("")
  console.log("AGENTS.md 的工具声明：")
  console.log(`  明说能查 kl 图谱：${String(report.entryDeclaresKl)}`)
  console.log(`  仍在说"唯一可用的工具"：${String(report.entryStillLiesAboutTools)}`)
  console.log("")
  console.log("落库的 run：")
  for (const run of report.runs) {
    console.log(
      `  ${run.decision} · ${run.decisionReason ?? "-"}${run.error ? ` · ${run.error}` : ""}`,
    )
  }
  console.log("")
  console.log("落库的草稿（最近 3 条，含本次之前的）：")
  for (const draft of report.drafts) {
    console.log(`  ${JSON.stringify(draft.text)}`)
    if (draft.notSentReason) console.log(`    原因：${draft.notSentReason}`)
  }
  console.log("")
  console.log("★ 本次新产出的那条：")
  console.log(`  ${report.newDraft === null ? "(没有)" : JSON.stringify(report.newDraft.text)}`)
  if (report.newDraft?.notSentReason) console.log(`    原因：${report.newDraft.notSentReason}`)

  /**
   * ★ 判据在这里，而且**跑不起来也算失败**。
   *
   * 「没报错」不是判据：这条链路最可能的失效是"成功返回但内容不对"。
   *
   * ★★ 只断言 `newDraft`，**不**断言 `drafts` —— 后者含修复之前落库的
   * 坏草稿（库里那两条半截 JSON），拿它们断言会让这个探针永远红着，
   * 而"永远红的门禁"和没有门禁一样会被忽略。
   */
  const failures = []
  if (!report.acpAvailable) failures.push("ACP 不可用 —— 这一轮什么都没验到（装 opencode 再来）")
  if (report.via.length === 0) failures.push("一条草稿都没生成（准入闸拒了？看 run）")
  else if (!report.via.includes("acp")) {
    failures.push(`走的是 ${report.via.join("/")} 而不是 acp —— 验的不是要验的那条路`)
  }
  if (report.entryStillLiesAboutTools)
    failures.push('AGENTS.md 仍在说"唯一可用的工具"（谎报能力没修掉）')
  if (!report.entryDeclaresKl) failures.push("AGENTS.md 没提 kl 图谱查询（tools:agent 没生效）")
  if (report.newDraft === null) failures.push("本次没有产出草稿（按 trigger 关联取不到）")
  else {
    const text = report.newDraft.text
    // 半截 JSON / 整段信封都不该出现在正文里
    if (text.includes('"reply"') || text.includes("holdForReview")) {
      failures.push(
        `本次草稿正文里有协议字段（截断或信封泄漏）：${JSON.stringify(text.slice(0, 60))}`,
      )
    }
    if (text.trim() === "") failures.push("本次草稿正文是空的")
  }

  console.log("")
  if (failures.length > 0) {
    console.error("✗ 端到端断言失败：")
    for (const failure of failures) console.error(`  · ${failure}`)
    process.exit(1)
  }
  console.log("✓ 生产路径（ACP）跑通：走的是 acp、工具声明如实、草稿正文里没有协议字段")
} finally {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(copyDir, { recursive: true, force: true })
  rmSync(workspaceRoot, { recursive: true, force: true })
}
