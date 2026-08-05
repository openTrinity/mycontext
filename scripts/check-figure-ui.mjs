#!/usr/bin/env node
/**
 * CDP 交互探针：在**运行中的应用**里点一遍形象定制界面。
 *
 * ## 为什么这个探针是必做项
 *
 * 单测给组件喂 props，证明"给定输入行为对"。它证明不了：
 * · 抽屉点了但 `onChange` 没往上传 → 预览不变（**不报错**）；
 * · `custom` 引用不稳 / memo key 没规范化 → 界面卡（**不报错**）；
 * · 切风格后 `sanitizeFigure` 把**全部**槽位都丢了 → 形象重置（**不报错**）；
 * · 保存时 payload 没带全 → `name` 被抹掉（**要过一会儿才发现**，最阴的一个）；
 * · i18n 少一个 key → 界面上显示一串原样的 key。
 *
 * 本仓库的记忆里明确记过一次："数字人页面单测 33 条全绿，
 * CDP 一点就抓到两个真 bug"，形态就是**点了没反应**。
 *
 * ## ★★ 必须跑在 vault 副本上（这条不是建议）
 *
 * 既有的 `check-persona-ui-interact.mjs` 文件头写着它"只读、不点会改库的按钮"。
 * **本探针必须点保存** —— 否则测不到"payload 没带全"那个唯一会真正丢
 * 用户数据的 bug。所以副本不是可选项，是前提：
 *
 *   cp -R ~/Library/Application\\ Support/MyContext /tmp/mycontext-probe
 *   MYCONTEXT_DATA_DIR=/tmp/mycontext-probe pnpm dev
 *   pnpm check:figure-ui 9335
 *
 * 探针自己**无法验证**你有没有这么做（渲染进程读不到主进程的 env），
 * 所以它在开头把这段话打出来。
 *
 * ## 断言必须"会随缺陷变化"
 *
 * 不断言"页面上有 N 个 img"（那在功能完全坏掉时也成立）。
 * 断言**点击前后预览的 `src` 字符串不同** —— 那个量只有在
 * "点击真的生效"时才变。
 */
const PORT = process.argv[2] ?? "9335"

/**
 * 切页签的耗时预算（毫秒）。
 *
 * `hair` 是最坏情况（64 个变体）。分批渲染之后一屏只材质化 32 格，
 * 实测生成侧 32 格 ≈2.4ms —— 预算给到 150ms 是为了容纳 React 提交、
 * 布局与位图解码，以及别人机器比这台慢。
 *
 * ★ 超了就是 `exit 1`（见文件末尾）。上一版只打印一句"考虑分页"而
 * 不改退出码，那等于没有阈值。
 */
const TAB_MS_BUDGET = 150

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === "page")
if (!page) throw new Error("未找到渲染进程页面")

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true })
  socket.addEventListener("error", reject, { once: true })
})

let id = 0
const pending = new Map()
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data)
  const handler = pending.get(message.id)
  if (handler) {
    pending.delete(message.id)
    handler(message)
  }
})

function evaluate(expression) {
  const messageId = (id += 1)
  return new Promise((resolve, reject) => {
    pending.set(messageId, (message) => {
      if (message.error) return reject(new Error(JSON.stringify(message.error)))
      const result = message.result?.result
      if (result?.subtype === "error") return reject(new Error(result.description))
      resolve(result?.value)
    })
    socket.send(
      JSON.stringify({
        id: messageId,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 页面里注入一个 `panel()` —— 返回设置弹窗（找不到时退回 document）。
 *
 * ★ 为什么所有查询都要限定在弹窗里：「数字分身」这四个字在**侧栏导航**里
 * 也有一个同名按钮，而形象块里的页签文案（"头发"）虽然目前是独有的，
 * 但用全局选择器等于赌"别处不会出现同名元素"。
 * 断言与点击用的选择器必须是被测对象**独有**的 —— 这个仓库栽过这一类：
 * 断言的字符串在别处也出现，于是那条断言什么都没锁住。
 */
const INJECT_PANEL = `window.panel = () => document.querySelector("dialog[open]") ?? document.body; true`

/** 当前预览图的 src（最大那张 —— 大预览是 128px，缩略图都更小）。 */
const previewSrc = `(() => {
  const imgs = [...(document.querySelector("dialog[open]") ?? document.body).querySelectorAll("img")]
  const big = imgs
    .map((i) => ({ src: i.getAttribute("src") ?? "", w: i.parentElement?.style.width ?? "" }))
    .filter((x) => x.w === "128px")
  return big[0]?.src ?? null
})()`

console.log(
  [
    "★ 本探针会点「保存形象」—— 那会写库。",
    "  确认你跑的是 vault 副本：",
    "    cp -R ~/Library/Application\\ Support/MyContext /tmp/mycontext-probe",
    "    MYCONTEXT_DATA_DIR=/tmp/mycontext-probe pnpm dev",
    "",
  ].join("\n"),
)

try {
  const results = {}

  /**
   * ★ 从一个**确定的**起点开始：关掉可能还开着的菜单。
   *
   * 探针要能反复跑。上一次跑完时用户菜单/弹窗可能还开着，
   * 而此时再点一次用户按钮会把菜单**关掉**而不是打开 ——
   * 于是 `settingsOpened` 报 false，后面全部错位。
   * 一个只有首次运行才绿的探针实际上等于没有探针。
   *
   * ## ★★ 绝对不要用 `dialogEl.close()` 去关设置弹窗
   *
   * 那个 `<dialog>` 的开关是 **React state 驱动**的（`Dialog` 组件在
   * `useEffect` 里 `open && !node.open → showModal()`）。
   * 直接调 DOM 的 `close()` 只改了 DOM，**React 那边仍以为是开着的** ——
   * 于是 `open` 没变化、effect 不再跑，`showModal()` 永远不会重新触发。
   * 表现是：弹窗内容在 DOM 里齐全（`textContent` 有"设置"），
   * 但 `dialog.open === false` 且**再也打不开** —— 只能刷新页面。
   * 排查这个花了很久，因为"内容在但打不开"看起来像挂载失败。
   *
   * 所以关弹窗要走界面（Escape → `cancel` 事件 → `onClose()` → React state）。
   *
   * ★ 关菜单用**在 body 上派发 `pointerdown`**：`DropdownMenu` 监听的
   * 正是 document 上的 `pointerdown`（判断"目标不在菜单与触发器内"）。
   * 不用"点一遍 aria-expanded=true 的元素"——那个元素就是用户按钮，
   * 点它等于开菜单，清理这一步会自己制造要清理的状态。
   */
  await evaluate(`(() => {
    // 关弹窗走 Escape（原生 dialog 的 cancel → React onClose），不用 close()
    for (const node of document.querySelectorAll("dialog[open]")) {
      node.dispatchEvent(new Event("cancel", { cancelable: true }))
    }
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    return true
  })()`)
  await sleep(800)

  // 侧栏可能是收起的（导航项那时不在 DOM 里）—— 先展开
  await evaluate(`(() => {
    const toggle = [...document.querySelectorAll("button")]
      .find((n) => (n.getAttribute("aria-label") ?? "").includes("展开侧边栏"))
    if (toggle) toggle.click()
    return true
  })()`)
  await sleep(1000)

  /**
   * 打开设置 → 数字分身。
   *
   * ★ 「设置」**不在侧栏导航里**，它在侧栏底部的用户菜单（一个
   * `DropdownMenu`）里。第一版探针按 `aria-label` 含"设置"去找，
   * 结果点中了侧栏的「数字分身」导航项 —— 然后报"设置页里没有形象块"。
   * 那是一句**正确结论、错误理由**的错误信息，最费排查时间。
   *
   * 所以分三步：点用户按钮 → 点菜单里的「设置」→ 点分区「数字分身」。
   */
  await evaluate(`(() => {
    // 用户按钮：文案里带邮箱，是侧栏底部那个。
    // ★ 只在菜单**没开**时点 —— 它是个 toggle，开着时再点就关了
    const hit = [...document.querySelectorAll("button")]
      .find((n) => (n.textContent ?? "").includes("@"))
    if (!hit) return false
    if (hit.getAttribute("aria-expanded") === "true") return "already-open"
    hit.click()
    return true
  })()`)
  await sleep(900)
  /**
   * ★ 入口的文案匹配必须**中英双语**。
   *
   * 本探针自己会把语言切成英文（⑦），而它的收尾未必总能切回来
   * （中途失败就直接退出了）。只认中文的话，**下一次运行**会在这里
   * 找不到入口，然后报"设置页里没有形象块" —— 一句正确结论、
   * 错误理由的错误信息。探针必须能在任一语言下起步。
   */
  results.settingsOpened = await evaluate(`(() => {
    const labels = ["设置", "Settings"]
    const hit = [...document.querySelectorAll("button, [role='menuitem']")]
      .find((n) => labels.includes((n.textContent ?? "").trim()))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  await sleep(2000)
  /**
   * ★ 分区按钮要在**设置弹窗内部**找。
   *
   * 「数字分身」这四个字在侧栏导航里也有一个同名按钮 ——
   * 断言/点击用的选择器必须是被测对象独有的，否则会点到另一个。
   * 弹窗是原生 `<dialog>`（`showModal()`，**没有** `role="dialog"` 属性），
   * 所以选择器是 `dialog[open]` 而不是 `[role='dialog']`。
   */
  results.personaSectionClicked = await evaluate(`(() => {
    const dialog = document.querySelector("dialog[open]")
    if (!dialog) return false
    const labels = ["数字分身", "Digital twin"]
    const hit = [...dialog.querySelectorAll("button")]
      .find((n) => labels.includes((n.textContent ?? "").trim()))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  await sleep(2500)

  await evaluate(INJECT_PANEL)
  results.panelFound = await evaluate(
    `["保存形象", "Save look"].some((label) => panel().textContent.includes(label))`,
  )
  if (results.panelFound !== true) {
    console.error("✗ 设置页里没有找到形象块 —— 挂载那一步没生效（或未登录）")
    process.exitCode = 1
    throw new Error("panel not found")
  }

  /**
   * ① ★ 点一个变体，预览的 src 必须变。
   *
   * 这是本探针最核心的一条。判据是**同一个量的前后差异**，
   * 而不是"页面上有几张图" —— 后者在 onChange 断掉时也成立。
   *
   * ## ★★ 必须点**变体格**，不能顺手点到颜色块
   *
   * 颜色块的 `aria-label` 也是「<名字> <序号>」形式（"发色 2"），
   * 于是一个宽松的正则会把它们一起选中。而颜色块有一个**恶劣的特性**：
   * 点一个恰好等于该风格默认色的块（如 lorelei 的 `hairColor` 默认
   * `000000`），`aria-pressed` 会从 false 变 true，但**产出的 SVG 逐字节相同**
   * —— 于是这条断言报"点了没反应"，而应用其实是好的。
   *
   * 那是一次**假红**，比假绿更浪费时间（它指向一个不存在的 bug）。
   * 所以这里先读当前页签的文案，只点前缀与它一致的格子。
   */
  const activeTab = await evaluate(`(() => {
    const tab = [...panel().querySelectorAll("[role='tab']")]
      .find((n) => n.getAttribute("aria-selected") === "true")
    return (tab?.textContent ?? "").trim() || null
  })()`)
  results.activeTab = activeTab
  const before = await evaluate(previewSrc)
  results.previewFound = before !== null
  const clicked = await evaluate(`(() => {
    const prefix = ${JSON.stringify(activeTab ?? "")}
    if (prefix === "") return false
    const cells = [...panel().querySelectorAll("button[aria-label]")]
      .filter((n) => (n.getAttribute("aria-label") ?? "").startsWith(prefix + " "))
      .filter((n) => /^\\d+$/.test((n.getAttribute("aria-label") ?? "").slice(prefix.length + 1)))
      .filter((n) => n.getAttribute("aria-pressed") === "false")
    if (cells.length === 0) return false
    // 挑靠后的一个，避开"恰好等于当前 seed 长出来的那一件"
    const target = cells[Math.min(4, cells.length - 1)]
    target.click()
    return target.getAttribute("aria-label")
  })()`)
  results.variantClicked = clicked
  await sleep(900)
  const after = await evaluate(previewSrc)
  results.previewChanged = before !== null && after !== null && before !== after

  /**
   * ② ★ 切页签的可交互耗时（`hair` 是 64 格，最坏情况）。
   *
   * 这是步骤 4 性能门槛的**量化依据** —— 不打印这个数，
   * "先量再优化"就只是一句口号。> 150ms 才考虑上分页/虚拟滚动。
   */
  const tabTiming = await evaluate(`(() => {
    const tabs = [...panel().querySelectorAll("[role='tab']")]
    const hair = tabs.find((n) => ["头发", "Hair"].includes((n.textContent ?? "").trim())) ?? tabs[0]
    if (!hair) return null
    const t0 = performance.now()
    hair.click()
    return { start: t0 }
  })()`)
  if (tabTiming !== null) {
    // 等一帧渲染完成（两次 rAF 之后 DOM 已经画上）
    results.hairTabMs = await evaluate(`(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return Math.round(performance.now() - ${String(tabTiming.start)})
    })()`)
    results.hairCellCount = await evaluate(`(() => {
      return [...panel().querySelectorAll("button[aria-label]")]
        .filter((n) => /^(头发|Hair) \\d+$/.test(n.getAttribute("aria-label") ?? "")).length
    })()`)
  }

  /**
   * ③ ★★ 切风格不该把**定制**丢光。
   *
   * 失效形态：`sanitizeFigure` 把全部槽位都丢了（比如风格名对不上），
   * 于是用户切个风格就丢掉了所有定制 —— 而那不报错。
   *
   * ## ★ 判据必须是「选中态还在不在」，不是「抽屉里还有没有格子」
   *
   * 第一版记的是 `drawerStillHasCells`（抽屉里格子数 > 0）——
   * 那个量由**风格**决定（新风格的变体表照样会渲染出几十个格子），
   * 与 `custom` 有没有被丢光**完全无关**。反证时把 `sanitizeFigure`
   * 改成传一个不存在的风格名（于是定制全丢），这条断言照样绿。
   * 一条在缺陷存在时仍为真的断言等于没有断言。
   *
   * 真正会随缺陷变化的量是**`aria-pressed="true"` 的变体格数**：
   * 切风格前先钉一件两个风格都合法的（`hair variant07`），
   * 切完之后它必须仍然是选中的。
   */
  // 先钉一件**两个风格都合法**的：hair 的前几个变体在 notionists/lorelei 都有
  await evaluate(`(() => {
    const tabs = [...panel().querySelectorAll("[role='tab']")]
    const hair = tabs.find((n) => ["头发", "Hair"].includes((n.textContent ?? "").trim()))
    if (hair) hair.click()
    return true
  })()`)
  await sleep(900)
  results.pinnedBeforeStyleSwitch = await evaluate(`(() => {
    const cells = [...panel().querySelectorAll("button[aria-label]")]
      .filter((n) => /^(头发|Hair) \\d+$/.test(n.getAttribute("aria-label") ?? ""))
    /* 挑第 40 个：notionists.hair 有 64 个、lorelei 只有 48 个，
       而变体表是倒序的（variant63 排第 1）——第 40 格在两边都落在合法区间内。 */
    const target = cells[39] ?? cells[0]
    if (!target) return false
    target.click()
    return target.getAttribute("aria-label")
  })()`)
  await sleep(900)

  const beforeStyle = await evaluate(previewSrc)
  results.styleSwitched = await evaluate(`(() => {
    const hit = [...panel().querySelectorAll("button")]
      .find((n) => ["插画", "Illustration"].includes((n.textContent ?? "").trim()))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  await sleep(1500)
  const afterStyle = await evaluate(previewSrc)
  results.stylePreviewChanged = beforeStyle !== afterStyle
  // 抽屉里仍然要有格子（空抽屉与"坏了"在界面上没法区分）—— 必要但**不充分**
  results.drawerStillHasCells = await evaluate(`(() => {
    return [...panel().querySelectorAll("button[aria-label]")]
      .filter((n) => /^[^ ]+ \\d+$/.test(n.getAttribute("aria-label") ?? "")).length > 0
  })()`)
  /**
   * ★ 这才是能抓到"定制被丢光"的那个量。
   * 切风格后回到 hair 页签，数还有几个选中态。
   */
  await evaluate(`(() => {
    const tabs = [...panel().querySelectorAll("[role='tab']")]
    const hair = tabs.find((n) => ["头发", "Hair"].includes((n.textContent ?? "").trim()))
    if (hair) hair.click()
    return true
  })()`)
  await sleep(1000)
  results.pinKeptAfterStyleSwitch = await evaluate(`(() => {
    return [...panel().querySelectorAll("button[aria-label][aria-pressed='true']")]
      .filter((n) => /^(头发|Hair) \\d+$/.test(n.getAttribute("aria-label") ?? "")).length
  })()`)

  /**
   * ④ ★★ 保存后 `name` 还在（R11 —— 唯一会真正丢用户数据的 bug）。
   *
   * `stepDone` 是整体覆盖写。只发 `{figureCustom}` 会把 `name` 抹掉，
   * 而**保存的一瞬间界面上是对的**（本地 state 还在）——
   * 要等下次读草稿署名时才发现。所以只能对着库读回来验。
   */
  const nameBefore = await evaluate(`(async () => {
    const res = await window.mycontext.onboarding.steps()
    const row = (res.data ?? []).find((r) => r.step === "persona")
    return row?.payload?.name ?? null
  })()`)
  results.nameBefore = nameBefore

  results.saveClicked = await evaluate(`(() => {
    const hit = [...panel().querySelectorAll("button")]
      .find((n) => ["保存形象", "Save look"].includes((n.textContent ?? "").trim()))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  await sleep(2500)

  const saved = await evaluate(`(async () => {
    const res = await window.mycontext.onboarding.steps()
    const row = (res.data ?? []).find((r) => r.step === "persona")
    const payload = row?.payload ?? {}
    return {
      name: payload.name ?? null,
      seed: payload.figureSeed ?? null,
      style: payload.figureStyle ?? null,
      customKeys: Object.keys(payload.figureCustom?.slots ?? {}).length,
    }
  })()`)
  results.nameAfter = saved.name
  results.seedAfter = saved.seed
  results.customSlotsSaved = saved.customKeys
  // 保存前没有名字的库（跳过过引导）不算失败 —— 但要说清是哪一种
  results.namePreserved = nameBefore === null ? "库里本来就没名字" : saved.name === nameBefore

  /**
   * ⑤ ★ 没有未翻译的 key 漏在界面上。
   *
   * 判据收紧成"含 `.` 且以 `personaStep.` / `settings.` / `onboarding.` 开头"
   * —— 因为 `slotLabel` 的兜底会**合法地**显示英文槽位名（`freckles`）。
   * 更宽的扫描（如 `/^[a-z]+([A-Z]|\\.)/`）会把那个合法兜底当成缺陷。
   * 这是一个真实的取舍：这条会漏掉"兜底显示了英文名"这种不好看但正确的情形。
   */
  results.untranslatedKeys = await evaluate(`(() => {
    const text = panel().textContent ?? ""
    const hits = text.match(/\\b(personaStep|settings|onboarding|common)\\.[a-zA-Z.]+/g) ?? []
    return [...new Set(hits)].join(",")
  })()`)

  /**
   * ⑥ ★ 抽屉里不出现变体名。
   *
   * 变体名实测含 `mrT` / `dannyPhantom`（第三方角色名）、`pissed` /
   * `faceMask`、以及上游拼写错误 `tound`。它们只该出现在 aria-label
   * 的序号形式里。
   */
  results.variantNamesLeaked = await evaluate(`(() => {
    const text = panel().textContent ?? ""
    const bad = ["mrT", "dannyPhantom", "fonze", "dougFunny", "tound", "pissed", "faceMask"]
    const hits = bad.filter((name) => text.includes(name))
    if (/variant\\d/.test(text)) hits.push("variantNN")
    return hits.join(",")
  })()`)

  /**
   * ⑦ ★ en 语言下抽屉里没有中文。
   *
   * 交付顺序允许步骤 4 先用硬编码的中文 labels 演示，而
   * "步骤 7 没清干净"的表现就是**英文界面里冒出中文** ——
   * 这与 `persona-identity.ts` 文件头警告过的"在 design 层塞中文缺省
   * 会让英文界面冒出中文名"完全同形。这条只有真的清干净了才会绿。
   *
   * ## ★★ 必须点界面上的语言按钮，不能只调 IPC
   *
   * `preferences.setLanguage` **只负责持久化**；真正切界面的是渲染层
   * `useSetLanguage` 里的 `i18n.changeLanguage()`（见 queries.ts）。
   * 只调 IPC 的话库里改了、界面**一个字都不会变** —— 于是这条断言
   * 报"en 下还有中文"，而那全是中文界面本来的文案。
   * 那又是一次**假红**：断言在功能完好时失败，指向一个不存在的 bug。
   *
   * 设置弹窗里就有语言选择器（`通用` 分区，`English` 那个按钮）。
   */
  await evaluate(`(() => {
    const dialog = document.querySelector("dialog[open]")
    if (!dialog) return false
    // 先回到「通用」分区 —— 语言选择器在那里
    const nav = [...dialog.querySelectorAll("button")]
      .find((n) => ["通用", "General"].includes((n.textContent ?? "").trim()))
    if (nav) nav.click()
    return true
  })()`)
  await sleep(1200)
  await evaluate(`(() => {
    const dialog = document.querySelector("dialog[open]")
    const hit = [...(dialog ?? document).querySelectorAll("button")]
      .find((n) => (n.textContent ?? "").trim() === "English")
    if (!hit) return false
    hit.click()
    return true
  })()`)
  await sleep(2000)
  /**
   * ★ 判据是**界面文案真的换了**，不是"点到了按钮"。
   *
   * 记"点 `通用` 成功了"不行 —— 那个量在语言完全没切换时也是 true，
   * 于是这条前置条件恒真，后面那条中文扫描就在中文界面上跑。
   *
   * ★ 也**不能**读 `documentElement.lang`：实测它一直是 `zh-CN`
   * （i18next 不写这个属性，本应用也没有代码去同步它）——
   * 用它做判据会得到一个**永远为 false** 的前置条件，
   * 于是这条断言永远报"没切到英文"，而界面其实换好了。
   * 那是一次假红，且指向的原因是错的。
   *
   * 真正会变的量是弹窗左侧导航的文案：中文 `通用` → 英文 `General`。
   */
  results.switchedToEnglish = await evaluate(`(() => {
    const dialog = document.querySelector("dialog[open]")
    if (!dialog) return false
    const nav = [...dialog.querySelectorAll("button")].map((n) => (n.textContent ?? "").trim())
    return nav.includes("General") && !nav.includes("通用")
  })()`)
  // 回到形象块（英文下分区名变成 "Persona"）
  await evaluate(`(() => {
    const dialog = document.querySelector("dialog[open]")
    if (!dialog) return false
    const hit = [...dialog.querySelectorAll("button")]
      /* 实测英文分区名是 "Digital twin"（不是 "Persona"）—— 照抄实测值 */
      .find((n) => ["Digital twin", "数字分身"].includes((n.textContent ?? "").trim()))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  await sleep(2500)
  results.chineseInEnglishUi = await evaluate(`(() => {
    // 只看形象块的页签（用户自己取的中文名字不算 —— 那是数据不是文案）
    const heads = [...panel().querySelectorAll("[role='tab']")]
    const tabText = heads.map((n) => n.textContent ?? "").join(" ")
    const matched = tabText.match(/[\\u4e00-\\u9fa5]+/g) ?? []
    return [...new Set(matched)].join(",")
  })()`)
  results.englishTabsFound = await evaluate(
    `[...panel().querySelectorAll("[role='tab']")].length > 0`,
  )
  // 语言切回中文，别把探针的副作用留给用户
  await evaluate(`(() => {
    const dialog = document.querySelector("dialog[open]")
    const nav = [...(dialog ?? document).querySelectorAll("button")]
      .find((n) => ["General", "通用"].includes((n.textContent ?? "").trim()))
    if (nav) nav.click()
    return true
  })()`)
  await sleep(1000)
  await evaluate(`(() => {
    const dialog = document.querySelector("dialog[open]")
    const hit = [...(dialog ?? document).querySelectorAll("button")]
      .find((n) => (n.textContent ?? "").trim() === "中文")
    if (hit) hit.click()
    return true
  })()`)
  await sleep(1200)

  console.log("=== 形象定制界面交互探针 ===")
  for (const [key, value] of Object.entries(results)) {
    console.log(`  ${key}: ${String(value)}`)
  }

  const failures = []
  /**
   * `variantClicked` 是**点到的那一格的 aria-label**（或 false），
   * 不是布尔 —— 拿标签而不是 true 是为了让输出能说清点了哪一格
   * （"点了没反应"时第一件想知道的就是点的是哪个）。
   * 所以判据是 `=== false`，不是 `!== true`。
   */
  if (results.variantClicked === false) failures.push("找不到可点的变体格")
  else if (results.previewChanged !== true) {
    failures.push("点了变体但预览的 src 没变 —— onChange 那条线断了（点了没反应）")
  }
  if (results.styleSwitched === true && results.drawerStillHasCells !== true) {
    failures.push("切风格后抽屉空了 —— 新风格的变体表没渲染出来")
  } else if (results.styleSwitched === true && results.pinnedBeforeStyleSwitch !== false) {
    /**
     * ★ 切风格前钉的那一件（两个风格都合法）切完必须还在。
     * 这条才真的能抓到"sanitizeFigure 把定制全丢了" ——
     * `drawerStillHasCells` 在那种缺陷下**照样是 true**（实测反证确认）。
     */
    if (results.pinKeptAfterStyleSwitch === 0) {
      failures.push(
        "切风格把定制丢光了：切换前钉了 " +
          String(results.pinnedBeforeStyleSwitch) +
          "，切换后一个选中态都没有 —— 切风格把定制清空了" +
          "（sanitizeFigure 丢了两边都合法的值，或 switchStyle 直接传了空 custom）",
      )
    }
  }
  if (results.saveClicked !== true) failures.push("找不到保存按钮")
  else if (results.namePreserved === false) {
    failures.push(
      `保存把 name 抹掉了：${String(results.nameBefore)} → ${String(results.nameAfter)}` +
        " —— payload 没带全（stepDone 是覆盖写）",
    )
  } else if (results.seedAfter === null) {
    failures.push("保存后 figureSeed 没了 —— payload 没带全")
  }
  if (results.untranslatedKeys !== "") {
    failures.push(`界面上有未翻译的 key：${results.untranslatedKeys}`)
  }
  if (results.variantNamesLeaked !== "") {
    failures.push(`变体名漏进了界面：${results.variantNamesLeaked}`)
  }
  /**
   * ★★ en 那一条**被跳过**时必须报失败，不能静默放过。
   *
   * `englishTabsFound === false` 意味着切到英文之后**根本没找到页签**
   * —— 那时 `chineseInEnglishUi` 当然是空串，于是
   * "条件 `found === true && 有中文`" 恒假，这条断言什么都没测。
   *
   * 这正是记忆 `gates-that-skip-are-worse-than-gates-that-fail` 的形状：
   * 门禁看起来在工作，实际什么都没保证。第一版就是这么写的，
   * 而它输出 `englishTabsFound: false` 后照样打印了那句 ✓。
   */
  if (results.switchedToEnglish !== true) {
    failures.push("没能切到英文 —— en 语言那条断言没跑（不是通过）")
  } else if (results.englishTabsFound !== true) {
    failures.push(
      "切到英文后找不到形象块的页签 —— en 那条断言**没验到**" +
        "（可能是分区名没跟着换，或形象块在英文下没渲染）",
    )
  } else if (results.chineseInEnglishUi !== "") {
    failures.push(`en 语言下页签里还有中文：${results.chineseInEnglishUi} —— 硬编码文案没清干净`)
  }

  /**
   * ★★ 性能阈值必须**进 failures**，不能只打印一句"考虑分页"。
   *
   * 上一版把它写在成功分支的字符串里（`hairTabMs > 150` 时追加
   * "★ 超过 150ms，考虑分页"），`process.exitCode` 不变 —— 那正是记忆
   * `gates-that-skip-are-worse-than-gates-that-fail` 的形状：
   * 一个只打印的阈值等于没有阈值，因为没人会在一堆绿色输出里
   * 注意到一句建议。
   *
   * ★ `hairTabMs === undefined` 也算失败：那意味着**没量到**
   * （找不到「头发」页签），而"没量到"与"很快"在输出上都是一句没有红字。
   * 这与本文件下面对 en 那条断言的处理同源。
   */
  if (results.hairTabMs === undefined) {
    failures.push("没量到切页签耗时 —— 找不到「头发」页签，这条性能门禁没跑（不是通过）")
  } else if (results.hairTabMs > TAB_MS_BUDGET) {
    failures.push(
      `切到「头发」（${String(results.hairCellCount)} 格）耗时 ` +
        `${String(results.hairTabMs)}ms，超过 ${String(TAB_MS_BUDGET)}ms 预算 —— ` +
        "分批渲染（SlotDrawer 的 revealed）可能被改坏了，或格子数涨上去了",
    )
  }

  if (failures.length > 0) {
    console.error("")
    for (const line of failures) console.error(`✗ ${line}`)
    process.exitCode = 1
  } else {
    console.log(
      "\n✓ 点一件预览真的变了 + 切风格没重置 + 保存后 name/seed 都在 + 无未翻译 key" +
        `；切到「头发」（${String(results.hairCellCount)} 格）耗时 ${String(results.hairTabMs)}ms` +
        `（预算 ${String(TAB_MS_BUDGET)}ms）`,
    )
  }
} finally {
  socket.close()
}
