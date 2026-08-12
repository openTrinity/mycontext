/**
 * 数字分身的**监听范围**（关心范围）—— 与学习范围并列的第二个生产者范围。
 *
 * ## 用户要的（原话）
 *
 * 「现状是学习范围决定一切，至少要分开两个吧，给用户的引导，学习的范围和
 *   监听范围」「不过他只需要记录实时流的内容」
 *
 * 所以这一块与上面的学习范围有三处**刻意不同**，每一处都在界面上说出来：
 *
 * | | 学习范围 | 监听范围（这里） |
 * |---|---|---|
 * | 管什么 | 往回挖多少历史 | 盯哪些会话的**新**消息 |
 * | 时间 | `since` 往回 | `enabledAt` 从现在往后 |
 * | 能不能收回 | 不能（图谱已消费） | **能**（不存历史，关掉无副作用） |
 * | 覆盖面 | 已采完 / 还在回溯 | 已放行 / 已跳过 |
 *
 * ## ★ 为什么"能关掉"必须在界面上明说
 *
 * 上面那块写着"范围只增不减"。如果这块不明说它可以关，用户会以为
 * 同一条规则也适用 —— 于是不敢勾选（怕勾了就撤不掉）。而实际上勾错一个群
 * 的代价在这里只是"以后不盯了"，没有任何数据后果。
 */
import { useMemo, useState } from "react"
import { Button } from "@mycontext/design"
import {
  useAttentionScope,
  useDisableAttentionScope,
  useSaveAttentionScope,
  useChannelConversations,
} from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export function AttentionScopePanel({ channelId }: { channelId: string | null }) {
  const { t } = useDynamicTranslation("settings")
  const scope = useAttentionScope(channelId ?? undefined, channelId !== null)
  const save = useSaveAttentionScope()
  const disable = useDisableAttentionScope()
  const [picking, setPicking] = useState(false)

  const active = useMemo(
    () => (scope.data?.items ?? []).filter((item) => item.active),
    [scope.data],
  )

  if (channelId === null) return null

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--border-divider-light)] pt-3">
      <div className="flex items-center gap-2">
        <p className="typography-body-small-400 text-[var(--text-base-primary)]">
          {t("status.attention.title", { defaultValue: "分身监听范围" })}
        </p>
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("status.attention.count", {
            defaultValue: "正在盯 {{count}} 个会话",
            count: scope.data?.activeCount ?? 0,
          })}
        </span>
      </div>

      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("status.attention.note", {
          defaultValue:
            "它**盯**哪些会话的新消息 —— 只看实时流、不回溯历史。与上面的学习范围是两件事：这里可以随时关掉（不会删任何数据），因为它不保存历史。",
        })}
      </p>

      {/*
        ★ 实时流覆盖面：`routed` 与 `skipped` 都显示。
        只显示放行数的话，「范围设窄了」与「那段时间没消息」都是 0 ——
        而那正是用户会来问的那个问题。
      */}
      {scope.data !== undefined && scope.data.coverage.days > 0 ? (
        <p className="typography-caption-400 text-[var(--text-base-secondary)]">
          {t("status.attention.coverage", {
            defaultValue: "近 30 天：放行 {{routed}} 条，按范围跳过 {{skipped}} 条",
            routed: scope.data.coverage.routed.toLocaleString(),
            skipped: scope.data.coverage.skipped.toLocaleString(),
          })}
        </p>
      ) : (
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("status.attention.coverageEmpty", {
            defaultValue: "近 30 天还没有实时流记录 —— 勾选会话之后新消息会记在这里。",
          })}
        </p>
      )}

      {active.length === 0 ? (
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("status.attention.empty", {
            defaultValue: "还没有勾选会话 —— 此时分身对**所有**已授权会话的新消息都会评估一次。",
          })}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {active.map((item) => (
            <li
              key={item.conversationExternalId}
              className="flex items-center justify-between gap-2"
            >
              <span className="typography-caption-400 text-[var(--text-base-secondary)] truncate">
                {item.title ?? t("status.attention.unnamed", { defaultValue: "未命名会话" })}
                {item.source === "learning"
                  ? t("status.attention.fromLearning", { defaultValue: "（随学习范围加入）" })
                  : ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={disable.isPending}
                onClick={() => {
                  disable.mutate({
                    channelId,
                    conversationExternalId: item.conversationExternalId,
                  })
                }}
              >
                {t("status.attention.stop", { defaultValue: "不再盯" })}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setPicking(!picking)}>
          {picking
            ? t("status.attention.collapse", { defaultValue: "收起" })
            : t("status.attention.add", { defaultValue: "添加会话" })}
        </Button>
      </div>

      {picking ? (
        <AttentionPicker
          channelId={channelId}
          alreadyActive={new Set(active.map((item) => item.conversationExternalId))}
          pending={save.isPending}
          onPick={(ids) => {
            save.mutate({ channelId, conversationExternalIds: ids })
            setPicking(false)
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * 会话选择器 —— 复用 `useChannelConversations`（学习范围那边用的同一个源）。
 *
 * ★ 复用而不是新拉一份：那个 hook 已经处理了"走子进程三路合并、失败降级成
 * 本地列表"。再写一份就会出现两处需要同步维护的会话来源，而其中一处会先过期。
 */
function AttentionPicker({
  channelId,
  alreadyActive,
  pending,
  onPick,
}: {
  channelId: string
  alreadyActive: ReadonlySet<string>
  pending: boolean
  onPick: (ids: string[]) => void
}) {
  const { t } = useDynamicTranslation("settings")
  /**
   * ★ 传 `true`：这个选择器只在用户点开「添加会话」之后才挂载，
   * 所以挂载即意味着"现在要这份列表"。传 false 会让它永远 pending。
   */
  const conversations = useChannelConversations(true)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const candidates = useMemo(() => {
    const all = conversations.data?.items ?? []
    return all
      .filter((item) => item.channelId === channelId)
      .filter((item) => !alreadyActive.has(item.externalId))
      .slice(0, 60)
  }, [conversations.data, channelId, alreadyActive])

  if (conversations.isPending) {
    return (
      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("status.attention.loading", { defaultValue: "正在读会话列表…" })}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {candidates.map((item) => (
          <label key={item.externalId} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.has(item.externalId)}
              onChange={(event) => {
                const next = new Set(selected)
                if (event.target.checked) next.add(item.externalId)
                else next.delete(item.externalId)
                setSelected(next)
              }}
            />
            <span className="typography-caption-400 text-[var(--text-base-secondary)] truncate">
              {item.title ?? t("status.attention.unnamed", { defaultValue: "未命名会话" })}
            </span>
          </label>
        ))}
      </div>
      <Button
        size="sm"
        disabled={selected.size === 0}
        loading={pending}
        onClick={() => onPick([...selected])}
      >
        {t("status.attention.confirm", {
          defaultValue: "加入监听范围（{{count}} 个）",
          count: selected.size,
        })}
      </Button>
    </div>
  )
}
