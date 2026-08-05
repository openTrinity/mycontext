/**
 * VAULT v21 — 把被误标成 `mediaId` 的**直链 URL** 改标成 `url`。
 *
 * ## 症状：一批永远下不下来的图，每十几秒重刷一遍日志
 *
 * 每轮两行 WARN：`process non-zero exit` 带
 * `"server_error_code": "RESOURCE_NOT_FOUND"`（原文
 * `failed to get download url for resourceId: <一条 http(s) URL>`），
 * 紧跟一行 `media download failed`。同一批资源反复出现。
 *
 * ## 根因：`mediaId=` 位置里装的不一定是 mediaId
 *
 * 真 mediaId 是以 `@` 或 `$` 开头的不透明串。而机器人/图文卡片类消息
 * 把一条**指向对象存储的直链 URL** 塞在同一个位置。
 *
 * `extractMedia` 首版无条件标成 `resourceKind: "mediaId"`，于是下载器拿这个 URL
 * 去 `chat message download-media --type mediaId` 换下载地址 —— 服务端必然
 * `RESOURCE_NOT_FOUND`。**这类值在物理上不可能下成功。**
 *
 * ## 为什么必须迁移历史数据，而不是只修解析器
 *
 * 修了 `extractMedia` 只影响**此后**采集的消息。已经落库的这些行仍是
 * `mediaId`，而下载队列的判据是 `downloaded_at IS NULL`（`listPending`）与
 * `path IS NULL`（`downloadForMessages`）—— 这张表上**没有「永久失败」这一列**，
 * 所以每一轮预热都会把它们再取出来重下一次，每次 spawn 一个子进程、
 * 留两行 WARN。实测一个真实库里有数百行这种资源，一直刷到迁移为止。
 *
 * 判据用 `LIKE 'http%'` 而不是更精确的 URL 解析：这一列存的是资源标识，
 * 真 mediaId 的字符集里**不存在** `http` 开头的形态（实测上万行真 mediaId
 * 无一例外），所以这个判据既够用也不会误伤。
 */
export const VAULT_0021_MEDIA_URL_KIND = `
UPDATE media_assets
   SET resource_kind = 'url'
 WHERE resource_kind = 'mediaId'
   AND resource_id LIKE 'http%';
`
