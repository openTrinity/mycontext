import { describe, expect, it } from "vitest"
import {
  assertAllowedLarkCommand,
  createFeishuIngest,
  FeishuAuth,
  LARK_AUTH_SCOPES,
  LarkCli,
  parseLarkAuthStatus,
  parseLarkDrivePage,
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

  it("stores Drive search results as durable knowledge-source records", () => {
    const page = parseLarkDrivePage(
      {
        results: [
          { token: "doc_1", title: "路线图", summary: "八月发布", edit_time: 1_785_207_229 },
        ],
      },
      0,
    )
    expect(page.conversations[0]?.externalId).toBe("feishu:drive")
    expect(page.messages[0]).toMatchObject({
      externalId: "drive:doc_1",
      contentText: "路线图\n八月发布",
    })
  })

  it("hydrates message-id searches and carries Drive pagination in the channel cursor", async () => {
    const calls: string[][] = []
    const ingest = createFeishuIngest({
      async json<T>(args: string[]): Promise<T> {
        calls.push(args)
        if (args[0] === "drive") {
          const next = args.includes("--page-token") ? null : "page-2"
          return {
            results: [{ token: next === null ? "doc_2" : "doc_1", title: "文档", summary: "正文" }],
            next_page_token: next,
          } as T
        }
        if (args[1] === "+messages-search") return { message_ids: ["om_1"] } as T
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

    const second = await ingest.pull({
      start: 0,
      end: 1_785_207_229_000,
      limit: 50,
      cursor: first.nextCursor,
    })
    expect(second.hasMore).toBe(false)
    expect(calls.at(-1)).toContain("--page-token")
  })
})
