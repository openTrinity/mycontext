/**
 * SearchView — 搜索模块的首屏（无会话时）。
 *
 * 结构就是需求要的那两块：**上面欢迎词 + 下面输入框**，别的都不要。
 *
 * 用户名取本地账号 email 的前缀 —— 接入统一登录后换成真名，
 * 组件签名不用改（它只接一个 `userName`）。
 */
import { Composer, GreetingName, WelcomeHeader, greetingKeyForHour } from "@mycontext/design"
import { useMemo, useState } from "react"
import { ChannelPicker } from "../shell/channel-picker.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

/** 一个可选的检索档位。`id` 是 `graph_scope` 存的值。 */
export interface SearchScopeOption {
  id: string
  label: string
}

export interface SearchViewProps {
  /** 展示用的用户名（当前是 email 前缀） */
  userName: string
  /** 提交一个新查询：由上层建会话并切到会话视图。`scope` = 选中的档位 */
  onSubmit: (query: string, scope: string) => void
  disabled?: boolean
  /** Agent 运行时缺失时的降级提示（不静默降质） */
  degradedNotice?: string | null
  /**
   * 可选的检索档位。
   *
   * ## ★ 只列**已授权**的渠道
   *
   * 档位与 kl 启动是解耦的（起哪些 kl 看连了哪些渠道），所以让用户选一个
   * "没连那个渠道"的档位，结果是那个端口上没有 kl → 连接失败 → 静默降级
   * 到本地召回。选项本身就不该出现。
   *
   * 少于两项时**不渲染选择器**：只有一个档位可选时那个控件是纯噪音
   * （而且会让用户以为还有别的选择）。
   */
  scopes?: readonly SearchScopeOption[]
}

export function SearchView({
  userName,
  onSubmit,
  disabled = false,
  degradedNotice,
  scopes = [],
}: SearchViewProps) {
  const { t } = useDynamicTranslation("search")
  const [draft, setDraft] = useState("")
  /**
   * 选中的档位。缺省取**第一项** —— 上层把主渠道排在最前，
   * 于是"不动这个控件"就是现有行为。
   */
  const [scope, setScope] = useState<string | null>(null)
  const activeScope = scope ?? scopes[0]?.id ?? ""

  // 问候语按小时分段。用 useMemo 只是为了避免每次渲染都取一次系统时间 ——
  // 跨过整点不会自动刷新，而那不值得为它加一个定时器。
  const greetingKey = useMemo(() => greetingKeyForHour(new Date().getHours()), [])

  const submit = (): void => {
    const query = draft.trim()
    if (query === "") return
    onSubmit(query, activeScope)
    setDraft("")
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[var(--gap-section-lg)] px-6 pt-[12vh]">
      <WelcomeHeader
        title={`${t(greetingKey)}${t("welcome.separator")}`}
        description={t("welcome.description")}
      >
        <GreetingName name={userName} />
      </WelcomeHeader>

      <Composer
        variant="hero"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        disabled={disabled}
        placeholder={t("composer.placeholder")}
        attachLabel={t("composer.attach")}
        sendLabel={t("composer.send")}
        stopLabel={t("composer.stop")}
        /**
         * ★★ 检索范围放**输入框内的底部工具条**（与发送按钮同一行），
         * 而不是浮在输入框上方。
         *
         * 上一版在上方独占一行，读起来像"页面的一个设置"；而它其实是
         * **这一次提问的参数** —— 与"发送"同属一个动作。放进输入框之后，
         * "我在问什么范围 → 我按发送"在视线上是连着的一件事，
         * 这也是多数 AI 产品把模型/工具选择器放在输入框里的理由。
         *
         * `toolbarExtra` 是 `Composer` 已有的槽（左侧，附件按钮旁），
         * 所以不用改设计系统。
         */
        toolbarExtra={
          <ChannelPicker
            options={scopes.map((option) => ({ id: option.id, label: option.label }))}
            activeId={activeScope}
            onChange={setScope}
            ariaLabel={t("scope.label")}
            prefix={t("scope.label")}
          />
        }
      />

      {degradedNotice !== null && degradedNotice !== undefined && (
        <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
          {degradedNotice}
        </p>
      )}
    </div>
  )
}
