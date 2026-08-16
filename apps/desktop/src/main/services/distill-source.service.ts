/**
 * 蒸馏资料源服务：用户的选择 + 可选会话列表。
 *
 * ## 为什么会话列表要走渠道 CLI 而不是读我们自己的 conversations 表
 *
 * 两者答的不是同一个问题：
 * · `conversations` 表 = **已经采过消息**的会话（受时间窗限制，可能只有一部分）；
 * · `chat list-all-conversations` = 用户**能看到的全部**会话（含从没采过的）。
 *
 * 选蒸馏范围时需要后者 —— 否则"还没采过的群"根本不会出现在选项里，
 * 而用户想蒸馏的恰恰可能是那个群。
 *
 * 但也**合并**表里的信息：已采过的会话能显示真实的最后消息时间与条数，
 * 那是判断"这个群值不值得蒸馏"的主要依据。
 *
 * ★ 而且渠道那一路**拿不全**：钉钉的 `list-all-conversations` 分页是坏的
 * （`--cursor` 无效 / `--limit` 硬顶 100 / `hasMore` 恒 false，三条都实测过，
 * 见 channels/plugins/dingtalk/conversations.ts 文件头）。所以本地表不只是
 * "补充信息"，它还补**渠道列不出来的会话** —— 实测本地有 11 个是渠道侧
 * 没返回的。两边都不全，合起来才够用，而剩下的不确定性靠 `truncated` 上报。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import { AppError } from "@mycontext/kernel"
import type { ChannelPlugin } from "@mycontext/channels"
import {
  AttentionCoverageRepository,
  AttentionScopeRepository,
  ChatCoverageRepository,
  DocumentCoverageRepository,
  DocumentRepository,
  MinutesCoverageRepository,
  ConversationRepository,
  DistillSourceRepository,
  SettingsRepository,
  toDayBucket,
  DISTILL_SOURCE_KINDS,
  type DistillScope,
  type DistillSourceKind,
  type SqliteDatabase,
} from "@mycontext/store"
import type {
  AttentionScopeView,
  AttentionScopeSaveInput,
  AttentionScopeDisableInput,
  ChatCoverageInput,
  ChatCoverageView,
  ChannelConversationListView,
  ChannelConversationSourceView,
  ChannelConversationView,
  DistillScopeInput,
  DistillSourceView,
  DocumentSpacesInput,
  DocumentSpacesView,
} from "@mycontext/ipc-contract"

/**
 * 采集器**已接入**的源。
 *
 * ★ 这张表必须诚实：`chat` 与 `minutes` 是真的打通并实测过的
 * （9541 条消息 / 20 条听记落库），其余七类只有 UI 选项与存储。
 *
 * 不标的话用户勾了"邮箱"却永远等不到数据，而且**不会报错** ——
 * 那正是这个项目里反复出现的那类静默失败。
 *
 * ## ★ 其余七类不是"渠道不支持"，是**我们还没写采集器**
 *
 * 逐个查过 DWS 的 reference，只读命令都存在：
 * · `doc` —— ✅ **已接**（`drive recent` + `wiki space/node list` 列举 →
 *   `doc read --node` 取 Markdown 正文）。曾被判成"做不到"，因为消息里的
 *   `fileId` 与 `doc read` 要的 `--node` 不是同一套 ID —— 但**不必从 fileId
 *   反查**，drive/wiki 的列举直接给 `nodeId`（见 documents.ts 文件头）。
 * · `mail` —— `mail folder list` / `mail contact list` / `attachment list`
 * · `calendar` —— `calendar list` / `event get` / `book list`
 * · `todo` —— `todo task list` / `task get` / `comment list`
 * · `attendance` —— `attendance approve list` / `class search` 等
 * · `ding` —— `ding message list`
 * · `drive` —— `drive list` / `drive search` / `drive download`
 *
 * 所以 UI 文案是「排期中」而不是「未接入」：后者读起来像"这个渠道
 * 做不到"，而事实是我们的采集器还没写。这个区别对用户有意义 ——
 * 前者他只能放弃，后者他知道勾上的选择会被记住。
 */
const READY_SOURCES: ReadonlySet<DistillSourceKind> = new Set(["chat", "minutes", "doc"])

/**
 * 某个域的**分区粒度**（给界面换量词用）。
 *
 * ★ 提成纯函数而不是在三处 return 里各写一个字面量：那三处会漂，
 * 而漂的表现是界面上"还有 3 个会话没齐"出现在文档那一行 ——
 * 数字对、量词错，而没有任何东西会报错。
 */
function partitionKindOf(domain: "chat" | "minutes" | "doc"): "conversation" | "space" | null {
  if (domain === "chat") return "conversation"
  if (domain === "doc") return "space"
  // ★ 听记是全量列举，没有分区概念 —— null 而不是编一个（见 G15）
  return null
}

/** 采集器状态。见 `READY_SOURCES` 上方那段。 */
function statusOf(kind: DistillSourceKind): "ready" | "planned" {
  return READY_SOURCES.has(kind) ? "ready" : "planned"
}

export interface DistillSourceServiceOptions {
  clock: Clock
  logger: Logger
  plugin: ChannelPlugin
  /**
   * 其余渠道的插件（会话列举用）。★ **函数**：它们由
   * `ChannelPipelineManager` 在登录后才挂上，装配这一刻还不知道有哪些。
   */
  sourcePlugins?: () => readonly ChannelPlugin[]
  /**
   * 主渠道的 id —— `save()` 用它判"这次要写主库还是某个渠道库"。
   *
   * ★ 不从 `plugin.meta.id` 取：那个语义是"这一层默认操作哪个插件"，
   * 而这里要的是"哪个 channelId 对应主库"。两者今天同值，但把它写成
   * 一个显式参数之后，`save()` 的判据就不依赖另一个字段的巧合。
   */
  primaryChannelId: string
  /**
   * 用户改了采集范围之后的回调（清越界语料 + 重建图谱，装配处注入）。
   *
   * ★ 为什么是回调而不是在这里做：清语料要碰 `DataPlaneService`、
   * 删媒体字节要碰文件系统、重建图谱要碰 `KlServerService` —— 这一层
   * 只管 `distill_sources` 那张表。把那三件事塞进来等于让一个配置读写
   * 服务持有半个应用。
   *
   * ## ★★★ 必须带 `channelId`
   *
   * 它原来是无参的，而接线那侧（`startup.ts` 的 `onScopeChanged`）只能对
   * **主渠道**动手：`dataPlane.applyScopeChange()` / `feed.export()` /
   * `klServer.rebuildGraph(true)` 三个都不带渠道，且那个 `klServer` 是主渠道
   * 的裸实例。于是"保存飞书的范围"会删掉并重建**钉钉**的图。
   *
   * 实测日志：`[Main:KlServer] graph build started` +
   * `kl graph data wiped for fresh rebuild {dataDir: …/kl}` ——
   * 而飞书的图在 `…/kl/feishu`。
   *
   * 不给 = 只存范围、不做后续清理（单测与未接线路径）。
   */
  onScopeChanged?: (channelId: string) => void
}

/**
 * 把新范围并进旧范围，**只许变宽**。
 *
 * ## ★★★ `undefined` 是"不设限"，也就是**最宽**的值 —— 它是吸收元
 *
 * 这是整段逻辑唯一容易写反的地方，而写反的后果是**反过来缩小范围**：
 *
 * 库里 `conversationIds` 是 `undefined`（全部会话都采）、这次传进来 10 个 ——
 * 若按"数组求并集"处理，结果是那 10 个，于是"只增不减"这条规则
 * 亲手把 92 个会话缩成了 10 个。所以判据不是"合并两个数组"，而是
 * **"哪一边更宽就用哪一边"**，而 `undefined` 永远最宽。
 *
 * 四个字段各自的"宽"方向（与 `isConversationInScope` / `isSentAtInScope`
 * 的放行条件一一对应，见 `packages/store/src/collection-scope.ts`）：
 *
 * | 字段              | 不设限     | 更宽的方向          |
 * |-------------------|-----------|--------------------|
 * | `conversationIds` | undefined | 并集               |
 * | `partitions`      | undefined | 并集               |
 * | `chatKinds`       | undefined | 并集               |
 * | `since`（下界）    | undefined | **更早**（`min`）   |
 * | `until`（上界）    | undefined | **更晚**（`max`）   |
 *
 * ★ `since` 还有第三态：`isSentAtInScope` 里 `null` 与 `undefined` 都放行。
 * 所以非 number 一律按"不设限"处理，不能只判 `undefined`。
 *
 * ★★ `partitions`（文档的空间白名单）走与 `conversationIds` **同一条**
 * `widen(…, unionOf)` —— 两者是同一件事的两个域（分区白名单）。
 * 漏掉它的后果是文档的空间白名单**不受"只增不减"保护**：每次保存
 * 直接覆盖，于是用户在设置里改一次范围就能悄悄缩小文档的采集面，
 * 而图谱里仍有那些空间的知识（配置说没学过、产出说学过）。
 *
 * ★ 纯函数并导出：这根"接线"若留在 `save` 里，测试就只能透过服务去打它，
 * 而本仓库已经吃过一次"两头都锁了、中间那根线是裸的"（删掉传值那一行，
 * 1023 条测试一条都不红）。
 */
export function mergeScopeOnlyGrowing(
  before: DistillScopeInput | undefined,
  incoming: DistillScopeInput,
): DistillScopeInput {
  if (before === undefined) return incoming

  const merged: DistillScopeInput = {}

  const ids = widen(before.conversationIds, incoming.conversationIds, unionOf)
  if (ids !== undefined) merged.conversationIds = ids
  /**
   * ★★ 分区白名单（文档的空间）走**同一条**规则 —— 见文件头那张表。
   *
   * 漏掉这一行的后果不是报错，而是文档的空间白名单不受"只增不减"保护：
   * 每次保存直接覆盖，于是用户在设置里改一次范围就能悄悄缩小采集面，
   * 而图谱里仍有那些空间的知识（配置说没学过、产出说学过）。
   */
  const partitions = widen(before.partitions, incoming.partitions, unionOf)
  if (partitions !== undefined) merged.partitions = partitions
  const kinds = widen(before.chatKinds, incoming.chatKinds, unionOf)
  if (kinds !== undefined) merged.chatKinds = kinds

  // 下界只能变早，上界只能变晚 —— 两个方向相反，只差一个函数
  const since = widen(numOrUndef(before.since), numOrUndef(incoming.since), Math.min)
  if (since !== undefined) merged.since = since
  const until = widen(numOrUndef(before.until), numOrUndef(incoming.until), Math.max)
  if (until !== undefined) merged.until = until

  return merged
}

/**
 * 一个字段的"只能变宽"合并。★ 三种情形，**两边的 `undefined` 含义不同**。
 *
 * | before | incoming | 结果 | 为什么 |
 * |--------|----------|------|--------|
 * | 无     | 有       | incoming | 库里**没记过这个字段的限制** → 这是第一次设，收下 |
 * | 有     | 无       | 无（不设限） | 用户放宽到"不限" → 允许 |
 * | 有     | 有       | `wider()` | 两个都是限制 → 取更宽的那个 |
 *
 * ## ★★★ 第一行为什么不能按"不设限是最宽、所以吸收 incoming"处理
 *
 * 我第一版正是那样写的（"任一边 undefined 就返回 undefined"），它**看起来**
 * 更符合"只增不减"，实际后果是范围**永远设不进去**，而且是静默的：
 *
 * · `DistillSourceRepository.list()` 对每个 kind 都合成一行，`scope` 是 `{}`；
 * · `syncTimeWindowToSources()` 在挂载时给每个非主渠道库写一行 chat，
 *   而它**刻意不带 `conversationIds`**（那是别的渠道的 external_id，
 *   复制过去会按一批不存在的 id 过滤 → 恒零，比超采更糟）。
 *
 * 于是飞书那一行天然是"有 since、没有 conversationIds"。把这个 `undefined`
 * 当成"用户选了全部会话"，就等于让飞书**永远**无法设白名单 —— 每次保存都被
 * 上一次的 `undefined` 吸收掉。那是超范围采集（CLAUDE.md 第 5 节）。
 *
 * 实测：那一版让 4 条隔离断言与 2 条读回断言转红（`conversationIds` 收到
 * `undefined`），而这 6 条断言存在的理由恰好就是防这类静默扩面。
 *
 * ★ 代价说清：`无 → 有` 这一格意味着"从不限收窄到具体列表"是**允许**的，
 * 那是范围唯一能变窄的路径。它与用户的要求不冲突 —— 要求是"不能取消
 * **以前选的**"，而这一格里以前什么都没选。这条路径上 purge 仍会跑
 * （越界数据被删），也就是隐私那一侧仍然成立。
 */
function widen<T>(
  before: T | undefined,
  incoming: T | undefined,
  wider: (a: T, b: T) => T,
): T | undefined {
  if (before === undefined) return incoming
  if (incoming === undefined) return undefined
  return wider(before, incoming)
}

/** 集合求并集（去重）。 */
function unionOf<T>(before: readonly T[], incoming: readonly T[]): T[] {
  return [...new Set([...before, ...incoming])]
}

/**
 * 非 number 一律当"不设限"。
 *
 * `isSentAtInScope` 判的是 `typeof scope.since === "number"` —— `null` 也放行。
 * 只判 `undefined` 的话 `Math.min(null, 5000)` 会算成 0（1970 年）。
 */
function numOrUndef(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value : undefined
}

export class DistillSourceService {
  private db: SqliteDatabase | null = null
  /**
   * 其余渠道各自的物理库（`channelId → db`）。
   *
   * ## ★★ 为什么范围必须写进**每一个**库
   *
   * `readCollectionScope(db)` 是**逐库**读的（采集闸在 `IngestService` 里，
   * 每个渠道一个实例、各自一个库）。只写主库的后果是其余渠道那一路
   * `distill_sources` 表里没有 chat 行 → `readCollectionScope` 判成
   * "从没配过 → 不设限" → **它按全量采**，而用户明明选了 7 天与 10 个会话。
   * 这是隐私问题，不是"多采点没坏处"。
   */
  private readonly sourceDbs = new Map<string, SqliteDatabase>()

  constructor(private readonly options: DistillSourceServiceOptions) {}

  /**
   * 挂主库 +（可选）其余渠道各自的库。
   *
   * `sources` 每次 attach 都整个替换而不是累加：管线是按 vault 挂的，
   * 留着上一个 vault 的句柄就是往已关闭的连接上写。
   */
  attach(
    db: SqliteDatabase,
    sources: readonly { channelId: string; db: SqliteDatabase }[] = [],
  ): void {
    this.db = db
    this.sourceDbs.clear()
    for (const source of sources) this.sourceDbs.set(source.channelId, source.db)
    this.syncTimeWindowToSources()
  }

  /**
   * 把主库的**时间窗**播到各渠道库。
   *
   * ## ★★ 为什么必须在挂载时做
   *
   * `readCollectionScope` 是逐库读的，而它对"表里没有 chat 行"的处理是
   * **不设限**（那对老库是对的：从没配过范围就别挡着采）。于是一个从没走过
   * 引导流程的渠道（飞书就是）会**按全量采** —— 实测飞书库的
   * `distill_sources` 是 0 行。那违反 CLAUDE.md 第 5 节。
   *
   * ★ 只播 `since`/`until`/`chatKinds`（渠道无关的语义），**不播
   * `conversationIds`** —— 那是某个渠道的 external_id，复制过去等于让它按
   * 一批不存在的 id 过滤，结果恒为零（那比超采更糟：静默一条都不采）。
   *
   * ★ 已经有 chat 行的渠道库**不覆盖**：用户可能已经在运行状态页给它单独
   * 设过范围，而挂载时拿主渠道的去盖会把那次设置无声抹掉。
   */
  private syncTimeWindowToSources(): void {
    const db = this.db
    if (db === null || this.sourceDbs.size === 0) return
    let primary
    try {
      primary = new DistillSourceRepository(db).list().find((row) => row.kind === "chat")
    } catch {
      // 表还没建（迁移没跑完）→ 这一轮不同步，下次挂载再来
      return
    }
    if (primary === undefined) {
      this.options.logger.info("collection scope sync skipped (no primary chat row)", {
        sources: [...this.sourceDbs.keys()],
      })
      return
    }

    for (const [channelId, sourceDb] of this.sourceDbs) {
      try {
        /**
         * ★★ 判"已经设过"必须查**表里有没有那一行**，不能用 `repo.list()`。
         *
         * `DistillSourceRepository.list()` 对**每一个** kind 都返回一行
         * （表里没有就给一个默认对象）—— 那对 UI 是对的（九个源都要显示），
         * 但用它判"设过没有"**恒为真**。实测踩到：日志说"已经设过了"，
         * 而库里 `SELECT` 出来是 0 行。
         */
        const exists =
          sourceDb
            .prepare<
              [],
              { n: number }
            >("SELECT count(*) AS n FROM distill_sources WHERE kind = 'chat'")
            .get()?.n ?? 0
        if (exists > 0) continue
        const repo = new DistillSourceRepository(sourceDb)
        repo.upsert(
          "chat",
          {
            enabled: primary.enabled,
            scope: {
              ...(primary.scope.since === undefined ? {} : { since: primary.scope.since }),
              ...(primary.scope.until === undefined ? {} : { until: primary.scope.until }),
              ...(primary.scope.chatKinds === undefined
                ? {}
                : { chatKinds: [...primary.scope.chatKinds] }),
              // ★ 刻意不带 conversationIds —— 见方法注释
            },
          },
          this.options.clock.now(),
        )
        this.options.logger.info("collection time window synced to channel", { channelId })
      } catch (error) {
        this.options.logger.error("collection scope sync failed", {
          channelId,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  detach(): void {
    this.db = null
    this.sourceDbs.clear()
  }

  /**
   * 读**某个渠道**的资料源与范围。
   *
   * ## ★★★ `channelId` 决定读哪个库
   *
   * 这个方法原来恒读主库，而采集范围面板一次只看一个渠道 —— 于是切到飞书时
   * 显示的是**钉钉的**范围，用户以为那就是飞书的、点保存又把它存成飞书的。
   *
   * 实测（本机库）：飞书的白名单里 28 个 id 有 **24 个是 `cid…`**
   * （钉钉形状），只有 4 个是 `oc_…`。那 24 个在飞书库里是不存在的 id，
   * 按它们过滤会让结果偏小 —— 静默漏采，而日志里一个错都没有。
   *
   * ★ 拿不到那个渠道的库时返回"全部未启用"而不是抛：设置页在管线还没挂上
   * 时也会渲染，抛错会让整页显示错误横幅，而实际只是还没就绪。
   */
  /**
   * 读某个渠道的**监听范围**（分身盯哪些会话的实时消息）+ 实时流覆盖面。
   *
   * ★ 放在这个服务里的理由与 `chatCoverage` 相同：per-channel 的库解析
   * 已经在这里，让 IPC 层再学一遍映射就会出现第二处要同步维护的地方 ——
   * 而那正是那次"保存飞书的范围却写进主库"的成因。
   */
  attentionScope(input: { channelId: string }): AttentionScopeView {
    const db = this.dbForChannel(input.channelId)
    if (db === null) {
      /**
       * ★ 库还没挂上时 `mode` 报 `unset` 而不是编一个 —— 那是"我们还不知道"，
       * 与"用户没配过"恰好同一句话（界面对两者要说的也是同一句）。
       */
      return {
        items: [],
        activeCount: 0,
        mode: "unset",
        coverage: { routed: 0, skipped: 0, days: 0 },
      }
    }
    const repo = new AttentionScopeRepository(db)
    const rows = repo.list(input.channelId)
    /**
     * 会话标题从 `conversations` 补 —— 只显示 id 的话用户认不出是哪个群
     * （而 id 是敏感标识，界面上本来也不该只给它）。
     */
    const conversations = new ConversationRepository(db)
    const items = rows.map((row) => {
      const conversation = conversations.findByExternalId(
        input.channelId,
        row.conversationExternalId,
      )
      return {
        conversationExternalId: row.conversationExternalId,
        title: conversation?.title ?? null,
        enabledAt: row.enabledAt,
        active: row.active,
        source: row.source,
      }
    })
    /**
     * 覆盖面窗口取近 30 天：实时流的问题是"最近它收到了多少"，
     * 而不是"历史上一共"。★ 与 `chatCoverage` 的 90 天不同是刻意的 ——
     * 那个要回答"这段历史齐不齐"，这个要回答"它现在在干活吗"。
     */
    const now = this.options.clock.now()
    const coverage = new AttentionCoverageRepository(db).summarize(
      input.channelId,
      toDayBucket(now - 30 * 86_400_000),
      toDayBucket(now),
    )
    return {
      items,
      activeCount: repo.activeCount(input.channelId),
      /**
       * ★★ 从库里读**真实的** mode，不从 `activeCount` 反推。
       *
       * 反推是旧的错误：`activeCount === 0` 有三种可能的成因
       * （从没配过 / 显式选了全部 / 把全部关掉），而它们在界面上
       * 该说三句不同的话。见 `AttentionMode` 的文件内注释。
       */
      mode: repo.mode(input.channelId),
      coverage,
    }
  }

  /**
   * 把会话加进监听范围（**只增**：已有的 `enabledAt` 只会变早）。
   *
   * ★ `enabledAt` 缺省用**主进程的时钟**而不是让渲染层传 `Date.now()`：
   * 时钟判据分散到两个进程里就会出现"界面上是今天、库里是明天"这类
   * 没人能解释的偏差（渲染进程与主进程的时钟本身一致，但**谁负责**
   * 这个语义必须只有一处）。
   */
  attentionScopeSave(input: AttentionScopeSaveInput): true {
    const db = this.dbForChannel(input.channelId)
    if (db === null) {
      throw new AppError("CHANNEL_UNSUPPORTED", `渠道未就绪：${input.channelId}`, {
        messageKey: "errors:channel.notReady",
      })
    }
    const at = this.options.clock.now()
    const scopeRepo = new AttentionScopeRepository(db)
    /**
     * ★★★ **先写 mode**，再写名单。
     *
     * 顺序有理由：mode 是"用户表态了"这个事实，而名单是那个表态的内容。
     * 反过来的话中途失败会留下"有名单但 mode 还是 unset"——
     * 而 `unset` 的行为是放行全部，于是用户刚刚勾的那几个会话
     * **反而没有收窄效果**。那正是这一整个改动要消灭的方向。
     *
     * ★ 而"有 mode 没名单"是安全的：`explicit` + 空名单 = 都不盯
     * （保守），`all` + 空名单 = 盯全部（正是它的语义）。
     */
    scopeRepo.setMode(input.channelId, input.mode, at)
    const changed = scopeRepo.add(
      input.channelId,
      input.conversationExternalIds.map((conversationExternalId) => ({
        conversationExternalId,
        enabledAt: input.enabledAt ?? at,
        source: "user",
      })),
      at,
    )
    /**
     * ★★★ 勾选监听 → **自动并入学习范围**（这一步是必须的，不是可选的）
     *
     * 用户原话把两个范围分开，但也说了分身要"看这段时间新消息"。而
     * `admit()` / `intake` 判"该不该回"要读**历史**：`message_mentions`、
     * 这个会话之前的往来、对方在触发消息之后有没有又说话。
     *
     * 所以"监听了但不采集"这个组合是**坏的**：分身收到消息、却拿不到
     * 任何上下文，于是它要么不回、要么回得离谱。而用户完全看不出成因
     * （他明明勾了监听）。
     *
     * ## 我上一轮把这件事留给用户决定，那是错的
     *
     * 我的顾虑是"一次勾选悄悄改动另一个只增不减的范围"。顾虑本身成立，
     * 但结论下错了：出路不是**不做**，而是**别悄悄做** ——
     * 所以这里 ① 只增（并集，不动 since），② 记日志说清并入了几个，
     * ③ 界面上标 `source: 'learning'` 让用户看到"这是随监听加入的"。
     *
     * 反过来（不联动）留下的是一个能配出来的坏状态，而用户没有线索。
     * 那比"多采一个群"糟得多。
     *
     * ★ 只补**会话白名单**，不动 `since`：监听只管实时流，没有理由
     * 因为勾了监听就把学习的历史下界往回挪（那才是真正的超范围）。
     */
    let mergedIntoLearning = 0
    try {
      const repo = new DistillSourceRepository(db)
      const chat = repo.list().find((row) => row.kind === "chat")
      const current = chat?.scope.conversationIds
      /**
       * ★ `undefined` = 不设限（全部会话都在学习范围里）→ 无需并入。
       * 这里若"贴心地"写成一个具体列表，反而把不设限收窄成那几个 ——
       * 那正是 `mergeScopeOnlyGrowing` 注释里那个坑。
       */
      if (current !== undefined) {
        const before = new Set(current)
        const missing = input.conversationExternalIds.filter((id) => !before.has(id))
        if (missing.length > 0) {
          repo.upsert(
            "chat",
            {
              enabled: chat?.enabled ?? true,
              scope: { ...chat?.scope, conversationIds: [...before, ...missing] },
            },
            at,
          )
          mergedIntoLearning = missing.length
        }
      }
    } catch (error) {
      /**
       * 并入失败**不**让整个保存失败：监听范围已经存进去了，
       * 而这一步是补偿。但必须记 —— 否则用户会遇到"监听了却没上下文"
       * 而没有任何线索。
       */
      this.options.logger.warn("attention scope learning merge failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    this.options.logger.info("attention scope saved", {
      channelId: input.channelId,
      requested: input.conversationExternalIds.length,
      // ★ 记 mode：它决定名单为空时的行为，而那正是最容易搞反的一处
      mode: input.mode,
      changed,
      mergedIntoLearning,
    })
    return true
  }

  /**
   * 把一个会话从监听范围里关掉。
   *
   * ★★ 这个动作**是允许的**，与学习范围的「只增不减」不冲突：
   * 监听范围不存任何历史，关掉它只是"以后别管这个群"，没有已有产出
   * 会因此不自洽。把两者混成一条规则会让用户永远无法让分身停下来。
   *
   * ## ★★★ 关掉时**顺带把 mode 钉成 `explicit`**
   *
   * 这一行修的是那个方向错误：用户逐个关到最后一个之后，旧判据
   * （`activeCount === 0` → 放行全部）会让**分身盯得更多**。
   *
   * 而"用户在关会话"这个动作本身就证明他在**显式管理名单** ——
   * 所以把 mode 钉成 `explicit` 是对他意图的忠实记录，而不是替他做决定。
   * 之后名单归零时 `explicit` 的语义（一条都不放行）正是他要的。
   *
   * ★ 即使 `disable` 没有命中任何行（`ok === false`）也写 mode：
   * 那说明那个会话本来就不在名单里，而用户的意图仍然是"我在收窄"。
   */
  attentionScopeDisable(input: AttentionScopeDisableInput): true {
    const db = this.dbForChannel(input.channelId)
    if (db === null) {
      throw new AppError("CHANNEL_UNSUPPORTED", `渠道未就绪：${input.channelId}`, {
        messageKey: "errors:channel.notReady",
      })
    }
    const repo = new AttentionScopeRepository(db)
    const at = this.options.clock.now()
    repo.setMode(input.channelId, "explicit", at)
    const ok = repo.disable(input.channelId, input.conversationExternalId, at)
    this.options.logger.info("attention scope disabled", {
      channelId: input.channelId,
      changed: ok,
    })
    return true
  }

  /**
   * per-channel 的库解析 —— 三处（`list`/`chatCoverage`/`attentionScope*`）
   * 共用。★ 提成一个方法而不是各写一遍：写错渠道就是写错库，
   * 而那类错误本仓库已经付过一次代价（钉钉白名单被飞书那次保存清空）。
   */
  private dbForChannel(channelId: string): SqliteDatabase | null {
    return channelId === this.options.primaryChannelId
      ? this.db
      : (this.sourceDbs.get(channelId) ?? null)
  }

  /**
   * 库里出现过的**文档空间**（知识库 / 云盘目录）+ 各自篇数。
   *
   * 给「文档空间白名单」那个 picker 用（`DistillScope.partitions` 的候选集）。
   *
   * ## ★★ 候选集只能从**已采到的文档**反推
   *
   * 渠道契约里没有"列出全部知识库"这个能力（`ChannelDocuments` 只有
   * `list` / `body` / `readableExtensions`）。所以"用户能勾哪些空间"
   * 只能是"我们已经见过的那些" —— 而界面必须把这个限制说出来
   * （`derivedFromCollected`），否则用户会以为某个知识库不在列表里
   * 是我们漏读了，而真相是那个空间里的文档还没被列举到。
   *
   * ★ 库没挂上 → 空列表 + `derivedFromCollected: true`（而不是抛）：
   * 那时用户看到"还没有采到任何空间"，与"这个渠道确实没有文档"
   * 恰好是同一句话，而两者他都做不了别的事。
   */
  documentSpaces(input: DocumentSpacesInput): DocumentSpacesView {
    const db = this.dbForChannel(input.channelId)
    if (db === null) return { items: [], derivedFromCollected: true }
    return {
      items: new DocumentRepository(db).listSpaces(input.channelId),
      /**
       * ★ 恒 true（当前没有任何渠道提供空间列举）。做成字段而不是让界面
       * 写死那句提示 —— 将来某个渠道真的提供了，这里改 false，
       * 界面上那句限制说明自然消失，不用改渲染层。
       */
      derivedFromCollected: true,
    }
  }

  /**
   * 读某个渠道**某个域**的覆盖面（「这段日期已有多少 / 齐没齐」）。
   *
   * ## ★★★ 三个域走**同一个方法**（G4）
   *
   * 修复前只有 chat 有读出口：`document_coverage`（v29）表在写而 apps 侧
   * **零调用**（`listDays`/`summarize` 一处都没被用过），听记只有一个
   * `drained` 布尔塞在快照里。而用户要的是「不管是消息还是听记，文档等」。
   *
   * 「两类能回答、一类不能」是最难解释的状态 —— 用户会以为文档那栏坏了。
   *
   * 各写一份的代价是三份 handler + 三个 hook + 三个组件，而它们只差一个
   * 表名（三张表共用 `CoverageRepositoryBase` 的五条判据）。
   *
   * ★ 方法名保留 `chatCoverage`：IPC 通道名与既有调用方都用它，
   * 改名是一次无谓的破坏性变更。`input.domain` 缺省 `chat`。
   *
   * ★ 放在这个服务里而不是 IPC 层：per-channel 的库解析已经在这里了
   * （`save`/`list` 都要），让 IPC 层再学一遍"哪个渠道对应哪个 db"
   * 就会出现第二处需要同步维护的映射 —— 而那正是本仓库那次
   * "保存飞书的范围却写进主库"的成因。
   *
   * ★ 库没就绪时返回**空**而不是抛：设置页在管线挂上之前也会渲染。
   * 空的语义是"还没有数据"，而界面对它的文案与"这段日期 0 条"不同 ——
   * 前者说"还没开始采"，后者说"这段时间没有消息"。
   */
  chatCoverage(input: ChatCoverageInput): ChatCoverageView {
    const db = this.dbForChannel(input.channelId)
    if (db === null) {
      /**
       * ★ `source` / `partitionKind` 按**这个域该有的形状**给，而不是
       * 随手填一个 —— 界面用它们决定说哪句话，而"库还没挂上"不该让
       * 那句话变成另一个域的措辞。
       */
      return {
        days: [],
        localCount: 0,
        dayCount: 0,
        drainedDays: 0,
        pendingConversations: input.domain === "minutes" ? null : 0,
        source: input.domain === "minutes" ? "derived" : "accounted",
        partitionKind: partitionKindOf(input.domain),
      }
    }
    if (input.domain === "doc") return this.documentCoverage(db, input)
    if (input.domain === "minutes") return this.minutesCoverage(db, input)
    const repo = new ChatCoverageRepository(db)
    /**
     * ★★★ 存量数据必须从 `messages` 回填一次 —— 而判据**不能**是"表是空的"。
     *
     * ## 我第一版的判据错了，而且错得很安静
     *
     * 第一版写的是 `count(*) === 0 → 重建`。实测（真应用 CDP）的后果：
     * 钉钉显示 **884** 条，而库里有 **36296** 条。
     *
     * 因为 `bump()` 在采集时已经写进去几行（当天新采的），于是
     * `count(*) > 0` 成立 → 回填**永不发生** → 界面把 884 当成"已有多少"
     * 显示出来。那正是本仓库最贵的那类 bug：数字看起来正常，
     * 与"真的只有 884 条"完全同形。
     *
     * ## 正确的判据：**这个渠道回填过没有**（一次性标记）
     *
     * 存进 `app_settings`（跟 vault 走，重启后仍然有效）。它与"表里有几行"
     * 是两个独立的事实 —— 而只有前者能回答"回填做过没有"。
     *
     * ★ 回填本身是幂等的（覆盖写），所以标记丢了重跑一次也不会把数字弄错。
     */
    const backfillKey = `chatCoverage.backfilled.${input.channelId}`
    // ★ 必须显式传 `vault_settings` —— 构造函数默认的是 `app_settings`，
    // 那张表在**控制库**里，在 vault 上查它会 `no such table`（实测踩到）。
    const settings = new SettingsRepository(db, "vault_settings")
    if (settings.get(backfillKey) === null) {
      try {
        const rebuilt = repo.rebuildFromMessages(input.channelId, this.options.clock.now())
        settings.set(backfillKey, "1", new Date(this.options.clock.now()).toISOString())
        this.options.logger.info("chat coverage backfilled from messages", {
          channelId: input.channelId,
          rows: rebuilt,
        })
      } catch (error) {
        /**
         * ★ 失败**不写标记** —— 下次查询会再试。写了标记再失败就等于
         * 永久停在一个不完整的数字上，而那是静默的。
         */
        this.options.logger.warn("chat coverage backfill failed", {
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const days = repo.listDays(input.channelId, input.fromDay, input.toDay)
    const summary = repo.summarize(input.channelId, input.fromDay, input.toDay)
    return {
      days,
      localCount: summary.localCount,
      dayCount: summary.days,
      drainedDays: summary.drainedDays,
      pendingConversations: summary.pendingConversations,
      // ★ chat 有专门的覆盖面表、写入侧逐格记账 → accounted
      source: "accounted",
      partitionKind: "conversation",
    }
  }

  /**
   * 文档域的覆盖面（v29 `document_coverage`）。
   *
   * ## ★★ 与聊天那侧的三处**刻意不同**
   *
   * ① **分区是空间**（知识库 / 云盘目录）而不是会话 —— 所以
   *    `pendingConversations` 在这个域里读作"还有几个空间没抽干"。
   *    字段名保留是因为契约里那一个名字被三个域共用（换名字要动既有调用方），
   *    而"还有几个分区没齐"这个问题在三个域上是同一个；
   * ② **每次都重建真值**（`rebuildFromDocuments`）而不是走一次性标记 ——
   *    文档量比消息小两三个数量级（一条 GROUP BY 走 channel_id 索引），
   *    不需要 chat 那套 `backfilled.*` 标记。而 chat 那侧必须有标记：
   *    36296 条消息重建一次是可感的开销；
   * ③ 重建**失败不抛**：与 chat 同一条理由（覆盖面是派生物，
   *    读不出来该显示"还没有数据"，而不是让整页打不开）。
   */
  private documentCoverage(db: SqliteDatabase, input: ChatCoverageInput): ChatCoverageView {
    const repo = new DocumentCoverageRepository(db)
    try {
      repo.rebuildFromDocuments(input.channelId, this.options.clock.now())
    } catch (error) {
      this.options.logger.warn("document coverage rebuild failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    const days = repo.listDays(input.channelId, input.fromDay, input.toDay)
    const summary = repo.summarize(input.channelId, input.fromDay, input.toDay)
    return {
      days: days.map((day) => ({
        dayBucket: day.dayBucket,
        localCount: day.localCount,
        drained: day.drained,
        // ★ 空间 → 契约里那个共用字段（见上面 ①）
        pendingConversations: day.pendingSpaces,
      })),
      localCount: summary.localCount,
      dayCount: summary.days,
      drainedDays: summary.drainedDays,
      pendingConversations: summary.pendingSpaces,
      // ★ doc 也有专门的覆盖面表（v29）、写入侧逐格记账 → accounted
      source: "accounted",
      // ★ 分区是**空间**（知识库/云盘目录），不是会话 —— 界面据此换量词
      partitionKind: "space",
    }
  }

  /**
   * 听记域的覆盖面。
   *
   * ## ★★★ 这一份从 `minutes` 表**现算**，因为 `minutes_coverage` 答不了
   *
   * `minutes_coverage` 是**每渠道一行**（`drained` / `earliestStartedAt` /
   * `listedTotal`）—— 它回答"上一轮抽干了吗"，回答不了"8 月 12 日那天有
   * 几场"。而用户问的正是后者。
   *
   * 加一张 per-day 表要一次迁移 + 一条写入路径，而真值已经在 `minutes` 表里
   * （走 `idx_minutes_started` 一次 GROUP BY，量级是几十到几百场）。
   * 维护第二份计数会出现"表里说 12 场、库里 13 场"那种对不上。
   *
   * ## ★★ `drained` 是**整个渠道**的结论，摊到每一天上
   *
   * 听记采集是全量列举（没有时间窗语义，见 `ChannelMinutes` 注释），
   * 所以"抽干"只对整轮成立 —— 不存在"某一天抽干了"。摊开不是造假，
   * 而是那个事实的真实粒度就是整个渠道。
   *
   * ★ `coverage === null`（还没跑过一轮）时 `drained` 取 **false** 而不是
   * true：那时我们不知道齐没齐，而 false 让界面说"还在回溯"（诚实），
   * true 会说"已采完"（把"不知道"讲成"没问题"）。
   *
   * ## ★★★ `pendingConversations` 报 `null` 而不是 0（修 G15）
   *
   * 原来它恒 **0**，理由写的是"听记不按分区分，编一个数不如报 0"。
   * 那句话只对了一半：0 不是编的，但它**读起来是"都齐了"** ——
   * 而真相是"这个概念对听记不适用"。
   *
   * 三行覆盖面并排时用户看到「文档还有 3 个空间没齐、听记还有 0 个没齐」，
   * 于是他以为听记比文档更完整 —— 而那两个数字压根不是同一种东西。
   *
   * ★ 同理 `source: "derived"`：这一份没有 `listedTotal`（渠道说有多少），
   * 所以"库里 12 场"是不是全部只能靠**整渠道**的 `drained` 回答。
   * 不说的话用户会以为三行是同一种精度的数字。
   */
  private minutesCoverage(db: SqliteDatabase, input: ChatCoverageInput): ChatCoverageView {
    const repo = new MinutesCoverageRepository(db)
    const overall = repo.get(input.channelId)
    const drained = overall?.drained ?? false
    const rows = repo.listDaysFromMinutes(input.channelId, input.fromDay, input.toDay)
    return {
      days: rows.map((row) => ({
        dayBucket: row.dayBucket,
        localCount: row.localCount,
        drained,
        // ★ null = 这个域没有分区概念（见上面那段 ★★★），不是"0 个没齐"
        pendingConversations: null,
      })),
      localCount: rows.reduce((sum, row) => sum + row.localCount, 0),
      dayCount: rows.length,
      // ★ 整轮抽干 ⇒ 这些天都算齐；没抽干 ⇒ 一天都不算齐（见上面那段）
      drainedDays: drained ? rows.length : 0,
      pendingConversations: null,
      // ★ 从 `minutes` 表现算，没有渠道给的 listedTotal → derived
      source: "derived",
      // ★ 不按分区统计
      partitionKind: null,
    }
  }

  list(channelId?: string): DistillSourceView[] {
    const db =
      channelId === undefined || channelId === this.options.primaryChannelId
        ? this.db
        : (this.sourceDbs.get(channelId) ?? null)
    if (db === null) {
      // 未登录时返回"全部未启用"而不是抛错：设置页在登录前也可能渲染。
      return DISTILL_SOURCE_KINDS.map((kind) => ({
        kind,
        enabled: false,
        scope: {},
        lastSyncedSeq: 0,
        state: "idle" as const,
        lastError: null,
        status: statusOf(kind),
      }))
    }
    return new DistillSourceRepository(db).list().map((row) => ({
      kind: row.kind,
      enabled: row.enabled,
      scope: row.scope,
      lastSyncedSeq: row.lastSyncedSeq,
      state: row.state,
      lastError: row.lastError,
      status: statusOf(row.kind),
    }))
  }

  /**
   * 存**一个渠道**的范围。
   *
   * ## ★★★ `channelId` 是必填的，而且它决定写哪个库
   *
   * 这个方法原来一次写**所有**库：主库拿 `input.scope` 原样，其余渠道库拿
   * `scope` + 各自的 `perChannelConversationIds[channelId]`。而采集范围面板
   * 一次只编辑**一个**渠道 —— 于是在飞书面板点保存时：
   *
   * · 渲染层判 `isPrimary=false`，`scope` 里**不带** `conversationIds`；
   * · 这里把那个 scope 原样 upsert 进**主库** → 钉钉的白名单被覆盖掉。
   *
   * 实测后果（本机）：钉钉的 `conversationIds` 从 9 个变成**字段整个消失**，
   * 之后按「不设限」重采，消息从 1730 涨到 3921（92 个会话全采）。
   * 那是超范围采集（CLAUDE.md 第 5 节），不是"多存了一份"。
   *
   * 所以判据改成"只动这一个渠道的库"。`perChannelConversationIds` 那个
   * 映射参数一并删除 —— 它存在的唯一理由是"一次写多个库"，而那正是 bug。
   *
   * ★ 白名单现在**统一**放在 `scope.conversationIds`，不再分主/非主两种形状。
   * 原来那个分叉（主渠道走 `scope`、其余走映射）要求调用方记住自己是谁，
   * 而它记错的表现就是上面那次数据丢失。
   *
   * ★ `conversationIds` 里装的是**这个渠道的** `external_id`，所以它天然
   * 不该跨库复制 —— 而这个签名让"复制到别的库"变成一件做不到的事。
   */
  save(input: {
    /** 存哪个渠道的范围。**必填** —— 见上面那段。 */
    channelId: string
    kind: DistillSourceKind
    enabled: boolean
    scope: DistillScopeInput
  }): true {
    /**
     * ★ 主库 = 主渠道自己的库；其余渠道各有一个。
     *
     * 拿不到就抛：那说明调用方指了一个没挂管线的渠道，而"静默写到主库上"
     * 正是这次事故的形状。宁可报错让 UI 显示失败。
     */
    const primaryId = this.options.primaryChannelId
    const db =
      input.channelId === primaryId ? this.requireDb() : this.sourceDbs.get(input.channelId)
    if (db === undefined) {
      throw new AppError("CHANNEL_UNSUPPORTED", `渠道未就绪：${input.channelId}`, {
        messageKey: "errors:channel.notReady",
      })
    }
    const repo = new DistillSourceRepository(db)
    /**
     * ★ 存之前先读旧值 —— 判"范围**实质**变了没有"要拿两边比。
     *
     * 只看"有人调了 save"是不够的：引导页的每一次「下一步」都会把九个源
     * 各存一遍，其中八个原封不动。那样每点一次就触发一次清语料 + 重建图谱
     * （分钟级、烧 LLM），而用户什么都没改。
     */
    const before = repo.list().find((row) => row.kind === input.kind)
    /**
     * ★ 临时诊断：保存进来的白名单到底有多少个。
     *
     * 现象：UI 上勾选计数 +1、点了下一步，但库里白名单个数不变。
     * 链路每一环单独看都对（toggle / scopeChanged / zod / upsert 全量覆盖），
     * 所以要看**真正传到主进程的那个数组**。
     *
     * ★ 只记个数与哈希，不记真实 id（那是 openConversationId，属于
     * CLAUDE.md §1.1 不许出仓库的标识；日志文件在本机，但口径一致更安全）。
     */
    if (input.kind === "chat") {
      const ids = input.scope.conversationIds ?? []
      this.options.logger.info("distill scope save received", {
        incoming: ids.length,
        stored: before?.scope.conversationIds?.length ?? -1,
        enabled: input.enabled,
        // 便于确认"是不是同一批" —— 只是长度和的指纹，不含真实值
        fingerprint: ids.reduce((sum, id) => sum + id.length, 0),
      })
    }
    /**
     * ── ★★★ 学习范围**只增不减** ────────────────────────────────
     *
     * 用户原话：「这些关心范围对业务领域现在不能变小，不能取消不选以前不选的，
     * 只能增多，这是消费者业务决定的吧。」—— 判据正是"消费者已经消费过"：
     * 图谱建过、蒸馏抽过那些会话，范围一缩小就与已有产出永久不一致
     * （图里还有那个人，而范围说不该有）。
     *
     * ## ★ 与「清越界语料」那条隐私保障的关系（这里有真冲突，两者都保住）
     *
     * 下面 `onScopeChanged` 那条链会调 `purgeOutOfScopeMessages` ——
     * **真删** messages + FTS + 向量 + 媒体，注释写明"那是隐私边界，不是缓存"。
     * 而"只增不减"意味着 purge 在默认路径上永不触发。
     *
     * 两者不是互斥的，冲突只在**入口**：
     * · 用户在会话列表里**取消勾选** → 那多半是手滑/改主意，不该静默删数据；
     * · 用户明确要"把这个群的数据删掉" → 那是另一个动作
     *   （现有出口是「清空当前渠道登录用户数据」，见 `OnboardingPanel`）。
     *
     * 所以这里把默认路径改成并集，**隐私边界仍然可达** —— 只是要用户显式要求，
     * 而不是勾选框的副作用。
     *
     * ## 三个字段各自的"只增"方向
     *
     * · `conversationIds` → 并集（新旧都要）
     * · `since`（时间下界）→ 只能**变早**（`Math.min`），变晚等于放弃一段历史
     * · `until`（时间上界）→ 只能**变晚**（`Math.max`），同理
     *
     * ★ `enabled` 不在此列：关掉一个源是"暂停采集"，不是"缩小范围" ——
     * 它不删任何已有数据，重新打开就继续。
     */
    const merged = mergeScopeOnlyGrowing(before?.scope, input.scope)
    if (input.kind === "chat") {
      const beforeCount = before?.scope.conversationIds?.length ?? 0
      const afterCount = merged.conversationIds?.length ?? 0
      const incomingCount = input.scope.conversationIds?.length ?? 0
      /**
       * ★ 只在**真的挡住了缩小**时记一条 —— 那是用户会来问"我取消了怎么还在"
       * 的时刻，需要一条能对上的日志。个数够了，不记真实 id（§1.1）。
       */
      if (incomingCount < beforeCount) {
        this.options.logger.info("learning scope shrink blocked (grow-only)", {
          channelId: input.channelId,
          stored: beforeCount,
          incoming: incomingCount,
          kept: afterCount,
        })
      }
    }
    repo.upsert(input.kind, { enabled: input.enabled, scope: merged }, this.options.clock.now())

    /**
     * ★★ 范围**改小**之后必须清掉越界语料 —— 那是隐私边界，不是缓存。
     *
     * 用户把会话白名单从 92 个改成 10 个，库里那 82 个会话的消息若留着，
     * 「严格遵守用户选的范围」这条就只在**下一次采集**上成立，
     * 而已经采进来的越界数据会继续喂给蒸馏、图谱与数字人。
     *
     * 放在 `save` 里而不是让调用方记得调：这是**唯一**的范围写入口，
     * 挂在这里才不会漏（IPC / 引导页 / 设置页都走它）。
     *
     * ## 只有 `chat` 源触发
     *
     * 采集闸（`readCollectionScope`）只读 chat 那一行 —— 其余源的范围
     * 目前不参与采集，为它们清语料/重建图谱是纯浪费。
     *
     * ★★ 回调**带上渠道** —— 不带的话接线那侧只能对主渠道动手，
     * 于是"保存飞书的范围"会删掉并重建**钉钉**的图（实测日志：
     * `[Main:KlServer] graph build started` + `dataDir: …/kl`，
     * 而飞书的是 `…/kl/feishu`）。
     */
    /**
     * ★ 判据比的是**存进去的** `merged`，不是请求里的 `input`。
     *
     * 「只增不减」之后这两者会分叉：用户取消勾选 → `input` 变小、`merged`
     * 与 `before` 相同。拿 `input` 比的话这里会判"范围变了"，于是触发
     * 整条派生链 —— 而其中第 3 步是 `rebuildGraph(fresh)`，**分钟级**。
     * 也就是说一次什么都没改的保存会让图谱重建一遍。
     *
     * ★ 放宽时这条链仍然必须跑：第 1 步除了清越界还**重置回填下界**，
     * 不跑的话新放开的那段历史永远挖不回来（游标已经在更晚的位置）。
     * 清越界那半在只增不减之后恒查不到东西 —— 那正是它应有的样子，
     * 不是可以删掉的理由（显式的「清空渠道数据」仍走同一条路）。
     */
    if (input.kind === "chat" && scopeChanged(before, { enabled: input.enabled, scope: merged })) {
      this.options.onScopeChanged?.(input.channelId)
    }
    return true
  }

  /**
   * 重置某个源的蒸馏水位 —— 下一轮从头再蒸。
   *
   * 只清水位**不删已有 facet**：facet 的合并是幂等的
   * （`mergeFacet` 按 `(facet, scope, scope_ref, key)` 定位并按证据合并），
   * 重蒸只会补充/更新而不会产生重复。删 facet 反而会丢掉那些
   * 已经人工确认过或来自别的源的结论。
   */
  reset(kind: DistillSourceKind): true {
    const db = this.requireDb()
    new DistillSourceRepository(db).resetProgress(kind, this.options.clock.now())
    this.options.logger.info("distill source progress reset", { kind })
    return true
  }

  /**
   * 列出可选会话。
   *
   * 合并两个来源（见文件头）：渠道能列出的会话 + 我们表里的已采信息。
   *
   * ## 为什么必须合并，而不是二选一
   *
   * 两边都不完整，而且**缺的部分不一样**（实测这个账号）：
   * · 渠道三路合并 173 个；
   * · 本地表 86 个，其中 **11 个是渠道三路都没返回的** —— 落在渠道窗口之外
   *   （见 dingtalk/conversations.ts 文件头：单聊没有任何全量列举命令）。
   *
   * 两个数字都由 `node scripts/check-conversations.mjs` 实测得到。
   *
   * 只用渠道会丢那 11 个「已经采过、有真实消息、却列不出来」的会话 ——
   * 那是最糟的一种缺失：数据就在本地，用户却选不到它。
   *
   * 渠道调用失败时**降级**到只用表里的数据（并标 truncated）——
   * 没网时仍能选已采过的会话，比整个选择页打不开好。
   */
  /**
   * 会话列表 —— **全部已挂渠道**，每一项带 `channelId`。
   *
   * ## ★★ 为什么必须覆盖所有渠道
   *
   * 这个列表是用户选采集范围的唯一入口。只给主渠道的话，另一个渠道的会话
   * **一个都选不到** —— 于是 `save()` 里那套"按渠道各存一份白名单"永远收到
   * 空值，而用户以为自己已经配好了范围。
   *
   * ## 每个渠道各自合并「远端 + 本地」
   *
   * 远端（渠道 CLI）给"能看到的全部会话"，本地表给"已经采过的那些"。
   * 两者都要：只用远端会丢掉那些列不出来但确实采过的（钉钉的单聊分页有硬
   * 限制），只用本地会丢掉还没采过的群 —— 而那可能正是用户想选的。
   *
   * ★ 单个渠道失败**不影响其余** —— 那时它退化成"只有本地已采的部分"并
   * 标 `truncated`。整个列表打不开比少一个渠道的远端结果糟得多。
   */
  async conversations(): Promise<ChannelConversationListView> {
    /**
     * ★ `meta` 可能不存在：这一层的一些测试用的是只带 `conversations` 的
     * 能力桩（那是合理的 —— 它们验的是合并逻辑，与渠道身份无关）。
     * 取不到时用一个中性占位：`channelId` 只用于**分组显示与回存分流**，
     * 而单渠道时那两件事都退化成"就这一个"。
     */
    const primaryId = this.options.plugin.meta?.id ?? "primary"
    /**
     * ★★ 主渠道的库**没挂上时不抛错**，只是这一桶不参与。
     *
     * 这里原来是 `db: this.requireDb()` —— 无条件调用，而 `requireDb()` 在
     * `db === null` 时抛 `DB_UNAVAILABLE`。于是整个列表变成红字「数据库不可用」，
     * 连另一个已挂上的渠道的会话都拿不到。
     *
     * ## 什么时候会撞上（实测）
     *
     * 授权流程里存在一个「身份已绑、vault 还没挂完」的窗口。渲染层在授权
     * 成功后会把缓存全部作废并立刻重取（见 `useChannelMutation` 的注释 ——
     * 那个全失效本身是对的，它修的是"授权后列表停在授权前那份空结果"），
     * 而重取正好落在这个窗口里的话就抛了。
     *
     * 更糟的是它**不会自己恢复**：那一刻之后没有下一次失效事件，
     * 于是红字一直挂着，用户只能重启应用。
     *
     * ## 为什么降级而不是抛
     *
     * "库还没挂上"不是错误，是**还没准备好** —— 与下面"渠道没有列举能力"
     * 是同一类：能给多少给多少，并用 `truncated` 说清这不是全集。
     * 抛错的代价是整块不可用（且不可恢复），而降级的代价只是这一轮少一个
     * 渠道 —— 后者明显更小，且下一次重取就补上了。
     *
     * ★ 仍然**留痕**（warn）：静默降级是本仓库最贵的那类 bug，
     * 一个空列表必须能在日志里区分"真的没有会话"与"库还没挂上"。
     */
    const primaryDb = this.db
    const targets: { channelId: string; db: SqliteDatabase; plugin: ChannelPlugin }[] = [
      ...(primaryDb === null
        ? []
        : [{ channelId: primaryId, db: primaryDb, plugin: this.options.plugin }]),
      ...[...this.sourceDbs.entries()].flatMap(([channelId, db]) => {
        const plugin = this.options.sourcePlugins?.().find((p) => p.meta.id === channelId)
        return plugin === undefined ? [] : [{ channelId, db, plugin }]
      }),
    ]
    if (primaryDb === null) {
      this.options.logger.warn("conversation list: primary db not attached yet; listing others", {
        channelId: primaryId,
        others: targets.length,
      })
    }

    const items: ChannelConversationView[] = []
    /**
     * ★ 主渠道的库没挂上 → 这一轮**必然**是截断的（少了整整一个渠道）。
     * 不标的话 0 项会被界面读成"这个账号真的没有会话"，
     * 而实际是"再等一下就有了"。
     */
    let truncated = primaryDb === null
    /**
     * 逐渠道的交代 —— `truncated` 只说"不是全集"，而用户要知道
     * **哪个渠道、为什么**（见契约里 `channelConversationSourceSchema`）。
     */
    const sources: ChannelConversationSourceView[] = []
    if (primaryDb === null) {
      sources.push({
        channelId: primaryId,
        count: 0,
        state: "not-ready",
        reason: "这个渠道的数据库还在挂载中",
      })
    }
    for (const target of targets) {
      const local = this.localConversations(target.db).map((row) => ({
        ...row,
        channelId: target.channelId,
      }))
      const list = target.plugin.conversations
      if (list === undefined) {
        /**
         * ★★ 这个渠道**没有会话列举能力** —— 只能给本地已采的那部分。
         *
         * ★ 现存渠道**都有**这个能力（飞书的 `im +chat-list` 已接上）。
         * 这条分支留着是给"新接的渠道还没实现 conversations"用的。
         *
         * 这里曾经写着「飞书就是这样，设计如此」——**那是错的**：CLI 有
         * `im +chat-list`（`Risk: read`），只是当时白名单里没放行，
         * 而我从"白名单里没有"反推成了"渠道不支持"。代价是引导第 4 步
         * 飞书的会话一个都选不到，且没有任何解释。
         *
         * ★★ 必须留痕。这里原来只有 `truncated = true` 一句注释、
         * **一条日志都没有** —— 于是那个渠道贡献 0 项且完全无声，
         * 排查时只能靠"两个 warn 之间缺了什么"反推。
         * 这正是 CLAUDE.md 第 4 节说的静默降级。
         */
        this.options.logger.info("conversation list: channel cannot enumerate; local only", {
          channelId: target.channelId,
          local: local.length,
        })
        items.push(...local)
        truncated = true
        sources.push({
          channelId: target.channelId,
          count: local.length,
          state: "cannot-enumerate",
          reason: null,
        })
        continue
      }
      try {
        const remote = await list.list()
        const byId = new Map(local.map((row) => [row.externalId, row]))
        for (const item of remote.items) {
          const existing = byId.get(item.externalId)
          byId.set(item.externalId, {
            externalId: item.externalId,
            title: item.title ?? existing?.title ?? null,
            kind: item.kind,
            memberCount: item.memberCount ?? existing?.memberCount ?? null,
            // 本地的最后消息时间更可信（它来自真实落库的消息）
            lastMessageAt: existing?.lastMessageAt ?? item.lastMessageAt ?? null,
            channelId: target.channelId,
          })
        }
        items.push(...byId.values())
        truncated ||= remote.truncated
        this.options.logger.info("conversation list merged", {
          channelId: target.channelId,
          remote: remote.items.length,
          local: local.length,
        })
        sources.push({
          channelId: target.channelId,
          count: byId.size,
          state: "ok",
          reason: null,
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.options.logger.warn("channel conversation list failed; using local only", {
          channelId: target.channelId,
          detail,
        })
        items.push(...local)
        truncated = true
        /**
         * ★ 登录过期与"这次调用失败"要分开：前者**靠等永远不会好**
         * （用户必须去重新授权），后者下一次轮询就可能成功。
         * 混成一种的话界面只能给一句无差别的"读取失败"，
         * 而用户对着一个过期的渠道等下去。
         *
         * 判据走 `AppError` 的 code —— 渠道层已经把它归好类了：
         * · `SESSION_EXPIRED` —— 「渠道登录已过期，需要重新授权」
         *   （`dingtalk/cli.ts:704`）；
         * · `CHANNEL_IDENTITY_UNAVAILABLE` —— 「还没绑定渠道身份，拒绝执行
         *   渠道命令」（同文件 :814，安全边界）。
         *
         * ★ 这两个都要**照抄 kernel 的枚举**，不能凭印象写：我第一版写的
         * `AUTH_EXPIRED` / `IDENTITY_UNBOUND` / `AUTH_REQUIRED` 三个
         * 全都不存在，typecheck 用 TS2367（"两个类型没有交集"）抓了出来 ——
         * 而那个比对若不是字面量类型就会静默恒 false，这一整个分类白写。
         */
        const code = error instanceof AppError ? error.code : null
        /**
         * ★★ 飞书 CLI 的 `not configured` 同样是**终态**。
         *
         * 它的 code 是 `PROCESS_FAILED`（exitCode 3 + `{"type":"config",
         * "subtype":"not_configured"}`），语义是"这个渠道的配置目录还没
         * 初始化好" —— 重试不会让它自己好，要走一次授权。
         *
         * 实测（打包态）：它在 13 分钟里刷了 13 次
         * `channel conversation list failed; using local only | not configured`，
         * 而界面上那句「这次没读到会话」读起来像一次偶发失败 ——
         * 用户会等，而等不来。
         *
         * ★ 判据放在**文本**上而不是 code：`PROCESS_FAILED` 是个大类，
         * 里面也有真正该重试的（超时、限流）。而 `not configured` 这个串
         * 来自 CLI 自己的错误信封，稳定且明确。
         */
        const notConfigured = /not.configured/i.test(detail)
        /**
         * ★★★ 「从没连过」与「连过但过期了」必须分开 —— 前者不该出现在这一步。
         *
         * `CHANNEL_IDENTITY_UNAVAILABLE`（还没绑渠道身份）原来和
         * `SESSION_EXPIRED` 一起归成 `expired`，于是界面上打出
         * 「钉钉 的登录已过期，重新连接后这里才会有它的会话」——
         * 而实际情况是**这个渠道一次都没连过**（实测日志：「还没绑定渠道身份，
         * 拒绝执行渠道命令」）。
         *
         * 用户的原话是"这里展示钉钉的文案很奇怪"：他只连了飞书，这一步却先
         * 甩一句钉钉的过期提示，而下面列的全是飞书的会话。说"过期"还暗示
         * 曾经连过、去重连就能恢复 —— 两件事都不成立。
         *
         * 归 `never-connected`：这一步问的是"接下来学哪些"，没连过的渠道
         * 采集不会跑，**它整条都不该出现在这里**（渲染层据此整条跳过，
         * 见 `sources-step.tsx`）。用户去「连接平台」连上之后它自然出现。
         *
         * ★ `not configured`（配置目录没初始化）也归这一档：同样是"还没连过"
         * 的一种形态 —— 它要走的是一次完整授权，不是"重新连接"。
         */
        const neverConnected = code === "CHANNEL_IDENTITY_UNAVAILABLE" || notConfigured
        sources.push({
          channelId: target.channelId,
          count: local.length,
          state: neverConnected
            ? "never-connected"
            : code === "SESSION_EXPIRED"
              ? "expired"
              : "failed",
          reason: detail,
        })
      }
    }

    items.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    return { items, truncated, sources }
  }

  private localConversations(db: SqliteDatabase): ChannelConversationView[] {
    return db
      .prepare<
        [],
        {
          external_id: string
          title: string | null
          type: "direct" | "group"
          member_count: number | null
          last_message_at: number | null
        }
      >(
        `SELECT external_id, title, type, member_count, last_message_at
           FROM conversations ORDER BY last_message_at DESC`,
      )
      .all()
      .map((row) => ({
        externalId: row.external_id,
        title: row.title,
        kind: row.type,
        memberCount: row.member_count,
        lastMessageAt: row.last_message_at,
      }))
  }

  private requireDb(): SqliteDatabase {
    if (this.db === null) throw new AppError("DB_UNAVAILABLE", "尚未登录")
    return this.db
  }
}

/**
 * 采集范围有没有**实质**变化。
 *
 * ## ★ 为什么不能直接比 JSON 字符串
 *
 * 引导页每次渲染都重新构造 `conversationIds` 数组，顺序取决于用户勾选的
 * 先后 —— `["A","B"]` 与 `["B","A"]` 是同一个范围，但 `JSON.stringify`
 * 不同。用字符串比的话，每点一次「下一步」都会触发一次清语料 + 重建图谱
 * （分钟级、烧 LLM），而用户什么都没改。
 *
 * 所以白名单按**集合**比（排序后逐个对），其余三项按值比。
 *
 * ## `undefined` 与 `[]` 视为等价
 *
 * 两者在采集闸那边是同一个意思（"没给白名单"），见 `DistillScope
 * .conversationIds` 的注释。分开处理会造出一个"从不传变成空数组"的
 * 假变更，而那次变更什么都不改。
 *
 * 旧行不存在（第一次存）→ 一律算变了：那时库里没有范围，
 * 而新范围可能已经排除掉一批会话。
 */
function scopeChanged(
  before: { enabled: boolean; scope: DistillScope } | undefined,
  after: { enabled: boolean; scope: DistillScopeInput },
): boolean {
  if (before === undefined) return true
  // 开关本身就是范围的一部分：关掉 chat 源 = 一条都不采。
  if (before.enabled !== after.enabled) return true
  if (before.scope.since !== after.scope.since) return true
  if (before.scope.until !== after.scope.until) return true
  if (!sameSet(before.scope.chatKinds, after.scope.chatKinds)) return true
  return !sameSet(before.scope.conversationIds, after.scope.conversationIds)
}

/** 两个字符串数组是否同一个集合（顺序无关，`undefined` ≡ `[]`）。 */
function sameSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const a = [...(left ?? [])].sort()
  const b = [...(right ?? [])].sort()
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}
