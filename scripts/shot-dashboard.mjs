#!/usr/bin/env node
/**
 * 一次性：给仪表盘拍浅色/暗色各一张，供人眼自查（dataviz 第 7 步）。
 *
 * 校验器只查颜色，不查版式 —— 标签碰撞、换行、溢出、滚动位置只能看。
 *
 * 用法：先带 --remote-debugging-port=<port> 起应用，再 `node scripts/shot-dashboard.mjs`
 * ⚠️ 截图里有真实人名 —— 存到 /tmp，不进仓库。
 */
import { writeFileSync } from "node:fs"

const PORT = process.argv[2] ?? "9334"
const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === "page")
if (!page) throw new Error("未找到渲染进程页面")

const { WebSocket } = await import("ws").catch(() => ({ WebSocket: globalThis.WebSocket }))
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true })
  socket.addEventListener("error", reject, { once: true })
})

let id = 0
function send(method, params = {}) {
  const messageId = (id += 1)
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== messageId) return
      socket.removeEventListener("message", onMessage)
      if (message.error) return reject(new Error(JSON.stringify(message.error)))
      resolve(message.result)
    }
    socket.addEventListener("message", onMessage)
    socket.send(JSON.stringify({ id: messageId, method, params }))
  })
}
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.subtype === "error") throw new Error(r.result.description)
  return r.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await evaluate(`(() => {
    const nodes = [...document.querySelectorAll("button, a")]
    const hit = nodes.find((n) => (n.textContent ?? "").includes("仪表盘"))
    if (hit) hit.click()
    return true
  })()`)
  await sleep(3000)

  /**
   * ★ 先复位到"干净"状态再拍。
   *
   * 探针跑完会留下：一个选中的实体（联动带处于状态态）+ 一个悬浮浮层
   * （点节点弹出来的那个）。拿那个状态自查会看错两件事 ——
   * 以为提示句不见了、以为图上永远糊着一个浮层。
   *
   * 浮层用 Escape 收（组件监听的是键盘），不是点空白：`mousedown`
   * 打在 body 上不冒泡到它的 outside-click 判定里。
   */
  await evaluate(`(() => {
    const clear = [...document.querySelectorAll('[role="status"] button')]
      .find((n) => (n.textContent ?? "").trim() === "看全部")
    if (clear) clear.click()
    return true
  })()`)
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  })
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  })
  await sleep(1500)

  for (const mode of ["light", "dark"]) {
    /**
     * 主题切换：这个应用把 mode 写在 <html> 的 class 上（Tailwind v4 的
     * dark: 变体靠它）。直接改 class 而不去点设置里的开关 —— 那个开关
     * 会写库，而探针必须只读。
     */
    await evaluate(`(() => {
      const root = document.documentElement
      root.classList.remove("light", "dark")
      root.classList.add(${JSON.stringify(mode)})
      root.dataset.theme = ${JSON.stringify(mode)}
      return root.className
    })()`)
    await sleep(1200)

    /**
     * ① 顶部：身份条不换行、主数字与指标卡的层次。
     *
     * ★ 滚动容器不是 document —— 这一页的滚动落在
     * `div.min-h-0.flex-1.overflow-auto` 上（实测 scrollHeight 2976 /
     * clientHeight 752）。写 `document.scrollingElement.scrollTop = 0`
     * 完全没有效果，而那时截出来的是一张**中间**的图，
     * 看起来像"身份条根本没渲染"。
     */
    await evaluate(`(() => {
      const sc = [...document.querySelectorAll("div")].find(
        (n) => n.scrollHeight > n.clientHeight + 50 && n.clientHeight > 200,
      )
      if (sc) sc.scrollTop = 0
      return sc?.scrollTop ?? -1
    })()`)
    await sleep(900)
    const top = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(`/tmp/dashboard-${mode}-top.png`, Buffer.from(top.data, "base64"))
    console.log(`${mode} 顶部 → /tmp/dashboard-${mode}-top.png`)

    // ② 联动带那一段：图 → 带 → 事实列表三者的位置关系读不读得出
    await evaluate(`(() => {
      const hint = [...document.querySelectorAll("p")]
        .find((n) => (n.textContent ?? "").includes("点图上任意一个点"))
      const band = hint ?? document.querySelector('[role="status"]')
      band?.scrollIntoView({ block: "center" })
      return band !== null && band !== undefined
    })()`)
    await sleep(900)
    const mid = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(`/tmp/dashboard-${mode}-bridge.png`, Buffer.from(mid.data, "base64"))
    console.log(`${mode} 联动带 → /tmp/dashboard-${mode}-bridge.png`)
  }
} finally {
  socket.close()
}
