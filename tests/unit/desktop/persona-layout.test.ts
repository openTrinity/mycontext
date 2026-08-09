/**
 * ★ 数字分身页的**布局决定**（门禁式断言，不是快照）。
 *
 * ## 为什么值得用断言锁住
 *
 * 这两条都是**产品决定**，而它们的回退方式都很自然：
 *
 * · 「草稿放右栏」是最顺手的写法（它跨会话，看起来该有自己的位置），
 *   而那正是被换掉的形态 —— 审草稿时看不到它要回复的那句话；
 * · 「运行日志常驻」同理：它是排查用的，占一整栏会把真正的动作挤窄。
 *
 * 两条回退都不会有任何报错，评审里也只是"挪了个位置"。
 * 所以固定成机器可查的。
 *
 * 用源码文本断言而不是渲染快照：`PersonaModule` 要 mock 一整套 IPC
 * （会话/草稿/快照/头像/活动日志），而快照会因为任何无关样式改动变红 ——
 * 于是很快就没人认真看它了。这里只断言**那两条决定**本身。
 * 组件级的行为（草稿卡能编辑、角标能点）在 `persona-thread.test.tsx` 里。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const PERSONA = join(import.meta.dirname, "../../../apps/desktop/src/renderer/features/persona")
const module_ = readFileSync(join(PERSONA, "persona-module.tsx"), "utf8")

/**
 * 去掉注释后的源码。
 *
 * ## ★★ 为什么必须有它
 *
 * 这个文件里的断言判据是"代码里有没有写某个字符串"，而本仓库的注释
 * **密度很高且专门解释被换掉的那个旧写法**（"不再是写死的 max-h-72"、
 * "已删的 RunTraceDisclosure"）。于是 `not.toContain("max-h-72")`
 * 会被解释它的那句注释自己命中 —— 断言测的变成"有没有人写过这几个字"，
 * 而不是"代码走哪条路"。
 *
 * 这不是假想：`persona-layout` 里 `agentAvailable` 那条断言当初就踩过，
 * 那里的解法是改判**完整取值路径**（`snapshot.data?.agentAvailable`）。
 * 但那招只在有取值路径可判时才成立，className 这类字面量没有 ——
 * 所以这里直接把注释剥掉。
 *
 * 剥法故意很笨（块注释 + 行注释两条正则）：它只用来喂断言，
 * 不需要处理"字符串里出现 `//`"这类真解析器才关心的情形。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
}

describe("★★ 回复区在消息流底部，不在第三栏", () => {
  /**
   * ★ 判据是「没有 aside」+「ReplyDock 排在 MessageThread 之后」。
   *
   * 只判"没有 aside"的话，把回复区搬到**左边**也能通过 —— 而那同样解决不了
   * "看不到它要回复的那句话"这个问题。两条一起才锁住"紧跟在对话之后"。
   */
  it("整页没有 <aside class 的第三栏（左栏 ConversationRail 自己有 aside 是另一回事）", () => {
    // persona-module 自身不该再直接写 <aside> —— 那是第三栏时代的结构
    expect(module_).not.toContain("<aside")
  })

  it("★ ReplyDock 排在 MessageThread **之后**（紧跟对话）", () => {
    const thread = module_.indexOf("<MessageThread")
    const dock = module_.indexOf("<ReplyDock")
    expect(thread).toBeGreaterThan(-1)
    expect(dock).toBeGreaterThan(-1)
    expect(dock).toBeGreaterThan(thread)
  })

  it("★ 两者在**同一个** section 里（不是又分了一栏）", () => {
    const section = module_.indexOf("<section")
    const sectionEnd = module_.indexOf("</section>")
    const dock = module_.indexOf("<ReplyDock")
    expect(dock).toBeGreaterThan(section)
    expect(dock).toBeLessThan(sectionEnd)
  })
})

describe("★ 处理结果（运行日志）移到中栏右上角的历史 popover，入口必须留着", () => {
  const chatHeader = readFileSync(join(PERSONA, "chat-header.tsx"), "utf8")

  /**
   * 用户反馈"对话框下面那个模块不需要处理结果，顶多当前对话右上角
   * 可以有个历史处理结果"。所以 `ActivityFeed`：
   * · **不再**常驻在 persona-module 的回复区下面；
   * · 收进 `ChatHeader` 一个默认关闭的 popover（点右上角 🕘 打开）。
   */
  it("★ persona-module 里不再常驻 ActivityFeed（回复区下面不放处理结果）", () => {
    expect(module_).not.toContain("<ActivityFeed")
  })

  it("★ ActivityFeed 仍然被渲染 —— 收进 ChatHeader 的历史 popover（不是删掉）", () => {
    /**
     * ★ 反证：不能顺手删掉。
     *
     * 完全删掉的话"数字人这一轮为什么没回"就再次变成一个查不到原因的问题
     * —— 而 `decision_reason` 那一整套设计的全部意义就是回答它。
     * 收起来可以，拿掉不行。
     */
    expect(chatHeader).toContain("<ActivityFeed")
  })

  it("★ 它在一个默认收起的 popover 里（由 historyOpen 控制），不是常驻", () => {
    // popover 由状态开关控制 → 默认不显示，点右上角 icon 才出现
    expect(chatHeader).toContain("historyOpen")
    /**
     * ★ 判的是**剥掉注释后**的源码，且窗口放宽到 2400 字符。
     *
     * 原来是 1200：那个数字是照当时的代码量取的，而 popover 里如今多了
     * 高度/滚动那几层的解释注释（本次修复的判据本身要写清），
     * 于是 `historyOpen ?` 与 `<ActivityFeed` 之间隔了 1860 字符 ——
     * 断言红了，但代码是对的。剥掉注释后这个距离与"注释写多长"无关了。
     */
    expect(stripComments(chatHeader)).toMatch(/historyOpen\s*\?[\s\S]{0,2400}<ActivityFeed/)
  })
})

/**
 * ★★ 「生成过程看不全」的回归锁。
 *
 * ## 那次故障的形态
 *
 * 过程原来是列表里一个**就地展开**的折叠块（已删的 `RunTraceDisclosure`）。
 * 而这一栏住在中栏右上角一个写死 `max-h-72`（288px）的 popover 里，
 * popover 又在 `persona-module` 那个 `overflow-hidden` 的布局区里。
 * 于是几十条 tool_call 的 trace 只能从 288px 的窗口里读，滚的还是
 * **外层那条列表**的滚动条 —— 用户报的「没法 scroll、这样可能看不全」。
 *
 * ## 为什么用源码断言而不是渲染
 *
 * 判据本身是**结构决定**（滚动容器挂在哪一层、过程走不走 top layer），
 * 而 jsdom 没有布局引擎 —— `scrollHeight`/`clientHeight` 恒为 0，
 * 真实溢出量不到。行为那一半在 `activity-feed-detail.test.tsx` 里
 * （"内容渲染在 <dialog> 内"+"只有一个滚动容器"），
 * 真浏览器里的溢出那一半在 `check:persona-ui` 里。
 */
describe("★★ 生成过程走独立弹窗（原生 dialog），不在 popover 里就地展开", () => {
  /**
   * ★ 三份都剥注释再判：这一组的断言全是"某个字面量在不在"，
   * 而解释它们的注释里必然提到那个字面量（见 `stripComments` 的注释）。
   */
  const chatHeader = stripComments(readFileSync(join(PERSONA, "chat-header.tsx"), "utf8"))
  const feed = stripComments(readFileSync(join(PERSONA, "activity-feed.tsx"), "utf8"))
  const dock = stripComments(readFileSync(join(PERSONA, "reply-dock.tsx"), "utf8"))

  /**
   * ★★ 走 `Dialog`（原生 `<dialog>` + `showModal()`）而不是又一个 popover。
   *
   * 这是**手段本身**：top layer 里的元素不受祖先 `overflow`/`z-index`/
   * `transform` 影响，而这一页从中栏区域到 popover 一路都是 overflow-hidden。
   * 换回 absolute 定位的浮层会让同一个 bug 立刻回来。
   */
  it("★★ 历史列表用 RunTraceDialog（原生 dialog），不再有就地展开的折叠块", () => {
    expect(feed).toContain("<RunTraceDialog")
    // 已删的那个组件不该以任何形式回来
    expect(feed).not.toContain("RunTraceDisclosure")
    expect(dock).not.toContain("RunTraceDisclosure")
  })

  it("★ 草稿卡里的入口也是弹窗（原来那个折叠块会把发送按钮挤出屏幕）", () => {
    expect(dock).toContain("<RunTraceDialog")
  })

  /**
   * ★★ 弹窗**只在有目标时才挂载** —— 那同时是"没点开不查库"的实现方式
   * （`RunTraceDialog` 以 `open` 当两个查询的 enabled）。
   * 恒挂一个 `open={false}` 的会需要一个假 runId，而那是下一个 bug 的入口。
   */
  it("★★ 弹窗条件挂载（openId 为空时不渲染），不是恒挂一个 open=false", () => {
    expect(feed).toContain("openId")
    expect(feed).not.toMatch(/<RunTraceDialog[\s\S]{0,200}open=\{false\}/)
  })

  /**
   * ★★ popover 的滚动容器必须挂在**有高度约束的那一层**。
   *
   * `overflow-y-auto` 挂在没有 max-h 的祖先上是"能滚不动"的经典成因：
   * 内容把父级撑高，父级永远没有溢出。而 `min-h-0` 是 flex 里让子项
   * 真的能被压缩的那一半 —— 缺了它 `flex-1` 不收缩，内容顶破 max-h。
   */
  it("★★ popover 有高度上限 + min-h-0 的滚动层（不再是写死的 max-h-72）", () => {
    expect(chatHeader).toContain("max-h-[min(60vh,32rem)]")
    expect(chatHeader).toContain("min-h-0 flex-1 overflow-y-auto")
    // 那个写死的 288px 上限不该回来
    expect(chatHeader).not.toContain("max-h-72")
  })
})

/**
 * ★★ 降级横幅的**判据**（这是一次静默降级的回归锁）。
 *
 * 横幅原来看 `agentAvailable`，而那个字段只反映"LLM 配没配"。于是
 * 「模型配好了、但 agent 二进制缺失/版本读不出来」这一档：
 * `agentAvailable === true` → 横幅**一个字都不显示**，
 * 而草稿实际已经退成直连（没有工具调用、没有事实检索）。
 * 实测同事就在这个状态里（日志 `opencode_version_unreadable`）。
 *
 * 用源码断言而不是渲染：判据本身是"读哪个字段"，那正是会被改回去的东西
 * （`agentAvailable` 读起来更自然）。渲染测试要 mock 一整套 IPC 才能
 * 覆盖同一件事，而且改个样式就红。
 */
describe("★★ 降级横幅看 degradedReason，不看 agentAvailable", () => {
  it("★★ 判据是 degradedReason（非 null 才显示）", () => {
    expect(module_).toContain("snapshot.data?.degradedReason != null")
  })

  it("★★ 不再用 agentAvailable 当横幅的判据", () => {
    /**
     * ★ 这条是那次故障的直接反证：把判据改回去必红。
     *
     * ★★ 判的是 `snapshot.data?.agentAvailable === false` 这个**完整取值路径**，
     * 不是裸的 `agentAvailable === false`。后者会被上面那段解释注释自己命中
     * （它就是在说"不要用这个"）—— 那种断言测的是"有没有人写过这几个字"，
     * 而不是"代码走哪个字段"，属于[断言的字符串必须是被测逻辑独有的]那一类坑。
     *
     * `agentAvailable` 本身仍在契约里（别处可能用），所以不能断言它整体消失。
     */
    expect(module_).not.toContain("snapshot.data?.agentAvailable === false")
  })

  it('★ 文案按原因分（不是一句写死的 t("degraded")）', () => {
    // 走 explainDegradedReason，才可能对 agent 那几档说对话
    expect(module_).toContain("explainDegradedReason")
    // 旧的单句 key 不该再出现 —— 它对 opencode 那几类是错的
    expect(module_).not.toContain('t("degraded")')
  })
})
