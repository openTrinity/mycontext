/**
 * ★★ 渠道命令必须**钉住当前 vault 绑定的那个身份**（`--profile`）。
 *
 * ## 这一组锁的是一个真实的越权读取面
 *
 * 渠道 CLI 的登录态按**系统用户**存，而"用哪个身份作答"由它自己的全局
 * `currentProfile` 决定 —— 那个值可能被用户在终端里、或上一次授权改掉。
 * 不钉的话应用会拿着 A 的 vault 去读 B 的会话与消息。
 *
 * 实测过（本机，两个身份都已登录）：
 * ```
 * profiles.json:  primary=组织甲  current=组织乙
 * auth status                                  → 组织乙  ← 界面显示这个
 * vault channel_self_identity                  → 组织甲  ← 库里绑这个
 * chat list-all-conversations                  → 38 个会话（组织乙的）
 * chat list-all-conversations --profile 组织甲  → 100 个会话
 * ```
 * 库里躺着组织甲的 248 个会话 / 83859 条消息，采集器却在按组织乙列会话。
 *
 * ## ★★ 为什么必须逐个 spawn 点都断言
 *
 * 有**三条**独立的起进程路径，`DwsCli` 只是其中一条：
 * `cli.ts`（业务命令）/ `auth.ts`（授权状态）/ `events.ts`（长连接与订阅）。
 * 后两条自己 `exec`/`spawnDuplex`，所以 `DwsCli` 里加的东西一样都到不了。
 *
 * 这个仓库已经在**同一个结构**上栽过一次：命令白名单门禁首版只覆盖
 * `DwsCli.run()`，而 `auth.ts` 整条路径绕过了它（见 cli.ts 文件头
 * 「门禁不能只覆盖一条调用路径」）。钉身份漏一处的表现是：
 * 会话列表钉住了而授权状态没有 —— 同一张卡片上两个互相矛盾的组织名，
 * 且没有任何报错。所以下面每条路径各有一条断言。
 */
import { describe, expect, it } from "vitest"
import { DingTalkAuth, DingTalkEventConsumer, DwsCli } from "@mycontext/channels"
import { RuntimeEnv } from "@mycontext/runtime-env"

/** 假身份。★ 值全是编的（CLAUDE.md §1.2）。 */
const PINNED = "dingFAKECORP0001:FAKEUSER0001"

const NOOP_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOGGER
  },
}

/**
 * `spawnDuplex` 的返回值形状（`DuplexHandle`）。
 *
 * ★ `close()` 必须触发 `onExit` —— 真实现关掉 stdin 后子进程退出，
 * 而 `spawnOnce` 的那个 Promise 只由 `onExit` settle。不触发的话
 * `stop()` 会永远等在"等重连循环收尾"那一步（表现为测试超时）。
 */
function fakeDuplex(spec: { onExit?: (info: unknown) => void }) {
  return {
    writeLine: async () => {},
    close: async () => {
      spec.onExit?.({ code: 0, signal: null })
    },
    alive: false,
    pid: undefined,
  }
}

/** 只被当成"能 resolve + buildEnv"用；`dwsProfileArgs` 走真实现（那正是被测的东西）。 */
function runtimeWith(profile: string | undefined): RuntimeEnv {
  return new RuntimeEnv({
    binDir: "/fake/bin",
    dwsChannel: "",
    dwsConfigDir: "/fake/absolute/dws-home",
    dwsProfile: () => profile,
    env: {},
  })
}

/** 把 `resolve()` 换成不碰文件系统的版本 —— 我们要验的是参数，不是二进制存在性。 */
function stubResolve(runtime: RuntimeEnv): RuntimeEnv {
  Object.defineProperty(runtime, "resolve", {
    value: () => ({ path: "/fake/dws", source: "bundled" }),
    configurable: true,
  })
  return runtime
}

// ---------------------------------------------------------------
// 路径 ①：RuntimeEnv 自己
// ---------------------------------------------------------------

describe("RuntimeEnv.dwsProfileArgs", () => {
  it("有身份时给出 --profile", () => {
    expect(runtimeWith(PINNED).dwsProfileArgs()).toEqual(["--profile", PINNED])
  })

  /**
   * ★ 没绑身份是**正常状态**（新账号还没授权过），必须给空数组。
   * 给 `["--profile", ""]` 会让上游报"组织未找到"，
   * 把一个正常状态变成一个错误。
   */
  it("没绑身份 / 空串 / 全空白 → 空数组，而不是 --profile 空值", () => {
    expect(runtimeWith(undefined).dwsProfileArgs()).toEqual([])
    expect(runtimeWith("").dwsProfileArgs()).toEqual([])
    expect(runtimeWith("   ").dwsProfileArgs()).toEqual([])
  })

  /**
   * ★ getter 每次现读：身份切换后**下一条命令**就得用新身份。
   * 取快照的话切完身份仍在读旧身份的数据 —— 正是这条要修的问题换个形式回来。
   */
  it("每次调用都现读（切身份后立即生效，不必重启）", () => {
    let current = "dingFAKECORP0001:FAKEUSER0001"
    const runtime = new RuntimeEnv({
      binDir: "/fake/bin",
      dwsChannel: "",
      dwsConfigDir: "/fake/absolute/dws-home",
      dwsProfile: () => current,
      env: {},
    })
    expect(runtime.dwsProfileArgs()).toEqual(["--profile", "dingFAKECORP0001:FAKEUSER0001"])
    current = "dingFAKECORP0002:FAKEUSER0002"
    expect(runtime.dwsProfileArgs()).toEqual(["--profile", "dingFAKECORP0002:FAKEUSER0002"])
  })

  /**
   * ★ **不能**放进 `buildEnv()`：上游没有等价的环境变量，
   * 那会是一个看起来生效、实际被完全忽略的注入。
   */
  it("不经环境变量传递（上游只认命令行参数）", () => {
    const env = runtimeWith(PINNED).buildEnv()
    expect(JSON.stringify(env)).not.toContain(PINNED)
  })
})

// ---------------------------------------------------------------
// 路径 ②：DwsCli（业务命令：会话列表、消息、头像…）
// ---------------------------------------------------------------

describe("DwsCli.run 钉住身份", () => {
  const captureArgs = async (
    profile: string | undefined,
    args: readonly string[],
  ): Promise<string[]> => {
    let seen: string[] = []
    const cli = new DwsCli({
      runtime: stubResolve(runtimeWith(profile)),
      processes: {
        exec: async (input: { args: string[] }) => {
          seen = input.args
          return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false }
        },
      } as never,
      logger: NOOP_LOGGER as never,
    })
    await cli.run(args)
    return seen
  }

  it("会话列表带上 --profile", async () => {
    const args = await captureArgs(PINNED, ["chat", "list-all-conversations"])
    expect(args).toContain("--profile")
    expect(args[args.indexOf("--profile") + 1]).toBe(PINNED)
  })

  it("消息拉取带上 --profile", async () => {
    const args = await captureArgs(PINNED, ["chat", "message", "list-all"])
    expect(args).toContain("--profile")
  })

  /**
   * ★★ 没绑身份时**拒绝执行业务命令** —— 这是行为变更，而且是安全修复。
   *
   * 原来这里断言的是"不带 --profile（退回 CLI 全局 profile）"。那个行为
   * 正是一个越权读取面：全局 `currentProfile` 由用户在终端里的最后一次操作
   * 决定，可能是**另一个组织**。于是"还没绑身份"这个状态下应用反而去读了
   * 某个人的会话与消息，落进一个不属于任何身份的库 —— 与 CLAUDE.md §5
   * 「不许扩大读取面」直接冲突，且完全静默（命令成功、数据入库、日志正常）。
   *
   * 实测触发路径：基础 vault（注册了但还没授权）挂载时 `dataPlane.attach`
   * 照常起采集，而那时 `dwsProfile()` 返回 undefined。
   *
   * 抛而不是返回空：静默返回空会被上层记成"这个账号 0 条会话"，
   * 那是本仓库最贵的那类 bug（把"读不到"记成"没有"）。
   */
  it("★★ 没绑身份时业务命令被拒（不退回 CLI 全局 profile）", async () => {
    await expect(captureArgs(undefined, ["chat", "list-all-conversations"])).rejects.toMatchObject({
      code: "CHANNEL_IDENTITY_UNAVAILABLE",
      retryable: false,
    })
  })

  /**
   * ★ 但 `auth` 一族要放行 —— 它们是"还没有身份时唯一能做的事"。
   *
   * `auth status` 要回答"这台机器登录了谁"（不钉才问得到），
   * 而 `auth login` 是获得身份的入口。把它们也拒掉会让用户
   * **永远无法授权**（死锁：要身份才能问，要问才能拿到身份）。
   */
  it("★★ auth 一族在没绑身份时仍放行（否则永远授权不了）", async () => {
    const args = await captureArgs(undefined, ["auth", "status"])
    expect(args).not.toContain("--profile")
    expect(args).toContain("status")
  })

  /**
   * ★ 调用方显式指定时不覆盖 —— 那是"我就要问这一个身份"，比默认更具体。
   * 覆盖会让参数里出现两个 `--profile`，而上游取哪个是不确定的。
   */
  it("调用方已显式给 --profile 时不重复注入", async () => {
    const args = await captureArgs(PINNED, [
      "chat",
      "list-all-conversations",
      "--profile",
      "dingFAKECORP0002:FAKEUSER0002",
    ])
    expect(args.filter((a) => a === "--profile")).toHaveLength(1)
    expect(args[args.indexOf("--profile") + 1]).toBe("dingFAKECORP0002:FAKEUSER0002")
  })

  /**
   * ★ 追加 `--profile` 不能破坏既有的两件事：`-f json` 与 `-y`。
   * 白名单的 `commandPath()` 遇到第一个 `-` 就停，所以命令匹配不受影响 ——
   * 这条断言就是钉住那个前提。
   */
  it("与 -f json / -y 的注入共存（白名单仍放行、仍自动确认）", async () => {
    const args = await captureArgs(PINNED, ["chat", "list-all-conversations"])
    expect(args.slice(0, 2)).toEqual(["chat", "list-all-conversations"])
    expect(args).toContain("-f")
    expect(args).toContain("-y")
    expect(args).toContain("--profile")
  })
})

// ---------------------------------------------------------------
// 路径 ③：DingTalkAuth（授权状态）—— 曾经绕过白名单门禁的那条路
// ---------------------------------------------------------------

describe("DingTalkAuth 钉住身份", () => {
  const authWith = (profile: string | undefined, onArgs: (args: string[]) => void) =>
    new DingTalkAuth({
      runtime: stubResolve(runtimeWith(profile)),
      processes: {
        exec: async (input: { args: string[] }) => {
          onArgs(input.args)
          return {
            exitCode: 0,
            stdout: JSON.stringify({ success: true, authenticated: false }),
            stderr: "",
            timedOut: false,
          }
        },
      } as never,
      logger: NOOP_LOGGER as never,
      openExternal: async () => {},
    })

  /**
   * ★★ 这一条与 `DwsCli` 那条是**两个不同的实现路径**，不是重复断言。
   * 漏了它的表现：会话列表按绑定身份读，而卡片上的组织名按全局 profile 显示。
   */
  it("auth status 带上 --profile（这条路径不经 DwsCli）", async () => {
    let seen: string[] = []
    await authWith(PINNED, (args) => {
      seen = args
    }).status()
    expect(seen).toContain("--profile")
    expect(seen[seen.indexOf("--profile") + 1]).toBe(PINNED)
  })

  it("没绑身份时不带 --profile", async () => {
    let seen: string[] = []
    await authWith(undefined, (args) => {
      seen = args
    }).status()
    expect(seen).not.toContain("--profile")
  })
})

// ---------------------------------------------------------------
// 路径 ④：DingTalkEventConsumer（长连接 + 订阅审计 + 停订阅）
// ---------------------------------------------------------------

describe("DingTalkEventConsumer 钉住身份", () => {
  const consumerWith = (
    profile: string | undefined,
    processes: Record<string, unknown>,
  ): DingTalkEventConsumer =>
    new DingTalkEventConsumer({
      runtime: stubResolve(runtimeWith(profile)),
      processes: processes as never,
      logger: NOOP_LOGGER as never,
      clock: { now: () => 0 } as never,
      onSignal: () => {},
    })

  /**
   * ★ 长连接不钉的后果：订阅的是**另一个身份**的消息 —— 数字人被别的组织的
   * 「@我」唤醒，而库里那个会话根本不存在（定向补拉一路失败，看起来像网络问题）。
   */
  it("event consume 长连接带上 --profile", () => {
    let seen: string[] = []
    const consumer = consumerWith(PINNED, {
      spawnDuplex: (input: { args: string[]; onExit?: (info: unknown) => void }) => {
        seen = input.args
        return fakeDuplex(input)
      },
    })
    consumer.start()
    expect(seen).toContain("--profile")
    expect(seen[seen.indexOf("--profile") + 1]).toBe(PINNED)
    consumer.stop()
  })

  /**
   * ★★ `event stop --all` 尤其不能漏：它停的是"这个身份的全部订阅"。
   * 不钉的话切身份时可能停掉**另一个身份**的订阅（甚至是用户自己终端里
   * 正在用的那个），而这个方法整段吞异常 —— 停错了人不会有任何痕迹。
   */
  it("event stop --all 带上 --profile（吞异常路径，漏了不会有痕迹）", async () => {
    const calls: string[][] = []
    const consumer = consumerWith(PINNED, {
      spawnDuplex: (input: { onExit?: (info: unknown) => void }) => fakeDuplex(input),
      exec: async (input: { args: string[] }) => {
        calls.push(input.args)
        return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false }
      },
    })
    consumer.start()
    await consumer.stop()

    const stopCall = calls.find((args) => args.includes("stop"))
    expect(stopCall).toBeDefined()
    expect(stopCall).toContain("--profile")
  })

  it("订阅审计带上 --profile（否则看的是别人订了什么）", async () => {
    const calls: string[][] = []
    const consumer = consumerWith(PINNED, {
      exec: async (input: { args: string[] }) => {
        calls.push(input.args)
        return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false }
      },
    })
    await consumer.audit()

    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).toContain("--profile")
  })
})
