/**
 * 采集完整性对账 —— 逐会话比「探针看到的最新时间」与「我们库里的最新时间」。
 *
 * 判据在调用方；这里只负责如实读出来。用的是产品里那个
 * `ProbeSnapshotRepository.staleConversations`（**同一份 SQL**）——
 * 探针自己抄一份的话，产品里那个查询写坏了它照样绿。
 */
import {
  ProbeSnapshotRepository,
  SyncCursorRepository,
  VAULT_MIGRATIONS,
  openStore,
} from "@mycontext/store"
import { systemClock } from "@mycontext/kernel"

export interface IngestGapReport {
  watermark: number | null
  probedConversations: number
  stale: {
    conversationExternalId: string
    probeLastMsgAt: number
    oursLastMsgAt: number | null
  }[]
}

export function runIngestGapCheck(options: { dbPath: string; channelId: string }): IngestGapReport {
  const handle = openStore({ path: options.dbPath, migrations: VAULT_MIGRATIONS })
  try {
    const probes = new ProbeSnapshotRepository(handle.db)
    const cursors = new SyncCursorRepository(handle.db, systemClock)
    const watermark = cursors.watermark(`${options.channelId}:chat:l2`)
    const probedConversations =
      handle.db
        .prepare<
          [string],
          { c: number }
        >("SELECT count(*) AS c FROM probe_snapshots WHERE channel_id = ? AND last_msg_at IS NOT NULL")
        .get(options.channelId)?.c ?? 0
    return {
      watermark: watermark === 0 ? null : watermark,
      probedConversations,
      // limit 给大一点：报告要看全，定向补采那侧才按预算截断
      stale: probes.staleConversations(options.channelId, { limit: 200 }),
    }
  } finally {
    handle.close()
  }
}
