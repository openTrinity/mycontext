/**
 * 知识图谱的**只读查询层** —— 我们自己的模块，不碰 kl 的子进程管理。
 *
 * ## ★ 为什么单独一个文件，而不是加进 `kl-server.service.ts`
 *
 * 那个文件是 **kl 子进程的 supervisor**（启动/健康轮询/建图/优雅停），
 * 由维护 kl 那条线的人负责 —— 而它的 `graphOverview` 只是顺带读了一次
 * 图库。往里继续堆"我要的查询"有两个具体代价：
 *
 * · **合并冲突**：这一轮已经真实发生过（两边同时改那个文件，
 *   `stash pop` 撞出 UU，还漏出一个重复的 `ipcMain.handle` 注册）；
 * · **职责错位**：进程生命周期与 SQL 查询是两件事，前者失败要重启子进程，
 *   后者失败只该让一个面板降级。
 *
 * 所以这里**直接开图库的只读连接**，与 kl 进程无关 ——
 * 图库是磁盘上的产物，读它不需要 server 在跑（实测建图**期间**也能读，
 * 而那时 kl 的 HTTP 端点在忙）。
 *
 * ## 这一层不做的事
 *
 * 不建图、不起进程、不写图库。只有 SELECT。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import Database from "better-sqlite3"
import type { Logger } from "@mycontext/kernel"
import type { KlGraphEgo, KlGraphFacts, KlGraphFactsInput } from "@mycontext/ipc-contract"
import {
  buildEgoGraph,
  matchSelfEntity,
  type EntityRow,
  type FactChannel,
  type FactEntityLink,
} from "../../renderer/features/graph/ego-graph-data.js"

/**
 * 图库的只读句柄。
 *
 * ★ 抽成接口是为了**能测**：真实现要一个 better-sqlite3 原生模块 + 一个真
 * 图库文件，而我们要验的是"过滤组合对不对""空结果与筛空怎么区分"——
 * 那是纯逻辑，不该被原生模块的 ABI（本仓库反复踩过）绑住。
 */
export interface GraphReadHandle {
  entitiesByName(names: readonly string[]): EntityRow[]
  factLinksAround(entityId: string): FactEntityLink[]
  /**
   * 按提及次数倒序取实体（做 `/facts` 交集时的候选集）。
   *
   * ★ `entities` 表是**真实的** —— 与 `edges` 不同，它不随后端搬家
   * （见 `factLinksAround` 的注释）。所以候选集仍然本地取，只有
   * "这些实体各自参与了哪些 fact"要问 kl。
   */
  allEntities(limit: number): EntityRow[]
  factConversations(factIds: readonly string[]): Array<{ factId: string; conversationId: string }>
  entitiesByIds(ids: readonly string[]): EntityRow[]
  searchFacts(query: {
    since: number | null
    types: readonly string[]
    entityName: string | null
    keyword: string
    limit: number
    offset: number
  }): {
    total: number
    rows: Array<{
      id: string
      text: string
      type: string
      confidence: number
      at: number | null
      entities: string[]
    }>
  }
  close(): void
}

export interface GraphQueryOptions {
  logger: Logger
  /**
   * kl 的数据目录（图库是它下面的 `knowledge.db`）。
   *
   * ## ★ 为什么是**函数**而不是值
   *
   * 它按 vault 分，而 vault 是跟着登录/切身份挂载的 —— 本服务在装配阶段
   * 就构造好了，那一刻还不知道会挂哪个身份。取值的话切身份后 ego 图
   * 读的还是上一个身份的图库，而症状是"换了身份，关系图还是上一个人的"
   * —— 不报错，只是答错。
   *
   * 用 getter 而不是 `rebind()`：本服务每次查询才 `existsSync` + 开一个
   * 只读连接，没有需要维护的状态（与它现有的 `getSelfNames` 惰性取值
   * 同一个形状）。返回空串 = 还没挂载 → 各方法走"图不存在"那条降级。
   */
  dataDir: () => string
  /** 本人在渠道里的显示名 —— ego 图据此在实体表里认出「我」 */
  getSelfNames: () => readonly string[]
  /** `会话 externalId → 渠道 id`，把关系归到 IM 渠道 */
  getChannelByConversation: () => ReadonlyMap<string, string>
  /** 打开图库。注入以便测试 —— 见 `GraphReadHandle` 的注释 */
  openDb?: (path: string) => GraphReadHandle
  /**
   * 问 kl「这个实体参与了哪些 fact」（返回 fact id 集合）。
   *
   * ## ★★★ 为什么关系必须走 kl，而不能读 SQLite 的 `edges`
   *
   * 那张表在**默认后端下按设计恒空**。上游 `storage/base.py` 的
   * `scan_edges_by_type` 注释明写：「on the ladybug backend edges live in
   * LadybugDB and the SQLite `edges` table is empty」，而
   * `config.default.yaml` 里 `KL_GRAPH_BACKEND` 的默认值就是 `ladybug`。
   *
   * 实测同一时刻两个源：
   *
   * ```
   * GET /status → {"graph_backend":"ladybug","sqlite":{"edges":26558}}
   * SELECT COUNT(*) FROM edges  → 0
   * ```
   *
   * 后果是「它认识的人与事」永远空，而文案说「还没抽到你和别人的关联」——
   * 把一个读错源说成了数据没建好，于是引导用户去点「优化图谱」（没有用）。
   *
   * ## 为什么是 `/facts` 而不是别的端点
   *
   * 试过三条，只有这条够用（都是实测）：
   * · `/expand` 只给 `ENTITY_SIMILAR`，不给 `ABOUT`；
   * · `/entity` 给 `ABOUT`（某实体 `degree: 2532`），但上游硬编码
   *   `edges_out[:5]` 截断到 5 条，没有参数能放开；
   * · `/graph_hop` 用 `ent:<uuid>` / `fact:<uuid>` 都返回空，没跟到原因。
   *
   * 所以改成：对每个候选实体问一次 `/facts`，再在本地求**交集**
   * （"我和他出现在同一条 fact 里" = 共现）。实测代价可接受：
   * 41 个高频实体 0.10s；全部 618 个 0.72s（平均 1.2ms/次）。
   *
   * ★ 不给这个回调 = 退回"关系读不到"的降级文案，而**不是**假装没有关系。
   */
  factsOfEntity?: (entityId: string) => Promise<ReadonlySet<string>>
  /**
   * ego 图最多问多少个候选实体。
   *
   * ★ 有上限是因为这是 N 次 HTTP：618 个是 0.72s，可接受；但实体数会随
   * 语料增长，没有上限的话某天它会变成一次十几秒的同步等待。
   * 按 `mention_count` 倒序取，所以砍掉的是最边缘的那些。
   */
  egoCandidateLimit?: number
  /** 现在几点（时间范围过滤要用）。注入让测试可复现 */
  now: () => number
}

const MS_PER_DAY = 86_400_000

/**
 * ego 图默认最多问多少个候选实体。见 `egoCandidateLimit` 的注释。
 *
 * ★ 800 的取法：本机图里 618 个实体，全问一遍实测 0.72s。留一点余量，
 * 但不留到"某天变成十几秒"。
 */
const EGO_CANDIDATE_LIMIT = 800

/**
 * 转义 `LIKE` 的通配符，配合 `ESCAPE '\\'` 使用。
 *
 * ★ 不转义的话用户输入的 `%` 会变成"匹配任意"—— 一个名字里带 `%`
 * 的筛选会返回全部事实，而那看起来像"筛选没生效"。
 * `_` 同理（匹配任意单字符）。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export class GraphQueryService {
  constructor(private readonly options: GraphQueryOptions) {}

  private get dbPath(): string {
    const dir = this.options.dataDir()
    // 未挂载（空串）→ 给一个必然不存在的路径，让 existsSync 走降级分支
    return dir === "" ? "" : join(dir, "knowledge.db")
  }

  /**
   * 以「我」为中心的关系子图。
   *
   * 三步，每一步的失败都**可解释**：图库在不在 → 图里有没有我 →
   * 有没有共现。三种都不是错误，UI 各给一句可行动的话；
   * 合成一个"不可用"会让用户不知道该去建图、确认身份、还是再等等。
   */
  /**
   * 用 kl 的 `/facts` 求交集，拼出 `fact → entity` 关联。
   *
   * ## 做法
   *
   * ① 拿「我」参与的全部 fact id（一次 `/facts`）；
   * ② 对每个候选实体各问一次，与①求交集 —— 交集非空 = 与我共现；
   * ③ 把交集展开成 `{factId, entityId}`，形状与 `factLinksAround` 一致，
   *    于是下游 `buildEgoGraph` 一行都不用改。
   *
   * ★ 「我」自己那一份也要放进结果：`buildEgoGraph` 靠 `self.id` 那些边
   * 认出中心节点，只给邻居的话中心是孤立的。
   *
   * ★ 并发问：618 次串行是 0.72s，而 `Promise.all` 会同时打 618 个连接到
   * 一个本地 uvicorn 上 —— 那个进程同时还在建图。用小批并发（8）折中：
   * 实测串行已经够快，批量只是留一点余量。
   */
  private async linksViaKl(db: GraphReadHandle, selfId: string): Promise<FactEntityLink[]> {
    const factsOf = this.options.factsOfEntity
    if (factsOf === undefined) return []

    const mine = await factsOf(selfId)
    if (mine.size === 0) return []

    const links: FactEntityLink[] = []
    // ★ 中心自己的边（见上面注释：不给的话中心节点是孤立的）
    for (const factId of mine) links.push({ factId, entityId: selfId })

    const limit = this.options.egoCandidateLimit ?? EGO_CANDIDATE_LIMIT
    const candidates = db.allEntities(limit).filter((row) => row.id !== selfId)

    const BATCH = 8
    for (let i = 0; i < candidates.length; i += BATCH) {
      const slice = candidates.slice(i, i + BATCH)
      const sets = await Promise.all(
        slice.map((row) =>
          // ★ 单个实体查失败不该让整张图失败：当成"没有共现"
          factsOf(row.id).catch(() => new Set<string>()),
        ),
      )
      slice.forEach((row, index) => {
        for (const factId of sets[index] ?? new Set<string>()) {
          if (mine.has(factId)) links.push({ factId, entityId: row.id })
        }
      })
    }
    return links
  }

  async ego(): Promise<KlGraphEgo> {
    const empty = (reason: string): KlGraphEgo => ({
      available: false,
      reason,
      self: null,
      nodes: [],
      edges: [],
    })

    if (!existsSync(this.dbPath)) {
      return empty("还没建过图（点「重新建图」开始，它会出网）")
    }
    const selfNames = this.options.getSelfNames()
    if (selfNames.length === 0) {
      return empty("还不知道你在钉钉里叫什么 —— 先在设置里确认本人身份")
    }

    let db: GraphReadHandle | null = null
    try {
      db = (this.options.openDb ?? openGraphReadDb)(this.dbPath)
      const self = matchSelfEntity(db.entitiesByName(selfNames), selfNames)
      if (self === null) {
        return empty("图里还没有你 —— 可能是这一轮建图没覆盖到你发言的会话")
      }

      /**
       * ★★★ 关系优先问 kl，SQLite 只作兜底。
       *
       * `factLinksAround` 读的 `edges` 表在默认后端（ladybug）下恒空 ——
       * 完整推理见 `factsOfEntity` 的注释。所以这里的顺序是刻意的：
       * ① 有 `factsOfEntity` → 走交集（真实关系）；
       * ② 没有（未注入 / kl 没起来）→ 退回 SQLite，它**可能**是空的，
       *    那时下面的文案要说清"读不到"而不是"没有"。
       */
      const links =
        this.options.factsOfEntity === undefined
          ? db.factLinksAround(self.id)
          : await this.linksViaKl(db, self.id)

      if (links.length === 0) {
        /**
         * ★★ 两种"空"要说不同的话。
         *
         * · 走过 kl 还是空 → 真的没抽到关联，指向「优化图谱」是对的；
         * · 没走 kl（读的是那张恒空表）→ 说"没抽到"就是**假话**。
         *   那时要说清是我们读不到，且指出 kl 没起来这个真实原因 ——
         *   否则用户会去点优化图谱，而那不会有任何帮助。
         */
        return empty(
          this.options.factsOfEntity === undefined
            ? "关系数据要图谱服务在运行才能读到 —— 稍等它起来，或在设置里看它的状态"
            : "还没抽到你和别人的关联（图刚建好时可能要再跑一次「优化图谱」）",
        )
      }

      const factIds = [...new Set(links.map((l) => l.factId))]
      const channelByConversation = this.options.getChannelByConversation()
      const factChannels: FactChannel[] = db
        .factConversations(factIds)
        .map((row) => ({
          factId: row.factId,
          channelId: channelByConversation.get(row.conversationId) ?? "",
        }))
        // 对不上渠道的丢掉：宁可少一个描边，也不要标一个错的渠道
        .filter((row) => row.channelId !== "")

      const entityIds = [...new Set(links.map((l) => l.entityId))]
      const entityById = new Map(db.entitiesByIds(entityIds).map((row) => [row.id, row]))

      const graph = buildEgoGraph({ self, links, entityById, factChannels })
      // ★ 只记数量，不记名字（实体名是真实人名）
      this.options.logger.info("graph ego built", {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        facts: factIds.length,
      })
      return { available: true, reason: null, ...graph }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn("read graph ego failed", { detail })
      return empty(`读图谱失败：${detail}`)
    } finally {
      try {
        db?.close()
      } catch {
        // 只读连接，关不掉无需处理
      }
    }
  }

  /**
   * 带过滤的事实检索。
   *
   * ## ★ 「一条都没有」与「筛掉了」必须分开
   *
   * 图里有 6663 条事实。用户筛完看到空列表时，他要知道的是
   * "我筛得太窄了"还是"这个图本来就是空的" —— 两者的下一步完全不同
   * （放宽条件 vs 去建图）。所以 `total === 0` 时的 `reason` 分两种，
   * 判据是"有没有筛选条件"。
   */
  /**
   * 这些名字里，哪些在图谱里真的是实体。
   *
   * ## 为什么单独暴露一个方法
   *
   * 数字人的记忆检索要先筛"哪个词值得查事实"（见 `persona-memory.ts`）：
   * 逐个查事实是 N 次 FTS，而绝大多数候选词根本不是实体。这一步用实体表
   * 把次数压到真的可能有记忆的那几个。
   *
   * 与 `ego()` 用的是**同一个** `entitiesByName` —— 那里也是靠它在实体表里
   * 认出「我」。复用而不是新写一条 SQL：两处对"名字怎么匹配"的理解必须一致，
   * 否则 ego 图认得的人、记忆检索却认不得。
   *
   * 图库不存在时返回空数组（降级）：调用方据此不加记忆段，起草照常。
   */
  entities(names: readonly string[]): Array<{ name: string; type: string; mentions: number }> {
    if (names.length === 0 || !existsSync(this.dbPath)) return []
    let db: GraphReadHandle | null = null
    try {
      db = (this.options.openDb ?? openGraphReadDb)(this.dbPath)
      /**
       * ★ 带上 `type` 与 `mentions`，**不在这一层过滤**。
       *
       * "哪种实体值得解释"是消费方的判据，不是查询层的：ego 图与事实面板
       * 都需要看到 System 实体（那是它们的正当内容），而记忆检索不需要。
       * 把白名单写在这里会让那两处一起瞎掉。
       *
       * ★ 分批，与 `factConversations` / `entitiesByIds` 同一个理由：SQLite 的
       * 绑定变量上限是 999（better-sqlite3 硬上限 32766）。这里的输入不是
       * "几个词"而是**滑窗切出来的全部候选** —— 一条 30 条消息的批次很容易
       * 产出上千个（实测数百字中文即近千个）。不分批的话 `PersonaMemory.lookup`
       * 的 catch 会把 `SqliteError` 吞掉、返回空数组，也就是**消息越长记忆越
       * 可能静默消失**，而那正是这一层要修的那个失效。
       */
      const out: Array<{ name: string; type: string; mentions: number }> = []
      for (let i = 0; i < names.length; i += CHUNK) {
        out.push(
          ...db
            .entitiesByName(names.slice(i, i + CHUNK))
            .map((row) => ({ name: row.name, type: row.type, mentions: row.mentions })),
        )
      }
      return out
    } catch (error) {
      this.options.logger.warn("graph entity lookup failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return []
    } finally {
      db?.close()
    }
  }

  /**
   * 某个关键词的事实，**限定在一个会话内**。
   *
   * ## ★ 为什么记忆检索必须限会话
   *
   * `facts()` 是全库检索 —— 那是事实面板的正当定义（用户在翻自己的全部记录）。
   * 但数字人起草是另一回事：把 A 会话抽出来的事实塞进 B 会话的提示词，
   * 等于让它**以本人的语气说出一段本人在这个会话里从没说过的话**。
   *
   * 实测规模说明这不是理论风险：一个同事实体的高置信事实来自 7–11 个不同会话，
   * 内容跨越私聊闲谈与项目进展。不限会话时，私聊里提一句同事的名字，
   * 草稿就可能复述那个人在别的群里的项目状态。
   *
   * 这也是 `mcp/auth.ts` 为 agent 自己的查询硬加 `scopeId` 的同一条理由 ——
   * 宿主替它查的时候不能把那道闸绕开。
   *
   * 判据取 `STATES` 边（fact → 它的来源消息）所在的会话，与
   * `factConversations` 用的是同一条关系。
   */
  factsInConversation(
    keyword: string,
    conversationExternalId: string,
    limit: number,
  ): Array<{ text: string; confidence: number }> {
    if (keyword === "" || conversationExternalId === "" || !existsSync(this.dbPath)) return []
    let db: GraphReadHandle | null = null
    try {
      db = (this.options.openDb ?? openGraphReadDb)(this.dbPath)
      /**
       * 多取一些再按会话筛：`searchFacts` 的 limit 是在 SQL 里生效的，
       * 而"这条事实属于哪个会话"要再查一次边。取 limit 的若干倍是为了让
       * 筛完还剩得下 —— 全取会让一个高频实体拉回上百条。
       */
      const candidates = db.searchFacts({
        since: null,
        types: [],
        entityName: null,
        keyword,
        limit: limit * SCOPED_FACT_OVERFETCH,
        offset: 0,
      }).rows
      if (candidates.length === 0) return []
      const inScope = new Set(
        db
          .factConversations(candidates.map((row) => row.id))
          .filter((row) => row.conversationId === conversationExternalId)
          .map((row) => row.factId),
      )
      return candidates
        .filter((row) => inScope.has(row.id))
        .slice(0, limit)
        .map((row) => ({ text: row.text, confidence: row.confidence }))
    } catch (error) {
      this.options.logger.warn("scoped graph fact lookup failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return []
    } finally {
      db?.close()
    }
  }

  facts(input: KlGraphFactsInput): KlGraphFacts {
    const empty = (reason: string): KlGraphFacts => ({
      available: false,
      reason,
      total: 0,
      facts: [],
    })
    if (!existsSync(this.dbPath)) {
      return empty("还没建过图（点「重新建图」开始，它会出网）")
    }

    let db: GraphReadHandle | null = null
    try {
      db = (this.options.openDb ?? openGraphReadDb)(this.dbPath)
      const since = input.days === null ? null : this.options.now() - input.days * MS_PER_DAY
      const result = db.searchFacts({
        since,
        types: input.types,
        entityName: input.entityName,
        keyword: input.keyword,
        limit: input.limit,
        offset: input.offset,
      })

      /**
       * 空结果的两种解释。
       *
       * `filtered` = 用户加了任何一个条件。加了 → "当前筛选下没有"（可放宽）；
       * 没加而仍然是 0 → 图本身是空的（去建图）。
       */
      const filtered =
        input.days !== null ||
        input.types.length > 0 ||
        (input.entityName !== null && input.entityName !== "") ||
        input.keyword.trim() !== ""
      const reason =
        result.total > 0
          ? null
          : filtered
            ? "当前筛选下没有事实 —— 试试放宽时间范围或去掉关键词"
            : "图里还没有事实（建图的抽取阶段可能没跑完）"

      // ★ 日志里只有条数，没有正文（那是真实聊天内容）
      this.options.logger.debug("graph facts queried", {
        total: result.total,
        returned: result.rows.length,
        hasKeyword: input.keyword.trim() !== "",
      })
      return { available: true, reason, total: result.total, facts: result.rows }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn("read graph facts failed", { detail })
      return empty(`读图谱失败：${detail}`)
    } finally {
      try {
        db?.close()
      } catch {
        // 同上
      }
    }
  }
}

/** SQLite 的绑定变量上限（默认 999）。分批查按它留裕量。 */
const CHUNK = 400

/**
 * 限会话检索时先多取几倍。
 *
 * 会话归属要在拿到候选之后再查一次边，所以 SQL 的 limit 挡不住"筛完不够"。
 * 5 倍是取舍：太小会让常见实体在本会话里的事实被别会话的挤掉，太大则把一个
 * 高频实体的上百条事实都拉回来再扔掉。
 */
const SCOPED_FACT_OVERFETCH = 5

/**
 * 真实现：只读打开图库。
 *
 * `fileMustExist` —— 缺文件时抛而不是建一个空库：后者会让"还没建图"
 * 这个状态从此消失（文件存在了，但每张表都是 0 行）。
 */
export function openGraphReadDb(path: string): GraphReadHandle {
  const db = new Database(path, { readonly: true, fileMustExist: true })

  const entityRows = (rows: unknown[]): EntityRow[] =>
    (rows as Array<{ id: string; name: string; type: string | null; mentions: number | null }>).map(
      (r) => ({ id: r.id, name: r.name, type: r.type ?? "Unknown", mentions: r.mentions ?? 0 }),
    )

  return {
    entitiesByName: (names) => {
      if (names.length === 0) return []
      const holes = names.map(() => "?").join(",")
      return entityRows(
        db
          .prepare(
            `SELECT id, name, entity_type AS type, mention_count AS mentions
               FROM entities WHERE name IN (${holes}) ORDER BY mention_count DESC`,
          )
          .all(...names),
      )
    },

    allEntities: (limit) =>
      entityRows(
        db
          .prepare(
            `SELECT id, name, entity_type AS type, mention_count AS mentions
               FROM entities ORDER BY mention_count DESC LIMIT ?`,
          )
          .all(limit),
      ),

    factLinksAround: (entityId) => {
      /**
       * 两步一句：先找"关于我"的 fact，再取那些 fact 的**全部** ABOUT 关联
       * —— 共现（我+他同一条 fact）与二跳（两个邻居同一条）都靠后者。
       *
       * `edges` 上有 UNIQUE(source_type, source_id, target_type, target_id,
       * edge_type)，所以这个 join 不会重复放大。
       */
      return db
        .prepare(
          `WITH mine AS (
             SELECT source_id AS fid FROM edges
              WHERE edge_type = 'ABOUT' AND source_type = 'fact'
                AND target_type = 'entity' AND target_id = ?
           )
           SELECT e.source_id AS factId, e.target_id AS entityId
             FROM edges e JOIN mine ON mine.fid = e.source_id
            WHERE e.edge_type = 'ABOUT' AND e.source_type = 'fact'
              AND e.target_type = 'entity'`,
        )
        .all(entityId) as FactEntityLink[]
    },

    factConversations: (factIds) => {
      if (factIds.length === 0) return []
      /**
       * ★ 分批：实测"我"参与的 fact 有几百条，而 SQLite 的绑定变量上限
       * 是 999 —— 撞上会抛错，而那时整个面板降级，为了一个纯实现细节。
       */
      /**
       * ★★★ 走 `facts.source_chunk_id → chunks.metadata.conversation_id`，
       * **不走** `STATES` 边。
       *
       * 原来那句 join 的是 `edges`，而那张表在默认后端（ladybug）下按设计
       * 恒空（上游 `kl_graph/storage/base.py:446` 明写，而
       * `config.default.yaml:39` 的 `KL_GRAPH_BACKEND` 默认就是 ladybug）。
       * 于是渠道描边永远拿不到 —— 表现是 ego 图画得出来但**一条描边都没有**，
       * 而那看起来像"渠道对不上"（注释里原本就这么解释的），
       * 实际上是我们查了一张空表。
       *
       * ★ 新判据的两段都在**真实**的表里：
       * · `facts.source_chunk_id` 是 facts 表的列（实测有值，形如
       *   `dingtalk:<uuid>`）；
       * · `chunks.metadata` 是 JSON，里面有 `conversation_id`
       *   （实测键齐全：conversation_id / senders / chat_kind …）。
       *
       * 用 SQLite 的 `json_extract` 而不是取回来在 JS 里解：metadata 里还有
       * `member_message_ids` / `senders` 这些**聊天内容相关**的字段，
       * 整段取回等于把它们搬进进程内存 —— 只要那一个值就够。
       */
      const out: Array<{ factId: string; conversationId: string }> = []
      for (let i = 0; i < factIds.length; i += CHUNK) {
        const slice = factIds.slice(i, i + CHUNK)
        const holes = slice.map(() => "?").join(",")
        out.push(
          ...(db
            .prepare(
              /**
               * ★★ `substr(..., instr(...) + 1)` 是在**剥掉来源前缀**。
               *
               * kl 侧的 `conversation_id` 形如 `<source>:<外部会话 id>`
               * （实测 56 字符，冒号前是来源名），而我们 `conversations`
               * 表里的 `external_id` 是**裸的**那一段（实测 27 / 47 字符）。
               * 不剥的话一条都对不上 —— 而对不上的表现是"图画得出来但没有
               * 任何渠道描边"，看起来像渠道字段缺失。
               *
               * 实测剥掉之后 61/61 全部对上。
               *
               * ★ 没有冒号时 `instr` 返回 0 → `substr(x, 1)` = 原串，
               * 也就是"没有前缀"这种形态自然退化成直接用，不用额外分支。
               */
              `SELECT f.id AS factId,
                      substr(
                        json_extract(c.metadata, '$.conversation_id'),
                        instr(json_extract(c.metadata, '$.conversation_id'), ':') + 1
                      ) AS conversationId
                 FROM facts f JOIN chunks c ON c.id = f.source_chunk_id
                WHERE f.id IN (${holes})
                  AND json_extract(c.metadata, '$.conversation_id') IS NOT NULL`,
            )
            .all(...slice) as Array<{ factId: string; conversationId: string }>),
        )
      }
      return out
    },

    entitiesByIds: (ids) => {
      if (ids.length === 0) return []
      const out: EntityRow[] = []
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK)
        const holes = slice.map(() => "?").join(",")
        out.push(
          ...entityRows(
            db
              .prepare(
                `SELECT id, name, entity_type AS type, mention_count AS mentions
                   FROM entities WHERE id IN (${holes})`,
              )
              .all(...slice),
          ),
        )
      }
      return out
    },

    searchFacts: (query) => {
      /**
       * ★ 关键词当成**短语**送进 FTS，而不是原样拼进 MATCH。
       *
       * `facts_fts` 是 fts5，MATCH 吃的是**查询语法**而不是纯文本 ——
       * 用户输入里的 `"` / `*` / `NEAR(` 都有语法含义。实测原样传：
       *   `a"b`   → `unterminated string`（抛错 → 整面板降级）
       *   `NEAR(` → `fts5: syntax error`
       *   `*`     → `unknown special query`
       *
       * 而这些字符用户随手就打得出来。包成 `"…"`（内部 `"` 翻倍）之后，
       * 同样这三个输入分别得到 2 / 0 / 0 条 —— 语法字符成了字面量。
       *
       * ⚠️ 这**不能**用绑定参数替代：绑定防的是 SQL 注入，
       * 而这里的注入面是 **FTS 查询语法**（值本身就是一段表达式）。
       * 两者都要：值走绑定 + 内容短语化。
       */
      const wheres: string[] = []
      const params: Array<string | number> = []

      if (query.keyword.trim() !== "") {
        wheres.push("f.id IN (SELECT id FROM facts_fts WHERE facts_fts MATCH ?)")
        params.push(`"${query.keyword.replace(/"/g, '""')}"`)
      }
      if (query.since !== null) {
        wheres.push("f.timestamp >= ?")
        params.push(query.since)
      }
      if (query.types.length > 0) {
        wheres.push(`f.fact_type IN (${query.types.map(() => "?").join(",")})`)
        params.push(...query.types)
      }
      if (query.entityName !== null && query.entityName !== "") {
        /**
         * ★★★ 按实体筛：判据是 **fact 正文包含这个名字**，而不是查 `ABOUT` 边。
         *
         * ## 原来那句 SQL 恒返 0 条
         *
         * 它写的是 `EXISTS (SELECT 1 FROM edges ... edge_type='ABOUT' ...)`，
         * 而那张表在默认后端（ladybug）下**按设计恒空** —— 上游
         * `kl_graph/storage/base.py:446` 明写「on the ladybug backend edges
         * live in LadybugDB and the SQLite `edges` table is empty」，
         * 而 `config.default.yaml:39` 的 `KL_GRAPH_BACKEND` 默认就是 ladybug。
         *
         * 于是这是一个**只会排除、永不匹配**的筛选器：一旦填了实体名，
         * 结果恒为 0 条，界面显示"没有匹配的事实"—— 看起来像真的没有。
         *
         * ## 为什么这里用正文匹配而不是像 ego 图那样问 kl
         *
         * 这个方法是**同步**的（`facts()` 不返回 Promise，界面上是随打随筛），
         * 而问 kl 是异步的。改成异步要动 IPC 契约与渲染层的筛选交互，
         * 那比这个 bug 本身大得多。
         *
         * ★ 正文匹配的**代价必须说清**：fact 正文里出现名字 ≈ 这条事实在说他，
         * 但不严格等价 —— 同名的人会混进来，而只在 `involved_entities` 里
         * 出现却没写进正文的会漏。实测本人花名：正文匹配 193 条、
         * kl 的真实关联 265 条，也就是**会漏约 27%**。
         *
         * 这个取舍是刻意的：一个偏松的筛选器 vs 一个恒为空的筛选器 ——
         * 后者是纯粹的谎。真要严格的话得等上游给批量 `fact_ids → entities`
         * 的口（已提需求），那时把这里换掉。
         */
        wheres.push("f.text LIKE ? ESCAPE '\\'")
        params.push(`%${escapeLike(query.entityName)}%`)
      }
      const where = wheres.length === 0 ? "" : `WHERE ${wheres.join(" AND ")}`

      const total =
        (
          db.prepare(`SELECT COUNT(*) AS c FROM facts f ${where}`).get(...params) as
            | { c: number }
            | undefined
        )?.c ?? 0

      const rows = db
        .prepare(
          `SELECT f.id, f.text, f.fact_type AS type, f.confidence, f.timestamp AS at
             FROM facts f ${where}
            ORDER BY f.timestamp DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, query.limit, query.offset) as Array<{
        id: string
        text: string
        type: string | null
        confidence: number | null
        at: number | null
      }>

      /**
       * 每条事实"在说谁" —— 一次批量取，不逐条查。
       * 每条上限 4 个：实测一条 fact 通常关联 1-2 个实体，
       * 4 个够而且不会把列表行撑开。
       *
       * ## ★★ 这里读 `edges` 是**已知会拿到空**的
       *
       * 那张表在默认后端（ladybug）下按设计恒空（见上面按实体筛那段的
       * 完整推理）。所以这些标签当前**总是空的** —— 但留着这段查询是对的：
       * ① 后端配成 `sqlite`（`KL_GRAPH_BACKEND=sqlite`）时它就有值；
       * ② 空数组是无害的降级（列表行少一排标签），不会说假话。
       *
       * ★ 与"按实体筛"不同：那个是**筛选器**，恒空意味着恒返 0 条
       * （一个只会排除的筛选器 = 谎），所以必须换判据。而这个只是**装饰**，
       * 没有就不显示，不会误导任何判断。两者的处理方式因此不同。
       */
      const ids = rows.map((r) => r.id)
      const nameByFact = new Map<string, string[]>()
      if (ids.length > 0) {
        const links = db
          .prepare(
            `SELECT e.source_id AS factId, en.name AS name
               FROM edges e JOIN entities en ON en.id = e.target_id
              WHERE e.edge_type = 'ABOUT' AND e.source_type = 'fact'
                AND e.source_id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as Array<{ factId: string; name: string }>
        for (const link of links) {
          const list = nameByFact.get(link.factId)
          if (list === undefined) nameByFact.set(link.factId, [link.name])
          else if (list.length < 4) list.push(link.name)
        }
      }

      return {
        total,
        rows: rows.map((r) => ({
          id: r.id,
          text: r.text,
          type: r.type ?? "GENERAL",
          confidence: r.confidence ?? 0,
          at: r.at ?? null,
          entities: nameByFact.get(r.id) ?? [],
        })),
      }
    },

    close: () => db.close(),
  }
}
