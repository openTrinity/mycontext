/**
 * ★ 「降级必须可见」这条原则的门禁。
 *
 * ## 为什么需要它
 *
 * 搜索模块的降级横幅判据原先是 `tryResolveOpencode() !== null`
 * —— 那回答的是「opencode **装了没有**」（能力是否具备），
 * 而 UI 要回答的是「这次**实际走了哪条路**」。
 *
 * 两者脱钩时会得到最坏的组合：本机装了 opencode → `agentAvailable` 为 true
 * → 横幅**不显示**；可 `prompt()` 里根本没有 agent 分支、实际仍走 `recallOnly`。
 * 于是「既没走 agent、也没告诉用户在降级」——
 * 而这正是本模块最想避免的那种状态（"答案质量变差"比"明确告知降级"难查得多）。
 *
 * 这条断言的是**不变式**而非实现细节：
 * `agentAvailable` 报的值必须与 `prompt` 实际走的路一致。
 * ACP 接线完成后这条测试会因为"声称走 agent 但产出仍是 recall"而变红 ——
 * 那正是它该提醒的时刻。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SERVICE = join(
  import.meta.dirname,
  "../../../apps/desktop/src/main/services/search.service.ts",
)

describe("★ 搜索降级的可见性", () => {
  const source = readFileSync(SERVICE, "utf8")

  it("agentAvailable 不能只探测二进制（那是能力，不是实际路径）", () => {
    // 允许它作为**必要条件**之一出现，但不能是唯一判据。
    const returnsOnlyProbe =
      /agentAvailable\(\)\s*:\s*boolean\s*\{\s*return\s+this\.options\.runtime\.tryResolveOpencode\(\)\s*!==\s*null\s*\}/s
    expect(
      returnsOnlyProbe.test(source),
      "agentAvailable 直接返回 tryResolveOpencode() 会让「装了 opencode 但 ACP 未接线」" +
        "这个真实状态显示成「未降级」—— 判据必须跟实际走的路走。",
    ).toBe(false)
  })

  it("存在一个显式的「ACP 是否已接线」开关，且与 prompt 的实际分支一致", () => {
    expect(source).toContain("ACP_WIRED")

    const wiredFalse = /ACP_WIRED\s*=\s*false/.test(source)
    // prompt 里是否真的存在 agent 分支（接线后会出现）。
    // 用 recallOnly 是否为唯一产出来判定。
    const promptUsesRecallOnly = /this\.recallOnly\(/.test(source)

    if (!wiredFalse) {
      // 声称接线了 → prompt 里必须有别的路径，不能只有 recallOnly
      expect(
        /ensureSession|AcpSupervisor|acp\./i.test(source),
        "ACP_WIRED 为 true 但 prompt 里看不到任何 agent 调用 —— 二者必须同时改。",
      ).toBe(true)
    } else {
      // 声称没接线 → 产出应当就是 recallOnly（否则这个开关是误导）
      expect(promptUsesRecallOnly).toBe(true)
    }
  })
})
