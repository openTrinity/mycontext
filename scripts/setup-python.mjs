#!/usr/bin/env node
/**
 * 准备 mycontext 的共用 Python 环境（内置解释器 + venv + 依赖）。
 *
 * ## 为什么需要它
 *
 * kl（知识图谱）是 Python 写的，依赖约 280MB / 150+ 个包
 * （litellm、scipy、qdrant-client…）。而：
 *
 * · 依赖装出来的目录不入 git（体积 + 里面的 `.so` 跟平台和 Python 小版本绑定，
 *   在别人机器上不通用）；
 * · **本机的 python3 不能指望**：macOS 自带的是 3.9.6，而 kl 要求 ≥3.10。
 *
 * 于是 clone 下来就没有可用的 Python 环境，kl 一跑就 `ModuleNotFoundError`：
 * agent 能说话（模型走网关），但**查不了图谱**。真实踩过。
 *
 * 应用启动时会自己调同一套逻辑（见 services/kl-deps.ts），这个脚本是给
 * 「想显式装一次」「CI」「排查」用的同一个入口 —— 判据与动作都在
 * `scripts/lib/python-env.mjs`，两边共用一份实现。
 *
 * 用法：
 *   pnpm setup:python            # 缺了才装（幂等）
 *   pnpm setup:python --force    # 无条件重装（依赖改了 / 环境坏了）
 */
import { rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ensurePythonEnv, isPythonEnvReady, requirementFiles, venvDir } from "./lib/python-env.mjs"
import { PYTHON_VERSION, platformKey } from "./lib/python-runtime.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const force = process.argv.includes("--force")

if (requirementFiles(root).length === 0) {
  console.error("✗ 找不到 kl-graph/requirements.txt —— kl-graph 没导入进来？")
  console.error("  跑 `pnpm sync:kl-graph`（需要能访问上游仓库）。")
  process.exit(1)
}

if (force) {
  console.log("--force：删掉现有 venv 重建…")
  rmSync(venvDir(root), { recursive: true, force: true })
}

/**
 * ★ 就绪判断交给 `ensurePythonEnv` 自己做，这里**不**提前 return。
 *
 * 我第一版在这里加了 `if (isPythonEnvReady) exit(0)`，结果是"已就绪"时
 * 整个函数根本没被调用 —— 而它在就绪分支里还要补生成 `kl` wrapper。
 * 于是 wrapper 永远不生成，agent 跑 `kl` 命中上游那个硬编码旧路径的脚本。
 * 两处判断同一件事、其中一处还带副作用，那就是必然漂移的设计。
 */
console.log(`平台 ${platformKey()} · 内置 Python ${PYTHON_VERSION}`)
if (isPythonEnvReady(root)) console.log("  环境已就绪（依赖指纹一致），只做校验与补齐。")

const python = await ensurePythonEnv(root, (message) => console.log(`  ${message}`))
if (python === null) {
  console.error("✗ Python 环境准备失败（上面有具体原因）。")
  process.exit(1)
}

console.log("✓ 完成。")
console.log(`  解释器：${python}`)
console.log("  应用启动时会激活这个环境（VIRTUAL_ENV + PATH），所有 Python 子进程都在里面。")
