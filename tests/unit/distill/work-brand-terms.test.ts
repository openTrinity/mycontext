/**
 * ★ 脱敏名单里的商标必须与 `check:trademarks` 门禁一致。
 *
 * ## 为什么这条测试存在
 *
 * work 层的脱敏名单（`distill.service.ts` 的 `FORBIDDEN_BRAND_TERMS`）与
 * 门禁脚本（`scripts/check-trademarks.mjs` 的 `FORBIDDEN`）**各存一份**。
 *
 * 共享一个常量本来更好，但那意味着让门禁脚本 import 应用代码 —— 它是独立的
 * node 脚本、跑在构建之前（`pnpm run check:all` 不依赖 `tsc`），那个耦合更糟。
 *
 * 于是代价是两份会漂。而漂的后果是**静默的**：门禁新增一个商标之后，
 * work 层仍然会把它写进 `work.md`，而那个文件若被导出并进仓库，门禁才报红
 * —— 中间隔了几步，没人会把两件事联系起来。这条测试把那个距离缩到零。
 *
 * ★ 两边都按片段拼装字符串（`"q" + "oder"`），否则**文件自己**会命中门禁。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..")

/** 从源码里把拼装式的字面量还原出来 —— 两边用同一个解析。 */
function extractTerms(source: string, marker: string): string[] {
  /**
   * ★ 从**最后一次**出现处找起。
   *
   * 两个文件里 marker 都先出现在解释性注释里（注释里会提到这个常量名），
   * 而真正的定义在后面。取第一次会解析到注释里那段散文，于是拿到空数组
   * —— 那样这条测试会变成"永远绿"（`gate.length > 0` 会先失败，但如果
   * 只解析错了一边，就是静默放行）。
   */
  const start = source.lastIndexOf(marker)
  if (start < 0) return []
  /**
   * 取 marker 之后 `=` 之后的那个 `[` —— **不能**直接找第一个 `[`：
   * 类型标注 `readonly string[]` 里就有一对，那会让解析取到空内容
   * （`string[]` 的 `[` 与 `]` 相邻）。实测踩过这个。
   */
  const eq = source.indexOf("=", start)
  const open = source.indexOf("[", eq < 0 ? start : eq)
  const close = source.indexOf("]", open)
  if (open < 0 || close < 0) return []
  const body = source.slice(open + 1, close)
  return (
    body
      .split(",")
      // `"q" + "oder"` → 去掉引号与加号，拼回一个词
      .map((part) => part.replace(/["'\s+]/g, ""))
      .filter((term) => term !== "")
  )
}

describe("★ 脱敏名单与商标门禁不许漂", () => {
  it("★ work 层的商标名单 ⊇ check:trademarks 拦的那些", () => {
    const gate = extractTerms(
      readFileSync(join(REPO_ROOT, "scripts/check-trademarks.mjs"), "utf8"),
      "const FORBIDDEN",
    )
    const workLayer = extractTerms(
      readFileSync(join(REPO_ROOT, "apps/desktop/src/main/services/distill.service.ts"), "utf8"),
      "FORBIDDEN_BRAND_TERMS: readonly string[]",
    )

    expect(gate.length, "门禁名单解析不出来 —— 那个脚本的结构变了").toBeGreaterThan(0)
    const missing = gate.filter((term) => !workLayer.includes(term))
    expect(
      missing,
      "门禁拦这些商标，而 work 层会把它们写进 work.md（导出后才报红，中间隔了几步）",
    ).toEqual([])
  })
})
