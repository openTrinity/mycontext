/**
 * 引导页的**用词门禁**：不许出现实现的名字。
 *
 * ## ★★ 为什么这一条值得是一个测试而不是一次改动
 *
 * 用户两次提到同一件事：先是「不要有很怪的引导提示」，后来直接点名
 * 「不要在 onboarding 直接出现 蒸馏 和 知识图谱 这种词」。
 *
 * 「蒸馏」（forge）与「知识图谱」（kl）都是**实现的名字**：
 * 一个是 Python 度量引擎，一个是图数据库服务。用户不需要知道它们叫什么，
 * 他需要知道它们**做什么** —— 所以文案说"学习范围""知识库""学到了什么"。
 *
 * 而一次性改掉不够：这批 key 有 40 多个，下次加一条文案时
 * 顺手写「蒸馏完成」是最自然的事（代码里到处都是 `distill*` 标识符）。
 * 所以要有一条一直守着的门禁。
 *
 * ## 判据是**值**，不是键
 *
 * `distillStep` / `graphTitle` 这些**键名**照旧 —— 它们对应主进程的
 * `distill.service` / `kl`，改键名会让"这个文案属于哪条链路"变得难查，
 * 而键名对用户**不可见**。所以只扫 value。
 *
 * ## ★ 只管引导页
 *
 * `settings.json` 与 `common.json` 里的「知识图谱（kl）」**不动** ——
 * 设置页与运行状态页本来就是给排查用的，那里准确的技术名是**有用的**
 * （用户要照着它去看日志、去查端口）。区别在于：引导是给第一次用的人看的，
 * 排查页是给已经知道自己在找什么的人看的。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * 直接读文件而不是 `import ... with { type: "json" }`。
 *
 * `@mycontext/i18n` 的 `exports` 只暴露包根（那份 `createI18n`），
 * 没有 `./locales/*` 子路径 —— 走 import 会 `Cannot find package`。
 * 为了一个测试去加一条 export 是让**生产代码的公共接口**为测试让步，
 * 那个方向不对；而这两个文件的路径是稳定的。
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const load = (locale: string): unknown =>
  JSON.parse(readFileSync(`${ROOT}packages/i18n/src/locales/${locale}/onboarding.json`, "utf8"))

/** 把嵌套的文案对象摊平成 `[路径, 文案]`，只留字符串叶子。 */
function flatten(value: unknown, path = ""): ReadonlyArray<readonly [string, string]> {
  if (typeof value === "string") return [[path, value]]
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) =>
    flatten(child, path === "" ? key : `${path}.${key}`),
  )
}

const ZH = flatten(load("zh"))
const EN = flatten(load("en"))

describe("★★ 引导页不出现实现的名字", () => {
  /**
   * 「蒸馏」—— forge 那条链路的内部叫法。
   *
   * 连"蒸"这个字都不许单独出现：改词那一轮抓到过
   * 「现在就**蒸**也可以」「**蒸**的是已采集到的全部」这类散句，
   * 它们不含"蒸馏"二字却同样是那个隐喻。
   */
  it("zh：没有「蒸馏」，也没有单独的「蒸」", () => {
    const hits = ZH.filter(([, text]) => /蒸/.test(text))
    expect(hits, `这些文案还带着「蒸」：${JSON.stringify(hits)}`).toEqual([])
  })

  /** 「图谱」/「建图」—— kl 那条链路的内部叫法。 */
  it("zh：没有「图谱」「建图」", () => {
    const hits = ZH.filter(([, text]) => /图谱|建图/.test(text))
    expect(hits, `这些文案还带着图谱黑话：${JSON.stringify(hits)}`).toEqual([])
  })

  it("en：没有 distill / distillation", () => {
    const hits = EN.filter(([, text]) => /distill/i.test(text))
    expect(hits, `these strings still say distill: ${JSON.stringify(hits)}`).toEqual([])
  })

  it("en：没有 knowledge graph", () => {
    const hits = EN.filter(([, text]) => /knowledge\s+graph/i.test(text))
    expect(hits, `these strings still say knowledge graph: ${JSON.stringify(hits)}`).toEqual([])
  })
})

describe("★ 换掉之后那些话仍然说得通（不是删空了）", () => {
  /**
   * ## 为什么要有这一组
   *
   * 上面四条只验"没有那个词"，而**把整句删掉**也能让它们全绿 ——
   * 那正是这个仓库栽过的那类假绿（断言在别处也能通过 / 缺席被读成删除）。
   *
   * 所以这里正面锁住替换后的词还在。挑的都是**这一批独有**的值。
   */
  it("四个步骤名都还在，且第 3/4 步换成了「学习」", () => {
    const get = (key: string) => ZH.find(([path]) => path === key)?.[1]
    expect(get("steps.channel")).toBe("连接平台")
    expect(get("steps.persona")).toBe("数字分身")
    expect(get("steps.sources")).toBe("学习范围")
    expect(get("steps.distill")).toBe("开始学习")
  })

  it("知识库那一块有标题，且说清它与上面那块的分工", () => {
    const get = (key: string) => ZH.find(([path]) => path === key)?.[1]
    expect(get("distillStep.graphTitle")).toBe("知识库")
    /**
     * ★ 判据挑「说过什么事」这半句。
     *
     * 它是这一块**独有**的 —— 而"怎么说话"在上面阶段条的说明里也有
     * （"统计怎么说话"），拿它当判据的话这条测试在这一块被删掉之后
     * **仍然会绿**。
     */
    expect(get("distillStep.graphHint")).toContain("说过什么事")
  })

  it("en 侧同步换了（不是只改了中文）", () => {
    const get = (key: string) => EN.find(([path]) => path === key)?.[1]
    expect(get("steps.sources")).toBe("Learning scope")
    expect(get("steps.distill")).toBe("Start learning")
    expect(get("distillStep.graphTitle")).toBe("Knowledge base")
  })

  /**
   * ★ 两侧的 key 集合必须一样。
   *
   * 换词时最容易犯的错是"改中文时顺手删了一个 key，英文那边还留着"——
   * 那时英文用户看到的是一句没被翻译的中文，或者一个 key 名。
   */
  it("zh 与 en 的 key 集合完全一致", () => {
    const zhKeys = new Set(ZH.map(([path]) => path))
    const enKeys = new Set(EN.map(([path]) => path))
    const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k))
    const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k))
    expect({ onlyZh, onlyEn }).toEqual({ onlyZh: [], onlyEn: [] })
  })
})
