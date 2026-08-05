/**
 * VAULT v8 — 媒体资源与听记的可用化。
 *
 * ## 为什么 v2 建好的表还需要 v8
 *
 * `media_assets` / `minutes` 两张表在 v2 就建了，但**从来没有写入方**
 * （grep 全仓库：`MediaAssetRepository` / `MinutesRepository` 都不存在）。
 * 接采集时发现 v2 的 `media_assets` 缺两列，缺了就没法用：
 *
 * · **`resource_id`** —— 平台侧资源 ID（`mediaId` / `fileId`）。
 *   v2 只有 `sha256`（内容哈希）。用 sha256 存 resourceId 是错的：
 *   一期不下载字节，算不出内容哈希；而把 ID 塞进 sha256 列会让
 *   「内容是否相同」的语义变成「ID 是否相同」—— 两者在文件被重新上传时不等价。
 * · **`resource_kind`** —— 取字节时该用哪个命令。实测两条完全不同的链路：
 *   `mediaId` 走 `chat message download-media`，`fileId` 走 `drive download`。
 *   不记下来的话二期只能靠 ID 前缀猜（实测 mediaId 以 `@` 或 `$` 开头，
 *   fileId 无固定前缀）—— 猜错的表现是下载命令报参数错，而非"这个资源取不到"。
 *
 * ## 唯一键：(message_id, resource_id)
 *
 * 采集窗口是**重叠**的（见 scheduler 的 WINDOW_OVERLAP_MS），同一条消息会被
 * 反复拉到。没有唯一键的话每轮都会给同一条消息插一份媒体行，
 * 而这个膨胀是静默的（没人会去 count media_assets）。
 *
 * ★ 两列都 `NOT NULL DEFAULT ''`：参与 UNIQUE 的列可空会让唯一键
 * 在 NULL 行上**完全失效**（SQLite 里 NULL != NULL），于是去重形同虚设。
 * 这条与 v2 的 `raw_records.external_id` 是同一个教训。
 *
 * ## minutes 不改结构
 *
 * v2 的列（`summary_text` / `transcript_json` / `speakers_json`）够用 ——
 * 实测 `minutes list all` 返回 uuid/title/startTime/durationMicros，
 * `minutes get summary|transcription` 返回正文，都能落进现有列。
 * 只补一个按时间查的索引（听记按时间range查是主要用法）。
 */
export const VAULT_0008_MEDIA_MINUTES = `
-- media_assets 补两列。SQLite 的 ADD COLUMN 不支持 NOT NULL 无默认值，
-- 所以给空串默认值（也正是唯一键需要的，见文件头）。
ALTER TABLE media_assets ADD COLUMN resource_id   TEXT NOT NULL DEFAULT '';
ALTER TABLE media_assets ADD COLUMN resource_kind TEXT NOT NULL DEFAULT '';

-- 幂等键：重叠窗口反复拉到同一条消息时不产生重复行。
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_unique
  ON media_assets(message_id, resource_id);

-- 「还没下载的资源」是二期下载器的工作队列，单独一个部分索引。
CREATE INDEX IF NOT EXISTS idx_media_pending
  ON media_assets(downloaded_at) WHERE downloaded_at IS NULL;

-- 听记按时间范围查是主要用法（"上周的会议聊了什么"）。
CREATE INDEX IF NOT EXISTS idx_minutes_started
  ON minutes(channel_id, started_at);
`
