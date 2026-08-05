/**
 * 传输层信封的剥离。
 *
 * ## 这是本轮那个故障的最小回归
 *
 * DWS 每个子命令的 JSON 都包在 `{arguments, errorCode, errorMsg, result, success}` 里。
 * 在 `DwsCli.json` 这一层剥掉，业务解析器就不必知道它存在 ——
 * 也就不会再出现「一处剥了、一处没剥」（实测探针剥了、正文没剥，
 * 于是 277 页响应落库 0 条且全程无报错）。
 */
import { describe, expect, it } from "vitest"
import { isAppError } from "@mycontext/kernel"
import { unwrapEnvelope } from "@mycontext/channels"
import {
  REAL_GET_SELF,
  REAL_LIST_ALL_PAGE,
  REAL_MINUTES_LIST,
  REAL_USER_SEARCH,
} from "../../fixtures/dingtalk-real-payloads.js"

describe("信封剥离", () => {
  it("★ chat message list-all：拿到 result 的内容", () => {
    const inner = unwrapEnvelope(REAL_LIST_ALL_PAGE) as Record<string, unknown>
    expect(inner["conversationMessagesList"]).toBeDefined()
    expect(inner["hasMore"]).toBe(false)
    // 信封字段不该泄漏到业务层
    expect(inner["success"]).toBeUndefined()
    expect(inner["arguments"]).toBeUndefined()
  })

  it("★ result 是**数组**时也正确返回（get-self / search 实测如此）", () => {
    const self = unwrapEnvelope(REAL_GET_SELF)
    expect(Array.isArray(self)).toBe(true)
    expect((self as unknown[]).length).toBe(1)

    const candidates = unwrapEnvelope(REAL_USER_SEARCH)
    expect(Array.isArray(candidates)).toBe(true)
    // 同名同姓多条 —— 这正是"只按 userId 精确匹配"的由来
    expect((candidates as unknown[]).length).toBeGreaterThan(1)
  })

  it("minutes 的信封多了 errorCode/errorMsg，同样剥掉", () => {
    const inner = unwrapEnvelope(REAL_MINUTES_LIST) as Record<string, unknown>
    expect(inner["itemList"]).toBeDefined()
    expect(inner["errorCode"]).toBeUndefined()
  })

  it("★ errorCode 非空 → 抛错（exit 0 但业务失败的唯一信号）", () => {
    expect(() =>
      unwrapEnvelope({ success: false, errorCode: "40035", errorMsg: "参数错误", result: null }),
    ).toThrow()
    try {
      unwrapEnvelope({ success: true, errorCode: "50001", errorMsg: "内部错误", result: null }, [
        "minutes",
        "list",
        "all",
      ])
      expect.unreachable("应当抛错")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      // 归类成可重试：业务错误多半是瞬时的，不该要求用户介入
      if (isAppError(error)) expect(error.retryable).toBe(true)
    }
  })

  it("success:false 且无 errorCode → 仍然抛错（不能当成空数据）", () => {
    expect(() => unwrapEnvelope({ success: false, result: null })).toThrow()
  })

  it("errorCode 为 null / 空串不算错误（实测 minutes 正常时就是 null）", () => {
    expect(unwrapEnvelope({ success: true, errorCode: null, result: { ok: 1 } })).toEqual({ ok: 1 })
    expect(unwrapEnvelope({ success: true, errorCode: "", result: { ok: 2 } })).toEqual({ ok: 2 })
  })

  it("★ 没有信封的输入原样返回（幂等 —— 重放已剥过的数据不能出错）", () => {
    const plain = { conversationMessagesList: [] }
    expect(unwrapEnvelope(plain)).toBe(plain)
    // 只有 result 没有 success：不是信封（某些业务对象本身就叫 result）
    const notEnvelope = { result: { a: 1 } }
    expect(unwrapEnvelope(notEnvelope)).toBe(notEnvelope)
    // 只有 success 没有 result
    const onlySuccess = { success: true }
    expect(unwrapEnvelope(onlySuccess)).toBe(onlySuccess)
  })

  it("数组 / 原始值 / null 原样返回", () => {
    const arr = [1, 2, 3]
    expect(unwrapEnvelope(arr)).toBe(arr)
    expect(unwrapEnvelope(null)).toBeNull()
    expect(unwrapEnvelope("text")).toBe("text")
    expect(unwrapEnvelope(42)).toBe(42)
  })
})
