/**
 * mycontext 的 Python 环境：启动时准备 + 激活。
 *
 * ## 为什么要在启动路径上做这件事
 *
 * kl（知识图谱）是 Python 写的。此前依赖"本机 python3"，真实机器上站不住：
 * **macOS 自带的是 3.9.6，而 kl 要求 ≥3.10**；同事机器上是 homebrew 3.13
 * 才碰巧能用。表现是 kl-server `exit 3`，日志里只有退出码 ——
 * agent 能说话但**查不了图谱**，而两件事很难联系起来（真实踩过）。
 *
 * 现在：解释器**随包分发**（按需下载 + 官方 sha256 校验），用它建一个共用
 * venv，启动时装好依赖并**激活**给所有 Python 子进程。
 *
 * ## 「激活」在这里是什么意思
 *
 * 就是 `source <venv>/bin/activate` 干的那三件事，以 env 注入的形式给到
 * 每个我们 spawn 的 Python 子进程：
 *
 * ```
 * VIRTUAL_ENV=<venv>            PATH="<venv>/bin:$PATH"        unset PYTHONHOME
 * ```
 *
 * 注入而不是 source 那个脚本：`activate` 是给交互式 shell 写的（要改当前
 * shell 状态，且 bash/zsh/fish/PowerShell 各一版），而我们不经过 shell。
 * 注入 env 的结果与它一致且跨平台统一 —— 实测：激活后从任意 cwd 起子进程，
 * 裸 `python` 命中 venv 且能 import kl 的依赖。
 *
 * ## 与 `pnpm setup:python` 的关系
 *
 * 判据与安装动作都在 `scripts/lib/python-env.mjs`，两边**共用一份实现**。
 * 刻意不在这里重写 pip 逻辑：两份实现迟早漂移，而"手动装是好的、
 * 自动装是坏的"那类差异最难查。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Logger } from "@mycontext/kernel"

/** 共用 env 模块的形状（那是 .mjs，动态 import 进来）。 */
export interface PythonEnvModule {
  ensurePythonEnv: (repoRoot: string, log?: (message: string) => void) => Promise<string | null>
  isPythonEnvReady: (repoRoot: string) => boolean
  relocateVenv: (repoRoot: string) => boolean
  installKlWrapper: (repoRoot: string, log?: (message: string) => void) => void
  venvPython: (repoRoot: string) => string
  venvEnv: (repoRoot: string, baseEnv?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}

/**
 * 准备好的 Python 环境。
 *
 * `env` 就是"激活后的环境"——起 Python 子进程时把它整个传给 spawn，
 * 那个进程就在 venv 里（裸 `python`/`pip`/`kl` 都命中它）。
 */
export interface PythonEnv {
  /** venv 解释器的绝对路径（spawn 的 executable 用它，不依赖 PATH 解析）。 */
  python: string
  /** 激活后的环境变量（VIRTUAL_ENV / PATH / 清掉 PYTHONHOME）。 */
  env: NodeJS.ProcessEnv
}

/**
 * 从 klRoot 反推仓库根。
 *
 * klRoot 是 `<repo>/kl-graph`（见 paths.ts 的 resolveKlRoot），上跳**一级**即仓库根。
 *
 * ★ 曾经是两级 —— kl 那时在 `<repo>/external/kl-graph`。导入真实 commit 历史时
 * 那层 `external/` 去掉了（见那次合并的 message），于是这里必须同步减一级。
 * 少改这一处的表现是：反推出 `<repo>/..`，也就是**仓库外面**那个目录，
 * 于是 `loadModule` 找不到 `scripts/lib/python-env.mjs` 而 return null，
 * 上层判"python 由别处管"→ 静默降级，kl 永远起不来且不报错。
 * 打包态更糟：反推到 `Contents/`，解释器 / mjs / requirements 三样全不在那儿。
 *
 * 这个反推同时约束**打包态的资源布局**：`Resources/` 必须镜像仓库布局，
 * 于是 kl 落在 `Resources/kl-graph` 而不是 `Resources/`。见 resolveKlRoot 的注释
 * 与 `electron-builder.yml` 的 extraResources。
 */
function repoRootFrom(klRoot: string): string {
  return join(klRoot, "..")
}

/**
 * 载入共用的 `.mjs` 实现。
 *
 * ★ 为什么绕一层 `createRequire` 而不是直接 `await import(url)`：
 * Vite 的 `vite:dynamic-import-vars` 插件会去分析带模板字符串的 `import()`,
 * 并试图在**构建期**把它变成静态映射 —— 于是报
 * `File URL host must be "localhost" or empty`（它把 `file://<绝对路径>`
 * 当成了要解析的 URL）。而我们要的恰恰是**运行时**按真实路径加载：
 * 那个文件在仓库里、不属于 bundle。
 *
 * 做法：把 `import()` 藏进 `new Function` 里 —— 构建期静态分析看不到它，
 * 运行时才真正求值。路径用 `pathToFileURL` 规范化（Windows 的盘符路径
 * 直接拼 `file://` 是错的，这个函数会处理）。
 */
async function loadModule(repoRoot: string): Promise<PythonEnvModule | null> {
  const file = join(repoRoot, "scripts", "lib", "python-env.mjs")
  if (!existsSync(file)) return null
  // 间接引用：把 import 藏在一个动态求值的函数里，构建期分析不到它。
  const dynamicImport = new Function("path", "return import(path)") as (
    path: string,
  ) => Promise<PythonEnvModule>
  return dynamicImport(pathToFileURL(file).href)
}

/**
 * 准备并激活 Python 环境。幂等 —— 已就绪时不联网、不装任何东西。
 *
 * @returns 激活好的环境；不可用时 null（调用方降级并明示原因）
 */
export async function ensurePythonEnv(
  klRoot: string,
  logger: Logger,
  /**
   * 载入器的注入点，只给测试用。
   *
   * 默认那条路走 `new Function` 藏起来的 `import()`（见 loadModule 的注释），
   * 而那个技巧在 vitest 里同样不可用（"A dynamic import callback was not
   * specified"）—— 它躲开静态分析的代价就是躲开了模块运行时。生产行为必须
   * 保留，所以给测试留一个缝，而不是把 loadModule 改成可被 mock 的形状。
   */
  load: (repoRoot: string) => Promise<PythonEnvModule | null> = loadModule,
): Promise<PythonEnv | null> {
  const repoRoot = repoRootFrom(klRoot)
  const module = await load(repoRoot)
  if (module === null) {
    logger.debug("python-env helper not found; assuming python is managed elsewhere")
    return null
  }

  // 已就绪：直接返回激活环境，不打日志（启动路径每次都会走到这里）。
  if (module.isPythonEnvReady(repoRoot)) {
    /**
     * ★ 「就绪」不等于「能跑」，所以这里也要重定位一次。
     *
     * `isPythonEnvReady` 只看两件事：venv 解释器在不在、依赖指纹对不对。
     * 两者都跟**路径**无关，而入 git 的 venv 恰恰在路径上绑死了生成它那台
     * 机器：`pyvenv.cfg` 的 `home =` 是绝对路径。换一台机器 clone 下来，
     * 指纹照样对得上（那是 requirements 的 hash），于是判定「就绪」，
     * 而解释器一起来就 `ModuleNotFoundError: No module named 'encodings'`
     * —— 连 stdlib 都找不到。
     *
     * 实测：`home` 指着 `/Users/<另一个人>/...` 时 kl-server 每次启动即退，
     * 日志里只有那行 encodings 报错，而「python 环境就绪」是 true。
     *
     * `relocateVenv` 幂等且只在值变了时写盘，所以放在启动路径上没有代价。
     * 共用的 `.mjs` 在自己的 ready 分支里也做同一件事（见其注释），
     * 这里漏掉就等于 app 走的那条路比脚本少一步。
     */
    module.relocateVenv(repoRoot)
    /**
     * ★ wrapper 同理 —— 它跟 `pyvenv.cfg` 是**同一类**问题的两个受害者。
     *
     * `vendor/python/<platform>/venv/bin/kl` 也入了 git，而里面那两行是
     * 绝对路径（`cd "<repo>/kl-graph"` + venv 解释器）。于是换一个
     * checkout 之后 `pyvenv.cfg` 被上面那行修好了，wrapper 却还指着**生成它
     * 那台机器**的目录 —— agent 跑裸 `kl` 直接 `cd: ... No such file or
     * directory`，而这一页上「python 环境就绪」仍然是 true。
     *
     * 实测：搜索 agent 的会话日志里是
     * `.../venv/bin/kl: line 4: cd: /Users/<另一处>/kl-graph:
     * No such file or directory`，而 kl-server 自己好得很（`/health` ok、
     * 8200 端口在听、图里 1570 实体 / 4570 事实）—— 因为主进程 spawn server
     * 用的是**绝对路径**，只有走 PATH 的裸 `kl` 会踩到 wrapper。
     * 这个不对称让它看起来像"检索坏了"而不是"wrapper 路径错了"。
     *
     * 写盘代价是一个 348 字节的文件，幂等，放在启动路径上无所谓。
     * `.mjs` 的 ready 分支本来就调它（见其注释），这里补齐。
     *
     * ★★ 压平态（打包）由 `.mjs` **自己**分流（写进解释器 bin 而不是
     * 不存在的 `venv/bin`，且写失败会被它吞掉）。这里刻意**不**加打包态
     * 判断 —— 判据留在 `.mjs` 一处，两边同时判就会漂移。
     * 打包实测过这条路的代价：它原来会 ENOENT 抛出，被下面的 catch 报成
     * 「Python 环境没准备好，跑 pnpm setup:python」，而环境是完全健康的。
     */
    module.installKlWrapper(repoRoot)
    return {
      python: module.venvPython(repoRoot),
      env: module.venvEnv(repoRoot, process.env),
    }
  }

  logger.info("preparing python environment (first run downloads ~24MB and installs deps)")
  const python = await module
    .ensurePythonEnv(repoRoot, (message) => logger.info(`setup-python: ${message}`))
    .catch((error: unknown) => {
      logger.warn("python environment preparation threw", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return null
    })
  if (python === null) {
    logger.warn("python environment unavailable; kl (graph) will not start")
    return null
  }
  logger.info("python environment ready", { python })
  return { python, env: module.venvEnv(repoRoot, process.env) }
}
