#!/usr/bin/env node
/**
 * 清掉**已经存下来的**越界语料（超出用户在引导里勾选的范围的那些）。
 *
 * ## 为什么需要这个脚本（只修前向路径不够）
 *
 * 范围闸（`IngestService.persist` / `refreshConversation` 里那两道）只保证
 * "从现在起不再采越界的"。而实测这台机器**已经**存了 46,415 条越界消息
 * （84,325 条里的 55%）与 46,365 行越界 FTS 索引 —— 只修前向等于把已经
 * 发生的那次违规永久留在盘上。按 CLAUDE.md 第 5 节这是隐私问题。
 *
 * 用户在应用里改勾选时走的是同一段代码（`IngestService.applyScopeChange`），
 * 这个脚本是给"修复上线之前就已经跑了很久的库"用的一次性入口。
 *
 * ## ★★ 默认只**预演**（不删）
 *
 * 删真实聊天记录不可逆。所以默认打印将要删什么，`--apply` 才真删。
 * 判据与产品运行时同一份代码（见 entry），不是抄的。
 *
 * ```bash
 * node scripts/purge-scope.mjs              # 预演：只报数
 * node scripts/purge-scope.mjs --apply      # 真删（会先备份）
 * ```
 *
 * ## ★ `--apply` 会先整库备份
 *
 * 备份到 `<vault>/../core.sqlite.bak-<时间戳>`。判断"删对了没有"这件事
 * 只能事后做，而那时原始数据已经没了 —— 所以备份不是可选项。
 * 备份**留在原地不自动删**：它含真实聊天内容，该由用户自己决定何时清。
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const apply = args.includes("--apply")

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

/**
 * 找 vault：取**最近改动**的那个（与 check-ingest-gap.mjs 同一个理由 ——
 * 这台机器上有多个 vault，取第一个会静默地操作一个早就不用的库）。
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
      const wal = `${db}-wal`
      const mtime = Math.max(statSync(db).mtimeMs, existsSync(wal) ? statSync(wal).mtimeMs : 0)
      candidates.push({ db, mtime })
    }
  }
  if (candidates.length === 0) throw new Error("没找到 vault（先登录应用并采集一次）")
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].db
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-purge-"))
const outFile = join(outDir, "purge.mjs")
/** 预演跑在副本上，`--apply` 跑在真库上 —— 见下。 */
const copyDir = mkdtempSync(join(tmpdir(), "mycontext-purge-vault-"))

try {
  await build({
    entryPoints: [join(root, "scripts/purge-scope-entry.ts")],
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
  const { runScopePurge } = await import(`file://${outFile}`)

  /**
   * 预演在**副本**上跑（连 -wal 一起拷，否则会漏掉还没 checkpoint 的
   * 最近消息 —— 而那部分恰好是"现在还在漏吗"的答案）。
   * `--apply` 必须在真库上跑，但先整库备份。
   */
  let target = source
  if (!apply) {
    target = join(copyDir, "core.sqlite")
    copyFileSync(source, target)
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${target}${suffix}`)
    }
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backup = join(dirname(source), `core.sqlite.bak-${stamp}`)
    copyFileSync(source, backup)
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${backup}${suffix}`)
    }
    console.log(`备份：${backup}`)
    console.log("（含真实聊天内容 —— 确认清理无误后请自行删除）")
    console.log("")
  }

  const report = runScopePurge({ dbPath: target, channelId: "dingtalk", dryRun: !apply })

  if (!report.restricted) {
    console.log("用户没配采集范围（或库里没有 chat 源）—— 此时「越界」没有定义，什么都不删。")
    process.exit(0)
  }

  const pct =
    report.totalBefore === 0 ? 0 : Math.round((report.messages / report.totalBefore) * 100)
  console.log(`勾选的会话：${String(report.allowed)}`)
  console.log(
    `时间下界：${report.since === null ? "不限" : new Date(report.since).toLocaleString("sv")}`,
  )
  console.log(`库里会话目录：${String(report.conversationsInDirectory)}（目录保留，不受范围限制）`)
  console.log("")
  console.log(`消息总数：${String(report.totalBefore)}`)
  console.log(
    `★ 越界消息：${String(report.messages)}（${String(pct)}%），分布在 ${String(report.conversations)} 个会话`,
  )
  console.log(`  连带 FTS 索引行：${String(report.ftsRows)}`)
  console.log(`  连带向量行：${String(report.vectors)}`)
  console.log(
    `  连带媒体元数据：${String(report.mediaAssets)}（已下字节 ${String(report.mediaPaths.length)}）`,
  )

  if (!apply) {
    console.log("")
    console.log("以上是**预演**（跑在副本上，真库没动）。确认无误后：")
    console.log("  node scripts/purge-scope.mjs --apply")
    process.exit(0)
  }

  /**
   * 媒体**字节**在这里删（store 层不碰文件系统，见 `PurgeReport.mediaPaths`）。
   * 逐个 catch：漏删只留下孤儿文件（可观测、可再清），而让整个清理因为
   * 一个文件删不掉而失败会把库留在"消息删了、报告没打出来"的状态。
   */
  let removedFiles = 0
  for (const path of report.mediaPaths) {
    try {
      unlinkSync(path)
      removedFiles += 1
    } catch {
      /* 孤儿文件不值得让整轮清理失败 */
    }
  }
  console.log("")
  console.log(`✓ 已删除 ${String(report.messages)} 条越界消息、${String(removedFiles)} 个媒体文件`)
  console.log("")
  console.log("接下来（让派生物跟上）：")
  console.log("· 重启应用 —— 导出与建图会按新范围重跑；")
  console.log("· 或在应用里重新保存一次采集范围，那会触发同一条对账链。")
} finally {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(copyDir, { recursive: true, force: true })
}
