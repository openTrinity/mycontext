/**
 * 设置弹窗的**布局**门禁。
 *
 * ## ★ 为什么这件事需要门禁（截图才发现的一类 bug）
 *
 * 用户报的现象是「滚动条不在最右侧，右边有一片莫名的空白」。
 * 量出来的几何：弹窗 960px，左导航 240px → 内容区 720px；
 * 而内容被 `mx-auto max-w-[560px]` 压到 560px 并**居中**，
 * 加 48px padding 之后右边空出 **112px**。
 *
 * 滚动条贴在 720px 容器的右缘（`overflow-y-auto` 在那一层），
 * 内容却在 560px 处结束 —— 于是"滚动条离内容很远"。
 *
 * 这类 bug 的可怕之处：**每个组件单独看都是对的**，
 * 没有报错、没有告警、单测全绿。它只在把三个尺寸（弹窗宽 / 导航宽 /
 * 内容限宽）放在一起算时才暴露，而那三个数分散在两个文件里。
 * 所以门禁必须锁**关系**，不是锁某一个值。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "../../apps/desktop/src/renderer/features/settings")
const view = readFileSync(join(ROOT, "settings-view.tsx"), "utf8")
const dialog = readFileSync(join(ROOT, "settings-dialog.tsx"), "utf8")

/** 从 `min(960px, ...)` 里取弹窗宽。 */
function dialogWidth(): number {
  const m = /width:\s*"min\((\d+)px/.exec(dialog)
  expect(m, 'settings-dialog 里应有 `width: "min(<n>px, ...)"`').not.toBeNull()
  return Number(m?.[1])
}

/** 从 `w-[240px]` 取左导航宽。 */
function navWidth(): number {
  const m = /className="flex w-\[(\d+)px\] shrink-0/.exec(view)
  expect(m, "settings-view 的左导航应有固定 `w-[<n>px]`").not.toBeNull()
  return Number(m?.[1])
}

describe("★ 滚动条必须紧贴内容（那片空白的根因）", () => {
  /**
   * ★ 这一条是**第二个**根因，也是最容易漏的那个。
   *
   * `SettingsView` 的根 div 原来只有 `flex h-full`，没有 `w-full`。
   * flex 容器在主轴上**按内容收缩** —— 实测它只有 703px（弹窗 960px），
   * 右边 257px 是弹窗的空底。加上左导航 240，内容区只剩 463px，
   * 于是 `max-w-[560px]` 那个限宽根本没机会生效（463 < 560）。
   *
   * 也就是用户看到的空白是两层叠出来的。只修"居中限宽"那一层的话，
   * 空白会从 112px 变成 257px —— **更宽**。我第一版差点就那样收工，
   * 是把探针接到运行中的应用、量出 703 才发现的。
   *
   * 教训：几何问题不能靠读 CSS 推，要在真 DOM 上量。
   */
  it("SettingsView 根容器铺满弹窗（少了 w-full 会收缩到内容宽）", () => {
    const m = /<div className="(flex h-full[^"]*)"/.exec(view)
    expect(m, "应能找到 SettingsView 的根 flex 容器").not.toBeNull()
    expect(m?.[1]).toContain("w-full")
  })

  /**
   * ★★ 内容列必须 `min-w-0` —— 「授权页右侧被切掉」那个 bug 的根因。
   *
   * 这个内容列是弹窗横向 flex 里的伸缩项。flex 项默认 `min-width:auto`，
   * 意味着它**拒绝缩到比内容更窄**：授权面板那一行有 5 颗按钮 + dws 路径框，
   * 固有宽度超过可用宽时，这一列不让子元素换行、而是自己撑过 960px，多出的
   * 被弹窗 `overflow-hidden` 裁掉（按钮/`使用自有 dws`/路径框全在右缘消失，
   * 且下面那层只有 `overflow-y-auto`、没有横向滚动条能够到）。
   *
   * 与"根容器要 w-full"是**同一类**（flex 主轴尺寸）却相反方向的坑，所以
   * 单独锁一条：内容列（`flex-1` + 弹窗底色那个）必须带 `min-w-0`。
   */
  it("内容列带 min-w-0（否则宽内容撑破弹窗、右侧被裁）", () => {
    const m = /<div className="(flex min-h-0[^"]*bg-\[var\(--bg-base-normal\)\][^"]*)"/.exec(view)
    expect(m, "应能找到内容列（flex-1 + 弹窗底色）").not.toBeNull()
    expect(m?.[1]).toContain("min-w-0")
    expect(m?.[1]).toContain("flex-1")
  })

  /**
   * 这是核心的一条：**滚动容器与限宽元素不能是不同的两层**。
   *
   * 原来是：
   *   <div class="overflow-y-auto">            ← 720px，滚动条在这
   *     <div class="mx-auto max-w-[560px]">    ← 内容只有 560px
   *
   * 两者宽度不同 → 滚动条与内容之间必然有空隙，且空隙 = 差值。
   * 修法是让滚动容器里的那一层**铺满**（限宽下沉到各 Section 自己）。
   */
  it("滚动容器的直接子元素不再 mx-auto 限宽", () => {
    /**
     * 抓 `overflow-y-auto` 那个容器之后紧跟的那个 div 的 class。
     *
     * ★ 正则**只锚 `overflow-y-auto`**，不再连着写
     * `bg-[var(--bg-base-normal)]` —— 那个底色后来搬到了外层容器
     * （因为顶部那条渠道条也要同一个底色），于是这条断言在**性质没变**的
     * 情况下红了一次。判据要锁"滚动容器的直接子元素不限宽"这件事，
     * 而不是锁那一行 class 的具体拼法。
     */
    const m = /overflow-y-auto[^">]*">\s*<div className="([^"]+)"/.exec(view)
    expect(m, "应能找到滚动容器的直接子 div").not.toBeNull()
    const cls = m?.[1] ?? ""
    // 这两个同时出现就是那个 bug 的形状
    expect(cls).not.toContain("mx-auto")
    expect(cls).not.toMatch(/max-w-\[\d+px\]/)
    // 它必须铺满
    expect(cls).toContain("w-full")
  })

  /**
   * ★ 限宽必须**不居中**。
   *
   * 就算把限宽下沉到 Section，如果还带 `mx-auto`，左边也会跟着缩进 ——
   * 于是内容与左导航之间出现一道无来由的空隙（换了个位置的同一个毛病）。
   */
  it("Section 的限宽不带 mx-auto（否则左边又空一道）", () => {
    const m = /wide \? "" : "(max-w-\[\d+px\][^"]*)"/.exec(view)
    expect(m, "Section 应用三元决定限宽").not.toBeNull()
    expect(m?.[1]).not.toContain("mx-auto")
  })
})

describe("★ 宽度关系：内容区放得下最宽的那一栏", () => {
  /**
   * 形象定制那一屏里最宽的一行是 20 个色点（size-6 = 24px + gap 8）。
   * 算下来约 20×32 = 640px，**放不进 560px**，但放得进 672px
   * （720 内容区 − 48 padding）。
   *
   * 这条锁的是「`wide` 那一栏真的有地方铺」——
   * 若有人把弹窗改窄回 720px，这条会红，提醒他形象那屏会挤爆。
   */
  it("内容区（弹窗 − 导航 − padding）容得下 20 个色点", () => {
    const contentWidth = dialogWidth() - navWidth() - 48
    // 20 个 24px 色点 + 19 个 8px 间隔
    const swatchRow = 20 * 24 + 19 * 8
    expect(contentWidth).toBeGreaterThanOrEqual(swatchRow)
  })

  /**
   * 文字型仍要窄。
   *
   * 一行 60-80 字是可读上限；铺满 672px 之后眼睛要横扫。
   * 所以缺省（`wide` 为 false）必须仍有限宽 —— 别把这次修复
   * 变成"所有栏都铺满"，那会伤掉语言/主题/身份那几栏的可读性。
   */
  it("文字型仍限宽，且明显窄于内容区", () => {
    const m = /wide \? "" : "max-w-\[(\d+)px\]/.exec(view)
    const textMeasure = Number(m?.[1])
    expect(textMeasure).toBeGreaterThan(0)
    expect(textMeasure).toBeLessThan(dialogWidth() - navWidth() - 48)
  })

  /** 缺省是窄的：新加的栏默认走安全的那一侧（窄了只是留白，宽了伤可读）。 */
  it("Section 的 wide 缺省为 false", () => {
    expect(view).toMatch(/wide = false/)
  })
})

describe("形象那一栏要 wide（否则色板/槽位全换行而右边空着）", () => {
  it("数字分身那一栏传了 wide", () => {
    const m = /<Section[^>]*t\("sections\.persona"\)[^>]*>/s.exec(view)
    expect(m, "应能找到数字分身那一栏的 Section").not.toBeNull()
    expect(m?.[0]).toContain("wide")
  })

  /**
   * 反面：文字型那几栏**不该**传 wide。
   *
   * 写这条是因为"全都加上 wide"是最省事的错误修法，而它不会有任何
   * 报错 —— 只是所有说明文字变成横跨 672px 的长行。
   */
  it("通用那一栏不传 wide", () => {
    const m = /<Section[^>]*t\("sections\.general"\)[^>]*>/s.exec(view)
    if (m !== null) expect(m[0]).not.toContain("wide")
  })
})

/**
 * ★★ 头像那一栏：**动作在前，内部路径不露**。
 *
 * ## 这条锁的是截图里看到的一处"没有设计感"
 *
 * 原来第一眼看到的是一个填着
 * `mycontext-file://local/Users/you/Library/Application%20Support/…`
 * 的输入框 —— 那是上传后主进程回填的**内部路径**：用户既读不懂、
 * 也不该编辑它，而它占了整块最显眼的位置。
 *
 * 而真实的操作只有两个：上传本地图片、从已连平台取。
 * 「填一个图片 URL」对一个本地优先的桌面应用本来就是奇怪的要求。
 *
 * ## 断言的是**顺序与可见性**，不是某个 class
 *
 * · 两个动作（ImagePicker / 从平台取）排在输入框**之前**；
 * · 输入框在 `<details>` 里（默认收起）；
 * · 但**没有被删掉** —— 贴外部图床 URL 这个用法要保留。
 *   删掉是"最省事的修法"，而那是一次功能缩水。
 */
describe("★★ 头像栏：动作优先，内部路径收进折叠区", () => {
  const identity = readFileSync(join(ROOT, "identity-panel.tsx"), "utf8")

  it("★ ImagePicker 排在头像输入框**之前**", () => {
    const picker = identity.indexOf("<ImagePicker")
    const details = identity.indexOf("<details")
    expect(picker).toBeGreaterThan(-1)
    expect(details).toBeGreaterThan(-1)
    expect(picker).toBeLessThan(details)
  })

  it("★★ 头像输入框在 <details> 里（默认不展开内部路径）", () => {
    /**
     * `open` 的判据是 `^https?://` —— 只有用户自己贴过网络 URL 才展开。
     * 内部的 `mycontext-file://` 不匹配，所以上传后它是收起的。
     */
    expect(identity).toMatch(/<details\s+open=\{\/\^https\?/)
  })

  it("★ 输入框仍然存在（不许为了整洁把功能删掉）", () => {
    const details = identity.indexOf("<details")
    const after = identity.slice(details)
    expect(after).toContain("<Input")
    expect(after).toContain('placeholder="https://…"')
  })

  it("★ 有头像时报**来源**而不是把路径糊在界面上", () => {
    expect(identity).toContain("avatarSourceLocal")
    expect(identity).toContain("avatarSourceRemote")
  })
})
