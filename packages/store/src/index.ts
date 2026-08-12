export { openStore, runMigrations } from "./database.js"
export type {
  SqliteDatabase,
  StoreHandle,
  AppliedMigration,
  OpenDatabaseOptions,
} from "./database.js"

export { MIGRATIONS, CONTROL_MIGRATIONS, VAULT_MIGRATIONS } from "./migrations.js"
export type { Migration } from "./migrations.js"

export { stripSqlComments, schemaChecksum, rawChecksum } from "./migration-checksum.js"
export {
  VAULT_0002_LEGACY_CHECKSUMS,
  VAULT_0009_LEGACY_CHECKSUMS,
} from "./migration-legacy-checksums.js"

export { AccountRepository, SettingsRepository } from "./accounts.js"
export type { AccountRecord, CreateAccountInput, SettingsTable } from "./accounts.js"

export { VaultStore } from "./vault.js"
export type { VaultStoreOptions, VaultPaths } from "./vault.js"

export {
  ChannelIdentityVaultRepository,
  identityKeyString,
  parseIdentityKeyString,
} from "./channel-identity-vaults.js"
export type { ChannelIdentityVaultRecord, ChannelIdentityKey } from "./channel-identity-vaults.js"

export { SessionStore, SESSION_SETTING_KEY } from "./session.js"

// ---------------------------------------------------------------
// 数据面（M2）
// ---------------------------------------------------------------

export { withTransaction, openConnection } from "./tx.js"

/**
 * 采集范围（用户在引导里勾的会话 + 时间范围）的**唯一权威**与越界清理。
 *
 * 放在 store 而不是各 service 里：它同时被采集、蒸馏、forge、导出四处读，
 * 而修复前那四处各有一份实现且语义已经漂了（见 collection-scope.ts 文件头）。
 */
export { readCollectionScope, isConversationInScope, isSentAtInScope } from "./collection-scope.js"
export type { CollectionScope } from "./collection-scope.js"
export { purgeOutOfScopeMessages } from "./purge-scope.js"
export type { PurgeReport } from "./purge-scope.js"

/**
 * 把一个 vault 清回「刚登录完、还没采过」的状态。
 *
 * 同样放在 store：设置页那个「清空当前渠道的数据」与 `scripts/reset-vault.mjs`
 * 走**同一份**判据 —— 那里面有三条硬约束（FTS 虚表必须先删、changelog 序列
 * 与消费者游标必须一起清零、外键要显式打开），抄第二份必然漂，
 * 而漂的后果全是静默的数据损坏。见 wipe-vault.ts 文件头。
 */
export { wipeVaultData, VAULT_DATA_TABLES, VAULT_SEARCH_TABLES } from "./wipe-vault.js"
export type { WipeVaultReport, WipeVaultOptions } from "./wipe-vault.js"

export { RawRecordRepository } from "./repositories/raw-records.js"
export type { RawInsertResult } from "./repositories/raw-records.js"

export {
  ConversationRepository,
  ActorRepository,
  SelfIdentityRepository,
  inferSelfExternalIdFromDirectChats,
} from "./repositories/conversations.js"
export type { PersonaConversationExclusionReason } from "./repositories/conversations.js"
export type { SelfExternalIdInference } from "./repositories/conversations.js"

export { MessageRepository } from "./repositories/messages.js"
export type { MessageUpsertResult } from "./repositories/messages.js"

export {
  MediaAssetRepository,
  MinutesRepository,
  MinutesCoverageRepository,
} from "./repositories/media-minutes.js"
export { ChatCoverageRepository, toDayBucket } from "./repositories/chat-coverage.js"
export type { ChatCoverageRow, ChatCoverageDay } from "./repositories/chat-coverage.js"
export { DocumentRepository } from "./repositories/documents.js"
export type { DocumentUpsertResult } from "./repositories/documents.js"
export type {
  MediaAssetRow,
  MinutesUpsertResult,
  MinutesCoverageRow,
} from "./repositories/media-minutes.js"

export { ContactAvatarRepository, AVATAR_RETRY_AFTER_MS } from "./repositories/contact-avatars.js"
export type { ContactAvatarRow, AvatarMissReason } from "./repositories/contact-avatars.js"

export {
  ChangelogRepository,
  ConsumerCursorRepository,
  LEASE_TTL_MS,
  LEASE_RENEW_MS,
} from "./repositories/changelog.js"

export { SyncCursorRepository, ProbeSnapshotRepository } from "./repositories/cursors.js"
export type { ProbeSnapshot } from "./repositories/cursors.js"

export { CHANGELOG_ENTITY_TYPES, CHANGELOG_DOMAINS } from "./repositories/types.js"
export type {
  ChannelIdValue,
  RawRecordInput,
  ActorInput,
  ConversationInput,
  ConversationRow,
  MessageInput,
  MessageRow,
  MessageMentionInput,
  MediaAssetInput,
  MinutesInput,
  MinutesRow,
  DocumentInput,
  DocumentRow,
  ChangelogEntityType,
  ChangelogDomain,
  ChangelogEntryInput,
  ChangelogRow,
  SelfIdentityRecord,
  SyncCursorRow,
  ConsumerCursorRow,
} from "./repositories/types.js"

export { RetentionRunner, collectStorageStats } from "./retention.js"
export type { RetentionOptions, RetentionReport, StorageStats } from "./retention.js"

export { FtsIndexRepository, VectorRepository } from "./repositories/index-tables.js"
export type { FtsHit, VectorRecord } from "./repositories/index-tables.js"

export { PersonaConfigRepository, PersonaRunRepository } from "./repositories/persona.js"
export type {
  DhConversationConfigRow,
  DhDraftRow,
  DhRunRow,
  PersonaActivityRow,
  PersonaRunDetailRow,
  PersonaTraceInput,
  PersonaTraceRow,
  ReplyMode,
  TriggerMode,
} from "./repositories/persona.js"

export { DistillTaskRepository } from "./repositories/distill-tasks.js"
export type {
  DistillTaskRow,
  DistillTaskState,
  DistillProgress,
} from "./repositories/distill-tasks.js"

export { ProfileFacetRepository } from "./repositories/profile-facets.js"
export type { ProfileFacetRow, FacetWrite } from "./repositories/profile-facets.js"

export { SearchSessionRepository } from "./repositories/search-sessions.js"

export {
  OnboardingRepository,
  DistillSourceRepository,
  ONBOARDING_STEPS,
  DISTILL_SOURCE_KINDS,
} from "./repositories/onboarding.js"
export type {
  OnboardingStep,
  OnboardingStepState,
  OnboardingStepRow,
  DistillSourceKind,
  DistillSourceRow,
  DistillScope,
} from "./repositories/onboarding.js"
export type {
  SearchSessionRow,
  SearchMessageRow,
  CreateSearchSessionInput,
  AppendSearchMessageInput,
} from "./repositories/search-sessions.js"
