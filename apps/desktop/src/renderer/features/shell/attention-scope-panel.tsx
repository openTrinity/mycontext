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
import { Button, Disclosure } from "@mycontext/design"
import {
  useAttentionScope,
  useDisableAttentionScope,
  useSaveAttentionScope,
  useChannelConversations,
} from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

/**
 * 分身监听范围面板。
 *
 * ## ★ `standalone` —— 独立成卡 vs 嵌在别的卡里
 *
 * 它有两个落点，视觉外壳不同：
 *
 * · **设置页 collect tab**（`standalone`）：与「学习范围」平级的一张独立
 *   `Disclosure` 卡。用户原话「不应该放在学习范围钉钉里，放在独立的…
 *   一个部分」—— 所以这里自带完整卡壳、标题带渠道，不再有那条把它粘在
 *   上一块底部的 `border-t`；
 * · **内嵌**（默认）：作为别的容器里的一段内容（保留 `border-t` 分隔）。
 *
 * 只差外壳，内部编辑器完全一样 —— 抽一个 `Body` 复用，不复制两份。
 */
export function AttentionScopePanel({
  channelId,
  standalone = false,
}: {
  channelId: string | null
  standalone?: boolean
}) {
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

  const activeCount = scope.data?.activeCount ?? 0
  /**
   * 当前模式。`undefined`（还没读到）按 `unset` 处理 —— 那与"用户没配过"
   * 恰好是同一句话（界面对两者要说的也是同一句）。
   */
  const mode = scope.data?.mode ?? "unset"

  const body = (
    <>
      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("status.attention.note", {
          defaultValue:
            "盯哪些会话的新消息 —— 只看实时流、不回溯历史。与上面的学习范围是两件事：这里可以随时关掉（不会删任何数据），因为它不保存历史。",
        })}
      </p>

      {/*
        ★★★ 当前模式**必须说出来**，因为 `activeCount: 0` 有三种含义。

        改动前界面只有一句「还没有勾选会话 —— 此时分身对所有已授权会话
        的新消息都会评估一次」，而那句话对三种情况里的**两种**是错的：
        · 用户显式选了「盯全部」→ 那不是"还没勾选"，是一个决定；
        · 用户把全部关掉了 → 分身**不该**再评估任何会话（旧行为反了）。
      */}
      <p className="typography-caption-400 text-[var(--text-base-secondary)]">
        {mode === "unset"
          ? t("status.attention.mode.unset", {
              defaultValue: "还没配置过监听范围 —— 分身暂时会盯所有已学习的会话。",
            })
          : mode === "all"
            ? t("status.attention.mode.all", {
                defaultValue: "当前：盯所有已学习的会话（你选的）。",
              })
            : activeCount === 0
              ? t("status.attention.mode.none", {
                  // ★ 不写 `**`：这里是纯文本渲染，星号会原样显示给用户
                  defaultValue: "当前：都不盯 —— 分身不会处理任何新消息。",
                })
              : t("status.attention.mode.explicit", {
                  defaultValue: "当前：只盯下面这 {{count}} 个会话。",
                  count: activeCount,
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
        /**
         * ★ 这句只说"名单是空的"这个**事实**，不再解释它的后果 ——
         * 后果由上面那段 mode 文案负责（同一句话对三种 mode 里的两种是错的，
         * 而那正是改动前的问题）。
         */
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("status.attention.empty", {
            defaultValue: "名单里还没有会话。",
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

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setPicking(!picking)}>
          {picking
            ? t("status.attention.collapse", { defaultValue: "收起" })
            : t("status.attention.add", { defaultValue: "添加会话" })}
        </Button>
        {/*
          ★★★ 「盯全部」与「都不盯」两个显式动作。

          改动前这两件事**都表达不出来**：
          · 「盯全部」只能靠"把名单清空"，而那与"从没配过"在库里同形；
          · 「都不盯」压根做不到 —— 名单清空会被路由读成"放行全部"
            （方向相反：关光了反而盯得更多）。

          现在它们各是一次 `mode` 写入，与名单正交。
        */}
        {mode === "all" ? null : (
          <Button
            size="sm"
            variant="ghost"
            loading={save.isPending}
            onClick={() => {
              // ★ 名单传空：`all` 模式下路由不看名单，留着会是看不出无效的残留
              save.mutate({ channelId, conversationExternalIds: [], mode: "all" })
            }}
          >
            {t("status.attention.watchAll", { defaultValue: "盯全部已学习的会话" })}
          </Button>
        )}
        {mode === "explicit" && activeCount === 0 ? null : (
          <Button
            size="sm"
            variant="ghost"
            loading={save.isPending}
            onClick={() => {
              /**
               * ★★ 「都不盯」= `explicit` + **不动名单**。
               *
               * 不清名单是刻意的：`disable` 那条路已经把每一行置成
               * `active=0`，而这里只需要把 mode 钉成 `explicit`
               * —— 那时活跃名单为空，路由的结论就是"一条都不放行"。
               *
               * ★ 传空数组只是"这次不新增"，`add()` 对空数组是 no-op。
               */
              save.mutate({ channelId, conversationExternalIds: [], mode: "explicit" })
            }}
          >
            {t("status.attention.watchNone", { defaultValue: "都不盯" })}
          </Button>
        )}
      </div>

      {picking ? (
        <AttentionPicker
          channelId={channelId}
          alreadyActive={new Set(active.map((item) => item.conversationExternalId))}
          pending={save.isPending}
          onPick={(ids) => {
            /**
             * ★ 挑具体会话隐含 `explicit`：那个动作本身就是"我要收窄"。
             * 不同步 mode 的话用户会加了几个会话却仍处于 `all`/`unset`，
             * 而那时他的选择**完全没有效果**（路由不看名单）—— 一个静默落空。
             */
            save.mutate({ channelId, conversationExternalIds: ids, mode: "explicit" })
            setPicking(false)
          }}
        />
      ) : null}
    </>
  )

  /**
   * ★ 独立卡：`Disclosure` 外壳 + 标题带渠道（与「学习范围」那张卡一致）。
   * 标题里的会话数原来在头部那一行，现在提到 `summary` —— 收起时也可见。
   */
  if (standalone) {
    const label = t("status.attention.title", { defaultValue: "分身监听范围" })
    return (
      <Disclosure
        title={`${label}·${t(`status.kl.channel.${channelId}`, { defaultValue: channelId })}`}
        summary={t("status.attention.count", {
          defaultValue: "正在盯 {{count}} 个会话",
          count: activeCount,
        })}
        defaultOpen={false}
      >
        <div className="flex flex-col gap-2">{body}</div>
      </Disclosure>
    )
  }

  /** 内嵌：作为别的容器里的一段（保留 border-t 分隔 + 自带标题行）。 */
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--border-divider-light)] pt-3">
      <div className="flex items-center gap-2">
        <p className="typography-body-small-400 text-[var(--text-base-primary)]">
          {t("status.attention.title", { defaultValue: "分身监听范围" })}
        </p>
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("status.attention.count", {
            defaultValue: "正在盯 {{count}} 个会话",
            count: activeCount,
          })}
        </span>
      </div>
      {body}
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
