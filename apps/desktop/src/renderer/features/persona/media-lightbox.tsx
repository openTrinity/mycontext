/**
 * MediaLightbox —— 点开一张聊天图片看大图，并可另存到本地。
 *
 * ## 为什么必须有
 *
 * 消息气泡里的缩略图上限 240px 高（那是对的 —— 一张竖图不该把整个气泡
 * 顶到一屏）。但那也意味着**看不清**：截图里的报错、白板照片上的字，
 * 在 240px 里全是马赏克。而这一页的用途是"判断这条消息在说什么、
 * 数字人该怎么回" —— 看不清图就等于少了一半上下文，用户只能回钉钉里找。
 *
 * ## 复用 `Dialog`（原生 `<dialog>`）而不是自己搭遮罩
 *
 * 它免费给到三件很难自己做对的事：top layer（不受祖先 overflow/z-index
 * 影响 —— 而消息流恰好在一个 `overflow-y-auto` 容器里）、焦点陷阱、
 * inert 背景。见 `packages/design/src/components/dialog.tsx` 的文件头。
 *
 * ## ★ 「下载」走主进程的系统对话框，不是 `<a download>`
 *
 * `<a download>` 在 `mycontext-file://` 上不工作（自定义协议不参与
 * Chromium 的下载栈），而且它会把"存到哪"这个决定留给浏览器的默认目录。
 * 走 `media.saveAs` 拿到真正的「另存为」对话框，而且**只传 mediaId** ——
 * 渲染层不参与"从哪读"（见那个 IPC 的注释）。
 */
import { useState } from "react"
import { Button, Dialog } from "@mycontext/design"
import type { MessageMediaView } from "@mycontext/ipc-contract"
import { useSaveMediaAs } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface MediaLightboxProps {
  /** 要看的那张图。`path` 必须非空（未下载的不该走到这里） */
  asset: MessageMediaView
  open: boolean
  onClose: () => void
}

export function MediaLightbox({ asset, open, onClose }: MediaLightboxProps) {
  const { t } = useDynamicTranslation("persona")
  const saveAs = useSaveMediaAs()
  /**
   * 保存结果只在弹窗里提示一下，不做全局 toast。
   *
   * `null` = 还没存过。用户取消时也要有反馈（"已取消"）——
   * 什么都不显示会让人以为按钮没响应。
   */
  const [note, setNote] = useState<string | null>(null)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      // 图片自己撑开尺寸，容器不给固定宽高（横图与竖图差别很大）
      className="max-w-[92vw] bg-[var(--bg-card-z1)] p-0"
    >
      <div className="flex max-h-[92vh] flex-col">
        {/*
          图在上、操作在下：用户打开它是为了看图，
          把工具条放在顶部会让图往下挤一截。
        */}
        <img
          src={asset.path ?? ""}
          alt={asset.originalName ?? t("mediaImage")}
          className="max-h-[80vh] max-w-[92vw] object-contain"
        />
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border-divider-light)] px-3 py-2">
          {/* 文件名可截：渠道给的名字可能很长，而它不该把按钮挤出去 */}
          <span className="typography-caption-400 min-w-0 flex-1 truncate text-[var(--text-base-secondary)]">
            {asset.originalName ?? t("mediaImage")}
          </span>
          {note === null ? null : (
            <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
              {note}
            </span>
          )}
          <Button
            size="sm"
            disabled={saveAs.isPending}
            onClick={() => {
              setNote(null)
              saveAs.mutate(
                { mediaId: asset.id },
                {
                  // 用户点「取消」不是错误 —— 但也要给一句反馈
                  onSuccess: (result) => {
                    setNote(result.saved ? t("mediaSaved") : t("mediaSaveCanceled"))
                  },
                  onError: () => {
                    setNote(t("mediaSaveFailed"))
                  },
                },
              )
            }}
          >
            {t("mediaSaveAs")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("mediaClose")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
