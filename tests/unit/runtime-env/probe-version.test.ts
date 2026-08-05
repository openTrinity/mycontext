/**
 * `probeBinaryVersion` 的行为断言 —— 用**真脚本**而不是 mock。
 *
 * ## 为什么必须用真进程
 *
 * 这个函数的全部风险都在**时序**上：超时判定、超时后重试、以及"慢但能出结果"
 * 的那一档。把 `spawnSync` mock 掉之后，测的就只是我们自己写的 if/else，
 * 而真实故障恰恰出在"Node 超时时 `error.code`/`signal` 长什么样"这类
 * 我们不能凭记忆断言的细节上。
 *
 * 所以这里造几个 shell 脚本当被测二进制：能精确控制"睡多久""打到哪个流"
 * "退出码是几"，而且跑得快（毫秒级 sleep）。
 *
 * ## 背景：这个函数为什么会有重试
 *
 * 那个 agent 二进制 132MB，macOS 首次执行要全量校验代码签名（企业机上还有
 * 杀毒钩子）。同一台机器实测：**冷** 2384/2496/2530/3621ms，**热** 263/275/278ms。
 * 原来 5s 的超时恰好落在冷启动临界区，超时后上层报"版本读不出来"→ 整个
 * agent 路径降级。而被 SIGTERM 杀掉之后紧接着重试只要 **266ms**（页已进缓存）
 * —— 超时那次自己付了预热的代价，所以重试几乎免费。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PROBE_TIMEOUT_MS, probeBinaryVersion } from "@mycontext/runtime-env"

/**
 * 测试用的短超时。
 *
 * 真实上限是 30s（见 `PROBE_TIMEOUT_MS` 的注释），但"两次都超时"那条用例
 * 会真等 2×30s —— 一个文件跑 90 秒，没人会愿意在本地跑全量。
 * 超时逻辑与具体秒数无关（都是 `spawnSync` 的同一个 `timeout` 选项），
 * 所以这里用 800ms 跑同样的分支，另有一条用例单独钉住生产默认值。
 */
const T = 800

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

/** 造一个可执行的 sh 脚本，返回它的绝对路径。 */
function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-probe-"))
  dirs.push(dir)
  const path = join(dir, "fake-bin")
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe("probeBinaryVersion · 正常路径", () => {
  it("读 stdout", () => {
    expect(probeBinaryVersion(script("echo 1.18.11"))).toBe("1.18.11")
  })

  it("stdout 空但 stderr 有内容 → 用 stderr（有些工具把版本打到 stderr）", () => {
    expect(probeBinaryVersion(script("echo 1.2.23 >&2"))).toBe("1.2.23")
  })

  it("两个流都空 → null", () => {
    expect(probeBinaryVersion(script("exit 0"))).toBeNull()
  })

  it("非零退出但有 stdout → 仍然用它（版本号已经拿到了）", () => {
    expect(probeBinaryVersion(script("echo 1.18.11; exit 1"))).toBe("1.18.11")
  })

  it("文件不存在 → null（不抛）", () => {
    expect(probeBinaryVersion("/nonexistent/definitely-not-here")).toBeNull()
  })
})

describe("★ probeBinaryVersion · 慢启动（真实故障的回归）", () => {
  /**
   * ★ 核心用例：**慢但能出结果**的二进制必须被读出来，不能判成"读不出"。
   *
   * 1.2s 远超原来那种"几百毫秒就该返回"的直觉，但远低于新的 30s 上限 ——
   * 正好落在"旧实现会误判、新实现该成功"之间。真机上冷启动是 2.4–3.6s，
   * 这里用 1.2s 是为了让测试跑得快，量级关系不变。
   */
  it("慢启动的二进制照样读得出来（冷启动实测 2.4–3.6s）", () => {
    const started = Date.now()
    // 500ms：远超"几百毫秒就该返回"的直觉、又低于上限 —— 正是旧实现会误判、
    // 新实现该成功的那一档。真机冷启动 2.4–3.6s，量级关系相同。
    const raw = probeBinaryVersion(script("sleep 0.5; echo 1.18.11"), T)
    expect(raw).toBe("1.18.11")
    // 反证：确认它真的等了（而不是恰好走了别的分支返回了字符串）
    expect(Date.now() - started).toBeGreaterThan(400)
  })

  /**
   * ★ 生产默认值单独钉一次。
   *
   * 上面几条用 800ms 跑分支逻辑，那就必须另有一条守住"生产上到底给多久" ——
   * 否则有人把默认值改回 5s，超时那几条仍然全绿（它们传的是自己的 T）。
   * 5s 恰好落在冷启动临界区，那正是本文件要防的故障。
   */
  it("生产默认超时远高于实测冷启动上限（3.6s）", () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000)
  })

  /**
   * ★ 超时重试：第一次超时、第二次成功 —— 与真机的形态一致
   * （首次被 SIGTERM 杀掉，重试时页已在缓存里，266ms 就回来了）。
   *
   * 用一个 marker 文件模拟"第一次慢、第二次快"：脚本第一次跑时睡很久，
   * 留下 marker；第二次看到 marker 就立刻返回。这样断言的是**真的重试了**，
   * 而不是我们读了某个内部计数器。
   */
  it("首次超时 → 重试一次；重试快了就拿到结果", () => {
    const dir = mkdtempSync(join(tmpdir(), "mycontext-probe-retry-"))
    dirs.push(dir)
    const marker = join(dir, "warmed")
    const path = join(dir, "fake-bin")
    // 第一次：睡到超时并留下 marker。第二次：立刻输出。
    writeFileSync(
      path,
      `#!/bin/sh\nif [ -f "${marker}" ]; then echo 1.18.11; exit 0; fi\ntouch "${marker}"\nsleep 30\n`,
    )
    chmodSync(path, 0o755)

    const raw = probeBinaryVersion(path, T)
    expect(raw).toBe("1.18.11")
  }, 20_000)

  /**
   * ★ 反证：重试**只有一次**，不是无限重试。
   *
   * 一个永远超时的二进制必须最终返回 null（让上层明确降级），而不是把启动
   * 拖到无限。否则"探测"就从一道闸变成了一个挂起点。
   */
  it("一直超时 → 重试一次后返回 null（不无限等）", () => {
    const started = Date.now()
    const raw = probeBinaryVersion(script("sleep 30"), T)
    expect(raw).toBeNull()
    // 反证：真的试了**两次**（≈2×T），而不是一次就放弃、也不是无限重试。
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThan(T * 2 * 0.8)
    expect(elapsed).toBeLessThan(T * 4)
  }, 20_000)

  /**
   * ★ 非超时失败**不**重试 —— 重试一个 `ENOENT` 只是把同样的失败做两遍，
   * 白等一轮。这条锁住"重试的触发条件是超时，而不是任何失败"。
   */
  it("非超时失败不重试（第二次跑会留下痕迹，这里断言没有）", () => {
    const dir = mkdtempSync(join(tmpdir(), "mycontext-probe-once-"))
    dirs.push(dir)
    const counter = join(dir, "runs")
    const path = join(dir, "fake-bin")
    // 每次运行 append 一行，然后什么都不输出、正常退出（= 失败但非超时）。
    writeFileSync(path, `#!/bin/sh\necho x >> "${counter}"\nexit 0\n`)
    chmodSync(path, 0o755)

    expect(probeBinaryVersion(path)).toBeNull()
    // 只跑了一次 → 文件里只有一行
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1)
  })
})
