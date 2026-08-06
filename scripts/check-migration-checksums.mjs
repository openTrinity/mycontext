#!/usr/bin/env node
/**
 * 门禁：已发布迁移的 **schema** 不可被改动。
 *
 * ## 为什么是「schema」而不是「SQL 原文」
 *
 * 原来的判据是 `sha256(整个 SQL 模板字符串)`，它把 SQL 里的 `--` 注释也算进去，
 * 于是**改注释就等于改迁移** —— 每个已迁移的 vault 启动即 `DB_MIGRATION_FAILED`，
 * 应用直接起不来。这个形态发生过两次：
 *
 * · v9 的注释里加了个 `'model'`（步骤列表）；
 * · v2 的注释里有一行示例姓名，被一次全仓脱敏 sweep 换成了化名。
 *
 * 第一次靠把注释还原成 byte-identical 修掉了。第二次那条路**无解**：v2 在历史上
 * 有三个原文变体（本机不同 vault 各记一个），三者互斥，还原任一版都会打挂另外
 * 两个，而且其中两版含真实姓名 —— 脱敏正是为了去掉它们。
 *
 * 所以判据改成了「剥掉注释后的 SQL」（见 `packages/store/src/migration-checksum.ts`）。
 * 这个门禁守的就是那个改动的前提：**注释变了、schema 没变**这件事在全历史成立。
 *
 * ## 它断言什么
 *
 * ① **全历史**：同一个 SQL 常量的所有历史变体，语义 checksum 必须相同。
 *    非空 = 有人真的改过已发布迁移的 schema —— 那是判据放行不了的，必须人工看。
 * ② **登记表**：`legacyChecksums` 每一项，若能在历史里找到产出它的那一版，
 *    那一版必须与当前 SQL 同 schema（找到了但 schema 不同 = 硬失败：那等于给
 *    某个版本单独关掉校验）。**找不到不算失败** —— 本仓是压成单 commit 发布的，
 *    压平之前的历史变体的 blob 不在本仓 `rev-list --all` 里，「找不到」是发布方式
 *    的必然，不代表 schema 被改过；这一档的真正兜底是 ④（本机 vault 对账）。
 * ③ **剥注释没写坏**：剥完不该变空，不同迁移不该撞出同一个 checksum。
 *    这两种形态都不报错，只是让整道校验失效。
 * ④ **本机 vault 对账**：逐条归因，出现无法归因的就红。
 *
 * ## ★ 为什么逻辑在 `-entry.ts` 里
 *
 * 因为要 import **真正发布的** `schemaChecksum`。写这个门禁的过程中，
 * 脚本里那份复制品与实现漂移过一次（规范化改了、复制品没跟上），
 * 于是它算出的值全不一样 —— 而门禁照样报绿。门禁拿副本比对 = 门禁在测副本。
 */
import { createRequire } from "node:module"
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

/**
 * 要找的 userData 目录名 —— 含**改名前**的旧名。
 *
 * 与 `check-no-local-data.mjs` 同一份清单、同一个理由：盘上的老目录是 rebrand
 * 之前跑出来的，删掉旧名会让门禁再也找不到本机的库，然后静默报绿。
 * （那次事故的完整记录见 check-no-local-data.mjs 里 APP_DIR_NAMES 的注释。）
 */
const APP_DIR_NAMES = [
  "MyContextDevelop",
  "MyContextDev",
  "MyContext",
  "InklingsDevelop",
  "InklingsDev",
  "Inklings",
]

function findAllVaults() {
  const appSupport = join(homedir(), "Library", "Application Support")
  const found = []
  for (const appDir of APP_DIR_NAMES) {
    const vaultsDir = join(appSupport, appDir, "vaults")
    if (!existsSync(vaultsDir)) continue
    for (const entry of readdirSync(vaultsDir)) {
      const candidate = join(vaultsDir, entry, "core.sqlite")
      if (existsSync(candidate) && statSync(candidate).size > 0) {
        found.push({ appDir, vaultId: entry, path: candidate })
      }
    }
  }
  return found
}

const vaultPaths = findAllVaults()

/**
 * ★ 有 vault 但打不开 = **这台机器上门禁失效**，必须让人看见。
 *
 * 「没有 vault」跳过那半是对的（同事机器上没登录过，无从对账），
 * 但历史扫描那半照跑 —— 它不依赖本机数据，在 CI 上也该是有效的。
 * 而 ABI 不匹配（刚跑过 `pnpm dev`）时打一行"跳过"就 exit 0，
 * 恰好会在最该工作的时刻静默失效。
 */
let Database = null
if (vaultPaths.length > 0) {
  try {
    Database = require("better-sqlite3")
  } catch (error) {
    console.error(
      "✗ 迁移 checksum 门禁**没能完整跑起来**：加载 better-sqlite3 失败" +
        `（${error instanceof Error ? error.message.slice(0, 80) : "unknown"}）\n` +
        "  本机有 vault，所以这不能当作通过 —— 先跑 `node scripts/rebuild-node.mjs`。",
    )
    process.exit(1)
  }
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-migcheck-"))
const outFile = join(outDir, "check.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/check-migration-checksums-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runMigrationChecksumCheck } = await import(`file://${outFile}`)
  const report = runMigrationChecksumCheck({
    repoRoot: root,
    vaultPaths: Database === null ? [] : vaultPaths,
    openDatabase: (path) => {
      const db = new Database(path, { readonly: true })
      return {
        all: (sql) => db.prepare(sql).all(),
        close: () => db.close(),
      }
    },
  })

  let failed = false

  console.log(`历史扫描：${report.historyBlobCount} 个 blob / ${report.constCount} 个 SQL 常量`)
  for (const finding of report.commentOnlyDrift) {
    console.log(
      `  · ${finding.constName}：${finding.variants.length} 个原文变体，语义一致` +
        `（${finding.variants[0].schema}）`,
    )
  }
  if (report.semanticDrift.length > 0) {
    failed = true
    console.error("\n✗ 有已发布迁移的 **schema** 被改过（不是注释）：")
    for (const finding of report.semanticDrift) {
      console.error(`  ${finding.constName}`)
      for (const variant of finding.variants) {
        console.error(`    raw=${variant.raw}  schema=${variant.schema}`)
      }
    }
    console.error(
      "  已发布的迁移不可修改 —— 请把它还原，改动写成新的迁移版本。\n" +
        "  （若这是一条从未进过任何库的新迁移，那就不该有多个历史变体，先确认。）",
    )
  }

  console.log(`\n登记表核对：${report.legacy.length} 项`)
  /**
   * ★ legacy 值的判定分三档，而不是原来的「找不到就红」。
   *
   * 起因：本仓是**压成单 commit 发布**的（源在别处，历史不随包公开）。
   * 而 legacyChecksums 里登记的旧值，是**压平之前**那些「只改注释、schema
   * 没变」的历史变体 —— 产出它们的那一版迁移文件的 blob 已经不在本仓的
   * `git rev-list --all` 里了。于是「在历史里找到产出它的那一版」这个前提
   * 在快照仓里**永远不成立**，而它本身不代表任何 schema 被改过。
   *
   * 为什么降级是安全的：② 的「找不到就红」只是双保险。legacy 值真正被**用到**
   * 的地方是 ④（本机 vault 对账）—— 一个 schema 真不同的 legacy 值会在那里
   * 让某个版本的漂移变成「已登记」而放行，而 ④ 在任何有该 vault 的机器上照跑、
   * 照红。所以这里把「找不到」降为**告警不失败**，并不放掉真正的保护；
   * 真正危险的一档（历史里**找到了**、但 schema 与当前不同）仍然硬失败。
   *
   * 而且这是**自愈**的：等 mycontext 自己攒出历史、某个 legacy 值的产出版本
   * 重新出现在 `rev-list --all` 里，它就自动回到「找到 → 核对 schema」这条路。
   * 前向保护由 ①（全历史 semantic-drift）承担，它在快照仓里照样有效。
   */
  for (const item of report.legacy) {
    if (item.foundSchema === null) {
      // 快照仓：产出它的那一版已随历史压平被丢弃 —— 无法用历史核对，不失败。
      console.log(
        `  ⚠ v${item.version} ${item.name} ${item.legacy} — ` +
          "历史里没有产出它的那一版（快照发布，历史已压平），改由 vault 对账（④）兜底",
      )
      continue
    }
    const ok = item.foundSchema === item.currentSchema
    if (!ok) failed = true
    console.log(
      `  ${ok ? "✓" : "✗"} v${item.version} ${item.name} ${item.legacy} — ` +
        `schema=${item.foundSchema}（当前 ${item.currentSchema}）`,
    )
  }
  if (
    report.legacy.some(
      (item) => item.foundSchema !== null && item.foundSchema !== item.currentSchema,
    )
  ) {
    console.error(
      "  legacyChecksums 只能登记**已确认与当前 SQL 同 schema**的旧值；\n" +
        "  登记一个 schema 不同的值等于给这个版本单独关掉校验。",
    )
  }

  if (report.emptyAfterStrip.length > 0) {
    failed = true
    console.error(
      `\n✗ 这些迁移剥掉注释后不含任何 SQL 语句：v${report.emptyAfterStrip.join(", v")}\n` +
        "  说明剥注释的实现把 SQL 本身吃掉了 —— 那会让所有迁移算出同一个 checksum。",
    )
  }
  if (report.collisions.length > 0) {
    failed = true
    console.error("\n✗ 不同迁移撞出了同一个语义 checksum：")
    for (const item of report.collisions) {
      console.error(`  v${item.a} 与 v${item.b} 都是 ${item.checksum}`)
    }
    console.error("  说明规范化过度，把语义不同的 SQL 折成了同一个值。")
  }

  if (report.vaults.length === 0) {
    console.log("\n本机 vault 对账：跳过（没有 vault，未登录过应用）")
  } else {
    console.log(`\n本机 vault 对账：${report.vaults.length} 个库`)
    let sawUnknown = false
    for (const vault of report.vaults) {
      if (vault.unreadable !== null) {
        failed = true
        console.error(`  ✗ ${vault.appDir}/${vault.vaultId} 读不到：${vault.unreadable}`)
        continue
      }
      if (vault.foreignManifest) {
        console.log(
          `  – ${vault.appDir}/${vault.vaultId} max=v${vault.maxVersion}` +
            "  属于另一套迁移清单（版本名对不上），跳过对账",
        )
        continue
      }
      const unknown = vault.drifts.filter((item) => item.verdict === "unknown")
      const pending = vault.drifts.filter((item) => item.verdict !== "unknown")
      const mark = unknown.length === 0 ? "✓" : "✗"
      /**
       * 待收敛的条数只报数字，不逐条列。
       *
       * 一个刚建的库会有 21 条待收敛（判据变更前写入的原文 checksum），
       * 逐条打印 5 个库就是 100 行 —— 而门禁一噪就会被整体忽略，
       * 那比少打印几行糟得多。无法归因的才逐条列：那是真的要人处理的。
       */
      console.log(
        `  ${mark} ${vault.appDir}/${vault.vaultId} max=v${vault.maxVersion}` +
          `  待收敛 ${pending.length} 条（下次启动自动收敛），无法归因 ${unknown.length} 条`,
      )
      for (const item of unknown) {
        failed = true
        sawUnknown = true
        console.error(`      ✗ v${item.version} ${item.name} 记的是 ${item.recorded}`)
      }
    }
    if (sawUnknown) {
      console.error(
        "  「无法归因」= 这个 checksum 既不是当前值、也不在登记表里、也算不出来源。\n" +
          "  它可能是一次真的 schema 改动，也可能是一个漏登记的历史变体 ——\n" +
          "  用 `git rev-list --objects --all -- packages/store/src/migrations` 找出\n" +
          "  产出它的那一版，确认 schema 一致后再登记进 legacyChecksums。",
      )
    }
  }

  if (failed) {
    console.error("\n✗ 迁移 checksum 门禁未通过")
    process.exitCode = 1
  } else {
    console.log("\n✓ 已发布迁移的 schema 未被改动")
  }
} catch (error) {
  /**
   * ★ 门禁自己崩了也必须红。
   *
   * 「跑不起来」与「通过」是两件事，而把异常吞掉打一行提示再 exit 0
   * 会让前者伪装成后者 —— 这个仓库已经为此付过一次代价。
   */
  console.error(
    `✗ 迁移 checksum 门禁**没能跑起来**：${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
