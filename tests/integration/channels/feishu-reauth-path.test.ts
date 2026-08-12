/**
 * 集成断言：`config remove` 之后 `auth login` 会**先去绑应用**。
 *
 * 与单测的区别：这里跑**真的 CLI 二进制**，所以验的是它当前版本真实
 * 吐出来的错误串 —— 而"判据与真实错误串对不上"正是这轮的 bug 形态
 * （`not_configured` 有下划线、`client_id` 那种措辞完全不同）。
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FeishuAuth } from "../../../packages/channels/src/plugins/feishu/auth.js"
import { LarkCli } from "../../../packages/channels/src/plugins/feishu/cli.js"
import { ProcessRunner } from "../../../packages/runtime-env/src/index.js"

const noopLogger = (): never =>
  ({ debug() {}, info() {}, warn() {}, error() {}, child: () => noopLogger() }) as never

describe("重新授权的自愈路径（真 CLI）", () => {
  it("★★ 配置残缺时 login 会先跑 config init（不再撞 not_configured 死掉）", async () => {
    const root = mkdtempSync(join(tmpdir(), "mycontext-reauth-"))
    // 造出 `config remove` 之后的真实残留形态（实测：文件在、apps 为空）
    const configDir = join(root, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ apps: [] }))

    const seen: string[][] = []
    const runner = new ProcessRunner(noopLogger())
    const options = {
      processes: {
        exec: async (input: Parameters<ProcessRunner["exec"]>[0]) => {
          seen.push([...input.args])
          return runner.exec(input)
        },
        spawn: async (input: Parameters<ProcessRunner["spawn"]>[0]) => {
          seen.push([...input.args])
          // ★ config init 会**阻塞等用户在浏览器里点** —— 这里不真等，
          //   立刻返回失败即可：我们要验的是"有没有走到这一步"。
          return {
            exitCode: 1,
            stdout: "",
            stderr: "probe: not waiting for browser",
            durationMs: 1,
            timedOut: false,
            cancelled: false,
          }
        },
      } as never,
      logger: noopLogger(),
      authRoot: () => root,
      executable: "apps/desktop/resources/bin/lark-cli-darwin-arm64",
      platform: "darwin" as const,
      openExternal: async () => undefined,
    }
    const auth = new FeishuAuth(options, new LarkCli(options))
    await auth.login({ mode: "loopback", onProgress: () => undefined }).catch(() => undefined)

    const cmds = seen.map((a) => a.slice(0, 2).join(" "))
    /**
     * ★ 断言**整条序列**而不只是"含 config init"。
     *
     * 实测这个序列是：
     *
     *     config keychain-downgrade  →  auth login  →  config init
     *                                       ↑              ↑
     *                              撞 not_configured    自愈：去绑应用
     *
     * 修复前它停在第二步 —— 用户点多少次「重新授权」都是同一句英文报错。
     * 把顺序也锁住：`config init` 必须在 `auth login` **之后**
     * （提前跑等于每次授权都强迫用户重选应用，那是另一个 bug）。
     */
    expect(cmds).toEqual(["config keychain-downgrade", "auth login", "config init"])
  }, 60_000)
})
