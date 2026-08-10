/**
 * 飞书的会话列举：`im +chat-list`。
 *
 * ## 为什么这件事需要单独一个文件
 *
 * 它与 `ingest.ts` 答的不是同一个问题：那边按**时间窗**搜消息
 * （`im +messages-search`），会话是从搜到的消息里**反推**的；
 * 这边直接问「我在哪些会话里」，含从没采过消息的。
 *
 * 选采集范围时需要后者 —— 否则一个还没采过的群根本不会出现在选项里，
 * 而用户想选的恰恰可能是它。
 *
 * ## 这个能力曾经**整个缺失**
 *
 * 飞书插件原来没有 `conversations`，于是引导第 4 步走
 * `DistillSourceService.conversations()` 里那条 `list === undefined` 降级分支：
 * 只给本地已采的部分。新装的机器上本地是空的 → **列表恒空**，
 * 而那条分支当时连一句日志都没有。
 *
 * 当时的判断是"飞书设计上不支持列会话"。核实后不成立：CLI 有
 * `im +chat-list`（`Risk: read`），只是我们的白名单里没有它。
 *
 * ## ★★ 实测（2026-08，随包 CLI）
 *
 * · 返回 `{ data: { chats, has_more, page_token } }`，逐项 8 个字段
 *   （`chat_id` / `chat_mode` / `chat_status` / `external` / `name` /
 *   `p2p_target_id` / `p2p_target_type` / `tenant_key`）；
 * · **`chats` 可能是 `null`** —— 账号没有群时 `--types=group` 就返回 null，
 *   不是空数组（解析层已挡，见 `parseLarkChatList`）；
 * · **不传 `--types` 等于只要群**，所以必须显式带 `p2p,group`；
 * · 拿到的 4 个会话与本机库里那 4 个 `external_id` **完全一致**
 *   （逐个比对过），所以它与采集那条路说的是同一批会话。
 */
import type { ChannelConversationItem, ChannelConversations } from "../../types.js"
import type { LarkCli } from "./cli.js"
import { parseLarkChatList } from "./parse.js"

/** 单页上限（CLI 的 `--page-size` 允许 1-100）。 */
const PAGE_SIZE = 100

/**
 * 分页上限。
 *
 * ## ★ 为什么要有一个上限，以及为什么它不是"只取第一页"
 *
 * CLAUDE.md 第 5 节要求「分页要抽干」——`hasMore=true` 就必须继续翻。
 * 这里照做，但仍留一个循环上限：游标类接口一旦服务端出 bug
 * （钉钉那边实测过 `hasMore` 与游标互相矛盾）就会变成死循环，
 * 而这个调用在**用户等着看列表**的路径上。
 *
 * 20 页 × 100 = 2000 个会话。真到了这个量级会标 `truncated`，
 * 界面据此提示列表不完整 —— 那是诚实的，而静默截断不是。
 */
const MAX_PAGES = 20

export function createFeishuConversations(cli: Pick<LarkCli, "json">): ChannelConversations {
  return {
    async list(signal?: AbortSignal) {
      const items: ChannelConversationItem[] = []
      /** 去重：`chat_id` 为准。分页边界上重复出现同一个会话是常见的服务端行为。 */
      const seen = new Set<string>()
      let pageToken: string | null = null
      let truncated = false

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const args = [
          "im",
          "+chat-list",
          // ★ 必须显式给：不传等于只要群，单聊一个都列不出来
          "--types=p2p,group",
          "--page-size",
          String(PAGE_SIZE),
          "--json",
          ...(pageToken === null ? [] : ["--page-token", pageToken]),
        ]
        const payload = await cli.json<unknown>(args, {
          ...(signal === undefined ? {} : { signal }),
        })
        const parsed = parseLarkChatList(payload)
        for (const item of parsed.items) {
          if (seen.has(item.externalId)) continue
          seen.add(item.externalId)
          items.push(item)
        }
        /**
         * ★★ 以 `hasMore` 为准，**不是**"游标非空就继续"。
         *
         * 钉钉那边实测过 277 页里 276 页 `hasMore:false` 却仍返回非空游标
         * （见 `ChannelPullPage.nextCursor` 的注释）——只看游标会永不终止。
         */
        if (!parsed.hasMore) return { items, truncated }
        if (parsed.nextToken === null) {
          /**
           * ★ `hasMore:true` 但没给游标 —— 翻不下去了，而这**是**截断。
           *
           * 说成"采完了"是最典型的静默数据缺失（CLAUDE.md 第 5 节），
           * 所以标 `truncated` 让界面说出来。
           */
          return { items, truncated: true }
        }
        pageToken = parsed.nextToken
        // 到了循环上限仍有下一页 → 确实截断了
        truncated = page === MAX_PAGES - 1
      }
      return { items, truncated }
    },
  }
}
