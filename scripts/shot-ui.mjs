#!/usr/bin/env node
/**
 * 一次性：给每个模块拍一张图，供**人眼**判断版式。
 *
 * 校验器只查颜色与类名，查不出"这一屏看起来乱" —— 标签碰撞、层次缺失、
 * 留白不均、一堆同字号的灰盒子，都只能看。
 *
 * ⚠️ 截图里有真实人名 —— 存到 /tmp，不进仓库。
 */
import { writeFileSync } from "node:fs"

const PORT = process.argv[2] ?? "9388"
const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === "page")
if (!page) throw new Error("未找到渲染进程页面")

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
  return r.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shoot(name) {
  await sleep(1200)
  const { data } = await send("Page.captureScreenshot", { format: "png" })
  writeFileSync(`/tmp/ui-${name}.png`, Buffer.from(data, "base64"))
  console.log(`  → /tmp/ui-${name}.png`)
}

/** 点侧栏某个模块。返回是否点到了。 */
async function openModule(label) {
  return evaluate(`(() => {
    const hit = [...document.querySelectorAll('button,a,[role=button]')]
      .find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)})
    if (!hit) return false
    hit.click()
    return true
  })()`)
}

await send("Page.enable")
await send("Runtime.enable")

console.log("当前页面：", await evaluate("document.title"))
console.log("侧栏可点项：")
const nav = await evaluate(`[...document.querySelectorAll('button,a,[role=button]')]
  .map((n) => (n.textContent || '').trim()).filter((s) => s && s.length < 12).slice(0, 24)`)
console.log(" ", JSON.stringify(nav))

await shoot("00-current")

for (const label of process.argv.slice(3)) {
  const ok = await openModule(label)
  console.log(`${label}: ${ok ? "点到了" : "没找到"}`)
  if (ok) await shoot(label)
}

socket.close()
