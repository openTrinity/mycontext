/**
 * MessageThread —— 消息流。观感对齐原生 IM（钉钉）。
 *
 * ## 为什么值得做成 IM 的样子
 *
 * 这一页的动作是"读一段对话，判断数字人回得对不对"。而判断需要
 * **一眼看出谁在跟谁说什么** —— 那正是 IM 布局解决的问题：
 * 头像给身份、气泡给归属、引用块给上下文、时间给节奏。
 *
 * 首版是一行行的纯文本 + 每条都带名字，一屏 6 条，读起来像日志而不是对话。
 *
 * ## ★ 四件具体的事
 *
 * 1. **头像**：真头像来自 DWS（共同群的成员详情 → mediaId → 下载），
 *    取不到时退回首字母色块。群头像取不到（钉钉没有那个字段）——
 *    那与用户在钉钉里看到的一致，所以不是缺陷。
 * 2. **引用回复**：`quoted_external_id` 一直在落库而 UI 从没用过。
 *    没有它，"他在回复谁"这个信息在界面上完全消失。
 * 3. **智能时间**：今天 `HH:mm` / 昨天 / 月日 / 往年带年份。
 *    一律 `HH:mm` 会把上周三的消息显示成像刚刚（见 message-time.ts）。
 * 4. **图片与文件**：打开会话时这一屏的媒体**自动下载**，所以图就在那。
 *    自动下载失败时才退回一个手动按钮（见 `MediaBlock`）——
 *    不给按钮的话用户只看到"[图片]"三个字，而那张图其实是能拿到的。
 *
 * ## 滚动与定位
 *
 * 这一页有三种"该停在哪"，判据完全不同，所以分开处理（见 `useEffect` 那几段）：
 *
 * 1. **打开/切换会话** → 停在**最底部**（最新消息）。这是 IM 的默认，
 *    也是这一页的动作所需：判断数字人回得对不对，看的是刚发生的事。
 *    消息是旧→新排列（`persona.service.ts` 里 `sort((a,b)=>a.sentAt-b.sentAt)`），
 *    所以"最新"在底部 —— 不主动滚就停在几十条之前的历史上。
 * 2. **草稿卡「看引用」** → 停在**被引用的那条**（高亮）。
 * 3. **点消息里的引用块** → 停在**被引用的那条**（高亮）。
 *
 * ★ 2 与 3 的锚点必须是"目标那条"，而不是"第一条被高亮的"。
 * 这里踩过：引用的消息通常比最近 80 条更早（实测 53 条引用一条都不在
 * 窗口内），它被合并进列表后排在**最前面** —— 于是锚定"第一条高亮"
 * 等于每次都跳到列表顶部，看起来像"莫名其妙滚到上面去了"。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Avatar, cn } from "@mycontext/design"
import type { MessageMediaView, PersonaMessageView } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import {
  useContactAvatars,
  useDownloadMedia,
  useDownloadMediaForMessages,
} from "../../lib/queries.js"
import { MediaLightbox } from "./media-lightbox.js"
import { dayKey, dayLabel, fullLabel, timeLabel } from "./message-time.js"
import { toDisplayContent } from "./content-display.js"

export interface MessageThreadProps {
  messages: readonly PersonaMessageView[]
  loading: boolean
  /**
   * 当前会话 id。**用来判断"换了会话"**，从而决定要不要重新滚到底。
   *
   * 不能用 `messages` 的内容变化代替：同一个会话来了新消息时 messages
   * 也会变，而那时不该把用户从他正在看的位置弹走。
   */
  conversationId?: string | null
  /** 要高亮并滚到的消息（来自草稿卡的"看引用"） */
  highlightIds?: readonly string[]
  /** 当前会话的 externalId（取头像时当共同群用，省掉一次搜索） */
  conversationExternalId?: string | null
  /** 群聊才取头像：钉钉没有群头像字段，取了也是空 */
  isGroup?: boolean
  /**
   * 点了某条「分身发的」角标 —— 把它当时引用的消息 id 交出去。
   *
   * ★ 由**容器**处理而不是这里自己高亮：引用的消息通常比"最近 80 条"
   * 更早（实测 53 条引用一条都不在窗口里），要走
   * `usePersonaMessages(includeIds)` 把它们显式取回来才看得到。
   * 在这一层自己 setState 只会高亮到"恰好在窗口里"的那几条 ——
   * 而那正是"点了没反应"的形态。
   */
  onShowCitations?: (messageIds: readonly string[]) => void
  /**
   * 请容器把某条**窗口外**的消息取回来（点引用块跳转时用）。
   *
   * ★ 与 `onShowCitations` 分开：那个会替换容器里的高亮集合，而这里只是
   * "顺便把这条也捞进来"。合用一个会让点引用块抹掉草稿卡的那组高亮
   * —— 正是本文件头「两者分开存」那条约束在容器层的延伸。
   */
  onRequestMessage?: (messageId: string) => void
  /**
   * 正在生成中的那一轮在处理哪些消息（来自快照的 `generating`）。
   *
   * ★ 就地标在**那几条消息上**，而不是在顶部放一个转圈：
   * 用户要看的是"正在处理哪几条"，而一个笼统的"生成中"回答不了那个问题
   * —— 尤其群里连来五条时，他想知道数字人是把五条一起读了还是只看了最后一条。
   */
  generatingIds?: readonly string[]
}

/** 同一人在这个间隔内连发的消息合并（不再重复头像与名字）。 */
const MERGE_WINDOW_MS = 5 * 60_000

export function MessageThread({
  messages,
  loading,
  conversationId = null,
  highlightIds = [],
  conversationExternalId = null,
  isGroup = false,
  onShowCitations,
  onRequestMessage,
  generatingIds = [],
}: MessageThreadProps) {
  const { t } = useDynamicTranslation("persona")
  const threadRef = useRef<HTMLUListElement | null>(null)
  const previousConversationRef = useRef<string | null>(null)
  const previousLatestMessageRef = useRef("")
  const handledCitationRef = useRef("")
  const downloadMedia = useDownloadMedia()
  /** 这一屏的媒体自动下（见下方 effect）——用户不必点每一张 */
  const autoDownload = useDownloadMediaForMessages()

  /** 滚动容器。滚动逻辑与容器必须在同一个组件里，否则只能靠调用方代劳。 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 每条消息的 DOM 节点，按 message.id 索引 —— 跳转要按 id 找目标。 */
  const itemRefs = useRef(new Map<string, HTMLLIElement>())
  /**
   * 点引用块要跳到的目标。
   *
   * 与 `highlightIds`（来自草稿卡）分开存：两者都要能高亮，但来源不同，
   * 合成一个 state 会让"点了引用"与"看引用"互相覆盖。
   */
  const [quoteTargetId, setQuoteTargetId] = useState<string | null>(null)
  /**
   * ★ 跳转的**回程**：跳走之前我在看哪条。
   *
   * 没有它的话「看引用」是一趟单程票 —— 被引用的消息常在几百条之前
   * （实测引用几乎都不在最近 80 条里），用户核对完只能手动滚回来，
   * 而"刚才那条"在几屏之外。存的是消息 id 而不是 scrollTop：
   * 补捞进来的更早消息会把内容整体往下推，像素位置那时已经失效了。
   */
  const [returnToId, setReturnToId] = useState<string | null>(null)
  /**
   * ★ 同一个目标被**重复点击**时也要重新定位。
   *
   * 去重键里带一个单调计数：光用 `conversationId:anchorId` 的话，
   * 用户跳过去、自己滚走、再点同一个引用 → 键没变 → effect 认为
   * "这次已经处理过了" → **点了没反应**。计数让每一次点击都是一次新的请求。
   */
  const [jumpNonce, setJumpNonce] = useState(0)

  /**
   * 发起一次跳转。
   *
   * `targetId` 为 null（没采到那条消息）时什么都不做 —— 调用方已经
   * 把这种情况做成不可点，这里再挡一层。
   *
   * `fromId` 是「跳之前我在看哪条」，用来给回程按钮。
   */
  const requestJump = useCallback(
    (targetId: string | null, fromId: string) => {
      if (targetId === null) return
      setQuoteTargetId(targetId)
      setReturnToId(fromId)
      setJumpNonce((n) => n + 1)
      /**
       * 目标可能在窗口外 —— 请容器把它捞回来。
       *
       * ★ 走 `onRequestMessage` 而**不是** `onShowCitations`：后者会
       * **替换**容器里的 `citationIds`，而那份 id 同时是草稿卡「看引用」
       * 的高亮来源 —— 点一下引用块就会把草稿的那组高亮抹掉。
       * 这个组件的文件头本来就写着"两者分开存，合成一个会互相覆盖"，
       * 而经 onShowCitations 补捞等于在容器那一层把它们又合回去了。
       */
      onRequestMessage?.(targetId)
    },
    [onRequestMessage],
  )

  /** 回到跳转前那条。回程只有一级 —— 走完就清掉按钮。 */
  const jumpBack = useCallback(() => {
    if (returnToId === null) return
    setQuoteTargetId(returnToId)
    setReturnToId(null)
    setJumpNonce((n) => n + 1)
  }, [returnToId])

  const registerItem = useCallback((id: string, node: HTMLLIElement | null) => {
    if (node === null) itemRefs.current.delete(id)
    else itemRefs.current.set(id, node)
  }, [])

  /** 高亮集合 = 草稿引用 + 刚点过的引用目标。 */
  const highlighted = useMemo(() => {
    const set = new Set(highlightIds)
    if (quoteTargetId !== null) set.add(quoteTargetId)
    return set
  }, [highlightIds, quoteTargetId])

  /**
   * 正在生成中的那一轮在处理哪些消息。
   *
   * 用 Set 而不是 `includes`：群里连来五条时这一批就是五条，
   * 而消息流一屏有几十条 —— 逐条 O(n) 查找会变成 O(n·m)。
   */
  const generatingSet = useMemo(() => new Set(generatingIds), [generatingIds])

  /**
   * 这一屏出现的所有发送者，**含本人**。
   *
   * ## ★ 本人原来被跳过，而那个理由是错的
   *
   * 原注释写的是「本人的头像走账号设置那份，而且本人通常没有共同群里的
   * avatarMediaId 记录」。第二句实测**不成立** —— 拿本人的
   * openDingTalkId 查任一群的成员详情，`avatarMediaId` 是有值的：
   *
   * ```
   * chat group members list-by-ids --id <任一群> --users <本人 odid>
   *   → { members: [{ nick: "小周", avatarMediaId: "@lQDPM4P-MAwPhw…" }] }
   * ```
   *
   * 本人在群里就是一个普通成员，没有任何特殊性。
   *
   * 第一句也站不住：账号那份头像是**用户自己上传的**（`avatar_source`
   * 多数是 null 或 manual，而钉钉没有开放的用户头像接口所以授权时填不上）。
   * 实测两个账号里一个 `avatar_url` 是 null —— 也就是说"走账号那份"
   * 在真实数据上等于**没有头像**，本人的消息只能显示首字母色块。
   *
   * 而这一栏是在审「以本人身份要发出去的话」，本人是这一屏的主角之一。
   */
  const senderIds = useMemo(() => {
    const ids = new Set<string>()
    for (const message of messages) {
      if (message.senderExternalId !== null && message.senderExternalId !== "") {
        ids.add(message.senderExternalId)
      }
    }
    return [...ids]
  }, [messages])

  /**
   * 取头像 —— 群聊与单聊都取。
   *
   * ## ★ 单聊为什么原来不取，现在为什么取了
   *
   * 取头像的路径是"共同群的成员详情里的 avatarMediaId"，而单聊本身不是群
   * —— 那时要先 `chat search-common` 搜共同群（每人 2-3 次 CLI 调用，
   * 每次约 0.7s）。原来因为这个开销跳过了单聊。
   *
   * 但那个理由站不住：**打开一个单聊只有一个对方**，所以代价是
   * 一次约 2 秒的首屏延迟，而且取到之后**永久缓存**
   * （`contact_avatars`；换头像时 mediaId 会变 → 新文件，不用做失效逻辑）。
   * 也就是每个联系人只付一次。而"一屏只有一个人所以收益不大"说反了：
   * 单聊里那个头像正是这一屏唯一的身份信息。
   *
   * 仍然**不做**启动时全量预取（52 个单聊 × 2-3 次调用会挤占采集）——
   * 懒取即可，用户打开哪个会话就取哪个。
   *
   * 终态 miss（`no_common_group` / `no_avatar_set`）不会重试，
   * 那在 `contact-avatars.ts` 的 `needsFetch` 里。
   */
  /**
   * ★ `groupExternalId` **只在群聊时**传。
   *
   * 它是一条捷径：已知共同群就直接查那个群的成员详情，省掉一次
   * `search-common`。但 `fetchAvatar` 对这个参数的处理是
   * 「查不到 mediaId → 判 `no_avatar_set` 并**不再搜别的群**」——
   * 因为"他确实在这个群里"是那条捷径的前提。
   *
   * 单聊的 `external_id` 不是群。传给它的话查询必然空 → 落一条
   * **终态** miss（`needsFetch` 从此不再重试），于是那个人的头像
   * 永久取不到。而表现是"单聊就是没有头像"—— 与没做这个功能一样。
   */
  /**
   * `senderExternalId → 显示名`，给 `search-common --nicks` 用。
   *
   * ★ 单聊里没有共同群那条捷径，只能靠花名搜 —— 而缺花名时渠道层
   * 一次命令都不调就返回 null（表现是"这个人没设头像"，实际是没去找）。
   * 群聊里也传：万一某人不在这个群的成员详情里（换群了），
   * 还能靠花名兜一次。
   */
  const nickBySender = useMemo(() => {
    const map: Record<string, string> = {}
    for (const message of messages) {
      const id = message.senderExternalId
      const name = message.senderDisplayName
      if (id === null || id === "" || name === null || name === "") continue
      map[id] = name
    }
    return map
  }, [messages])
  const avatars = useContactAvatars(
    senderIds,
    isGroup ? conversationExternalId : null,
    nickBySender,
  )
  const avatarByExternalId = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of avatars.data ?? []) {
      /**
       * `path` 已经是可加载的 `mycontext-file://` URL（主进程在 IPC 边界
       * 转过了）—— 这里**不要**再拼前缀。
       *
       * ★ 为什么不是 `file://`：实测从 `http://localhost:5273` 加载
       * `file://` 被 Chromium 直接拦掉，而失败是静默的（回退到首字母兜底）。
       * 踩过一次：23 个头像下载成功、界面上 img 数量是 0。
       */
      if (item.path !== null) map.set(item.externalId, item.path)
    }
    return map
  }, [avatars.data])

  /**
   * 消息定位只操作中间栏自己的滚动容器：
   * · 有引用时只滚一次，定位到第一条被引用的消息；
   * · 切换会话后立即到底，首屏直接展示最新消息；
   * · 当前会话追加消息时平滑到底。
   *
   * 不用 `scrollIntoView`：它会尝试滚动所有祖先，可能连页面外层一起推动，
   * 表现就是点“看引用”后中间栏与整页先后跳两次。
   *
   * 引用保持高亮期间暂停自动滚底。新消息到达不应把用户从正在核对的引用
   * 拉走，也不应再次重放引用滚动。
   *
   * 用 layout effect 是为了在浏览器绘制前完成切换会话的首次定位。
   * 依赖消息 id 而不是数组本身：查询刷新即使内容没变也可能返回新数组，
   * 那不该重复滚动。
   */
  /**
   * 这一轮要停在哪条消息上。`null` = 没有引用要跳，走"到底部"那一路。
   *
   * ★ 两个来源合成**一个**锚点：
   * · `quoteTargetId` —— 刚点过的引用块（点了就要立刻跳过去）；
   * · `highlightIds[0]` —— 草稿卡「看引用」传进来的第一条。
   *
   * 点过的引用**优先**：它是用户此刻的动作，而 `highlightIds` 可能还停留在
   * 上一次「看引用」的那一组。两者分开成两个 effect 会让"点了引用"与
   * "看引用"互相覆盖（那正是合并前的形态）。
   */
  const anchorId = quoteTargetId ?? highlightIds[0] ?? null
  const latestMessageId = messages.at(-1)?.id ?? ""
  /**
   * ★ 锚点那条**到没到这一屏**。它必须进依赖数组。
   *
   * ## 为什么（这一条是实测踩出来的"点了没反应"）
   *
   * 引用的消息通常不在最近 80 条里，要靠 `usePersonaMessages(includeIds)`
   * 再取一次才回来。而它回来时：
   * · `anchorId` 没变（还是同一条引用）；
   * · `latestMessageId` 也没变（补进来的是**更早**的消息，末条不动）。
   *
   * 于是只依赖那两个值的话，effect 在"目标终于到了"这一刻**不会重跑** ——
   * 表现就是点了引用什么都不动。加上这个布尔量，目标从"没到"变成"到了"
   * 本身就是一次依赖变化。
   */
  const anchorPresent = anchorId !== null && messages.some((item) => item.id === anchorId)
  useLayoutEffect(() => {
    if (loading || latestMessageId === "") return

    const container = threadRef.current?.parentElement
    if (container === null || container === undefined) return

    /**
     * ★ 去重键带 `jumpNonce`：同一个目标点第二次也要重新定位。
     *
     * 只用 `conversationId:anchorId` 的话，用户跳过去 → 自己滚走 →
     * 再点同一个引用，键没变，于是这个 effect 认为"处理过了"而什么都不做
     * —— 表现就是**点了没反应**。计数让每次点击都是一次新请求。
     */
    const citationKey =
      anchorId === null ? "" : `${conversationId ?? ""}:${anchorId}:${String(jumpNonce)}`
    if (anchorId !== null) {
      /**
       * ★ 目标节点按 **id 查表**（`itemRefs`），不用共享的 `anchorRef`。
       *
       * `anchorRef` 是一个在渲染期被写的可变引用：谁最后渲染谁赢，而
       * "最后渲染的"未必是这一轮的锚点（列表重排、补捞插入更早的消息都会
       * 打乱顺序）。按 id 查表是**确定性**的 —— 要跳哪条就取哪条的节点。
       */
      const target = itemRefs.current.get(anchorId) ?? null
      if (handledCitationRef.current !== citationKey && target !== null) {
        const containerRect = container.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        const top =
          container.scrollTop +
          targetRect.top -
          containerRect.top -
          container.clientHeight / 2 +
          targetRect.height / 2
        const next = Math.max(0, top)
        /**
         * ★★ 远处**瞬时到位**，近处才平滑 —— 这是"最短路径"的关键一条。
         *
         * ## 症状与根因
         *
         * 用户报的是「不是最短路径过去的，每次都要回到上面再下去」。
         * 根因不是定位算错（`top` 一直是对的），而是 `behavior: "smooth"`：
         * 浏览器的平滑滚动会**匀速刷过中间的全部内容**。而被引用的消息
         * 几乎总在几百条之前（实测引用几乎一条都不在最近 80 条里，靠
         * `includeIds` 补捞回来的都更早）—— 于是那段动画就是肉眼可见地
         * "往上翻过整段历史"，距离越远越久。视觉上完全就是绕了一大圈。
         *
         * ## 判据：超过两屏就瞬时
         *
         * 两屏之内平滑滚是**有用的**——它让人看清"我从这儿移到了那儿"，
         * 保持了空间感。超过两屏那个空间感本来就断了（中间的内容一闪而过
         * 什么也看不清），此时动画只剩等待成本。所以远距离直接落点，
         * 靠高亮底色告诉用户"停在这条"。
         *
         * 与下面「切换会话用 auto、追加新消息用 smooth」是同一个判断：
         * 长距离用瞬时，短距离用平滑。
         */
        const far = Math.abs(next - container.scrollTop) > container.clientHeight * 2
        container.scrollTo({ top: next, behavior: far ? "auto" : "smooth" })
        handledCitationRef.current = citationKey
      }
      previousConversationRef.current = conversationId
      previousLatestMessageRef.current = latestMessageId
      return
    }

    const switchedConversation = previousConversationRef.current !== conversationId
    const appendedMessage = previousLatestMessageRef.current !== latestMessageId
    if (switchedConversation || appendedMessage) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: switchedConversation ? "auto" : "smooth",
      })
    }
    handledCitationRef.current = ""
    previousConversationRef.current = conversationId
    previousLatestMessageRef.current = latestMessageId
  }, [anchorId, anchorPresent, conversationId, latestMessageId, loading, jumpNonce])

  /**
   * ★ 这一屏还没下载的媒体，**自动下**。
   *
   * ## 为什么改成自动而不是按需
   *
   * 原来每张图都要用户点一下"下载图片"才显示。那个设计的理由是
   * "一个活跃群一周几百张图，全下是几百 MB 且绝大多数没人看" ——
   * 对**全量预取**来说这个理由成立，但对**用户正在看的这一屏**不成立：
   * 他已经打开这个会话了，那些图就是他要看的东西。
   *
   * 所以范围收在"这一屏的消息"上（最多 80 条，与消息窗口对齐），
   * 而不是整个会话历史。要下更多是另一件事，需要显式入口与进度反馈。
   *
   * ## ★ 依赖里是 `pendingMediaKey` 而不是 `messages`
   *
   * 用 messages 会在每次 invalidate 之后再跑一遍（下载成功 → 重查消息 →
   * messages 是新数组 → effect 重跑）。而 key 只在**还有没下的资源**时
   * 才变化：下完之后它变成空串，effect 自然停下。
   */
  const pendingMediaKey = useMemo(
    () =>
      messages
        .filter((message) => message.media.some((asset) => asset.path === null))
        .map((message) => message.id)
        .join(","),
    [messages],
  )
  useEffect(() => {
    if (pendingMediaKey === "") return
    autoDownload.mutate({ messageIds: pendingMediaKey.split(",") })
    // `autoDownload` 不进依赖：mutation 对象每次渲染都是新的，
    // 依赖它等于每帧重跑一次下载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMediaKey])

  /**
   * ★ 滚动容器在**这个组件里**，不在调用方。
   *
   * 原来容器在 `persona-module.tsx`，而滚动逻辑在这里 —— 于是这里只能
   * 靠 `scrollIntoView`（作用在祖先滚动容器上）而拿不到容器本身，
   * "打开就停在底部"这件事没法做（那需要 `scrollTop = scrollHeight`）。
   *
   * `overflow-x-hidden` 保留调用方原有的理由：`overflow-y:auto` 会把
   * `overflow-x` 的计算值也变成 auto，任何将来新加的不可断内容都会让
   * 横向滚动条回来，而本人消息是 `flex-row-reverse`（横向溢出方向相反，
   * 滑动手感与其余消息不一致）。不用 `overflow-hidden`：那会连纵向一起关掉。
   */
  const containerClass = "min-h-0 flex-1 overflow-y-auto overflow-x-hidden"

  if (loading) {
    return (
      <div className={containerClass}>
        <p className="typography-body-small-400 p-4 text-[var(--text-base-tertiary)]">
          {t("loading")}
        </p>
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className={containerClass}>
        <div className="flex h-full flex-col items-center justify-center gap-1 p-8">
          <p className="typography-body-base-400 text-[var(--text-base-secondary)]">
            {t("emptyThread")}
          </p>
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("emptyThreadHint")}
          </p>
        </div>
      </div>
    )
  }

  /**
   * `now` 在渲染时取一次并对整屏复用。
   *
   * 每条各取一次 `Date.now()` 会让同一屏里的"今天/昨天"判断用不同的
   * 基准 —— 正好跨午夜渲染时能看到相邻两条一个说"今天"一个说"昨天"
   * 而它们其实同一天。
   */
  const now = Date.now()
  let lastDay = ""
  let lastSender: string | null = null
  let lastAt = 0
  /**
   * 滚动锚点 = **`highlightIds[0]` 那一条**，不是"列表里第一条被高亮的"。
   *
   * ## ★ 这个区别就是那个"莫名其妙跳到上面去"的 bug
   *
   * 被引用的消息通常比最近 80 条更早（实测 53 条引用一条都不在窗口内），
   * 它被 `usePersonaMessages(includeIds)` 补进列表后排在**最前面**。
   * 于是"第一条被高亮的"≈ 列表首条 —— 每次都跳到顶部。
   *
   * 而 `highlightIds[0]` 是调用方真正想让用户看的那一条
   * （草稿卡的「看引用」传的是它引的第一条；点引用块传的是被引的那条）。
   * 多条高亮时两者会分叉，那正是要锁住的情形。
   */

  /**
   * 回程按钮只在**目标真的还在这一屏里**时显示。
   *
   * 不判的话（比如切了会话之后）按钮还挂着，点了会滚不到任何地方 ——
   * 那又是一次"点了没反应"。
   */
  const canJumpBack = returnToId !== null && messages.some((item) => item.id === returnToId)

  return (
    <div ref={scrollRef} className={containerClass}>
      {/*
        ★ 回程按钮：跳去看引用之后，一键回到刚才那条。
        没有它的话「看引用」是单程票 —— 被引用的消息常在几百条之前，
        核对完要手动滚回来，而"刚才那条"在几屏之外。

        `sticky top-0` 而不是 `fixed` / 绝对定位到底部：
        · sticky 让它**跟着这个滚动区**（滚多远都在视野里），而 fixed 会
          脱离出去盖住别的模块；
        · 停在**顶部**而不是底部 —— 底部是回复区（`ReplyDock`），
          一个浮标压在输入框上会挡住"我要发什么"。
      */}
      {canJumpBack ? (
        <div className="pointer-events-none sticky top-0 z-10 flex justify-end px-4 pt-2">
          <button
            type="button"
            onClick={jumpBack}
            className={cn(
              "typography-caption-400 pointer-events-auto flex items-center gap-1 rounded-full",
              "border border-[var(--border-light)] bg-[var(--bg-card-z1)] px-2.5 py-1",
              "text-[var(--text-base-secondary)] shadow-[var(--shadow-sm)]",
              "transition-colors hover:text-[var(--text-base-primary)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
            )}
          >
            <span aria-hidden="true">↩</span>
            {t("jumpBack")}
          </button>
        </div>
      ) : null}
      <ul ref={threadRef} className="flex flex-col gap-0.5 px-4 py-3">
        {messages.map((message) => {
          const day = dayKey(message.sentAt)
          const showDay = day !== lastDay
          const senderKey = `${String(message.isSelf)}:${message.senderDisplayName ?? ""}`
          /**
           * 合并条件：同一人 + 间隔够近 + 中间没跨天 + **没有引用块**。
           *
           * 跨天必须断开 —— 否则"昨天 23:58 / 今天 00:01"会合成一组，
           * 而那两条在对话意义上毫无关系。
           *
           * 带引用的也必须断开：引用块是"他在回复另一条"的信号，
           * 合并之后那个引用会看起来像属于上一条。
           */
          const merged =
            !showDay &&
            senderKey === lastSender &&
            message.sentAt - lastAt < MERGE_WINDOW_MS &&
            message.quoted === null
          const isHighlighted = highlighted.has(message.id)
          const isSelf = message.isSelf === true
          /**
           * ★ 显示用的正文：剥掉协议标记与 DWS 塞进来的 CLI 使用说明。
           *
           * 库里存的是原文（可回溯、可重解析），而原文里混着
           * `[图片消息](mediaId=@lQ…)` 与「注意：如需下载使用dws chat message
           * download-media命令下载」—— 实测全库 9.8% 的消息带前者、
           * 6.2% 带后者，也就是把 CLI 的使用说明摆给最终用户看。
           *
           * 那张图其实已经在 `media_assets` 里有索引，下面 `MediaBlock`
           * 正在渲染它 —— 所以标记不只是难看，它是**重复**的。
           */
          const display = toDisplayContent(message.contentText)

          lastDay = day
          lastSender = senderKey
          lastAt = message.sentAt

          return (
            <li
              key={message.id}
              /**
               * 每条都登记，按 id 索引 —— 跳转按目标 id 从 `itemRefs` 查节点。
               *
               * ★ 曾经还额外给"锚点那条"挂一个共享的 `anchorRef`，已经删掉：
               * 那是个在渲染期被写的可变引用（谁最后渲染谁赢），而最后渲染的
               * 未必是这一轮的锚点 —— 列表重排、补捞插入更早的消息都会打乱
               * 顺序，于是定位按一个过期节点算，落点是错的。按 id 查表是
               * 确定性的：要跳哪条就取哪条。
               */
              ref={(node) => registerItem(message.id, node)}
            >
              {showDay ? (
                <div className="flex items-center gap-3 px-2 py-3">
                  <span className="h-px flex-1 bg-[var(--border-divider-light)]" />
                  <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                    {dayLabel(message.sentAt, now)}
                  </span>
                  <span className="h-px flex-1 bg-[var(--border-divider-light)]" />
                </div>
              ) : null}

              <div
                className={cn(
                  "group flex gap-2 px-2",
                  merged ? "py-0.5" : "pt-2 pb-0.5",
                  // 本人的消息靠右 —— IM 的基本语言，一眼看出"这是我说的"
                  isSelf ? "flex-row-reverse" : "",
                  isHighlighted
                    ? "rounded-[var(--radius-md)] bg-[var(--status-fill-warning-container)]"
                    : "",
                )}
              >
                {/* 合并时留出头像的宽度但不渲染头像 —— 保证气泡左边缘对齐 */}
                <span className="w-7 shrink-0">
                  {merged ? null : (
                    <Avatar
                      name={message.senderDisplayName ?? (isSelf ? t("me") : "?")}
                      src={
                        message.senderExternalId === null
                          ? null
                          : (avatarByExternalId.get(message.senderExternalId) ?? null)
                      }
                      size="md"
                    />
                  )}
                </span>

                <div
                  className={cn(
                    "flex min-w-0 flex-col gap-0.5",
                    // 气泡不占满整行：太宽的行读起来累，也看不出"谁说的"
                    "max-w-[min(560px,72%)]",
                    isSelf ? "items-end" : "items-start",
                  )}
                >
                  {merged ? null : (
                    /**
                     * ★ 头部四项要有收缩策略，否则长发送者名会把这一行
                     * 撑得比气泡还宽（实测最长 15 字符，形如
                     * 「张小明 Alex（主用钉）」「Morgan（小莫）［主用钉］」——
                     * 化名，长度与字符集与真实样本一致）。
                     *
                     * 分工：名字**可截**（`min-w-0 truncate`），
                     * 时间与两个状态标签**不可截**（`shrink-0`）——
                     * 截一半的时间戳没有意义，而「@我」少一个字就变了意思。
                     */
                    <span
                      className={cn(
                        "typography-caption-400 flex min-w-0 max-w-full items-baseline gap-1.5 text-[var(--text-base-tertiary)]",
                        isSelf ? "flex-row-reverse" : "",
                      )}
                    >
                      <span className="min-w-0 truncate text-[var(--text-base-secondary)]">
                        {isSelf ? t("me") : (message.senderDisplayName ?? t("unknownSender"))}
                      </span>
                      <span className="shrink-0" title={fullLabel(message.sentAt)}>
                        {timeLabel(message.sentAt, now)}
                      </span>
                      {message.mentionsSelf ? (
                        <span className="shrink-0 text-[var(--text-accent-normal)]">
                          {t("mentionsMe")}
                        </span>
                      ) : null}
                      {/*
                        「分身发的」**不**放在这一行 —— 见气泡下面那个
                        `AgentSendBadge`。这一行只在未合并时渲染，
                        分身连发两条时第二条就没有角标了。
                      */}
                    </span>
                  )}

                  <div
                    className={cn(
                      "flex flex-col gap-1 rounded-[var(--radius-md)] px-2.5 py-1.5",
                      isSelf
                        ? "bg-[var(--status-fill-info-container)] text-[var(--text-base-primary)]"
                        : "bg-[var(--bg-card-z0)] text-[var(--text-base-primary)]",
                      // @我 用一条左边线标出来，而不是换底色（底色已经用来分"谁说的"了）
                      message.mentionsSelf && !isSelf
                        ? "border-l-2 border-[var(--text-accent-normal)]"
                        : "",
                    )}
                  >
                    {/*
                    ★ 引用块：点了就跳到被引用的那条消息。
                    `quoted.id` 是真的 `message_id`（不是按文本匹配猜），
                    所以定位是可靠的。

                    ★★ 目标**不在这一屏也能跳** —— 走 `requestJump`，它会把
                    这个 id 交给容器去 `includeIds` 取回来（与草稿卡的
                    「看引用」同一条路）。这里曾经用 `presentIds` 把
                    窗口外的目标做成不可点，于是用户只能去右上角搜索里绕一圈
                    —— 而后端本来就支持按 id 补捞（见 persona.service 的
                    `messages(includeIds)`）。唯一真的跳不了的是**没有 id**
                    （被引用的消息压根没采到），那时仍然只展示。
                  */}
                    {message.quoted === null ? null : (
                      <QuotedBlock
                        quoted={message.quoted}
                        // 有 id 就能跳 —— 不在窗口里的会被补捞回来
                        jumpable={message.quoted.id !== null}
                        onJump={() => requestJump(message.quoted?.id ?? null, message.id)}
                        unknownLabel={t("quotedUnknown")}
                        outOfRangeLabel={t("quotedOutOfRange")}
                        jumpHint={t("quotedJumpHint")}
                      />
                    )}

                    {display.text === "" ? null : (
                      /**
                       * ★ `wrap-anywhere` 而不是 `break-words`。
                       *
                       * `break-words`（overflow-wrap: break-word）只在**已有断点**处
                       * 换行，对不含空格的长 token 完全无效。实测库里真有这种数据 ——
                       * 钉钉分享链接：`[dingtalk://dingtalkclient/page/link?pc_slide=…`
                       * 单条 1568 字符且一个空格都没有。
                       *
                       * 气泡有 `max-w-[min(560px,72%)]`，但 `max-width` **管不住**
                       * 一个不可断的子元素：它撑破气泡 → 撑破 li → 在滚动容器上
                       * 冒出横向滚动条。而本人消息是 `flex-row-reverse`，
                       * 那里的溢出方向是**反的**，于是横向滑动的手感与其余消息相反。
                       *
                       * 不用 `break-all`：那会在任何字符间断开，把正常英文单词
                       * 也拦腰截断。`anywhere` 只在没有更好断点时才硬断，
                       * 而且它参与 `min-content` 计算 —— 这正是气泡宽度需要的。
                       */
                      <span className="typography-body-small-400 whitespace-pre-wrap wrap-anywhere">
                        {display.text}
                      </span>
                    )}

                    {message.media.map((asset) => (
                      <MediaBlock
                        key={asset.id}
                        asset={asset}
                        busy={downloadMedia.isPending}
                        onDownload={() => downloadMedia.mutate({ mediaId: asset.id })}
                      />
                    ))}

                    {/*
                    ★ 正文清洗成空、又没有媒体行可渲染时给一句占位。

                    这种情况有一个真实来源：消息里只有 `[图片消息](mediaId=…)`
                    而 `media_assets` 里那一行还没建索引（历史数据或解析规则
                    变过）。那时清洗后正文是空、`media` 数组也是空 ——
                    气泡会渲染成一个**空的圆角矩形**，看起来像界面坏了。

                    用 `hadMedia` 区分"这条本来是媒体消息"与"真的空消息"：
                    前者说明有内容只是取不到，后者才是异常。
                  */}
                    {display.text === "" && message.media.length === 0 ? (
                      <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                        {display.hadMedia ? t("mediaUnindexed") : t("emptyMessage")}
                      </span>
                    ) : null}
                  </div>

                  {/*
                    ★ 「分身发的」角标 —— 挂在**气泡下面**，不在消息头里。

                    ## 为什么不能放在头里

                    那一行只在**没合并**时渲染（`merged` 为 false）。而分身
                    连发两条时第二条是合并的 —— 角标就消失了，也就是
                    "有时显示有时不显示"，比不显示更让人不信。

                    ## 为什么可点

                    用户的原话是「点击后能显示引用的区域」。它交出的是这条
                    发送当时的 `citations`，由容器走 `includeIds` 取回来
                    （引用常在窗口之外，见 onShowCitations 的注释）。

                    没有 citations 时**仍然显示**但不可点：角标本身
                    （"这句不是本人自己想的"）是有价值的信息，
                    而"可点却点不出东西"是"点了没反应"的形态。
                  */}
                  {/*
                    ★ 判 `== null` 一次盖住 null 与 undefined。

                    契约上它是 `nullable()`（服务端总会给 null），但渲染层
                    对"字段没来"必须是**不崩**的：这一栏的数据经 IPC 过来，
                    而旧版本主进程 / 半路改过的 fixture 都可能少这个字段。
                    一条消息缺个角标是可接受的降级，整个消息流白屏不是。
                  */}
                  {/*
                    ★ 「正在基于这条起草」—— 就地标在被处理的那几条上。
                    见 `generatingIds` 的注释：顶部一个转圈回答不了
                    "正在处理哪几条"这个问题。
                  */}
                  {generatingSet.has(message.id) ? (
                    <span className="typography-caption-400 flex items-center gap-1.5 text-[var(--text-accent-normal)]">
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--text-accent-normal)]"
                      />
                      {t("generatingFromThis")}
                    </span>
                  ) : null}

                  {message.agentSend == null ? null : (
                    <AgentSendBadge
                      source={message.agentSend.source}
                      citationCount={message.agentSend.citations.length}
                      autoLabel={t("sentByPersonaAuto")}
                      approvedLabel={t("sentByPersonaApproved")}
                      citationLabel={t("showCitationCount", {
                        count: message.agentSend.citations.length,
                      })}
                      onShowCitations={
                        onShowCitations === undefined || message.agentSend.citations.length === 0
                          ? undefined
                          : () => onShowCitations(message.agentSend?.citations ?? [])
                      }
                    />
                  )}
                </div>

                {/*
                合并后的行没有时间戳（那会让每行都挂一个数字）——
                hover 时才显示，需要的时候能看到，不需要时不占视觉。
              */}
                {merged ? (
                  <span
                    className="typography-caption-400 shrink-0 self-center text-[var(--text-base-tertiary)] opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                    title={fullLabel(message.sentAt)}
                  >
                    {timeLabel(message.sentAt, now)}
                  </span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * 引用块。可点时跳到被引用的那条消息。
 *
 * ## ★ 为什么用 `<button>` 而不是给 `<span>` 挂 onClick
 *
 * 点击能力必须落在可聚焦、有语义的元素上：键盘用户能 Tab 到它并回车，
 * 读屏器会念"按钮"。挂了 onClick 的 span 仍然只是一段文字 ——
 * 用户不知道它可点（旁边 `MediaBlock` 的图片放大也是同一个理由）。
 *
 * 不可跳时**退回 `<span>`**，不是一个 disabled 的 button：
 * 那时它不是"暂时不能点"，而是"本来就不可点"（被引用的消息在采集窗口
 * 之外，永远不会出现在这一屏）。给个 disabled button 会让人反复去点。
 */
/**
 * 「这条是数字分身发的」角标。
 *
 * ## ★ 两种来源必须分开显示
 *
 * · `agent_auto` —— 分身**自己**决定并发出去的；
 * · `user_approved` —— 分身起草、**本人点了发送**的。
 *
 * 合成一句"分身发的"会让后者显得比实际更自动 —— 而那两者的责任归属
 * 完全不同（前者是系统替我说话，后者是我自己选的那句话）。
 * 用户日后回看"这句怎么发出去的"，要的正是这个区分。
 *
 * ## 有引用才可点
 *
 * 没有 citations 时仍然显示角标（"这句不是本人自己想的"本身有价值），
 * 但退回 `<span>` —— 与 `QuotedBlock` 同一个理由：一个可点却点不出
 * 东西的按钮会让人反复去点，那是"点了没反应"的形态。
 */
function AgentSendBadge({
  source,
  citationCount,
  autoLabel,
  approvedLabel,
  citationLabel,
  onShowCitations,
}: {
  source: string
  citationCount: number
  autoLabel: string
  approvedLabel: string
  citationLabel: string
  onShowCitations?: (() => void) | undefined
}) {
  /**
   * ★ 判据是 `=== "agent_auto"`，未知值按**保守**那一档（"本人确认过"）。
   *
   * 反过来（未知当自动发）会把一条本人亲自点过发送的消息说成系统自动发的
   * —— 那是在夸大自动化的程度，而这一栏的作用恰恰是让用户信任它。
   */
  const label = source === "agent_auto" ? autoLabel : approvedLabel
  const dot = (
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--text-accent-normal)]" />
  )

  if (onShowCitations === undefined || citationCount === 0) {
    return (
      <span className="typography-caption-400 flex items-center gap-1.5 text-[var(--text-base-tertiary)]">
        {dot}
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onShowCitations}
      title={citationLabel}
      className="typography-caption-400 flex items-center gap-1.5 rounded-[var(--radius-sm)] text-[var(--text-base-tertiary)] transition-colors hover:text-[var(--text-accent-normal)]"
    >
      {dot}
      <span>{label}</span>
      <span className="text-[var(--text-accent-normal)]">{citationLabel}</span>
    </button>
  )
}

function QuotedBlock({
  quoted,
  jumpable,
  onJump,
  unknownLabel,
  outOfRangeLabel,
  jumpHint,
}: {
  quoted: NonNullable<PersonaMessageView["quoted"]>
  jumpable: boolean
  onJump: () => void
  unknownLabel: string
  outOfRangeLabel: string
  jumpHint: string
}) {
  const inner = (
    <>
      <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {quoted.senderDisplayName ?? unknownLabel}
      </span>
      <span className="typography-caption-400 wrap-anywhere text-[var(--text-base-tertiary)]">
        {/* 被引用的消息不在采集窗口里时正文是空的 —— 明说而不是留白 */}
        {quoted.excerpt === "" ? outOfRangeLabel : quoted.excerpt}
      </span>
    </>
  )

  const base = "flex flex-col gap-0.5 border-l-2 border-[var(--border-divider-light)] pl-1.5"

  if (!jumpable) return <span className={base}>{inner}</span>

  return (
    <button
      type="button"
      onClick={onJump}
      title={jumpHint}
      className={cn(
        base,
        // `text-left`：button 默认居中，而这是一段引文
        "cursor-pointer rounded-[var(--radius-sm)] text-left outline-none",
        "transition-colors duration-150 hover:border-[var(--text-accent-normal)]",
        "hover:bg-[var(--overlay-on-container-hover)]",
        "focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
      )}
    >
      {inner}
    </button>
  )
}

/**
 * 一个图片/文件块。
 *
 * ## ★ 那个下载按钮现在是**兜底**，不是主路径
 *
 * 打开会话时这一屏的媒体会自动下（见上方 `pendingMediaKey` 那段 effect），
 * 所以正常情况下用户看到的就是图本身。
 *
 * 按钮仍然要留着：自动下载**会失败**（网络、钉盘文件类型还没接、
 * 平台 id 缺失），而失败时如果只剩三个字「[图片]」，用户既不知道
 * 发生了什么也没有补救手段。这时按钮就是那个手动重试的入口。
 */
function MediaBlock({
  asset,
  busy,
  onDownload,
}: {
  asset: MessageMediaView
  busy: boolean
  onDownload: () => void
}) {
  const { t } = useDynamicTranslation("persona")
  const [zoomed, setZoomed] = useState(false)

  if (asset.path !== null && asset.previewable) {
    return (
      <>
        {/*
          ★ 包一层 `<button>` 而不是给 `<img>` 挂 onClick。

          点击能力必须落在一个**可聚焦、有语义**的元素上：
          · 键盘用户能 Tab 到它并回车打开；
          · 读屏器会念"按钮"，而挂了 onClick 的 img 仍然只是一张图
            （用户不知道它可点）。

          `cursor-zoom-in` 明示"点了会放大" —— 缩略图看起来与不可点的图
          完全一样，没有这个提示用户不会去点。
        */}
        <button
          type="button"
          onClick={() => setZoomed(true)}
          title={t("mediaZoomHint")}
          className="cursor-zoom-in self-start rounded-[var(--radius-sm)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
        >
          <img
            /**
             * `asset.path` 已经是 `mycontext-file://` URL。
             * 直接用 `file://` 会被 Chromium 拦掉（见文件头与 local-file-protocol.ts）。
             */
            src={asset.path}
            alt={asset.originalName ?? t("mediaImage")}
            // 缩略图上限：一张竖图不该把整个气泡顶到一屏高
            className="max-h-[240px] max-w-full rounded-[var(--radius-sm)] object-contain"
          />
        </button>
        {/*
          ★ 只在打开时挂载。
          常挂的话一屏 20 张图就是 20 个 `<dialog>` + 20 份原图 URL，
          而其中 19 个永远不会被看到。
        */}
        {zoomed ? <MediaLightbox asset={asset} open onClose={() => setZoomed(false)} /> : null}
      </>
    )
  }

  if (asset.path !== null) {
    // 下载了但不是图片（PDF 等）—— 只给文件名，不尝试内联渲染
    // `wrap-anywhere`：文件名同样可能是一长串没有空格的字符
    return (
      <span className="typography-caption-400 wrap-anywhere text-[var(--text-base-secondary)]">
        {t("mediaFile", { name: asset.originalName ?? asset.kind })}
      </span>
    )
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onDownload}
      className={cn(
        "typography-caption-400 flex items-center gap-1 self-start rounded-[var(--radius-sm)] px-1.5 py-0.5",
        "border border-dashed border-[var(--border-divider-light)] text-[var(--text-base-secondary)]",
        "transition-colors duration-150 hover:bg-[var(--overlay-on-container-hover)]",
        "disabled:cursor-not-allowed disabled:text-[var(--text-base-disable)]",
      )}
    >
      {t(asset.kind === "image" ? "mediaDownloadImage" : "mediaDownloadFile")}
    </button>
  )
}
