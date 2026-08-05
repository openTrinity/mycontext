/**
 * @vitest-environment jsdom
 *
 * ★★ 运行状态页的**信息层次**门禁。
 *
 * ## 这一页原来是什么样
 *
 * 一屏平铺**五个**同级分区（数据面 / 知识图谱 / 运行环境 / 数据目录 /
 * 数据库 / 配置注入），全部 `title-small-500` 同一档标题、全部默认展开。
 * 而这五块被查看的频率差一个数量级以上：
 *
 * · **数据面**：「采集在正常干活吗」—— 这一页存在的理由，每次都看；
 * · **知识图谱**：偶尔来点一次建图；
 * · 运行环境 / 数据目录 / 数据库 / 配置注入：**排查时**才看
 *   （四块加起来 16 个键值对 + 一张 4 列表格）。
 *
 * 也就是说：为了看第一块，用户每次都要滚过后面四块。而"每次都要滚过"
 * 的代价不是多滚两下 —— 是那五个同样粗的标题让人无法判断该看哪个。
 *
 * ## 断言的是**层次决定**，不是像素
 *
 * · 排查用的那几块折叠（`Disclosure`），常看的那两块不折叠；
 * · kl 那块的两个 `<h3>` 不再用 `caption`（12px）——
 *   分区内小标题比正文小是层次倒置；
 * · 三个动作按钮不再各自钉一句永久说明（三句 = 一整段灰字，
 *   而它们解释的是**按钮的语义**，读一次就够）→ 移进 `title`；
 * · 「重建」那句 `rebuildHint` 在 i18n 里存在却从未被渲染 ——
 *   而它是三个动作里唯一**不可逆**的那个。
 *
 * 用源码文本断言：`StatusPanel` 依赖 `useStatusReport` / 四个 kl hook，
 * 真渲染要 mock 一整套；而这里要锁的是那几条**版式决定**，
 * 它们在源码里是可判定的事实。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { MyContextApi } from "@mycontext/ipc-contract"

const panel = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/shell/status-panel.tsx"),
  "utf8",
)

describe("★★ 状态页：常看的摊开，排查的折叠", () => {
  it("★★ 排查用的四块折叠起来（否则每次都要滚过 16 个键值对）", () => {
    /**
     * 运行环境 / 数据目录 / 数据库 / 配置注入 —— 四块都是排查时才看。
     * 用 `Disclosure`（原生 details，键盘可达、Cmd+F 能命中并展开）。
     */
    expect(panel).toContain("Disclosure")
    const folded = panel.match(/<Disclosure/g) ?? []
    expect(folded.length).toBeGreaterThanOrEqual(4)
  })

  it("★★ 数据面**不**折叠 —— 它是这一页存在的理由", () => {
    /**
     * 反证过一次：把五块都折叠起来，于是打开状态页看到的是五个收起的
     * 标题行，而"采到了多少"要点一下才看到。那比原来更糟 ——
     * 原来至少第一屏就是它。
     */
    const dataPlaneLine = panel.split("\n").find((line) => line.includes("<DataPlanePanel"))
    expect(dataPlaneLine).toBeDefined()
    // DataPlanePanel 那一行不该被包在 Disclosure 里
    expect(panel).not.toMatch(/<Disclosure[^>]*>\s*<DataPlanePanel/)
  })

  it("★ 折叠的那几块要给收起时可见的摘要（否则为看一个数字要展开）", () => {
    /**
     * `Disclosure` 的 `summary` 就是为这件事存在的。数据库那块的版本号、
     * 配置注入那块的条数 —— 都属于"扫一眼就够"的信息。
     */
    expect(panel).toMatch(/summary=/)
  })
})

describe("★★ kl 那块：小标题不能比正文小", () => {
  it("★★ 分区内 h3 不用 caption（12px 标题 + 13px 正文 = 层次倒置）", () => {
    /**
     * 原来两个 `<h3>` 都是 `typography-caption-400`（12px），
     * 而它们统辖的正文是 `body-small-400`（13px）—— 标题比正文小。
     */
    const h3Blocks = panel.match(/<h3[^>]*className="[^"]*"/g) ?? []
    expect(h3Blocks.length).toBeGreaterThan(0)
    for (const block of h3Blocks) {
      expect(block, `h3 用了 caption：${block}`).not.toContain("typography-caption-400")
    }
  })
})

describe("★★ 两个动作：说明挂在按钮上，不占几行灰字", () => {
  /**
   * ★ 原来是**三个**按钮（建图 / 优化图谱 / 重建），现在是两个。
   *
   * 「优化图谱」已删：读 `kl-graph/kl_server.py` 发现 `/ingest` 的
   * `run_improve` 默认就是 True —— 建图内部已经跑完同一件事（进度里那个
   * `improve / communities + pagerank` 阶段）。那个按钮是重复的，而且它为了
   * 独占数据文件会先 stop server，正是实测到的 `Broken pipe` 与
   * `Qdrant already accessed` 两次故障的来源。
   */
  it("★★ 建图的说明移进 title（它解释按钮语义，读一次就够）", () => {
    /**
     * 原来 `buildHint` 与 `optimizeHint` 是两个常驻的 `<p>`：
     * 加起来 60 多个字的灰字，每次打开状态页都占掉两行，
     * 而它们说的是"这个按钮会做什么"—— 那是参考信息。
     *
     * 与会话表头那次同一个判断（`reply-mode-controls.tsx` 的 autoWarn）：
     * 解释控件语义的话挂 `title`，描述当前状态的话留在版面上。
     */
    expect(panel).toMatch(/title=\{t\("status\.kl\.buildHint"\)\}/)
    // 不该再有常驻的那个 <p>
    expect(panel).not.toMatch(/>\s*\{t\("status\.kl\.buildHint"\)\}\s*</)
  })

  /** ★ 「优化图谱」按钮已删 —— 门禁盯着别加回来（它是重复的，见上）。 */
  it("★ 不再有「优化图谱」按钮", () => {
    const code = panel
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\/.*$/gm, "")
    expect(code).not.toContain("optimizeHint")
    expect(code).not.toContain("useKlGraphOptimize")
  })

  it("★★ 「重建」必须显示 rebuildHint —— 它是唯一不可逆的那个", () => {
    /**
     * `rebuildHint`（"清空重来：删掉现有图与缓存后全量重抽"）在 i18n 里
     * **早就存在**，但源码里从来没有引用过它 —— 也就是说三个按钮中
     * 唯一有不可逆后果的那个，反而是唯一没有任何说明的。
     *
     * 有 `window.confirm` 不等于说清了：确认框在**点下去之后**才出现，
     * 而用户需要在点之前就知道这个按钮和旁边那个"建图"差在哪。
     *
     * ★ 断言的是 `t(...)` **调用**而不是"文件里出现过 rebuildHint"：
     * 反证时发现后者会被这个测试自己引用的**注释文本**满足 ——
     * 那属于"断言的字符串不是被测逻辑独有的"，等于没锁。
     */
    expect(panel).toMatch(/t\("status\.kl\.rebuildHint"\)/)
    // 且它要真的在版面上（不只是挂在 title 里）
    expect(panel).toMatch(/>\s*\{t\("status\.kl\.rebuildHint"\)\}\s*</)
  })
})

/**
 * ★★ 真渲染那一组 —— 源码文本断言查不出的那两类问题。
 *
 * 上面那些断言的是"源码里写了什么"。它们查不出：
 * · i18n 键**不存在**时界面上出现的是原样的键名
 *   （`status.database.accountSummary` 这种字符串直接糊在标题行上）；
 * · 折叠块收起时那些内容**真的**不在首屏（`<details>` 语义对不对）。
 *
 * 两者都是"不报错、但界面是坏的"。所以这一组真挂载一次。
 */
describe("★★ 真渲染：摘要不是原样的 i18n 键，收起的内容不在首屏", () => {
  it("★★ 收起时摘要显示的是人话，不是 status.xxx 这样的键名", async () => {
    const { render, screen, cleanup } = await import("@testing-library/react")
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query")
    const { I18nextProvider } = await import("react-i18next")
    const { createI18n } = await import("@mycontext/i18n")
    const { StatusPanel } = await import(
      "../../apps/desktop/src/renderer/features/shell/status-panel.js"
    )

    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

    const api = {
      app: {
        statusReport: () =>
          Promise.resolve({
            ok: true as const,
            data: {
              appVersion: "0.1.0",
              electronVersion: "43.2.0",
              nodeVersion: "22.17.0",
              platform: "darwin",
              packaged: false,
              paths: { userData: "/u", database: "/u/c.sqlite", vaults: "/u/v", logs: "/u/l" },
              database: { appliedVersion: 18, migrations: [], accountCount: 2 },
              config: [
                {
                  key: "chatModel",
                  envName: "MYCONTEXT_CHAT_MODEL",
                  value: "qwen",
                  source: "env" as const,
                  sensitive: false,
                  configured: true,
                },
                {
                  key: "embedModel",
                  envName: "MYCONTEXT_EMBED_MODEL",
                  value: "v4",
                  source: "default" as const,
                  sensitive: false,
                  configured: true,
                },
              ],
              dotenvLoaded: true,
              dotenvPath: "/repo/.env",
            },
          }),
      },
      // 数据面与 kl 都在这一页里，缺了会整棵树渲染失败
      ingest: {
        snapshot: () => new Promise(() => undefined),
        onProgress: () => () => undefined,
      },
      kl: {
        serverStatus: () =>
          Promise.resolve({
            ok: true as const,
            data: {
              state: "ready" as const,
              reason: null,
              port: 8200,
              building: false,
              networkEgress: true,
              buildProgress: null,
            },
          }),
        onStatus: () => () => undefined,
      },
    } as unknown as MyContextApi
    ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
    ;(window as unknown as { mycontext: unknown }).mycontext = api

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <I18nextProvider i18n={createI18n("zh")}>
        <QueryClientProvider client={client}>
          <StatusPanel />
        </QueryClientProvider>
      </I18nextProvider>,
    )

    // 等 statusReport 落地
    await screen.findByText(/运行环境/)

    /**
     * ★ 全屏扫一遍：任何 `status.` 开头的原样键名都是 i18n 缺键的证据。
     * 这一条会在"加了 summary 但忘了加词条"时立刻变红 ——
     * 而那个错误在源码断言里完全看不见。
     */
    expect(container.textContent ?? "").not.toMatch(/status\.[a-zA-Z]+\./)

    // 摘要里那两个数是真的算出来的：2 个账号 / 2 项配置其中 1 项被覆盖
    expect(screen.getByText(/2 个账号/)).toBeTruthy()
    expect(screen.getByText(/2 项，1 项被覆盖/)).toBeTruthy()

    // 折叠块收起：内容在 DOM 里但 details 未 open（浏览器据此不渲染）
    const details = [...container.querySelectorAll("details")]
    expect(details.length).toBeGreaterThanOrEqual(4)
    expect(
      details.every((node) => !node.open),
      "排查用的那几块应当默认收起",
    ).toBe(true)

    cleanup()
  })
})
