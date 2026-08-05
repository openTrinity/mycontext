/**
 * VAULT v11 — 清掉被**错误标签**钉住的头像 miss。
 *
 * ## 为什么需要一次数据修复而不只是改代码
 *
 * `no_common_group` 是**终态**（`needsFetch` 从此不再重试）—— 这个设计是
 * 对的：真的没有共同群时重试永远得到同一个答案。
 *
 * 但两个先后修掉的 bug 都会**错误地**写下这个标签：
 *
 * ① 缺花名时 `findViaCommonGroups` 一次命令都不调就返回 null
 *    （`search-common` 只能按花名搜）→ 记成"没有共同群"，
 *    而我们**压根没去找**。现在这种情况报 `lookup_skipped`（可重试）；
 * ② 「他在群里但 `avatarMediaId` 是 null」（= 没设头像）与
 *    「没有共同群」被表示成同一个 null → 前者被报成后者。
 *
 * 两个 bug 写下的都是 `no_common_group`，所以清这一个标签就够。
 *
 * 于是那些行**永久**卡住：代码修好了也不会再试一次。实测这个库里
 * 21 行 `no_common_group`，逐个用真 CLI 复跑后其中**至少两个人其实有头像**，
 * 剩下的多数是"在群里但没设头像"
 * —— 也就是说这个标签在真实数据上**几乎全是错的**。
 *
 * ## ★ 只删 `no_common_group`，不动其余
 *
 * · `no_avatar_set` —— 由新代码写下的这一条是可信的（它现在有独立判据），
 *   而且它是真终态，删了会白重试一遍；
 * · `download_failed` —— 本来就有 6 小时退避，会自己重试；
 * · 取到的行（`miss_reason IS NULL`）—— 删了等于把已下载的文件作废。
 *
 * 删行而不是把 `miss_reason` 置 NULL：`needsFetch` 判的是
 * 「没有行 → 该取」，而一行 `local_path` 与 `miss_reason` 都为 NULL 的
 * 记录语义上是"取到了但路径是空"，那会让下次读缓存时命中一个空头像。
 *
 * ## 幂等
 *
 * 重复应用无害（第二次没有行可删）。而迁移只跑一次 —— 之后再出现的
 * `no_common_group` 是新代码写的，那时它是可信的。
 */
export const VAULT_0011_AVATAR_MISS_RESET = `
DELETE FROM contact_avatars WHERE miss_reason = 'no_common_group';
`
