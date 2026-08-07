/**
 * 「清空当前渠道的数据」的确认框。
 *
 * ## ★★ 为什么这个必须有确认，而原来那个按钮没有
 *
 * 它替换掉的「重置蒸馏水位」**不删任何数据**（只清水位让它重蒸一遍），
 * 点错了最多白跑一轮。而这个按钮删的是**真实聊天记录** —— 几万条消息、
 * 索引、图谱、下载的媒体，全部不可逆。所以：
 *
 * · **先预演再问** —— 打开时先跑一次 `dryRun`，把真实条数摆出来。
 *   写死一句"将删除全部数据"是不够的：用户无法判断"全部"是 3 条还是 8 万条，
 *   而那个数量级恰好决定他要不要停手；
 * · **列出保留什么** —— 这是这个动作最容易被误解的地方。不写清的话
 *   用户会以为要重新扫码授权、重新勾一遍会话，于是不敢点；
 * · **默认焦点在「取消」** —— 与退出确认框相反（那里默认焦点在"退出"，
 *   因为按 ⌘Q 的意图就是退出）。这里误触的代价是不可逆的数据损失，
 *   所以默认落在安全的一侧。
 *
 * ## 为什么走渲染层画而不是 `dialog.showMessageBox`
 *
 * 与 `QuitConfirmDialog` 同一个理由（见那个文件的头）：原生框永远长得像
 * 另一个程序。这里还多一条 —— 我们要在框里显示预演出来的表格，
 * 原生框只能放纯文本。
 */
import { useEffect, useId, useRef } from "react"
import { Button, Dialog } from "@mycontext/design"
import type { ChannelDataWipeResult } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface ChannelDataWipeDialogProps {
  open: boolean
  /** 预演结果。null = 还在跑（或跑失败了） */
  preview: ChannelDataWipeResult | null
  /** 预演还在跑 */
  loading: boolean
  /** 正在真删 */
  wiping: boolean
  /** 预演或清空的错误文案；null = 没有 */
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

export function ChannelDataWipeDialog({
  open,
  preview,
  loading,
  wiping,
  error,
  onCancel,
  onConfirm,
}: ChannelDataWipeDialogProps) {
  const { t } = useDynamicTranslation("settings")
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)

  /*
   * 「取消」拿默认焦点（见文件头第三条）。
   *
   * 与 `QuitConfirmDialog` 一样要等一帧：`<Dialog>` 的 `showModal()` 在它
   * 自己的 effect 里跑，而原生 dialog 打开时会把焦点移到内部第一个可聚焦
   * 元素上 —— 要在那之后才抢。
   */
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => cancelRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <Dialog open={open} onClose={onCancel} labelledBy={titleId} className="radius-xl">
      <div
        className="flex flex-col gap-4 radius-xl border border-[var(--border-light)] bg-[var(--bg-base-normal)] p-5 shadow-[var(--shadow-lg)]"
        style={{ width: "min(460px, calc(100vw - 64px))" }}
      >
        <div className="flex items-start gap-3">
          {/*
            这里用**危险红**而不是警示黄（退出框用的是黄）：那个是"你要中断
            一些工作"，这个是"你要永久删掉几万条聊天记录"。
          */}
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--status-fill-error-container)] text-[var(--status-error)]"
          >
            <svg viewBox="0 0 20 20" fill="none" className="size-5">
              <path d="M10 6.5v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="10" cy="13.8" r="0.9" fill="currentColor" />
              <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </span>
          <div className="flex min-w-0 flex-col gap-1 pt-0.5">
            <h2 id={titleId} className="typography-body-large-700 text-[var(--text-base-primary)]">
              {t("dataWipe.confirmTitle")}
            </h2>
            <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("dataWipe.confirmDetail")}
            </p>
          </div>
        </div>

        {/*
          预演结果。三态都要能区分：正在数 / 数出来了 / 数失败了。
          少了第一态的话框会先显示"0 条"再跳成真实值 —— 那个 0 会让人
          以为没数据可删而放心点下去。
        */}
        <div className="flex flex-col gap-2 radius-md bg-[var(--bg-card-z0)] px-3 py-2.5">
          {loading ? (
            <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
              {t("dataWipe.counting")}
            </p>
          ) : preview === null ? (
            <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
              {t("dataWipe.countFailed")}
            </p>
          ) : (
            <>
              <p className="typography-body-small-400 text-[var(--text-base-primary)]">
                {t("dataWipe.willDelete", { rows: preview.rows })}
              </p>
              {/*
                逐表明细只列前几张（按行数降序）。全列出来会是二十多行，
                而用户要的是"量级对不对"，不是一张完整的表清单。
              */}
              {preview.byTable.length === 0 ? null : (
                <ul className="flex flex-col gap-0.5">
                  {preview.byTable.slice(0, 5).map((row) => (
                    <li
                      key={row.table}
                      className="typography-caption-400 flex items-baseline justify-between gap-3 text-[var(--text-base-tertiary)]"
                    >
                      <span className="truncate">{row.table}</span>
                      <span className="shrink-0 tabular-nums">{row.rows}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/*
          ★ 保留清单 —— 这一段是这个框里最重要的信息之一（见文件头第二条）。
          不写清的话用户会以为要重新授权、重新勾会话，于是根本不敢点。
        */}
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("dataWipe.keeps")}
        </p>

        {error === null ? null : (
          <p className="typography-body-small-400 text-[var(--status-error)]">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            ref={cancelRef}
            size="md"
            variant="secondary"
            onClick={onCancel}
            disabled={wiping}
          >
            {t("dataWipe.cancel")}
          </Button>
          {/*
            danger 变体 + loading：真删要几秒（VACUUM + 删目录 + 重挂服务），
            期间必须看得出在做事，否则用户会重复点。
          */}
          <Button
            size="md"
            variant="danger"
            loading={wiping}
            disabled={wiping || loading}
            onClick={onConfirm}
          >
            {t("dataWipe.confirmAction")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
