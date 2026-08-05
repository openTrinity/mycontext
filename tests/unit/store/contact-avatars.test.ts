/**
 * 头像缓存的重试语义 + v11 数据修复。
 *
 * ## ★ 这里锁的是「终态」不能钉死一个**错的**答案
 *
 * `needsFetch` 的设计是对的：`no_common_group` / `no_avatar_set` 是终态，
 * 重试永远得到同一个答案，不记下来就会每次打开页面对几十个人各重试一遍。
 *
 * 但终态的代价是**不可逆** —— 一旦标签写错，代码修好了也不会再试。
 * 实测这个形态真的发生了：21 行 `no_common_group`，用真 CLI 逐个复跑后
 * **至少两人其实有头像**，其余多数是"在群里但没设头像"。
 * 也就是说那个标签在真实数据上几乎全是错的，而它们全部被永久钉住。
 *
 * 所以 v11 删掉这个标签的历史行，让新代码重新判一次。
 */
import { describe, expect, it } from "vitest"
import { ContactAvatarRepository, AVATAR_RETRY_AFTER_MS } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CHANNEL = "dingtalk"
const NOW = new Date(2026, 6, 30, 12, 0, 0).getTime()

describe("★ 重试语义：终态不重试，download_failed 带退避", () => {
  it("没有行 → 该取", () => {
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    expect(repo.needsFetch(CHANNEL, "DeNEW", NOW)).toBe(true)
    vault.close()
  })

  it("取到了 → 不再取", () => {
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    repo.recordHit({
      channelId: CHANNEL,
      externalId: "DeOK",
      localPath: "/tmp/a.jpg",
      mediaId: "@lQ1",
      at: NOW,
    })
    expect(repo.needsFetch(CHANNEL, "DeOK", NOW)).toBe(false)
    vault.close()
  })

  it("no_avatar_set 是终态（他真的没设头像，重试没意义）", () => {
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    repo.recordMiss({ channelId: CHANNEL, externalId: "DeNONE", reason: "no_avatar_set", at: NOW })
    expect(repo.needsFetch(CHANNEL, "DeNONE", NOW)).toBe(false)
    // 一天之后也不试 —— 终态就是终态
    expect(repo.needsFetch(CHANNEL, "DeNONE", NOW + 24 * 3600_000)).toBe(false)
    vault.close()
  })

  it("★ download_failed 过了退避窗口要重试（网络抖动是会好的）", () => {
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    repo.recordMiss({
      channelId: CHANNEL,
      externalId: "DeFAIL",
      reason: "download_failed",
      at: NOW,
    })
    // 窗口内不重试（否则每次打开页面都会重试一遍失败的那些）
    expect(repo.needsFetch(CHANNEL, "DeFAIL", NOW + 60_000)).toBe(false)
    expect(repo.needsFetch(CHANNEL, "DeFAIL", NOW + AVATAR_RETRY_AFTER_MS)).toBe(true)
    vault.close()
  })

  it("★ lookup_skipped 立刻可重试，不带退避（什么都没失败，只是缺花名）", () => {
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    repo.recordMiss({
      channelId: CHANNEL,
      externalId: "DeNONICK",
      reason: "lookup_skipped",
      at: NOW,
    })
    /**
     * 与 `download_failed` 的区别：那个是"试了但失败了"（要退避，
     * 否则每次打开页面都重试一遍），这个是"压根没试"——
     * 没有需要退避的东西，而缺花名往往下一秒就补上了
     * （会话标题刚采到 / 那个人的消息刚落库）。
     *
     * 记成终态是首版的行为，后果是花名有了头像也永久不再取。
     */
    expect(repo.needsFetch(CHANNEL, "DeNONICK", NOW)).toBe(true)
    expect(repo.needsFetch(CHANNEL, "DeNONICK", NOW + 1000)).toBe(true)
    vault.close()
  })

  it("取到之后要清掉之前的失败原因（否则 needsFetch 以为还在失败）", () => {
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    repo.recordMiss({
      channelId: CHANNEL,
      externalId: "DeRETRY",
      reason: "download_failed",
      at: NOW,
    })
    repo.recordHit({
      channelId: CHANNEL,
      externalId: "DeRETRY",
      localPath: "/tmp/b.jpg",
      mediaId: "@lQ2",
      at: NOW + AVATAR_RETRY_AFTER_MS,
    })
    const row = repo.get(CHANNEL, "DeRETRY")
    expect(row?.missReason).toBeNull()
    expect(row?.localPath).toBe("/tmp/b.jpg")
    vault.close()
  })
})

/**
 * ★ v11：把被错标签钉住的行删掉。
 *
 * 迁移在 `openTestVault()` 时就已经跑完了，所以这里不能"建库再插旧数据"
 * —— 那样迁移不会再跑一次。改为直接验**迁移的 SQL 语义**：
 * 插入三种行，跑一遍与 v11 完全相同的语句，断言只有 `no_common_group` 被删。
 *
 * 这样测的是"那条 DELETE 的作用域对不对"，而作用域错了的后果很实在：
 * 多删 `no_avatar_set` → 白重试几十个人；多删取到的行 → 已下载的文件作废。
 */
describe("★ v11 只清 no_common_group，不动其余", () => {
  it("三种行里只有 no_common_group 被删", () => {
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    repo.recordMiss({
      channelId: CHANNEL,
      externalId: "DeNoGroup",
      reason: "no_common_group",
      at: NOW,
    })
    repo.recordMiss({
      channelId: CHANNEL,
      externalId: "DeNoAvatar",
      reason: "no_avatar_set",
      at: NOW,
    })
    repo.recordMiss({
      channelId: CHANNEL,
      externalId: "DeFailed",
      reason: "download_failed",
      at: NOW,
    })
    repo.recordHit({
      channelId: CHANNEL,
      externalId: "DeHit",
      localPath: "/tmp/c.jpg",
      mediaId: "@lQ3",
      at: NOW,
    })

    // 与 v11-avatar-miss-reset.ts 里的语句一致
    vault.db.prepare("DELETE FROM contact_avatars WHERE miss_reason = 'no_common_group'").run()

    // 被钉住的那个没有行了 → needsFetch 重新为 true（新代码会再判一次）
    expect(repo.get(CHANNEL, "DeNoGroup")).toBeNull()
    expect(repo.needsFetch(CHANNEL, "DeNoGroup", NOW)).toBe(true)

    // 其余三种都还在
    expect(repo.get(CHANNEL, "DeNoAvatar")?.missReason).toBe("no_avatar_set")
    expect(repo.get(CHANNEL, "DeFailed")?.missReason).toBe("download_failed")
    // ★ 取到的行必须留着 —— 删了等于把已下载的文件作废
    expect(repo.get(CHANNEL, "DeHit")?.localPath).toBe("/tmp/c.jpg")
    vault.close()
  })
})

/**
 * 契约枚举（`not_*` / `failed`）与历史枚举（`no_*` / `download_failed`）
 * 都要判对。
 *
 * ## ★ 为什么两套值必须共存
 *
 * 头像能力契约化之后，写入的是渠道无关的新枚举。但这张表里**已经有**
 * 旧值的行（v11 只删了 `no_common_group` 那一种，其余留着）。
 *
 * 读取侧不认旧值的后果是静默的：`toRow` 会把不认识的值过滤成 `null`，
 * 而 `missReason === null` 的含义是**"没失败过"** → 于是那些
 * 已经确定取不到的人会被重新取一遍，正好是这个文件在防的那件事。
 *
 * 反过来，新值落进"未知"分支会被当成终态 —— 那会让可重试的永久不再试。
 */
describe("★ 新旧两套 miss 枚举都要判对（读取侧兼容，不写迁移）", () => {
  it("not_set / not_reachable 是终态（新枚举）", () => {
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    repo.recordMiss({ channelId: CHANNEL, externalId: "DeNS", reason: "not_set", at: NOW })
    repo.recordMiss({ channelId: CHANNEL, externalId: "DeNR", reason: "not_reachable", at: NOW })
    // 一天之后也不试 —— 终态就是终态
    expect(repo.needsFetch(CHANNEL, "DeNS", NOW + 24 * 3600_000)).toBe(false)
    expect(repo.needsFetch(CHANNEL, "DeNR", NOW + 24 * 3600_000)).toBe(false)
    vault.close()
  })

  it("★ not_attempted 立刻可重试（新枚举里最要紧的一个）", () => {
    /**
     * 语义是"我们压根没查"（缺显示名）。判成终态的后果是
     * 花名后来采到了、头像却永久不再取。
     */
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    repo.recordMiss({ channelId: CHANNEL, externalId: "DeNA", reason: "not_attempted", at: NOW })
    expect(repo.needsFetch(CHANNEL, "DeNA", NOW)).toBe(true)
    vault.close()
  })

  it("failed 带退避（新枚举，与旧的 download_failed 同语义）", () => {
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    repo.recordMiss({ channelId: CHANNEL, externalId: "DeF", reason: "failed", at: NOW })
    expect(repo.needsFetch(CHANNEL, "DeF", NOW + 60_000)).toBe(false)
    expect(repo.needsFetch(CHANNEL, "DeF", NOW + AVATAR_RETRY_AFTER_MS)).toBe(true)
    vault.close()
  })

  it("★ 历史行里的旧值仍要被**读出来**，不能被过滤成 null", () => {
    /**
     * 直接写 SQL 而不用 `recordMiss` —— 模拟的是"契约化之前落的行"。
     * 这条断言的是 `toRow` 的白名单：漏掉旧值会让 `missReason` 变成 null，
     * 而那等于"没失败过"，于是终态失效。
     */
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    vault.db
      .prepare(
        `INSERT INTO contact_avatars
           (channel_id, external_id, local_path, media_id, miss_reason, attempted_at)
         VALUES (?, ?, NULL, NULL, ?, ?)`,
      )
      .run(CHANNEL, "DeOLD", "no_avatar_set", NOW)
    expect(repo.get(CHANNEL, "DeOLD")?.missReason).toBe("no_avatar_set")
    // 而且仍然是终态
    expect(repo.needsFetch(CHANNEL, "DeOLD", NOW + 24 * 3600_000)).toBe(false)
    vault.close()
  })

  it("认不出来的值仍然过滤成 null（脏数据 → 当成没试过，重新取）", () => {
    /**
     * 这一条锁的是白名单**没有**被放宽成"什么都收"。
     * 一个真正未知的值（手改过的库 / 未来版本回退）应该让那一行
     * 退回"没试过"，而不是被当成某种终态钉死。
     */
    const vault = openTestVault()
    const repo = new ContactAvatarRepository(vault.db)
    vault.db
      .prepare(
        `INSERT INTO contact_avatars
           (channel_id, external_id, local_path, media_id, miss_reason, attempted_at)
         VALUES (?, ?, NULL, NULL, ?, ?)`,
      )
      .run(CHANNEL, "DeJUNK", "something_from_the_future", NOW)
    expect(repo.get(CHANNEL, "DeJUNK")?.missReason).toBeNull()
    expect(repo.needsFetch(CHANNEL, "DeJUNK", NOW)).toBe(true)
    vault.close()
  })
})
