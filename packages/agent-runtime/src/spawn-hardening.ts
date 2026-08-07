/**
 * spawn `opencode acp` 的安全加固。
 *
 * ## 为什么必须做（这不是理论风险）
 *
 * 逐条核对过 opencode 的源码：
 * · `cli/cmd/acp.ts` 的 handler 里 `Server.listen(opts)` **起了一个 HTTP server**
 *   （ACP 的 stdio 只是前端，真正的 session/tool 状态在这个 HTTP server 上）；
 * · `server/auth.ts` 的 `required(config)` 在 `OPENCODE_SERVER_PASSWORD`
 *   未设或为空串时返回 **false**；
 * · `httpapi/middleware/authorization.ts` 的三处中间件全部是
 *   `if (!ServerAuth.required(config)) return 直接放行`；
 * · `server/cors.ts` 对**无 Origin 头直接 return true**、
 *   对任意 `http://localhost:*` 与 `http://127.0.0.1:*` 一律放行。
 *
 * → 本机任意进程、任意本机网页（一个 `fetch` 就够）都能注入自己的 MCP server、
 * 或直接驱动我们的 session。对一个「知道本人全部聊天记录、且宿主会替它发消息」
 * 的 agent，这是**本地权限提升通道**。
 *
 * ## 三条加固
 *
 * 1. 注入随机 `OPENCODE_SERVER_PASSWORD`（每次启动重新生成）；
 *    并且**没有密码就拒绝启动** —— 「忘了注入」必须是启动失败，
 *    而不是"跑起来了但没鉴权"（后者外观上完全正常，属静默失效）。
 * 2. 显式传 `--hostname 127.0.0.1`。默认值已经是它，但**默认值不是契约**
 *    （`cli/network.ts` 里 `--mdns` 会把它改成 `0.0.0.0`）。
 *    端口保持默认 0（随机）—— 随机端口比固定端口难被本机脚本猜到。
 * 3. `OPENCODE_PERMISSION` 用**白名单式 deny-all**，不是 deny 列表。
 *    实测 `agent/agent.ts:119` 的 defaults 是 `"*": "allow"` ——
 *    只 deny `edit`/`bash` 等于放行 `webfetch`，而 `tool/webfetch.ts:35`
 *    只校验 http(s) 前缀、**无域名白名单**。群消息里的一句 injection
 *    完全可以「读画像 → fetch 到攻击者服务器」把本人画像整份外传，
 *    全程没有一次写操作。
 */
import { randomBytes } from "node:crypto"
import { AppError } from "@mycontext/kernel"

/** 宿主工具的统一前缀。**不加前缀会与内建工具碰撞**，见 reverse-handlers 的注释。 */
export const HOST_TOOL_PREFIX = "mycontext_"

/**
 * 权限配置。
 *
 * `"*": "deny"` + `"mycontext_*": "allow"` 的顺序依赖：
 * 实测 `Permission.merge` 的实现是 `rulesets.flat()`（permission/index.ts:200）
 * + `findLast` 判定（同文件 210 行），而 `agent.ts:145` 的调用顺序是
 * `merge(defaults, …, user)` → **user 在最后所以我们的规则赢**。
 *
 * 这个顺序依赖是我们安全模型的地基。opencode 升级时改掉了它，
 * 我们**不会收到任何报错** —— 因此 `tests/externals/opencode-permission.test.ts`
 * 有一条「注入 deny-all 后 webfetch 确实不可用」的断言。
 */
export const DENY_ALL_PERMISSION = {
  "*": "deny",
  [`${HOST_TOOL_PREFIX}*`]: "allow",
} as const

/**
 * 在 deny-all 之上**精确放行 `kl` 命令**（不是放开 `bash`）。
 *
 * ## 为什么是这个形状（真进程锁定，见 opencode-permission.test）
 *
 * opencode 的 `bash` 权限支持**按命令 glob** 的对象形态
 * （`PermissionObjectConfig`：键是命令 glob，值是 allow/deny/ask，
 * 官方 config schema 确认）。判定沿用全局那套 `findLast` 语义 ——
 * **对象内最后一个匹配的键赢**，所以 `"*":"deny"` 必须写在最前、
 * 具体的 `"kl"/"kl *"` 放行写在其后（实测：反过来 `kl` 会被 `*` 挡住）。
 *
 * · `skill: "allow"` —— agent 靠 opencode 原生 skill 机制调用 kl（`/kl` 展开），
 *   skill 工具本身要放行，否则 `<cwd>/.opencode/skills/kl` 发现了也调不动。
 * · `bash: {"*":"deny","kl":"allow","kl *":"allow"}` —— skill 正文让 agent 跑
 *   `kl ask "…"` 这类命令，只有 `kl`（裸命令）和 `kl <args>` 放行，其余 bash
 *   全 deny。实测：`cat`/`head`/`pwd` 这类在此形态下**硬拒**（无 permission ask，
 *   直接不执行），只有 `kl*` 真的跑起来。
 *
 * ★ 放宽一条命令就是扩大攻击面，所以：不放开 bash、只放 `kl`，且有真进程断言
 * （opencode-permission.test 的「kl 允许、非 kl 拒绝」两条）守着这个形状不回退。
 */
export const KL_SKILL_PERMISSION = {
  "*": "deny",
  [`${HOST_TOOL_PREFIX}*`]: "allow",
  skill: "allow",
  bash: {
    "*": "deny",
    kl: "allow",
    "kl *": "allow",
    /**
     * ★ 多图检索：`KL_SERVER_PORT=<n> kl ...` —— **前缀赋值是另一个命令串**。
     *
     * `kl` 与 `kl *` 都匹配不到它（模式是对整条命令串做 glob，而这条以
     * `KL_SERVER_PORT=` 开头）。漏了这一条的表现是混合档位下 agent 的每次
     * 换端口查询都被拒 —— 而它会退回只查默认端口那个图，也就是**静默**
     * 给出一个"只搜了一个来源"的答案。
     *
     * 放行面刻意窄到一个变量名：`*=* kl *` 会让 agent 能设任意环境变量
     * （含 `PATH` / `LD_PRELOAD`），那等于把 deny-all 拆掉。
     */
    "KL_SERVER_PORT=* kl": "allow",
    "KL_SERVER_PORT=* kl *": "allow",
  },
} as const

/**
 * 会绕过 deny-all 的配置**路径**（不是"键名"）。
 *
 * ## ★ 为什么按路径而不是按键名
 *
 * 首版是 `new Set(["permission","tools"])` + 任意深度剥除，实测把
 * `mcp.myserver.tools` 也剥掉了 —— 那不是权限配置，而是 MCP server 的
 * 工具声明。逃生阀存在的意义恰是「你的抽象不够用时我要能绕过它」，
 * 而超范围剥除会**静默破坏它的正当用途**（用户配了、没报错、就是不生效）。
 *
 * 真正能提权的只有这几处（逐条核对过 opencode 源码）：
 * · `permission`（顶层，user ruleset）—— `agent.ts:138` 的 `fromConfig(cfg.permission)`；
 * · `tools`（顶层）—— `config.ts:553` 把它转成 `result.permission` 再 merge；
 * · `agent.<name>.permission` —— `agent.ts:293` 把它追加在 user ruleset
 *   **之后**，而 merge = `rulesets.flat()` + `findLast`，所以它赢；
 * · `agent.<name>.tools` —— `core/v1/config/agent.ts:69` 的 normalize 把它
 *   转成该 agent 的 permission；
 * · `mode.<name>.permission` / `mode.<name>.tools` —— ★ 这两条容易漏：
 *   `mode` 是 `agent` 的**废弃别名**，schema 完全相同
 *   （`core/v1/config/config.ts:90` 的 `ConfigAgentV1.Info`），
 *   而 `config.ts:535-542` 会把 `mode.<name>` **merge 进 `agent.<name>`**。
 *   只剥 `agent.*` 的话，改用 `mode` 这个键名就能绕过整道清洗。
 *
 * 匹配用通配段（`*` 匹配任意一个键名），而不是"任意深度"。
 *
 * ⚠️ 新增一个 opencode 版本时要复核这张表：它们把 `tools` 转 permission 的
 * 逻辑分散在两处（顶层与 agent 级），再多一处我们不会收到任何信号。
 */
const PERMISSION_PATHS: readonly string[][] = [
  ["permission"],
  ["tools"],
  ["agent", "*", "permission"],
  ["agent", "*", "tools"],
  // mode 是 agent 的废弃别名，会被 merge 进 agent —— 不剥它等于留了个后门
  ["mode", "*", "permission"],
  ["mode", "*", "tools"],
]

/** 当前路径（不含数组下标）是否命中某条提权路径。 */
function isPermissionPath(segments: readonly string[]): boolean {
  return PERMISSION_PATHS.some(
    (pattern) =>
      pattern.length === segments.length &&
      pattern.every((token, index) => token === "*" || token === segments[index]),
  )
}

/**
 * 从一份 harness 配置里剥掉所有能改权限的键。
 *
 * ## 为什么必须剥（实测的完整链路）
 *
 * 逃生阀（高级 AI 配置里的 `rawConfigJson`）会整份注入
 * `OPENCODE_CONFIG_CONTENT`。而 opencode 的权限判定是
 * `Permission.merge(...)` = **`rulesets.flat()`** + `findLast`
 * （permission/index.ts:200/210），且 `agent.ts:293` 把
 * `cfg.agent.<name>.permission` 追加在 **user ruleset 之后** ——
 * 于是配置里的
 *
 * ```json
 * { "agent": { "build": { "permission": { "webfetch": "allow" } } } }
 * ```
 *
 * 会把 `webfetch` 从 deny **翻回 allow**。而 `tool/webfetch.ts:35`
 * 只校验 http(s) 前缀、**无域名白名单** —— 这正是威胁模型 #1 的主要外泄通道：
 * 群消息里一句 injection 就能「读画像 → fetch 到攻击者服务器」，
 * 全程没有一次写操作。
 *
 * ## 剥而不是拒
 *
 * 逃生阀的用途是「你的抽象不够用时我要能绕过它」，那是正当需求；
 * 但「绕过权限模型」不在其中。所以剥掉权限键、保留其余配置 ——
 * 极客仍能换 provider / 模型 / 各种参数，只是拿不到提权。
 * 被剥掉了什么由调用方记日志（见 advanced-ai.service），不静默。
 *
 * ## 剥的范围**按路径限定**
 *
 * 见 `PERMISSION_PATHS`：全深度剥 `tools` 会连 `mcp.<name>.tools`
 * 一起剥掉（实测），那是超出必要范围地破坏逃生阀。
 *
 * @returns 清洗后的配置与被剥掉的键路径（供日志与 UI 提示）
 */
export function stripPermissionOverrides(config: unknown): {
  sanitized: unknown
  stripped: string[]
} {
  const stripped: string[] = []

  /**
   * @param segments 当前节点的**键路径**（不含数组下标）。
   *   数组下标不进 segments 是刻意的：`agent[0].permission` 这种形状
   *   在 opencode 的配置里不存在（agent 是一个对象映射），
   *   而把下标算进去会让路径长度对不上、于是漏剥。
   */
  const walk = (node: unknown, path: string, segments: readonly string[]): unknown => {
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, `${path}[${index}]`, segments))
    }
    if (node === null || typeof node !== "object") return node

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path === "" ? key : `${path}.${key}`
      const childSegments = [...segments, key]
      if (isPermissionPath(childSegments)) {
        stripped.push(childPath)
        continue
      }
      result[key] = walk(value, childPath, childSegments)
    }
    return result
  }

  return { sanitized: walk(config, "", []), stripped }
}

/**
 * 断言一份配置里不含任何权限键。
 *
 * `stripPermissionOverrides` 是"清洗"，这个是"门禁"：注入前再断一次，
 * 保证将来有人新增一条绕过清洗的注入路径时会**启动失败**而不是静默提权。
 *
 * @throws AppError(CONFIG_INVALID)
 */
export function assertNoPermissionOverrides(config: unknown): void {
  const { stripped } = stripPermissionOverrides(config)
  if (stripped.length > 0) {
    throw new AppError(
      "CONFIG_INVALID",
      "harness 配置不允许包含权限键（会绕过 deny-all 权限模型）",
      {
        messageKey: "errors:config.invalid",
        messageParams: { detail: stripped.join(", ") },
      },
    )
  }
}

export interface OpencodeSpawnOptions {
  /** 模型配置（写进 OPENCODE_CONFIG_CONTENT，实测 config.ts:468 支持） */
  modelConfig?: unknown
  /** 基础环境（通常是 process.env） */
  baseEnv?: NodeJS.ProcessEnv
  /** 覆盖随机密码（仅测试用；生产必须让它随机生成） */
  serverPassword?: string
  /**
   * 在 deny-all 之上精确放行 `kl` 命令 + skill 工具（搜索接 kl skill 时用）。
   * 默认 false（纯 deny-all）。见 `KL_SKILL_PERMISSION` 的头注释。
   */
  allowKlCommand?: boolean
  /**
   * ★ opencode 的 `skills.paths` —— **指目录，而不是把 skill cpSync 进 cwd**。
   *
   * opencode 二进制里明写这个字段的形态（`strings ~/.opencode/bin/opencode | grep '"paths"'`
   * 印出 `"paths": [".opencode/skills", "/abs/path/to/skills"]`）—— 是 string 数组，
   * 支持绝对路径。用它就不用每建一次 workspace 都 cpSync 一份 skill：
   * 本机实测 61 个会话 = 61 份 kl 副本，且蒸馏更新还得等下次 createAgent 才生效。
   *
   * 直接放进 modelConfig.skills.paths（下面 stringify 时一起序列化进 OPENCODE_CONFIG_CONTENT）。
   * 空数组 / undefined = 不加，opencode 走它自己的默认（`<cwd>/.opencode/skills`）。
   */
  skillPaths?: readonly string[]
  /**
   * 隔离用的 HOME（我们自己的空目录）。给了就同时注入 `XDG_DATA_HOME`
   * 指回真实的 `~/.local/share`，见 `applyHomeIsolation` 的注释。
   *
   * 不给 = 不隔离（保持继承宿主 HOME）—— 测试与非搜索场景用。
   */
  agentHome?: string
  /**
   * 连 XDG 数据/状态/缓存目录一起隔离。**默认 false**。
   *
   * ★ 多个 opencode 同时活着时**必需**：它们否则共用
   * `~/.local/share/opencode/opencode.db`，而实测后起的那个撞在
   * `CREATE TABLE workspace` 上直接起不来。
   *
   * ★ 默认必须留 false：那是"现有档位逐字节不变"的保证 ——
   * 已有会话的 `session/resume` 靠的就是那个共享数据目录。
   * 完整推理见 `applyHomeIsolation`。
   */
  isolateData?: boolean
  /**
   * npm 包缓存目录（注入 `npm_config_cache`）。
   *
   * ## ★ 为什么与 `agentHome` 分开
   *
   * `agentHome` 是**按身份隔离**的（它下面的 `.config` / `.local/state`
   * 会随会话产生状态）。而 npm 缓存是 **registry 的只读镜像**
   * （实测 325 MB，key 全形如 `registry.npmjs.org/...`，逐项验过不含
   * 任何身份/会话字节）—— 跟着身份各拷一份是纯浪费：两个身份 650 MB、
   * 五个 1.6 GB，且首次切身份要重新联网拉一遍。
   *
   * 所以两个旋钮分开注入：HOME 按身份走，缓存留在应用级一份。
   *
   * 不给 = 不覆盖（npm 用它自己的默认位置，也就是 `$HOME/.npm`
   * —— 那时缓存会落进隔离 HOME 里，功能正常只是会重复占盘）。
   */
  npmCache?: string
}

export interface HardenedSpawn {
  args: string[]
  env: Record<string, string>
  /** 本次进程的 server password（诊断用；**不要写日志**） */
  serverPassword: string
}

/**
 * 把 agent 进程的 HOME 换成我们自己的空目录，隔离宿主的 skill/配置。
 *
 * ## ★ 这修的是一个真实的隔离漏洞
 *
 * 原来 env 是把整个 `process.env` 原样拷过去的，`HOME` 因此被继承 ——
 * 而 opencode 会从 **`$HOME/.claude/skills`** 发现 skill。实测本机那 8 个
 * 用户级 skill（docx / pdf / pptx / xlsx / frontend-design / skill-creator /
 * web-artifacts-builder，以及一个名叫 `test-leak-skill` 的**探针**）全部出现
 * 在搜索 agent 的可见列表里。那个探针的 SKILL.md 原文写着：
 *
 * > If a chat agent sees this skill, isolation is broken and the user's
 * > `~/.claude/skills/` is leaking into the sandboxed session.
 *
 * 也就是说这不是"不好看"，是隔离失效：宿主的任意 skill 都能被搜索 agent 读到
 * 并执行。搜索 agent 应当**只**看得到我们铺进 workspace 的 kl。
 *
 * ## 为什么是 HOME + XDG_DATA_HOME 两个一起改（真进程实测四组才定下来）
 *
 * · 只改 `XDG_CONFIG_HOME`：**没用**，泄漏照旧 —— skill 走的是 `$HOME/.claude`，
 *   不是 XDG_CONFIG。
 * · 只改 `HOME`：skill 干净了，但 opencode 的 **session 存储也跟着搬走**
 *   （`opencode.db` + `storage/` 在 `~/.local/share/opencode`）。那会让每一轮的
 *   `session/resume` 都失败 → 持续降级重建 + 回灌历史，正是我们刚修掉的那个
 *   "首字很慢 / 自问自答"的 bug 的成因。
 * · **HOME=隔离目录 + XDG_DATA_HOME=真实 `~/.local/share`**：skill 只剩 kl，
 *   且 `session/resume` 实测仍然成功。采用这一组。
 *
 * ★ 依赖关系写在这里，避免以后踩坑：我们的模型凭据走 env 注入
 * （`resolveGatewayModelConfig` → `OPENCODE_CONFIG_CONTENT`），**不依赖**
 * `$HOME/.local/share/opencode/auth.json`。哪天有人改成读 auth.json，
 * 就必须重新考虑这里的隔离（否则 agent 读不到凭据）。
 */
/**
 * ## ★★ `isolateData`：多进程并存时必须连数据目录一起隔离
 *
 * 上面那一组（HOME 隔离 + XDG_DATA_HOME 指回真实 HOME）的前提是
 * **同时只有一个 opencode**。多档位检索之后不成立了：三个档位 + 数字人
 * 可能有四个进程同时活着，而它们共用 `~/.local/share/opencode/opencode.db`。
 *
 * 实测：两个 opencode 共用一个数据目录 → **后起的那个直接起不来**，
 * 撞在 `CREATE TABLE workspace` 上（SQLite 那个库不是为并发写设计的）。
 * 完整 XDG 隔离（DATA/STATE/CACHE 三个都指进 agentHome）→ 两个都活、零错误。
 *
 * ## 代价：`session/resume` 会失败一次
 *
 * 换了数据目录 = 换了 session 存储，旧 sessionId 在新库里不存在。
 * 表现是一次降级重建（回灌历史），之后正常。所以：
 *
 * ★ **默认必须是 `false`** —— 那是"钉钉档位逐字节不变"的保证。
 * 已有会话的 resume 靠的就是那个共享数据目录，默认改成 true 等于让
 * 所有存量会话各降级一次，而那不是这次改动该带来的代价。
 *
 * `true` 时**不尊重父进程已设的 XDG 值**（与 DATA_HOME 那条相反）：
 * 隔离的意义就是不共享，父进程设了什么都不该影响它。
 */
function applyHomeIsolation(
  env: Record<string, string>,
  agentHome: string,
  isolateData = false,
): void {
  const realHome = env["HOME"]
  env["HOME"] = agentHome
  // 配置目录也指进隔离区：`$HOME/.config` 之外还有人显式设 XDG_CONFIG_HOME，
  // 那一份同样会被 opencode 读到，一起挡掉。
  env["XDG_CONFIG_HOME"] = `${agentHome}/.config`
  if (isolateData) {
    // ★ 三个都指进来，且**覆盖**父进程的值（见上面那段）
    env["XDG_DATA_HOME"] = `${agentHome}/.local/share`
    env["XDG_STATE_HOME"] = `${agentHome}/.local/state`
    env["XDG_CACHE_HOME"] = `${agentHome}/.cache`
    return
  }
  // ★ 不隔离数据时 session 存储必须留在原处，否则 resume 全灭（见上面的注释）。
  if (env["XDG_DATA_HOME"] === undefined && realHome !== undefined && realHome !== "") {
    env["XDG_DATA_HOME"] = `${realHome}/.local/share`
  }
  /**
   * ★★ 别让 zsh 读用户的启动脚本 —— 换掉 HOME 之后它们**必然半坏**。
   *
   * ## 实测症状
   *
   * agent 跑的每一条 `kl` 命令，输出第一行都是：
   *
   * ```
   * /Users/<用户名>/.zshenv:.:1: no such file or directory:
   *   <agentHome>/.cargo/env
   * ```
   *
   * 因为 `.zshenv` 里那句 `. "$HOME/.cargo/env"` 是照真实 HOME 写的，
   * 而我们把 `HOME` 换成了隔离目录 —— 于是同一句在 agent 进程里指向
   * 一个不存在的路径。用户机器上的 rc 文件里这类 `$HOME/...` 引用很常见
   * （rustup / nvm / pyenv / conda 都这么装）。
   *
   * ## 为什么它不只是噪音
   *
   * · 每条工具输出都被这行报错**污染**，而那些输出要进模型上下文 ——
   *   等于每次调用都白烧一段 token 去讲一件与任务无关的事；
   * · 更糟的是**模型会当真**：它看到 stderr 里有 `no such file or directory`
   *   就可能判断"这条命令失败了"，然后重试或改写命令。真机那一轮里
   *   agent 试了三种调用形态，这行报错是干扰源之一。
   *
   * ## 判据：rc 文件属于**用户的交互 shell**，不属于我们 spawn 的子进程
   *
   * 我们要的是一个干净的、可预测的执行环境；用户 rc 里的 PATH 定制
   * 我们本来也不想继承（那正是 `PATH` 由我们显式拼的原因）。
   * `ZDOTDIR` 指进隔离区（那里没有 rc 文件）比逐个 unset 更稳 ——
   * 后者要穷举 `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin`，漏一个就白做。
   *
   * ★ 只影响我们 spawn 的子进程，不碰用户自己的 shell。
   */
  env["ZDOTDIR"] = agentHome
  /**
   * bash 那一侧的等价物。`BASH_ENV` 是非交互 bash 会 source 的那个文件 ——
   * 用户设过它的话同样带着 `$HOME` 引用。指向空串 = 不 source 任何东西。
   */
  env["BASH_ENV"] = ""
}

/**
 * 模型 id 的兜底默认。
 *
 * 不是随手写的：网关实测这个 200，其余候选 503。只在「调用方没传 + env
 * 也没有」时生效。
 */
export const DEFAULT_GATEWAY_MODEL = "claude-sonnet-4-6"

/**
 * 解析「这一轮到底用哪个模型」。**唯一一份**优先级实现。
 *
 * ★ 导出而不是内联进 `resolveGatewayModelConfig`：调用方还要把同一个值写进
 * 日志（"到底用了哪个模型"是排查时的第一个问题）。各写一份的话两处会漂移，
 * 而漂移的表现是**日志报的模型与实际用的不是一个** —— 比不报更糟，因为它
 * 把排查引向错误的方向。
 *
 * 三档，都用"非空才算"（不是 `??`）：env 里的空串（`KEY=` 占位）与设置里
 * 存了个空串都很常见，而空模型 id 拼进 `mycontext/` 会让 opencode 去解析
 * 一个空引用，表现又是那条最难查的"session/prompt 永不返回"。
 */
export function resolveModelName(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
): string {
  if (modelOverride !== undefined && modelOverride.trim() !== "") return modelOverride
  const fromEnv = env["MYCONTEXT_MODEL_MAIN"]
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv
  return DEFAULT_GATEWAY_MODEL
}

/**
 * 从环境变量解析出一份可直接喂给 `buildOpencodeSpawn({modelConfig})` 的模型配置。
 *
 * ## 为什么走 openai-compatible 内联 provider，而不是 anthropic provider
 *
 * 本机网关（`ANTHROPIC_BASE_URL`）既讲 Anthropic Messages 协议，也讲
 * **OpenAI Chat Completions**（`/v1/chat/completions` 实测 200）。而 opencode 的
 * 内置 `anthropic` provider 依赖 **models.dev 注册表**去解析模型元数据 ——
 * 注册表拉不到时（离线/被墙）它**不报错**，只是 `session/prompt` 直接回
 * `end_turn` + **0 token**（实测：静默不说话，正是本项目最怕的失效）。
 *
 * 内联 `@ai-sdk/openai-compatible` provider + 内联 `models` **绕过注册表**：
 * baseURL/apiKey/模型元数据全部本地给全，不依赖任何外网解析。实测这条路
 * agent 真的回答（10k tokens、`agent_message_chunk` 有内容）。
 *
 * ## env 口径（本机实测）
 *
 * 网关根与密钥各有两个来源，**按优先级回退**：
 *
 * · base：`ANTHROPIC_BASE_URL` → `MYCONTEXT_LLM_BASE_URL`
 * · key： `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `MYCONTEXT_LLM_API_KEY`
 *
 * ★ 为什么必须回退到 `MYCONTEXT_LLM_*`：**它们本来就是同一个网关**
 * （`llmapi.llm-gateway.com`，OpenAI 兼容口）。让人为了搜索再配一遍
 * `ANTHROPIC_*` 是纯粹的重复劳动，而且漏配的后果极其隐蔽 ——
 * opencode 会退回默认 provider 去查被墙的 models.dev，表现为
 * `session/prompt` 永不返回、满 120 秒超时（真实踩过：同事机器上
 * "搜索完全没法用"，日志只有一条超时，查不到是缺密钥）。
 *
 * 保留 `ANTHROPIC_*` 优先级更高：那是 opencode 自己的约定，
 * 谁想给搜索单独指一个网关（比如临时换个模型服务）仍然能覆盖。
 *
 * · 拼 URL：base 不含 `/v1` 时补上；
 * · 模型 id：`modelOverride` → `MYCONTEXT_MODEL_MAIN` → `claude-sonnet-4-6`。
 *
 * ## ★ 模型名为什么统一到 `MYCONTEXT_MODEL_MAIN`
 *
 * 这里原来读的是 `MYCONTEXT_SEARCH_MODEL` —— 一个**只存在于 `process.env`**
 * 的变量：不在 `kernel/config.ts` 的 schema 里、设置页没有、而
 * `RuntimeConfigService.seedProcessEnv()` 也不 seed 任何模型名。于是
 * `.env` 里写它**到不了这里**（`bootstrap/config.ts` 刻意不写 `process.env`），
 * 用户在设置页改「主模型」也影响不到这条路。
 *
 * 后果是分裂的：数字人**常态**回复（走这里的 ACP 子进程）用 sonnet，
 * 而**降级**回退到直连时用 `modelMain` —— 两个模型，用户一个都改不动，
 * 且"回复风格突然变了"查不到原因。
 *
 * ★ `modelOverride` 优先于 env 是必需的，不是锦上添花：`seedProcessEnv`
 * 只在装配阶段跑一次，而用户在设置里改完模型后子进程是**之后**才 spawn 的
 * ——只靠 env 会读到那份旧快照。所以由持有 `runtimeConfig` 的装配层把
 * 解析后的值显式传进来（与 kl 的 `llmModel` 同一个做法，见 `startup.ts`）。
 *
 * 默认值仍是 `claude-sonnet-4-6`：那不是随手写的，是实测结论（网关实测 200，
 * 其余候选 503）。它只在「调用方没传 + env 也没有」时兜底。
 *
 * base 与 key 各自**两个来源都空**才返回 null（调用方据此降级）。
 */
export function resolveGatewayModelConfig(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
): unknown | null {
  // 取第一个非空值 —— `??` 不够：env 里常见的是**空字符串**（`KEY=` 占位），
  // 那种情况下 `??` 会把空串当有效值传下去，最后表现为"配了但认证失败"。
  const pick = (...keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const value = env[key]
      if (value !== undefined && value.trim() !== "") return value
    }
    return undefined
  }

  const base = pick("ANTHROPIC_BASE_URL", "MYCONTEXT_LLM_BASE_URL")
  const apiKey = pick("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "MYCONTEXT_LLM_API_KEY")
  if (base === undefined || apiKey === undefined) return null

  /**
   * ★ 走 `resolveModelName` 而不是在这里再判一次优先级：调用方还要把同一个
   * 值写进日志，两份实现会漂移（见那个函数的注释）。
   */
  const model = resolveModelName(env, modelOverride)
  const baseURL = base.endsWith("/v1") ? base : `${base.replace(/\/$/, "")}/v1`
  const providerId = "mycontext"
  const modelRef = `${providerId}/${model}`
  return {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "MyContext Gateway",
        options: { baseURL, apiKey },
        /**
         * ★ `modalities.input` 必须含 `"image"`，否则 agent **看不到图**。
         *
         * ## 这一行是「数字分身说读不了图片」的真正根因
         *
         * opencode 靠内联 models 的这个字段判断"这个模型能不能收图"
         * （二进制里：`input:{text:!0,audio:!1,image:X,…}`，`X` 来自这里）。
         * 不给的话它**默认 false**，于是无论图怎么送进去 —— prompt 里的
         * image block、还是 `read` 工具读出来的 attachment —— 都会在
         * "转成模型请求"那一步被丢掉。
         *
         * 而失效方式极具误导性：**模型自己会说**「当前模型不支持图片输入」。
         * 那句话不在 opencode 的二进制里（搜过），所以看起来像是模型的限制，
         * 一路把人引向"换个模型"。实测同一个模型经直连（`LlmClient`）
         * 能正确读出同一张图 —— 所以从来不是模型没有视觉能力。
         *
         * 实测（真 opencode + 真网关，一张写着 `VZ7QK` 的 PNG）：
         * · 不给这一行 → 「当前模型不支持图像输入」（两条路都是）；
         * · 给了 → 回答 `VZ7QK`（两条路都通）。
         *
         * ★ 只需要这一行。试过的另外两条都**不是**必要条件：
         * `attachment: true`（加了没用，去掉照样通）、
         * 放行 `read` 权限（image block 那条路根本不需要它）。
         *
         * `output` 一并给上：同一个字段的两半，只给 input 会让形状看起来
         * 像是漏了什么。
         */
        models: {
          [model]: { name: model, modalities: { input: ["text", "image"], output: ["text"] } },
        },
      },
    },
    model: modelRef,
    small_model: modelRef,
  }
}

/**
 * 构造加固后的 spawn 参数与环境。
 *
 * @throws AppError(CONFIG_INVALID) 当 server password 为空 ——
 *   fail-fast 而不是"启动了但没鉴权"。
 */
export function buildOpencodeSpawn(options: OpencodeSpawnOptions = {}): HardenedSpawn {
  const serverPassword = options.serverPassword ?? randomBytes(32).toString("base64url")

  // 「忘了注入」必须是启动失败。这一条看起来多余（上一行刚生成），
  // 但它挡的是「有人把上面改成从配置读，而配置为空」这种未来的改动。
  if (serverPassword === "") {
    throw new AppError("CONFIG_INVALID", "拒绝在无 server password 的情况下启动 Agent 进程", {
      messageKey: "errors:config.invalid",
      messageParams: { detail: "empty server password" },
    })
  }

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.baseEnv ?? process.env)) {
    if (value !== undefined) env[key] = value
  }

  if (options.agentHome !== undefined && options.agentHome !== "") {
    applyHomeIsolation(env, options.agentHome, options.isolateData ?? false)
  }
  /**
   * ★ 在 `applyHomeIsolation` **之后**注入：它刚把 `HOME` 换掉，
   * 而 npm 的默认缓存位置是 `$HOME/.npm` —— 不覆盖的话缓存会跟着
   * 隔离 HOME 走，也就是每个身份各攒一份 325 MB（见 `npmCache` 的注释）。
   */
  if (options.npmCache !== undefined && options.npmCache !== "") {
    env["npm_config_cache"] = options.npmCache
  }

  env["OPENCODE_SERVER_PASSWORD"] = serverPassword
  // 精确放行 kl 命令时用扩展形态，否则纯 deny-all。两者的 `"*"` 都是 deny，
  // 所以 assertHardened 的白名单判定对两者都成立。
  env["OPENCODE_PERMISSION"] = JSON.stringify(
    options.allowKlCommand === true ? KL_SKILL_PERMISSION : DENY_ALL_PERMISSION,
  )
  /**
   * ★ 屏蔽用户本地 opencode 配置对 agent 的污染。
   *
   * 参考 opencode 源码（`~/gits/opencode`）逐条核对，污染源与挡法：
   *
   * ## ① 外部 skill 扫描（`.claude/skills` + `.agents/skills`）→ **必须挡**
   *
   * `packages/opencode/src/skill/index.ts:186-203` 有**两条**扫描路径：
   * · 全局侧扫 `{global.home}/.claude/skills`、`{global.home}/.agents/skills`。
   *   `global.home = OPENCODE_TEST_HOME ?? os.homedir()`，而 `os.homedir()` 尊重
   *   `HOME` env —— 所以 `applyHomeIsolation` 里 `HOME=agentHome` 已经挡住这条。
   * · **但** 它还会**沿文件系统父目录 findUp**（同文件 196-202 行）。workspace 在
   *   `<userData>/agents/persona/<id>`，向上到 `/` 的路径**会经过 `/Users/<user>/`**，
   *   那里的 `.claude/skills` 与 `.agents/skills` 正好命中（实测本机
   *   `~/.agents/skills/find-skills` 存在）。换 `HOME` **不改变文件系统**，
   *   findUp 挡不住。
   *
   * 唯一稳妥的挡法：`OPENCODE_DISABLE_EXTERNAL_SKILLS=1` —— 从扫描这一步就跳过
   * 两个外部目录（global 与 findUp 都跳）。它**不影响** `skills.paths`
   * （我们自己指定的目录走的是 `cfg.skills.paths` 那条分支，同文件 211-220 行）。
   *
   * ## ② `OPENCODE_DISABLE_PROJECT_CONFIG` —— ★ **刻意不注**
   *
   * 它看起来正好挡住 project 侧 `opencode.json`/`opencode.jsonc` 的 findUp
   * （`config/paths.ts:27-33`），但实测源码后发现它**顺带把 `AGENTS.md` 的加载
   * 也关掉了**：`session/instruction.ts:81` 与 `:123` 两处都在
   * `if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG)` 里 findUp `AGENTS.md`，
   * 置位后只从 `global.config` 找。
   *
   * 而 `<cwd>/AGENTS.md` 是我们**唯一**的会话身份入口（会话标题、授权模式、
   * 用户手写的 personaNote、输出协议）。注了这个 flag 等于把它整份丢掉 ——
   * 而且**不报错**：agent 仍然回答，只是不再知道自己在替谁说话、也不再遵守
   * `{reply, holdForReview, reviewReason}` 那套协议。正是本项目反复出现的
   * 那类静默失效，所以宁可少挡一条也不能注它。
   *
   * project 侧 `opencode.json` 的实际风险很低：workspace 在 userData 下，
   * 从它上溯到 `/` 的路径上只有我们自己 mkdir 的 `<cwd>/.opencode`。
   * 真要挡，得等 opencode 把这两件事拆成两个 flag。
   *
   * ★ 这条**dev 与打包同样生效** —— env 只作用于 opencode 子进程。
   */
  env["OPENCODE_DISABLE_EXTERNAL_SKILLS"] = "1"
  /**
   * ★ 把 modelConfig 与 skillPaths 合并成同一份 OPENCODE_CONFIG_CONTENT。
   *
   * opencode 只认**一份**配置内容（`OPENCODE_CONFIG_CONTENT` 环境变量），
   * 所以两个来源必须先在这里合并。合并顺序：
   *   1) modelConfig 作为基础（可能来自「高级 AI」逃生阀，也可能 undefined）；
   *   2) skillPaths 覆盖 `skills.paths`（保留 modelConfig 里其他 skill 字段）。
   *
   * ★ 合并**之后**再过 `assertNoPermissionOverrides` —— 那是加固层最后一道门。
   */
  const skillPaths = (options.skillPaths ?? []).filter((p) => p !== "")
  const hasSkillPaths = skillPaths.length > 0
  if (options.modelConfig !== undefined || hasSkillPaths) {
    const base =
      options.modelConfig === undefined
        ? {}
        : (JSON.parse(JSON.stringify(options.modelConfig)) as Record<string, unknown>)
    if (hasSkillPaths) {
      const existingSkills =
        typeof base["skills"] === "object" && base["skills"] !== null
          ? (base["skills"] as Record<string, unknown>)
          : {}
      base["skills"] = { ...existingSkills, paths: skillPaths }
    }
    assertNoPermissionOverrides(base)
    env["OPENCODE_CONFIG_CONTENT"] = JSON.stringify(base)
  }

  return {
    // 显式传 hostname：默认值不是契约。端口留默认（随机）。
    args: ["acp", "--hostname", "127.0.0.1"],
    env,
    serverPassword,
  }
}

/**
 * 解析一个来自环境变量的 JSON，失败时抛**显式分类**的错误。
 *
 * ## 为什么不能裸 `JSON.parse`
 *
 * 首版直接 `JSON.parse(env["OPENCODE_CONFIG_CONTENT"])`，畸形内容会抛裸
 * `SyntaxError`（实测 `isAppError=false`）。而安全门禁的失败**必须是显式的
 * 分类拒绝**：裸 SyntaxError 会绕过 IPC 的错误映射，UI 上只能显示一个
 * 未翻译的内部错误（"Unexpected token } in JSON at position 17"），
 * 用户既不知道是自己填错了配置，也不知道该改哪里。
 *
 * 而 `OPENCODE_CONFIG_CONTENT` 的内容恰恰**主要来自逃生阀**（用户原文 JSON），
 * 所以"畸形"是一个正常会发生的输入，不是不可能的意外。
 */
function parseEnvJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new AppError("CONFIG_INVALID", `Agent 进程环境里的 ${name} 不是合法 JSON`, {
      cause: error,
      messageKey: "errors:config.invalid",
      messageParams: { detail: `${name}: ${(error as Error).message}` },
    })
  }
}

/**
 * 校验一份环境是否满足加固要求。
 *
 * 单独暴露是为了让**测试能断言这几条不可回退** ——
 * 有人在重构中删掉一行注入，除了这个断言没有任何信号会红。
 *
 * @throws AppError(CONFIG_INVALID) 任何一条不满足时。**一律是 AppError**
 *   （不是裸 SyntaxError）：门禁的失败要能被 IPC 映射与 i18n 处理。
 */
export function assertHardened(env: Record<string, string>): void {
  const password = env["OPENCODE_SERVER_PASSWORD"]
  if (password === undefined || password === "") {
    throw new AppError("CONFIG_INVALID", "Agent 进程环境缺少 server password（会导致无鉴权）", {
      messageKey: "errors:config.invalid",
      messageParams: { detail: "missing OPENCODE_SERVER_PASSWORD" },
    })
  }

  const permission = env["OPENCODE_PERMISSION"]
  if (permission === undefined) {
    throw new AppError("CONFIG_INVALID", "Agent 进程环境缺少权限白名单", {
      messageKey: "errors:config.invalid",
      messageParams: { detail: "missing OPENCODE_PERMISSION" },
    })
  }
  const parsed = parseEnvJson("OPENCODE_PERMISSION", permission) as Record<string, string> | null
  // `JSON.parse("null")` / `"[]"` / `"3"` 都是合法 JSON 但不是我们要的形状。
  // 不查的话 `parsed["*"]` 会在 null 上抛 TypeError（又是一个非 AppError）。
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError("CONFIG_INVALID", "权限配置必须是一个 JSON 对象", {
      messageKey: "errors:config.invalid",
      messageParams: { detail: "OPENCODE_PERMISSION is not an object" },
    })
  }
  if (parsed["*"] !== "deny") {
    throw new AppError(
      "CONFIG_INVALID",
      "权限配置必须是白名单式（`*: deny`）：deny 列表挡不住 webfetch 外泄",
      {
        messageKey: "errors:config.invalid",
        messageParams: { detail: `"*" is ${JSON.stringify(parsed["*"])}, expected "deny"` },
      },
    )
  }

  // 注入的 config 也要查：`agent.<name>.permission` 会覆盖上面这份 deny-all
  // （实测 merge = rulesets.flat() + findLast，agent 段追加在 user 段之后），
  // 所以「OPENCODE_PERMISSION 对了」不等于「权限模型生效了」。
  const configContent = env["OPENCODE_CONFIG_CONTENT"]
  if (configContent !== undefined && configContent !== "") {
    assertNoPermissionOverrides(parseEnvJson("OPENCODE_CONFIG_CONTENT", configContent))
  }
}
