/**
 * ForgeService：蒸馏引擎的进程编排与**落点契约**。
 *
 * 这里不起真 Python（真跑一遍在 `tests/unit/forge-vendor.test.ts` 与
 * `pnpm verify` 里，那边跑的是 vendor 里的引擎本体）—— 用 mock ProcessRunner
 * 扮演子进程，验证这一层真正负责的三件事：
 *
 *  · **写出的配置**：路径、`ownsOutput`、时区，都是契约的一部分；
 *  · **落点**：产物必须在 userData 里，绝不能是任何 agent 配置目录；
 *  · **失败不抛**：蒸馏失败是要显示给用户的状态，不是异常。
 *
 * 落点那条是这个文件存在的主要理由。forge 上游的默认值就是
 * `~/.claude/skills`，而写错了**不会报错**：skill 装上了、能用，
 * 只是出现在了一个没人打算改动的 agent 里，且卸载应用也带不走。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import type { ExecResult, ProcessRunner, ResolvedPython, SpawnSpec } from "@mycontext/runtime-env"
import {
  openStore,
  VAULT_MIGRATIONS,
  SelfIdentityRepository,
  DistillSourceRepository,
} from "@mycontext/store"
import { ForgeService, WORK_LAYER_SKILL_PATH } from "@main/services/forge.service.js"

const logger = createLogger("test", { level: "error" })
const NOW = 1_785_000_000_000

const temps: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

/** 一个假的 Python：路径不用真存在，spawn 是 mock 的。 */
const python: ResolvedPython = {
  path: "/usr/bin/python3",
  version: [3, 11, 0],
  source: "system",
}

/**
 * mock ProcessRunner。按步返回 stdout，并记下每次 spawn 的 spec ——
 * 传给 forge 的参数（`-B`、cwd、config 路径）本身就是契约。
 */
function fakeRunner(
  outputs: Partial<Record<string, unknown>> = {},
  options: { exitCode?: number; stderr?: string } = {},
) {
  const specs: SpawnSpec[] = []
  const runner = {
    async spawn(spec: SpawnSpec): Promise<ExecResult> {
      specs.push(spec)
      const step = spec.args[spec.args.indexOf("forge") + 1] ?? ""
      const payload = outputs[step] ?? {}
      return {
        exitCode: options.exitCode ?? 0,
        stdout: JSON.stringify(payload),
        stderr: options.stderr ?? "",
        timedOut: false,
      }
    },
  } as unknown as ProcessRunner
  return { runner, specs }
}

/** 一个已确认身份、有几条消息的 vault。forge 会拒绝未确认的身份。 */
function makeVault(options: { confirmed?: boolean } = {}) {
  const dir = tempDir("mycontext-forge-vault-")
  const path = join(dir, "core.sqlite")
  const handle = openStore({ path, migrations: VAULT_MIGRATIONS })
  const identity = new SelfIdentityRepository(handle.db)
  identity.upsert({
    channelId: "dingtalk",
    userId: "u-1",
    openIds: [{ kind: "openDingTalkId", value: "DSELF" }],
    displayNames: ["本人"],
    corpId: null,
    corpName: null,
  })
  if (options.confirmed !== false) identity.confirm("dingtalk", NOW)
  handle.db
    .prepare(
      `INSERT INTO conversations (id, channel_id, external_id, type, title, created_at)
       VALUES ('c1', 'dingtalk', 'ext-c1', 'direct', '对端', ?)`,
    )
    .run(NOW)
  handle.db
    .prepare(
      `INSERT INTO messages (id, channel_id, conversation_id, external_id, sender_external_id,
                             content_text, sent_at, direction, is_self, created_at)
       VALUES ('m1', 'dingtalk', 'c1', 'ext-m1', 'DSELF', '在的', ?, 'outbound', 1, ?)`,
    )
    .run(NOW - 86_400_000, NOW)
  return { handle, path }
}

/** 一个 forge 会用到的产物根 + 工作目录。 */
function makeRoots() {
  const base = tempDir("mycontext-forge-userdata-")
  return {
    forgeRoot: join(base, "vaults", "v1", "forge"),
    skillRoot: join(base, "vaults", "v1", "forge", "skills"),
    base,
  }
}

function makeService(runner: ProcessRunner, pythonOverride: ResolvedPython | null = python) {
  const forgeDir = tempDir("mycontext-forge-engine-")
  mkdirSync(join(forgeDir, "forge"), { recursive: true })
  writeFileSync(join(forgeDir, "forge", "__main__.py"), "", "utf8")
  return new ForgeService({
    clock: new ManualClock(NOW),
    logger,
    processes: runner,
    forgeDir,
    python: pythonOverride,
  })
}

const HAPPY = {
  pull: { inserted: 12, complete: true },
  build: { corpus: { turns: 8, asks: 3 }, warnings: [] },
  publish: { files: 15 },
}

describe("能不能跑（缺失是降级而非异常）", () => {
  it("没有 Python 时报出可操作的原因", () => {
    const { runner } = fakeRunner()
    const availability = makeService(runner, null).availability()
    expect(availability.ok).toBe(false)
    // 提示要说清「引擎随包但解释器不内置」，否则用户以为是安装坏了
    expect(availability.reason).toContain("Python")
  })

  it("缺引擎时指向 prepare:bin", () => {
    const { runner } = fakeRunner()
    const service = new ForgeService({
      clock: new ManualClock(NOW),
      logger,
      processes: runner,
      forgeDir: join(tempDir("mycontext-empty-"), "nope"),
      python,
    })
    expect(service.availability().reason).toContain("prepare:bin")
  })
})

describe("★ 产物落点", () => {
  it("配置里的 skillRoots 在 userData 下，且不含任何 agent 配置目录", async () => {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })

    const config = JSON.parse(
      readFileSync(join(roots.forgeRoot, "persona-config.json"), "utf8"),
    ) as { skillRoots: string[]; ownsOutput: boolean; dataRoot: string }

    expect(config.skillRoots).toHaveLength(1)
    expect(config.skillRoots[0]!.startsWith(roots.skillRoot)).toBe(true)
    expect(config.dataRoot).toBe(roots.forgeRoot)
    for (const reserved of [".claude", ".codex", ".cursor"]) {
      expect(config.skillRoots[0]!.includes(reserved), `不得落在 ${reserved} 下`).toBe(false)
    }
    // 也不能在 home 根下乱放
    expect(config.skillRoots[0]!.startsWith(join(homedir(), "."))).toBe(false)
    vault.handle.close()
  })

  it("★ ownsOutput 必须为 true（让 publish 自己也拒绝 agent 目录）", async () => {
    /**
     * 这是第二道防线：路径传对了只是这一次对，而 `ownsOutput` 让 forge
     * **永久**拒绝写入 `~/.claude` 一类目录。少了它，将来任何一处传错
     * 都会静默地把 skill 装进用户自己的 agent。
     */
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    const config = JSON.parse(
      readFileSync(join(roots.forgeRoot, "persona-config.json"), "utf8"),
    ) as { ownsOutput: boolean }
    expect(config.ownsOutput).toBe(true)
    vault.handle.close()
  })

  it("★★ work 层产物登记进 externalSkillFiles（否则下一轮 publish 把它删掉）", async () => {
    /**
     * `references/work.md` 由**应用**写（work facet 的 LLM 抽取产物），落在
     * forge 的产物目录里 —— 因为对加载 skill 的 agent 来说那是一个包。
     *
     * 不登记的话 `publish` 的 `_prune` 会把它当成"上一版留下的残留"删掉，
     * 而且是静默的：prune 报成普通清理，应用按自己的节奏又写回去 ——
     * 于是这个文件存在与否取决于谁最后跑，抽它花的 token 就那么没了。
     * 顺带 `forge lock` 也会跳过它（否则应用下一轮重写会 PermissionError，
     * 而那条路是定时跑的，表现为「work 层悄悄不更新了」）。
     */
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    const config = JSON.parse(
      readFileSync(join(roots.forgeRoot, "persona-config.json"), "utf8"),
    ) as { externalSkillFiles: string[] }
    expect(config.externalSkillFiles).toContain(WORK_LAYER_SKILL_PATH)
    vault.handle.close()
  })

  it("数据源指向这个 vault 的 core.sqlite（切账号不能读错库）", async () => {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    const config = JSON.parse(
      readFileSync(join(roots.forgeRoot, "persona-config.json"), "utf8"),
    ) as { source: { kind: string; options: { path: string } } }
    expect(config.source.kind).toBe("vault")
    expect(config.source.options.path).toBe(vault.path)
    vault.handle.close()
  })

  it("时区显式写进配置（不读运行环境）", async () => {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    const service = new ForgeService({
      clock: new ManualClock(NOW),
      logger,
      processes: runner,
      forgeDir: (() => {
        const dir = tempDir("mycontext-forge-engine-")
        mkdirSync(join(dir, "forge"), { recursive: true })
        writeFileSync(join(dir, "forge", "__main__.py"), "", "utf8")
        return dir
      })(),
      python,
      offsetMinutes: -330,
    })
    await service.run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    const config = JSON.parse(
      readFileSync(join(roots.forgeRoot, "persona-config.json"), "utf8"),
    ) as { timezoneOffset: string }
    // 读运行环境时区会让同一份语料在出过差的笔记本上测出不同的作息
    expect(config.timezoneOffset).toBe("-05:30")
    vault.handle.close()
  })
})

describe("三步编排", () => {
  it("按 pull → build → publish 顺序跑，且都不写字节码", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })

    expect(specs.map((s) => s.args[s.args.indexOf("forge") + 1])).toEqual([
      "pull",
      "build",
      "publish",
    ])
    /**
     * `-B`：引擎目录是构建产物，往里写 `__pycache__` 会让
     * `check:vendor-clean` 在下一次 verify 时失败。
     */
    for (const spec of specs) expect(spec.args).toContain("-B")
    expect(result.ok).toBe(true)
    expect(result.messages).toBe(12)
    expect(result.turns).toBe(8)
    expect(result.asks).toBe(3)
    expect(result.files).toBe(15)
    vault.handle.close()
  })

  it("重复学习展示当前本人语料总数，不把本轮新增 0 误报成语料归零", async () => {
    const { runner } = fakeRunner({
      ...HAPPY,
      pull: { inserted: 0, complete: true },
      build: { corpus: { selfMessages: 51, turns: 5, asks: 0 }, warnings: [] },
    })
    const vault = makeVault()
    const roots = makeRoots()
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })

    expect(result.messages).toBe(51)
    expect(result.turns).toBe(5)
    vault.handle.close()
  })

  it("since 给定时转成本地墙钟串传给 pull（forge 比的是字符串）", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: NOW,
    })
    const pull = specs[0]!
    const since = pull.args[pull.args.indexOf("--since") + 1] ?? ""
    // 不是 unix 数字：forge 拒绝数字时间戳（秒/毫秒无法从数值推断）
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    vault.handle.close()
  })

  it("since 为 null 时用 forge 的增量水位", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    const pull = specs[0]!
    expect(pull.args[pull.args.indexOf("--since") + 1]).toBe("auto")
    vault.handle.close()
  })

  /**
   * ★★ 测量窗口要真的进 `build` 的命令行。
   *
   * `since` 只管**采集**下界，而 `build` 从不受它约束 —— 语料库里已有的更早
   * 历史照样会被全量测进画像。于是「重蒸最近 30 天」做不到，且症状静默：
   * pull 如实只采 30 天，build 照常出数字，grade 可能还是 A。
   *
   * 断言的是 spawn 出去的**参数**而不是返回值：拼错标志名会静默无效
   * （argparse 不认的话会报错，但少传一个参数不会），而那是这一层唯一
   * 能被外部观察到的行为。
   */
  it("★★ windowDays 传成 build --window-days", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
      windowDays: 30,
    })
    const build = specs.find((s) => s.args.includes("build"))!
    expect(build.args[build.args.indexOf("--window-days") + 1]).toBe("30")
    vault.handle.close()
  })

  it("★ windowDays 不传 / null / 0 时不加这个标志（= 全量测量）", async () => {
    for (const windowDays of [undefined, null, 0]) {
      const { runner, specs } = fakeRunner(HAPPY)
      const vault = makeVault()
      const roots = makeRoots()
      await makeService(runner).run({
        db: vault.handle.db,
        vaultPath: vault.path,
        ...roots,
        since: null,
        ...(windowDays === undefined ? {} : { windowDays }),
      })
      const build = specs.find((s) => s.args.includes("build"))!
      // 不传标志（而不是传 0）：让 forge 读它配置里的 measureWindowDays 缺省，
      // 也就是与加这个参数之前完全一致的行为。
      expect(build.args, `windowDays=${String(windowDays)}`).not.toContain("--window-days")
      vault.handle.close()
    }
  })
})

/**
 * ★ auto 会把「应用刚补回来的历史」永久挡在画像外面。
 *
 * `--since auto` 从 forge 自己派生库的 `pulledThrough` 续跑，而走那条
 * 分支时配置里的 `analysisStart` **完全不参与**（`ingest.py` 的
 * `resolve_window` 只在没有 checkpoint 时才读它）。实测同一份
 * `analysisStart: 2026-02-01`：空库切 26 片，有 checkpoint 后只切 1 片。
 *
 * 于是「采集补回 180 天 → 蒸馏」这条链是断的，而且**静默**：
 * pull 报 `inserted: 0`（确实没新的）、build 出数字、publish 写文件、
 * 等级可能还是 A —— 唯一的症状是画像薄，而「薄」没有参照物。
 */
describe("★ vault 有更早语料时必须重扫（否则补回的历史进不了画像）", () => {
  /** 给 forge 的派生库塞一份"只覆盖到某个时间"的语料。 */
  function seedCorpus(forgeRoot: string, earliestMs: number): void {
    mkdirSync(join(forgeRoot, "database"), { recursive: true })
    const handle = openStore({ path: join(forgeRoot, "database", "persona.db"), migrations: [] })
    // 只建断言用得到的两列：forge 真实表更宽，但这一层只读 MIN(epoch)。
    handle.db.prepare("CREATE TABLE messages (message_id TEXT, epoch REAL)").run()
    handle.db.prepare("INSERT INTO messages VALUES ('x', ?)").run(earliestMs / 1000)
    handle.close()
  }

  it("forge 语料只到 8 天前而 vault 有半年 → 传显式 since，不是 auto", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    // vault 里补进一条半年前的消息（模拟反向回填的成果）
    const halfYearAgo = NOW - 180 * 86_400_000
    vault.handle.db
      .prepare(
        `INSERT INTO messages (id, channel_id, conversation_id, external_id, sender_external_id,
                               content_text, sent_at, direction, is_self, created_at)
         VALUES ('m-old', 'dingtalk', 'c1', 'ext-m-old', 'DSELF', '很久以前', ?, 'outbound', 1, ?)`,
      )
      .run(halfYearAgo, NOW)
    // 而 forge 的语料只覆盖到 8 天前
    seedCorpus(roots.forgeRoot, NOW - 8 * 86_400_000)

    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })

    const pull = specs[0]!
    const since = pull.args[pull.args.indexOf("--since") + 1] ?? ""
    // ★ 关键：不是 auto。auto 会让那 172 天永远不被读。
    expect(since).not.toBe("auto")
    // 且从 vault 的左端开始（墙钟串，forge 比的是字符串）
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(since.slice(0, 10)).toBe(
      new Date(halfYearAgo + 8 * 3_600_000).toISOString().slice(0, 10),
    )
    vault.handle.close()
  })

  it("两边左端一致时保持 auto（否则每轮都全量重扫，等于关掉增量）", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    // makeVault 的那条消息在 NOW - 1 天；语料左端给成同一时刻。
    seedCorpus(roots.forgeRoot, NOW - 86_400_000)

    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })

    expect(specs[0]!.args[specs[0]!.args.indexOf("--since") + 1]).toBe("auto")
    vault.handle.close()
  })

  it("差距在一天内不算落后（切片与 overlap 的天然抖动）", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    // 语料左端比 vault 晚 2 小时：这是 forge 按天切片的正常边界差。
    seedCorpus(roots.forgeRoot, NOW - 86_400_000 + 2 * 3_600_000)

    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })

    expect(specs[0]!.args[specs[0]!.args.indexOf("--since") + 1]).toBe("auto")
    vault.handle.close()
  })

  it("调用方给了显式 since 时以它为准（不被探测覆盖）", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    seedCorpus(roots.forgeRoot, NOW - 8 * 86_400_000)

    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: NOW - 3 * 86_400_000,
    })

    const pull = specs[0]!
    const since = pull.args[pull.args.indexOf("--since") + 1] ?? ""
    expect(since.slice(0, 10)).toBe(
      new Date(NOW - 3 * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10),
    )
    vault.handle.close()
  })

  it("语料库还不存在时走 full（读 analysisStart），不因探测失败而挂掉", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    // 不建 persona.db —— 首次蒸馏就是这个状态。
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    expect(result.ok).toBe(true)
    expect(specs[0]!.args[specs[0]!.args.indexOf("--since") + 1]).toBe("auto")
    vault.handle.close()
  })
})

/**
 * ★ 用户勾的会话白名单必须真的到达 forge 的语料查询。
 *
 * 这个值曾经是纯装饰：引导页把它写进 `distill_sources.scope_json`，而
 * 蒸馏侧没有任何代码读 —— 被排除的会话照样进画像，且界面上看不出来。
 * 更隐蔽的是 vault 源用 `**_ignored` 吞掉未知参数，所以**拼错键名也不报错**。
 * 因此这里断言的是写进配置文件的确切键名（`conversationIds`）。
 */
/**
 * ★ locale pack 必须由应用给，不能让 forge 的 `auto` 去猜。
 *
 * `auto` 按本人消息的字符集直方图判定，而中英混写正好落在它的边界上。
 * 实测同一个人的语料：Latin 51.8%/Han 48.2% 判出 `zh-CN`（等级 A），
 * 补了几天历史变成 Han 52.1%/Latin 47.9% 之后判出 **`null` pack**（等级 D）——
 * 因为「加权」分支要求 Han 不是第一名，而 52.1 vs 47.9 又达不到
 * 「明显领先」的阈值。
 *
 * `null` pack 意味着所有**词级**层缺失（ask 分类、改口/推脱/澄清的真实说法），
 * 而产物看起来仍然完整。也就是「多采了历史反而让画像变差」，
 * 且原因在任何界面上都看不出来 —— 正是这一类静默降级。
 */
describe("★ locale pack 显式给定（auto 在中英混写上会翻车）", () => {
  function serviceWith(localeId: string | null | undefined, runner: ProcessRunner) {
    const forgeDir = tempDir("mycontext-forge-engine-")
    mkdirSync(join(forgeDir, "forge"), { recursive: true })
    writeFileSync(join(forgeDir, "forge", "__main__.py"), "", "utf8")
    return new ForgeService({
      clock: new ManualClock(NOW),
      logger,
      processes: runner,
      forgeDir,
      python,
      ...(localeId === undefined ? {} : { localeId }),
    })
  }

  async function localeInConfig(localeId: string | null | undefined) {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    await serviceWith(localeId, runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    const config = JSON.parse(
      readFileSync(join(roots.forgeRoot, "persona-config.json"), "utf8"),
    ) as { locale: { id: string } }
    vault.handle.close()
    return config.locale.id
  }

  it("给了 pack id 就写进配置，不是 auto", async () => {
    expect(await localeInConfig("zh-CN")).toBe("zh-CN")
  })

  it("英文界面写 en", async () => {
    expect(await localeInConfig("en")).toBe("en")
  })

  it("没给时才退回 auto（向后兼容，但不是期望路径）", async () => {
    expect(await localeInConfig(undefined)).toBe("auto")
    expect(await localeInConfig(null)).toBe("auto")
  })
})

describe("★ 蒸馏范围（会话白名单）", () => {
  function readConfig(forgeRoot: string) {
    return JSON.parse(readFileSync(join(forgeRoot, "persona-config.json"), "utf8")) as {
      source: { kind: string; options: Record<string, unknown> }
    }
  }

  it("勾了会话时按确切键名传给 vault 源", async () => {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    new DistillSourceRepository(vault.handle.db).upsert(
      "chat",
      { enabled: true, scope: { conversationIds: ["c1", "c2"] } },
      NOW,
    )

    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })

    const options = readConfig(roots.forgeRoot).source.options
    // 键名拼错 = 静默无效（落进 vault 源的 `**_ignored`），所以断言字面量。
    expect(options["conversationIds"]).toEqual(["c1", "c2"])
    vault.handle.close()
  })

  it("没配范围时传空数组（= 不限），而不是省略这个键", async () => {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()

    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })

    const options = readConfig(roots.forgeRoot).source.options
    /**
     * 显式空数组:省略与"选了 0 个"在 JSON 里同形,而后者语义应是"什么都不蒸"。
     * 留一个可断言的空值让"不限"这件事在配置里是写明的,不是推断的。
     */
    expect(options["conversationIds"]).toEqual([])
    vault.handle.close()
  })

  it("源被关掉时退回不限（关源 ≠ 什么都不蒸）", async () => {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    new DistillSourceRepository(vault.handle.db).upsert(
      "chat",
      { enabled: false, scope: { conversationIds: ["c1"] } },
      NOW,
    )

    await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })

    expect(readConfig(roots.forgeRoot).source.options["conversationIds"]).toEqual([])
    vault.handle.close()
  })
})

describe("★ 失败是状态，不是异常", () => {
  it("身份未确认时不起进程，并给出可操作的原因", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault({ confirmed: false })
    const roots = makeRoots()
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    /**
     * forge 侧也会拒（vault 源检查 `confirmed_at`），但在这里先判是为了
     * 给人话：起一个进程再让它失败，用户看到的是 Python 退出信息。
     */
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("身份未确认")
    expect(specs).toHaveLength(0)
    vault.handle.close()
  })

  it("某一步失败时报出停在哪，且不继续往下跑", async () => {
    const { runner, specs } = fakeRunner(HAPPY, {
      exitCode: 1,
      stderr: "refusing to publish into /Users/x/.claude/skills",
    })
    const vault = makeVault()
    const roots = makeRoots()
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe("pull")
    // forge 的 SystemExit 消息是写给人看的，直接透出来比包一层「exit 1」有用
    expect(result.reason).toContain("refusing to publish")
    expect(specs).toHaveLength(1)
    vault.handle.close()
  })

  it("语料不完整时把原因带出来（而不是报成成功）", async () => {
    const { runner } = fakeRunner({
      ...HAPPY,
      pull: {
        inserted: 3,
        complete: false,
        note: "1474 row(s) were read but NOT imported: is_self is NULL",
        sourceStats: { unjudgedRows: 1474 },
      },
    })
    const vault = makeVault()
    const roots = makeRoots()
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    // 跑完了（ok），但原因要留着 —— 否则「身份还没回填完」看起来像「这人不太说话」
    expect(result.ok).toBe(true)
    expect(result.reason).toContain("is_self")
    vault.handle.close()
  })

  it("输出不是 JSON 时报引擎异常，不是崩溃", async () => {
    const specs: SpawnSpec[] = []
    const runner = {
      async spawn(spec: SpawnSpec): Promise<ExecResult> {
        specs.push(spec)
        return {
          exitCode: 0,
          stdout: "Traceback (most recent call last)",
          stderr: "",
          timedOut: false,
        }
      },
    } as unknown as ProcessRunner
    const vault = makeVault()
    const roots = makeRoots()
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("不是 JSON")
    vault.handle.close()
  })

  it("没有 Python 时直接返回原因，不起进程", async () => {
    const { runner, specs } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    const result = await makeService(runner, null).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("Python")
    expect(specs).toHaveLength(0)
    expect(existsSync(join(roots.forgeRoot, "persona-config.json"))).toBe(false)
    vault.handle.close()
  })
})

/**
 * ★ 覆盖度等级：读得到就报，读不到要**可见**。
 *
 * 等级只出现在 `fidelity.md` 的一句 Markdown 里（forge 的 `_grade()`
 * 结果没有进任何 JSON）。所以这是一个脆弱的耦合，而它坏掉的方式很坏：
 * 上游改一个词 → 静默变 null → 与"还没蒸完"长得一模一样。
 */
describe("覆盖度等级", () => {
  /** 造一份 forge 已发布的产物，`fidelity.md` 的措辞可控。 */
  function publishFidelity(skillRoot: string, body: string): void {
    const dir = join(skillRoot, "persona-persona", "references")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "fidelity.md"), body, "utf8")
  }

  it("从产物里读出 A–D", async () => {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    publishFidelity(
      roots.skillRoot,
      "# Fidelity report\n\n**8/11 layers measured · coverage grade B** · built …\n",
    )
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    expect(result.grade).toBe("B")
    vault.handle.close()
  })

  /**
   * ★ 匹配不上时仍然 `ok`，但等级是 null。
   *
   * 不把它变成失败：产物已经发布了、画像是可用的，只是我们读不出那个
   * 等级。变成失败会让"上游改了一句文案"表现为"蒸馏坏了"，
   * 那个误导比缺一个等级严重得多。（可见性由一条 warn 日志承担。）
   */
  it("措辞变了时不谎报等级，也不把整轮变成失败", async () => {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    publishFidelity(roots.skillRoot, "# Fidelity report\n\n**8/11 layers measured · rating B**\n")
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    expect(result.ok).toBe(true)
    expect(result.grade).toBeNull()
    vault.handle.close()
  })

  it("产物还不存在时等级是 null（正常状态，不是错误）", async () => {
    const { runner } = fakeRunner(HAPPY)
    const vault = makeVault()
    const roots = makeRoots()
    const result = await makeService(runner).run({
      db: vault.handle.db,
      vaultPath: vault.path,
      ...roots,
      since: null,
    })
    expect(result.ok).toBe(true)
    expect(result.grade).toBeNull()
    vault.handle.close()
  })
})

/**
 * ★ 清水位：让「重新蒸馏」真的从头蒸。
 *
 * `--since auto` 是从 forge 派生库里的 `pulledThrough` 续跑的。不清它的话
 * 那个按钮什么都没重来，而它看起来生效了。
 */
describe("清增量水位", () => {
  /** 造一个 forge 的派生库（只要 `meta` 表 —— 那是水位所在）。 */
  function makeForgeDb(forgeRoot: string, withWatermark: boolean): string {
    const path = join(forgeRoot, "database", "persona.db")
    mkdirSync(join(forgeRoot, "database"), { recursive: true })
    const handle = openStore({ path, migrations: [] })
    handle.db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    if (withWatermark) {
      handle.db
        .prepare("INSERT INTO meta (key, value) VALUES ('pulledThrough', '2026-07-01 00:00:00')")
        .run()
    }
    handle.close()
    return path
  }

  it("删掉 pulledThrough，下一轮就是全量", () => {
    const { runner } = fakeRunner(HAPPY)
    const roots = makeRoots()
    const path = makeForgeDb(roots.forgeRoot, true)

    expect(makeService(runner).resetWatermark(roots.forgeRoot)).toBe(true)

    const handle = openStore({ path, migrations: [] })
    const row = handle.db
      .prepare<[], { c: number }>("SELECT count(*) AS c FROM meta WHERE key = 'pulledThrough'")
      .get()
    expect(row?.c).toBe(0)
    handle.close()
  })

  /**
   * ★ 只删水位，不删语料 —— 也不删用户手写的 owner 块。
   *
   * 那些块是 forge 唯一不可重建的东西（`publish` 会把它们恢复回去）。
   * 图省事删掉整个派生库会一起丢掉它们，而那是不可逆的。
   */
  it("不动 meta 里的其它键", () => {
    const { runner } = fakeRunner(HAPPY)
    const roots = makeRoots()
    const path = makeForgeDb(roots.forgeRoot, true)
    const seed = openStore({ path, migrations: [] })
    seed.db.prepare("INSERT INTO meta (key, value) VALUES ('lastPullAt', 'x')").run()
    seed.close()

    makeService(runner).resetWatermark(roots.forgeRoot)

    const handle = openStore({ path, migrations: [] })
    expect(
      handle.db
        .prepare<[], { value: string }>("SELECT value FROM meta WHERE key='lastPullAt'")
        .get()?.value,
    ).toBe("x")
    handle.close()
  })

  it("库还不存在时返回 false 而不是抛（还没蒸过，下一轮本来就是全量）", () => {
    const { runner } = fakeRunner(HAPPY)
    const roots = makeRoots()
    expect(makeService(runner).resetWatermark(roots.forgeRoot)).toBe(false)
  })

  it("表结构对不上时返回 false（不假装成功）", () => {
    const { runner } = fakeRunner(HAPPY)
    const roots = makeRoots()
    const path = join(roots.forgeRoot, "database", "persona.db")
    mkdirSync(join(roots.forgeRoot, "database"), { recursive: true })
    const handle = openStore({ path, migrations: [] })
    handle.db.exec("CREATE TABLE something_else (k TEXT)")
    handle.close()

    expect(makeService(runner).resetWatermark(roots.forgeRoot)).toBe(false)
  })
})
