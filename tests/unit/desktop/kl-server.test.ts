/**
 * KlServerService：kl-server 子进程的状态机 + 健康轮询 + 无孤儿退出。
 *
 * 这里**不起真 Python**（那要 venv + qdrant + 网关，属 tests/externals）——
 * 用一个 mock ProcessRunner 扮演子进程，注入 probeHealth/sleep/clock 把
 * warmup 轮询变成确定性的，验证状态机的每条边：
 *
 *  · 懒启动 → starting → ready（/health ok 后）；
 *  · warmup 超时 → failed（且把半死进程关掉）；
 *  · 进程崩溃 → failed（非主动 stop 时）；
 *  · failed 不自动重起，retry() 才重来；
 *  · stop() 走 close()，且 onExit 不误报 failed；
 *  · 状态变化推 IPC 事件（getWindow）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import type { DuplexHandle, DuplexSpec } from "@mycontext/runtime-env"
import { KlServerService, klLogLevelFor } from "@main/services/kl-server.service.js"
import type { KlIngestSnapshot } from "@main/services/kl-server.service.js"

const logger = createLogger("test", { level: "error" })

/**
 * mock 的 kl 子进程。`fail=true` 让 close 前先"崩溃"；`onSpec` 抓到 spec
 * 以便测试主动触发 onExit（模拟崩溃）。
 */
function fakeRunner(spawnOpts: { exitCode?: number; lines?: string[] } = {}) {
  let spec: DuplexSpec | null = null
  let spawnSpec: { args: string[]; cwd: string | undefined; env: Record<string, string> } | null =
    null
  let alive = true
  const handle: DuplexHandle = {
    async writeLine() {},
    async close() {
      alive = false
      // close 后对端退出：触发 onExit（此时 state 已被 stop() 置 stopped）。
      spec?.onExit?.({ code: 0, signal: null })
    },
    get alive() {
      return alive
    },
    pid: 9999,
  }
  return {
    handle,
    getSpec: () => spec,
    getSpawnSpec: () => spawnSpec,
    crash: () => {
      alive = false
      spec?.onExit?.({ code: 1, signal: null })
    },
    processes: {
      spawnDuplex: (s: DuplexSpec): DuplexHandle => {
        spec = s
        alive = true
        for (const line of spawnOpts.lines ?? []) s.onStderr?.(line)
        return handle
      },
      // 一次性命令（建图走这条）：喂 onLine、返回 canned 结果。
      spawn: async (s: {
        args: string[]
        cwd?: string
        env: Record<string, string>
        onLine: (line: string, stream: "stdout" | "stderr") => void
      }) => {
        spawnSpec = { args: s.args, cwd: s.cwd, env: s.env }
        for (const line of spawnOpts.lines ?? []) s.onLine(line, "stdout")
        return { exitCode: spawnOpts.exitCode ?? 0, stdout: "", stderr: "", timedOut: false }
      },
    } as unknown as ConstructorParameters<typeof KlServerService>[0]["processes"],
  }
}

function makeService(options: {
  runner: ReturnType<typeof fakeRunner>
  probeHealth: (port: number) => Promise<boolean>
  probeExisting?: (port: number) => Promise<boolean>
  postIngest?: (port: number, exportDir: string) => Promise<number>
  readStatus?: ConstructorParameters<typeof KlServerService>[0]["readStatus"]
  clock: ManualClock
  gateway?: ConstructorParameters<typeof KlServerService>[0]["gateway"]
  exportDir?: string
  dataDir?: string
  events?: unknown[]
  preparePython?: ConstructorParameters<typeof KlServerService>[0]["preparePython"]
  openGraphDb?: ConstructorParameters<typeof KlServerService>[0]["openGraphDb"]
  /**
   * 替换 logger —— 只给"验日志级别"的那组用。
   *
   * ★ 必须能替：`klLogLevelFor` 是纯函数、单独测很容易，但真实 bug 出在
   * **调用点**（`onStderr` 到底走那个函数，还是直接 `logger.warn`）。
   * 只测纯函数的话，把调用点改回一律 warn 测试照样全绿 —— 实测验证过。
   */
  logger?: ConstructorParameters<typeof KlServerService>[0]["logger"]
}) {
  const window = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, payload: unknown) => options.events?.push(payload) },
  } as unknown as ReturnType<ConstructorParameters<typeof KlServerService>[0]["getWindow"]>

  return new KlServerService({
    clock: options.clock,
    logger: options.logger ?? logger,
    processes: options.runner.processes,
    klRoot: "/fake/kl-graph",
    dataDir: options.dataDir ?? "/tmp/mycontext-kl-test-data",
    getWindow: () => window,
    probeHealth: options.probeHealth,
    /**
     * 缺省"端口上没有别人"—— 这些用例验的是**我们自己**起进程的那条路。
     *
     * ★ 必须显式给：缺省实现会打真 `GET /health`，而本机开发时 8200 上
     * 常常真有一个（应用起的 / 上一次的孤儿）。那时全部用例会走进"复用"
     * 分支、根本不 spawn —— 于是断言 `runner.getSpec()` 的用例集体变红，
     * 而红的原因与被测逻辑无关。复用分支自己那一组单独注入 true。
     */
    probeExisting: options.probeExisting ?? (async () => false),
    // sleep 推进 ManualClock：轮询循环靠它前进，测试不真等。
    sleep: async (ms) => {
      options.clock.advance(ms)
    },
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    ...(options.exportDir === undefined ? {} : { exportDir: options.exportDir }),
    ...(options.postIngest === undefined ? {} : { postIngest: options.postIngest }),
    ...(options.readStatus === undefined ? {} : { readStatus: options.readStatus }),
    ...(options.preparePython === undefined ? {} : { preparePython: options.preparePython }),
    ...(options.openGraphDb === undefined ? {} : { openGraphDb: options.openGraphDb }),
  })
}

const KL_PYTHON = "KL_PYTHON"
const savedPython = process.env[KL_PYTHON]
/** 临时数据目录（重建测试真删文件）；每个 case 后清掉。 */
const dirs: string[] = []
afterEach(() => {
  if (savedPython === undefined) delete process.env[KL_PYTHON]
  else process.env[KL_PYTHON] = savedPython
  vi.restoreAllMocks()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe("KlServerService · 状态机", () => {
  it("初始 stopped，port 为 null", () => {
    const runner = fakeRunner()
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
    })
    expect(svc.status().state).toBe("stopped")
    expect(svc.status().port).toBeNull()
  })

  it("懒启动 → starting → ready（/health ok 后）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    // 头两次探测未就绪，第三次 ok（模拟 warmup）。
    let calls = 0
    const svc = makeService({
      runner,
      probeHealth: async () => ++calls >= 3,
      clock: new ManualClock(1_000),
    })
    const ready = await svc.ensureReady()
    expect(ready).toBe(true)
    expect(svc.status().state).toBe("ready")
    expect(svc.status().port).toBe(8200)
    // 起进程时 cwd=klRoot、args=kl_server.py、注入 KL_DATA_DIR/KL_SERVER_PORT
    const spec = runner.getSpec()!
    expect(spec.cwd).toBe("/fake/kl-graph")
    expect(spec.args).toEqual(["kl_server.py"])
    expect(spec.env["KL_DATA_DIR"]).toBe("/tmp/mycontext-kl-test-data")
    expect(spec.env["KL_SERVER_PORT"]).toBe("8200")
  })

  it("没设 KL_PYTHON 也能起（退回 python3）", async () => {
    delete process.env[KL_PYTHON]
    const runner = fakeRunner()
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
    })
    await svc.ensureReady()
    expect(runner.getSpec()!.executable).toBe("python3")
  })

  it("warmup 超时 → failed，且关掉半死进程", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const closeSpy = vi.spyOn(runner.handle, "close")
    const svc = makeService({
      runner,
      probeHealth: async () => false, // 永远不 ready
      clock: new ManualClock(1_000),
    })
    const ready = await svc.ensureReady()
    expect(ready).toBe(false)
    expect(svc.status().state).toBe("failed")
    expect(svc.status().reason).toMatch(/超时/)
    expect(closeSpy).toHaveBeenCalled()
  })

  it("进程崩溃 → failed（带 code）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    let ready = false
    const svc = makeService({
      runner,
      probeHealth: async () => ready,
      clock: new ManualClock(1_000),
    })
    ready = true
    await svc.ensureReady()
    expect(svc.status().state).toBe("ready")
    // 运行中崩溃
    runner.crash()
    expect(svc.status().state).toBe("failed")
    expect(svc.status().reason).toMatch(/退出/)
  })

  it("★ 缺依赖时给出可照做的修法（而不是原样贴 Python 报错）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner({
      lines: [
        "Traceback (most recent call last):",
        "ModuleNotFoundError: No module named 'fastapi'",
      ],
    })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
    })
    await svc.ensureReady()
    runner.crash()

    /**
     * ★ 断言的是**用户能做什么**，而不是"末行被带上了"。
     *
     * 原来断言 `toContain("ModuleNotFoundError: …")` —— 那只保证"把 Python 的
     * 报错贴上去了"，而用户看不懂那句话。现在 `describeExit` 把它翻成
     * 「依赖缺失 + 跑 pnpm setup:kl」。
     *
     * ★ 而且"取末行"这个实现本身是错的：真正的原因常常**不在**末行
     * （实测一次 Qdrant 锁冲突，末行是 uvicorn 的 `Application startup
     * failed. Exiting.` —— 只取它等于什么都没说）。
     */
    const reason = svc.status().reason ?? ""
    expect(reason).toContain("依赖")
    expect(reason).toContain("pnpm setup:kl")
  })

  /**
   * ★★ Qdrant 目录被占是多渠道之后**会更常见**的一种失败：每个渠道一个 kl、
   * 各自一个 qdrant 目录，任何一次没走优雅退出（crash / 强杀 / dev 热重启）
   * 都会留下一个占着目录的孤儿。
   *
   * 实测踩过：飞书的 kl 起不来，而界面上只有「进程退出（code=3）：
   * Application startup failed. Exiting.」—— 真实原因（目录被另一个 kl 占着）
   * 与修法（结束那个孤儿）一个字都看不到。
   */
  it("★★ Qdrant 目录被占用 → 说清是孤儿进程占着 + 带上目录", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner({
      lines: [
        "ERROR:    Traceback (most recent call last):",
        "Traceback (most recent call last):",
        "RuntimeError: Storage folder /tmp/v1/kl/feishu/qdrant_data is already accessed by another instance of Qdrant client. If you require concurrent access, use Qdrant server instead.",
        // ★ 末行是收尾噪音 —— 只取它就什么都没说
        "ERROR:    Application startup failed. Exiting.",
      ],
    })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
    })
    await svc.ensureReady()
    runner.crash()

    const reason = svc.status().reason ?? ""
    expect(reason).toContain("被另一个进程占用")
    expect(reason).toContain("孤儿")
    // ★ 带上目录：用户要知道去哪看
    expect(reason).toContain("/tmp/v1/kl/feishu/qdrant_data")
    // ★ 反证：不能只把末行贴上来
    expect(reason).not.toContain("Application startup failed")
  })

  it("failed 后 ensureReady 不自动重起；retry() 才重来", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const spawnSpy = vi.spyOn(runner.processes, "spawnDuplex")
    let ready = false
    const svc = makeService({
      runner,
      probeHealth: async () => ready,
      clock: new ManualClock(1_000),
    })
    ready = true
    await svc.ensureReady()
    runner.crash() // → failed
    expect(spawnSpy).toHaveBeenCalledTimes(1)

    // failed 态：ensureReady 直接 false，不重起
    expect(await svc.ensureReady()).toBe(false)
    expect(spawnSpy).toHaveBeenCalledTimes(1)

    // retry() 显式重来
    expect(await svc.retry()).toBe(true)
    expect(spawnSpy).toHaveBeenCalledTimes(2)
    expect(svc.status().state).toBe("ready")
  })

  it("stop() → stopped，且 onExit 不误报 failed", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
    })
    await svc.ensureReady()
    await svc.stop()
    expect(svc.status().state).toBe("stopped")
    expect(svc.status().reason).toBeNull()
  })

  it("并发 ensureReady 只起一个进程", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const spawnSpy = vi.spyOn(runner.processes, "spawnDuplex")
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
    })
    const [a, b] = await Promise.all([svc.ensureReady(), svc.ensureReady()])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(spawnSpy).toHaveBeenCalledTimes(1)
  })
})

describe("KlServerService · 网关出网边界", () => {
  it("给了网关 → networkEgress:true，且注入 KL_* env", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      gateway: () => ({
        llmBaseUrl: "https://gw/anthropic",
        llmModel: "claude-sonnet-4-6",
        embedBaseUrl: "https://gw/v1",
        embedModel: "text-embedding-v4",
        apiKey: "sk-x",
        embeddingDim: 2048,
        sendDimensions: true,
      }),
    })
    expect(svc.status().networkEgress).toBe(true)
    await svc.ensureReady()
    const env = runner.getSpec()!.env
    expect(env["KL_LLM_BASE_URL"]).toBe("https://gw/anthropic")
    expect(env["KL_LLM_MODEL"]).toBe("claude-sonnet-4-6")
    expect(env["KL_EMBED_BASE_URL"]).toBe("https://gw/v1")
    expect(env["KL_EMBED_API_KEY"]).toBe("sk-x")
    // ★ 维度必须注入（网关返回 2048，kl 默认建 4096 集合会崩）——见 KlServerService 注释。
    expect(env["KL_EMBEDDING_DIM"]).toBe("2048")
    expect(env["KL_EMBED_SEND_DIMENSIONS"]).toBe("1")
  })

  it("没给网关 → networkEgress:false", () => {
    const runner = fakeRunner()
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
    })
    expect(svc.status().networkEgress).toBe(false)
  })
})

/**
 * ★★ 改网关之后要**重起 kl** —— 这一组防的是打包态实测到的静默失败。
 *
 * kl 的网关是通过 `KL_*` env 传的，而 env 只在 spawn 那一刻定。于是
 * "跑着的这个 kl 用的是哪份网关"完全取决于它**启动时**读到什么。
 * 打包态首启没有 `.env`（网关为空），用户随后在设置里填 key ——
 * 蒸馏/数字人立刻生效（走 LlmHolder.reconfigure），而 kl 一直用着空网关：
 *
 * ```
 * 16:19:27 kl-server 起来（env 里只有 KL_LLM_MODEL，没有 base/key）
 * 16:39:34 auto graph build failed
 *          {"reason":"litellm.InternalServerError - Connection error."}
 * ```
 * 表现是**填了 key 却永远建不出图**，而设置页显示保存成功。
 */
describe("KlServerService · 网关变更后重起（onGatewayChanged）", () => {
  /** 可变网关：模拟用户在设置里改配置。 */
  function mutableGateway(initial: { llmBaseUrl: string; apiKey: string }) {
    const current = { ...initial }
    return {
      get: () => ({ ...current }),
      set: (next: { llmBaseUrl: string; apiKey: string }) => {
        current.llmBaseUrl = next.llmBaseUrl
        current.apiKey = next.apiKey
      },
    }
  }

  it("★★ 网关从空变成有 key → 重起，且新进程带上新 env", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    // 首启：什么都没配（打包态首次运行就是这样）
    const gw = mutableGateway({ llmBaseUrl: "", apiKey: "" })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      gateway: () => gw.get(),
    })
    await svc.ensureReady()
    // 反证起点：第一个进程的环境里确实没有网关（正是那个故障的形状）
    expect(runner.getSpec()!.env["KL_LLM_BASE_URL"]).toBeUndefined()
    expect(runner.getSpec()!.env["KL_EMBED_API_KEY"]).toBeUndefined()

    // 用户在设置里填了网关
    gw.set({ llmBaseUrl: "https://gw/anthropic", apiKey: "sk-new" })
    await svc.onGatewayChanged()

    expect(svc.status().state).toBe("ready")
    // ★ 新进程必须带上新网关 —— 不重起的话这两个断言就是那个 bug
    expect(runner.getSpec()!.env["KL_LLM_BASE_URL"]).toBe("https://gw/anthropic")
    expect(runner.getSpec()!.env["KL_EMBED_API_KEY"]).toBe("sk-new")
  })

  /**
   * ★ 配置**没变**时不能重起：`onChange` 会因为改任何一项触发（模型、
   * embedding 模型…），而重起要重付 warmup（打包态实测 6012ms），期间检索
   * 不可用。无条件重起等于"每次动设置就让图谱断一会儿"。
   */
  it("★ 网关没变 → 不重起（避免白付一次 warmup）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const gw = mutableGateway({ llmBaseUrl: "https://gw", apiKey: "sk-x" })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      gateway: () => gw.get(),
    })
    await svc.ensureReady()
    const before = runner.getSpec()

    await svc.onGatewayChanged()

    // 同一个 spec 对象 = 没有重新 spawn
    expect(runner.getSpec()).toBe(before)
    expect(svc.status().state).toBe("ready")
  })

  /**
   * ★ 没起过（stopped）时只记指纹、不启动 —— 懒启动的语义不该被
   * "改了个设置"打破（那会让一个从没用过图谱的用户被动付 warmup + 出网）。
   */
  it("★ 服务没起过 → 不因为改配置而启动", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const gw = mutableGateway({ llmBaseUrl: "", apiKey: "" })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      gateway: () => gw.get(),
    })
    gw.set({ llmBaseUrl: "https://gw", apiKey: "sk-x" })
    await svc.onGatewayChanged()

    expect(svc.status().state).toBe("stopped")
    expect(runner.getSpec()).toBeNull()
  })

  /**
   * ★ 建图中不重起：ingest 跑在 server 进程内（in-server `/ingest`），
   * 杀它等于中断建图 —— 而那批 LLM 抽取的钱已经花了。
   */
  it("★ 建图中改网关 → 不打断建图", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const gw = mutableGateway({ llmBaseUrl: "https://gw", apiKey: "sk-x" })
    let polls = 0
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      gateway: () => gw.get(),
      postIngest: async () => 200,
      readStatus: async () => {
        polls += 1
        if (polls === 2) {
          // 建图跑到一半时用户改了网关
          gw.set({ llmBaseUrl: "https://gw2", apiKey: "sk-y" })
          void svc.onGatewayChanged()
        }
        return polls < 4 ? snap({ state: "running", phase: "phase_b" }) : snap()
      },
    })
    const r = await svc.rebuildGraph()
    // ★ 建图照常跑完（被杀掉的话这里会是"进程已退出"）
    expect(r.ok).toBe(true)
    expect(r.entities).toBe(15)
  })

  /**
   * ★ 复用（adopted）的进程不是我们的孩子 —— 杀它会打断用户手上的活
   * （他可能自己 `kl start` 起了一个）。见 `adopted` 字段的注释。
   */
  it("★ 复用别人的进程时 → 不去重起它", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const gw = mutableGateway({ llmBaseUrl: "", apiKey: "" })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      // 端口上已经有一个健康的 server
      probeExisting: async () => true,
      clock: new ManualClock(1_000),
      gateway: () => gw.get(),
    })
    await svc.ensureReady()
    expect(svc.status().state).toBe("ready")

    gw.set({ llmBaseUrl: "https://gw", apiKey: "sk-x" })
    await svc.onGatewayChanged()

    expect(svc.status().state).toBe("ready")
    // 从头到尾没 spawn 过（复用态）
    expect(runner.getSpec()).toBeNull()
  })
})

describe("KlServerService · 状态推 UI", () => {
  it("状态变化经 getWindow 推 IPC 事件", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const events: unknown[] = []
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      events,
    })
    await svc.ensureReady()
    const states = events.map((e) => (e as { state: string }).state)
    // 至少经过 starting 与 ready
    expect(states).toContain("starting")
    expect(states).toContain("ready")
  })
})

/**
 * `/status` 的假快照。默认是"跑完了、图非空"。
 */
function snap(over: Partial<KlIngestSnapshot> = {}): KlIngestSnapshot {
  return {
    state: "done",
    phase: "",
    percent: 1,
    error: "",
    counts: { entities: 15, facts: 23, edges: 125 },
    ...over,
  }
}

describe("KlServerService · 建图（rebuildGraph 走 server 的 /ingest）", () => {
  /**
   * ★ 建图**不再另起进程**，而是让跑着的 server 干（`POST /ingest`）。
   *
   * 换掉 `python -m scripts.ingest` 的原因见实现处注释：in-server ingest
   * 复用同一个 Qdrant writer，于是"两个进程抢文件"的前提没了 ——
   * 建图期间检索照常可用，也不用每次重付 ~90s 的 warmup。
   *
   * 这里连带锁住那个**方向**：必须先 ensureReady 再 POST。原来那条路径是
   * 反的（先 stop 再跑），照抄过来会 100% 失败 —— 而失败信息会是
   * "连不上 8200"，看起来像网络问题而不是顺序错。
   */
  it("先起 server 再 POST /ingest，带上导出目录，计数来自 /status", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const posted: Array<{ port: number; dir: string }> = []
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async (port, dir) => {
        // POST 的时候 server 必须已经就绪 —— 顺序错了这里就会看到 stopped
        expect(svc.status().state).toBe("ready")
        posted.push({ port, dir })
        return 200
      },
      readStatus: async () => snap(),
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(true)
    expect(r.entities).toBe(15)
    expect(r.facts).toBe(23)
    expect(r.edges).toBe(125)
    expect(posted).toEqual([{ port: 8200, dir: "/tmp/exports/dws" }])
    // 不再另起 ingest 进程
    expect(runner.getSpawnSpec()).toBeNull()
  })

  it("服务此前启动失败时，点击建图会自动重试服务", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => snap(),
    })
    await svc.ensureReady()
    runner.crash()
    expect(svc.status().state).toBe("failed")

    const result = await svc.rebuildGraph()

    expect(result.ok).toBe(true)
    expect(svc.status().state).toBe("ready")
  })

  /**
   * ★ `/ingest` 是**非阻塞**的：POST 立刻返回 `started`，活儿在后台跑。
   *
   * 所以必须轮询到终态才能报结果。不轮询的话我们会在 Phase A 刚开始
   * 就返回"建好了，0 个实体"—— 而 0 实体与"真的什么都没抽到"外观一致，
   * 那正是本项目里最难归因的一类失败（`kl ingest` 之前就是这么静默空跑的）。
   */
  it("轮询到 done 才返回（running 期间不提前收工）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    let polls = 0
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => {
        polls += 1
        if (polls < 4) {
          return snap({
            state: "running",
            phase: polls < 3 ? "phase_a" : "phase_b",
            percent: 0.2 * polls,
            counts: { entities: 0, facts: 0, edges: 0 },
          })
        }
        return snap()
      },
    })
    const r = await svc.rebuildGraph()
    expect(polls).toBeGreaterThanOrEqual(4)
    expect(r.ok).toBe(true)
    // 终态的计数，不是中途那些 0
    expect(r.entities).toBe(15)
  })

  /** 进度要推给 UI：分钟级任务没有进度时"在跑"与"卡死"在界面上一样。 */
  it("建图进度经 IPC 推出去（phase + percent）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const events: Array<{ buildProgress: { phase: string; percent: number } | null }> = []
    let polls = 0
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      events,
      postIngest: async () => 200,
      readStatus: async () => {
        polls += 1
        return polls < 3 ? snap({ state: "running", phase: "phase_a", percent: 0.35 }) : snap()
      },
    })
    await svc.rebuildGraph()
    const progressed = events.filter((e) => e.buildProgress !== null)
    expect(progressed.length).toBeGreaterThan(0)
    expect(progressed[0]?.buildProgress?.phase).toBe("phase_a")
    expect(progressed[0]?.buildProgress?.percent).toBeCloseTo(0.35)
    // 跑完要清掉，否则 UI 上永远挂着一个 35%
    expect(svc.status().buildProgress).toBeNull()
  })

  /**
   * ★ 建图与服务状态是两个维度，别混 —— 但换成 in-server ingest 之后
   * 这条的**正确形状变了**，我第一版照抄旧断言，红了。
   *
   * 旧世界：建图期间服务**故意停着**（腾出数据文件给另一个 ingest 进程），
   * 所以 `building:true` 期间出现 `starting` 一定是 bug（UI 会同屏显示
   * 「服务启动中」+「建图中」自相矛盾 —— 那是真实见过的）。
   *
   * 新世界：干活的就是 server 自己，所以 `rebuildGraph` **第一步就是把它起来**。
   * 于是 `building:true` 期间经过 `starting` 是**必然且正确**的。
   * 该锁的变成了终点：建图跑起来之后服务必须是 `ready`（检索照常可用），
   * 而不是停着。
   *
   * 这就是"照抄旧断言"的危险：它不会报"你抄错了"，只会说某个布尔值不对，
   * 而那时人的第一反应是去改实现迎合断言。
   */
  it("建图期间服务是活的（起过 → 最终 ready，不是停着）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const events: Array<{ state: string; building: boolean }> = []
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      events,
      postIngest: async () => 200,
      readStatus: async () => snap(),
    })
    await svc.rebuildGraph()
    // 建图期确实推过 building:true（否则 UI 上没有"忙"的表达）
    expect(events.some((e) => e.building === true)).toBe(true)
    // ★ 终点：服务活着（in-server ingest 的意义就在这 —— 建图期间检索不中断）
    expect(svc.status().state).toBe("ready")
    // 且建完把 building 落回 false，否则入口会永久禁用
    expect(svc.status().building).toBe(false)
  })

  it("没有导出目录 → 直接失败，不 POST", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    let posts = 0
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      postIngest: async () => {
        posts += 1
        return 200
      },
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(false)
    expect(posts).toBe(0)
  })

  /**
   * ingest 报错 → failed 且带上 server 给的原因。
   *
   * 原因必须**透出来**：这条路径上真实见过的错误是
   * `[Errno 32] Broken pipe`（孤儿 server 的 stdout 读端已关）与
   * embedding 维度不匹配 —— 两者都只能从这句原文里认出来，
   * 换成我们自己编的"建图失败"就等于把唯一的线索丢了。
   */
  it("ingest 报错 → failed，且原因来自 server", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () =>
        snap({
          state: "error",
          error: "[Errno 32] Broken pipe",
          counts: { entities: 0, facts: 0, edges: 0 },
        }),
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("Broken pipe")
    /**
     * ★★ 建图失败**不把服务标成 failed**。
     *
     * 这条原来断言的是 `state === "failed"` —— 而那正是 bug:`fail()` 会同时
     * 写 `state` 与 `reason`,而 UI 的「图谱服务」区渲染的就是 `reason`。
     * 于是**建图**失败显示成**服务**失败(实测截图:徽章写着「就绪」,
     * 下面挂着红色「建图失败:…」—— 两个互相矛盾的说法同屏)。
     *
     * 服务此刻确实是好的:in-server ingest 挂了不影响它继续提供检索。
     * 失败原因随返回值走,由「图谱数据」区显示。
     */
    expect(svc.status().state).toBe("ready")
    // 反证:服务的 reason 保持干净(没被建图的错误污染)
    expect(svc.status().reason).toBeNull()
  })

  /**
   * ★★ 建图**没有时间上限** —— 跑再久也不能判失败。
   *
   * ## 这条守的是一个已经发生过的假失败
   *
   * 原来有个 45min 的 `INGEST_TIMEOUT_MS`。它**并不会停掉建图**（ingest 跑在
   * kl-server 进程里，我们这边只是停止观察），于是到点之后报
   * 「建图失败：建图超时（>45min）」，而 kl 那边一直跑到底。实测抓到过：
   *
   * ```
   * 06:45:41 WARN auto graph build failed {"reason":"建图失败：建图超时（>45min）"}
   * // 同一时刻 /status 仍是 state=running phase_a，chunks 已写 38381 条
   * ```
   *
   * 后果不止是难看的日志：`FeedService` 把它记成失败 → `consecutiveFailures`
   * 累进 → 触发退避 → **后续自动建图被推迟**，而实际上什么都没坏。
   *
   * 这里让轮询跑满 1000 轮 —— `sleep` 推 ManualClock，等价 **50 分钟**，
   * 跨过旧实现那个 45min 判据（真实耗时仍是毫秒级）。必须成功。
   */
  it("★★ 建图跑很久也不判超时（原来 45min 就报假失败）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    let polls = 0
    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => {
        polls += 1
        // 1000 轮 × 3s = 50 分钟 —— 跨过旧实现那个 45min 判据
        return polls < 1000 ? snap({ state: "running", phase: "phase_b", percent: 0.4 }) : snap()
      },
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(true)
    expect(r.entities).toBe(15)
    // 反证：确实轮了很多次（不是走了别的早退分支）
    expect(polls).toBeGreaterThanOrEqual(1000)
  })

  /**
   * ★ 那靠什么结束 —— **进程真没了**才算失败。
   *
   * 两个条件都要：连续多次探测不到 `/status`（`INGEST_PROBE_FAILURE_LIMIT`）
   * **且**子进程句柄已死。只看探测会误伤（建图期间 server 烧 CPU，偶发超时
   * 是常态），所以这里 `crash()` 让句柄也死掉。
   */
  it("★ 建图中 kl-server 进程死了 → 判失败（这是唯一的失败判据）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    let polls = 0
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => {
        polls += 1
        // 第 3 轮进程崩掉，之后探测一律抛（连不上）
        if (polls === 3) runner.crash()
        if (polls >= 3) throw new Error("ECONNREFUSED")
        return snap({ state: "running", phase: "phase_a", percent: 0.2 })
      },
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("进程已退出")
  })

  /**
   * ★ 反证：探测偶发失败但进程还活着 → **不能**判失败。
   *
   * 建图期间 server 在烧 CPU，3s 的 `/status` 偶发超时是常态。只看探测失败
   * 就判死会把正常建图打断 —— 那是我们刚修掉的那类 bug 的另一种形态。
   */
  it("★ 探测偶发失败但进程活着 → 继续等，不判失败", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    let polls = 0
    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => {
        polls += 1
        // 连续 10 次失败（远超 INGEST_PROBE_FAILURE_LIMIT=5），但句柄始终 alive
        if (polls <= 10) throw new Error("timeout")
        return snap()
      },
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(true)
    expect(r.entities).toBe(15)
  })

  /**
   * ★ 409 = server 说"已经有一个 ingest 在跑"，这**不是**错误。
   *
   * 真实场景：上一次触发还没跑完就重启了应用（或用户手动 `kl ingest` 过）。
   * 那时正确的行为是**跟随**那一个的进度，而不是报错让用户再点一次
   * （再点还是 409，于是他会认为功能坏了）。
   */
  it("409（已有 ingest 在跑）→ 跟随它，不报错", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 409,
      readStatus: async () => snap(),
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(true)
    expect(r.entities).toBe(15)
  })

  /**
   * ★★ 一组：ingest 说 `done` 但**图是空的** —— 必须判失败。
   *
   * ## 这防的是打包态实测抓到的一幕
   *
   * 界面上是一句绿色的「建图完成: 0 实体 / 0 事实 / 0 边」，而同一时刻
   * 日志里是 `auto graph build failed`。用户没有任何理由去看日志，
   * 于是永远不知道要去填网关 key —— 而那正是真正的原因（kl 带着空的
   * `KL_LLM_BASE_URL` 起来，Phase B 报 `Connection error`）。
   *
   * 「成功」配着三个 0 是本项目最典型的静默失败形态，所以这里逐档锁住。
   * 分档是必要的：三种情况的**下一步完全不同**（等一轮 / 修 LLM 网关 /
   * 修 embedding 网关），给一句笼统的"建图失败"等于没说。
   */
  it("★★ 导出目录里没有 records.jsonl → 判失败，且说是「还没有数据」", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    // 真目录但**空的** —— 自动建图跑在首次导出之前时就是这个形状
    const exportDir = mkdtempSync(join(tmpdir(), "mycontext-kl-noexport-"))
    dirs.push(exportDir)
    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir,
      postIngest: async () => 200,
      // ingest 自己是"成功"的 —— 它确实把一个空输入处理完了
      readStatus: async () => snap({ counts: { entities: 0, facts: 0, edges: 0 } }),
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("导出还没生成")
    // ★ 不该把人引向"去改网关"—— 这一档用户什么都不用做
    expect(r.reason).not.toContain("密钥")
  })

  /**
   * ★★ 有输入、chunks 也写进去了 → Phase A 成功、Phase B 没产出。
   *
   * 这是打包态那个真实故障的形状（实测 `chunks: 3847` 而 `entities: 0`）。
   * 处置是去填/修网关，所以文案必须指向设置页。
   */
  it("★★ 有数据、切块也成功但 0 实体 → 判失败，指向网关设置", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const exportDir = mkdtempSync(join(tmpdir(), "mycontext-kl-hasexport-"))
    dirs.push(exportDir)
    mkdirSync(join(exportDir, "chat"), { recursive: true })
    writeFileSync(join(exportDir, "chat", "records.jsonl"), '{"id":"m1"}\n')

    // `graphOverview` 读图库拿 chunks 数 —— 走 `openGraphDb` 注入点而不是
    // 铺一个真 SQLite：better-sqlite3 在测试态编的是 Node ABI，而这套单测
    // 刻意不碰 native（那是 `pnpm native:node/electron` 来回切的根源）。
    const dataDir = mkdtempSync(join(tmpdir(), "mycontext-kl-emptygraph-"))
    dirs.push(dataDir)
    // graphOverview 先判 knowledge.db 文件在不在，所以要真有这个文件
    writeFileSync(join(dataDir, "knowledge.db"), "")

    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir,
      dataDir,
      postIngest: async () => 200,
      readStatus: async () => snap({ counts: { entities: 0, facts: 0, edges: 0 } }),
      // Phase A 成功的形状：chunks 有 3847 行，entities/facts 全 0
      openGraphDb: () => ({
        count: (table) => (table === "chunks" ? 3847 : 0),
        groupBy: () => [],
        topEntities: () => [],
        recentFacts: () => [],
        close: () => {},
      }),
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(false)
    // 带上真实块数：那个数字本身就是"Phase A 成功了"的证据
    expect(r.reason).toContain("3847")
    expect(r.reason).toContain("设置")
  })

  /**
   * ★ 反证：真的建出东西来时**不能**被这条新判据误伤。
   *
   * `entities > 0` 就该是成功 —— 哪怕 edges 是 0（关系边是建图最后一步，
   * 中途快照里 edges=0 是正常的）。
   */
  it("★ 反证：抽出了实体 → 仍判成功（哪怕 edges 是 0）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => snap({ counts: { entities: 15, facts: 23, edges: 0 } }),
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(true)
    expect(r.entities).toBe(15)
  })

  /**
   * ★ 重建（fresh=true）：先把 knowledge.db / qdrant_data / extraction_cache 删掉再跑，
   * 否则抽取缓存（key=md5(msg.id)）会命中旧结果，达不到"重抽"的意图。
   */
  it("rebuildGraph(true) 清空数据目录后再建图", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const dataDir = mkdtempSync(join(tmpdir(), "mycontext-kl-fresh-"))
    dirs.push(dataDir)
    // 铺出旧图 + 缓存
    writeFileSync(join(dataDir, "knowledge.db"), "old")
    mkdirSync(join(dataDir, "qdrant_data"), { recursive: true })
    mkdirSync(join(dataDir, "extraction_cache", "ab"), { recursive: true })
    writeFileSync(join(dataDir, "extraction_cache", "ab", "x.json"), "{}")

    /**
     * ★ 这个用例验的是 **wipe 的顺序**，所以必须先过 `fresh` 前置闸
     * （见 `freshRebuildBlocker`：清库前要求"导出里真有数据"+"网关配好了"）。
     * 不铺这两样的话它会在清库**之前**就被挡下 —— 那是闸在正常工作，
     * 但这个用例就测不到它想测的东西了。闸本身有独立的用例（见下面那组）。
     */
    const exportDir = mkdtempSync(join(tmpdir(), "mycontext-kl-fresh-export-"))
    dirs.push(exportDir)
    mkdirSync(join(exportDir, "chat"), { recursive: true })
    writeFileSync(join(exportDir, "chat", "records.jsonl"), '{"id":"m1"}\n')

    const runner = fakeRunner()
    /**
     * ★ 断言 wipe 发生在 POST **之前**。
     *
     * 顺序反了的话我们会把新 ingest 刚写进去的东西删掉 —— 表现是
     * "清空重来跑完了，图还是空的"，而两步单独看都成功了。
     * 所以在 postIngest 的回调里量一次文件是否已经没了。
     */
    let dbGoneAtPost: boolean | null = null
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir,
      dataDir,
      // 前置闸要求网关配好（没网关时清库 = 清完也抽不出实体）
      gateway: () => ({ llmBaseUrl: "https://gw", apiKey: "sk-x" }),
      postIngest: async () => {
        dbGoneAtPost = !existsSync(join(dataDir, "knowledge.db"))
        return 200
      },
      readStatus: async () => snap(),
    })
    const r = await svc.rebuildGraph(true)
    expect(r.ok).toBe(true)
    // 删干净了（`knowledge.db` 会被 ensureReady 之后的 server 重建，
    // 但 qdrant_data / extraction_cache 是我们删的那两个）
    expect(existsSync(join(dataDir, "qdrant_data"))).toBe(false)
    expect(existsSync(join(dataDir, "extraction_cache"))).toBe(false)
    // ★ 顺序：POST 的时候旧库已经不在了
    expect(dbGoneAtPost).toBe(true)
    /**
     * ★ 不再另起 ingest 进程 —— 建图交给跑着的 server（`POST /ingest`）。
     *
     * 这条替换了原来的 `expect(getSpawnSpec().args).toEqual(["-m","scripts.ingest"])`：
     * in-server ingest 复用同一个 Qdrant writer，于是"两个进程抢文件"的前提没了。
     * 断言"没有 spawn"比断言"spawn 了什么"更能锁住这个决定。
     */
    expect(runner.getSpawnSpec()).toBeNull()
  })

  it("rebuildGraph(false) 增量：不删数据目录", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const dataDir = mkdtempSync(join(tmpdir(), "mycontext-kl-incr-"))
    dirs.push(dataDir)
    writeFileSync(join(dataDir, "knowledge.db"), "keep")

    const runner = fakeRunner({ exitCode: 0 })
    const svc = makeService({
      runner,
      probeHealth: async () => false,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      dataDir,
    })
    await svc.rebuildGraph(false)
    expect(existsSync(join(dataDir, "knowledge.db"))).toBe(true)
  })
})

describe("KlServerService · 优化图谱（optimizeGraph / periodic）", () => {
  it("跑 `-m scripts.improve`（cwd=klRoot），解析计数，成功", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner({
      exitCode: 0,
      lines: [
        "  Fact SIMILAR_TO edges: 40",
        "  Entity SIMILAR_TO edges: 12",
        "    L0: 8 communities, 100 entities",
        "    L1: 5 communities, 100 entities",
        "    L0: 3 communities, 50 facts",
      ],
    })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
    })
    const r = await svc.optimizeGraph()
    expect(r.ok).toBe(true)
    expect(r.factEdges).toBe(40)
    expect(r.entityEdges).toBe(12)
    // 各层社群数累加（8+5 实体 / 3 事实）
    expect(r.entityCommunities).toBe(13)
    expect(r.factCommunities).toBe(3)
    const spawn = runner.getSpawnSpec()!
    expect(spawn.args).toEqual(["-m", "scripts.improve"])
    expect(spawn.cwd).toBe("/fake/kl-graph")
  })

  it("improve 期间 building:true 且 state 从不误报 starting", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner({ exitCode: 0 })
    const events: Array<{ state: string; building: boolean }> = []
    const svc = makeService({
      runner,
      probeHealth: async () => false,
      clock: new ManualClock(1_000),
      events,
    })
    await svc.optimizeGraph()
    expect(events.some((e) => e.building === true)).toBe(true)
    expect(events.filter((e) => e.building === true).every((e) => e.state !== "starting")).toBe(
      true,
    )
  })

  it("improve 退出码非 0 → failed", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner({ exitCode: 1 })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
    })
    const r = await svc.optimizeGraph()
    expect(r.ok).toBe(false)
    expect(svc.status().state).toBe("failed")
  })
})

/**
 * ★ 依赖没装好时，必须**在起进程之前**就说清楚。
 *
 * 起因是同事机器上的真实故障：`.venv/` 是 gitignore 的，clone 下来没有，
 * `resolvePython()` 于是退回系统 python3（那里面没有 qdrant/litellm/jieba），
 * kl-server 起来就 `exit 3` —— 日志里只有一句退出码，看不出是缺依赖，
 * 表现是"能和 opencode 聊，但 kl 调不通"。
 *
 * 所以 start() 的第一步是 ensureDeps：装好过就秒返回，没装好就明确 fail。
 */
describe("KlServerService · Python 环境准备与激活", () => {
  const ok = {
    python: "/bundled/venv/bin/python",
    env: { VIRTUAL_ENV: "/bundled/venv", PATH: "/bundled/venv/bin:/usr/bin" },
  }

  it("环境不可用 → 直接 failed，且**不** spawn（否则会拿系统 python 起出 exit 3）", async () => {
    const runner = fakeRunner()
    const service = makeService({
      runner,
      clock: new ManualClock(0),
      probeHealth: async () => true,
      preparePython: async () => null,
    })
    const ready = await service.ensureReady()

    expect(ready).toBe(false)
    expect(service.status().state).toBe("failed")
    expect(runner.getSpec()).toBeNull()
    // 原因要给出可照做的下一步
    expect(service.status().reason ?? "").toContain("pnpm setup:python")
  })

  it("preparePython 抛异常也算不可用（不把异常泄到启动路径）", async () => {
    const runner = fakeRunner()
    const service = makeService({
      runner,
      clock: new ManualClock(0),
      probeHealth: async () => true,
      preparePython: () => Promise.reject(new Error("boom")),
    })
    expect(await service.ensureReady()).toBe(false)
    expect(service.status().state).toBe("failed")
    expect(runner.getSpec()).toBeNull()
  })

  /**
   * ★ 核心：用**内置 venv 的解释器**起进程，而不是系统 python3。
   */
  it("环境就绪 → 用 venv 解释器 spawn", async () => {
    const runner = fakeRunner()
    const service = makeService({
      runner,
      clock: new ManualClock(0),
      probeHealth: async () => true,
      preparePython: async () => ok,
    })
    expect(await service.ensureReady()).toBe(true)
    expect(runner.getSpec()?.executable).toBe(ok.python)
  })

  /**
   * ★ 激活：env 里要带 VIRTUAL_ENV 且 PATH 前插 venv/bin。
   *
   * 只用绝对路径起对的解释器不够 —— kl 内部还会自己 spawn python
   * （它 scripts/ 里有），那时靠的是 PATH。不激活的话那些子进程会命中系统 python。
   */
  it("环境就绪 → 子进程在激活后的 venv 里（VIRTUAL_ENV + PATH）", async () => {
    const runner = fakeRunner()
    const service = makeService({
      runner,
      clock: new ManualClock(0),
      probeHealth: async () => true,
      preparePython: async () => ok,
    })
    await service.ensureReady()

    const env = runner.getSpec()?.env ?? {}
    expect(env["VIRTUAL_ENV"]).toBe("/bundled/venv")
    expect(env["PATH"]?.startsWith("/bundled/venv/bin")).toBe(true)
    // kl 自己那套变量仍然要在
    expect(env["KL_SERVER_PORT"]).toBeDefined()
  })

  it("没注入 preparePython → 保持原行为（兜底解析本机 python）", async () => {
    const runner = fakeRunner()
    const service = makeService({
      runner,
      clock: new ManualClock(0),
      probeHealth: async () => true,
    })
    expect(await service.ensureReady()).toBe(true)
    expect(runner.getSpec()?.executable).toBeDefined()
  })
})

/**
 * ★★ kl 子进程输出的日志分级。
 *
 * ## 这一组防的是一个**跨三台机器**的诊断盲区
 *
 * kl 的 stdout/stderr 原来一律记 `debug`，而打包态 `logLevel: info` 把它整段
 * 丢掉。代价：有同事「建图完成」但一条 fact 都没有，而**为什么**在我们的日志里
 * 根本不存在 —— 唯一的线索是 kl stdout 里那行 `LLM errors: 430`。
 *
 * 根因在上游 `kl_graph/ingest/llm_extractor.py`：LLM 调用失败时
 * `return [{"entities": [], "facts": [], "_error": …}]`，而 `_process_batch`
 * 紧接着把那个空结果**写进磁盘缓存**。于是抽取不抛异常、ingest 报
 * `done "ingest complete"`；下一次建图全部命中空缓存 —— 实测 87 秒
 * "建成"一张空图（4365 条消息、零 LLM 调用）。
 *
 * ## 为什么必须测
 *
 * 判据是一串正则，而"规则写错"与"规则生效"**外观完全相同**（日志里都没那行）。
 * 而且这条 bug 只在**打包态**显形（dev 的 logLevel 是 debug，一切正常），
 * 也就是最不容易被日常开发碰到、却最影响远程排查的那一类。
 */
describe("★★ kl 子进程日志分级（klLogLevelFor）", () => {
  it("★★ `LLM errors: 430` → warn（这是 facts=0 的唯一线索）", () => {
    expect(klLogLevelFor("  LLM errors: 430")).toBe("warn")
    expect(klLogLevelFor("  LLM errors: 1")).toBe("warn")
  })

  /**
   * ★ 反证：`LLM errors: 0` 是**正常**情况，每次建图都打一行。
   * 提成 warn 的话每次成功建图都会留一条假警报 —— 而"日志里有 warn"
   * 是我们判断"这台机器有问题"的第一个信号，不能污染它。
   */
  it("★ 反证：`LLM errors: 0` 不是 warn", () => {
    expect(klLogLevelFor("  LLM errors: 0")).not.toBe("warn")
  })

  it("★ Python/litellm 的错误征兆 → warn", () => {
    expect(klLogLevelFor("ERROR:    [Errno 48] address already in use")).toBe("warn")
    expect(klLogLevelFor("Traceback (most recent call last):")).toBe("warn")
    expect(klLogLevelFor("litellm.InternalServerError: Connection error.")).toBe("warn")
    expect(klLogLevelFor("Background ingest failed")).toBe("warn")
  })

  it("★ 阶段里程碑 → info（一次建图各一行，不刷屏）", () => {
    expect(klLogLevelFor("PHASE B.1: LLM EXTRACTION")).toBe("info")
    expect(klLogLevelFor("  Extraction complete in 812.3s (13.5 min)")).toBe("info")
    expect(klLogLevelFor("=== kl-server ready in 8.6s (port 8200) ===")).toBe("info")
  })

  /**
   * ★★ 抽取统计要能看见 —— 这几行合起来回答"这次到底调没调 LLM"。
   *
   * 那次 87 秒空跑的特征就在这里：`Cache hits: 4365` + `LLM calls made: 0`。
   * 看不到它们的话，"87 秒建完 4365 条"只能靠掐时间猜。
   */
  it("★★ 抽取统计汇总 → info（`Cache hits: 4365` 能识破空跑）", () => {
    expect(klLogLevelFor("  Total messages processed: 4365")).toBe("info")
    expect(klLogLevelFor("  Cache hits: 4365")).toBe("info")
    expect(klLogLevelFor("  LLM calls made: 0")).toBe("info")
    expect(klLogLevelFor("  Chunks needing extraction: 0 / 4365")).toBe("info")
  })

  /**
   * ★ 反证：**不能**一律提 info。
   *
   * kl 的 stdout 很吵 —— 每批抽取打一行 Progress，一次建图几百行。
   * 全提 info 会淹掉我们自己的日志，而那份日志是排查远程问题的全部依据。
   */
  it("★ 反证：逐批进度仍是 debug（否则一次建图刷几百条）", () => {
    expect(klLogLevelFor("  Progress: 12/430 batches (120/4300 msgs)")).toBe("debug")
    expect(klLogLevelFor("[B.1] Loading chunks (chat + sources)...")).toBe("debug")
    expect(klLogLevelFor('INFO:     127.0.0.1:60920 - "GET /health HTTP/1.1" 200 OK')).toBe("debug")
  })

  /**
   * ★★ **stderr 也走这个函数** —— 上一版把 stderr 一律记成 warn，理由是
   * "kl 只在真出问题时往 stderr 写"。那个判断是错的。
   *
   * uvicorn、LiteLLM、kl 自己的 logging **全部**走 stderr（Python logging 的
   * 默认 StreamHandler 就是 stderr）。实测一次 4 小时会话：
   * ```
   * 总 10817 条日志
   *   9706  kl-server stderr    ← 90%
   *     ↳ 5394 LiteLLM 日志 / 4108 kl 的 [INFO] / 只有 30 条真警告
   * ```
   * 30 条有用的被 9676 条噪音埋着，日志文件涨到 1.7MB —— 而"日志里有 warn"
   * 本该是"这台机器有问题"的第一信号，那个信号被彻底冲淡。
   *
   * 所以这里锁住：**stderr 上那些日常行必须是 debug**。
   */
  it("★★ stderr 上的 uvicorn/LiteLLM/kl 日常日志是 debug（不是 warn）", () => {
    // uvicorn 的启动流水（每次起 kl 都有一串）
    expect(klLogLevelFor("INFO:     Started server process [95239]")).toBe("debug")
    expect(klLogLevelFor("INFO:     Waiting for application startup.")).toBe("debug")
    expect(klLogLevelFor("INFO:     Application startup complete.")).toBe("debug")
    expect(klLogLevelFor("INFO:     Uvicorn running on http://127.0.0.1:8200")).toBe("debug")
    // LiteLLM 的成功回调（5394 条里的大头）
    expect(klLogLevelFor("19:47:02 - LiteLLM:INFO: utils.py:1479 - Wrapper: Completed Call")).toBe(
      "debug",
    )
    expect(klLogLevelFor("LiteLLM completion() model= qwen3.7-flash; provider = anthropic")).toBe(
      "debug",
    )
    // kl 自己的 [INFO]（4108 条）
    expect(klLogLevelFor("2026-08-03 19:37:51,807 [INFO] Opening SQLite: /path/knowledge.db")).toBe(
      "debug",
    )
    // Pydantic 的弃用提醒 —— 每次启动都有，不是我们能处理的问题
    expect(
      klLogLevelFor("PydanticDeprecatedSince20: Support for class-based `config` is deprecated"),
    ).toBe("debug")
  })

  /**
   * ★★ 反证：stderr 上真正的失败**仍然**要抓到。
   *
   * 降级不能把这几条一起降掉 —— 它们是"kl 为什么起不来 / 为什么没结果"的
   * 全部信息量。`[Errno 48]` 那条实测决定过一次误判（看起来像崩溃，其实是
   * 端口被一个卡死的 kl 占着）。
   */
  /**
   * ★★★ 锁**调用点** —— 上面那些用例测的是纯函数，而真实 bug 在调用点。
   *
   * 实测验证过：把 `onStderr` 改回 `logger.warn(...)` 一律 warn（上一版的
   * 错误实现），上面 8 个纯函数用例**照样全绿**。也就是那一组根本没有防住
   * 要防的东西。所以这里起一个真 service、喂真 stderr 行、量真实级别。
   */
  it("★★★ 真起进程喂 stderr → 日常行落在 debug（锁调用点，不只是纯函数）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const seen: Array<{ level: string; line: unknown }> = []
    const rec = (level: string) => (message: string, fields?: Record<string, unknown>) => {
      if (message.includes("kl-server")) seen.push({ level, line: fields?.["line"] })
    }
    const recorder = {
      debug: rec("debug"),
      info: rec("info"),
      warn: rec("warn"),
      error: rec("error"),
      child: () => recorder,
    } as unknown as ConstructorParameters<typeof KlServerService>[0]["logger"]

    const svc = makeService({
      runner: fakeRunner({
        lines: [
          // 这四行是实测日志里最多的那几类（合计 9600+ 条）
          "INFO:     Started server process [95239]",
          "19:47:02 - LiteLLM:INFO: utils.py:1479 - Wrapper: Completed Call",
          "2026-08-03 19:37:51,807 [INFO] Opening SQLite: /path/knowledge.db",
          // 而这一条必须仍然是 warn
          "ERROR:    [Errno 48] error while attempting to bind on address",
        ],
      }),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      logger: recorder,
    })
    await svc.ensureReady()

    const warns = seen.filter((s) => s.level === "warn")
    // ★★ 只有那条 ERROR 是 warn —— 另外三条日常行不许污染 warn
    expect(warns).toHaveLength(1)
    expect(String(warns[0]?.line)).toContain("Errno 48")
    // 三条日常行确实收到了（走 debug），不是被丢了
    expect(seen.filter((s) => s.level === "debug")).toHaveLength(3)
  })

  it("★★ 反证：stderr 上的真失败仍是 warn", () => {
    expect(
      klLogLevelFor(
        "ERROR:    [Errno 48] error while attempting to bind on address ('127.0.0.1', 8200)",
      ),
    ).toBe("warn")
    expect(klLogLevelFor("ERROR:    Exception in ASGI application")).toBe("warn")
    expect(klLogLevelFor("Traceback (most recent call last):")).toBe("warn")
    // 实测抓到的那条上游 bug：judge 少了 /v1，404 了 303 次
    expect(
      klLogLevelFor(
        "LLM judge error: Client error '404 Not Found' for url 'https://gw/chat/completions'",
      ),
    ).toBe("warn")
    expect(klLogLevelFor("  LLM errors: 430")).toBe("warn")
  })
})

/**
 * ★★ `fresh=true`（清空重来）的前置闸。
 *
 * ## 这一组防的是一个**已经在两台同事机器上发生**的数据损失
 *
 * 原来的顺序是 `stop → wipe → ensureReady → postIngest`，而 wipe 之后每一步
 * 都可能失败并 return。两台机器的日志里都是同一个形状：
 * ```
 * 09:55:46 kl graph data wiped for fresh rebuild
 * 09:55:49 kl-server ready
 * ── 之后再无任何建图记录 ──
 * ```
 * 图库被清空了、没建回来，**比点之前更糟**。
 */
describe("★★ 清空重建的前置闸（freshRebuildBlocker）", () => {
  /** 有真数据的导出目录（闸的第一个条件）。 */
  function exportWithData(): string {
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-gate-export-"))
    dirs.push(dir)
    mkdirSync(join(dir, "chat"), { recursive: true })
    writeFileSync(join(dir, "chat", "records.jsonl"), '{"id":"m1"}\n')
    return dir
  }

  /** 数据目录，铺一个假图库用来验"到底删没删"。 */
  function dataDirWithGraph(): string {
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-gate-data-"))
    dirs.push(dir)
    writeFileSync(join(dir, "knowledge.db"), "old-graph")
    mkdirSync(join(dir, "qdrant_data"), { recursive: true })
    return dir
  }

  it("★★ 没配网关 → 拒绝清库，图还在", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const dataDir = dataDirWithGraph()
    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: exportWithData(),
      dataDir,
      // 不注入 gateway = 没配网关
      postIngest: async () => 200,
      readStatus: async () => snap(),
    })
    const r = await svc.rebuildGraph(true)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("网关")
    // ★★ 核心：旧图**还在**（这正是两台同事机器上丢掉的东西）
    expect(existsSync(join(dataDir, "knowledge.db"))).toBe(true)
    expect(existsSync(join(dataDir, "qdrant_data"))).toBe(true)
  })

  it("★★ 导出还没生成 → 拒绝清库，图还在", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const dataDir = dataDirWithGraph()
    // 空导出目录（没有 chat/records.jsonl）
    const emptyExport = mkdtempSync(join(tmpdir(), "mycontext-kl-gate-noexp-"))
    dirs.push(emptyExport)
    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: emptyExport,
      dataDir,
      gateway: () => ({ llmBaseUrl: "https://gw", apiKey: "sk-x" }),
      postIngest: async () => 200,
      readStatus: async () => snap(),
    })
    const r = await svc.rebuildGraph(true)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("数据")
    expect(existsSync(join(dataDir, "knowledge.db"))).toBe(true)
  })

  /**
   * ★ 反证：**增量**建图（`fresh=false`）不走这道闸。
   *
   * 它不删任何东西，失败的代价只是白跑一趟；多一道闸反而会挡住合理的重试
   * （比如用户刚配好网关想立刻建一次）。
   */
  it("★ 反证：增量建图不受这道闸约束", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const emptyExport = mkdtempSync(join(tmpdir(), "mycontext-kl-gate-incr-"))
    dirs.push(emptyExport)
    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: emptyExport,
      // 没网关、没导出 —— 增量仍然应该走到 postIngest
      postIngest: async () => 200,
      readStatus: async () => snap(),
    })
    const r = await svc.rebuildGraph(false)
    // 走到了真正的建图（计数来自 /status），说明没被闸挡下
    expect(r.ok).toBe(true)
    expect(r.entities).toBe(15)
  })
})

/**
 * ★★ 「有实体但没事实」= 抽取缓存被污染，必须判失败并给对的下一步。
 *
 * 实测形状（同事机器）：`graph auto-built` 说成功，87 秒跑完 4365 条消息，
 * 而用户看到 facts=0。原来的判据是 `entities === 0 && facts === 0`，
 * 那个 `&&` 太松 —— 这一档 entities 非零，于是被判成了成功。
 */
describe("★★ 有实体但零事实 → 判失败（抽取缓存被污染）", () => {
  it("★★ facts=0 而 entities>0 → 不算成功", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    // ★ 要铺真导出：`emptyGraphReason` 的第一档是"导出还没生成"，
    // 而这个用例验的是**第二档**（缓存被污染）。不铺就会命中第一档。
    const exportDir = mkdtempSync(join(tmpdir(), "mycontext-kl-poison-"))
    dirs.push(exportDir)
    mkdirSync(join(exportDir, "chat"), { recursive: true })
    writeFileSync(join(exportDir, "chat", "records.jsonl"), '{"id":"m1"}\n')
    // ★ `graphOverview` 先判 knowledge.db 在不在（不在就早退，压根不调
    // openGraphDb）—— 所以要真有这个文件，注入的计数才会被用上。
    const dataDir = mkdtempSync(join(tmpdir(), "mycontext-kl-poison-data-"))
    dirs.push(dataDir)
    writeFileSync(join(dataDir, "knowledge.db"), "")
    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir,
      dataDir,
      postIngest: async () => 200,
      // kl 报"建成"，有实体、但一条事实都没有
      readStatus: async () => snap({ counts: { entities: 120, facts: 0, edges: 0 } }),
      openGraphDb: () => ({
        count: (t) => (t === "entities" ? 120 : t === "chunks" ? 3905 : 0),
        groupBy: () => [],
        topEntities: () => [],
        recentFacts: () => [],
        close: () => {},
      }),
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(false)
    /**
     * ★ 指引必须指向「重建」（清抽取缓存），**不是**"去改网关" ——
     * 这一档网关可能本来就是好的，改它没有任何用（缓存已经脏了）。
     * 给错指引的代价是用户反复检查一个正确的配置。
     */
    expect(r.reason).toContain("缓存")
    expect(r.reason).toContain("重建")
    // 真实计数要带出来（那 120 个实体确实在库里，说谎会更难查）
    expect(r.entities).toBe(120)
    expect(r.facts).toBe(0)
  })

  it("★ 反证：有事实就算成功（哪怕 edges 是 0）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const svc = makeService({
      runner: fakeRunner(),
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => snap({ counts: { entities: 120, facts: 340, edges: 0 } }),
    })
    const r = await svc.rebuildGraph()
    expect(r.ok).toBe(true)
    expect(r.facts).toBe(340)
  })
})

/**
 * ★★ 退出应用时杀掉 kl **不是**建图失败。
 *
 * 实测的坏形态（每次退出都撞一次）：
 * ```
 * 14:50:14.021 shutdown step started {"step":"klServer"}     ← 我们杀 kl
 * 14:50:14.809 graph build failed {"reason":"建图中断：kl-server 进程已退出"}
 * 14:50:14.810 graph auto build failed {"consecutiveFailures":1,
 *                                       "retryAfterMs":1800000}
 * ```
 * 于是**下次启动后半小时不自动建图**，而这一轮什么都没坏。
 *
 * 根因：`awaitIngest` 唯一的失败判据是"进程死了"（墙钟超时那条早先被
 * 刻意删掉了，见实现处注释），所以它分不清"崩了"与"我们自己关的"。
 *
 * 这一组测的是**服务这一侧**：`stop()` 期间的建图必须回 `cancelled: true`
 * 而不是 `reason: 进程已退出`。上层不计入退避那半边在
 * `tests/unit/knowledge-feed/graph-sync.test.ts` 里锁。
 */
describe("KlServerService · 建图被主动打断（stop）不算失败", () => {
  it("★ 轮询期间 stop() → cancelled，且不带失败原因", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    /**
     * 让状态一直 `running`，于是 `awaitIngest` 会一直轮询 ——
     * 直到我们在第二次轮询前把服务停掉。
     *
     * ★ 停在**轮询循环里**而不是 POST 之前：那才是真实时序（建图跑了
     * 几十分钟，用户点了退出）。POST 之前停的话根本进不了这条路径。
     *
     * ★★ 而 `stop()` **之后**的探测必须抛错，因为那时 kl 真的没了。
     * 让它继续返回 `running` 就不忠实了 —— 而且会掩盖问题：撤掉修复后
     * 循环永远出不来（测试挂死而不是变红），于是这条测试变成假绿。
     */
    let polls = 0
    let killed = false
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => {
        if (killed) throw new Error("connect ECONNREFUSED")
        polls += 1
        if (polls === 2) {
          // 模拟 before-quit：把 kl 关掉（内部会立 stopping 再 close handle）
          await svc.stop()
          killed = true
        }
        return snap({ state: "running", phase: "phase_a", percent: 0.4 })
      },
    })

    const r = await svc.rebuildGraph()

    /**
     * ★ `ok:false` 是对的（图确实没建成，不能推建图水位）——
     * 但必须带上 `cancelled`，否则上层没法把它与真失败分开。
     */
    expect(r.ok).toBe(false)
    expect(r.cancelled).toBe(true)
    // 而且**不能**编一个失败原因：那条 reason 会被当成真错误上报
    expect(r.reason).toBeNull()
    // building 必须落回 false，否则下次启动入口永久禁用
    expect(svc.status().building).toBe(false)
  })

  it("对照：进程真崩了 → 不是 cancelled，且带原因", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    let polls = 0
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => {
        polls += 1
        // 第二轮起进程没了：探测抛错 + handle 已死 → 真失败
        if (polls === 1) return snap({ state: "running", phase: "phase_a", percent: 0.4 })
        runner.crash()
        throw new Error("connect ECONNREFUSED")
      },
    })

    const r = await svc.rebuildGraph()

    expect(r.ok).toBe(false)
    /**
     * ★ 这一条锁住修复**没有把真失败也一起吞掉**。
     *
     * 只测上面那条的话，把 `cancelled` 恒设为 true 也会全绿 ——
     * 而那会让真崩溃永远不进退避（每 10 分钟重试一次建图）。
     */
    expect(r.cancelled ?? false).toBe(false)
    expect(r.reason).toContain("进程已退出")
  })

  it("★ stop() 之后重新 start → stopping 标记作废（否则重起后的建图被误判）", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      exportDir: "/tmp/exports/dws",
      postIngest: async () => 200,
      readStatus: async () => snap(),
    })
    await svc.ensureReady()
    await svc.stop()

    // 再起一轮建图（用户手动点「重建」，或下一轮自动建图）
    const r = await svc.rebuildGraph()

    /**
     * ★ 如果 `stopping` 不在 `start()` 里清掉，这里会立刻回 cancelled ——
     * 表现是"点了重建，什么都没发生，日志说被打断了"，而且**永远**如此
     * （标记再也不会被清）。这条比第一条更隐蔽：它不是假失败而是假取消。
     */
    expect(r.cancelled ?? false).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.facts).toBe(23)
  })
})

/**
 * ★★ 这一组锁的是「kl-server 生命周期绑定」——把「建图恒 Broken pipe」根治掉。
 *
 * ## 事故形态（必须记住）
 *
 * kl-server 绑固定端口 8200。上一个应用实例没走优雅 `stop()`（crash / 强杀 /
 * 硬超时 / 开发态热重启）就会留下一个**孤儿**继续占着 8200，它的 stdio 是上一个
 * 实例的 socketpair、**读端已死**。下一个实例探到端口被占就 adopt 它 —— 而建图
 * 会往 stdout 狂 print，写到读端已关的 socket → `[Errno 32] Broken pipe`，建图恒
 * 失败（实测图库停在 500 条 fact、自我图只剩 2 个邻居）。
 *
 * 修法（方案 B）：用 pidfile 认出「自家孤儿」，启动时杀掉重起一个**有句柄**的；
 * 认不出（外部进程）就不拿它建图、给明确报错。判据同时要 pidfile.port 一致 +
 * pid 存活 + 端口 /health ok，缺一不接管（防 pid 复用误杀）。
 */
describe("KlServerService · 生命周期绑定（pidfile 自愈 + 建图不 adopt 孤儿）", () => {
  /** 造一个带 pidfile 的临时 dataDir，pidfile 指向给定 pid/port。 */
  function dataDirWithPidfile(pid: number, port = 8200): string {
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-pidfile-"))
    dirs.push(dir)
    writeFileSync(join(dir, "kl-server.pid"), JSON.stringify({ pid, port, startedAt: 1_000 }))
    return dir
  }

  /**
   * ★★ 建图前的硬闸：端口上是**外部进程**（无 pidfile）时，绝不 postIngest。
   *
   * 这是"EPIPE 永不再发生"的直接保证 —— 建图这条会 print 的路径要么有句柄、
   * 要么明确失败，绝不落到孤儿的死管道上。
   */
  it("★ 建图时端口被外部进程占（无 pidfile）→ 明确报错，且不 postIngest", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-nopid-"))
    dirs.push(dir)
    let postCalls = 0
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      probeExisting: async () => true, // 端口一直被占（外部进程不让出）
      clock: new ManualClock(1_000),
      dataDir: dir, // 没有 pidfile
      exportDir: "/tmp/exports/dws",
      postIngest: async () => {
        postCalls += 1
        return 200
      },
      readStatus: async () => snap(),
    })

    const r = await svc.rebuildGraph()

    expect(r.ok).toBe(false)
    expect(r.reason).toContain("不受本应用管理")
    // ★ 核心：绝不对孤儿发 /ingest（那正是 Broken pipe 的来源）
    expect(postCalls).toBe(0)
    // 没有句柄可用于建图，也没 spawn 出自己的（外部进程占着端口没让）
    expect(runner.getSpec()).toBeNull()
  })

  /**
   * ★★ 自家孤儿自愈：pidfile 指向存活的自家 pid → 先 SIGTERM 杀它，再 spawn
   * 一个有句柄的，建图照常。
   */
  it("★ 自家孤儿（pidfile 指向存活 pid）→ 先杀再起自己的，建图成功", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const dir = dataDirWithPidfile(4242)
    // 端口先被占（孤儿在），被 SIGTERM 后让出：第 2 次探测起转 false。
    let existingCalls = 0
    const killed: Array<{ pid: number; signal: string | number }> = []
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number): true => {
        killed.push({ pid, signal: signal ?? 0 })
        // signal 0 = 存在性检查：pid 4242 "活着"（不抛）。
        return true
      })
    let postCalls = 0
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      probeExisting: async () => {
        existingCalls += 1
        return existingCalls <= 1 // 首探被占，SIGTERM 后让出
      },
      clock: new ManualClock(1_000),
      dataDir: dir,
      exportDir: "/tmp/exports/dws",
      postIngest: async () => {
        postCalls += 1
        return 200
      },
      readStatus: async () => snap(),
    })

    const r = await svc.rebuildGraph()

    // 对孤儿发过 SIGTERM（signal 0 的存在性检查也在里面）
    expect(killed.some((k) => k.pid === 4242 && k.signal === "SIGTERM")).toBe(true)
    // 接管后 spawn 了自己的进程（有句柄）
    expect(runner.getSpec()).not.toBeNull()
    // 建图正常走 postIngest（不再是孤儿）
    expect(postCalls).toBe(1)
    expect(r.ok).toBe(true)
    killSpy.mockRestore()
  })

  /**
   * ★ pid 复用防误杀：pidfile 的 pid 已不存活（`process.kill(pid,0)` 抛）→
   * 判为「不是自家孤儿」，不发 SIGTERM，退回 adopt。
   */
  it("★ pidfile 指向的 pid 已死 → 不误杀，退回 adopt", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const dir = dataDirWithPidfile(4243)
    const sigterms: number[] = []
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number): true => {
        if (signal === 0 || signal === undefined) {
          // 存在性检查：这个 pid 已经没了。
          throw new Error("ESRCH")
        }
        sigterms.push(pid)
        return true
      })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      probeExisting: async () => true,
      clock: new ManualClock(1_000),
      dataDir: dir,
    })

    await svc.ensureReady()

    // 没对任何 pid 发过 SIGTERM（pid 已死 → 不接管）
    expect(sigterms).toHaveLength(0)
    // 退回 adopt：ready 且没 spawn 自己的
    expect(svc.status().state).toBe("ready")
    expect(runner.getSpec()).toBeNull()
    killSpy.mockRestore()
  })

  /**
   * ★ pidfile 的端口与当前端口不一致（别的 vault / 陈旧记录）→ 不接管。
   */
  it("★ pidfile 端口对不上 → 判为外部进程，不接管", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const dir = dataDirWithPidfile(4244, 9999) // 端口 9999 ≠ 8200
    const sigterms: number[] = []
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number): true => {
        if (signal !== 0 && signal !== undefined) sigterms.push(pid)
        return true
      })
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      probeExisting: async () => true,
      clock: new ManualClock(1_000),
      dataDir: dir,
    })

    await svc.ensureReady()

    expect(sigterms).toHaveLength(0) // 端口对不上，碰都不碰
    expect(svc.status().state).toBe("ready") // 退回 adopt
    killSpy.mockRestore()
  })

  /**
   * ★ 自己 spawn 成功后写 pidfile；优雅 stop() 后清掉。
   *
   * 下个实例靠这个文件的有无判断「要不要接管孤儿」——写漏了下次就 adopt 死管道，
   * 清漏了下次会去杀一个早没了的 pid。
   */
  it("★ spawn 后写 pidfile，stop() 后清掉", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-pidwrite-"))
    dirs.push(dir)
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      clock: new ManualClock(1_000),
      dataDir: dir,
    })

    await svc.ensureReady()
    // 起好后 pidfile 在，且记的是子进程 pid（fakeRunner 固定 9999）
    const pidfile = join(dir, "kl-server.pid")
    expect(existsSync(pidfile)).toBe(true)

    await svc.stop()
    // 优雅停之后 pidfile 消失
    expect(existsSync(pidfile)).toBe(false)
  })

  /**
   * ★ adopt 态（外部进程）下 stop() 不该写/留 pidfile —— 那不是我们的进程。
   */
  it("★ adopt 外部进程时不写 pidfile", async () => {
    process.env[KL_PYTHON] = "/fake/python"
    const runner = fakeRunner()
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-adoptnopid-"))
    dirs.push(dir)
    const svc = makeService({
      runner,
      probeHealth: async () => true,
      probeExisting: async () => true, // 端口被外部进程占（无 pidfile）
      clock: new ManualClock(1_000),
      dataDir: dir,
    })

    await svc.ensureReady()
    expect(svc.status().state).toBe("ready")
    // adopt 了别人的进程 —— 不该凭空写出一个 pidfile
    expect(existsSync(join(dir, "kl-server.pid"))).toBe(false)
    // 也没 spawn 自己的
    expect(runner.getSpec()).toBeNull()
  })
})

/**
 * ★★ 「清空重建」必须删干净，否则它**永久失败**。
 *
 * ## 实测现场（用户："点开始学习没反应"）
 *
 * ```
 * 14:05:36  graph build started {fresh: true}   → 删了 knowledge.db / qdrant
 * 14:05:47  graph build failed:
 *           "Checkpoint batch '…' has no durable workset;
 *            run Phase A before any chunk-dependent phase"
 * ```
 *
 * 根因：`ingest_checkpoint.<source_id>.json` **没被删**，而它记着
 * `phase_a.persist_chunks` 等步骤已完成 —— 而库刚被删空。于是 kl 跳过
 * Phase A 直奔 chunk 相关阶段，每次都报同一个错，**连"清空重建"也修不好**。
 *
 * 而它同时卡住第二条链路：`graphBusy()` 在那一瞬间为真 → work 层每轮让路
 * → playbook 永远等不到。一个漏删的文件沿两条路把两个功能一起卡死，
 * 且都不报根因。
 *
 * ★ 用源码断言：真实现要一个 kl 子进程 + 真图库。而这里要守的性质很窄
 * ——"那份删除清单里有这几个名字" —— 源码断言直接对上它。
 */
describe("★★ wipeGraphData 的删除清单", () => {
  const source = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "apps/desktop/src/main/services/kl-server.service.ts",
    ),
    "utf8",
  )
  /** 只看 `wipeGraphData` 那一段（别被别处的同名字符串蒙过去）。 */
  const body = (() => {
    const at = source.indexOf("private wipeGraphData")
    expect(at, "找不到 wipeGraphData —— 结构变了，这条断言要跟着改").toBeGreaterThan(0)
    return source.slice(at, at + 4000)
  })()

  it("★★ 删 checkpoint（不删它，清空重建会永久报 no durable workset）", () => {
    expect(body).toContain("ingest_checkpoint.")
  })

  it("★★ 删 ladybug 图库（边在那里，SQLite 的 edges 表按设计恒空）", () => {
    expect(body).toContain("graph.ladybug")
  })

  it("★★ 抽取缓存两个名字都删（上游从目录改成了单文件）", () => {
    /**
     * 原来只删 `extraction_cache`（无扩展名的旧目录名），而真实文件是
     * `extraction_cache.db` —— 于是那句"删了才会真的重抽"一直没做到。
     * 这与 `WORK_CORPUS_FACETS` 里那个 `ownership` 是同一类改名漏了一处。
     */
    expect(body).toContain('"extraction_cache.db"')
  })

  it("★ 仍然删 knowledge.db 与 qdrant（原有行为不许丢）", () => {
    expect(body).toContain('"knowledge.db"')
    expect(body).toContain('"qdrant_data"')
  })
})
