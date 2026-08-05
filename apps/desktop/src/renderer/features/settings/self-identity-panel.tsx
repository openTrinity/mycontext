/**
 * 本人身份的确认入口。
 *
 * ## ★ 为什么这个入口必须存在
 *
 * 身份未确认时**每一条**消息的 `is_self` 都是 null，而蒸馏守卫会以
 * `identity_unconfirmed` 拒掉全部语料 —— 表现是"蒸馏跑完了，一条结论都没有"，
 * 且不报错。实测这个 vault 的 9768 条消息全部如此。
 *
 * `resolveSelf` / `confirmSelf` 在主进程里早就完整实现了，IPC 通道与 hook 也都在 ——
 * 缺的只是**有人去调它**。能力齐备而入口缺失，这类缺口不会报错，
 * 只会让下游功能静默产出 0。
 *
 * ## ★ 两步而不是一步
 *
 * 先 `resolve`（给出候选：姓名 + 工号 + 已识别到多少条本人消息），
 * 用户核对后再 `confirm`。
 *
 * 不合成一步是因为：同名同姓时 `resolveSelf` 会抛
 * `SELF_IDENTITY_AMBIGUOUS`（实测按姓名搜能返回 6 个不同 ID），
 * 而**身份错了之后画像全错且不可逆**（污染后的结论会作为下一轮的基线继续放大）。
 * 所以这里绝不"挑第一个" —— 歧义就把错误显示给用户。
 */
import { useState } from "react"
import { Button } from "@mycontext/design"
import type { SelfIdentityView } from "@mycontext/ipc-contract"
import { useConfirmSelf, useResolveSelf } from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface SelfIdentityPanelProps {
  /** 库里是否已确认（来自 ingest 快照） */
  confirmed: boolean
  /** 还有多少条消息没判定 is_self —— 那些会被蒸馏守卫拒掉 */
  unjudged: number
}

export function SelfIdentityPanel({ confirmed, unjudged }: SelfIdentityPanelProps) {
  const { t } = useDynamicTranslation("settings")
  const errorText = useErrorText()
  const resolve = useResolveSelf()
  const confirm = useConfirmSelf()
  const [resolved, setResolved] = useState<SelfIdentityView | null>(null)

  /**
   * 已确认且没有未判定消息 → 只显示一行状态，不占地方。
   *
   * 已确认但仍有未判定（新采进来的还没回填）也要显示入口 ——
   * 那些消息同样会被守卫拒掉。
   */
  if (confirmed && unjudged === 0) {
    return (
      <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
        {t("selfIdentity.confirmedOk")}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-[var(--gap-component-md)]">
      {/* 后果先说清：这不是一个"可选的优化"，而是蒸馏能不能出东西的前提 */}
      <p className="typography-body-small-400 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] px-3 py-2 text-[var(--text-base-secondary)]">
        {confirmed
          ? t("selfIdentity.partialWarning", { count: unjudged })
          : t("selfIdentity.warning")}
      </p>

      {resolve.error === null ? null : (
        <p className="typography-body-small-400 text-[var(--status-error)]">
          {errorText(resolve.error)}
        </p>
      )}
      {confirm.error === null ? null : (
        <p className="typography-body-small-400 text-[var(--status-error)]">
          {errorText(confirm.error)}
        </p>
      )}

      {/* 解析结果：让用户核对"这是我吗"，而不是让我们替他判断 */}
      {resolved === null ? null : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("selfIdentity.userId")}
          </dt>
          <dd className="typography-body-small-400 text-[var(--text-base-primary)]">
            {resolved.userId}
          </dd>
          <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("selfIdentity.names")}
          </dt>
          <dd className="typography-body-small-400 text-[var(--text-base-primary)]">
            {resolved.displayNames.join(" / ")}
          </dd>
          <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("selfIdentity.corp")}
          </dt>
          <dd className="typography-body-small-400 text-[var(--text-base-primary)]">
            {resolved.corpName ?? "—"}
          </dd>
          <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("selfIdentity.matched")}
          </dt>
          <dd className="typography-body-small-400 text-[var(--text-base-primary)]">
            {t("selfIdentity.matchedValue", { count: resolved.matchedMessageCount })}
          </dd>
        </dl>
      )}

      {confirm.data === undefined ? null : (
        <p className="typography-body-small-400 text-[var(--status-success)]">
          {t("selfIdentity.backfilled", {
            messages: confirm.data.backfilled,
            mentions: confirm.data.mentionsBackfilled,
          })}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="md"
          variant="secondary"
          disabled={resolve.isPending}
          onClick={() => {
            resolve.mutate(undefined, { onSuccess: (data) => setResolved(data) })
          }}
        >
          {t("selfIdentity.resolve")}
        </Button>
        <Button
          size="md"
          // 必须先解析：直接确认会抛"尚未解析身份"，那对用户毫无意义
          disabled={resolved === null || confirm.isPending}
          onClick={() => confirm.mutate()}
          title={t("selfIdentity.confirmHint")}
        >
          {t("selfIdentity.confirm")}
        </Button>
      </div>
    </div>
  )
}
