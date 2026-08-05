/**
 * 画像 facet 仓储的门禁。
 *
 * ## 两条不变式
 *
 * 1. **无证据不入库。** 这是可信度与可审计的底线，不是可配置项 ——
 *    用户在审阅页点开一条结论要能看到"这是从哪几句话得出的"。
 *    允许无证据的结论进来，等于允许模型往画像里写它想出来的东西。
 *    守卫在两处（`assertHasEvidence` 与这里），因为一旦破了，
 *    整个功能的可信度基础就没了。
 *
 * 2. **改动前留档。** 每次 update 往 `profile_facet_revisions` 写旧值。
 *    没有它，用户看到一个奇怪的结论时无从判断它是哪一轮写进去的。
 *
 * 另外锁 `(facet, scope, scope_ref, key)` 的唯一定位 —— 那是增量合并的
 * 前提；以及 `scope_ref` 空串（不是 null）：可空列参与 UNIQUE 时
 * 那些行的唯一性完全不生效，而 global 恰恰是画像的主要来源。
 */
import { describe, expect, it } from "vitest"
import { ProfileFacetRepository } from "@mycontext/store"
import { isAppError } from "@mycontext/kernel"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_785_000_000_000

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: "f1",
    facet: "tone",
    scope: "global",
    scopeRef: "",
    key: "formality",
    value: "偏随意",
    confidence: 0.8,
    evidence: ["m1", "m2"],
    source: "llm" as const,
    ...overrides,
  }
}

describe("★ 无证据不入库", () => {
  it("空证据数组直接抛 DISTILL_NO_EVIDENCE", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)
    expect(() => repo.write(base({ evidence: [] }), NOW)).toThrow()
    try {
      repo.write(base({ evidence: [] }), NOW)
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("DISTILL_NO_EVIDENCE")
    }
    // 而且**没有**写进去（不是"抛了但半条已经落库"）
    expect(repo.count()).toBe(0)
    vault.close()
  })
})

describe("★ 唯一定位：同一个 (facet, scope, scope_ref, key) 只有一行", () => {
  it("第二次写同一个键是 update 而不是新增一行", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)

    const first = repo.write(base(), NOW)
    expect(first.inserted).toBe(true)
    expect(first.revision).toBe(1)

    const second = repo.write(base({ id: "f2", value: "偏正式" }), NOW + 1000)
    expect(second.inserted).toBe(false)
    expect(second.revision).toBe(2)
    // ★ 只有一行 —— 堆两行会让"哪行是当前值"无法判定
    expect(repo.count()).toBe(1)
    vault.close()
  })

  it("key 不同就是两行", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)
    repo.write(base(), NOW)
    repo.write(base({ id: "f2", key: "sentence_length" }), NOW)
    expect(repo.count()).toBe(2)
    vault.close()
  })

  it("★ global 的 scope_ref 是空串（不是 null）—— 否则 UNIQUE 在 global 行上失效", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)
    repo.write(base(), NOW)
    repo.write(base({ id: "f2", value: "变了" }), NOW + 1)
    /**
     * 如果 scope_ref 允许 null 且我们写了 null，SQLite 的 UNIQUE
     * 不会约束这些行（NULL 互不相等）—— 于是同一条结论堆成两行，
     * 而两行都"看起来正常"。这条断言是那个陷阱的守卫。
     */
    const row = repo.find("tone", "global", "", "formality")
    expect(row?.scopeRef).toBe("")
    expect(repo.count()).toBe(1)
    vault.close()
  })
})

describe("★ 改动前留档", () => {
  it("update 会把旧值写进 revisions", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)
    repo.write(base({ value: "第一版" }), NOW)
    repo.write(base({ value: "第二版" }), NOW + 1000)
    repo.write(base({ value: "第三版" }), NOW + 2000)

    const history = repo.revisions("f1")
    // 两次 update → 两条历史（第一版与第二版）
    expect(history).toHaveLength(2)
    expect(history.map((item) => JSON.parse(item.valueJson))).toEqual(["第二版", "第一版"])
    // 当前值是第三版
    expect(JSON.parse(repo.find("tone", "global", "", "formality")?.valueJson ?? "null")).toBe(
      "第三版",
    )
    vault.close()
  })

  it("首次 insert 不产生历史（没有旧值可留）", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)
    repo.write(base(), NOW)
    expect(repo.revisions("f1")).toHaveLength(0)
    vault.close()
  })

  it("删除结论时版本链跟着删（不留孤儿）", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)
    repo.write(base({ value: "v1" }), NOW)
    repo.write(base({ value: "v2" }), NOW + 1)
    expect(repo.revisions("f1")).toHaveLength(1)

    expect(repo.remove("f1")).toBe(true)
    /**
     * CASCADE 删掉版本链：留着孤儿没有消费者会读，
     * 只会让"审计链断裂"在无人察觉的情况下发生（见 v6 迁移的注释）。
     */
    expect(repo.revisions("f1")).toHaveLength(0)
    expect(repo.count()).toBe(0)
    vault.close()
  })
})

describe("按 scope 读（materializer 渲染时用）", () => {
  it("只返回该 scope 的行", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)
    repo.write(base(), NOW)
    repo.write(base({ id: "f2", scope: "conversation", scopeRef: "cid-1", key: "group_tone" }), NOW)

    expect(repo.listByScope("global").map((row) => row.key)).toEqual(["formality"])
    expect(repo.listByScope("conversation", "cid-1").map((row) => row.key)).toEqual(["group_tone"])
    // 会话 scope 但 ref 不匹配 → 空
    expect(repo.listByScope("conversation", "cid-other")).toHaveLength(0)
    vault.close()
  })
})

describe("冲突与时间窗照实存", () => {
  it("conflict 存进 conflict_json，读回来结构不变", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)
    repo.write(base(), NOW)
    repo.write(
      base({ value: "偏正式", conflict: { existing: "偏随意", candidate: "偏正式" } }),
      NOW + 1,
    )
    const row = repo.find("tone", "global", "", "formality")
    expect(JSON.parse(row?.conflictJson ?? "null")).toEqual({
      existing: "偏随意",
      candidate: "偏正式",
    })
    vault.close()
  })

  it("update 不传 window 时保留原值（不该被擦成 null）", () => {
    const vault = openTestVault()
    const repo = new ProfileFacetRepository(vault.db)
    repo.write(base({ windowStart: NOW - 1000, windowEnd: NOW }), NOW)
    repo.write(base({ value: "变了" }), NOW + 1)
    const row = repo.find("tone", "global", "", "formality")
    /**
     * 擦成 null 会丢掉"这条结论是从哪个时间窗得出的" ——
     * 而那是判断结论是否过时的唯一依据。
     */
    expect(row?.windowStart).toBe(NOW - 1000)
    expect(row?.windowEnd).toBe(NOW)
    vault.close()
  })
})
