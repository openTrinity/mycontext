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
 * `kl-graph/skills/kl/SKILL.md` 是**算法团队的文件**，我们不改它
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
 * 于是那 3 个真名仍然在 `kl-graph/skills/kl/SKILL.md` 里 ——
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

/**
 * ★★ 我们这套部署与上游假设不符的地方 —— 注入在 SKILL.md **正文之前**。
 *
 * ## 为什么必须注入，而不是"让 agent 自己摸索"
 *
 * 真机实测一轮（206 秒、`kl ask` 最终成功）里，agent 白跑了 3 次失败调用
 * 才找到能用的形态。三个原因都源自上游那份文档对**它自己的仓库布局**
 * 的合理假设，而我们的部署把那些假设打破了：
 *
 * ① **`KL_REPO` 推导规则在我们这里不成立。** 上游写「skill 文件在
 *    `<repo>/.claude/skills/kl/SKILL.md`，所以 repo 根是它的 `../../..`」。
 *    我们把 skill **单独打进 `Resources/skills/kl/`**（与 kl-graph 代码根
 *    是两个位置 —— 见 `personaSkillPaths` 里"两类来源生命周期不同"那段），
 *    于是 agent 推出来的是 `resources/skills/kl`，那里没有 `kl` 可执行。
 *    实测它据此跑了两条命令，两条都失败。
 *
 * ② **`.venv` 那条回退路径也不成立。** 上游的 `kl` 包装脚本 exec
 *    `<repo>/.venv/bin/python`，而我们的解释器在 `vendor/python/<平台>/venv`
 *    （不在 kl-graph 里）。文档教的两种调用方式**都指向 `.venv`**。
 *    我们注入的 PATH 里已经把能用的 `kl` 放在首位（见 `persona-acp.ts`
 *    的 `getPythonEnv`），所以正确答案是**直接用裸 `kl`**，别推路径。
 *
 * ③ **管道会被权限层硬拒。** `bash` 的白名单只放行 `kl` 与 `kl *`
 *    （`KL_SKILL_PERMISSION`），而 `kl ask "…" 2>&1 | head -100` 整条
 *    不匹配那个 glob → 直接不执行。上游文档没写管道，是 agent 自己加的
 *    （它以为要截断长输出）。
 *
 * ★ 这里**不放宽白名单**：那是安全边界（CLAUDE.md §5），放开一条命令
 * 就是扩大攻击面。正确做法是告诉 agent 不要生成那种形态 ——
 * `kl` 自己有 `-k` / `--pretty` 控制输出量，不需要 `head`。
 *
 * 注入而不是改上游那份：与脱敏同一个理由（改了会在 `sync:kl-graph`
 * 合并时冲突，且算法团队看不到）。放在正文**之前**是因为 agent 读到
 * 上游那段 `KL_REPO` 推导规则时，得先知道"在这个宿主里别那么做"。
 */
const HOST_PREAMBLE = `<!-- 由 sync:kl-skill 注入：本宿主（MyContext 桌面端）的运行环境与上游假设不同 -->
# 在这个宿主里怎么调 kl（先读这一段，它覆盖下文的路径推导）

这份 skill 跑在 MyContext 桌面端的 agent 里。宿主已经把可用的 \`kl\`
放进 PATH 首位，所以：

- **直接用裸 \`kl\`** —— \`kl status\` / \`kl ask "…"\` / \`kl context <id>\`。
- **不要推导 \`KL_REPO\`**，也不要拼 \`"$KL_REPO/kl"\` 或
  \`.venv/bin/python kl_cli.py\`。下文那套"从 SKILL.md 上跳三级"的规则
  在这个宿主里得到的是 skill 资源目录，那里没有可执行文件 —— 会失败。
- **不要用管道、重定向或任何其他命令**（\`| head\`、\`| jq\`、\`2>&1\`、
  \`cat\`、\`pwd\` …）。权限层只放行 \`kl\` 本身，带管道的整条命令会被
  **直接拒绝执行**。输出太长时用 \`kl\` 自己的参数控制（如 \`-k\` 限条数、
  \`--pretty\`），而不是截断。
- \`kl-server\` 由宿主启动并保持运行，**不需要** \`kl start\`。

下文是上游原文，其中的路径推导与启动说明按上面这几条替换。

---

`

/**
 * 给外发的那份 SKILL.md 加上宿主适配前言。
 *
 * ★ 幂等：已经有前言的文本再跑一次不变（判据是那行注入标记）——
 * 与 `sanitize` 同一个要求，否则重复同步会叠出好几段前言。
 * 只对 SKILL.md 做（其余文件是参考资料，agent 不从那里学怎么调命令）。
 */
export function withHostPreamble(text) {
  if (text.includes("由 sync:kl-skill 注入")) return text
  return HOST_PREAMBLE + text
}

/**
 * 某个文件在外发前要做的**全部**变换。
 *
 * ★★ 生产者（`sync-kl-skill.mjs`）与门禁（`check-kl-skill-sync.mjs`）
 * 必须共用这一个入口。两处各写一遍"SKILL.md 要加前言、其余只脱敏"的
 * 判据，结局是它们迟早差一个字，而那时门禁**永远红**且错误信息说
 * "请运行 pnpm sync:kl-skill"（真实原因是两份判据不一致）——
 * 这个模块的头注释里已经记过同一个坑，别再犯第二次。
 *
 * `rel` 是相对 skill 根的路径（如 `SKILL.md`、`reference/xxx.md`）。
 * 只有**顶层的 SKILL.md** 加前言：那是 agent 学"怎么调命令"的地方，
 * 而参考资料不是。
 */
export function transformFor(rel, text) {
  const normalized = rel.split("\\").join("/")
  return normalized === "SKILL.md" ? withHostPreamble(sanitize(text)) : sanitize(text)
}

/** 把文本里的真名与商标换掉。幂等 —— 已经换过的文本再跑一次不变。 */
/**
 * 我们**追加**在 skill 末尾的一段（上游那份没有，也不该有）。
 *
 * ## ★★ 为什么必须走 sanitize 而不是手改产物
 *
 * `check:kl-skill-sync` 的判据是 `fingerprint(源, sanitize) === fingerprint(产物)`。
 * 手改产物的话下一次 `pnpm sync:kl-skill` 会把它整个覆盖掉 —— 而那不报错，
 * 只是"混合检索档位突然只查一个图"（一个静默的错答案）。
 * 把追加写进 `sanitize` 之后，生产者与门禁用的是**同一个**变换。
 *
 * ## 这一段在说什么
 *
 * 多渠道之后一个身份下有多个物理隔离的图库，各自一个 kl-server 与端口。
 * `KL_SERVER_PORT` 只能指一个 —— 混合档位的 agent 要问全部图，就得知道
 * 每个图在哪个端口。宿主在 spawn 时注入 `KL_GRAPHS_JSON`。
 */
const MYCONTEXT_APPENDIX = `

---

## 多图谱检索（宿主注入 \`KL_GRAPHS_JSON\` 时）

本宿主可能同时运行**多个** kl-server —— 一个数据来源一个，各自独立的
图库与端口，彼此物理隔离（这是隐私边界：来源之间不做 JOIN）。

\`KL_SERVER_PORT\` 只指向其中一个。若环境里还有 \`KL_GRAPHS_JSON\`，
它是一个 \`{"<来源名>": <端口>}\` 的映射，列出**全部**可查的图：

\`\`\`bash
# 例：{"dingtalk":8200,"feishu":8201}
echo "$KL_GRAPHS_JSON"
\`\`\`

问一个跨来源的问题时，**逐个图各问一次**，然后在回答里合并。
先看一眼有哪些图，再对每个端口各发一条命令：

\`\`\`bash
echo "$KL_GRAPHS_JSON"
# 假设读到 {"dingtalk":8200,"feishu":8201}，就发两条：
KL_SERVER_PORT=8200 kl ask "<question>" --pretty
KL_SERVER_PORT=8201 kl ask "<question>" --pretty
\`\`\`

不要写 shell 循环去解析那个 JSON —— 你已经读到了它的内容，
直接按读到的端口逐条发命令。宿主的命令白名单只放行 \`kl\` 与
\`KL_SERVER_PORT=<n> kl ...\` 这两种形态，别的写法会被拒。

两条要求：

- **不要**把一个来源的事实归到另一个来源。回答里涉及具体事实时说清它来自哪个。
- 某个图查不通时**说出来**，不要静默只用另一个的结果 —— 那会让用户以为
  搜过了全部来源。

没有 \`KL_GRAPHS_JSON\` 时忽略本节，按 \`KL_SERVER_PORT\` 查那一个图即可。
`

export function sanitize(text) {
  let out = text
  for (const [real, alias] of matchedNames(text)) out = out.split(real).join(alias)
  for (const [from, to] of Object.entries(TRADEMARK_TO_NEUTRAL)) out = out.split(from).join(to)
  // ★ 只对 SKILL.md 追加（目录里可能还有别的文件，给它们加就是噪音）
  return out.includes("KL_SERVER_PORT") ? `${out.trimEnd()}\n${MYCONTEXT_APPENDIX}` : out
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
