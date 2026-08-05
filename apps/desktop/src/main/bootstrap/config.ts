/**
 * 配置装载：把 .env 与真实环境变量交给 kernel 的 loadConfig。
 *
 * .env 只在开发态读取：打包后的应用不应依赖工作目录里的文件
 * （用户双击启动时 cwd 不确定），生产配置走真实环境变量或后续的下发机制。
 *
 * 这里不写 process.env：让优先级判定完全由 loadConfig 决定，
 * 否则「.env 覆盖了真实环境变量」这类问题会变得难以追查。
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loadConfig, parseEnvFile, type LoadedConfig } from "@mycontext/kernel"

export interface ConfigBootstrapResult {
  config: LoadedConfig
  dotenvLoaded: boolean
  dotenvPath: string | undefined
}

/** 向上找到根为止的层数上限：够覆盖 monorepo 深度，又不会走到用户主目录之外。 */
const MAX_LOOKUP_DEPTH = 5

/**
 * 逐级向上找 .env。
 *
 * 不能只看 cwd：electron-vite 启动 Electron 时 cwd 是 `apps/desktop`，
 * 而 .env 在仓库根（与 electron.vite.config.ts 读端口用的是同一份）。
 * 只看 cwd 的话 .env 会被静默忽略——配置悄悄回落到内置默认值，
 * 而「我改了 .env 为什么没生效」这类问题极难查。
 *
 * 也不写死「上跳两级」：那会把布局假设钉在代码里，
 * 以后换目录层级或直接在仓库根启动都会再坏一次。
 */
function findDotenv(from: string): string | undefined {
  let dir = from
  for (let depth = 0; depth <= MAX_LOOKUP_DEPTH; depth += 1) {
    const candidate = join(dir, ".env")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function bootstrapConfig(options: {
  packaged: boolean
  cwd?: string
}): ConfigBootstrapResult {
  let dotenv: Record<string, string> | undefined
  let dotenvPath: string | undefined

  if (!options.packaged) {
    const found = findDotenv(options.cwd ?? process.cwd())
    if (found !== undefined) {
      try {
        dotenv = parseEnvFile(readFileSync(found, "utf8"))
        dotenvPath = found
      } catch {
        // 读到了但解析/读取失败：按「没有 .env」处理，走默认值 + 真实环境变量。
        dotenv = undefined
        dotenvPath = undefined
      }
    }
  }

  return {
    config: loadConfig({
      env: process.env,
      ...(dotenv === undefined ? {} : { dotenv }),
    }),
    dotenvLoaded: dotenv !== undefined,
    dotenvPath,
  }
}
