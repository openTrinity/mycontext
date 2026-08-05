/**
 * ★★ 运行状态「数据面」的**信息层次**门禁。
 *
 * ## 为什么这一块值得锁
 *
 * 原来是九个 `Metric` 排成 3×3 网格，全部 13px 同色 —— 那是一张**电子表格**
 * 而不是状态页。而用户来这一页只有一个问题：「采集在正常干活吗」，
 * 回答它只需要两个数：采到了多少、其中多少能搜到。
 * 其余七个（水位、探针周期、向量数、库体积、原生留存、身份、会话数）
 * 是排查时才看的 —— 与那两个同权重就等于让人每次都读九遍。
 *
 * ## 断言的是**层次**与**一致性**，不是像素
 *
 * · 主数字用比支撑量更大的那一档，且**只有一个**主数字；
 * · 索引不是第二个大号数字，而是主数字的**副标**（它是子集，不是并列项）；
 * · 落后时副标转警示色（那时两个数真的不同，用户会遇到"搜不到"）；
 * · 数字都过千位分隔 —— 同一块里出现 `12,074` 与 `12074` 两种写法
 *   比两处都不分隔更显得随意。
 *
 * 用源码文本断言：`DataPlanePanel` 依赖 `useIngestSnapshot` /
 * `useIngestProgress` 两个 IPC hook 加一个 `SelfIdentityPanel` 子树，
 * 真渲染要 mock 一整套；而这里要锁的是那几条**版式决定**，
 * 它们在源码里是可判定的事实。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const panel = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/shell/data-plane-panel.tsx"),
  "utf8",
)

describe("★★ 数据面：一个主数字 + 支撑量（不是 3×3 表格）", () => {
  it("★ 主数字用比支撑量更大的那一档", () => {
    /**
     * `title-base-600`（18px）对 `body-small-400`（13px）—— 清晰的两级。
     * ★ 刻意**不**用 `title-large-600`（26px，hero 那一档）：
     * 这一页是排查页不是仪表盘，而"每屏只有一个 hero"是那一档成立的前提。
     */
    expect(panel).toContain("typography-title-base-600")
    expect(panel).not.toContain("typography-title-large-600")
  })

  it("★★ 只有一个主数字（并列两个同样大的数会让人以为看错了）", () => {
    /**
     * 「已采集 12,074」与「已建索引 12,074」在正常状态下**是同一个数**。
     * 两个大号数字并排显示同一个值，读者的第一反应是自己看错了。
     */
    const hits = panel.match(/typography-title-base-600/g) ?? []
    expect(hits).toHaveLength(1)
  })

  it("★ 索引是主数字的副标，不是第九个格子", () => {
    // 它是"采到的那些里有多少能搜到" —— 子集关系，不是并列项
    expect(panel).toContain("ftsCovered")
    // 原来那个独立格子的 key 不该再出现
    expect(panel).not.toContain("dataPlane.ftsIndexed")
  })

  it("★★ 索引落后时副标转警示色（那时用户真的会搜不到）", () => {
    expect(panel).toMatch(/warn=\{data\.ftsLag > 0\}/)
    expect(panel).toContain("--status-warning")
  })

  it("★ 数字过千位分隔（不许同一块里两种写法）", () => {
    /**
     * 反证过一次：副标用 i18next 的 `{{count}}` 直接传数字，
     * 渲染成 `12074`，而上面那行是 `12,074` —— 同一块里两种写法。
     * i18next 的插值**不做**本地化格式化，所以必须自己 `toLocaleString`。
     */
    expect(panel).not.toMatch(/String\(data\.messages\)/)
    expect(panel).toContain("data.messages.toLocaleString()")
    expect(panel).toContain("data.ftsIndexed.toLocaleString()")
  })

  it("★ 占位符不叫 count（那是 i18next 的复数魔法键）", () => {
    /**
     * 传一个已格式化的字符串给 `count` 会让复数解析拿到非数字。
     * 这条锁住"别为了省事又改回 count"。
     */
    expect(panel).toMatch(/indexed:\s*data\.ftsIndexed\.toLocaleString\(\)/)
  })
})
