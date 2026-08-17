/**
 * 越界语料清理 —— 把**不在用户勾选范围内**的消息及其派生物从 vault 里删掉。
 *
 * 判据与产品运行时**同一份代码**（`readCollectionScope` +
 * `purgeOutOfScopeMessages`）。脚本自己抄一份判据的话，产品里那道闸写坏了
 * 这个脚本照样"清得很干净"——而那正是要防的。
 */
import {
  ConversationRepository,
  VAULT_MIGRATIONS,
  openStore,
  purgeOutOfScopeMessages,
  readCollectionRequest,
  type PurgeReport,
} from "@mycontext/store"

export interface ScopePurgeReport extends PurgeReport {
  /** 范围有没有设（false = 没配过，此时不该删任何东西） */
  restricted: boolean
  /** 许可的会话数 */
  allowed: number
  /** 时间下界（unix ms）；null = 不限 */
  since: number | null
  /** 清理前库里的消息总数 */
  totalBefore: number
  /** 库里的会话总数（目录，不受范围限制） */
  conversationsInDirectory: number
}

export function runScopePurge(options: {
  dbPath: string
  channelId: string
  dryRun: boolean
}): ScopePurgeReport {
  const handle = openStore({ path: options.dbPath, migrations: VAULT_MIGRATIONS })
  try {
    /**
     * ★★★ 判据走**采集面**（`readCollectionRequest`），与产品运行时
     * （`applyScopeChange`）**同一份**。
     *
     * 原来是 `readCollectionScope`（学习范围）。DWD 只打标不筛行之后，
     * 「只因监听而入库的」那些行本来就不在学习白名单里 —— 拿学习范围清
     * 会把分身要盯的会话删掉。而这个脚本是在**真库**上跑的，
     * 删错就是不可逆的。
     */
    const scope = readCollectionRequest(handle.db, "chat", options.channelId)
    const totalBefore =
      handle.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM messages").get()?.c ?? 0
    const report = purgeOutOfScopeMessages(handle.db, options.channelId, scope, {
      dryRun: options.dryRun,
    })
    return {
      ...report,
      restricted: scope.restricted,
      allowed: scope.allow.size,
      since: typeof scope.since === "number" ? scope.since : null,
      totalBefore,
      conversationsInDirectory: new ConversationRepository(handle.db).count(),
    }
  } finally {
    handle.close()
  }
}
