/**
 * forge 蒸馏引擎的宿主。
 *
 * ## 这一层的职责边界
 *
 * · **写配置** —— forge 是配置驱动的 CLI，路径与开关全由这里给定；
 * · **起进程** —— `pull` → `build` → `publish` 三步，逐行读它的 JSON 输出；
 * · **不理解测量** —— 那全在 `vendor/forge/` 里（纯 Python、零模型调用、
 *   768 项离线自测）。这里既不解析它的结论，也不替它做判断。
 *
 * 分开的理由与 `DistillService` 对 `DistillRunner` 一样：进程编排要碰
 * 定时器、BrowserWindow、用户点了什么，而测量逻辑不该被这些拖住。
 *
 * ## ★ 落点：userData，按 vault 隔离
 *
 * forge 上游 `init` 的默认 `skillRoots` 是 `~/.claude/skills/<slug>-persona`
 * 与 `~/.codex/skills/<slug>-persona`。对「自己给自己炼画像」那是对的，
 * 对本应用是三重错误：那是**运行这台机器的人**的 agent 配置（应用无权写）、
 * 多账号会打在同一路径上互相覆盖、卸载应用也带不走。
 *
 * 所以路径一律由这里给（`VaultStore.forgeRoot()` / `skillRoot()`），
 * 并且在配置里置 `ownsOutput: true` —— 那会让 `publish.py` 主动**拒绝**
 * 写入任何 agent 配置目录。两边都设防，因为「记得传对路径」不是可依赖的保证，
 * 而这个错误一旦发生是静默的：skill 装上了、能用，只是出现在了一个
 * 没人打算改动的 agent 里。
 *
 * ## ★ 为什么 env 不能用来传配置
 *
 * 本应用的 dotenv **只灌进自己的 config，不写 `process.env`**
 * （kl 那边踩过：`.env` 里的 `KL_PYTHON` 到不了子进程，退回系统 python3
 * 缺依赖 → 一起来就 exit 3）。所以 forge 需要的一切都写进它的配置文件，
 * 不依赖环境变量透传。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Clock, type Logger } from "@mycontext/kernel"
import type { ProcessRunner, ResolvedPython } from "@mycontext/runtime-env"
import { WORK_LAYER_SKILL_PATH as WORK_LAYER_PATH } from "./persona-gate.js"
import {
  SelfIdentityRepository,
  openStore,
  readCollectionScope,
  type SqliteDatabase,
} from "@mycontext/store"

/** forge 的三步。顺序固定：语料 → 特征 → 产物。 */
export type ForgeStep = "pull" | "build" | "publish"

/**
 * work 层产物在 skill 包里的相对路径。
 *
 * ★ **真源在 `persona-gate.ts`**（那里写了为什么放那儿）。这里 re-export 是为了
 * 让 `startup.ts` 继续从这个模块拿它 —— 一个字符串常量有三个消费者
 * （这里进 `externalSkillFiles`、startup 拼落盘路径、persona.service 进参考件
 * 白名单），各写一份字面量必然漂，而漂的表现是静默的：写在 A 路径、读 B 路径，
 * 文件在磁盘上却没人读，不报错。
 */
export { WORK_LAYER_SKILL_PATH } from "./persona-gate.js"

/**
 * 单步超时。
 *
 * `pull` 是本地 SQL 投影（实测 4400 条约 2 秒），`build` 要做全量测量与
 * 决策挖掘（实测同样量级约 3 秒）。给到分钟级是为了容纳十万条量级的语料，
 * 而不是因为现在慢。到点算失败，不无限等 —— 卡住的子进程比失败更难查。
 */
const STEP_TIMEOUT_MS: Record<ForgeStep, number> = {
  pull: 600_000,
  build: 900_000,
  publish: 120_000,
}

export interface ForgeRunResult {
  ok: boolean
  /** 失败时停在哪一步（成功时为 null） */
  failedStep: ForgeStep | null
  /** 人话原因，直接可显示 */
  reason: string | null
  /** forge 当前语料库里的本人消息总数 */
  messages: number
  /** 配对出的 (上下文 → 我的回复) 数 */
  turns: number
  /** 挖掘出的「别人问我」数，含没回的 */
  asks: number
  /** 发布出的文件数 */
  files: number
  /** 产物根目录（persona 包的父目录） */
  skillRoot: string
  /** forge 判定的覆盖度等级 A–D（读不到时 null） */
  grade: string | null
}

export interface ForgeServiceOptions {
  clock: Clock
  logger: Logger
  processes: ProcessRunner
  /** 随包分发的 forge 源码目录（`python3 -m forge` 的 cwd） */
  forgeDir: string
  /** 解析出的 Python 解释器；null = 没有可用的 → 蒸馏降级 */
  python: ResolvedPython | null
  /**
   * 时区偏移（分钟）。
   *
   * 必须显式传：vault 存的是 unix 毫秒，而「几点活跃」是本地时间的问题。
   * 读运行环境的时区会让同一份语料在出过差的笔记本上测出不同的作息。
   */
  offsetMinutes?: number
  /**
   * 界面语言 → 蒸馏用哪个 locale pack。
   *
   * ## ★ 为什么不能让 forge 自己 `auto` 判
   *
   * `auto` 是按**本人自己消息的字符集直方图**判的，而中英混写的技术岗
   * 恰好落在它的判定边界上。实测同一个人的语料：
   * · 一次 Latin 51.8% / Han 48.2% → 走「加权」分支 → `zh-CN`，等级 A；
   * · 补了历史之后 Han 52.1% / Latin 47.9% → 加权分支不触发，
   *   而 52.1 vs 47.9 又达不到「明显领先」的阈值 → **`null` pack**，等级 D。
   *
   * `null` pack 意味着**所有词级层全部缺失**（ask 分类、改口/推脱/澄清的
   * 真实说法），产物看起来还是完整的，只是决策层退回默认值。也就是说
   * 「多采了几天历史」会让画像变差，而原因在任何界面上都看不出来。
   *
   * 应用**知道**用户的语言（设置里就有），没有理由把这件事交给一个
   * 在 52/48 上抛硬币的判定。传 null 时才退回 `auto`。
   */
  localeId?: string | null
}

export class ForgeService {
  constructor(private readonly options: ForgeServiceOptions) {}

  /**
   * 能不能跑。缺 Python 或缺引擎都是**预期状态**，不是异常 ——
   * 状态页要能显示「为什么降级」，而不是让调用方去 catch。
   */
  availability(): { ok: boolean; reason: string | null } {
    if (this.options.python === null) {
      return {
        ok: false,
        reason:
          "未检测到可用的 Python 3.9+。内置解释器（vendor/python）不可用，" +
          "本机也没找到 —— 跑 pnpm setup:python 补内置那份，" +
          "或用 MYCONTEXT_PYTHON_BIN 指定一个。",
      }
    }
    if (!existsSync(join(this.options.forgeDir, "forge", "__main__.py"))) {
      return {
        ok: false,
        reason: `缺少蒸馏引擎：${this.options.forgeDir}。请运行 pnpm prepare:bin。`,
      }
    }
    return { ok: true, reason: null }
  }

  /**
   * 清掉增量水位，让下一轮真的从头蒸。
   *
   * ## ★ 为什么必须有这个方法
   *
   * forge 的 `--since auto` 是从它**自己派生库**里的 `pulledThrough` meta
   * 续跑的。而「重新蒸馏」按钮原来只清 `distill_tasks` 与 `distill_sources`
   * —— 那两张表现在只有 LLM runner 在用（默认还是关的）。于是用户点了
   * 「重新蒸馏」，forge 照旧只增量跑，什么都没重来，而按钮看起来生效了。
   *
   * ## 只删 meta，不删语料
   *
   * 删掉整个派生库会一起丢掉用户手写的 owner 块（那是 forge 唯一
   * 不可重建的东西）。清掉水位就够了：`pull` 会从 `analysisStart` 重新
   * 逐片跑，而 `insert_message` 本来就是幂等的（按平台 id 去重）。
   *
   * 返回是否真的清掉了。库不存在（还没蒸过）时是 false —— **那不是错误**，
   * 那时下一轮本来就是全量。
   */
  resetWatermark(forgeRoot: string): boolean {
    const path = join(forgeRoot, "database", "persona.db")
    if (!existsSync(path)) return false
    try {
      /**
       * 用 better-sqlite3 直接删那一行。
       *
       * 不起一个 Python 进程去做：那要多一条 CLI 子命令（上游没有），
       * 而这是一次单行 DELETE。表名与键名跟 `forge/store.py` 的 `set_meta`
       * 同源 —— 对不上时 `changes` 是 0，会如实返回 false 而不是假装成功。
       */
      const db = openStore({ path, migrations: [] })
      try {
        const result = db.db.prepare("DELETE FROM meta WHERE key = 'pulledThrough'").run()
        this.options.logger.info("forge watermark cleared", { changes: result.changes })
        return result.changes > 0
      } finally {
        db.close()
      }
    } catch (error) {
      /**
       * 清不掉只降级成「下一轮仍是增量」，不抛。
       *
       * 抛的话「重新蒸馏」这个按钮会整个失败，而用户真正想做的事
       * （重新跑一遍）本来还是能做的 —— 只是没那么彻底。
       */
      this.options.logger.warn("forge watermark reset failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * 跑完整一轮：pull → build → publish。
   *
   * **不抛**。每一步失败都带着「停在哪」与原因返回 —— 蒸馏失败是要显示给
   * 用户的状态，而不是要让上层 try/catch 的异常。
   */
  async run(input: {
    db: SqliteDatabase
    vaultPath: string
    forgeRoot: string
    skillRoot: string
    /** 只蒸这个时间点之后的（unix ms）；null = 用 forge 的增量水位 */
    since: number | null
    /**
     * 只**测量**最近这么多天（`build --window-days`）。
     *
     * ## ★ 为什么这个参数与 `since` 不能合并
     *
     * `since` 管的是「什么进语料库」，这个管的是「build 看哪一段」，两者不等价：
     * 语料库一旦有了半年（用户选过宽范围，或 `resolveSince` 回扫过），之后每次
     * build 都会把半年全部测进去 —— 也就是**「重蒸最近 30 天」做不到**，
     * 除非先清掉派生库，而那会扔掉不可再采的历史。
     *
     * 窗口是非破坏性的：语料一条不删，下次不传这个参数就又是全量。
     *
     * `undefined` = 不传（读 forge 配置里的 `measureWindowDays`，默认 0 = 全量）。
     */
    windowDays?: number | null
    signal?: AbortSignal
    /**
     * 每进入一个阶段回调一次。
     *
     * ## ★ 为什么需要它
     *
     * 三个阶段（pull → build → publish）实测合起来几十秒到几分钟，
     * 而在此之前**整个过程只有开始与结束两个事件**：界面上是一句
     * "正在蒸馏…" 干等到底，看不出走到哪了（用户的原话是"很塑料，很拉"）。
     *
     * `forgeStatus.step` 这个字段在 IPC 契约里**早就声明了**
     * （`"pull" | "build" | "publish"`），只是主进程一直写死 `null`
     * ——注释写着"具体到哪一步要 forge 逐行回调，暂不接"。这就是那个回调。
     *
     * 只报"进入了哪个阶段"，不报百分比：每个阶段内部的进度我们**拿不到**
     * （`runStep` 只解析末尾那个 JSON），编一个百分比出来是在撒谎。
     */
    onStep?: (step: ForgeStep) => void
  }): Promise<ForgeRunResult> {
    const empty: ForgeRunResult = {
      ok: false,
      failedStep: null,
      reason: null,
      messages: 0,
      turns: 0,
      asks: 0,
      files: 0,
      skillRoot: input.skillRoot,
      grade: null,
    }

    const available = this.availability()
    if (!available.ok) return { ...empty, reason: available.reason }

    /**
     * 身份未确认就不跑。
     *
     * forge 侧的 vault 源同样会拒（`confirmed_at IS NULL` 直接退出），
     * 但在这里先判一次是为了给**可执行的**提示：起一个进程再让它失败，
     * 用户看到的是一行 Python 退出信息，而不是「先去状态页确认身份」。
     */
    const identity = new SelfIdentityRepository(input.db).get("dingtalk")
    if (identity === null || identity.confirmedAt === null) {
      return {
        ...empty,
        reason: "本人身份未确认 —— 先在状态页确认身份，让应用回填 is_self，再蒸馏。",
      }
    }

    const configPath = this.writeConfig(input)

    input.onStep?.("pull")
    /**
     * 调用方给了显式 since 就照办；给 null（"用增量水位"）时**再判一次**
     * vault 里是否有 forge 还没覆盖的更早语料 —— 见 `resolveSince`。
     *
     * 不能无条件用 auto：那会让"应用补回来的历史"永远进不了画像。
     */
    const since = input.since ?? this.resolveSince(input)
    const pull = await this.runStep("pull", configPath, input.signal, [
      "--since",
      since === null ? "auto" : isoLocal(since, this.offsetMinutes()),
    ])
    if (!pull.ok) return { ...empty, failedStep: "pull", reason: pull.reason }

    const pulled = pull.payload as {
      inserted?: number
      complete?: boolean
      note?: string
      sourceStats?: { unjudgedRows?: number }
    }
    const inserted = pulled.inserted ?? 0

    input.onStep?.("build")
    /**
     * ★ 把测量窗口传下去。
     *
     * 不传（`undefined` / `null`）时 forge 读配置里的 `measureWindowDays`
     * （缺省 0 = 全量），与改这个参数之前的行为一致。
     */
    const buildArgs =
      input.windowDays === undefined || input.windowDays === null || input.windowDays <= 0
        ? []
        : ["--window-days", String(Math.floor(input.windowDays))]
    const build = await this.runStep("build", configPath, input.signal, buildArgs)
    if (!build.ok) {
      return { ...empty, messages: inserted, failedStep: "build", reason: build.reason }
    }
    const built = build.payload as {
      corpus?: { selfMessages?: number; turns?: number; asks?: number }
      warnings?: { code?: string; detail?: string }[]
    }
    /**
     * `pull.inserted` 只是本轮新增数：幂等重跑时会从 N 变成 0，
     * 但语料库和配对都还在。结果页展示当前语料规模，必须读 build 的累计值。
     * 兼容旧 Forge：缺 `selfMessages` 时退回本轮新增数。
     */
    const messages = built.corpus?.selfMessages ?? inserted
    const turns = built.corpus?.turns ?? 0
    const asks = built.corpus?.asks ?? 0

    /**
     * ★ `asks === 0` 是**失败**，不是「这个人没被问过」。
     *
     * forge 自己也报 `no_asks_mined`，理由值得复述：单聊被误判成群聊时
     * 一条 ask 都挖不出来，而**风格层照常有数字** —— 产物看起来是完整的，
     * 只是决策层整个退化成默认值。静默通过的话没人会去看 fidelity.md。
     */
    const warnings = built.warnings ?? []
    if (warnings.length > 0) {
      this.options.logger.warn("forge build warned", { warnings })
    }

    input.onStep?.("publish")
    const publish = await this.runStep("publish", configPath, input.signal)
    if (!publish.ok) {
      return { ...empty, messages, turns, asks, failedStep: "publish", reason: publish.reason }
    }
    const published = publish.payload as { files?: number }
    const coverage = readGrade(input.skillRoot)
    if (coverage.unreadable) {
      /**
       * 产物在、但那句话匹配不上 —— 几乎只可能是上游改了 `fidelity.md`
       * 的文案。记 warn 让它可见：静默返回 null 的话这个耦合会一直坏着，
       * 而"没有等级"看起来和"还没蒸完"一样。
       */
      this.options.logger.warn(
        "forge coverage grade unreadable; upstream wording may have changed",
        {
          path: join(input.skillRoot, "persona-persona", "references", "fidelity.md"),
        },
      )
    }

    const result: ForgeRunResult = {
      ok: true,
      failedStep: null,
      // 语料不完整时把原因带出来（身份没回填完、时间戳不可用等）。
      reason: pulled.complete === false ? (pulled.note ?? null) : null,
      messages,
      turns,
      asks,
      files: published.files ?? 0,
      skillRoot: input.skillRoot,
      grade: coverage.grade,
    }
    this.options.logger.info("forge run finished", {
      messages,
      turns,
      asks,
      files: result.files,
      grade: result.grade,
      unjudged: pulled.sourceStats?.unjudgedRows ?? 0,
    })
    return result
  }

  private offsetMinutes(): number {
    return this.options.offsetMinutes ?? 8 * 60
  }

  /**
   * 本人的显示名，来自已确认的身份表。
   *
   * 回退到 slug 而不是抛错：`run()` 在此之前已经拒过未确认的身份，所以走到
   * 这里必然有行；这个回退只是让「表结构变了」不至于让蒸馏整个失败。
   */
  private ownerName(db: SqliteDatabase): string {
    const identity = new SelfIdentityRepository(db).get("dingtalk")
    return identity?.displayNames[0] ?? "persona"
  }

  /**
   * 本人身份的事实清单，进产物的「你在替谁说话」一节。
   *
   * 只取**已确认**的身份表里的字段，一条也不推断：多一条编出来的「职位」
   * 就是 agent 将来会理直气壮说错的一句话。姓名的别名一起给，因为群里
   * 对方可能用花名叫本人，agent 要认得出那也是在叫自己。
   */
  private ownerFacts(db: SqliteDatabase): string[] {
    const identity = new SelfIdentityRepository(db).get("dingtalk")
    if (identity === null) return []
    const facts: string[] = []
    const [primary, ...aliases] = identity.displayNames
    if (primary !== undefined) {
      facts.push(
        aliases.length > 0
          ? `你就是 ${primary}（也被叫作 ${aliases.join("、")}）。`
          : `你就是 ${primary}。`,
      )
    }
    if (identity.corpName !== null && identity.corpName !== "") {
      facts.push(`所在组织：${identity.corpName}。`)
    }
    return facts
  }

  /**
   * 用户勾选的会话白名单；空数组 = 不限。
   *
   * 判据走 `@mycontext/store` 的 `readCollectionScope`（唯一权威）——
   * 修复前采集/蒸馏/forge/导出各有一份实现，而它们对"源被关掉"的解读
   * 已经漂成了「不限」（= 蒸全部）。见 collection-scope.ts 文件头。
   *
   * ★ 源关掉现在是「一个都不蒸」而不是「不限」：关掉聊天源的语义只可能是
   * "别用聊天记录"，不可能是"用全部聊天记录"。
   */
  private scopedConversationIds(db: SqliteDatabase): string[] {
    try {
      const scope = readCollectionScope(db)
      if (!scope.restricted) return []
      return [...scope.allow]
    } catch (error) {
      /**
       * 读不出来退回"不限"，不抛。
       *
       * 方向是刻意的：多蒸几个会话是画像偏一点，而让整轮蒸馏因为读不到
       * 一个可选配置而失败，用户看到的是"蒸馏坏了"而不是"范围没生效"。
       */
      this.options.logger.warn("forge scope probe failed; distilling every conversation", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  /**
   * 决定这一轮该给 forge 的 `--since`：`null` = 用它自己的水位续跑。
   *
   * ## ★ 为什么不能一直传 auto
   *
   * `--since auto` 从 forge **自己派生库**里的 `pulledThrough` 续跑，
   * 而那个 checkpoint 只向前（`ingest.py` 每个成功切片把它推到切片右端）。
   * 关键是：走 auto 分支时配置里的 `analysisStart` **完全不参与** ——
   * `resolve_window` 只在没有 checkpoint 时才读它。
   *
   * 于是「先让应用补回半年历史、再蒸馏」这条路是**走不通**的：
   * 实测同一份 `analysisStart: 2026-02-01`，空库时切 26 片（02-01→08-01），
   * 而有了 `pulledThrough: 08-01 00:47` 之后只切 1 片（08-01 00:17→10:32）。
   * 补进 vault 的那 172 天 forge 一眼都不会看。
   *
   * 而这个落差是**静默**的：pull 报 `inserted: 0`（确实没有新的），
   * build 照常出数字，publish 照常写文件，grade 可能还是 A ——
   * 唯一的症状是画像薄，而「薄」没有参照物。
   *
   * ## 判据：vault 里有 forge 没覆盖到的更早语料
   *
   * 比「用户选了 180 天」更直接：用户选的范围是**意图**，而 forge 该不该
   * 重扫取决于**事实** —— vault 的左端是否比 forge 语料的左端更早。
   * 采集是渐进的（一轮补一个 7 天窗），用事实判据能让 forge 跟着一段段
   * 往回扫，而不必等整段历史补完。
   *
   * 阈值 1 天：两边的左端天然有小的抖动（forge 按天切片、且 overlap
   * 会让边界差几分钟）。不设阈值会让每轮都判定成"要全量重扫"，
   * 那就等于永久关掉增量 —— 每次蒸馏都从半年前重跑一遍。
   */
  private resolveSince(input: { db: SqliteDatabase; forgeRoot: string }): number | null {
    const vaultEarliest = this.earliestMs(input.db)
    if (vaultEarliest === null) return null

    const corpusEarliest = this.corpusEarliestMs(input.forgeRoot)
    /**
     * forge 还没有语料 → 让它走 full（读 `analysisStart`，那已经是
     * vault 的左端）。传显式 since 也一样，但 null 让日志里的 mode
     * 如实显示 "full"。
     */
    if (corpusEarliest === null) return null

    const DAY_MS = 86_400_000
    if (corpusEarliest - vaultEarliest <= DAY_MS) return null

    /**
     * vault 有更早的语料 → 显式从 vault 的左端重扫。
     *
     * 重扫是安全的：`insert_message` 按平台 id 幂等，重复切片只花时间
     * 不产生重复行。代价是这一轮慢（26 个切片而不是 1 个），但它只在
     * 「刚补回一段历史」之后发生，补完就自然回落到增量。
     */
    this.options.logger.info("forge will rescan earlier history", {
      vaultEarliest: new Date(vaultEarliest).toISOString(),
      corpusEarliest: new Date(corpusEarliest).toISOString(),
      behindDays: Math.round((corpusEarliest - vaultEarliest) / DAY_MS),
    })
    return vaultEarliest
  }

  /** vault 里最早一条消息的 unix ms；null = 空库。 */
  private earliestMs(db: SqliteDatabase): number | null {
    return (
      db
        .prepare<
          [],
          { earliest: number | null }
        >("SELECT MIN(sent_at) AS earliest FROM messages WHERE channel_id = 'dingtalk'")
        .get()?.earliest ?? null
    )
  }

  /**
   * forge 语料里最早一条消息的 unix ms；null = 还没有语料。
   *
   * ★ 读 `messages` 的实际左端而不是 `pulledThrough`：那个 meta 是**右**端
   * （已拉到哪），回答不了"最早覆盖到哪"。用它判断会永远得出"没落后"。
   */
  private corpusEarliestMs(forgeRoot: string): number | null {
    const path = join(forgeRoot, "database", "persona.db")
    if (!existsSync(path)) return null
    try {
      const handle = openStore({ path, migrations: [] })
      try {
        const row = handle.db
          .prepare<[], { earliest: number | null }>("SELECT MIN(epoch) AS earliest FROM messages")
          .get()
        const epoch = row?.earliest ?? null
        // forge 的 `epoch` 是秒（REAL）；0/空表示没有可用的语料。
        return epoch === null || epoch <= 0 ? null : Math.round(epoch * 1000)
      } finally {
        handle.close()
      }
    } catch (error) {
      /**
       * 读不出来就退回 auto，不抛。
       *
       * 这是个**优化判据**，不是正确性前提：读失败时最坏结果是"这一轮
       * 仍然只增量跑"，而让整轮蒸馏因为探测失败而挂掉是不成比例的。
       */
      this.options.logger.warn("forge corpus probe failed; falling back to incremental", {
        detail: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * 库里最早一条消息的日期（`YYYY-MM-DD`，本地）。
   *
   * 空库时退回今天：那时 pull 会得到 0 条并如实报出来，而给一个远古日期
   * 会让它白跑几百个空切片。
   */
  /**
   * 全量回溯的起点日期（YYYY-MM-DD）。
   *
   * ★ 优先用**用户选的下界** `scope.since`（引导里那个范围），而不是库里
   * 最早那条消息 —— 否则用户选了"最近 30 天"，forge 仍从库里最早（可能半年前）
   * 起逐 7 天切片跑到今天，既慢又把范围外的语料蒸进画像。
   *
   * 只在 `scope.since` 比库里最早更晚时用它（收窄）：更早则没意义（库里没有
   * 那段数据，切空片而已）。都没有 scope 时退回 earliest，与原行为一致。
   */
  private analysisStartDate(db: SqliteDatabase): string {
    const row = db
      .prepare<
        [],
        { earliest: number | null }
      >("SELECT MIN(sent_at) AS earliest FROM messages WHERE channel_id = 'dingtalk'")
      .get()
    const earliest = row?.earliest ?? null
    const scopeSince = this.scopeSince(db)
    let ms: number
    if (earliest === null) {
      ms = scopeSince ?? this.options.clock.now()
    } else if (scopeSince !== null && scopeSince > earliest) {
      ms = scopeSince
    } else {
      ms = earliest
    }
    return isoLocal(ms, this.offsetMinutes()).slice(0, 10)
  }

  /** `distill_sources` 的 chat 源里用户选的下界（unix ms）；null = 没配 / 源关。 */
  private scopeSince(db: SqliteDatabase): number | null {
    const scope = readCollectionScope(db)
    if (!scope.enabled) return null
    return scope.since ?? null
  }

  /**
   * 写 forge 的配置文件。
   *
   * 每次运行都重写：路径里含 vaultId，而 vault 会随登录切换。留着旧的会让
   * 一个账号的蒸馏读到另一个账号的语料 —— 那是最坏的一类错误，而它不会报错。
   */
  private writeConfig(input: {
    db: SqliteDatabase
    vaultPath: string
    forgeRoot: string
    skillRoot: string
  }): string {
    for (const sub of ["database", "derived", "backups"]) {
      mkdirSync(join(input.forgeRoot, sub), { recursive: true, mode: 0o700 })
    }
    mkdirSync(input.skillRoot, { recursive: true, mode: 0o700 })

    const slug = "persona"
    const config = {
      configVersion: 3,
      profileSlug: slug,
      /**
       * 本人的显示名。
       *
       * ★ 必须真给，不能留空：forge 把它替换进产物的每一处 `{{NAME}}`
       * （SKILL.md 的标题、决策层的「{{NAME}} will follow up」、风格说明的
       * 主语）。留空时那些位置会退化成 slug，也就是字面的 "persona" ——
       * agent 于是不知道自己在替谁说话，对方问「你是谁」时只能编。
       *
       * 取 `channel_self_identity.display_names_json` 的第一个：那是应用
       * 解析并经用户**确认过**的组织内姓名，比任何猜测可靠。
       */
      displayName: this.ownerName(input.db),
      /**
       * 本人是谁 —— 事实，不是风格。
       *
       * forge 测的是**怎么说**，而「叫什么、在哪家公司、平时怎么称呼常聊的人」
       * 是语料里不会陈述的事实：应用在登录时就权威地知道它们（身份是它认证的）。
       * 从聊天正文里推断这些，正是「画像很自信地说错自己的职位」的来源。
       *
       * 所以这一段由应用给，且**只给已确认的**：`channel_self_identity`
       * 是用户核对过的那张表。取不到就不给 —— 产物里那一节整个不出现，
       * agent 只说「我」而不编造身份。
       */
      owner: { facts: this.ownerFacts(input.db) },
      dataRoot: input.forgeRoot,
      skillRoots: [join(input.skillRoot, `${slug}-persona`)],
      /**
       * ★ 让 publish 拒绝写入 `~/.claude` / `~/.codex` 之类目录。
       * 见文件头。默认 false 是给「个人自己用 forge」留的，这里必须 true。
       */
      ownsOutput: true,
      /**
       * ★ work 层的产物由**应用**写，forge 既不生成也不能删。
       *
       * `references/work.md` 是「他负责什么、怎么做事、定过什么规矩」——
       * 那些没有结构化信号可测（数不出来），所以走 LLM 抽取
       * （`packages/distill` 的 work facet），而 forge 的前提是零模型调用。
       *
       * 它落在 forge 的产物目录里，因为对加载 skill 的 agent 来说那是**一个**包。
       * 但不登记的话 `publish` 会把它当成"上一版留下的残留"删掉，而且是静默的：
       * prune 把它报成普通清理，应用按自己的节奏又写回去 —— 于是这个文件的
       * 存在与否取决于谁最后跑，而抽它花掉的 token 就那么没了。
       *
       * 同时 `forge lock` 也会跳过它（否则应用下一轮重写会 PermissionError，
       * 而那条路是定时跑的，表现为「work 层悄悄不更新了」）。
       */
      externalSkillFiles: [WORK_LAYER_PATH],
      /**
       * 全量回溯的起点：库里最早那条消息的日期。
       *
       * 不写死一个远古日期（forge 会从那天起逐 7 天切片跑到今天，空片也要跑），
       * 也不用「今天减 N 天」—— 那会静默漏掉更早的语料，而漏掉的部分
       * 在产物里看不出来，只是画像薄一点。
       */
      analysisStart: this.analysisStartDate(input.db),
      timezoneOffset: formatOffset(this.offsetMinutes()),
      source: {
        kind: "vault",
        options: {
          path: input.vaultPath,
          channel_id: "dingtalk",
          /**
           * 用户在引导里勾的会话白名单。
           *
           * ★ 空数组 = 不限，**必须**是空而不是省略这个键：省略与"选了 0 个"
           * 在 JSON 里同形，而后者应该是"什么都不蒸"。引导页不允许提交 0 个，
           * 所以这里的空只可能来自"没配范围"，语义就是不限。
           *
           * 传的是 `conversationIds`（与引导页、`distill_sources` 同名）。
           * vault 源两种拼写都收 —— 它以前用 `**_ignored` 吞掉未知参数，
           * 拼错会**静默无效**：pull 成功、语料照旧全量，而没有任何迹象。
           */
          conversationIds: this.scopedConversationIds(input.db),
        },
      },
      /**
       * locale pack：优先用应用知道的界面语言，拿不到才退回 `auto`。
       * 见 `ForgeServiceOptions.localeId` —— `auto` 在中英混写上会翻车。
       */
      locale: { id: this.options.localeId ?? "auto" },
      database: { path: join(input.forgeRoot, "database", "persona.db") },
      /**
       * 兜底永远是 draft_only：放开自主发送要用户在应用里显式授权
       * （已有 `dh_send_grants` 那一套），不由蒸馏的配置决定。
       */
      autonomy: { scope: "draft_only", allowlist: [], allowlistNames: [], maxCodepoints: 300 },
      /**
       * ★ `replyWindow`（曾经叫 `inbox`）。留空对象即可：`staleAfterMinutes`
       * 为 null 时 forge 用**测出来的**值（本机约 90 分钟），那比我们在这里
       * 写一个数字准。inbox skill 已随上游那半一起删掉，两个只有它用的标题
       * 过滤键也不再存在 —— 传一个已删除的键不会报错，只会静默无效。
       */
      replyWindow: {},
    }

    const configPath = join(input.forgeRoot, "persona-config.json")
    // 0600：这份配置里有 vault 的绝对路径。
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    return configPath
  }

  /** 跑一步，返回解析后的 JSON。失败时 reason 是人话。 */
  private async runStep(
    step: ForgeStep,
    configPath: string,
    signal: AbortSignal | undefined,
    extraArgs: string[] = [],
  ): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }> {
    const python = this.options.python
    if (python === null) return { ok: false, reason: "没有可用的 Python 解释器" }

    let lastLine = ""
    try {
      const result = await this.options.processes.spawn({
        executable: python.path,
        /**
         * `-B`：不写 `__pycache__`。
         *
         * 引擎目录是**构建产物**（`prepare:bin` 从 vendor 拷来），往里写字节码
         * 会让 `check:vendor-clean` 那条门禁在下一次 verify 时失败，而且缓存里
         * 带着生成时的绝对路径。
         */
        args: ["-B", "-m", "forge", step, "--config", configPath, ...extraArgs],
        env: {},
        cwd: this.options.forgeDir,
        timeoutMs: STEP_TIMEOUT_MS[step],
        ...(signal === undefined ? {} : { signal }),
        onLine: (line) => {
          if (line.trim() !== "") lastLine = line
          this.options.logger.debug("forge", { step, line })
        },
      })

      if (result.exitCode !== 0) {
        return {
          ok: false,
          reason: forgeError(step, result.stderr, result.stdout),
        }
      }
      // forge 全部输出 JSON（单个对象，多行 pretty-print）。
      return { ok: true, payload: JSON.parse(result.stdout) as unknown }
    } catch (error) {
      if (error instanceof SyntaxError) {
        // 退出码 0 但输出不是 JSON：引擎被改过或版本不匹配。
        return {
          ok: false,
          reason: `蒸馏引擎 ${step} 的输出不是 JSON（最后一行：${lastLine.slice(0, 120)}）`,
        }
      }
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `蒸馏 ${step} 失败：${detail}` }
    }
  }
}

/**
 * 从 stderr / stdout 里挑出可显示的原因。
 *
 * forge 的 `SystemExit` 消息是**写给人看的**（「先在应用里确认身份」这类），
 * 直接透出来比包一层「蒸馏失败（exit 1）」有用。Python traceback 则取最后
 * 几行 —— 前面全是调用栈，对用户没有信息。
 */
function forgeError(step: ForgeStep, stderr: string, stdout: string): string {
  const tail = stderr.trim() || stdout.trim()
  if (tail === "") return `蒸馏 ${step} 失败（无输出）`
  const lines = tail.split("\n").filter((line) => line.trim() !== "")
  const meaningful = lines.filter((line) => !/^\s+(File "|\s*\^|at )/.test(line))
  return (meaningful.length > 0 ? meaningful : lines).slice(-3).join("；").slice(0, 400)
}

/**
 * 读 forge 写进产物的覆盖度等级（A–D）。
 *
 * ## ★ 这是一个**脆弱**的耦合，而且是刻意留着的
 *
 * 等级只出现在 `fidelity.md` 的一句 Markdown 里
 * （`**N/M layers measured · coverage grade X**`）—— forge 的 `report.coverage()`
 * 有结构化输出，但 `_grade()` 的结果**没有**进任何 JSON。
 *
 * 两条路都不好：
 * · 在这里照抄它的阈值（层数比例 + 薄弱项 + `asks === 0` 判 D）——
 *   那是**第二个真源**，改了一边不会有人发现，而两边不一致时
 *   我们会显示一个和产物里写的不同的等级；
 * · 正则捞那句话 —— 上游改文案就静默失效。
 *
 * 选后者，但让失效**可见**：读到文件却匹配不上时抛出去，由调用方记一条
 * `grade_unreadable`。静默返回 null 的话，"读不到"与"上游改了文案"
 * 长得一模一样，而后者是需要有人去改代码的。
 *
 * 文件不存在时返回 null —— 那是正常状态（publish 还没跑完 / 没蒸过）。
 */
function readGrade(skillRoot: string): { grade: string | null; unreadable: boolean } {
  const path = join(skillRoot, "persona-persona", "references", "fidelity.md")
  if (!existsSync(path)) return { grade: null, unreadable: false }
  const match = /coverage grade ([A-D])/.exec(readFileSync(path, "utf8"))
  return match?.[1] === undefined
    ? { grade: null, unreadable: true }
    : { grade: match[1], unreadable: false }
}

/**
 * 读 forge 测出的 ask 频率与衰减半衰期，给 `work.md` 的 `tasks` 一节引用。
 *
 * ## ★ 这次读的是**结构化输出**，与 `readGrade` 不同
 *
 * `readGrade` 只能正则捞 `fidelity.md` 里的一句 Markdown（那个数没进任何 JSON），
 * 所以它注释里说"上游改文案就静默失效"。这里不一样：
 * `derived/features.json` 是 forge 自己写的结构化产物
 * （`decisions.replyPropensity` / `meta.recency`），读它不是权宜。
 *
 * ## ★ 为什么必须由 forge 给，而不是让 work 层自己数
 *
 * 一个数出现两次就会打架，而打架时没有任何机制决定谁赢。分工是硬的：
 * **频率是测量（forge），内容是抽取（LLM）**。work 层只把两者摆在一起。
 *
 * 读不到（还没蒸过 / 文件坏了）时返回空 —— 渲染那侧会**省掉**频率那段，
 * 而不是写「0 次」。「测出来 0 次」与「没测」是两件事（同 `fidelity.md` 的约定）。
 */
export function readForgeWorkContext(forgeRoot: string): {
  askKinds: Record<string, { asks: number; answerRatePct: number }>
  staleAfterDays: number
} {
  const empty = { askKinds: {}, staleAfterDays: 0 }
  const path = join(forgeRoot, "derived", "features.json")
  if (!existsSync(path)) return empty
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      decisions?: { replyPropensity?: Record<string, unknown> }
      meta?: { recency?: { halfLifeDays?: unknown; enabled?: unknown } }
    }
    const askKinds: Record<string, { asks: number; answerRatePct: number }> = {}
    for (const [kind, raw] of Object.entries(parsed.decisions?.replyPropensity ?? {})) {
      // `_baseline` 那一行不是 ask 类型（forge 用下划线前缀标内部键）
      if (kind.startsWith("_") || typeof raw !== "object" || raw === null) continue
      const row = raw as { asks?: unknown; answerRatePct?: unknown }
      /**
       * ★ 取 `asks`（**原始**次数）而不是 `total`（衰减后的加权质量）。
       *
       * 产物里写的是"确实发生过 N 次"，那必须是能被人核对的整数。
       * 加权质量是个小数，写进去无法验证，而 forge 自己也是把两者并列发布的。
       */
      const asks = typeof row.asks === "number" ? row.asks : 0
      const rate = typeof row.answerRatePct === "number" ? row.answerRatePct : 0
      if (asks > 0) askKinds[kind] = { asks, answerRatePct: rate }
    }
    const recency = parsed.meta?.recency
    const half = typeof recency?.halfLifeDays === "number" ? recency.halfLifeDays : 0
    // 衰减关着时不标「较早」：那时 forge 自己也不认为旧证据该降权，
    // 两层对"多旧算旧"给出不同答案会让读的人无从判断。
    const staleAfterDays = recency?.enabled === true ? half : 0
    return { askKinds, staleAfterDays }
  } catch {
    /**
     * 读坏了就当没有 —— 不抛。
     *
     * 这是一个**装饰性**输入：缺了它 `work.md` 少一个括号，而抽出来的内容
     * 一条不少。为一个装饰让整轮 work 层失败是不成比例的。
     */
    return empty
  }
}

/** unix ms → 指定偏移下的 `YYYY-MM-DD HH:MM:SS`（forge 比的是本地墙钟串）。 */
function isoLocal(ms: number, offsetMinutes: number): string {
  const shifted = new Date(ms + offsetMinutes * 60_000)
  return shifted.toISOString().slice(0, 19).replace("T", " ")
}

/** 480 → `+08:00`。 */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}
