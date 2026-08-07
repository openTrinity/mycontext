import { describe, expect, it } from "vitest"
import {
  assertAllowedLarkCommand,
  createFeishuDocuments,
  createFeishuIngest,
  FeishuAuth,
  LARK_AUTH_SCOPES,
  LarkCli,
  parseLarkAuthStatus,
  parseLarkMessagePage,
} from "@mycontext/channels"
import type { Logger } from "@mycontext/kernel"
import type { ProcessRunner } from "@mycontext/runtime-env"

/**
 * 授权时真正要到的权限 —— 直接取源，**不在测试里再抄一份**。
 *
 * ★ 抄一份的话这两处会各自漂：收窄了实现而测试里那份没动，测试仍然绿
 * （它验的是"这一大堆都在"，而 `hasScopes` 只做子集判断）。
 * 那正是这次收窄时踩到的 —— 测试挡住了一个**正确**的改动。
 */
const REQUIRED_SCOPES = [...LARK_AUTH_SCOPES]

describe("Feishu CLI safety boundary", () => {
  it("allows read/auth commands used by the plugin", () => {
    expect(() =>
      assertAllowedLarkCommand(["drive", "+search", "--query", "", "--as", "user"]),
    ).not.toThrow()
    expect(() => assertAllowedLarkCommand(["auth", "login", "--no-wait", "--json"])).not.toThrow()
    expect(() => assertAllowedLarkCommand(["config", "keychain-downgrade"])).not.toThrow()
  })

  it("rejects write-capable commands", () => {
    expect(() => assertAllowedLarkCommand(["im", "message", "send", "--text", "hello"])).toThrow()
    expect(() => assertAllowedLarkCommand(["drive", "delete", "--token", "x"])).toThrow()
  })

  it("pins macOS credentials to the isolated HOME before OAuth token persistence", async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = []
    const processes = {
      async exec(input: { args: string[]; env: Record<string, string> }) {
        calls.push({ args: input.args, env: input.env })
        return { exitCode: 0, stdout: "already downgraded", stderr: "" }
      },
    } as unknown as ProcessRunner
    const cli = new LarkCli({
      processes,
      logger: {} as Logger,
      authRoot: () => "/tmp/inklings-feishu-test-auth",
      executable: "/tmp/lark-cli",
      platform: "darwin",
    })

    await cli.ensureAutomationCredentialAccess()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(["config", "keychain-downgrade"])
    expect(calls[0]?.env["HOME"]).toContain("inklings-feishu-test-auth/home")
  })

  it("does not invoke the macOS-only migration on other platforms", async () => {
    let called = false
    const processes = {
      async exec() {
        called = true
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    } as unknown as ProcessRunner
    const cli = new LarkCli({
      processes,
      logger: {} as Logger,
      authRoot: () => "/tmp/inklings-feishu-test-auth-linux",
      executable: "/tmp/lark-cli",
      platform: "linux",
    })

    await cli.ensureAutomationCredentialAccess()

    expect(called).toBe(false)
  })
})

describe("Feishu auth and ingest parsing", () => {
  it("migrates macOS key storage before completing a re-authorization", async () => {
    const calls: string[][] = []
    const events: string[] = []
    const processes = {
      async exec(input: { args: string[] }) {
        calls.push(input.args)
        events.push(input.args.join(" "))
        let stdout = "{}"
        if (input.args.includes("--no-wait")) {
          stdout = JSON.stringify({
            device_code: "device-1",
            user_code: "ABCD-EFGH",
            verification_url: "https://open.feishu.cn/device",
          })
        } else if (input.args[0] === "config") {
          stdout = "already downgraded"
        } else if (input.args[1] === "status") {
          stdout = JSON.stringify({
            verified: true,
            identities: {
              user: {
                openId: "ou_self",
                userName: "Nico",
                tenantKey: "tenant",
                tenantName: "Inklings",
                status: "authenticated",
                scopes: REQUIRED_SCOPES,
              },
            },
          })
        }
        return { exitCode: 0, stdout, stderr: "", timedOut: false }
      },
    } as unknown as ProcessRunner
    const logger = { debug: () => undefined, warn: () => undefined } as unknown as Logger
    const options = {
      processes,
      logger,
      authRoot: () => "/tmp/inklings-feishu-reauth-order",
      executable: "/tmp/lark-cli",
      platform: "darwin" as const,
      openExternal: async () => {
        events.push("open browser")
      },
    }
    const auth = new FeishuAuth(options, new LarkCli(options))

    const status = await auth.login({
      mode: "loopback",
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })

    expect(status.state).toBe("authorized")
    const requestedScopes = calls[0]?.[3]?.split(",") ?? []
    expect(requestedScopes).toEqual(REQUIRED_SCOPES)
    expect(calls.map((args) => args.join(" "))).toEqual([
      expect.stringContaining("auth login --scope"),
      "config keychain-downgrade",
      "auth login --device-code device-1",
      "auth status --json --verify",
    ])
    expect(events.indexOf("open browser")).toBeLessThan(events.indexOf("config keychain-downgrade"))
  })

  /**
   * ★★ 不许索要**没有调用点**的权限。
   *
   * 多要一个不是"以后可能有用"，而是现在就让用户授出了我们并不读的数据面
   * （CLAUDE.md 第 5 节）。这条门禁盯住几类曾经在列表里、而实现里
   * 一次都没调过的：会议全文、媒体导出、联系人反查、reaction、pins、表格。
   *
   * 要加回其中任何一项：**先有调用点**，再从这个名单里去掉它。
   */
  it("★★ 不索要没有调用点的权限（会议 / 媒体 / 联系人反查 / reaction）", () => {
    const forbidden = [
      "minutes:minutes.search:read",
      "minutes:minutes.basic:read",
      "minutes:minutes.artifacts:read",
      "minutes:minutes.media:export",
      "docs:document.media:download",
      "sheets:spreadsheet:read",
      "contact:user:search",
      "contact:user.basic_profile:readonly",
      "im:message.reactions:read",
      "im:message.pins:read",
      "wiki:space:retrieve",
      "wiki:node:retrieve",
    ]
    for (const scope of forbidden) {
      expect(REQUIRED_SCOPES, `${scope} 没有调用点，不该向用户索要`).not.toContain(scope)
    }
  })

  it("requires the complete read-only scope set", () => {
    const identity = {
      openId: "ou_self",
      userName: "Nico",
      tenantKey: "tenant",
      tenantName: "Inklings",
      status: "authenticated",
      scopes: REQUIRED_SCOPES,
    }
    expect(parseLarkAuthStatus({ verified: true, identities: { user: identity } }).state).toBe(
      "authorized",
    )
    expect(
      parseLarkAuthStatus({
        verified: true,
        identities: { user: { ...identity, scopes: REQUIRED_SCOPES.slice(0, -1) } },
      }).state,
    ).toBe("unauthorized")
  })

  it("normalizes IM messages into the shared channel contract", () => {
    const page = parseLarkMessagePage(
      {
        items: [
          {
            message_id: "om_1",
            chat_id: "oc_1",
            chat_name: "产品群",
            chat_type: "group",
            sender: { open_id: "ou_2", name: "小李" },
            content: JSON.stringify({ text: "飞书里的进展" }),
            create_time: "1785207229000",
          },
        ],
      },
      0,
    )
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({
      externalId: "om_1",
      conversationExternalId: "oc_1",
      senderExternalId: "ou_2",
      contentText: "飞书里的进展",
      sentAt: 1_785_207_229_000,
    })
  })

  /**
   * ★★ 云文档进 `documents`，**不再**变成一个假群的消息。
   *
   * 改动前它走消息那条路：合成会话 `feishu:drive`（`type:"group"`）+ 每篇
   * 文档一条 message。四处污染且都不报错 —— 其中最严重的是**消息水位被
   * 文档的编辑时间推进**（文档比消息新时，那段时间的真实消息会被当成已采过）。
   *
   * 所以这一组的核心断言是**否定式**的：`conversations` 里没有那个假群。
   */
  it("★★ 云文档进 documents 契约，且不产出任何会话/消息", async () => {
    const documents = createFeishuDocuments({
      json: <T,>(): Promise<T> =>
        Promise.resolve({
          results: [
            {
              token: "doc_1",
              title: "路线图",
              summary: "八月发布",
              edit_time: 1_785_207_229,
              url: "https://example.invalid/doc_1",
            },
          ],
        } as T),
    })
    const page = await documents.list({})
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      externalId: "doc_1",
      origin: "drive",
      title: "路线图",
      url: "https://example.invalid/doc_1",
    })
    // ★ 正文取不到 → null（而不是把摘要片段当全文，那会让残缺看不出来）
    expect(page.items[0]?.contentText).toBeNull()
    // ★ 时间解析出来了（取不到才该是 null）
    expect(page.items[0]?.updatedAt).toBeGreaterThan(0)
  })

  it("★ 没有稳定 id 的条目跳过（下标兜底会让同一篇文档反复入库）", async () => {
    const documents = createFeishuDocuments({
      json: <T,>(): Promise<T> =>
        Promise.resolve({ results: [{ title: "没有 token 的东西", summary: "x" }] } as T),
    })
    await expect(documents.list({})).resolves.toMatchObject({ items: [] })
  })

  it("★ body() 恒返回 null 且不抛（某一篇取不到是常态而非错误）", async () => {
    const documents = createFeishuDocuments({ json: <T,>(): Promise<T> => Promise.resolve({} as T) })
    await expect(documents.body({ externalId: "doc_1", extension: null })).resolves.toEqual({
      contentText: null,
      rawPayload: null,
    })
    // ★ 空数组 = 一篇都读不到。采集侧据此不把它们排进正文队列（不白占配额）
    expect(documents.readableExtensions).toEqual([])
  })

  it("撞分页上限时报 truncated（否则下游把「只列了 20 页」当成「一共这么多」）", async () => {
    const documents = createFeishuDocuments({
      // 恒返回 next token → 一定会撞上限
      json: <T,>(): Promise<T> =>
        Promise.resolve({ results: [{ token: "d" }], next_page_token: "more" } as T),
    })
    let last = await documents.list({})
    for (let i = 0; i < 25 && last.hasMore; i += 1) {
      last = await documents.list({ cursor: last.nextToken })
    }
    expect(last.truncated).toBe(true)
    expect(last.hasMore).toBe(false)
    expect(last.nextToken).toBeNull()
  })

  /**
   * ★★ 采集只剩消息一路 —— 而它的分页现在**自己记游标**。
   *
   * 改动前 IM 那路写死 `--page-limit 5` 且不返回游标，于是每个时间窗恒只取
   * 前 5 页；而 drive 抽干时报 `hasMore=false`，上层据此推进水位 ——
   * 剩下的消息永久丢失且日志无错。
   */
  it("★★ 消息搜索补正文，且分页位置记进游标（不再恒取前几页）", async () => {
    const calls: string[][] = []
    const ingest = createFeishuIngest({
      async json<T>(args: string[]): Promise<T> {
        calls.push(args)
        if (args[1] === "+messages-search") {
          const next = args.includes("--page-token") ? null : "page-2"
          return { message_ids: ["om_1"], next_page_token: next } as T
        }
        return {
          items: [
            {
              message_id: "om_1",
              chat_id: "oc_1",
              sender: { open_id: "ou_2", name: "小李" },
              content: { text: "hydrate 后的正文" },
            },
          ],
        } as T
      },
    })

    const first = await ingest.pull({ start: 0, end: 1_785_207_229_000, limit: 50, cursor: null })
    expect(first.hasMore).toBe(true)
    expect(first.messages.some((message) => message.contentText === "hydrate 后的正文")).toBe(true)
    expect(calls.some((args) => args[1] === "+messages-mget")).toBe(true)
    // ★ 采集不再产出任何"云文档"会话 —— 那个假群没了
    expect(first.conversations.some((c) => c.externalId === "feishu:drive")).toBe(false)
    // ★ 也不再调 drive（文档走 documents 契约）
    expect(calls.some((args) => args[0] === "drive")).toBe(false)

    const second = await ingest.pull({
      start: 0,
      end: 1_785_207_229_000,
      limit: 50,
      cursor: first.nextCursor,
    })
    expect(second.hasMore).toBe(false)
    /**
     * ★ 断言落在**搜索**那条命令上，不是 `calls.at(-1)` ——
     * 最后一条是补正文的 `+messages-mget`（它不翻页）。
     * 取最后一次 `+messages-search`：那才是应该带上游标的那条。
     */
    const searches = calls.filter((args) => args[1] === "+messages-search")
    expect(searches.at(-1)).toContain("--page-token")
    expect(searches.at(-1)).toContain("page-2")
  })

  /**
   * ★★ 隐私：`--edited-since` / 时间窗必须来自用户选的范围。
   *
   * 改动前 drive 那路写死 `365d` —— 用户选 7 天而我们实际采一年。
   * 现在 drive 走 documents（有自己的保守默认），而消息这路直接传 start/end。
   */
  it("★★ 消息搜索的时间窗来自 spec（不是写死的范围）", async () => {
    const calls: string[][] = []
    const ingest = createFeishuIngest({
      async json<T>(args: string[]): Promise<T> {
        calls.push(args)
        return { items: [] } as T
      },
    })
    const end = 1_785_207_229_000
    const start = end - 7 * 86_400_000
    await ingest.pull({ start, end, limit: 50, cursor: null })
    const search = calls.find((args) => args[1] === "+messages-search") ?? []
    const startArg = search[search.indexOf("--start") + 1] ?? ""
    // 传的是 spec.start 那一天，而不是某个写死的下界
    expect(startArg.startsWith(new Date(start).toISOString().slice(0, 10))).toBe(true)
  })
})
