#!/usr/bin/env node
/**
 * 门禁：vendor/ 内的文件与各自的 SHA256SUMS 一致。
 *
 * 21MB 二进制的 `git diff` 不可读 —— 有人把它换成带后门的版本，
 * code review **看不出来**。这条门禁让「二进制被替换」在 CI 里被发现，
 * 而不是靠 review 时肉眼看 diff。
 *
 * forge 是源码，diff 可读，但它同样受管：那是随包分发、且**会被 spawn 执行**的
 * 第三方代码。「有人顺手改了 vendor 里一行 Python」与「上游升级」在 diff 里
 * 长得一样，hash 让两者可区分。
 *
 * 升级任一 vendor 时必须同批更新 SHA256SUMS —— 这就是让「vendor 变了」可见的方式。
 */
import { readdirSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { findUnlistedFiles, verifyVendorIntegrity, SUMS_FILES } from "./lib/vendor-integrity.mjs"

const root = resolve(import.meta.dirname, "..")
const result = verifyVendorIntegrity(root)

/**
 * ★ 未登记的文件也要拦。
 *
 * 逐行比对只证明「清单里的文件没变」，不证明「盘上没有清单外的文件」。
 * 往 vendor/forge/forge/ 里加一个模块而不更新 SHA256SUMS，正向校验会
 * 一路绿灯 —— 而 Python 的 import 不要求那个文件出现在任何清单里。
 *
 * 只对 forge 做：dws 那边是单个二进制加上游随包的 workspace/，
 * 多一个文件不改变行为，而 forge 是被执行的源码树。
 */
const unlisted = findUnlistedFiles(root, "vendor/forge", "vendor/forge/SHA256SUMS", {
  readdirSync,
  statSync,
})

if (!result.ok || unlisted.length > 0) {
  console.error(`vendor 完整性校验未通过（${SUMS_FILES.join("、")}）：`)
  for (const issue of result.issues) console.error(`  - ${issue}`)
  for (const path of unlisted) {
    console.error(`  - 未登记：${path}（在盘上但不在 SHA256SUMS 里）`)
  }
  console.error("\n若是有意升级，请重算 hash（见 vendor/<name>/README.md 的升级步骤）")
  process.exit(1)
}

console.log(`vendor 完整性校验通过：${result.checked} 个文件 hash 一致`)
