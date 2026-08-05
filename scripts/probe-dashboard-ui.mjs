#!/usr/bin/env node
/**
 * CDP 探针：在**运行中的应用**里量仪表盘的层级与对齐。
 *
 * ## 为什么需要它
 *
 * 这一轮改的全是"看起来割不割裂"：卡片有没有壳、卡里的数字有没有下沉
 * 一层色阶、标题与内容左缘是否同一条线、分组间距是不是两档。
 * 单测能锁"class 里有没有那个 token"，锁不住"它在屏幕上算出来是什么色值"
 * —— 而 jsdom 压根不算 CSS 变量（`getComputedStyle` 拿到空串）。
 *
 * 所以这里量的是**计算样式与几何**，只有真浏览器给得出。
 *
 * ## ★ 为什么是"挂载一份"而不是"点进仪表盘"
 *
 * 应用当前可能停在引导页（走完了才进主壳）。点「进入应用」会调
 * `onboarding.complete()` —— 那是对库的写操作。
 *
 * 这里改成在同一个 JS 环境里 `import` 一次 `DashboardModule`，渲染到一个
 * 游离（opacity:0、pointer-events:none）的容器上，量完 unmount 掉。
 * 页面本身完全不动，库一个字节都不写。
 *
 * ## ★ 两个坑（都实测踩过，见下方注释）
 *
 * 1. 依赖 URL 必须逐字用页面自己加载过的那个**带 `?v=hash` 的 @fs 长 URL**
 *    —— 不带 hash 的是另一个模块实例，会让整棵树抛 `No QueryClient set`；
 * 2. 挂载失败时**缺席会被读成"已删除"**，于是所有 `not.toContain` 型断言
 *    全部变绿。所以下面有一道内容长度门禁：渲染不出东西就 exit 1。
 *
 * ## 用法
 *
 *   pnpm dev -- --remote-debugging-port=9388     # 或让应用已带该端口在跑
 *   node scripts/probe-dashboard-ui.mjs [端口]
 */

const PORT = process.argv[2] ?? "9388"

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = list.find((p) => p.type === "page")
if (page === undefined) {
  console.log(`⚠️  ${PORT} 上没有页面。应用带 --remote-debugging-port=${PORT} 起来了吗？`)
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data)
  if (pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const reply = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  const details = reply.result?.exceptionDetails
  if (details !== undefined) {
    throw new Error(details.exception?.description ?? details.text ?? "eval failed")
  }
  return reply.result?.result?.value
}

await new Promise((resolve) => socket.addEventListener("open", resolve))
await send("Runtime.enable")

/**
 * 依赖的 URL —— 必须**逐字用页面自己加载过的那个**（见文件头坑 1）。
 */
const WANT = ["react", "react-dom_client", "@tanstack_react-query", "react-i18next"]
const deps = await evaluate(`
  (() => {
    const want = ${JSON.stringify(WANT)}
    const found = {}
    for (const entry of performance.getEntriesByType('resource')) {
      if (!entry.name.includes('/@fs/') || !entry.name.includes('?v=')) continue
      const m = /\\.vite\\/deps\\/(.+?)\\.js\\?v=/.exec(entry.name)
      if (m !== null && want.includes(m[1])) found[m[1]] = entry.name
    }
    return found
  })()
`)
const missing = WANT.filter((k) => deps?.[k] === undefined)
if (missing.length > 0) {
  console.log(`⚠️  页面还没加载过这些依赖：${missing.join(", ")}`)
  socket.close()
  process.exit(1)
}

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const I18N = `http://localhost:5273/@fs${REPO}/packages/i18n/src/index.ts`
const MODULE = `http://localhost:5273/@fs${REPO}/apps/desktop/src/renderer/features/dashboard/dashboard-module.tsx`

const mount = await evaluate(`
  (async () => {
    const un = (m) =>
      m && typeof m.default === 'object' && m.default !== null && Object.keys(m).length <= 2
        ? { ...m.default, ...m }
        : m
    const React = un(await import(${JSON.stringify(deps.react)}))
    const RD = un(await import(${JSON.stringify(deps["react-dom_client"])}))
    const rq = un(await import(${JSON.stringify(deps["@tanstack_react-query"])}))
    const ri = un(await import(${JSON.stringify(deps["react-i18next"])}))
    const i18nMod = await import(${JSON.stringify(I18N)})
    const mod = await import(${JSON.stringify(MODULE)})

    const host = document.createElement('div')
    host.id = '__probe_dashboard'
    // 游离：不可见、不吃事件、不影响页面布局之外的任何东西
    host.style.cssText = 'position:fixed;left:0;top:0;width:1440px;height:2400px;opacity:0;pointer-events:none;z-index:-1'
    document.body.appendChild(host)

    const client = new rq.QueryClient({ defaultOptions: { queries: { retry: false } } })
    const root = RD.createRoot(host)
    root.render(
      React.createElement(ri.I18nextProvider, { i18n: i18nMod.createI18n('zh') },
        React.createElement(rq.QueryClientProvider, { client },
          React.createElement(mod.DashboardModule))))
    globalThis.__probeRoot = root
    // 等 query 回来（IPC 要过主进程）
    await new Promise((r) => setTimeout(r, 2500))
    return (host.textContent ?? '').length
  })()
`)

/**
 * ★★ 挂载门禁 —— 见文件头坑 2。
 *
 * 渲染失败时 `textContent` 是空的，而"文字不在"会被读成"已经删掉了"。
 * 那一次七条断言全绿、结论全错。所以这里宁可 exit 1。
 */
if (typeof mount !== "number" || mount < 60) {
  console.log(`❌ 挂载没生效（内容长度 ${String(mount)}）—— 后面的判断都不可信，中止。`)
  await evaluate(
    `globalThis.__probeRoot?.unmount(); document.getElementById('__probe_dashboard')?.remove(); 1`,
  )
  socket.close()
  process.exit(1)
}

const probe = await evaluate(`
  (() => {
    const host = document.getElementById('__probe_dashboard')
    const T = (e) => (e?.textContent ?? '').replace(/\\s+/g, ' ').trim()
    const bg = (e) => getComputedStyle(e).backgroundColor
    const checks = []
    const ok = (name, pass, detail) => checks.push({ name, pass, detail })

    // ① 名字**恰好出现一次**（问候语里），不是身份条那种重复
    /**
     * ★ 这一条的判据变了：上一版是"一次都不许出现"（那时刚删掉与侧栏
     * 重复的身份条）。现在顶部有一行问候「下午好，小王」，名字**应该**
     * 出现 —— 但只能出现在那一处。
     *
     * 所以判据从"0 处"改成"恰好 1 处"：既防身份条复活（那会变成 2 处），
     * 也防问候语丢掉（0 处）。
     *
     * 花名（小王）与实名（高鹏）都算 —— 显示哪个取决于渠道有没有花名，
     * 而这一条要验的是"名字只出现一次"，与显示的是哪个无关。
     */
    const nameHits = [...host.querySelectorAll('*')]
      .filter((e) => /高鹏|小王/.test(T(e)) && e.children.length === 0)
    ok('名字恰好出现一次（问候语里，不是身份条那种重复）',
        nameHits.length === 1, \`命中 \${nameHits.length} 处\`)
    ok('没有恒亮的「本人身份已确认」', !T(host).includes('本人身份已确认'), '')

    // ② 数字块是**凹槽**，且与页面底色可分（层级靠色阶，不靠框）
    const card = [...host.querySelectorAll('section')].find((e) => T(e).includes('我的数字分身'))
    const tiles = card === undefined ? [] : [...card.querySelectorAll('div')]
      .filter((e) => {
        const t = T(e)
        return ['待我确认', '可自动回复', '正在排队', '常驻会话'].some((l) => t.startsWith(l))
          && t.length < 40 && e.className.includes('rounded')
      })
    const tileBg = tiles[0] === undefined ? null : bg(tiles[0])
    // ★ body 是透明的（底色画在 main 那层）—— 只用来判断"没画自己的背景"
    const pageBg = getComputedStyle(document.body).backgroundColor
    ok('找到分身卡与它内部的数字块', card !== undefined && tiles.length === 4,
        \`卡=\${String(card !== undefined)} 数字块=\${tiles.length}\`)

    /**
     * ★★ 这一条的方向**反过来**了，理由记在这里。
     *
     * 上一版断言的是"主数字与分身卡都有壳（同一种）"—— 那时我刚给主数字
     * 加了个框来消除"一块裸一块有壳"。方向错了：两块都升成卡之后这一页
     * 变成"框套框套框"，用户：「上面为啥还要加框，好怪」。
     *
     * 现在断言的是**两块都没有面**：section 的底色应与页面底色相同
     * （即它压根没画自己的背景）。
     */
    /**
     * 「消息」那一块 —— 它现在是**第六个 MiniStat**（label + 18px 数字），
     * 不再是上一版那个 48px 的 HeroStat（那个组件已删）。
     *
     * 找法不变（label='消息' + 纯数字），因为 MiniStat 的结构与它一样：
     * 一个 span 装 label、一个 span 装数字。
     */
    const msgStat = [...host.querySelectorAll('div')].find((e) => {
      const spans = e.querySelectorAll('span')
      if (spans.length < 2) return false
      const label = T(spans[0])
      const value = T(spans[1])
      return label === "消息" && /^[0-9,—-]+$/.test(value)
    })
    const transparent = (v) => v === 'rgba(0, 0, 0, 0)' || v === 'transparent' || v === pageBg
    ok('清点数**没有**框（裸排，不是卡片）',
        msgStat !== undefined && transparent(bg(msgStat)),
        \`「消息」底色=\${msgStat === undefined ? 'missing' : bg(msgStat)}\`)
    ok('分身卡也**没有**框',
        card !== undefined && transparent(bg(card)),
        \`分身卡底色=\${card === undefined ? 'missing' : bg(card)}\`)

    /**
     * ★★ 清点数的字号 ≥ 18px —— 防止又被压小。
     *
     * 这个字号来回改过：18 → 15（为了"挤进一行"）→ 18（用户："MiniStat
     * 可能也太小了"）。15px 与 12px 的 label 只差 3px，主次读不出来。
     * 判据量**实测像素**而不是 class 名 —— 换 token 时 class 名也会变。
     */
    const msgValue = msgStat?.querySelectorAll('span')[1]
    const msgFs = msgValue === undefined || msgValue === null
      ? null
      : Number.parseFloat(getComputedStyle(msgValue).fontSize)
    ok('清点数字号 ≥ 18px（不许再被压小）',
        msgFs !== null && msgFs >= 18, \`实测 \${msgFs}px\`)

    /**
     * ★ 但数字块**仍要与页面底色分得开** —— 去框之后它是唯一的层级信号。
     *
     * ## 两个坑，都实测撞过
     *
     * 1. document.body 的背景是**透明**的（底色画在 main 那一层）。
     *    拿 body 去比会得到 rgba(0,0,0,0)，差值算出 255 —— 一个
     *    "过了但什么都没验"的绿。所以这里读页面上真正画了底色的那个祖先；
     * 2. z0 是**半透明**的，getComputedStyle 给的是 rgba(...,0.06)
     *    而不是合成后的色值。所以要自己按 alpha 合成一次再比。
     *
     * 暗色下应约 rgb(44,44,44) vs rgb(31,31,31) → 差 13；
     * 亮色下 243 vs 252 → 差 9。所以门限取 6。
     */
    const num = (v) => (v.match(/[\\d.]+/g) ?? []).map(Number)
    /**
     * 页面真正画了底色的那一层。
     *
     * ★ **不能**从 host 往上找祖先：探针的容器是挂在 body 下的一个
     * 游离 div，它的祖先只有 body（透明）。第一版就是那么写的，
     * 于是拿到 null，整条检查变成 null >= 6 —— 一个"过了但什么都没验"
     * 的反面（这次是恒红，同样没有信息）。
     *
     * 真实的底色画在应用外壳的 main 上（bg-base-normal）。
     * 拿不到时退回读 :root 上那个 token 的计算值。
     */
    const paintedBg = (() => {
      const main = document.querySelector('main')
      if (main !== null) {
        const c = getComputedStyle(main).backgroundColor
        const p = num(c)
        if (p.length >= 3 && (p[3] === undefined || p[3] > 0.9)) return c
      }
      // 退路：直接问 token（探针环境里 main 可能还没渲染）
      const probeEl = document.createElement('div')
      probeEl.style.cssText = 'position:fixed;left:-9999px;background:var(--bg-base-normal)'
      document.body.appendChild(probeEl)
      const c = getComputedStyle(probeEl).backgroundColor
      probeEl.remove()
      return c
    })()
    // z0 over 页面底色：按 alpha 合成
    const composed = (() => {
      if (tileBg === null || paintedBg === null) return null
      const f = num(tileBg), b = num(paintedBg)
      if (f.length < 3 || b.length < 3) return null
      const a = f[3] ?? 1
      return Math.round((f[0] ?? 0) * a + (b[0] ?? 0) * (1 - a))
    })()
    const delta = composed === null || paintedBg === null
      ? null
      : Math.abs(composed - (num(paintedBg)[0] ?? 0))
    ok('数字块与页面底色仍可分（合成后差值 ≥ 6）',
        delta !== null && delta >= 6,
        \`合成后=\${composed} 页面=\${paintedBg} 差=\${delta}\`)

    // ③ 问候行：问候语 + 它**右边**的头像
    const greetLine = [...host.querySelectorAll('div')].find((e) => {
      const t = T(e)
      return /^(早上好|下午好|晚上好|夜深了)/.test(t) && t.length < 30
    })
    ok('有问候语（早上好/下午好/晚上好/夜深了）',
        greetLine !== undefined, greetLine === undefined ? '一个都没有' : T(greetLine))

    /**
     * ★★ 头像在问候语**左边** —— 这一条的方向被改过两次。
     *
     * · v1：头像在左（我按"图标+文字"的常规顺序放的）；
     * · v2：用户「下午好，{钉钉名} 右边是头像」→ 改到右边；
     * · v3（现在）：用户「头像请在 greeting 部分左边」→ 改回左边。
     *
     * 判据量 **x 坐标**而不是"存在"：只断言"有头像"的话，它在任何一侧
     * 都是绿的 —— 而这两轮争的正是哪一侧。
     *
     * ★ greetText 必须找**带问候文字的那个 span**，不能用
     * querySelector('span') 取第一个 —— 头像取不到图时会渲染一个
     * 带首字母的 span，而它现在排在 greeting **前面**，
     * 于是"第一个 span"是头像而不是问候语。
     */
    const greetText = [...(greetLine?.querySelectorAll('span') ?? [])].find((e) =>
      /^(早上好|下午好|晚上好|夜深了)/.test(T(e)))
    const avatar = greetLine?.querySelector('img, span[aria-hidden="true"]')
    const xOf = (el) => (el === null || el === undefined ? null : Math.round(el.getBoundingClientRect().x))
    ok('头像在问候语左边（不是右边）',
        xOf(avatar) !== null && xOf(greetText) !== null && xOf(avatar) < xOf(greetText),
        \`头像 x=\${xOf(avatar)} 问候语 x=\${xOf(greetText)}\`)

    /**
     * ★★ 这一条的方向**又反过来了**（第三次），历程记在这里。
     *
     * · v1：问候一行 / 消息+小指标一行 —— 断言"问候在主数字之上"；
     * · v2：三组挤同一行 —— 断言"问候与主数字 y 差 < 30px"（同一行）；
     * · v3（现在）：**拆成上下两段** —— 问候独占一行，六个清点数另一行。
     *
     * 用户："MiniStat 可能也太小了，也不一定强求在一行里" ——
     * 那是把"必须同一行"这条**假约束**松掉的许可。挤同一行时每轮都在做
     * 同一种取舍（压字号 or 压间距），松掉之后两边都能舒展。
     *
     * 所以判据是"问候行在清点行**之上**、且两者不在同一行（y 差 > 20px）"。
     */
    const yOf = (el) => (el === null || el === undefined ? null : Math.round(el.getBoundingClientRect().y))

    /**
     * ★★ 五个小指标在**另一行**，且**独立右对齐**。
     *
     * 上一版是"小指标塞在主数字的 aside 里"，现在拆到主数字**下方**的
     * 独立一行。判据：
     * · 它的 y 大于主数字（在下面）
     * · 它的**右缘**贴近**主数字**的右缘（"和会话数在一块"）
     *
     * ## ★ 找 miniRow 用**祖先里最里层**的那个
     *
     * 第一版直接 find "文字里含'会话'/'关系边'/'图片与文件'的 div" ——
     * 那匹配了很多祖先（host 自己就含全部这些字）。第一个命中的是最外层
     * 的整块 host（y=0），于是"在主数字下面"永远红。
     *
     * 改成筛后取**最小的**（面积最小 = 最里层），命中的是真正的小指标那行。
     */
    /**
     * 六个清点项 —— 每一项是"label + 数字"的一个小块。
     *
     * ★ 找法从"含全部三个词的那个容器"改成"逐项找"。
     *
     * 上一版六项在同一个 flex 里，所以能靠"文字含 会话/关系边/图片与文件"
     * 找到那个共同容器。改成 12 列栅格之后**每项自己一个 col-span div**，
     * 没有任何一个 div 同时含全部三个词（除了整个栅格）——
     * 旧找法会命中最外层，量出来的 x/y 全是整块的，判据就失去意义。
     */
    const STAT_LABELS = ['会话', '图片与文件', '实体', '事实', '关系边', '消息']
    const statCells = STAT_LABELS.map((label) => {
      // 那一项的最内层块：文字恰好是 "label + 数字"
      const cells = [...host.querySelectorAll('div')].filter((e) => {
        const spans = e.querySelectorAll('span')
        if (spans.length !== 2) return false
        return T(spans[0]) === label
      })
      // 取面积最小的（最里层那个 MiniStat 自己）
      return cells.length === 0
        ? null
        : cells.reduce((a, b) => {
            const aR = a.getBoundingClientRect(), bR = b.getBoundingClientRect()
            return aR.width * aR.height <= bR.width * bR.height ? a : b
          })
    })
    ok('找到全部六个清点项',
        statCells.every((c) => c !== null),
        \`命中 \${statCells.filter((c) => c !== null).length}/6\`)
    const firstStat = statCells[0]
    const lastStat = statCells[STAT_LABELS.length - 1]
    const miniRight = lastStat === null || lastStat === undefined
      ? null
      : lastStat.getBoundingClientRect().right
    const miniY = firstStat === null || firstStat === undefined
      ? null
      : Math.round(firstStat.getBoundingClientRect().y)

    /**
     * ★ 清点行在问候行**下面**，且两者**不在同一行**。
     *
     * 门限 20px：问候行本身高 64px（头像），清点行高约 40px。
     * 真拆成两段时 y 差应在 80px 以上；挤回同一行时差会掉到 30 以内。
     * 20 落在两者中间，离两边都有余量。
     */
    const segGap = miniY === null || yOf(greetLine) === null
      ? null
      : miniY - (yOf(greetLine) ?? 0)
    ok('清点行在问候行下面、各占一行（y 差 > 20px）',
        segGap !== null && segGap > 20,
        \`问候 y=\${yOf(greetLine)} 清点 y=\${miniY} 差=\${segGap}px\`)

    /**
     * ★ 清点行整排**右对齐**到内容区右缘。
     *
     * 上一版是"与主数字右缘对齐"，而主数字（那个独立的 48px 块）已经
     * 不存在了 —— 它变成了清点行里的第六项。所以参照物换成内容区本身。
     */
    const contentRight = host.getBoundingClientRect().right - 32
    ok('清点行右对齐到内容区右缘（差 ≤ 4px）',
        miniRight !== null && Math.abs(contentRight - miniRight) <= 4,
        \`内容区右=\${Math.round(contentRight)} 清点行右=\${miniRight === null ? 'missing' : Math.round(miniRight)}\`)

    /**
     * ★★★ 这一轮的**核心判据**：三段的左缘落在**同一条线**上。
     *
     * ## 为什么这几条最重要
     *
     * 上半部分改了七八轮都没解决"不对齐"，因为每一段是独立的 flex 行、
     * 各自决定从哪开始。真应用里量到四条互不重合的左缘
     * （头像 64 / 卡片 428 / 清点数 928 / h1 60）——
     * 块与块之间那些"奇怪的空白"就是这些线之间的残余。
     *
     * 这一轮改成 12 列栅格，那件事**可以被量出来**了：
     * 头像左缘 == 第一个清点项左缘 == 分身形象左缘。
     *
     * 容差 1px（不是 0）：亚像素渲染下 grid 列边界可能有 0.x 的差。
     */
    const leftOf = (el) =>
      el === null || el === undefined ? null : Math.round(el.getBoundingClientRect().left)
    const lefts = {
      头像: leftOf(avatar),
      清点首项: leftOf(firstStat),
      分身块: leftOf(card?.firstElementChild),
    }
    const leftValues = Object.values(lefts).filter((v) => v !== null)
    const leftSpread = leftValues.length < 2
      ? null
      : Math.max(...leftValues) - Math.min(...leftValues)
    ok('★ 三段左缘落在同一条线（头像 / 清点首项 / 分身块，差 ≤ 1px）',
        leftSpread !== null && leftSpread <= 1,
        JSON.stringify(lefts) + \` 极差=\${leftSpread}px\`)

    /**
     * ★★ 上下两段的**列边界**也要对上。
     *
     * 段 2 是六项各 2 列，段 3 是分身块 4 列 + 四个卡片各 2 列。
     * 所以段 2 的**第 3 项**（实体）左缘应等于段 3 的**第 1 个卡片**左缘
     * —— 都在第 5 列的起点。这一条锁的是"两段共用同一套列"，
     * 而不只是"各自内部均分"。
     */
    const thirdStat = statCells[2]
    const firstTile = tiles[0]
    const colMatch = leftOf(thirdStat) !== null && leftOf(firstTile) !== null
      ? Math.abs((leftOf(thirdStat) ?? 0) - (leftOf(firstTile) ?? 0))
      : null
    ok('★ 段 2 第 3 项与段 3 第 1 个卡片左缘对齐（同为第 5 列，差 ≤ 1px）',
        colMatch !== null && colMatch <= 1,
        \`清点第3项 x=\${leftOf(thirdStat)} 第1个卡片 x=\${leftOf(firstTile)} 差=\${colMatch}px\`)

    /**
     * ★ 右缘也要在一条线上：清点行最后一项 == 最后一个卡片。
     *
     * 左缘齐但右缘不齐仍然会读成"没对齐" —— 那说明两段的总宽不同。
     */
    const rightOf = (el) =>
      el === null || el === undefined ? null : Math.round(el.getBoundingClientRect().right)
    const lastTile = tiles[tiles.length - 1]
    const rightMatch = rightOf(lastStat) !== null && rightOf(lastTile) !== null
      ? Math.abs((rightOf(lastStat) ?? 0) - (rightOf(lastTile) ?? 0))
      : null
    ok('★ 清点行与卡片行右缘对齐（差 ≤ 1px）',
        rightMatch !== null && rightMatch <= 1,
        \`清点末项右=\${rightOf(lastStat)} 末卡片右=\${rightOf(lastTile)} 差=\${rightMatch}px\`)

    /**
     * ★★ greeting 与头像的**尺寸**判据（用户：「文字那么小包括头像」）。
     *
     * 判据取**实测像素**而不是 class 名 —— 上一版设了 body-base-500(15px)
     * 但换字号时更改类名也照样绿。用户抱怨的是**眼睛看到的大小**。
     *
     * · greeting 至少 22px（现在是 title-large-600 = 26px，余量 4px）；
     * · 头像至少 48px 宽（现在是 xl = 64px，余量 16px）。
     */
    const fsOf = (el) => (el === null || el === undefined ? null
      : Number.parseFloat(getComputedStyle(el).fontSize))
    const greetFs = fsOf(greetText)
    ok('greeting 字号足够大（≥ 22px）',
        greetFs !== null && greetFs >= 22, \`实测 \${greetFs}px\`)
    const avatarW = avatar === null || avatar === undefined ? null
      : Math.round(avatar.getBoundingClientRect().width)
    ok('头像足够大（≥ 48px 宽）',
        avatarW !== null && avatarW >= 48, \`实测 \${avatarW}px\`)

    // ★ 那两句废话不许回来
    ok('不再说「从你的聊天里读过的」', !T(host).includes('从你的聊天里读过'), '')
    ok('不再说「已能被搜到」（图里它与主数字是同一个数）',
        !T(host).includes('已能被搜到'), '')

    /**
     * ★★ 段间空档：**清点行底 → 分身顶** 应该有一段明显的留白。
     *
     * 这条口径换过两次：
     * · v1：读两层 parentElement 的 gap 属性 —— 脆（那是 shorthand
     *   row column，而且 parentElement 走到哪一层随布局变）；
     * · v2：量"主数字 y 与分身 y 的差" —— 而主数字那个块已经不存在了；
     * · v3（现在）：量**清点行底 → 分身顶**的真实距离。
     *
     * 这一轮删掉了它们之间那条 border-t 分割线（用户：「分割线可能
     * 也没有很有必要」），分段完全靠这段留白 —— 所以它必须够宽。
     * 期望 28px（--gap-section-xxxl），门限取 20 留余量。
     */
    const miniBottom = miniRow === undefined ? null : miniRow.getBoundingClientRect().bottom
    const personaTop = card === undefined ? null : card.getBoundingClientRect().top
    const segSpace = miniBottom === null || personaTop === null
      ? null
      : Math.round(personaTop - miniBottom)
    ok('清点行与分身之间留白够宽（> 20px，分段靠间距不靠线）',
        segSpace !== null && segSpace > 20,
        \`清点行底=\${miniBottom === null ? 'missing' : Math.round(miniBottom)} 分身顶=\${personaTop === null ? 'missing' : Math.round(personaTop)} 留白=\${segSpace}px\`)

    /**
     * ★★ 上半部分**没有分割线**（用户：「分割线可能也没有很有必要」）。
     *
     * 判据扫真实的**计算样式**：上半部分（分身卡之前）不该有任何元素
     * 画了 border-top。单测那条读源码字符串，这条量渲染结果 ——
     * 两者互补：源码里没写、但某个 class 组合意外带上 border 也会被抓到。
     */
    const withTopBorder = [...host.querySelectorAll('div, section')].filter((e) => {
      const w = getComputedStyle(e).borderTopWidth
      return w !== '' && Number.parseFloat(w) >= 0.5
    })
    ok('上半部分没有分割线（border-top）',
        withTopBorder.length === 0,
        \`命中 \${withTopBorder.length} 个带 border-top 的元素\`)

    /**
     * ★★ 分身与四个数在**同一行**（用户：「小小周和下面的待我确认、
     * 可自动回复等应该放在一行也完全可以吧」）。
     *
     * 判据是**两者的 y 差**，不是"有没有 border-t"：
     * 删掉那条线但布局仍然竖着，线的判据会绿而这一条会红 ——
     * 而后者才是用户要的东西。
     *
     * ★ 门限取 48px（≈ 数字块自身高度的一半）而不是 60：
     * 反证时把布局改回竖排量到 62px，只比 60 多 2px —— 那种"刚好越线"
     * 的门槛下一次改点内边距就会翻面。同一行时实测 43px，
     * 竖排时 62px，48 落在中间且离两者都有余量。
     */
    /**
     * \u5206\u8eab\u7684\u540d\u5b57\u90a3\u4e00\u884c \u2014\u2014 \u9760**\u6392\u7248\u7c7b**\u5b9a\u4f4d\uff08\u5b83\u662f\u8fd9\u4e00\u5757\u552f\u4e00\u7684 title \u53f7\uff09\u3002
     *
     * \u2605 \u4e0d\u7528\u4e2d\u6587\u5b57\u7b26\u6b63\u5219\u53bb\u731c\u540d\u5b57\uff1a\u540d\u5b57\u662f\u7528\u6237\u8d77\u7684\uff0c\u53ef\u80fd\u662f\u82f1\u6587\u3001\u53ef\u80fd\u5e26
     * 数字。第一版写了个只认 2-6 个汉字的判断，既脆（改个名字就找不到）
     * 又多了一处 lint 挑出来的无用转义。
     */
    const pName = card === undefined ? null
      : [...card.querySelectorAll('span')].find((e) => e.className.includes('typography-title'))
    const dy = pName === null || pName === undefined || tiles[0] === undefined
      ? null
      : Math.abs(Math.round(pName.getBoundingClientRect().y - tiles[0].getBoundingClientRect().y))
    ok('分身与四个数在同一行（y 差 < 48px）', dy !== null && dy < 48, \`y 差=\${dy}px\`)

    /**
     * ⑤ 左缘对齐 —— 换成量**问候语的 x 坐标**。
     *
     * 上一版量 outer.paddingLeft，前提是能拿到内容区那一层。
     * 探针挂载的 host 是游离 fixed，读不到应用的真实 padding。
     * 但问候语的 x 应该就是内容区的左缘 —— 直接量它。
     *
     * 页头 h1 也是同一条线（app-header.tsx 的 pl-6），这条会在
     * 真应用里对齐；探针挂载的 host 从 left:0 起，问候语 x 就是 padding。
     */
    const greetX = xOf(greetText)
    ok('问候语左缘 = 32px（内容区 padding-left）',
        greetX === 32, \`实测 \${greetX}px\`)

    return JSON.stringify({ checks }, null, 1)
  })()
`)

await evaluate(
  `globalThis.__probeRoot?.unmount(); document.getElementById('__probe_dashboard')?.remove(); 1`,
)

const { checks } = JSON.parse(probe)
let bad = 0
for (const c of checks) {
  if (!c.pass) bad += 1
  console.log(`${c.pass ? "✓" : "✗"} ${c.name}${c.detail === "" ? "" : `  —— ${c.detail}`}`)
}
console.log(`\n${checks.length - bad}/${checks.length} 通过`)
socket.close()
process.exit(bad === 0 ? 0 : 1)
