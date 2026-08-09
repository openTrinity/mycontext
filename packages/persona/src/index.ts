export {
  evaluatePolicy,
  withinWorkHours,
  POLICY_CONDITIONS,
  DECISION_REASONS,
  CONDITION_TO_REASON,
  MIN_CONFIDENCE,
  UNEVALUATED_CONFIDENCE,
  DEFAULT_WORK_HOURS,
  DEFAULT_RATE_LIMIT,
  REPLY_MODES,
} from "./policy.js"
export type {
  PolicyCondition,
  DecisionReason,
  Decision,
  ReplyMode,
  PolicyInput,
  PolicyVerdict,
  WorkHours,
  RateLimit,
} from "./policy.js"

export { evaluateScene, riskFromScene, SCENE_RULES, MAX_AUTO_LENGTH } from "./scene.js"
export type { SceneRule, SceneInput, SceneVerdict } from "./scene.js"

/**
 * 四个模块之间的契约（只有形状，没有逻辑）。见 `contracts.ts` 的文件头。
 *
 * ★ 只导出 type：这个文件里**不该**有任何运行时值 —— 一旦有，
 * "契约"就会开始携带行为，而行为迟早要求一个真源，那就又回到了
 * 现在这种"同一件事在四个地方各判一遍"的形态。
 */
export type {
  ContextMessage,
  TurnRequest,
  TurnFreshness,
  ReplyProposal,
  MessageClassification,
  RecipientTraits,
  TraitCoverage,
  TurnUnderstanding,
  GuardPolicy,
  SendDecision,
} from "./contracts.js"

/** ① intake —— 收消息与上下文装配。见 `intake.ts` 的文件头。 */
export { TurnAssembler, DEFAULT_INTAKE_POLICY } from "./intake.js"
export type { IntakePolicy, MediaDownloader, TurnAssemblerOptions } from "./intake.js"

/** ③ guard —— 唯一决策点。见 `guard.ts` 的文件头。 */
export {
  PersonaGuard,
  evaluateGate,
  defaultGuardPolicy,
  DEFAULT_ALWAYS_REVIEW_ASK_KINDS,
} from "./guard.js"
export type {
  GateAction,
  GateVerdict,
  ForgeAdvice,
  DraftReview,
  LagVerdict,
  RuntimeGates,
  GuardOptions,
} from "./guard.js"

export { SendGuard, contentHash, assertMentionPlaceholders, SEND_SCOPE } from "./send-guard.js"
export type {
  SendInput,
  SendOutcome,
  SendOutcomeState,
  SendTarget,
  SendGuardOptions,
  DraftSource,
  GrantSource,
  SendExecutor,
} from "./send-guard.js"

export {
  Mailbox,
  MAX_BATCH_SIZE,
  MAX_TURN_ATTEMPTS,
  DEFAULT_BATCH_WINDOW_MS,
  DEFAULT_QUIET_MS,
  READ_REPLY_EXPIRY_MS,
  MAX_GROUP_DRAFTABLE_AGE_MS,
  MAX_DIRECT_DRAFTABLE_AGE_MS,
} from "./mailbox.js"
export type { MailboxOptions, InboxEntry, DropReason, TakenBatch } from "./mailbox.js"

export {
  PersonaSupervisor,
  admit,
  MAX_RESIDENT_AGENTS,
  IDLE_EVICT_MS,
  MAX_CONCURRENT_TURNS,
  DEFAULT_TRIGGER_MODE_DIRECT,
  DEFAULT_TRIGGER_MODE_GROUP,
} from "./supervisor.js"
export type {
  SupervisorOptions,
  AdmissionInput,
  AdmissionVerdict,
  ConversationConfig,
  ResidentAgent,
} from "./supervisor.js"

export {
  createPersonaInboxHandler,
  createPersonaFastPath,
  deliverMessage,
  PERSONA_CONSUMER_ID,
} from "./inbox-consumer.js"
export type { PersonaHandlerOptions } from "./inbox-consumer.js"

export {
  GrantManager,
  RECOMMENDED_TTL,
  RECOMMENDED_TTL_MS,
  RENEWAL_WARNING_MS,
} from "./grant-manager.js"
export type { GrantManagerOptions, GrantRecord } from "./grant-manager.js"
