#!/usr/bin/env node
/**
 * 一条命令：**用开源版 dws 起一个全新的应用实例**，走一遍 onboarding。
 *
 * ## 为什么需要它（四样东西必须同时换掉）
 *
 * 「换成开源版试一下」听起来是一件事，实际要同时满足四个条件，
 * 少一个就会得到一个看起来对、实际测的不是那回事的环境：
 *
 * ① **二进制**：用开源版的那份；
 * ② **应用数据**：`MYCONTEXT_DATA_DIR` 指到独立目录 —— 否则新账号会写进
 *    你日常那个 vault（`InklingsDevelop`），把两个人的消息混进同一个库；
 * ③ **登录凭据**：这一条最容易漏。token 的密钥默认在 **macOS Keychain**
 *    （服务名 `dws-cli`，按系统用户存一份），`DWS_CONFIG_DIR` **隔离不了它**。
 *    不隔离的话新实例会读到你已有的登录态 —— 于是"用新账号走 onboarding"
 *    这件事根本不会发生（它直接就是已登录状态）。
 * ④ **二进制所在目录**（★ 见下）。
 *
 * 第 ③ 条的解法是上游给的两个变量（实测有效）：
 * `DWS_KEYCHAIN_DIR=<dir>` 把密钥存到指定目录，
 * `DWS_DISABLE_KEYCHAIN=1` 让它用文件 DEK 而不是走系统 Keychain。
 * 实测：设了这两个之后 `auth status` 是干净的「未登录」，
 * 而原来那份登录态**完全没被动**。
 *
 * ## ★★ 第 ④ 条是踩过的坑：**不能**去切 `resources/bin` 里那一份
 *
 * 首版做法是跑 `dws-edition oss`，把 `apps/desktop/resources/bin/dws-*`
 * **原地换成**开源版。但那个文件是**两个实例共享**的 ——
 * 于是日常那个正在跑的实例也跟着换了，而开源版刷不动内置版建立的登录态，
 * 采集立刻开始每 11 秒报一次「旧版登录态已无法刷新」。
 * 用户看到的是"拉不到聊天记录"，根因却在几分钟前的一次 `prepare:bin` 上。
 *
 * 所以现在给沙箱**自己的 bin 目录**（`sandbox/bin`），
 * 通过 `MYCONTEXT_BIN_DIR` 传给这个实例。日常那份 `resources/bin`
 * **一个字节都不碰** —— 两个实例可以同时跑、各用各的 dws。
 *
 * ## 沙箱目录
 *
 * 默认 `<repo>/.dws-oss-sandbox/`（已 gitignore）。里面：
 *   bin/       开源版 dws（从 vendor/dws-oss 拷来并签名）
 *   data/      应用数据（vault、control.sqlite、logs）
 *   keychain/  开源版的加密凭据（文件 DEK）
 *
 * 删掉这个目录 = 彻底重来一遍 onboarding，不影响日常那份数据。
 *
 * 用法：
 *   node scripts/dev-dws-oss.mjs           # 起（缺产物会自动拉取）
 *   node scripts/dev-dws-oss.mjs --reset    # 清空沙箱后再起（重走 onboarding）
 *   node scripts/dev-dws-oss.mjs --where    # 只打印沙箱状态，不启动
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)

const sandbox = join(root, ".dws-oss-sandbox")
const sandboxBin = join(sandbox, "bin")
const dataDir = join(sandbox, "data")
const keychainDir = join(sandbox, "keychain")
const vendorOss = join(root, "vendor/dws-oss")

/**
 * 沙箱的 renderer dev server 端口。
 *
 * 与日常实例的默认值（5273）**必须不同** —— 两个 vite dev server 抢同一个端口，
 * 第二个直接 `Error: Port 5273 is already in use` 起不来。
 * 允许用 `MYCONTEXT_OSS_DEV_PORT` 覆盖（万一 5274 也被占）。
 */
const devPort = process.env["MYCONTEXT_OSS_DEV_PORT"] ?? "5274"

function platformSuffix() {
  const arch = process.arch === "x64" ? "x64" : process.arch
  return `${process.platform}-${arch}`
}
const binaryName =
  process.platform === "win32" ? `dws-${platformSuffix()}.exe` : `dws-${platformSuffix()}`

function landedVersion(path) {
  if (!existsSync(path)) return null
  const probe = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 30_000 })
  if (probe.error !== undefined || probe.signal !== null) return null
  return `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim().split("\n")[0] ?? null
}

if (args.includes("--where")) {
  console.log(`沙箱：      ${sandbox}`)
  console.log(`  dws：     ${landedVersion(join(sandboxBin, binaryName)) ?? "（还没准备）"}`)
  console.log(`  应用数据：${dataDir}${existsSync(dataDir) ? "" : "（还没建）"}`)
  console.log(`  凭据：    ${keychainDir}${existsSync(keychainDir) ? "" : "（还没建）"}`)
  console.log("")
  console.log("日常那份（不受本命令影响）：")
  const daily = join(root, "apps/desktop/resources/bin", binaryName)
  console.log(`  dws：     ${landedVersion(daily) ?? "（还没准备）"}`)
  process.exit(0)
}

if (args.includes("--reset")) {
  rmSync(sandbox, { recursive: true, force: true })
  console.log(`已清空沙箱：${sandbox}\n`)
}

// ── 开源版产物（不入 git，缺了就拉）──────────────────────────
if (!existsSync(join(vendorOss, binaryName))) {
  console.log("开源版产物还没拉取，先执行 fetch-dws-oss…\n")
  const fetched = spawnSync(process.execPath, [join(root, "scripts/fetch-dws-oss.mjs")], {
    stdio: "inherit",
  })
  if (fetched.status !== 0) process.exit(fetched.status ?? 1)
  console.log("")
}

/**
 * 拷进沙箱的 bin 并**重签 + 真跑一次**。
 *
 * 这三步与 `prepare-bin.mjs::installExecutable` 同一套理由（那里有长注释）：
 * 往已存在的路径 copy 会复用 inode，让内核缓存的 ad-hoc 签名与新内容对不上，
 * 表现是 spawn 时被 SIGKILL 且 stdout/stderr 全空。所以先 unlink 再拷、
 * 拷完重签、最后**真跑一次**确认它能执行 —— 跑不起来就在这里硬失败，
 * 而不是让它表现成几百行之后的"未检测到有效登录态"。
 */
mkdirSync(sandboxBin, { recursive: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(keychainDir, { recursive: true })

const target = join(sandboxBin, binaryName)
if (existsSync(target)) unlinkSync(target)
copyFileSync(join(vendorOss, binaryName), target)
chmodSync(target, 0o755)
if (process.platform === "darwin") {
  const signed = spawnSync("codesign", ["--force", "--sign", "-", target], { encoding: "utf8" })
  if (signed.status !== 0) {
    console.warn(`  （codesign 未生效：${(signed.stderr ?? "").trim().slice(0, 160)}）`)
  }
}
const version = landedVersion(target)
if (version === null) {
  console.error(
    [
      `沙箱里的 dws 跑不起来：${target}`,
      "这通常是 macOS 拒绝了 ad-hoc 签名的 Mach-O。可手动确认：",
      `  codesign --force --sign - ${target} && ${target} --version`,
    ].join("\n    "),
  )
  process.exit(1)
}

/**
 * opencode 也要给：它在 `binDir` 下解析（`tryResolveOpencode` 的 bundled 档）。
 * 不给的话这个实例会降级到内置 harness —— 不是崩，但"顺手把 agent 也降级了"
 * 会让 onboarding 之后的表现和日常实例不一致，白白多一个变量。
 * 拷不到就算了（缺失本来就是允许的降级路径）。
 */
const opencodeName =
  process.platform === "win32" ? `opencode-${platformSuffix()}.exe` : `opencode-${platformSuffix()}`
const opencodeSource = join(root, "apps/desktop/resources/bin", opencodeName)
if (existsSync(opencodeSource)) {
  const opencodeTarget = join(sandboxBin, opencodeName)
  if (existsSync(opencodeTarget)) unlinkSync(opencodeTarget)
  copyFileSync(opencodeSource, opencodeTarget)
  chmodSync(opencodeTarget, 0o755)
  if (process.platform === "darwin") {
    spawnSync("codesign", ["--force", "--sign", "-", opencodeTarget], { encoding: "utf8" })
  }
}

console.log("─".repeat(64))
console.log("以**开源版 dws** + **独立沙箱**启动")
console.log(`  dws：     ${version}`)
console.log(`  bin：     ${sandboxBin}`)
console.log(`  应用数据：${dataDir}`)
console.log(`  凭据：    ${keychainDir}（文件 DEK，不走系统 Keychain）`)
console.log(`  devPort： ${devPort}（日常实例是 5273，错开才能同时跑）`)
console.log("")
console.log("★ 日常那份 resources/bin 与登录态**完全没碰** —— 两个实例可以同时跑。")
console.log("应用起来后：渠道页是「未授权」，按引导用新账号扫码即可。")
console.log("彻底重来：node scripts/dev-dws-oss.mjs --reset")
console.log("─".repeat(64))
console.log("")

/**
 * ★★ native 模块必须为 **Electron 的 ABI** 重编（`pnpm dev` 里那一步）。
 *
 * better-sqlite3 是原生模块，Node 22 与 Electron 的 `NODE_MODULE_VERSION`
 * 不同（实测 127 vs 148）。跑过 `pnpm test`（它会 `native:node`）之后
 * 产物是 Node 版的，此时直接起 Electron 会在**打开控制库那一刻**炸：
 * `DB_UNAVAILABLE … was compiled against a different Node.js version`。
 *
 * 首版这里为了绕开 `prepare:bin`（它会写日常那份 resources/bin）而直接调
 * `electron-vite dev`，结果把同一条链路上的 `rebuild-electron` 一起绕过了 ——
 * 而那一步与 prepare:bin 无关、且**必须**跑。
 *
 * 所以现在显式跑 `rebuild-electron`，仍然**不**跑 `prepare:bin`
 * （沙箱的二进制上面已经自己准备好，日常那份一个字节都不该碰）。
 * 它是幂等的：ABI 已经对上时几乎立即返回。
 */
const rebuilt = spawnSync(process.execPath, [join(root, "scripts/rebuild-electron.mjs")], {
  cwd: root,
  stdio: "inherit",
})
if (rebuilt.status !== 0) {
  console.error(
    "\nnative 模块重编失败 —— Electron 起来后会在打开数据库时报 DB_UNAVAILABLE。\n" +
      "可手动重试：pnpm native:electron",
  )
  process.exit(rebuilt.status ?? 1)
}

/**
 * ★ 五个变量一起传。`buildEnv` 继承 `process.env`（见 runtime-env/binaries.ts），
 * 所以给 dev 进程设上就会一路透到每个 dws 子进程，不需要改业务代码。
 *
 * `MYCONTEXT_DEV_PORT` 必须换掉：renderer 的 vite dev server 默认 5273，
 * 与日常实例**同一个端口**。不换的话第二个实例起不来
 * （`Error: Port 5273 is already in use`）—— 而"两个实例可以同时跑"
 * 正是这个沙箱的意义。`electron.vite.config.ts::resolveDevPort` 认这个变量
 * （真实环境变量优先于 .env）。
 *
 * 用 `exec electron-vite dev` 而不是 `pnpm --filter … dev`：后者的 dev 脚本
 * 里串了 `rebuild-electron`（上面已经跑过），但**根**的 `pnpm dev` 还串了
 * `prepare:bin` —— 那个会覆盖日常那份 resources/bin。
 */
const dev = spawnSync("pnpm", ["--filter", "@mycontext/desktop", "exec", "electron-vite", "dev"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    MYCONTEXT_BIN_DIR: sandboxBin,
    MYCONTEXT_DATA_DIR: dataDir,
    MYCONTEXT_DEV_PORT: devPort,
    DWS_KEYCHAIN_DIR: keychainDir,
    DWS_DISABLE_KEYCHAIN: "1",
  },
})
process.exit(dev.status ?? 0)
