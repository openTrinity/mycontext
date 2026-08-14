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
import type { CoverageDomain, DistillScopeInput, DistillSourceId } from "@mycontext/ipc-contract"
import { useDistillSources, useSaveDistillSource } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { SourcesStep, type SourcesDraft } from "../onboarding/sources-step.js"
import { ScopeCoverage } from "./scope-coverage.js"

/**
 * 有覆盖面读出口的三个域，**按用户关心的顺序**。
 *
 * ★ 顺序不是随手写的：消息是主体（量级最大、用户最关心），
 * 听记与文档是补充。让文档排第一会让人以为它是主要数据源。
 *
 * ★ 与 `CoverageDomain` 同源（那是契约里的枚举），所以加一个域时
 * 类型会提示这里要不要跟着加 —— 而不是静默少一行。
 */
const COVERAGE_DOMAINS: readonly CoverageDomain[] = ["chat", "minutes", "doc"]

/** 主渠道 id —— 它的白名单走 `scope.conversationIds`（存量形状）。 */
const PRIMARY_CHANNEL_ID = "dingtalk"

/** 把库里存的 scope 还原成这个面板的草稿。 */
/**
 * 今天 00:00 的时间戳 —— `since` 的**唯一**基准。
 *
 * ★★ `toDraft`（库 → 天数）与 `submit`（天数 → 库）必须用同一个基准，
 * 否则"打开面板、什么都不改、直接保存"会算出一个不同的 `since`，
 * 而主进程侧 `scopeChanged()` 判 `since` 不等就跑一整轮清语料 + 删图重建。
 * 两处各用 `Date.now()` 时这个不一致是必然的（相差几秒到几分钟）。
 */
function midnightToday(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

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
   *
   * ★ 基准用 `midnightToday()` 而不是 `Date.now()` —— 见那个函数的注释。
   */
  const since = scope?.since
  const rangeDays =
    since === undefined ? null : Math.max(1, Math.round((midnightToday() - since) / 86_400_000))
  return {
    rangeDays,
    customRange: null,
    chatKinds: [...((scope?.chatKinds ?? ["direct", "group"]) as ("direct" | "group")[])],
    conversationIds: [...(scope?.conversationIds ?? [])],
    enabledSources: [...enabledSources],
    /**
     * ★★ 这个面板**不管**监听范围（它下面挂着独立的 `AttentionScopePanel`）。
     *
     * 给空数组是因为 `SourcesStep` 的 draft 形状要求这个字段，而不是
     * "这里的监听范围是空的"。★ 所以保存时也**不能**用它去写
     * `attention_scope` —— 那会把用户在下面那个面板里配好的名单清掉。
     * 判据：这一处只 `saveSource`（学习范围），从不调 `attentionScopeSave`。
     */
    attentionConversationIds: [],
  }
}

export interface CollectionScopePanelProps {
  /** 当前在看哪个渠道（由 `StatusView` 持有，与这一页其余部分共用）。 */
  channelId: string | null
}

export function CollectionScopePanel({ channelId }: CollectionScopePanelProps) {
  const { t } = useDynamicTranslation("settings")
  const errorText = useErrorText()
  /**
   * 这一页当前在编辑**哪个渠道** —— picker 没选过（null）时就是主渠道。
   *
   * ★ 提成一个常量而不是各处写 `channelId ?? PRIMARY`：读库、存库、
   * 草稿归属、会话过滤、已保存提示**五处**都要用它，而其中任意两处不一致
   * 都会造成一次跨渠道错位（那正是这一整轮 bug 的形状）。
   */
  const activeChannel = channelId ?? PRIMARY_CHANNEL_ID
  /**
   * ★★ 读**这个渠道**的资料源与范围。
   *
   * 不带渠道的后果（实测）：切到飞书时显示的是**钉钉的**范围，用户以为那就是
   * 飞书的、点保存又把钉钉那 24 个 `cid…` 存成了飞书的白名单 ——
   * 而它们在飞书库里是不存在的 id，按它们过滤会静默漏采。
   *
   * ★ `channelId` 为 null（还没选过）时读主渠道 —— 与 `channelFilter` 一致。
   */
  const sources = useDistillSources(true, activeChannel)
  const save = useSaveDistillSource()

  const chat = (sources.data ?? []).find((item) => item.kind === "chat")
  const enabledSources = useMemo<readonly DistillSourceId[]>(
    () => (sources.data ?? []).filter((item) => item.enabled).map((item) => item.kind),
    [sources.data],
  )
  /**
   * 哪些源开着 —— 覆盖面按它过滤（关掉的源不显示那一行）。
   *
   * ★ `sources.data` 还没回来时**当成全开**（`Set` 由 enabledSources 构造，
   * 那时它是空的 → 一行都不显示 → 首帧闪一下空白再补上三行）。
   * 所以判据写成"数据没回来就先都显示"，避免那次闪动。
   */
  const enabledKinds = useMemo(
    () =>
      sources.data === undefined
        ? new Set<string>(COVERAGE_DOMAINS)
        : new Set<string>(enabledSources),
    [sources.data, enabledSources],
  )

  /**
   * 草稿。`null` = 还没打开过 → 打开时从库里的当前范围初始化。
   *
   * ★ 不用 `useEffect` 同步：那会在每次 query 刷新时把用户正在编辑的草稿
   * 冲掉（实测过这类 bug 的形状：勾了几个会话，后台一轮采集推来新快照，
   * 勾选全没了）。改成"打开时取一次"。
   */
  /**
   * 草稿 + **它属于哪个渠道**。`null` = 还没编辑过 → 用库里的值。
   *
   * ★ 带渠道是必须的：这一页的 picker 会切渠道，而 React state 不会自己
   * 跟着变。只存 `SourcesDraft` 时切过去看到的是上一个渠道的勾选。
   */
  const [draft, setDraft] = useState<{ channelId: string; value: SourcesDraft } | null>(null)
  /**
   * 上一次保存成功的**渠道**（null = 这一页还没保存过）。
   *
   * ★★ 为什么不是一个 boolean：那个版本一旦为 true 就**永远**显示，
   * 而且切到另一个渠道后仍然挂着 —— 用户在飞书栏看到「已保存」，
   * 而那句话说的是刚才在钉钉栏那次。记下渠道之后就能只在对应的栏显示。
   *
   * ★ 用户报的问题是"点完没有状态变化，感知不到点击生效了"。
   * 根因有两个，这是其中之一（另一个是 `since` 每次现算导致重复触发，
   * 见 `submit` 里那段）。
   */
  const [savedChannel, setSavedChannel] = useState<string | null>(null)

  /**
   * 首帧还没拿到 `sources` 时草稿是 null；拿到之后**只初始化一次**。
   *
   * ★ 用 `draft === null` 这个判据而不是 `useEffect([sources.data])`：
   * 后者会在每次 query 刷新时把用户正在编辑的草稿冲掉（实测过这类 bug 的
   * 形状：勾了几个会话，后台一轮采集推来新快照，勾选全没了）。
   */
  /**
   * ★★ 草稿是**按渠道**的 —— 切渠道时必须丢掉上一个渠道的编辑。
   *
   * `draft` 记下它属于哪个渠道；渠道一变就当作没有草稿，从新渠道的库值
   * 重新初始化。不这么做的话切到飞书看到的是钉钉的勾选，
   * 而点保存就把它存成飞书的（用户报的"先选钉钉又选飞书就出问题"）。
   */
  const effective =
    (draft !== null && draft.channelId === activeChannel ? draft.value : null) ??
    (sources.data === undefined ? null : toDraft(chat?.scope, enabledSources))

  const submit = () => {
    if (effective === null) return
    const draft = effective
    /**
     * ★★ `since` 按**天**对齐（当天 00:00:00），不是 `Date.now() - N 天`。
     *
     * ## 这一条修的是一次真实的重复重建
     *
     * 主进程侧 `scopeChanged()` 的判据里有 `before.since !== after.since`，
     * 而现算的 `Date.now() - N*86400000` **每次点击都是不同的毫秒值** ——
     * 于是"同一个『近 30 天』"被判成"范围变了"，每点一次就跑一整轮
     * 清语料 + 删图重建（分钟级、出网烧 LLM）。
     *
     * 实测（本机日志）：连点三次保存 → `scope change pipeline start`
     * 出现 3 次（06:57:59 / 06:58:00 / 06:58:01），而后两次
     * `purgedMessages: 0` —— 白干两轮，且第一轮的建图被后面两次打断。
     * 库里存下的 `since` 是 `2026-07-08 14:58:01`，正是第三次点击那一刻减 30 天。
     *
     * 按天对齐之后，同一天内重复保存同一个选择得到**同一个** `since`，
     * 判据自然为假、回调不再触发。
     *
     * ★ 用当天 00:00 而不是"上一个整小时"：用户选的语义是"最近 N 天"，
     * 而那本来就是按天数的。对齐到天还顺带让 `since` 可读
     * （日志与库里看到的是一个整点，而不是一串随机毫秒）。
     */
    const since =
      draft.rangeDays === null ? undefined : midnightToday() - draft.rangeDays * 86_400_000
    /**
     * ★★★ 白名单**统一**放 `scope.conversationIds`，并把渠道显式告诉主进程。
     *
     * ## 这里原来分两种形状，而那个分叉造成了一次数据丢失
     *
     * 旧代码判 `isPrimary`：主渠道的白名单放 `scope.conversationIds`，
     * 其余渠道放 `perChannelConversationIds[channelId]`，而服务层
     * **一次写所有库**。于是在飞书那栏保存时 `scope` 里**不带**
     * `conversationIds` —— 服务层把它原样写进主库，钉钉那 9 个 id 被清空。
     *
     * 实测后果：钉钉的 `conversationIds` 字段整个消失 → 按「不设限」重采
     * → 消息从 1730 涨到 3921（92 个会话全采）。那是超范围采集。
     *
     * 现在一次只存一个渠道，`scope.conversationIds` 里就是**这个渠道自己的**
     * external_id —— 跨库复制在结构上不可能发生。
     *
     * ★ `channelId` 为 null（还没选过）时落到主渠道：这一页的 picker 初值是
     * null，而那时用户看到的列表也是主渠道的（见 `channelFilter`）。
     */
    save.mutate(
      {
        channelId: activeChannel,
        kind: "chat",
        enabled: true,
        scope: {
          ...(since === undefined ? {} : { since }),
          chatKinds: draft.chatKinds,
          conversationIds: draft.conversationIds,
        },
      },
      { onSuccess: () => setSavedChannel(activeChannel) },
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
          ? t("status.scope.title", { defaultValue: "学习范围" })
          : `${t("status.scope.title", { defaultValue: "学习范围" })}·${t(
              `status.kl.channel.${channelId}`,
              { defaultValue: channelId },
            )}`
      }
      /**
       * ★★ 这句原来是「保存后立刻生效：越界的消息会被清掉」—— 在
       * 「只增不减」之后**不再成立**（范围不会变小，没有越界可清）。
       * 而它说的是删数据这么重的一件事，留着就是报告一件不会发生的事。
       *
       * ★ 「学习范围」而不是「采集范围」：用户的心智模型是两件事 ——
       * 「我要它**学**哪些历史」与「我要分身**盯**哪些实时消息」。
       * 后者是下面那块「分身监听范围」，两者必须在同一屏里能被区分开，
       * 否则用户改了这里却期待分身行为变化（或反过来）。
       */
      hint={t("status.scope.description", {
        defaultValue: "它**学**哪些历史：采多久、采哪些会话。范围只增不减。",
      })}
    >
      <div className="flex flex-col gap-3">
        {/*
          ★ 覆盖面放在**编辑器之前**：用户打开这块最先想知道的是
          "我现在有多少"，而不是先面对一堆勾选框。
        */}
        {/*
          ★★★ 三个域**各一行**（G4）。
          
          修复前只有消息那一行：`document_coverage`（v29）表在写而没人读，
          听记只有一个 `drained` 布尔塞在快照里。而用户要的是
          「不管是消息还是听记，文档等」—— 而"两类能回答、一类不能"
          是最难解释的状态（用户会以为文档那栏坏了）。

          ★ 只勾了的源才显示：用户关掉文档源之后还给他一行"文档 0 篇"
          读起来像坏了，而事实是他自己关的。判据取 `sources` 里的 enabled。
        */}
        {COVERAGE_DOMAINS.filter((domain) => enabledKinds.has(domain)).map((domain) => (
          <ScopeCoverage
            key={domain}
            domain={domain}
            channelId={channelId}
            rangeDays={effective?.rangeDays ?? null}
            customRange={effective?.customRange ?? null}
          />
        ))}
        {effective === null ? null : (
          <ScopeEditor
            channelId={channelId}
            draft={effective}
            onDraftChange={(next) => setDraft({ channelId: activeChannel, value: next })}
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
          {/*
            ★★ `loading` 而不只是 `disabled` —— 用户报的正是"点完没有状态变化，
            感知不到点击生效了"。保存要走一次 IPC + 写库，虽然快但不是零延迟，
            而一个只变灰的按钮读起来像"没反应"。
          */}
          <Button size="sm" disabled={effective === null} loading={save.isPending} onClick={submit}>
            {t("status.scope.save", { defaultValue: "保存范围" })}
          </Button>
          {/*
            ★ 保存后必须说清**会发生什么**。

            ★★ 这句话原来是「越界的消息正在清理，图谱会重建」—— 那在
            「只增不减」之后**不再成立**：范围不会变小，所以没有"越界"可清。
            留着它就是在报告一件没发生的事（而且是删数据这么重的一件事）。

            ★★ 只在**保存过的那个渠道**上显示：这个提示原来是一个 boolean，
            于是切到另一个渠道后仍然挂着，而它说的是上一个渠道那次保存。
          */}
          {savedChannel === activeChannel ? (
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("status.scope.savedHint", {
                defaultValue: "已保存。新增的范围会在下一轮采集时往回补（分钟级）。",
              })}
            </span>
          ) : null}
        </div>
        {/*
          ★★★ 「只增不减」必须**在用户动手之前**就说出来。

          没有这句话时，取消勾选一个群 → 点保存 → 提示"已保存" → 而那个群
          还在范围里。用户看到的是"保存没生效"，也就是一个 bug 的样子。
          而实际行为是对的（消费者已经消费过那些会话，缩小会让图谱与蒸馏
          产出跟范围永久不一致）。这类"行为正确但读起来像坏了"的情况，
          修法是把判据讲出来，而不是改行为。

          ★ 同时给出真正的退路 —— 用户误选了大群时确实需要能收回，
          而那条路是「清空当前渠道数据」（它会真删，并且明确告知）。
          不给退路的"只增不减"会变成一个陷阱。
        */}
        {/*
          ★★ 监听范围**不再**挂在这里了（这是一次刻意的拆分）。

          用户原话：「数字分身监听范围在设置里不应该放在学习范围钉钉里，
          放在独立的数字分身监听范围的一个部分」。

          它原来嵌在学习范围这张卡内部 —— 于是"学它哪些历史"与"盯哪些实时
          消息"这两件**语义相反**的事（一个只增不减、一个可随时关掉）挤在
          同一张卡里，用户要点进「学习范围·钉钉」才找得到监听设置。现在它
          在 collect tab 里与本卡**平级**成一张独立卡（见 `settings-view` 的
          collect 分支）。这一层只管学习范围，不再引用 `AttentionScopePanel`。
        */}
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("status.scope.growOnlyNote", {
            defaultValue:
              "范围只增不减：取消勾选不会删掉已经学到的内容，也不会缩小范围 —— 因为图谱和画像已经用过那些消息。要真正移除，用「通用 › 清空当前渠道数据」。",
          })}
        </p>
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
  /**
   * 这一页一次只管**一个**渠道 → 单元素集合。
   *
   * ★ `useMemo` 而不是每次渲染 `new Set([...])`：`channelFilter` 进了
   * `SourcesStep` 里那个 `useMemo` 的依赖数组，每帧新对象会让它每帧重算
   * （那里面要过滤上百条会话）。
   *
   * ★★ `null`（还没选过）时落到**主渠道**，而不是"不过滤"：不过滤的话
   * 用户会在飞书面板里勾到钉钉的会话，而那批 id 存进飞书库就是按不存在的
   * id 过滤，结果恒为零且不报错。
   */
  const channelScope = useMemo(() => new Set([channelId ?? PRIMARY_CHANNEL_ID]), [channelId])
  return (
    <SourcesStep
      value={draft}
      onChange={onDraftChange}
      sources={sources}
      /**
       * ★★ `null`（还没选过）时落到**主渠道**，而不是"不过滤"。
       *
       * 不过滤的后果实测到了：一进运行状态页 `statusChannel` 就是 null，
       * 于是列表把钉钉与飞书的会话混在一起（用户截图：单聊里 5 个钉钉的名字
       * 后面跟着三个「飞书会话」）。而这个面板保存时是按渠道写库的 ——
       * 勾了飞书的会话却存进主渠道的白名单，那批 id 在钉钉库里不存在，
       * 于是**那些会话永远不会被采**，且不报错。
       */
      channelFilter={channelScope}
    />
  )
}

/** 单独导出给测试用（还原逻辑是纯函数，值得单独锁）。 */
export { toDraft as toScopeDraft }
