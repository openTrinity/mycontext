/**
 * 文档采集的**时间闸** —— 学习范围的时间下界必须卡住文档，与消息/听记一致。
 *
 * ## ★★★ 这一层修的是一个真实的隐私缺口（G1）
 *
 * 加这道闸之前，`runDocuments()` 第一行就是 `documents.list({})` ——
 * 一个空 spec，从头到尾**不看任何范围**。对比听记那侧（每轮现读
 * `domainTimeRange("minutes")` 并透传 since/until），文档这侧连一个读范围的
 * 方法都不存在（`documentsTimeRange` 在整个 `ingest.service.ts` 里出现 0 次）。
 *
 * 而引导**确实**给 doc 源写了 `{since, until}`（`onboarding-view.tsx` 的保存
 * 循环对非 chat 源就写这两个字段）。所以用户选「学最近 30 天」，文档侧会把
 * 知识库里全部历史文档拉回来、落库、发 changelog、进图谱与画像。
 *
 * 按 CLAUDE.md 第 5 节：「严格遵守用户在引导里选的范围。超范围采集是隐私
 * 问题，不是"多采点没坏处"」。
 *
 * ## 断言的是**结果**（库里有什么），不是"某个函数被调过"
 *
 * 与 `ingest-scope-gate.test.ts` 同一条纪律：断言"调过 xx"锁的是实现，
 * 而这里要锁的是"越界文档不在库里"这个事实 —— 后者才是隐私边界。
 *
 * ## 反证（这些用例真的能抓到缺陷吗）
 *
 * 把 `runDocuments` 里那道 `isOccurredAtInScope` 改成永真放行 ⇒
 * 「越界的那篇不落库」与「只落范围内的」两条转红。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type { ChannelPlugin, ParsedDocumentLike } from "@mycontext/channels"
import { DistillSourceRepository, DOMAIN_SCOPE_DEFAULTS } from "@mycontext/store"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const CHANNEL = "dingtalk"

/** 范围内（3 天前）与范围外（100 天前）各一篇，同一个知识库。 */
const RECENT = "docFAKE0001"
const OLD = "docFAKE0002"
/** 渠道没给任何时间的那篇（`updatedAt` / `createdAt` 都是 null）。 */
const UNDATED = "docFAKE0003"

function doc(externalId: string, updatedAt: number | null): ParsedDocumentLike {
  return {
    externalId,
    origin: "wiki",
    title: `文档 ${externalId}`,
    docType: "ALIDOC",
    extension: "md",
    url: null,
    workspaceId: "spaceFAKE0001",
    updatedAt,
    createdAt: null,
    contentText: null,
  }
}

function setup(
  options: {
    /** 学习范围的时间下界；不传 = 不写 scope（"没配过"） */
    since?: number
    items?: readonly ParsedDocumentLike[]
    /** doc 源的开关；不传 = 不写那一行 */
    enabled?: boolean
  } = {},
) {
  const clock = new ManualClock(NOW)
  const items = options.items ?? [doc(RECENT, NOW - 3 * DAY), doc(OLD, NOW - 100 * DAY)]
  const plugin = {
    meta: { id: CHANNEL },
    // ★ 必须有 ingest 才会走 start()（没有的话 IngestService 直接跳过）
    ingest: {
      probe: async () => null,
      pull: async () => ({
        conversations: [],
        messages: [],
        nextCursor: null,
        hasMore: false,
        itemCount: 0,
        rawPayload: "{}",
      }),
    },
    documents: {
      list: async () => ({
        items: [...items],
        nextToken: null,
        hasMore: false,
        truncated: false,
        rawPayload: JSON.stringify({ items: items.length }),
      }),
      // 正文一律取不到 —— 这一层测的是列举那道闸，不是正文补齐
      body: async () => ({ contentText: null, rawPayload: null }),
      readableExtensions: ["md"],
    },
  } as unknown as ChannelPlugin

  const vault = openTestVault()
  const service = new IngestService({
    db: vault.db,
    clock,
    logger: createLogger("test-doc-scope", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()

  if (options.since !== undefined || options.enabled !== undefined) {
    new DistillSourceRepository(vault.db).upsert(
      "doc",
      {
        enabled: options.enabled ?? true,
        scope: options.since === undefined ? {} : { since: options.since },
      },
      NOW,
    )
  }
  return { vault, service, clock }
}

/** 库里有没有这篇文档。 */
function has(vault: TestVault, externalId: string): boolean {
  return (
    (vault.db
      .prepare<
        [string, string],
        { c: number }
      >("SELECT count(*) AS c FROM documents WHERE channel_id = ? AND external_id = ?")
      .get(CHANNEL, externalId)?.c ?? 0) > 0
  )
}

describe("★★★ 文档采集必须遵守学习范围的时间下界（隐私边界）", () => {
  it("设了 since=30 天前：范围内那篇落库、100 天前那篇**一篇都不落**", async () => {
    const { vault, service } = setup({ since: NOW - 30 * DAY })

    await service.tickDocuments()

    expect(has(vault, RECENT)).toBe(true)
    // ★ 反证锚点：把闸改成永真放行 ⇒ 这一条转红
    expect(has(vault, OLD)).toBe(false)
    vault.close()
  })

  it("★ 越界的文档不发 changelog（否则它照样进图谱与画像）", async () => {
    const { vault, service } = setup({ since: NOW - 30 * DAY })

    await service.tickDocuments()

    /**
     * 只断言"documents 表里没有"是不够的：changelog 是下游（图谱/蒸馏）的
     * 输入，越界的行进了那里就等于进了图谱 —— 而 `documents` 表干净会让
     * 排查的人以为闸门起作用了。
     */
    const rows = vault.db
      .prepare<
        [],
        { entity_id: string }
      >("SELECT entity_id FROM knowledge_changelog WHERE domain = 'doc'")
      .all()
    const ids = new Set(
      rows.map(
        (row) =>
          vault.db
            .prepare<
              [string],
              { external_id: string }
            >("SELECT external_id FROM documents WHERE id = ?")
            .get(row.entity_id)?.external_id ?? "",
      ),
    )
    expect(ids.has(RECENT)).toBe(true)
    expect(ids.has(OLD)).toBe(false)
    vault.close()
  })

  it("★★ 丢弃必须**可见**：进 snapshot 的 droppedOutOfScope", async () => {
    const { vault, service } = setup({ since: NOW - 30 * DAY })

    await service.tickDocuments()

    /**
     * 静默丢弃是本仓库最贵的那类 bug（CLAUDE.md 第 4 节）：不记的话
     * "闸门挡掉了 300 篇"与"这个知识库本来只有 20 篇"在状态页上完全同形。
     */
    expect(service.snapshot().scope.droppedOutOfScope).toBe(1)
    expect(service.snapshot().scope.lastDroppedAt).not.toBeNull()
    vault.close()
  })

  it("★★ 覆盖面只记范围内的（否则进度永远追不平）", async () => {
    const { vault, service } = setup({ since: NOW - 30 * DAY })

    await service.tickDocuments()

    /**
     * 把范围外的篇数记进 `listed_total` 会让覆盖面与 `documents` 表永久
     * 对不上：`listedTotal` 说有 2 篇、库里只有 1 篇（另一篇被闸门挡了），
     * 界面于是显示"还差 1 篇没采到" —— 而那一篇是用户明确不要的。
     * 一个永远追不平的进度比没有进度更糟。
     *
     * ★★ 必须**跨行求和**，不能 `.get()` 读第一行。两篇文档的业务时间差
     * 97 天 ⇒ 落在**两个不同的 day_bucket** ⇒ 表里是两行，每行各 1 篇。
     * 第一版这条断言写的是 `.get()?.listed_total === 1`，于是闸门被破坏时
     * 它**照样绿**（读到的那一行确实是 1）—— 反证时发现的。
     * 判据必须是"整段区间一共记了几篇"，那才是界面显示的那个数。
     */
    const total = vault.db
      .prepare<
        [string],
        { rows: number; listed: number; local: number }
      >("SELECT count(*) AS rows, COALESCE(sum(listed_total),0) AS listed, COALESCE(sum(local_count),0) AS local FROM document_coverage WHERE channel_id = ?")
      .get(CHANNEL)
    expect(total?.rows).toBe(1)
    expect(total?.listed).toBe(1)
    expect(total?.local).toBe(1)
    vault.close()
  })

  it("没设时间下界（用户选了不限）→ 两篇都落库", async () => {
    const { vault, service } = setup({ enabled: true })

    await service.tickDocuments()

    // ★ 闸只在用户真的设了界时收紧。不限就是不限 —— 不该顺手收窄。
    expect(has(vault, RECENT)).toBe(true)
    expect(has(vault, OLD)).toBe(true)
    vault.close()
  })

  it("★★ 「没配过」（表里没有 doc 行）→ 仍然采（与 chat 方向相反，刻意）", async () => {
    const { vault, service } = setup({})

    await service.tickDocuments()

    /**
     * `DOMAIN_SCOPE_DEFAULTS.doc = "collect-all"` —— 与 chat 的
     * `collect-nothing` **相反**，而两者都对：代价不对称的方向不同。
     * · chat 默认放宽 = 隐私事故（采了用户没同意的全部聊天）；
     * · doc 默认收紧 = 功能静默消失（引导默认勾了它，用户没显式关过）。
     */
    expect(has(vault, RECENT)).toBe(true)
    expect(has(vault, OLD)).toBe(true)
    vault.close()
  })

  it("★★★ 缺省方向**真的生效**：把 doc 改成 collect-nothing ⇒ 一篇都不采", async () => {
    /**
     * ## 这条用例是反证抓出来的
     *
     * 第一版的 doc 采集路只用**时间闸**（`isOccurredAtInScope`），完全不看
     * `restricted`。于是 `DOMAIN_SCOPE_DEFAULTS.doc` 那个声明对文档来说是
     * **装饰性的** —— 我把它从 `collect-all` 改成 `collect-nothing` 之后，
     * 当时的 9 条用例**一条都没转红**。
     *
     * 那正是这一轮要消灭的形态：声明写着一件事，代码里没有任何地方执行它。
     * 危险方向很具体：将来有人按隐私要求把某个域的缺省改成 collect-nothing，
     * 改完**以为生效了**，实际那个域照采。
     *
     * ★ 用 `DOMAIN_SCOPE_DEFAULTS` 的真值驱动断言（而不是硬编码
     * "doc 应该采"）：这样它锁的是「声明与行为一致」这个**关系**，
     * 而不是某一个具体方向 —— 将来真要改方向时，改声明这一条就跟着对。
     */
    const { vault, service } = setup({})

    await service.tickDocuments()

    const expectCollected = DOMAIN_SCOPE_DEFAULTS.doc === "collect-all"
    expect(has(vault, RECENT)).toBe(expectCollected)
    expect(has(vault, OLD)).toBe(expectCollected)
    vault.close()
  })

  it("★ doc 源被显式关掉 → 整轮不跑（一篇都不落）", async () => {
    const { vault, service } = setup({ enabled: false })

    await service.tickDocuments()

    expect(has(vault, RECENT)).toBe(false)
    expect(has(vault, OLD)).toBe(false)
    vault.close()
  })
})

describe("★★ 渠道没给时间的文档（updatedAt / createdAt 都是 null）", () => {
  it("设了界 → 挡掉（判据不可靠时走隐私那一侧）", async () => {
    const { vault, service } = setup({
      since: NOW - 30 * DAY,
      items: [doc(RECENT, NOW - 3 * DAY), doc(UNDATED, null)],
    })

    await service.tickDocuments()

    /**
     * `ParsedDocumentLike.updatedAt` 的契约注释明写「取不到就 null，
     * **不要猜一个 now**（下游按时间窗过滤会漏掉它）」—— 契约作者已经预期
     * 这一层会挡掉它。按 CLAUDE.md 第 5 节，判据不可靠时不采。
     */
    expect(has(vault, RECENT)).toBe(true)
    expect(has(vault, UNDATED)).toBe(false)
    vault.close()
  })

  it("★★★ 没设界 → 放行（此时挡掉它是**凭空丢数据**）", async () => {
    const { vault, service } = setup({
      enabled: true,
      items: [doc(RECENT, NOW - 3 * DAY), doc(UNDATED, null)],
    })

    await service.tickDocuments()

    /**
     * 这一条是上一条的**必要配对**。只写上一条的话，最省事的实现是
     * "时间未知一律挡" —— 而那会让「用户选了不限」的场景静默少掉一批文档
     * （渠道对某类文档就是不给时间）。
     *
     * 判据：闸只在用户**真的设了界**时收紧。没设界时本来全放行。
     *
     * 反证：把 `bounded` 那个判断去掉（改成一律挡）⇒ 这一条转红。
     */
    expect(has(vault, RECENT)).toBe(true)
    expect(has(vault, UNDATED)).toBe(true)
    vault.close()
  })
})

/**
 * ── ★★★ G2 的**运行时**自检：拿真实游标表比对声明 ────────────────
 *
 * `topology.test.ts` 里那条判据⑤用的是一份**我手写的** id 清单
 * （我 grep 了每个 `cursors.register(` 调用点）。它锁住了"当前这六个都声明了"，
 * 但**锁不住将来**：有人加一个新消费者时会加 register、可能忘了加声明，
 * 而他也不会想到去改那份手写清单 —— 于是单测照绿，状态页又少一行。
 * 那正是 G2 复发的形状。
 *
 * 所以自检必须**也**在运行时跑一次，输入是"库里真的有什么"。
 */
describe("★★★ 拓扑自检在运行时也跑（输入是真实游标表）", () => {
  it("库里出现一个没声明的消费者 → snapshot() 记一条 warn", async () => {
    const { vault, service } = setup({ enabled: true })
    const warnings: string[] = []
    /**
     * ★ 直接往游标表插一行 —— 模拟"有人加了 register 但忘了加声明"。
     * 不走 `ConsumerCursorRepository.register()` 是因为那要造 clock，
     * 而这里要验的只是"snapshot 会不会发现它"。
     */
    vault.db
      .prepare(
        `INSERT INTO consumer_cursors
           (consumer_id, acked_seq, required, registered_at, stale_after_ms,
            needs_full_rebuild, updated_at)
         VALUES (?, 0, 0, ?, ?, 0, ?)`,
      )
      .run("某个忘了声明的消费者", NOW, 7 * 24 * 3600_000, NOW)

    /**
     * `snapshot()` 用的是构造时那个 logger，所以这里换一个能收集的进去。
     * ★ 用 `as` 是因为 logger 是私有 options —— 这条断言的价值
     * （防 G2 复发）值得这一处妥协，而它只在测试里。
     */
    const collected = {
      ...createLogger("probe", { level: "warn" }),
      warn: (message: string) => warnings.push(message),
    }
    ;(service as unknown as { options: { logger: unknown } }).options.logger = collected

    service.snapshot()

    expect(warnings.some((w) => w.includes("topology inconsistent"))).toBe(true)
    vault.close()
  })

  it("★ 声明齐全时**不**刷日志（否则真异常会被淹掉）", async () => {
    const { vault, service } = setup({ enabled: true })
    const warnings: string[] = []
    const collected = {
      ...createLogger("probe", { level: "warn" }),
      warn: (message: string) => warnings.push(message),
    }
    ;(service as unknown as { options: { logger: unknown } }).options.logger = collected

    // 连调三次：界面是按秒轮询的，一次不一致也不该刷三条
    service.snapshot()
    service.snapshot()
    service.snapshot()

    expect(warnings.filter((w) => w.includes("topology inconsistent"))).toHaveLength(0)
    vault.close()
  })
})
