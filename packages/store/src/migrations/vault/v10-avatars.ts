/**
 * VAULT v10 — 联系人头像缓存。
 *
 * ## 为什么头像要一张表而不是"每次去取"
 *
 * 取一个人的头像要 **2-3 次 CLI 调用**（搜共同群 → 群成员详情 → 下载媒体，
 * 实测每次 0.3-0.8s）。消息流里一屏 20 条可能有 8 个不同的人 ——
 * 不缓存的话每次滚动都是十几秒的子进程风暴。
 *
 * ## ★ 「取不到」也必须落库，而且要分原因
 *
 * 三种取不到（见 `avatar.ts`）：
 * · `no_common_group` —— 与这个人没共同群；
 * · `no_avatar_set` —— 他自己没设头像（钉钉也显示文字头像）；
 * · `download_failed` —— 换签名 URL 或下载失败。
 *
 * 前两种是**终态**：重试永远得到同一个答案。不记下来的话每次打开页面
 * 都会对那几十个"本来就没头像"的人各重试一遍 —— 几十次 CLI 调用，
 * 而结果不变。只有第三种值得重试，所以 `miss_reason` 必须存下来
 * 而不是"没有行就当没试过"。
 *
 * ## 为什么按 external_id 而不是 actor
 *
 * 消息行上的发送者标识是 `sender_external_id`（openDingTalkId），
 * 而 `actors` 表是我们自己的实体归并 —— 归并可能还没发生（新面孔）。
 * 头像要在"只知道一个 openDingTalkId"时就能查，所以主键用它。
 */
export const VAULT_0010_AVATARS = `
-- 联系人头像缓存。一个 external_id 一行（不管取到没取到）。
CREATE TABLE contact_avatars (
  channel_id   TEXT NOT NULL,
  -- openDingTalkId：与 messages.sender_external_id 同一个空间
  external_id  TEXT NOT NULL,
  -- 本地文件绝对路径；取不到时为 NULL
  local_path   TEXT,
  -- 平台的 mediaId。换头像时它会变 → 文件名也变，所以不用做缓存失效
  media_id     TEXT,
  /*
    取不到的原因：'no_common_group' | 'no_avatar_set' | 'download_failed'。
    取到时为 NULL。

    ★ 前两种是终态（重试无意义），第三种可以重试 —— 这个区分是这一列
    存在的**全部理由**。合成一个 'failed' 会让终态也被反复重试。
  */
  miss_reason  TEXT,
  -- 上次尝试时间：download_failed 的重试要有退避，靠它算
  attempted_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, external_id)
);

-- 只查"还没试过或该重试的"用得上
CREATE INDEX idx_avatars_miss ON contact_avatars(miss_reason) WHERE miss_reason IS NOT NULL;
`
