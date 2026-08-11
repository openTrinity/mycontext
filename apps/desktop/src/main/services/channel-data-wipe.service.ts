/**
 * 「清空当前渠道的数据」—— 把这个渠道身份**整个归零**。
 *
 * ## ★★ 语义：归零，不是"清数据留配置"
 *
 * 首版做的是"清数据、保留身份与勾选范围"（那是从 `scripts/reset-vault.mjs`
 * 继承的语义，对那个脚本的用途是对的：排障之后继续用同一身份）。
 * 用在这颗按钮上是**错的**，实测后果（本机日志）：
 *
 * ```
 * 07:55:15  channel data wipe done  rows=95172        ← 真删了 9.5 万行
 * 07:55:17  ingest dropped out-of-scope {allowed:72}  ← 2 秒后又开始采
 * 08:00:36  最新一条消息落库                           ← 5 分钟内回来 5000 条
 * ```
 *
 * 身份还确认着、72 个勾选会话还在，于是重挂之后采集立刻按原范围重跑。
 * 用户看到的是"点了清空但数据还在涨"——与"按钮没生效"无法区分。
 *
 * 所以现在的语义是**彻底归零**：删掉整个 vault 目录 + 解除身份映射。
 * 下次要重新授权、重新确认身份、重新选学习范围、重新建数字人身份。
 *
 * ## 为什么是"删整个目录"而不是逐表 DELETE
 *
 * `reset-vault.mjs` 的文件头早就写了这条：「要连这些一起清就直接删整个
 * vault 目录（那时应用会当成新账号，重新登录即可）」。
 *
 * 逐表清的路要同时保证：三条硬约束（FTS 虚表先删、序列与游标一起归零、
 * 外键要开）、把身份/范围/引导/数字人配置各自清对、还要让
 * `readCollectionScope` 读出"一个都不采"而不是"不限"（删掉 `distill_sources`
 * 的 chat 行会被读成**不限 = 采全部**，正好反方向 —— 这是个真陷阱）。
 * 而删目录一次到位，且**没有中间状态**：目录在或不在。
 *
 * 那三条硬约束仍然有价值（`wipeVaultData` 还在，命令行脚本用它做
 * "留身份的清理"），只是这颗按钮不走那条路。
 *
 * ## 删完之后挂哪个 vault
 *
 * 复用 `resolveOnLogin` 的既有规则：解绑之后这个账号可能还有别的身份
 * （挂最近用过的那个），也可能一个都没有 → 退回账号的**基础 vault**
 * （`accounts.vault_id`）。后者正是"注册了但还没连渠道"的正常状态，
 * onboarding 会往那个库里写 —— 也就是用户会看到引导流程重新出现。
 *
 * 自己判断"该挂哪个"会得到第二份同义实现，而两份必然分叉。
 *
 * ## ★★ 删目录**不等于**退出已授权 —— 必须显式 logout
 *
 * 这是这一版修掉的关键错误。渠道凭据文件确实在
 * `<vault>/channels/<渠道>/dws-home/` 下，但 **token 的密钥在系统钥匙串里**
 * ——不在那个目录。实测（见 `profile-seed.ts` 文件头）：全新空目录跑
 * `auth status` 仍返回 `authenticated: true`，因为 CLI 会就地从钥匙串
 * 重建一份 `profiles.json`。
 *
 * 也就是说只删目录的话，清空之后下一次 `auth status` 照样是已授权 ——
 * 那正是用户报的"删了还是已授权状态"。所以顺序里必须有一步
 * `channel logout`（`dws auth logout`，带 `--profile` 钉住身份），
 * 而且要在删目录**之前**（CLI 需要读配置才知道退哪个 profile）。
 */
import { existsSync } from "node:fs"
import type { Clock, Logger } from "@mycontext/kernel"
import { AppError } from "@mycontext/kernel"
import { openConnection, wipeVaultData } from "@mycontext/store"
import type { ChannelIdentityKey } from "@mycontext/store"

/** 清空的结果。给 UI 显示"清掉了多少"，也给日志留证据。 */
export interface ChannelDataWipeResult {
  /** 清掉（或将要清掉）的库行数合计 */
  rows: number
  /** 逐表行数（只含库里真实存在且非零的表，给 UI 展开看） */
  byTable: { table: string; rows: number }[]
  /** 删掉的文件/目录数。归零模式下是整个 vault 目录（1） */
  removedPaths: number
  /** 是否只是预演 */
  dryRun: boolean
  /**
   * 身份映射有没有被解除。
   *
   * 与 `rows` 分开报：用户要确认的不只是"删了多少条"，更是
   * "是不是真的要重新授权了"。而后者的判据是这一行。
   */
  identityUnbound: boolean
  /**
   * 授权有没有真的退掉（钥匙串里那份 token 清没清）。
   *
   * ★ 单独报而不是并进 `identityUnbound`：两者会**分别**失败。
   * 解绑是本地一行 DELETE（几乎不会失败），而退登要跑一个子进程
   * （可能超时/CLI 不支持）。合成一个的话"数据清了、映射解了、
   * 但仍然已授权"这个真实存在的中间态就没法如实告诉用户了。
   */
  authRevoked: boolean
}

export interface ChannelDataWipeOptions {
  clock: Clock
  logger: Logger
  /**
   * 当前挂载的 vault（目录 + 库路径）。null = 没登录。
   *
   * 取**函数**而不是值：vault 随登录/切身份变，装配这一刻还没有。
   */
  currentVault: () => { root: string; database: string } | null
  /**
   * 当前身份的四元组键与它的 vaultId。null = 这个 vault 还没绑身份
   * （"注册了但没连渠道"的基础 vault —— 那时没有映射可解除）。
   */
  currentIdentity: () => { key: ChannelIdentityKey; vaultId: string } | null
  /** 卸载全部服务并关库（复用登录那条编排，见文件头）。 */
  unmount: () => Promise<void>
  /** 删掉整个 vault 目录（`VaultStore.destroy`，不可逆）。 */
  destroyVault: (vaultId: string) => void
  /**
   * 这个 vault 上**除了**给定渠道之外，还绑着哪些渠道的身份。
   *
   * ## ★★ 为什么必须有它（否则清一个渠道会连带删掉另一个）
   *
   * control v5 起**一个 vault 可以挂多个渠道的身份**（索引 `(vault_id, channel_id)`），
   * 而非主渠道的库落在**这个 vault 目录里面**的 `sources/<channelId>/`。
   * 于是"清空当前渠道"若走 `destroyVault`（删整个目录），实测后果是：
   *
   * · 本机 control 库里钉钉与飞书**共用同一个 vault**（实测：两条身份、
   *   同一个 vault_id）；
   * · 点一次「清空」→ 另一个渠道的 `sources/<channelId>/` 全部数据一起消失，
   *   而它的身份映射还留在 control 库里指向一个已不存在的目录；
   * · 下次登录 `resolveOnLogin` 挑中它 → `openStore` **新建一个空库** →
   *   用户看到"已授权但什么都没有"的身份，且永远不会被清理。
   *
   * 有了这个判据就能分两档：还有别的渠道 → **只删这个渠道的子树**；
   * 只剩它自己 → 照旧 destroy 整个 vault（省下一个没人引用的空壳）。
   *
   * @returns 其他渠道的 channelId 列表（不含传入的那个）
   */
  siblingChannels: (vaultId: string, channelId: string) => string[]
  /**
   * 删掉**一个渠道**在这个 vault 里的子树（`sources/<channelId>/` 与
   * `channels/<channelId>/`：库、导出、图谱、交接文件、那份隔离的凭据目录）。
   *
   * 只在 vault 被多渠道共用时走这条 —— 见 `siblingChannels`。
   *
   * @returns 实际删掉的目录数（0 = 本来就没有）
   */
  destroyChannelSubtree: (vaultId: string, channelId: string) => number
  /** 解除 control 库里的身份 → vault 映射。 */
  unbindIdentity: (key: ChannelIdentityKey) => void
  /**
   * 退出该渠道的授权（清钥匙串里那份 token）。返回是否真的退掉了。
   *
   * 必须在**删目录之前**调：CLI 要读 `DWS_CONFIG_DIR` 下的 profiles
   * 才知道退哪个身份。目录先删了的话它会退成钥匙串里的全局 current
   * —— 可能是另一个身份。
   */
  revokeAuth: (channelId: string) => Promise<boolean>
  /**
   * 重新挑一个 vault 挂上（复用 `resolveOnLogin` 的规则，见文件头）。
   *
   * 返回 null = 当前没有登录账号，那时不挂（也没什么可挂）。
   */
  remount: () => Promise<void>
}

export class ChannelDataWipeService {
  constructor(private readonly options: ChannelDataWipeOptions) {}

  /**
   * 清空当前渠道的数据并解除授权。
   *
   * @param options.dryRun 只数不删。**预演不停服务** —— 它只读，
   *   而为了报几个数字就把采集停掉再起来是不必要的干扰。
   */
  async wipe(options: { dryRun?: boolean } = {}): Promise<ChannelDataWipeResult> {
    const vault = this.options.currentVault()
    if (vault === null) {
      throw new AppError("DB_UNAVAILABLE", "尚未登录，没有可清空的渠道数据")
    }
    const identity = this.options.currentIdentity()
    const dryRun = options.dryRun === true

    /**
     * 预演：开一个**独立只读连接**数一遍，不动运行中的服务。
     *
     * 复用 `wipeVaultData` 的 `dryRun` 只为了拿那份逐表计数 —— 真删走的是
     * "删整个目录"，两者的**计数口径一致**（那个函数数的就是这些数据表）。
     * 计数与真删不同源在这里是可接受的：预演报的是"这个库里有多少数据"，
     * 而删目录一定把它们全部带走（是它的超集，含身份与配置）。
     */
    if (dryRun) {
      const db = openConnection(vault.database, { readonly: true })
      try {
        const report = wipeVaultData(db, { dryRun: true, now: this.options.clock.now() })
        return {
          rows: report.totalRows,
          byTable: Object.entries(report.rows)
            .filter(([, rows]) => rows > 0)
            .map(([table, rows]) => ({ table, rows }))
            .sort((left, right) => right.rows - left.rows),
          removedPaths: 0,
          dryRun: true,
          // 预演时如实报"将会解除/将会退登"（有身份才会）
          identityUnbound: identity !== null,
          authRevoked: identity !== null,
        }
      } finally {
        db.close()
      }
    }

    // 真删前先把计数读出来 —— 目录删掉之后就再也数不到了（要给用户回执）
    let rows = 0
    let byTable: { table: string; rows: number }[] = []
    try {
      const db = openConnection(vault.database, { readonly: true })
      try {
        const report = wipeVaultData(db, { dryRun: true, now: this.options.clock.now() })
        rows = report.totalRows
        byTable = Object.entries(report.rows)
          .filter(([, count]) => count > 0)
          .map(([table, count]) => ({ table, rows: count }))
          .sort((left, right) => right.rows - left.rows)
      } finally {
        db.close()
      }
    } catch (error) {
      /**
       * 数不出来**不阻止清空**：那只是回执上少一个数字，而用户要的是
       * "把它清掉"。抛在这里会让一个坏掉的库永远清不了 —— 而那种库
       * 恰恰是最需要清的。
       */
      this.options.logger.warn("channel data wipe: pre-count failed", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    /**
     * ① 卸载：await 到底。它会等在途那一轮采集收尾、停 kl 子进程、
     *    退订事件长连、最后关库（见 `teardownVault`）。
     *
     * ★ 必须在删目录**之前**：库正被以 WAL 打开，而 kl-server 子进程持着
     *   `knowledge.db` 的句柄。macOS 允许删开着的文件，于是"删了但进程还在
     *   写旧 inode"——表现是清完之后图还在。
     */
    this.options.logger.info("channel data wipe: unmounting vault", {})
    await this.options.unmount()

    let identityUnbound = false
    let authRevoked = false
    let removedPaths = 0
    try {
      /**
       * ② ★★ 先退授权 —— **必须在删目录之前**。
       *
       * token 的密钥在系统钥匙串里，不在这个目录（见文件头）。所以：
       * · 不调它 → 清完之后 `auth status` 照样已授权（用户报的那个 bug）；
       * · 在删目录**之后**调 → CLI 读不到这个 vault 的 profiles，会去退
       *   钥匙串里的全局 current，那可能是**另一个**身份。
       *
       * 没有身份（基础 vault）时跳过：那时本来就没授权过什么可退的。
       */
      if (identity !== null) {
        authRevoked = await this.options.revokeAuth(identity.key.channelId)
        if (!authRevoked) {
          /**
           * 退登失败**不阻止清空**，但要留下痕迹：用户要的是"把它清掉"，
           * 而"凭据还在"是可以再点一次 / 手动处理的降级状态。
           * 静默当成成功才是真问题（那正是这一版在修的）。
           */
          this.options.logger.warn(
            "channel data wipe: auth revoke failed; credentials may remain",
            {
              channelId: identity.key.channelId,
            },
          )
        }
      }

      /**
       * ③ 解除身份映射，**再**删目录。
       *
       * 顺序是刻意的：先删目录后解绑的话，中间那一刻 control 库里有一条
       * 指向**已经不存在的目录**的映射 —— 而下次登录 `resolveOnLogin`
       * 会挑中它并试图挂载，那时 `openStore` 会**新建一个空库**
       * （目录不在就建），于是用户看到一个"已授权但什么都没有"的身份，
       * 而它永远不会被清理掉。
       *
       * 反过来（先解绑）最坏是留下一个没人引用的目录：可观测、可再删，
       * 而且下一次清空/登录都不会碰它。两种错都会发生，选后果小的那个。
       */
      if (identity !== null) {
        this.options.unbindIdentity(identity.key)
        identityUnbound = true
      }

      /**
       * ④ 删盘上的东西 —— **分两档**，取决于这个 vault 还有没有别的渠道。
       *
       * ## ★★ 为什么不能一律 `destroyVault`
       *
       * control v5 起一个 vault 可挂多个渠道的身份，而非主渠道的库就在
       * **这个 vault 目录里**（`sources/<channelId>/`）。一律删整个目录的
       * 实测后果：本机钉钉与飞书共用一个 vault，清任一个 → 另一个的语料、
       * 图谱、导出全部消失，而它的映射还指向那个已不存在的目录（下次登录
       * 会静默新建空库，得到一个"已授权但什么都没有"且清不掉的身份）。
       *
       * · 还有别的渠道 → 只删**这个渠道的子树**（`sources/<id>/` +
       *   `channels/<id>/`），别人的东西一个字节都不碰；
       * · 只剩它自己 → 照旧 destroy 整个 vault（否则留一个空壳目录）。
       *
       * `VaultStore.destroy` 会先 close 句柄再 `rmSync(recursive, force)`，
       * 所以 WAL/SHM 残留也一起走 —— 那很关键：留下 `-wal` 会让下次
       * 打开同名库读到旧数据。子树那条走 `destroyChannelSubtree`，
       * 库已在 ① 的 `unmount()` 里关掉了。
       */
      if (existsSync(vault.root)) {
        // 没绑身份（基础 vault）时 vaultId 从目录名取 —— destroy 只用它拼路径
        const vaultId = identity?.vaultId ?? basenameOf(vault.root)
        const siblings =
          identity === null ? [] : this.options.siblingChannels(vaultId, identity.key.channelId)
        if (identity !== null && siblings.length > 0) {
          removedPaths = this.options.destroyChannelSubtree(vaultId, identity.key.channelId)
          this.options.logger.info("channel data wipe: kept shared vault", {
            siblings: siblings.length,
            removedPaths,
          })
        } else {
          this.options.destroyVault(vaultId)
          removedPaths = 1
        }
      }
    } finally {
      /**
       * ⑤ 无论上面成不成功都**必须**重挂。
       *
       * 放在 finally 里是刻意的：删到一半抛异常而不重挂的话，应用会留在
       * "已登录但什么服务都没起"的状态 —— 界面上看起来像整个应用坏了，
       * 而用户唯一的出路是重启。
       *
       * ★ 重挂挑的是 `resolveOnLogin` 的结果，而刚才已经解绑，所以它会
       * 退回"账号的基础 vault"（或这个账号的另一个身份）—— 也就是用户
       * 会看到未授权 + 引导流程重新出现，而不是回到刚被清掉的那个身份。
       */
      this.options.logger.info("channel data wipe: remounting", {})
      await this.options.remount()
    }

    this.options.logger.info("channel data wipe done", {
      rows,
      removedPaths,
      identityUnbound,
      authRevoked,
    })
    return { rows, byTable, removedPaths, dryRun: false, identityUnbound, authRevoked }
  }
}

/**
 * 取路径的最后一段（= vaultId）。
 *
 * 不用 `node:path` 的 `basename`：那个对末尾带分隔符的路径返回上一级，
 * 而 `VaultPaths.root` 的来源（`join`）不会带 —— 但依赖"不会带"是脆的。
 * 这里显式过滤空段，两种形态都对。
 */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== "")
  return parts[parts.length - 1] ?? ""
}
