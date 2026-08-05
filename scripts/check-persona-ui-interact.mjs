#!/usr/bin/env node
/**
 * CDP 交互探针：在**运行中的应用**里点一遍数字人页面的新控件。
 *
 * ## 为什么单测不够
 *
 * 单测给组件喂 props，证明"给定输入行为对"。它证明不了：
 * · 容器传给 leaf 的 props 名字对不对（拼错就是那个功能悄悄不工作）；
 * · 「看引用」交出去的 id 到不到得了中栏（两个组件之间的那条线）；
 * · 编辑框在快照推送（每几秒一次）之下会不会被重置。
 *
 * 这三件都只在真应用里才暴露，而暴露的形态是"点了没反应"——
 * 没有报错、没有日志。
 *
 * ## 只读
 *
 * 不点「标记已发」也不点「丢弃」——那会改库。只点编辑/看引用/筛选，
 * 全是纯前端状态。
 */
const PORT = process.argv[2] ?? "9335"

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

/** 按文本点一个按钮。返回是否点到了。 */
const clickByText = (text) => `(() => {
  const nodes = [...document.querySelectorAll("button")]
  const hit = nodes.find((n) => (n.textContent ?? "").trim() === ${JSON.stringify(text)})
  if (!hit) return false
  hit.click()
  return true
})()`

try {
  // 侧栏可能是收起的（导航项那时不在 DOM 里）——先展开
  await evaluate(`(() => {
    const toggle = [...document.querySelectorAll("button")]
      .find((n) => (n.getAttribute("aria-label") ?? "").includes("展开侧边栏"))
    if (toggle) toggle.click()
    return true
  })()`)
  await sleep(1200)

  // 进数字人页
  await evaluate(`(() => {
    const hit = [...document.querySelectorAll("button, a")]
      .find((n) => (n.textContent ?? "").trim() === "数字人")
    if (hit) hit.click()
    return true
  })()`)
  await sleep(2500)

  const results = {}

  /**
   * ① 选中**有草稿**的那个会话。
   *
   * 直接点第一行不行：默认排序把有草稿的排在前，但左栏可能被
   * 「只看待处理」筛过。按草稿徽标（"N 待审"）找才是稳的 ——
   * 而这个探针要验的编辑/引用都得先有一条草稿。
   */
  const picked = await evaluate(`(() => {
    const rows = [...document.querySelectorAll("aside ul li button")]
    const withDraft = rows.find((r) => /\\d+ 待审/.test(r.textContent ?? ""))
    const target = withDraft ?? rows[0]
    if (!target) return false
    target.click()
    return withDraft !== undefined ? "withDraft" : "first"
  })()`)
  results.pickedConversation = picked
  await sleep(1800)

  // ② 编辑草稿：点「编辑」→ 出现 textarea → 改内容 → 按钮文案变
  results.editOpened = await evaluate(clickByText("编辑"))
  await sleep(600)
  results.textareaAppeared = await evaluate(`document.querySelectorAll("textarea").length > 0`)
  if (results.textareaAppeared) {
    await evaluate(`(() => {
      const area = document.querySelector("textarea")
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, "value",
      ).set
      setter.call(area, "【UI 探针】改过的正文")
      area.dispatchEvent(new Event("input", { bubbles: true }))
      return true
    })()`)
    await sleep(600)
    // 改过之后按钮文案必须变 —— 否则用户不知道发出去的是哪一版
    results.buttonLabelChanged = await evaluate(
      `document.body.innerText.includes("发送（用编辑后的）")`,
    )
    /**
     * ★ 编辑态要活过一次快照推送。
     *
     * 这一页每几秒收一次 `onSnapshot` 并 invalidate 三个 query。
     * 编辑态如果提到了父组件，那次重渲染会把输入框清空 ——
     * 而用户正在打字。等 6 秒（至少一次 tick）再看内容还在不在。
     */
    await sleep(6500)
    results.editSurvivedRefetch = await evaluate(
      `(document.querySelector("textarea")?.value ?? "").includes("UI 探针")`,
    )
    // 退出编辑态（不保存 —— 不点「标记已发」，库不受影响）
    await evaluate(clickByText("完成"))
  }

  // ③ 「看引用」：点了之后中栏应当出现高亮底色
  await sleep(500)
  const citationButton = await evaluate(`(() => {
    const hit = [...document.querySelectorAll("button")]
      .find((n) => /^看引用 \\d+$/.test((n.textContent ?? "").trim()))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  results.citationClicked = citationButton
  if (citationButton) {
    await sleep(1200)
    results.citationHighlighted = await evaluate(
      `document.querySelectorAll("[class*='status-fill-warning-container']").length > 0`,
    )
  }

  /**
   * ④ ★ 本地图片**真的加载得出来**。
   *
   * 这一条是单测**结构上验不了**的：单测只能断言 `<img src>` 这个字符串，
   * 而"这个 URL 在 Electron 里能不能加载"取决于 Chromium 的同源策略与
   * 协议注册 —— 只有真应用能回答。
   *
   * 踩过的坑：src 写的是 `file:///…/avatars/x.jpg`，单测断言那个串通过，
   * 而实测 23 个头像下载成功、界面上 img 数量是 **0** ——
   * 因为从 `http://localhost:5273` 加载 `file://` 被直接拦掉，
   * 且 `<img onerror>` 静默回退到首字母兜底。
   *
   * 判据用 `naturalWidth > 0`：`complete` 在**失败**时也是 true
   * （加载结束了，只是结果是错误），用它会让这条断言恒绿。
   */
  await sleep(1500)
  /**
   * ★ 先问**后端有没有头像**，再看界面上有几张。
   *
   * 只数 DOM 里的 img 是不够的：`Avatar` 在加载失败时会把 `<img>`
   * **整个换成**首字母色块（那是刻意的降级），于是 `imageCount` 变成 0
   * —— 而 0 与"这一屏本来就没有头像"完全一样。
   *
   * 第一次写这条探针时就栽在这里：把 URL 改回 `file://`（那是坏的），
   * 探针报"这一屏没有本地图片，那一条没验到" —— 恒绿。
   *
   * 所以判据是**两个数的关系**：后端说有 N 个头像，界面上就该有
   * N 张解码成功的图。
   *
   * ## ★ 为什么这里要**自己切到一个群聊**
   *
   * 头像只在群聊里取（单聊要先搜共同群，收益不抵开销 —— 见
   * `message-thread.tsx`）。而上面第 ① 步挑的是"草稿最多"的那个会话，
   * 它是单聊还是群聊**纯看运气**。
   *
   * 踩到过：那次挑中一个单聊，于是这条断言直接跳过，报
   * 「这个会话后端也没有头像，那一条没验到」—— 而它前一次是绿的，
   * 两次输出看起来都像通过。也就是说这条最贵的断言（唯一能验
   * `mycontext-file://` 真的可加载）有一半的时间根本没跑。
   *
   * 所以现在显式找一个**群聊**并点进去。找不到群聊才算"没验到"，
   * 那时输出会说清楚是哪一种。
   */
  /**
   * 查群 + 点击**分两次** evaluate。
   *
   * 合在一个 `async` IIFE 里时 CDP 报 `Promise was collected`：
   * 点击触发 React 重渲染，而那个还没 resolve 的 promise 正好在这中间
   * 被回收掉。查询（异步）与点击（同步）拆开就没有这个窗口。
   */
  const groupTitle = await evaluate(`(async () => {
    const convs = await window.mycontext.persona.conversations()
    const groups = (convs.data ?? []).filter((c) => c.kind === "group")
    if (groups.length === 0) return null
    // 消息多的群更可能有多个发送者 → 更可能有头像
    const best = groups.slice().sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0))[0]
    return best.title ?? null
  })()`)
  if (groupTitle === null) {
    results.groupSwitched = "没有群聊"
  } else {
    results.groupSwitched = String(
      await evaluate(`(() => {
        const rows = [...document.querySelectorAll("aside ul li button")]
        const hit = rows.find((r) => (r.textContent ?? "").includes(${JSON.stringify(groupTitle)}))
        if (!hit) return false
        hit.click()
        return true
      })()`),
    )
    // 切了会话要等消息 + 头像两趟查询回来
    await sleep(6000)
  }

  const expected = await evaluate(`(async () => {
    const convs = await window.mycontext.persona.conversations()
    const list = convs.data ?? []
    const groups = list.filter((c) => c.kind === "group")
    if (groups.length === 0) return { senders: 0, cached: 0, reason: "no_group" }
    const best = groups.slice().sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0))[0]
    const msgs = await window.mycontext.persona.messages({
      conversationId: best.conversationId,
      limit: 80,
    })
    const ids = [
      ...new Set(
        (msgs.data ?? [])
          .filter((m) => m.isSelf !== true && m.senderExternalId)
          .map((m) => m.senderExternalId),
      ),
    ]
    const res = await window.mycontext.media.avatars({
      externalIds: ids,
      groupExternalId: best.externalId,
    })
    return { senders: ids.length, cached: (res.data ?? []).filter((x) => x.path).length }
  })()`)
  results.avatarsAvailable = expected.cached

  /**
   * ★ 等图片**真的解码完**再数，而不是固定 sleep。
   *
   * 切会话之后有两趟异步：拉消息、拉头像（后者每人 2-3 次 CLI 调用）。
   * 固定等一段时间的话，慢一点就数到 0 —— 而"0 张"与"URL 加载不了"
   * 在输出上一模一样，于是这条最贵的断言会**假红**（实测踩到：
   * 后端 22 个头像、界面 59 张图都好着，探针报 0）。
   *
   * 轮询到"有 img 且都解码了"为止，最多等 15 秒。超时才算真的没有。
   */
  for (let round = 0; round < 30; round += 1) {
    const ready = await evaluate(`(() => {
      const imgs = [...document.querySelectorAll("li img")]
      return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0)
    })()`)
    if (ready === true) break
    await sleep(500)
  }

  const imageProbe = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll("li img")]
    return {
      count: imgs.length,
      // naturalWidth > 0 才是"真的解码出了像素"（complete 在失败时也是 true）
      decoded: imgs.filter((i) => i.naturalWidth > 0).length,
      schemes: [...new Set(imgs.map((i) => (i.getAttribute("src") ?? "").split(":")[0]))],
    }
  })()`)
  results.imageCount = imageProbe.count
  results.imageDecoded = imageProbe.decoded
  results.imageSchemes = imageProbe.schemes.join(",")

  // ⑤ 「只看待处理」筛选：点了之后左栏行数应当变少（或至少不报错）
  const filterClicked = await evaluate(`(() => {
    const hit = [...document.querySelectorAll("button")]
      .find((n) => /^只看待处理/.test((n.textContent ?? "").trim()))
    if (!hit) return false
    const before = document.querySelectorAll("aside ul li").length
    hit.click()
    window.__probeBefore = before
    return true
  })()`)
  if (filterClicked) {
    await sleep(800)
    results.filterNarrowed = await evaluate(
      `document.querySelectorAll("aside ul li").length <= window.__probeBefore`,
    )
    await evaluate(`(() => {
      const hit = [...document.querySelectorAll("button")]
        .find((n) => /^只看待处理/.test((n.textContent ?? "").trim()))
      if (hit) hit.click()
      return true
    })()`)
  }

  console.log("=== 数字人页面交互探针 ===")
  for (const [key, value] of Object.entries(results)) {
    console.log(`  ${key}: ${String(value)}`)
  }

  const required = ["editOpened", "textareaAppeared", "buttonLabelChanged", "editSurvivedRefetch"]
  const failed = required.filter((key) => results[key] !== true)
  if (failed.length > 0) {
    console.error(`\n✗ 这些在真应用里没生效：${failed.join(", ")}`)
    process.exitCode = 1
  } else if (results.citationClicked === true && results.citationHighlighted !== true) {
    console.error("\n✗ 点了「看引用」但中栏没有高亮 —— 容器到中栏那条线断了")
    process.exitCode = 1
  } else if (results.avatarsAvailable > 0 && results.imageDecoded === 0) {
    /**
     * ★ 后端有头像但界面上一张都没解码出来。
     *
     * 两种形态都在这一条里：
     * · `<img>` 在但取不到（scheme 不对 / 白名单挡了）；
     * · `<img>` 根本没渲染（Avatar 已经降级成首字母色块）。
     *
     * 后者正是最阴的那种 —— DOM 里干净得像"本来就没有头像"。
     * 单测在这里结构上是**盲**的：它只能验那个字符串。
     */
    console.error(
      `\n✗ 后端有 ${results.avatarsAvailable} 个头像，界面上解码出 0 张` +
        `（img 节点 ${results.imageCount} 个，scheme: ${results.imageSchemes || "无"}）` +
        ` —— URL 在 Electron 里取不到，检查协议注册与白名单`,
    )
    process.exitCode = 1
  } else {
    const note = results.citationClicked === true ? "" : "（这批草稿没有引用，那一条没验到）"
    /**
     * ★ 「没验到」要说清是**哪一种**没验到。
     *
     * 这条断言是唯一能证明 `mycontext-file://` 真的可加载的（单测结构上
     * 验不了）。所以它被跳过时不能只留一句含糊的"没验到" ——
     * 那句话读起来跟通过一样，而它曾经在挑中单聊时静默出现过一半的次数。
     */
    const imageNote =
      results.avatarsAvailable > 0
        ? `；${results.imageDecoded}/${results.imageCount} 张图真的加载出来了`
        : results.groupSwitched === "没有群聊"
          ? "；★ 这个库里没有群聊，图片加载那一条**没验到**（头像只在群聊取）"
          : "；★ 这个群的成员都没设头像，图片加载那一条**没验到**"
    console.log(`\n✓ 草稿可编辑 + 编辑态活过刷新${note}${imageNote}`)
  }
} finally {
  socket.close()
}
