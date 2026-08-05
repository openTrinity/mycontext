export type {
  ChannelId,
  ChannelMeta,
  ChannelCapabilities,
  ChannelPlugin,
  ChannelAuth,
  AuthStatus,
  AuthMode,
  AuthProgress,
  AuthContext,
  ChannelIngest,
  ChannelIdentity,
  ChannelAvatars,
  ChannelAvatarMiss,
  ChannelAvatarRequest,
  ChannelAvatarResult,
  ChannelProbeResult,
  ChannelPullPage,
  ChannelPullSpec,
  ChannelConversationPullSpec,
  ParsedMessageLike,
  ParsedConversationLike,
  ChannelConversations,
  ChannelEvents,
  ChannelEventsDeps,
  ChannelEventSignal,
  ChannelEventStreamHealth,
  ChannelEventStreamState,
  ChannelEventSubscriptionAudit,
  MediaRunner,
  ChannelConversationItem,
  ChannelConversationList,
  ChannelMinutes,
  ChannelMinutesPage,
  ChannelDocuments,
  ParsedDocumentLike,
  ParsedMinutesLike,
  ParsedMediaLike,
} from "./types.js"

export { createRegistry, ChannelHost } from "./host.js"
export type { ChannelRegistry, StartLoginInput } from "./host.js"

export {
  createDingTalkPlugin,
  DingTalkAuth,
  createDingTalkIngest,
  createDingTalkIdentity,
} from "./plugins/dingtalk/index.js"
export type { DingTalkAuthOptions } from "./plugins/dingtalk/index.js"
export { DingTalkEventConsumer, parseEventLine } from "./plugins/dingtalk/events.js"
export type {
  DingTalkEventConsumerOptions,
  DingTalkEventSignal,
  EventStreamHealth,
  EventStreamState,
} from "./plugins/dingtalk/events.js"

export {
  parseAuthStatus,
  extractJsonObject,
  extractAuthUrl,
  extractDeviceCode,
  extractDeviceVerifyUrl,
  extractDeviceExpiry,
  daysUntil,
} from "./plugins/dingtalk/parse.js"

export { createFeishuPlugin } from "./plugins/feishu/index.js"

export {
  parseLocalTime,
  formatLocalTime,
  parseDwsLocalTime,
  formatDwsLocalTime,
  formatIsoWithOffset,
  formatDwsIsoTime,
  normalizeUnix,
  DINGTALK_TIME_SPEC,
} from "./plugins/dingtalk/time.js"
export type { ChannelTimeSpec } from "./plugins/dingtalk/time.js"

export {
  DwsCli,
  extractJson,
  unwrapEnvelope,
  classifyDwsError,
  requiresHostApproval,
  canAutoConfirm,
  assertAllowedCommand,
  DWS_COMMAND_ALLOWLIST,
} from "./plugins/dingtalk/cli.js"
export type { DwsCliOptions, DwsCommandResult } from "./plugins/dingtalk/cli.js"

export { resolveSelf } from "./plugins/dingtalk/self-identity.js"
export type { ResolvedSelfIdentity } from "./plugins/dingtalk/self-identity.js"

export {
  parseMessageListPage,
  looksTruncated,
  unwrapRichContent,
} from "./plugins/dingtalk/message-parse.js"
export type {
  ParsedMessage,
  ParsedConversation,
  ParsedMessagePage,
} from "./plugins/dingtalk/message-parse.js"

export {
  extractMedia,
  extractMentionTexts,
  mentionsSelf,
} from "./plugins/dingtalk/content-extract.js"
export type { ParsedMedia } from "./plugins/dingtalk/content-extract.js"

export {
  parseMinutesList,
  parseMinutesSummary,
  createDingTalkMinutes,
} from "./plugins/dingtalk/minutes.js"
export type { ParsedMinutes } from "./plugins/dingtalk/minutes.js"

/**
 * 文档（知识库 wiki + 钉盘）。
 *
 * `isReadableDocExtension` 也导出：**导出侧要用同一个后缀判据**
 * —— 两处各写一份必然漂，而漂了的表现是"某类文档突然不进图谱了"。
 */
export {
  createDingTalkDocuments,
  DingTalkDocuments,
  isReadableDocExtension,
} from "./plugins/dingtalk/documents.js"
export type { ParsedDocument, ParsedDocumentPage } from "./plugins/dingtalk/documents.js"

export { createDingTalkConversations } from "./plugins/dingtalk/conversations.js"

/**
 * 头像获取。
 *
 * ## ★ 只出**契约实现**，不出 `fetchAvatar` 本身
 *
 * 改动前这里导出的是裸的 `fetchAvatar`，理由写的是「它需要一个落地目录，
 * 而那是宿主的概念，挂在 plugin 上会让渠道层知道文件系统布局」——
 * 那个顾虑是对的，但结论走偏了：正确的解法是**把 outputDir 放进请求参数**
 * （见 `ChannelAvatarRequest`），而不是把整个能力搬到契约外面。
 *
 * 搬到外面的代价是真实的：`media.service.ts` 于是直接 import 了
 * `fetchAvatar`，而它的入参叫 `openDingTalkId`、失败原因叫
 * `no_common_group` —— 宿主层因此写满了钉钉的词汇，接第二个渠道时
 * 这条路走不通。
 *
 * 现在 `fetchAvatar` 降为插件内部，对外只有 `createDingTalkAvatars`
 * 与契约类型 —— "绕过契约"在结构上就不可能了。
 */
export { createDingTalkAvatars } from "./plugins/dingtalk/avatar.js"

/**
 * 真发送（`SendGuard` 四层里的第 ③ 层）。
 *
 * 单独导出而不是挂在 plugin 上：它只该被 `SendGuard` 拿到，
 * 挂在 plugin 上等于让任何拿到 plugin 的代码都能发消息 ——
 * 而"谁能发消息"是这个项目里最需要收窄的那个能力。
 */
export { createSendExecutor } from "./plugins/dingtalk/send.js"
export type { SendSpec, SendResult, SendTargetKind } from "./plugins/dingtalk/send.js"
