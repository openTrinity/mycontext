/**
 * 运行状态页的**采集范围**面板 —— 按渠道改「采什么」。
 *
 * ## ★★ 为什么必须有这个入口
 *
 * 改动前采集范围**只在引导流程里能改**：钉钉是引导第 3 步选的，而飞书
 * 压根没走过引导 —— 于是它的范围**从来没被设置过**。实测后果：
 * 飞书库的 `distill_sources` 表是空的（0 行），而 `readCollectionScope`
 * 读不到 chat 行就判"从没配过 → 不设限" → **按全量采**。
 *
 * 那是隐私问题（CLAUDE.md 第 5 节：严格遵守用户选的范围），不是"少个入口"。
 *
 * ## ★ 复用 `SourcesStep` 而不是重写一个
 *
 * 它是纯受控组件（`value` / `onChange` / `sources`），而"选时间范围 + 勾会话"
 * 这套交互已经在引导里打磨过（含"取消勾选后不从列表消失"那个坑）。
 * 重写一份会让两处的判据慢慢分叉 —— 而分叉的那一头就是漏采或超采。
 *
 * ## ★ 会话列表按渠道过滤
 *
 * 列表混着两个渠道（每项带 `channelId`），而这个面板一次只管一个渠道。
 * 不过滤的话用户会在飞书面板里勾到钉钉的会话，而那批 id 存进飞书库
 * 就是"按一批不存在的 id 过滤" → 结果恒为零。
 */
import { useMemo, useState } from "react"
import { Button, Disclosure } from "@mycontext/design"
import type { DistillScopeInput, DistillSourceId } from "@mycontext/ipc-contract"
import { useDistillSources, useSaveDistillSource } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { SourcesStep, type SourcesDraft } from "../onboarding/sources-step.js"

/** 主渠道 id —— 它的白名单走 `scope.conversationIds`（存量形状）。 */
const PRIMARY_CHANNEL_ID = "dingtalk"

/** 把库里存的 scope 还原成这个面板的草稿。 */
function toDraft(
  scope: DistillScopeInput | undefined,
  enabledSources: readonly DistillSourceId[],
): SourcesDraft {
  /**
   * ★ `since` 还原成**天数**而不是自定义区间：用户当初选的多半是预设
   * （7/30/90），而把它显示成一个具体日期会让"我选的是 30 天"这件事
   * 变成一个需要心算的问题。
   *
   * 算不出整天数（自定义区间存的）时给 null（= 不限），
   * 而不是猜一个最近的预设 —— 猜错会在用户点保存时**悄悄改小范围**。
   */
  const since = scope?.since
  const rangeDays =
    since === undefined ? null : Math.max(1, Math.round((Date.now() - since) / 86_400_000))
  return {
    rangeDays,
    customRange: null,
    chatKinds: [...((scope?.chatKinds ?? ["direct", "group"]) as ("direct" | "group")[])],
    conversationIds: [...(scope?.conversationIds ?? [])],
    enabledSources: [...enabledSources],
  }
}

export interface CollectionScopePanelProps {
  /** 当前在看哪个渠道（由 `StatusView` 持有，与这一页其余部分共用）。 */
  channelId: string | null
}

export function CollectionScopePanel({ channelId }: CollectionScopePanelProps) {
  const { t } = useDynamicTranslation("settings")
  const errorText = useErrorText()
  const sources = useDistillSources()
  const save = useSaveDistillSource()

  const chat = (sources.data ?? []).find((item) => item.kind === "chat")
  const enabledSources = useMemo<readonly DistillSourceId[]>(
    () => (sources.data ?? []).filter((item) => item.enabled).map((item) => item.kind),
    [sources.data],
  )

  /**
   * 草稿。`null` = 还没打开过 → 打开时从库里的当前范围初始化。
   *
   * ★ 不用 `useEffect` 同步：那会在每次 query 刷新时把用户正在编辑的草稿
   * 冲掉（实测过这类 bug 的形状：勾了几个会话，后台一轮采集推来新快照，
   * 勾选全没了）。改成"打开时取一次"。
   */
  const [draft, setDraft] = useState<SourcesDraft | null>(null)
  const [saved, setSaved] = useState(false)

  /**
   * 首帧还没拿到 `sources` 时草稿是 null；拿到之后**只初始化一次**。
   *
   * ★ 用 `draft === null` 这个判据而不是 `useEffect([sources.data])`：
   * 后者会在每次 query 刷新时把用户正在编辑的草稿冲掉（实测过这类 bug 的
   * 形状：勾了几个会话，后台一轮采集推来新快照，勾选全没了）。
   */
  const effective = draft ?? (sources.data === undefined ? null : toDraft(chat?.scope, enabledSources))

  const submit = () => {
    if (effective === null) return
    const draft = effective
    const since =
      draft.rangeDays === null ? undefined : Date.now() - draft.rangeDays * 86_400_000
    const isPrimary = channelId === null || channelId === PRIMARY_CHANNEL_ID
    save.mutate(
      {
        kind: "chat",
        enabled: true,
        scope: {
          ...(since === undefined ? {} : { since }),
          chatKinds: draft.chatKinds,
          /**
           * ★★ 白名单按渠道分开存。
           *
           * 主渠道走 `scope.conversationIds`（存量形状不动），其余渠道走
           * `perChannelConversationIds` —— 那里面装的是**这个渠道的**
           * external_id，复制到另一个渠道就是"按不存在的 id 过滤"，
           * 结果恒为零且不报错。
           */
          ...(isPrimary ? { conversationIds: draft.conversationIds } : {}),
        },
        ...(isPrimary || channelId === null
          ? {}
          : { perChannelConversationIds: { [channelId]: draft.conversationIds } }),
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <Disclosure
      /**
       * ★ 标题带渠道 —— 与 `KlPanel` 同一条理由（这一页只有一个 picker，
       * 而它在最上面；这里保存的白名单是**按渠道**写库的，写错渠道那批
       * 会话就永远不会被采，且不报错）。
       */
      title={
        channelId === null
          ? t("status.scope.title", { defaultValue: "采集范围" })
          : `${t("status.scope.title", { defaultValue: "采集范围" })}·${t(
              `status.kl.channel.${channelId}`,
              { defaultValue: channelId },
            )}`
      }
      hint={t("status.scope.description", {
        defaultValue: "改「采多久、采哪些会话」。保存后立刻生效：越界的消息会被清掉。",
      })}
    >
      <div className="flex flex-col gap-3">
        {effective === null ? null : (
          <ScopeEditor
            channelId={channelId}
            draft={effective}
            onDraftChange={setDraft}
            sources={(sources.data ?? []).map((item) => ({
              kind: item.kind,
              status: item.status,
            }))}
          />
        )}

        {save.error === null ? null : (
          <p className="typography-body-small-400 text-[var(--status-error)]">
            {errorText(save.error)}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button size="sm" disabled={effective === null || save.isPending} onClick={submit}>
            {t("status.scope.save", { defaultValue: "保存范围" })}
          </Button>
          {/*
            ★ 保存后必须说清**会发生什么** —— 这个动作会删数据（越界的消息
            连带它的 FTS/向量/媒体行一起清），而那是不可逆的。
            只显示一个"已保存"会让用户以为它只是记下了一个偏好。
          */}
          {saved ? (
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("status.scope.savedHint", {
                defaultValue: "已保存。越界的消息正在清理，图谱会重建（分钟级）。",
              })}
            </span>
          ) : null}
        </div>
      </div>
    </Disclosure>
  )
}

/**
 * 范围编辑器 —— 只做一件事：把会话列表按渠道过滤后交给 `SourcesStep`。
 *
 * 提成一个组件是因为 `SourcesStep` 自己会拉会话列表，而过滤要发生在它**内部**
 * 拿到列表之后。这里通过 `channelFilter` 把判据传下去。
 */
function ScopeEditor({
  channelId,
  draft,
  onDraftChange,
  sources,
}: {
  channelId: string | null
  draft: SourcesDraft
  onDraftChange: (next: SourcesDraft) => void
  sources: readonly { kind: DistillSourceId; status: "ready" | "planned" }[]
}) {
  return (
    <SourcesStep
      value={draft}
      onChange={onDraftChange}
      sources={sources}
      /**
       * ★ 只列这个渠道的会话。`undefined` = 不过滤（引导页那条路）。
       *
       * 不过滤的话用户会在飞书面板里勾到钉钉的会话 —— 那批 id 存进飞书库
       * 就是按不存在的 id 过滤，结果恒为零。
       */
      /**
       * ★★ `null`（还没选过）时落到**主渠道**，而不是"不过滤"。
       *
       * 不过滤的后果实测到了：一进运行状态页 `statusChannel` 就是 null，
       * 于是列表把钉钉与飞书的会话混在一起（用户截图：单聊里 5 个钉钉的名字
       * 后面跟着三个「飞书会话」）。而这个面板保存时是按渠道写库的 ——
       * 勾了飞书的会话却存进主渠道的白名单，那批 id 在钉钉库里不存在，
       * 于是**那些会话永远不会被采**，且不报错。
       */
      channelFilter={channelId ?? PRIMARY_CHANNEL_ID}
    />
  )
}

/** 单独导出给测试用（还原逻辑是纯函数，值得单独锁）。 */
export { toDraft as toScopeDraft }
