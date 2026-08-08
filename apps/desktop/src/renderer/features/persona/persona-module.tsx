/**
 * PersonaModule —— 数字人：薄容器。
 *
 * 这里只做三件事：拉数据、选中哪个会话、把回调接到 IPC。
 * 具体渲染全在 leaf 组件里（与搜索模块同构）——
 * 首版把三栏 + 会话行 + 监听控件 + 草稿卡 + 运行日志全塞在一个文件里，
 * 结果每改一处视觉都要在 391 行里找位置。
 *
 * ## 三栏而不是两栏
 *
 * 左：会话（带「待处理 N」徽标）；中：消息流（@我 高亮）；右：草稿 + 运行日志。
 * 草稿单独一栏的理由是它**跨会话** —— 用户最常做的动作是"扫一眼有几条要审"，
 * 而不是"进到某个会话里看有没有草稿"。
 *
 * ## ★ 降级与边界必须写在界面上
 *
 * 没配模型 → 顶部横幅明示"只出占位草稿"；「发送」只标状态不真发。
 * 静默降级是这个项目里反复出现的那类失效，所以宁可界面上多两行字。
 */
import { useEffect, useMemo, useState } from "react"
import {
  useChannels,
  useContactAvatars,
  usePersonaActivities,
  usePersonaConversations,
  usePersonaDrafts,
  usePersonaMessages,
  usePersonaSnapshot,
  useComposeSend,
  useResolveDraft,
  useSavePersonaConfig,
  useSetKillSwitch,
} from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { ConversationRail } from "./conversation-rail.js"
import { PERSONA_SUPPORTED_CHANNEL, PersonaHeaderControls } from "./persona-header-controls.js"
import { useHeaderSlot } from "../shell/header-slot.js"
import { ReplyDock } from "./reply-dock.js"
import { ChatHeader } from "./chat-header.js"
import { ConversationSettingsDialog } from "./conversation-settings-dialog.js"
import { explainDegradedReason } from "./decision-reason.js"
import { MessageThread } from "./message-thread.js"

export function PersonaModule() {
  const { t } = useDynamicTranslation("persona")
  const errorText = useErrorText()

  /**
   * 把守卫的拒因翻成人话。
   *
   * ★ 判据是**可枚举的几个** + 兜底带上原始 code。只兜底的话
   * 用户看到 `grant_missing` 这种串；只列举不兜底的话新增一个拒因
   * 会显示空字符串 —— 那时"没发出去"变成"什么都没说"。
   */
  const sendFailureText = (reason: string | undefined): string => {
    const known: Record<string, string> = {
      // 渠道拒绝：三种 code 同一句话（用户的下一步都一样 —— 检查登录/权限）
      permission_denied: t("sendReasonGrantMissing"),
      grant_expired: t("sendReasonGrantMissing"),
      blocked_no_grant: t("sendReasonGrantMissing"),
      rate_limited: t("sendReasonRateLimited"),
      kill_switch: t("sendReasonKillSwitch"),
      channel_unavailable: t("sendReasonChannelUnavailable"),
    }
    const detail =
      reason === undefined
        ? t("sendReasonOther", { code: "unknown" })
        : (known[reason] ?? t("sendReasonOther", { code: reason }))
    return t("sendFailed", { reason: detail })
  }

  const snapshot = usePersonaSnapshot()
  /**
   * 渠道连上了吗 —— 给顶部那条「未连接」横幅用（见下面 JSX 里的注释）。
   *
   * `undefined`（还在查）→ `null`：那时不下结论。
   */
  const channels = useChannels()
  const dingtalkState = channels.data?.find((item) => item.id === "dingtalk")?.status.state
  const channelConnected = dingtalkState === undefined ? null : dingtalkState === "authorized"
  const conversations = usePersonaConversations()
  const drafts = usePersonaDrafts()
  const saveConfig = useSavePersonaConfig()
  const resolveDraft = useResolveDraft()
  const composeSend = useComposeSend()
  const killSwitch = useSetKillSwitch()

  const [activeId, setActiveId] = useState<string | null>(null)
  /**
   * 「看引用」要高亮的消息。切会话时清掉（那些 id 不在新会话里）。
   *
   * ★ 同时传给 `usePersonaMessages` —— 引用的消息通常比"最近 80 条"更早
   * （实测真实数据上 53 条引用一条都不在窗口里），不显式带上就是
   * "点了没反应"。
   */
  const [citationIds, setCitationIds] = useState<readonly string[]>([])
  /**
   * ★ 只为**取回来**、不参与高亮的消息 id（点引用块跳转时攒进来）。
   *
   * 与 `citationIds` 分开的理由：那一份同时是「高亮哪些」的来源
   * （草稿卡的「看引用」），把跳转目标也塞进去会**抹掉草稿的那组高亮**
   * —— 点一下引用块，正在核对的那几条就不亮了。
   *
   * 累加而不是替换：用户可能顺着引用链一路点下去（A 引 B、B 引 C），
   * 每次替换会让上一跳的消息又掉出窗口，于是「回到刚才」找不到目标。
   */
  const [fetchOnlyIds, setFetchOnlyIds] = useState<readonly string[]>([])
  const messageIdsToFetch = useMemo(
    () => [...new Set([...citationIds, ...fetchOnlyIds])],
    [citationIds, fetchOnlyIds],
  )
  const messages = usePersonaMessages(activeId, messageIdsToFetch)
  const activities = usePersonaActivities(activeId)
  /**
   * 会话设置弹窗开着吗，以及打开时停在哪个 tab。
   *
   * `null` = 关。`"settings" | "search"` = 打开并定位到那个 tab
   * （成员那一档没有独立入口，进弹窗后切）。放这里而不是弹窗内部：
   * 中栏头上的两个 icon（设置 / 搜索）要能各自把它开到不同 tab。
   */
  const [settingsTab, setSettingsTab] = useState<"settings" | "search" | null>(null)

  const list = useMemo(() => conversations.data ?? [], [conversations.data])

  /**
   * 左栏所有单聊对方的头像，**一次批量取**。
   *
   * ## ★ 为什么在容器这一层取
   *
   * 每行自己发一次请求的话，一屏几十个会话就是几十次 IPC，而每次取头像
   * 本身还要 2-3 次 CLI 调用（`search-common` → 成员详情 → 下载）。
   * `media.avatars` 的形状本来就是批量的，用它一次拿完。
   *
   * 群聊不在里面：钉钉没有群头像字段（取了也是空），那与用户在钉钉里
   * 看到的一致，所以群聊退回首字母色块**不是缺陷**。
   *
   * ★ `groupExternalId` 传 null：单聊的 external_id 不是群，
   * 传下去会让 `fetchAvatar` 走"已知共同群"那条捷径 → 查不到 →
   * 判**终态** `no_avatar_set` → 那个人的头像永久取不到。
   */
  const peerIds = useMemo(
    () => [
      ...new Set(
        list
          .filter((item) => item.kind === "direct" && item.peerExternalId !== null)
          .map((item) => item.peerExternalId as string),
      ),
    ],
    [list],
  )
  /**
   * `peer id → 花名`。单聊的花名就是**会话标题**（钉钉单聊标题即对方名字）。
   *
   * ★ 不传它整条路径会静默失效：没有共同群时取头像靠
   * `search-common --nicks`，而缺花名时渠道层一次命令都不调就返回 null。
   */
  const nickByPeer = useMemo(() => {
    const map: Record<string, string> = {}
    for (const item of list) {
      if (item.kind !== "direct" || item.peerExternalId === null) continue
      const nick = item.title
      if (nick !== null && nick !== "") map[item.peerExternalId] = nick
    }
    return map
  }, [list])
  const peerAvatars = useContactAvatars(peerIds, null, nickByPeer)
  const avatarByPeer = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of peerAvatars.data ?? []) {
      if (row.path !== null) map.set(row.externalId, row.path)
    }
    return map
  }, [peerAvatars.data])
  const allDrafts = useMemo(() => drafts.data ?? [], [drafts.data])
  /** 每个会话有几条待审草稿（左栏徽标与默认选中都用它）。 */
  const draftCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const draft of allDrafts) {
      counts.set(draft.conversationId, (counts.get(draft.conversationId) ?? 0) + 1)
    }
    return counts
  }, [allDrafts])

  /**
   * 默认选中**有草稿要审**的那个会话。
   *
   * ★ 排序键是"草稿数优先，其次待处理数"，不是只看待处理数。
   *
   * 实测过一次真实数据：顶部横幅写着"待审草稿 13 条"，右栏却写
   * "待审草稿（0）"—— 因为默认选中的是待处理数最高的会话，
   * 而那个会话恰好一条草稿都没有。用户看到的是两个互相矛盾的数字，
   * 而这一页的主要动作就是审草稿。
   *
   * 只在首次有数据时选（`activeId === null` 闩住）—— 否则每次 refetch
   * 都会把用户正在看的会话切走。
   */
  useEffect(() => {
    if (activeId !== null || list.length === 0) return
    const best = [...list].sort(
      (a, b) =>
        (draftCounts.get(b.conversationId) ?? 0) - (draftCounts.get(a.conversationId) ?? 0) ||
        b.unreadForPersona - a.unreadForPersona,
    )[0]
    setActiveId(best?.conversationId ?? null)
  }, [activeId, list, draftCounts])

  const active = list.find((item) => item.conversationId === activeId) ?? null

  /**
   * 当前会话那一轮在途生成的状态。
   *
   * ★ 只取**当前会话**那一条：快照里的 `generating` 是全局的（可能有
   * 3 个会话同时在跑），把别的会话的 id 传下去会在这一屏标错消息
   * （那些 id 恰好不在这里，表现是"什么都没标"，但语义已经错了）。
   *
   * 消息流（就地标出"正在读这几条"）与回复区（「正在处理」那个 tab）
   * 用**同一份**——各自 find 一次会在两处得到不同的快照瞬间，
   * 于是消息流标着而 tab 已经消失（或反过来）。
   */
  const generatingEntry =
    active === null
      ? undefined
      : snapshot.data?.generating.find((item) => item.conversationId === active.conversationId)
  const generatingForActive = generatingEntry?.messageIds ?? []
  const generatingSince = generatingEntry?.startedAt ?? null
  /**
   * 出现在会话列表里的渠道。
   *
   * ★ 从**数据**推而不是写死 `"dingtalk"`：写死的话飞书接进来那天
   * 这一页会理直气壮地显示"钉钉"，而那是一句错的话
   * （比不显示更糟 —— 用户会据此判断消息要发到哪）。
   *
   * 顺序跟随列表（按最后消息时间排），所以"最近在用的渠道"排在前面。
   */
  const channelIds = useMemo(() => [...new Set(list.map((item) => item.channelId))], [list])
  /**
   * 已授权的**全部**渠道 —— 与 `channelIds`（列表里出现过的）不同。
   * 选择器要列这个：飞书连上了却在这一页看不到入口的话，
   * "为什么它不在这里"就成了一个没有答案的问题。
   */
  const channels = useChannels()
  const authorizedChannelIds = useMemo(
    () =>
      (channels.data ?? [])
        .filter((c) => c.available && c.status.state === "authorized")
        .map((c) => c.id),
    [channels.data],
  )
  /**
   * 这一页当前在看哪个渠道。`null` = 没选过 → 主渠道。
   *
   * ★ 选中一个**不支持**的渠道时不切数据，只把整页换成一句说明
   * （见下面 `unsupportedChannel`）—— 数字分身只在主渠道工作，
   * 那是一条刻意的边界而不是"还没做"。
   */
  const [pickedChannel, setPickedChannel] = useState<string | null>(null)
  const personaChannel = pickedChannel ?? PERSONA_SUPPORTED_CHANNEL
  const unsupportedChannel = personaChannel === PERSONA_SUPPORTED_CHANNEL ? null : personaChannel
  const activeDrafts = allDrafts.filter(
    (draft) => activeId === null || draft.conversationId === activeId,
  )
  /**
   * 别的会话还有多少草稿。
   *
   * 不显示的话右栏的"（0）"与顶部的"13 条"就是一对矛盾的数字，
   * 而用户无从知道另外那些在哪 —— 他会以为草稿丢了。
   */
  const otherDraftCount = allDrafts.length - activeDrafts.length

  /**
   * ★ 状态与动作注入**页头右侧**，不再是自己的一条横栏。
   *
   * 见 `header-slot.tsx` 与 `PersonaHeaderControls`：用户反馈"上面两栏
   * 应该合并，且太重了" —— 原来页头（只有标题）与 TopBar（渠道 + 三个
   * 28px 大数字 + 立即处理 + 二段开关）是两条，现在合成页头一行。
   *
   * `useMemo` 是 `useHeaderSlot` 的要求：它依赖节点本身判断"变了没有"，
   * 传新对象会让它每帧重挂（见那个 hook 的注释）。依赖列表里正是
   * 那几个真正会影响这段 UI 的值。
   */
  const headerControls = useMemo(
    () => (
      <PersonaHeaderControls
        snapshot={snapshot.data}
        channelIds={channelIds}
        authorizedChannelIds={authorizedChannelIds}
        activeChannelId={personaChannel}
        onChannelChange={setPickedChannel}
        killSwitchBusy={killSwitch.isPending}
        onToggleRunning={(running) => killSwitch.mutate({ active: !running })}
      />
    ),
    // killSwitch 整体每次渲染是新对象；只有这两个成员真的影响这段 UI，
    // 单独列出来（mutate 是 react-query 的稳定引用，isPending 是要反映的状态）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.data, channelIds, killSwitch.isPending, killSwitch.mutate],
  )
  useHeaderSlot(headerControls)

  /**
   * ★★ 选了一个数字分身**不支持**的渠道 → 整页换成一句说明。
   *
   * 不显示会话列表与草稿：那些数据来自主渠道，摆在"当前是飞书"的标题下面
   * 就是一句错话（用户会以为那些草稿会发到飞书）。
   *
   * 这不是"还没做"，而是一条刻意的边界：非主渠道是**只读**接入
   * （不进自动回复/发消息链路），只读渠道不该能替用户说话。
   */
  if (unsupportedChannel !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-8">
        <p className="typography-title-small-500 text-[var(--text-base-primary)]">
          {t("unsupportedChannelTitle", { defaultValue: "数字分身暂不支持这个渠道" })}
        </p>
        <p className="typography-body-small-400 max-w-md text-center text-[var(--text-base-tertiary)]">
          {t("unsupportedChannelHint", {
            defaultValue:
              "这个渠道是只读接入：数据只用于建图与搜索，不会进入自动回复或发消息链路，也没有申请任何写权限。",
          })}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        降级横幅：能力没到位时必须明示，否则用户会以为模型很差。
        ★ 它留在顶栏**下面**而不是收进顶栏：那是一个需要读完整句的
        说明（"草稿是占位文本"），而顶栏是扫视区。

        ★★ 判据是 `degradedReason !== null`，**不是** `agentAvailable === false`。
        后者只反映"LLM 配没配"，于是"模型配好了但 opencode 缺失/版本不对"
        这一类（草稿实际走直连、没有工具与检索）**完全不显示横幅** ——
        用户看到的是能力静默变差。实测同事就在这个状态里
        （`opencode_version_unreadable`），而横幅一个字都没出现。
      */}
      {/*
        ★★ 渠道未连接的横幅 —— 与降级横幅**并列**，各说一件事。
        这一条排在前面：没连上渠道时"模型降级"是次要的
        （草稿写得再好也发不出去、收不到新消息）。

        ## 为什么这里必须有

        引导走完之后应用不再判授权（`onboarding.isDismissed()` 只看四步
        走过没有，那是刻意的 —— 见 onboarding.service.ts 文件头）。于是
        登录态过期时数字分身照常打开：有名字、有头像、会话列表还在，
        而那些会话是**历史数据**，新消息一条也进不来、草稿也发不出去。
        实测就是这个形态（设置页写着「未连接」，这里却什么都不说）。

        判据用 `=== false` 而不是 `!connected`：`undefined`（还在查）时
        不下结论，否则已连接的账号会闪一下这条横幅。
      */}
      {channelConnected === false ? (
        <div className="typography-body-small-400 shrink-0 bg-[var(--status-fill-warning-container)] px-4 py-2 text-[var(--status-warning)]">
          {t("channelDisconnected")}
        </div>
      ) : null}

      {snapshot.data?.degradedReason != null ? (
        <div className="typography-body-small-400 shrink-0 bg-[var(--bg-card-z0)] px-4 py-2 text-[var(--text-base-secondary)]">
          {explainDegradedReason(snapshot.data.degradedReason, t)}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden border-t border-[var(--border-divider-light)]">
        <ConversationRail
          items={list}
          loading={conversations.isLoading}
          activeId={activeId}
          draftCounts={draftCounts}
          avatarByPeer={avatarByPeer}
          onSelect={(id) => {
            setActiveId(id)
            setCitationIds([])
            /**
             * 换会话要一并清掉补捞集合。
             *
             * 不清的话上一个会话的 message id 会留在查询键里 ——
             * 后端按 conversationId 校验会把它们丢掉（不会泄漏），
             * 但每换一次会话查询键就多几个没用的 id，缓存命中率白掉。
             */
            setFetchOnlyIds([])
          }}
        />

        <section className="flex min-w-0 flex-1 flex-col">
          {active === null ? (
            <p className="typography-body-small-400 p-4 text-[var(--text-base-tertiary)]">
              {t("pickConversation")}
            </p>
          ) : (
            <>
              {/*
                ★ 中栏头只留身份 + 右上角 icon（见 `ChatHeader`）。
                回复方式 / 触发条件 / 白名单全进设置弹窗；渠道 icon 不再重复
                （顶栏有了）；历史处理结果收进一个 popover
                （用户："不需要处理结果，顶多右上角放历史"）。
              */}
              <ChatHeader
                item={active}
                peerAvatar={
                  active.peerExternalId === null
                    ? null
                    : (avatarByPeer.get(active.peerExternalId) ?? null)
                }
                activities={activities.data ?? []}
                onOpenSettings={() => setSettingsTab("settings")}
                onOpenSearch={() => setSettingsTab("search")}
              />
              {/*
                滚动容器已经移进 `MessageThread` —— 那里同时需要容器与
                滚动逻辑（"打开就停在底部"要 `scrollTop = scrollHeight`，
                而 `scrollIntoView` 拿不到容器本身）。
                `overflow-x-hidden` 的理由也一并搬了过去（见那个文件）。
              */}
              <MessageThread
                messages={messages.data ?? []}
                loading={messages.isLoading}
                highlightIds={citationIds}
                conversationId={active.conversationId}
                conversationExternalId={active.externalId}
                isGroup={active.kind === "group"}
                /**
                 * 点了消息上的「分身发的」角标 → 高亮它当时引用的那些消息。
                 *
                 * ★ 与草稿卡的「看引用」共用同一个 state：两者要的是同一件事
                 * （把一组 id 取回来并高亮）。各自一份 state 会让两处高亮
                 * 互相覆盖，而那种 bug 在真应用里才看得见。
                 */
                onShowCitations={setCitationIds}
                /**
                 * 点引用块跳到**窗口外**的消息 —— 把它捞进取回集合。
                 *
                 * ★ 与 `onShowCitations` 分开（见 `fetchOnlyIds` 的注释）：
                 * 合用一个会让"点引用块"抹掉草稿卡的那组高亮。
                 */
                onRequestMessage={(id) =>
                  setFetchOnlyIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
                }
                /**
                 * 正在生成的那一轮在处理哪些消息 —— 就地标出来。
                 *
                 * ★ 只取**当前会话**那一条：快照里的 `generating` 是全局的
                 * （可能有 3 个会话同时在跑），把别的会话的 id 传进来会在
                 * 这一屏标错消息（那些 id 恰好不在这里，表现是"什么都没标"，
                 * 但语义已经错了）。
                 */
                generatingIds={generatingForActive}
              />

              {/*
                ★ 回复区（`ReplyDock`）在消息流底部，紧跟在它要回复的
                那段对话之后 —— 这是用户要的"聊天窗口"形态。

                它替掉了原来的「待审草稿（N）+ 一列草稿卡」那种表单式样式：
                那是一张表单，而它所在的位置（聊天窗口底部）本来该是
                "我要发什么"。现在是一条 tab 栏 + 一个输入区：
                tab 回答"有几个候选"（正在处理 / 草稿 1..N / 新建），
                输入区回答"发什么"。

                `shrink-0` 在组件内部 —— 它不能被消息流挤掉
                （消息流是 flex-1 且自己滚，回复区必须留在视野里）。
              */}
              <ReplyDock
                conversationId={activeId}
                drafts={activeDrafts}
                generatingIds={generatingForActive}
                generatingSince={generatingSince}
                busy={resolveDraft.isPending || composeSend.isPending}
                /**
                 * ★ 两种"没发出去"都要显示；**但丢弃不算**。
                 *
                 * 抛出来的错（网关挂了）走 `error`；而**被守卫拦住**
                 * （没授权、超频率、停摆）是正常返回 `{ ok: false, reason }`
                 * —— 不显示它的话用户点了发送、草稿还在、界面无变化，
                 * 与"点了没反应"一模一样。而这两种的处置完全不同。
                 *
                 * ★ 但**丢弃**（`action: "discard"`）也返回 `delivered: false`
                 * 且**不带 reason**，一并走 sendFailureText 会显示
                 * 「没发出去：unknown」—— 用户点丢弃看到"发送失败"是彻底
                 * 反着的：丢弃**成功**了，本来就不发。所以只有 send 那一路才判。
                 *
                 * ★ 自己写那条（composeSend）也要报：它没有草稿卡可以
                 * 消失作为反馈，失败时消息流里什么都不会变。
                 */
                errorText={
                  resolveDraft.error !== null
                    ? errorText(resolveDraft.error)
                    : composeSend.error !== null
                      ? errorText(composeSend.error)
                      : resolveDraft.variables?.action === "send" &&
                          resolveDraft.data?.delivered === false
                        ? sendFailureText(resolveDraft.data.reason)
                        : composeSend.data?.delivered === false
                          ? sendFailureText(composeSend.data.reason)
                          : null
                }
                otherCount={otherDraftCount}
                onResolve={(input) => resolveDraft.mutate(input)}
                onCompose={(text) =>
                  composeSend.mutate({ conversationId: active.conversationId, text })
                }
                onShowCitations={setCitationIds}
              />

              {/*
                ★ 运行日志（处理结果）已经**移到中栏右上角**的历史 popover
                （见 `ChatHeader`）。用户反馈"对话框下面那个模块不需要处理结果，
                顶多当前对话右上角可以有个历史处理结果"。

                所以回复区下面**什么都不放** —— 底部就是回复区，
                与聊天窗口一致。排查用的 `ActivityFeed` 仍然存在，
                只是收进了那个默认关闭的 popover（入口不能删，见它的注释）。
              */}
            </>
          )}
        </section>

        {/* 会话设置弹窗：设置 / 成员 / 记录搜索三个 tab */}
        {active === null || settingsTab === null ? null : (
          <ConversationSettingsDialog
            open
            onClose={() => setSettingsTab(null)}
            item={active}
            busy={saveConfig.isPending}
            initialTab={settingsTab}
            onChange={(patch) =>
              saveConfig.mutate({ conversationId: active.conversationId, ...patch })
            }
            onJumpToMessage={(id) => setCitationIds([id])}
          />
        )}

        {/*
          ★ 第三栏删掉了 —— 草稿改成消息流底部的「待发送」气泡。

          ## 为什么原来是三栏，为什么现在不必

          原注释的理由是「草稿**跨会话**，用户最常做的动作是扫一眼有几条要审」。
          那个需求还在，但它不需要一整栏：左栏的会话行已经有草稿徽标
          （`draftCounts`），顶部横幅有全局总数 —— "哪些会话有待审"仍然一眼可见。

          而一整栏的代价是：审草稿时**看不到它要回复的那句话**。
          草稿卡在右边、被回复的消息在中间，判断"这句回得对不对"要来回看。
          放到消息流底部之后，它紧跟在对话之后 —— 那正是 IM 的形态，
          也是这一页真正的动作（读一段对话，判断回得对不对）。

          运行日志（`ActivityFeed`）跟着一起移出常驻位置：它是排查用的，
          不该常占一栏。现在收在 `ReplyModeControls` 旁边的折叠区里。
        */}
      </div>
    </div>
  )
}
