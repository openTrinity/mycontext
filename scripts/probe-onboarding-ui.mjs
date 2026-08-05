#!/usr/bin/env node
/**
 * CDP 探针：在**运行中的应用**里量引导页的版式与层级。
 *
 * ## 为什么需要它
 *
 * 引导页这一轮改的全是**版式与层级**：横栏多宽、状态字有没有占一行、
 * 三块控件的顺序对不对、有没有嵌套滚动条。单测能锁"文案在不在 DOM 里"，
 * 锁不住"它在屏幕上是什么样" —— 而这次的整个诉求就是后者。
 *
 * 所以这里量的是**计算样式与几何**（宽度、各格高度是否一致、
 * 滚动区个数、`aria-pressed` 个数），不是文本。
 *
 * ## ★ 为什么是"挂载一份"而不是"点进引导页"
 *
 * 引导页只在 `needsOnboarding` 为真时出现，走完之后就进主壳了。
 * 让它重新出现要调 `onboarding.restart()` —— 而那会 **reset 库里的四步进度**
 * （见 `onboarding.service.ts` 的 `restart`），是对用户状态的破坏性改动。
 *
 * 这里改成在同一个 JS 环境里 `import` 一次 `OnboardingView`，渲染到一个
 * 游离（opacity:0、pointer-events:none）的容器上，量完 unmount 掉。
 * 页面本身完全不动，库一个字节都不写。
 *
 * ## 只读
 *
 * 只点步骤条上的四个步骤（纯前端 state），不点「开始蒸馏」「授权」
 * 「进入应用」—— 那些会改库或起子进程。
 *
 * ## 用法
 *
 * 应用要带 `--remote-debugging-port=<port>` 起着：
 *
 * ```
 * pnpm --filter @mycontext/desktop dev -- --remote-debugging-port=9388
 * node scripts/probe-onboarding-ui.mjs 9388
 * ```
 */
const PORT = process.argv[2] ?? "9388"

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === "page")
if (!page) throw new Error("未找到渲染进程页面")

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true })
  socket.addEventListener("error", reject, { once: true })
})

let seq = 0
const pending = new Map()
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data)
  const handler = pending.get(msg.id)
  if (handler) {
    pending.delete(msg.id)
    handler(msg)
  }
})

async function evaluate(expression) {
  const id = ++seq
  const reply = await new Promise((resolve) => {
    pending.set(id, resolve)
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    )
  })
  const details = reply.result?.exceptionDetails
  if (details) {
    return { __err: (details.exception?.description ?? details.text ?? "").slice(0, 400) }
  }
  return reply.result?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const problems = []
const notes = []
function check(ok, label, detail) {
  const line = `${label}${detail === undefined || detail === "" ? "" : ` —— ${detail}`}`
  if (ok) notes.push(`  ✓ ${line}`)
  else problems.push(`  ✗ ${line}`)
}

/**
 * 依赖的 URL —— 必须**逐字用页面自己加载过的那个**。
 *
 * ## ★ 这里有两个坑，都实测踩过
 *
 * 1. `performance` 里既有短 URL（`/node_modules/.vite/deps/react.js`）也有
 *    `/@fs/<绝对路径>/…` 的长 URL。**短的 import 不到**（`Failed to fetch`）——
 *    它只是 Vite 内部重写的落点。
 *
 * 2. 更要紧的：带 `?v=<hash>` 与不带的是**两个不同的模块实例**。
 *    用不带 hash 的那个去建 `QueryClientProvider`，而 `OnboardingView` 里的
 *    `useQuery` 来自带 hash 的那份 —— 于是 React context 对不上，
 *    整棵树抛 `No QueryClient set`，而**页面上什么都不渲染**。
 *    那次的表现极具误导性：所有"某段文案已删掉"的断言**全部通过**
 *    （缺席被读成了删除），只有量宽度的那几条报 undefined。
 *
 * 所以这里筛的是"带 hash 的 @fs 长 URL"，并且**一个都不能少**。
 */
const deps = await evaluate(`
  (() => {
    const want = ['react', 'react-dom_client', '@tanstack_react-query', 'react-i18next']
    const found = {}
    for (const entry of performance.getEntriesByType('resource')) {
      // 只认 @fs 开头且带 ?v= 的 —— 见上方注释里那两个坑
      if (!entry.name.includes('/@fs/') || !entry.name.includes('?v=')) continue
      const m = /\\.vite\\/deps\\/(.+?)\\.js\\?v=/.exec(entry.name)
      if (m !== null && want.includes(m[1])) found[m[1]] = entry.name
    }
    return found
  })()
`)
const missing = ["react", "react-dom_client", "@tanstack_react-query", "react-i18next"].filter(
  (k) => deps?.[k] === undefined,
)
if (missing.length > 0) {
  console.log(`⚠️  页面还没加载过这些依赖：${missing.join(", ")}`)
  console.log("   等应用完全渲染出主界面之后再跑。")
  socket.close()
  process.exit(1)
}

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const I18N = `http://localhost:5273/@fs${REPO}/packages/i18n/src/index.ts`

const mount = await evaluate(`
  (async () => {
    /**
     * Vite 的 optimized deps 是 CJS-interop 的命名空间：有些包的实体挂在
     * \`default\` 上而不是命名导出。两边合一下，省掉逐个判断。
     */
    const un = (m) =>
      m && typeof m.default === 'object' && m.default !== null && Object.keys(m).length <= 2
        ? { ...m.default, ...m }
        : m
    const React = un(await import(${JSON.stringify(deps.react)}))
    const RD = un(await import(${JSON.stringify(deps["react-dom_client"])}))
    const rq = un(await import(${JSON.stringify(deps["@tanstack_react-query"])}))
    const ri = un(await import(${JSON.stringify(deps["react-i18next"])}))
    const i18nMod = await import(${JSON.stringify(I18N)})
    const ob = await import('http://localhost:5273/features/onboarding/onboarding-view.tsx')

    const host = document.createElement('div')
    // 量几何要求它**有真实尺寸**，所以不能 display:none —— 用透明 + 不可点
    host.style.cssText =
      'position:fixed;left:0;top:0;width:1400px;height:900px;opacity:0;pointer-events:none;z-index:-1;'
    document.body.appendChild(host)

    const ce = React.createElement ?? React.default.createElement
    const createRoot = RD.createRoot ?? RD.default.createRoot
    const root = createRoot(host)
    root.render(
      ce(ri.I18nextProvider, { i18n: i18nMod.createI18n('zh') },
        ce(rq.QueryClientProvider,
          { client: new rq.QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          ce(ob.OnboardingView))))
    await new Promise((r) => setTimeout(r, 2200))
    window.__PROBE_HOST = host
    window.__PROBE_ROOT = root
    return { mounted: true, length: (host.textContent ?? '').length }
  })()
`)
if (mount?.__err !== undefined) {
  console.log("挂载失败：", mount.__err)
  socket.close()
  process.exit(1)
}
/**
 * ★ 必须验"真的渲染出东西了"，不能只验"没抛错"。
 *
 * 踩过：render 之后什么都没渲染出来，而下面每一条 check 拿到的都是
 * `undefined` —— 于是"文案删掉了"那几条**全部通过**（缺席被读成了删除），
 * 而"宽度是 880"那几条报 `undefinedpx`。
 * 一个探针给出 7 个假绿比整个失败更危险。
 */
if (typeof mount?.length !== "number" || mount.length < 40) {
  console.log("挂载后没有内容 —— 探针拿不到可量的 DOM，本次结论作废。")
  console.log("mount =", JSON.stringify(mount))
  socket.close()
  process.exit(1)
}

/** 点步骤条上的某一步（可点跳转是引导页的既有能力）。 */
async function goStep(label) {
  await evaluate(`
    (() => {
      const btn = [...window.__PROBE_HOST.querySelectorAll('ol > li button')]
        .find((n) => (n.textContent ?? '').includes(${JSON.stringify(label)}))
      if (btn) btn.click()
      return btn !== undefined
    })()
  `)
  await sleep(800)
}

// ── ① 顶部横栏 ──────────────────────────────────────────
const bar = await evaluate(`
  (() => {
    const ol = window.__PROBE_HOST.querySelector('ol')
    if (ol === null) return { none: true }
    const li = [...ol.querySelectorAll(':scope > li')]
    const heights = li.map((n) => Math.round(n.getBoundingClientRect().height))
    return {
      width: Math.round(ol.getBoundingClientRect().width),
      steps: li.length,
      heights,
      uniform: new Set(heights).size === 1,
      srOnly: ol.querySelectorAll('.sr-only').length,
      visibleDone: [...ol.querySelectorAll('span')].filter(
        (n) => (n.textContent ?? '').trim() === '已完成' && !n.classList.contains('sr-only'),
      ).length,
    }
  })()
`)
check(bar.width >= 860, "顶栏加宽到 880", `${bar.width}px（原 640）`)
check(bar.steps === 5, "五步都在", `${bar.steps} 格`)
check(bar.uniform, "各格高度一致（状态字不再让做完的那格变高）", JSON.stringify(bar.heights))
check(bar.visibleDone === 0, "「已完成」不再占可见行")
check(bar.srOnly === bar.steps, "状态词保留给读屏器", `${bar.srOnly} 条 sr-only`)

const width = await evaluate(`
  (() => {
    const el = [...window.__PROBE_HOST.querySelectorAll('div')].find(
      (n) => getComputedStyle(n).maxWidth === '720px',
    )
    return el === undefined ? null : Math.round(el.getBoundingClientRect().width)
  })()
`)
check(width === 720, "内容列宽度 720（原 560）", width === null ? "找不到" : `${width}px`)

// ── ② 步骤 1：头像 + 分区标题 ───────────────────────────
await goStep("连接平台")
const step1 = await evaluate(`
  (() => {
    const h = window.__PROBE_HOST
    const t = h.textContent ?? ''
    return {
      authorized: t.includes('已连接'),
      imgs: [...h.querySelectorAll('img')].map((n) => Math.round(n.getBoundingClientRect().width)),
      /**
       * Avatar 的首字母兜底。
       *
       * ## ★ 认它认过两次错，判据最后落在**尺寸 + 单个字**上
       *
       * 1. 一开始按 \`borderRadius === '9999px'\` 认 —— Tailwind v4 的
       *    \`rounded-full\` 实测算出来是 \`1.67772e+07px\`，一个都匹配不到；
       * 2. 改成按 class 含 \`rounded-full\` 认 —— 而 \`Avatar\` 后来加了
       *    \`shape\` prop 且**默认是 squircle**（\`rounded-[19px]\` +
       *    \`corner-squircle\`），于是又匹配不到。
       *
       * 两次的失败表现都一样：报"头像没画出来"，而它其实画出来了。
       * 所以判据改成**它是什么**而不是**它长什么样**：一个 size="xl"（64px）
       * 的方块，里面只有一个字（首字母）。形状与圆角值将来还可能再改，
       * 而"64px 见方 + 一个字"是这个兜底的语义本身。
       */
      fallbackAvatars: [...h.querySelectorAll('span,div')].filter((n) => {
        const r = n.getBoundingClientRect()
        if (Math.round(r.width) !== 64 || Math.round(r.height) !== 64) return false
        const text = (n.textContent ?? '').trim()
        return text.length === 1 && n.querySelector('img') === null
      }).length,
      oldSubtitle: t.includes('后续的消息采集与蒸馏都基于这个授权'),
      sections: [...h.querySelectorAll('section')].map((n) =>
        (n.querySelector('span')?.textContent ?? '').slice(0, 12),
      ),
    }
  })()
`)
if (step1.authorized) {
  check(
    step1.imgs.some((w) => w >= 56) || step1.fallbackAvatars > 0,
    "授权后画头像（有图用图，没图用首字母兜底）",
    step1.imgs.length > 0
      ? `img 宽 ${JSON.stringify(step1.imgs)}`
      : `首字母兜底 ${step1.fallbackAvatars} 个`,
  )
  check(!step1.oldSubtitle, "删掉了那句「后续的消息采集与蒸馏都基于这个授权」")
  check(
    step1.sections.includes("已连接的账号"),
    "凭证信息收进带标题的分区",
    JSON.stringify(step1.sections),
  )
} else {
  notes.push("  · 未授权 → 头像那几条跳过（未授权时本来就没有身份可画）")
}

// ── ③ 步骤 2：层级顺序 + 预设选中态 ─────────────────────
await goStep("数字分身")
const step2 = await evaluate(`
  (() => {
    const h = window.__PROBE_HOST
    const t = h.textContent ?? ''
    const at = (k) => t.indexOf(k)
    const order = [['快速开始', at('快速开始')], ['风格', at('风格')], ['细节调整', at('细节调整')]]
      .filter((x) => x[1] >= 0)
      .sort((a, b) => a[1] - b[1])
      .map((x) => x[0])
    return {
      order,
      presetPressed: [...h.querySelectorAll('button[aria-pressed]')].filter(
        (n) => n.querySelector('img') !== null,
      ).length,
      deepBadge: (t.match(/可深度定制/g) ?? []).length,
    }
  })()
`)
check(
  JSON.stringify(step2.order) === JSON.stringify(["快速开始", "风格", "细节调整"]),
  "三块按真实依赖排序（预设 → 风格 → 细节）",
  JSON.stringify(step2.order),
)
check(
  step2.presetPressed > 0,
  "预设有 aria-pressed 选中态（改动前完全没有）",
  `${step2.presetPressed} 个`,
)
check(step2.deepBadge === 1, "「可深度定制」只作为能力标记出现一次", `${step2.deepBadge} 次`)

// ── ④ 步骤 3：嵌套滚动 ─────────────────────────────────
await goStep("蒸馏范围")
await sleep(2500) // 会话列表要等 IPC（实测约 4.8s 的三路子进程调用）
const step3 = await evaluate(`
  (() => {
    const h = window.__PROBE_HOST
    const t = h.textContent ?? ''
    const scrollers = [...h.querySelectorAll('*')].filter((n) => {
      const s = getComputedStyle(n)
      return s.overflowY === 'auto' || s.overflowY === 'scroll'
    })
    return {
      scrollers: scrollers.map((n) => String(n.className).slice(0, 44)),
      // 定高滚动区的痕迹：原来是 max-h-[320px]
      maxH320: [...h.querySelectorAll('*')].filter(
        (n) => getComputedStyle(n).maxHeight === '320px',
      ).length,
      ready: t.includes('现在可用'),
      planned: t.includes('排期中'),
    }
  })()
`)
check(step3.maxH320 === 0, "定高 320px 滚动区已去掉", `找到 ${step3.maxH320} 个`)
check(
  step3.scrollers.length <= 1,
  "只剩页面这一层滚动（不再嵌套）",
  `${step3.scrollers.length} 个：${JSON.stringify(step3.scrollers)}`,
)
check(step3.ready && step3.planned, "资料源分「现在可用 / 排期中」")

// ── ⑤ 步骤 4：阶段条 + 废话删掉 ────────────────────────
await goStep("开始蒸馏")
await sleep(1000)
const step4 = await evaluate(`
  (() => {
    const h = window.__PROBE_HOST
    const t = h.textContent ?? ''
    const tracks = [...h.querySelectorAll('ol')].filter((n) =>
      (n.textContent ?? '').includes('读语料'),
    )
    return {
      trackCount: tracks.length,
      phases: tracks[0]
        ? [...tracks[0].querySelectorAll(':scope > li')].map((n) => (n.textContent ?? '').trim())
        : [],
      oldHint: t.includes('蒸馏会读你选的会话并抽取画像'),
      sourceSummary: /已启用 \\d+ 个资料源/.test(t),
      oldCardTitle: t.includes('画像蒸馏（本地测量'),
      denseCounts: /语料 \\d+ 条 · 配对/.test(t),
      result: t.includes('蒸馏结果'),
      grade: t.includes('覆盖度'),
    }
  })()
`)
check(step4.trackCount === 1, "有三阶段的阶段条", JSON.stringify(step4.phases))
check(
  JSON.stringify(step4.phases) === JSON.stringify(["读语料", "测量", "生成产物"]),
  "阶段名与 ForgeService 的 pull/build/publish 一一对应",
)
check(!step4.oldHint, "删掉了与父级重复的 hint")
check(!step4.sourceSummary, "删掉了会误导的「已启用 N 个资料源」")
check(!step4.oldCardTitle, "删掉了重复的卡片标题")
check(!step4.denseCounts, "结果不再是一行 `·` 串起来的五个数")
if (step4.result) check(step4.grade, "覆盖度等级单独成块")
else notes.push("  · 这个账号还没蒸过 → 结果卡不显示（刻意：没跑过时一排 0 是噪音）")

// ── 收尾：卸载探针容器，页面不受影响 ────────────────────
await evaluate(`
  (() => {
    try {
      window.__PROBE_ROOT.unmount()
      window.__PROBE_HOST.remove()
    } catch {}
    return true
  })()
`)

console.log("\n引导页版式探针（真应用，只读，不写库）\n")
console.log(notes.join("\n"))
if (problems.length > 0) {
  console.log("\n有问题：")
  console.log(problems.join("\n"))
}
console.log(`\n通过 ${notes.filter((n) => n.includes("✓")).length} · 问题 ${problems.length}`)
socket.close()
process.exit(problems.length > 0 ? 1 : 0)
