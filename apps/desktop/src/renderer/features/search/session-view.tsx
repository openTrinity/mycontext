/**
 * SessionView — 有会话时的视图：事件流 + 底部输入框。
 *
 * 与首屏（SearchView）的区别只有布局：这里输入框固定在底部、
 * 上方是可滚动的事件流。刻意不复用同一个组件 ——
 * 两者的滚动与高度约束完全不同，硬合会得到一堆 `variant` 分支。
 */
import { Composer } from "@mycontext/design"
import { useEffect, useRef, useState } from "react"
import type { ChatItem } from "@mycontext/agent-runtime"
import { EventStream } from "../agent-stream/event-stream.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface SessionViewProps {
  items: readonly ChatItem[]
  onSubmit: (query: string) => void
  onStop?: () => void
  /** 正在生成：禁用发送并显示停止按钮 */
  busy?: boolean
  disabled?: boolean
  onCitationClick?: ((ordinal: number) => void) | undefined
  degradedNotice?: string | null
}

export function SessionView({
  items,
  onSubmit,
  onStop,
  busy = false,
  disabled = false,
  onCitationClick,
  degradedNotice,
}: SessionViewProps) {
  const { t } = useDynamicTranslation("search")
  const [draft, setDraft] = useState("")
  const bottomRef = useRef<HTMLDivElement | null>(null)

  /**
   * 新内容到达时滚到底。
   *
   * 只在**条数变化**时滚，不在流式追加时每个字符都滚 ——
   * 后者会让用户想往上翻看历史时被不断拽回底部。
   */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [items.length])

  const submit = (): void => {
    const query = draft.trim()
    if (query === "") return
    onSubmit(query)
    setDraft("")
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 py-6">
          <EventStream
            items={items}
            busy={busy}
            {...(onCitationClick ? { onCitationClick } : {})}
          />
          <div ref={bottomRef} />
        </div>
      </div>

      {/*
        输入区。底色走 `--bg-base-material`（半透明）+ backdrop-blur：
        事件流滚到底时最后一行会从输入区下面透出来，比实底"切断"更自然。

        ★ 原来写的是 `bg-[var(--bg-base)]` —— **这个 token 不存在**
        （语义层只有 `--bg-base-normal` / `--bg-base-material`）。
        无效的 var() 不报错、只是不生效，所以它一直是透明的：
        滚动内容会直接压在输入框背后。
      */}
      <div className="shrink-0 border-t border-[var(--border-divider-light)] bg-[var(--bg-base-material)] backdrop-blur-md">
        <div className="mx-auto w-full max-w-[720px] px-6 py-4">
          {degradedNotice !== null && degradedNotice !== undefined && (
            <p className="typography-caption-400 mb-2 text-[var(--text-base-tertiary)]">
              {degradedNotice}
            </p>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            busy={busy}
            disabled={disabled}
            {...(onStop ? { onStop } : {})}
            placeholder={t("composer.placeholder")}
            attachLabel={t("composer.attach")}
            sendLabel={t("composer.send")}
            stopLabel={t("composer.stop")}
          />
        </div>
      </div>
    </div>
  )
}
