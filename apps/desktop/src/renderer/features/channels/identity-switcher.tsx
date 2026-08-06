/**
 * 身份切换器 —— 一个账号下的多个渠道身份，各自一份独立的数据。
 *
 * ## ★ 为什么需要它（这修的是截图那条红字的另一半）
 *
 * 隔离维度是 `(channelId, corpId, userId)`：同一个人在两家企业下是**两个
 * 身份**（`userId` 只在企业内唯一），各自一个 vault。授权到一个新身份时
 * 主进程会自动路由过去，但"回到上一个身份"必须有个显式入口 ——
 * 没有的话用户只能靠再授权一次，而那要重新扫码。
 *
 * ## ★★ 切换是个**重动作**，界面必须说出来
 *
 * 切一次要卸掉整套（停采集、卸 agent、停图谱服务）再挂新的，而图谱要重付
 * 一次 warmup（实测冷启约 90s）。不明示的话用户会在那 90 秒里看到一个空
 * 图谱面板 —— 而"图谱空了"与"图谱正在准备"在界面上长得一样，
 * 那正是本项目最怕的那类静默降级。
 *
 * 只有一个身份时**整块不渲染**：那时"切换"这个概念不存在，
 * 摆一个只有一项的列表只会让人以为漏了什么。
 */
import { Avatar, Button, Panel, cn } from "@mycontext/design"
import type { ChannelIdentity } from "@mycontext/ipc-contract"
import { useChannelIdentities, useSwitchChannelIdentity } from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"

export interface IdentitySwitcherProps {
  /** 只在已登录时查（未登录时主进程给空数组，但白跑一次 IPC 没必要） */
  enabled?: boolean
}

export function IdentitySwitcher({ enabled = true }: IdentitySwitcherProps) {
  const identities = useChannelIdentities(enabled)
  const switchTo = useSwitchChannelIdentity()
  const errorText = useErrorText()

  const rows = identities.data ?? []
  /**
   * ★ 少于两个就不渲染。
   *
   * 一个身份时"切换"没有意义；零个时（还没授权过）更不该出现 ——
   * 那时用户要看到的是授权入口，不是一个空列表。
   */
  if (rows.length < 2) return null

  return (
    <Panel className="flex flex-col gap-[var(--gap-section-sm)]">
      <div className="flex flex-col gap-0.5">
        <span className="typography-body-base-500 text-[var(--text-base-primary)]">你的身份</span>
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          每个身份有自己独立的一份数据（会话、画像、图谱都不互通）。切换后要
          重新准备图谱，需要一两分钟。
        </p>
      </div>

      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <IdentityRow
            key={`${row.channelId}:${row.corpId}:${row.userId}`}
            identity={row}
            switching={switchTo.isPending}
            onSwitch={() =>
              switchTo.mutate({
                channelId: row.channelId,
                corpId: row.corpId,
                userId: row.userId,
              })
            }
          />
        ))}
      </ul>

      {/*
        ★ 切换中的提示放在列表**下方**且一直显示到 settle。
        它解释的是"为什么现在图谱是空的" —— 那句话必须在用户看到空图谱的
        同一屏上，否则他会去别处找原因。
      */}
      {switchTo.isPending ? (
        <p className="typography-body-small-400 radius-md bg-[var(--status-fill-warning-container)] px-3 py-2 text-[var(--status-warning)]">
          正在切换身份：停掉当前身份的采集与图谱服务，再挂载新的。图谱需要重新
          准备（一两分钟），期间图谱面板会是空的 —— 那不是数据丢了。
        </p>
      ) : null}

      {switchTo.error !== null ? (
        <p
          role="alert"
          className="typography-body-small-400 radius-md bg-[var(--status-fill-error-container)] px-3 py-2 text-[var(--status-error)]"
        >
          {errorText(switchTo.error)}
        </p>
      ) : null}
    </Panel>
  )
}

function IdentityRow({
  identity,
  switching,
  onSwitch,
}: {
  identity: ChannelIdentity
  switching: boolean
  onSwitch: () => void
}) {
  /**
   * 显示名：组织 · 真名。两者都可能为空（绑定时渠道没给），
   * 那时退到 ID 的前几位 —— 比一个空行强，而且用户能拿它对上日志。
   */
  const corp = identity.corpName ?? `${identity.corpId.slice(0, 10)}…`
  const user = identity.userName ?? `${identity.userId.slice(0, 6)}…`
  /**
   * ★★ 「来源应用」标记 —— 没有它这一屏会出现**两行一模一样**的条目。
   *
   * 实测：同一台机器上两个来源的渠道 CLI（随包的开源版、用户自备的
   * 闭源版）返回的 `corp_id`/`user_id` 完全相同，于是组织名与花名也相同。
   * 隔离键靠 `channelId` 上的来源后缀把它们分开（见 `source-key.ts`），
   * 但那个后缀**不显示**的话，用户看到的是两个无法区分的"某组织 · 某某"，
   * 而点哪一个的后果不同（各自是一份独立的数据）。
   *
   * ★ 只显示"自备"这一档，内置那份不加标记：绝大多数用户只有内置一个来源，
   * 给它挂个"内置"徽章是纯噪音。有第二个来源时才需要区分。
   *
   * ★ **不显示 hash 本身**：它由本机绝对路径算出来，虽然不可逆，
   * 但一串 `src-3f2a1b8c` 对用户没有意义，而"自备"这个词有。
   */
  const custom = identity.channelId.includes("@")

  return (
    <li
      className={cn(
        "flex items-center gap-3 radius-md px-3 py-2.5",
        identity.active ? "bg-[var(--status-fill-success-container)]" : "bg-[var(--bg-card-z0)]",
      )}
    >
      <Avatar size="md" name={user} src={null} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="typography-body-small-400 truncate text-[var(--text-base-primary)]">
            {corp}
          </span>
          {identity.active ? (
            <span className="typography-caption-400 radius-sm bg-[var(--status-fill-success-container)] px-1.5 py-0.5 text-[var(--status-success)]">
              当前
            </span>
          ) : null}
          {custom ? (
            <span className="typography-caption-400 radius-sm bg-[var(--bg-card-z1)] px-1.5 py-0.5 text-[var(--text-base-tertiary)]">
              自备客户端
            </span>
          ) : null}
        </div>
        <p className="typography-caption-400 mt-0.5 truncate text-[var(--text-base-tertiary)]">
          {user}
        </p>
      </div>
      {/*
        ★ 当前那个不给按钮（而不是给一个禁用的）：禁用按钮读起来像
        "这个操作暂时不可用"，而事实是"你已经在这儿了"。
      */}
      {identity.active ? null : (
        <Button size="sm" variant="secondary" disabled={switching} onClick={onSwitch}>
          切换
        </Button>
      )}
    </li>
  )
}
