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
export type { VaultStoreOptions } from "./vault.js"

export { SessionStore, SESSION_SETTING_KEY } from "./session.js"

// ---------------------------------------------------------------
// 数据面（M2）
// ---------------------------------------------------------------

export { withTransaction, openConnection } from "./tx.js"

export { RawRecordRepository } from "./repositories/raw-records.js"
export type { RawInsertResult } from "./repositories/raw-records.js"

export {
  ConversationRepository,
  ActorRepository,
  SelfIdentityRepository,
} from "./repositories/conversations.js"
export type { PersonaConversationExclusionReason } from "./repositories/conversations.js"

export { MessageRepository } from "./repositories/messages.js"
export type { MessageUpsertResult } from "./repositories/messages.js"

export { MediaAssetRepository, MinutesRepository } from "./repositories/media-minutes.js"
export { DocumentRepository } from "./repositories/documents.js"
export type { DocumentUpsertResult } from "./repositories/documents.js"
export type { MediaAssetRow, MinutesUpsertResult } from "./repositories/media-minutes.js"

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
