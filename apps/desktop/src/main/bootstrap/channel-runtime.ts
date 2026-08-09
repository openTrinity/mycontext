/**
 * 渠道运行时注册表 —— **「渠道」从可选参数变成拿到实例的前提**。
 *
 * ## ★★★ 为什么需要这一层
 *
 * 这一轮修了 12 个 bug，其中 **9 个是同一个形状**：某个上下文（channelId）
 * 在多层传递中丢了一环，而丢的那一环没有任何信号。逐个看会发现它们都长在
 * 同两个前提上：
 *
 * ### 前提 A：主渠道与非主渠道走两套代码路径
 *
 * · 主渠道：`feed` / `klServer` / `graphQuery` 是**应用级单例**
 *   （`startup.ts` 里那三个 `new`），切 vault 时 `rebind()` 换目录；
 * · 非主渠道：由 `ChannelPipelineManager` 在登录后**每次新建一套**。
 *
 * 于是每加一个动作都要在两处各写一遍，漏一处就是一次静默错位。已发生的：
 * `mountedSourceVaults` 从没 `.set()`（飞书 kl 整条路径是死链）、
 * `applyPostAuthIdentity` 没传渠道（身份写到主渠道表上）、
 * 启动时只给主渠道 `ensureReady`（飞书恒「未启动」）、
 * `onScopeChanged` 无参（保存飞书的范围删掉了钉钉的图）、
 * `list()`/`applyScopeChange()` 恒读主库。
 *
 * ### 前提 B：「顶层字段就是主渠道」这个假设散落各处
 *
 * `MultiKlServerService.status()` 返回 `{...primary, perChannel}`。
 * 于是任何"顶层 + 选中渠道"的组合都会拼出一张假卡 —— 实测出现过
 * 「飞书 · 就绪 · 8200」（标签飞书、端口是主渠道的）。
 *
 * ## 这一层怎么拆掉那两个前提
 *
 * **主渠道也是一条 runtime。** 它不再是"那个特殊的、用顶层字段代表的"渠道，
 * 而是 `all()` 里的第一条。想拿它的 kl 就 `require("dingtalk").klServer` ——
 * 与拿飞书的写法**一模一样**。
 *
 * **`require()` 拿不到就抛。** 这是核心不变式：静默落回主渠道曾经造成
 * 删错渠道的图、写错渠道的库。宁可让 UI 显示一个错误 —— 那时用户会重试或
 * 报告，而静默做错没有任何信号。
 *
 * ## ★ 它**不**负责创建
 *
 * 主渠道那三个服务仍是单例 + rebind（`klServer` 的单例语义被 `reclaimOrphan`
 * 认领孤儿进程、`dispose` 的关停顺序依赖），非主渠道仍由
 * `ChannelPipelineManager` 每次新建。这一层只**持有引用并按 channelId 索引**。
 * 改成"统一由 registry 创建"要牵动进程管理，风险远超收益。
 */
import { AppError } from "@mycontext/kernel"
import type { SqliteDatabase } from "@mycontext/store"
import type { ChannelPlugin } from "@mycontext/channels"
import type { FeedDirs, FeedService } from "../services/feed.service.js"
import type { KlServerService } from "../services/kl-server.service.js"
import type { GraphQueryService } from "../services/graph-query.service.js"

/**
 * 一个渠道的**完整**运行时。
 *
 * ★ 字段与 `MountedChannelPipeline.parts` 一致（那已经是对的形状），
 * 区别只是主渠道现在也被装进来。
 */
export interface ChannelRuntime {
  readonly channelId: string
  /** 这个渠道的插件（自带它的 CLI 与能力集）。 */
  readonly plugin: ChannelPlugin
  /** 它自己的物理库。主渠道是 vault 的 `core.sqlite`，其余在 `sources/<id>/`。 */
  readonly db: SqliteDatabase
  readonly dbPath: string
  /** 导出 / 图谱 / handoff 的落点（见 `VaultStore.sourceRoot`）。 */
  readonly feedDirs: FeedDirs
  readonly feed: FeedService
  readonly klServer: KlServerService
  readonly graphQuery: GraphQueryService
  /**
   * 数字人 / 蒸馏 / 画像只在这个渠道上工作吗。
   *
   * ## ★ 为什么收进这里
   *
   * 这个判据现在有**三份**：渲染层写死一个常量
   * （`use-dashboard-scope.ts` 的 `PERSONA_SUPPORTED_CHANNEL`）、
   * 主进程侧到处判 `channelId !== dingtalk.meta.id`、
   * 以及 `onScopeChanged` 里那句"蒸馏只在主渠道跑"。
   *
   * 三份判据总会分叉，而分叉的那一头就是"某个渠道意外进了画像"
   * 或"某个渠道的功能莫名不可用"。收成一个字段之后，将来某渠道要开数字人
   * 只改一处。
   */
  readonly personaSupported: boolean
}

export interface ChannelRuntimeRegistryOptions {
  /** 主渠道 id —— `primary()` 与 `personaSupported` 的判据。 */
  primaryChannelId: string
  /**
   * 当前挂着的全部 runtime。**函数**：非主渠道的那些由
   * `ChannelPipelineManager` 在登录后才现造，而这个注册表在装配阶段就构造好。
   * 传数组的话它永远是空的（那正是 `MultiKlServerService` 踩过的坑）。
   */
  runtimes: () => readonly ChannelRuntime[]
}

export class ChannelRuntimeRegistry {
  constructor(private readonly options: ChannelRuntimeRegistryOptions) {}

  /** 当前挂着的全部渠道（含主渠道）。顺序：主渠道在前。 */
  all(): readonly ChannelRuntime[] {
    return this.options.runtimes()
  }

  /**
   * 找一个渠道。拿不到返回 `null` —— 调用方**必须显式处理**那种情况。
   *
   * ★ 与 `require()` 分开：有些路径上"这个渠道还没挂"是正常的
   * （刚授权、正在挂载中），那时该降级而不是抛。
   */
  find(channelId: string): ChannelRuntime | null {
    return this.all().find((item) => item.channelId === channelId) ?? null
  }

  /**
   * 取一个渠道，**拿不到就抛**。
   *
   * ## ★★★ 这是整个重构的核心不变式
   *
   * 抛而不是落回主渠道 —— 后者曾经造成：
   * · 保存飞书的范围**删掉了钉钉的图**（`onScopeChanged` 无参）；
   * · 在飞书那栏保存**清空了钉钉的会话白名单**（`save()` 恒写主库）；
   * · 切到飞书显示的是**钉钉的**事实与关系（`facts()`/`ego()` 静默落回）。
   *
   * 三次都是"不报错、只是做错了对象"，而那类问题只能靠人肉发现。
   * 抛出来的话最坏是 UI 上一条错误横幅 —— 用户会重试或报告。
   */
  require(channelId: string): ChannelRuntime {
    const found = this.find(channelId)
    if (found === null) {
      throw new AppError("CHANNEL_NOT_READY", `渠道未就绪：${channelId}`, {
        /**
         * ★ 用 `byCode` 那条已有文案（「渠道尚未就绪，请先登录后重试」）——
         * 不新增 key：`errors:channel.*` 那一段是**授权流程**的文案，
         * 而这里说的是"管线还没挂上"，两者混在一起会让用户去点重新授权。
         */
        messageKey: "errors:byCode.CHANNEL_NOT_READY",
        // ★ context 里带上"当前挂了哪些" —— 排查时第一个要问的就是这个
        context: { channelId, mounted: this.all().map((item) => item.channelId) },
      })
    }
    return found
  }

  /**
   * 主渠道那条。
   *
   * ★ 它**必须存在** —— 主渠道的服务是应用级单例，只要 vault 挂上了它就在。
   * 拿不到说明装配漏了，那是个编程错误而不是运行时状态，所以走 `require`。
   */
  primary(): ChannelRuntime {
    return this.require(this.options.primaryChannelId)
  }

  /**
   * 数字人 / 蒸馏支持的那条（当前 = 主渠道）。
   *
   * ★ 单独一个方法而不是让调用方 `primary()`：两者今天同值，但语义不同。
   * "画像该蒸哪个渠道的语料"问的是能力，不是"谁是主渠道" ——
   * 将来第二个渠道开数字人时，改这里而不是把所有 `primary()` 调用点重读一遍。
   */
  personaHosts(): readonly ChannelRuntime[] {
    return this.all().filter((item) => item.personaSupported)
  }
}
