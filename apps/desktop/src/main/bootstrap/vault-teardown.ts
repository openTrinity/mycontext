/**
 * 卸载当前 vault 的**顺序**。
 *
 * ## ★★ 为什么单独一个文件，而不是留在 `startup.ts` 的闭包里
 *
 * 它原来是 `bootstrapApp()` 里一个 35 行的内联闭包，捕获了十来个上层单例。
 * 那个位置**没法写测试** —— 要测它就得把整个 `bootstrapApp()` 跑起来
 * （Electron app、真实 vault、迁移、python env…）。与 `post-auth-identity.ts`
 * 当初被提取的理由完全一样。
 *
 * 而这段编排恰恰是**必须**有回归门禁的那一类：它的失效方式全是静默的。
 * 下面每一步都对应一个已实测的坑，而"顺序错了"在界面上看不出来 ——
 * 只会让切身份之后某一块仍在按上一个身份工作。
 *
 * ## 顺序（每一步的 why 见 `teardownVault` 的实现）
 *
 * ```
 * ① agent（search）—— 撤 token + kill opencode，再放开 db
 * ② media / distill / persona —— 都持定时器且会写库
 * ③ ★ await klServer.stop() —— 必须 await：让出 8200 + 写掉 pidfile
 * ④ ★ await dataPlane.detach() —— 等在途那一轮采集收尾
 * ⑤ 最后才清身份与路径引用，再关库
 * ```
 */
import type { Logger } from "@mycontext/kernel"

/**
 * 卸载需要的能力，**按行为**声明而不是收整个 service。
 *
 * 用结构类型（只列真正调到的方法）而不是具体类：一是测试里造假依赖不必
 * 实现几十个无关方法，二是这段代码到底依赖什么在签名里就看得见 ——
 * 收整个 service 的话，"它可能碰任何东西"。
 */
export interface VaultTeardownDeps {
  /** 引导状态的仓储绑定（纯内存，传 null 解绑） */
  onboarding: { bind(settings: null, progress: null): void }
  distillSources: { detach(): void }
  /**
   * 搜索 agent。
   *
   * `shutdown()` 撤 MCP token 并 kill opencode 子进程（无孤儿），
   * `detach()` 才放开 db —— 两者**必须按这个顺序**：反过来的话
   * 换库期间旧 agent 还活着，而它手里那个 db 句柄已经不该用了。
   */
  search: { shutdown(): Promise<unknown>; detach(): void }
  media: { detach(): void }
  distill: { detach(): Promise<unknown> }
  persona: { detach(): Promise<unknown> }
  /**
   * 图谱服务子进程。
   *
   * ## ★★ 为什么必须 await 它
   *
   * kl 绑固定端口 8200，pidfile 放在它的 dataDir 下。登出时不等无所谓
   * （后面没人再起），但**切身份**时新 vault 会立刻起一个：新目录里没有
   * pidfile → 探到旧进程还活着 → 判成"用户手工起的外部进程" →
   * `adopted=true` → 建图直接报错；而 adopt 成功的分支更糟 ——
   * 那个进程的 `KL_DATA_DIR` 指着**旧身份的图库**，新身份查到的是上一个
   * 人的知识。这正是 `KL_PIDFILE_NAME` 注释里记的那个坑换了个入口。
   */
  klServer: { stop(): Promise<unknown> }
  /**
   * 非主渠道的采集管线。
   *
   * ★ 在**关库之前**卸载：每条管线的 `dispose` 要 await 停自己的 kl
   * （`KL_DATA_DIR` 指着这个 vault）并 detach 它的 FeedService，而后者写库。
   * 顺序反了就是往已关闭的连接上写，而那条错误没人 catch。
   *
   * 可选：测试里的假依赖不必实现它。
   */
  channelPipelines?: { unmount(): Promise<void> }
  /**
   * 数据面（采集 + 事件长连 + Feed）。
   *
   * `detach()` 会等在途的那一轮采集收尾（它可能正 await 一个 0.6s 的
   * 渠道子进程）。不等就关库会抛无人 catch 的
   * `The database connection is not open`（实测 logout 时稳定复现）。
   */
  dataPlane: { detach(): Promise<unknown> }
  /**
   * 清掉"当前是谁 / 当前用哪套路径"的引用，然后关库。
   *
   * ## ★★ 为什么它必须在 `dataPlane.detach()` **之后**
   *
   * `detach()` → `eventStream.stop()` → `unsubscribeAll()` →
   * `dws event stop --all --profile <X>`，而那个 `<X>` 来自身份 getter。
   * 先清的话退订命令不带 profile，按渠道 CLI 的全局 profile 退订 ——
   * 可能停掉**另一个身份**的订阅（甚至用户自己终端里正在用的那个）。
   * 而 `unsubscribeAll` 整段吞异常（退出路径不该抛）→ **停错了不会有
   * 任何痕迹**。
   */
  releaseVault(): void
  logger: Pick<Logger, "warn" | "error">
}

/**
 * 按顺序卸载，**不抛**。
 *
 * 每一步失败都记日志并继续：卸载失败而不关库等于"登出后数据仍可读"，
 * 那比丢一条错误日志严重得多。
 */
export async function teardownVault(deps: VaultTeardownDeps): Promise<void> {
  deps.onboarding.bind(null, null)
  deps.distillSources.detach()

  // ① agent：先撤 token + kill 进程，再放开 db
  await deps.search
    .shutdown()
    .catch((error: unknown) => {
      deps.logger.warn("search shutdown failed", { detail: describe(error) })
    })
    .finally(() => {
      deps.search.detach()
    })
  deps.media.detach()

  // ② 两个持定时器且会写库的
  await deps.distill.detach().catch((error: unknown) => {
    deps.logger.warn("distill detach failed", { detail: describe(error) })
  })
  await deps.persona.detach().catch((error: unknown) => {
    deps.logger.warn("persona detach failed", { detail: describe(error) })
  })

  // ③ ★ await：让出 8200 并写掉 pidfile（见 `klServer` 的注释）
  await deps.klServer.stop().catch((error: unknown) => {
    deps.logger.warn("kl server stop failed", { detail: describe(error) })
  })

  // ④ ★ await：等在途那一轮采集收尾（见 `dataPlane` 的注释）
  await deps.dataPlane.detach().catch((error: unknown) => {
    deps.logger.error("data plane detach failed", { detail: describe(error) })
  })

  /**
   * ⑤ 非主渠道的管线（各自的 kl + feed）。
   *
   * 在 ④ 之后：`dataPlane.detach()` 会 stop 它们的 `IngestService`，
   * 而那些采集轮次会往 source 库写 —— 先拆管线的话 feed 已经 detach 了，
   * 但采集还在跑，于是那一轮的导出触发落到一个已 detach 的 FeedService 上。
   *
   * 在 ⑥ 之前：`vaults.closeAll()` 会关掉 source 库句柄，而管线的
   * `dispose` 要 detach feed（写库）。
   */
  if (deps.channelPipelines !== undefined) {
    await deps.channelPipelines.unmount().catch((error: unknown) => {
      deps.logger.error("channel pipelines unmount failed", { detail: describe(error) })
    })
  }

  // ⑥ 到这里才清：④ 里的退订要用**旧**身份的 profile（见 `releaseVault`）
  deps.releaseVault()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
