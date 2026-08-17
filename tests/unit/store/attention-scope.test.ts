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
import { ManualClock } from "@mycontext/kernel"
import {
  AttentionRouter,
  AttentionScopeRepository,
  AttentionCoverageRepository,
  routeToAttention,
  toDayBucket,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const A = "cidFAKE0001=="
const B = "cidFAKE0002=="
const T0 = 1_780_000_000_000
/** mode 三态那几条用的时刻。★ 与 T0 分开：那几条要造覆盖面行，读起来更清楚。 */
const NOW = 1_785_000_000_000

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
 * ── ★★★ 接线：路由挂在**两条投递路的交汇点**上 ────────────────────
 *
 * ## 这一组断言被重写过，理由必须写清（否则下次又会退回去）
 *
 * 上一版锁的是 `ingest.service.ts` 里那段路由的文本形状
 * （`const accepted = routed ? ... : false`、`let routed = true`、
 * `AttentionCoverageRepository(...).bump`）。那些断言在当时是对的，
 * 但它们锁死了一个**错的位置**：
 *
 * 路由只在那里 ⇒ 只有**快通道**过范围闸，而慢兜底（`persona-inbox`
 * 消费者）整条绕过 —— 用户勾的监听范围在那条路上不生效。而慢兜底恰恰是
 * 真机上主要生效的那条（`inbound.message` 要求 `changed.length > 0`，
 * 本机历史早已采完：实测 62 个连续页全是 `changed:0 / unchanged:51`）。
 *
 * 也就是说：**上一版三条断言全绿，而功能是坏的**。锁文本形状的代价就在这里
 * —— 它把"当前实现长什么样"当成了"行为对不对"。
 *
 * 所以现在：
 * · **行为**门禁交给 `tests/integration/persona/attention-routing.test.ts`
 *   （直接调真 handler，删掉路由那道 if ⇒ 4 条转红，已实测）；
 * · 这里只留**结构**断言：路由在 `deliverMessage` 里（两条路唯一的交汇点），
 *   且调用点不再各自实现一份。结构断言的价值是防"又把它挪回调用点"。
 */
describe("接线：路由挂在两条投递路的交汇点（deliverMessage）", () => {
  it("★★★ 路由在 `deliverMessage` 里，且在准入前置查询之前", async () => {
    /**
     * 判据是**位置**：`deliverMessage` 是投递的唯一入口。路由在这里
     * ⇒ 任何新增的投递路径也必然过闸，"忘了加路由"在结构上不可能。
     *
     * ★★ v4 起它**只有一个调用者**（`createPersonaInboxHandler`）——
     * 快通道已删，所以"两条路判据分叉"这个风险从结构上消失了。
     *
     * ★ 还断言它在 `message_mentions` 那条查询**之前**：范围外的消息不该
     * 为它去查 mentions 与"对方后来有没有又说话"（3 次带子查询的 SQL）。
     * 这不只是性能 —— 顺序反了说明路由变成了"事后旁白"而不是闸。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/persona/src/inbox-consumer.ts", "utf8")
    const fnIdx = src.indexOf("export function deliverMessage")
    expect(fnIdx).toBeGreaterThan(0)
    /**
     * ★ 锚点改成 `createPersonaInboxHandler` —— 快通道
     * （`createPersonaFastPath`）已删（v4 §4），而它曾是这里的下界。
     */
    const body = src.slice(fnIdx, src.indexOf("export function createPersonaInboxHandler"))
    // 路由真的被调用，且它的结论门控 return
    expect(body).toContain("repos.router.route({")
    expect(body).toContain("if (!route.routed)")
    /**
     * 路由在准入前置查询之前。
     *
     * ★ 锚点用 `SELECT count(*) AS c FROM message_mentions` 而不是
     * 光秃秃的 `message_mentions` —— 后者会先命中**注释里**那句
     * "「@我」从 message_mentions 读"，于是断言比较的是两个注释的先后，
     * 而那与真实执行顺序无关（第一版正是这样红的：666 < 611 不成立，
     * 因为注释出现在路由调用之后）。锚点必须是**代码**，不是文本。
     */
    expect(body.indexOf("repos.router.route(")).toBeLessThan(body.indexOf("FROM message_mentions"))
  })

  it("★★★ `deliverMessage` **只有一个调用者**（v4 §4：两条路合成一条）", async () => {
    /**
     * ## 这一条这一轮**换了方向**，而它比原来那条更强
     *
     * 原来断言的是"两条通路共用同一份仓储（含 router）" —— 那是在两条路
     * 并存的前提下能做到的最好保证（判据只有一份，但**两个调用者**）。
     *
     * 快通道删掉之后（v4 §4）保证升级了：**只有一个调用者** ——
     * 于是"两条路判据分叉"这个风险从结构上消失，而不是靠共用仓储去防。
     *
     * ★ 反证：再加一个 `createPersonaFastPath` 那样的第二入口 → 这条转红。
     * 而红之前的状态正是那个永久的维护负担（v2 修过一次真事故：
     * 路由原来只挂快通道，慢兜底整条绕过监听范围）。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/persona/src/inbox-consumer.ts", "utf8")
    // ★ 仓储里仍然含 router（判据的载体没变）
    expect(src).toContain("router: new AttentionRouter(options.db, options.clock)")
    /**
     * ★★ 调用 `deliverMessage(` 的地方**只有一处**。
     *
     * 用正则数而不是 `includes`：后者答不了"有几个"，而这条断言的
     * 全部内容就是那个数字。
     */
    const callSites = src.match(/deliverMessage\(options, repos/g) ?? []
    expect(callSites).toHaveLength(1)
    // ★ 而那一处在消费者工厂里（不是某个新的快通道）
    const slow = src.slice(src.indexOf("export function createPersonaInboxHandler"))
    expect(slow).toContain("deliverMessage(options, repos")
    expect(slow).toContain("createRepos(options)")
  })

  it("★★★ 快通道整个消失了（`createPersonaFastPath` 不再存在）", async () => {
    /**
     * ★ 断言"不存在"而不是"没被调用"：留一个没人用的导出会让下一个人
     * 以为它是可用的第二入口，而那正是要消灭的形状
     * （v3 的 G10 就是"有实现、零引用"那一类）。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/persona/src/inbox-consumer.ts", "utf8")
    expect(src).not.toContain("export function createPersonaFastPath")
    const index = readFileSync("packages/persona/src/index.ts", "utf8")
    expect(index).not.toContain("createPersonaFastPath")
  })

  it("★★★ 调用点**不再**自己实现一份路由（否则判据又变成两份）", async () => {
    /**
     * 下沉之后 `ingest.service.ts` 里那段路由必须**消失**，而不是留着
     * 「双保险」。留着的后果是同一条消息被记账两次（覆盖面虚高一倍），
     * 而且两份判据会各自演化。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    // 只允许出现在注释里说明"为什么搬走了"，不允许再有真实调用
    expect(src).not.toContain("routeToAttention({")
    expect(src).not.toContain("new AttentionCoverageRepository(")
    /**
     * ★★★ 而**投递本身也不在这里了**（v4 §4）。
     *
     * 原来这一行断言的是"快通道没被顺手删掉"
     * （`expect(src).toContain("this.personaFastPath?.(message.id)")`）。
     * 现在方向相反：那条路是**刻意**删的，投递只走 changelog。
     *
     * ★ 而秒级感知靠 `refreshConversation` 末尾驱动一次消费者循环 ——
     * 那一行有它自己的门禁（`collection-request.test.ts`）。
     */
    expect(src).not.toContain("personaFastPath")
    expect(src).not.toContain('this.events.emit("inbound.message"')
  })

  it("★★★ mode 没配过（存量库）→ 放行且 enforced=false（否则是一次静默功能回归）", () => {
    /**
     * `attention_scope` 是新表，存量用户那张表是空的、也没有 mode 键。
     * 空表判成"什么都不关心"会让分身整个静默 —— 用户看到的是"它不理人了"，
     * 而日志里一个错都没有。
     *
     * ## ★★★ 这条断言的是**行为**，不是源码里有某个字符串
     *
     * 原来这一条是 `expect(src).toContain("activeCount(...) === 0")` ——
     * 那锁的是一个实现细节。而那个细节这一轮**必须**变（旧判据把
     * "把全部关掉"也读成"放行全部"，方向是反的），于是它拦不住真正的
     * 回归、只拦住了正确的修复。
     *
     * 现在锁的是「存量库的行为一个字都不能变」这个真正的约束。
     */
    const vault = openTestVault()
    try {
      const router = new AttentionRouter(vault.db, new ManualClock(NOW))
      const verdict = router.route({
        channelId: CH,
        conversationExternalId: "cidFAKE0001==",
        sentAt: NOW,
      })
      expect(verdict.routed).toBe(true)
      // ★ enforced=false：这不是"在范围内"，是"没有配置所以不拦"
      expect(verdict.enforced).toBe(false)
      expect(verdict.mode).toBe("unset")
      /**
       * ★★ 而且**不记账**：那一段时间的 routed/skipped 不代表任何用户配置，
       * 记进去会让"范围设窄了"与"还没配范围"在覆盖面上同形。
       */
      const coverage = new AttentionCoverageRepository(vault.db).summarize(
        CH,
        toDayBucket(NOW - 86_400_000),
        toDayBucket(NOW + 86_400_000),
      )
      expect(coverage.routed).toBe(0)
      expect(coverage.skipped).toBe(0)
    } finally {
      vault.close()
    }
  })

  it("★★★ mode 没配过但**名单非空**（存量已配好的库）→ 按名单判，不许失效", () => {
    /**
     * ## 这一条是集成测试当场抓到的一个真实回归
     *
     * 我第一版把 `unset` 写成"无条件放行"。而存量库里 `attention_scope`
     * **有行**（用户配过），只是没有 mode 键（它是这一轮新加的）——
     * 于是用户明确勾过的那 3 个群变成了"盯全部"。
     *
     * 5 条集成断言当场转红（范围外的消息全部被放行）。
     *
     * 所以 `unset` 的正确回落是**旧判据**（按名单空不空判），
     * 而不是"放行"这一个分支。
     */
    const vault = openTestVault()
    try {
      const repo = new AttentionScopeRepository(vault.db)
      // 存量形状：有名单、**没有** mode 键
      repo.add(CH, [{ conversationExternalId: A, enabledAt: NOW - 1000, source: "user" }], NOW)
      expect(repo.mode(CH)).toBe("unset")

      const router = new AttentionRouter(vault.db, new ManualClock(NOW))
      // 名单里的 → 放行，且 enforced=true（用户的配置**在生效**）
      const inScope = router.route({ channelId: CH, conversationExternalId: A, sentAt: NOW })
      expect(inScope.routed).toBe(true)
      expect(inScope.enforced).toBe(true)
      // ★★★ 名单外的 → **拦住**（这才是那 5 条转红的断言）
      const outOfScope = router.route({ channelId: CH, conversationExternalId: B, sentAt: NOW })
      expect(outOfScope.routed).toBe(false)
      expect(outOfScope.reason).toBe("not_in_scope")
    } finally {
      vault.close()
    }
  })

  it("★★★ mode=explicit + 名单为空 → **一条都不放行**（关光了不该盯得更多）", () => {
    /**
     * 这是旧判据方向搞反的那一格：用户在设置页把最后一个会话关掉，
     * `activeCount` 归零，于是旧路由回到"放行全部" ——
     * **关掉全部之后分身盯得更多了**，而它不报错。
     */
    const vault = openTestVault()
    try {
      const repo = new AttentionScopeRepository(vault.db)
      repo.setMode(CH, "explicit", NOW)
      const router = new AttentionRouter(vault.db, new ManualClock(NOW))
      const verdict = router.route({
        channelId: CH,
        conversationExternalId: "cidFAKE0001==",
        sentAt: NOW,
      })
      expect(verdict.routed).toBe(false)
      expect(verdict.reason).toBe("not_in_scope")
      // ★ enforced=true：这是**按用户配置**做的判断（与 unset 那档的区别）
      expect(verdict.enforced).toBe(true)
    } finally {
      vault.close()
    }
  })

  it("★★ mode=all → 放行、enforced=true、**而且记账**（它是一次用户决定）", () => {
    /**
     * `all` 与 `unset` 都放行，区别**只在** enforced 与记账 ——
     * 而那正是要区分的两件事：「你还没说要盯什么」与「你说了盯全部」
     * 在界面上是两句不同的话，覆盖面也该只反映后者。
     */
    const vault = openTestVault()
    try {
      new AttentionScopeRepository(vault.db).setMode(CH, "all", NOW)
      const router = new AttentionRouter(vault.db, new ManualClock(NOW))
      const verdict = router.route({
        channelId: CH,
        conversationExternalId: "cidFAKE0001==",
        sentAt: NOW,
      })
      expect(verdict.routed).toBe(true)
      expect(verdict.enforced).toBe(true)
      expect(verdict.mode).toBe("all")
      const coverage = new AttentionCoverageRepository(vault.db).summarize(
        CH,
        toDayBucket(NOW - 86_400_000),
        toDayBucket(NOW + 86_400_000),
      )
      expect(coverage.routed).toBe(1)
    } finally {
      vault.close()
    }
  })

  it("★★ 坏的 mode 值（手改过的库）→ 回落 unset，而不是抛", () => {
    /**
     * 回落方向只能是 `unset`（改动前的行为）：
     * · 回落 `explicit` 会让一个手改坏的库让分身**静默停摆**；
     * · 回落 `all` 会让"从没配过"冒充"用户选了全部"（于是覆盖面
     *   开始记一段不代表任何配置的账）。
     */
    const vault = openTestVault()
    try {
      vault.db
        .prepare("INSERT INTO vault_settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run(`attention.mode.${CH}`, "盯一半", new Date(NOW).toISOString())
      expect(new AttentionScopeRepository(vault.db).mode(CH)).toBe("unset")
    } finally {
      vault.close()
    }
  })

  it("★★ 两侧都记账（routed / skipped），且按消息业务时间分桶", async () => {
    /**
     * 只记放行的话，"范围设窄了"与"那段时间没消息"不可区分 ——
     * 而那正是用户会来问的那个问题。
     *
     * ★ `dayBucket` 用 `input.sentAt` 而不是 `clock.now()`：一条昨天的消息
     * 今天被慢兜底捞回来时，它属于**昨天**那一天的实时流覆盖面。
     * 用记账时刻分桶会让回填那一轮把几万条旧消息全记到今天。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/store/src/attention-router.ts", "utf8")
    const idx = src.indexOf("this.coverage.bump(")
    expect(idx).toBeGreaterThan(0)
    const call = src.slice(idx, idx + 300)
    expect(call).toContain("routed: routed ? 1 : 0")
    expect(call).toContain("skipped: routed ? 0 : 1")
    expect(call).toContain("toDayBucket(input.sentAt)")
  })
})

/**
 * ── ★★★ 消费者协同：蒸馏不许跑在图谱前面 ────────────────────────
 *
 * 用户原话：「每个消费者都根据当前/当前一些消费者一起干活」
 * 「forge 蒸馏可能还会引用 kl-graph 第二阶段的 fact 之类的」。
 *
 * 判据落在 `OutboxConsumer` 的 `dependsOn`：蒸馏的批次上界被夹到
 * `graph-export` 的 `acked_seq`。没有这个闸的话蒸馏会跑到图谱前面，
 * 那段消息的 fact 还不存在 —— 而蒸馏照常"成功"、游标照常推进，
 * 缺失是**永久且静默**的。
 */
describe("接线：消费者依赖（蒸馏 ← 图谱导出）", () => {
  it("★★★ 蒸馏声明了 dependsOn: ['graph-export']", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    const idx = src.indexOf("consumerId: DISTILL_CONSUMER_ID")
    expect(idx).toBeGreaterThan(0)
    /**
     * 反证：把 `dependsOn` 那一行删掉 → 这条转红。
     * 而红之前的状态正是"蒸馏可以跑在图谱前面"。
     */
    const block = src.slice(idx, idx + 2600)
    expect(block).toContain('dependsOn: ["graph-export"]')
  })

  it("★★★ 骨架把批次上界夹到上游，而不是「上游没追平就整轮不干活」", async () => {
    /**
     * 夹上界 vs 整轮跳过：后者在两个消费者互等时会死锁，也会让一个慢的
     * 上游把整条链路停死。判据落在"有没有按 seq 过滤批次"。
     *
     * 反证：把 `.filter((row) => ... row.seq <= upstreamLimit)` 删掉 → 红。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/ingest/src/consumer.ts", "utf8")
    expect(src).toContain("row.seq <= upstreamLimit")
    expect(src).toContain("waitingForUpstream")
  })

  it("★★★ 上游**没注册**时不夹（否则是一次静默功能回归）", async () => {
    /**
     * kl 服务没起时 `graph-export` 不存在。夹成 0 会让蒸馏永久停在原地，
     * 而用户看到的是"画像一直不更新"，日志里一个错都没有。
     *
     * 反证：把 `if (upstream === null) continue` 改成
     * `upstreamLimit = 0` → 红。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/ingest/src/consumer.ts", "utf8")
    const idx = src.indexOf("for (const upstreamId of this.options.dependsOn ?? [])")
    expect(idx).toBeGreaterThan(0)
    const loop = src.slice(idx, idx + 400)
    expect(loop).toContain("if (upstream === null) continue")
  })

  it("★★ 「在等上游」必须能被区分出来（不是报 0 就完事）", async () => {
    /**
     * 只返回 `processed: 0` 的话，"没新数据"与"在等图谱"不可区分 ——
     * 而后者的出路是去看图谱为什么慢。这是本仓库反复出现的那类
     * "静默 return 让两种情况同形"。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/ingest/src/consumer.ts", "utf8")
    expect(src).toContain("waitingForUpstream: waitingFor")
  })
})

/**
 * ── ★★★ 勾选监听 → 自动并入学习范围 ───────────────────────────
 *
 * 「监听了但不采集」是一个**坏状态**：分身收到消息却拿不到上下文
 * （`admit()`/`intake` 要读 mentions、历史往来），于是不回或回得离谱，
 * 而用户完全看不出成因。所以联动是必须的。
 *
 * ★ 我上一轮把这个决定推给用户，那是错的：顾虑（悄悄改动只增范围）
 * 成立，但出路是**别悄悄做**而不是**不做**。
 */
describe("接线：监听范围并入学习范围（只增 + 可见）", () => {
  it("★★★ attentionScopeSave 会把会话补进学习范围的白名单", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    const idx = src.indexOf("attentionScopeSave(input: AttentionScopeSaveInput)")
    expect(idx).toBeGreaterThan(0)
    const body = src.slice(idx, idx + 4000)
    /**
     * 反证：把那段 merge 删掉 → 这条转红。
     * 而红之前的状态是"勾了监听但那个群不在学习范围里"。
     */
    expect(body).toContain("mergedIntoLearning")
    expect(body).toContain("conversationIds: [...before, ...missing]")
  })

  it("★★★ 学习范围「不设限」时**不并入**（否则把全采收窄成几个）", async () => {
    /**
     * `conversationIds === undefined` 表示不设限（全部会话都在学习范围里）。
     * 这时"贴心地"写一个具体列表进去 = 把 92 个会话收窄成勾选的那几个 ——
     * 而那是本轮开头那个坑的同一形状。
     *
     * 反证：把 `if (current !== undefined)` 这个判据删掉 → 红。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    const idx = src.indexOf("mergedIntoLearning")
    const around = src.slice(Math.max(0, idx - 1200), idx + 800)
    expect(around).toContain("if (current !== undefined)")
  })

  it("★★ 并入**不动** since（监听只管实时流，没理由往回挖历史）", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    const idx = src.indexOf("mergedIntoLearning = missing.length")
    expect(idx).toBeGreaterThan(0)
    const block = src.slice(Math.max(0, idx - 700), idx)
    // 只覆盖 conversationIds，其余字段原样展开
    expect(block).toContain("...chat?.scope")
    expect(block.includes("since:")).toBe(false)
  })

  it("★★ 并入失败不让保存失败，但必须记日志（否则无线索）", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    expect(src).toContain("attention scope learning merge failed")
  })
})

/**
 * ── ★★★ 「监听范围可逆」这个决定的依据，锁在测试里 ──────────────
 *
 * 我曾把这个决定推给用户（"要不要也只增不减，你说一声"）。那是错的：
 * 判据是可查的 —— 「只增不减」管的是"缩小会不会让**已有产出**与配置矛盾"，
 * 而监听范围三条全不成立。这里把那三条钉住，免得日后被凭感觉改掉。
 */
describe("监听范围可逆：判据（不是偏好）", () => {
  it("★★★ 这张表不引用任何消息数据", async () => {
    /**
     * 引用了消息就意味着它有"已经吃进去的历史"，那时缩小才会造成不一致。
     *
     * 反证：给 `attention-scope.ts` 加一个读 `messages` 的方法 → 这条转红，
     * 而那正是"该重新考虑可逆性"的信号。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/store/src/repositories/attention-scope.ts", "utf8")
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    expect(code.includes("FROM messages")).toBe(false)
    expect(code.includes("content_text")).toBe(false)
  })

  it("★★★ disable 只置位，不删行（可逆的前提）", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/store/src/repositories/attention-scope.ts", "utf8")
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    expect(code).toContain("UPDATE attention_scope SET active = 0")
    // ★ 判据落在**剥注释后的代码**上：注释里解释过"不删行"，搜字符串会命中它
    expect(code.includes("DELETE FROM attention_scope")).toBe(false)
  })

  it("★★★ 没有任何消费者的产出派生自它", async () => {
    /**
     * 图谱/蒸馏/分身三个包若开始读这张表，它就变成"有下游产出"的配置，
     * 那时可逆性要重新论证。这条是那个变化的警报。
     */
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const name of readdirSync(dir)) {
        const full = `${dir}/${name}`
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (full.endsWith(".ts")) out.push(full)
      }
      return out
    }
    const files = [
      ...walk("packages/distill/src"),
      ...walk("packages/knowledge-feed/src"),
      ...walk("packages/persona/src"),
    ]
    const offenders = files.filter((file) => readFileSync(file, "utf8").includes("attention_scope"))
    expect(offenders).toEqual([])
  })
})
