/**
 * 采集频率设置。
 *
 * ## ★ 为什么必须有这个面板
 *
 * 周期本来就能配（`dh_settings.ingestIntervals`），但**没有任何界面入口** ——
 * 也就是"可配置"只对能开 SQLite 的人成立。对用户而言那等于写死。
 *
 * ## 为什么是离散档位而不是自由输入
 *
 * 一个手填的 `0`（或 `1`）会让采集把 CLI 调用打满、并挤掉发送。
 * 档位把"能填坏"这件事从界面上去掉，代价只是少了几个中间值。
 *
 * ## 两条必须写在界面上的话（否则会被当成 bug 报回来）
 *
 * · 探针是**基础周期**：`AdaptiveInterval` 在探针耗时超过周期一半时自动降频，
 *   所以设了 10s 可能看到 20s —— 不写清楚，用户会以为设置没生效。
 * · 全量拉取**不建议**跟着降到 10s：L2 是全量时间窗分页（实测一轮最多 600 页），
 *   加密只会占满采集锁并挤掉发送。真正让新消息秒级可见的是
 *   「事件叫醒 + 探针 hint → 定向补拉」。
 */
import { Disclosure } from "@mycontext/design"
import { useIngestIntervals, useSaveIngestIntervals } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { LimitRow } from "./persona-runtime-panel.js"

type IntervalKey =
  | "probeBaseMs"
  | "probeMaxMs"
  | "activeScanMs"
  | "pullMs"
  | "minutesMs"
  | "documentsMs"
  | "graphBuildMinIntervalMs"

/**
 * 各项的档位（毫秒）。范围与 `ingestIntervalsSchema` 的 min/max 对齐 ——
 * 界面给不出 schema 会拒掉的值（否则保存会失败而用户不知道为什么）。
 */
const OPTIONS: Record<IntervalKey, readonly number[]> = {
  probeBaseMs: [5_000, 10_000, 30_000, 60_000],
  probeMaxMs: [60_000, 120_000, 300_000],
  // 轮转扫描：15s–5min（schema 的区间）。比 pullMs 允许更勤 ——
  // 它的固定成本只有 1 次目录调用（带缓存）+ 1 次 GROUP BY。
  activeScanMs: [15_000, 30_000, 60_000, 300_000],
  pullMs: [60_000, 120_000, 300_000, 600_000],
  minutesMs: [600_000, 1_800_000, 3_600_000],
  // 文档：15min–6h（schema 的区间）。比听记宽 —— 知识库重度用户想更勤。
  documentsMs: [900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000],
  /**
   * ★ 建图最小间隔：15min–6h。**语义与上面几项相反** ——
   * 那些是"多久跑一次"，这一项是"**至少**隔多久才允许再建一次"。
   *
   * 建图是这个产品里最贵的一次操作（改一次图要重算全图的相似度与社区），
   * 而"攒够 500 条"在活跃群里十几分钟就达标 —— 所以需要一道冷却。
   * 下界 15min 是因为再短就等于没有冷却；上界 6h 留在 24h 兜底之下。
   */
  graphBuildMinIntervalMs: [900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000],
}

/** 毫秒 → 人能读的档位文案（`10s` / `2min` / `1h`）。 */
function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`
  return `${Math.round(ms / 3_600_000)}h`
}

export function IngestIntervalsPanel() {
  const { t } = useDynamicTranslation("settings")
  const intervals = useIngestIntervals()
  const save = useSaveIngestIntervals()
  const current = intervals.data

  return (
    <Disclosure
      title={t("ingestIntervals.title")}
      hint={t("ingestIntervals.description")}
      defaultOpen={false}
    >
      {current === undefined ? (
        <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
          {t("ingestIntervals.loading")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {(Object.keys(OPTIONS) as IntervalKey[]).map((key) => (
            <LimitRow
              key={key}
              label={t(`ingestIntervals.fields.${key}`)}
              hint={t(`ingestIntervals.hints.${key}`)}
              value={current[key]}
              options={OPTIONS[key]}
              busy={save.isPending}
              format={formatMs}
              onChange={(next) => save.mutate({ [key]: next })}
            />
          ))}
          {/*
            ★ 这一条不是补充说明，是**防误报**：保存后重挂采集才生效，
            而重挂是瞬时的、界面上看不见。不说的话"点了没反应"会被报上来。
          */}
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("ingestIntervals.note")}
          </p>
        </div>
      )}
    </Disclosure>
  )
}
