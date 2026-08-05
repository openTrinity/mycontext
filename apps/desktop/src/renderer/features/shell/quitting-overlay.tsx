/**
 * QuittingOverlay — 优雅退出的全屏遮罩。
 *
 * ## 为什么要有它
 *
 * 用户确认退出之后，`dispose()` 要跑 0.5-2s（数字人在途轮次、搜索
 * ACP session、kl 子进程、DWS 子进程都要等）。这段时间窗口还挂着但已不再
 * 响应业务操作——不加提示的话表现是"点哪都没反应"。
 *
 * 挂一个遮罩告诉用户"正在关闭"，那段等待就从"卡了"变成"在关"。
 *
 * ## 视觉：与 QuitConfirmDialog 同一张卡
 *
 * 同一套 token（`radius-xl` + `--border-light` + `--bg-base-normal` +
 * `--shadow-lg`）、同样的 400px 定宽。用户刚在确认框上点了「退出」，
 * 下一帧出现的东西**应该看起来是同一个东西的延续** —— 换一套形状会像
 * 跳到了另一个界面。
 *
 * 首版这里画的是一组 420px 的扩散光环（`AmbientRings`）。那个组件是给
 * 登录页右侧的品牌氛围面板用的，铺在半透明遮罩上时它的 1px 描边环
 * 与背景内容叠在一起，读起来像画面出了故障；而它 5.2s 一轮的周期
 * 比 dispose 本身还长，用户根本看不到一个完整动作。
 *
 * ## 转圈而不是进度条
 *
 * dispose 每步的耗时分布很跳（search 3s 预算、db 1s），进度条会在
 * 某一步长时间不动 —— 那比没有进度条更像卡死。转圈只承诺"在做事"。
 *
 * ## 位置：应用最外层，不在 AppShell 里
 *
 * 退出可能发生在任意状态下（登录页 / 引导页 / 主壳 / 加载态）。
 * 装在 App 里覆盖到 body 层，保证任何路由分支都被盖住。
 *
 * ## 一次性、不可撤销
 *
 * 收到 `shell:quitting` 后就锁死，直到进程消失。不做"取消退出"按钮：
 * dispose 里第一件事就是关子进程，那些没法再拉起而继续用——
 * 给用户一个假的挽回选项比没有挽回更糟。
 *
 * ## 不复用 `<Dialog>`
 *
 * 那个组件的 open 状态与 DOM `showModal()` 双向同步、支持 Esc 与点遮罩
 * 关闭。这里三者都**不要**——退出不可取消。直接一层 fixed 盒子最简单。
 */
import { useEffect } from "react"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface QuittingOverlayProps {
  visible: boolean
}

export function QuittingOverlay({ visible }: QuittingOverlayProps) {
  const { t } = useDynamicTranslation()

  /*
   * 遮罩挂上后禁用页面滚动。等 dispose 跑完 Electron 会把窗口一起收走，
   * 不用手动 cleanup —— 但 return 里还是清一下，防御 hot-reload。
   */
  useEffect(() => {
    if (!visible) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [visible])

  if (!visible) return null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      /*
        `bg-page-mask` 亮色下只有 0.2 透明度（`<Dialog>` 的 backdrop 也是
        配着 opacity 用的），单靠它压不住背景内容。补一层轻模糊：
        它让"背景已经不可操作"这件事在视觉上确定，而不用把遮罩加深到
        看不见界面 —— 用户此刻还想确认自己刚才在哪一页。
      */
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-[var(--bg-page-mask)] backdrop-blur-[2px] motion-safe:animate-[mycontext-quit-fade_160ms_ease-out]"
    >
      <style>{`
        @keyframes mycontext-quit-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes mycontext-quit-rise {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes mycontext-quit-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div
        className="flex items-center gap-3.5 radius-xl border border-[var(--border-light)] bg-[var(--bg-base-normal)] px-5 py-4 shadow-[var(--shadow-lg)] motion-safe:animate-[mycontext-quit-rise_220ms_cubic-bezier(0.22,0.61,0.36,1)]"
        style={{ width: "min(400px, calc(100vw - 64px))", animationFillMode: "both" }}
      >
        {/*
          转圈：一段 270° 的弧配 `border-transparent` 的另外三边。
          `motion-safe` 之外不加 fallback —— reduced-motion 下它就是一个
          静止的四分之三圆环，仍然读得出"这是个加载指示"。
        */}
        <span
          aria-hidden="true"
          className="size-5 shrink-0 rounded-full border-2 border-[var(--border-medium)] border-t-[var(--text-accent-normal)] motion-safe:animate-[mycontext-quit-spin_680ms_linear_infinite]"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="typography-body-base-500 text-[var(--text-base-primary)]">
            {t("quit.overlayTitle")}
          </span>
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("quit.overlaySubtitle")}
          </span>
        </div>
      </div>
    </div>
  )
}
