/**
 * 渠道能力的判据 —— **渲染层唯一**一份。
 *
 * ## 为什么需要这个文件
 *
 * 「数字分身在哪个渠道上能跑」这件事，渲染层原来是**七处各写一份**
 * `channelId === "dingtalk"`（`PRIMARY_CHANNEL_ID` × 5 +
 * `PERSONA_SUPPORTED_CHANNEL` × 2）。同一个事实的七份拷贝，
 * 而这一轮已经三次被同一形状咬到（`factsOfEntity` / `storage` /
 * `getSelfNames` 都是"两处各写一遍、漏一处静默错位"）。
 *
 * ## 判据是 `sendAs`，不是渠道 id
 *
 * 分身的本质就是**以我的身份发消息**。所以问的应该是"这个渠道让不让我
 * 以本人身份发"，而不是"它是不是钉钉"：
 *
 * · 钉钉 `sendAs: ["self"]` —— 能；
 * · 飞书 `sendAs: []` —— 不能（`plugins/feishu/index.ts` 头注释第一行写着
 *   `deliberately no persona/send`，是刻意的只读接入）。
 *
 * 好处是**将来某个渠道开了发送能力，这里一行都不用改**；而写死 id 的版本
 * 要改七处，漏一处的表现是"界面说不可用，而它其实可用"（或者更糟：反过来）。
 */
import type { ChannelSummary } from "@mycontext/ipc-contract"

/**
 * 这个渠道能跑数字分身吗。
 *
 * `undefined`（渠道列表还没加载 / 找不到那个 id）→ `false`：
 * 拿不到能力时**当成不能**，而不是乐观假设 —— 后者会让界面先显示分身可用、
 * 数据到了再收回去（闪一下），而且那一闪之间用户可能已经点了。
 *
 * ## ★★ 为什么用可选链而不是直接 `channel.capabilities.sendAs`
 *
 * `capabilities` 是**后加的字段**，而开发态热更会出现「新渲染层 + 旧主进程」：
 * 那时 `capabilities` 是 `undefined`，直接取 `.sendAs` 会抛，而这个函数在
 * 渲染路径上 —— 一抛就是**整页白屏**。打包态在升级窗口里同样会遇到。
 *
 * 这个仓库为同一个原因白屏过一次（见 `data-plane-panel.tsx` 里"逐字段兜底"
 * 那段注释）。所以：字段缺失时降级成"不支持"，而不是崩。
 */
export function canRunPersona(channel: ChannelSummary | undefined): boolean {
  return (channel?.capabilities?.sendAs?.length ?? 0) > 0
}

/**
 * 能跑分身、**且已授权**的渠道。空数组 = 数字分身整体不可用。
 *
 * ★ 两个条件都要：只连了飞书时"能跑分身的渠道"里有钉钉（它在列表里，
 * 只是没授权），而那时分身仍然是不可用的 —— 引导流程第 3/5 步要据此说话。
 */
export function personaCapableChannels(
  channels: readonly ChannelSummary[],
): readonly ChannelSummary[] {
  return channels.filter(
    (channel) => canRunPersona(channel) && channel.status.state === "authorized",
  )
}
