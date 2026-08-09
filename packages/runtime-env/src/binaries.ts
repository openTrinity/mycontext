/**
 * 预置二进制解析。
 *
 * 开发态从仓库的 apps/desktop/resources/bin 读；打包态从
 * process.resourcesPath/bin 读（electron-builder 的 extraResources 落点）。
 * 两种模式路径逻辑同一份代码，避免「开发能跑、打包缺文件」这类只在发版后暴露的问题。
 *
 * 文件名一律带 -{platform}-{arch} 后缀：加 Windows 支持时只需把二进制放进去，
 * 解析逻辑不用改。
 */
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { AppError } from "@mycontext/kernel"
import { resolvePython, type PythonVersionProbe, type ResolvedPython } from "./python.js"

/**
 * 需要解析的可执行文件。
 *
 * 两者现在**都随包分发到 resources/bin**（见 scripts/prepare-bin.mjs）：
 * - `dws`：vendor 内置 → resources/bin，**必需**，缺失即错误
 * - `opencode`：npm 平台包（`opencode-ai` 精确钉版本）→ resources/bin。
 *   `bundled` 档优先，从而 dev 与打包共用一套解析、且**不受用户本机
 *   那份 opencode 影响**。仍保留 env/home/path 三档作兜底与逃生阀。
 *   运行时缺失仍是**降级**（内置 harness），不是错误。
 *
 * Python 解释器是第三类，解析逻辑在 ./python.ts —— 它要**执行**候选来读版本，
 * 而这个文件因为提到 opencode 而受 spawn 门禁约束（见那边的注释）。
 */
export type BinaryName = "dws" | "opencode"

export interface ResolvedBinary {
  name: BinaryName
  /** 绝对路径 */
  path: string
  /** 解析用的平台标识，如 darwin-arm64 */
  platform: string
  /** 从哪一档解析出来的（诊断用；状态页会显示） */
  source: "bundled" | "env" | "home" | "path"
}

export interface RuntimeEnvOptions {
  /** 二进制所在目录 */
  binDir: string
  /**
   * DWS 渠道号（上游 `channelCode`）。**开源发布不带它，缺省是空串。**
   *
   * 空 = 不注入 `DWS_CHANNEL`（见 buildEnv）。上游对空串与未设置等价处理，
   * 只有被组织限定了渠道范围（`channelScope=specified`）时才需要由分发方注入。
   */
  dwsChannel: string
  /**
   * 用户自备的 dws 可执行文件（绝对路径）。**优先于随包那份。**
   *
   * ## 为什么要这条覆盖
   *
   * 随包分发的是**开源版**（npm 依赖 `dingtalk-workspace-cli`）。而内部同学
   * 用的是闭源版 —— 它不随仓库分发，只能由用户自己装好再指路径。
   * 这一条就是那个入口（UI 上填、落设置库；`MYCONTEXT_DWS_SOURCE` 环境变量
   * 是脚本侧的同义物，见 scripts/lib/dws-resolver.mjs）。
   *
   * ## ★ 解析顺序：这一条 > `binDir` 里那份
   *
   * "我明确指了一个"必须盖过默认。而**兜底永远是**随包的开源版 ——
   * 用户把路径清空、或指的文件不见了（换了台机器、卸载了闭源包），
   * 都自动退回随包那份，而不是让渠道整个不可用。
   *
   * 缺省 undefined = 没设，只用随包那份。
   */
  dwsBinOverride?: string | undefined
  /**
   * DWS 的配置目录（`profiles.json` / 日志 / 事件流）。
   *
   * **必须是绝对路径**，见 buildEnv() 的断言与其注释。
   *
   * ## ★★ 它是**按 vault** 的，所以装配层传的是一个 getter
   *
   * 这个目录里的 `profiles.json` 决定「本机有哪些身份、当前用哪个」。
   * 每个 vault 一份**只含它那一个身份**的 profiles 之后，越权读取变成
   * 结构性不可能（实测：在只 seed 组织甲的目录里拿组织乙的 `--profile`
   * 去问，直接 `organization "…" not found`）。
   *
   * 声明成 `string` 而不是函数是刻意的：TS 的属性声明对 getter 天然成立
   * （`dwsChannel` / `dwsBinOverride` 已经是这么用的，见 startup.ts），
   * 于是"每次现读"这件事对**本类的实现完全透明** —— `buildEnv()` 里那句
   * `this.options.dwsConfigDir` 不需要知道它背后是常量还是 getter。
   * 而那条"必须绝对路径"的断言会继续保护它（切身份后仍然每次 buildEnv 都查）。
   */
  dwsConfigDir: string
  /**
   * 把渠道命令**钉死在某一个身份**上（上游 `--profile <corpId>:<userId>`）。
   *
   * ## ★★ 为什么必须钉：不钉就是一个越权读取面
   *
   * CLI 的登录态按**系统用户**存，而"用哪个身份作答"由它自己的全局
   * `currentProfile` 决定 —— 那个值可能被用户在终端里、或上一次授权改掉。
   * 于是应用会拿着 A 的 vault，去读 B 的会话列表与消息。
   *
   * 实测（本机，两个身份都已登录）：
   * ```
   * profiles.json:   primary=组织甲   current=组织乙
   * auth status                                  → 组织乙   ← 界面显示这个
   * vault channel_self_identity                  → 组织甲   ← 库里绑这个
   * chat list-all-conversations                  → 38 个会话（组织乙的）
   * chat list-all-conversations --profile 组织甲  → 100 个会话
   * ```
   * 库里躺着组织甲的会话与消息，采集器却在按组织乙列会话。
   * 这不是显示不准，是读到了不属于用户预期范围的内容（CLAUDE.md 第 5 节）。
   *
   * ## ★ 为什么是 `--profile` 而不是 `profile switch`
   *
   * `--profile` 是**单次生效、无副作用**的；`profile switch` 改的是全局状态，
   * 会踩掉用户自己终端里的登录态。而且实测 `profile switch --dry-run`
   * **真的会改** `currentProfile`（上游的 bug）—— 连"预览"都不安全。
   *
   * ## ★ 取值是函数（getter）
   *
   * 与 `dwsChannel` / `dwsBinOverride` 同一个理由：`RuntimeEnv` 启动时构造一次，
   * 而当前挂载的是哪个 vault 会随身份切换而变。传静态值的话切完身份仍在读旧
   * 身份的数据 —— 而那正是这条要修的问题换了个形式回来。
   *
   * 缺省 undefined / 返回空 = 不钉（退回 CLI 的全局 profile）。
   * 这只该发生在"这个 vault 还没绑任何渠道身份"时。
   */
  dwsProfile?: (() => string | undefined) | undefined
  /**
   * 仓库根 —— 内置 Python 解释器就在它下面的 `vendor/python/<plat>/python`。
   *
   * 打包态传的是 `process.resourcesPath`（`Resources/` **镜像仓库布局**，
   * 所以同一个相对路径在两种形态下都成立 —— 见 `python.ts` 的
   * `bundledPythonExe` 与 `electron-builder.yml` 的 extraResources）。
   *
   * 缺省 undefined = 没有内置那一档，`tryResolvePython` 退回 env/PATH/系统
   * 三档（既有测试就是这么调的，行为不变）。
   */
  repoRoot?: string | undefined
  /** 覆盖环境变量来源（测试注入用；缺省读 process.env） */
  env?: NodeJS.ProcessEnv
}

function platformSuffix(): string {
  const arch = process.arch === "x64" ? "x64" : process.arch
  return `${process.platform}-${arch}`
}

function fileName(name: BinaryName): string {
  const suffix = platformSuffix()
  return process.platform === "win32" ? `${name}-${suffix}.exe` : `${name}-${suffix}`
}

/** opencode 官方安装器不带平台后缀；我们的 bundled 那份带后缀（与 dws 同规则）。 */
const OPENCODE_EXE = process.platform === "win32" ? "opencode.exe" : "opencode"

/**
 * 允许的最低 opencode 版本。
 *
 * ## ★ 为什么是 1.2.23（有出处，不是拍的）
 *
 * opencode 的 ACP 前端调它自己起的本地 HTTP server 时，早期版本**不带
 * 鉴权头**（`createOpencodeClient({ baseUrl })` 无 `headers`）。而我们为了
 * 安全给那个 server 注入了随机 `OPENCODE_SERVER_PASSWORD`（见 spawn-hardening
 * 的头注释：不注的话本机任意网页一个 fetch 就能驱动我们的 session）。
 * 于是低版本被自己的 basic auth 401 掉，`session/new` 报 `-32603`，
 * ACP **一次都起不来**（实测同事机器上 1.2.15 就是这样）。
 *
 * 上游在 `8694c5b68f fix(auth): respect server username in clients` 修的，
 * `git tag --contains` 确认首个含它的 release 是 **v1.2.23**。
 *
 * bundle 之后正常永远满足（我们钉的是 1.18.x）；这条断言挡的是
 * "有人把依赖降级 / 逃生阀 `MYCONTEXT_OPENCODE_BIN` 指到一个老二进制" ——
 * 那时必须是**明确降级 + 可读原因**，而不是 7 次 `-32603`。
 */
export const MIN_OPENCODE_VERSION = "1.2.23"

/**
 * 跑 `opencode --version` 读版本号。**注入**而不是自己 spawn ——
 * 本文件受 spawn 门禁约束（与 `tryResolvePython(runVersionProbe)` 同一款做法）。
 *
 * @returns 形如 `"1.18.11"` 的原始 stdout（调用方负责解析），失败返回 null。
 */
export type OpencodeVersionProbe = (binPath: string) => string | null

export type OpencodeResolution =
  | { ok: true; binary: ResolvedBinary; version: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "too_old"; binary: ResolvedBinary; found: string; required: string }
  | { ok: false; reason: "unreadable_version"; binary: ResolvedBinary }

/**
 * 把 `"OpenCode 1.18.11"` / `"1.2.23\n"` 这类 stdout 解析成 `[major,minor,patch]`。
 * 解析不出返回 null（调用方按"版本不可读"处理，fail closed）。
 */
export function parseSemver(raw: string): [number, number, number] | null {
  // 用 `String.match` 而不是 `RegExp.exec`：本文件提到 opencode，而 spawn 门禁
  // （spawn-wiring.test.ts）把 `exec(` 也算作"起了进程"的调用 —— `.exec()`
  // 会被它误判成 spawn opencode。`match` 语义等价且不撞那个正则。
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/)
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** a >= b（三段式比较）。 */
export function semverGte(a: [number, number, number], b: [number, number, number]): boolean {
  const [a0, a1, a2] = a
  const [b0, b1, b2] = b
  if (a0 !== b0) return a0 > b0
  if (a1 !== b1) return a1 > b1
  return a2 >= b2
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 尽力补上可执行位（asar/extraResources 解出的文件常丢它）。
 *
 * 与 `resolve()` 里那段不同：那里补不上要**抛错**（dws 必需，跑不了就得停）；
 * 这里是尽力而为 —— opencode 缺可执行位时抛错会把"能降级"变成"崩溃"，
 * 而降级到内置 harness 才是它缺失时该有的行为。补不上就让后续 spawn 自己报错。
 */
function ensureExecutable(path: string): void {
  try {
    accessSync(path, constants.X_OK)
  } catch {
    try {
      chmodSync(path, 0o755)
    } catch {
      // 尽力而为：补不上就交给后续 spawn 去暴露，不在这里把降级变崩溃。
    }
  }
}

export class RuntimeEnv {
  constructor(private readonly options: RuntimeEnvOptions) {}

  /**
   * 解析二进制路径。
   *
   * 缺失时给出可操作的错误：只说「文件不存在」会让人不知道该干什么，
   * 因此带上期望路径与准备脚本名。
   */
  resolve(name: BinaryName): ResolvedBinary {
    if (name === "opencode") {
      const resolved = this.tryResolveOpencode()
      if (resolved !== null) return resolved
      throw new AppError(
        "RUNTIME_BINARY_MISSING",
        "未检测到 opencode。它不随包分发（体积过大），需本机安装或用 MYCONTEXT_OPENCODE_BIN 指定。",
        {
          messageKey: "errors:runtime.binaryMissing",
          messageParams: {
            file: OPENCODE_EXE,
            path: join(homedir(), ".opencode", "bin", OPENCODE_EXE),
            command: "MYCONTEXT_OPENCODE_BIN=<path>",
          },
          context: { name, platform: platformSuffix() },
        },
      )
    }

    /**
     * ★ dws：用户自备那份优先，随包的开源版兜底。
     *
     * 判据是「文件真的在」而不是「设了这个值」—— 用户换机器 / 卸了闭源包
     * 之后那条路径会失效，此时**静默退回随包版**比让渠道整个不可用好得多
     * （后者的表现是 onboarding 直接走不下去，而用户并不知道是路径的问题）。
     *
     * 可执行位与"真的能跑"由落地那一侧保证：随包那份走 `prepare:bin` 的
     * installExecutable（unlink→copy→chmod→重签→spawn 一次 --version），
     * 用户自备那份由保存时的校验保证（见 desktop 的 dws-source service）。
     * 这里只补可执行位，不重复那套检查。
     */
    if (name === "dws") {
      const override = this.options.dwsBinOverride
      if (override !== undefined && override !== "" && isFile(override)) {
        ensureExecutable(override)
        return { name, path: override, platform: platformSuffix(), source: "env" }
      }
    }

    const path = join(this.options.binDir, fileName(name))

    try {
      const stats = statSync(path)
      if (!stats.isFile()) throw new Error("not a file")
    } catch {
      throw new AppError(
        "RUNTIME_BINARY_MISSING",
        `缺少预置可执行文件 ${fileName(name)}。\n` +
          `期望位置：${path}\n` +
          `请运行 pnpm prepare:bin 准备（当前平台：${platformSuffix()}）`,
        {
          messageKey: "errors:runtime.binaryMissing",
          messageParams: { file: fileName(name), path, command: "pnpm prepare:bin" },
          context: { name, path, platform: platformSuffix() },
        },
      )
    }

    // 从 asar/extraResources 解出的文件可能丢掉可执行位，这里补上。
    try {
      accessSync(path, constants.X_OK)
    } catch {
      try {
        chmodSync(path, 0o755)
      } catch (error) {
        throw new AppError("RUNTIME_BINARY_MISSING", `无法为 ${fileName(name)} 设置可执行权限`, {
          cause: error,
          messageKey: "errors:runtime.binaryNotExecutable",
          messageParams: { file: fileName(name), path },
          context: { path },
        })
      }
    }

    return { name, path, platform: platformSuffix(), source: "bundled" }
  }
  /**
   * opencode 的四档解析。返回 null 表示「没找到」。
   *
   * 用 `tryResolve` 而不是让 `resolve` 抛错：opencode 缺失是**预期状态**，
   * 不是异常 —— 应用要能在没有它的情况下降级到内置 harness 继续工作。
   * 把预期状态做成异常，会让调用方到处写 try/catch 来表达「正常情况」。
   *
   * ★ 档位顺序（`bundled` 最优先是关键）：
   *   1. `bundled` —— `binDir/opencode-<plat>-<arch>`，prepare-bin 从 npm 平台包
   *      拷来的那份。dev 与打包共用它，从而**不受用户本机 opencode 影响**。
   *   2. `env` —— `MYCONTEXT_OPENCODE_BIN`，逃生阀（联调换版本）。
   *   3. `home` / `path` —— 本机装的那份，仅当上面都没有时的兜底。
   */
  tryResolveOpencode(): ResolvedBinary | null {
    const env = this.options.env ?? process.env

    // 1. bundled：prepare-bin 从 npm 平台包拷进 binDir 的那份（dev 与打包同源）。
    const bundled = join(this.options.binDir, fileName("opencode"))
    if (isFile(bundled)) {
      // asar/extraResources 解出的文件可能丢可执行位（与 dws 同一处理）。
      ensureExecutable(bundled)
      return { name: "opencode", path: bundled, platform: platformSuffix(), source: "bundled" }
    }

    // 2. env 逃生阀。
    const explicit = env["MYCONTEXT_OPENCODE_BIN"]
    if (explicit !== undefined && explicit !== "" && isFile(explicit)) {
      return { name: "opencode", path: explicit, platform: platformSuffix(), source: "env" }
    }

    // 3. 官方安装器默认位置。
    const home = join(homedir(), ".opencode", "bin", OPENCODE_EXE)
    if (isFile(home)) {
      return { name: "opencode", path: home, platform: platformSuffix(), source: "home" }
    }

    // 4. PATH。
    for (const dir of (env["PATH"] ?? "").split(delimiter)) {
      if (dir === "") continue
      const candidate = join(dir, OPENCODE_EXE)
      if (existsSync(candidate) && isFile(candidate)) {
        return { name: "opencode", path: candidate, platform: platformSuffix(), source: "path" }
      }
    }

    return null
  }

  /**
   * 解析 + **版本闸**。这是调用方（persona-acp / search）真正该用的入口。
   *
   * ## 为什么解析和"可用"要分成两个方法
   *
   * `tryResolveOpencode` 只回答"找到了吗"。而"能不能用"还要过版本闸 ——
   * 低于 `MIN_OPENCODE_VERSION` 的那份**找得到但用不了**（ACP 会 -32603）。
   * 把这两件事混成一个，调用方就没法把"没装"（引导去装）与"太老"
   * （引导去升级）区分开，而这两种给用户的下一步完全不同。
   *
   * 版本读不出来时判 `unreadable_version` 并**拒绝**（fail closed）：
   * 一个连 `--version` 都跑不出的二进制，没有理由信任它的 ACP。
   *
   * @param probe 注入的版本探针（本文件受 spawn 门禁约束，不能自己起进程）。
   */
  resolveUsableOpencode(probe: OpencodeVersionProbe): OpencodeResolution {
    const binary = this.tryResolveOpencode()
    if (binary === null) return { ok: false, reason: "missing" }

    const raw = probe(binary.path)
    const parsed = raw === null ? null : parseSemver(raw)
    if (parsed === null) return { ok: false, reason: "unreadable_version", binary }

    const required = parseSemver(MIN_OPENCODE_VERSION)
    // MIN_OPENCODE_VERSION 是编译期常量，解析必成功；兜底只为类型收窄。
    if (required === null || !semverGte(parsed, required)) {
      return {
        ok: false,
        reason: "too_old",
        binary,
        found: `${parsed[0]}.${parsed[1]}.${parsed[2]}`,
        required: MIN_OPENCODE_VERSION,
      }
    }
    return { ok: true, binary, version: `${parsed[0]}.${parsed[1]}.${parsed[2]}` }
  }

  /**
   * Python 解释器解析。返回 null 表示「没有可用的」——**这是预期状态**，
   * 蒸馏降级即可。
   *
   * 第一优先是**内置**那份（`repoRoot` 给了才有这一档）：它随包分发、版本由
   * 我们钉。本机的只作兜底 —— 实测过 PATH 上的 `python3` 是**另一个项目
   * venv 里的解释器**，而蒸馏跑在那上面等于把一个外部项目的生命周期
   * 接进了我们的功能。详见 `./python.ts` 里那一档的注释。
   *
   * 实现在 ./python.ts：它要执行候选来读版本，而本文件受 spawn 门禁约束。
   * 这里保留一个方法是为了调用方便 —— 主进程已经持有 RuntimeEnv，
   * 不必为了一个解释器再传一份 env 进去。
   */
  tryResolvePython(runVersionProbe?: PythonVersionProbe): ResolvedPython | null {
    return resolvePython(this.options.env ?? process.env, runVersionProbe, this.options.repoRoot)
  }

  /**
   * 钉住身份的命令行参数（`["--profile", "<corpId>:<userId>"]`，没钉时空数组）。
   *
   * ## ★ 为什么是命令行参数而不是环境变量
   *
   * 上游没有等价的环境变量 —— 身份只能经 `--profile` 传。所以它**不能**
   * 放进 `buildEnv()`：那会是一个看起来生效、实际被完全忽略的注入
   * （而"设了没生效"是本仓库反复出现的那类静默失效）。
   *
   * ## ★ 追加在**子命令之后**是安全的
   *
   * 白名单门禁的 `commandPath()` 遇到第一个 `-` 开头的 token 就停，
   * 所以追加在末尾既不影响命令匹配，也不影响 `-y` 的注入判定。
   * 实测上游对 `dws auth status -f json --profile X` 与
   * `dws --profile X auth status -f json` 行为一致。
   *
   * ## ★ 空值一律当"没钉"
   *
   * getter 返回空串/空白（vault 还没绑身份、或反查不到）时给空数组，
   * 而不是 `["--profile", ""]` —— 后者会让上游报"组织未找到"，
   * 把"还没绑身份"这个正常状态变成一个错误。
   */
  dwsProfileArgs(): string[] {
    const value = this.options.dwsProfile?.()
    if (value === undefined || value.trim() === "") return []
    return ["--profile", value.trim()]
  }

  /**
   * 身份钉住了吗。`false` = 当前没有绑定身份。
   *
   * ## ★★ 为什么需要显式问一句，而不是看 `dwsProfileArgs()` 是不是空
   *
   * 那个方法在没绑身份时返回**空数组**，而空数组拼进 args 里是完全无害的
   * —— 命令照样跑，只是**不带 `--profile`**，于是跟着渠道 CLI 的
   * **全局 currentProfile** 走。而那个值由用户在终端里的最后一次操作决定，
   * 可能是另一个组织。
   *
   * 也就是说「没绑身份」这个状态会静默降级成「用 CLI 里现成的登录态」——
   * 而我们的原则是**只做用户在这个应用里授权过的事**，不借用环境里
   * 已有的凭据（CLAUDE.md §5：不许扩大读取面）。
   *
   * 调用方拿 `[...args, ...dwsProfileArgs()]` 时看不出这个区别（两种情况
   * 都"正常"），所以判据必须单独暴露出来、由每个起子进程的地方显式处置。
   */
  hasPinnedIdentity(): boolean {
    const value = this.options.dwsProfile?.()
    return value !== undefined && value.trim() !== ""
  }

  /**
   * 组装子进程环境变量。
   *
   * DWS_CONFIG_DIR 指向应用数据目录：把 profiles 与日志与用户自己终端里的
   * dws 分开。注意 token 本身由 macOS Keychain（服务名 dws-cli）按系统用户存储，
   * **无法通过此变量隔离**——这是 DWS 的既有行为，UI 层需要向用户说明。
   */
  buildEnv(extra: Record<string, string> = {}): Record<string, string> {
    /**
     * dwsConfigDir 必须是绝对路径 —— fail-fast 而不是「跑起来再说」。
     *
     * 实测三组行为：
     *   ① 绝对路径          → 正确写入该目录，**不碰 cwd**
     *   ② 未设置            → 写入 ~/.dws，**也不碰 cwd**（即使 cwd 下已有 .dws/）
     *   ③ **相对路径或空串** → 在 **cwd 下**创建 .dws/（已复现）
     *
     * 也就是说：`resources/bin/.dws/`（含真实 token，本仓库已泄漏过一次）
     * 的唯一成因是第 ③ 种。因此根因修复是在这里断言，
     * 而**不是**把 cwd 改成 dwsConfigDir —— 后者治不了根因，
     * 还会在相对路径场景下让 .dws 嵌套进它自己。
     */
    if (!isAbsolute(this.options.dwsConfigDir)) {
      throw new AppError(
        "CONFIG_INVALID",
        `dwsConfigDir 必须是绝对路径，实际收到 ${JSON.stringify(this.options.dwsConfigDir)}。` +
          "相对路径会让外部程序把凭据写进当前工作目录。",
        {
          messageKey: "errors:config.invalid",
          messageParams: { detail: "dwsConfigDir must be absolute" },
          context: { dwsConfigDir: this.options.dwsConfigDir },
        },
      )
    }

    const base: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.options.env ?? process.env)) {
      if (value !== undefined) base[key] = value
    }
    return {
      ...base,
      /**
       * ★ 渠道号**只在非空时**注入。
       *
       * 开源发布缺省不带渠道号（见 kernel/config.ts 的 dwsChannel），
       * 而无条件写 `DWS_CHANNEL: ""` 会把**继承来的**那个值覆盖掉 ——
       * 内部同学在 shell 里 export 过渠道号时，应用这边反而把它擦成空串，
       * 表现是"明明设了却不生效"，且完全静默。
       *
       * 上游对「空串」与「未设置」等价处理（三处读它都是 `if v != ""` 的守卫），
       * 所以"不注入"与"注入空串"对 dws 本身没区别 —— 区别只在会不会踩掉继承值。
       */
      ...(this.options.dwsChannel === "" ? {} : { DWS_CHANNEL: this.options.dwsChannel }),
      DWS_CONFIG_DIR: this.options.dwsConfigDir,
      ...extra,
    }
  }
}
