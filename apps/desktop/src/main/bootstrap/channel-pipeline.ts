/**
 * 渠道采集管线的挂载表。
 *
 * ## ★★ 为什么需要这一层（而不是在 bootstrap 里各渠道各写一份）
 *
 * 一条渠道的采集管线由三个服务组成：`FeedService`（导出四件套）、
 * `KlServerService`（kl 子进程 supervisor）、`GraphQueryService`（图库只读查询）。
 * 三者都需要**按 vault 分**的路径与一个**独占的端口**，而 bootstrap 遍历
 * registry 装配服务时 vault 还没挂载 —— 那一刻既不知道 vaultId，
 * 也不知道用户到底连了哪几个渠道。
 *
 * 改动前的形态是「构造时给空串占位、挂载时 rebind」。主渠道那样做还成立
 * （它只有一个、rebind 有人调），但复制到第二个渠道就断了：实测飞书那三个
 * 服务全部拿着空串构造，而**没有任何一处 rebind** —— 于是
 * · kl 的 `KL_DATA_DIR` 是空的；
 * · 图库查询恒走"图不存在"降级；
 * · 判断"要不要起飞书 kl"的那张 `Map` 一次都没被 `set` 过，恒返回 false。
 * 三条一起构成一个**完全静默**的死链：界面显示正常，飞书那一路什么都不做。
 *
 * 所以路径不能在构造时给，得把**构造本身**推到挂载时 —— 这就是本文件。
 *
 * ## 为什么是泛型 + 工厂，而不是在这里 import 那三个服务
 *
 * 「怎么造一条管线」需要整个 bootstrap 闭包（runtimeConfig / paths / logger /
 * Python 环境准备…），搬进来等于把 bootstrap 劈成两半。而**生命周期**
 * （谁在挂着、端口怎么分、失败怎么回滚）与那些细节无关。
 *
 * 于是这里只管生命周期，构造与拆除由调用方给的 `create` 返回的
 * `{ parts, dispose }` 承担。副产品是这一层能被单测覆盖：注入假工厂即可，
 * 不必起 Electron、真 vault、真 Python。
 */
import { createServer } from "node:net"
import { AppError, type Logger } from "@mycontext/kernel"

/** 造一条管线时能知道的全部信息。 */
export interface ChannelPipelineSpec {
  vaultId: string
  channelId: string
  /** 已探测确认空闲、且与同批其他渠道不冲突的 kl 端口 */
  klPort: number
}

/**
 * 一条管线的句柄。
 *
 * `dispose` 由工厂给而不是由本类推断：拆除**有顺序**（先 `await` 停 kl
 * 让出端口与 pidfile，再 detach feed，最后关库），而那个顺序属于
 * "怎么造的"那份知识。放在这里等于让生命周期层去了解每个服务的内部约束。
 *
 * 契约：`dispose` **不抛**（内部自己吞并记日志）。抛了本类也只会记一条
 * 日志继续拆下一条 —— 拆除中途放弃会留下更糟的半挂载状态。
 */
export interface ChannelPipelineHandle<P> {
  parts: P
  dispose: () => Promise<void>
}

export type ChannelPipelineFactory<P> = (
  spec: ChannelPipelineSpec,
) => Promise<ChannelPipelineHandle<P>> | ChannelPipelineHandle<P>

export interface ChannelPipelineManagerOptions<P> {
  logger: Logger
  create: ChannelPipelineFactory<P>
  /**
   * 端口扫描起点。主渠道那个端口（8200）**不在**扫描范围内 ——
   * 它由 bootstrap 固定持有，本类只分配"其余渠道"的。
   */
  basePort: number
  /** 最多往上试几个端口。超了就报错而不是无限扫。 */
  portScanLimit?: number
  /**
   * 端口是否空闲。注入以便测试。
   *
   * ★ 缺省实现是**真的 listen 一下**而不是发 HTTP 探测：我们要问的是
   * "这个端口能不能被我们绑上"，而那与"上面有没有一个健康的服务"是两件事。
   * 用 HTTP 探测的话，被别的**非 HTTP** 程序占着的端口会被判成空闲，
   * 于是 kl 起来时 `EADDRINUSE`，而失败原因落在 Python 的 stderr 里。
   */
  isPortFree?: (port: number) => Promise<boolean>
}

export interface MountedChannelPipeline<P> {
  channelId: string
  klPort: number
  parts: P
}

const DEFAULT_PORT_SCAN_LIMIT = 32

/**
 * 端口空闲探测：真的绑一次再放开。
 *
 * 绑 `127.0.0.1` 而不是 `0.0.0.0`：kl 只监听回环，绑全网卡会把
 * "别的网卡上有人占着" 误判成不可用。
 */
export async function isLocalPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer()
    const done = (free: boolean): void => {
      server.removeAllListeners()
      server.close(() => resolve(free))
    }
    server.once("error", () => {
      // EADDRINUSE / EACCES 都算不可用 —— 原因不重要，我们绑不上就是绑不上
      server.removeAllListeners()
      resolve(false)
    })
    server.once("listening", () => done(true))
    server.listen(port, "127.0.0.1")
  })
}

export class ChannelPipelineManager<P> {
  private mounted: {
    channelId: string
    klPort: number
    handle: ChannelPipelineHandle<P>
  }[] = []
  private currentVaultId: string | null = null
  /**
   * 串行闸。
   *
   * ★ 必需：`mount`（登录）与 `mountOne`（用户在设置页新授权一个渠道）
   * 是两个**独立**的触发源，都可能在对方还没跑完时进来。并发跑的话两条
   * 管线会分到同一个端口（各自探测时那个端口都还空着），而症状是
   * 第二个 kl 起来时 `EADDRINUSE` —— 一个只在"边登录边授权"时出现的竞态。
   */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ChannelPipelineManagerOptions<P>) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    // 前一个任务失败也要继续排队（两个分支都接 task），否则一次挂载失败
    // 会把闸永久卡死 —— 之后所有挂载都静默不执行。
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** 当前挂着的是哪个 vault；null = 没挂载。 */
  vaultId(): string | null {
    return this.currentVaultId
  }

  get(channelId: string): P | null {
    return this.mounted.find((item) => item.channelId === channelId)?.handle.parts ?? null
  }

  portOf(channelId: string): number | null {
    return this.mounted.find((item) => item.channelId === channelId)?.klPort ?? null
  }

  all(): MountedChannelPipeline<P>[] {
    return this.mounted.map((item) => ({
      channelId: item.channelId,
      klPort: item.klPort,
      parts: item.handle.parts,
    }))
  }

  /**
   * 挂载一批渠道（登录 / 切身份走这条）。**幂等地先卸载**。
   *
   * ## ★★ 中途失败必须整批回滚
   *
   * 不回滚的后果不是"少一条管线"，而是**半挂载**：已建好的那条在跑
   * （占着端口、在采集、在导出），而 `vaultId()` 与调用方的判断都以为
   * 这次挂载没成功。于是界面上会出现一个"存在但不该存在"的渠道，
   * 而下一次 `mount` 又会去建它 —— 那时端口已被自己占着。
   *
   * 抛出去而不是吞掉：调用方（bootstrap）用 `.catch` 记 error 日志。
   * 挂载失败不该让登录失败，但必须留痕。
   */
  async mount(vaultId: string, channelIds: readonly string[]): Promise<void> {
    await this.run(async () => {
      await this.disposeAll()
      this.currentVaultId = vaultId
      try {
        for (const channelId of channelIds) await this.createOne(vaultId, channelId)
      } catch (error) {
        this.options.logger.error("channel pipeline mount failed; rolling back", {
          vaultId,
          channelIds: [...channelIds],
          mounted: this.mounted.map((item) => item.channelId),
          detail: error instanceof Error ? error.message : String(error),
        })
        await this.disposeAll()
        this.currentVaultId = null
        throw error
      }
      this.options.logger.info("channel pipelines mounted", {
        vaultId,
        channels: this.mounted.map((item) => ({
          channelId: item.channelId,
          klPort: item.klPort,
        })),
      })
    })
  }

  /**
   * 追加挂载一条（用户在设置页新授权了一个渠道）。
   *
   * 已挂着就直接返回现有的 —— 授权成功事件会重复到达（重新授权同一个渠道），
   * 而重复挂载意味着两条管线往同一个库写、抢同一个端口。
   *
   * 没挂 vault 时**不抛**：那是"还没登录就授权"这条正常路径（授权是没有
   * 身份时唯一能做的事）。返回 null，等登录时的 `mount` 一起建。
   */
  async mountOne(channelId: string): Promise<P | null> {
    return await this.run(async () => {
      const vaultId = this.currentVaultId
      if (vaultId === null) {
        this.options.logger.info("channel pipeline mount deferred (no vault yet)", { channelId })
        return null
      }
      const existing = this.mounted.find((item) => item.channelId === channelId)
      if (existing !== undefined) return existing.handle.parts
      const created = await this.createOne(vaultId, channelId)
      this.options.logger.info("channel pipeline mounted", {
        vaultId,
        channelId,
        klPort: this.portOf(channelId),
      })
      return created
    })
  }

  /** 卸载全部。**不抛** —— 卸载失败而放弃会留下比丢一条日志严重得多的状态。 */
  async unmount(): Promise<void> {
    await this.run(async () => {
      await this.disposeAll()
      this.currentVaultId = null
    })
  }

  private async createOne(vaultId: string, channelId: string): Promise<P> {
    const klPort = await this.allocatePort(channelId)
    const handle = await this.options.create({ vaultId, channelId, klPort })
    this.mounted.push({ channelId, klPort, handle })
    return handle.parts
  }

  private async allocatePort(channelId: string): Promise<number> {
    const isFree = this.options.isPortFree ?? isLocalPortFree
    const limit = this.options.portScanLimit ?? DEFAULT_PORT_SCAN_LIMIT
    const taken = new Set(this.mounted.map((item) => item.klPort))
    for (let offset = 0; offset < limit; offset += 1) {
      const port = this.options.basePort + offset
      // 先排掉本批已分出去的：那些端口上的 kl 可能还在 warmup（还没 listen），
      // 探测会说它空闲 —— 于是两条管线拿到同一个端口。
      if (taken.has(port)) continue
      if (await isFree(port)) return port
    }
    throw new AppError("CHANNEL_PIPELINE_NO_PORT", `没有可用端口：${channelId}`, {
      context: { channelId, basePort: this.options.basePort, limit },
    })
  }

  /**
   * 倒序拆除。
   *
   * 倒序而不是正序：先建的那条更可能被后建的依赖（本类目前没有这种依赖，
   * 但拆除顺序与构造顺序相反是更安全的默认，且免费）。
   *
   * 每条各自 try/catch：一条拆不掉不能让剩下的留在挂载表里 ——
   * 那正是"半挂载"的另一个入口。
   */
  private async disposeAll(): Promise<void> {
    const items = [...this.mounted].reverse()
    this.mounted = []
    for (const item of items) {
      try {
        await item.handle.dispose()
      } catch (error) {
        this.options.logger.error("channel pipeline dispose failed", {
          channelId: item.channelId,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
