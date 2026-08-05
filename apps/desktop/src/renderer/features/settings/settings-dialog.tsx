/**
 * SettingsDialog — 设置弹窗。
 *
 * ## 为什么设置是弹窗而不是侧栏里的一个页面
 *
 * 设置是**离开当前任务去调一个参数、然后回到原处**的动作。
 * 做成侧栏页面会把它变成"第四个模块"：占一格导航、点进去当前的搜索/状态
 * 上下文被替换掉，改完还要自己点回去。弹窗保留背景上下文，Esc 就回来了。
 *
 * （侧栏里那一格现在给了「运行状态」—— 那个才是要长时间看着的东西。）
 *
 * ## 布局对齐参考实现
 *
 * 960×680、**左右双栏**（不是"上标题栏 + 下双栏"）：
 * · 左 240px 导航列吃 sidebar 底色，标题「设置」在它的顶部；
 * · 右内容区独立滚动，关闭按钮浮在它的右上角。
 *
 * ★ 标题放在**左列**而不是横跨整宽的 header —— 这是与首版最大的差别。
 * 横跨的 header 会把弹窗切成"上下两块"，而导航列的底色只能从 header 下方开始，
 * 于是左上角出现一个与谁都不对齐的色块。标题跟着导航列走就没有这个问题。
 *
 * 尺寸用 `min(..., 100vw - 边距)`：小屏（13" 或分屏）下固定 960
 * 会让弹窗超出视口，而超出的那部分**没有滚动条可以够到**。
 */
import { Dialog, IconButton, Tooltip } from "@mycontext/design"
import { useId } from "react"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { CloseIcon } from "../shell/icons.js"
import { SettingsView } from "./settings-view.js"

export interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const { t } = useDynamicTranslation("settings")
  const { t: tc } = useDynamicTranslation()
  const titleId = useId()

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      // 容器只做圆角裁剪；底色/边框/阴影全在内层
      // （写在 <dialog> 上的 bg-* 会与它自己的 reset 类撞特异性，见 Dialog 的注释）
      className="radius-xl"
    >
      <div
        className={[
          // ★ flex-row：左右双栏，标题在左列内部（见文件头）
          "relative flex overflow-hidden radius-xl",
          "border border-[var(--border-light)] bg-[var(--bg-base-normal)] shadow-[var(--shadow-lg)]",
        ].join(" ")}
        style={{
          // 边距留 96px（两侧各 48）：弹窗与视口边缘留出明显间距，
          // 让背景的压暗层可见 —— 那是"这是个浮层"的主要视觉线索。
          width: "min(960px, calc(100vw - 96px))",
          height: "min(680px, calc(100vh - 96px))",
        }}
      >
        {/*
          内容复用 SettingsView —— 它本来就是「左导航 + 右内容」的双栏结构，
          标题由它的 `title` 插槽渲染进左列顶部。
          在弹窗里重写一遍只会得到两份会各自漂移的设置界面。
        */}
        <SettingsView
          title={
            <h2 id={titleId} className="typography-body-large-700 text-[var(--text-base-primary)]">
              {t("title")}
            </h2>
          }
        />

        {/*
          关闭按钮浮在右上角。
          `placement="left"` —— 按钮已在容器最右上，气泡向下/向右都会被裁掉或
          盖住内容（首版 bottom 就把提示压在了标题栏上）。
        */}
        <div className="absolute right-3 top-3 z-10">
          <Tooltip content={tc("actions.close")} placement="left">
            <IconButton label={tc("actions.close")} size="sm" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </Dialog>
  )
}
