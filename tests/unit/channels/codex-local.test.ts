/**
 * 本地 Codex 通道：只收用户输入，并且授权按 vault 显式保存。
 *
 * fixture 只保留真实 JSONL 的字段形状，所有 id、标题和正文均为编造值。
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { createCodexLocalPlugin } from "@mycontext/channels"
import { isAppError } from "@mycontext/kernel"

const FIRST_AT = Date.parse("2026-08-20T08:00:00.000Z")
const SECOND_AT = Date.parse("2026-08-20T09:00:00.000Z")

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function sessionMeta(id: string, at: number): string {
  return line({
    timestamp: new Date(at).toISOString(),
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      timestamp: new Date(at).toISOString(),
      cwd: "/workspace/example",
      cli_version: "0.0.0-test",
    },
  })
}

function sessionMetaWithSharedSession(id: string, sharedSessionId: string, at: number): string {
  return line({
    timestamp: new Date(at).toISOString(),
    type: "session_meta",
    payload: {
      id,
      session_id: sharedSessionId,
      timestamp: new Date(at).toISOString(),
      cwd: "/workspace/example",
      cli_version: "0.0.0-test",
    },
  })
}

function userMessage(text: string, at: number): string {
  return line({
    timestamp: new Date(at).toISOString(),
    type: "event_msg",
    payload: { type: "user_message", message: text, images: [], local_images: [] },
  })
}

function excludedRecords(at: number): string {
  return [
    line({
      timestamp: new Date(at).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "FAKE_ENVIRONMENT_SECRET" }],
      },
    }),
    line({
      timestamp: new Date(at).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "FAKE_MODEL_ANSWER" }],
      },
    }),
    line({
      timestamp: new Date(at).toISOString(),
      type: "response_item",
      payload: { type: "custom_tool_call_output", output: "FAKE_COMMAND_OUTPUT" },
    }),
  ].join("")
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mycontext-codex-local-"))
  const sessions = join(root, "sessions", "2026", "08", "20")
  const archived = join(root, "archived_sessions")
  await mkdir(sessions, { recursive: true })
  await mkdir(archived, { recursive: true })
  await writeFile(
    join(root, "session_index.jsonl"),
    line({ id: "session-active-fake", thread_name: "重构本地索引", updated_at: "fake" }),
  )
  const activePath = join(sessions, "rollout-active-fake.jsonl")
  await writeFile(
    activePath,
    [
      sessionMeta("session-active-fake", FIRST_AT),
      excludedRecords(FIRST_AT + 1),
      userMessage("请整理这个模块的边界", FIRST_AT + 2),
    ].join(""),
  )
  await writeFile(
    join(archived, "rollout-archived-fake.jsonl"),
    [
      sessionMeta("session-archived-fake", SECOND_AT),
      userMessage("归档任务里的输入", SECOND_AT + 2),
    ].join(""),
  )
  return { root, activePath }
}

function pluginFor(root: string, consentRoot = "") {
  return createCodexLocalPlugin({
    recordsRoot: () => root,
    consentRoot: () => consentRoot,
  })
}

describe("CodexLocalRecordReader", () => {
  it("列出活跃与归档任务，活跃任务使用本地索引标题", async () => {
    const { root } = await fixture()
    const plugin = pluginFor(root)

    const result = await plugin.conversations!.list()

    expect(result.truncated).toBe(false)
    expect(result.items).toHaveLength(2)
    expect(result.items.find((item) => item.externalId === "session-active-fake")?.title).toBe(
      "重构本地索引",
    )
    expect(result.items.find((item) => item.externalId === "session-archived-fake")?.title).toMatch(
      /^本地任务/,
    )
  })

  it("优先使用任务 id，不能把共享 session_id 的派生任务折叠", async () => {
    const root = mkdtempSync(join(tmpdir(), "mycontext-codex-shared-session-"))
    const sessions = join(root, "sessions")
    await mkdir(sessions, { recursive: true })
    await writeFile(
      join(sessions, "rollout-a.jsonl"),
      sessionMetaWithSharedSession("task-a-fake", "shared-session-fake", FIRST_AT),
    )
    await writeFile(
      join(sessions, "rollout-b.jsonl"),
      sessionMetaWithSharedSession("task-b-fake", "shared-session-fake", SECOND_AT),
    )
    const plugin = pluginFor(root)

    const result = await plugin.conversations!.list()

    expect(result.items.map((item) => item.externalId).sort()).toEqual([
      "task-a-fake",
      "task-b-fake",
    ])
  })

  it("只采 event_msg.user_message，排除环境注入、模型回答与工具输出", async () => {
    const { root } = await fixture()
    const plugin = pluginFor(root)

    const page = await plugin.ingest.pull({
      start: FIRST_AT,
      end: SECOND_AT - 1,
      cursor: null,
      limit: 20,
    })

    expect(page.messages.map((message) => message.contentText)).toEqual(["请整理这个模块的边界"])
    expect(page.messages[0]?.senderExternalId).toBe("local-user")
    expect(page.rawPayload).not.toContain("FAKE_ENVIRONMENT_SECRET")
    expect(page.rawPayload).not.toContain("FAKE_MODEL_ANSWER")
    expect(page.rawPayload).not.toContain("FAKE_COMMAND_OUTPUT")
  })

  it("游标按时间与稳定消息 id 翻页，文件追加后缓存会失效", async () => {
    const { root, activePath } = await fixture()
    const plugin = pluginFor(root)
    const window = { start: FIRST_AT, end: SECOND_AT + 10_000, limit: 1 }

    const first = await plugin.ingest.pull({ ...window, cursor: null })
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).not.toBeNull()

    const second = await plugin.ingest.pull({ ...window, cursor: first.nextCursor })
    expect(second.messages.map((message) => message.contentText)).toEqual(["归档任务里的输入"])

    await appendFile(activePath, userMessage("追加的一轮输入", SECOND_AT + 3))
    const afterAppend = await plugin.ingest.pull({
      start: SECOND_AT + 3,
      end: SECOND_AT + 10_000,
      limit: 1,
      cursor: null,
    })
    expect(afterAppend.messages.map((message) => message.contentText)).toEqual(["追加的一轮输入"])
  })
})

describe("CodexLocalAuth", () => {
  it("未显式同意时不连接；授权和退出只改当前 vault 的标记", async () => {
    const { root } = await fixture()
    const consentRoot = mkdtempSync(join(tmpdir(), "mycontext-codex-consent-"))
    const auth = pluginFor(root, consentRoot).auth
    const onProgress = vi.fn()

    await expect(auth.status()).resolves.toEqual({ state: "unauthorized" })
    const connected = await auth.login({
      mode: "loopback",
      signal: new AbortController().signal,
      onProgress,
    })

    expect(connected.state).toBe("authorized")
    await expect(auth.status()).resolves.toMatchObject({
      state: "authorized",
      userId: "local-user",
    })
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "succeeded" }))
    await expect(auth.logout()).resolves.toBe(true)
    await expect(auth.status()).resolves.toEqual({ state: "unauthorized" })
  })

  it("记录目录不存在时快速失败并给稳定错误码", async () => {
    const consentRoot = mkdtempSync(join(tmpdir(), "mycontext-codex-consent-"))
    const auth = pluginFor(join(consentRoot, "missing"), consentRoot).auth

    let thrown: unknown
    try {
      await auth.login({
        mode: "loopback",
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      })
    } catch (error) {
      thrown = error
    }
    expect(isAppError(thrown) && thrown.code).toBe("CHANNEL_LOCAL_RECORDS_UNAVAILABLE")
  })

  it("插件声明只读 chat、无发送能力且只提供单一授权入口", async () => {
    const { root } = await fixture()
    const consentRoot = mkdtempSync(join(tmpdir(), "mycontext-codex-consent-"))
    const plugin = pluginFor(root, consentRoot)

    expect(plugin.meta.id).toBe("codex")
    expect(plugin.capabilities.domains).toEqual(["chat"])
    expect(plugin.capabilities.sendAs).toEqual([])
    expect(plugin.auth.supportedModes?.()).toEqual(["loopback"])
  })
})
