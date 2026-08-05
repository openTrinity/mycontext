#!/usr/bin/env node
/**
 * 通过 CDP 读运行中的应用里**数字人页面真的渲染出了什么**。
 *
 * 为什么需要它：单测能证明"给定 props 时组件行为对"，但证明不了
 * 这一页在真实应用里**装得起来** —— 少一个 i18n key、queries 里
 * 拼错一个 IPC 方法名、leaf 组件之间 props 名不一致，
 * 这些都在真渲染时才炸，而炸的形态是一片空白（不是报错弹窗）。
 *
 * 只读：点侧栏、读文本，不改任何数据。
 *
 * 用法：先带 --remote-debugging-port=<port> 起应用，再跑本脚本。
 */
const PORT = process.argv[2] ?? "9334"

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === "page")
if (!page) throw new Error("未找到渲染进程页面，应用是否已启动？")

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

try {
  /**
   * 侧栏可能是收起的（用户上次收起了，或刚重载）—— 那时导航项根本不在 DOM 里。
   * 不先展开的话这个脚本会报"找不到入口"，而那是**脚本自己的**问题，
   * 不是页面的问题。
   */
  await evaluate(`(() => {
    const toggle = [...document.querySelectorAll("button")]
      .find((n) => (n.getAttribute("aria-label") ?? "").includes("展开侧边栏"))
    if (toggle) toggle.click()
    return true
  })()`)
  await sleep(1200)

  // 点侧栏里的"数字人"（用文本找，不依赖 test id）
  const clicked = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll("button, a")]
    const hit = nodes.find((n) => (n.textContent ?? "").includes("数字人"))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  if (clicked !== true) throw new Error("侧栏里没找到「数字人」入口")
  await sleep(2500)

  const view = await evaluate(`(() => {
    const text = document.body.innerText
    /**
     * ★ 横向溢出检测。
     *
     * 这一段是**单测证明不了**的那部分：jsdom 没有布局引擎，
     * scrollWidth/clientWidth 恒为 0。只有在真浏览器里量才有意义。
     *
     * 找的是消息流那个滚动容器（有 overflow-y-auto 且里面有 li 的那个）。
     * 溢出 1px 也算 —— 一旦 scrollWidth > clientWidth，
     * 用户就能横向拖动这一栏，而这一页永远不该横向滚动。
     */
    const scrollers = [...document.querySelectorAll("div")].filter((n) => {
      const style = getComputedStyle(n)
      return (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        n.querySelector("li") !== null
      )
    })
    const overflow = scrollers.map((n) => ({
      scrollWidth: n.scrollWidth,
      clientWidth: n.clientWidth,
      overflowX: getComputedStyle(n).overflowX,
      // 超出的量：>0 就是 bug
      overBy: n.scrollWidth - n.clientWidth,
    }))
    /**
     * ★ 还要单独量**内容有没有被裁掉**。
     *
     * overflow-x-hidden 只是把溢出**藏起来**，并不让内容换行 ——
     * 实测（真浏览器，逐字复刻的类链）：正文仍是 12066px 宽、
     * scrollWidth 仍超出 11722px，只是那 11712px **看不见**了，
     * 而正文高度从换行后的 1248px 塌回 72px（三行）—— 也就是说
     * 用户永远读不到那段文字。这比横向滚动条更糟：滚动条至少是可见的。
     *
     * 所以判据是两条：容器不横向滚动**且**没有后代越过容器右边缘。
     *
     * ⚠️ 必须量**所有后代**，不能只量气泡（li div.group）：
     * 溢出发生在气泡**里面**那个正文 span 上，而气泡自己有
     * max-w-[min(560px,72%)] 兜着 —— 只量气泡会得到 0，
     * 也就是一个永远绿的假门禁（实测：量所有后代 11722px，只量气泡 0px）。
     *
     * ⚠️ 这段在模板串里，**不能出现反引号** —— 那会提前终止模板串
     * （犯过一次：node --check 报的是 "missing ) after argument list"，
     * 而真正的原因在几十行之前的一个反引号里）。
     */
    const overhang = scrollers.map((n) => {
      const pb = n.getBoundingClientRect()
      return [...n.querySelectorAll("*")]
        .map((e) => Math.round(e.getBoundingClientRect().right - pb.right))
        .reduce((max, v) => (v > max ? v : max), 0)
    })
    const widest = overhang.reduce((max, v) => (v > max ? v : max), 0)
    return {
      // 未翻译的 key 会原样出现（reasons.xxx / persona.xxx）
      rawKeys: [...text.matchAll(/\\b(?:reasons|drops|decisions|reasonKind)\\.[a-z_.]+/g)].map((m) => m[0]),
      placeholders: [...text.matchAll(/\\{\\{\\w+\\}\\}/g)].map((m) => m[0]),
      // 三栏各自的标志性文案
      hasRail: /会话 \\d+/.test(text),
      hasControls: text.includes("回复方式") || text.includes("触发条件"),
      hasDrafts: text.includes("待审草稿") || text.includes("草稿"),
      hasActivity: text.includes("处理结果"),
      // ★ 本次新增的两块信息：渠道标识与草稿署名
      hasChannel: text.includes("钉钉"),
      hasSignature: /起草/.test(text),
      overflow,
      widestOverhang: widest,
      length: text.length,
      excerpt: text.slice(0, 700),
    }
  })()`)

  console.log("=== 数字人页面实渲染 ===")
  console.log(`正文长度 ${view.length}`)
  console.log(
    `左栏 ${view.hasRail} · 回复方式 ${view.hasControls} · 草稿 ${view.hasDrafts} · 处理结果 ${view.hasActivity}`,
  )
  console.log(`未翻译 key：${view.rawKeys.length === 0 ? "无" : view.rawKeys.join(", ")}`)
  console.log(
    `未替换占位符：${view.placeholders.length === 0 ? "无" : view.placeholders.join(", ")}`,
  )
  console.log(`渠道标识 ${view.hasChannel} · 草稿署名 ${view.hasSignature}`)
  console.log("--- 消息流横向溢出 ---")
  for (const box of view.overflow) {
    console.log(
      `  scrollWidth ${box.scrollWidth} / clientWidth ${box.clientWidth} ` +
        `(超出 ${box.overBy}px, overflow-x: ${box.overflowX})`,
    )
  }
  console.log(`  最宽内容超出容器右边缘：${view.widestOverhang}px`)
  console.log("--- 摘录 ---")
  console.log(view.excerpt)

  const bad = []
  if (view.length < 200) bad.push("页面几乎是空的（组件没装起来）")
  if (view.rawKeys.length > 0) bad.push(`有未翻译的 key：${view.rawKeys.join(", ")}`)
  if (view.placeholders.length > 0) bad.push(`有未替换的占位符：${view.placeholders.join(", ")}`)
  if (!view.hasRail) bad.push("左栏没渲染")
  if (!view.hasDrafts) bad.push("草稿栏没渲染")
  if (!view.hasActivity) bad.push("处理结果没渲染")
  if (!view.hasChannel) bad.push("看不出这是哪个渠道（渠道标识没渲染）")

  /**
   * ★ 消息流不该横向滚动。
   *
   * 成因是超长不可断内容（实测钉钉分享链接 1568 字符无空格）撑破气泡。
   * 而本人消息是 flex-row-reverse，那里的溢出方向是**反的** ——
   * 于是横向滑动的手感与其余消息相反，这是用户报的形态。
   */
  if (view.overflow.length === 0) {
    bad.push("没找到消息流滚动容器（选中的会话可能没有消息 —— 这一条没验到）")
  }
  for (const box of view.overflow) {
    if (box.overBy > 0) bad.push(`消息流横向溢出 ${box.overBy}px（气泡被超长内容撑破）`)
  }
  /**
   * 容器可以用 overflow-x-hidden 把溢出藏起来，但那时**内容被裁掉**
   * 而不是换行 —— 实测正文高度会从 1248px 塌回 72px，用户读不到那段字。
   * 留 1px 容差给亚像素舍入。
   */
  if (view.widestOverhang > 1) {
    bad.push(`有内容越过容器右边缘 ${view.widestOverhang}px（被裁掉了，不是换行）`)
  }

  if (bad.length > 0) {
    console.error("\n✗ " + bad.join("；"))
    process.exitCode = 1
  } else {
    console.log(
      "\n✓ 数字人页面在真实应用里装起来了（三栏齐全、无未翻译 key、渠道标识在、消息流不横向滚动）",
    )
  }
} finally {
  socket.close()
}
