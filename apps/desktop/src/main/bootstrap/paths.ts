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
  /**
   * ★★ 以下三个字段是**存量迁移用的旧落点**，新代码一律不要读它们。
   *
   * 隔离维度已经从"本地账号"改成"渠道身份"，而这三处原来是**应用级**的
   * （也就是跨身份共用）：
   * ```
   * legacyDwsHome    → vaults/<id>/channels/dingtalk/dws-home
   * legacySharedRoot → vaults/<id>/{kl,exports/dws,handoff.json}
   * legacyAgentHome  → vaults/<id>/agent-home  +  <userData>/agent-npm-cache
   * ```
   * 当前落点一律走 `VaultStore.paths(vaultId)`（那是唯一真源，
   * 见它的注释：给一个对象让"漏了一个"变成编译错误）。
   *
   * 保留这三个只为让迁移脚本能找到旧数据；迁移完成后它们应当是空的，
   * 而迁移脚本的最后一步会**断言**这一点 —— 留一个就是留了一条
   * "老 vault 走老路径"的分支，而那正是「改 userData 目录名静默关掉
   * 数据检查」那次事故的形状。
   */
  legacyDwsHome: string
  legacySharedRoot: string
  legacyAgentHome: string
  /**
   * Agent 子进程用的 npm 缓存（**应用级，刻意不按 vault 分**）。
   *
   * ## ★ 为什么它与 agentHome 分开
   *
   * `agentHome` 里原来同时装着两类东西：opencode 的配置与 session 锁
   * （`.config` / `.local/state`，**会随会话产生状态** → 必须按身份分），
   * 以及 `.npm/_cacache`（**registry 的只读镜像**，实测 325 MB，
   * key 全形如 `registry.npmjs.org/...`）。
   *
   * 后者按身份各拷一份是纯浪费：两个身份 650 MB、五个 1.6 GB，
   * 全是同一批包的副本，而且首次切身份还要重新联网拉一遍。
   * npm 本来就有 `npm_config_cache` 这个正交旋钮，用它把"缓存"从"HOME"里
   * 拆出来 —— 隔离与体积两个目标就都成立。
   *
   * ★ 里面**没有**任何身份/会话字节：逐项验过（本机的组织名/用户花名/
   * `openConversationId` 命中 0 个文件；一条宽正则 `cid[A-Za-z0-9+/]{20}`
   * 扫到的 19 个命中追进去全是 `web-tree-sitter` 等包元数据里 integrity
   * hash 的片段 —— 假阳性）。
   */
  agentNpmCache: string
  /**
   * kl-graph（Python 检索服务）代码根，含 `kl_server.py`。
   *
   * 开发态在仓库 `kl-graph`；打包态在 `resourcesPath/kl-graph` ——
   * `Resources/` 刻意镜像仓库布局（理由见 `resolveKlRoot`）。
   * 不存在时 kl 功能整体降级为"未集成"。
   */
  klRoot: string
  /**
   * 「仓库根」—— 内置 Python 与运行时要 import 的 `.mjs` 都挂在它下面。
   *
   * 开发态是真的仓库根；打包态是 `Resources/`（它**镜像仓库布局**，
   * 所以 `vendor/python/<plat>/python`、`scripts/lib/*.mjs` 这些相对路径
   * 在两种形态下是同一个 —— 见 `resolveKlRoot` 的注释与 electron-builder.yml）。
   *
   * ★ 与 `klRoot` 是**同一个约定的两半**：这里 = klRoot 上跳一级。
   * `services/python-env.ts` 的 `repoRootFrom()` 做的是同一件事（那条路
   * 拿到的只有 klRoot，所以留着）—— 层数改了两边都要动。
   */
  repoRoot: string
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

  /**
   * ★★ 以下三个是**旧落点**，只为迁移脚本能找到存量数据而保留。
   *
   * 它们原来是应用级的（跨身份共用），现在各自的当前落点在 vault 内
   * （见 `AppPaths.legacy*` 的注释与 `VaultStore.paths()`）。
   *
   * ★ 刻意**不再 mkdir**：新装机不该凭空多出三个永远为空的目录，
   * 而"目录存在"会让迁移脚本那条"迁完应当为空"的断言失去意义
   * （分不清"空目录"与"没有过数据"）。旧装机上它们本来就在。
   */
  const legacyDwsHome = join(userData, "channels", "dingtalk", "dws-home")
  const legacySharedRoot = join(userData, "shared")
  const legacyAgentHome = join(userData, "agent-home")

  /**
   * Agent 子进程的 npm 缓存（应用级，见 `AppPaths.agentNpmCache`）。
   * **必须真实存在**：npm 对不存在的 cache 目录会自己建，但我们提前建
   * 是为了让权限与位置在第一次 spawn 之前就确定。
   */
  const agentNpmCache = join(userData, "agent-npm-cache")
  mkdirSync(agentNpmCache, { recursive: true })

  const klRoot = resolveKlRoot(packaged, options.mainDir)

  return {
    userData,
    controlDatabase: join(userData, "control.sqlite"),
    vaultsRoot: join(userData, "vaults"),
    logs,
    logFile: join(logs, `app-${new Date().toISOString().slice(0, 10)}.jsonl`),
    binDir: resolveBinDir(packaged, options.mainDir),
    skillsDir: resolveSkillsDir(packaged, options.mainDir),
    forgeDir: resolveForgeDir(packaged, options.mainDir),
    legacyDwsHome,
    legacySharedRoot,
    legacyAgentHome,
    agentNpmCache,
    klRoot,
    // 上跳一级 —— 与 `services/python-env.ts` 的 `repoRootFrom()` 同一个约定。
    repoRoot: join(klRoot, ".."),
  }
}
