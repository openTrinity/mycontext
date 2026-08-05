/**
 * 本地图片上传。
 *
 * ## ★ 为什么读成 base64 再走 IPC
 *
 * 渲染层拿到的 `File` 只有一个沙箱内引用 —— Electron 21+ 起
 * `File.path` 已移除，所以拿不到真实路径。而即便拿得到，也不该让
 * 渲染层直接往 userData 写：那等于把"任意写文件"交给了可能被 XSS 的那层。
 *
 * 所以：这里读字节 → base64 → 主进程校验（**按魔术字节**判类型）+ 落盘。
 *
 * ## 大小在**这一层**先拦一次
 *
 * 主进程有 4MB 上限，但那是最后一道。在这里先拦是为了给一句人话的错误
 * ——「这张图太大」比 IPC 抛一个校验失败要好懂得多。而且 4MB 的图
 * 转 base64 是 5.5MB 字符串，白跑一趟没必要。
 */
import { useRef, useState } from "react"
import { Button } from "@mycontext/design"
import { useUploadImage } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

/** 与主进程一致的上限。图片头像不需要更大。 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export interface ImagePickerProps {
  purpose: "figure" | "avatar"
  /** 选好并上传成功后拿到本地路径 */
  onPicked: (path: string) => void
  label: string
  disabled?: boolean
}

export function ImagePicker({ purpose, onPicked, label, disabled = false }: ImagePickerProps) {
  const { t } = useDynamicTranslation("common")
  const inputRef = useRef<HTMLInputElement>(null)
  const upload = useUploadImage()
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File): Promise<void> {
    setError(null)
    if (file.size > MAX_IMAGE_BYTES) {
      setError(t("imagePicker.tooLarge"))
      return
    }
    /**
     * `arrayBuffer()` 而不是 `FileReader`：前者是 promise，后者是回调 +
     * 事件，而在回调里 setState 会遇到"组件已卸载"的竞态。
     */
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    /**
     * 手写 base64 而不是 `btoa(String.fromCharCode(...bytes))`。
     *
     * 后者在几 MB 的数组上会**爆栈**（spread 把每个字节变成一个实参，
     * 而 V8 的实参上限是十万量级）。分块处理，每块 8KB。
     */
    let binary = ""
    const CHUNK = 8192
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
    }
    try {
      const saved = await upload.mutateAsync({ base64: btoa(binary), purpose })
      onPicked(saved.path)
    } catch {
      // 主进程那边认不出格式时会拒 —— 给一句人话而不是原始错误
      setError(t("imagePicker.rejected"))
    }
  }

  return (
    <span className="flex flex-col gap-1">
      <input
        ref={inputRef}
        type="file"
        // 只列出主进程认得的那几种（它按魔术字节校验，这里只是过滤选择器）
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // 清空 value：不清的话选同一个文件第二次不会触发 change
          event.target.value = ""
          if (file !== undefined) void handleFile(file)
        }}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || upload.isPending}
        onClick={() => inputRef.current?.click()}
      >
        {upload.isPending ? t("imagePicker.uploading") : label}
      </Button>
      {error === null ? null : (
        <span className="typography-caption-400 text-[var(--status-error)]">{error}</span>
      )}
    </span>
  )
}
