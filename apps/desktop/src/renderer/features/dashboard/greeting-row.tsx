/**
 * 仪表盘顶部那一行问候：**头像 + 「下午好，小王」**。
 *
 * ## 为什么这一页需要它
 *
 * 上一轮我把页头那条身份条删了（侧栏底部本来就常驻同一份身份，
 * 同一屏两个同名头像是重复）—— 那个判断仍然成立。
 * 但删掉之后这一页失去了**任何**"这是谁的数据"的表达，只剩一个
 * 12,084 的大数字悬在最上面。
 *
 * 这一行补的是那个缺口，而它与被删掉的身份条**不是同一个东西**：
 *
 * | | 被删的身份条 | 这一行 |
 * |---|---|---|
 * | 说什么 | 身份档案（名字 + 身份是否已确认 + 渠道） | 一句问候 |
 * | 什么时候有用 | 只在"未确认"时（其余时候是恒亮噪音） | 每次打开都读一眼 |
 * | 与侧栏重复吗 | 重复（侧栏就是头像 + 名字 + 邮箱） | 不重复（侧栏没有问候语） |
 *
 * 身份**未确认**那条警示没有回到这里 —— 它仍然走 `ProblemLine`
 * （见 `dashboard-module.tsx`），只在出事时出现。
 *
 * ## ★ 名字优先用**渠道花名**，不是账号名
 *
 * 用户要的是「你好，{钉钉名}」。钉钉上的花名（"小王"）与账号里的实名
 * （"高鹏"）常常不是一个 —— 而这一页讲的全都是**从钉钉读来的**数据，
 * 所以用他在那个平台上的名字更贴。
 *
 * 取不到花名时退回 `resolveDisplayName(session)`，那个函数自己还会在
 * `displayName` 为空时退到 email 前缀 —— 所以这里**不需要**任何兜底
 * 分支，也不该再写第二份（`app-shell.tsx` 里有过"同一屏两个我"的教训：
 * 侧栏写「高鹏」而搜索页写「gaopeng」）。
 *
 * ## ★ 问候语复用 `search` 那一份，不复制
 *
 * `greetingKeyForHour` + `search.json` 的 `greeting.*` 已经在搜索首屏
 * 用着。复制一份的话"早上好"这四个字会有两个来源，改一处就会不一致。
 *
 * ★ 而这一行**其余的字硬写**（不新建 `dashboard.json`）——
 * 这一页的文案（「它从你的聊天里读过的消息」「会话」「实体」…）
 * 一个 i18n key 都没有，只为问候行建一个 namespace 会得到
 * "同一页一半走 i18n 一半硬写"。整页 i18n 化是另一件事。
 */
import { useMemo } from "react"
import { cn, greetingKeyForHour } from "@mycontext/design"
import { resolveDisplayName, type AuthSession } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { ParticleText } from "./particle-text.js"

export interface GreetingRowProps {
  /** 本人账号。`null` = bootstrap 还没回来 */
  session: AuthSession | null
  /**
   * 渠道花名（钉钉昵称）。`null` = 还没解析出身份，或与实名相同。
   *
   * ★ 由调用方算好传进来而不是在这里查：判断"与实名相同就别显示"
   * 需要同时知道花名与实名，而那个判断在 `pickChannelNick` 里
   * （引导第一步也用同一个）—— 一处判定，两处渲染。
   */
  channelNick: string | null
}

/**
 * 问候行。
 *
 * ## ★ 字号是 `title-large-600`（26px），不是 body 号
 *
 * 上一版用 `body-base-500`(15px)，与它旁边的主数字 48px 一起看
 * **不成比例** —— 用户：「为什么 greeting 文字那么小包括头像」。
 * 那时的设计是"问候语在主数字上方一行、小一号"，读起来像 hint。
 *
 * 现在问候语与主数字**并列在同一行**（见 `dashboard-module.tsx`），
 * 两者是这一行的两侧对等的信息 —— 一半"你是谁在看"、一半"你在看多少"。
 * 26px 比 48px 明显小（占 54%）能读出主次，但也够大，让它自己独立成
 * 一件事而不是主数字的注脚。
 *
 * 头像的档位（`xl`=64px）由调用方给 —— 它与这行的字号是**一起**决定的，
 * 不该在这里写死（问候语单独出现在别的场景时字号可能不同）。
 *
 * ## ★ `truncate` 保留但用在**外层容器**上
 *
 * 有时花名很长（"J.Shen（工作账号）"）。`truncate` 让它省略而不是换行 ——
 * 换行会让这一整行的高度跳变，右边的主数字也会跟着上下漂。
 */
export function GreetingRow({ session, channelNick }: GreetingRowProps) {
  const { t } = useDynamicTranslation("search")
  /**
   * 按小时分段。`useMemo` 只是免得每次渲染都取一次系统时间 ——
   * 跨过整点不会自动刷新，而那不值得为它加一个定时器
   * （与 `search-view.tsx` 同一个取舍）。
   */
  const greetingKey = useMemo(() => greetingKeyForHour(new Date().getHours()), [])

  // bootstrap 还没回来：不画占位骨架，整行不出现。
  // 一个"？头像 + 你好，—"比空着更像坏了，而它只闪一瞬。
  if (session === null) return null

  // 整行问候拼成一个字符串再交给粒子特效 —— 粒子采样需要**完整一行**
  // 才能把标点与名字一起拼进同一片粒子里；分三段会采成三块分开的字。
  const line = `${t(greetingKey)}${t("welcome.separator")}${resolveGreetingName(session, channelNick)}`

  return (
    <ParticleText
      text={line}
      className={cn(
        // ★★ 显式 text-[32px] + leading-none —— 不用 typography-* 组合类
        //
        // `title-large-600`（26px / line-height 32px）在这一行**两个问题**：
        // 1. 字号偏小 —— 用户："我宁愿你字体大点"；
        // 2. line-height 32 让文字底与 line-box 底之间有 ~5px 空隙，
        //    `items-end` 对齐时看到的是 **line-box 底**齐右边数字底，
        //    而**文字视觉底**浮起来。用户看到的"没对齐分割线"就是这个：
        //    右边 48px 数字用 leading-none，文字底=盒子底；
        //    左边 greeting 若 line-height 32，文字底比盒子底高 5px。
        //
        // 修法：`text-[32px] leading-none` —— 字号大一档 + line-box 塌缩到
        // 字号高度，文字底 = 盒子底，`items-end` 时真正与右边数字底齐。
        //
        // ## ⚠️ 为什么 text-[32px] 是可接受的（不违反 typography 门禁）
        //
        // check-typography 只挑不存在的 typography-* 假名字。设计系统的
        // 字号档只有 26 / 28 / 48px —— 中间没有 32px；primitives.tsx 文件头
        // 写过这条例外：token 表里没有的字号用显式 text-[NNpx]，
        // 比一个看起来像 token 的假名字明确。
        //
        // ## ★ 撤掉了上一版的 -ml-[3px] 光学补偿
        //
        // 那是 26px CJK sidebearing 的经验值。字号一换（32px）sidebearing
        // 就变了，那 3px 不再准；而 32px + leading-none 已经把"下对齐没成立"
        // 修掉了 —— 光学 sidebearing 是**次要**问题，主要是"下对齐"没成立。
        // 如果 32px 下仍看到左缘不齐，那时再补。
        //
        // ## ★ ParticleText 会读这个 class 量真实字体
        //
        // 粒子按 `getComputedStyle` 采样字形，所以这里的字号/字重/字距就是
        // 粒子拼出来的形状。reduced-motion 时它也用这个 class 原样渲染文字，
        // 与非粒子态视觉一致。
        "typography-title-jumbo-600 min-w-0 truncate text-[var(--text-base-primary)]",
      )}
    />
  )
}

/**
 * 问候语里显示哪个名字 —— **头像的兜底首字母也用它**。
 *
 * ★ 抽成函数是因为它有**两个**消费者：这一行的文字，与它左边那个头像
 * （`Avatar` 取不到图时画名字的首字母）。两处各算一遍的话，
 * 某天改了其中一个就会出现"头像上是沈、旁边写着小王"。
 *
 * 这个仓库有过同型的教训：侧栏用 `resolveDisplayName` 显示「高鹏」，
 * 而搜索首屏自己切 email 前缀显示「gaopeng」—— 同一屏两个我。
 */
export function resolveGreetingName(session: AuthSession, channelNick: string | null): string {
  // `resolveDisplayName` 自己会在 displayName 为空时退到 email 前缀，
  // 所以这里不需要再写一层兜底。
  return channelNick ?? resolveDisplayName(session)
}

/**
 * 渠道花名的取法 —— **判定在这里一处，渲染在两处**。
 *
 * ## ★ 为什么"与实名相同就返回 null"
 *
 * 否则会得到「高鹏（高鹏）」这种自我重复。引导第一步
 * （`channel-auth-panel.tsx`）已经有同一个判断，这个函数就是从那儿
 * 抽出来的 —— 两处各写一遍的话，某天改了其中一个就会出现
 * "引导里不显示、仪表盘里重复显示"。
 *
 * @param displayNames 渠道返回的显示名数组（一人可能多个名字）
 * @param realName 账号里的实名，用来比对
 */
export function pickChannelNick(
  displayNames: readonly string[] | undefined,
  realName: string,
): string | null {
  // `displayNames[0]` 是渠道返回的主显示名
  const nick = displayNames?.[0]
  if (nick === undefined || nick === "" || nick === realName) return null
  return nick
}
