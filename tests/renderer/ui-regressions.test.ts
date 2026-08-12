/**
 * 那四个 UI 项的**回归断言** —— 它们此前只有提交信息在声称。
 *
 * ## 为什么补这个文件
 *
 * `227b85d` 声称改了四件事（事实卡去渠道 tag / 设置导航扁平化 + 全局渠道
 * 切换 / 钉钉刷新头像按钮 / 暗色下 greeting 用对比白），而仓库里**没有
 * 任何断言**守着它们 —— 判据只存在于那句 commit message 里。
 * 于是任何一次重构都可能把它们改回去而没人发现。
 *
 * 本轮已在真应用里逐条验过（CDP，`theme: dark`）：
 * · 事实卡带钉钉 tag 的卡片数 **0**；
 * · 设置导航 8 项同级、`嵌套ul数: 0`、切换器 `aria-label` 命中
 *   `settings.channelScope.pickerLabel`；切到飞书后设置页显示飞书组织名；
 * · 授权页有「刷新头像」；
 * · greeting canvas 亮像素 **21531 / 暗 0**。
 *
 * 这个文件把那四条钉在源码上，让"改回去"会红。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

/** 剥注释 —— 否则搜到的可能是解释这条规则的注释而不是真代码。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

describe("① 事实卡不带渠道 tag", () => {
  const FACTS = "apps/desktop/src/renderer/features/graph/facts-explorer.tsx"

  it("★★★ 已按渠道筛过时不渲染 tag（判据是「这次查询限定渠道了吗」）", () => {
    /**
     * 用户原话：「钉钉的仪表盘下面的 fact 为什么会有钉钉的 tag，不需要吧」。
     *
     * ## ★ 我第一版的判据是错的
     *
     * 我断言"组件里不再渲染 channelId 派生的标签"，还把文件路径猜成
     * `features/dashboard/facts-explorer.tsx`（实际在 `features/graph/`）。
     * 真实修法**不是删掉**：混合检索（不限定渠道）时那个 tag 是唯一能区分
     * 来源的东西，所以它是**有条件**渲染 —— `channelId !== undefined` 就不画。
     *
     * 断言成"没有这段代码"会把一个正确的实现判成错的，而且会阻止将来
     * 混合检索用回它。所以判据落在**那个条件**上。
     *
     * 反证：把 `channelId !== undefined ||` 去掉（变成无条件渲染）→ 转红。
     */
    const src = stripComments(readFileSync(FACTS, "utf8"))
    expect(src).toContain("channelId !== undefined || fact.channelId === undefined ? null :")
  })

  it("★★ 真要显示时渠道名走 i18n，不写死「钉钉」/「飞书」", () => {
    /**
     * 原来那个三元把渠道名写死了 —— 加一个渠道就要来改这里。
     * 反证：把 `tch(...)` 换回中文字面量 → 转红。
     */
    const src = stripComments(readFileSync(FACTS, "utf8"))
    expect(src).toContain("tch(`${fact.channelId}.label`")
    // 卡片渲染段里不许出现写死的渠道名
    const at = src.indexOf("fact.channelId === undefined ? null :")
    const block = src.slice(at, at + 400)
    expect(block.includes("钉钉")).toBe(false)
    expect(block.includes("飞书")).toBe(false)
  })
})

describe("② 设置导航扁平 + 全局渠道切换", () => {
  it("★★★ 没有「渠道」父级，子项全部升为一级", () => {
    /**
     * 用户原话：「现在的渠道一级 tab 不要了，他的二级子 tab 全变成一级 tab」。
     *
     * 判据：`CHANNEL_FREE_SECTIONS` 只有通用与关于；其余 section 直接列在
     * 导航里，没有一个 id 叫 `channels` 的父级项。
     */
    const src = stripComments(
      readFileSync("apps/desktop/src/renderer/features/settings/settings-view.tsx", "utf8"),
    )
    expect(src).toContain("CHANNEL_FREE_SECTIONS")
    // 反证：把 `{ id: "channels", ... }` 作为导航项加回去 → 转红
    expect(src.includes('{ id: "channels"')).toBe(false)
  })

  it("★★★ 数字分身与引导流程都是一级项（不再挂在数字分身父级下）", () => {
    /**
     * 用户原话：「数字分身不需要归类（现在有个数字分身下面有数字分身和
     * 引导流程）」。
     */
    const src = stripComments(
      readFileSync("apps/desktop/src/renderer/features/settings/settings-view.tsx", "utf8"),
    )
    expect(src).toContain('id: "persona"')
    expect(src).toContain('id: "onboarding"')
    // 不许再有嵌套的 children 结构
    expect(src.includes("children: [")).toBe(false)
  })

  it("★★★ 有全局渠道切换器，且它带可访问标签", () => {
    /**
     * 用户原话：「有个设置整体有个全局的地方记住现在的渠道」。
     *
     * ★ 判据落在 `pickerLabel` 这个 i18n key 上，而不是中文字面量 ——
     * 界面读的是 locale JSON（本轮已经踩过一次：只改 defaultValue
     * 而界面照旧显示旧文案）。
     */
    const src = stripComments(
      readFileSync("apps/desktop/src/renderer/features/settings/settings-view.tsx", "utf8"),
    )
    expect(src).toContain("channelScope.pickerLabel")
    const zh = JSON.parse(readFileSync("packages/i18n/src/locales/zh/settings.json", "utf8"))
    const en = JSON.parse(readFileSync("packages/i18n/src/locales/en/settings.json", "utf8"))
    // 两侧 locale 都要有，否则切到英文时那个按钮没有 aria-label
    expect(typeof zh.channelScope?.pickerLabel).toBe("string")
    expect(typeof en.channelScope?.pickerLabel).toBe("string")
  })

  it("★★ 模型页也按渠道（它曾经是全局的）", () => {
    /**
     * 用户原话：「别的都要区分渠道，包括模型」。
     * 判据：model section 不在 `CHANNEL_FREE_SECTIONS` 里。
     */
    const src = stripComments(
      readFileSync("apps/desktop/src/renderer/features/settings/settings-view.tsx", "utf8"),
    )
    const at = src.indexOf("CHANNEL_FREE_SECTIONS")
    const decl = src.slice(at, at + 200)
    expect(decl).toContain("general")
    expect(decl).toContain("about")
    expect(decl.includes("model")).toBe(false)
  })
})

describe("③ 钉钉也有刷新头像按钮", () => {
  it("★★★ 刷新头像按钮不被 isolatedCredentials 挡住", () => {
    /**
     * 用户原话：「钉钉渠道那边得要有个刷新头像的按钮吧」。
     *
     * 它原来挂在只有飞书成立的 `isolatedCredentials` 分支里，所以钉钉看不到。
     * 判据：按钮的显示条件是 `accountConnected`（两个渠道都成立）。
     *
     * 反证：把条件改回 `isolatedCredentials` → 转红。
     */
    /**
     * ★★ 判据要落在**那个 JSX 条件**上，不是"附近出现过这个词"。
     *
     * 我第一版取 `at - 1200` 那一段做判据 —— 反证（把门控换成
     * `isolatedCredentials`）**照样绿**：那个窗口里还有别的
     * `accountConnected`（失败态判据、按钮文案三元），随便一个都能命中。
     * 剥注释也不够，因为它们是真代码而不是注释。
     *
     * 所以改成：从按钮往前找**最近的** `? (` 分支开头，断言它就是
     * `{accountConnected ? (`。
     *
     * 反证：把那一行换成 `{isolatedCredentials ? (` → 转红（已实测）。
     */
    const src = stripComments(
      readFileSync("apps/desktop/src/renderer/features/channels/channel-auth-panel.tsx", "utf8"),
    )
    const at = src.indexOf("refreshAvatar.mutate(")
    expect(at).toBeGreaterThan(0)
    const before = src.slice(0, at)
    const gateAt = before.lastIndexOf("? (")
    const gateLineStart = before.lastIndexOf("{", gateAt)
    const gate = before.slice(gateLineStart, gateAt + 3).replace(/\s+/g, " ")
    expect(gate).toBe("{accountConnected ? (")
  })
})

describe("④ 暗色下 greeting 用对比白", () => {
  it("★★★ particle 颜色跟随主题（不是写死的深色）", () => {
    /**
     * 用户原话：「仪表盘 greeting 那边，文本请用对比的白色吧，不然暗色主题
     * greeting 文本用的 particle 用黑色基调就不行」。
     *
     * 判据两条：① 颜色来自 CSS 变量而不是硬编码；② 主题变化会**重画**
     * （`data-theme` 进依赖）—— 只改颜色不重画的话，切主题后画布还是旧的。
     *
     * 反证：把 `themeMode` 从 effect 依赖里删掉 → 转红（那正是修复前
     * "className 不变、于是不重画"的状态）。
     */
    const src = stripComments(
      readFileSync("apps/desktop/src/renderer/features/dashboard/particle-text.tsx", "utf8"),
    )
    expect(src).toContain("data-theme")
    expect(src).toContain("themeMode")
    // 依赖数组里必须有 themeMode，否则切主题不重画
    const depsAt = src.lastIndexOf("}, [")
    expect(src.slice(depsAt, depsAt + 80)).toContain("themeMode")
  })
})
