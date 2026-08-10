/**
 * 会话列表在「库还没挂上」时**降级而不是抛错**，且能自己恢复。
 *
 * ## 锁的是哪个 bug
 *
 * 截图上那条红字「数据库不可用」（`DB_UNAVAILABLE`）来自
 * `DistillSourceService.conversations()` 里无条件的 `requireDb()` ——
 * 主渠道那一桶是硬编码进 targets 数组的。
 *
 * 授权流程里存在一个「身份已绑、vault 还没挂完」的窗口。渲染层在授权成功
 * 后会把缓存全部作废并立刻重取（那个全失效本身是对的，它修的是"授权后
 * 列表停在授权前那份空结果"），而重取正好落在这个窗口里就抛了 ——
 * 于是整块变红字，连另一个已挂上的渠道的会话都拿不到。
 *
 * 更糟的是它**不会自己恢复**：那一刻之后没有下一次失效事件。
 *
 * ## 判据
 *
 * 「库还没挂上」不是错误，是**还没准备好** —— 与"渠道没有列举能力"同一类：
 * 能给多少给多少，并用 `truncated` 说清这不是全集。
 */
import { describe, expect, it, vi } from "vitest"
import { DistillSourceService } from "@main/services/distill-source.service"
import type { ChannelPlugin } from "@mycontext/channels"

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

/** 一个只有列举能力的渠道桩（这一组验的是合并/降级，与渠道身份无关）。 */
function plugin(
  id: string,
  items: { externalId: string; title: string; kind: "direct" | "group" }[],
) {
  return {
    meta: { id, displayName: id },
    conversations: { list: () => Promise.resolve({ items, truncated: false }) },
  } as unknown as ChannelPlugin
}

function service(options: Partial<Parameters<typeof DistillSourceService>[0]> = {}) {
  return new DistillSourceService({
    plugin: plugin("dingtalk", []),
    clock: { now: () => 0 },
    logger: logger(),
    ...options,
  } as unknown as Parameters<typeof DistillSourceService>[0])
}

describe("★★ 主渠道库没挂上时的会话列表", () => {
  /**
   * ★★★ 这条是那个 bug 的直接反面。
   * 反证：把 targets 第一项改回 `db: this.requireDb()` → 抛 DB_UNAVAILABLE，必红。
   */
  it("★★★ 库没挂上 → 不抛错，返回空列表并标 truncated", async () => {
    const svc = service()
    // 从没 attach 过 → this.db === null
    const view = await svc.conversations()
    expect(view.items).toEqual([])
    // ★ 必须标截断：否则 0 项会被读成"这个账号真的没有会话"
    expect(view.truncated).toBe(true)
  })

  /**
   * ★★ 库没挂上**不影响**已挂上的其他渠道 —— 原来那个 throw 会让整块不可用。
   */
  it("★★ 库没挂上时，另一个已挂渠道的会话仍然列得出来", async () => {
    const log = logger()
    const svc = service({
      logger: log,
      sourcePlugins: () => [
        plugin("feishu", [{ externalId: "ocFAKE0001", title: "群 A", kind: "group" }]),
      ],
    })
    // 非主渠道的库直接塞进去（主渠道仍是 null）
    ;(svc as unknown as { sourceDbs: Map<string, unknown> }).sourceDbs.set("feishu", {
      prepare: () => ({ all: () => [] }),
    })

    const view = await svc.conversations()
    expect(view.items.map((i) => i.externalId)).toEqual(["ocFAKE0001"])
    expect(view.items[0]?.channelId).toBe("feishu")
    expect(view.truncated).toBe(true)
    // ★ 降级要留痕：空列表必须能在日志里区分"真没会话"与"库还没挂上"
    expect(log.warn.mock.calls.some((c) => String(c[0]).includes("primary db not attached"))).toBe(
      true,
    )
  })
})
