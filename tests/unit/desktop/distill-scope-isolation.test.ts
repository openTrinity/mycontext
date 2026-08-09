/**
 * ## ★★★ 保存一个渠道的范围，绝不能动另一个渠道的库
 *
 * 这是一次**真实数据丢失**的回归锁。用户在飞书的采集范围面板点「保存范围」，
 * 结果钉钉的会话白名单被清空（9 个 → 0 个），之后钉钉按「不设限」重采 ——
 * 消息从 1730 涨到 3921（92 个会话全采）。那是超范围采集，
 * CLAUDE.md 第 5 节明确点名的隐私问题。
 *
 * 根因是旧的 `save()` 形状：主渠道的白名单走 `scope.conversationIds`、
 * 其余渠道走 `perChannelConversationIds` 映射，而服务层**一次写所有库**。
 * 于是渲染层在飞书那栏判 `isPrimary=false` → `scope` 里不带
 * `conversationIds` → 服务层把这个 scope 原样 upsert 进**主库**。
 *
 * ## 判据：保存前后另一个库那一行**逐字段相等**
 *
 * 不是"另一个库还有 chat 行"（那在被覆盖成空 scope 时也成立），
 * 而是把整行读出来比对 —— 尤其 `conversationIds` 的**内容**。
 *
 * 用真 sqlite 而不是假 repo：这个 bug 的形状是"写进了另一个库"，
 * 而假 repo 天然只有一个存储，那种错误根本表现不出来。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import { isAppError } from "@mycontext/kernel"
import type { ChannelPlugin } from "@mycontext/channels"
import { DistillSourceRepository } from "@mycontext/store"
import { DistillSourceService } from "@main/services/distill-source.service.js"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_700_000_000_000
const PRIMARY = "dingtalk"
const SOURCE = "feishu"

/** 值全是编的（CLAUDE.md §1.2）：形状真、内容假。 */
const PRIMARY_CONVS = ["cidFAKE0001==", "cidFAKE0002==", "cidFAKE0003=="]
const SOURCE_CONVS = ["ocFAKE0001", "ocFAKE0002"]

let dir: string
let primaryVault: ReturnType<typeof openTestVault>
let sourceVault: ReturnType<typeof openTestVault>
let service: DistillSourceService
/** `onScopeChanged` 收到的渠道 —— 回调必须带上它（见下面那条用例）。 */
let scopeChangedFor: string[]

const plugin = { meta: { id: PRIMARY } } as unknown as ChannelPlugin

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mycontext-scope-"))
  primaryVault = openTestVault()
  sourceVault = openTestVault()
  scopeChangedFor = []
  service = new DistillSourceService({
    clock: new ManualClock(NOW),
    logger: createLogger("test-scope", { level: "error" }),
    plugin,
    primaryChannelId: PRIMARY,
    onScopeChanged: (channelId) => scopeChangedFor.push(channelId),
  })
  service.attach(primaryVault.db, [{ channelId: SOURCE, db: sourceVault.db }])
})

afterEach(() => {
  primaryVault.close()
  sourceVault.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 直接从某个库里读出 chat 那一行的范围。 */
function scopeOf(vault: ReturnType<typeof openTestVault>) {
  return new DistillSourceRepository(vault.db).list().find((row) => row.kind === "chat")?.scope
}

describe("★★★ 采集范围按渠道隔离", () => {
  it("★★★ 保存飞书的范围，主库的 conversationIds 一字不动", () => {
    // 先把主渠道的白名单存好（模拟用户在引导里勾了 3 个会话）
    service.save({
      channelId: PRIMARY,
      kind: "chat",
      enabled: true,
      scope: { since: NOW - 86_400_000, chatKinds: ["direct", "group"], conversationIds: PRIMARY_CONVS },
    })
    const before = scopeOf(primaryVault)
    expect(before?.conversationIds).toEqual(PRIMARY_CONVS)

    // ★ 现在保存**飞书**的范围 —— 这一步曾经清空主库那份白名单
    service.save({
      channelId: SOURCE,
      kind: "chat",
      enabled: true,
      scope: { since: NOW - 7 * 86_400_000, chatKinds: ["direct"], conversationIds: SOURCE_CONVS },
    })

    // 核心断言：主库那一行**逐字段**没变
    expect(scopeOf(primaryVault)).toEqual(before)
    // 反证不是空跑：飞书那份确实写进去了，且是它自己的 id
    expect(scopeOf(sourceVault)?.conversationIds).toEqual(SOURCE_CONVS)
  })

  it("★★★ 反过来也成立：保存主渠道不动飞书的白名单", () => {
    service.save({
      channelId: SOURCE,
      kind: "chat",
      enabled: true,
      scope: { since: NOW, chatKinds: ["direct"], conversationIds: SOURCE_CONVS },
    })
    const before = scopeOf(sourceVault)

    service.save({
      channelId: PRIMARY,
      kind: "chat",
      enabled: true,
      scope: { since: NOW, chatKinds: ["group"], conversationIds: PRIMARY_CONVS },
    })

    expect(scopeOf(sourceVault)).toEqual(before)
    expect(scopeOf(primaryVault)?.conversationIds).toEqual(PRIMARY_CONVS)
  })

  /**
   * ★★ 白名单**永远**在 `scope.conversationIds` 里，不再分主/非主两种形状。
   *
   * 旧形状要求调用方"记住自己是谁，并把 id 放进对应的位置"——
   * 而它记错的表现就是上面那次数据丢失。这条锁住新形状：
   * 非主渠道的 id 也走同一个字段。
   */
  it("★★ 非主渠道的白名单也走 scope.conversationIds（不是另一个映射字段）", () => {
    service.save({
      channelId: SOURCE,
      kind: "chat",
      enabled: true,
      scope: { conversationIds: SOURCE_CONVS },
    })
    expect(scopeOf(sourceVault)?.conversationIds).toEqual(SOURCE_CONVS)
  })

  /**
   * ★★★ 回调必须带渠道 —— 接线那侧靠它决定重建**谁的**图。
   *
   * 不带的话那侧只能对主渠道动手：实测日志
   * `[Main:KlServer] graph build started` + `dataDir: …/kl`
   * （飞书的图在 `…/kl/feishu`）—— 保存飞书的范围删掉了钉钉的图。
   */
  it("★★★ onScopeChanged 收到的是保存的那个渠道", () => {
    service.save({
      channelId: SOURCE,
      kind: "chat",
      enabled: true,
      scope: { since: NOW - 999, conversationIds: SOURCE_CONVS },
    })
    expect(scopeChangedFor).toEqual([SOURCE])

    service.save({
      channelId: PRIMARY,
      kind: "chat",
      enabled: true,
      scope: { since: NOW - 888, conversationIds: PRIMARY_CONVS },
    })
    expect(scopeChangedFor).toEqual([SOURCE, PRIMARY])
  })

  /**
   * ★ 范围没实质变化时不触发回调 —— 那条链是分钟级的（清语料 + 重建图谱），
   * 而引导页每点一次「下一步」都会把九个源各存一遍。
   */
  it("★ 范围没变不触发回调（否则每点一次下一步就重建一轮图）", () => {
    const scope = { since: NOW - 100, chatKinds: ["direct" as const], conversationIds: SOURCE_CONVS }
    service.save({ channelId: SOURCE, kind: "chat", enabled: true, scope })
    expect(scopeChangedFor).toEqual([SOURCE])
    service.save({ channelId: SOURCE, kind: "chat", enabled: true, scope })
    expect(scopeChangedFor).toEqual([SOURCE])
  })

  /**
   * ★★★ 指到一个**没挂管线**的渠道 → 抛错，而不是静默写进主库。
   *
   * "静默写进主库"正是这次事故的形状。宁可让 UI 显示保存失败 ——
   * 那时用户会重试或报告，而静默写错库没有任何信号。
   */
  it("★★★ 未挂载的渠道抛错，绝不落回主库", () => {
    const before = scopeOf(primaryVault)
    expect(() =>
      service.save({
        channelId: "unknown-channel",
        kind: "chat",
        enabled: true,
        scope: { conversationIds: ["xFAKE0001"] },
      }),
    ).toThrow()
    try {
      service.save({
        channelId: "unknown-channel",
        kind: "chat",
        enabled: true,
        scope: { conversationIds: ["xFAKE0001"] },
      })
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("CHANNEL_UNSUPPORTED")
    }
    // 主库一点没被碰
    expect(scopeOf(primaryVault)).toEqual(before)
  })
})
