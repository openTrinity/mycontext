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
   * 用户改了采集范围之后的回调（清越界语料 + 重建图谱，装配处注入）。
   *
   * ★ 为什么是回调而不是在这里做：清语料要碰 `DataPlaneService`、
   * 删媒体字节要碰文件系统、重建图谱要碰 `KlServerService` —— 这一层
   * 只管 `distill_sources` 那张表。把那三件事塞进来等于让一个配置读写
   * 服务持有半个应用。
   *
   * 不给 = 只存范围、不做后续清理（单测与未接线路径）。
   */
  onScopeChanged?: () => void
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
  attach(db: SqliteDatabase, sources: readonly { channelId: string; db: SqliteDatabase }[] = []): void {
    this.db = db
    this.sourceDbs.clear()
    for (const source of sources) this.sourceDbs.set(source.channelId, source.db)
  }

  detach(): void {
    this.db = null
    this.sourceDbs.clear()
  }

  list(): DistillSourceView[] {
    const db = this.db
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
   * 存范围。写主库 **+ 每个渠道库各一份**（见 `sourceDbs` 的注释）。
   *
   * ## ★★ `conversationIds` 按渠道各存一份，其余字段共享
   *
   * `since` / `until` / `chatKinds` 是渠道无关的语义，全量复制是对的。
   * 而 `conversationIds` 里装的是**某个渠道的** `external_id` —— 把钉钉那批
   * 复制到飞书库，等于让飞书按一批不存在的 ID 过滤，**结果恒为零**：
   * 采集一条都不进，而日志里一个错都没有。
   *
   * ★ 那个渠道没勾选过时给 **`undefined`** 而不是 `[]`。两者当前行为相同
   * （都当"不限"），但语义不同：`[]` 是"明确选了零个"。判据一改就分道扬镳，
   * 而那时 `[]` 会变成"一个都不采"—— 一个静默的全量数据缺失。
   */
  save(input: {
    kind: DistillSourceKind
    enabled: boolean
    scope: DistillScopeInput
    /**
     * 其余渠道各自的会话白名单（`channelId → externalIds`）。
     * 某个渠道缺席 = 那个渠道不限会话（见上面关于 undefined 与 [] 的段落）。
     */
    perChannelConversationIds?: Readonly<Record<string, readonly string[]>> | undefined
  }): true {
    const db = this.requireDb()
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
     */
    /**
     * 逐渠道库各写一份。★ 失败**不抛**：主库已经写成了，而抛出去会让 UI
     * 显示"保存失败"，于是用户再点一次 —— 而主库那边每次都会触发一轮
     * 清语料 + 重建图谱（分钟级）。这里记 error 就够：状态页看得见。
     */
    for (const [channelId, sourceDb] of this.sourceDbs) {
      try {
        const ids = input.perChannelConversationIds?.[channelId]
        new DistillSourceRepository(sourceDb).upsert(
          input.kind,
          {
            enabled: input.enabled,
            scope: {
              ...input.scope,
              // ★ 那个渠道自己的白名单；没给就是"不限"（undefined，不是 []）
              ...(ids === undefined ? { conversationIds: undefined } : { conversationIds: [...ids] }),
            },
          },
          this.options.clock.now(),
        )
      } catch (error) {
        this.options.logger.error("distill scope save failed for channel", {
          channelId,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (input.kind === "chat" && scopeChanged(before, input)) {
      this.options.onScopeChanged?.()
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
    const targets: { channelId: string; db: SqliteDatabase; plugin: ChannelPlugin }[] = [
      { channelId: primaryId, db: this.requireDb(), plugin: this.options.plugin },
      ...[...this.sourceDbs.entries()].flatMap(([channelId, db]) => {
        const plugin = this.options.sourcePlugins?.().find((p) => p.meta.id === channelId)
        return plugin === undefined ? [] : [{ channelId, db, plugin }]
      }),
    ]

    const items: ChannelConversationView[] = []
    let truncated = false
    for (const target of targets) {
      const local = this.localConversations(target.db).map((row) => ({
        ...row,
        channelId: target.channelId,
      }))
      const list = target.plugin.conversations
      if (list === undefined) {
        // 渠道没有列举能力 → 只有本地已采的那部分，必然是截断的
        items.push(...local)
        truncated = true
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
      } catch (error) {
        this.options.logger.warn("channel conversation list failed; using local only", {
          channelId: target.channelId,
          detail: error instanceof Error ? error.message : String(error),
        })
        items.push(...local)
        truncated = true
      }
    }

    items.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    return { items, truncated }
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
