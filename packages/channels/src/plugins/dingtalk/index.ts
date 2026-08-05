/**
 * 钉钉渠道插件。
 *
 * capabilities 反映的是第一期的真实能力：
 * - ingest 只有 poll（本人身份走 dws CLI 拉取；机器人推送本期不做）
 * - changeProbe 为 true（实测 list-unread-conversations 仅 0.7s，可作廉价探针）
 * - sendAs 只有 self（以本人身份回复，不建机器人）
 */
import type { DingTalkAuthOptions } from "./auth.js"
import { DingTalkAuth } from "./auth.js"
import { createDingTalkAvatars } from "./avatar.js"
import { DwsCli } from "./cli.js"
import { createDingTalkConversations } from "./conversations.js"
import { createDingTalkDocuments } from "./documents.js"
import { DingTalkEventConsumer } from "./events.js"
import { createDingTalkIdentity, createDingTalkIngest } from "./ingest.js"
import { createDingTalkMinutes } from "./minutes.js"
import type { ChannelPlugin } from "../../types.js"

export function createDingTalkPlugin(options: DingTalkAuthOptions): ChannelPlugin {
  // 采集与授权共用同一套 runtime/processes：命令白名单与超时策略只有一处。
  const cli = new DwsCli({
    runtime: options.runtime,
    processes: options.processes,
    logger: options.logger,
  })

  return {
    meta: {
      id: "dingtalk",
      labelKey: "channels:dingtalk.label",
      descriptionKey: "channels:dingtalk.description",
      available: true,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      ingest: ["poll"],
      changeProbe: true,
      media: false,
      sendAs: ["self"],
      domains: ["chat", "contact", "doc", "minutes"],
    },
    auth: new DingTalkAuth(options),
    ingest: createDingTalkIngest(cli),
    identity: createDingTalkIdentity(cli),
    minutes: createDingTalkMinutes(cli),
    /**
     * 文档（知识库 wiki + 钉盘最近访问）。
     *
     * ★ 这条以前被判成"做不到"（消息里的 fileId 与 doc read 的 --node
     * 不是同一套 ID）。实测 drive recent / wiki node list **直接给 nodeId**，
     * 正向枚举即可 —— 见 documents.ts 文件头。
     */
    documents: createDingTalkDocuments(cli),
    conversations: createDingTalkConversations(cli),
    /**
     * 实时事件（DingTalk Stream 长连接）。工厂而非实例：它要在登录后带上
     * onSignal 才起（见 types.ts 的 ChannelEvents 注释与 events.ts 文件头）。
     * runtime/processes/logger 沿用插件这一套，clock/onSignal 由数据面在 attach 时给。
     */
    events: (deps) =>
      new DingTalkEventConsumer({
        runtime: options.runtime,
        processes: options.processes,
        logger: options.logger.child("Events"),
        clock: deps.clock,
        onSignal: deps.onSignal,
      }),
    /**
     * 头像：钉钉只有 `ofUser`（群头像拿不到，见 avatar.ts 文件头）。
     * 「怎么才能拿到头像」这份钉钉特有的知识收在插件里。
     */
    avatars: createDingTalkAvatars(cli),
    // 媒体下载：只透出跑命令的能力，落地路径由宿主决定（见 types.ts）
    mediaRunner: cli,
  }
}

export { DingTalkAuth } from "./auth.js"
export type { DingTalkAuthOptions } from "./auth.js"
export { createDingTalkAvatars } from "./avatar.js"
export { createDingTalkIngest, createDingTalkIdentity } from "./ingest.js"
export { createDingTalkMinutes } from "./minutes.js"
export { createDingTalkConversations } from "./conversations.js"
export { createDingTalkDocuments, DingTalkDocuments, isReadableDocExtension } from "./documents.js"
export type { ParsedDocument, ParsedDocumentPage } from "./documents.js"
export { DingTalkEventConsumer, parseEventLine } from "./events.js"
export type {
  DingTalkEventConsumerOptions,
  DingTalkEventSignal,
  EventStreamHealth,
  EventSubscriptionAudit,
  EventStreamState,
} from "./events.js"
