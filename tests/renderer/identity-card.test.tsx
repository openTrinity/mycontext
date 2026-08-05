/**
 * @vitest-environment jsdom
 *
 * **数字分身卡**，以及"本人身份不在这一页"这条。
 *
 * ## ★★ 这一组的断言方向变过两次，两次的理由都记在这里
 *
 * 1. 最早锁的是"两个身份必须在同一张卡里"（中间一个 `→` 箭头）。
 *    推翻它的是用户：「高鹏（真实身份）和小小周（数字身份）不用放在一起」。
 * 2. 于是拆成两个组件：页头一条 `SelfIdentityStrip` + 一张 `PersonaCard`。
 *    **那一版也被推翻了** —— 侧栏底部（`sidebar-user-button.tsx`）本来就
 *    常驻着「头像 + 名字 + 邮箱」，切到哪一页都在。于是同一屏出现两个
 *    同名头像，而读者会去找它们的区别（其实没有）。
 *    用户的话是「还是很怪，整体设计能不能和谐点，不要有很割裂的感觉」。
 *
 * 现在：**本人身份归侧栏**，这一页只讲分身。`SelfIdentityStrip` 已删除。
 *
 * ## ★ 删掉那条时有两件事必须被守住，就是这一组存在的意义
 *
 * · 「身份待确认」那条警示**不能跟着丢**。未确认时蒸馏会静默拒掉
 *   **全部**语料（历史上 9768 条全被拒而进度页显示"完成"）。
 *   它搬去了仪表盘的 `ProblemLine` —— 那部分由 `dashboard-identity.test.tsx`
 *   锁（判据函数 `readIdentityBar` 的三态）；
 * · 当初那处**文案重复**不许回来（「在盯着新消息」「N 个会话可自动回」
 *   各写两遍）。拆开不等于可以各说一遍，所以那批断言全部保留。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { PersonaSnapshotView } from "@mycontext/ipc-contract"
import { PersonaCard } from "@renderer/features/dashboard/identity"
import type { PersonaCards } from "@renderer/features/dashboard/dashboard-data"
import type { PersonaIdentity } from "@renderer/features/persona/persona-identity"

/**
 * jsdom 没有 `ResizeObserver`，而分身卡里的 `Button`（空态那个
 * 「去起个名字」）走 `useSquircle` → `new ResizeObserver`。
 *
 * 缺它的表现不是"报缺 ResizeObserver"，而是整棵树抛在 Button 里、
 * 渲染出一个空 div —— 于是断言失败信息指向一个完全无关的方向。
 */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver

afterEach(cleanup)

const PERSONA: PersonaIdentity = {
  name: "小某",
  figureSeed: "seed",
  figureImagePath: null,
  figureCustom: {},
} as unknown as PersonaIdentity

function snapshot(over: Partial<PersonaSnapshotView> = {}): PersonaSnapshotView {
  return {
    running: true,
    agentAvailable: true,
    killSwitch: false,
    autoReplyCount: 6,
    pendingInbox: 0,
    pendingDrafts: 0,
    residents: [],
    maxResident: 8,
    ...over,
  } as PersonaSnapshotView
}

const CARDS: PersonaCards = {
  autoReply: "6",
  pendingInbox: "0",
  pendingDrafts: "0",
  residents: "0 / 8",
  killSwitch: false,
  degraded: null,
}

function renderPersona(
  over: { cards?: PersonaCards | null; snap?: PersonaSnapshotView | null } = {},
) {
  return render(
    <PersonaCard
      persona={PERSONA}
      snapshot={over.snap === undefined ? snapshot() : over.snap}
      cards={over.cards === undefined ? CARDS : over.cards}
    />,
  )
}

describe("★★ 分身卡里没有本人身份（那一份在侧栏）", () => {
  /**
   * ★ 判据是"分身卡里**没有**本人那一半"，而不是"页面上两个都有"。
   *
   * 后者在并排那一版下**也是绿的** —— 而那正是被推翻的形态。
   */
  it("分身卡里没有本人的名字与身份状态", () => {
    const { container } = renderPersona()
    const text = container.textContent ?? ""
    expect(text).toContain("小某")
    // 本人那一半不该在这里 —— 它在侧栏底部
    expect(text).not.toContain("沈某")
    expect(text).not.toContain("本人身份已确认")
  })

  /**
   * ★ 那个 `→` 箭头不能回来。
   *
   * 它是并排那一版的语义（"委托关系"），而两者不再是一条流程上的两点。
   */
  it("不再有「我 → 我的分身」那个箭头", () => {
    const { container } = renderPersona()
    expect(container.textContent ?? "").not.toContain("→")
  })

  /**
   * ★ 渠道名不在这张卡上。
   *
   * 它是**整页的取值范围**，现在在 `AppHeader` 的 actions 槽里。
   * 贴在分身卡上会读成"这个分身的一个属性"。
   */
  it("分身卡里不出现渠道名", () => {
    const { container } = renderPersona()
    expect(container.textContent ?? "").not.toMatch(/钉钉|飞书/)
  })
})

describe("★★ 分身的四个数与分身在同一张卡里", () => {
  it("四个数都渲染在分身卡这一棵子树里", () => {
    const { container } = renderPersona()
    const root = container.firstElementChild
    expect(root).not.toBeNull()
    const text = root?.textContent ?? ""
    for (const label of ["待我确认", "可自动回复", "正在排队", "常驻会话"]) {
      expect(text, `「${label}」应在分身卡内`).toContain(label)
    }
    // 分身那一半也在同一棵子树里 —— 两者缺一这条就没有意义
    expect(text).toContain("小某")
  })

  /** 还没读到快照时不画那一排（一排「—」比没有更像坏了） */
  it("cards=null 时不画那一排", () => {
    renderPersona({ cards: null })
    expect(screen.queryByText("待我确认")).toBeNull()
    // 但分身那一半照常在 —— 它不依赖那四个数字
    expect(screen.getByText("小某")).toBeTruthy()
  })

  /** ★ 卡要自报是什么 —— 上一版靠箭头区分两个名字，"小某是什么"要靠猜 */
  it("卡上有「我的数字分身」这个说明", () => {
    renderPersona()
    expect(screen.getByText("我的数字分身")).toBeTruthy()
  })
})

describe("★★ 四个数是凹槽，而这一页**没有框**", () => {
  /**
   * ## 这一条的方向被改过一次，两次的理由都记在这里
   *
   * 第一版：四个数字卡与承载它们的分身卡是**同一个色值**
   * （都 `--bg-card-z1`，真应用里量到两者都是 `rgb(38,38,38)`）——
   * 四个框只靠 1px 描边浮在同色底上。那时这一条锁的是
   * "数字用 z0、外层卡用 z1"。
   *
   * 第二版（现在）：那张外层卡**整个去掉了**。把主数字与分身卡都升成卡
   * 之后这一页变成"框套框套框"（5 个块 3 层边界），用户的话是
   * 「上面为啥还要加框，好怪，能不能视觉简洁高级点」。
   *
   * 所以现在锁两件事：
   * · 四个数字**仍然**是 z0 凹槽（层级靠色阶，这条没变）；
   * · 这棵子树里**一个 z1 都没有**（框不许回来）。
   *
   * 判据用 **class 里的 token 名**而不是计算色：jsdom 不算 CSS 变量，
   * `getComputedStyle` 拿到的是空串（那会让这条恒绿 —— 一个假绿）。
   * 真实色值由 `scripts/probe-dashboard-ui.mjs` 在真浏览器里量。
   */
  it("四个数字是 z0 凹槽", () => {
    const { container } = renderPersona()
    const sunken = [...container.querySelectorAll("div")].filter((el) =>
      el.className.includes("--bg-card-z0"),
    )
    expect(sunken.length, "四个数字都应是凹槽（z0）").toBe(4)
  })

  /**
   * ★ 整棵子树里不许有 z1 —— 那是"框"的载体。
   *
   * 只断言"有 4 个 z0"的话，有人再套一层 z1 包起来它仍然是绿的，
   * 而那正是用户抱怨的形态。
   */
  it("分身卡这一块没有任何 z1 的面（框不许回来）", () => {
    const { container } = renderPersona()
    const raised = [...container.querySelectorAll("*")].filter((el) =>
      el.className.toString().includes("--bg-card-z1"),
    )
    expect(raised.length, "这一页靠色阶与间距分层，不靠框").toBe(0)
  })

  /** 凹槽没有描边 —— 已经用色阶分层了，再加描边是同一件事说两遍 */
  it("凹槽不带 ring（层级靠色阶，不靠描边）", () => {
    const { container } = renderPersona()
    const sunken = [...container.querySelectorAll("div")].find((el) =>
      el.className.includes("--bg-card-z0"),
    )
    expect(sunken).toBeDefined()
    expect(sunken?.className ?? "").not.toContain("ring-1")
  })

  /**
   * ★★ 那条 `border-t` **被删掉了**，这一条的方向变过一次。
   *
   * 上一版分身与四个数是上下两段，那条线是它们唯一的分界（去框之后
   * 更是如此），所以那时锁的是"线必须在"。
   *
   * 现在两者在**同一行**（用户：「小小周和下面的待我确认、可自动回复等
   * 应该放在一行也完全可以吧」）—— 没有上下两半，那条线也就没有
   * 要分的东西了。留着它会变成一条横穿整块、两边内容毫无关系的线。
   *
   * 所以判据反过来：这一块里**不该**再有 border-t。
   */
  it("没有那条横线了（分身与四个数已经并成一行，没有上下两半要分）", () => {
    const { container } = renderPersona()
    const withBorder = [...container.querySelectorAll("*")].filter((el) =>
      el.className.toString().includes("border-t"),
    )
    expect(withBorder, "并成一行之后那条分界线是多余的").toHaveLength(0)
  })

  /**
   * ★ 而"并成一行"这件事本身要锁住 —— 否则上面那条只是
   * "把线删了"，而布局可能仍然是竖着的两段。
   *
   * ## 判据换过一次：`flex-wrap` → 12 列栅格
   *
   * 上一版这里是 `flex flex-wrap` + 四个数字块 `flex-1 basis-[140px]`，
   * 所以断言"根上有 flex-wrap、没有 flex-col"。
   *
   * 但那个布局有个真实的毛病：卡片宽度是"平分剩余空间"，而剩余空间取决于
   * 左边分身块占了多少 —— 于是卡片左缘随内容漂。真应用里量到它落在 x=428，
   * 而上面那排清点数在 x=928、头像在 x=64：三条互不重合的竖线，
   * 中间那些"奇怪的空白"就是它们之间的残余
   * （用户："你不觉得很不对齐吗，奇怪的空白很多"）。
   *
   * 所以改成 `grid grid-cols-12`：分身块 4 列 + 四个卡片各 2 列。
   * 断言跟着换成**列跨度**，而锁的意图没变：两者仍在同一行。
   */
  it("分身与四个数在同一行（12 列栅格，不是上下两段）", () => {
    const { container } = renderPersona()
    const root = container.firstElementChild
    // 根是 12 列栅格
    expect(root?.className).toContain("grid-cols-12")
    // 竖排的类不该出现在根上 —— 那是更早一版的形态
    expect(root?.className ?? "").not.toContain("flex-col")

    /**
     * ★ 宽屏下分身块占 4 列、四个卡片各 2 列 —— 加起来正好 12，
     * 也就是"它们在同一行"的真正判据（4 + 4×2 = 12）。
     *
     * 只断言"根是 grid"不够：那时把卡片写成 `col-span-12`（各占一整行）
     * 仍然会绿，而那就是竖排。
     */
    const spans = [...(root?.children ?? [])].map((el) => {
      const m = /lg:col-span-(\d+)/.exec(el.className.toString())
      return m === null ? 0 : Number(m[1])
    })
    expect(spans, "分身块 4 列 + 四个卡片各 2 列").toEqual([4, 2, 2, 2, 2])
  })
})

describe("★★ 同一句话只说一遍（拆开之后这条仍然要守）", () => {
  /**
   * 「在盯着新消息」在分身卡里**恰好一次**。
   *
   * 用 `getAllByText` 数个数而不是 `getByText` —— 后者在有两个时会抛
   * "found multiple"，那也算红，但报错信息说的是"选择器不够精确"，
   * 指向一个错误的方向（其实是**文案重复**）。
   */
  it("「在盯着新消息」恰好出现一次", () => {
    renderPersona()
    expect(screen.getAllByText("在盯着新消息")).toHaveLength(1)
  })

  /**
   * ★ 旧那句「N 个会话可自动回」不能回来。
   *
   * 它与「可自动回复 6 / 回复模式设成自动的会话」是同一个 `autoReplyCount`。
   * 判据用正则而不是整串相等：数字会变，而重复这件事与数字无关。
   */
  it("不再出现「N 个会话可自动回」（与「可自动回复」那张卡同一个数）", () => {
    const { container } = renderPersona()
    expect(container.textContent ?? "").not.toMatch(/个会话可自动回(?!复)/)
  })

  it("「可自动回复」恰好出现一次", () => {
    renderPersona()
    expect(screen.getAllByText("可自动回复")).toHaveLength(1)
  })
})

describe("运行状态三态各自可分", () => {
  it("running=false → 调度未运行（而不是仍说在盯着）", () => {
    renderPersona({ snap: snapshot({ running: false }) })
    expect(screen.getByText("调度未运行")).toBeTruthy()
    expect(screen.queryByText("在盯着新消息")).toBeNull()
  })

  /**
   * ★ 快照还没到（null）与"读到了、没在跑"必须分开。
   *
   * 合成一句的话，启动那一瞬间会显示「调度未运行」—— 一个假警报，
   * 而用户会去点「启动」。
   */
  it("snapshot=null → 读取中（不是「调度未运行」）", () => {
    renderPersona({ snap: null })
    expect(screen.getByText("读取中")).toBeTruthy()
    expect(screen.queryByText("调度未运行")).toBeNull()
  })
})
