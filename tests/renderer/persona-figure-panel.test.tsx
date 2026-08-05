/**
 * @vitest-environment jsdom
 *
 * 设置页形象块：**保存必须带全 payload**。
 *
 * ## 为什么这一条单独一个文件
 *
 * `stepDone(step, payload)` 是**整体覆盖写**，不是 patch。
 * 只发 `{ figureCustom }` 会把 `name` / `figureSeed` / `figureStyle` /
 * `figureImagePath` **全部抹掉** —— 这是本方案里**唯一会真正丢用户数据**
 * 的风险（R11）。
 *
 * 而它的表现是**延迟的**：保存的一瞬间界面上形象是对的（本地 state 还在），
 * 要等下次读草稿署名时才发现数字人没名字了。所以人工点一遍**测不到**它，
 * 必须有一条断言看着 payload 本身。
 *
 * 判据是 `stepDone` 收到的那个对象（会随缺陷变化的量），
 * 不是"保存按钮点得动"（那在 payload 全错时也成立）。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { MyContextApi, OnboardingStepView } from "@mycontext/ipc-contract"
import { PersonaFigurePanel } from "../../apps/desktop/src/renderer/features/settings/persona-figure-panel.js"

afterEach(cleanup)

/** jsdom 没有 ResizeObserver，而 Button 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })

/**
 * 库里已经存着的那一行。
 *
 * 形状照实录来（`persona-identity.ts` 的文件头记的就是这个）：
 * 一个**老用户**的 payload 里没有 `figureCustom`。
 */
const STORED_PAYLOAD = {
  name: "小小周",
  figureSeed: "小小周|0#0",
  figureStyle: "lorelei",
  figureImagePath: null,
}

/**
 * @param payload 库里那一行的 payload
 * @param state   那一步的状态。`"pending"` + `payload: null` 是**从没走过引导**
 *                的用户 —— 那正是"空 name 被写进去"的触发条件
 */
function installApi(
  payload: unknown = STORED_PAYLOAD,
  state: OnboardingStepView["state"] = "done",
): { stepDone: unknown[] } {
  const recorded: { stepDone: unknown[] } = { stepDone: [] }
  const steps: OnboardingStepView[] = [{ step: "persona", state, payload, updatedAt: 1 }]
  const api = {
    onboarding: {
      steps: () => ok(steps),
      stepDone: (input: unknown) => {
        recorded.stepDone.push(input)
        return ok(true as const)
      },
    },
  }
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = api as unknown as MyContextApi
  return recorded
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const i18n = createI18n("zh")
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <PersonaFigurePanel />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

/** 等回填完成 —— 保存按钮出现即为就绪。 */
async function waitReady(): Promise<HTMLElement> {
  return await waitFor(() => screen.getByText("保存形象"))
}

describe("★★ 保存必须带全 payload（否则抹掉 name）", () => {
  it("只改形象时 name / figureSeed / figureStyle / figureImagePath 都不丢", async () => {
    const recorded = installApi()
    renderPanel()
    const save = await waitReady()

    // 改一件（不改名字 —— 名字这一栏由 IdentityPanel 管）
    fireEvent.click(screen.getByRole("tab", { name: "头发" }))
    fireEvent.click(screen.getByLabelText("头发 3"))
    fireEvent.click(save)

    await waitFor(() => {
      expect(recorded.stepDone).toHaveLength(1)
    })
    const sent = recorded.stepDone[0] as { step: string; payload: Record<string, unknown> }
    expect(sent.step).toBe("persona")
    // ★ 这四条就是 R11 的断言。少任何一条都是一次真实的数据丢失
    expect(sent.payload["name"]).toBe("小小周")
    expect(sent.payload["figureSeed"]).toBe("小小周|0#0")
    expect(sent.payload["figureStyle"]).toBe("lorelei")
    expect(sent.payload["figureImagePath"]).toBeNull()
    // 而改动本身当然要在
    expect(sent.payload["figureCustom"]).toMatchObject({ slots: { hair: expect.any(String) } })
  })

  it("什么都没改就保存 → payload 与库里的现值等价（不是空对象）", async () => {
    /**
     * 这条抓的是另一个形态：回填没做对时，保存会把一个"缺省身份"
     * 写回库 —— 表现同样是名字消失，但触发条件是"点了保存没改东西"。
     */
    const recorded = installApi()
    renderPanel()
    fireEvent.click(await waitReady())

    await waitFor(() => {
      expect(recorded.stepDone).toHaveLength(1)
    })
    const sent = recorded.stepDone[0] as { payload: Record<string, unknown> }
    expect(sent.payload["name"]).toBe("小小周")
    expect(sent.payload["figureSeed"]).toBe("小小周|0#0")
    expect(sent.payload["figureStyle"]).toBe("lorelei")
  })
})

describe("★★ 名字为空时不许保存（否则引导页的必填守卫永久失效）", () => {
  /**
   * ## 为什么这一组是"严重"级别
   *
   * 全量 payload 只保证"不丢已有的 name"，**不保证 name 本身有效**。
   * 一个从没走过引导的用户（persona 行 `state: "pending"`、`payload: null`）
   * 在这里点保存，实测发出的是
   * `{"name":"","figureSeed":"|0#0","figureStyle":"notionists",…}`
   * 并把 persona 步标成 **done** —— 于是引导页 `onboarding-view.tsx`
   * 的"名字必填"守卫**从此再也不会触发**（那一步已经 done 了），
   * 草稿署名永久回落到兜底文案。
   *
   * 判据是 **payload 里不许出现空 name**，不是"按钮点不动"：
   * 后者在按钮禁用但 `save` 仍被别处调用时也成立，而前者是那次
   * 数据丢失的直接量。两条都写，因为它们各自能被绕过。
   */
  it("空 name（从没走过引导）时 stepDone 一次都不许发出", async () => {
    const recorded = installApi(null, "pending")
    renderPanel()
    // 界面要能用（形象可以先挑），只是存不下去
    const save = await waitReady()
    fireEvent.click(save)
    // 给 mutation 一个真的能跑完的窗口，否则这条断言会因为"还没发出"而假绿
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(recorded.stepDone).toEqual([])
  })

  it("保存按钮禁用，并说明原因（点不动而不说为什么与坏了不可区分）", async () => {
    installApi(null, "pending")
    renderPanel()
    const save = await waitReady()
    expect(save.closest("button")?.hasAttribute("disabled")).toBe(true)
    // i18n 里本来就有这条文案，之前 grep 命中 0 处 —— 那个判断写了一半
    expect(screen.getByText("先在引导里给数字分身起个名字")).toBeTruthy()
  })

  it("只有空白字符的名字同样挡住（与引导页的 trim() 判据同源）", async () => {
    const recorded = installApi({ name: "   ", figureSeed: "|0#0" })
    renderPanel()
    fireEvent.click(await waitReady())
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(recorded.stepDone).toEqual([])
  })

  it("反面：有名字时照常能存（否则上面三条可能只是把功能删了）", async () => {
    const recorded = installApi()
    renderPanel()
    fireEvent.click(await waitReady())
    await waitFor(() => {
      expect(recorded.stepDone).toHaveLength(1)
    })
  })
})

describe("旧数据（没有 figureCustom）不炸", () => {
  it("老 payload 能正常回填并保存", async () => {
    // 库里现在真的是这个形状 —— 只有 name 与 figureSeed
    const recorded = installApi({ name: "小墨", figureSeed: "小墨|0#0" })
    renderPanel()
    fireEvent.click(await waitReady())

    await waitFor(() => {
      expect(recorded.stepDone).toHaveLength(1)
    })
    const sent = recorded.stepDone[0] as { payload: Record<string, unknown> }
    expect(sent.payload["name"]).toBe("小墨")
    expect(sent.payload["figureSeed"]).toBe("小墨|0#0")
    // 没有 figureStyle 的旧数据落到缺省风格，而不是 undefined
    expect(sent.payload["figureStyle"]).toBe("notionists")
    expect(sent.payload["figureCustom"]).toEqual({})
  })

  it("脏数据不白屏：figureCustom 是字符串 / 数组 / 乱七八糟", async () => {
    /**
     * `readPersonaIdentity` 现有注释已经为"坏数据不让页面打不开"立过规矩。
     * 手改过的 payload、降级过的版本都可能给出这些形状。
     */
    for (const dirty of ["not an object", [1, 2], { slots: 42 }, { slots: { hair: 123 } }]) {
      const recorded = installApi({ ...STORED_PAYLOAD, figureCustom: dirty })
      const view = renderPanel()
      fireEvent.click(await waitReady())
      await waitFor(() => {
        expect(recorded.stepDone).toHaveLength(1)
      })
      const sent = recorded.stepDone[0] as { payload: Record<string, unknown> }
      // 脏的部分被收敛掉，而**名字仍在**
      expect(sent.payload["name"]).toBe("小小周")
      expect(sent.payload["figureCustom"]).toEqual({})
      view.unmount()
    }
  })
})

describe("★★ steps 查询失败必须说话，不能永久停在「读取中」", () => {
  /**
   * ## 为什么这一组是"严重"级别
   *
   * 全局 `retry: false`（`main.tsx`），所以查询失败是**终态**。
   * 上一版把判据写成 `steps.isPending || draft === null` → 显示「读取中…」，
   * 而失败时实测 `pending=false error=true data=undefined` ——
   * 面板**永久**停在「读取中…」，既不说发生了什么，也没有重试的路。
   *
   * 用户看到的是"设置页坏了"，而"一直在转"与"真的坏了"不可区分。
   * 这与 `OnboardingPanel` / `status-panel.tsx` 对 error 的既有处理不一致，
   * 那两处都是"错误文案 + 重试按钮"。
   */
  function installFailingApi(): { calls: number } {
    const state = { calls: 0 }
    const api = {
      onboarding: {
        steps: () => {
          state.calls += 1
          return Promise.reject(new Error("boom"))
        },
        stepDone: () => ok(true as const),
      },
    }
    ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
    ;(window as unknown as { mycontext: unknown }).mycontext = api as unknown as MyContextApi
    return state
  }

  it("失败时不显示「读取中…」，而是给出错误与重试", async () => {
    installFailingApi()
    renderPanel()

    await waitFor(() => {
      expect(screen.getByText("重试")).toBeTruthy()
    })
    /**
     * ★ 这一条就是那个 bug 的直接判据：修复前这里是「读取中…」且永不改变。
     * 断言"没有它"而不是"有错误文案" —— 后者在两句都显示时也成立，
     * 而那种界面（一边转一边报错）同样是坏的。
     */
    expect(screen.queryByText("读取中…")).toBeNull()
  })

  it("重试按钮真的重新发起查询（不是一个装饰）", async () => {
    const state = installFailingApi()
    renderPanel()
    const retry = await waitFor(() => screen.getByText("重试"))
    const before = state.calls
    fireEvent.click(retry)
    /**
     * 判据是**底层查询被再调了一次**（会随缺陷变化的量），
     * 不是"按钮点得动"——一个 `onClick={() => {}}` 的按钮也点得动。
     */
    await waitFor(() => {
      expect(state.calls).toBeGreaterThan(before)
    })
  })
})
