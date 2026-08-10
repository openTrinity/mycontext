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
  DistillSourceRepository,
  DISTILL_SOURCE_KINDS,
  type DistillScope,
  type DistillSourceKind,
  type SqliteDatabase,
} from "@mycontext/store"
import type {
  ChannelConversationListView,
  ChannelConversationSourceView,
  ChannelConversationView,
  DistillScopeInput,
  DistillSourceView,
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
    repo.upsert(
      input.kind,
      { enabled: input.enabled, scope: input.scope },
      this.options.clock.now(),
    )

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
    if (input.kind === "chat" && scopeChanged(before, input)) {
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
        sources.push({
          channelId: target.channelId,
          count: local.length,
          state:
            code === "SESSION_EXPIRED" || code === "CHANNEL_IDENTITY_UNAVAILABLE"
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
