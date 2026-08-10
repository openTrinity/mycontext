/**
 * 学习范围里「单聊/群聊」的**筛选**：关键字常驻 + 群人数档位。
 *
 * ## 为什么读源码而不是渲染组件
 *
 * `SourcesStep` 那棵树要 `useChannelConversations`（一次真渠道子进程调用）
 * 与一堆 IPC，jsdom 起不来。整体交互靠 CDP 在真应用里验。而下面这几条是
 * **静态可判**的纯逻辑与结构约束，改坏了不报错、只是筛选悄悄失灵 ——
 * 正是最该有门禁的地方。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { inMemberBucket, type MemberBucket } from "@renderer/features/onboarding/sources-step"

const SRC = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/onboarding/sources-step.tsx"),
  "utf8",
)

describe("★★ 群人数档位判据 inMemberBucket", () => {
  /**
   * ★★★ 未知人数（null）在**任何**档都通过 —— 这是主判据。
   *
   * 群列表接口当前对所有群都不返回人数（实测 100% null）。若把 null 当成
   * 不匹配筛掉，一选档位就把整组群清空 —— 那是"筛选把数据静默弄没了"。
   * 反证：把这一条改成 null→false，断言转红。
   */
  it("★★★ null 人数在任何档都通过（不筛掉未知）", () => {
    const buckets: MemberBucket[] = ["all", "0-100", "101-200", "201+"]
    for (const b of buckets) expect(inMemberBucket(null, b)).toBe(true)
  })

  it("★ all 档恒通过", () => {
    expect(inMemberBucket(5, "all")).toBe(true)
    expect(inMemberBucket(9999, "all")).toBe(true)
  })

  it("★★ 边界：100 属 0-100，101 属 101-200，200 属 101-200，201 属 201+", () => {
    expect(inMemberBucket(100, "0-100")).toBe(true)
    expect(inMemberBucket(101, "0-100")).toBe(false)
    expect(inMemberBucket(101, "101-200")).toBe(true)
    expect(inMemberBucket(200, "101-200")).toBe(true)
    expect(inMemberBucket(201, "101-200")).toBe(false)
    expect(inMemberBucket(201, "201+")).toBe(true)
    expect(inMemberBucket(200, "201+")).toBe(false)
  })

  it("★ 相邻档不重叠（1..∞ 每个数只落一个具体档）", () => {
    for (const n of [1, 50, 100, 101, 150, 200, 201, 500]) {
      const hits = (["0-100", "101-200", "201+"] as MemberBucket[]).filter((b) =>
        inMemberBucket(n, b),
      )
      expect(hits.length).toBe(1)
    }
  })
})

describe("★★ 搜索框不再有会话数量门槛", () => {
  /**
   * 原来搜索框只在 `items.length > COLLAPSED_ROWS` 时渲染 —— 会话少时想搜
   * 也搜不了，且"有时有有时没有"让人以为坏了。用户明确要"加关键字筛选"，
   * 所以改成始终显示。判据剥掉注释再比（注释里解释了这段历史，不剥会自匹配）。
   */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

  it("★★ 渲染搜索框的条件不再是 items.length > COLLAPSED_ROWS", () => {
    // 那个旧门槛条件不该再出现在代码里
    expect(code).not.toMatch(/items\.length > COLLAPSED_ROWS[\s\S]{0,40}<Input/)
  })

  it("★ 关键字过滤仍作用在 visible（与全选同源）", () => {
    // visible 里既有关键字判定也有人数档位判定
    expect(code).toMatch(/matchesKeyword && inMemberBucket/)
  })
})
