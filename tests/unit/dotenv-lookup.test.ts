/**
 * .env 定位测试。
 *
 * 这里存在的理由是一个真实缺陷：`bootstrapConfig` 原来只在 `process.cwd()` 下找 .env，
 * 而 electron-vite 启动 Electron 时 cwd 是 `apps/desktop`，.env 在仓库根——
 * 于是 .env 被**静默忽略**，配置悄悄回落到内置默认值。
 * 没有报错、界面上也只显示「.env 已读取：否」，因此没人发现。
 *
 * 这组用例锁的就是「cwd 不是 .env 所在目录」这个形态。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { bootstrapConfig } from "@main/bootstrap/config"

const dirs: string[] = []

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-dotenv-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe("从 cwd 向上找 .env", () => {
  it("cwd 就是 .env 所在目录时能读到", () => {
    const root = repo()
    writeFileSync(join(root, ".env"), "MYCONTEXT_LOG_LEVEL=debug\n")

    const result = bootstrapConfig({ packaged: false, cwd: root })
    expect(result.dotenvLoaded).toBe(true)
    expect(result.dotenvPath).toBe(join(root, ".env"))
    expect(result.config.values.logLevel).toBe("debug")
  })

  /**
   * 这条是缺陷的直接复现：cwd 在子目录里。
   * electron-vite 就是这样启动主进程的。
   */
  it("cwd 在子目录（apps/desktop）时仍能找到仓库根的 .env", () => {
    const root = repo()
    writeFileSync(join(root, ".env"), "MYCONTEXT_LOG_LEVEL=warn\n")
    const nested = join(root, "apps", "desktop")
    mkdirSync(nested, { recursive: true })

    const result = bootstrapConfig({ packaged: false, cwd: nested })
    expect(result.dotenvLoaded).toBe(true)
    expect(result.dotenvPath).toBe(join(root, ".env"))
    expect(result.config.values.logLevel).toBe("warn")
  })

  it("就近优先：子目录自己有 .env 时不再往上找", () => {
    const root = repo()
    writeFileSync(join(root, ".env"), "MYCONTEXT_LOG_LEVEL=error\n")
    const nested = join(root, "apps", "desktop")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, ".env"), "MYCONTEXT_LOG_LEVEL=debug\n")

    const result = bootstrapConfig({ packaged: false, cwd: nested })
    expect(result.dotenvPath).toBe(join(nested, ".env"))
    expect(result.config.values.logLevel).toBe("debug")
  })

  it("没有 .env 时不抛错，回落到默认值", () => {
    const result = bootstrapConfig({ packaged: false, cwd: repo() })
    expect(result.dotenvLoaded).toBe(false)
    expect(result.dotenvPath).toBeUndefined()
    expect(result.config.values.logLevel).toBe("info")
  })

  /**
   * 打包态一律不读 .env：用户双击启动时 cwd 不确定，
   * 顺着目录往上找有可能捞到一个完全无关的文件。
   */
  it("打包态不读 .env，哪怕它就在 cwd 里", () => {
    const root = repo()
    writeFileSync(join(root, ".env"), "MYCONTEXT_LOG_LEVEL=debug\n")

    const result = bootstrapConfig({ packaged: true, cwd: root })
    expect(result.dotenvLoaded).toBe(false)
    expect(result.config.values.logLevel).toBe("info")
  })
})
