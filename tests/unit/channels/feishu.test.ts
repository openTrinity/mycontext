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
    /**
     * ★ 按**命令名**找那次 login，不再用 `calls[0]`：钥匙串降级现在排在
     * 它前面（见下面那段长注释）。按下标取会让"顺序变了"表现成
     * "scope 变空了"，而那是个误导性的失败信息。
     */
    const loginCall = calls.find((args) => args[0] === "auth" && args[1] === "login")
    const requestedScopes = loginCall?.[3]?.split(",") ?? []
    expect(requestedScopes).toEqual(REQUIRED_SCOPES)
    expect(calls.map((args) => args.join(" "))).toEqual([
      /**
       * ★★★ 钥匙串降级是**第一条**命令，在 `auth login` 之前。
       *
       * 这条测试原来锁的是旧顺序（downgrade 排在 `auth login` 之后、
       * 且断言它在"开浏览器"之后）—— 而那正是那个系统弹窗的成因：
       * macOS 上 `config init` / `auth login` 会先去问系统钥匙串，
       * 而我们的 HOME 指向 vault、那里没有钥匙串条目，于是弹出
       * 「找不到用于储存 "master.key" 的钥匙串」，选项是取消 / 还原为默认
       * （后者会往用户真实的登录钥匙串里写，正是要避免的）。
       *
       * 实测（2026-08，随包 CLI）：空的隔离 HOME 里直接跑
       * `config keychain-downgrade` 就能成功并写出 master.key.file，
       * 且明确 "The OS Keychain was not modified" —— 所以先降级是可行的，
       * 也是唯一能挡住弹窗的位置。
       */
      "config keychain-downgrade",
      expect.stringContaining("auth login --scope"),
      /**
       * ★★ `--json` 是必须的，而这条测试原来锁的是**漏掉它**的那一版。
       *
       * 不带 `--json` 时这条命令的 stdout 是给人看的：先一整段以
       * `[AI agent] ` 开头的使用提示（里面有括号）、再一行「等待用户授权...」、
       * 最后才是 JSON。而 `extractLarkJson` 逐个候选起点试 parse，
       * 提示文本里的括号会先命中 → 抛「飞书 CLI 返回了无法解析的内容」。
       *
       * 实测（本机 CLI 日志 2026-08-08 17:16）：那一刻 `/oauth/token`
       * 已经 status=200、`auth status --verify` 显示 tokenStatus valid ——
       * **授权真的成功了**，我们却给用户弹了一条红字。
       *
       * 也就是说这条断言当时把一个 bug 锁成了"期望行为"。
       */
      "auth login --device-code device-1 --json",
      "auth status --json --verify",
    ])
    /**
     * ★★ 降级必须在**开浏览器之前** —— 与改动前的断言恰好相反。
     *
     * 弹窗出现在"点了开始授权"之后、浏览器打开之前，用户看到的是一个
     * 突然冒出来的系统安全框而不是授权页。降级排在最前面才没有那个窗口。
     */
    expect(calls.findIndex((args) => args.join(" ") === "config keychain-downgrade")).toBe(0)
    expect(events.indexOf("open browser")).toBeGreaterThan(-1)
  })

  /**
   * ★★ 不许索要**没有调用点**的权限。
   *
   * 多要一个不是"以后可能有用"，而是现在就让用户授出了我们并不读的数据面
   * （CLAUDE.md 第 5 节）。
   *
   * ## ★★ 判据是「CLI 让不让我们调这条命令」，不是「我们用不用这份数据」
   *
   * 这个区别是真机验证逼出来的。`im:message.reactions:read` 曾经在这个
   * 名单里 —— 理由是"实现显式传了 `--no-reactions`，所以用不到 reactions"。
   * 那个推理错了：CLI 把这个 scope 声明在**命令**上并在 **pre-flight 阶段**
   * 校验（它自己的文档：`already declared in each shortcut's UserScopes …
   * pre-flight check surfaces a missing_scope error before the request is
   * sent`）。而 `--no-reactions` 只影响请求发出**之后**的行为。
   *
   * 删掉它的实测表现：授权能过，但每次拉消息都
   * `missing required scope(s): im:message.reactions:read` —— **一条都采不到**。
   *
   * 所以这个名单里只留**命令本身不需要**的那些。要动它：先真机跑一次
   * 那条命令，不能只读我们自己的代码。
   */
  it("★★ 不索要没有调用点的权限（会议 / 媒体 / 联系人反查 / pins / 表格）", () => {
    const forbidden = [
      // 插件没有 minutes 能力（index.ts 里没挂），四项一次都没调过
      "minutes:minutes.search:read",
      "minutes:minutes.basic:read",
      "minutes:minutes.artifacts:read",
      "minutes:minutes.media:export",
      // 没有媒体下载能力
      "docs:document.media:download",
      // 表格取不到正文（readableExtensions 里就没有它）
      "sheets:spreadsheet:read",
      // ★ 按名字**反查人**是一个明显更大的读取面（CLAUDE.md 第 5 节点名了这类）
      "contact:user:search",
      "contact:user.basic_profile:readonly",
      // pins 从来没读过，且不像 reactions 那样是命令的必需 scope（实测）
      "im:message.pins:read",
      // wiki 枚举没有调用点（云文档走 drive +search）
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

  /**
   * ★★★ 授权的两个过期时间必须**从 CLI 的响应里读**，不许硬编码 null。
   *
   * ## 实测的坏形态（用户截图 2026-08-10）
   *
   * 设置页飞书那一栏「凭证刷新至 —」「需重新授权 —」两行都是空的，
   * 而钉钉那栏有真日期。原因是 `parseLarkAuthStatus` 里那三个字段写死了
   * `null` —— 而 CLI **给了**它们（本机实测 `auth status --json --verify`）：
   *
   *     identities.user.expiresAt        2026-08-10T19:42:17+08:00
   *     identities.user.refreshExpiresAt 2026-08-17T17:42:17+08:00
   *
   * 也就是说不是"渠道拿不到"，是这一层没读。
   *
   * ★ 这里的 payload 形状照**真实响应**（键名与嵌套层级），值全是编的。
   *   形状错了就测不到真问题（那是本仓库 fixture 的一贯要求）。
   */
  it("★★★ 授权时间从 identities.user 读出来（原来硬编码 null → 界面两行「—」）", () => {
    const now = new Date("2026-08-10T10:00:00.000Z")
    const status = parseLarkAuthStatus(
      {
        verified: true,
        identities: {
          user: {
            openId: "ou_self",
            userName: "A同学",
            tenantKey: "tenant",
            tenantName: "示例租户",
            status: "ready",
            tokenStatus: "valid",
            scope: REQUIRED_SCOPES.join(" "),
            expiresAt: "2026-08-10T19:42:17+08:00",
            refreshExpiresAt: "2026-08-17T17:42:17+08:00",
          },
        },
      },
      now,
    )

    expect(status.state).toBe("authorized")
    if (status.state !== "authorized") return
    expect(status.accessExpiresAt).toBe("2026-08-10T19:42:17+08:00")
    expect(status.refreshExpiresAt).toBe("2026-08-17T17:42:17+08:00")
    // 8-10 10:00Z → 8-17 09:42Z，差 6 天多 → floor = 6（与钉钉同一个 daysUntil）
    expect(status.daysUntilRefreshExpiry).toBe(6)
  })

  /**
   * ★★ 取不到时是 `null`，**不是 0**。
   *
   * `daysUntil` 对无法解析的串返回 0，而 0 的意思是"今天就到期" ——
   * 那与"不知道"完全不同：界面会催用户去重新授权一个其实还有效的凭据。
   */
  it("★★ CLI 没给时间时是 null 而不是 0（0 = 今天到期，是另一件事）", () => {
    const status = parseLarkAuthStatus({
      verified: true,
      identities: {
        user: {
          openId: "ou_self",
          userName: "A同学",
          tenantKey: "tenant",
          tenantName: "示例租户",
          status: "ready",
          scope: REQUIRED_SCOPES.join(" "),
        },
      },
    })

    expect(status.state).toBe("authorized")
    if (status.state !== "authorized") return
    expect(status.refreshExpiresAt).toBeNull()
    expect(status.daysUntilRefreshExpiry).toBeNull()
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
      json: <T>(): Promise<T> =>
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
      json: <T>(): Promise<T> =>
        Promise.resolve({ results: [{ title: "没有 token 的东西", summary: "x" }] } as T),
    })
    await expect(documents.list({})).resolves.toMatchObject({ items: [] })
  })

  it("★ body() 恒返回 null 且不抛（某一篇取不到是常态而非错误）", async () => {
    const documents = createFeishuDocuments({ json: <T>(): Promise<T> => Promise.resolve({} as T) })
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
      json: <T>(): Promise<T> =>
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
