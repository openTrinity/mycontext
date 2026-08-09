/**
 * Vault：按账号隔离的业务数据库。
 *
 * 一个账号一个 `vaults/<vaultId>/core.sqlite`。为什么分库而不是在单库里
 * 给每张表挂 accountId：后者要求**每个查询都记得带条件**，漏一处就是跨账号
 * 数据泄漏，而这种漏洞在单账号开发环境下永远不会暴露。分库之后隔离由文件系统
 * 保证——打开的是哪个文件，能看到的就只有那些数据。
 *
 * 删账号也从「逐表清理 + 担心漏表」变成删一个目录。
 *
 * 本阶段不加密、不隔离进程（见 docs/M1c）：
 * 加密的密钥只能来自口令派生（改口令要重包、忘口令等于数据丢失）或钥匙串
 * （本机用户仍能解，边界与现状相同），收益不明确而代价明确。
 * 进程隔离是为「数据库卡死不拖死主进程」设计的，我们现在没有长事务。
 * 两者都可以后加而不改仓储接口。
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { Logger } from "@mycontext/kernel"
import { openStore, type StoreHandle } from "./database.js"
import { VAULT_MIGRATIONS } from "./migrations.js"

export interface VaultStoreOptions {
  /** vaults 根目录，各账号在其下按 vaultId 建子目录 */
  root: string
  logger?: Logger
  now?: () => Date
}

/**
 * 一个 vault 的全部磁盘落点。见 `VaultStore.paths()` 的注释（为什么是一个对象）。
 *
 * 全部字段都是**绝对路径**，且全部在 `root` 之下 —— 那是"删账号 = 删一个目录"
 * 这条收益的前提，也是本类型存在的意义：新增一个落点时，把它加进这里就
 * 自动落在 vault 内，而不会有人再顺手拼一个应用级路径。
 */
export interface VaultPaths {
  /** vault 目录本身 */
  root: string
  /** 业务库 `core.sqlite` */
  database: string
  forgeRoot: string
  skillRoot: string
  /** 图谱数据目录 = 算法团队的 `databaseDir`（注入 `KL_DATA_DIR`） */
  klRoot: string
  /** 四件套导出（注入 `KL_DWS_EXPORT_DIR`） */
  exportRoot: string
  /** `handoff.json`（给算法团队的一页运行时事实） */
  handoffFile: string
  mediaRoot: string
  avatarRoot: string
  uploadRoot: string
  agentWorkspaceRoot: string
  /** agent 子进程的隔离 HOME（不含 npm 缓存，见实现处注释） */
  agentHome: string
  /** 渠道 CLI 的配置目录（身份隔离的主防线，见实现处注释） */
  dwsHome: string
  /**
   * 飞书官方 CLI 的配置/日志/token 根目录。
   *
   * ★ 与 `dwsHome` 同一条理由（身份隔离的主防线），但飞书这条更彻底：
   * 钉钉的 token 由系统钥匙串保管、隔离不了，而 lark-cli 的凭据可以整个
   * 关在这个目录里（见 `LarkCli.env()` 里那套 HOME/XDG 重定向）。
   */
  feishuAuthRoot: string
}

export class VaultStore {
  /** 已打开的句柄。同一个 vaultId 只开一次——重复打开同一文件会各自持有 WAL 状态。 */
  private readonly open = new Map<string, StoreHandle>()

  constructor(private readonly options: VaultStoreOptions) {}

  /** vault 的目录（不含文件名），删除账号时按此目录整体清理。 */
  directory(vaultId: string): string {
    return join(this.options.root, vaultId)
  }

  path(vaultId: string): string {
    return join(this.directory(vaultId), "core.sqlite")
  }

  /**
   * 一个非主渠道的**根目录** —— 它的库、导出、图谱、交接文件全在这下面。
   *
   * ★ 有了这个方法，"一个渠道的东西全在它自己的目录下"这条不变式就有了
   * 单一落点：新增一类产物时在这里派生，而不是各处 `join` 一遍
   * （那正是 `exports/dws/feishu` 那个错误路径的来源）。
   */
  sourceRoot(vaultId: string, channelId: string): string {
    return join(this.directory(vaultId), "sources", channelId)
  }

  /** A physically separate database for one external data source. */
  sourcePath(vaultId: string, channelId: string): string {
    return join(this.sourceRoot(vaultId, channelId), "core.sqlite")
  }

  /**
   * 非主渠道的**导出目录**（喂它自己那个图谱的语料投影）。
   *
   * ## ★★ 为什么不是 `exports/dws/<channelId>`
   *
   * 那是改动前的拼法（`join(vp.exportRoot, channelId)`），而 `vp.exportRoot`
   * 已经是 `exports/dws` —— `dws` 是**主渠道 CLI 的名字**。于是飞书的导出物
   * 落在 `exports/dws/feishu`，读起来像"dws 的飞书子目录"，而两者毫无关系。
   *
   * 更糟的是那个目录下本来是**内容类型**的分层
   * （`exports/dws/chat` / `wiki` / `minutes`），于是一个渠道名和三个内容类型
   * 并列成了兄弟 —— 语义上就是错的，而下一个人按那个布局推断"飞书也是一种
   * 内容类型"会写出更多错位。
   *
   * ★ 现在与 `sourcePath` 同一个命名空间：`sources/<channelId>/…`。
   * 那条惯例的收益是"一个渠道的东西全在它自己的目录下" ——
   * 删一个渠道就是删一个目录，而且不可能与别的渠道互相覆盖。
   */
  sourceExportRoot(vaultId: string, channelId: string): string {
    return join(this.sourceRoot(vaultId, channelId), "exports")
  }

  /**
   * 非主渠道的图谱数据目录。
   *
   * ★ 与 `sourceExportRoot` 同一条理由，收进同一个命名空间。
   * 改动前是 `kl/<channelId>` —— 那个**不算错**（`kl/` 下面本来就没有
   * 内容类型分层，飞书与 `qdrant_data` / `extraction_cache` 并列只是有点乱），
   * 但既然导出那边要归位，两者一起收比留一半更容易理解。
   */
  sourceKlRoot(vaultId: string, channelId: string): string {
    return join(this.sourceRoot(vaultId, channelId), "kl")
  }

  /**
   * 那个渠道的交接文件（给算法团队的一页运行时事实）。
   *
   * ★ 主渠道那份在 vault 根下（`handoff.json`，上游按固定路径读它，
   * 动它要改他们那侧）；非主渠道各自一份，收在自己的目录里。
   * 改动前它是根下的 `handoff.<channelId>.json` —— 与主渠道那份并列，
   * 于是 vault 根随渠道数量长出一堆同名前缀的文件。
   */
  sourceHandoffFile(vaultId: string, channelId: string): string {
    return join(this.sourceRoot(vaultId, channelId), "handoff.json")
  }

  sourceHandle(vaultId: string, channelId: string): StoreHandle {
    return this.handleAt(`${vaultId}:source:${channelId}`, this.sourcePath(vaultId, channelId))
  }

  /**
   * 蒸馏引擎（forge）的工作目录。
   *
   * 放在 vault 目录**内**而不是与之并列：里面的东西全部派生自这个 vault
   * （forge 自己的派生库、features.json、用户手改的 owner 块），
   * vault 删了它们就该一起消失 —— 而「删账号 = 删一个目录」是上面那条
   * 隔离设计的核心收益，多一个需要单独清理的目录就会削弱它。
   */
  forgeRoot(vaultId: string): string {
    return join(this.directory(vaultId), "forge")
  }

  /**
   * 蒸馏产出的 skill 包所在目录。
   *
   * ★ 绝不放 `~/.claude/skills` 或 `~/.codex/skills`。
   *
   * forge 上游的默认值正是那两个位置 —— 对「自己给自己炼画像」是对的，
   * 对本应用完全不成立：那是**运行这台机器的人**的 agent 配置，
   * 应用无权往里写；多账号会打在同一路径上互相覆盖；而且卸载应用
   * 不会带走它。写进 userData 之后，删 vault 即删干净。
   *
   * `publish.py` 侧另有一道 `ownsOutput` 门禁会拒绝那两个目录 ——
   * 两边都设防，因为「记得传对路径」不是可依赖的保证。
   */
  skillRoot(vaultId: string): string {
    return join(this.forgeRoot(vaultId), "skills")
  }

  /**
   * 这个 vault 的**全部**磁盘落点，一次给齐。
   *
   * ## ★★ 为什么是一个对象而不是九个方法
   *
   * 隔离的判据是「换个身份看，这里的字节还成立吗」——派生自聊天记录的
   * 全部按 vault 分。而那是**一整套**路径（图库、导出、媒体、agent workspace、
   * 渠道 CLI 的配置目录…），装配层要把它们逐个喂给对应的服务。
   *
   * 给一个对象让"漏了一个"变成**编译错误**而不是运行时的静默降级：
   * 装配层解构它，少接一个字段 tsc 就报；而九个独立方法里漏调一个，
   * 表现是那一类数据仍然写在应用级目录 —— 也就是切了身份还在读上一个人的
   * 数据，而没有任何报错。这个仓库最贵的 bug 全是这个形状。
   *
   * ★ 只做**路径拼接**，不建目录（各写入方按需 mkdir，与现有约定一致）。
   *
   * 后续要抽得更彻底（比如把"哪个服务吃哪个字段"也编码进类型）由接手的人做；
   * 这一层先保证「一处定义、一次传递」。
   */
  paths(vaultId: string): VaultPaths {
    const root = this.directory(vaultId)
    return {
      root,
      database: this.path(vaultId),
      forgeRoot: this.forgeRoot(vaultId),
      skillRoot: this.skillRoot(vaultId),
      /**
       * 知识图谱的数据目录（`knowledge.db` / `qdrant_data` / `extraction_cache`）。
       *
       * ★ 这一个目录就是算法团队要的 `databaseDir` —— 上游全部路径都从
       * 一个环境变量（`KL_DATA_DIR`）派生，所以按 vault 换目录**不需要
       * 改他们那侧任何代码**。
       */
      klRoot: join(root, "kl"),
      /** 四件套导出（喂图谱的语料投影）。注入上游的 `KL_DWS_EXPORT_DIR`。 */
      exportRoot: join(root, "exports", "dws"),
      /** 给算法团队的一页运行时事实。一身份一份，删 vault 时一并消失。 */
      handoffFile: join(root, "handoff.json"),
      mediaRoot: join(root, "media"),
      avatarRoot: join(root, "avatars"),
      uploadRoot: join(root, "uploads"),
      /** agent workspace（`persona/<cid>`、`search/<sid>`），含 transcript 片段。 */
      agentWorkspaceRoot: join(root, "agents"),
      /**
       * agent 子进程的隔离 HOME。
       *
       * ★ 只放 `.config` / `.local/state`（opencode 的配置与 session 锁，
       * 会随会话产生状态）。**npm 包缓存不在这里** —— 那是 registry 的只读
       * 镜像（实测 325 MB），按身份各拷一份纯属浪费且首次切换要重新联网。
       * 它走应用级的 `npm_config_cache`（见 AppPaths.agentNpmCache）。
       */
      agentHome: join(root, "agent-home"),
      /**
       * 渠道 CLI 的配置目录（`profiles.json` / 日志 / 事件流）。
       *
       * ## ★★ 这是身份隔离的**主防线**，比 `--profile` 强
       *
       * 实测：目录里只 seed 该身份那一条 profile 之后，
       * 拿另一个身份的 `--profile` 去问会直接
       * `organization "…" not found` —— 越权读取变成**结构性不可能**。
       * 而 `--profile` 只是"我们记得传"，漏一处就是泄漏。
       * 两道一起上（同 `vault.ts` 文件头那条推理：靠文件系统，不靠自觉）。
       *
       * ★ 必须**显式 seed**，不能只建空目录：实测空目录会取 Keychain 里的
       * 全局 `current`，而那个值会被用户在终端改掉 —— 那就把要修的问题
       * 原样搬进了新目录。
       */
      dwsHome: join(root, "channels", "dingtalk", "dws-home"),
      feishuAuthRoot: join(root, "channels", "feishu"),
    }
  }

  /** 打开（或复用）指定 vault，按需应用 vault 迁移。 */
  handle(vaultId: string): StoreHandle {
    return this.handleAt(vaultId, this.path(vaultId))
  }

  private handleAt(key: string, path: string): StoreHandle {
    const existing = this.open.get(key)
    if (existing !== undefined) return existing

    const handle = openStore({
      path,
      migrations: VAULT_MIGRATIONS,
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    })
    this.open.set(key, handle)
    this.options.logger?.info("vault opened", { vaultId: key, version: handle.appliedVersion })
    return handle
  }

  isOpen(vaultId: string): boolean {
    return this.open.has(vaultId)
  }

  close(vaultId: string): void {
    const keys = [...this.open.keys()].filter(
      (key) => key === vaultId || key.startsWith(`${vaultId}:source:`),
    )
    for (const key of keys) {
      const handle = this.open.get(key)
      if (handle === undefined) continue
      this.open.delete(key)
      try {
        handle.close()
      } catch {
        // 关闭失败（通常是已被关闭）无需再处理：句柄已从表中移除。
      }
    }
  }

  closeAll(): void {
    for (const vaultId of [...this.open.keys()]) this.close(vaultId)
  }

  /**
   * 删除整个 vault（不可逆）。
   * 先关闭句柄再删目录：Windows 上占用中的文件删不掉，
   * 而 WAL/SHM 残留文件必须一起删干净，否则下次打开会读到旧数据。
   */
  destroy(vaultId: string): void {
    this.close(vaultId)
    rmSync(this.directory(vaultId), { recursive: true, force: true })
    this.options.logger?.warn("vault destroyed", { vaultId })
  }
}
