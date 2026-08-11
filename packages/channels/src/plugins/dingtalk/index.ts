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
  const auth = new DingTalkAuth(options)

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
      /**
       * ★ **false** —— token 的密钥在系统钥匙串、按系统用户存一份，与用户
       * 自己终端里的 CLI 共用同一份登录态（实测）。我们退登会连带退掉用户
       * 终端那份，所以界面不提供退出授权/切换账号，只给一句说明。
       */
      isolatedCredentials: false,
    },
    auth,
    ingest: createDingTalkIngest(cli),
    /**
     * ★ 给身份解析一条**授权态退路**。
     *
     * `contact user get-self` 需要 contact 域权限，而实测有客户端对某些企业
     * 没开通它（`ENTERPRISE_NOT_AUTHORIZED`）—— 那时它原本会让整条身份链
     * 断掉，「用这个身份」永远成不了。
     *
     * 而 `auth status` 走 auth 域、本来就返回 `user_id`/`user_name`，
     * 也就是我们要的东西已经在手边。完整的 why 见 `resolveSelf` 的注释。
     */
    identity: createDingTalkIdentity(cli, async () => {
      const status = await auth.status()
      if (status.state !== "authorized") return null
      return {
        userId: status.userId,
        userName: status.userName,
        corpId: status.corpId,
        corpName: status.corpName,
      }
    }),
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
    /**
     * 导出四件套里那些渠道特有的固定值。
     *
     * ★ 这四个值原来是**写死在导出层**的（`export-materializer.ts`）。
     * 值一个字不改地搬过来 —— 尤其 `senderIdField`：那个 payload 是上游
     * 算法侧按名字直接读的，改名要他们同步改代码。
     *
     * `workspaceId` 与上游 `export_chat.py` 的 `WORKSPACE_ID` 同值。
     */
    exportProfile: {
      workspaceId: "workspace:ali-ding",
      workspaceLabel: "钉钉工作区",
      deepLinkScheme: "dingtalk",
      senderIdField: "senderOpenDingTalkId",
    },
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
