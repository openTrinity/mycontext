/**
 * 测试侧的 opencode 定位。
 *
 * ## ★ 优先级必须与生产**同序**（这里曾经漂过，代价是假红 + 排查跑偏）
 *
 * 生产是 `RuntimeEnv.tryResolveOpencode()`（`packages/runtime-env/src/binaries.ts`），
 * 顺序是 **bundled → env → home → PATH**，第一档是
 * `resources/bin/opencode-<plat>-<arch>` —— 那是 `pnpm prepare:bin` 从 npm
 * 平台包拷来的、版本被 `package.json` 钉住的那一份。
 *
 * 这里原来**缺了 bundled 那一档**，于是在装过 opencode 的开发机上
 * 命中 `~/.opencode/bin/opencode`（本机实测 **1.15.5**，而钉住的是 1.18.11）。
 * 后果是 externals 测的不是产品实际会跑的那个二进制：真实踩过 ——
 * 送图那条端到端在 1.15.5 上 2 秒返回空文本（session 都没起来），
 * 而同一份代码在 1.18.11 上正确回答。**排查方向被带偏了整整一轮**：
 * 看起来像"我们的图没送对"，其实是跑错了二进制。
 *
 * env 变量名也对齐生产的 `MYCONTEXT_OPENCODE_BIN`（这里原来写的是
 * `MYCONTEXT_OPENCODE_PATH`，没有任何地方设它 —— 那一档形同不存在）。
 * 旧名保留为回退，免得谁的本地脚本还在用。
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ResolvedOpencode {
  path: string
  kind: "bundled" | "env" | "home" | "path"
}

/** 与 `binaries.ts` 的 `binaryFileName` 同一套命名。 */
function bundledName(): string {
  const arch = process.arch === "x64" ? "x64" : process.arch
  const suffix = `${process.platform}-${arch}`
  return process.platform === "win32" ? `opencode-${suffix}.exe` : `opencode-${suffix}`
}

export function resolveOpencode(): ResolvedOpencode | null {
  /**
   * ① bundled —— **产品实际跑的那一份**，所以排第一（与生产同序）。
   * 从这个文件（`tests/helpers/`）上跳两级到仓库根。
   */
  const bundled = join(import.meta.dirname, "../..", "apps/desktop/resources/bin", bundledName())
  if (existsSync(bundled)) return { path: bundled, kind: "bundled" }

  // ② 显式覆盖（联调换版本）。生产用的是 MYCONTEXT_OPENCODE_BIN。
  const fromEnv = process.env["MYCONTEXT_OPENCODE_BIN"] ?? process.env["MYCONTEXT_OPENCODE_PATH"]
  if (fromEnv !== undefined && fromEnv !== "" && existsSync(fromEnv)) {
    return { path: fromEnv, kind: "env" }
  }
  const fromHome = join(homedir(), ".opencode/bin/opencode")
  if (existsSync(fromHome)) return { path: fromHome, kind: "home" }
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir === "") continue
    const candidate = join(dir, "opencode")
    if (existsSync(candidate)) return { path: candidate, kind: "path" }
  }
  return null
}
