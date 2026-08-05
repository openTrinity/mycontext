/**
 * @vitest-environment jsdom
 *
 * ★★ 同一份 payload 在**四个消费方**上必须是同一张脸。
 *
 * ## 为什么这一条要单独一个文件
 *
 * `persona-identity.ts` 的文件头写着"解析只有这一份"，理由是
 * "抄两份会让引导里看到形象 A、草稿卡上看到形象 B"。而审查实测发现
 * 那件事**真的发生了**：名字派生 seed 的规则只活在 `persona-step.tsx`
 * 的渲染里，`persona-signature.tsx` / `persona-figure-panel.tsx` 用的是
 * 裸 `figureSeed` —— 同一个 `{name:"小小周", figureSeed:"|0#0"}` 在两处
 * 渲染出**两张不同的脸**（实测产物 19760 vs 15183 字符）。
 *
 * 所以这里断言的不是"某个函数返回什么"，而是**两个真实组件渲染出的
 * `src` 相同**。那是唯一会随这类缺陷变化的量：任何一处漏了派生，
 * 它就会不同，而两边都不会报错。
 *
 * ## ★ 判据为什么不是"调 readPersonaIdentity 得到派生值"
 *
 * 那种断言只证明**解析函数**对，证明不了**消费方用了它** ——
 * 而这个 bug 恰恰是"函数在那里，某些消费方没走它"。
 * 一条在缺陷存在时仍为真的断言等于没有断言。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { MyContextApi, OnboardingStepView } from "@mycontext/ipc-contract"
import { PersonaSignature } from "../../apps/desktop/src/renderer/features/persona/persona-signature.js"
import { PersonaStep } from "../../apps/desktop/src/renderer/features/onboarding/persona-step.js"
import { readPersonaIdentity } from "../../apps/desktop/src/renderer/features/persona/persona-identity.js"

afterEach(cleanup)

/** jsdom 没有 ResizeObserver，而 Button 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

/**
 * 库里那一行 —— **照实录来**。
 *
 * 这个形状是记忆里记的真实 payload（`persona-identity.ts` 文件头也抄了它）：
 * `figureSeed` 是常量 `"|0#0"`，名字在 `name` 里。它正是触发条件。
 */
const STORED: OnboardingStepView[] = [
  { step: "persona", state: "done", payload: { name: "小小周", figureSeed: "|0#0" }, updatedAt: 1 },
]

function installApi(rows: OnboardingStepView[] = STORED): void {
  const api = {
    onboarding: {
      steps: () => Promise.resolve({ ok: true as const, data: rows }),
      stepDone: () => Promise.resolve({ ok: true as const, data: true as const }),
    },
  }
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = api as unknown as MyContextApi
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nextProvider>
  )
}

/** 取某个尺寸的那张图的 src。形象是 `<img>`，尺寸写在父节点的 inline style 上。 */
function srcOfSize(root: HTMLElement, size: string): string {
  const images = [...root.querySelectorAll("img")]
  const hit = images.find(
    (image) => (image.parentElement as HTMLElement | null)?.style.width === size,
  )
  return hit?.getAttribute("src") ?? ""
}

describe("★★ 引导页与草稿署名是同一张脸", () => {
  it("同一份 payload：署名（16px）与引导页大预览（128px）的 src 相同", async () => {
    installApi()

    /** 署名：数字人页草稿卡上那个小头像 */
    const signature = render(wrap(<PersonaSignature />))
    /**
     * ★ 必须等**名字**上屏，不能只等 `src` 非空。
     *
     * 查询还没回来时 `personaIdentityFromSteps(undefined)` 给的是缺省身份
     * （`name: ""`、`figureSeed: "|0#0"`），而那时形象**已经渲染了** ——
     * 于是"等 src 非空"会拿到**缺省那张脸**，两边一比自然相等，
     * 这条断言就变成了恒真。写这个测试时真踩了一次。
     */
    await waitFor(() => {
      expect(screen.getByText(/小小周/)).toBeTruthy()
    })
    const signatureSrc = srcOfSize(signature.container as HTMLElement, "16px")
    expect(signatureSrc).not.toBe("")
    signature.unmount()

    /**
     * 引导页：回填走 `readPersonaIdentity`（与 `onboarding-view` 同一条路），
     * 然后交给 `PersonaStep` 渲染。
     */
    const identity = readPersonaIdentity(STORED[0])
    const step = render(
      wrap(
        <PersonaStep
          value={{
            name: identity.name,
            figureSeed: identity.figureSeed,
            ...(identity.figureStyle === undefined ? {} : { figureStyle: identity.figureStyle }),
            figureImagePath: identity.figureImagePath ?? null,
            figureCustom: identity.figureCustom ?? {},
          }}
          onChange={() => {}}
          showNameError={false}
        />,
      ),
    )
    const stepSrc = srcOfSize(step.container as HTMLElement, "128px")
    expect(stepSrc).not.toBe("")

    /**
     * ★★ 这就是那个 bug 的直接判据。
     *
     * `size` 只写进 SVG 的 `width`/`height`，所以两张图除了那两个数字
     * 之外必须逐字节相同。比"去掉尺寸之后的串"而不是整串 ——
     * 否则 16px 与 128px 本身的差异会让这条恒红。
     */
    const strip = (uri: string) => uri.replace(/width%3D%22\d+%22|height%3D%22\d+%22/g, "")
    expect(strip(stepSrc)).toBe(strip(signatureSrc))
  })

  it("★ 反面：名字不同就该是两张脸（否则上面那条可能恒真）", async () => {
    /**
     * 没有这一条时，一个"seed 恒为常量"的实现（也就是**修复前**那种
     * 每个新用户同一张脸）照样能让上面那条通过 —— 因为两处都一样地错。
     * 判据取"改了名字之后 src 变了"。
     */
    installApi()
    const a = render(wrap(<PersonaSignature />))
    // 同上：等名字上屏，否则拿到的是缺省那张脸（两次都一样 → 恒真）
    await waitFor(() => {
      expect(screen.getByText(/小小周/)).toBeTruthy()
    })
    const first = srcOfSize(a.container as HTMLElement, "16px")
    a.unmount()
    cleanup()

    installApi([
      {
        step: "persona",
        state: "done",
        payload: { name: "另一个人", figureSeed: "|0#0" },
        updatedAt: 1,
      },
    ])
    const b = render(wrap(<PersonaSignature />))
    await waitFor(() => {
      expect(screen.getByText(/另一个人/)).toBeTruthy()
    })
    expect(srcOfSize(b.container as HTMLElement, "16px")).not.toBe(first)
  })

  it("★ 用户自己挑过（|rN#0）时改名字不换脸 —— 派生只接管缺省值", async () => {
    /**
     * 这条锁的是 `resolvePersonaFigureSeed` 的**条件**，不只是它存在。
     * 一个"永远按名字重算"的实现会把用户点「随机」挑过的脸换掉，
     * 而那是另一种数据丢失（挑过的东西被一次改名覆盖）。
     */
    const pickedSeed = "小小周|0#0|r3#0"
    installApi([
      {
        step: "persona",
        state: "done",
        payload: { name: "小小周", figureSeed: pickedSeed },
        updatedAt: 1,
      },
    ])
    const identity = readPersonaIdentity({
      step: "persona",
      state: "done",
      payload: { name: "完全不同的名字", figureSeed: pickedSeed },
      updatedAt: 1,
    })
    // 名字变了，seed 必须原样保留
    expect(identity.figureSeed).toBe(pickedSeed)
  })
})

describe("★ 载入时被裁掉的东西要能报出来", () => {
  it("不匹配当前风格的键进 figureDropped（否则第一次保存就永久裁掉且无人知道）", () => {
    /**
     * 裁剪本身是对的（DiceBear 对不认识的槽位静默忽略），但上一版把
     * `dropped` 丢了 —— 设置页把裁剪结果填进 draft、保存时原样写回，
     * 于是一份不匹配的库数据在**第一次保存时被永久裁掉**，用户全程无感。
     *
     * `lips` 是 notionists 的槽位，lorelei 没有它（实测）。
     */
    const identity = readPersonaIdentity({
      step: "persona",
      state: "done",
      payload: {
        name: "小小周",
        figureSeed: "小小周|0#0",
        figureStyle: "lorelei",
        figureCustom: { slots: { lips: "variant11" } },
      },
      updatedAt: 1,
    })
    expect(identity.figureDropped).toBe(1)
    expect(identity.figureCustom?.slots?.["lips"]).toBeUndefined()
  })

  it("反面：干净的数据 figureDropped 为 0（一个恒亮的提示等于没有提示）", () => {
    const identity = readPersonaIdentity({
      step: "persona",
      state: "done",
      payload: {
        name: "小小周",
        figureSeed: "小小周|0#0",
        figureStyle: "notionists",
        figureCustom: { slots: { hair: "variant07" } },
      },
      updatedAt: 1,
    })
    expect(identity.figureDropped).toBe(0)
  })
})
