/**
 * 头像获取的门禁。
 *
 * ## ★ 锁的是「取不到」的**原因分对了**
 *
 * 三种原因里两种是终态（`no_common_group` / `no_avatar_set`，
 * `needsFetch` 从此不再重试），一种可重试（`download_failed`）。
 * 所以分错的代价不是"文案难看"，而是：
 *
 * · 把可重试的分成终态 → 那个人的头像**永久**取不到；
 * · 把终态分成可重试 → 每次打开页面对几十个人各重试一遍，结果永远一样。
 *
 * ## 这个文件存在的直接原因
 *
 * `fetchAvatar` 原来**一条直接测试都没有**，于是一个真实的误报活了下来：
 * 实测 21 个人被记成 `no_common_group`，而他们其实有 7-9 个共同群、
 * 只是没设头像 —— 成员详情返回的是
 * `{members:[{nick:"小马", avatarMediaId:null}]}`（成员行**在**，
 * 那个字段是 null），而首版把"有群没头像"与"没有群"都表示成 null。
 *
 * 「没有共同群」会让用户以为该去拉个群，而拉了也没用 ——
 * 错误的标签指向错误的排查方向。
 *
 * 载荷形状全部照实测（见各用例里的注释）。
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
/**
 * ★ 相对路径直接导入插件内部，不走 `@mycontext/channels` 桶。
 *
 * `fetchAvatar` 已经**不再对外导出**了（头像能力契约化之后，桶只出
 * `createDingTalkAvatars`）—— 那是刻意的：宿主层不该拿到一个入参叫
 * `openDingTalkId`、失败原因叫 `no_common_group` 的函数。
 *
 * 但这个文件测的正是**钉钉侧那些实测结论**（哪种载荷该判成哪个原因），
 * 所以它该看着钉钉的词汇写。测试直接摸内部是对的，
 * 换成经契约测会把断言变成映射后的中性名字，
 * 而"`no_avatar_set` 与 `no_common_group` 不能混"这条就锁不住了。
 * 契约映射本身另有一组用例（见文件末尾）。
 */
import {
  createDingTalkAvatars,
  fetchAvatar,
} from "../../../packages/channels/src/plugins/dingtalk/avatar.js"

/**
 * 假 CLI。
 *
 * `json` 按命令前缀分派（`search-common` / `list-by-ids`），
 * `run` 模拟 `download-media` —— 它的副作用是**写文件**，
 * 而 `fetchAvatar` 会检查文件非空，所以这里必须真的写。
 */
function fakeCli(behavior: {
  /** search-common 返回的群列表 */
  groups?: { openConversationId: string }[]
  /** 每个群里这个人的成员详情：undefined = 不在这个群（members: []） */
  memberByGroup?: Record<string, { avatarMediaId: string | null }>
  /** download-media 是否写出文件（false = 模拟下载失败） */
  writeFile?: boolean
  runThrows?: unknown
}) {
  const calls: string[][] = []
  return {
    calls,
    cli: {
      json: <T>(args: readonly string[]): Promise<T> => {
        calls.push([...args])
        if (args.includes("search-common")) {
          return Promise.resolve({
            groups: behavior.groups ?? [],
            hasMore: false,
            nextCursor: null,
          } as T)
        }
        if (args.includes("list-by-ids")) {
          const groupId = args[args.indexOf("--id") + 1] ?? ""
          const member = behavior.memberByGroup?.[groupId]
          // 不在这个群 → `members: []`（实测形态）
          return Promise.resolve({ members: member === undefined ? [] : [member] } as T)
        }
        return Promise.resolve({} as T)
      },
      run: (
        args: readonly string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        calls.push([...args])
        if (behavior.runThrows !== undefined) return Promise.reject(behavior.runThrows)
        if (behavior.writeFile !== false) {
          const output = args[args.indexOf("--output") + 1]
          if (output !== undefined) writeFileSync(output, "fake-jpeg-bytes")
        }
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })
      },
    },
  }
}

function outDir(): string {
  return mkdtempSync(join(tmpdir(), "mycontext-avatar-"))
}

/** 实测的真实形态：33-34 字符、`D` 开头。 */
const PEER = "DXq7mLb2ZfWn4tRc9JvHs5KyPd3GaE8Tu"
/** 实测的 mediaId 形态：`@lQ…` */
const MEDIA_ID = "@lQDPM4mJAAD2pGvNBJ3NBJuwwgsO6Rcg3_gJQDWp4rJbAA"

describe("★ 「有共同群但没设头像」不能报成「没有共同群」", () => {
  it("成员行在、avatarMediaId 为 null → no_avatar_set", async () => {
    /**
     * 这正是实测「小马」的形态：7 个共同群，每个群里
     * `members=1` 而 `avatarMediaId=null`。
     */
    const { cli } = fakeCli({
      groups: [{ openConversationId: "cidA" }, { openConversationId: "cidB" }],
      memberByGroup: { cidA: { avatarMediaId: null }, cidB: { avatarMediaId: null } },
    })
    const result = await fetchAvatar(cli, {
      openDingTalkId: PEER,
      nick: "小马",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 首版这里是 no_common_group —— 而那会让用户去拉一个没用的群
    expect(result.reason).toBe("no_avatar_set")
  })

  it("★ 确认没头像后**立刻停**，不再翻剩下的群（头像是人的属性，不是群的）", async () => {
    /**
     * 实测同一个人在 3 个不同群里返回**完全相同**的 mediaId ——
     * 所以看过一个群就有答案了。不停的话 7 个共同群要多花 6 次子进程调用
     * （每次约 0.7s）去得到同一个结论。
     */
    const { calls, cli } = fakeCli({
      groups: [
        { openConversationId: "cidA" },
        { openConversationId: "cidB" },
        { openConversationId: "cidC" },
      ],
      memberByGroup: {
        cidA: { avatarMediaId: null },
        cidB: { avatarMediaId: null },
        cidC: { avatarMediaId: null },
      },
    })
    await fetchAvatar(cli, { openDingTalkId: PEER, nick: "小马", outputDir: outDir() })
    const memberCalls = calls.filter((args) => args.includes("list-by-ids"))
    expect(memberCalls).toHaveLength(1)
  })

  it("真的没有共同群 → no_common_group（这个标签仍然要能出现）", async () => {
    const { cli } = fakeCli({ groups: [] })
    const result = await fetchAvatar(cli, {
      openDingTalkId: PEER,
      nick: "陌生人",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("no_common_group")
  })

  it("搜到群但他不在里面（members 空）→ no_common_group", async () => {
    // 花名搜出来的群里没有他 —— 那与"没有共同群"是同一件事
    const { cli } = fakeCli({ groups: [{ openConversationId: "cidA" }], memberByGroup: {} })
    const result = await fetchAvatar(cli, {
      openDingTalkId: PEER,
      nick: "同名的人",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("no_common_group")
  })
})

describe("★ 已知共同群那条捷径", () => {
  it("捷径命中 → 不调 search-common（那是它存在的全部意义）", async () => {
    const { calls, cli } = fakeCli({
      memberByGroup: { cidKNOWN: { avatarMediaId: MEDIA_ID } },
    })
    const result = await fetchAvatar(cli, {
      openDingTalkId: PEER,
      nick: "小吴",
      groupExternalId: "cidKNOWN",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(true)
    expect(calls.some((args) => args.includes("search-common"))).toBe(false)
  })

  it("★ 他已经不在那个已知群里（退群/换群）→ **要继续搜**，不能判终态", async () => {
    /**
     * 调用方给的"已知共同群"来自我们看到他发消息的那个群，
     * 但他可能之后退群了。那时 `members` 是空 —— 而那**不代表**他没头像。
     * 判终态会让这个人的头像永久取不到（`needsFetch` 不再重试）。
     */
    const { calls, cli } = fakeCli({
      groups: [{ openConversationId: "cidOTHER" }],
      memberByGroup: { cidOTHER: { avatarMediaId: MEDIA_ID } },
    })
    const result = await fetchAvatar(cli, {
      openDingTalkId: PEER,
      nick: "小吴",
      // 这个群里没有他（memberByGroup 里没配）
      groupExternalId: "cidSTALE",
      outputDir: outDir(),
    })
    expect(calls.some((args) => args.includes("search-common"))).toBe(true)
    expect(result.ok).toBe(true)
  })

  it("在已知群里但没设头像 → no_avatar_set 且不再搜（答案已确定）", async () => {
    const { calls, cli } = fakeCli({
      memberByGroup: { cidKNOWN: { avatarMediaId: null } },
    })
    const result = await fetchAvatar(cli, {
      openDingTalkId: PEER,
      nick: "小马",
      groupExternalId: "cidKNOWN",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("no_avatar_set")
    expect(calls.some((args) => args.includes("search-common"))).toBe(false)
  })
})

describe("★ 缺花名时的行为", () => {
  it("没有花名且没有已知共同群 → 一条命令都调不了", async () => {
    /**
     * `search-common` 只能按花名搜。缺花名时**一次命令都不调**
     * （踩过：48 个单聊对方全部这样，而 reason 看起来像"没设头像"）。
     */
    const { calls, cli } = fakeCli({})
    const result = await fetchAvatar(cli, { openDingTalkId: PEER, outputDir: outDir() })
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("★ 缺花名报 lookup_skipped（可重试），**不是** no_common_group（终态）", async () => {
    /**
     * 这一条锁的是一个"永久取不到"的陷阱。
     *
     * 缺花名的诚实答案是"我们没查"，而首版报的是 `no_common_group` ——
     * 那是**终态**（`needsFetch` 从此不再重试）。
     *
     * 而缺花名往往是**暂时**的：左栏的花名来自会话标题、消息流的来自
     * `sender_display_name`，两者都可能"还没采到"。记成终态的后果是
     * 花名后来有了、头像却永久不再取。
     */
    const { cli } = fakeCli({})
    const result = await fetchAvatar(cli, { openDingTalkId: PEER, outputDir: outDir() })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("lookup_skipped")
  })
})

describe("★ 下载失败是可重试的，不能记成终态", () => {
  it("命令成功但文件是空的 → download_failed", async () => {
    const { cli } = fakeCli({
      memberByGroup: { cidKNOWN: { avatarMediaId: MEDIA_ID } },
      writeFile: false,
    })
    const result = await fetchAvatar(cli, {
      openDingTalkId: PEER,
      groupExternalId: "cidKNOWN",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    /**
     * 记成终态的话这个人的头像永久取不到，而这**恰恰是**那种
     * 重试有用的情况（网络抖动 / 签名 URL 过期）。
     */
    expect(result.reason).toBe("download_failed")
  })

  it("下载抛错 → download_failed（带上原因供排查）", async () => {
    const { cli } = fakeCli({
      memberByGroup: { cidKNOWN: { avatarMediaId: MEDIA_ID } },
      runThrows: new Error("http2 timeout"),
    })
    const result = await fetchAvatar(cli, {
      openDingTalkId: PEER,
      groupExternalId: "cidKNOWN",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("download_failed")
    expect(result.detail).toContain("http2 timeout")
  })
})

describe("★ 取到之后：download-media 的参数与落地", () => {
  it("--message-id 0（头像不属于任何消息，但这个参数必填）", async () => {
    const { calls, cli } = fakeCli({ memberByGroup: { cidKNOWN: { avatarMediaId: MEDIA_ID } } })
    await fetchAvatar(cli, {
      openDingTalkId: PEER,
      groupExternalId: "cidKNOWN",
      outputDir: outDir(),
    })
    const download = calls.find((args) => args.includes("download-media"))
    expect(download).toBeDefined()
    expect(download?.[download.indexOf("--message-id") + 1]).toBe("0")
    // mediaId 要原样传（它就是那个 `@lQ…`）
    expect(download?.[download.indexOf("--resource-id") + 1]).toBe(MEDIA_ID)
  })

  it("文件名用 mediaId 的 hash，不含姓名（那是 PII）", async () => {
    const { cli } = fakeCli({ memberByGroup: { cidKNOWN: { avatarMediaId: MEDIA_ID } } })
    const result = await fetchAvatar(cli, {
      openDingTalkId: PEER,
      nick: "高鹏",
      groupExternalId: "cidKNOWN",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).not.toContain("高鹏")
    expect(result.path.endsWith(".jpg")).toBe(true)
  })
})

/**
 * 契约映射：钉钉的原因 → 渠道无关的原因。
 *
 * ## ★ 为什么这组用例必须存在
 *
 * 映射表（`MISS_MAP`）是**终态语义的唯一转运点**。上面那些用例锁的是
 * "钉钉侧判对了原因"，这里锁的是"判对的原因没在翻译时丢掉终态属性"。
 *
 * 漏掉这一层的后果与判错原因**完全一样**：
 * · 终态错译成可重试 → 每 6 小时重试一件永远失败的事；
 * · 可重试错译成终态 → 那个人的头像永久取不到。
 *
 * 而这类错误在类型上是合法的（都是 `ChannelAvatarMiss`），编译器抓不到。
 *
 * ★ 断言用的是**成对**的（钉钉原因 → 契约原因），而不是只断言契约值 ——
 * 只断言 `"not_set"` 的话，一个把四种原因全映射成 `not_set` 的实现
 * 也能过其中一条。
 */
describe("★ 契约映射：终态属性不能在翻译时丢掉", () => {
  it("在群里但没设头像 → not_set（钉钉的 no_avatar_set，终态）", async () => {
    const { cli } = fakeCli({
      groups: [{ openConversationId: "cidA" }],
      memberByGroup: { cidA: { avatarMediaId: null } },
    })
    const result = await createDingTalkAvatars(cli).ofUser({
      externalId: PEER,
      displayName: "小马",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("not_set")
  })

  it("没有共同群 → not_reachable（钉钉的 no_common_group，终态）", async () => {
    const { cli } = fakeCli({ groups: [] })
    const result = await createDingTalkAvatars(cli).ofUser({
      externalId: PEER,
      displayName: "陌生人",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("not_reachable")
  })

  it("★ 缺显示名 → not_attempted（钉钉的 lookup_skipped，**可重试**）", async () => {
    /**
     * 这一条是四个映射里最要紧的：`not_attempted` 的语义是"我们压根没查"，
     * 归成终态的后果是花名后来采到了、头像却永久不再取
     * （见 `ChannelAvatarMiss` 与 `needsFetch` 的注释）。
     */
    const { calls, cli } = fakeCli({ groups: [{ openConversationId: "cidA" }] })
    const result = await createDingTalkAvatars(cli).ofUser({
      externalId: PEER,
      // 没给 displayName，也没给已知共同群 → 无从查起
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("not_attempted")
    // "压根没查"要名副其实：一条命令都不该发出去
    expect(calls).toHaveLength(0)
  })

  it("下载失败 → failed（钉钉的 download_failed，可重试）", async () => {
    const { cli } = fakeCli({
      memberByGroup: { cidKNOWN: { avatarMediaId: MEDIA_ID } },
      writeFile: false,
    })
    const result = await createDingTalkAvatars(cli).ofUser({
      externalId: PEER,
      displayName: "小吴",
      viaConversationExternalId: "cidKNOWN",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("failed")
  })

  it("成功时 cacheKey 是渠道的 mediaId（换头像 → 变值 → 宿主据此失效）", async () => {
    const { cli } = fakeCli({ memberByGroup: { cidKNOWN: { avatarMediaId: MEDIA_ID } } })
    const result = await createDingTalkAvatars(cli).ofUser({
      externalId: PEER,
      displayName: "小吴",
      viaConversationExternalId: "cidKNOWN",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cacheKey).toBe(MEDIA_ID)
  })

  it("★ 钉钉没有群头像能力 → ofConversation 不实现（而不是恒定失败）", () => {
    /**
     * 留 undefined 与"实现一个总是返回 not_reachable 的方法"不同：
     * 前者让调用方知道**这个渠道没这能力**（直接用首字母兜底），
     * 后者会让它以为"这次没拿到，也许下次行"，于是每次都试一遍。
     */
    const { cli } = fakeCli({})
    expect(createDingTalkAvatars(cli).ofConversation).toBeUndefined()
  })

  it("★ displayName 传空串等同没传（不能当成一个真名字去搜）", async () => {
    // 空串走进 search-common 会搜到无意义的结果，或干脆报错
    const { calls, cli } = fakeCli({ groups: [{ openConversationId: "cidA" }] })
    const result = await createDingTalkAvatars(cli).ofUser({
      externalId: PEER,
      displayName: "",
      outputDir: outDir(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("not_attempted")
    expect(calls).toHaveLength(0)
  })
})
