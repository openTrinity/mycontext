/**
 * Policy 判定：**穷举全部条件组合**，不采样。
 *
 * 2^N 根本不需要属性测试的采样 —— 表驱动穷举是**证明**而不是抽查，
 * 而且不用引入新依赖。
 *
 * ★ 组合数由 `POLICY_CONDITIONS.length` 算出来，不写死：
 * 加一个条件时组合数自动翻倍，而**忘了在 `breakCondition` 里处理它**
 * 会是编译错误（那个 switch 是穷举的）。写死 256 的话加条件之后
 * 这个文件仍然全绿，只是少验了一半。
 *
 * 三条核心断言：
 * ① 全通过时 `decision='auto_sent'`；
 * ② **其余组合的 `decision_reason` 全部非空**；
 * ③ 授权缺失/过期时 reason ∈ {grant_missing, grant_expired}。
 *
 * 第 ② 条是这个模块存在的理由：静默降级是最难调试的产品行为 ——
 * 用户开了 auto 却总在出草稿，不告诉他命中了哪条，他只能放弃这个功能。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, MS_PER_HOUR, MS_PER_MINUTE } from "@mycontext/kernel"
import {
  CONDITION_TO_REASON,
  DECISION_REASONS,
  DEFAULT_RATE_LIMIT,
  DEFAULT_WORK_HOURS,
  evaluatePolicy,
  MIN_CONFIDENCE,
  UNEVALUATED_CONFIDENCE,
  POLICY_CONDITIONS,
  withinWorkHours,
  type PolicyInput,
} from "@mycontext/persona"

/** 工作日下午 3 点（周三）：默认工作时间内。 */
const IN_HOURS = new Date(2026, 6, 29, 15, 0, 0).getTime()
/** 同一天凌晨 3 点：工作时间外。 */
const OUT_OF_HOURS = new Date(2026, 6, 29, 3, 0, 0).getTime()

/** 全部条件都满足的基线输入。 */
function baseline(now: number): PolicyInput {
  return {
    replyMode: "auto",
    sceneAllowsAuto: true,
    agentAllowsAuto: true,
    confidence: 0.9,
    risk: "low",
    bannedPhraseHits: [],
    recentSendsInConversation: [],
    recentSendsGlobal: [],
    killSwitchActive: false,
    grant: { expiresAt: now + 7 * 24 * MS_PER_HOUR, revokedAt: null },
    dryRun: false,
    workHours: DEFAULT_WORK_HOURS,
    rateLimit: DEFAULT_RATE_LIMIT,
  }
}

/** 把某个条件"弄坏"。返回改坏后的输入。 */
function breakCondition(
  input: PolicyInput,
  condition: (typeof POLICY_CONDITIONS)[number],
  now: number,
): PolicyInput {
  switch (condition) {
    case "mode_is_auto":
      return { ...input, replyMode: "draft" }
    case "within_work_hours":
      // 工作时间靠 clock 而不是输入判定，所以这里改 workHours（等价于"现在不在时段内"）
      return { ...input, workHours: { days: [], startHour: 9, endHour: 19 } }
    case "scene_allows_auto":
      return { ...input, sceneAllowsAuto: false }
    case "agent_allows_auto":
      return { ...input, agentAllowsAuto: false }
    case "confidence_and_risk":
      return { ...input, confidence: 0.5 }
    case "no_banned_phrase":
      return { ...input, bannedPhraseHits: ["一定"] }
    case "within_rate_limit":
      /**
       * ★ 造够 `perConversation` 条（默认 5）落在窗口内 —— 少一条打不破。
       * 默认放宽后（1 分钟 5 条）这里必须跟着默认值走，写死 2 条会让
       * 这个 breaker 悄悄失效（穷举里这一位永远"没坏"，而那不会报错）。
       */
      return {
        ...input,
        recentSendsInConversation: Array.from(
          { length: input.rateLimit.perConversation },
          (_unused, index) => now - (index + 1) * 1000,
        ),
      }
    case "kill_switch_inactive":
      return { ...input, killSwitchActive: true }
    case "has_valid_grant":
      /**
       * ★ 用**被撤销**来打破这一条，不能用 `grant: null`。
       *
       * `null`（从没授权过）现在是**合法**状态 —— 因为
       * `chat chmod chat.message:send` 在真实环境上授不下来
       * （服务端 `scope未配置授权规则`），而 `send` 本身不要求它。
       * 硬性要求一个拿不到的东西等于把功能焊死。
       *
       * 仍然算失败的是「渠道明确说过不行」：撤销与过期。
       */
      return { ...input, grant: { expiresAt: null, revokedAt: now } }
  }
}

describe("★ 穷举全部条件组合", () => {
  const clock = new ManualClock(IN_HOURS)

  /** 生成全部 2^N 个"哪些条件被弄坏"的组合（N = 条件数）。 */
  const combinations = Array.from({ length: 1 << POLICY_CONDITIONS.length }, (_, mask) => {
    const broken = POLICY_CONDITIONS.filter((_, index) => (mask & (1 << index)) !== 0)
    return { mask, broken }
  })

  it("组合数是 2^条件数（穷举而不是采样）", () => {
    /**
     * 与条件数联动而不是写死。
     *
     * 同时下限断言：条件数至少 8 —— 防止有人把 POLICY_CONDITIONS
     * 删空之后这个文件"穷举了 1 个组合"照样全绿。
     */
    expect(POLICY_CONDITIONS.length).toBeGreaterThanOrEqual(8)
    expect(combinations.length).toBe(2 ** POLICY_CONDITIONS.length)
  })

  it("全通过（mask=0）时自动发送且无原因", () => {
    const verdict = evaluatePolicy(baseline(IN_HOURS), clock)
    expect(verdict).toEqual({ decision: "auto_sent", reason: null, failedConditions: [] })
  })

  /**
   * ★★ 这是本文件最重要的一条：其余 255 个组合的 reason **全部非空**。
   */
  it.each(combinations.filter((item) => item.broken.length > 0))(
    "mask=$mask（坏了 $broken.length 条）→ 有非空 reason",
    ({ broken }) => {
      let input = baseline(IN_HOURS)
      for (const condition of broken) input = breakCondition(input, condition, IN_HOURS)

      const verdict = evaluatePolicy(input, clock)
      expect(verdict.decision).not.toBe("auto_sent")
      expect(verdict.reason, `坏了 ${broken.join(",")} 却没有 reason`).not.toBeNull()
      expect(DECISION_REASONS).toContain(verdict.reason)
      // 被弄坏的条件都应出现在 failedConditions 里（而不是短路在第一个）
      for (const condition of broken) {
        expect(verdict.failedConditions, `${condition} 未被报告`).toContain(condition)
      }
    },
  )
})

describe("★ 授权门（外部强制）", () => {
  const clock = new ManualClock(IN_HOURS)

  /**
   * ★ 「从没授权过」**不再**是失败 —— 这是一次刻意的放宽。
   *
   * ## 为什么
   *
   * 实测 `chat chmod chat.message:send` 在真实环境上**授不下来**：
   * 服务端返回 `scope未配置授权规则: chat.message:send`
   * （`chat.group:destroy` 同样失败，说明整套 chmod 规则没开，
   * 不是我们参数拼错）。而 `chat message send --dry-run` **干净通过**、
   * 没有任何权限抱怨 —— 也就是发送本身不要求这道授权。
   *
   * 硬性要求一个拿不到的东西，结果是把一个实测可用的功能永久焊死：
   * 自动发送恒判 `grant_missing`，而用户无论如何都授不了权。
   *
   * ## 那还剩什么闸
   *
   * 撤销与过期仍然拦（见下面两条）—— 那是渠道**明确说过"不行"**。
   * 另外 policy 还有 8 条、`SendGuard` 还有急停 + 重读库比对 contentHash。
   * 被移除的只有"必须先有一条本地 grant 记录"这一条。
   *
   * 而"渠道到底允不允许发"改由**真发一次的返回**回答：权限类错误 →
   * 标撤销 + 降级为 draft + 不重试（`send-guard.ts` 里那段）。
   * 这与 `grant-manager.ts` 文件头一直写着的
   * 「`expires_at` 只是优化，正确性只来自真发一次看返回什么」终于一致了。
   */
  it("从未授权 → **通过**（那道授权在真实环境上拿不到，见注释）", () => {
    const verdict = evaluatePolicy({ ...baseline(IN_HOURS), grant: null }, clock)
    expect(verdict.failedConditions).not.toContain("has_valid_grant")
    expect(verdict.decision).toBe("auto_sent")
  })

  it("已过期 → grant_expired", () => {
    const verdict = evaluatePolicy(
      { ...baseline(IN_HOURS), grant: { expiresAt: IN_HOURS - 1, revokedAt: null } },
      clock,
    )
    expect(verdict.reason).toBe("grant_expired")
  })

  it("已撤销 → grant_missing（不是 expired：撤销与到期是两件事）", () => {
    const verdict = evaluatePolicy(
      { ...baseline(IN_HOURS), grant: { expiresAt: IN_HOURS + MS_PER_HOUR, revokedAt: IN_HOURS } },
      clock,
    )
    expect(verdict.reason).toBe("grant_missing")
  })

  it("permanent 授权（expiresAt=null）永不过期", () => {
    const verdict = evaluatePolicy(
      { ...baseline(IN_HOURS), grant: { expiresAt: null, revokedAt: null } },
      clock,
    )
    expect(verdict.decision).toBe("auto_sent")
  })

  /**
   * 这条是「授权到期次日 auto 静默失效」的回归：
   * 授权默认 TTL 只有 24h，不建模的话前 7 条全过而用户完全无法理解为什么没发。
   */
  it("授权 24h 后过期 → 次日自动降级为草稿且原因明确", () => {
    const grantedAt = IN_HOURS
    const laterClock = new ManualClock(grantedAt + 25 * MS_PER_HOUR)
    const verdict = evaluatePolicy(
      {
        ...baseline(grantedAt),
        // 25 小时后仍在工作时间（同一时刻的次日下午）
        workHours: { days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
        grant: { expiresAt: grantedAt + 24 * MS_PER_HOUR, revokedAt: null },
      },
      laterClock,
    )
    expect(verdict.decision).toBe("drafted")
    expect(verdict.reason).toBe("grant_expired")
  })
})

describe("★ agent 审核门", () => {
  it("agent 判定需要审核时降级草稿，且原因明确", () => {
    const verdict = evaluatePolicy(
      { ...baseline(IN_HOURS), agentAllowsAuto: false },
      new ManualClock(IN_HOURS),
    )
    expect(verdict.decision).toBe("drafted")
    expect(verdict.reason).toBe("agent_requires_review")
    expect(verdict.failedConditions).toContain("agent_allows_auto")
  })
})

describe("dry-run 是旁路而不是条件", () => {
  it("dry-run 时根本不评估 8 条", () => {
    const clock = new ManualClock(IN_HOURS)
    // 输入里所有条件都坏了
    let input: PolicyInput = { ...baseline(IN_HOURS), dryRun: true }
    for (const condition of POLICY_CONDITIONS) input = breakCondition(input, condition, IN_HOURS)
    input.dryRun = true

    const verdict = evaluatePolicy(input, clock)
    expect(verdict.reason).toBe("dry_run")
    // 没有条件被评估 —— 这正是"旁路"的意思
    expect(verdict.failedConditions).toEqual([])
  })

  it("dry_run 刻意不在 CONDITION_TO_REASON 里", () => {
    const mapped = Object.values(CONDITION_TO_REASON).flat()
    expect(mapped).not.toContain("dry_run")
  })
})

/**
 * ★★ `yolo` 档：不过判定闸，直接发。
 *
 * 用户显式要的一档（类似 `bypassPermissions`）。这一组锁三件事：
 * ① 全部条件都坏掉时**仍然**放行 —— 那正是它存在的意义；
 * ② 它是**旁路**而不是条件（不进 CONDITION_TO_REASON，与 `dry_run` 同待遇）；
 * ③ ★ **dry-run 优先于 yolo** —— `--dry-run` 是"绝不真发"的开关，
 *    yolo 不该穿过它，否则 dry-run 就不再安全了。
 *
 * ★ 急停不在这一层：它在 `SendGuard` 里（覆盖手动发送等**所有**路径），
 * 由 send-guard 的测试锁。这里只能确认 policy 这一层放行 ——
 * 所以下面那条 kill switch 的断言写的是"policy 放行但守卫会拦"，
 * 不是"policy 拦得住"。
 */
describe("★★ yolo 是旁路：不过判定闸直接发", () => {
  it("★★ 9 条全坏也放行（这正是这一档的意义）", () => {
    const clock = new ManualClock(OUT_OF_HOURS)
    let input: PolicyInput = baseline(OUT_OF_HOURS)
    for (const condition of POLICY_CONDITIONS) {
      input = breakCondition(input, condition, OUT_OF_HOURS)
    }
    // breakCondition 会把 mode 改成 draft，最后覆盖成 yolo
    input = { ...input, replyMode: "yolo" }

    const verdict = evaluatePolicy(input, clock)
    expect(verdict.decision).toBe("auto_sent")
    expect(verdict.reason).toBeNull()
    // 旁路：一条都没评估
    expect(verdict.failedConditions).toEqual([])
  })

  it("★★ dry-run 优先于 yolo（--dry-run 必须始终是安全的）", () => {
    const clock = new ManualClock(IN_HOURS)
    const verdict = evaluatePolicy(
      { ...baseline(IN_HOURS), replyMode: "yolo", dryRun: true },
      clock,
    )
    expect(verdict.decision).toBe("drafted")
    expect(verdict.reason).toBe("dry_run")
  })

  it("★ policy 层对 yolo + 急停也放行 —— 急停由 SendGuard 兜（见文件头）", () => {
    const clock = new ManualClock(IN_HOURS)
    const verdict = evaluatePolicy(
      { ...baseline(IN_HOURS), replyMode: "yolo", killSwitchActive: true },
      clock,
    )
    // policy 这一层确实放行；真正拦住它的是守卫里那一关（那里有独立断言）
    expect(verdict.decision).toBe("auto_sent")
  })

  it("yolo 不是条件，不进 CONDITION_TO_REASON（与 dry_run 同待遇）", () => {
    expect(POLICY_CONDITIONS).not.toContain("yolo" as never)
    const mapped = Object.values(CONDITION_TO_REASON).flat()
    expect(mapped).not.toContain("yolo" as never)
  })

  it("★ 反证：同样的坏输入换成 auto 就会被挡（证明上面放行来自 yolo）", () => {
    const clock = new ManualClock(OUT_OF_HOURS)
    let input: PolicyInput = baseline(OUT_OF_HOURS)
    for (const condition of POLICY_CONDITIONS) {
      input = breakCondition(input, condition, OUT_OF_HOURS)
    }
    input = { ...input, replyMode: "auto" }

    const verdict = evaluatePolicy(input, clock)
    expect(verdict.decision).toBe("drafted")
    expect(verdict.failedConditions.length).toBeGreaterThan(0)
  })
})

describe("条件 → 原因的映射完整性", () => {
  it("每个 policy 条件都有对应的 reason（漏配是编译错误，这里再兜一层）", () => {
    for (const condition of POLICY_CONDITIONS) {
      expect(CONDITION_TO_REASON[condition].length, `${condition} 没有配 reason`).toBeGreaterThan(0)
    }
  })

  it("映射里的每个 reason 都在 DECISION_REASONS 枚举里", () => {
    for (const reasons of Object.values(CONDITION_TO_REASON)) {
      for (const reason of reasons) expect(DECISION_REASONS).toContain(reason)
    }
  })

  it("除 dry_run 外，每个 reason 都被至少一个条件映射到（没有死枚举）", () => {
    const mapped = new Set(Object.values(CONDITION_TO_REASON).flat())
    for (const reason of DECISION_REASONS) {
      if (reason === "dry_run") continue
      expect(mapped.has(reason), `${reason} 不被任何条件映射（死枚举）`).toBe(true)
    }
  })
})

// `silent` 模式已废除（"这个会话别管"由 triggerMode:"none" 表达，
// 在管控层的 admit 里直接短路，根本不进 evaluatePolicy）。
// 保留 policy 的两档：draft / auto。旧用例删除，不再维护死枝。

describe("单条条件的细节", () => {
  const clock = new ManualClock(IN_HOURS)

  it("置信度恰好等于门槛时通过（>= 而不是 >）", () => {
    const verdict = evaluatePolicy({ ...baseline(IN_HOURS), confidence: MIN_CONFIDENCE }, clock)
    expect(verdict.decision).toBe("auto_sent")
  })

  it("置信度够但风险不低 → risk_not_low（与 low_confidence 区分开）", () => {
    const verdict = evaluatePolicy({ ...baseline(IN_HOURS), risk: "medium" }, clock)
    expect(verdict.reason).toBe("risk_not_low")
  })

  /**
   * ★ 「未评估」不等于「低置信度」。
   *
   * 我们没有自评机制。首版的做法是给一个假分数 0.6（恰好低于门槛），
   * 于是 `confidence_and_risk` 恒不通过 —— 自动发送被一个**编出来的数字**
   * 挡住。那在没有执行器时是安全的，但接了执行器之后它会变成唯一的闸，
   * 那时只能要么调高（凭空放行一切）要么删掉（少一道闸）。
   *
   * 现在用哨兵显式表示"没评估过"，把关交给场景判定（确定性、可审计）。
   * 这两条断言锁的是：哨兵**不**触发 `low_confidence`，
   * 但真实的低分**仍然**触发。
   */
  it("哨兵置信度（未评估）不报 low_confidence —— 把关交给场景", () => {
    const verdict = evaluatePolicy(
      { ...baseline(IN_HOURS), confidence: UNEVALUATED_CONFIDENCE },
      clock,
    )
    expect(verdict.failedConditions).not.toContain("confidence_and_risk")
    expect(verdict.decision).toBe("auto_sent")
  })

  it("真实的低分仍然报 low_confidence（哨兵不是「绕过这条判定」的后门）", () => {
    const verdict = evaluatePolicy({ ...baseline(IN_HOURS), confidence: 0.5 }, clock)
    expect(verdict.failedConditions).toContain("confidence_and_risk")
    expect(verdict.reason).toBe("low_confidence")
  })

  it("频率上限：窗口外的历史发送不计入", () => {
    const verdict = evaluatePolicy(
      {
        ...baseline(IN_HOURS),
        /**
         * 全部落在**窗口之外**（默认单会话窗口 1 分钟）—— 哪怕条数超上限，
         * 出窗了就不算。用 `perConversationWindowMs` 而不是写死 11 分钟：
         * 默认放宽后窗口是 1 分钟，写死会让这条测的东西漂掉。
         */
        recentSendsInConversation: Array.from(
          { length: baseline(IN_HOURS).rateLimit.perConversation + 3 },
          (_unused, i) =>
            IN_HOURS - baseline(IN_HOURS).rateLimit.perConversationWindowMs - i * 1000,
        ),
      },
      clock,
    )
    expect(verdict.decision).toBe("auto_sent")
  })

  it("全局频率上限独立生效", () => {
    const verdict = evaluatePolicy(
      {
        ...baseline(IN_HOURS),
        // 单会话不超，但全局塞满上限 → 只因全局这一关降级
        recentSendsGlobal: Array.from(
          { length: baseline(IN_HOURS).rateLimit.global },
          (_unused, i) => IN_HOURS - i * 1000,
        ),
      },
      clock,
    )
    expect(verdict.reason).toBe("rate_limited")
  })

  it("★★ 上限为 0 = 关掉这一关（不是永远限流）", () => {
    /**
     * ★ 反证：`withinRateLimit` 里如果对 0 不短路，`count >= 0` 恒成立 →
     * **永远**判 rate_limited。那是最坏的反向 bug —— 用户想放开却被彻底堵死，
     * 而 UI 上"上限 0"看起来就是"不限"。所以这条锁的是"0 真的放行"。
     */
    const verdict = evaluatePolicy(
      {
        ...baseline(IN_HOURS),
        rateLimit: {
          perConversation: 0,
          perConversationWindowMs: 60_000,
          global: 0,
          globalWindowMs: 3_600_000,
        },
        // 塞一大堆最近发送 —— 如果 0 没短路，这些会触顶
        recentSendsInConversation: Array.from({ length: 50 }, (_unused, i) => IN_HOURS - i * 100),
        recentSendsGlobal: Array.from({ length: 500 }, (_unused, i) => IN_HOURS - i * 100),
      },
      clock,
    )
    expect(verdict.decision).toBe("auto_sent")
    expect(verdict.failedConditions).not.toContain("within_rate_limit")
  })

  it("★ 单会话 0、全局非 0 → 只有全局那关生效（两关各自独立）", () => {
    const verdict = evaluatePolicy(
      {
        ...baseline(IN_HOURS),
        rateLimit: {
          perConversation: 0, // 这一关关了
          perConversationWindowMs: 60_000,
          global: 2, // 这一关开着，上限 2
          globalWindowMs: 3_600_000,
        },
        recentSendsInConversation: Array.from({ length: 50 }, (_unused, i) => IN_HOURS - i * 100),
        recentSendsGlobal: [IN_HOURS - 100, IN_HOURS - 200], // 达到全局上限 2
      },
      clock,
    )
    expect(verdict.reason).toBe("rate_limited")
  })

  it("失败时报告全部未通过条件（不短路在第一个）", () => {
    const verdict = evaluatePolicy(
      { ...baseline(IN_HOURS), replyMode: "draft", confidence: 0.1, killSwitchActive: true },
      clock,
    )
    expect(verdict.failedConditions).toContain("mode_is_auto")
    expect(verdict.failedConditions).toContain("confidence_and_risk")
    expect(verdict.failedConditions).toContain("kill_switch_inactive")
  })

  /**
   * ★ 默认值锁：单会话 1 分钟 5 条、全局 1 小时 100 条。
   *
   * 用户明确选定的值。写死断言是为了挡住"手滑改回 2/20"那一类回退 ——
   * 那不会有任何编译/测试信号（其它测试都用 baseline 的相对值），
   * 而默认值变严的后果是自动发莫名其妙又开始降级。
   */
  it("★ DEFAULT_RATE_LIMIT 是放宽后的 5 / 1min、100 / 1h", () => {
    expect(DEFAULT_RATE_LIMIT.perConversation).toBe(5)
    expect(DEFAULT_RATE_LIMIT.perConversationWindowMs).toBe(MS_PER_MINUTE)
    expect(DEFAULT_RATE_LIMIT.global).toBe(100)
    expect(DEFAULT_RATE_LIMIT.globalWindowMs).toBe(MS_PER_HOUR)
  })
})

describe("工作时间判定", () => {
  it("周中下午在时段内", () => {
    expect(withinWorkHours(IN_HOURS, DEFAULT_WORK_HOURS)).toBe(true)
  })

  it("凌晨不在时段内", () => {
    expect(withinWorkHours(OUT_OF_HOURS, DEFAULT_WORK_HOURS)).toBe(false)
  })

  it("周末不在时段内（默认只有周一到周五）", () => {
    const saturday = new Date(2026, 7, 1, 15, 0, 0).getTime()
    expect(new Date(saturday).getDay()).toBe(6)
    expect(withinWorkHours(saturday, DEFAULT_WORK_HOURS)).toBe(false)
  })

  it("边界：startHour 含、endHour 不含", () => {
    const nine = new Date(2026, 6, 29, 9, 0, 0).getTime()
    const nineteen = new Date(2026, 6, 29, 19, 0, 0).getTime()
    expect(withinWorkHours(nine, DEFAULT_WORK_HOURS)).toBe(true)
    expect(withinWorkHours(nineteen, DEFAULT_WORK_HOURS)).toBe(false)
  })
})
