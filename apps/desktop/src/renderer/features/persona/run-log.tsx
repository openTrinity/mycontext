/**
 * RunLog —— 运行日志：每次调度的 decision + 原因。
 *
 * ## 为什么这一栏必须存在
 *
 * 用户开了监听却什么都没发生时，除了这里没有任何地方能看出**发生了什么**：
 * 是根本没触发（准入闸丢掉了）、还是触发了但判了只出草稿、
 * 还是模型调用报错。这三种情况的下一步动作完全不同。
 *
 * ## decision 用色块而不是文字
 *
 * `auto_sent` / `drafted` / `silent` / `error` 四态，扫一眼要能看出
 * 有没有 error —— 而一列等宽的中文词是扫不出来的。
 */
import { Tag } from "@mycontext/design"
import type { PersonaRunView } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { explainDecisionReason } from "./decision-reason.js"
import { DECISION_STATUS } from "./labels.js"

export interface RunLogProps {
  runs: readonly PersonaRunView[]
}

function timeLabel(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function RunLog({ runs }: RunLogProps) {
  const { t } = useDynamicTranslation("persona")

  return (
    <div className="flex flex-col gap-2">
      <h3 className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
        {t("runsTitle")}
      </h3>

      {runs.length === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
            {t("noRuns")}
          </p>
          {/* 空日志的两种可能：没开监听 / 开了但没触发。都给出去 */}
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("noRunsHint")}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {runs.map((run) => {
            const explained = explainDecisionReason(run.decisionReason)
            return (
              <li
                key={run.id}
                className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] px-1.5 py-1 hover:bg-[var(--overlay-on-container-hover)]"
              >
                <span className="typography-caption-400 flex items-center gap-1.5">
                  <Tag size="sm" status={DECISION_STATUS[run.decision] ?? "default"}>
                    {/* 没有对应文案的 decision 原样显示 —— 兜底文案会把它伪装成已知态 */}
                    {DECISION_STATUS[run.decision] === undefined
                      ? run.decision
                      : t(`decisions.${run.decision}`)}
                  </Tag>
                  <span className="text-[var(--text-base-tertiary)]">
                    {timeLabel(run.createdAt)}
                  </span>
                  {/* 耗时与 token：调"为什么这么慢/这么贵"时唯一有用的两个数 */}
                  {run.latencyMs === null ? null : (
                    <span className="text-[var(--text-base-tertiary)]">
                      {t("latency", { ms: run.latencyMs })}
                    </span>
                  )}
                  {run.costTokens === null ? null : (
                    <span className="text-[var(--text-base-tertiary)]">
                      {t("tokens", { count: run.costTokens })}
                    </span>
                  )}
                </span>

                {/* ★ 未自动发送时的原因必须显示：静默降级最难调试 */}
                {run.decisionReason === null ? null : (
                  <span className="typography-caption-400 text-[var(--text-base-secondary)]">
                    {explained === null ? run.decisionReason : t(explained.labelKey)}
                  </span>
                )}

                {run.error === null ? null : (
                  <span className="typography-caption-400 break-words text-[var(--status-error)]">
                    {run.error}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
