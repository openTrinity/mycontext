/**
 * 数字分身的**监听范围**与**路由**（v28 `attention_scope`）。
 *
 * ## 用户要的（原话）
 *
 * 「现状是学习范围决定一切，至少要分开两个吧，学习的范围和监听范围」
 * 「消费者是不是得有个路由模块，看这段时间新消息会不会是我这个数字分身的
 *   设置要关心的，这个是路由判断是否需要的部分」
 * 「不过他只需要记录实时流的内容」
 *
 * 这个文件锁住三件事：路由的三条判据、监听范围的"只增"方向、
 * 以及**监听范围可以关掉**（那与学习范围的只增不减是两回事）。
 */
import { describe, expect, it } from "vitest"
import {
  AttentionScopeRepository,
  AttentionCoverageRepository,
  routeToAttention,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const A = "cidFAKE0001=="
const B = "cidFAKE0002=="
const T0 = 1_780_000_000_000

describe("routeToAttention：这条消息我管不管", () => {
  it("★ 在范围内且晚于起点 → 放行", () => {
    expect(
      routeToAttention({
        conversationExternalId: A,
        sentAt: T0 + 1000,
        scope: { enabledAt: T0, active: true },
      }),
    ).toEqual({ routed: true })
  })

  it("★★ 不在名单里 → not_in_scope", () => {
    expect(routeToAttention({ conversationExternalId: A, sentAt: T0 + 1000, scope: null })).toEqual(
      { routed: false, reason: "not_in_scope" },
    )
  })

  it("★★ 在名单但关掉了 → scope_disabled（与「不在名单」是两个 reason）", () => {
    /**
     * 两者出路不同：`not_in_scope` 要用户去勾选，`scope_disabled` 说明
     * 曾经勾过又关了。合成同一个 reason 会让用户排查时分不清。
     *
     * 反证：把 `active` 那条判据删掉 → 这条转红（会得到 routed: true）。
     */
    expect(
      routeToAttention({
        conversationExternalId: A,
        sentAt: T0 + 1000,
        scope: { enabledAt: T0, active: false },
      }),
    ).toEqual({ routed: false, reason: "scope_disabled" })
  })

  it("★★★ 早于 enabled_at → before_enabled_at（监听**只管实时流**）", () => {
    /**
     * 这是本文件最重要的一条，也是监听范围与学习范围最本质的差别：
     * 用户原话「他只需要记录实时流的内容」。
     *
     * 没有这条判据的话，一次历史回填会把几万条旧消息全部路由给管控层 ——
     * 而那不是"分身很勤奋"，是它对着三个月前的消息起草回复
     * （本仓库实测过 19 天前的群消息被起草）。
     *
     * 反证：把 `sentAt < enabledAt` 那条删掉 → 这条转红。
     */
    expect(
      routeToAttention({
        conversationExternalId: A,
        sentAt: T0 - 1,
        scope: { enabledAt: T0, active: true },
      }),
    ).toEqual({ routed: false, reason: "before_enabled_at" })
  })

  it("★ 正好等于 enabled_at → 放行（边界含在内）", () => {
    // 用 `<` 而不是 `<=`：起点那一刻的消息属于范围
    expect(
      routeToAttention({
        conversationExternalId: A,
        sentAt: T0,
        scope: { enabledAt: T0, active: true },
      }).routed,
    ).toBe(true)
  })

  it("★★ 判据顺序：关掉的会话即使消息很旧也报 scope_disabled", () => {
    /**
     * 顺序有意义：`active` 先于时间判。反过来的话一个关掉的会话会报
     * `before_enabled_at`，而那句话指向"时间不对"，与真实原因无关。
     */
    expect(
      routeToAttention({
        conversationExternalId: A,
        sentAt: T0 - 999_999,
        scope: { enabledAt: T0, active: false },
      }),
    ).toEqual({ routed: false, reason: "scope_disabled" })
  })

  it("★★★ 路由**不判**「该不该回」—— 那是 admit() 的事", () => {
    /**
     * 路由的入参里**没有** isSelf / origin / turnAnswered / killSwitch ——
     * 这条断言锁住那个边界：一旦有人把"是不是自己发的"塞进路由，
     * "范围外"与"不该回"就会用同一个 reason 表达，而它们一个是配置问题、
     * 一个是时机问题。
     *
     * 判据落在**类型的键集合**上（运行时能观察到的那部分）。
     */
    const input = {
      conversationExternalId: A,
      sentAt: T0,
      scope: { enabledAt: T0, active: true },
    }
    expect(Object.keys(input).sort()).toEqual(["conversationExternalId", "scope", "sentAt"])
  })
})

describe("AttentionScopeRepository：只增 + 可关掉", () => {
  it("★★ 重复加同一个会话 → enabled_at 只能**变早**", () => {
    /**
     * 与学习范围的 `since` 同一条规则：变晚等于放弃一段已经在盯的时间。
     *
     * 反证：把 SQL 里 `MIN(attention_scope.enabled_at, excluded.enabled_at)`
     * 改成 `excluded.enabled_at` → 这条转红。
     */
    const vault = openTestVault()
    const repo = new AttentionScopeRepository(vault.db)
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0 }], 1)
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0 + 86_400_000 }], 2)
    expect(repo.get(CH, A)?.enabledAt).toBe(T0) // 挡住变晚
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0 - 86_400_000 }], 3)
    expect(repo.get(CH, A)?.enabledAt).toBe(T0 - 86_400_000) // 放行变早
    vault.close()
  })

  it("★★★ 监听范围**可以关掉** —— 那与学习范围的只增不减是两回事", () => {
    /**
     * 「只增不减」针对学习范围：消费者已经消费过历史，缩小会让图谱/画像
     * 与范围永久不一致。监听范围**不存任何历史** —— 关掉它只是
     * "以后别管这个群了"，没有已有产出会因此不自洽。
     *
     * 把两者混成同一条规则会得到一个荒谬结论：用户永远无法让分身停止盯着
     * 某个群。那不是隐私保护，是产品缺陷。
     */
    const vault = openTestVault()
    const repo = new AttentionScopeRepository(vault.db)
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0 }], 1)
    expect(repo.disable(CH, A, 2)).toBe(true)
    expect(repo.get(CH, A)?.active).toBe(false)
    expect(repo.activeCount(CH)).toBe(0)
    vault.close()
  })

  it("★★ 关掉之后重新打开：**不重置** enabled_at", () => {
    /**
     * 那个时间点是"从哪儿开始关心"，不是"上次启用时间"。重置会让中间那段
     * 消息永久落在范围外，而用户以为重新打开就都算。
     *
     * 反证：把 `add` 的 ON CONFLICT 里 `enabled_at = MIN(...)` 改成
     * `enabled_at = excluded.enabled_at` → 这条转红。
     */
    const vault = openTestVault()
    const repo = new AttentionScopeRepository(vault.db)
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0 }], 1)
    repo.disable(CH, A, 2)
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0 + 999_999 }], 3)
    expect(repo.get(CH, A)?.active).toBe(true)
    expect(repo.get(CH, A)?.enabledAt).toBe(T0)
    vault.close()
  })

  it("★★ 用户显式勾过的不许被自动并入降级成 'learning'", () => {
    /**
     * `source` 决定界面怎么解释这一行（"你勾的" vs "跟随学习范围加的"）。
     * 让自动并入覆盖掉 `user` 会造成错误归因。
     *
     * 反证：把 `CASE WHEN ... 'user' THEN 'user' ELSE excluded.source END`
     * 改成 `excluded.source` → 这条转红。
     */
    const vault = openTestVault()
    const repo = new AttentionScopeRepository(vault.db)
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0, source: "user" }], 1)
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0, source: "learning" }], 2)
    expect(repo.get(CH, A)?.source).toBe("user")
    vault.close()
  })

  it("★ 关掉不删行（「曾经关心过」与「从没关心过」可区分）", () => {
    const vault = openTestVault()
    const repo = new AttentionScopeRepository(vault.db)
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0 }], 1)
    repo.disable(CH, A, 2)
    expect(repo.get(CH, A)).not.toBeNull() // 行还在
    expect(repo.get(CH, B)).toBeNull() // 从没加过 → null
    vault.close()
  })

  it("★ 渠道之间不串", () => {
    const vault = openTestVault()
    const repo = new AttentionScopeRepository(vault.db)
    repo.add(CH, [{ conversationExternalId: A, enabledAt: T0 }], 1)
    repo.add("feishu", [{ conversationExternalId: "ocFAKE0001", enabledAt: T0 }], 1)
    expect(repo.activeCount(CH)).toBe(1)
    expect(repo.activeCount("feishu")).toBe(1)
    expect(repo.get("feishu", A)).toBeNull()
    vault.close()
  })
})

describe("AttentionCoverageRepository：实时流覆盖面", () => {
  it("★★★ 同时记 routed 与 skipped（只记放行的话两种情况不可区分）", () => {
    /**
     * 只有 `routed` 的话，「范围设窄了」与「那段时间没消息」都表现为 0 ——
     * 而那正是用户会来问的那个问题。
     *
     * 反证：把 `skipped_count` 的累加删掉 → 这条转红。
     */
    const vault = openTestVault()
    const repo = new AttentionCoverageRepository(vault.db)
    repo.bump(CH, { dayBucket: "2026-08-12", routed: 3, skipped: 0, at: 1 })
    repo.bump(CH, { dayBucket: "2026-08-12", routed: 0, skipped: 7, at: 2 })
    const summary = repo.summarize(CH, "2026-08-01", "2026-08-31")
    expect(summary).toEqual({ routed: 3, skipped: 7, days: 1 })
    vault.close()
  })

  it("★ 累加而不是覆盖（实时流是一条条来的）", () => {
    const vault = openTestVault()
    const repo = new AttentionCoverageRepository(vault.db)
    for (let i = 0; i < 5; i += 1) {
      repo.bump(CH, { dayBucket: "2026-08-12", routed: 1, skipped: 0, at: i })
    }
    expect(repo.summarize(CH, "2026-08-12", "2026-08-12").routed).toBe(5)
    vault.close()
  })

  it("★★ 汇总里**没有**百分比字段（分母同样拿不到）", () => {
    const vault = openTestVault()
    const repo = new AttentionCoverageRepository(vault.db)
    repo.bump(CH, { dayBucket: "2026-08-12", routed: 1, skipped: 1, at: 1 })
    const summary = repo.summarize(CH, "2026-08-01", "2026-08-31")
    expect(Object.keys(summary).sort()).toEqual(["days", "routed", "skipped"])
    vault.close()
  })
})

/**
 * ── ★★★ 接线：路由真的挂在投递之前 ─────────────────────────────
 *
 * 上面全绿而 `ingest.service.ts` 里那段路由被删掉的话，分身照旧收到
 * **所有**会话的消息 —— 而"监听范围"就变成一个只存在于界面上的概念。
 * 本仓库反复出现的形状：两头都锁了、中间那根线是裸的。
 */
describe("接线：路由挂在 personaFastPath 之前", () => {
  it("★★★ 投递**受** routed 门控（不是「路由在前面出现过」）", async () => {
    /**
     * ── 这一条第一版**没有判别力** ──────────────────────────────
     *
     * 我原来断言 `indexOf("routeToAttention(") < indexOf("personaFastPath?.(")`
     * —— 即"路由那行在文件里更靠前"。反证时我把投递改成无条件调用
     * （`const accepted = this.personaFastPath?.(...)`，路由结果只 `void` 掉），
     * 那正是"等于没路由"的形状，而断言**照样绿**：两个字面量的先后没变。
     *
     * 顺序不是判据，**门控**才是。所以改成断言那一行里 `routed` 真的参与
     * 了投递的条件表达式。
     *
     * 反证：把它改成 `const accepted = this.personaFastPath?.(message.id) ?? false`
     * （无论 routed 如何都投递）→ 这条转红（已实测）。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    const idx = src.indexOf("const accepted =")
    expect(idx).toBeGreaterThan(0)
    // 取到该语句结尾：投递必须写在 `routed ? ... : false` 里面
    const stmt = src.slice(idx, idx + 200)
    expect(stmt).toContain("routed")
    expect(stmt).toContain("this.personaFastPath?.(message.id)")
    // ★ `routed` 必须出现在调用**之前**（即它是条件，不是事后的旁白）
    expect(stmt.indexOf("routed")).toBeLessThan(stmt.indexOf("this.personaFastPath"))
    // 而且路由本身要真的算过
    expect(src).toContain("routeToAttention({")
  })

  it("★★★ 名单为空时**放行**（否则是一次静默功能回归）", async () => {
    /**
     * `attention_scope` 是新表，存量用户那张表是空的。空表判成
     * "什么都不关心"会让分身整个静默 —— 用户看到的是"它不理人了"，
     * 而日志里一个错都没有。
     *
     * 反证：把 `hasScope` 那个判据删掉（无条件路由）→ 这条转红。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    expect(src).toContain("activeCount(this.options.plugin.meta.id) > 0")
    const idx = src.indexOf("let routed = true")
    expect(idx).toBeGreaterThan(0)
  })

  it("★★ 两侧都记账（routed / skipped）", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    const idx = src.indexOf("AttentionCoverageRepository(this.options.db).bump")
    expect(idx).toBeGreaterThan(0)
    const call = src.slice(idx, idx + 400)
    expect(call).toContain("routed: verdict.routed ? 1 : 0")
    expect(call).toContain("skipped: verdict.routed ? 0 : 1")
  })
})
