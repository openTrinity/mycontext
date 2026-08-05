#!/usr/bin/env node
/**
 * 采集完整性对账：**探针说有更新、而我们库里没有**的那些会话。
 *
 * ## 为什么这个探针必须存在
 *
 * 时间窗那套（水位 + 2 分钟重叠 + 5 分钟前探）在"消息按时到达"时是对的，
 * 但服务端延迟超过重叠窗时那段已经被水位推过去了 —— 固定窗口**再也不会
 * 覆盖它**，而界面上没有任何迹象（状态 idle、无错误）。
 *
 * 也就是说漏采的**表现与一切正常完全相同**。唯一能发现它的办法是拿
 * 「探针看到的每会话最新时间」与「我们库里该会话最新时间」逐个比 ——
 * 那正是这个脚本做的事。
 *
 * 实测这台机器（92 个会话）跑出 10 个落后，最严重 559 分钟，
 * 3 个会话我们一条消息都没有。
 *
 * ## ★ 只读：跑在 vault 的**副本**上
 *
 * 它自己拷一份到 /tmp，绝不碰真库（连 -wal 一起拷，否则会丢掉
 * 还没 checkpoint 的最近消息 —— 而"最近"恰好是这个脚本要看的）。
 *
 * ```bash
 * node scripts/check-ingest-gap.mjs            # 报告
 * node scripts/check-ingest-gap.mjs --assert   # 有落后就 exit 1（门禁用）
 * ```
 *
 * `--assert` 默认容忍 0 个落后会话。日常库里本来就有历史欠账时，
 * 用 `--max-stale N` 把基线固定住，让**新增**的落后能被看见。
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const assertMode = args.includes("--assert")
const maxStale = (() => {
  const index = args.indexOf("--max-stale")
  return index === -1 ? 0 : Number(args[index + 1] ?? 0)
})()

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

/**
 * 找 vault。
 *
 * ★ **取最近改动的那个**，不是"第一个找到的"。
 *
 * 这台机器上有两个 vault（旧的那个停在 7-30）。取第一个的话报告会基于
 * 一个早就不用的库 —— 而那种错误是静默的：数字看起来合理，只是与用户
 * 现在在用的那个账号无关。判据用 mtime：正在采集的库一直在写。
 */
function findVault() {
  const appSupport = join(homedir(), "Library", "Application Support")
  const candidates = []
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
      if (!existsSync(db)) continue
      // -wal 比主文件更能反映"刚刚还在写"（WAL 模式下主文件可能很久不动）
      const wal = `${db}-wal`
      const mtime = Math.max(statSync(db).mtimeMs, existsSync(wal) ? statSync(wal).mtimeMs : 0)
      candidates.push({ db, mtime })
    }
  }
  if (candidates.length === 0) throw new Error("没找到 vault（先登录应用并采集一次）")
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].db
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-ingestgap-"))
const outFile = join(outDir, "check.mjs")
const copyDir = mkdtempSync(join(tmpdir(), "mycontext-ingestgap-vault-"))

try {
  await build({
    entryPoints: [join(root, "scripts/check-ingest-gap-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const source = findVault()
  const dbCopy = join(copyDir, "core.sqlite")
  copyFileSync(source, dbCopy)
  // ★ 连 -wal 一起：只拷主文件会丢掉最近的消息，而"最近"正是判据
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${dbCopy}${suffix}`)
  }

  const { runIngestGapCheck } = await import(`file://${outFile}`)
  const report = runIngestGapCheck({ dbPath: dbCopy, channelId: "dingtalk" })

  const fmt = (ms) => (ms === null ? "（库里一条都没有）" : new Date(ms).toLocaleString("sv"))
  console.log(`水位：${fmt(report.watermark)}`)
  console.log(`探针有记录的会话：${String(report.probedConversations)}`)
  console.log(`★ 探针说有更新、我们库里没有的：${String(report.stale.length)}`)
  console.log("")
  for (const item of report.stale) {
    const lag =
      item.oursLastMsgAt === null
        ? "∞"
        : `${String(Math.round((item.probeLastMsgAt - item.oursLastMsgAt) / 60_000))} 分钟`
    console.log(`  探针 ${fmt(item.probeLastMsgAt)}  我们 ${fmt(item.oursLastMsgAt)}  落后 ${lag}`)
  }

  if (report.stale.length > 0) {
    console.log("")
    console.log("这些会话的消息都早于水位 —— 固定窗口不会再覆盖它们，")
    console.log("要靠定向补采（IngestService 的对账那一步）才追得回来。")
  }

  if (!assertMode) process.exit(0)

  if (report.stale.length > maxStale) {
    console.error("")
    console.error(`✗ 落后会话 ${String(report.stale.length)} 个，超过基线 ${String(maxStale)}`)
    /**
     * 「跑不起来/断言不成立必须 exit 1」—— 静默 exit 0 的门禁比没有门禁更糟，
     * 因为它给出的是"已验证"的假信号。
     */
    process.exit(1)
  }
  console.log("")
  console.log(`✓ 落后会话 ${String(report.stale.length)} 个，未超过基线 ${String(maxStale)}`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(copyDir, { recursive: true, force: true })
}
