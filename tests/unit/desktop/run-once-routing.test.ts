/**
 * ## ★★★ 「立即同步」必须只采**它那一个渠道**
 *
 * `runOnce(channelId)` 是状态页那个「立即同步」按钮的落点，而它**一条测试都
 * 没有** —— 这就是"点飞书的同步实际采了钉钉"这类问题能反复发生的原因。
 *
 * 判据与 kl 那组一致（`multi-kl-server.test.ts`）：不是断言"目标渠道被采了"，
 * 而是**反证另一个渠道一次都没被碰**。前者在"两个都采了"时也成立，
 * 而"两个都采了"正是要防的那个 bug（超范围采集是隐私问题，
 * 见 CLAUDE.md 第 5 节）。
 *
 * ## 为什么用真 `DataPlaneService` 而不是断言源码文本
 *
 * 这一层的错法是"路由分支写错"，而那种错在源码里长得完全正常
 * （`filter` 少一个条件、提前 return 的判据取错了对象）。只有真的跑一遍、
 * 数每个插件的 `pull` 被调了几次，才能看出打给了谁。
 */
import { describe, expect, it, vi } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type { ChannelPlugin, ChannelPullPage } from "@mycontext/channels"
import { DataPlaneService } from "@main/services/data-plane.service.js"
import type { FeedDirs, FeedService } from "@main/services/feed.service.js"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_700_000_000_000

const fakeFeed = {
  attach: async () => {},
  detach: async () => {},
} as unknown as FeedService

function emptyPage(): ChannelPullPage {
  return {
    conversations: [],
    messages: [],
    nextCursor: null,
    hasMore: false,
    itemCount: 0,
    rawPayload: "{}",
  }
}

/**
 * 造一个假渠道插件，并把它的 `pull` 暴露出来数调用次数。
 *
 * ★ `pull` 是"真的去问那个渠道的 CLI"的唯一入口 —— 它被调了几次，
 * 就等于那个渠道的 CLI 被打了几次。
 */
function makePlugin(channelId: string) {
  const pull = vi.fn(async () => emptyPage())
  const probe = vi.fn(async () => null)
  const plugin = {
    meta: { id: channelId },
    ingest: { probe, pull },
    /**
     * ★ 必须有 `auth.status` —— `attach` 会用它判"这个渠道授权了吗"，
     * 没授权的渠道**不起采集**（它的 CLI 会一直失败刷日志）。
     * 这里都给 authorized，否则两条采集都不会起，路由也就无从验证。
     */
    auth: {
      status: async () => ({
        state: "authorized" as const,
        corpId: "corpFAKE0001",
        corpName: "测试组织",
        userId: "userFAKE0001",
        userName: "测试用户",
        accessExpiresAt: null,
        refreshExpiresAt: null,
        daysUntilRefreshExpiry: null,
      }),
    },
  } as unknown as ChannelPlugin
  return { plugin, pull, probe }
}

/** 每个渠道各自的导出目录（本测试不真写，只要形状对）。 */
function dirs(root: string): FeedDirs {
  return {
    dataRoot: root,
    exportRoot: `${root}/exports`,
    klRoot: `${root}/kl`,
    handoffFile: `${root}/handoff.json`,
  } as FeedDirs
}

/**
 * 主渠道 + 一个非主渠道，两边都能数调用。
 *
 * ★ 非主渠道要**两处**都给：构造时的 `sources`（提供 plugin 与 feed）
 * 与 `attach` 的 `sourceAttachments`（提供它自己的库）。少任何一处
 * `sourceIngest` 里就没有这个渠道 —— 那正是真实链路里"管线没挂上"的形态。
 */
async function makePair() {
  const primary = makePlugin("dingtalk")
  const feishu = makePlugin("feishu")
  const primaryVault = openTestVault()
  const sourceVault = openTestVault()

  const service = new DataPlaneService({
    clock: new ManualClock(NOW),
    logger: createLogger("test-runonce", { level: "error" }),
    plugin: primary.plugin,
    feed: fakeFeed,
    getWindow: () => null,
    // ★ 关定时器：否则后台轮询会把调用次数搅乱
    autoStart: false,
    sources: () => [{ plugin: feishu.plugin, feed: fakeFeed }],
  })

  await service.attach(primaryVault.db, primaryVault.path, dirs(primaryVault.path), [
    {
      channelId: "feishu",
      db: sourceVault.db,
      dbPath: sourceVault.path,
      feedDirs: dirs(sourceVault.path),
    },
  ])

  return { service, primary, feishu, primaryVault, sourceVault }
}

describe("★★★ runOnce：立即同步只打指定渠道的 CLI", () => {
  it("★★★ runOnce('feishu') 不碰主渠道的 CLI", async () => {
    const { service, primary, feishu, primaryVault, sourceVault } = await makePair()
    service.activateChannel("dingtalk")
    service.activateChannel("feishu")
    primary.pull.mockClear()
    feishu.pull.mockClear()

    await service.runOnce("feishu")

    /**
     * ★★ 先反证"这个用例不是空跑"：目标渠道**确实被采了**。
     *
     * 少了这一条，上面那句 `not.toHaveBeenCalled` 在"两个渠道谁都没跑"
     * 时也会绿 —— 而那是另一个 bug（点了同步没反应），不是路由正确。
     */
    expect(feishu.pull).toHaveBeenCalled()
    expect(primary.pull).not.toHaveBeenCalled()
    await service.detach()
    primaryVault.close()
    sourceVault.close()
  })

  it("★★★ runOnce('dingtalk') 不碰飞书的 CLI", async () => {
    const { service, primary, feishu, primaryVault, sourceVault } = await makePair()
    service.activateChannel("dingtalk")
    service.activateChannel("feishu")
    primary.pull.mockClear()
    feishu.pull.mockClear()

    await service.runOnce("dingtalk")

    expect(primary.pull).toHaveBeenCalled()
    expect(feishu.pull).not.toHaveBeenCalled()
    await service.detach()
    primaryVault.close()
    sourceVault.close()
  })
})
