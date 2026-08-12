/**
 * 飞书头像 —— **两种响应形状**都要认。
 *
 * ## ★★★ 为什么这个文件必须存在（我在这里错了两次，方向相反）
 *
 * `contact +get-user` 的响应形状**取决于怎么调它**，而两条路的形状完全不同。
 * 实测（同一台机、同一个 CLI 版本，2026-08）：
 *
 * | 调用                                  | 身份 | avatar 形状                        |
 * |---------------------------------------|------|------------------------------------|
 * | 省略 `--user-id`（取本人）            | user | **平铺** `avatar_middle/big/…`     |
 * | `--user-id <open_id>`                 | bot  | **嵌套** `avatar.avatar_240/640/…` |
 * | `--user-id <open_id>`                 | user | **只有 3 个字段，零 avatar**       |
 *
 * 我的两次错：
 * · 首版按嵌套写（照开放平台文档）→ 被"实测本人"证伪，改成只认平铺；
 * · 而线上真正走的是**按 id 取**那条，于是 `pickAvatarUrl` 恒返回 null →
 *   每个人都落 `not_set`（**终态、不重试**）→ 头像永远首字母兜底。
 *   用户报"头像还是没显示"，`contact_avatars` 表里全是 miss。
 *
 * 两次"实测"都是真的，但**都只覆盖了一半的调用形态**。
 * 所以这里把三种形态各锁一条 —— 单靠"我实测过"挡不住这类错。
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFeishuAvatars } from "../../../packages/channels/src/plugins/feishu/avatar.js"

/** 造一个只回固定 payload 的 cli 替身，并记下它被调用时的参数。 */
function cliReturning(payload: unknown, seen?: string[][]) {
  return {
    json: async <T>(args: string[]): Promise<T> => {
      seen?.push([...args])
      return payload as T
    },
  }
}

/** 只验"挑到了 URL 没有"，不真下载 —— 下载那步是 fetch，另有 miss 分类覆盖。 */
async function pick(payload: unknown): Promise<{ tried: boolean; url: string | null }> {
  const seen: string[][] = []
  const avatars = createFeishuAvatars(cliReturning(payload, seen) as never)
  const result = await avatars.ofUser({
    externalId: "ou_FAKE0000000000000000000000000001",
    // 挑到 URL 才会走到下载 —— 目录必须真存在，否则错的是 mkdir 而不是被测逻辑
    outputDir: mkdtempSync(join(tmpdir(), "mycontext-feishu-avatar-")),
  } as never)
  /**
   * 拿不到 URL 时实现返回 `not_set`（终态）；拿到了才会去下载 ——
   * 而下载在单测里必然失败（没有网），落 `failed`（可重试）。
   * 所以用 reason 反推"有没有挑到 URL"：这是这条断言的判据。
   */
  const reason = result.ok ? null : result.reason
  return { tried: seen.length > 0, url: reason === "not_set" ? null : "picked" }
}

describe("飞书头像：响应形状", () => {
  it("★★ 嵌套形状（按 id + bot，**线上真正走的那条**）能挑到 URL", async () => {
    /**
     * 反证：把 `pickAvatarUrl` 里那段嵌套分支删掉，这一条立刻转红 ——
     * 而红之前的状态正是用户看到的"头像还是没显示"。
     */
    const { url } = await pick({
      ok: true,
      data: {
        user: {
          open_id: "ou_FAKE0000000000000000000000000001",
          name: "Alice",
          avatar: {
            avatar_72: "https://example.invalid/a72.png",
            avatar_240: "https://example.invalid/a240.png",
            avatar_640: "https://example.invalid/a640.png",
            avatar_origin: "https://example.invalid/orig.png",
          },
        },
      },
    })
    expect(url).toBe("picked")
  })

  it("★★ 平铺形状（取本人那条）也要能挑到 —— 不能二选一", async () => {
    // 反证：删掉平铺那段分支 → 红。两条路都在用，任何一条都不能丢。
    const { url } = await pick({
      ok: true,
      data: {
        user: {
          open_id: "ou_FAKE0000000000000000000000000001",
          name: "Alice",
          avatar_middle: "https://example.invalid/middle.png",
          avatar_big: "https://example.invalid/big.png",
        },
      },
    })
    expect(url).toBe("picked")
  })

  it("★ 真的没有任何 avatar 字段 → not_set（这个终态本身是对的）", async () => {
    /**
     * 按 id + **user** 身份实测就是这个形状（只有 name/i18n_name/user_id）。
     * 那时判 `not_set` 在**语义上**是错的（人家有头像，是我们身份用错了），
     * 但这一层只能看到"响应里没有头像" —— 修的地方是调用身份（用 bot），
     * 而不是把终态改成可重试。终态判据保持不变，所以这条断言仍然要绿。
     */
    const { url } = await pick({
      ok: true,
      data: { user: { user_id: "u_FAKE01", name: "Alice", i18n_name: {} } },
    })
    expect(url).toBeNull()
  })

  it("★★ 按 id 取必须用 **bot** 身份（user 身份拿不到头像字段）", async () => {
    /**
     * CLI help 原文："Self lookup (omit --user-id) needs user identity;
     * **a bot must pass --user-id**"。实测按 id + user 只回三个字段。
     *
     * 反证：把 `--as bot` 改回 `--as user`，这一条转红 —— 而那正是
     * 修复前的代码，它让每个人都被误判成"没设头像"。
     */
    const seen: string[][] = []
    const avatars = createFeishuAvatars(
      cliReturning({ ok: true, data: { user: {} } }, seen) as never,
    )
    await avatars.ofUser({
      externalId: "ou_FAKE0000000000000000000000000001",
      outputDir: mkdtempSync(join(tmpdir(), "mycontext-feishu-avatar-")),
    } as never)
    const args = seen[0] ?? []
    const asIndex = args.indexOf("--as")
    expect(args).toContain("--user-id")
    expect(asIndex).toBeGreaterThanOrEqual(0)
    expect(args[asIndex + 1]).toBe("bot")
  })

  it("★ 没有 open_id → 一次命令都不发，且记**可重试**（id 后来会采到）", async () => {
    const seen: string[][] = []
    const avatars = createFeishuAvatars(cliReturning({ ok: true }, seen) as never)
    const result = await avatars.ofUser({
      externalId: "",
      outputDir: mkdtempSync(join(tmpdir(), "mycontext-feishu-avatar-")),
    } as never)
    expect(seen).toEqual([])
    expect(result.ok === false && result.reason).toBe("not_attempted")
  })
})
