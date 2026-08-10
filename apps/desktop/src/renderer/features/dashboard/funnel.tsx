/**
 * 消化漏斗 —— 「喂进去多少 → 落地多少」。
 *
 * ## ★★ 这一块是本轮最有信息量的一个图，因为它的缺口现在完全不可见
 *
 * 实测本机（32,878 条消息的库）：
 *
 * ```
 * messages  32,878  ────────────────────────────  100%
 * units     32,930  ────────────────────────────  100%   （登记的处理单元）
 * chunks     3,409  ██▉                            10.4%  （切块，多条消息并一块）
 * facts        975  ▊                               28.6% of chunks
 * entities     602  ▌                               61.7% of facts
 * ```
 *
 * 而 `graph-build` 消费者的 `acked_seq` 只有 2,871 —— changelog head 是
 * 34,142，**落后 31,271 条，只消化了 8.4%**。
 *
 * 现在的界面上完全看不出来：实体数在涨、没有报错、状态一切正常。
 * 唯一的症状是"结论有点少"，而"少"**没有参照物**。这正是 CLAUDE.md §4
 * 说的那类最贵的 bug。把每一级的绝对值摊开，缺口就有了参照物。
 *
 * ## ★ 为什么是横向条而不是真的梯形漏斗
 *
 * 梯形漏斗（每级一个梯形块）把**面积**当编码通道，而面积是人最不擅长
 * 比较的那个（Cleveland–McGill）。这里五级的量级差到 50 倍，用长度编码
 * 才读得出来。而且横排能把级名与数值都写在同一行 —— 不需要图例。
 *
 * ## ★ 比率用「相对上一级」而不是「相对第一级」
 *
 * 相对第一级的话后三级都是个位数百分比（10.4% / 3.0% / 1.8%），
 * 看起来像"全都在漏" —— 而 messages→chunks 那一步的下降是**设计如此**
 * （多条消息合成一块）。相对上一级才能指出**哪一步**真的在漏。
 */
import { cn } from "@mycontext/design"
import { formatCount } from "./dashboard-data.js"

export interface FunnelStage {
  label: string
  /** `null` = 读不到（图库不存在）。**与 0 必须区分** —— 见下面渲染处 */
  value: number | null
  /** 一句话解释这一级是什么 / 为什么会掉 */
  hint?: string
  color: string
}

export interface FunnelProps {
  stages: readonly FunnelStage[]
}

/**
 * 横向漏斗。
 *
 * 条的几何跟 `Distribution` 一致（同一页里两种条不该长得不一样）：
 * 10px 高、数据端 4px 圆角、同色系浅轨道、**直接标数值**
 * （relief 规则要求的 —— 浅色主题下某些 slot 对比度低于 3:1）。
 */
export function Funnel({ stages }: FunnelProps) {
  /**
   * 分母取**第一级**而不是最大值。
   *
   * ★ `units`（32,930）实测比 `messages`（32,878）**略大** —— 图谱侧会把
   * 文档与听记也登记成单元。用 max 当分母的话第一条就不满格，
   * 而"消息数不是 100%"会让人以为消息丢了。
   */
  const base = stages[0]?.value ?? 0

  return (
    <div className="flex flex-col gap-1">
      {stages.map((stage, index) => {
        const prev = index === 0 ? null : (stages[index - 1]?.value ?? null)
        const ratio = base === 0 || stage.value === null ? 0 : stage.value / base
        /**
         * 相对上一级的留存率。null = 算不出来（第一级，或任一端读不到）。
         * ★ 上一级为 0 时也是 null 而不是 0% —— `0/0` 没有意义，
         *   而显示 "0%" 会读成"这一步全漏了"。
         */
        const retention =
          prev === null || prev === 0 || stage.value === null ? null : stage.value / prev

        return (
          <div key={stage.label} className="flex items-center gap-3">
            <span className="typography-caption-400 w-[76px] shrink-0 truncate text-[var(--text-base-secondary)]">
              {stage.label}
            </span>
            <span
              className="relative h-[10px] min-w-0 flex-1 overflow-hidden rounded-[2px]"
              style={{ background: `color-mix(in oklab, ${stage.color} 12%, transparent)` }}
            >
              <span
                className="absolute inset-y-0 left-0 rounded-l-[2px] rounded-r-[4px]"
                style={{
                  width: `${String(Math.max(ratio * 100, stage.value !== null && stage.value > 0 ? 1.5 : 0))}%`,
                  background: stage.color,
                }}
              />
            </span>
            {/* 数值。列对齐 → tabular-nums */}
            <span className="typography-caption-400 w-[64px] shrink-0 text-right tabular-nums text-[var(--text-base-primary)]">
              {/*
               * ★★ 读不到时显示 `—` 而不是 `0`。
               *
               * 「还没建图」与「建了但一条都没抽到」的处置完全不同
               * （前者去点建图，后者要查为什么抽空）。把"不知道"显示成
               * "零"会让一个新装的库看起来像一个坏掉的库。
               */}
              {stage.value === null ? "—" : formatCount(stage.value)}
            </span>
            {/* 相对上一级的留存率 */}
            <span
              className={cn(
                "typography-caption-400 w-[52px] shrink-0 text-right tabular-nums",
                // ★ 低留存**不染红**：messages→chunks 掉到 10% 是设计如此
                //   （多条消息合一块）。染红会把正常行为报成故障。
                "text-[var(--text-base-tertiary)]",
              )}
            >
              {retention === null ? "" : `${(retention * 100).toFixed(retention < 0.1 ? 1 : 0)}%`}
            </span>
          </div>
        )
      })}
      {/* 每一级的解释，收在底部一行行列出 —— 挂在条上会挤 */}
      <div className="mt-1 flex flex-col gap-0.5">
        {stages
          .filter((s) => s.hint !== undefined)
          .map((s) => (
            <p key={s.label} className="typography-caption-400 text-[var(--text-base-tertiary)]">
              <span className="text-[var(--text-base-secondary)]">{s.label}</span> · {s.hint}
            </p>
          ))}
      </div>
    </div>
  )
}
