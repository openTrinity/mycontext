/**
 * 聊天覆盖面记账（`chat_coverage` / v27）。
 *
 * 用户要的是「说明现在已有那部分日期的那部分业务数据，以及要多少、
 * 共已经有了多少」。这个文件锁住那个"多少"的**语义**，因为这里最容易
 * 悄悄编出一个假数字 —— 上一轮仪表盘那句「才学了 0.0%」就是编分母编出来的。
 *
 * ★ 判据集中在三处：累加 vs 覆盖、`MIN(drained)` 而不是 MAX、
 * 以及"没有行"不许被伪装成"采完了 0 条"。
 */
import { describe, expect, it } from "vitest"
import { ChatCoverageRepository, toDayBucket } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const A = "cidFAKE0001=="
const B = "cidFAKE0002=="

function repo() {
  const vault = openTestVault()
  return { coverage: new ChatCoverageRepository(vault.db), vault }
}

describe("toDayBucket：一天的归属", () => {
  it("★★ 按**本地时区**算，不是 UTC", () => {
    /**
     * 用户说的"8 月 12 日那天的消息"是他所在时区的那一天。用 UTC 的话
     * 东八区晚上 8 点之后的消息会归到第二天 —— 于是"今天采了多少"与
     * 用户自己数的对不上，而两个数字都"看起来对"。
     *
     * 反证：把实现改成 `toISOString().slice(0,10)` → 在东八区下这条转红。
     * ★ 断言写成"与本地 getDate() 一致"而不是写死某个字符串，
     * 因为写死会让这条测试只在某一个时区里绿（CI 时区可能不同）。
     */
    const at = new Date(2026, 7, 12, 23, 30).getTime() // 本地时间 8/12 23:30
    expect(toDayBucket(at)).toBe("2026-08-12")
  })

  it("★ 月/日补零（字典序要能当日期序用）", () => {
    // `listDays` 用文本比较做区间筛选，靠的就是零填充
    expect(toDayBucket(new Date(2026, 0, 5).getTime())).toBe("2026-01-05")
  })
})

describe("chat_coverage：计数", () => {
  it("★★★ 同一个 (会话,天) 多轮采 → 条数**累加**，不是覆盖", () => {
    /**
     * 一天的消息会跨多轮进来（回溯翻页 + 实时流）。用覆盖的话计数会在
     * 轮次之间反复跳回小值 —— 而界面上那是"已有的消息变少了"。
     *
     * 反证：把 SQL 里 `local_count = chat_coverage.local_count + excluded.local_count`
     * 改成 `= excluded.local_count` → 这条转红。
     */
    const { coverage, vault } = repo()
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 10, at: 1 })
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 7, at: 2 })
    const rows = coverage.listByConversation(CH, A)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.localCount).toBe(17)
    vault.close()
  })

  it("★ 不同会话 / 不同天各自成行", () => {
    const { coverage, vault } = repo()
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 3, at: 1 })
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-13", delta: 4, at: 1 })
    coverage.bump(CH, { conversationExternalId: B, dayBucket: "2026-08-12", delta: 5, at: 1 })
    expect(coverage.listByConversation(CH, A)).toHaveLength(2)
    expect(coverage.summarize(CH, "2026-08-01", "2026-08-31").localCount).toBe(12)
    vault.close()
  })

  it("★★ listedTotal 传 null 时**保留**库里的旧值", () => {
    /**
     * 实时流那条路不走列表，它不知道"渠道说有多少条"。让它把一个已知的值
     * 清成 NULL 就是丢信息。
     *
     * 反证：把 `COALESCE(excluded.listed_total, chat_coverage.listed_total)`
     * 改成 `excluded.listed_total` → 这条转红。
     */
    const { coverage, vault } = repo()
    coverage.bump(CH, {
      conversationExternalId: A,
      dayBucket: "2026-08-12",
      delta: 5,
      listedTotal: 42,
      at: 1,
    })
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 1, at: 2 })
    expect(coverage.listByConversation(CH, A)[0]?.listedTotal).toBe(42)
    vault.close()
  })
})

describe("chat_coverage：齐没齐（drained）", () => {
  it("★★★ 一天里有**一个**会话没抽干 → 这一天就不算齐（MIN 而不是 MAX）", () => {
    /**
     * 这是本文件最重要的一条。用 `MAX(drained)` 的话，91 个会话里
     * 90 个齐了就报"这一天已采完"—— 而那正是静默数据缺失的样子：
     * 界面说齐了，实际少了一个群。
     *
     * 反证：把 `MIN(drained)` 改成 `MAX(drained)` → 这条转红。
     */
    const { coverage, vault } = repo()
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 5, at: 1 })
    coverage.bump(CH, { conversationExternalId: B, dayBucket: "2026-08-12", delta: 5, at: 1 })
    // 只把 A 标齐
    coverage.markDrained(CH, {
      conversationExternalId: A,
      dayBucket: "2026-08-12",
      drained: true,
      at: 2,
    })
    const days = coverage.listDays(CH, "2026-08-12", "2026-08-12")
    expect(days[0]?.drained).toBe(false)
    expect(days[0]?.pendingConversations).toBe(1)
    vault.close()
  })

  it("★ 全部会话都抽干 → 这一天算齐", () => {
    const { coverage, vault } = repo()
    for (const id of [A, B]) {
      coverage.bump(CH, { conversationExternalId: id, dayBucket: "2026-08-12", delta: 5, at: 1 })
      coverage.markDrained(CH, {
        conversationExternalId: id,
        dayBucket: "2026-08-12",
        drained: true,
        at: 2,
      })
    }
    const days = coverage.listDays(CH, "2026-08-12", "2026-08-12")
    expect(days[0]?.drained).toBe(true)
    expect(days[0]?.pendingConversations).toBe(0)
    vault.close()
  })

  it("★★ markDrained 不许改动条数", () => {
    /**
     * 翻页到 hasMore=false 那一刻，条数已经在写消息时累加过了。
     * 这里再加一遍就会翻倍。
     *
     * 反证：把 `markDrained` 里的 `delta: 0` 改成 `delta: 1` → 红。
     */
    const { coverage, vault } = repo()
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 9, at: 1 })
    coverage.markDrained(CH, {
      conversationExternalId: A,
      dayBucket: "2026-08-12",
      drained: true,
      at: 2,
    })
    expect(coverage.listByConversation(CH, A)[0]?.localCount).toBe(9)
    vault.close()
  })

  it("★★★ markDaysDrained 只更新**已有行**，不凭空造行", () => {
    /**
     * 一天没有任何行时造一行 `local_count=0, drained=1`，界面就会说
     * "这一天已采完 0 条" —— 而事实是"我们不知道这天有没有消息"。
     * 那是把结论伪装成事实（与 v24 里 `transcript_pages` 不给默认值同一个取舍）。
     *
     * 反证：把 `markDaysDrained` 的 UPDATE 改成 INSERT ... ON CONFLICT → 红。
     */
    const { coverage, vault } = repo()
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 3, at: 1 })
    // 区间覆盖 8/10–8/14，但只有 8/12 有行
    const marked = coverage.markDaysDrained(CH, "2026-08-10", "2026-08-14", 5)
    expect(marked).toBe(1)
    expect(coverage.listDays(CH, "2026-08-10", "2026-08-14")).toHaveLength(1)
    expect(coverage.listDays(CH, "2026-08-12", "2026-08-12")[0]?.drained).toBe(true)
    vault.close()
  })
})

describe("chat_coverage：汇总（不编百分比）", () => {
  it("★★ summarize 给的是「共几天 / 几天齐了」而**不是**一个百分比", () => {
    /**
     * 渠道 API 不提供"某天共有多少条"，所以百分比只能编。这条断言
     * 锁住返回形状里**没有** percent/total 这类字段 —— 有人后来加上去
     * 就等于又编了一个分母。
     */
    const { coverage, vault } = repo()
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 3, at: 1 })
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-13", delta: 4, at: 1 })
    coverage.markDrained(CH, {
      conversationExternalId: A,
      dayBucket: "2026-08-12",
      drained: true,
      at: 2,
    })
    const summary = coverage.summarize(CH, "2026-08-01", "2026-08-31")
    expect(summary).toEqual({
      localCount: 7,
      days: 2,
      drainedDays: 1,
      pendingConversations: 1,
    })
    // ★ 形状断言：不许出现"总共该有多少"这类拿不到真值的字段
    expect(Object.keys(summary).sort()).toEqual([
      "days",
      "drainedDays",
      "localCount",
      "pendingConversations",
    ])
    vault.close()
  })

  it("★ 区间外的天不算进来（文本比较当日期序用）", () => {
    const { coverage, vault } = repo()
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-07-31", delta: 100, at: 1 })
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 3, at: 1 })
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-09-01", delta: 100, at: 1 })
    expect(coverage.summarize(CH, "2026-08-01", "2026-08-31").localCount).toBe(3)
    vault.close()
  })

  it("★ 渠道之间不串（同一个 vault 里两个渠道）", () => {
    const { coverage, vault } = repo()
    coverage.bump(CH, { conversationExternalId: A, dayBucket: "2026-08-12", delta: 3, at: 1 })
    coverage.bump("feishu", {
      conversationExternalId: "ocFAKE0001",
      dayBucket: "2026-08-12",
      delta: 50,
      at: 1,
    })
    expect(coverage.summarize(CH, "2026-08-01", "2026-08-31").localCount).toBe(3)
    expect(coverage.summarize("feishu", "2026-08-01", "2026-08-31").localCount).toBe(50)
    vault.close()
  })
})

/**
 * ── ★★★ 从 messages 重建（存量数据的唯一出路）────────────────────
 *
 * 实测（本机真库，CDP）：62 个连续采集页全是 `changed:0 / unchanged:51`——
 * 历史早就采完，回溯只是重读同一批消息，`persistBatch` 全部判重。
 * 所以只靠 `bump()` 累加的话，存量数据的计数**永远是 0**，
 * 界面会说"这段日期 0 条"而库里有三万多条。
 *
 * 这一组锁住重建的两条性质：数得对、且**幂等**。
 */
describe("rebuildFromMessages：存量数据也要能数出来", () => {
  /** 造几条真实形状的消息（值全是编的，CLAUDE.md §1.2）。 */
  function seed(vault: ReturnType<typeof openTestVault>, rows: { conv: string; at: number }[]) {
    const convIds = new Map<string, string>()
    for (const row of rows) {
      if (!convIds.has(row.conv)) {
        const id = `conv-${convIds.size + 1}`
        convIds.set(row.conv, id)
        vault.db
          .prepare(
            `INSERT INTO conversations (id, channel_id, external_id, type, title, created_at)
             VALUES (?, ?, ?, 'group', '测试群', 0)`,
          )
          .run(id, CH, row.conv)
      }
    }
    let n = 0
    for (const row of rows) {
      n += 1
      vault.db
        .prepare(
          `INSERT INTO messages
             (id, channel_id, conversation_id, external_id, sent_at, direction, created_at)
           VALUES (?, ?, ?, ?, ?, 'inbound', 0)`,
        )
        .run(`msg-${n}`, CH, convIds.get(row.conv), `msgFAKE${n}`, row.at)
    }
  }

  it("★★★ 按 (会话, 天) 数出真值", () => {
    const vault = openTestVault()
    const coverage = new ChatCoverageRepository(vault.db)
    const day1 = new Date(2026, 7, 12, 10, 0).getTime()
    const day2 = new Date(2026, 7, 13, 10, 0).getTime()
    seed(vault, [
      { conv: A, at: day1 },
      { conv: A, at: day1 },
      { conv: A, at: day2 },
      { conv: B, at: day1 },
    ])
    const rows = coverage.rebuildFromMessages(CH, 100)
    expect(rows).toBeGreaterThan(0)
    expect(coverage.summarize(CH, "2026-08-12", "2026-08-13").localCount).toBe(4)
    expect(coverage.listDays(CH, "2026-08-12", "2026-08-12")[0]?.localCount).toBe(3)
    vault.close()
  })

  it("★★★ 幂等：重建两次结果相同（覆盖而不是累加）", () => {
    /**
     * 反证：把 SQL 里 `local_count = excluded.local_count` 改成
     * `= chat_coverage.local_count + excluded.local_count` → 这条转红
     * （第二次重建会翻倍）。而懒重建可能被触发多次，翻倍就是报假数。
     */
    const vault = openTestVault()
    const coverage = new ChatCoverageRepository(vault.db)
    seed(vault, [{ conv: A, at: new Date(2026, 7, 12, 10, 0).getTime() }])
    coverage.rebuildFromMessages(CH, 100)
    coverage.rebuildFromMessages(CH, 200)
    expect(coverage.summarize(CH, "2026-08-12", "2026-08-12").localCount).toBe(1)
    vault.close()
  })

  it("★★★ SQL 的 day_bucket 与 toDayBucket() 落在同一天（时区必须一致）", () => {
    /**
     * SQL 用 `date(..., 'localtime')`、JS 用 `getFullYear()` 系列 ——
     * 两条路必须归到同一天，否则同一条消息在"采集时累加"与"从库重建"
     * 之间会被算到两天上，而两个数字都"看起来对"。
     *
     * ## ★★ 这条断言第一版**没有判别力**（反证是绿的）
     *
     * 我原来取"晚上 23:30"，理由是"那是跨天时刻"。在本机（UTC+8，
     * `getTimezoneOffset() === -480`）那个时刻的 UTC 日期与本地日期**相同**
     * —— UTC 比本地早，所以跨天发生在**凌晨**而不是深夜。于是去掉
     * `'localtime'` 之后这条照样绿：它测的是一个两条路本来就一致的时刻。
     *
     * 判据因此改成"**先算出本机真正跨天的那一侧**，再取那个时刻"，
     * 而不是写死一个我以为跨天的钟点 —— 后者在别的时区会再次失去判别力
     * （而且是静默的：测试照常绿）。
     *
     * 反证：把 SQL 里的 `'localtime'` 去掉 → 这条转红（已实测）。
     */
    const vault = openTestVault()
    const coverage = new ChatCoverageRepository(vault.db)
    /**
     * 取本机 UTC 日期 ≠ 本地日期的那个时刻。
     * · offset < 0（UTC 落后于本地，如 UTC+8）→ 跨天在凌晨；
     * · offset > 0（UTC 领先，如 UTC-5）→ 跨天在深夜。
     */
    const probeDay = new Date(2026, 7, 12, 12, 0)
    const early = new Date(2026, 7, 12, 0, 30).getTime()
    const late = new Date(2026, 7, 12, 23, 30).getTime()
    const crossing = probeDay.getTimezoneOffset() < 0 ? early : late
    // 前提自查：这个时刻**必须**真的跨天，否则这条断言又变成空跑
    expect(new Date(crossing).toISOString().slice(0, 10)).not.toBe(toDayBucket(crossing))

    seed(vault, [{ conv: A, at: crossing }])
    coverage.rebuildFromMessages(CH, 100)
    const rows = coverage.listByConversation(CH, A)
    expect(rows[0]?.dayBucket).toBe(toDayBucket(crossing))
    vault.close()
  })

  it("★ 不动 drained（那是采集侧的结论）", () => {
    const vault = openTestVault()
    const coverage = new ChatCoverageRepository(vault.db)
    seed(vault, [{ conv: A, at: new Date(2026, 7, 12, 10, 0).getTime() }])
    coverage.rebuildFromMessages(CH, 100)
    coverage.markDrained(CH, {
      conversationExternalId: A,
      dayBucket: "2026-08-12",
      drained: true,
      at: 200,
    })
    // 再重建一次 —— 不许把 drained 打回 0
    coverage.rebuildFromMessages(CH, 300)
    expect(coverage.listDays(CH, "2026-08-12", "2026-08-12")[0]?.drained).toBe(true)
    vault.close()
  })
})

/**
 * ── ★★★ 回填的判据不能是「表里有没有行」──────────────────────────
 *
 * 这一条记录一次真实的静默错报。我第一版把懒回填的判据写成
 * `count(*) === 0 → 重建`，看起来完全合理。实测（真应用 CDP）：
 *
 *     钉钉显示 884 条，而库里有 36296 条
 *
 * 因为 `bump()` 在采集时已经写进去几行（当天新采的那些），于是
 * `count(*) > 0` 成立 → 回填**永不发生** → 界面把 884 当成"已有多少"。
 * 改成一次性标记之后同一台机器上是 **37300 条 / 91 天**。
 *
 * 判据落在源码上：`chatCoverage` 必须用**标记**而不是**行数**来决定回填。
 */
describe("接线：回填用一次性标记，不是「表里有几行」", () => {
  it("★★★ 判据是 vault_settings 里的标记，不是 count(*)", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    const idx = src.indexOf("chatCoverage(input: ChatCoverageInput)")
    expect(idx).toBeGreaterThan(0)
    const body = src.slice(idx, idx + 4000)
    /**
     * 反证：把判据换回 `count(*) FROM chat_coverage ... === 0` → 这条转红。
     * 而红之前的状态正是"884 当成 36296"那次错报。
     */
    expect(body).toContain("chatCoverage.backfilled.")
    expect(body).toContain("rebuildFromMessages")
    // ★ 不许再用"表里有几行"当判据
    expect(body.includes("SELECT count(*) AS c FROM chat_coverage")).toBe(false)
  })

  it("★★ 标记存 vault_settings（app_settings 在控制库里，查不到）", async () => {
    /**
     * `SettingsRepository` 的构造函数**默认** `app_settings`，而那张表
     * 不在 vault 上 —— 实测报 `no such table: app_settings`，整个查询失败。
     *
     * 反证：把 `"vault_settings"` 那个参数删掉 → 真应用里 IPC 直接报错。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    expect(src).toContain('new SettingsRepository(db, "vault_settings")')
  })

  it("★ 回填失败时**不写标记**（否则永久停在不完整的数字上）", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    const idx = src.indexOf("chat coverage backfill failed")
    expect(idx).toBeGreaterThan(0)
    /**
     * ★ 窗口要**从 `catch` 那一行开始**取，不能往前数固定字符数。
     *
     * 我第一版取 `idx - 400`，那个窗口跨过了 `catch` 边界、把 try 里正常的
     * `settings.set` 也框了进来 → 断言红，而代码是对的。
     * 判据是"catch **之后**有没有 set"，所以先定位 catch 再切。
     */
    const catchAt = src.lastIndexOf("} catch (error) {", idx)
    expect(catchAt).toBeGreaterThan(0)
    const catchBlock = src.slice(catchAt, idx + 200)
    expect(catchBlock.includes("settings.set")).toBe(false)
  })
})

/**
 * ── ★★★ 接线：采集侧真的在写这张表 ─────────────────────────────
 *
 * 上面全绿而 `ingest.service.ts` 里那两处调用被删掉的话，这张表会永远是空的，
 * 而界面会显示"这段日期 0 条"——与"真的没采到"完全同形。
 * 本仓库反复出现的形状：两头都锁了、中间那根线是裸的。
 */
describe("接线：ingest 在两个位置记账", () => {
  it("★★ persist 之后累加条数（唯一的消息写入口）", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    expect(src).toContain("ChatCoverageRepository")
    // 累加用的是真的写进库的那些行，不是整页（后者含重复 → 计数虚高）
    const idx = src.indexOf("chat coverage bump failed")
    expect(idx).toBeGreaterThan(0)
    const block = src.slice(Math.max(0, idx - 2200), idx)
    expect(block).toContain("result.changed")
    expect(block).toContain("toDayBucket")
  })

  it("★★ 窗抽干之后标 drained", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    /**
     * 反证：把 `markDaysDrained(...)` 那一段删掉 → 红。
     * 而红之前的状态是 `drained` 永远为 0 → 界面永远说"还在回溯"。
     */
    expect(src).toContain("markDaysDrained")
    const idx = src.indexOf("markDaysDrained")
    const around = src.slice(Math.max(0, idx - 900), idx)
    // 判据必须挂在"整个窗抽干"那一步，而不是单页的 hasMore
    expect(around).toContain("if (drained)")
  })
})
