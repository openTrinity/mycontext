#!/usr/bin/env node
/**
 * 随包分发的 kl skill 的**脱敏 + 去商标**映射，以及"有没有漏"的判据。
 *
 * `sync-kl-skill.mjs`（生产者）与 `check-kl-skill-sync.mjs`（门禁）共用这一份 ——
 * 两处各写一份映射的结局是它们迟早不一致，而那时门禁会**永远红**
 * 且原因指向"忘了同步"（真实原因是两份映射差一个字）。
 *
 * ## 为什么需要这一步
 *
 * `kl-graph/.claude/skills/kl/SKILL.md` 是**算法团队的文件**，我们不改它
 * （改了会在 `pnpm sync:kl-graph` 合并上游时变成冲突，且他们看不到）。
 * 而这份 skill 会通过 `extraResources` **打进 .app 分发给用户**
 * （`apps/desktop/resources/skills/` → `Resources/skills/`），
 * 于是同一段文字换了受众：从"内部文档"变成"随产品外发的内容"。
 *
 * 两类东西必须在这一步换掉，且**只**改我们发出去的那份：
 *
 * ① **真实同事姓名** —— 命令示例里用的是真名（`kl entity "<某同事>"`）；
 * ② **第三方产品商标** —— 上游 7/31 那批新增里有一句
 *    「<那个产品> agents run in bash on Windows」。`check:trademarks`
 *    禁止全仓库出现那几个词，而 `apps/desktop/resources/` 不在它的跳过名单里，
 *    也**不该**在 —— 那正是会外发的目录。
 *
 * ★ ② 不只是合规问题，内容本身也是错的：那句话描述的是**别的宿主 agent**，
 * 而我们这份 skill 跑在我们自己的 agent 里。照抄过去等于告诉模型一件
 * 与它自己的运行环境无关的事。所以换成中性表述而不是删掉整段 ——
 * 那段讲的 Windows bash 语法与 `PYTHONUTF8=1` 对我们同样成立。
 */

/**
 * 真名 → 化名。
 *
 * 与 `fix(privacy)` 那次的映射一致（那次改的是 fixture 与文档）。
 * 新造一套的代价是：同一个人在 fixture 里叫 A、在 skill 里叫 B，
 * 而"这两个是同一个人吗"以后没人答得上来。
 *
 * 加新条目时：真名必须是**确认过的真实同事**，化名必须是**同字数的编造名**
 * （字数变了会让"这是个人名"这件事在文档里读起来变形）。
 *
 * ## ★★ 为什么这份表在"历史已脱敏"之后仍然必须存在
 *
 * 全仓库历史改写把**我们自己**的代码与 commit message 都洗过了，
 * 但 `kl-graph/` 刻意一个字节都没动（那是算法团队的真实历史）。
 * 于是那 3 个真名仍然在 `kl-graph/.claude/skills/kl/SKILL.md` 里 ——
 * 而这份 skill 会被 `sync:kl-skill` 拷进 `apps/desktop/resources/skills/`
 * 并**打进 .app 发给用户**。也就是说：源脏、产物必须干净，落差就靠这张表。
 *
 * ★ 一次真实的自伤（也是这张表最后改用 hash 的原因之一）：
 * 那次历史改写的替换表里有一条「某真名 → 某化名」，而它**也扫过本文件** ——
 * 于是这里原本写成明文的 `<真名>: "<化名>"` 被替换成了
 * `<化名>: "<化名>"`，全部退化成自映射。后果不是报错，而是
 * `check:kl-skill-sync` 把**化名本身**当成"该净化的真名"报残留
 * （产物里确实有 5 处那个化名，而它已经是脱敏后的正确结果了）。
 *
 * 教训有两条：① 脱敏表这类文件自己也会被全局替换扫到，改完必须回头看它；
 * ② 表里**存 hash 而不是明文**之后，这类自伤连发生的余地都没有了 ——
 * 全局替换找不到可匹配的明文。
 */

/**
 * 真名 → 化名，但键存的是**真名的 sha256 前 16 位**，不是真名本身。
 *
 * ## ★★ 为什么不能直接写真名
 *
 * 这个文件会随开源仓库公开。而一张写着「潘某某 → 傅书言」的表，
 * 既泄漏了真名、又把化名与真人对应关系一并交出去 ——
 * 比不脱敏更糟：不脱敏只是漏了名字，这个是漏了名字**加**映射关系。
 *
 * 而这张表又**必须**存在：`kl-graph/` 刻意一个字节没动（那是算法团队的
 * 真实历史），所以它的 `SKILL.md` 里仍有 3 个真名，而那份 skill 会被
 * `sync:kl-skill` 拷进 `apps/desktop/resources/skills/` 并**打进 .app**。
 * 源脏、产物必须干净，落差就靠这张表。
 *
 * 解法：只存 hash。替换时对**源文本里出现的候选串**算 hash 去比对 ——
 * 于是表能照常工作，而表本身不含任何真名。
 *
 * ## 怎么加新条目
 *
 * ```
 * node -e 'console.log(require("node:crypto").createHash("sha256").update("<真名>").digest("hex").slice(0,16))'
 * ```
 * 把输出填进下面，值写同字数的化名。
 * **不要**把真名写进 commit message 或注释。
 */
import { createHash } from "node:crypto"

/** 候选中文姓名的长度范围（2~4 字，覆盖绝大多数中文名）。 */
const NAME_MIN = 2
const NAME_MAX = 4

/** sha256(真名).slice(0,16) → 化名。 */
const NAME_HASH_TO_ALIAS = Object.freeze({
  "13ba54890ee8b200": "傅书言",
  f8c0f7d5686d8592: "卫昭明",
  c624fd108f9b0216: "孟允之",
  ed2078443f7f022d: "苏子墨",
  ae8a1f7cca0d8a8a: "钱望之",
})

function nameHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/**
 * 扫出文本里所有**命中 hash 表**的中文姓名。
 *
 * 做法：把连续的中文字符切成词，再按 2~4 字的滑窗算 hash 去查表。
 * 比"拿真名去 includes"多绕一层，换来的是表里不存真名。
 */
function matchedNames(text) {
  const found = new Map()
  for (const run of text.match(/[一-龥]+/g) ?? []) {
    for (let len = NAME_MAX; len >= NAME_MIN; len -= 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const candidate = run.slice(i, i + len)
        const alias = NAME_HASH_TO_ALIAS[nameHash(candidate)]
        if (alias !== undefined) found.set(candidate, alias)
      }
    }
  }
  return found
}

/**
 * 商标字样 → 中性表述。
 *
 * ★ 键按片段拼装：直接写字面量的话**本文件自己**会被 `check:trademarks` 命中
 * （那个脚本的 FORBIDDEN 也是这么写的，理由相同 —— 见它的注释）。
 */
export const TRADEMARK_TO_NEUTRAL = Object.freeze({
  ["Q" + "wenWork agents"]: "本产品的 agent",
  // 上游示例里拿这个网关产品名当"实体"举例（`kl timeline "<它>"`）。
  // 换成一个中性的示例实体名 —— 例子讲的是"实体名可以是中英文"，与具体是谁无关。
  ["M" + "uleRun"]: "AcmeCloud",
})

/** 把文本里的真名与商标换掉。幂等 —— 已经换过的文本再跑一次不变。 */
export function sanitize(text) {
  let out = text
  for (const [real, alias] of matchedNames(text)) out = out.split(real).join(alias)
  for (const [from, to] of Object.entries(TRADEMARK_TO_NEUTRAL)) out = out.split(from).join(to)
  return out
}

/**
 * 文本里**残留**的真名与商标（该换没换的）。
 *
 * 返回 `{kind, value}` 数组而不是布尔：报错时要能说出漏了哪一类，
 * 否则"有残留"这句话不足以让人定位。`value` 给调用方判断用 ——
 * 打日志时不该回显它（那等于又泄漏一次）。
 */
export function findResidual(text) {
  const out = []
  for (const real of matchedNames(text).keys()) {
    out.push({ kind: "真实姓名", value: real })
  }
  for (const mark of Object.keys(TRADEMARK_TO_NEUTRAL)) {
    if (text.includes(mark)) out.push({ kind: "第三方商标", value: mark })
  }
  return out
}
