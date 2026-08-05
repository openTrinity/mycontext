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
}

export class DistillSourceService {
  private db: SqliteDatabase | null = null

  constructor(private readonly options: DistillSourceServiceOptions) {}

  attach(db: SqliteDatabase): void {
    this.db = db
  }

  detach(): void {
    this.db = null
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

  save(input: { kind: DistillSourceKind; enabled: boolean; scope: DistillScopeInput }): true {
    const db = this.requireDb()
    new DistillSourceRepository(db).upsert(
      input.kind,
      { enabled: input.enabled, scope: input.scope },
      this.options.clock.now(),
    )
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
  async conversations(): Promise<ChannelConversationListView> {
    const db = this.requireDb()
    const local = this.localConversations(db)

    const conversations = this.options.plugin.conversations
    // 渠道无此能力：只有本地表，那必然是"已采过的那部分"，所以是截断的。
    if (conversations === undefined) return { items: local, truncated: true }

    try {
      const remote = await conversations.list()
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
        })
      }
      const items = [...byId.values()].sort(
        (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
      )
      this.options.logger.info("conversation list merged", {
        remote: remote.items.length,
        local: local.length,
        merged: items.length,
        truncated: remote.truncated,
      })
      return { items, truncated: remote.truncated }
    } catch (error) {
      this.options.logger.warn("channel conversation list failed; using local only", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return { items: local, truncated: true }
    }
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
