#!/usr/bin/env node
/**
 * 真进程验「发出去的那条是哪一条」这条关联链（**会真的发一条消息**）。
 *
 * ## 为什么这个探针必须存在
 *
 * `dws chat message send` 只返回 `openTaskId`，**没有** `openMessageId`
 * （实测；见 `dingtalk/send.ts` 的 `readTaskId` 注释）。消息 id 要再走一跳
 * `query-send-status`。这条链断掉的后果是一整串静默失效：
 *
 * `sent_message_external_id` 为 NULL → `claimAgentOrigin` 匹配不到
 * → `messages.origin` 恒 `human` → 界面上分不出哪条是分身发的
 * → 分身的回复被当本人语料再蒸一遍（自我强化漂移）。
 *
 * ★ 单测锁不住这一条：它用的是我们自己编的 payload。而这个 bug 的成因
 * **恰恰**是"编的形状与真实返回不一样"—— 那时单测全绿而链是断的
 * （实测：13 条旧断言全通过，库里 32 条已发全部 NULL）。
 *
 * ## 只发给自己
 *
 * 目标固定是当前登录用户（`--user` 自己的 userId），正文带【mycontext 自检】
 * 前缀。不接受任意目标参数：一个"能给任意人发消息"的脚本放在仓库里，
 * 迟早会有人手滑。
 *
 * ```bash
 * node scripts/check-send-linkage.mjs
 * ```
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-sendlink-"))
const outFile = join(outDir, "check.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/check-send-linkage-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: {
      ...workspaceAlias(),
      // 这条路径不碰 dialog；桩会在真被调到时抛（见那个文件）
      electron: join(root, "scripts/lib/electron-stub.mjs"),
    },
    logLevel: "silent",
  })

  const { runSendLinkageCheck } = await import(`file://${outFile}`)
  const report = await runSendLinkageCheck({
    binDir: join(root, "apps/desktop/resources/bin"),
    /**
     * ★ 用**应用自己的** DWS profile 目录 —— 登录态在那里。
     * 给一个临时空目录会让命令以"未登录"失败，而那看起来与
     * "关联链断了"一模一样（都是发送失败）。
     */
    dwsConfigDir: join(
      homedir(),
      "Library/Application Support/MyContextDevelop/channels/dingtalk/dws-home",
    ),
  })

  console.log(`send 返回：${JSON.stringify(report.send)}`)
  console.log(`query-send-status 返回：${JSON.stringify(report.status)}`)
  console.log("")

  /**
   * ★ 判据是**拿到了 openMessageId**，不是"发送成功"。
   *
   * 发送成功在这个 bug 下是恒真的 —— 命令返回 `success: true`，
   * 只是我们没有任何东西能把它与采集回来的那条对上。
   */
  const failures = []
  if (report.send === null) failures.push("发送失败（看上面的返回）")
  else {
    if (report.send.taskId === undefined || report.send.taskId === null) {
      failures.push("★ 没拿到 taskId —— readTaskId 没读到 openTaskId，就是那个 bug")
    }
    if (report.status === null) {
      failures.push("★ 换不到 openMessageId（query-send-status 没返回 id）")
    } else if (typeof report.status.externalId !== "string" || report.status.externalId === "") {
      failures.push("★ openMessageId 是空的")
    }
  }

  if (failures.length > 0) {
    console.error("✗ 关联链断了：")
    for (const failure of failures) console.error(`  · ${failure}`)
    /**
     * 「跑不起来/断言不成立必须 exit 1」—— 静默 exit 0 的门禁比没有门禁更糟，
     * 因为它给出的是"已验证"的假信号。
     */
    process.exit(1)
  }

  console.log(
    `✓ 关联链通了：openTaskId → openMessageId=${report.status.externalId}` +
      `（delivered=${String(report.status.delivered)}）`,
  )
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
