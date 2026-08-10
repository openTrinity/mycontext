export {
  buildOpencodeSpawn,
  resolveGatewayModelConfig,
  resolveModelName,
  DEFAULT_GATEWAY_MODEL,
  assertHardened,
  stripPermissionOverrides,
  assertNoPermissionOverrides,
  DENY_ALL_PERMISSION,
  KL_SKILL_PERMISSION,
  HOST_TOOL_PREFIX,
} from "./spawn-hardening.js"
export type { OpencodeSpawnOptions, HardenedSpawn } from "./spawn-hardening.js"

export { CHAT_ITEM_TYPES, textBlock, toPlainText } from "./chat-item.js"
export type {
  ChatItem,
  ChatItemType,
  ChatItemRole,
  ToolStatus,
  UnifiedContentBlock,
  AgentEvent,
} from "./chat-item.js"

export { ChatItemReducer } from "./reducer.js"
export type { ReducerOptions, ReduceResult } from "./reducer.js"

export { AcpClient } from "./acp/client.js"
export type {
  AcpClientOptions,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  ReverseMethodHandler,
} from "./acp/client.js"

export { mapSessionUpdate } from "./acp/session-update-mapper.js"

export { AcpSupervisor } from "./acp/supervisor.js"
export type {
  AcpSupervisorOptions,
  SessionRecord,
  McpServerSpec,
  EnsureSessionResult,
} from "./acp/supervisor.js"

export {
  createReverseHandlers,
  isAllowlistedTool,
  isInsideWorkspace,
  HOST_TOOLS,
  TOOL_ALLOWLIST,
} from "./acp/reverse-handlers.js"
export type {
  HostToolName,
  PermissionOutcome,
  ReverseHandlerOptions,
} from "./acp/reverse-handlers.js"

export { McpAuth, scopeToConversationFilter } from "./mcp/auth.js"
export type { McpAuthOptions, McpScope, McpTokenKind, IssuedToken } from "./mcp/auth.js"

export { buildKlSkillMarkdown, KL_SKILL_RELPATH } from "./kl-skill.js"

export { installSkills, SKILLS_RELDIR } from "./workspace.js"
export type { SkillSource, InstallSkillsResult } from "./workspace.js"
