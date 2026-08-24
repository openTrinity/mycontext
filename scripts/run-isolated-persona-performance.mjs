#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

const project = resolve(import.meta.dirname, "..")
const fixtureInput = process.env.MYCONTEXT_PERF_FIXTURE?.trim() ?? ""
if (fixtureInput === "" || !isAbsolute(fixtureInput)) {
  throw new Error("set MYCONTEXT_PERF_FIXTURE to an absolute isolated fixture path")
}
const fixture = realpathSync(fixtureInput)
const tempRoots = [realpathSync(tmpdir()), realpathSync("/tmp")]
if (
  !tempRoots.some((base) => {
    const child = relative(base, fixture)
    return child !== "" && !child.startsWith("..") && !isAbsolute(child)
  })
) {
  throw new Error("performance fixture must be inside a temporary directory")
}
if (!fixture.includes("mycontext")) throw new Error("fixture directory must contain mycontext")
if (!existsSync(join(project, "apps/desktop/out/main/index.js"))) {
  throw new Error("run pnpm build before the performance UI check")
}

const root = mkdtempSync(join(tmpdir(), "mycontext-persona-performance-"))
const chromium = join(root, "chromium")
const stub = join(root, "dws-deny")
const blocked = join(root, "blocked-dws.log")
let child = null
let timer = null

function sqlite(db, sql) {
  execFileSync("sqlite3", [db, sql], { stdio: "ignore" })
}
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
function findFile(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(path, name)
      if (found !== null) return found
    } else if (entry.name === name) return path
  }
  return null
}
async function waitForPortFile() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    for (const base of [root, chromium]) {
      const path = join(base, "DevToolsActivePort")
      if (!existsSync(path)) continue
      const [port] = readFileSync(path, "utf8").trim().split(/\r?\n/)
      if (port !== undefined && /^\d+$/.test(port)) return Number(port)
    }
    if (child?.exitCode !== null)
      throw new Error(`Electron exited early: ${String(child?.exitCode)}`)
    await sleep(100)
  }
  throw new Error("Electron debugging port did not become ready")
}
async function fetchTargets(port) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, {
        signal: AbortSignal.timeout(1000),
      })
      const targets = await response.json()
      const page = targets.find((item) => item.type === "page" && item.title === "MyContext")
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // Renderer is still starting.
    }
    await sleep(100)
  }
  throw new Error("MyContext renderer target did not become ready")
}
async function navigate(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  const pending = new Map()
  let sequence = 0
  const opened = new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", resolvePromise, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    const complete = pending.get(message.id)
    if (complete !== undefined) {
      pending.delete(message.id)
      complete(message)
    }
  })
  const call = (method, params = {}) =>
    new Promise((resolvePromise, reject) => {
      const id = ++sequence
      pending.set(id, (message) => {
        if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
        else resolvePromise(message.result)
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    return result.result.value
  }
  await opened
  let shellReady = false
  for (let attempt = 0; attempt < 300; attempt += 1) {
    shellReady = await evaluate(
      `(()=>{const controls=['仪表盘','数字分身','搜索','运行状态'].every(label=>[...document.querySelectorAll('button,a')].some(node=>(node.innerText||'').trim()===label));const text=document.body?.innerText??'';return controls&&text.includes('我的数字分身')})()`,
    )
    if (shellReady) break
    await sleep(100)
  }
  if (!shellReady) throw new Error("application shell did not become ready")
  const timings = []
  const ipcTimings = await evaluate(`(async()=>{const checks=[
    ['channels.list',()=>window.mycontext.channels.list()],
    ['onboarding.steps',()=>window.mycontext.onboarding.steps()],
    ['ingest.snapshot',()=>window.mycontext.ingest.snapshot()],
    ['pipeline.feedInfo',()=>window.mycontext.pipeline.feedInfo({channelId:'dingtalk'})],
    ['persona.snapshot',()=>window.mycontext.persona.snapshot()],
    ['distill.progress',()=>window.mycontext.distill.progress()],
    ['kl.serverStatus',()=>window.mycontext.kl.serverStatus()],
    ['kl.graphEgo',()=>window.mycontext.kl.graphEgo({channelId:'dingtalk'})],
    ['kl.graphOverview',()=>window.mycontext.kl.graphOverview({channelId:'dingtalk'})],
    ['ingest.readSelf',()=>window.mycontext.ingest.readSelf()]
  ];const out=[];for(const [name,run] of checks){const at=performance.now();try{await run();out.push({name,ms:Math.round(performance.now()-at),ok:true})}catch{out.push({name,ms:Math.round(performance.now()-at),ok:false})}}return out})()`)
  for (let round = 1; round <= 3; round += 1) {
    for (const label of ["仪表盘", "数字分身", "搜索", "运行状态"]) {
      const started = Date.now()
      const clicked = await evaluate(
        `(()=>{const label=${JSON.stringify(label)};const item=[...document.querySelectorAll('button,a')].find(node=>(node.innerText||'').trim()===label);if(!item)return false;item.click();return true})()`,
      )
      if (clicked !== true) throw new Error(`navigation missing: ${label}`)
      let settled = false
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await sleep(25)
        if (await evaluate(`(document.body?.innerText??'').includes(${JSON.stringify(label)})`)) {
          settled = true
          break
        }
      }
      if (!settled) throw new Error(`navigation did not settle: ${label}`)
      timings.push({ round, label, ms: Date.now() - started })
    }
  }
  const overflow = await evaluate(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth",
  )
  socket.close()
  return { timings, ipcTimings, overflow, maxMs: Math.max(...timings.map((item) => item.ms)) }
}

try {
  cpSync(fixture, root, { recursive: true, mode: 0x0002 })
  rmSync(chromium, { recursive: true, force: true })
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>'${blocked}'\nif [ "\${1:-}" = "--version" ]; then echo 'dws-isolated 0.0.0'; exit 0; fi\nif [ "\${1:-}" = "auth" ] && [ "\${2:-}" = "status" ]; then echo '{"success":true,"authenticated":true,"token_valid":true,"refresh_token_valid":true,"expires_at":"2099-01-01T00:00:00Z","refresh_expires_at":"2099-01-02T00:00:00Z","corp_id":"dingFAKEPERF0001","corp_name":"隔离性能组织","user_id":"100001","user_name":"隔离性能用户"}'; exit 0; fi\necho '{"ok":false,"error":{"message":"isolated test denied"}}'\nexit 3\n`,
  )
  chmodSync(stub, 0o700)
  const control = join(root, "control.sqlite")
  sqlite(
    control,
    `INSERT INTO app_settings(key,value,updated_at) VALUES('dws_source_path','${stub.replaceAll("'", "''")}','${new Date().toISOString()}') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
     UPDATE channel_identity_vaults SET corp_id='dingFAKEPERF0001',user_id='100001',corp_name='隔离性能组织',user_name='隔离性能用户';`,
  )
  const vault = findFile(join(root, "vaults"), "core.sqlite")
  if (vault === null) throw new Error("fixture does not contain a vault")
  sqlite(
    vault,
    `INSERT INTO dh_settings(key,value_json,updated_at) VALUES('killSwitch','true',0) ON CONFLICT(key) DO UPDATE SET value_json='true';
     INSERT INTO vault_settings(key,value,updated_at) VALUES('onboarding.completedAt','isolated','${new Date().toISOString()}') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
     DELETE FROM dh_send_grants;
     DELETE FROM dh_send_attempts;`,
  )
  child = spawn(
    process.execPath,
    [
      join(project, "node_modules/electron/cli.js"),
      "--remote-debugging-port=0",
      `--user-data-dir=${chromium}`,
      join(project, "apps/desktop/out/main/index.js"),
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        MYCONTEXT_DATA_DIR: root,
        MYCONTEXT_DEV_TOOLS: "false",
        MYCONTEXT_LLM_API_KEY: "",
        MYCONTEXT_LLM_BASE_URL: "",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  )
  const navigation = (async () => {
    const port = await waitForPortFile()
    const webSocket = await fetchTargets(port)
    return await navigate(webSocket)
  })()
  const childFailure = new Promise((_, reject) => {
    child.once("error", reject)
  })
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("isolated performance UI timed out"))
    }, 90_000)
  })
  const outcome = await Promise.race([navigation, childFailure, timeout])
  clearTimeout(timer)
  const blockedText = existsSync(blocked) ? readFileSync(blocked, "utf8") : ""
  const send_like = blockedText
    .split(/\r?\n/)
    .filter((line) => /send|message create|chat send/i.test(line)).length
  if (send_like !== 0) throw new Error(`send_like=${String(send_like)}`)
  const failedIpc = outcome.ipcTimings.filter((item) => !item.ok)
  if (failedIpc.length > 0) {
    throw new Error(`required IPC failed: ${JSON.stringify(failedIpc)}`)
  }
  const maxIpcMs = Math.max(...outcome.ipcTimings.map((item) => item.ms))
  if (maxIpcMs > 5000) throw new Error(`required IPC too slow: ${String(maxIpcMs)}ms`)
  if (outcome.maxMs > 3000) {
    throw new Error(
      `navigation too slow: ${JSON.stringify(outcome.timings.filter((item) => item.ms === outcome.maxMs))}; ipc=${JSON.stringify(outcome.ipcTimings)}`,
    )
  }
  if (outcome.overflow > 1) throw new Error(`horizontal overflow: ${String(outcome.overflow)}px`)
  process.stdout.write(`${JSON.stringify({ ...outcome, send_like })}\n`)
} finally {
  if (timer !== null) clearTimeout(timer)
  if (child !== null && child.exitCode === null) {
    child.kill("SIGTERM")
    await sleep(500)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  rmSync(root, { recursive: true, force: true })
}
