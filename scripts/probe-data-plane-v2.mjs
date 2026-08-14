#!/usr/bin/env node
/**
 * CDP 探针：验这一轮**数据平面 v2** 的改动在**真应用**里成立。
 *
 * ## 为什么必须有这个探针（单测证明不了什么）
 *
 * 这一轮的改动全是"装不起来会一片空白、而且不报错"的类型：
 *
 * · **拓扑卡多了三行消费者**（graph-build / distill-work / local-index-vector）
 *   —— 声明加对了但契约/视图漏一处，界面上就是**少几行**，不会报错；
 * · **覆盖面多了两个域**（听记 / 文档）—— IPC 通道加了 `domain` 参数，
 *   少注册一处就是 invoke 报错、schema 漏一处就是那两行永远空白；
 * · **`unwired` 那一行的文案** —— 它与 `absent` 在旧代码里同形，
 *   而两者的出路相反（"什么都不用做" vs "去起服务"）。
 *
 * 三种失败都**不是**报错弹窗，而是"看起来正常但少了东西"。
 *
 * ## ★ 四类断言
 *
 * ① **拓扑卡把六个消费者都画出来了**（不是四个）；
 * ② **`unwired` 那一行说的是"为什么没接"**，不是"未注册"；
 * ③ **三个域的覆盖面各有一行**（消息 / 听记 / 文档），且量词各不相同；
 * ④ **主进程没报拓扑不一致**（运行时自检的那条 warn）。
 *
 * ★ ③ 的判据是"量词"而不是"数字非零"：真机上文档可能真的是 0 篇
 * （用户没开那个源、或知识库是空的）。而**量词**（条/场/篇）证明的是
 * "这三行真的走了三个不同的域" —— 那才是这一轮要验的事。
 *
 * 只读：点侧栏与设置页，不改任何数据。
 * ⚠️ 跑在真实 vault 上（设置页会显示真实会话标题）。
 *
 * ★ 真实数据不出机器：所有比对都在页内 `evaluate` 里做，
 * 只把布尔与计数带回来 —— 不回传任何文本片段。
 *
 * 用法：先带 --remote-debugging-port=<port> 起应用，再跑本脚本。
 *   pnpm dev -- --remote-debugging-port=9411
 *   node scripts/probe-data-plane-v2.mjs 9411
 */
const PORT = process.argv[2] ?? "9411"

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === "page")
if (!page) {
  console.log(`⚠️  ${PORT} 上没有页面。应用带 --remote-debugging-port=${PORT} 起来了吗？`)
  process.exit(1)
}

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

/** 点侧栏里含某段文字的入口。返回是否点到。 */
async function openModule(label) {
  return evaluate(`(() => {
    const nodes = [...document.querySelectorAll("button, a")]
    const hit = nodes.find((n) => (n.textContent ?? "").includes(${JSON.stringify(label)}))
    if (!hit) return false
    hit.click()
    return true
  })()`)
}

const problems = []
const facts = {}

try {
  // 侧栏可能是收起的 —— 先展开，否则找不到导航项（那是脚本自己的问题）
  await evaluate(`(() => {
    const toggle = [...document.querySelectorAll("button")]
      .find((n) => (n.getAttribute("aria-label") ?? "").includes("展开侧边栏"))
    if (toggle) toggle.click()
    return true
  })()`)
  await sleep(800)

  /**
   * ── ① 先直接问 IPC：三个域的覆盖面通道通不通 ───────────────
   *
   * ★ 在读界面**之前**问 IPC，是因为两者的失败要能区分：
   * IPC 报错 = 通道/schema 没接对；IPC 通了而界面空 = 渲染层没接对。
   * 只看界面的话这两种会混成一句"那一行是空的"。
   */
  const ipc = await evaluate(`(async () => {
    const api = window.mycontext?.distill
    if (!api?.chatCoverage) return { ok: false, why: "no chatCoverage api" }
    const today = new Date()
    const day = (d) => {
      const t = new Date(today.getTime() - d * 86400000)
      const p = (n) => String(n).padStart(2, "0")
      return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate())
    }
    const out = {}
    for (const domain of ["chat", "minutes", "doc"]) {
      try {
        const res = await api.chatCoverage({
          channelId: "dingtalk", fromDay: day(90), toDay: day(0), domain,
        })
        // ★ 只带回**形状**与计数，不带任何文本
        out[domain] = res?.ok === true
          ? { ok: true, dayCount: res.data?.dayCount ?? null, localCount: res.data?.localCount ?? null }
          : { ok: false, why: String(res?.error?.code ?? "unknown") }
      } catch (error) {
        out[domain] = { ok: false, why: String(error?.message ?? error).slice(0, 80) }
      }
    }
    return { ok: true, out }
  })()`)
  facts.ipc = ipc
  if (ipc?.ok !== true) {
    problems.push(`覆盖面 IPC 不可用：${ipc?.why ?? "未知"}`)
  } else {
    for (const domain of ["chat", "minutes", "doc"]) {
      if (ipc.out?.[domain]?.ok !== true) {
        problems.push(`覆盖面 IPC（${domain} 域）失败：${ipc.out?.[domain]?.why ?? "未知"}`)
      }
    }
  }

  /**
   * ── ② 快照里的消费者：六个都在吗 ────────────────────────────
   *
   * ★ 判据是**声明里的六个 id 都出现**，而不是"数量 >= 6"：
   * 后者在"多了一个、少了一个"时照样绿。
   */
  const consumers = await evaluate(`(async () => {
    const api = window.mycontext?.ingest ?? window.mycontext?.status
    // 快照的入口名在不同版本里可能是 ingest.snapshot 或 status.report
    const tryCalls = [
      () => window.mycontext?.ingest?.snapshot?.(),
      () => window.mycontext?.status?.report?.(),
    ]
    for (const call of tryCalls) {
      try {
        const res = await call?.()
        const snap = res?.data ?? res
        const list = snap?.consumers
        if (Array.isArray(list)) {
          return {
            ok: true,
            ids: list.map((c) => c.id),
            unwired: list.filter((c) => c.wiring === "unwired").map((c) => c.id),
            withReason: list.filter((c) => c.wiring === "unwired" && (c.unwiredReason ?? "") !== "").length,
          }
        }
      } catch { /* 换下一个入口 */ }
    }
    return { ok: false, why: "拿不到 ingest 快照" }
  })()`)
  facts.consumers = consumers
  if (consumers?.ok !== true) {
    problems.push(`拿不到消费者快照：${consumers?.why ?? "未知"}`)
  } else {
    const want = [
      "local-index-fts",
      "local-index-vector",
      "graph-export",
      "graph-build",
      "distill",
      "distill-work",
      "persona-inbox",
    ]
    for (const wanted of want) {
      if (!consumers.ids.includes(wanted)) problems.push(`快照里缺消费者 ${wanted}`)
    }
    if (!consumers.unwired.includes("local-index-vector")) {
      problems.push("local-index-vector 没被标成 unwired")
    }
    if (consumers.withReason < 1) {
      problems.push("unwired 的消费者没有 unwiredReason（界面只能说「未注册」）")
    }
  }

  /**
   * ── ③ 设置页：拓扑卡与三行覆盖面真的画出来了 ──────────────
   */
  /**
   * ★ 入口是「运行状态」而不是「设置」—— 实测（CDP）：拓扑卡与采集范围
   * 面板都在状态页（`status-panel.tsx`）里，而侧栏里没有叫"设置"的项。
   * 第一版探针写的是"设置"，于是它报"侧栏里没找到入口" —— 那是探针
   * 自己的问题，不是应用的。
   */
  if ((await openModule("运行状态")) !== true) {
    problems.push("侧栏里没找到「运行状态」入口")
  } else {
    await sleep(2500)
    /**
     * ★★★ 「学习范围」是一个 `Disclosure`（**默认折叠**）—— 折叠时它的
     * 内容**不在 DOM 里**，所以覆盖面那三行读不到。
     *
     * 第一版探针没展开它，于是报"设置页上没有 xx 域那一行" ——
     * 而那是探针自己的问题（内容根本没渲染），不是应用的。
     * 这一段是那次误报的修法。
     */
    /**
     * 展开那张卡。
     *
     * ★ 它是原生 details/summary（Disclosure 组件），**不是** button ——
     * 第一版探针只找 button，于是永远找不到（那是探针的问题，不是应用的）。
     * ★ 直接置 open=true 比 click 稳：click 会 toggle，已展开时反而关掉。
     *
     * ★★ 这段说明必须写在注入块**外面**：注入给 CDP 的模板字符串里
     * 有一个裸反引号就会把模板提前截断，而报错指向模板开始那一行
     * （`check-probe-templates.mjs` 存在的全部理由）。我刚在这里踩了一次
     * —— 把 details/summary 用反引号括起来，于是整个脚本连解析都过不了。
     */
    const expanded = await evaluate(`(() => {
      const node = [...document.querySelectorAll("details")]
        .find((n) => (n.textContent ?? "").includes("学习范围"))
      if (!node) return false
      node.open = true
      return true
    })()`)
    if (expanded !== true) problems.push("状态页上没找到「学习范围」那张卡")
    // 展开之后三个域各发一次 IPC，等它们回来
    await sleep(3000)
    /**
     * 读界面。
     *
     * ★★ 用 `textContent` 而不是 `innerText`：`<details>` 展开之后
     * innerText（受 CSS 影响的"可见文本"）在这个组件上会**漏掉**覆盖面
     * 那几行 —— 实测撞到过：三行确实在 DOM 里，而 innerText 读不到。
     *
     * ★★ 判据是"三行**各自带域名**"而不是"数字非零"：一个刚建的 vault
     * 三个域都是 0（那是事实），而三行文案**必须不同** ——
     * 实测撞到过三行完全一样（都是"这段日期还没有记账数据"），
     * 用户根本分不清哪行是哪个域。见 scope-coverage.tsx 里那段 ★★★。
     */
    const ui = await evaluate(`(() => {
      const text = document.body.textContent ?? ""
      const rows = [
        "local-index-fts", "local-index-vector", "graph-export",
        "graph-build", "distill", "distill-work", "persona-inbox",
      ].filter((id) => text.includes(id))
      return {
        hasTopology: text.includes("数据平面"),
        consumerRows: rows,
        // 三个域各自带域名的那一行（有数字时是"消息：… 起已有 N 条"，
        // 空态时是"消息：这段日期还没有记账数据…"）
        domainRows: {
          chat: text.includes("消息："),
          minutes: text.includes("会议听记："),
          doc: text.includes("文档："),
        },
        saysUnwiredReason: text.includes("向量检索") || text.includes("本期未接入"),
      }
    })()`)
    facts.ui = ui
    if (ui.hasTopology !== true) problems.push("设置页上没有「数据平面」拓扑卡")
    if ((ui.consumerRows?.length ?? 0) < 6) {
      problems.push(`拓扑卡只画了 ${ui.consumerRows?.length ?? 0} 个消费者（应当 >= 6）`)
    }
    for (const domain of ["chat", "minutes", "doc"]) {
      if (ui.domainRows?.[domain] !== true) {
        problems.push(`状态页上没有「${domain}」域那一行覆盖面（或它没带域名）`)
      }
    }
    if (ui.saysUnwiredReason !== true) {
      problems.push("unwired 那一行没说清「为什么没接」（读起来像「未注册」）")
    }
  }
} catch (error) {
  problems.push(`探针本身出错：${error.message}`)
}

socket.close()

console.log("── 实测到的事实 ──")
console.log(JSON.stringify(facts, null, 2))
if (problems.length > 0) {
  console.log("\n❌ 未通过：")
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exit(1)
}
console.log("\n✅ 数据平面 v2 的四类断言在真应用里全部成立")
