/** 本地编码助手记录：显式授权后，只读采集用户主动输入。 */
import type { ChannelPlugin } from "../../types.js"
import { CODEX_LOCAL_IDENTITY, CodexLocalAuth, type CodexLocalAuthOptions } from "./auth.js"
import { CodexLocalRecordReader, type CodexLocalRecordReaderOptions } from "./records.js"

export interface CodexLocalPluginOptions
  extends CodexLocalAuthOptions,
    CodexLocalRecordReaderOptions {}

export function createCodexLocalPlugin(options: CodexLocalPluginOptions): ChannelPlugin {
  const reader = new CodexLocalRecordReader(options)
  return {
    meta: {
      id: "codex",
      labelKey: "channels:codex.label",
      descriptionKey: "channels:codex.description",
      available: true,
    },
    capabilities: {
      chatTypes: ["direct"],
      ingest: ["poll"],
      changeProbe: true,
      media: false,
      sendAs: [],
      domains: ["chat"],
      isolatedCredentials: true,
    },
    auth: new CodexLocalAuth(options),
    ingest: {
      probe: async (signal) => await reader.probe(signal),
      pull: async (spec) => await reader.pull(spec),
    },
    identity: {
      resolveSelf: async () => CODEX_LOCAL_IDENTITY,
    },
    conversations: {
      list: async (signal) => await reader.conversations(signal),
    },
    exportProfile: {
      workspaceId: "workspace:local-coding-agent",
      workspaceLabel: "本地编码助手",
      deepLinkScheme: "mycontext",
      senderIdField: "senderLocalUserId",
    },
  }
}
