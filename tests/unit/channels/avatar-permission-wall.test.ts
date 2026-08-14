/**
 * 头像取不到时的**分类**：权限墙必须与"抖动"分开。
 *
 * ## ★★★ 用户报的问题
 *
 * 「钉钉授权后头像没获取到，且刷新头像也没用」。
 *
 * ## 根因（实测，本机随包渠道客户端）
 *
 * ```
 * $ dws contact user get-self
 * server_error_code: ENTERPRISE_NOT_AUTHORIZED
 * operation:          contact/get_current_user_profile
 * ```
 *
 * 钉钉没有开放的按 id 取头像接口，只能绕「共同群成员详情里的
 * avatarMediaId」，而那条链路的每一步都在 `contact` 家族上
 * （找人 → 找共同群 → 读成员详情）。所以**这份客户端下头像永远取不到**。
 *
 * ## 改动前为什么"点了没反应"
 *
 * `cli.ts` 已经把 `ENTERPRISE_NOT_AUTHORIZED` 分类成 `PERMISSION_REQUIRED`
 * 并**抛出**，而 `fetchAvatar` 不接这个抛 —— 它一路穿到
 * `media.service.ts` 的兜底 catch，被记成 `failed`（**可重试**）。于是：
 *
 * · 每 6 小时对每个人重试一遍一件永远失败的事；
 * · 用户点「刷新头像」→ `force` 确实重试 → 服务端照样拒 → 界面无声。
 *
 * 那是本仓库最贵的那类故障：真实的失败被显示成"正常"。
 */
import { describe, expect, it } from "vitest"
import { AppError } from "@mycontext/kernel"
import { createDingTalkAvatars } from "@mycontext/channels"
import type { ChannelAvatarRequest, MediaRunner } from "@mycontext/channels"

/**
 * 走**契约边界**（`createDingTalkAvatars().ofUser`）而不是裸的 `fetchAvatar`。
 *
 * ★ `fetchAvatar` 是**刻意**不导出的（`index.ts` 里写了理由：它的入参叫
 * `openDingTalkId`、失败原因叫 `no_common_group`，那些是钉钉的词，
 * 不该出现在渠道无关的调用方里）。为了测试去放开那个导出等于用测试
 * 撬开一条已经关掉的边界 —— 而契约边界上能验的东西是一样的
 * （`MISS_MAP` 也在这条路上，顺带一起锁住）。
 */
function askAvatar(cli: MediaRunner, request: Partial<ChannelAvatarRequest> = {}) {
  return createDingTalkAvatars(cli).ofUser({
    externalId: ODID,
    outputDir: "/tmp/mycontext-avatar-test",
    ...request,
  })
}

const ODID = "DFAKE0001peer"

/**
 * 造一个在 `chat search-common` 上抛权限错的假 CLI。
 *
 * ★ 抛的是 `AppError{PERMISSION_REQUIRED}` —— 那正是 `DwsCli` 对
 * `ENTERPRISE_NOT_AUTHORIZED` 的分类结果（见 `cli.ts` 的
 * `SERVER_ERROR_CODES`）。用真实的错误形状而不是随便一个 Error，
 * 否则这条用例锁不住"我们认的是哪个码"。
 */
function permissionWallCli(): MediaRunner {
  return {
    json: async (args: readonly string[]) => {
      if (args.includes("search-common")) {
        throw new AppError(
          "PERMISSION_REQUIRED",
          "当前渠道客户端对这个企业没有开通该能力，请在设置里换一份客户端",
        )
      }
      return {} as never
    },
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  }
}

/**
 * 造一个在 search-common 上抛**网络类**错误的假 CLI（对照组）。
 *
 * ★★ `retryable: true` 是**必须显式写**的：`AppError` 的默认值是 `false`
 * （见 `errors.ts`），而真实的 `DwsCli` 对子进程失败抛的是
 * `PROCESS_FAILED` + **显式** `retryable: true`（`cli.ts:838`）。
 *
 * 我第一版漏了这个字段，于是这个"对照组"实际上也是终态 —— 而判据
 * 改成按 `retryable` 判之后它立刻转红。那次转红是对的：**fixture 与
 * 真实行为不一致**，而不是实现错了。
 */
function flakyCli(): MediaRunner {
  return {
    json: async (args: readonly string[]) => {
      if (args.includes("search-common")) {
        throw new AppError("PROCESS_FAILED", "子进程超时", { retryable: true })
      }
      return {} as never
    },
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  }
}

describe("★★★ 权限墙 → 终态 `not_permitted`，而不是可重试的 `failed`", () => {
  it("★★★ search-common 报 PERMISSION_REQUIRED → reason 是 not_permitted", async () => {
    const result = await askAvatar(permissionWallCli(), { displayName: "张三" })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    /**
     * 反证：把 `fetchAvatar` 里那段 try/catch 去掉 ⇒ 这条用例会**抛**
     * （而不是返回一个 reason）—— 那正是改动前的行为：异常穿到
     * `media.service.ts` 的兜底 catch，被记成 `failed`。
     */
    expect(result.reason).toBe("not_permitted")
  })

  it("★★★ 而**网络类**失败仍然往上抛（那些确实值得重试）", async () => {
    /**
     * 这一条是上一条的**必要配对**。只写上一条的话，最省事的实现是
     * "catch 掉所有异常都记成 not_permitted" —— 而那会让一次子进程超时
     * 变成**终态**，那个人的头像从此永久不再取。
     *
     * 判据：只认 `PERMISSION_REQUIRED` 这一个码，其余原样抛出，
     * 由 `media.service.ts` 记成可重试的 `failed`。
     */
    await expect(askAvatar(flakyCli(), { displayName: "张三" })).rejects.toThrow(/子进程超时/)
  })

  it("★★★ 「还没绑定渠道身份」也走同一条路（CDP 抓到的第二个码）", async () => {
    /**
     * ## 这一条是 CDP 实测抓出来的
     *
     * 我第一版的判据是 `error.code === "PERMISSION_REQUIRED"` —— 只认一个码。
     * 而真机上第一次点刷新撞到的是**另一个**：
     *
     * ```
     * WARN [Main:Media] avatar fetch threw
     *   {"detail":"还没绑定渠道身份，拒绝执行渠道命令…"}
     * ```
     *
     * 那是 `CHANNEL_IDENTITY_UNAVAILABLE`（`retryable: false`）——
     * 同一个形状（终态被记成可重试的 `failed`），而列举码的写法漏了它。
     *
     * 所以判据改成 `retryable === false`：那就是"重试有没有意义"这个问题
     * 的答案本身，将来新增的终态码自动进这条路。
     *
     * 反证：把判据改回 `error.code === "PERMISSION_REQUIRED"` ⇒ 这条转红。
     */
    const identityWall: MediaRunner = {
      json: async (args: readonly string[]) => {
        if (args.includes("search-common")) {
          throw new AppError("CHANNEL_IDENTITY_UNAVAILABLE", "还没绑定渠道身份，拒绝执行渠道命令", {
            retryable: false,
          })
        }
        return {} as never
      },
      run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    }

    const result = await askAvatar(identityWall, { displayName: "张三" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("not_permitted")
  })

  it("★★ 契约边界上也是 not_permitted（MISS_MAP 没把它折成 failed）", async () => {
    const avatars = createDingTalkAvatars(permissionWallCli())
    const result = await avatars.ofUser({
      externalId: ODID,
      displayName: "张三",
      outputDir: "/tmp/mycontext-avatar-test",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    /**
     * `MISS_MAP` 是穷尽的 `Record`，所以漏映射会编译失败 —— 但**映射错**
     * （折成 `failed`）不会。这一条锁的正是那个方向：终态 → 终态。
     *
     * 反证：把 `MISS_MAP.not_permitted` 改成 `"failed"` ⇒ 这条转红。
     */
    expect(result.reason).toBe("not_permitted")
  })
})

describe("★★ 缺花名仍然是 not_attempted（没被新分类抢走）", () => {
  it("★ 没有 nick、也没有已知共同群 → not_attempted（可重试）", async () => {
    /**
     * `not_attempted` 的含义是"我们一次命令都没调"（缺花名）。它必须
     * 与权限墙分开：缺花名往往是**暂时**的（会话标题还没采到），
     * 而权限墙在当前客户端下是永久的。
     *
     * ★ 这条同时证明新加的 try/catch **没有**改变"压根没查"那条路 ——
     * 它连 `search-common` 都不会调，所以那个 catch 不参与。
     */
    const result = await askAvatar(permissionWallCli())

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    // ★ 契约那侧叫 `not_attempted`（钉钉内部叫 `lookup_skipped`）
    expect(result.reason).toBe("not_attempted")
  })
})

describe("★★ 界面能说出「换一份客户端」这句可执行的话", () => {
  it("★★★ i18n 里有 avatarMiss 那四条（zh / en 都要）", async () => {
    /**
     * ## 为什么这一条值得单独测
     *
     * `t(key, {defaultValue})` 的 `defaultValue` **只在 key 不存在时**生效。
     * 这一轮踩过一次同形的坑（覆盖面那三行文案完全一样，因为
     * `settings.json` 里那几个 key 本来就有旧值）—— 而这次是反过来：
     * key **必须存在**，否则界面显示的是 defaultValue（能用，但翻译不了）。
     *
     * ★ 两种语言都查：只加中文的话英文界面会显示中文。
     */
    const zh = (await import("../../../packages/i18n/src/locales/zh/channels.json", {
      with: { type: "json" },
    })) as { default: Record<string, unknown> }
    const en = (await import("../../../packages/i18n/src/locales/en/channels.json", {
      with: { type: "json" },
    })) as { default: Record<string, unknown> }

    for (const bundle of [zh.default, en.default]) {
      const miss = bundle["avatarMiss"] as Record<string, string> | undefined
      expect(miss).toBeDefined()
      // 四种原因各一句 —— 少一句就会退回 defaultValue（中文硬编码）
      for (const key of ["notPermitted", "notSet", "notReachable", "failed"]) {
        expect(typeof miss?.[key]).toBe("string")
        expect((miss?.[key] ?? "").length).toBeGreaterThan(0)
      }
    }
  })

  it("★★★ `not_permitted` 那句必须给出**出路**，不能只说「失败了」", async () => {
    /**
     * 这一条锁的是**文案的内容**而不是它存在。
     *
     * 「取不到头像」这句话对用户没用 —— 他已经看到没有头像了。
     * 唯一有价值的信息是"换一份有权限的客户端"，而那是这个缺陷
     * 与其余三种 miss 的**全部区别**（其余三种用户什么都做不了）。
     *
     * 判据：中文那句里必须提到"客户端"；英文那句里必须提到 client。
     */
    const zh = (await import("../../../packages/i18n/src/locales/zh/channels.json", {
      with: { type: "json" },
    })) as { default: { avatarMiss: Record<string, string> } }
    const en = (await import("../../../packages/i18n/src/locales/en/channels.json", {
      with: { type: "json" },
    })) as { default: { avatarMiss: Record<string, string> } }

    expect(zh.default.avatarMiss.notPermitted).toContain("客户端")
    expect(en.default.avatarMiss.notPermitted.toLowerCase()).toContain("client")
  })
})
