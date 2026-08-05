#!/usr/bin/env node
/**
 * 端到端手动验证辅助：通过 CDP 在真实运行的应用里驱动登录链路。
 *
 * 这不是自动化测试，而是「人工验收」的可复现脚本：
 * 它走的是真实的 preload → IPC → 主进程 → SQLite 路径，
 * 因此能证明整条链路通，而不只是单元级别的逻辑正确。
 *
 * 用 Node 22 内建的全局 WebSocket，不额外引入 ws 依赖。
 *
 * 用法：先带 --remote-debugging-port=9333 启动应用，再运行本脚本。
 */

const PORT = process.argv[2] ?? "9333"

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) =>
  response.json(),
)
const page = targets.find((target) => target.type === "page")
if (!page) throw new Error("未找到渲染进程页面，应用是否已启动？")

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true })
  socket.addEventListener("error", reject, { once: true })
})

let messageId = 0
const pending = new Map()
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data)
  const handler = pending.get(message.id)
  if (handler) {
    pending.delete(message.id)
    handler(message)
  }
})

/** 在渲染进程里求值一段表达式并取回结果。 */
function evaluate(expression) {
  const id = (messageId += 1)
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => {
      if (message.error) return reject(new Error(JSON.stringify(message.error)))
      const result = message.result?.result
      if (message.result?.exceptionDetails) {
        return reject(new Error(JSON.stringify(message.result.exceptionDetails)))
      }
      resolve(result?.value)
    })
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })
}

const steps = []
function record(name, detail) {
  steps.push({ name, ...detail })
  console.log(`[${detail.ok ? "PASS" : "FAIL"}] ${name}${detail.note ? ` — ${detail.note}` : ""}`)
}

const EMAIL = "m0-verify@example.com"
const PASSWORD = "password-m0-verify"

// 1. 初始状态：无账号、无会话
const initial = await evaluate(`window.mycontext.app.bootstrapState()`)
record("初始状态：无账号且未登录", {
  ok: initial.ok === true && initial.data.hasAccount === false && initial.data.session === null,
  note: `hasAccount=${initial.data?.hasAccount}, session=${initial.data?.session}`,
})

// 2. 弱口令被拒绝
const weak = await evaluate(
  `window.mycontext.auth.register({email:"weak@example.com",password:"short"})`,
)
record("弱口令被拒绝", {
  ok: weak.ok === false && weak.error.code === "AUTH_WEAK_PASSWORD",
  note: weak.error?.code,
})

// 3. 非法邮箱被拒绝
const badEmail = await evaluate(
  `window.mycontext.auth.register({email:"not-an-email",password:"${PASSWORD}"})`,
)
record("非法邮箱被拒绝", {
  ok: badEmail.ok === false && badEmail.error.code === "AUTH_INVALID_EMAIL",
  note: badEmail.error?.code,
})

// 4. 注册成功并建立会话
const registered = await evaluate(
  `window.mycontext.auth.register({email:"${EMAIL}",password:"${PASSWORD}"})`,
)
record("注册成功并建立会话", {
  ok: registered.ok === true && registered.data.email === EMAIL,
  note: `accountId=${registered.data?.accountId?.slice(0, 8)}…`,
})

// 5. 重复邮箱被拒绝
const duplicate = await evaluate(
  `window.mycontext.auth.register({email:" ${EMAIL.toUpperCase()} ",password:"${PASSWORD}"})`,
)
record("重复邮箱被拒绝（含大小写与空格差异）", {
  ok: duplicate.ok === false && duplicate.error.code === "AUTH_EMAIL_TAKEN",
  note: duplicate.error?.code,
})

// 6. 状态报告：迁移版本、账号数、配置来源与脱敏
const status = await evaluate(`window.mycontext.app.statusReport()`)
const report = status.data
const apiKeyEntry = report?.config.find((entry) => entry.key === "llmApiKey")
const modelEntry = report?.config.find((entry) => entry.key === "modelMain")
record("状态报告：数据库迁移已应用", {
  // 只断言「有迁移被应用过」而不写死版本号：加迁移不该让这条假失败。
  ok: (report?.database.appliedVersion ?? 0) >= 1 && report?.database.accountCount === 1,
  note: `v${report?.database.appliedVersion}, accounts=${report?.database.accountCount}`,
})
record("状态报告：环境变量注入生效", {
  ok: modelEntry?.source === "env" && modelEntry.value === "qwen3.7-max",
  note: `modelMain=${modelEntry?.value} (${modelEntry?.source})`,
})
record("状态报告：密钥不泄漏明文", {
  ok: apiKeyEntry?.value === null && !JSON.stringify(report).includes("sk-"),
  note: `llmApiKey.value=${apiKeyEntry?.value}, configured=${apiKeyEntry?.configured}`,
})

// 7. 登出后会话清空，但账号仍在
const loggedOut = await evaluate(`window.mycontext.auth.logout()`)
const afterLogout = await evaluate(`window.mycontext.app.bootstrapState()`)
record("登出后会话清空、账号保留", {
  ok:
    loggedOut.ok === true &&
    afterLogout.data.session === null &&
    afterLogout.data.hasAccount === true,
  note: `hasAccount=${afterLogout.data?.hasAccount}, session=${afterLogout.data?.session}`,
})

// 8. 错误口令被拒绝
const wrongPassword = await evaluate(
  `window.mycontext.auth.login({email:"${EMAIL}",password:"definitely-wrong"})`,
)
record("错误口令被拒绝", {
  ok: wrongPassword.ok === false && wrongPassword.error.code === "AUTH_INVALID_CREDENTIALS",
  note: wrongPassword.error?.code,
})

// 9. 正确口令可登录（邮箱大小写不敏感）
const loggedIn = await evaluate(
  `window.mycontext.auth.login({email:"${EMAIL.toUpperCase()}",password:"${PASSWORD}"})`,
)
record("正确口令可登录（邮箱大小写不敏感）", {
  ok: loggedIn.ok === true && loggedIn.data.email === EMAIL,
  note: `email=${loggedIn.data?.email}`,
})

// 10. 未注册邮箱与错误口令返回同一错误码
const unknown = await evaluate(
  `window.mycontext.auth.login({email:"nobody@example.com",password:"${PASSWORD}"})`,
)
record("未注册邮箱与错误口令返回同一错误码", {
  ok: unknown.error?.code === wrongPassword.error?.code,
  note: `${unknown.error?.code} === ${wrongPassword.error?.code}`,
})

// 11. 渲染层拿不到 ipcRenderer（contextIsolation 生效）
const isolation = await evaluate(
  `JSON.stringify({require: typeof window.require, ipc: typeof window.ipcRenderer, keys: Object.keys(window.mycontext)})`,
)
const parsed = JSON.parse(isolation)
record("渲染层未暴露 require / ipcRenderer", {
  ok: parsed.require === "undefined" && parsed.ipc === "undefined",
  note: `暴露的 API：${parsed.keys.join(", ")}`,
})

/**
 * 12. 会话是签名 token：登录返回携带 token 过期时间。
 *
 * 这一项证明的是真实链路上确实签发了会话凭据（并且密钥能从钥匙串取到）——
 * 单测里签名密钥是注入的，走不到 safeStorage。
 */
const sessionMeta = await evaluate(`window.mycontext.app.bootstrapState()`)
const liveSession = sessionMeta.data?.session
record("会话携带 token 过期时间（真实链路签发成功）", {
  ok:
    typeof liveSession?.tokens?.expiresAt === "string" &&
    !Number.isNaN(Date.parse(liveSession.tokens.expiresAt)),
  note: `expiresAt=${liveSession?.tokens?.expiresAt}`,
})

/**
 * 13. token 本身不进渲染层。
 *
 * 渲染层不需要它（需要凭据的调用都在主进程发起），递过去只是白送一个
 * 可被 XSS 偷走的东西。JWT 有两个 `.`，据此判断整个会话对象里没有 token。
 */
const sessionJson = JSON.stringify(liveSession ?? {})
record("会话对象里不含 token 本身", {
  ok: !/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(sessionJson),
  note: sessionJson,
})

// 14. 渠道列表：钉钉可用、飞书暂未开放
const channels = await evaluate(`window.mycontext.channels.list()`)
const dingtalk = channels.data?.find((entry) => entry.id === "dingtalk")
const feishu = channels.data?.find((entry) => entry.id === "feishu")
record("渠道列表返回钉钉（可用）与飞书（暂未开放）", {
  ok: channels.ok === true && dingtalk?.available === true && feishu?.available === false,
  note: `dingtalk.available=${dingtalk?.available}, feishu.available=${feishu?.available}`,
})

/**
 * 15. 授权状态走真实 dws 二进制。
 *
 * 断言的是「链路通 + 形态合法」，不断言具体是已授权还是未授权——
 * 那取决于跑验证的这台机器上有没有登录过，写死会让脚本在别人机器上假失败。
 * 已授权时额外确认身份字段齐全（UI 直接渲染这些字段，缺了就是空白卡片）。
 */
const authStatus = await evaluate(
  `window.mycontext.channels.authStatus({channelId:"dingtalk",refresh:true})`,
)
const state = authStatus.data?.state
const shapeOk =
  state === "unauthorized" ||
  state === "expired" ||
  (state === "authorized" &&
    typeof authStatus.data.corpName === "string" &&
    typeof authStatus.data.userName === "string" &&
    typeof authStatus.data.refreshExpiresAt === "string" &&
    Number.isInteger(authStatus.data.daysUntilRefreshExpiry))
record("钉钉授权状态可查（真实 dws 链路）且形态合法", {
  ok: authStatus.ok === true && shapeOk,
  note:
    state === "authorized"
      ? `authorized，refresh 剩余 ${authStatus.data.daysUntilRefreshExpiry} 天`
      : `state=${state}`,
})

// 16. 未开放渠道不给授权入口：调用直接被拒，而不是静默失败
const unsupported = await evaluate(
  `window.mycontext.channels.authStart({channelId:"feishu",mode:"loopback"})`,
)
record("未开放渠道拒绝授权调用", {
  ok: unsupported.ok === false && unsupported.error?.code === "CHANNEL_UNSUPPORTED",
  note: unsupported.error?.code,
})

// 17. 取消一个不存在的授权流程是幂等的（UI 可能重复点「取消」）
const cancelNoop = await evaluate(`window.mycontext.channels.authCancel({channelId:"dingtalk"})`)
record("取消不存在的授权流程不报错", {
  ok: cancelNoop.ok === true && cancelNoop.data === false,
  note: `data=${cancelNoop.data}`,
})

// 18. Onboarding 记账：跳过后 needsOnboarding 落定为 false
const skipped = await evaluate(`window.mycontext.onboarding.skip()`)
const afterSkip = await evaluate(`window.mycontext.app.bootstrapState()`)
record("跳过 Onboarding 后不再拦截启动", {
  ok: skipped.ok === true && afterSkip.data?.needsOnboarding === false,
  note: `needsOnboarding=${afterSkip.data?.needsOnboarding}`,
})

/**
 * 19. 存储布局：控制库与 per-account vault 分开。
 *
 * 断言路径而不是断言文件存在（渲染层读不到文件系统）——
 * 文件是否真的建出来由 scripts/smoke.mjs 与 vault.test.ts 覆盖。
 */
const report2 = (await evaluate(`window.mycontext.app.statusReport()`)).data
const paths = report2?.paths
record("控制库与 vault 目录分离", {
  ok:
    typeof paths?.database === "string" &&
    paths.database.endsWith("control.sqlite") &&
    typeof paths.vaults === "string" &&
    paths.vaults.endsWith("vaults"),
  note: `database=${paths?.database?.split("/").slice(-2).join("/")}, vaults=${paths?.vaults?.split("/").slice(-1)[0]}`,
})

/**
 * 20. 开发态数据目录不叫 MyContextDev。
 *
 * 那个名字与同机的参考实现完全相同，两个项目会共用一个 userData 目录，
 * 任一方的「重置数据」都会连带删掉对方的库。
 */
record("开发态数据目录与参考实现不冲突", {
  ok: typeof paths?.userData === "string" && !/\/MyContextDev$/.test(paths.userData),
  note: paths?.userData,
})

/**
 * 21. 语言偏好：切到 en 后落盘并能读回。
 *
 * 只验主进程侧的持久化；界面文案是否真的变英文由人工截图确认
 * （CDP 里断言每一句译文没有意义，那等于把语言包抄一遍）。
 */
const setEn = await evaluate(`window.mycontext.preferences.setLanguage({language:"en"})`)
const afterEn = await evaluate(`window.mycontext.app.bootstrapState()`)
record("语言偏好可持久化", {
  ok: setEn.ok === true && afterEn.data?.language === "en",
  note: `language=${afterEn.data?.language}`,
})

// 22. 非法语言值被拒（zod 校验生效，不会把脏值写进库）
const badLanguage = await evaluate(`window.mycontext.preferences.setLanguage({language:"klingon"})`)
record("非法语言值被拒", {
  ok: badLanguage.ok === false && badLanguage.error?.code === "IPC_BAD_REQUEST",
  note: badLanguage.error?.code,
})

// 恢复成跟随系统，避免把验证残留留给下一次手动检查
await evaluate(`window.mycontext.preferences.setLanguage({language:"system"})`)

/**
 * 23. 错误里带 i18n key，而不是只有中文。
 *
 * 这一项证明 messageKey 真的流到了渲染层——UI 才可能把它翻成英文。
 */
const weakAgain = await evaluate(
  `window.mycontext.auth.register({email:"weak2@example.com",password:"short"})`,
)
record("错误携带 i18n key 与参数", {
  ok:
    weakAgain.error?.messageKey === "errors:auth.weakPassword" &&
    typeof weakAgain.error?.messageParams?.min === "number",
  note: `messageKey=${weakAgain.error?.messageKey}, params=${JSON.stringify(weakAgain.error?.messageParams)}`,
})

// 24. 渠道摘要传 key 而不是文案（主进程不再持有语言文案）
const channelsAgain = await evaluate(`window.mycontext.channels.list()`)
const dt = channelsAgain.data?.find((entry) => entry.id === "dingtalk")
record("渠道摘要传 i18n key 而非文案", {
  ok:
    dt?.labelKey === "channels:dingtalk.label" &&
    typeof dt?.descriptionKey === "string" &&
    Array.isArray(dt?.stepKeys) &&
    dt.stepKeys.length > 0 &&
    /**
     * 只检查文案字段有没有中文，不检查整个对象。
     * status 里的 corpName / userName 是真实的用户数据（如「（公司）」），
     * 那是原样展示的内容，不该也不能被翻译。
     */
    !/[一-鿿]/.test(`${dt.labelKey}${dt.descriptionKey}${dt.stepKeys.join("")}`),
  note: `labelKey=${dt?.labelKey}, stepKeys=${dt?.stepKeys?.length}`,
})

socket.close()

const failed = steps.filter((step) => !step.ok)
console.log(`\n${steps.length - failed.length}/${steps.length} 项通过`)
if (failed.length > 0) {
  console.error("失败项：" + failed.map((step) => step.name).join("；"))
  process.exitCode = 1
} else {
  console.log("E2E_OK")
}
