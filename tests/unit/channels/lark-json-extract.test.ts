import { describe, expect, it } from "vitest"
import { extractLarkJson } from "@mycontext/channels"

describe("extractLarkJson 剥前缀", () => {
  it("★ [AI agent] 提示 + JSON（真实形态）", () => {
    const real = `[AI agent] This command blocks for up to ~10 minutes while waiting for the user to authorize in their browser. Use "lark-cli auth login --no-wait --json" [do not retry].
{"ok":true,"data":{"device_code":"abc","verification_url":"https://x"}}`
    expect(extractLarkJson(real)).toEqual({
      ok: true,
      data: { device_code: "abc", verification_url: "https://x" },
    })
  })
  it("notice 行在前", () => {
    expect(extractLarkJson('notice: my_edit_time [hour-level]\n{"ok":true}')).toEqual({ ok: true })
  })
  it("真数组照旧", () => {
    expect(extractLarkJson('[{"a":1}]')).toEqual([{ a: 1 }])
  })
  it("★ 纯噪音抛 AppError 而不是裸 SyntaxError", () => {
    expect(() => extractLarkJson("[AI agent] nothing here")).toThrow(/无法解析/)
  })
})
