/**
 * 主题：明暗（跟随系统 + 手动覆盖）+ 主题色，都写入 `data-*` 供 token 层切换。
 * 选择持久化在 localStorage（渲染层偏好，不必进 SQLite）。
 *
 * ## 为什么明暗与主题色是**两个**独立维度
 *
 * 它们回答的是不同问题：明暗是"环境亮不亮"（常跟随系统），
 * 主题色是"我喜欢什么颜色"（纯个人偏好、与环境无关）。
 * 合成一个枚举会得到 2×4=8 个值，而"跟随系统"这件事只对明暗成立。
 *
 * 两者都只改 CSS 变量：明暗切 `data-theme`（semantic.css），
 * 主题色切 `data-accent`（primitives.css 里的 `--brand-brand-*`）——
 * **没有任何组件需要知道当前是什么主题或什么颜色。**
 */
import { useEffect, useState } from "react"

export type ThemePreference = "system" | "light" | "dark"

/**
 * 主题色。**三个：蓝 / 黄 / 紫。**
 *
 * ★ 曾经有四个：`ink`（品牌墨蓝，默认）/ `amber` / `violet` / `blue`。
 * 而 `ink` 与 `blue` 都是蓝 —— 摆在一起用户分不出"这两个有什么区别"，
 * 那正是选择器最糟的形态（看起来有得选，实际是同一个）。
 *
 * 合并之后 `blue` 就是那个默认（它对应 `:root` 里的品牌墨蓝），
 * 另外两个色相相距足够远。
 *
 * 顺序 = 界面上的顺序：默认在最前。
 */
export const ACCENTS = ["blue", "amber", "violet"] as const
export type AccentPreference = (typeof ACCENTS)[number]

/**
 * 默认主题色。
 *
 * ★ 必须是 `:root` 里那一套的颜色。
 *
 * `:root` 装的是品牌墨蓝（`#3563d6`），而"选中默认时删掉 data-accent"
 * 这个机制意味着**默认渲染出来的就是 :root 那一套**。
 * 所以如果这里写 `amber`，用户会看到"选中了黄色，界面是蓝的" ——
 * 一个不会报错、只是明显不对的 bug。
 */
export const DEFAULT_ACCENT: AccentPreference = "blue"

const STORAGE_KEY = "mycontext.theme"
const ACCENT_STORAGE_KEY = "mycontext.accent"

function resolve(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function readStored(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system"
}

function readAccent(): AccentPreference {
  const stored = localStorage.getItem(ACCENT_STORAGE_KEY)
  // 未知值（降级回滚 / 手改过 localStorage）按默认处理，而不是原样写进 DOM ——
  // 写进去会得到一个匹配不到任何 CSS 规则的属性，表现是"主题色选了没反应"。
  return (ACCENTS as readonly string[]).includes(stored ?? "")
    ? (stored as AccentPreference)
    : DEFAULT_ACCENT
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readStored)
  const [accent, setAccent] = useState<AccentPreference>(readAccent)

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset["theme"] = resolve(preference)
      document.documentElement.dataset["os"] = window.navigator.platform
        .toLowerCase()
        .includes("mac")
        ? "darwin"
        : "other"
    }
    apply()
    localStorage.setItem(STORAGE_KEY, preference)

    // 跟随系统时需要监听系统主题变化。
    if (preference !== "system") return
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [preference])

  useEffect(() => {
    /**
     * 默认（blue）删属性而不是设一个重复的块。
     *
     * `:root` 那一份是唯一真源；再写一份 `[data-accent="blue"]`
     * 就有了两处定义同一套颜色，迟早漂。
     */
    if (accent === DEFAULT_ACCENT) delete document.documentElement.dataset["accent"]
    else document.documentElement.dataset["accent"] = accent
    localStorage.setItem(ACCENT_STORAGE_KEY, accent)
  }, [accent])

  return { preference, setPreference, resolved: resolve(preference), accent, setAccent }
}
