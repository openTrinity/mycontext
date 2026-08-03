/**
 * ChannelAuthPanel — 渠道授权卡片。
 *
 * Onboarding 与设置页共用：两处的信息与操作完全一致，分别实现必然漂移。
 * 差异只由 variant 控制——Onboarding 用居中的「连接关系」大图（首次引导需要
 * 讲清楚「谁连到谁」），设置页用紧凑的行式布局（已经知道背景，只关心状态与操作）。
 *
 * 视觉语言对齐参考设计系统的连接器卡片：
 * 双图标 + 中间状态连线、填充块承载账号信息（带状态圆点）、
 * 未连接时用图标 + 标题 + 说明的信息块讲清授权范围。
 */
import { Avatar, Button, DingTalkIcon, Panel, Tooltip, cn } from "@mycontext/design"
import { REFRESH_EXPIRY_WARNING_DAYS } from "@mycontext/ipc-contract"
import type { AuthProgress, AuthStatus, ChannelSummary } from "@mycontext/ipc-contract"
import { useEffect, useState } from "react"
import type { ComponentType } from "react"
import { Trans } from "react-i18next"
import {
  useAdoptSession,
  useAdoptableSession,
  useAuthProgress,
  useBootstrapState,
  useCancelChannelAuth,
  useSelfIdentity,
  useStartChannelAuth,
} from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { StepSection } from "../onboarding/step-section.js"
import { DwsSourceDisclosure } from "./dws-source-disclosure.js"
import { DINGTALK_BRAND, KeyIcon, ShieldIcon, SpinnerIcon, ToolsIcon } from "./channel-icons.js"

/**
 * 渠道 id → 官方标识组件。
 *
 * 放在这里而不是渠道插件里：插件跑在主进程，不能引 React 组件。
 * 没有官方标识的渠道不在表里，由 ChannelBadge 走字母兜底。
 */
const BRAND_ICONS: Record<string, ComponentType<{ className?: string }> | undefined> = {
  dingtalk: DingTalkIcon,
  feishu: FeishuBrandIcon,
}

const FEISHU_BRAND_LOGO_URL = new URL("./assets/channel-source-logo.png", import.meta.url).href

function FeishuBrandIcon({ className }: { className?: string }) {
  return <img alt="" className={cn("object-contain", className)} src={FEISHU_BRAND_LOGO_URL} />
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 状态文案的 i18n key。三个状态都要有，缺一个界面上就是原样的 key。 */
const STATE_LABEL_KEY: Record<AuthStatus["state"], string> = {
  authorized: "channels:state.authorized",
  expired: "channels:state.expired",
  unauthorized: "channels:state.unauthorized",
}

const STATE_STYLE: Record<AuthStatus["state"], string> = {
  authorized: "bg-[var(--status-fill-success-container)] text-[var(--status-success)]",
  expired: "bg-[var(--status-fill-warning-container)] text-[var(--status-warning)]",
  unauthorized: "bg-[var(--bg-card-z0)] text-[var(--text-base-tertiary)]",
}

export interface ChannelAuthPanelProps {
  channel: ChannelSummary
  /** onboarding：居中大图引导；settings：紧凑行式 */
  variant?: "onboarding" | "settings"
}

export function ChannelAuthPanel({ channel, variant = "settings" }: ChannelAuthPanelProps) {
  const { t } = useDynamicTranslation("channels")
  const errorText = useErrorText()
  const start = useStartChannelAuth()
  const cancel = useCancelChannelAuth()
  const [progress, setProgress] = useState<AuthProgress | null>(null)
  /**
   * 授权 URL 与授权码单独留存，不从「最后一个进度事件」推导。
   *
   * dws 会先打印 URL/授权码、随后持续打印「等待授权中」，
   * 若只看最新事件，这些用户真正需要的信息会被 waiting 冲掉——
   * 而它们恰恰是浏览器没自动打开时的唯一兜底。
   */
  const [browserUrl, setBrowserUrl] = useState<string | undefined>(undefined)
  const [scopeAuthorizationUrl, setScopeAuthorizationUrl] = useState<string | undefined>(undefined)
  const [deviceCode, setDeviceCode] = useState<
    Extract<AuthProgress, { phase: "device-code" }> | undefined
  >(undefined)
  const [onboardingExpanded, setOnboardingExpanded] = useState(false)

  useAuthProgress(channel.id, (next) => {
    setProgress(next)
    if (next.phase === "browser-opened") setBrowserUrl(next.url)
    if (next.phase === "scope-authorization") setScopeAuthorizationUrl(next.url)
    if (next.phase === "device-code") setDeviceCode(next)
  })

  const running = start.isPending
  const status = channel.status
  const authorized = status.state === "authorized"
  const scopePrefix = channel.id === "feishu" ? "feishuScope" : "scope"

  /**
   * 渠道侧的昵称（钉钉叫花名）。
   *
   * 只在已授权时查 —— 未授权时那一行必然不存在，白发一次 IPC。
   * 拿不到就不显示（`readSelf` 在还没解析身份时返回 null，那是正常状态）。
   *
   * ★ 用 `useSelfIdentity`（query）而不是 `useResolveSelf`（mutation）：
   * 后者每次都真调渠道并可能抛歧义错误 —— 见 queries.ts 里的注释。
   */
  // The current identity IPC is the DingTalk/Persona identity. Feishu is a
  // read-only knowledge source and deliberately has no Persona identity UI.
  const usesPersonaIdentity = channel.id === "dingtalk"
  const selfIdentity = useSelfIdentity(authorized && usesPersonaIdentity)
  /**
   * ★★ 这个**账号**自己连好了吗 —— 与「渠道 authorized」是两件事。
   *
   * ## 为什么需要比 `authorized` 更严的判据
   *
   * dws 的登录态按**系统用户**共享（token 密钥在 Keychain，`DWS_CONFIG_DIR`
   * 隔离不了它 —— 见 `plugins/dingtalk/auth.ts` 文件头）。所以 `authorized`
   * 回答的是「**这台电脑**登录过钉钉吗」，而不是「**这个账号**连了吗」。
   *
   * 后果（实测两个真实形态）：新注册的账号一进引导页就看到「已连接钉钉·某某」，
   * 合理反应是"那我不用管了，下一步" —— 于是他从不授权，而这个账号的
   * 身份行、头像、显示名、采集范围全都跟着**上一个账号**或某个**过期
   * profile** 走。`@222` 那个账号就是：身份表 0 行、accounts 两列全 NULL，
   * 而 messages 已 49 条 —— `is_self` 全 NULL，蒸馏拒掉全部语料而进度页显示"完成"。
   *
   * 引导页的完成门本来就用的是按账号的信号（`selfConfirmed` 读 vault 里的
   * `confirmed_at`），所以它没被这个假象骗到。**骗到的是界面**：卡片显示
   * 「已连接」，用户没有任何理由去点授权。这里把那个表达修正过来。
   *
   * ## ★ 判据是 `confirmed` 而不只是"有身份行"
   *
   * 同名多 ID 的歧义情形下身份行存在、但 `confirmed_at` 仍是 null
   * （主进程不替用户猜）。那时 `is_self` 全表为空、蒸馏一条语料都拿不到，
   * 所以同样**不算**"这个账号连好了" —— 与完成门的判据保持一致。
   *
   * `undefined`（还在查）按"未连接"处理会让已连接的账号闪一下"去授权"，
   * 所以显式要求 `=== true`：查完之前两个分支都不进（见下面 `pending`）。
   */
  const accountConnected =
    authorized && (!usesPersonaIdentity || selfIdentity.data?.confirmed === true)
  /**
   * 身份还在查 —— 此时**不要**下结论。
   *
   * 不判这个的话：已连接的账号在首帧会显示「授权钉钉」，200ms 后变回
   * 「已连接」。那种一闪而过的状态比慢 200ms 更让人困惑，
   * 而且会让人以为自己的授权掉了。
   */
  const identityPending = authorized && usesPersonaIdentity && selfIdentity.data === undefined

  /**
   * 与实名不同才显示，否则会得到"王强（王强）"。
   *
   * `displayNames` 是数组（一人可能多个名字），取第一个 ——
   * 它是渠道返回的主显示名。
   */
  const channelNick = (() => {
    if (!authorized) return null
    const nick = selfIdentity.data?.displayNames[0]
    if (nick === undefined || nick === "" || nick === status.userName) return null
    return nick
  })()

  /**
   * ★★ 身份错位：**渠道当前用的组织** ≠ **这个账号绑定的组织**。
   *
   * ## 这条告警现在是「异常兜底」，不再是常态
   *
   * 改动前它是常态：渠道命令跟着 CLI 的全局 `currentProfile` 走，而那个值
   * 会被用户在终端改掉，于是应用拿着 A 的库去读 B 的会话。实测过一次真实
   * 错位（库里绑组织甲、248 个会话，而 `chat list-all-conversations` 按组织乙
   * 答 38 个）—— 那是**越权读取面**，与 CLAUDE.md 第 5 节同一类问题。
   *
   * 现在两道防线把它从根上关掉了：
   * ① 渠道配置目录**按 vault**，挂载时只 seed 当前身份那一条 profile ——
   *    结构性隔离（实测拿另一个身份的 `--profile` 去问直接
   *    `organization "…" not found`）；
   * ② 每条命令再显式钉一次 `--profile <corpId>:<userId>`。
   *
   * ## ★ 那为什么还留着它
   *
   * 因为它现在能抓到一件**真的异常**：seed 逻辑失效（比如那个目录被外部
   * 改过、或 CLI 在里面跑过一次 `auth login` 又加进一个身份）。
   * 那时两个值会重新分叉，而没有这条告警的话它又是静默的。
   *
   * ★ 一条过期的注释已按实测改掉：这里原来写「实测**每一种** `--profile`
   * 形式都报 organization not found，所以只能告警不能修」。那是**旧 CLI
   * 版本**的结论 —— 在 v1.0.56 上 `--profile <corpId>:<userId>` 四类命令
   * 全部正常，且放在子命令之后也生效。所以"不能修"已经不成立，
   * 修法就是上面那两道。（`profile switch` 仍然不用：它改全局状态，
   * 会踩掉用户终端里的登录态，而且实测 `--dry-run` 也会真的改。）
   *
   * ★ 比对用 `corpId` 而不是 `corpName`（后者是显示名，写法可能变）。
   * 两侧任一为空就不判 —— 缺值时报警只会制造假阳性。
   */
  const identityMismatch = (() => {
    if (!authorized) return null
    const boundCorpId = selfIdentity.data?.corpId
    if (boundCorpId === undefined || boundCorpId === null || boundCorpId === "") return null
    if (boundCorpId === status.corpId) return null
    return {
      channelCorp: status.corpName,
      boundCorp: selfIdentity.data?.corpName ?? boundCorpId,
    }
  })()

  /**
   * 本机有一份**可采纳**的登录态（渠道说已授权，但这个账号还没身份行）。
   *
   * ## ★ 这个状态意味着什么
   *
   * dws 的登录态按**系统用户**共享（token 密钥在 Keychain，`DWS_CONFIG_DIR`
   * 隔离不了它 —— 见 plugins/dingtalk/auth.ts 文件头）。所以新注册一个应用
   * 账号进来就是"已连接"，而这个账号自己的身份/头像/显示名都还没落库。
   *
   * ★ **不自动采纳** —— 给一个写明组织与账号的按钮，由用户决定。
   * 自动采纳会替他选定身份，而他之后真去授权换组织时反被身份守卫拦住
   * （`SELF_IDENTITY_CONFLICT`）—— 那个冲突是自动补跑自己制造的。
   * 完整理由见主进程 `adoptExistingSession` 的注释。
   *
   * 只在已授权时查：未授权时答案必然是 null，而这个查询会跑一次
   * `auth status`（子进程）。
   */
  const adoptable = useAdoptableSession(authorized && usesPersonaIdentity)
  const adopt = useAdoptSession()

  /**
   * 本人头像 —— 授权后用于设置页的账号行。
   *
   * 取账号里那份而不是重新去渠道拿：`startup.ts` 的 `onAuthorized` 已经
   * 在身份确认后自动取过一次并写进账号了（遵守 manual 优先），所以这里
   * **只是读**。拿不到时传 null，`Avatar` 自己退回首字母。
   */
  const bootstrap = useBootstrapState()
  const selfAvatar = usesPersonaIdentity ? (bootstrap.data?.session?.avatarUrl ?? null) : null

  /**
   * 上一次授权的失败原因。
   *
   * 进度事件里的失败带 i18n key 与原始细节；抛出来的错误走 useErrorText。
   *
   * ## ★★ 已经连上了就**不显示**旧的失败 —— 那是过期状态残留
   *
   * 这两个来源（`progress` 是本地 state，`start.error` 是 mutation 的 error）
   * 都只在**下一次点授权**时才被清（`begin()` 里 `setProgress(null)` +
   * `start.reset()`）。也就是说：授权失败一次之后，即使登录态**后来自己好了**
   * （CLI 懒刷新会就地把 token 刷回来，或者用户在终端里登了一次），
   * 那句红字仍然挂在卡片上，直到用户再点一次授权。
   *
   * 实测踩到的真实形态（2026-08-08 本机）：卡片显示「未连接」+
   * 「授权流程结束但未检测到有效登录态，请重试」，而同一刻拿应用自己的
   * dws-home 跑 `auth status` 是 `authenticated: true, refreshed: true` ——
   * 登录早就好了，只有界面还在报错。用户据此以为坏了、反复点重试。
   *
   * 所以判据加一条 `!accountConnected`：连上了就不再展示历史失败。
   * ★ 用 `accountConnected` 而不是 `authorized`：后者只说明"这台电脑登录过
   * 钉钉"，而这张卡片要回答的是"**这个账号**连好了吗"（见它上方那段）。
   */
  const failure = accountConnected
    ? undefined
    : progress?.phase === "failed"
      ? t(progress.messageKey, { detail: progress.detail ?? "" })
      : start.error !== null
        ? errorText(start.error)
        : undefined

  // 授权进入等待或失败时保持详情可见，避免用户只看到一条静态平台行，
  // 却不知道浏览器是否已打开、授权码在哪里或下一步该做什么。
  useEffect(() => {
    if (running || failure !== undefined) setOnboardingExpanded(true)
  }, [failure, running])

  const begin = (mode: "loopback" | "device") => {
    setProgress(null)
    setBrowserUrl(undefined)
    setScopeAuthorizationUrl(undefined)
    setDeviceCode(undefined)
    start.reset()
    start.mutate({ channelId: channel.id, mode })
  }

  // 未开放的渠道：只展示能力预告，不给任何操作入口
  if (!channel.available) {
    return (
      <Panel className="flex items-center gap-3 opacity-70">
        <ChannelBadge channelId={channel.id} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="typography-body-base-500 text-[var(--text-base-primary)]">
              {t(channel.labelKey)}
            </span>
            <StateTag available={false} state={status.state} />
          </div>
          <p className="typography-caption-400 mt-0.5 text-[var(--text-base-tertiary)]">
            {t(channel.descriptionKey)}
          </p>
        </div>
      </Panel>
    )
  }

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="md" loading={running} onClick={() => begin("loopback")}>
        {/*
          ★ 「重新授权」只在**这个账号**真的连好时才说得通。
          机器级登录态下（authorized 但账号没连）说"重新"是误导 ——
          用户会以为已经连过一次了，而实际上这个账号从没授权。
        */}
        {t(accountConnected ? "actions.reauthorize" : "actions.start")}
      </Button>
      <Tooltip content={t("actions.useCodeHint")} placement="top">
        <Button size="md" variant="secondary" disabled={running} onClick={() => begin("device")}>
          {t("actions.useCode")}
        </Button>
      </Tooltip>
    </div>
  )

  const body = (
    <>
      {authorized ? (
        <AccountBlock
          status={status}
          adoptable={adoptable.data ?? null}
          adopting={adopt.isPending}
          onAdopt={() => adopt.mutate()}
        />
      ) : (
        <div className="flex flex-col gap-0.5">
          <InfoRow
            icon={<ToolsIcon className="size-4" />}
            title={t(`${scopePrefix}.readTitle`)}
            description={t(`${scopePrefix}.readDescription`)}
          />
          <InfoRow
            icon={<ShieldIcon className="size-4" />}
            title={t(`${scopePrefix}.noSpeakTitle`)}
            description={t(`${scopePrefix}.noSpeakDescription`)}
          />
          <InfoRow
            icon={<KeyIcon className="size-4" />}
            title={t(`${scopePrefix}.credentialsTitle`)}
            description={t(`${scopePrefix}.credentialsDescription`)}
          />
        </div>
      )}

      {/*
        ★ 「使用自有 dws」：授权与否**都**显示（仅钉钉，dws 是它的 CLI）。

        这里曾经嵌在上面那个三元的 else 分支里，理由写的是"授权走不通是唯一
        需要换 dws 的时刻"。那个前提在共享登录态下不成立：dws 的 token 按
        **系统用户**存（见 plugins/dingtalk/auth.ts 文件头），所以新注册一个
        应用账号进来**就是**已授权 —— 于是"已连上但想换成闭源版"的人
        看不到任何入口，而那恰恰是内部同学的常规路径，不是异常。

        隐蔽性由组件自己保证（默认折叠 + 平淡标题 + 靠右），不需要再靠
        "在某个状态下整块不渲染"来实现。
      */}
      {channel.id === "dingtalk" ? (
        // 右下角：组件自己 items-end 靠右，这里只给一点上间距
        <div className="mt-1">
          <DwsSourceDisclosure />
        </div>
      ) : null}

      {running ? (
        <ProgressBlock
          deviceCode={deviceCode}
          browserUrl={browserUrl}
          scopeAuthorizationUrl={scopeAuthorizationUrl}
          onCancel={() => cancel.mutate({ channelId: channel.id })}
        />
      ) : null}

      {failure !== undefined && !running ? (
        <p
          role="alert"
          className="typography-body-small-400 radius-md bg-[var(--status-fill-error-container)] px-3 py-2 text-[var(--status-error)]"
        >
          {failure}
        </p>
      ) : null}

      {authorized &&
      status.daysUntilRefreshExpiry !== null &&
      status.daysUntilRefreshExpiry <= REFRESH_EXPIRY_WARNING_DAYS ? (
        <p className="typography-body-small-400 radius-md bg-[var(--status-fill-warning-container)] px-3 py-2 text-[var(--status-warning)]">
          {t("settings.expiryWarning", { days: status.daysUntilRefreshExpiry })}
        </p>
      ) : null}

      {/*
        ★★ 身份错位告警 —— 用 error 而不是 warning。

        它比"凭证快过期"严重：那个是**将来**会失效，而这个是**现在**正在
        按另一个组织的身份读数据（会话列表、采集范围都跟着错）。
        用户授权了 A 却在看 B 的会话，这是越权读取面，必须显眼。

        放在过期提醒之后：两条可能同时出现（错位到的那个 profile 恰好也快过期，
        实测就是这样），而"身份不对"比"快过期"更该先被处理。
      */}
      {identityMismatch === null ? null : (
        <p
          role="alert"
          className="typography-body-small-400 radius-md bg-[var(--status-fill-error-container)] px-3 py-2 text-[var(--status-error)]"
        >
          {t("settings.identityMismatch", {
            channelCorp: identityMismatch.channelCorp,
            boundCorp: identityMismatch.boundCorp,
          })}
        </p>
      )}
    </>
  )

  if (variant === "onboarding") {
    return (
      <Panel pad="sm" className="flex flex-col gap-0 overflow-hidden">
        <div className="flex min-h-16 items-center gap-3">
          <ChannelBadge channelId={channel.id} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="typography-body-base-500 text-[var(--text-base-primary)]">
                {t(
                  accountConnected || identityPending
                    ? "onboarding.connectedTitle"
                    : "onboarding.connectTitle",
                  { channel: t(channel.labelKey) },
                )}
              </h2>
              <StateTag
                available
                state={
                  accountConnected || identityPending
                    ? status.state
                    : status.state === "expired"
                      ? "expired"
                      : "unauthorized"
                }
              />
            </div>
            <div className="typography-caption-400 mt-0.5 flex min-w-0 items-center gap-1 text-[var(--text-base-tertiary)]">
              {accountConnected ? (
                channelNick === null ? (
                  `${status.corpName} · ${status.userName}`
                ) : (
                  `${status.corpName} · ${status.userName}（${channelNick}）`
                )
              ) : identityPending ? (
                <span>{status.corpName}</span>
              ) : authorized && !identityPending ? (
                <>
                  <span className="shrink-0">{status.corpName}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{t("onboarding.machineSessionHint")}</span>
                </>
              ) : (
                t(channel.descriptionKey)
              )}
            </div>
          </div>
          <Button
            size="sm"
            variant={onboardingExpanded ? "secondary" : "primary"}
            aria-expanded={onboardingExpanded}
            onClick={() => setOnboardingExpanded((open) => !open)}
          >
            {t(onboardingExpanded ? "actions.collapse" : "actions.configure")}
          </Button>
        </div>

        {onboardingExpanded ? (
          <div className="flex flex-col gap-[var(--gap-component-md)] border-t border-[var(--border-divider-light)] pt-[var(--gap-component-md)]">
            <div className="flex justify-end">{actions}</div>
            <StepSection
              title={t(accountConnected ? "onboarding.accountTitle" : "onboarding.scopeTitle")}
            >
              {body}
            </StepSection>
          </div>
        ) : null}
      </Panel>
    )
  }

  return (
    <Panel className="flex flex-col gap-[var(--gap-section-sm)]">
      <div className="flex items-center gap-3">
        {/*
          ★ 已授权时这个位置放**本人头像**（渠道图标降为右下角角标），
          未授权时就是渠道图标本身。

          ## 为什么这里该是头像

          这一行回答的是「这个渠道连的是谁」。未授权时没有"谁"，
          渠道图标是唯一能说的事；而授权之后**身份才是主信息** ——
          旁边那行字已经在写 `corpName · userName（花名）`，
          左边却还是一个渠道 logo，于是整行没有任何地方能让人
          一眼确认"连上的是我自己"。

          授权后的账号身份比渠道标识更重要，所以这里让头像成为主图标。

          ## 角标而不是替换

          「某平台的某个人」两个信息都要在,而头像 + 右下角平台角标
          正是 IM 里表达这件事的标准形态。渠道图标消失的话
          多渠道并列时就分不清哪一行是哪个平台了。
        */}
        {/* ★ 头像/身份按**账号连了吗**显示 —— 见 accountConnected 的注释 */}
        {accountConnected ? (
          <span className="relative shrink-0">
            <Avatar size="lg" name={status.userName ?? "?"} src={selfAvatar} />
            {/*
              ★ 这圈 ring 的圆角必须与 `ChannelBadge` **同半径**。

              角标内部是 `radius-md`(8px)，而这里原来写的是 `--radius-sm`(6px)
              —— ring 沿 6px 的轮廓走、里面的图标是 8px，于是四角各露出一小块
              错位的缝隙。在暗色下那缝隙是深的，看起来就是"头像有黑边、没对齐"。

              ring 的颜色取 `--bg-card-z1`：那正是 `Panel` 的 `raised` 底色
              （实色 #262626 / #ffffff），所以这圈描边读起来是"角标把底色顶开了"
              而不是一条灰线。用半透明 token 会透出下面的头像，那才真是脏边。
            */}
            <span className="absolute -bottom-0.5 -right-0.5 radius-md ring-2 ring-[var(--bg-card-z1)]">
              <ChannelBadge channelId={channel.id} size="sm" />
            </span>
          </span>
        ) : (
          <ChannelBadge channelId={channel.id} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="typography-body-base-500 text-[var(--text-base-primary)]">
              {t(channel.labelKey)}
            </span>
            <StateTag available state={status.state} />
          </div>
          <p className="typography-caption-400 mt-0.5 truncate text-[var(--text-base-tertiary)]">
            {accountConnected
              ? // 有渠道昵称（花名）时带上：那才是同事们叫他的名字
                channelNick === null
                ? `${status.corpName} · ${status.userName}`
                : `${status.corpName} · ${status.userName}（${channelNick}）`
              : authorized && !identityPending
                ? // 机器级登录态：不冒充成"你的"身份，说清要为当前账号确认一次
                  t("onboarding.machineSessionHint")
                : status.state === "expired"
                  ? t("settings.expiredHint")
                  : t(channel.descriptionKey)}
          </p>
        </div>
        {actions}
      </div>

      <div className="h-px bg-[var(--border-divider-light)]" />
      {body}
      <SharedCredentialNote channelId={channel.id} />
    </Panel>
  )
}

/**
 * 渠道标识徽标。
 *
 * 官方标识本身就是「满幅底色 + 白色图形」的方形图标，因此**直接铺满**整个方框，
 * 不再套一层边框与白底——那会变成「框里的框」，而且官方蓝底被我们的白底一圈包住
 * 反而更不像它自己。只有字母兜底才需要容器来撑出形状。
 */
function ChannelBadge({
  channelId,
  size = "md",
}: {
  channelId: string
  /** `sm` 是给"叠在头像右下角当角标"用的 */
  size?: "sm" | "md" | "lg"
}) {
  const { t } = useDynamicTranslation("channels")
  const box =
    size === "lg" ? "size-12 radius-xl" : size === "sm" ? "size-5 radius-md" : "size-10 radius-lg"
  const official = BRAND_ICONS[channelId]

  if (official !== undefined) {
    const Icon = official
    // overflow-hidden 让方形标识跟着容器圆角被裁切。
    return (
      <div className={cn("shrink-0 overflow-hidden", box)}>
        <Icon className="size-full" />
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center border border-[var(--border-light)] bg-[var(--bg-card-z1)]",
        box,
      )}
    >
      {/*
        没有官方标识时用渠道名首字兜底。取自译文而不是写死「飞」：
        英文界面下会得到 "L"(ark)，不会突然冒出一个汉字。
      */}
      <span className="typography-body-base-500 text-[var(--text-base-tertiary)]">
        {[...t(`${channelId}.label`)][0] ?? "?"}
      </span>
    </div>
  )
}

function StateTag({ available, state }: { available: boolean; state: AuthStatus["state"] }) {
  const { t } = useDynamicTranslation("channels")
  return (
    <span
      className={cn(
        "typography-caption-400 radius-sm px-1.5 py-0.5",
        available ? STATE_STYLE[state] : "bg-[var(--bg-card-z0)] text-[var(--text-base-tertiary)]",
      )}
    >
      {available ? t(STATE_LABEL_KEY[state]) : t("state.unavailable")}
    </span>
  )
}

/**
 * 已连接账号的详情块（填充块 + 状态圆点）。
 *
 * `adoptable` 非 null = 渠道说已授权，但**这个应用账号**还没有身份行 ——
 * 那份登录态是本机上别处（另一个账号、或用户自己的终端）建立的。
 * 见下面那段的注释：为什么给按钮而不是自动采纳。
 */
function AccountBlock({
  status,
  adoptable = null,
  adopting = false,
  onAdopt,
}: {
  status: Extract<AuthStatus, { state: "authorized" }>
  adoptable?: { corpName: string; userName: string } | null
  adopting?: boolean
  onAdopt?: () => void
}) {
  const { t } = useDynamicTranslation("channels")
  return (
    <div className="flex flex-col gap-1.5 radius-md bg-[var(--bg-card-z0)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-[var(--status-success)]" />
        <span className="typography-body-small-400 truncate text-[var(--text-base-primary)]">
          {status.corpName}
        </span>
      </div>
      <dl className="flex flex-col gap-0.5 pl-4">
        <Field
          label={t("account.user")}
          value={t("account.userValue", { name: status.userName, id: status.userId })}
        />
        <Field label={t("account.accessExpiresAt")} value={formatTime(status.accessExpiresAt)} />
        <Field label={t("account.refreshExpiresAt")} value={formatTime(status.refreshExpiresAt)} />
      </dl>
      {/*
        ★ 这份登录态**不是这个账号建立的** —— 说清，并给一个显式选择。

        dws 的 token 按系统用户存（见 plugins/dingtalk/auth.ts 文件头），
        所以新注册一个应用账号进来就直接是"已连接"，而上面那些字段
        （组织、账号、有效期）看起来完全像是这个账号自己的属性。

        ★★ 为什么是按钮而不是自动采纳：自动会**替用户选定身份**，而他之后
        真去授权换另一个组织时反被身份守卫拦住（SELF_IDENTITY_CONFLICT）——
        那个冲突是自动补跑自己制造的。而且用户可能压根还没决定要不要用这个
        渠道（比如想先填自有 dws 路径再授权）。所以：写明是哪个组织、哪个人，
        让他自己点。

        措辞不提 Keychain / token 这些内部概念：用户需要知道的是
        "这是本机已有的登录态，要不要用它"。
      */}
      {adoptable === null ? null : (
        <div className="mt-1 flex flex-col gap-1.5 pl-4">
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("account.adoptableHint", {
              corp: adoptable.corpName,
              name: adoptable.userName,
            })}
          </p>
          <div>
            <Button size="sm" variant="secondary" loading={adopting} onClick={onAdopt}>
              {t("account.adoptAction")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="typography-caption-400 flex items-center gap-1.5">
      <dt className="text-[var(--text-base-tertiary)]">{label}</dt>
      <dd className="min-w-0 truncate text-[var(--text-base-secondary)]">{value}</dd>
    </div>
  )
}

function InfoRow({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex gap-3 py-2">
      <span className="flex size-8 shrink-0 items-center justify-center radius-md bg-[var(--bg-card-z0)] text-[var(--text-base-secondary)]">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
          {title}
        </p>
        <p className="typography-caption-400 mt-0.5 leading-relaxed text-[var(--text-base-tertiary)]">
          {description}
        </p>
      </div>
    </div>
  )
}

function ProgressBlock({
  deviceCode,
  browserUrl,
  scopeAuthorizationUrl,
  onCancel,
}: {
  deviceCode: Extract<AuthProgress, { phase: "device-code" }> | undefined
  browserUrl: string | undefined
  scopeAuthorizationUrl: string | undefined
  onCancel: () => void
}) {
  const { t } = useDynamicTranslation("channels")
  const { t: tc } = useDynamicTranslation()
  const showingScopeAuthorization = scopeAuthorizationUrl !== undefined
  const showingDeviceCode = !showingScopeAuthorization && deviceCode !== undefined
  const manualUrl = scopeAuthorizationUrl ?? browserUrl
  return (
    <div className="flex flex-col gap-2 radius-md border border-[var(--border-light)] bg-[var(--bg-card-z0)] p-3">
      <div className="flex items-center gap-2">
        <SpinnerIcon className="size-4 animate-spin text-[var(--text-accent-normal)]" />
        <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
          {t(
            showingScopeAuthorization
              ? "progress.scopeAuthorization"
              : showingDeviceCode
                ? "progress.enterCode"
                : "progress.browserOpened",
          )}
        </span>
      </div>

      {showingDeviceCode ? (
        <>
          <code
            className="typography-title-base-600 select-all text-center font-mono-token tracking-[0.2em] text-[var(--text-base-primary)]"
            style={{ color: DINGTALK_BRAND }}
          >
            {deviceCode.userCode}
          </code>
          <p className="typography-caption-400 break-all text-[var(--status-link)]">
            {deviceCode.verifyUrl}
          </p>
        </>
      ) : null}

      {manualUrl !== undefined ? (
        <p className="typography-caption-400 break-all text-[var(--text-base-tertiary)]">
          {t("progress.manualUrl", { url: manualUrl })}
        </p>
      ) : null}

      <div>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          {tc("actions.cancel")}
        </Button>
      </div>
    </div>
  )
}

/**
 * 登录态共享说明。
 *
 * 实测确认：token 的加密密钥在系统钥匙串里按系统用户存一份，
 * 应用与用户终端里的 dws 是同一份登录态，无法隔离。
 * 因此不提供「退出授权」按钮——那会连带清掉用户终端的登录态。
 */
function SharedCredentialNote({ channelId }: { channelId: string }) {
  /**
   * 用 Trans 而不是 t()：文案里要嵌一个 <code> 标签。
   * 命令名作为插值参数传进去，而不是把句子拆成前后两半再拼——
   * 拼接假设了「命令在句中的位置」，而中英文的语序恰好不同。
   */
  return (
    <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
      <Trans
        ns="channels"
        i18nKey={
          channelId === "feishu" ? "settings.feishuCredentialNote" : "settings.sharedCredentialNote"
        }
        values={{
          command: channelId === "feishu" ? "lark-cli auth logout --json" : "dws auth logout",
        }}
        components={{ 1: <code className="font-mono-token" /> }}
      />
    </p>
  )
}
