/**
 * 引导步骤：**数字分身监听范围**（与学习范围分开的独立一步）。
 *
 * ## ★★★ 为什么它是独立一步，而不是塞在「学习范围」那一步里
 *
 * 用户原话：「在 onboarding 也应该加一个步骤，不和学习范围放一起」。
 *
 * 学习范围（`sources` 那一步）与监听范围语义**相反**：
 * · 学习范围：往回挖多少历史、只增不减；
 * · 监听范围：盯哪些会话的**新**消息、可随时关掉。
 *
 * 挤在同一步里，用户会以为是一件事的两个选项。分成两步、各有各的标题与
 * 说明，才让"学它什么"与"让它盯什么"这两个决定被分开表达。
 *
 * ## ★★ 候选**只有已勾进学习范围**的会话（前置防护）
 *
 * 「监听了但不采集」是一个能配出来的坏状态：`admit()` 判该不该回要读历史
 * （`message_mentions`、这个会话之前的往来），所以分身会收到消息却拿不到
 * 任何上下文，于是不回或回得离谱 —— 而用户看不出成因。
 *
 * 把候选限定在"上一步已勾选的会话"，那个坏状态在引导里**配不出来**。
 * 这也是这一步必须排在 `sources` **之后**的原因：候选来自上一步的选择。
 *
 * ## ★ 与 `sources-step` 的 `AttentionSection` 是同一段逻辑
 *
 * 它原来嵌在学习范围那一步里（作为下半块）。拆成独立步骤后，那一段挪到
 * 这里，`sources-step` 不再引用它 —— 判据只有一份，不复制。
 */
import { useMemo } from "react"
import { Button, Checkbox } from "@mycontext/design"
import type { ChannelConversationView } from "@mycontext/ipc-contract"
import { useChannelConversations } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { StepSection } from "./step-section.js"
import type { SourcesDraft } from "./sources-step.js"

export interface AttentionStepProps {
  value: SourcesDraft
  onChange: (next: SourcesDraft) => void
  /**
   * 只列这些渠道的会话（与 `SourcesStep` 同一个判据）。
   * 候选还要再过一道"已勾进学习范围"，见下。
   */
  channelFilter?: ReadonlySet<string>
}

export function AttentionStep({ value, onChange, channelFilter }: AttentionStepProps) {
  const { t } = useDynamicTranslation("onboarding")
  const conversations = useChannelConversations(true)

  /**
   * 候选 = **已勾进学习范围**（上一步）且属于当前渠道的会话。
   *
   * ★ 两道过滤：先按 `channelFilter` 收窄到已连渠道（与学习范围一致），
   * 再取其中 `conversationIds` 里有的 —— 那是"上一步选了要学的"。
   * 没勾进学习范围的会话不该出现在这里（见文件头的前置防护）。
   */
  const candidates = useMemo<readonly ChannelConversationView[]>(() => {
    const all = conversations.data?.items ?? []
    const inChannel =
      channelFilter === undefined
        ? all
        : all.filter((item) => item.channelId === undefined || channelFilter.has(item.channelId))
    const learned = new Set(value.conversationIds)
    return inChannel.filter((item) => learned.has(item.externalId))
  }, [conversations.data, channelFilter, value.conversationIds])

  const chosen = new Set(value.attentionConversationIds)
  const toggle = (externalId: string): void => {
    const next = chosen.has(externalId)
      ? value.attentionConversationIds.filter((id) => id !== externalId)
      : [...value.attentionConversationIds, externalId]
    onChange({ ...value, attentionConversationIds: next })
  }

  return (
    <StepSection
      title={t("attentionStep.title", { defaultValue: "数字分身监听范围" })}
      hint={t("attentionStep.hint", {
        defaultValue:
          "分身只处理这些会话从现在起的新消息。与上一步的学习范围不同：它不看历史，也可以随时关掉。",
      })}
      action={
        value.attentionConversationIds.length > 0 ? (
          <span className="flex items-center gap-2">
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("attentionStep.selected", {
                defaultValue: "盯 {{count}} 个会话",
                count: value.attentionConversationIds.length,
              })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange({ ...value, attentionConversationIds: [] })}
            >
              {t("attentionStep.clear", { defaultValue: "取消全部监听" })}
            </Button>
          </span>
        ) : undefined
      }
    >
      {candidates.length === 0 ? (
        /**
         * ★ 候选为空时说清**为什么**，而不是给一个空列表。
         * 空列表读起来像"坏了"，而真相是"回上一步勾几个会话" ——
         * 那是一个用户能立刻执行的动作。
         */
        <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
          {t("attentionStep.empty", {
            defaultValue:
              "上一步还没勾选要学习的会话 —— 先选好学习范围，再从中挑出让分身盯着的那些。",
          })}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {/*
            ★★ 「不勾任何一个」是一个**有意义**的选择，必须说出来。

            存量行为是"名单为空 → 全部放行"（迁移期的正确一侧，见
            `AttentionRouter.route`）。所以不勾 = 分身盯所有已学习的会话。
            不说这句，用户以为"不勾就是不启用"，而事实相反。
          */}
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("attentionStep.emptyMeaning", {
              defaultValue: "一个都不勾 = 分身会盯上一步所有已勾选的会话（可稍后在设置里收窄）。",
            })}
          </p>
          <ul className="flex flex-col gap-1">
            {candidates.map((item) => (
              <li key={item.externalId}>
                <Checkbox
                  checked={chosen.has(item.externalId)}
                  onChange={() => toggle(item.externalId)}
                  label={item.title ?? item.externalId.slice(0, 8)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </StepSection>
  )
}
