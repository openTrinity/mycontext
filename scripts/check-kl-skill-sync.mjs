#!/usr/bin/env node
/**
 * 门禁：随包分发的 kl skill 与 `kl-graph/` 里的源一致 —— **净化之后**一致。
 *
 * 「同步过了」与「忘了同步」**外观完全相同** —— agent 照常工作，
 * 只是用的是三个月前的命令说明（而那些命令可能已经改了参数）。
 * 有同步脚本而无漂移门禁，与 check-docs-tracked 是同一类静默失败。
 *
 * `kl-graph/` 不存在时**跳过而不失败**：E 阶段之前它本来就没有，
 * 而门禁在那个阶段红了只会教人忽略它。
 *
 * ## ★★ 为什么比的是"净化后"而不是原文
 *
 * `sync:kl-skill` 不是纯拷贝 —— 它把上游示例里的真实同事姓名换成化名、
 * 把一处第三方产品商标换成中性表述（理由见 `lib/kl-skill-sanitize.mjs`）。
 * 于是产物与源**必然**逐字节不同。
 *
 * 拿原文比的话这个门禁**永远红**，而错误信息会说"请运行 pnpm sync:kl-skill" ——
 * 跑了也还是红。那种门禁的下场是被加进忽略列表，连带真的漂移也不再有人看。
 * （这正是「跑不起来的门禁比失败的门禁更糟」那条的另一面：
 *  一个恒红的门禁与一个恒绿的门禁一样没有信息量。）
 *
 * 所以判据是：**把源按同一套映射脱敏，再与产物比**。
 * 于是三件事同时被锁住：
 *   ① 上游内容变了没同步 → 红（原来就有的能力，保留）；
 *   ② 产物里**残留真名**（脱敏漏了/有人手改了产物）→ 红（新增，见下）；
 *   ③ 有人改了映射但没重跑同步 → 红（因为脱敏后的源变了）。
 *
 * ## ★ ② 那一条是独立的判据，不能靠现成的两道门禁
 *
 * · `check:no-local-data` 有 `MIN_LENGTH = 4`（避免两三个字的误报），
 *   而中文姓名是**三个字** —— 这四个名字从来不在它的比对集里。
 *   也就是说：**它对姓名这件事完全沉默**。
 * · `check:trademarks` 确实会拦商标（它就是这么发现那句话的），
 *   但它给出的建议是"删掉那几个词"，而这里要的是**换成中性表述并保留段落**
 *   —— 那段讲的 Windows bash 语法对我们同样成立。
 *
 * 所以残留检查放在这里，且它比"指纹不一致"更严重：
 * 指纹不一致意味着"发出去的是旧版"，残留真名意味着"发出去的带着同事的名字"。
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { findResidual, sanitize } from "./lib/kl-skill-sanitize.mjs"

const root = resolve(import.meta.dirname, "..")
/**
 * ★ 源是 `kl-graph/skills/kl`，**不是** `kl-graph/.claude/skills/kl`。
 *
 * 上游把 SKILL.md 从 `.claude/skills/kl` 搬到了 `skills/kl`（`74dea06`：
 * id 寻址 /entity+/facts、废弃 /expand、新增 `kl global-search`）。
 * 而 `.claude/` 在本仓库的 `.gitignore` 里 —— 那份旧的 499 行副本
 * **未被 git 跟踪**、停在搬家前的 `772303e`，`sync:kl-graph` 再也不会更新它。
 *
 * 门禁原来盯着那个 gitignore 掉的旧副本，于是它拿"停更的旧源"与"停更的旧产物"
 * 对比、恒绿；而 agent 真正装的是那份 499 行旧 skill，压根不知道
 * `global-search` 存在 —— 「接上新功能」在文档这一层是断的。
 * 这正是「门禁跳过比门禁失败更糟」：绿 ≠ 同步，只是盯错了目录。
 */
const source = join(root, "kl-graph/skills/kl")
const target = join(root, "apps/desktop/resources/skills/kl")

if (!existsSync(source)) {
  console.log("kl skill 同步检查跳过：kl-graph 尚未接入")
  process.exit(0)
}

/** 与 sync-kl-skill.mjs 同一条判据（那边只对文本做替换）。 */
const TEXT_EXT = /\.(md|txt|json|yml|yaml|sh|py|ts|js|mjs)$/i

/**
 * 目录内容的指纹：相对路径 + 内容 hash，排序后再 hash。
 *
 * `transform` 让源那侧先过一遍净化 —— 产物那侧传恒等函数。
 * 文本文件按 utf8 读（要做字符串替换），其余按字节。
 */
function fingerprint(dir, transform) {
  const entries = []
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      const rel = relative(dir, full)
      const content = TEXT_EXT.test(name)
        ? Buffer.from(transform(readFileSync(full, "utf8")), "utf8")
        : readFileSync(full)
      entries.push(`${rel}:${createHash("sha256").update(content).digest("hex")}`)
    }
  }
  walk(dir)
  return {
    digest: createHash("sha256").update(entries.join("\n")).digest("hex"),
    count: entries.length,
  }
}

/** 产物里残留的真名/商标。返回 `[相对路径, 类别数组]`，不回显真名本身。 */
function leaks(dir) {
  const found = []
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!TEXT_EXT.test(name)) continue
      const hits = findResidual(readFileSync(full, "utf8"))
      if (hits.length > 0) {
        found.push([relative(dir, full), [...new Set(hits.map((h) => h.kind))]])
      }
    }
  }
  walk(dir)
  return found
}

if (!existsSync(target)) {
  console.error(`kl skill 未同步到随包资源目录：${target}\n请运行 pnpm sync:kl-skill`)
  process.exit(1)
}

/**
 * ★ 残留检查放在指纹**之前**。
 *
 * 两者都红时，"发出去的带着真名/商标"是更该先看到的那条 ——
 * 而指纹不一致的提示（"请运行 pnpm sync:kl-skill"）会把注意力引向别处。
 */
const residual = leaks(target)
if (residual.length > 0) {
  console.error(
    [
      "✗ 随包分发的 kl skill 里**残留该净化的内容**（会打进 .app 发给用户）：",
      ...residual.map(([rel, kinds]) => `  ${rel}：${kinds.join("、")}`),
      "",
      "  净化在 `pnpm sync:kl-skill` 里做（映射见 scripts/lib/kl-skill-sanitize.mjs）。",
      "  ★ 别去改 kl-graph/ 里的源 —— 那是算法团队的文件，改了会在下次",
      "    `pnpm sync:kl-graph` 合并上游时变成冲突。要加映射就加在那份映射里。",
      "  ★ 注意 check:no-local-data 对姓名是沉默的（它有 4 字下限，而中文名是 3 字）。",
    ].join("\n"),
  )
  process.exit(1)
}

const from = fingerprint(source, sanitize)
const to = fingerprint(target, (text) => text)

if (from.digest !== to.digest) {
  console.error(
    [
      "kl skill 与源不一致（打包出去的会是旧版本，而 agent 不会报错）：",
      `  源（净化后）：${from.count} 个文件 ${from.digest.slice(0, 12)}`,
      `  产物：        ${to.count} 个文件 ${to.digest.slice(0, 12)}`,
      "请运行 pnpm sync:kl-skill",
    ].join("\n"),
  )
  process.exit(1)
}

console.log(`kl skill 同步检查通过：${from.count} 个文件一致（净化后比对，产物无残留）`)
