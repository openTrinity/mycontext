/**
 * work 层的**去重与稳定 key** —— 让 `mergeFacet` 真的有机会跑起来。
 *
 * ## ★★ 这个文件修的是一次「合并层从未触发」的静默失效
 *
 * `profile_facets` 的 `UNIQUE(facet, scope, scope_ref, key)` 是增量合并的**前提**：
 * 只有同一件事在不同窗口落到同一个 `key`，`mergeFacet` 的三态
 * （补充 / 确认 / 矛盾）才会被调到。
 *
 * 而 `key` 原来是**模型每个窗口自己编的英文串**。于是同一件事在每个窗口
 * 都是一个新 key、一行新记录。实测本机库（33924 条消息、273 条结论）：
 *
 * ```
 * revision = 1 的有 260 条 / 273   → 三态几乎从未跑过
 * artifacts 里「发截图」有 11 条各自独立：
 *   screenshot_with_caption / screenshot_with_report / screenshot_for_status
 *   screenshot_with_ui_work / screenshot_attach / bug_report_screenshot_brief …
 * ```
 *
 * 后果是**双向**的，而且都不报错：
 *
 * · 产物侧 —— 268 条结论里大量近义重复，`work.md` 涨到 37KB，
 *   而直连降级路把它全文拼进每一轮的 system prompt；
 * · 证据侧 —— 每轮新语料都在**堆新行**而不是**加固已有行**，
 *   于是「有 20 句话都这么说」这个最有价值的信号（`mergeFacet` 的
 *   `confirm` 分支会提升置信度）**永久丢失**。
 *
 * ## 解法：key 由本地词法算，不由模型给
 *
 * 模型只负责输出**内容**（它擅长的），key 与"这条是不是已经有了"由
 * 本地纯函数决定（它擅长的）。这样同一件事必然落到同一行。
 *
 * ## ★ 为什么不走「第二次模型调用」
 *
 * mem0 那类做法是抽完再发一次请求，把候选与已有结论一起给模型，
 * 让它判 ADD / UPDATE / NOOP。那对同义改写更准，但**与这一层的经济性
 * 目标直接冲突**：每轮多一笔钱，去修一个词法就能修掉大半的问题。
 * 而这一层贵到需要攒批（见 `work-refresh.ts`）。
 *
 * 代价要说清楚：**词法档合不了完全换词的同义改写**
 * （「发图配一句话」vs「附截屏并说明」几乎没有共同 token）。那些仍会各占一行。
 * 阈值留成常量，将来真需要时在模糊区间加一档模型仲裁 —— 但那是另一次改动，
 * 不该在"先把 260 条 revision=1 修掉"这一轮里混进来。
 *
 * ## ★ 复用 `@mycontext/retrieval` 的 `tokenize`，不自己切词
 *
 * 那个函数（CJK 单字 + 相邻二字，ASCII 词原样）已经在 FTS 索引与召回两处
 * 生产验证过，且它文件头记着「两侧不一致会让检索静默失效」那个坑。
 * 这里再写一个切词器就是第二个真源 —— 而两个切词器早晚不一致。
 */
import { tokenize } from "@mycontext/retrieval"
import type { FacetCandidate } from "../guards.js"

/**
 * 进 key 的 token 数上限。
 *
 * 太少（比如 3）会让不同的事撞成同一个 key —— 那比不合并更糟：
 * `mergeFacet` 会把两件事判成「矛盾」，然后双双降置信。
 * 太多则 key 变得跟原句一样长，等于没归一化（换一个字就是新 key）。
 *
 * 8 是取「够区分」与「容忍改写」的折中：一条结论正文通常 20–60 字，
 * 切出 40–120 个 token，取按字典序最靠前的 8 个 —— 改写掉一两个词
 * 通常不影响这 8 个里的多数。
 */
const KEY_TOKENS = 8

/**
 * 判为「同一条结论」的重叠系数下限。
 *
 * ## ★★ 这个数与相似度公式都是**在真实语料上量出来的**
 *
 * 第一版用 Jaccard（交集/并集）配 0.5，跑真库重放时只合掉 9 条 ——
 * 而 `artifacts` 里那 11 条「发截图」肉眼就是同一件事。原因是 Jaccard 的分母
 * 含并集：两句话都长时，**各自独有的词把分母撑大**，于是明显的近义句只有
 * 0.25–0.31（实测那 11 条两两比对，最高 0.31）。
 *
 * 换成**重叠系数**（交集 / 较短那个集合）之后判别力就够了 —— 那个公式对
 * 「一句话是另一句的详细版」特别合适，而那恰好是这一层最常见的重复形态
 * （模型在不同窗口对同一件事给出详略不同的两版）。
 *
 * ★ 但**光靠比值不行**，必须配 `MIN_SHARED_TOKENS`（见那里）。
 * 拿真库合并出的 78 对逐对看，相似度最低的那批里有明确的误合：
 *
 * ```
 * 0.35  「核心 AI 助手路由必须先能用」 ←→ 「合 main 前必须先通过 review」
 * 0.35  「做模型蒸馏相关工作」       ←→ 「负责订阅相关业务模型…」
 * ```
 *
 * 两句都短，共享的又都是「必须 / 先 / 相关 / 模型」这类中文虚词与常用词 ——
 * 比值很容易过阈值，而它们说的是两件事。
 *
 * 在一组人工标注（6 对真重复 / 12 对真不同，取自本机真实结论）上网格搜索：
 *
 * ```
 * 阈值 0.5 + 共享 ≥ 8 → 命中真重复 4/6，误合 0/12
 * 阈值 0.5 + 无下限   → 命中真重复 4/6，误合 2/12
 * 阈值 0.35（第一版） → 误合 3/12
 * ```
 *
 * ## ★ 为什么宁可漏合（4/6 而不是追 6/6）
 *
 * 误合与漏合的代价**不对称**：
 *
 * · 漏合 —— 产物里多一条近义结论。难看，但两条说的都是真的；
 * · 误合 —— 两件不同的事被 `mergeFacet` 判成「矛盾」，于是**双双降置信**
 *   （`merger.ts` 的 conflict 分支），最后可能双双掉到 `MIN_CONFIDENCE`
 *   之下而消失。也就是误合会**吃掉真结论**，且没有任何迹象。
 *
 * 所以取的是"误合为 0"那一档，而不是召回最高那一档。
 */
const SIMILAR_THRESHOLD = 0.5

/**
 * 除了比值，还要求**绝对**共享这么多 token 才算同一条。
 *
 * ★ 这一条是防**短句**的。两句十来个字的结论共享「必须」「先」「的」
 * 这类中文虚词就能让重叠系数轻松过 0.5，而它们说的是两件事
 * （实测误合例见 `SIMILAR_THRESHOLD`）。要求绝对量之后，
 * 只有真的共享一整段措辞才会被合。
 *
 * 8 个 token 在 CJK 下大约是四五个字的重合（`tokenize` 会产出单字 + 相邻二字），
 * 也就是"共享一个完整短语"这个量级 —— 网格搜索里它把误合从 2/12 压到 0/12
 * 而没有损失任何真重复的命中。
 */
const MIN_SHARED_TOKENS = 8

/**
 * 一条结论正文 → 稳定 key。
 *
 * ★ 三步都必要：
 * · `tokenize` 归一化（大小写、CJK 切分）；
 * · **去重后排序** —— 让 key 不依赖 token 在原句里的位置；
 * · 截断到 `KEY_TOKENS` 并用 `-` 连接。
 *
 * ★ 排序**不等于**「语序调换必然同 key」：CJK 切分会产出相邻二字，
 * 而调换语序会改变哪些相邻对存在（「先看日志再复现」有 `日志`，
 * 调换后切分点上变成 `志再`）。那一类改写由相似度那一档
 * （`findSimilar`）兜住 —— 单字 token 大量重合，Jaccard 仍然过阈值。
 * 这里不许一个做不到的承诺。
 *
 * ★ 空 token（正文只有标点或表情）时回落到内容的确定性摘要而**不是**空串：
 * 空 key 会让所有这类结论撞成同一行（UNIQUE 命中），把无关的东西合并起来。
 */
export function facetKey(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  const tokens = [...new Set(tokenize(text))].sort()
  if (tokens.length === 0) {
    // 确定性回落：同一内容必须得到同一个 key（否则每轮又是新行）
    return `raw-${hashText(text)}`
  }
  return tokens.slice(0, KEY_TOKENS).join("-")
}

/**
 * `tasks` 的 value 是**对象**（`{task, from, trigger, askKind}`）。
 *
 * ★ key 只从 `task` 与 `askKind` 算，**不含** `from` / `trigger`：
 * 那两个字段是同一件事的**举例**，每个窗口举的例子都不同
 * （「MR 链接 + 一句话」vs「MR链接 + 拉群@提及」）。把它们算进 key
 * 就等于让同一个任务在每个窗口都是新行 —— 那正是要修的那个 bug。
 *
 * 实测证据：`tasks` 38 条里有 6 条都是「review / 合 MR」，只是 trigger 不同。
 */
export function candidateKey(candidate: FacetCandidate): string {
  const value = candidate.value
  if (candidate.facet === "tasks" && typeof value === "object" && value !== null) {
    const item = value as Record<string, unknown>
    const task = typeof item["task"] === "string" ? item["task"] : ""
    const askKind = typeof item["askKind"] === "string" ? item["askKind"] : ""
    if (task !== "") return facetKey(`${task} ${askKind}`)
  }
  return facetKey(value)
}

/**
 * 两条正文的重叠度。返回**比值与绝对共享量**两个数。
 *
 * ★ 两个都要，见 `MIN_SHARED_TOKENS`：光看比值会让两句短结论
 * 共享几个中文虚词就被判成同一条。
 *
 * 比值用**重叠系数**（交集 / 较短那个集合）而不是 Jaccard（交集/并集）：
 * 并集做分母时，两句话各自独有的词会把分母撑大，于是"一句话是另一句的
 * 详细版"这种最常见的重复形态只能得到 0.25 上下，与不相干的句子分不开
 * （实测那 11 条「发截图」结论两两比对，Jaccard 最高 0.31、重叠系数最高 0.50）。
 */
export function overlap(left: string, right: string): { ratio: number; shared: number } {
  const a = new Set(tokenize(left))
  const b = new Set(tokenize(right))
  if (a.size === 0 || b.size === 0) return { ratio: 0, shared: 0 }
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return { ratio: shared / Math.min(a.size, b.size), shared }
}

/** 重叠系数（只要比值那个数）。判据请用 `overlap` —— 它还带绝对共享量。 */
export function similarity(left: string, right: string): number {
  return overlap(left, right).ratio
}

/** 库里已有的一行，去重只需要这三样。 */
export interface ExistingFacet {
  key: string
  /** 已有行的正文（`value_json` 反序列化后）—— 用于算相似度 */
  value: unknown
  facet: string
}

/**
 * 在已有结论里找「这其实是同一条」。
 *
 * 返回命中那一行的 `key`（调用方据此定位并交给 `mergeFacet`），
 * 没找到返回 null（调用方用 `candidateKey` 算出的新 key 插入）。
 *
 * ★ **两个判据都要过**：比值 ≥ `SIMILAR_THRESHOLD` **且** 绝对共享
 * ≥ `MIN_SHARED_TOKENS`。只看比值时实测有明确误合（两句短结论共享
 * 「必须 / 先 / 相关」就够了）—— 见那两个常量的注释与网格搜索结果。
 *
 * ★ **只在同一个 facet 内比较。** 跨 facet 比较会把
 * `workflow`「先看日志再复现」与 `knowhow`「必须先看日志」合成一条 ——
 * 而那两个的分工判据（有顺序 vs 有断言）正是 `llm-map.LLM_FACETS` 特意划开的。
 *
 * ★ 取**最相似**的那一条而不是第一条过阈值的：过阈值的可能有多条
 * （近义结论本来就成簇），随便挑一条会让结果取决于库里的行顺序 ——
 * 也就是同一份语料两次跑得到不同的画像，而这个引擎的立足点是可复现。
 */
export function findSimilar(
  candidate: FacetCandidate,
  existing: readonly ExistingFacet[],
  threshold = SIMILAR_THRESHOLD,
  minShared = MIN_SHARED_TOKENS,
): string | null {
  const text = valueText(candidate.value, candidate.facet)
  let best: { key: string; score: number } | null = null
  for (const row of existing) {
    if (row.facet !== candidate.facet) continue
    const { ratio, shared } = overlap(text, valueText(row.value, row.facet))
    if (ratio < threshold || shared < minShared) continue
    if (best === null || ratio > best.score) best = { key: row.key, score: ratio }
  }
  return best?.key ?? null
}

/**
 * 一条结论用于比对的文本。
 *
 * `tasks` 只取 `task` —— 与 `candidateKey` 同一个理由：`from` / `trigger`
 * 是举例，每轮都不同，算进去会让相似度被噪音拉低而永远合不上。
 */
function valueText(value: unknown, facet: string): string {
  if (facet === "tasks" && typeof value === "object" && value !== null) {
    const item = value as Record<string, unknown>
    const task = typeof item["task"] === "string" ? item["task"] : ""
    if (task !== "") return task
  }
  return typeof value === "string" ? value : JSON.stringify(value ?? "")
}

/**
 * 确定性哈希（FNV-1a 32 位）。
 *
 * 只用于 `facetKey` 的回落分支，不是安全用途 —— 要的性质只有一条：
 * **同一输入永远同一输出**（否则每轮又是新行）。
 */
function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}
