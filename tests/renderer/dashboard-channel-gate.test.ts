/**
 * ## ★★★ 渠道还没定下来时，别把**另一个渠道**的图谱显示成当前渠道的
 *
 * 用户报的形态：「钉钉的知识图谱显示完全错乱了，从飞书切回来以后」，
 * 而且补了一句关键线索 —— **「切到飞书再切回来，他又能正常显示了」**。
 * 那句话把问题定位到了缓存，而不是数据。
 *
 * ## 根因链
 *
 * `useDashboardScope` 里：
 *
 * ```ts
 * const channelId = pickedChannelId ?? authorizedChannelIds[0] ?? undefined
 * ```
 *
 * 而 `authorizedChannelIds` 来自 `useChannels()` —— **首帧是空数组**。于是：
 *
 * 1. 首帧 `channelId === undefined` → 发一次"不带渠道"的 ego 请求，
 *    主进程那侧不带渠道 = **主渠道**（`MultiGraphQueryService.ego()`），
 *    结果存进 `["kl","graph-ego","primary"]`；
 * 2. 渠道列表加载完 → `channelId` 变成第一个已授权渠道（可能是飞书）
 *    → 换了 queryKey、发新请求；
 * 3. 而这中间界面**已经在按新渠道渲染标签**，显示的却是那份主渠道的数据。
 *
 * 第二次进入就正常，因为那时缓存里已经有对的那份了。
 *
 * ## ★★ 为什么不是所有 hook 都能加这道门
 *
 * `undefined` 在不同 hook 上语义**不同**：
 *
 * · `useKlGraphEgo` —— 只有仪表盘用，`undefined` 没有合法用途 → 可以加 `enabled`；
 * · `useKlGraphOverview` —— **引导流程第 4 步**调 `useKlGraphOverview(building)`
 *   不带渠道，语义是"整体图谱规模"（全部合并）。加了 `enabled` 会把那一步
 *   的三个数字整块关掉 —— 实测就是这么红的（`distill-result.test.tsx` 两条）；
 * · `useKlGraphFacts` —— `undefined` = 合并全部，**搜索那条路要它**。
 *
 * 所以后两者的门必须开在**调用方**（仪表盘），而不是 hook 里。
 * 这条区别正是这个文件存在的理由：下一个人很可能"顺手统一加上 enabled"。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

function read(relative: string): string {
  return readFileSync(join(import.meta.dirname, "..", "..", relative), "utf8")
}

/** 剔掉注释 —— 这些文件的注释里引用了旧写法（解释它为什么错）。 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

const queries = code(read("apps/desktop/src/renderer/lib/queries.ts"))
const dashboard = code(read("apps/desktop/src/renderer/features/dashboard/dashboard-module.tsx"))

describe("★★★ 渠道未定时不显示别的渠道的图谱", () => {
  /**
   * ★★★ ego 在 hook 层加门 —— 它只有仪表盘用，`undefined` 没有合法语义。
   *
   * 判据是"`enabled` 与 channelId 挂钩"，而不是"存在 enabled" ——
   * 后者在 `enabled: true` 这种无效写法下也会绿。
   */
  it("★★★ useKlGraphEgo 在渠道未定时不发请求", () => {
    const ego = queries.slice(queries.indexOf("export function useKlGraphEgo"))
    const body = ego.slice(0, ego.indexOf("\n}"))
    expect(body).toContain("enabled: channelId !== undefined")
  })

  /**
   * ★★ `useKlGraphOverview` **不能**加那道门。
   *
   * 引导流程第 4 步（`distill-step.tsx`）调它时不带渠道，语义是"整体规模"。
   * 加了 `enabled` 会让那一步的三个数字整块消失 —— 实测红过两条用例。
   *
   * 这条断言方向是**反的**（断言"没有"），因为要防的是"顺手统一加上"。
   */
  it("★★ useKlGraphOverview 不加 enabled（引导第 4 步靠不带渠道 = 全部合并）", () => {
    const overview = queries.slice(queries.indexOf("export function useKlGraphOverview"))
    const body = overview.slice(0, overview.indexOf("\n}"))
    expect(
      body,
      "引导流程第 4 步调 useKlGraphOverview(building) 不带渠道 —— 加了 enabled 会把它关掉",
    ).not.toContain("enabled: channelId !== undefined")
  })

  /**
   * ★★ facts 的门开在**仪表盘**，不在 hook 里。
   *
   * `channelId: undefined` 对 `useKlGraphFacts` 是"合并全部渠道"，
   * 而搜索那条路正需要它。仪表盘是"看某一个渠道的图谱"，所以由它自己判。
   */
  it("★★ 仪表盘在渠道未定时不渲染 FactsExplorer（那时它会显示合并结果）", () => {
    expect(dashboard).toMatch(/graphChannel === undefined \? null : \(/)
  })

  /**
   * ★ 反证：仪表盘确实**传了**渠道给 FactsExplorer。
   * 少了这条，上面那条在"整块删掉 FactsExplorer"时也会绿。
   */
  it("★ 反证：FactsExplorer 仍然收到 channelId", () => {
    expect(dashboard).toContain("channelId={graphChannel}")
  })

  /**
   * ★★ `useFeedInfo` 同款 —— 它的 `enabled` 是调用方给的（登录前不查），
   * 所以必须是 `&&` 而不是覆盖掉那个参数。
   */
  it("★★ useFeedInfo 把渠道判据与调用方的 enabled 合并（不是覆盖）", () => {
    const feed = queries.slice(queries.indexOf("export function useFeedInfo"))
    const body = feed.slice(0, feed.indexOf("\n}"))
    expect(body).toContain("enabled: enabled && channelId !== undefined")
  })
})
