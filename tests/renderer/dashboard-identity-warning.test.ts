/**
 * 仪表盘上「本人身份未确认」那条警示**没有在重构里丢掉**。
 *
 * ## ★★ 为什么这一条要单独用源码断言，而不是渲染一遍
 *
 * 这次改动删掉了页头那条身份条（`SelfIdentityStrip`）—— 理由是侧栏底部
 * 本来就常驻同一份身份，同一屏两个同名头像是重复。那个删除本身是对的。
 *
 * 但那条里**带着**一句有真实后果的话：「身份待确认 —— 蒸馏会拒掉全部语料」。
 * 未确认时守卫会**静默**拒掉全部语料（历史上 9768 条全被拒，
 * 而进度页显示"完成"，见 `self-identity-must-be-confirmed-before-distill`）。
 * 删一个组件时顺手把它带走，是那种**当天看不出、下次蒸馏才发现**的损失。
 *
 * 渲染 `DashboardModule` 来断言它需要 8 个 query 的桩（bootstrap / ingest /
 * distill / persona / feed / kl / ego / overview）加 i18n 与 QueryClient ——
 * 那些桩自己就有几十行，而其中任何一个的形状变了都会让这条测试红在
 * 一个与"警示丢了没有"完全无关的地方。而这条要防的事很窄：
 * **那句话与它的触发条件还在源码里**。所以直接读源码。
 *
 * ★ 这类测试的失效方式是"断言的字符串在别处也能通过"
 * （见 `assertion-strings-must-be-unique-to-the-thing-tested`）。
 * 所以下面每一条都同时要求：那句话在、判据在、且**恒亮的那句不在**。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8")

/**
 * ★★ 断言前**必须把注释剥掉**，否则这一组会红在自己的注释上。
 *
 * 这不是理论风险 —— 第一版就栽了：我在源码注释里写了
 * 「上一版说的是『本人身份已确认』，现在删了」来记录改动理由，
 * 而 `not.toContain("本人身份已确认")` 于是失败。同理
 * `not.toContain("SelfIdentityStrip")` 撞上了解释它为什么被删的那段注释。
 *
 * 更糟的是**反方向**：如果只做 `toContain`，一句写在注释里的话
 * 会让测试变绿 —— 那时"警示还在"这个结论是假的（注释不渲染给用户）。
 * 所以这一步是这一组成立的前提，不是清理。
 */
function code(source: string): string {
  return (
    source
      // 块注释（含 JSDoc）
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // 行注释
      .replace(/\/\/[^\n]*/g, "")
      // JSX 注释外壳 `{ }` 里已经没内容了，留着不影响
      .replace(/\{\s*\}/g, "")
  )
}

const DASHBOARD = code(read("apps/desktop/src/renderer/features/dashboard/dashboard-module.tsx"))
const IDENTITY = code(read("apps/desktop/src/renderer/features/dashboard/identity.tsx"))
const SHELL = code(read("apps/desktop/src/renderer/features/shell/app-shell.tsx"))

describe("★★ 身份未确认那条警示在重构后仍然存在", () => {
  /**
   * 那句话必须说出**后果**，不能只说"待确认"。
   *
   * 「待确认」是一个状态名，读者不知道该不该管它；
   * 「会拒掉全部语料」才让人知道现在蒸馏是白跑的。
   */
  it("仪表盘上有一句说明后果的话（不只是「待确认」）", () => {
    expect(DASHBOARD).toContain("拒掉全部语料")
  })

  /**
   * ★ 触发条件必须是 `unconfirmed` 这一态，**不能**是 `!selfConfirmed`。
   *
   * `selfConfirmed` 是 `boolean | null`，`null` 表示"还在读"。
   * 写成 `!selfConfirmed` 的话启动那一瞬间会闪一条假警报 ——
   * 而用户会去点设置里那个已经确认过的开关。
   */
  it("触发条件走 selfState 的 unconfirmed 一态（null 是「还在读」，不报警）", () => {
    expect(DASHBOARD).toMatch(/selfState\s*===\s*"unconfirmed"/)
    // 判据来自纯函数，不在这一层重新判一遍
    expect(DASHBOARD).toContain("readIdentityBar")
  })

  /**
   * ★ 它用 `ProblemLine`（与这一页其余"哪里坏了"同一种样式）。
   *
   * 自己写一个警示框会让同一屏出现两种"出事了"的长相，
   * 而读者要学两次才知道哪个更严重。
   *
   * 判据取"那句话所在的那个 JSX 元素"而不是"那一行" ——
   * prettier 会因为行长把 `<ProblemLine text=… tone=… />` 折成多行，
   * 按行取会让这条测试**红在格式化上**（而它要验的是结构）。
   */
  it("用 ProblemLine 而不是自己写一个警示框", () => {
    const at = DASHBOARD.indexOf("拒掉全部语料")
    expect(at).toBeGreaterThan(-1)
    // 往前找到这个元素的起始 `<`，往后到它闭合
    const open = DASHBOARD.lastIndexOf("<", at)
    const close = DASHBOARD.indexOf("/>", at)
    const element = DASHBOARD.slice(open, close)
    expect(element).toContain("ProblemLine")
    // ★ tone 必须是 bad：它的后果比"采集未运行"重（那只是慢，这是白跑）
    expect(element).toContain('tone="bad"')
  })
})

describe("★★ 恒亮的那句不许回来", () => {
  /**
   * 「本人身份已确认」平时永远显示，永远不需要任何动作 —— 那是噪音。
   *
   * 这一条与上面那条是一对：警示要留，而"一切正常"的播报不要。
   * 只锁前者的话，有人"顺手"把整条身份条搬回来也是绿的。
   */
  it("仪表盘与分身卡都不再说「本人身份已确认」", () => {
    expect(DASHBOARD).not.toContain("本人身份已确认")
    expect(IDENTITY).not.toContain("本人身份已确认")
  })

  /**
   * ★ `SelfIdentityStrip` 这个组件本身不许再出现。
   *
   * 它是那份重复的载体（侧栏底部已有头像 + 名字 + 邮箱）。
   * 判据锁"导出"与"使用"两侧 —— 只锁一侧的话另一侧可以悄悄复活。
   */
  it("SelfIdentityStrip 已删除（页面与组件两侧都没有）", () => {
    expect(IDENTITY).not.toContain("SelfIdentityStrip")
    expect(DASHBOARD).not.toContain("SelfIdentityStrip")
  })

  /**
   * ★ 渠道筹码不在这一页的内容里 —— 它在页头（`AppHeader` 的 actions）。
   *
   * 一个作用于**整页**的取值范围画在页面内容里，读起来像"只影响这一块"。
   */
  it("渠道筹码不再由仪表盘内容渲染", () => {
    expect(DASHBOARD).not.toContain("ScopeChip")
    expect(SHELL).toContain("ScopeChip")
  })
})

describe("★★ 顶部那一行的尺寸（用户：「greeting 那么小包括头像」）", () => {
  /**
   * ## 为什么这一组要单独存在
   *
   * CDP 探针虽然能量实测像素，但它是**独立 import 一份** DashboardModule
   * 到游离 host 里 —— Vite 的 HMR 不会重挂那份，模块被缓存住之后
   * "把 size 改回 lg"探针**读到的还是旧的 xl**（我实测撞到过），
   * 反证形同虚设。
   *
   * 所以尺寸类的**源码层门禁**放在这里：字面锁住 `size="xl"` 与
   * `typography-title-large-600`，改动它们必然触发这一条。
   */
  it('头像用 size="xl" —— 与 48px 主数字并排读得平', () => {
    /**
     * ★ 找**问候语所在**的那个 Avatar：仪表盘可能还有别的头像（比如分身
     * 那块的 PersonaFigure，但那不是 Avatar），锁 dashboard-module 里的
     * 那一处即可 —— 匹配到 GreetingRow 附近的那个 Avatar。
     */
    // 简单起见，锁"这个文件里 Avatar 组件用了 xl 档"
    expect(DASHBOARD).toMatch(/<Avatar\b[^>]*size="xl"/s)
    // 反面：不许悄悄改回 lg/md
    expect(DASHBOARD).not.toMatch(/<Avatar\b[^>]*size="(lg|md|sm|xs)"/s)
  })

  it("greeting 用 title-jumbo-600（32px / LH 1），不是 body/title-large 号", () => {
    const GREETING = code(read("apps/desktop/src/renderer/features/dashboard/greeting-row.tsx"))
    /**
     * ★ 字号档从 `title-large-600`(26/32) 换到 `title-jumbo-600`(32/1)。
     *
     * 两个原因（用户直接指出的）：
     * · "字体大点"—— 26 → 32；
     * · "下对齐"—— LH 32 → LH 1，让 `items-end` 时文字底真正齐分割线。
     *
     * 反面：`title-large-600` 与 body 号都不许回来 —— 前者是上一版留下的
     * "line-box 底齐但文字底浮起来"的形态，后者是更早的 15px 小字号。
     */
    expect(GREETING).toContain("typography-title-jumbo-600")
    expect(GREETING).not.toMatch(/typography-body-(base|small|reading)/)
    expect(GREETING).not.toContain("typography-title-large-600")
  })

  /**
   * ★★ `title-jumbo-600` 必须是 48px + line-height 1
   *
   * 这条同时锁**档位的两个属性**：
   * · 48px：与 64px 头像视觉同高（用户："文本可以再大点，和头像同高"）；
   * · line-height 1：让 `items-end` 时**文字底** = **盒子底** = **头像底**。
   *
   * 只锁"文件里有 title-jumbo-600"的话，token 值被改掉了这条仍会绿 ——
   * 而那正好是"下对齐"或"文字太小"失效的场景。所以这里读 CSS 文件本身。
   */
  it("title-jumbo-600 定义为 48px + LH 1（与 64px 头像同高、下对齐前提）", () => {
    const TYPOG = read("packages/design/src/styles/typography.css")
    const block = /\.typography-title-jumbo-600\s*\{[^}]*\}/.exec(TYPOG)?.[0]
    expect(block, "typography.css 里应有 title-jumbo-600 那档").toBeDefined()
    expect(block).toMatch(/font-size:\s*48px/)
    expect(block).toMatch(/line-height:\s*1\b/)
  })

  /**
   * ★★ 头像与 greeting 在**同一行**、不许被 wrap 分开。
   *
   * ## 这条断言的载体换过一次，理由记在这里
   *
   * 上一版这两者住在 `primitives.tsx` 的 `DashboardHead` 里（一个
   * greeting/avatar/trailing 三槽容器），所以断言读那个组件的源码。
   * 那时的 bug 是 `flex-wrap` 把头像挤到下一行、悬在页面中间
   * （用户："还是没让头像和 greeting 对齐下面的分割线"）。
   *
   * 这一轮上半部分重排成"三段"之后 `DashboardHead` 没有消费者了，
   * 整个删掉；头像与 greeting 直接由 `dashboard-module.tsx` 排。
   * 所以断言跟着搬过来 —— 锁的**意图没变**：两者必须在同一个不 wrap
   * 的 flex 行里。
   */
  it("头像与 greeting 在同一个不 wrap 的 flex 行里", () => {
    // 取"头像 + greeting"那一段（Avatar 到 GreetingRow 之间）
    const at = DASHBOARD.indexOf("<Avatar")
    expect(at, "仪表盘应渲染问候行的头像").toBeGreaterThan(-1)
    // 往前找到包住它的那个 div 的 className
    const open = DASHBOARD.lastIndexOf("<div", at)
    const wrapper = DASHBOARD.slice(open, at)
    expect(wrapper, "头像所在的那一行要是 flex").toContain("flex")
    // ★ 不许 wrap —— 那正是上一版把头像挤到下一行的原因
    expect(wrapper).not.toContain("flex-wrap")
    // 头像与 greeting 紧邻（中间只有 Avatar 那一个元素）
    const seg = DASHBOARD.slice(at)
    expect(seg.indexOf("<GreetingRow"), "GreetingRow 应紧跟在 Avatar 之后").toBeGreaterThan(-1)
  })

  /**
   * ★★ 上半部分**没有分割线**（用户：「分割线可能也没有很有必要」）。
   *
   * 上一版在问候/清点 与 分身卡 之间有一条 `border-t`。它想分隔的两块
   * 本来就靠内容区分得很清楚，而那条线自己要上下留白 —— 我给了 8px+8px，
   * 结果线被夹死、两块反而被推远，用户看到的是"排布有点紧密"。
   *
   * 现在靠**间距**分段。这条锁住它不许回来：
   * 判据是"`PersonaCard` 不再被一个带 border-t 的 div 包着"。
   */
  it("分身卡上方没有分割线（分段靠间距，不靠线）", () => {
    const at = DASHBOARD.indexOf("<PersonaCard")
    expect(at, "仪表盘应渲染分身卡").toBeGreaterThan(-1)
    // 往前 200 字符内不该有 border-t（那是上一版包住它的那个 div）
    const before = DASHBOARD.slice(Math.max(0, at - 200), at)
    expect(before, "分身卡上方不该有 border-t 分割线").not.toContain("border-t")
  })
})
