/**
 * 引导流程的设置入口：看四步状态 + 重新走一遍 + 清空当前渠道的数据。
 *
 * ## 为什么设置里也要有
 *
 * 引导页只在 `needsOnboarding` 为真时出现，走完就再也进不去了。
 * 但用户会想改数字人名字、换蒸馏范围、重蒸一遍 —— 那些都在引导里。
 * 没有这个入口，唯一的办法是删库重来。
 *
 * ## ★★ 「清空当前渠道的数据」换掉了「重置蒸馏水位」
 *
 * 原来那个按钮只清 `distill_sources.last_synced_seq` 与 `distill_tasks`，
 * **不删任何数据**。问题是它回答不了用户真正想做的那件事：「这个渠道的
 * 数据脏了 / 我改了范围，我要它从零重来」—— 重置水位之后语料、索引、图谱、
 * forge 的派生库全都还在，于是重蒸出来的画像与之前几乎一样。
 * 按钮看起来生效了，实际什么都没变（这正是这个代码库里最贵的那类问题）。
 *
 * 现在那个动作本身仍然存在，只是**不再需要一个按钮**：改采集范围时
 * 主进程会自动跑同一条链（清越界 → 重导出 → 重建图 → 重蒸），
 * 见 `DistillSourceService.onScopeChanged`。
 *
 * 清空是**不可逆**的，所以走确认框且先预演出条数 ——
 * 见 `ChannelDataWipeDialog` 的文件头。
 */
import { useEffect, useState } from "react"
import { Button, cn } from "@mycontext/design"
import type { ChannelDataWipeResult, OnboardingStepId } from "@mycontext/ipc-contract"
import { useOnboardingSteps, useRestartOnboarding, useWipeChannelData } from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { ChannelDataWipeDialog } from "./channel-data-wipe-dialog.js"

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
  const restart = useRestartOnboarding()
  const wipe = useWipeChannelData()

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [preview, setPreview] = useState<ChannelDataWipeResult | null>(null)

  /*
   * 打开框时先跑一次预演，把真实条数拿来给用户看（见 dialog 的文件头）。
   *
   * ★ 每次打开都重新数，不缓存：两次打开之间采集一直在跑，
   * 显示一个几分钟前的数字会让用户以为清空的范围就是那么大。
   */
  useEffect(() => {
    if (!confirmOpen) return
    setPreview(null)
    wipe.mutate({ dryRun: true }, { onSuccess: (result) => setPreview(result) })
    // `wipe` 每次渲染都是新对象，加进依赖会让这个 effect 反复重跑（每次都再数一遍）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmOpen])

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
            清空与重走引导是**两件事**，所以是两颗按钮：
            前者删这个渠道采到的一切（不可逆），后者只是重新走一遍那五个页面。
            合成一个会让想改名字的人顺手删掉几万条聊天记录。

            用 ghost 而不是 danger：这是设置页里一个不常用的入口，
            一颗常驻的红按钮会让整个面板看起来危险。真正的危险提示
            在确认框里（那里才是做决定的地方）。
          */}
          <Button
            size="md"
            variant="ghost"
            disabled={wipe.isPending}
            onClick={() => setConfirmOpen(true)}
            title={t("dataWipe.hint")}
          >
            {t("dataWipe.action")}
          </Button>
        </div>
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {to("restartHint")}
        </p>
      </div>

      <ChannelDataWipeDialog
        open={confirmOpen}
        preview={preview}
        loading={wipe.isPending && preview === null}
        wiping={wipe.isPending && preview !== null}
        error={wipe.error === null ? null : errorText(wipe.error)}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          wipe.mutate(
            { dryRun: false },
            {
              // 只在**成功**时关框：失败要让用户看到原因，而不是框一闪而过
              onSuccess: () => setConfirmOpen(false),
            },
          )
        }}
      />
    </div>
  )
}
