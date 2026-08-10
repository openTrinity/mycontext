/**
 * `ChannelService.list()` 的 `capabilities` 必须**透传插件的值**，不能自己推导。
 *
 * ## 这一条锁的是「同一个事实的第二个真源」
 *
 * 「这个渠道能不能以本人身份发消息」的真源是插件的 `ChannelCapabilities`。
 * 而 `list()` 是把它送到渲染层的那一跳 —— 如果这里写成
 *
 *     sendAs: plugin.meta.id === "dingtalk" ? ["self"] : []
 *
 * 就等于在这一层造了第二份判据，而两份迟早分叉：给某个渠道开了发送能力、
 * 插件里改好了，界面却仍说不支持（或反过来，更糟）。
 *
 * 那正是渲染层原来的病 —— 七处各写一份 `channelId === "dingtalk"`。
 *
 * ## 判据：给一个 `sendAs` 与"常识"相反的 fake
 *
 * fake 的 id 是 `dingtalk` 而 `sendAs` 是**空的**。任何"按 id 推导"的实现
 * 都会返回 `["self"]` 而被抓到；只有真正透传的实现才回空数组。
 * 反过来再给一个 id 陌生但 `sendAs: ["self"]` 的 —— 两个方向都堵住。
 */
import { describe, expect, it } from "vitest"
import type { AuthStatus, ChannelPlugin } from "@mycontext/channels"
import { ChannelService } from "@main/services/channel.service"

const UNAUTHORIZED: AuthStatus = { state: "unauthorized" }

/**
 * 造一个 `capabilities` 由调用方指定的假插件。
 *
 * ★ id 与 capabilities **解耦**：这一组的全部意义就是验证实现不看 id。
 */
function fakePlugin(
  id: string,
  capabilities: { sendAs: string[]; domains: string[] },
): ChannelPlugin {
  return {
    meta: { id, labelKey: `channels:${id}.label`, descriptionKey: "d", available: true },
    capabilities,
    auth: {
      describeStepKeys: () => [],
      status: () => Promise.resolve(UNAUTHORIZED),
      login: () => Promise.reject(new Error("not used")),
    },
  } as unknown as ChannelPlugin
}

function service(plugins: readonly ChannelPlugin[]) {
  return new ChannelService({
    host: {
      list: () => plugins,
      isLoginInProgress: () => false,
      status: (id: string) =>
        Promise.resolve(
          plugins.find((p) => p.meta.id === id)?.auth.status() ?? Promise.resolve(UNAUTHORIZED),
        ),
    },
  } as never)
}

describe("list() 透传插件的 capabilities", () => {
  it("★★★ id 是 dingtalk 但 sendAs 为空 → 回空（按 id 推导的实现会返回 self）", async () => {
    const [row] = await service([fakePlugin("dingtalk", { sendAs: [], domains: ["chat"] })]).list()

    expect(row?.capabilities.sendAs, "这个值被按 id 推导了，不是透传的").toEqual([])
  })

  it("★★★ id 陌生但 sendAs 有 self → 回 self（反方向同一条判据）", async () => {
    const [row] = await service([
      fakePlugin("some-new-channel", { sendAs: ["self"], domains: ["chat", "minutes"] }),
    ]).list()

    expect(row?.capabilities.sendAs).toEqual(["self"])
    expect(row?.capabilities.domains).toEqual(["chat", "minutes"])
  })

  /**
   * ★★ 每一行都要有 `capabilities`。
   *
   * 缺失时渲染层的 `canRunPersona` 会降级成"不支持"（它用可选链，不会崩）——
   * 也就是**静默**把一个可用的渠道显示成不可用，而没有任何报错。
   */
  it("★★ 多渠道时每一行都带 capabilities", async () => {
    const rows = await service([
      fakePlugin("a", { sendAs: ["self"], domains: ["chat"] }),
      fakePlugin("b", { sendAs: [], domains: ["chat", "doc"] }),
    ]).list()

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.capabilities, `${row.id} 少了 capabilities`).toBeDefined()
      expect(Array.isArray(row.capabilities.sendAs)).toBe(true)
    }
  })

  /**
   * ★ 返回的数组是**拷贝**，不是插件内部那个引用。
   *
   * 这份数据会过 IPC（结构化克隆），所以运行时不会真的共享。但在同一个进程里
   * 直接持有插件的数组意味着：渲染层若拿到它并 `sort()`，就改了插件的能力声明。
   * 这条断言把"拷贝"钉住，代价接近零。
   */
  it("★ 返回的 sendAs 不是插件内部那个数组引用", async () => {
    const plugin = fakePlugin("a", { sendAs: ["self"], domains: ["chat"] })
    const [row] = await service([plugin]).list()

    expect(row?.capabilities.sendAs).not.toBe(plugin.capabilities.sendAs)
    expect(row?.capabilities.sendAs).toEqual([...plugin.capabilities.sendAs])
  })
})
