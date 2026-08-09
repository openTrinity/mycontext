/**
 * kl 面板的两组门禁：**服务状态与建图状态分离**，以及**建图进度的百分比换算**。
 *
 * ## 一、把可用说成不可用
 *
 * 原来服务徽章是 `busy ? "建图占用中" : <服务状态>`，理由是"建图要独占数据
 * 文件，会先把服务停掉再跑"。那对**旧实现**成立（stop server → 另起
 * `python -m scripts.ingest` → 起回来）。上游提供 in-server `POST /ingest`
 * 之后前提消失了：干活的就是 server 自己、复用同一个 Qdrant writer，
 * `rebuildGraph` 里只有 `fresh=true`（重建）才 stop。
 *
 * 实测到的矛盾（本机同一时刻）：
 *   /health → {"status":"ok"}
 *   /status → status=ready，sqlite 29230 条消息，ingest=running phase_a
 *   UI      → 徽章「建图占用中」，服务操作按钮全部消失
 *
 * ## 二、进度整块移除（改了两轮都没对）
 *
 * 状态页曾显示建图进度，三次都错、错法各不相同：
 *   ① percent 当成 0–100 → 整轮建图全程显示「0%」「1%」；
 *   ② 分了 determinate/indeterminate → 出现「已运行 NaN 分钟」
 *      （热更时新渲染层 + 旧主进程，`now - undefined`）；
 *   ③ 优化跑完后仍挂着「抽实体 + 建图 已运行 12 分钟」+ 满格进度条，
 *      而后端此刻报的是 `phase_a 0.2`。
 *
 * 每轮都是再兜一个 case，而根因没动 —— 那份数据**不足以支撑一个进度指示**：
 * 上游只有 Phase A 有真实回调（Phase B 的 LLM 抽取几十分钟里 percent 恒为
 * 0.4，实测 20s 采样三次一动不动），且 `buildProgress` 会在 optimize 停
 * server 时卡在 stale 值上不自己清。完整理由在
 * `klServerStatusSchema.buildProgress` 的注释里。
 *
 * 所以整块去掉，**并用门禁盯着**：进度看起来是个显然该有的功能，下一个人很
 * 可能顺手加回来，而那些问题一个都没解决。保留的是终态结果行
 * （「建图完成：N 实体」「优化完成：…」）—— 一次性事实，不依赖轮询，一直是对的。
 *
 * ## 断言策略
 *
 * `klServiceStateKey` 这个纯函数直接测；其余用源码文本锁，与
 * `status-panel-hierarchy.test.tsx` 同一套做法（`KlPanel` 不导出，真渲染要
 * mock 一整套 hook，而那测不到这里的判据）。扫源码前先剔掉注释 ——
 * 面板里的注释解释了这段历史，会命中自己的说明文字。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { klBuildPercent, klServiceStateKey } from "@renderer/features/shell/status-panel.js"

const panel = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/shell/status-panel.tsx"),
  "utf8",
)
/** 读一份 locale 的 `status.kl` 段。 */
function readLocale(loc: string): Record<string, string> {
  const parsed = JSON.parse(
    readFileSync(
      join(import.meta.dirname, `../../packages/i18n/src/locales/${loc}/settings.json`),
      "utf8",
    ),
  ) as { status: { kl: Record<string, string> } }
  return parsed.status.kl
}

describe("★★ 服务徽章只反映服务状态（不被建图覆盖）", () => {
  it("四个服务状态各自映射到自己的文案 key", () => {
    expect(klServiceStateKey("ready")).toBe("status.kl.stateReady")
    expect(klServiceStateKey("starting")).toBe("status.kl.stateStarting")
    expect(klServiceStateKey("failed")).toBe("status.kl.stateFailed")
    expect(klServiceStateKey("stopped")).toBe("status.kl.stateStopped")
  })

  /**
   * ★★ 函数签名里**没有** building/busy 这个入参。
   *
   * 这比断言"某个输入下不返回 stateBuilding"更强 —— 它让"把建图塞回服务
   * 徽章"这件事在类型上就做不到，除非有人显式改签名（那时这条会红）。
   */
  it("★★ 判据只有 state 一个入参（建图进不来）", () => {
    expect(klServiceStateKey.length).toBe(1)
  })

  /**
   * ★ `stateBuilding` 这个 key 不该再被服务徽章用。i18n 里留着不算错
   * （历史文案），但源码里不能再出现 —— 出现了就说明有人又接回去了。
   */
  it("★ 源码里不再引用 stateBuilding（那是旧实现的产物）", () => {
    expect(panel).not.toContain("stateBuilding")
  })

  it("★ 服务操作不再被 busy 藏掉", () => {
    /**
     * 剔掉注释再匹配 —— 面板里的注释**引用了**旧写法（解释它为什么错），
     * 直接扫全文会命中自己的说明文字。与 `spawn-wiring.test.ts` 同一个做法：
     * 门禁要判的是代码，不是散文。
     */
    const code = panel
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\/.*$/gm, "")
    expect(code).not.toMatch(/busy \? null/)
    // 反证：剔注释之后 busy 仍在（它还管着三个数据按钮的互斥禁用）
    expect(code).toContain("disabled={busy}")
  })
})

describe("★★ 建图进度：percent 是 0–1 小数", () => {
  /**
   * ★★ 这是会算错且不会报错的那一处：kl 的 percent 是 **0–1 小数**
   * （`_set_progress("done", "", 1.0, ...)`），主进程原样透传。当成 0–100
   * 直接显示的话整轮建图全程都是「0%」「1%」—— 看起来像卡死。
   */
  it("★★ 0.2 → 20%（不是 0%）", () => {
    expect(klBuildPercent({ phase: "phase_a", percent: 0.2, startedAt: 0 })).toBe(20)
  })

  it("1.0 → 100%", () => {
    expect(klBuildPercent({ phase: "", percent: 1, startedAt: 0 })).toBe(100)
  })

  it("0.856 → 86%（四舍五入到整数）", () => {
    expect(klBuildPercent({ phase: "phase_a", percent: 0.856, startedAt: 0 })).toBe(86)
  })

  it("没在建图 → null（整块不渲染）", () => {
    expect(klBuildPercent(null)).toBeNull()
  })

  /** ★ 脏值夹到 [0,100]：上游给负数/超界时不显示 -3% 或 140%。 */
  it("★ 脏值夹到 [0,100]，NaN 当 0", () => {
    expect(klBuildPercent({ phase: "x", percent: -0.5, startedAt: 0 })).toBe(0)
    expect(klBuildPercent({ phase: "x", percent: 1.4, startedAt: 0 })).toBe(100)
    expect(klBuildPercent({ phase: "x", percent: Number.NaN, startedAt: 0 })).toBe(0)
  })

  /**
   * ★ **不做任何时间减法** —— `startedAt` 可能缺（新渲染层 + 旧主进程，
   * 热更时就是这样），而 `now - undefined` 是 NaN，真机上显示过
   * 「已运行 NaN 分钟」。只用 percent 就绕开整类问题。
   */
  it("★ startedAt 缺失也不影响（只用 percent，不做减法）", () => {
    expect(klBuildPercent({ phase: "phase_b", percent: 0.4 })).toBe(40)
  })
})

describe("★ 进度真的渲染出来了", () => {
  const code = panel
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/.*$/gm, "")

  /**
   * ★ 反证过"什么都不显示"：那时建图期间界面上只剩三个灰掉的按钮，没有任何
   * 东西说明它在跑 —— 比一个会在 40% 停顿的百分比更难懂（实测截图）。
   */
  it("★ 建图期间有进度文字", () => {
    expect(code).toContain("buildProgress")
  })

  /** ★ 只要文字,不要进度条(产品要求)。门禁盯着别加回来。 */
  it("★ 没有进度条", () => {
    expect(code).not.toContain("progressbar")
    expect(code).not.toContain("aria-valuenow")
  })

  it("分钟级任务带 aria-live", () => {
    expect(code).toContain('aria-live="polite"')
  })

  /** 终态结果行保留 —— 一次性事实，不依赖轮询。 */
  it("保留建图的终态结果行", () => {
    expect(code).toContain("buildDone")
    expect(code).toContain("buildFailed")
  })
})

/**
 * ## ★★ 建图必须说清是**哪个渠道**在建
 *
 * 用户报的原话：「建图这里还是没有区分开渠道，我不知道现在是谁在建图」——
 * 截图里是一个灰掉的「建图中…」按钮加一行「建图中 85%」，没有任何渠道归属。
 *
 * 成因在两处：
 * ① `MultiKlServerService.status()` 顶层 `buildProgress` 取的是"**任意**一个
 *    在建渠道"的进度（`find(s => s.building)`），归属在聚合时就丢了；
 * ② `KlPanel` 里 `busy` / `percent` 都读顶层，而这一页其余部分（服务徽章、
 *    端口、失败原因、三个按钮）**已经**按 `perChannel` 取了 —— 也就是同一页里
 *    两套判据，而不一致的那一半正是用户看到的那行字。
 *
 * 顺带修掉的一个真行为问题：`busy` 读顶层"任一在建"，于是钉钉在建图时飞书那栏
 * 的「建图」按钮也是灰的。两个渠道是两个独立的 kl（各自进程、端口、Qdrant），
 * 钉钉在跑压根不妨碍飞书建图 —— 锁住一个能点的按钮，且界面上没有一句话说明。
 */
describe("★★ 建图带渠道归属", () => {
  const code = panel
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/.*$/gm, "")

  /**
   * ★ 判据是"进度**不从顶层取**"。
   *
   * 写成"不含 `status?.buildProgress`"而不是"含 `row.buildProgress`"：
   * 后者在"两处都读、以顶层为准"这种半吊子实现下也是绿的，
   * 而那正是改动前那一版的形状。
   */
  /**
   * ★★ 判据升级过一次：从"进度别读顶层"变成"**结构上读不到顶层**"。
   *
   * 上一版是"每渠道一行状态 + 顶层一套按钮"，那时这条断言盯的是
   * `row === undefined ? status?.buildProgress : row.buildProgress` ——
   * 也就是"以 row 为主、顶层只做旧主进程回落"。
   *
   * 但那个布局本身是错的：两行渠道状态下面挂一套按钮，用户的原话是
   * 「这里的停止是停止谁，这里的重建是重建谁」。现在改成**每渠道一张卡**，
   * 按钮长在卡里、数据全部取自 `row` —— `ChannelKlCard` 拿不到 `status`
   * 这个变量，于是"读顶层"在结构上不可能发生。
   *
   * 所以判据也跟着换：不再匹配某个三元表达式，而是断言
   * ① 卡组件存在且只吃一个 `row`；② 卡内不出现任何 `status?.` 读取。
   */
  it("★★ 每渠道一张卡：卡内只读 row，读不到顶层聚合", () => {
    expect(code).toContain("function ChannelKlCard")
    expect(code).toContain("klBuildPercent(row.buildProgress")
    // 卡组件的函数体里不许出现顶层 status —— 它压根不在作用域里
    const card = code.slice(code.indexOf("function ChannelKlCard"))
    expect(card).not.toContain("status?.")
    expect(card).not.toContain("status.perChannel")
  })

  /** ★ 文案里必须出现渠道名 —— 只有百分比的那个 key 不够。 */
  it("★★ 进度文案带渠道名", () => {
    expect(code).toContain("buildProgressOn")
    for (const loc of ["zh", "en"]) {
      expect(readLocale(loc)["buildProgressOn"]).toContain("{{channel}}")
      expect(readLocale(loc)["buildProgressOn"]).toContain("{{percent}}")
    }
  })

  /**
   * ★ 「别的渠道也在建图」这句话**已经不需要了**，这条断言随之删除。
   *
   * 它是上一版的补偿：那时只有一栏进度，所以要额外说一句"另一个渠道也在建"，
   * 否则用户在飞书栏看到"没在建"而后台钉钉正烧着 LLM。
   *
   * 现在每个渠道都有自己的卡、自己的进度行 —— 钉钉在建图，钉钉那张卡上就
   * 直接写着「钉钉 建图中 42%」。用一句话去描述另一张卡上已经写明的事实
   * 是纯冗余，而冗余的那份还会过期（它依赖顶层聚合）。
   *
   * ★ i18n 的 `buildingElsewhere` 键**保留**：删键要同时清两个语言文件，
   * 而它下次做"跨渠道并发提示"时还用得上。没有消费方的文案不该留着 ——
   * 这条规矩是对的，但它的门禁在 i18n 那边统一管，不在这个文件里。
   */
  it("★ 每张卡有自己的进度行（不再需要「别的渠道也在建」那句补偿）", () => {
    // 进度文案仍在，且带渠道名
    expect(code).toContain("buildProgressOn")
    for (const loc of ["zh", "en"]) {
      expect(readLocale(loc)["buildProgressOn"]).toContain("{{channel}}")
    }
  })

  /**
   * ★★ 按钮的禁用也按渠道判。
   *
   * 顶层 `status.building` 是"任一在建" —— 用它禁用的话钉钉建图期间
   * 飞书那张卡也点不了，而两者是独立的 kl（各自进程、端口、Qdrant writer）。
   */
  it("★★ busy 只看这张卡自己的 row.building", () => {
    const card = code.slice(code.indexOf("function ChannelKlCard"))
    expect(card).toMatch(/const busy = build\.isPending \|\| row\.building/)
  })

  /**
   * ★★★ 这一条是用户报了**四遍**的那个问题的门禁：
   * 「这里的停止是停止谁，这里的重建是重建谁」。
   *
   * 判据不是"文案里有渠道名"（那是补丁），而是**按钮的渠道来自它所在的卡**。
   * 只要 onClick 里取的是 `row.channelId`，"打给谁"就由 DOM 结构决定，
   * 不可能与用户看到的那一行不一致。
   *
   * 反证：断言这一段里**不出现** `channelId ?? undefined` 这类页面级取值 ——
   * 那正是上一版的写法，而它在 `channelId` 为 null（还没选过）时退化成
   * "不指定渠道 → 全建/全停"。实测踩到过：点一次建图，日志里
   * `graph build started` 主渠道与飞书各来一条。
   */
  it("★★★ 启停与建图的渠道都取自这张卡的 row.channelId", () => {
    const card = code.slice(code.indexOf("function ChannelKlCard"))
    expect(card).toMatch(/stop\.mutate\(row\.channelId\)/)
    expect(card).toMatch(/start\.mutate\(row\.channelId\)/)
    expect(card).toMatch(/fresh: false, channelId: row\.channelId/)
    expect(card).toMatch(/fresh: true, channelId: row\.channelId/)
    // ★ 不许再出现"页面级 channelId 兜 undefined"那套写法
    expect(card).not.toContain("channelId ?? undefined")
    expect(card).not.toContain("channelId === null ? {} :")
  })
})

describe("★ 重建：不弹系统确认框", () => {
  /**
   * `window.confirm` 是系统模态框（跳出应用视觉、不可样式化、文案也塞不进
   * 版式）。而「重建」是设置页里一个明确标着名字、旁边就写着代价的按钮 ——
   * 点它的人正是想要这个结果。为一个可预期的操作打断一次交互，收益不抵成本。
   *
   * 代价说明留在按钮旁边那行小字（`rebuildHint`）里：点之前就能读到，
   * 比弹窗更早。
   */
  it("★ 不再调 window.confirm", () => {
    const code = panel
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\/.*$/gm, "")
    expect(code).not.toContain("window.confirm")
    /**
     * 反证：重建按钮本身还在，且仍然传 `fresh: true`。
     *
     * ★ 不再断言 `build.mutate(true)` 这个**具体写法** —— 参数已经从
     * 裸 boolean 变成对象（要一起带渠道 id：不带的话在飞书那栏点「重建」
     * 会把钉钉的图一起删了重烧）。断言写法会让一次正确的重构变红，
     * 而这条测试要守的是"fresh=true 还在传"这件事。
     */
    expect(code).toMatch(/build\.mutate\(\s*\{\s*fresh:\s*true/)
  })

  it("★ rebuildConfirm 这个 key 已删（没有消费方的文案不该留着）", () => {
    for (const loc of ["zh", "en"]) {
      expect(readLocale(loc)["rebuildConfirm"]).toBeUndefined()
    }
  })
})

describe("文案：不用口语化表达", () => {
  /**
   * 「烧钱」「烧 LLM」这类写法在设置页里不合适 —— 这一页的读者要据此做决定
   * （要不要点重建），需要的是"耗时与开销都高于增量建图"这种可判断的描述。
   */
  it("说明文案里不出现「烧钱」「烧 LLM」", () => {
    const kl = readLocale("zh")
    for (const key of ["buildHint", "rebuildHint"]) {
      const text = kl[key] ?? ""
      expect(text, `zh.${key}`).not.toContain("烧钱")
      expect(text, `zh.${key}`).not.toContain("烧 LLM")
    }
  })

  it("三句说明中英文都在（缺一句界面上就是原样的 key）", () => {
    for (const loc of ["zh", "en"]) {
      const kl = readLocale(loc)
      for (const key of ["buildHint", "rebuildHint"]) {
        expect(kl[key], `${loc}.${key}`).toBeTruthy()
      }
    }
  })
})

describe("★ 过期文案：建图不再暂停服务", () => {
  /**
   * `buildHint` 里原来写着「期间图谱服务会暂停」—— 与 in-server ingest 矛盾
   * （增量建图不停 server）。文案错的代价不比代码小：用户会因此不敢在需要
   * 检索的时候点建图。
   */
  it("中英文 buildHint 都不再说服务会暂停", () => {
    expect(readLocale("zh")["buildHint"]).not.toContain("暂停")
    expect(readLocale("en")["buildHint"]).not.toMatch(/pause/i)
  })
})
