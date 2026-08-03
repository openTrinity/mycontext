/** Read-only Feishu source: OAuth + Drive/IM ingestion, deliberately no persona/send. */
import type { ChannelPlugin } from "../../types.js"
import { FeishuAuth, type FeishuPluginOptions } from "./auth.js"
import { LarkCli } from "./cli.js"
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
  }
}

export { FeishuAuth } from "./auth.js"
export type { FeishuPluginOptions } from "./auth.js"
export { LarkCli, assertAllowedLarkCommand, extractLarkJson } from "./cli.js"
export { createFeishuIngest, createFeishuIdentity } from "./ingest.js"
export {
  LARK_AUTH_SCOPES,
  parseLarkAuthStatus,
  parseLarkDeviceGrant,
  parseLarkDrivePage,
  parseLarkMessagePage,
} from "./parse.js"
