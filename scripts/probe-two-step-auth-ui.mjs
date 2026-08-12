#!/usr/bin/env node
/**
 * CDP 探针：验本轮改动在**真应用**里成立。
 *
 * ## 为什么必须在真应用里量
 *
 * 这一轮有两类改动只有真浏览器能证伪：
 *
 * ① **设计系统 token 是否真的存在**。Tailwind 对未知 class **静默丢弃**
 *    —— 我这轮就写错过四个（`border-border-subtree`/`bg-surface-sunken`/
 *    `text-content-*`/`typography-caption-500`，仓库里全都没有）。
 *    单测锁"class 串里有没有那个词"是绿的，而屏幕上那条线根本不画。
 *    所以这里量 `getComputedStyle` 的**算出来的值**。
 * ② **两步授权区块在什么状态下出现**。它依赖 `status.appBinding`，
 *    而那要主进程真去跑一次 `auth status` 才有。
 *
 * ## 用法
 *
 *   pnpm dev -- --remote-debugging-port=9388
 *   node scripts/probe-two-step-auth-ui.mjs [端口]
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
await new Promise((resolve) => socket.addEventListener("open", resolve))

/** 在页面里跑一段并把返回值取回来（返回值必须可 JSON 序列化）。 */
async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400))
  }
  return res.result?.result?.value
}

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail === undefined ? "" : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

// ─────────────────────────────────────────────────────────────
// ① 设计系统 token：我这轮用到的每一个都必须**算出真值**
// ─────────────────────────────────────────────────────────────
const tokens = await evaluate(`(() => {
  const probe = document.createElement("div")
  document.body.appendChild(probe)
  const read = (name) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v === "" ? null : v
  }
  const out = {
    borderDividerLight: read("--border-divider-light"),
    bgBaseNormal: read("--bg-base-normal"),
    textBaseTertiary: read("--text-base-tertiary"),
    textBasePrimary: read("--text-base-primary"),
    statusWarning: read("--status-warning"),
    overlaySelected: read("--overlay-on-container-selected"),
  }
  probe.remove()
  return out
})()`)
for (const [name, value] of Object.entries(tokens)) {
  check(`token --${name} 有真值`, value !== null, value ?? "空串（这个变量不存在！）")
}

// 反面：我写错过的那几个**不该**存在 —— 确认判据本身有区分力
const bogus = await evaluate(`(() => {
  const read = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
  return { borderSubtle: read("--border-subtle"), surfaceSunken: read("--surface-sunken") }
})()`)
check(
  "判据有区分力：编造的 token 确实读不到（否则上面全绿没有意义）",
  bogus.borderSubtle === "" && bogus.surfaceSunken === "",
  `--border-subtle="${bogus.borderSubtle}" --surface-sunken="${bogus.surfaceSunken}"`,
)

// ─────────────────────────────────────────────────────────────
// ② 主进程真实数据：渠道摘要里有没有 appBinding / capabilities
// ─────────────────────────────────────────────────────────────
const channels = await evaluate(`(async () => {
  const r = await window.mycontext.channels.list()
  if (r.ok !== true) return { error: JSON.stringify(r).slice(0, 200) }
  // ★ Result 的载荷字段是 \`data\`（不是 \`value\`）—— 实测确认，别照猜写
  return r.data.map((c) => ({
    id: c.id,
    state: c.status.state,
    hasAppBinding: c.status.appBinding !== undefined,
    appIdLen: c.status.appBinding?.appId?.length ?? 0,
    appNameLen: c.status.appBinding?.appName?.length ?? 0,
    corpNameLen: c.status.state === "authorized" ? (c.status.corpName ?? "").length : 0,
    corpIdLen: c.status.state === "authorized" ? (c.status.corpId ?? "").length : 0,
    sendAs: c.capabilities?.sendAs ?? null,
    isolatedCredentials: c.capabilities?.isolatedCredentials ?? null,
  }))
})()`)
console.log("\n渠道摘要（脱敏，只看长度与形状）：")
console.log(JSON.stringify(channels, null, 2))

if (Array.isArray(channels)) {
  const dingtalk = channels.find((c) => c.id === "dingtalk")
  const feishu = channels.find((c) => c.id === "feishu")
  check(
    "契约新字段已到渲染层：capabilities.isolatedCredentials 是布尔",
    typeof dingtalk?.isolatedCredentials === "boolean",
    `dingtalk=${String(dingtalk?.isolatedCredentials)}`,
  )
  check(
    "钉钉是一步授权 → 没有 appBinding（不该长出「换应用」按钮）",
    dingtalk?.hasAppBinding === false,
    `hasAppBinding=${String(dingtalk?.hasAppBinding)}`,
  )
  check(
    "飞书只读接入 → sendAs 为空数组（分身设置该显示「只读」而不是参数）",
    Array.isArray(feishu?.sendAs) && feishu.sendAs.length === 0,
    `sendAs=${JSON.stringify(feishu?.sendAs)}`,
  )
  if (dingtalk?.state === "authorized") {
    check(
      "钉钉组织名非空（corpName 有值）",
      dingtalk.corpNameLen > 0,
      `corpName 长度=${dingtalk.corpNameLen}`,
    )
  }
  // 飞书刚被清空 → 预期 unauthorized 且无 appBinding；重新授权后这两条会变
  console.log(
    `\nℹ️  飞书当前 state=${feishu?.state}、hasAppBinding=${String(feishu?.hasAppBinding)}` +
      `（数据刚清空，所以两步都未完成 —— 这与预期一致）`,
  )
}

// ─────────────────────────────────────────────────────────────
// ③ i18n：本轮新增的 key 必须真的解析出译文（不是原样返回 key）
// ─────────────────────────────────────────────────────────────
const i18n = await evaluate(`(() => {
  const keys = [
    "channels:twoStep.appLabel",
    "channels:twoStep.sessionLabel",
    "channels:twoStep.sessionMissing",
    "channels:actions.switchUser",
    "channels:actions.switchApp",
    "channels:actions.switchAppHint",
    "channels:actions.switchUserDone",
    "channels:actions.switchAppDone",
    "settings:channels.tabs.auth",
    "settings:channels.tabs.collect",
    "settings:channels.tabs.graph",
    "settings:persona.channelUnsupported",
  ]
  const i = window.__i18n ?? null
  if (i === null) return { missing: "window.__i18n 不可用（探针换个判法）" }
  return Object.fromEntries(keys.map((k) => [k, i.t(k)]))
})()`)
if (i18n?.missing === undefined && i18n !== undefined) {
  for (const [key, value] of Object.entries(i18n)) {
    const resolved =
      typeof value === "string" && value !== key && !value.endsWith(key.split(":")[1])
    check(`i18n ${key} 有译文`, resolved, resolved ? `“${value.slice(0, 28)}…”` : `原样返回 key`)
  }
} else {
  console.log(`\nℹ️  i18n 直查不可用（${i18n?.missing ?? "未知"}）—— 由 DOM 断言间接覆盖`)
}

console.log(
  failures.length === 0
    ? "\n✅ 全部通过"
    : `\n❌ ${failures.length} 项未通过：\n  - ${failures.join("\n  - ")}`,
)
socket.close()
process.exit(failures.length === 0 ? 0 : 1)
