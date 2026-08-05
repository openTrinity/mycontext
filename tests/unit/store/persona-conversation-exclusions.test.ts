import { describe, expect, it } from "vitest"
import {
  ActorRepository,
  ConversationRepository,
  MessageRepository,
  PersonaConfigRepository,
  PersonaRunRepository,
  SelfIdentityRepository,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_785_306_600_000

function addConversation(
  vault: ReturnType<typeof openTestVault>,
  input: {
    id: string
    title: string
    type?: "direct" | "group"
    messages: { id: string; isSelf: boolean; senderActorId?: string }[]
  },
): void {
  new ConversationRepository(vault.db).upsert({
    id: input.id,
    channelId: "dingtalk",
    externalId: `cid-${input.id}`,
    type: input.type ?? "direct",
    title: input.title,
    createdAt: NOW,
  })
  new MessageRepository(vault.db).upsertMany(
    input.messages.map((message, index) => ({
      id: message.id,
      channelId: "dingtalk",
      conversationId: input.id,
      externalId: `ext-${message.id}`,
      ...(message.senderActorId === undefined ? {} : { senderActorId: message.senderActorId }),
      senderExternalId: message.isSelf ? "self" : `other-${input.id}`,
      senderDisplayName: message.isSelf ? "我" : input.title,
      contentText: "消息",
      sentAt: NOW + index,
      direction: message.isSelf ? ("outbound" as const) : ("inbound" as const),
      isSelf: message.isSelf,
      createdAt: NOW + index,
    })),
  )
}

describe("Persona 会话排除分类", () => {
  it("BuildBot这类只有对方消息的系统助手单聊被排除", () => {
    const vault = openTestVault()
    addConversation(vault, {
      id: "buildbot",
      title: "BuildBot",
      messages: [{ id: "buildbot-message", isSelf: false }],
    })

    const conversations = new ConversationRepository(vault.db)
    expect(conversations.personaExclusionReason("buildbot")).toBe("bot_channel")
    expect(new PersonaConfigRepository(vault.db).listWithConversations()).toEqual([])
    vault.close()
  })

  it("公益3小时这类平台公益入口也被排除", () => {
    const vault = openTestVault()
    addConversation(vault, {
      id: "public-service",
      title: "公益3小时",
      messages: [{ id: "public-service-message", isSelf: false }],
    })

    expect(new ConversationRepository(vault.db).personaExclusionReason("public-service")).toBe(
      "bot_channel",
    )
    vault.close()
  })

  it("标题带助手但双方真实聊过，不按名称误判为 bot", () => {
    const vault = openTestVault()
    addConversation(vault, {
      id: "human-assistant",
      title: "项目助手",
      messages: [
        { id: "assistant-in", isSelf: false },
        { id: "assistant-out", isSelf: true },
      ],
    })

    const conversations = new ConversationRepository(vault.db)
    expect(conversations.personaExclusionReason("human-assistant")).toBeNull()
    expect(new PersonaConfigRepository(vault.db).listWithConversations()).toHaveLength(1)
    vault.close()
  })

  it("只有本人消息的单聊识别为自聊", () => {
    const vault = openTestVault()
    const identities = new SelfIdentityRepository(vault.db)
    identities.upsert({
      channelId: "dingtalk",
      userId: "self-user",
      openIds: [{ kind: "openDingTalkId", value: "self" }],
      displayNames: ["顾清和", "小吴"],
      corpId: null,
      corpName: null,
    })
    identities.confirm("dingtalk", NOW)
    addConversation(vault, {
      id: "self-chat",
      title: "小吴",
      messages: [{ id: "self-message", isSelf: true }],
    })

    expect(new ConversationRepository(vault.db).personaExclusionReason("self-chat")).toBe(
      "self_conversation",
    )
    vault.close()
  })

  it("只有本人消息但标题不是本人姓名时，仍视为普通单聊", () => {
    const vault = openTestVault()
    const identities = new SelfIdentityRepository(vault.db)
    identities.upsert({
      channelId: "dingtalk",
      userId: "self-user",
      openIds: [{ kind: "openDingTalkId", value: "self" }],
      displayNames: ["顾清和", "小吴"],
      corpId: null,
      corpName: null,
    })
    identities.confirm("dingtalk", NOW)
    addConversation(vault, {
      id: "partial-human-chat",
      title: "小徐",
      messages: [{ id: "partial-self-message", isSelf: true }],
    })

    expect(
      new ConversationRepository(vault.db).personaExclusionReason("partial-human-chat"),
    ).toBeNull()
    vault.close()
  })

  it("所有对方消息来自 bot/system actor 时，不依赖标题也能识别", () => {
    const vault = openTestVault()
    new ActorRepository(vault.db).upsert({
      id: "bot-actor",
      channelId: "dingtalk",
      externalId: "bot-external",
      kind: "bot",
      displayName: "自动服务",
      seenAt: NOW,
    })
    addConversation(vault, {
      id: "actor-bot",
      title: "自动服务",
      messages: [{ id: "actor-bot-message", isSelf: false, senderActorId: "bot-actor" }],
    })

    expect(new ConversationRepository(vault.db).personaExclusionReason("actor-bot")).toBe(
      "bot_channel",
    )
    vault.close()
  })

  it("运行时清理排除会话中已有的 inbox 与待审草稿", () => {
    const vault = openTestVault()
    addConversation(vault, {
      id: "buildbot",
      title: "BuildBot",
      messages: [{ id: "buildbot-message", isSelf: false }],
    })
    vault.db
      .prepare(
        `INSERT INTO dh_inbox
           (message_id, conversation_id, state, enqueued_at)
         VALUES ('buildbot-message', 'buildbot', 'pending', ?)`,
      )
      .run(NOW)
    new PersonaRunRepository(vault.db).insertDraft(
      {
        id: "buildbot-draft",
        runId: null,
        conversationId: "buildbot",
        replyToExternalId: "ext-buildbot-message",
        text: "收到",
        citations: ["buildbot-message"],
        notSentReason: "mode_not_auto",
      },
      NOW,
    )

    expect(new ConversationRepository(vault.db).cleanupPersonaExclusions(NOW + 1000)).toEqual({
      inbox: 1,
      drafts: 1,
    })
    expect(
      vault.db
        .prepare<
          [],
          { state: string; drop_reason: string }
        >("SELECT state, drop_reason FROM dh_inbox WHERE message_id = 'buildbot-message'")
        .get(),
    ).toEqual({ state: "dropped", drop_reason: "bot_channel" })
    expect(new PersonaRunRepository(vault.db).pendingDrafts()).toEqual([])
    vault.close()
  })
})
