/**
 * 数据目录解析。
 *
 * 开发态与打包态用不同的目录名，避免开发数据污染正式安装的用户数据。
 * MYCONTEXT_DATA_DIR 可显式覆盖（开发/测试用），但打包态忽略以防误配置。
 *
 * 为什么显式 setPath 而不只是 setName：Electron 在应用启动早期就依据
 * 最近的 package.json 的 name 解析出 userData 路径，之后再 setName 不一定
 * 会回溯修正。而在 pnpm workspace 下用 `--filter` 启动时，最近的 name 是
 * `@mycontext/desktop`，会得到 `.../Application Support/@mycontext/desktop`
 * 这种带斜杠的怪异路径。因此这里始终显式指定目录，不依赖隐式推导。
 */
import { app } from "electron"
import { join } from "node:path"
import { mkdirSync } from "node:fs"

export interface AppPaths {
  userData: string
  /** 控制库：账号、应用级设置、会话 token 与签名密钥 */
  controlDatabase: string
  /** 各账号 vault 的根目录（`vaults/<vaultId>/core.sqlite`） */
  vaultsRoot: string
  logs: string
  logFile: string
  /** 随包分发的可执行文件目录 */
  binDir: string
  /**
   * 随包分发的 skill 目录（`kl` 等）。
   *
   * 与 binDir 同一套解析规则：打包态在 `process.resourcesPath/skills`，
   * 开发态在仓库的 `apps/desktop/resources/skills`。
   * agent 的 workspace 里要有它才用得上图谱查询 —— 光同步到资源目录
   * 而不放进 workspace，agent 是看不到的（skill 的发现是按 cwd 走的）。
   */
  skillsDir: string
  /**
   * 随包分发的 forge 蒸馏引擎目录（Python 源码，`python3 -m forge` 的 cwd）。
   *
   * 与 binDir 同一套解析规则。它是**目录而不是可执行文件**，所以不走
   * runtime-env 的 binaries 解析：那套按 `-{platform}-{arch}` 后缀找单文件，
   * 而 forge 是纯 stdlib Python，一份源码在所有平台通用。
   */
  forgeDir: string
  /** DWS 的配置目录（隔离 profiles 与日志；token 由 Keychain 共享，隔离不了） */
  dwsHome: string
  /**
   * 与算法团队共享的目录。
   *
   * 单独一个根目录而不是散落在 userData 下：他们要在这里读导出物与
   * handoff.json、写自己的索引数据。一个明确的边界让「哪些是共享的」
   * 一眼可见，也让权限与清理有个统一的落点。
   */
  sharedRoot: string
  /**
   * Agent 的 workspace 根目录。
   *
   * 每个会话一个子目录（`search/<sessionId>` / `persona/<conversationId>`）：
   * agent 只能看到自己那个目录，这既是上下文隔离也是隐私边界。
   */
  agentWorkspaces: string
  /**
   * Agent 子进程用的隔离 HOME。
   *
   * ★ 不是可选的美化：opencode 从 `$HOME/.claude/skills` 发现 skill，继承宿主
   * HOME 会让用户自己装的**任意** skill 进入搜索 agent 的视野（实测泄漏 8 个，
   * 其中一个正是专门检测隔离失效的探针）。指向这个空目录后，agent 只看得到
   * 我们铺进 workspace 的 kl。详见 spawn-hardening 的 `applyHomeIsolation`。
   */
  agentHome: string
  /**
   * kl-graph（Python 检索服务）代码根，含 `kl_server.py`。
   *
   * 开发态在仓库 `kl-graph`；打包态在 `resourcesPath/kl-graph` ——
   * `Resources/` 刻意镜像仓库布局（理由见 `resolveKlRoot`）。
   * 不存在时 kl 功能整体降级为"未集成"。
   */
  klRoot: string
}

/**
 * 目录名：打包态与开发态分开，便于并存与清理。
 *
 * 开发态刻意不叫 `MyContextDev`：同一台机器上的参考实现用的正是这个名字，
 * 两个项目共用一个 userData 目录时，任一方的「重置数据」都会连带
 * 删掉对方的库。
 */
export function resolveAppName(packaged: boolean): string {
  return packaged ? "MyContext" : "MyContextDevelop"
}

/**
 * 预置二进制目录。
 *
 * 打包态在 process.resourcesPath/bin（electron-builder 的 extraResources 落点）；
 * 开发态在仓库的 apps/desktop/resources/bin。main 产物位于 out/main，
 * 因此相对它上跳两级到 apps/desktop。
 */
function resolveBinDir(packaged: boolean, mainDir: string): string {
  return packaged ? join(process.resourcesPath, "bin") : join(mainDir, "../../resources/bin")
}

/** skill 目录。与 binDir 同一套规则（见 AppPaths.skillsDir）。 */
function resolveSkillsDir(packaged: boolean, mainDir: string): string {
  return packaged ? join(process.resourcesPath, "skills") : join(mainDir, "../../resources/skills")
}

/**
 * kl-graph 代码根。
 *
 * 开发态：main 产物在 `out/main`，上跳到仓库根再进 `kl-graph`
 * （`../../../../kl-graph`：out/main → out → apps/desktop → apps → repo）。
 *
 * ## ★★ 打包态是 `Resources/kl-graph`，而 `Resources/` **镜像仓库布局**
 *
 * `services/python-env.ts` 的 `repoRootFrom(klRoot)` 会从这个路径**上跳一级**
 * 反推"仓库根"，再据此找内置解释器、`scripts/lib/python-env.mjs`、
 * `requirements.txt`。于是 `Resources/` 只要镜像仓库布局，那个反推就继续成立：
 * ```
 * Resources/kl-graph  →  上跳一级 = Resources/
 *   ⇒ 解释器 = Resources/vendor/python/darwin-arm64/python   ✓
 *   ⇒ mjs    = Resources/scripts/lib/python-env.mjs          ✓
 *   ⇒ reqs   = Resources/kl-graph/requirements.txt           ✓
 * ```
 * ★ 层级数与 `repoRootFrom` 是**同一个约定的两半**：这里深一层、那里就得多跳
 * 一级。曾经是 `external/kl-graph` + 上跳两级，导入真实 commit 历史时那层
 * `external/` 去掉了，两边同时减一。只改一边的表现是反推落到仓库外/`Contents/`，
 * 而**开发态可能一切正常** —— 因为仓库外那一级恰好也可能存在。
 *
 * 对应的 `extraResources` 落点在 `apps/desktop/electron-builder.yml`（有注释
 * 指回这里）。两边必须同时改。
 */
function resolveKlRoot(packaged: boolean, mainDir: string): string {
  return packaged ? join(process.resourcesPath, "kl-graph") : join(mainDir, "../../../../kl-graph")
}

/** forge 引擎目录。与 binDir 同一套规则（见 AppPaths.forgeDir）。 */
function resolveForgeDir(packaged: boolean, mainDir: string): string {
  return packaged ? join(process.resourcesPath, "forge") : join(mainDir, "../../resources/forge")
}

export function resolveAppPaths(options: {
  dataDirOverride?: string
  /** 主进程产物所在目录（import.meta.dirname），用于推导开发态资源路径 */
  mainDir: string
}): AppPaths {
  const packaged = app.isPackaged
  const appName = resolveAppName(packaged)
  app.setName(appName)

  const { dataDirOverride } = options
  const target =
    !packaged && dataDirOverride !== undefined && dataDirOverride !== ""
      ? dataDirOverride
      : join(app.getPath("appData"), appName)

  mkdirSync(target, { recursive: true })
  app.setPath("userData", target)

  const userData = app.getPath("userData")
  const logs = join(userData, "logs")
  mkdirSync(logs, { recursive: true })

  // DWS 的 profiles/日志放应用数据目录，与用户终端里的 ~/.dws 分开。
  const dwsHome = join(userData, "channels", "dingtalk", "dws-home")
  mkdirSync(dwsHome, { recursive: true })

  // 与算法团队共享的根目录。子目录（exports/dws、kl）由各自的写入方按需创建。
  const sharedRoot = join(userData, "shared")
  mkdirSync(sharedRoot, { recursive: true })

  // Agent workspace：每个会话一个子目录，由服务按需创建。
  const agentWorkspaces = join(userData, "agents")
  mkdirSync(agentWorkspaces, { recursive: true })

  // Agent 子进程的隔离 HOME。**必须真实存在**：opencode 起来会往 HOME 下写
  // 配置/缓存，指向不存在的路径会让它启动失败。
  const agentHome = join(userData, "agent-home")
  mkdirSync(agentHome, { recursive: true })

  return {
    userData,
    controlDatabase: join(userData, "control.sqlite"),
    vaultsRoot: join(userData, "vaults"),
    logs,
    logFile: join(logs, `app-${new Date().toISOString().slice(0, 10)}.jsonl`),
    binDir: resolveBinDir(packaged, options.mainDir),
    skillsDir: resolveSkillsDir(packaged, options.mainDir),
    forgeDir: resolveForgeDir(packaged, options.mainDir),
    dwsHome,
    sharedRoot,
    agentWorkspaces,
    agentHome,
    klRoot: resolveKlRoot(packaged, options.mainDir),
  }
}
