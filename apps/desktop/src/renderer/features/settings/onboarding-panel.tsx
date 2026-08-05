/**
 * 引导流程的设置入口：看四步状态 + 重新走一遍。
 *
 * ## 为什么设置里也要有
 *
 * 引导页只在 `needsOnboarding` 为真时出现，走完就再也进不去了。
 * 但用户会想改数字人名字、换蒸馏范围、重蒸一遍 —— 那些都在引导里。
 * 没有这个入口，唯一的办法是删库重来。
 *
 * ## ★ 重蒸不会产生重复
 *
 * `reset` 只清水位（`last_synced_seq`），**不删已有 facet**：
 * facet 合并按 `(facet, scope, scope_ref, key)` 定位并按证据合并，
 * 重蒸只会补充/更新。删 facet 反而会丢掉人工确认过的、
 * 或来自别的源的结论 —— 那是不可逆的损失。
 */
import { Button, cn } from "@mycontext/design"
import type { OnboardingStepId } from "@mycontext/ipc-contract"
import {
  useDistillSources,
  useOnboardingSteps,
  useResetDistillSource,
  useRestartOnboarding,
} from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

const STEP_ORDER: readonly OnboardingStepId[] = [
  "channel",
  "model",
  "persona",
  "sources",
  "distill",
]

export function OnboardingPanel() {
  const { t } = useDynamicTranslation("settings")
  const { t: to } = useDynamicTranslation("onboarding")
  const errorText = useErrorText()
  const steps = useOnboardingSteps()
  const sources = useDistillSources()
  const restart = useRestartOnboarding()
  const resetSource = useResetDistillSource()

  const byStep = new Map((steps.data ?? []).map((row) => [row.step, row]))

  return (
    <div className="flex flex-col gap-[var(--gap-section-md)]">
      <ol className="flex flex-col gap-1">
        {STEP_ORDER.map((id) => {
          const state = byStep.get(id)?.state ?? "pending"
          return (
            <li
              key={id}
              className="flex items-baseline justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2 odd:bg-[var(--bg-card-z0)]"
            >
              <span className="typography-body-small-400 text-[var(--text-base-primary)]">
                {to(`steps.${id}`)}
              </span>
              <span
                className={cn(
                  "typography-caption-400",
                  state === "done"
                    ? "text-[var(--status-success)]"
                    : "text-[var(--text-base-tertiary)]",
                )}
              >
                {to(`state.${state}`)}
              </span>
            </li>
          )
        })}
      </ol>

      {restart.error === null ? null : (
        <p className="typography-body-small-400 text-[var(--status-error)]">
          {errorText(restart.error)}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Button
            size="md"
            variant="secondary"
            disabled={restart.isPending}
            onClick={() => restart.mutate()}
          >
            {to("restart")}
          </Button>
          {/*
            重置蒸馏水位与重走引导是**两件事**：
            前者让已启用的源从头再蒸一遍（用于"我改了范围想重来"），
            后者只是重新走一遍那四个页面。合成一个按钮会让想改名字的人
            顺带把几千条消息重蒸一次。
          */}
          <Button
            size="md"
            variant="ghost"
            disabled={resetSource.isPending}
            onClick={() => {
              for (const source of sources.data ?? []) {
                if (source.enabled) resetSource.mutate({ kind: source.kind })
              }
            }}
            title={t("onboarding.resetDistillHint")}
          >
            {t("onboarding.resetDistill")}
          </Button>
        </div>
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {to("restartHint")}
        </p>
      </div>
    </div>
  )
}
