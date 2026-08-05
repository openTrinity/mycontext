/**
 * 记忆检索 —— 起草前把「对方提到的东西是什么」从知识图谱里查出来。
 *
 * ## ★ 为什么需要这一层
 *
 * forge 给的是**怎么说**（语气、句长、气泡数、逐人语气），图谱给的是
 * **说什么**（某个昵称指的是谁、某个项目是什么）。两者正交，而缺了后者的产出
 * 是一种可复现的失效：对方提到一个专有名词，草稿把那个词**原样复述**一遍，
 * 因为模型除了语气参数什么都没拿到。
 *
 * 语气对、要回的点也都回到了，但内容是空的 —— 而语气越像，这种空洞越难被
 * 察觉。图谱里往往**已经有**那个名词的解释（它是从同一批聊天记录里抽出来的），
 * 只是从来没有接进起草。
 *
 * ## ★ 为什么由宿主查，而不是让 agent 自己调 `kl`
 *
 * `kl` 在 PATH 上、`bash: {kl: allow}` 也放行了，agent 理论上能自己跑。实测
 * **一次都没跑过**，而且有两个独立的原因：forge 产出的 SKILL.md 里根本没提过
 * `kl` 的存在；而 `kl` 自己的 description 把用途限定在工作话题上，于是一个
 * 私人称呼按那个描述不该触发查询。
 *
 * 这与 forge 反复写下的那条判断一致：能机械判定的事必须是**返回值**，不是
 * 一段建议。所以宿主先查好、把结论放进提示词，agent 拿到的是事实而不是
 * 「你可以去查」。
 *
 * ## ★ 置信度是门槛，不是装饰
 *
 * 图谱的事实是 LLM 抽出来的，带 `confidence`。低置信度的事实进了提示词就是
 * 「以本人语气说出一件可能不对的事」—— 而语气越像，对方越会信。所以
 * `MIN_CONFIDENCE` 卡在 0.8。这个值来自抽取器的输出分布：绝大多数事实落在
 * 0.85–0.95，而 0.7 以下的量很小且明显更像猜测 —— 也就是这条线切掉的是尾部
 * 噪声，不是有用信息的一半。
 *
 * ## 只读、失败即降级
 *
 * 图库不存在 / 打不开 / 查出错 → 返回空，起草照常进行（只是没有记忆）。
 * 这一层**永远不能**让一轮起草失败：它是增强，不是前提。
 */
import type { Logger } from "@mycontext/kernel"

/** 一条查到的记忆。`term` 是触发它的那个词，用来在提示词里说明"这是谁"。 */
export interface MemoryHit {
  term: string
  /** 图谱里关于它的陈述，按置信度降序 */
  facts: string[]
}

/**
 * 事实的置信度门槛。
 *
 * 低于这个值不进提示词 —— 见文件头。**不要为了"多查到一点"下调**：
 * 以本人的语气说出一件错事，比不说更糟。
 */
export const MIN_CONFIDENCE = 0.8

/** 一个词最多带几条事实。够解释"这是什么"，又不至于挤掉对话本身。 */
const MAX_FACTS_PER_TERM = 3

/** 一轮最多查几个词。每个词一次 FTS，查十几个会让起草可感地变慢。 */
const MAX_TERMS = 3

/**
 * ★ 哪类实体**值得解释**。
 *
 * ## 为什么必须按类型筛
 *
 * 抽取器会把普通英文词（`chat` / `api` 这类）当成 `System` 实体。于是任何提到
 * 那个词的消息都会把一批**无关**事实拖进提示词 —— 实测带进来的是别人的前端
 * 样式 bug 与一段架构讨论，而它们的置信度都在 0.85 以上，也就是**置信度门槛
 * 挡不住它**：那些事实本身是可靠的，问题在于词太泛。
 *
 * 后果比"噪声"更具体：一段与本人无关的工作内容，被以本人的语气带进一次私聊。
 *
 * 白名单而不是黑名单：黑名单要穷举所有泛化词（而且是语言相关的，与这一层
 * 刻意的语言无关性冲突），白名单只需要回答"哪种东西需要一句解释"——
 * 人、项目、组织需要；系统与工具名多半是通用词，而真需要解释的产品名
 * 通常也在项目里。
 *
 * ⚠️ 取值来自 kl 的 `EntityType` 枚举（`kl_graph/models/types.py`）。
 * 上游加了新类型时这里不会报错，只会**少查一类** —— 那是安全的方向。
 */
const EXPLAINABLE_TYPES: ReadonlySet<string> = new Set([
  "Person",
  "Project",
  "Organization",
  "Team",
  "Event",
])

/**
 * 提及数下限。
 *
 * ★ 这一条**单独用不够**，必须与类型白名单叠加：真机分布里 `Person` 的中位提及数
 * 是 5，而那个噪声实体 `chat` 恰好也是 5 —— 光按提及数切会连真人一起切掉。
 *
 * 它挡的是另一类：抽取器偶然产出的一次性实体（提及 1–2 次，多半是抽错的片段）。
 * 一个真正需要在提示词里解释的东西，一定被反复提过。
 */
const MIN_MENTIONS = 3

/** 候选词的长度区间（码点）。 */
const MIN_TERM_LENGTH = 2
const MAX_TERM_LENGTH = 12

/**
 * CJK 滑窗切子串的长度区间。
 *
 * 无分词语言里的人名、昵称与项目名绝大多数是 2–4 个字。上界给到 6 覆盖长一点
 * 的产品名，再长就交给整段匹配 —— 每多一档都会多出一批候选，而它们最终都要
 * 过一次实体表。
 */
const MIN_ENTITY_SPAN = 2
const MAX_ENTITY_SPAN = 6

/**
 * 从对方这一串话里挑出**值得查**的词。
 *
 * ## 判据：图谱里是个实体，且不是我们已经认识的人
 *
 * 挑词不做分词也不猜语义 —— 那需要一个模型，而这一层的价值恰恰在于确定性。
 * 做法是反过来：把候选串拿去图谱的实体表里**对一下**，命中即值得查。
 * 于是"什么算专有名词"这个问题由图谱回答，而不是由一份词表回答。
 *
 * 候选串来自两处，都不需要语言知识：
 * · 连续的非标点片段（CJK 没有空格，所以按标点切）；
 * · 空白分隔的词（拉丁文、产品名、缩写）。
 *
 * ★ 本人与对方的名字**排除掉**：`people.md` 已经按人给了语气，再解释一遍
 * "对话的这个人是谁"是噪声，而且会挤掉真正不认识的那个词。
 */
export function candidateTerms(text: string, exclude: readonly string[]): string[] {
  const excluded = new Set(exclude.filter((name) => name !== ""))
  const out: string[] = []
  const seen = new Set<string>()

  const offer = (raw: string): void => {
    const term = raw.trim()
    if (term === "" || seen.has(term)) return
    seen.add(term)
    const length = [...term].length
    if (length < MIN_TERM_LENGTH || length > MAX_TERM_LENGTH) return
    if (excluded.has(term)) return
    // 纯数字/纯标点不是实体
    if (!/[\p{L}]/u.test(term)) return
    out.push(term)
  }

  // 标点与空白都当分隔符；CJK 与拉丁一视同仁
  for (const piece of text.split(/[\s,，。、！!？?；;：:（）()「」【】[\]"'~…]+/u)) {
    offer(piece)
    for (const word of piece.split(/\s+/u)) offer(word)
    /**
     * ★ 无分词语言还要滑窗切子串。
     *
     * 图谱的 `entitiesByName` 是**精确** `IN (...)` 匹配（与 `ego()` 共用那一条
     * SQL），而无分词语言的一句话里没有空格：一个昵称通常嵌在更长的片段内部。
     * 不滑窗的话那种句子永远匹配不到实体 —— 这一条让整层**静默失效**，
     * 查得到的只剩恰好被标点独立出来的名字。是测试红了才发现的。
     *
     * 只对无分词的书写系统滑窗：有空格的语言上面两步已经切开了，再滑窗只会
     * 造出无意义的子串，白花一次 FTS。
     */
    if (/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(piece)) {
      const chars = [...piece]
      for (let size = MIN_ENTITY_SPAN; size <= MAX_ENTITY_SPAN; size += 1) {
        for (let start = 0; start + size <= chars.length; start += 1) {
          offer(chars.slice(start, start + size).join(""))
        }
      }
    }
  }
  return out
}

/** 图谱那一侧我们要用到的两个只读能力（注入以便测试）。 */
export interface MemorySource {
  /**
   * 名字 → 图谱里的实体；空数组表示没有这个东西。
   *
   * `type` / `mentions` 由查询层原样带出、**在这里**才过滤 —— 见
   * `EXPLAINABLE_TYPES` 与 `MIN_MENTIONS`。
   */
  entitiesByName: (
    names: readonly string[],
  ) => Array<{ name: string; type: string; mentions: number }>
  /**
   * 关于这个词的事实，**限定在这个会话内**；调用方自己按置信度过滤。
   *
   * ★ `conversationExternalId` 不是可选参数。图谱是全库的，而把 A 会话抽出来
   * 的事实塞进 B 会话的提示词，等于让数字人以本人语气说出一段本人在这个会话里
   * 从没说过的话 —— 实测一个同事实体的高置信事实来自 7–11 个不同会话，内容
   * 跨越私聊闲谈与项目进展。与 `mcp/auth.ts` 给 agent 自己的查询硬加 scopeId
   * 是同一条理由：宿主替它查的时候不能把那道闸绕开。
   */
  searchFacts: (
    keyword: string,
    conversationExternalId: string,
  ) => Array<{ text: string; confidence: number }>
}

export interface PersonaMemoryOptions {
  logger: Logger
  /** 图谱不可用时给 null —— 那时 `lookup` 恒返回空数组（降级，不是错误） */
  source: MemorySource | null
}

export class PersonaMemory {
  constructor(private readonly options: PersonaMemoryOptions) {}

  /**
   * 查这一串话里提到的、我们可能不认识的东西。
   *
   * 返回空数组有三种可能，对调用方都一样（提示词里不加这一段）：
   * 图谱不可用、没有候选词、候选词在图谱里都查不到。区分它们没有用 ——
   * 起草的行为完全相同。
   */
  lookup(text: string, exclude: readonly string[], conversationExternalId: string): MemoryHit[] {
    const source = this.options.source
    if (source === null || text.trim() === "" || conversationExternalId === "") return []

    try {
      const terms = candidateTerms(text, exclude)
      if (terms.length === 0) return []

      /**
       * ★ 一次性问图谱"这些词里哪些是实体"，而不是逐个查事实。
       *
       * 逐个查事实是 N 次 FTS，而绝大多数候选词根本不是实体（普通的动词短语、
       * 语气词、滑窗切出来的碎片）。
       * 先用实体表筛一遍，把 FTS 的次数压到"真的可能有记忆"的那几个。
       */
      /**
       * ★ 两道过滤叠加，缺一不可（见两个常量的注释）：
       * · 类型白名单挡"泛化的系统/工具名"（`chat` 那类）；
       * · 提及数下限挡"抽错的一次性片段"。
       */
      const entities = source
        .entitiesByName(terms)
        .filter((row) => EXPLAINABLE_TYPES.has(row.type) && row.mentions >= MIN_MENTIONS)
      if (entities.length === 0) return []

      // 提及数高的先查：那是图谱里"更被谈论"的东西，也更可能是对话真正在说的
      const ranked = [...entities].sort((a, b) => b.mentions - a.mentions).slice(0, MAX_TERMS)

      const hits: MemoryHit[] = []
      for (const entity of ranked) {
        const facts = source
          .searchFacts(entity.name, conversationExternalId)
          .filter((fact) => fact.confidence >= MIN_CONFIDENCE)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, MAX_FACTS_PER_TERM)
          .map((fact) => fact.text)
        // 实体存在但没有够置信的事实 → 不放进提示词。
        // 「图谱里有这个名字」本身不是内容，说不出任何东西。
        if (facts.length > 0) hits.push({ term: entity.name, facts })
      }
      return hits
    } catch (error) {
      /**
       * 查记忆失败**绝不能**让起草失败 —— 它是增强不是前提。
       * 但要记一行：静默降级会让"数字人突然又变笼统了"无从归因。
       */
      this.options.logger.warn("persona memory lookup failed; drafting without it", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }
}
