/**
 * 从 kl-graph 的图库读 chunk，作为 playbook 归纳的输入。
 *
 * ## ★★ 这个文件是与 kl-graph 的接缝，边界写在这里
 *
 * · **只读**（调用方以 `readonly` 打开）—— 那个库的 schema 归 kl 所有。
 *   写它会与它的 Qdrant 侧失去一致，而那种不一致没有任何地方能发现
 *   （`kl-server.service.ts` 里记着同一条）；
 * · **只读节点表**（`chunks`），**不碰边表**。`edges` 在默认的 ladybug 后端下
 *   按设计恒空 —— 五处 SQL 读它读了很久才被发现（`7db074b`）。这里从一开始
 *   就不依赖边：需要的信息全在 `chunks.metadata` 里（`senders` /
 *   `member_message_ids`）；
 * · **不依赖 kl server 在跑** —— 读磁盘文件即可，建图**期间**也能读
 *   （那时 kl 的 HTTP 在忙）。
 *
 * ## ★ 为什么用他们切好的 chunk，而不是自己从 messages 切
 *
 * kl 按 **3 小时静默**切 session（`SESSION_GAP_HOURS`），实测一个 message chunk
 * 中位 21 条消息、2 个发言人 —— 天然就是「一次完整来回」。自己再切一遍是重复
 * 劳动，而且切得更差（没有 reply 关系、没有实体消歧）。
 *
 * ## ★★ 本人是否发言：靠 `metadata.senders` 对显示名，而这比 `is_self` **弱**
 *
 * 这是这一层的归因判据（与 `guards.assertSelfAttributed` 同一个理由：归纳
 * 别人的流程会产出一份自信且错误的画像）。但要说清它的局限：
 *
 * · `messages.is_self` 是采集侧按 **ID** 判定的 —— 实测本人在群里显示花名、
 *   同名同姓 search 返回 5+ 个不同 ID，所以姓名匹配会灾难性误判；
 * · kl 的 `metadata.senders` **只有显示名**，所以这里只能按名字对
 *   —— 也就是**同名同姓会误判**。
 *
 * 为什么仍然可接受：显示名来自 `channel_self_identity.display_names_json`
 * （已确认过的本人花名，不是猜的），而误判的后果是"多归纳了一段别人的对话"，
 * 不是"把别人的身份当成本人"。要更强得让 kl 在 metadata 里带 `sender_id`
 * —— 那是给他们的需求，不是这里能补的。
 *
 * ## ★ 为什么 db 是注入的，而不是这里 `new Database(path)`
 *
 * 与 `work-corpus.ts` 同一个做法：`@mycontext/distill` 不依赖 better-sqlite3
 * （那是个 native 模块，本仓库的 Electron/Node ABI 反复踩过）。
 * 由宿主打开只读连接传进来，这一层就只是 SQL + 纯逻辑，可测。
 */
import type { SqliteDatabase } from "@mycontext/store"
import type { PlaybookSource } from "./playbook.js"

/** 一个 chunk 的正文最多取多少字。太长会撑爆 prompt（一批 4 个已接近网关上限）。 */
const MAX_CHARS_PER_CHUNK = 2400

/**
 * 读候选 chunk。
 *
 * 返回**全部**本人参与与否都带上的 message chunk（`selfSpoke` 标出来）——
 * 筛选判据在 `playbook.selectSources` 里，那是纯函数、可穷举测试。
 * 这一层只负责"把数据取出来"，不做判断。
 *
 * ★ 表不存在 / 读失败时返回空数组而不是抛：还没建图是**正常状态**
 * （用户可能刚登录），而这一层是增强不是前提 —— 同 `PersonaMemory`
 * 那条"失败即降级，绝不让一轮起草失败"。
 */
export function readPlaybookChunks(
  db: SqliteDatabase,
  input: { selfNames: readonly string[]; limit: number },
): PlaybookSource[] {
  if (input.selfNames.length === 0) return []

  let rows: Array<{ id: string; content: string; metadata: string }>
  try {
    rows = db
      .prepare<[number], { id: string; content: string; metadata: string }>(
        `SELECT id, content, metadata FROM chunks
          WHERE source_type = 'message'
            AND metadata IS NOT NULL
            AND content IS NOT NULL AND content != ''
          ORDER BY timestamp DESC
          LIMIT ?`,
      )
      .all(input.limit)
  } catch {
    // 表还不存在（没建过图）或库正被热切换 —— 都是正常状态
    return []
  }

  const selfNames = new Set(input.selfNames.filter((name) => name.trim() !== ""))
  const out: PlaybookSource[] = []
  for (const row of rows) {
    let meta: { senders?: unknown; member_message_ids?: unknown }
    try {
      meta = JSON.parse(row.metadata) as typeof meta
    } catch {
      // 单条 metadata 坏了就跳过它，不让整轮失败
      continue
    }
    const senders = Array.isArray(meta.senders) ? meta.senders : []
    const memberIds = Array.isArray(meta.member_message_ids) ? meta.member_message_ids : []
    out.push({
      id: row.id,
      content: row.content.slice(0, MAX_CHARS_PER_CHUNK),
      size: memberIds.length,
      selfSpoke: senders.some((s) => typeof s === "string" && selfNames.has(s)),
    })
  }
  return out
}
