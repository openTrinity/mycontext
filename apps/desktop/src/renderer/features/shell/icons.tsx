/**
 * 模块与操作图标。
 *
 * 自绘图标，currentColor 取色，与设计系统的图标规范一致
 * （不引第三方图标库，避免为几个图标拖进整个包）。
 *
 * 模块图标是 16px 线性（1.4 描边）；侧栏折叠按钮用 24px 实心，
 * 与参考设计系统的 System-bar 图标一致——线性图标在那个位置
 * 与交通灯并排时显得过轻。
 */

/**
 * 收起侧栏：整块面板 + 左侧粗竖条（表示「栏还在，只是收起来」）。
 * 实心风格，24 视图框，与参考实现的 IconLeftSidebarHide 同构。
 */
export function SidebarHideIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M20.25 6.5C20.25 4.98122 19.0188 3.75 17.5 3.75H6.5C4.98122 3.75 3.75 4.98122 3.75 6.5V17.5C3.75 19.0188 4.98122 20.25 6.5 20.25H17.5C19.0188 20.25 20.25 19.0188 20.25 17.5V6.5ZM21.75 17.5C21.75 19.8472 19.8472 21.75 17.5 21.75H6.5C4.15279 21.75 2.25 19.8472 2.25 17.5V6.5C2.25 4.15279 4.15279 2.25 6.5 2.25H17.5C19.8472 2.25 21.75 4.15279 21.75 6.5V17.5Z"
        fill="currentColor"
      />
      <path
        d="M6 7.5C6 6.67157 6.67157 6 7.5 6C8.32843 6 9 6.67157 9 7.5V16.5C9 17.3284 8.32843 18 7.5 18C6.67157 18 6 17.3284 6 16.5V7.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** 展开侧栏：面板被一条竖缝分成两半（表示「栏已收起，可以拉出来」）。 */
export function SidebarShowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M20.25 6.5C20.25 4.98122 19.0188 3.75 17.5 3.75H9.75V20.25H17.5C19.0188 20.25 20.25 19.0188 20.25 17.5V6.5ZM3.75 17.5C3.75 19.0188 4.98122 20.25 6.5 20.25H8.25V3.75H6.5C4.98122 3.75 3.75 4.98122 3.75 6.5V17.5ZM21.75 17.5C21.75 19.8472 19.8472 21.75 17.5 21.75H6.5C4.15279 21.75 2.25 19.8472 2.25 17.5V6.5C2.25 4.15279 4.15279 2.25 6.5 2.25H17.5C19.8472 2.25 21.75 4.15279 21.75 6.5V17.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function GaugeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M2.5 12a5.5 5.5 0 1 1 11 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M8 12V7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** 仪表盘：四格布局 */
export function DashboardIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/**
 * 知识图谱：三个节点 + 连线。
 *
 * 刻意画成"节点+边"而不是一个网格/树：这一页的内容是关系，
 * 而侧栏图标是用户唯一的线索（标签会被折叠侧栏藏起来）。
 */
export function GraphIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path d="M8 4.6 4.4 10.4M8 4.6l3.6 5.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="3.4" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="3.4" cy="11.6" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12.6" cy="11.6" r="1.9" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** 数字人：人形轮廓 + 对话气泡角标 */
export function PersonaIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <circle cx="6.5" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2 13.5c0-2.2 2-3.8 4.5-3.8 1 0 1.9.25 2.6.68"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M10 8.5h4.5v3.2H12l-1.6 1.5v-1.5H10V8.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 搜索：放大镜 */
export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10.2 10.2 13.5 13.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M13 9.8A5.5 5.5 0 0 1 6.2 3a5.5 5.5 0 1 0 6.8 6.8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function LogOutIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M10 11l3-3-3-3M13 8H6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 设置：齿轮 */
export function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="size-4"
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.59 3.94c.09-.54.56-.94 1.11-.94h2.6c.55 0 1.02.4 1.11.94l.21 1.28c.06.37.31.69.65.87l.22.13c.32.2.72.26 1.07.12l1.22-.46c.51-.19 1.09.02 1.37.49l1.3 2.25c.27.48.16 1.08-.26 1.43l-1 .83c-.3.24-.44.61-.43.99v.26c-.01.38.13.75.43.99l1 .83c.42.35.53.95.26 1.43l-1.3 2.25c-.28.47-.86.68-1.37.49l-1.22-.46c-.35-.14-.75-.08-1.07.12l-.22.13c-.34.18-.59.5-.65.87l-.21 1.28c-.09.54-.56.94-1.11.94h-2.6c-.55 0-1.02-.4-1.11-.94l-.21-1.28c-.06-.37-.31-.69-.65-.87l-.22-.13c-.32-.2-.72-.26-1.07-.12l-1.22.46c-.51.19-1.09-.02-1.37-.49l-1.3-2.25c-.27-.48-.16-1.08.26-1.43l1-.83c.3-.24.44-.61.43-.99v-.26c.01-.38-.13-.75-.43-.99l-1-.83a1.13 1.13 0 0 1-.26-1.43l1.3-2.25c.28-.47.86-.68 1.37-.49l1.22.46c.35.14.75.08 1.07-.12l.22-.13c.34-.18.59-.5.65-.87l.21-1.28Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

/** 关闭：叉。弹窗右上角用 */
export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** 上下箭头：用户按钮的展开指示（菜单向上弹，所以是 chevron-up 的语义） */
export function ChevronUpDownIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M5.5 6.5L8 4l2.5 2.5M10.5 9.5L8 12l-2.5-2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 语言：地球 */
export function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2.2 8h11.6M8 2.2c1.6 1.7 2.4 3.6 2.4 5.8S9.6 12.1 8 13.8C6.4 12.1 5.6 10.2 5.6 8S6.4 3.9 8 2.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  )
}

/** 通用设置：滑杆（比齿轮更贴"调参数"，齿轮已用于设置入口本身） */
export function SlidersIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="6" cy="4.5" r="1.6" fill="currentColor" />
      <circle cx="10.5" cy="8" r="1.6" fill="currentColor" />
      <circle cx="5" cy="11.5" r="1.6" fill="currentColor" />
    </svg>
  )
}

/** 渠道：插头（"接上一个外部系统"） */
export function PlugIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M6 2v3.2M10 2v3.2M4.4 5.2h7.2v2.2a3.6 3.6 0 0 1-3.6 3.6 3.6 3.6 0 0 1-3.6-3.6V5.2ZM8 11v3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 关于：信息 */
export function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.2v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="5.2" r="0.85" fill="currentColor" />
    </svg>
  )
}

/**
 * 引导流程（一串带勾的步骤）。
 *
 * 用"清单"而不是"旗帜/火箭"这类隐喻：这一栏的内容是**四步的进度**，
 * 而清单是那件事最直白的图形（用户不需要先理解隐喻）。
 */
export function ChecklistIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M2.2 4.4l1.3 1.3 2.2-2.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.2 10.6l1.3 1.3 2.2-2.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.4 4.6h5.4M8.4 11h5.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * 数字人的运行参数（滑块 + 齿轮的混合意象：可调的运行时）。
 *
 * 与 `SlidersIcon`（通用设置）区分：那个是三条横滑块，这个带一个
 * 中心圆 —— 一眼能看出"这是另一类设置"而不是同一个图标复用。
 */
export function TuningIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * 回到初始视图（四角取景框 + 中心点）。
 *
 * ## 为什么是取景框而不是别的隐喻
 *
 * 这个按钮做的事是"把视口还原到 `autoFit: view` 算出来的那个构图"——
 * 也就是**重新取景**，数据一个字节都不变。
 *
 * 排掉的两个候选：
 * · **循环箭头**（↻）读作"刷新/重新拉数据"，而这里不重新建图、不重查
 *   —— 用一个会被误读成"要等几分钟"的图标是在制造犹豫；
 * · **放大镜**读作"搜索"，与这一页的搜索页撞。
 *
 * 四角括号 + 中心点是相机取景与地图"回到我的位置"共用的符号，
 * 用户不需要先理解隐喻。
 *
 * 规格与本文件其余图标一致：`viewBox 0 0 16 16` + `size-4` +
 * `currentColor`，描边 1.3（与 `InfoIcon`/`TuningIcon` 同一档）。
 */
export function FocusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      {/*
        四个角各画一个折角。用四段独立 path 而不是一个 rect + dash：
        dash 的相位会随尺寸漂，而这四段是固定几何。
      */}
      <path
        d="M2.4 5.6V3.6a1.2 1.2 0 0 1 1.2-1.2h2M10.4 2.4h2a1.2 1.2 0 0 1 1.2 1.2v2M13.6 10.4v2a1.2 1.2 0 0 1-1.2 1.2h-2M5.6 13.6h-2a1.2 1.2 0 0 1-1.2-1.2v-2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      {/* 中心点：取景框对准的那个目标 */}
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </svg>
  )
}
