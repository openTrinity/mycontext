/**
 * vendor 完整性校验（脚本与门禁共用）。
 *
 * 为什么需要：21MB 二进制的 `git diff` 不可读 —— 有人把它换成带后门的版本，
 * code review 看不出来。SHA256SUMS 让「二进制变了」这件事在 diff 里**可见**，
 * 而这个校验让它在门禁里**可拦**。
 *
 * forge 是**源码**而不是二进制，diff 本身可读，但它同样需要校验：
 * 它是随包分发的第三方代码，且会被 spawn 执行。一次「顺手改一行 vendor 里的
 * Python」在 review 里跟上游升级长得一样，而 hash 让两者可区分。
 *
 * SHA256SUMS 的格式与 `shasum -a 256` 输出一致：`<hash>  <相对仓库根的路径>`。
 * 升级任一 vendor 时必须同批更新它（见各自目录的 README 升级步骤）。
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 每个 vendor 各自一份 SHA256SUMS。
 *
 * 不合并成一份：各 vendor 的升级节奏与来源独立，合并会让升级其中一个时
 * 另一个的 hash 也出现在 diff 里，「哪个变了」反而看不出来。
 *
 * ★ dws 不在这张表里：它已改为**不入 git**（开源版走 npm 依赖、闭源版由
 * `MYCONTEXT_DWS_SOURCE` 指本机路径，见 vendor/dws/README.md）。
 * 开源版那份的完整性由 npm 包内 `assets/checksums.txt` 在解包前校验
 * （`scripts/lib/dws-resolver.mjs`），比我们自己维护一份 hash 更贴近上游。
 */
const SUMS_FILES = ["vendor/forge/SHA256SUMS"]

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/**
 * @param {string} root 仓库根的绝对路径
 * @param {string[]} [sumsFiles] 只校验其中几份（缺省全部）
 * @returns {{ ok: boolean, issues: string[], checked: number }}
 */
export function verifyVendorIntegrity(root, sumsFiles = SUMS_FILES) {
  const issues = []
  let checked = 0

  for (const sumsFile of sumsFiles) {
    const sumsPath = join(root, sumsFile)
    if (!existsSync(sumsPath)) {
      issues.push(`缺少 ${sumsFile}`)
      continue
    }

    for (const line of readFileSync(sumsPath, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (trimmed === "") continue
      // shasum 输出是 `<hash>  <path>`（两个空格）；容忍单空格与 `*` 前缀（二进制模式）。
      const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(trimmed)
      if (match === null) {
        issues.push(`${sumsFile}：无法解析的行 ${trimmed.slice(0, 80)}`)
        continue
      }
      const [, expected, relPath] = match
      const full = join(root, relPath)
      if (!existsSync(full)) {
        issues.push(`文件缺失：${relPath}`)
        continue
      }
      const actual = sha256(full)
      checked += 1
      if (actual !== expected.toLowerCase()) {
        issues.push(`hash 不一致：${relPath}\n      期望 ${expected}\n      实际 ${actual}`)
      }
    }
  }

  return { ok: issues.length === 0, issues, checked }
}

/**
 * ★ 反向校验：文件在盘上但**不在** SHA256SUMS 里 —— 校验会「通过」。
 *
 * 正向逐行比对拦不住新增文件：往 vendor/forge/forge/ 里塞一个
 * `evil.py` 而不更新 SHA256SUMS，上面那个循环压根不会看它一眼，
 * 于是「完整性校验通过」这句话就成了假保证。而 forge 是会被 spawn 执行的源码，
 * 多一个模块就足以改变行为（Python 的 import 不需要它出现在任何清单里）。
 */
export function findUnlistedFiles(root, dir, sumsFile, { readdirSync, statSync }) {
  const listed = new Set()
  const sumsPath = join(root, sumsFile)
  if (existsSync(sumsPath)) {
    for (const line of readFileSync(sumsPath, "utf8").split("\n")) {
      const match = /^[0-9a-f]{64}\s+\*?(.+)$/i.exec(line.trim())
      if (match !== null) listed.add(match[1])
    }
  }

  const unlisted = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      const rel = full.slice(root.length + 1)
      // SHA256SUMS 自己不可能列出自己的 hash。
      if (rel === sumsFile) continue
      if (!listed.has(rel)) unlisted.push(rel)
    }
  }
  walk(join(root, dir))
  return unlisted
}

export { SUMS_FILES }
