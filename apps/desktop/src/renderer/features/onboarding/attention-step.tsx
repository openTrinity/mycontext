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
 *
 * ## ★★★ 三个互斥选项，而不是"勾选 + 一句解释"
 *
 * 改动前这里只有一个勾选列表 + 一句「一个都不勾 = 分身会盯全部」。
 * 那句话是对的，但它有两个问题：
 *
 * ① 它要求用户从一句解释里推断出一个**反直觉**的默认值 ——
 *    而相邻的上一步（学习范围）默认值方向恰好相反（一个都不采）；
 * ② 第三个意图（「先都不盯」）**压根表达不出来** —— 空数组在旧存储里
 *    与"从没配过"同形，于是那个选择没有任何落库痕迹。
 *
 * 现在走 `AttentionModePicker` + `SourcesDraft.attentionMode`（三态）。
 */
import { useMemo } from "react"
import { Checkbox } from "@mycontext/design"
import type { AttentionModeValue, ChannelConversationView } from "@mycontext/ipc-contract"
import { useChannelConversations } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { StepSection } from "./step-section.js"
import { AttentionModePicker } from "./attention-mode-picker.js"
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
  /**
   * 当前模式。
   *
   * ★★ `undefined`（存量草稿）按**勾了就 explicit、没勾就 all** 推断 ——
   * 那与改动前的**实际效果**一致（不勾 = 放行全部），所以重进引导的
   * 用户看到的是他上次那个选择，而不是一个被重置的默认值。
   */
  const mode: AttentionModeValue =
    value.attentionMode ?? (value.attentionConversationIds.length > 0 ? "explicit" : "all")

  const setMode = (next: AttentionModeValue): void => {
    /**
     * ★★★ 选「盯全部」时**清空名单**。
     *
     * 不清的话库里会既有 `mode: "all"` 又有一份具体名单 —— 而路由在
     * `all` 下压根不看名单，于是那份名单是一个**看不出无效的**残留：
     * 用户之后切回 explicit 会突然发现自己"盯着"几个早就忘了的群。
     *
     * ★ 反过来（explicit → all → explicit）会丢掉勾选，那是刻意的代价：
     * 让用户重勾一次，比让他带着一份自己不知道的名单走要好。
     */
    if (next === "all") {
      onChange({ ...value, attentionMode: "all", attentionConversationIds: [] })
      return
    }
    onChange({ ...value, attentionMode: next })
  }

  const toggle = (externalId: string): void => {
    const next = chosen.has(externalId)
      ? value.attentionConversationIds.filter((id) => id !== externalId)
      : [...value.attentionConversationIds, externalId]
    /**
     * ★ 勾任何一个都隐含 `explicit`：用户在挑具体会话这个动作本身
     * 就是"我要收窄"。不同步的话他会勾了几个却仍处于 `all` 模式，
     * 而那时他的勾选**完全没有效果**（路由不看名单）—— 一个静默的落空。
     */
    onChange({ ...value, attentionMode: "explicit", attentionConversationIds: next })
  }

  return (
    <StepSection
      title={t("attentionStep.title", { defaultValue: "数字分身监听范围" })}
      hint={t("attentionStep.hint", {
        defaultValue:
          "分身只处理这些会话从现在起的新消息。与上一步的学习范围不同：它不看历史，也可以随时关掉。",
      })}
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
        <div className="flex flex-col gap-3">
          {/*
            ★★★ 三个互斥选项**取代**了原来那句解释性文案。

            原来那句（「一个都不勾 = 分身会盯上一步所有已勾选的会话」）
            是对的，但它要求用户从一句话里推断出一个反直觉的默认值 ——
            而相邻的上一步（学习范围）默认值方向恰好相反。
            更糟的是第三个意图（「先都不盯」）压根表达不出来。
          */}
          <AttentionModePicker
            value={mode}
            onChange={setMode}
            learnedCount={candidates.length}
            chosenCount={value.attentionConversationIds.length}
          />

          {/*
            ★ 勾选列表**只在 explicit 下显示**：`all` 模式下路由不看名单，
            那时摆一个勾选列表出来就是邀请用户做一件没有效果的事。
          */}
          {mode === "explicit" ? (
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
          ) : null}
        </div>
      )}
    </StepSection>
  )
}
