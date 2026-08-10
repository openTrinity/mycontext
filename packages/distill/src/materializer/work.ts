/**
 * `work.md` —— work 层的产物：**能力**，不是**授权**。
 *
 * ## 它在整个 skill 包里的位置
 *
 * 一个装好的 persona skill 有两个来源：
 *
 * · forge 写的 6 个 md（`style` / `decisions` / `people` / `scenes` /
 *   `limits` / `fidelity`）—— 全部是**测量值**，零模型调用；
 * · 这一个 —— 从语料里**抽**出来的工作方式，因为它测不出来。
 *
 * 判据在 `llm-map.LLM_FACETS` 里写清了：能从长度、时间、收发方、词频里数出来的
 * 归 forge；只能从"他说了什么内容"里读出来的归这里。一个人负责哪个系统这件事
 * 不体现在他消息的长度上。
 *
 * ## ★★ 这个文件不进决策判据
 *
 * `work.md` 说的是「他会做什么、怎么做」，**不是**「agent 可以替他答什么」。
 * 那两件事必须分开，否则一份写着「他负责用户中台」的能力描述会被读成
 * 「用户中台的问题可以替他答」—— 而那是决策层的事，由 forge 的
 * `decisions.md` / `rules.json` 管（答复率、风险类、never_settle）。
 *
 * 所以：
 * · 这个文件只进 `references/`，**不进** `rules.json`（脚本读的唯一真值）；
 * · 文件里明写一句「这里的内容不构成回复授权」。
 *
 * 混起来的后果不是报错：agent 会拿着一份很有底气的能力清单去答一个
 * 本该草稿的问题，而每一层看起来都在正常工作。
 *
 * ## ★ facet 值是不可信输入
 *
 * 这些结论是从群聊语料抽的，也就是内容最终来源是别人发的消息。所以一律过
 * `neutralizeMarkdown`（与 `render.ts` 同一个函数，见那里长长的注释：
 * 伪造更高优先级层级、Unicode 行终止符、`![](…)` 自动加载外泄信道）。
 */
import type { ProfileFacetRow } from "@mycontext/store"
import { neutralizeMarkdown } from "./render.js"

/**
 * work 层的 facet，按产物里的呈现顺序。
 *
 * ★ 顺序是「他是谁 → 别人找他干什么 → 他怎么做 → 交付什么 → 他的红线」。
 * agent 从上往下读，所以最能定位"这条消息是不是他的活"的放最前面。
 */
const WORK_SECTIONS: readonly { facet: string; heading: string; blurb: string }[] = [
  {
    facet: "role",
    heading: "他是干什么的",
    blurb: "职能、负责的系统，以及**哪些明确不是他的**。",
  },
  {
    facet: "tasks",
    heading: "别人找他做什么",
    blurb:
      "反复出现的任务，按 ask 类型分组。**括号里的次数与答复率来自测量**，" +
      "且是**那一类的合计**，不是组里某一条的 —— forge 只有分类没有内容，" +
      "所以它说不出这一类的总次数里有多少属于其中哪一条。",
  },
  { facet: "workflow", heading: "工作流程", blurb: "接到事情之后他按什么步骤做。" },
  { facet: "artifacts", heading: "输出物偏好", blurb: "他交付的东西长什么样。" },
  { facet: "knowhow", heading: "他定过的规矩", blurb: "他明确表达过的判断与红线。" },
]

/**
 * 每节最多列几条。
 *
 * ## ★★ 为什么必须有上限
 *
 * 实测产出的 `work.md` 是 **37453 字节 / 268 条结论**。而直连降级路
 * （`persona.service.readGuidance`）把参考件**全文拼进每一轮的 system prompt**
 * —— 那一份里 work 层独占 61%（`style.md` 4.5K + `decisions.md` 6.2K +
 * `SKILL.md` 12.6K + 这个 37.5K）。也就是每一条回复都在为 268 条结论付钱，
 * 而其中绝大多数与当前这条消息无关。
 *
 * ACP 路不受影响（agent 靠 `skills.paths` 自取），但直连是**降级路** ——
 * 恰恰在 agent 起不来时才走，也就是最不该雪上加霜的时候。
 *
 * 上限按 facet 分别给：`role`（他是谁）超过十几条就说明抽重了，
 * 而 `knowhow`（他定过的规矩）本来就该多 —— 那是最有用的一节。
 */
const SECTION_LIMITS: Readonly<Record<string, number>> = {
  role: 12,
  tasks: 15,
  workflow: 15,
  artifacts: 12,
  knowhow: 15,
}

/** 缺省上限（新 facet 忘了配时兜住，而不是无限列）。 */
const DEFAULT_SECTION_LIMIT = 12

/**
 * 置信度低于这个值的**标注**出来（但仍然进产物）。
 *
 * 与 `MIN_CONFIDENCE`（低于它直接不进）是两档：0.5 以下不可信到不该出现，
 * 而 0.5–0.65 是"有证据但不多"—— 那种结论有价值，但 agent 不该拿它当定论。
 * 只排序不标注等于让它们与 0.9 的结论长得一样（这是实测发现的问题）。
 */
const THIN_CONFIDENCE = 0.65

/** forge 测出的一类 ask 的频率。`work.md` 只**引用**，不重算。 */
export interface AskKindStat {
  /** 原始次数（未加权）—— 那是"确实发生过这么多次" */
  asks: number
  answerRatePct: number
}

/**
 * 置信度低于这个值的结论**不进产物**。
 *
 * 不是"标个低置信度留着"：产物是给 agent 读的，而 agent 不会因为一条结论
 * 标着 0.3 就不照做 —— 它只会看到一句陈述。审阅页可以显示全部（那是给人看的），
 * 但进 skill 的必须是站得住的。
 */
const MIN_CONFIDENCE = 0.5

export interface WorkLayerResult {
  /** 文件内容；`null` = 没有任何够格的结论（此时**不该写文件**，见下） */
  content: string | null
  /** 进了产物的结论条数 */
  included: number
  /** 因置信度不够被挡掉的条数 */
  droppedLowConfidence: number
}

/**
 * playbook 那一节的输入。
 *
 * ★ 与 facet **分开传**，不塞进 `ProfileFacetRow[]`：它的形状根本不同
 * （有阶段序列、有覆盖率），而硬塞进 facet 的键值形状会让"这是一条有序流程"
 * 这件事在装配的那一刻消失。
 */
export interface WorkPlaybookSection {
  playbooks: readonly {
    name: string
    trigger: string
    stages: readonly { action: string; output: string; asks: string }[]
  }[]
  /**
   * ★★ 覆盖率 —— **必须给，且必须写进产物**。见 `PlaybookResult.coverage`。
   *
   * 这是唯一能让「换个人跑失效了」被看见的信号。一份只有 2 条 playbook 的
   * 产物如果不说"从 1529 段里只归纳出 76 段"，读的人会以为这个人就这么点
   * 套路 —— 而真相可能是取样判据在他的语料上完全失效。
   */
  coverage: { candidates: number; eligible: number; sampled: number }
}

/**
 * 把 work facet 渲染成 `work.md`。
 *
 * ★ 一条够格的结论都没有时返回 `content: null` 而**不是**一个空骨架。
 * 空骨架（只有四个标题、每节写「暂无」）会让 agent 以为"这些维度都查过了、
 * 确实没有"，而真相是"还没蒸出来"。缺文件是一个诚实的状态；
 * 而 forge 的 `fidelity.md` 已经建立了「未测到 ≠ 测到 0」这个约定。
 */
export function renderWorkLayer(
  facets: readonly ProfileFacetRow[],
  context: {
    displayName: string
    nowMs: number
    /**
     * forge 测出的 ask 频率（`features.json → decisions.replyPropensity`）。
     *
     * ★ **引用，不重算。** `tasks` 那一节把它并排写在任务名后面
     * （「review 代码（forge 测 73 次 / 答复率 82%）」）。
     *
     * 为什么必须来自 forge 而不是让 LLM 也数一遍：一个数出现两次就会打架，
     * 而打架的时候没有任何机制决定谁赢。分工是硬的 —— **频率是测量（forge），
     * 内容是抽取（LLM）**，这个文件只把两者摆在一起。
     *
     * 取不到（还没蒸过 / 读失败）时省掉括号那段，而不是写 0 次 ——
     * "测出来 0 次"与"没测"是两件事（同 `fidelity.md` 的那条约定）。
     */
    askKinds?: Readonly<Record<string, AskKindStat>>
    /**
     * 证据多旧算"较早"（天）。取 forge 的 `recency.halfLifeDays`（`signals.json`）。
     *
     * 复用那个阈值而不新造一个：两层对"多旧算旧"给出不同答案会让
     * `work.md` 说"较早"而 `decisions.md` 仍按当前算 —— 读的人无从判断。
     * 0 / 省略 = 不标注。
     */
    staleAfterDays?: number
    /**
     * 工作套路那一节。省略 = 这一轮没归纳出来（那一节**不出现**）。
     *
     * ★ 空的 `playbooks` 与省略是两件事，但产物里的处理相同（不出现）——
     * 区别只在覆盖率那一行：有 `coverage` 时会说清"从 N 段里归纳出 M 段"，
     * 而那正是"归纳过但没结果"与"根本没跑"的分界。
     */
    playbookSection?: WorkPlaybookSection
  },
): WorkLayerResult {
  const byFacet = new Map<string, ProfileFacetRow[]>()
  let droppedLowConfidence = 0

  for (const row of facets) {
    if (!WORK_SECTIONS.some((section) => section.facet === row.facet)) continue
    if (row.confidence < MIN_CONFIDENCE) {
      droppedLowConfidence += 1
      continue
    }
    const list = byFacet.get(row.facet) ?? []
    list.push(row)
    byFacet.set(row.facet, list)
  }

  const playbooks = context.playbookSection?.playbooks ?? []
  /**
   * ★ playbook 单独也算"有内容"。
   *
   * 判据必须含它，否则一个只有 playbook、没有 facet 的账号会返回 `null` →
   * 落盘那侧把文件删掉 → 花钱归纳出来的套路直接丢掉，而且不报错。
   */
  const included =
    [...byFacet.values()].reduce((sum, rows) => sum + rows.length, 0) + playbooks.length
  if (included === 0) {
    return { content: null, included: 0, droppedLowConfidence }
  }

  const name = neutralizeMarkdown(context.displayName || "本人")
  const lines: string[] = [
    `# ${name} 的工作方式`,
    "",
    `<!-- generated from profile_facets (work) @ ${String(context.nowMs)} — 请勿手改 -->`,
    "",
    /**
     * ★ 这段免责必须在最前面，且必须说清"不是授权"。
     *
     * 一份写着「他负责用户中台」的清单，读起来非常像"用户中台的问题你可以答"。
     * 而能不能答由决策层管（`decisions.md` 的答复率与风险类）。
     * 这句话是这个文件与那个文件之间唯一的边界声明。
     */
    "> 这里写的是**他会做什么、怎么做**，用于替他起草内容时对齐做法。",
    "> **这不是回复授权**：某件事是不是该由你替他答，只看 `decisions.md`",
    "> 与 `rules.json`（答复率、风险类、never_settle）。这个文件里出现过的",
    "> 系统或话题，不代表它可以被自动回复。",
    "",
    "> 每条结论都来自他自己说过的话。**没有写在这里的，不要推断** ——",
    "> 缺一节的意思是「还没蒸出来」，不是「他没有这方面的做法」。",
    "",
  ]

  for (const section of WORK_SECTIONS) {
    const rows = byFacet.get(section.facet)
    // 没有结论的整节**不出现**，而不是写一句「暂无」——
    // 见函数注释：那会让"没测到"读成"测到了没有"。
    if (rows === undefined || rows.length === 0) continue
    lines.push(`## ${section.heading}`, "", section.blurb, "")

    // 置信度高的排前面：agent 从上往下读，最可靠的先入眼。
    const sorted = [...rows].sort((a, b) => b.confidence - a.confidence)
    const limit = SECTION_LIMITS[section.facet] ?? DEFAULT_SECTION_LIMIT
    const shown = sorted.slice(0, limit)
    const truncated = sorted.length - shown.length

    if (section.facet === "tasks") {
      // ★ 按 askKind 分组，让测量值只出现一次 —— 见 `renderTaskGroups`。
      lines.push(...renderTaskGroups(shown, context))
    } else {
      for (const row of shown) {
        lines.push(
          `- ${neutralizeMarkdown(parseValue(row.valueJson))}${annotate(row, context.staleAfterDays, context.nowMs)}`,
        )
      }
    }

    /**
     * ★★ 被截掉的**必须说出来**。
     *
     * 静默截断会读成「这一节已经全了」，而真相是「还有 N 条，只是置信度更低」
     * —— 那正是 `fidelity.md` 建立的「未测到 ≠ 测到 0」这条约定的同一形状。
     * agent 据此知道"这里可能还有别的做法"，而不是把这 12 条当成穷举。
     */
    if (truncated > 0) {
      lines.push("", `（另有 ${String(truncated)} 条置信度更低的结论未列出。）`)
    }
    lines.push("")
  }

  /**
   * ★ 工作套路放**最后**。
   *
   * 前面五节是"他是谁 / 别人找他干什么 / 怎么做 / 交付什么 / 红线"——
   * 那些是判断「这条消息是不是他的活」用的，agent 从上往下读时先要它们。
   * 套路是**决定要做之后**才需要的（照哪几步走），所以排在后面。
   */
  if (playbooks.length > 0) {
    lines.push(...renderPlaybooks(playbooks, context.playbookSection?.coverage))
  }

  return { content: lines.join("\n"), included, droppedLowConfidence }
}

/**
 * 工作套路那一节。
 *
 * ## ★★ 覆盖率那一行是硬要求
 *
 * 见 `WorkPlaybookSection.coverage`：一份只有两三条套路的产物，如果不说
 * 「从多少段对话里归纳出多少段」，读的人无法区分
 * 「这个人就这么点套路」与「取样判据在他的语料上失效了」。
 * 而后者在换个人跑时是**很可能**发生的 —— 这一层只在一份语料上验过。
 *
 * ## ★ 不写「暂无套路」
 *
 * 一条都没有时这一节整个不出现（调用方已判 `length > 0`）。写一句「暂无」
 * 会让 agent 以为"查过了，他确实没有固定做法"，而真相是"没归纳出来"。
 * 同 `fidelity.md` 那条「未测到 ≠ 测到 0」的约定。
 */
function renderPlaybooks(
  playbooks: WorkPlaybookSection["playbooks"],
  coverage: WorkPlaybookSection["coverage"] | undefined,
): string[] {
  const out: string[] = ["## 他的工作套路", ""]

  out.push(
    "接到这几类事时他按什么步骤走。**每一步的「产出」是这一步真正交付的东西** ——",
    "替他起草时用它对齐做法，不要跳步。",
    "",
  )

  if (coverage !== undefined) {
    /**
     * ★ 三个数都报，因为它们回答三个不同的问题：
     * · candidates —— 他一共有多少段对话（规模）
     * · eligible   —— 其中多少段**有流程痕迹**（这份语料适不适合归纳）
     * · sampled    —— 真的送进模型的（成本上限，剩下的留给下一轮）
     *
     * 只报一个比率会把"语料里本来没有流程"与"我们只看了一小部分"混在一起。
     */
    out.push(
      `> 从 ${String(coverage.candidates)} 段本人参与的对话里，` +
        `${String(coverage.eligible)} 段带流程痕迹，本轮归纳了 ${String(coverage.sampled)} 段，` +
        `得到 ${String(playbooks.length)} 条套路。`,
      "> **没有归纳出来的部分不代表他没有做法** —— 只代表那些对话里读不出顺序。",
      "",
    )
  }

  for (const book of playbooks) {
    out.push(`### ${neutralizeMarkdown(book.name)}`, "")
    out.push(`触发：${neutralizeMarkdown(book.trigger)}`, "")
    for (const [index, stage] of book.stages.entries()) {
      out.push(`${String(index + 1)}. ${neutralizeMarkdown(stage.action)}`)
      out.push(`   - 产出：${neutralizeMarkdown(stage.output)}`)
      // 「常问」是原话，替答时最有用的一栏 —— 但不是每步都有
      if (stage.asks !== "") out.push(`   - 常问：${neutralizeMarkdown(stage.asks)}`)
    }
    out.push("")
  }

  return out
}

/**
 * `tasks` 一节：按 `askKind` 分组，**测量值写在组标题上**。
 *
 * ## ★★ 为什么必须分组
 *
 * 实测产物里 38 条任务中有 **17 条**各自挂着同一句
 * 「forge 测 73 次 / 答复率 82.4%」—— 因为它们的 `askKind` 都是 `help_request`，
 * 而那个频率是**整个 askKind 的**，不是这一条任务的。
 *
 * 后果有两层，第二层更糟：
 *
 * · 字数 —— 同一句话复述 17 遍；
 * · **读者被误导** —— 17 行各带一个数，读起来像 17 个独立测量，
 *   于是 agent 会以为「review MR」被问过 73 次、「排查前端问题」也被问过 73 次。
 *   真相是这两件事**共享**那 73 次里的一部分，而具体怎么分 forge 测不出来
 *   （它只有分类没有内容，这正是 `tasks` 这个 facet 存在的理由）。
 *
 * 所以频率提到组标题、组内只列任务名 —— 那既省字数，又把
 * 「这个数属于这一类，不属于其中某一条」这件事**说清楚了**。
 *
 * ★ 组的顺序按 forge 测的次数从多到少：agent 从上往下读，最常发生的先入眼。
 * 取不到频率的组（forge 没测到那一类）排在最后，且不写括号 ——
 * 「测出来 0 次」与「没测」是两件事。
 */
function renderTaskGroups(
  rows: readonly ProfileFacetRow[],
  context: {
    askKinds?: Readonly<Record<string, AskKindStat>>
    staleAfterDays?: number
    nowMs: number
  },
): string[] {
  const groups = new Map<string, ProfileFacetRow[]>()
  for (const row of rows) {
    const kind = taskAskKind(row.valueJson)
    const list = groups.get(kind) ?? []
    list.push(row)
    groups.set(kind, list)
  }

  const ordered = [...groups.entries()].sort(([left], [right]) => {
    const leftAsks = context.askKinds?.[left]?.asks ?? -1
    const rightAsks = context.askKinds?.[right]?.asks ?? -1
    return rightAsks - leftAsks
  })

  const out: string[] = []
  for (const [kind, list] of ordered) {
    const stat = kind === "" ? undefined : context.askKinds?.[kind]
    const label = kind === "" ? "未归类" : kind
    const measured =
      stat === undefined
        ? ""
        : `（forge 测 ${String(stat.asks)} 次 / 答复率 ${String(stat.answerRatePct)}%，**这一类合计**）`
    out.push(`### ${label}${measured}`, "")
    for (const row of list) {
      out.push(
        `- ${renderTaskBody(row.valueJson)}${annotate(row, context.staleAfterDays, context.nowMs)}`,
      )
    }
    out.push("")
  }
  return out
}

/** 一条 `tasks` 结论的 `askKind`；取不到返回空串（归入「未归类」组）。 */
function taskAskKind(valueJson: string): string {
  try {
    const parsed: unknown = JSON.parse(valueJson)
    if (typeof parsed !== "object" || parsed === null) return ""
    const kind = (parsed as Record<string, unknown>)["askKind"]
    return typeof kind === "string" ? kind : ""
  } catch {
    return ""
  }
}

/**
 * 一条 `tasks` 结论的正文 —— **不含**频率（那在组标题上）。
 *
 * 模型没照对象给（给了一句话）时原样渲染那句话 —— 少一个字段比丢一条结论好。
 */
function renderTaskBody(valueJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(valueJson)
  } catch {
    return neutralizeMarkdown(valueJson)
  }
  if (typeof parsed !== "object" || parsed === null) {
    return neutralizeMarkdown(parseValue(valueJson))
  }
  const item = parsed as Record<string, unknown>
  const task = typeof item["task"] === "string" ? item["task"] : ""
  if (task === "") return neutralizeMarkdown(parseValue(valueJson))

  const parts = [`**${neutralizeMarkdown(task)}**`]
  const from = typeof item["from"] === "string" ? item["from"] : ""
  if (from !== "") parts.push(` · 谁提：${neutralizeMarkdown(from)}`)
  const trigger = typeof item["trigger"] === "string" ? item["trigger"] : ""
  if (trigger !== "") parts.push(` · 长这样：${neutralizeMarkdown(trigger)}`)
  return parts.join("")
}

/**
 * 一条结论的**标注**：证据薄、或证据偏旧。
 *
 * ## ★ 为什么要标，而不是只排序
 *
 * 实测问题：0.55 的「睡前会安排他人继续优化」与 0.85 的「bug 分诊流程」
 * 在产物里**长得一模一样**，只有先后之别。而 agent 不会因为一条排在后面
 * 就少信它 —— 它只看到一句陈述句。
 *
 * `⚠︎证据较少` 与 `⏳较早` 是给 agent 的**降权信号**，与 forge 在
 * `decisions.md` 里用 `⚠︎thin` / `⚑changed` 是同一套做法（那边也是标注而非隐藏）。
 */
function annotate(row: ProfileFacetRow, staleAfterDays: number | undefined, nowMs: number): string {
  const marks: string[] = []
  if (row.confidence < THIN_CONFIDENCE) marks.push("⚠︎证据较少")
  /**
   * 用 `windowEnd`（证据所在窗口的右端）而不是 `updatedAt`：后者是"什么时候
   * 抽的"，而重抽一遍旧语料会把它刷新成今天 —— 那样一条三个月前的结论
   * 看起来永远是新的。
   */
  if (
    staleAfterDays !== undefined &&
    staleAfterDays > 0 &&
    row.windowEnd !== null &&
    nowMs - row.windowEnd > staleAfterDays * 86_400_000
  ) {
    marks.push("⏳较早")
  }
  return marks.length === 0 ? "" : ` ${marks.join(" ")}`
}

/**
 * `valueJson` → 一行文本。
 *
 * 值可能是字符串、数字或对象（facet 的 value 是 `unknown`）。非字符串一律
 * `JSON.stringify` 后原样带上：丢掉它会静默少一条结论，而 agent 读到一段
 * JSON 至少知道那里有东西没渲染好。
 */
function parseValue(valueJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(valueJson)
  } catch {
    return valueJson
  }
  if (typeof parsed === "string") return parsed
  if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed)
  return JSON.stringify(parsed)
}
