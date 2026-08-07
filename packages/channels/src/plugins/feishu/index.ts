/** Read-only Feishu source: OAuth + Drive/IM ingestion, deliberately no persona/send. */
import type { ChannelPlugin } from "../../types.js"
import { FeishuAuth, type FeishuPluginOptions } from "./auth.js"
import { LarkCli } from "./cli.js"
import { createFeishuDocuments } from "./documents.js"
import { createFeishuIdentity, createFeishuIngest } from "./ingest.js"

export function createFeishuPlugin(options: FeishuPluginOptions): ChannelPlugin {
  const cli = new LarkCli(options)
  return {
    meta: {
      id: "feishu",
      labelKey: "channels:feishu.label",
      descriptionKey: "channels:feishu.description",
      available: true,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      ingest: ["poll"],
      changeProbe: false,
      media: false,
      sendAs: [],
      domains: ["chat", "doc"],
    },
    auth: new FeishuAuth(options, cli),
    ingest: createFeishuIngest(cli),
    identity: createFeishuIdentity(cli),
    /**
     * ★ 云文档走 `documents` 契约，**不再**伪装成聊天消息。
     *
     * 改动前它走消息那条路（一个合成的假群 `feishu:drive`），四处污染且
     * 都不报错：会话列表多出不存在的群、FTS 把文档当聊天、**消息水位被
     * 文档的编辑时间推进**、图谱生出假群的边。见 `documents.ts` 的文件头。
     */
    documents: createFeishuDocuments(cli),
    /**
     * ★★ 必须给，否则飞书的语料会被打上**钉钉的** workspace id
     * （导出层的缺省），于是两个渠道的会话挂在同一个 workspace 下 ——
     * "这条事实来自哪个渠道"在图里就丢了，而且不报错。
     *
     * `senderIdField` 用中性名：飞书的主 id 是 open_id，与钉钉那个字段
     * 不是同一个体系，共用一个名字会让下游误以为可以互相比对。
     */
    exportProfile: {
      workspaceId: "workspace:feishu",
      workspaceLabel: "飞书工作区",
      deepLinkScheme: "feishu",
      senderIdField: "senderOpenId",
    },
  }
}

export { FeishuAuth } from "./auth.js"
export type { FeishuPluginOptions } from "./auth.js"
export { LarkCli, assertAllowedLarkCommand, extractLarkJson } from "./cli.js"
export { createFeishuIngest, createFeishuIdentity } from "./ingest.js"
export { createFeishuDocuments } from "./documents.js"
export {
  LARK_AUTH_SCOPES,
  parseLarkAuthStatus,
  parseLarkDeviceGrant,
  parseLarkDriveDocuments,
  parseLarkMessagePage,
} from "./parse.js"
