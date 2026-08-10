/**
 * @vitest-environment jsdom
 *
 * 换渠道时清掉「被筛实体」。
 *
 * ## 实测的坏形态（用户截图 2026-08-09）
 *
 * 在钉钉点了图上某个人 → 联动带显示「关于 <某人>」、下面按他筛事实。
 * 切到飞书之后**那条带和筛选条件都没变** —— 而那个名字在飞书的图里
 * 根本不存在。两种结局都很糟：
 *
 * · 飞书没有同名实体 → 显示「0 条事实」，读起来像"飞书没数据"；
 * · 飞书恰好有同名实体 → 显示的是**另一个人**的事实，而界面上没有
 *   任何痕迹说这两个"他"不是一个人。
 *
 * 后者正是本仓库最贵的那类缺陷：不报错，只是答错，而答的是
 * 「这个人说过什么」这种会被当真的问题。
 *
 * ## 为什么门禁写成这个形状
 *
 * 清空逻辑是 `dashboard-module.tsx` 里一个 `useEffect(…, [scope.channelId])`，
 * 而那个组件依赖十几个 hook（渠道、采集快照、图谱、数字人…），整体渲染
 * 起来要 mock 一屏。判据本身很窄：**channelId 变了，两个 state 归零**。
 *
 * 所以这里用一个只带那段逻辑的探针组件：它与真实实现共用同一个 hook 调用
 * 形状（`useState` + 依赖 channelId 的 `useEffect`）。换掉真实实现的写法时
 * 这条不会自动红 —— 所以第三条用源码判据把 effect 本身钉住。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { useEffect, useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

afterEach(cleanup)

/** 与 `dashboard-module.tsx` 里那段同形：两个 state + 按 channelId 清空。 */
function FocusProbe({ channelId }: { channelId: string | undefined }) {
  const [entityFocus, setEntityFocus] = useState<string | null>(null)
  const [focusCount, setFocusCount] = useState<number | null>(null)
  useEffect(() => {
    setEntityFocus(null)
    setFocusCount(null)
  }, [channelId])
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setEntityFocus("A同学")
          setFocusCount(12)
        }}
      >
        pick
      </button>
      <span data-testid="focus">{entityFocus ?? "(none)"}</span>
      <span data-testid="count">{focusCount === null ? "(none)" : String(focusCount)}</span>
    </div>
  )
}

describe("换渠道时清掉被筛实体", () => {
  it("★★ 选中后换 channelId → 归零", () => {
    const { rerender } = render(<FocusProbe channelId="dingtalk" />)
    act(() => {
      screen.getByText("pick").click()
    })
    expect(screen.getByTestId("focus").textContent).toBe("A同学")
    expect(screen.getByTestId("count").textContent).toBe("12")

    rerender(<FocusProbe channelId="feishu" />)

    // ★ 核心判据：名字与计数都必须清掉
    expect(screen.getByTestId("focus").textContent).toBe("(none)")
    expect(screen.getByTestId("count").textContent).toBe("(none)")
  })

  it("★ 同一个渠道内重渲染**不**清（别把上面那条修成「点了就没」）", () => {
    const { rerender } = render(<FocusProbe channelId="dingtalk" />)
    act(() => {
      screen.getByText("pick").click()
    })
    rerender(<FocusProbe channelId="dingtalk" />)
    expect(screen.getByTestId("focus").textContent).toBe("A同学")
  })

  /**
   * ★★ 真实实现里那个 effect 还在，且依赖的是 `scope.channelId`。
   *
   * 上面两条测的是"这个形状对不对"，测不到"真实组件有没有用这个形状"。
   * 删掉那个 effect 时上面两条照样绿 —— 所以这一条盯源码。
   */
  it("★★ dashboard-module 里那个 effect 依赖 scope.channelId", () => {
    /**
     * ★ 用 `process.cwd()` 而不是 `import.meta.url`：这个文件跑在 jsdom 环境下，
     * 那时 `import.meta.url` 是 **http** scheme（vite 的 dev server 地址），
     * `fileURLToPath` 会抛 "The URL must be of scheme file"。
     * vitest 的 cwd 恒为仓库根。
     */
    const source = readFileSync(
      join(
        process.cwd(),
        "apps/desktop/src/renderer/features/dashboard/dashboard-module.tsx",
      ),
      "utf8",
    )
    // 剥注释 —— 注释里写了不等于代码里做了
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(
      code,
      "换渠道时必须清 entityFocus/focusCount —— 那个 useEffect 不见了",
    ).toMatch(/setEntityFocus\(null\)[\s\S]{0,120}setFocusCount\(null\)[\s\S]{0,80}scope\.channelId/)
  })
})
