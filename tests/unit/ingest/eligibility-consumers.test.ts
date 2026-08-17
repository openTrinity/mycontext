/**
 * **消费者按标签取自己那一段** + 两个"不许加标签闸"的反面判据（v4 阶段 D）。
 *
 * ## 这个文件与 `eligibility-tagging.test.ts` 的分工
 *
 * 那个文件锁**写侧**（打标、只增不减、NULL 三态）。
 * 这个文件锁**读侧**：谁按标签取、谁**不许**按标签取、以及那两个
 * 输入是"整张表"的消费者（changelog 上的过滤对它们无效）。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { CONSUMERS } from "@mycontext/ingest"
import { DISTILL_CONSUMER_ID } from "@mycontext/distill"
import { FTS_CONSUMER_ID } from "@mycontext/ingest"
import { GRAPH_SYNC_CONSUMER_ID } from "@mycontext/knowledge-feed"
import { PERSONA_CONSUMER_ID } from "@mycontext/persona"

describe("★★★ 声明：谁按学习标签取，谁不按", () => {
  it('★★★ 学习侧那几个消费者 `requires: "learning"`', () => {
    const by = new Map(CONSUMERS.map((spec) => [spec.id, spec]))
    expect(by.get(FTS_CONSUMER_ID)?.requires).toBe("learning")
    expect(by.get(DISTILL_CONSUMER_ID)?.requires).toBe("learning")
    expect(by.get(GRAPH_SYNC_CONSUMER_ID)?.requires).toBe("learning")
  })

  it("★★★ 分身是 `requires: null` —— 它**不许**有标签闸（§6.2 那个洞）", () => {
    /**
     * ## 为什么不能给分身一个 `attention_eligible` 标签
     *
     * 想过，不行 —— 两个范围的**性质**不同：
     *
     * | | 学习范围 | 监听范围 |
     * |---|---|---|
     * | 能怎么变 | **只增不减** | ★ **可以关掉**；`enabled_at` 只能变早 |
     * | 标签过期的方向 | 只往"更严"漂 → **安全** | ★ **两个方向都漂** |
     * | 漂错的现象 | 放宽了但暂时没学（下一轮补上） | ★ 「我关了它还在回消息」 |
     *
     * 最后那一格是用户**看得见的错误行为**，而一个落库那刻的快照挡不住它：
     * 消息入库时那个会话还开着 → 标 1 → 用户关掉 → 标签还是 1
     * → 分身照常起草。
     *
     * 所以监听那侧的判据必须是 `AttentionRouter`（读 `attention_scope`
     * 的**当前值**）、每条现判。
     *
     * ★ 而 `requires: null` 还有第二重意思：分身要看到
     * `learning_eligible = 0` 的消息（那些正是它盯着的那个群的新消息）。
     * 给它任何标签闸都会把它自己要的数据挡掉。
     *
     * 反证：把它改成 `"learning"` 或加一个 `"attention"` → 这条转红。
     */
    const persona = CONSUMERS.find((spec) => spec.id === PERSONA_CONSUMER_ID)
    expect(persona?.requires).toBeNull()
    // ★ 而它的范围判定走**路由**（每条现判），那一条不能同时消失
    expect(persona?.routed).toBe(true)
  })

  it("★★ `requires` 只有两种取值（不许悄悄多一个 `attention`）", () => {
    /**
     * 判据放在**全表**上而不只是分身那一行：加一个 `"attention"` 取值的人
     * 多半会加在别的消费者上，而后果同形（一个挡不住它声称要挡的东西的闸）。
     */
    for (const spec of CONSUMERS) {
      expect([null, "learning"]).toContain(spec.requires)
    }
  })
})

describe("★★★ 输入是「整张表」的那两个消费者：changelog 上的过滤对它们无效", () => {
  /**
   * ## 为什么要专门一组源码断言
   *
   * `requires` 让消费者从 changelog 取自己那一段。但这两个的输入是**表**：
   *
   * · `graph-export` —— 全量重导 `records.jsonl` 四件套；
   * · `forge pull` —— 按时间窗投影 `messages`。
   *
   * 它们只用一个 seq 判"要不要重导"，那一趟**压根不看 changelog 的内容**。
   * 所以标签必须在**它们自己的 SQL** 里 —— 而那正是 v4 §5.4 的 B 位，
   * 设计文档标的"漏掉后果最具体"的那一处：
   *
   *   `learning_eligible = 0` 的行被写进四件套 → 进图谱 → 进画像。
   *   **那是超范围，而且不报错。**
   */
  it("★★★ 共用谓词里有 `learning_eligible`（两侧都靠它）", () => {
    const src = readFileSync("packages/store/src/corpus-predicate.ts", "utf8")
    expect(src).toContain("learning_eligible IS NOT 0")
    /**
     * ★★★ 必须是 `IS NOT 0` 而**不是** `= 1`。
     *
     * 两者对 1 / 0 行为相同，**只在 NULL 上分岔** —— 而存量库里每一行
     * 都是 NULL（v30 只加列、不回填）。写成 `= 1` 的后果是存量用户下一轮
     * 重导得到一份**空**的四件套 → 图谱与画像清空，且不报错。
     *
     * 反证：把谓词改成 `learning_eligible = 1` → 这条转红
     * （而行为那一条在 `corpus-parity.test.ts` 里也会转红）。
     */
    expect(src).not.toContain("learning_eligible = 1")
  })

  it("★★★ `graph-export` 的物化查询拼的是共用谓词（不是自己手写一份）", () => {
    /**
     * 判据是"它引用那个常量"，而不是"它的 SQL 里有 learning_eligible" ——
     * 后者允许它手写一份，而手写的那份会与 forge 那侧漂
     * （`corpus-predicate.ts` 的文件头记着这件事已经真的发生过一次）。
     */
    const src = readFileSync("packages/knowledge-feed/src/export-materializer.ts", "utf8")
    expect(src).toContain("CORPUS_MESSAGE_PREDICATE")
  })

  it("★★★ forge 那侧的语料查询同样拼共用谓词", () => {
    const src = readFileSync("packages/store/src/repositories/messages.ts", "utf8")
    // `distillableInWindow` 是 forge pull 的那条查询
    const at = src.indexOf("distillableInWindow(")
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 2000)).toContain("CORPUS_MESSAGE_PREDICATE")
  })
})

describe("★★★ 清理的判据是采集面，不是学习范围", () => {
  it("★★★ `applyScopeChange` 传的是 `collectionRequest()`", () => {
    /**
     * ## 漏掉这一条的后果是**真删数据**
     *
     * DWD 只打标不筛行之后，库里**故意**留着「只因监听而入库的」那些行
     * —— 而它们本来就不在学习白名单里。拿学习范围当清理判据会把它们
     * 判成"越界"并真删（连带 FTS / 向量 / 媒体文件）：
     *
     *   用户监听的那个群 → 每保存一次范围就被清空一次 → 分身失去上下文
     *
     * 而它不报错。
     *
     * ★ 类型上也拦住了（`PurgeCriterion` 要求 `attentionOnly`，
     * `CollectionScope` 没有这个字段），所以这条断言是**第二道**门 ——
     * 它锁的是"将来有人给 CollectionScope 补上那个字段"之后仍然不许传错。
     */
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    const at = src.indexOf("applyScopeChange(options:")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, at + 1800)
    expect(body).toContain("this.collectionRequest()")
    /**
     * ★ 判据是"**赋值**给传下去的那个变量"，不是"函数体里不许提这个名字"。
     *
     * 后者刚才把这个用例本身弄红了 —— 因为那一处的注释正在解释
     * "原来是 collectionScope，为什么必须换"。**一条禁止提及某个名字的
     * 判据会逼人删掉解释**，而那段解释恰恰是防止有人改回去的东西。
     */
    expect(body).not.toContain("= this.collectionScope()")
  })

  it("★★ 那个脚本走同一份判据（它是在**真库**上跑的）", () => {
    /**
     * 脚本自己抄一份判据的话，产品里那道闸写对了它照样能删错 ——
     * 而它删的是真实聊天记录，不可逆。
     */
    const src = readFileSync("scripts/purge-scope-entry.ts", "utf8")
    expect(src).toContain("readCollectionRequest(")
    expect(src).not.toContain("readCollectionScope(")
  })
})
