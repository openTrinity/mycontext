import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("Persona 性能 UI 隔离门禁", () => {
  it("只使用临时数据根并拒绝发送类命令", () => {
    const source = readFileSync("scripts/run-isolated-persona-performance.mjs", "utf8")
    expect(source).toContain("mkdtempSync(join(tmpdir()")
    expect(source).toContain("MYCONTEXT_DATA_DIR")
    expect(source).toContain("--remote-debugging-port=0")
    expect(source).toContain("isolated test denied")
    expect(source).toContain("onboarding.completedAt")
    expect(source).toContain("ipcTimings.filter((item) => !item.ok)")
    expect(source).toContain("if (failedIpc.length > 0)")
    expect(source).toContain("Math.max(...outcome.ipcTimings.map((item) => item.ms))")
    expect(source).toContain("我的数字分身")
    expect(source).toContain("send_like")
    expect(source).not.toContain("127.0.0.1:5273")
    expect(source).not.toContain("MyContextDevelop")
  })

  it("正常、错误和超时路径都清理 Electron 与临时目录", () => {
    const source = readFileSync("scripts/run-isolated-persona-performance.mjs", "utf8")
    expect(source).toContain("finally")
    expect(source).toContain("rmSync(root, { recursive: true, force: true })")
    expect(source).toContain('child.kill("SIGKILL")')
    expect(source).toContain("clearTimeout(timer)")
  })
})
