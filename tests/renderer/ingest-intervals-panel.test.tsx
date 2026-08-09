/**
 * @vitest-environment jsdom
 *
 * 采集周期设置面板。
 *
 * ## 为什么这一屏值得门禁
 *
 * 这个面板存在的全部理由是「可配置**不等于**配得了」：周期本来就能写进
 * `dh_settings.ingestIntervals`，但在有界面入口之前那只对能开 SQLite 的人
 * 成立。而一个"少了一路"的面板恰恰会重现同一个问题 —— 它宣称能配采集，
 * 用户却找不到某一路（文档周期原先就是这样：写死在常量里、
 * 与其余四项不同源）。
 *
 * 所以这里锁的是：
 * · **五路全在**（探针基准/退避上界/全量兜底/听记/文档）；
 * · 档位落在 `ingestIntervalsSchema` 的 min/max 之内 —— 界面给不出
 *   schema 会拒掉的值（否则保存失败而用户不知道为什么）；
 * · 点档位真的只提交**那一项**（`.partial()` 的坑：显式 undefined 会把
 *   其余字段覆盖成缺省，persona 的 limitsSave 踩过同一个）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import { ingestIntervalsSchema, type MyContextApi } from "@mycontext/ipc-contract"
import { IngestIntervalsPanel } from "@renderer/features/settings/ingest-intervals-panel"

afterEach(cleanup)

const CURRENT = {
  probeBaseMs: 10_000,
  probeMaxMs: 120_000,
  activeScanMs: 30_000,
  pullMs: 120_000,
  minutesMs: 1_800_000,
  documentsMs: 3_600_000,
  graphBuildMinIntervalMs: 3_600_000,
}

function wrap() {
  const save = vi.fn<
    (input: Parameters<MyContextApi["ingest"]["intervalsSave"]>[0]) => Promise<unknown>
  >(() => Promise.resolve({ ok: true as const, data: CURRENT }))
  const api = {
    ingest: {
      intervals: () => Promise.resolve({ ok: true as const, data: CURRENT }),
      intervalsSave: save,
    },
  } as unknown as MyContextApi
  ;(globalThis as { mycontext?: unknown }).mycontext = api
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={createI18n("zh")}>
        <IngestIntervalsPanel />
      </I18nextProvider>
    </QueryClientProvider>,
  )
  return { save }
}

describe("★ 采集周期面板：五路全部可配", () => {
  it("★★ 文档周期也在面板上（它曾经写死、与其余四项不同源）", async () => {
    wrap()
    // Disclosure 默认收起 —— 先展开
    fireEvent.click(await screen.findByText(/采集周期/))
    for (const label of [
      /增量探测基准周期/,
      /自适应退避上界/,
      /全量会话轮转扫描周期/,
      /全量分页兜底周期/,
      /会议听记轮询周期/,
      /文档轮询周期/,
    ]) {
      expect(await screen.findByText(label)).toBeTruthy()
    }
  })

  it("★ 只提交被点的那一项（不把其余擦回缺省）", async () => {
    const { save } = wrap()
    fireEvent.click(await screen.findByText(/采集周期/))
    // 文档周期的一个档位：3h
    fireEvent.click(await screen.findByRole("button", { name: "3h" }))
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1)
    })
    const arg = save.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.keys(arg)).toEqual(["documentsMs"])
    expect(arg["documentsMs"]).toBe(10_800_000)
  })
})

describe("★ 档位必须落在 schema 的区间内", () => {
  /**
   * ★ 这一条防的是"界面给了一个保存必失败的值"。
   *
   * 面板的档位是手写常量，而区间在 zod schema 里 —— 两处独立，
   * 于是调宽 schema 或加档位时很容易越界。越界的表现是点了没反应
   * （IPC 那侧 zod 拒掉），而界面上没有任何解释。
   */
  it("每一路的每一个档位都能通过 ingestIntervalsSchema", () => {
    const options: Record<keyof typeof CURRENT, readonly number[]> = {
      probeBaseMs: [5_000, 10_000, 30_000, 60_000],
      probeMaxMs: [60_000, 120_000, 300_000],
      activeScanMs: [15_000, 30_000, 60_000, 300_000],
      pullMs: [60_000, 120_000, 300_000, 600_000],
      minutesMs: [600_000, 1_800_000, 3_600_000],
      documentsMs: [900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000],
      // 建图最小间隔：15min / 30min / 1h / 2h / 6h（与面板 OPTIONS 同源）
      graphBuildMinIntervalMs: [900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000],
    }
    for (const [key, values] of Object.entries(options)) {
      for (const value of values) {
        const candidate = { ...CURRENT, [key]: value }
        const result = ingestIntervalsSchema.safeParse(candidate)
        expect(result.success, `${key}=${String(value)} 应当被 schema 接受`).toBe(true)
      }
    }
  })
})
