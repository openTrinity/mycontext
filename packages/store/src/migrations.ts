/**
 * 迁移清单。
 *
 * 每个迁移是一个模块内的 SQL 字符串而非独立 .sql 文件：主进程会被 electron-vite
 * 打包成单文件，运行时按相对路径读 .sql 需要额外的 extraResources 拷贝步骤，
 * 打包后极易漏文件。内联 SQL 让「开发态 / 打包态」路径完全一致。
 *
 * 两套清单：
 * - CONTROL_MIGRATIONS：control.sqlite（账号、应用级设置、会话）
 * - VAULT_MIGRATIONS：vaults/<vaultId>/core.sqlite（单个账号的业务数据）
 *
 * 分库而不是给每张业务表挂 accountId：跨账号泄漏从「每个查询都要记得带条件」
 * 变成「打开的是哪个文件」——前者靠自觉，后者靠文件系统。删账号也变成删目录。
 *
 * 规则：
 * - version 单调递增，**已发布的迁移不得再修改**（checksum 会校验）
 * - 新增变更一律追加新 version
 * - vault 的每个版本 SQL 拆到 `migrations/vault/v*.ts`，本文件只组装数组
 */
import { VAULT_0002_RAW_NORMALIZED } from "./migrations/vault/v2-raw-normalized.js"
import { VAULT_0003_OUTBOX } from "./migrations/vault/v3-outbox.js"
import { VAULT_0004_INDEX } from "./migrations/vault/v4-index.js"
import { VAULT_0005_SEARCH } from "./migrations/vault/v5-search.js"
import { VAULT_0006_DISTILL } from "./migrations/vault/v6-distill.js"
import { VAULT_0007_PERSONA } from "./migrations/vault/v7-persona.js"
import { VAULT_0008_MEDIA_MINUTES } from "./migrations/vault/v8-media-minutes.js"
import { VAULT_0009_ONBOARDING } from "./migrations/vault/v9-onboarding.js"
import { VAULT_0010_AVATARS } from "./migrations/vault/v10-avatars.js"
import { VAULT_0011_AVATAR_MISS_RESET } from "./migrations/vault/v11-avatar-miss-reset.js"
import { VAULT_0012_PERSONA_REVIEW } from "./migrations/vault/v12-persona-review.js"
import { VAULT_0013_PERSONA_CONVERSATION_EXCLUSIONS } from "./migrations/vault/v13-persona-conversation-exclusions.js"
import { VAULT_0014_PERSONA_SELF_CONVERSATION } from "./migrations/vault/v14-persona-self-conversation.js"
import { VAULT_0015_PERSONA_PUBLIC_SERVICE_BOTS } from "./migrations/vault/v15-persona-public-service-bots.js"
import { VAULT_0016_PERSONA_REPLY_EXPIRY } from "./migrations/vault/v16-persona-reply-expiry.js"
import { VAULT_0017_SEND_TASK_ID } from "./migrations/vault/v17-send-task-id.js"
import { VAULT_0018_DRAFT_CAP } from "./migrations/vault/v18-draft-cap.js"
import { VAULT_0020_DOCUMENTS } from "./migrations/vault/v20-documents.js"
import { VAULT_0021_MEDIA_URL_KIND } from "./migrations/vault/v21-media-url-kind.js"
import { VAULT_0022_UNWRAP_RICH_CONTENT } from "./migrations/vault/v22-unwrap-rich-content.js"
import { VAULT_0023_CONVERSATION_UNREADABLE } from "./migrations/vault/v23-conversation-unreadable.js"
import { VAULT_0019_DRAFT_KEEP_AND_TRACE } from "./migrations/vault/v19-draft-keep-and-trace.js"
import {
  VAULT_0002_LEGACY_CHECKSUMS,
  VAULT_0009_LEGACY_CHECKSUMS,
} from "./migration-legacy-checksums.js"

export interface Migration {
  version: number
  name: string
  sql: string
  /**
   * 这条迁移在历史上出现过的旧 `rawChecksum`，全部已确认「只改了注释」。
   *
   * 命中的库会被就地收敛到 `schemaChecksum`，而**没登记的值仍然报错**。
   * 见 `migration-legacy-checksums.ts` 的文件头（含为什么挂在这里而不是
   * 一张 version→checksums 的表：version 在两套清单里不唯一）。
   */
  legacyChecksums?: readonly string[]
}

const CONTROL_0001_INIT = `
CREATE TABLE accounts (
  id              TEXT PRIMARY KEY,
  email_canonical TEXT NOT NULL UNIQUE,
  email_display   TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  salt            TEXT NOT NULL,
  hash_params     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_login_at   TEXT
);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

/**
 * 每个账号一个 vault。
 *
 * 追加新版本而不是改 v1：已应用的迁移改动会被 checksum 拦住（这是有意的）。
 * 回填用 id 本身作为 vault_id——已有账号必须拿到一个稳定值，
 * 而 SQLite 的 ALTER TABLE ADD COLUMN 不支持在加 NOT NULL 列时用表达式默认值。
 *
 * 不加 UNIQUE 约束：SQLite 无法对已有列追加约束，需要重建表。
 * 一对一由应用层保证（vault_id 由注册流程生成，不接受外部输入）。
 */
const CONTROL_0002_VAULTS = `
ALTER TABLE accounts ADD COLUMN vault_id TEXT NOT NULL DEFAULT '';
UPDATE accounts SET vault_id = id WHERE vault_id = '';
CREATE UNIQUE INDEX idx_accounts_vault_id ON accounts(vault_id);
`

/**
 * 用户身份：显示名 + 头像。
 *
 * ## 为什么在 control 库而不是 vault
 *
 * 这是**账号级**身份：登录界面与账号切换器都要显示它，而那时还没挂 vault。
 * 放 vault 会让"显示自己的名字"依赖"先打开自己的库"，多一层没必要的耦合。
 *
 * ## ★ `avatar_source` 是「不自动替换」的判据，不是 `avatar_url` 空不空
 *
 * 渠道授权成功后回填头像的规则只有一条：
 *   'manual' → 永不覆盖   'channel' → 可更新   NULL → 可填
 *
 * 用 source 而不是"url 是否为空"：用户**手动清空**头像是一个明确的选择
 * （"我就要首字母"），只看 url 会让下一次授权把它又填回来 ——
 * 而那个覆盖是静默的（没人会盯着自己的头像等它变）。
 *
 * 三列都可空：已有账号回填不了显示名（那要用户自己填或从渠道拿），
 * 而 `NOT NULL DEFAULT ''` 会让"没设过"与"设成空串"不可区分。
 */
const CONTROL_0003_PROFILE = `
ALTER TABLE accounts ADD COLUMN display_name  TEXT;
ALTER TABLE accounts ADD COLUMN avatar_url    TEXT;
ALTER TABLE accounts ADD COLUMN avatar_source TEXT;
`

/**
 * 渠道身份 → vault 的映射。**隔离维度从「本地账号」改成「渠道身份」。**
 *
 * ## ★★ 为什么 `accounts.vault_id` 那个一对一不够
 *
 * 一个人可能在**多个组织**里各有一个身份（实测本机就有两个钉钉 profile），
 * 而每个身份的会话、消息、画像都必须彻底分开 —— 混在一起不是显示问题，
 * 是把两个组织的语料蒸进同一份画像，而那不可逆。
 *
 * 原来的隔离键是 `accountId`，于是"换身份"只能"换本地账号"：
 * `SelfIdentityRepository.upsert` 撞 `SELF_IDENTITY_CONFLICT` 之后，
 * 界面能给的唯一出路就是"新建一个账号"—— 那是把渠道的身份问题
 * 推给了登录体系，而两者本来无关（同一个人、同一个登录，只是换了组织）。
 *
 * 现在键是 `(account_id, channel_id, corp_id, user_id)`：
 * 「谁的 · 哪个渠道 · 哪个组织 · 组织里的哪个人」。
 * 钉钉与飞书天然分开（`channel_id` 在键里），接飞书时这张表一个字不用改。
 *
 * ## ★ 判定键是 `corp_id + user_id`，不是 openId
 *
 * 与 `isSameIdentity()`（repositories/conversations.ts）**同一个判据** ——
 * 两处分叉的话，"算不算同一个身份"会有两个答案，而那种不一致的表现是
 * 「授权到同一个组织却又建了一个新 vault」（数据凭空一分为二）。
 *
 * openId 是渠道专有形态（钉钉一个、飞书三套），放进这张渠道无关的表
 * 会让接下一个渠道时必须改主键。而 `corpId + userId`（组织 + 成员编号）
 * 是所有 IM 都有的概念。
 *
 * ## ★ `corp_name` / `user_name` 只做显示，不参与判定
 *
 * 组织改名、花名改了都不该被判成"换了个人"。所以它们可空、可更新，
 * 而主键里一个都没有。
 *
 * ## ★ `vault_id` 上的 UNIQUE 是一条真不变式
 *
 * 一个 vault 只能属于一个身份 —— 这正是 `SelfIdentityRepository.upsert`
 * 那道 fail-closed 守卫在库层的对应物。两个身份指向同一个 vault_id
 * 时，那道守卫会在第二个身份写 `channel_self_identity` 时抛错，
 * 但那时数据已经开始混了。所以在这里用索引挡住。
 *
 * `accounts.vault_id` **保留不动**：它是"还没绑任何渠道身份"时的基础
 * vault（注册即有，onboarding 状态要往里写），也是已发布迁移不能改。
 * 存量账号的基础 vault 会在首次挂载时按它库里的身份行归属到这张表。
 */
const CONTROL_0004_IDENTITY_VAULTS = `
CREATE TABLE channel_identity_vaults (
  account_id   TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  corp_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  vault_id     TEXT NOT NULL,
  corp_name    TEXT,
  user_name    TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (account_id, channel_id, corp_id, user_id)
);
CREATE UNIQUE INDEX idx_identity_vaults_vault ON channel_identity_vaults(vault_id);
CREATE INDEX idx_identity_vaults_account ON channel_identity_vaults(account_id, channel_id);
`

/** 单个账号的库。本阶段只有账号级设置（onboarding 状态等）。 */
const VAULT_0001_INIT = `
CREATE TABLE vault_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

export const CONTROL_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "init", sql: CONTROL_0001_INIT },
  { version: 2, name: "account-vaults", sql: CONTROL_0002_VAULTS },
  { version: 3, name: "account-profile", sql: CONTROL_0003_PROFILE },
  { version: 4, name: "channel-identity-vaults", sql: CONTROL_0004_IDENTITY_VAULTS },
]

/**
 * Vault 清单。
 *
 * 每个版本的 SQL 拆到 `migrations/vault/v*.ts` 单独一个模块，本文件只组装数组：
 * 35 张表塞进一个文件既是冲突热点（多个阶段的改动都落在这里），
 * 也会让单次编辑超出可审阅的规模。checksum 校验不受影响 ——
 * 它算的是 SQL 字符串的内容，与文件路径无关。
 *
 * **版本号连续、写到才分配。** 不预留空号：`appliedVersion` 的语义是
 * 「最后一条已应用迁移的 version」，它已经流到 IPC 契约与状态面板；
 * 留空洞会让「版本号 = schema 代数」这个用户可见的语义失真，
 * 而分批发布的收益（跑起来再定稿）与编号是否连续无关。
 */
export const VAULT_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "vault-init", sql: VAULT_0001_INIT },
  {
    version: 2,
    name: "raw-normalized",
    sql: VAULT_0002_RAW_NORMALIZED,
    legacyChecksums: VAULT_0002_LEGACY_CHECKSUMS,
  },
  { version: 3, name: "outbox", sql: VAULT_0003_OUTBOX },
  { version: 4, name: "index", sql: VAULT_0004_INDEX },
  { version: 5, name: "search", sql: VAULT_0005_SEARCH },
  { version: 6, name: "distill", sql: VAULT_0006_DISTILL },
  { version: 7, name: "persona", sql: VAULT_0007_PERSONA },
  { version: 8, name: "media-minutes", sql: VAULT_0008_MEDIA_MINUTES },
  {
    version: 9,
    name: "onboarding",
    sql: VAULT_0009_ONBOARDING,
    legacyChecksums: VAULT_0009_LEGACY_CHECKSUMS,
  },
  { version: 10, name: "avatars", sql: VAULT_0010_AVATARS },
  { version: 11, name: "avatar-miss-reset", sql: VAULT_0011_AVATAR_MISS_RESET },
  { version: 12, name: "persona-review", sql: VAULT_0012_PERSONA_REVIEW },
  {
    version: 13,
    name: "persona-conversation-exclusions",
    sql: VAULT_0013_PERSONA_CONVERSATION_EXCLUSIONS,
  },
  {
    version: 14,
    name: "persona-self-conversation",
    sql: VAULT_0014_PERSONA_SELF_CONVERSATION,
  },
  {
    version: 15,
    name: "persona-public-service-bots",
    sql: VAULT_0015_PERSONA_PUBLIC_SERVICE_BOTS,
  },
  {
    version: 16,
    name: "persona-reply-expiry",
    sql: VAULT_0016_PERSONA_REPLY_EXPIRY,
  },
  {
    version: 17,
    name: "send-task-id",
    sql: VAULT_0017_SEND_TASK_ID,
  },
  {
    version: 18,
    name: "draft-cap",
    sql: VAULT_0018_DRAFT_CAP,
  },
  {
    version: 19,
    name: "draft-keep-and-trace",
    sql: VAULT_0019_DRAFT_KEEP_AND_TRACE,
  },
  {
    version: 20,
    name: "documents",
    sql: VAULT_0020_DOCUMENTS,
  },
  {
    version: 21,
    name: "media-url-kind",
    sql: VAULT_0021_MEDIA_URL_KIND,
  },
  {
    version: 22,
    name: "unwrap-rich-content",
    sql: VAULT_0022_UNWRAP_RICH_CONTENT,
  },
  {
    version: 23,
    name: "conversation-unreadable",
    sql: VAULT_0023_CONVERSATION_UNREADABLE,
  },
]

/** 默认清单指 control：openStore 不传 migrations 时开的就是控制库。 */
export const MIGRATIONS = CONTROL_MIGRATIONS
