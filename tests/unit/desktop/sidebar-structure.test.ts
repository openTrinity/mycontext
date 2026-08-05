/**
 * ★ 侧栏结构的三条决定（门禁式断言，不是快照）。
 *
 * ## 为什么值得用断言锁住
 *
 * 这三条都是**产品决定**而不是实现细节，而它们的回退方式都很自然：
 * · 有人觉得"品牌区没图标太素"→ 把水滴加回来；
 * · 有人加新模块时顺手复制那段分割线；
 * · 有人把设置又做成一个侧栏页（那是最"顺手"的写法）。
 *
 * 三条都不会有任何报错，评审里也只是"多/少了一行"。所以固定成机器可查的。
 *
 * 用源码文本断言而不是渲染快照：快照会因为任何无关的样式改动变红，
 * 于是很快就没人认真看它了。这里只断言**那一条决定**本身。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const RENDERER = join(import.meta.dirname, "../../../apps/desktop/src/renderer")
const shell = readFileSync(join(RENDERER, "features/shell/app-shell.tsx"), "utf8")
const modules = readFileSync(join(RENDERER, "features/shell/modules.tsx"), "utf8")
const wordmark = readFileSync(
  join(import.meta.dirname, "../../../packages/design/src/components/brand-wordmark.tsx"),
  "utf8",
)

describe("★ 侧栏品牌区不渲染墨滴图标", () => {
  it("BrandWordmark 的 mark 默认关（侧栏不传 → 不渲染）", () => {
    expect(wordmark).toMatch(/mark\s*=\s*false/)
  })

  it("侧栏没有显式打开 mark", () => {
    // 允许将来登录页传 mark，但侧栏这一处不该传
    expect(shell).not.toMatch(/<BrandWordmark[^>]*\bmark\b/)
  })

  it("字标用专用的 wordmark 字重档（粗黑体风格的落点）", () => {
    expect(wordmark).toContain("typography-wordmark")
  })

  /**
   * ★ BETA 不能用 Tag 组件。
   *
   * Tag 是**语义状态**标记（info/success/error），带填充底色。
   * 品牌标签不是状态、它是字标的一部分 —— 用 Tag 会让它染上蓝底、
   * 与"提示信息"同形（首版就是蓝底，与设计稿的描边胶囊不符）。
   */
  it("★ BETA 是描边胶囊，不是 Tag（Tag 有填充底色且语义是状态）", () => {
    expect(wordmark).not.toContain("<Tag")
    expect(wordmark).not.toMatch(/from "\.\/tag\.js"/)
    // 描边 + 全大写 + 放开字距，是还原设计稿的三个要素
    expect(wordmark).toContain("uppercase")
    expect(wordmark).toMatch(/rounded-full border/)
    // 字距只断言"有设"而不钉死数值：具体值是视觉调优的产物，
    // 钉死会让每次微调都要改测试（而那时改的人只会顺手把断言改成新值）。
    expect(wordmark).toMatch(/tracking-\[0\./)
  })

  it("字标与 BETA 同色（整体读成一个单元，不是两个词）", () => {
    const occurrences = wordmark.split("--text-base-primary").length - 1
    // 字标 1 处 + BETA 的 border 与 text 各 1 处
    expect(occurrences).toBeGreaterThanOrEqual(3)
  })
})

describe("★ 运行状态与业务模块同组", () => {
  it("status 在 FEATURE_MODULES 里（不再是分割线下的「基建」）", () => {
    // 取 FEATURE_MODULES 那个数组的文本范围
    const start = modules.indexOf("FEATURE_MODULES")
    const end = modules.indexOf("STATUS_MODULE", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(modules.slice(start, end)).toContain('id: "status"')
  })

  it("★ 不再有 UTILITY_MODULES（那个分组连同分割线一起去掉了）", () => {
    expect(modules).not.toContain("UTILITY_MODULES")
    expect(shell).not.toContain("UTILITY_MODULES")
  })

  it("★ 导航区不再有分组分割线", () => {
    // 只看导航区（nav 开标签到闭标签之间）
    const start = shell.indexOf("<nav")
    const end = shell.indexOf("</nav>", start)
    expect(start).toBeGreaterThan(-1)
    const nav = shell.slice(start, end)
    // 搜索会话列表自己那条分隔线是另一回事（它分隔的是"模块"与"会话"），
    // 所以断言的是"分组分割线"那句注释不再存在
    expect(nav).not.toContain("基建页与业务模块分组")
  })
})

describe("★ 设置是弹窗，不是侧栏页面", () => {
  it("侧栏挂了 SettingsDialog", () => {
    expect(shell).toContain("SettingsDialog")
  })

  it("★ 内容区不再有 settings 分支（否则就是又变回页面了）", () => {
    expect(shell).not.toMatch(/active\.id === "settings"/)
  })

  it("modules.tsx 不再导出 SETTINGS_MODULE（侧栏没有这一项）", () => {
    expect(modules).not.toContain("SETTINGS_MODULE")
  })
})

describe("★ 侧栏底部是用户按钮", () => {
  it("挂了 SidebarUserButton", () => {
    expect(shell).toContain("SidebarUserButton")
  })

  it("★ 退出登录不再是底部的图标按钮（那让它与「切主题」同等重量）", () => {
    // 底部区域不该再直接渲染 LogOutIcon —— 它现在在菜单项里
    expect(shell).not.toContain("LogOutIcon")
  })
})

/**
 * ★★ Dialog 容器不能自带背景色 —— 一个实际发生过的透明弹窗 bug。
 *
 * ## 症状与根因
 *
 * 设置弹窗**整个透明**，背景的运行状态页透出来叠在弹窗内容上。
 *
 * 原因不是 backdrop 没生效（那部分 CSS 实测编译正确），而是
 * `Dialog` 在 `<dialog>` 上写了 `bg-transparent`，而调用方通过 `className`
 * 传的 `bg-[var(--bg-base-normal)]` 与它是**同等特异性**（都是单个类）——
 * 于是谁赢由**样式表里的先后顺序**决定，而不是 props 的顺序。
 *
 * 实测编译产物里 `.bg-transparent` 排在 `.bg-[var(--bg-base-normal)]` 之后，
 * 所以调用方的背景被吃掉。**这类冲突不报错，在小 diff 里也看不出来。**
 *
 * ## 规则
 *
 * 容器只负责"清掉浏览器默认"，一切可见外观交给内层容器。
 */
describe("★★ Dialog 不在容器上写背景色（透明弹窗回归）", () => {
  const dialog = readFileSync(
    join(import.meta.dirname, "../../../packages/design/src/components/dialog.tsx"),
    "utf8",
  )

  it("Dialog 自己不设 bg-*（会与调用方的背景撞特异性）", () => {
    // 只看 className 那段（注释里提到 bg-* 是在解释这条规则本身）
    const start = dialog.indexOf("className={cn(")
    const end = dialog.indexOf(")}", start)
    expect(start).toBeGreaterThan(-1)
    const classes = dialog.slice(start, end)
    expect(classes).not.toContain("bg-transparent")
    // backdrop:bg-* 是伪元素，不冲突 —— 允许
    expect(classes.replace(/backdrop:bg-\[[^\]]*\]/g, "")).not.toMatch(/\bbg-\[/)
  })

  it("backdrop 仍然压暗（否则弹窗与背景分不开）", () => {
    expect(dialog).toContain("backdrop:bg-[var(--bg-page-mask)]")
  })

  it("设置弹窗的背景色给在**内层**容器上", () => {
    const settings = readFileSync(join(RENDERER, "features/settings/settings-dialog.tsx"), "utf8")
    // Dialog 的 className 只做圆角裁剪
    expect(settings).toMatch(/className="radius-xl"/)
    // 内层才有底色
    expect(settings).toContain("bg-[var(--bg-base-normal)]")
  })
})

/**
 * ★★ 「知识图谱」**不能**再有独立的侧栏入口。
 *
 * ## 为什么这一条值得当门禁
 *
 * 它是一个产品决定，而回退方式极其自然：将来有人要加一个图相关的
 * 功能时，最顺手的写法就是"再开一栏"—— 那时侧栏又有了「知识图谱」，
 * 而仪表盘那一整块（ego 图 + 邻居排名 + 事实检索）就变成了重复内容。
 *
 * 撤栏的理由（见 `modules.tsx` 的文件头）：那个名字本身是技术词，
 * 而它与仪表盘讲的是同一个故事的两段 —— 分开之后**两边都不完整**。
 *
 * ## 断言的是"没有"，所以必须同时锁住"有"的那一面
 *
 * 只断言 `not.toContain("graph")` 是空的：把整个 FEATURE_MODULES
 * 删空它照样绿。所以下面同时断言四个该在的模块都在 ——
 * 于是"撤掉了图谱"与"侧栏坏了"两件事能区分开。
 */
describe("★★ 知识图谱没有独立入口（整块并进仪表盘）", () => {
  it("ModuleId 里没有 graph", () => {
    const line = modules.match(/export type ModuleId = [^\n]*/)?.[0] ?? ""
    expect(line).not.toContain('"graph"')
  })

  it("FEATURE_MODULES 里没有 graph 那一项", () => {
    expect(modules).not.toMatch(/id:\s*"graph"/)
    expect(modules).not.toContain("modules.graph.")
  })

  it("app-shell 没有 graph 的路由分支，也不 import GraphModule", () => {
    expect(shell).not.toContain("GraphModule")
    expect(shell).not.toMatch(/active\.id === "graph"/)
  })

  /**
   * ★ 反面：四个模块必须都还在。
   *
   * 没有这一条时，把 FEATURE_MODULES 整个删空能让上面三条全绿 ——
   * 而那是一个空侧栏，比多一栏糟得多。
   */
  it("仪表盘 / 数字人 / 搜索 / 运行状态四项都还在", () => {
    for (const id of ["dashboard", "persona", "search", "status"]) {
      expect(modules).toMatch(new RegExp(`id:\\s*"${id}"`))
    }
  })

  /**
   * ★ 图谱那一块**真的**在仪表盘里，而不是只是导航项没了。
   *
   * 撤栏而不搬内容的话，用户是"功能消失了"而不是"换了地方" ——
   * 而这个项目里那种静默降级正是反复出现的失效。
   */
  it("仪表盘装着 ego 图与事实检索面板", () => {
    const dashboard = readFileSync(
      join(RENDERER, "features/dashboard/dashboard-module.tsx"),
      "utf8",
    )
    /**
     * 断言的是**渲染**（`<X`）而不是名字出现过。
     *
     * `toContain("FactsExplorer")` 在 `FactsExplorerX` 上也为真 ——
     * 反证时抓到过这一点：把组件名改一个字母，那个断言照样绿。
     * `<FactsExplorer` 后面必须跟空白或 `/`，改名就断。
     */
    expect(dashboard).toMatch(/<EgoGraphPanel[\s/>]/)
    expect(dashboard).toMatch(/<FactsExplorer[\s/>]/)
  })
})

/**
 * ★★ 身份只有一个：问候语与侧栏底部必须同源。
 *
 * ## 这条锁的是一个实测看到的不一致
 *
 * 侧栏底部写「高鹏」（`resolveDisplayName(session)`），而搜索首屏的
 * 问候语写「gaopeng」—— 因为 `app-shell` 那里自己切了一次
 * `session.email.split("@")[0]`。同一屏两个身份，用户看到的是
 * "这是同一个我吗"，而那比两处都用 email 前缀更糟：它让人怀疑
 * 自己有两个账号。
 *
 * `resolveDisplayName` 本身已经处理了 displayName 为空时退回 email 前缀 ——
 * 所以问题不是缺兜底，而是**写了第二份**。
 *
 * 用源码断言而不是渲染：这一条要防的是"有人又在别处切一次 email"，
 * 那是源码层面的事实（渲染测试只能覆盖当前那一个调用点）。
 */
describe("★★ 身份解析只有一份（不许各处自己切 email）", () => {
  it("app-shell 用 resolveDisplayName 给搜索首屏", () => {
    expect(shell).toContain("resolveDisplayName(session)")
  })

  it('★ 反证：不许再出现 `email.split("@")` 这种就地切法', () => {
    /**
     * 这一条比上一条重要：上一条只保证"现在用对了"，
     * 而这一条挡住"下次有人又图省事自己切一次"。
     *
     * ★ 把**注释里**的那处排除掉再判 —— 修复说明里引用了原来的错写法
     * （那是有价值的：读代码的人会想知道为什么强调同源）。
     * 不排除的话这条断言会被自己的文档触发，而那种红是纯噪音。
     */
    const code = shell.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(code).not.toMatch(/email\.split\(/)
  })
})
