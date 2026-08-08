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

  /**
   * ## ★★ 这一条是实测抓到的真实坏输入（`auth login` 不带 `--json`）
   *
   * 那段提示里有**中文全角括号与半角括号**、还有引号里的命令行，
   * 而 `extractLarkJson` 是"逐个候选起点试到能 parse 为止"的贪心 ——
   * 提示文本越复杂，越可能有某个起点恰好能 parse 出一个**不完整**的东西。
   *
   * 修法是调用方带上 `--json`（见 `feishu.test.ts` 里那条断言），
   * 但这一层仍然要能扛住：升级上游 CLI 时提示文本随时会变，
   * 而"解析失败"在授权这条路上表现为"明明成功了却报错"。
   */
  it("★★ auth login 的完整人类可读输出（提示 + 等待行 + JSON）", () => {
    const real = `[AI agent] 此命令最长阻塞约 10 分钟，等待用户在浏览器内完成授权。请确保 runner 的 timeout >= 600s。若你的 harness 只会把最终回复发给用户，请改用 "lark-cli auth login --no-wait --json" 拿到 device_code 和 verification_url（把 verification_url 作为本轮最终消息）。**必须生成二维码并展示**: 调用 lark-cli auth qrcode 转为二维码。
等待用户授权...
{"ok":false,"error":{"type":"authentication","message":"authorization failed"}}`
    expect(extractLarkJson(real)).toEqual({
      ok: false,
      error: { type: "authentication", message: "authorization failed" },
    })
  })
})
