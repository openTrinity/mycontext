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
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface SearchViewProps {
  /** 展示用的用户名（当前是 email 前缀） */
  userName: string
  /** 提交一个新查询：由上层建会话并切到会话视图 */
  onSubmit: (query: string) => void
  disabled?: boolean
  /** Agent 运行时缺失时的降级提示（不静默降质） */
  degradedNotice?: string | null
}

export function SearchView({
  userName,
  onSubmit,
  disabled = false,
  degradedNotice,
}: SearchViewProps) {
  const { t } = useDynamicTranslation("search")
  const [draft, setDraft] = useState("")

  // 问候语按小时分段。用 useMemo 只是为了避免每次渲染都取一次系统时间 ——
  // 跨过整点不会自动刷新，而那不值得为它加一个定时器。
  const greetingKey = useMemo(() => greetingKeyForHour(new Date().getHours()), [])

  const submit = (): void => {
    const query = draft.trim()
    if (query === "") return
    onSubmit(query)
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
      />

      {degradedNotice !== null && degradedNotice !== undefined && (
        <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
          {degradedNotice}
        </p>
      )}
    </div>
  )
}
