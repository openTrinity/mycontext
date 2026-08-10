/**
 * 图谱「详情」popover 的**结构约束** —— 那些改坏了不会报错的地方。
 *
 * ## 为什么是读源码而不是渲染组件
 *
 * 与 `ego-graph-popover-close.test.ts` / `ego-graph-hover.test.ts` 同一个理由：
 * 这个 popover 长在 `DashboardModule` 里，而那棵树要十几个 IPC 通道 +
 * G6 的 canvas（jsdom 起不来）。整体行为靠 CDP 探针在真应用里验
 * （这一轮已经验过：常驻说明 0 行、点开三段都在、点外面收起）。
 *
 * 但下面这几条是**静态可判**的，而且它们的共同点是：改坏之后
 * **既不报错也不影响数据**，只是界面悄悄退化 —— 那正是最需要一道门禁的地方。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = join(import.meta.dirname, "../../apps/desktop/src/renderer/features/dashboard")
const POPOVER = readFileSync(join(DIR, "graph-detail-popover.tsx"), "utf8")
const MODULE = readFileSync(join(DIR, "dashboard-module.tsx"), "utf8")

describe("★★ popover 必须有出口", () => {
  /**
   * ★★★ 只有入口没有出口是本仓库栽过的形状
   * （见 `ego-graph-popover-close.test.ts`：那张卡永久压在画布左上角，
   * 单测全绿、不报错，用户唯一的办法是切走页面再切回来）。
   *
   * 这里的出口有两个，都要在：
   * · 再点一次那颗 ⓘ（`setOpen((v) => !v)`）；
   * · 点 popover 外面（全屏透明捕获层 `fixed inset-0` 上的 onClick）。
   */
  it("★★★ 有 toggle（再点一次收起）", () => {
    expect(POPOVER).toContain("setOpen((v) => !v)")
  })

  it("★★★ 有点外面收起的捕获层", () => {
    expect(POPOVER).toContain("fixed inset-0")
    // 那一层必须真的**能收**，不只是存在
    expect(POPOVER).toMatch(/fixed inset-0[\s\S]{0,200}setOpen\(false\)/)
  })
})

describe("★★ 滚动与高度：两个踩过的坑", () => {
  /**
   * ★★ 滚动容器必须是**有 `max-h` 的那一层**。
   *
   * `min-h-0` 缺了的话 `flex-1` 不收缩，内容把 popover 顶破 `max-h`
   * 而不是滚动 —— 与 `RunTraceDialog` 和 chat-header 那两处是同一个坑
   * （那里的注释记着）。
   */
  it("★★ 滚动层同时有 min-h-0 / flex-1 / overflow-y-auto", () => {
    expect(POPOVER).toMatch(/min-h-0[^"]*flex-1[^"]*overflow-y-auto/)
  })

  /**
   * ★ 高度用 `min(60vh, …)` 而不是写死的 `max-h-72`（288px）。
   *
   * 288px 在 800px 高的窗口里只用掉 36% —— 明明有地方可以长，
   * 却把自己压到只能露三四行（chat-header 那处踩过并改掉了）。
   */
  it("★ 高度跟着视口，不写死 px", () => {
    expect(POPOVER).toContain("max-h-[min(60vh,32rem)]")
    /**
     * ★ 判据要**剥掉注释**再比。
     *
     * 我第一版直接 `not.toContain("max-h-72")` —— 而本文件的头注释里
     * 正解释着"为什么不用 max-h-72"，于是断言把自己的说明文字当成了代码。
     * 这与「脱敏表会被自己的替换扫到」是同一个形状：判据的输入里混进了
     * 描述判据的文字。
     */
    const code = POPOVER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(code).not.toContain("max-h-72")
  })

  /** ★ 滚到底不把滚动传给背后的页面（否则读者以为自己滚错了地方）。 */
  it("★ 有 overscroll-contain", () => {
    expect(POPOVER).toContain("overscroll-contain")
  })
})

describe("★★★ 版面：那四行常驻文字不许回来", () => {
  /**
   * ★★★ 这一条是这次改动的**主判据**。
   *
   * 我这一轮往「它认识的人与事」顶部堆了四行常驻文字（建图失败、降级原因、
   * 调度倒计时、上一轮产出），实测把图挤下去大半屏。CDP 量过：
   * 改之前 4 行，改之后 **0 行**。
   *
   * 判据钉在"模块里不再直接渲染那两个长句"上：
   * · `describeBuildVolume` 只该被 popover 用；
   * · 调度那句也只在 popover 里出现。
   *
   * ★ 只留 `classifyGraphReason` —— 它是那道"要不要常驻"的判据本身。
   */
  it("★★★ 模块不再渲染「上一轮产出」那一长句", () => {
    expect(MODULE).not.toContain("describeBuildVolume")
    expect(MODULE).not.toContain("上一轮 ·")
  })

  it("★★★ 模块不再渲染「自动构建 · …」那一行", () => {
    expect(MODULE).not.toContain("自动构建 ·")
    expect(MODULE).not.toContain("describeBuildSchedule")
  })

  /**
   * ★★ 而"要用户动手"的那一档**仍然常驻** —— 收起来等于藏了一个待办。
   *
   * 判据是模块里仍有一处按 `actionable` 渲染 `ProblemLine`。
   */
  it("★★ actionable 那一档仍然常驻（不许一起收走）", () => {
    expect(MODULE).toMatch(/graphReasonKind === "actionable"[\s\S]{0,200}ProblemLine/)
  })

  /** ★ 建图**失败**那条也照旧常驻（那是最需要用户看到的一条）。 */
  it("★ 建图失败仍然常驻", () => {
    expect(MODULE).toMatch(/buildGraph\.data\?\.ok === false[\s\S]{0,200}ProblemLine/)
  })
})

describe("★★ 空态：点开什么都没有的入口比没有入口更糟", () => {
  /**
   * ★★ 三段全空时**不渲染那颗按钮**。
   *
   * 未登录 / 没接自动构建 / 还没建过图时就是这个状态。留着一颗点开
   * 空白的按钮会让人以为它坏了 —— 而"坏了"是个比"没有这个功能"
   * 昂贵得多的结论。
   */
  it("★★ 三段都空 → 提前返回 null", () => {
    expect(POPOVER).toMatch(/hasAnything[\s\S]{0,120}return null/)
  })
})

describe("★★★ 那颗按钮不许叫「重新建图」", () => {
  /**
   * ★★★ 这一条锁的是一次**真实的语义 bug**，而它此前没有任何门禁。
   *
   * 图谱侧的写入全部只增不减（`upsert_entity` 是 `mention_count + 1`，
   * facts/edges 是 `INSERT OR IGNORE`，整个 storage 层**没有任何**
   * DELETE / prune / 孤儿清理）。所以缩小采集范围之后，旧会话的实体与边
   * **永远留在图里** —— 实测图库覆盖 73 个会话而当前导出只有 72 个、
   * 交集仅 40 个：33 个已不在范围内的会话仍占着 70.5% 的消息。
   *
   * 用户点着一个写「重新」的按钮，得到的是"又加了一轮"。
   *
   * ★ 现在叫「同步」——「同步」说的是"把新采到的补进去"，本身不含
   * "清空重来"的意思。真正会清空的入口在状态页那个「重建」（`fresh=true`）。
   *
   * ★★ 判据剥掉注释再比：本仓库的注释里到处解释着"为什么不能叫重新建图"，
   * 不剥的话断言会把说明文字当成代码（这一轮已经栽过一次，见上面
   * `max-h-72` 那条）。
   */
  const CODE = MODULE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

  it("★★★ 代码里不出现「重新建图」", () => {
    expect(CODE).not.toContain("重新建图")
  })

  /**
   * ★★ 三档都要在，且**首次与增量分开**。
   *
   * 第一次要烧全部语料的 embedding（分钟级、出网、花钱），与后续那种
   * 几十秒的增量完全不是一件事 —— 不区分的话用户会以为第一次也很快。
   */
  it("★★ 三档文案齐全（同步中 / 同步 / 首次同步）", () => {
    expect(CODE).toContain('"同步中…"')
    expect(CODE).toContain('"同步"')
    expect(CODE).toContain('"首次同步"')
  })

  /** ★ 旧文案不许残留（改一半比不改更糟：两处说法不一致）。 */
  it("★ 旧文案「继续建图（增量）」已清掉", () => {
    expect(CODE).not.toContain("继续建图")
  })
})
