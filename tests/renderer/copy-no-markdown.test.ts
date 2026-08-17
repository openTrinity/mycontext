/**
 * 用户可见文案里**不许出现 markdown 标记**。
 *
 * ## ★★★ 为什么需要一道门禁（而不是"注意一下"）
 *
 * 这个仓库的注释与设计文档密度很高，且都用 `**加粗**` 强调判据。
 * 写界面文案时手会顺着同一个习惯写下去 —— 而 `t()` 的返回是**纯字符串**，
 * 渲染路径上没有任何 markdown 处理（例：`Disclosure` 的 `hint` 直接作为
 * 文本子节点，`packages/design/src/components/disclosure.tsx:84`）。
 *
 * 于是那两个星号**原样显示给用户**：
 *
 *     它**学**哪些历史：采多久、采哪些会话。
 *
 * ★ 这不是理论风险：写这道门禁时库里有**三处**，全部来自这个分支
 * 自己的改动（学习范围卡的 hint、收窄告知的标题、"都不盯"的状态行）。
 * 三处都通过了 typecheck / lint / 4881 条单测 —— 因为它们在类型上、
 * 行为上都完全正确，**只有人眼能发现**。所以判据必须自动化。
 *
 * ## 要强调怎么办
 *
 * 靠**词序**（关键词放句首）或拆成两句。中文界面文案本来就不该依赖
 * 加粗来传达语义 —— 一句话需要加粗才能读懂，通常说明该拆句。
 */
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = "apps/desktop/src/renderer"

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith(".tsx") || path.endsWith(".ts")) out.push(path)
  }
  return out
}

/**
 * 抽出所有 `defaultValue:` 后面那个**字符串字面量**。
 *
 * ★ 只看 `defaultValue`（而不是全文搜 `**`）：注释与 JSDoc 里的 `**`
 * 是正常的、也是这个仓库的风格。一条"连注释都不许写"的判据会逼人
 * 删掉解释，而那正是我们想留住的东西（`data-plane-runnables` 那次
 * 已经踩过：`not.toContain("commitProgress")` 把一段解释判成了违规）。
 */
function defaultValues(source: string): string[] {
  const out: string[] = []
  /**
   * 两种字面量都要看：
   *
   * · `defaultValue: "…"`（含 prettier 换行后的形态）；
   * · ★ `` defaultValue: `…` ``（带 `{{插值}}` 的文案用的是模板字符串 ——
   *   实测 `status-panel.tsx` 有 5 处，全是这种）。
   *
   * ★★ 而 `defaultValue: someVariable`（如 `defaultValue: slotKey`）**不看** ——
   * 那是"key 缺失时退回原始 key"的兜底，不是人写的文案。
   * 把它算进来只会让下面那个下界失去意义。
   */
  for (const re of [
    /defaultValue:\s*(?:\r?\n\s*)?"((?:[^"\\]|\\.)*)"/g,
    /defaultValue:\s*(?:\r?\n\s*)?`((?:[^`\\]|\\.)*)`/g,
  ]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) out.push(m[1] ?? "")
  }
  return out
}

describe("★★★ 界面文案不许含 markdown 标记（它会原样显示给用户）", () => {
  const files = walk(ROOT)

  it("★ 先确认这个扫描真的扫到了东西（否则下面那条恒绿）", () => {
    /**
     * ★★ 一条恒绿的门禁比没有门禁更糟：它给人"已经有人在看着"的错觉。
     * v2 的复盘里抓出过一条真的恒绿的用例，所以这里显式验证扫描面。
     */
    expect(files.length).toBeGreaterThan(50)
    const total = files.reduce(
      (sum, file) => sum + defaultValues(readFileSync(file, "utf8")).length,
      0,
    )
    /**
     * ★ 下界取 100 —— 实测当前扫到 **110** 条字面量文案。
     *
     * 全文 `defaultValue` 出现 123 次，差的 13 处是
     * `defaultValue: 某个变量`（key 缺失时退回原 key 的兜底，不是文案）
     * 与注释里提到这个名字的地方 —— 两者都**不该**算进来。
     *
     * ★★ 这个差值本身是我写这道门禁时的一个发现：第一版正则只认双引号，
     * 扫到 97 条，而带 `{{插值}}` 的文案用的是**模板字符串**
     * （`status-panel.tsx` 那 5 处）—— 也就是说漏掉了一整类。
     * 那正是这条"先确认扫到了东西"的用例要抓的形状。
     *
     * 取略低的整数而不是 `toBe(110)`：后者会让每加一句文案都来改数字，
     * 于是它很快被改成一个不再有意义的值。
     */
    expect(total).toBeGreaterThan(100)
  })

  it("★★★ 没有任何 `defaultValue` 含 `**`", () => {
    /**
     * 反证：把任一处文案改成 `"**强调**"` → 这条转红，且报出文件与原文。
     */
    const offenders: string[] = []
    for (const file of files) {
      for (const value of defaultValues(readFileSync(file, "utf8"))) {
        if (value.includes("**")) offenders.push(`${file}: ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("★★ 也不许含反引号包裹的代码标记（同一个理由）", () => {
    /**
     * `` `code` `` 在文案里同样会原样显示。而它比 `**` 更容易漏 ——
     * 写"把 `learning_eligible` 打成 0"这种解释性文案时几乎是本能。
     *
     * ★ 判据只挡**成对**的反引号：单个反引号可能是正常内容
     * （极少，但不值得为它误报）。
     */
    const offenders: string[] = []
    for (const file of files) {
      for (const value of defaultValues(readFileSync(file, "utf8"))) {
        if (/`[^`]+`/.test(value)) offenders.push(`${file}: ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
