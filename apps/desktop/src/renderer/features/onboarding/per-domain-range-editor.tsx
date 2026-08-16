/**
 * 「某类数据单独设时间范围」—— 引导第 4 步与设置页的学习范围卡共用。
 *
 * ## ★★★ 为什么需要它（修 G14）
 *
 * `distill_sources` 本来就是**每个 kind 一行**，每行的 `scope_json` 各有
 * `since`/`until`。缺的一直是**引导页的表达**：保存循环算**一次** since，
 * 然后写给每个 kind。
 *
 * 而三个域的合理范围天然不同 —— 最实际的那一例是**文档**：
 * 规范文档三年前写的也有效，而「学最近 90 天」会把它们全排除。
 * 用户对文档的期望通常是"不限"，对聊天是"最近几个月"。
 *
 * `ingest.service.ts` 里那段注释早就写过这件事：「拿 chat 的范围去卡听记
 * 在这个应用里**恰好等价**，但那是**巧合而不是契约**」。
 *
 * ## ★★ 形状：**覆盖**，不是三份必填
 *
 * 绝大多数用户只想说一句"学最近 90 天"。让三个域都必填会把一个常见选择
 * 变成三次操作。所以缺省是「跟随」（不写这个键），只有想单独设的才展开。
 *
 * ★ 而"跟随"必须**显示出全局值是多少**（"跟随（90 天）"），
 * 否则用户看到一行"跟随"不知道跟的是什么 —— 那时他只能回去看上面那排筹码。
 */
import type { CoverageDomain } from "@mycontext/ipc-contract"
import { cn } from "@mycontext/design"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

/** 一个域的覆盖设置。`null` = 跟随全局。 */
export interface DomainRangeOverride {
  rangeDays: number | null
  customRange?: { from: string; to: string } | null
}

export interface PerDomainRangeEditorProps {
  /** 全局范围（用来把"跟随"那一项显示成"跟随（90 天）"） */
  globalRangeDays: number | null
  globalCustomRange?: { from: string; to: string } | null
  value: Partial<Record<CoverageDomain, DomainRangeOverride>>
  onChange: (next: Partial<Record<CoverageDomain, DomainRangeOverride>>) => void
  /**
   * 只显示这些域（= 用户勾选了的资料源）。
   *
   * ★ 必须过滤：给一个关掉的源显示范围设置等于邀请用户配一个不生效的值，
   * 而那个不一致（"我配了文档只学最近 30 天，可它一篇都没采"）
   * 完全看不出成因。
   */
  domains: readonly CoverageDomain[]
}

/**
 * 可选的档位。★ 与 `sources-step` 的 `RANGES` **刻意不完全一样**：
 * 这里多一个「跟随」（那是缺省），少几个中间档（per-domain 覆盖是少数需求，
 * 给太多档会让这一块看起来比它实际的重要性更重）。
 */
const OPTIONS: readonly { days: number | null | "inherit"; labelKey: string }[] = [
  { days: "inherit", labelKey: "sourcesStep.perDomain.inherit" },
  { days: 30, labelKey: "sourcesStep.perDomain.days30" },
  { days: 90, labelKey: "sourcesStep.perDomain.days90" },
  { days: 365, labelKey: "sourcesStep.perDomain.days365" },
  { days: null, labelKey: "sourcesStep.perDomain.unlimited" },
]

/** 域名的 i18n key（与覆盖面那三行同源，量词与名字都按域给）。 */
const DOMAIN_LABEL: Record<CoverageDomain, { key: string; fallback: string }> = {
  chat: { key: "sourcesStep.perDomain.domain.chat", fallback: "消息" },
  minutes: { key: "sourcesStep.perDomain.domain.minutes", fallback: "会议听记" },
  doc: { key: "sourcesStep.perDomain.domain.doc", fallback: "文档" },
}

/** 全局值的人话（给"跟随（…）"那一项）。 */
function globalLabel(
  rangeDays: number | null,
  custom: { from: string; to: string } | null | undefined,
): string {
  if (custom !== null && custom !== undefined) return `${custom.from} ~ ${custom.to}`
  return rangeDays === null ? "不限" : `${rangeDays} 天`
}

export function PerDomainRangeEditor({
  globalRangeDays,
  globalCustomRange,
  value,
  onChange,
  domains,
}: PerDomainRangeEditorProps) {
  const { t } = useDynamicTranslation("onboarding")

  const pick = (domain: CoverageDomain, days: number | null | "inherit"): void => {
    /**
     * ★★ 选「跟随」= **删掉这个键**，而不是写一个等于全局的值。
     *
     * 写一个具体值的后果是"跟随"这个语义消失了：之后用户改全局范围，
     * 这个域**不会跟着变** —— 而界面上它仍显示与全局相同的数字，
     * 于是那个静默的脱钩完全看不出来。
     */
    if (days === "inherit") {
      const next = { ...value }
      delete next[domain]
      onChange(next)
      return
    }
    /**
     * ★ 覆盖时**清掉自定义区间**：两者互斥（与全局那侧同一条判据）。
     * 留着会让"哪个生效"说不清。
     */
    onChange({ ...value, [domain]: { rangeDays: days, customRange: null } })
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("sourcesStep.perDomain.hint", {
          defaultValue:
            "不设就跟随上面那个范围。★ 文档常常该选「不限」—— 规范类文档三年前写的也有效。",
        })}
      </p>
      {domains.map((domain) => {
        const override = value[domain]
        const active = override?.rangeDays
        const label = DOMAIN_LABEL[domain]
        return (
          <div key={domain} className="flex flex-wrap items-center gap-2">
            <span className="typography-body-small-400 w-20 shrink-0 text-[var(--text-base-secondary)]">
              {t(label.key, { defaultValue: label.fallback })}
            </span>
            {OPTIONS.map((option) => {
              const selected =
                option.days === "inherit" ? override === undefined : active === option.days
              return (
                <button
                  key={String(option.days)}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pick(domain, option.days)}
                  className={cn(
                    "typography-caption-400 rounded-full border px-2.5 py-0.5 transition-colors duration-150",
                    selected
                      ? "border-[var(--text-accent-normal)] bg-[var(--bg-card-z0)] text-[var(--text-base-primary)]"
                      : "border-[var(--border-divider-light)] text-[var(--text-base-secondary)] hover:bg-[var(--bg-card-z0)]",
                  )}
                >
                  {option.days === "inherit"
                    ? /**
                       * ★★ 「跟随」必须**带上全局值** —— 否则用户看到一行
                       * "跟随"不知道跟的是什么，只能回去看上面那排筹码。
                       */
                      t(option.labelKey, {
                        defaultValue: "跟随（{{value}}）",
                        value: globalLabel(globalRangeDays, globalCustomRange),
                      })
                    : t(option.labelKey, {
                        defaultValue: option.days === null ? "不限" : `${option.days} 天`,
                      })}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
