/**
 * 卸载 vault 的**顺序**。
 *
 * ## 这一组锁的是三条"错了也看不出来"的顺序
 *
 * ① ★★ **身份/路径引用最后才清**。数据面 detach 时会跑
 *    `event stop --all --profile <旧身份>`，那个 profile 来自身份 getter。
 *    先清的话按渠道 CLI 的全局 profile 退订 —— 可能停掉另一个身份的订阅
 *    （甚至用户自己终端里正在用的那个）。而那条路径整段吞异常
 *    （退出路径不该抛）→ **停错了不会有任何痕迹**。
 *
 * ② ★★ **图谱服务必须 await 停掉**。它绑固定端口 8200、pidfile 在 dataDir 下。
 *    不等就挂新 vault 的话：新目录没有 pidfile → 探到旧进程还活着 →
 *    判成"外部进程" → 建图报错；adopt 成功的分支更糟（那个进程的
 *    KL_DATA_DIR 指着旧身份的图库，新身份查到上一个人的知识）。
 *
 * ③ **agent 先 shutdown 再 detach**。反过来的话换库期间旧 agent 还活着，
 *    而它手里那个 db 句柄已经不该用了。
 *
 * 而且**每一步失败都不能中断后面的**：卸载没走完就关库等于"登出后数据
 * 仍可读"，那比丢一条错误日志严重得多。
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "@mycontext/kernel"
import { teardownVault, type VaultTeardownDeps } from "@main/bootstrap/vault-teardown.js"

const logger = createLogger("test-teardown", { level: "error" })

/**
 * 造一套记录调用顺序的假依赖。
 *
 * `failures` 指定哪几步抛错 —— 用来验"一步失败不中断后面的"。
 */
function makeDeps(options: { failures?: readonly string[] } = {}) {
  const order: string[] = []
  const failures = new Set(options.failures ?? [])
  const step = (name: string) => {
    order.push(name)
    if (failures.has(name)) throw new Error(`${name} 故意失败`)
  }
  const asyncStep = async (name: string) => {
    order.push(name)
    // 真的让出一次事件循环：同步 resolve 会让"忘了 await"也碰巧顺序正确
    await Promise.resolve()
    if (failures.has(name)) throw new Error(`${name} 故意失败`)
  }

  const deps: VaultTeardownDeps = {
    onboarding: { bind: () => step("onboarding.bind") },
    distillSources: { detach: () => step("distillSources.detach") },
    search: {
      shutdown: () => asyncStep("search.shutdown"),
      detach: () => step("search.detach"),
    },
    media: { detach: () => step("media.detach") },
    distill: { detach: () => asyncStep("distill.detach") },
    persona: { detach: () => asyncStep("persona.detach") },
    klServer: { stop: () => asyncStep("klServer.stop") },
    dataPlane: { detach: () => asyncStep("dataPlane.detach") },
    releaseVault: () => step("releaseVault"),
    logger,
  }
  return { deps, order }
}

describe("★★ 卸载顺序", () => {
  /**
   * ★★ 这条是本组最重要的：`releaseVault`（清身份 + 关库）必须是**最后一步**。
   *
   * 它前面那步 `dataPlane.detach()` 会用**旧**身份去退订事件。
   * 顺序反了就退订错人，而那条路径吞异常 —— 没有任何痕迹。
   */
  it("★★ releaseVault 在 dataPlane.detach 之后（否则会退订错身份）", async () => {
    const { deps, order } = makeDeps()
    await teardownVault(deps)
    expect(order.indexOf("releaseVault")).toBeGreaterThan(order.indexOf("dataPlane.detach"))
    // 而且它就是最后一步（后面不该再有任何动作）
    expect(order.at(-1)).toBe("releaseVault")
  })

  /**
   * ★★ 图谱服务必须**真的被等到停**，不能 fire-and-forget。
   *
   * ## 断言形式很重要（首版这条是假绿）
   *
   * 首版只断言 `klServer.stop` 出现在 `releaseVault` 之前 —— 而把
   * `await` 改成 `void` 之后那个顺序**依然成立**（同步部分照样先跑），
   * 于是测试全绿。等于没锁。
   *
   * 现在让 `stop()` 在**真异步**之后才标记完成，并断言那个完成标记出现在
   * 序列里。`void` 掉的话它落在 `releaseVault` 之后（甚至根本没进来），
   * 而那正是那条竞态的形态：新 vault 的 kl 起来时 8200 还被旧进程占着。
   */
  it("★★ klServer.stop 真的被 await（fire-and-forget 会红）", async () => {
    const order: string[] = []
    const deps: VaultTeardownDeps = {
      onboarding: { bind: () => order.push("onboarding.bind") },
      distillSources: { detach: () => order.push("distillSources.detach") },
      search: {
        shutdown: () => Promise.resolve(order.push("search.shutdown")),
        detach: () => order.push("search.detach"),
      },
      media: { detach: () => order.push("media.detach") },
      distill: { detach: () => Promise.resolve(order.push("distill.detach")) },
      persona: { detach: () => Promise.resolve(order.push("persona.detach")) },
      klServer: {
        // ★ 跨两个微任务再落"停好了" —— void 掉的话它会排到 releaseVault 之后
        stop: async () => {
          await Promise.resolve()
          await Promise.resolve()
          order.push("klServer.stopped")
        },
      },
      dataPlane: { detach: () => Promise.resolve(order.push("dataPlane.detach")) },
      releaseVault: () => order.push("releaseVault"),
      logger,
    }
    await teardownVault(deps)

    expect(order).toContain("klServer.stopped")
    // ★ 关键：端口必须在关库/挂新库之前真的让出来
    expect(order.indexOf("klServer.stopped")).toBeLessThan(order.indexOf("releaseVault"))
    // 也必须在数据面之前（那是设计的顺序）
    expect(order.indexOf("klServer.stopped")).toBeLessThan(order.indexOf("dataPlane.detach"))
  })

  /** ★ agent：先 shutdown（kill 进程）再 detach（放开 db）。 */
  it("★ search.shutdown 在 search.detach 之前", async () => {
    const { deps, order } = makeDeps()
    await teardownVault(deps)
    expect(order.indexOf("search.shutdown")).toBeLessThan(order.indexOf("search.detach"))
  })

  it("完整顺序与设计一致", async () => {
    const { deps, order } = makeDeps()
    await teardownVault(deps)
    expect(order).toEqual([
      "onboarding.bind",
      "distillSources.detach",
      "search.shutdown",
      "search.detach",
      "media.detach",
      "distill.detach",
      "persona.detach",
      "klServer.stop",
      "dataPlane.detach",
      "releaseVault",
    ])
  })
})

describe("★★ 任何一步失败都不中断后面的", () => {
  /**
   * ## 为什么这条比"记下错误"重要
   *
   * 卸载没走完就关库 = "登出后数据仍可读"。而这些步骤全在等外部世界
   * （子进程、长连接、在途采集），任一步失败都是常态而不是异常。
   *
   * ★ 逐个失败都验一遍：只验一步的话，某个 catch 漏了照样绿。
   */
  it.each([
    ["search.shutdown"],
    ["distill.detach"],
    ["persona.detach"],
    ["klServer.stop"],
    ["dataPlane.detach"],
  ])("%s 失败 → 后面的步骤仍然全跑完，且最终关库", async (failing) => {
    const { deps, order } = makeDeps({ failures: [failing] })
    await expect(teardownVault(deps)).resolves.toBeUndefined()
    // ★ 关库这一步必须发生 —— 不关等于登出后账号数据仍可读
    expect(order).toContain("releaseVault")
    expect(order.at(-1)).toBe("releaseVault")
  })

  /**
   * ★ 即使 search 的 shutdown 抛了，`detach()` 仍要跑
   * （那是 `.finally` 的职责）—— 不跑的话它会一直攥着一个即将关闭的 db。
   */
  it("★ search.shutdown 抛错时 search.detach 仍然跑（.finally）", async () => {
    const { deps, order } = makeDeps({ failures: ["search.shutdown"] })
    await teardownVault(deps)
    expect(order).toContain("search.detach")
  })

  it("多步同时失败也能走完", async () => {
    const { deps, order } = makeDeps({
      failures: ["search.shutdown", "klServer.stop", "dataPlane.detach"],
    })
    await expect(teardownVault(deps)).resolves.toBeUndefined()
    expect(order.at(-1)).toBe("releaseVault")
  })
})
