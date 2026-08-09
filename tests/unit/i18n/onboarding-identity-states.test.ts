/**
 * 引导的渠道那一步：**三档状态都要有话说**。
 *
 * ## 这一组锁的是「第三档什么都不显示」
 *
 * 引导里那一步原来只有两种表现：
 *
 * ```
 * 未授权        → 授权面板 + 按钮            ✓ 有
 * 已授权待确认  → 一个白底小框 + 解析入口    ✓ 有（但长得像补充说明）
 * 已授权已就绪  → 什么都没有                ✗ ← 问题在这
 * ```
 *
 * 第三档不说话的后果：它与"还在加载"、"出了问题但没提示"在界面上**长得
 * 一样** —— 用户不知道该不该等，也不知道能不能往下走。
 *
 * 而第二档用的是 `bg-card-z0` + 细边（与"补充说明"同一种样式），
 * 于是一个**待办**读起来像可以划过去的文字。而它其实很重要：
 * 身份没确认时蒸馏会拒掉全部语料且不报错，画像出不来。
 *
 * ★ 这一组不渲染整个 `OnboardingView`（那要 mock 十几个 IPC 通道）。
 * 三档的**判据**已经在 `dashboard-data.test.ts` 里锁得很细
 * （`readIdentityProblem` 那一组）—— 这里补的是判据之外的两件事：
 * ① 第三档的文案**存在**（我新加的 key，缺了就渲染出裸 key）；
 * ② 两种语言都有（漏一边的话另一种语言下界面出现英文 key 名）。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * ★ 直接读文件而不是 import —— `@mycontext/i18n` 的 `exports` 只暴露包根，
 * 没有 `./locales/*` 子路径（走 import 会 `Cannot find package`）。
 * 与 `onboarding-wording.test.ts` 同一个做法，那里记了完整理由：
 * 为一个测试去加一条 export 是让生产代码的公共接口为测试让步。
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const load = (locale: string): { channel: Record<string, string> } =>
  JSON.parse(
    readFileSync(`${ROOT}packages/i18n/src/locales/${locale}/onboarding.json`, "utf8"),
  ) as { channel: Record<string, string> }

const zh = load("zh")
const en = load("en")

/** 三档里需要文案的那些 key（第一档的文案在授权面板里，不在这）。 */
const REQUIRED_CHANNEL_KEYS = [
  // 第二档：标题 + 三种成因各一句
  "identityPendingTitle",
  "identityAmbiguous",
  "identityAdoptable",
  "identityUnresolved",
  // 第三档：就绪
  "identityReady",
] as const

describe("★★ 三档状态的文案都在（缺了会渲染出裸 key）", () => {
  it.each(REQUIRED_CHANNEL_KEYS)("zh 有 channel.%s", (key) => {
    const value = zh.channel[key]
    expect(typeof value).toBe("string")
    expect(String(value).trim()).not.toBe("")
  })

  /**
   * ★ 英文缺一条的后果不是"没翻译"，而是界面上出现 `channel.identityReady`
   * 这样的裸 key —— 比没有那句话更糟。
   */
  it.each(REQUIRED_CHANNEL_KEYS)("en 有 channel.%s", (key) => {
    const value = en.channel[key]
    expect(typeof value).toBe("string")
    expect(String(value).trim()).not.toBe("")
  })
})

describe("★ 第三档要说「完成了」，不能只是没话说", () => {
  /**
   * ★★ 判据是**语义**而不是"这个 key 非空"：一句
   * 「已连接」既不说身份也不说这一步完成，读者仍然不知道能不能往下走。
   *
   * 所以要求它同时提到"身份/你是谁"与"完成/好了"这两件事。
   */
  it("★★ zh 的就绪文案同时说清「身份」与「这一步完成」", () => {
    const text = zh.channel["identityReady"] ?? ""
    expect(text).toMatch(/你|身份/)
    expect(text).toMatch(/完成|好了|就绪/)
  })

  /**
   * ★ 待确认那一档的标题必须读起来像**待办**（"还差一步"这类），
   * 而不是一个中性名词 —— 后者不会驱动任何动作。
   */
  it("★ zh 的待确认标题读起来像待办", () => {
    const text = zh.channel["identityPendingTitle"] ?? ""
    expect(text).toMatch(/还差|还需|请|未/)
  })
})
