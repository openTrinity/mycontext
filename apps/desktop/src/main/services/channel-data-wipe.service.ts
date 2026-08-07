/**
 * 「清空当前渠道的数据」—— 把这个身份的 vault 清回「刚登录完、还没采过」。
 *
 * ## ★★ 它替换掉了什么，以及为什么
 *
 * 设置里原来那个按钮是「重置蒸馏水位」。那个动作**不删任何数据**，只把
 * `distill_sources.last_synced_seq` 与 `distill_tasks` 清掉让它重蒸一遍。
 * 问题是它回答不了用户真正想做的那件事：「这个渠道的数据脏了/我改了范围，
 * 我要它从零重来」。重置水位之后语料、索引、图谱、forge 派生库全都还在，
 * 于是重蒸出来的画像与之前几乎一样 —— 按钮看起来生效了，实际什么都没变。
 *
 * ## 本质上清的是两块（这正是用户问的那个问题）
 *
 * · **vault 库里的数据** —— 语料、会话、原始记录、Outbox、索引、数字人痕迹；
 * · **current profile 的派生产物** —— `forge/`（含它自己那份语料副本与
 *   `pulledThrough` 水位）、`kl/`（图库 + 向量 + 抽取缓存）、`exports/`
 *   （四件套）、`media/` `avatars/`（下载的字节）。
 *
 * 这两块合起来就是"这个渠道身份采出来的一切"。
 *
 * ## ★★ 但**不是**清整个 vault 目录 —— 四样东西必须留
 *
 * 否则这个按钮会变成"退出登录 + 重新勾一遍会话"：
 *
 * | 留 | 删了的后果（都实测过） |
 * | --- | --- |
 * | `channels/`（渠道凭据） | 要重新扫码授权 |
 * | `channel_self_identity` | 蒸馏会**拒掉全部语料**（那是一道刻意的闸） |
 * | `distill_sources.scope_json` | 用户要重新勾一遍会话（实测这台机器 72 个） |
 * | `onboarding_progress` / `vault_settings` | 引导进度与偏好丢失 |
 *
 * 也就是「**清数据，不清"你是谁"和"你选了什么"**」。要连这些一起清，
 * 正确做法是删掉整个 vault 目录（应用会当成新账号，重新登录即可）——
 * 那是另一个动作，不该由这个按钮悄悄替用户做。
 *
 * ## ★★★ 为什么必须先停服务、清完再重挂
 *
 * 库正被一堆服务以 WAL 打开着，而它们各自持着定时器与内存态：
 * · 采集器可能正 await 一个 0.6s 的渠道子进程 —— 它回来之后会往
 *   **已经被清空**的库里写，那批数据没有 conversations 父行（FK 失败）
 *   或者更糟：水位已经归零而它又推了一次，于是回溯不会发生；
 * · kl-server 子进程持着 `knowledge.db` 的句柄，删文件后它仍在写旧 inode
 *   （macOS 允许删开着的文件）—— 表现是"清了但图还在"；
 * · `DistillService` / `PersonaService` 的定时器会在清库中途醒来查库。
 *
 * 所以顺序是 **卸载（await 到底）→ 清 → 重挂**，复用登录/切身份那两个已有
 * 编排（`teardownVault` / `mountVault`）而不是新写一套：那两个函数里每一步
 * 都对应一个实测过的坑（见 `vault-teardown.ts` 的文件头）。
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { Clock, Logger } from "@mycontext/kernel"
import { AppError } from "@mycontext/kernel"
import { openConnection, wipeVaultData, type WipeVaultReport } from "@mycontext/store"

/** 清空的结果。给 UI 显示"清掉了多少"，也给日志留证据。 */
export interface ChannelDataWipeResult {
  /** 清掉（或将要清掉）的库行数合计 */
  rows: number
  /** 逐表行数（只含库里真实存在且非零的表，给 UI 展开看） */
  byTable: { table: string; rows: number }[]
  /** 删掉的文件/目录数 */
  removedPaths: number
  /** 是否只是预演 */
  dryRun: boolean
  /** FTS 自检：null = 跳过（库里没这张表） */
  ftsIntegrityOk: boolean | null
}

export interface ChannelDataWipeOptions {
  clock: Clock
  logger: Logger
  /**
   * 当前挂载的 vault 目录与库路径。null = 没登录（这时清什么都无从谈起）。
   *
   * 取**函数**而不是值：vault 随登录/切身份变，装配这一刻还没有。
   */
  currentVault: () => { root: string; database: string } | null
  /** 卸载全部服务并关库（复用登录那条编排，见文件头）。 */
  unmount: () => Promise<void>
  /** 重新挂载（同上）。 */
  remount: () => Promise<void>
}

export class ChannelDataWipeService {
  constructor(private readonly options: ChannelDataWipeOptions) {}

  /**
   * 清空当前渠道的数据。
   *
   * @param options.dryRun 只数不删。**预演不停服务** —— 它只读，
   *   而为了报几个数字就把采集停掉再起来是不必要的干扰。
   * @param options.dropSearch 连用户自己的搜索提问历史一起清（默认不清）。
   */
  async wipe(
    options: { dryRun?: boolean; dropSearch?: boolean } = {},
  ): Promise<ChannelDataWipeResult> {
    const vault = this.options.currentVault()
    if (vault === null) {
      throw new AppError("DB_UNAVAILABLE", "尚未登录，没有可清空的渠道数据")
    }
    const dryRun = options.dryRun === true

    /**
     * 预演：开一个**独立连接**只读地数一遍，不动运行中的服务。
     *
     * 用 `openConnection`（不跑迁移）而不是主进程那个句柄：这条路径要在
     * "服务还在跑"的前提下工作，而借用它们的句柄意味着预演与采集共享
     * 同一个连接的事务状态。
     */
    if (dryRun) {
      const db = openConnection(vault.database, { readonly: true })
      try {
        const report = wipeVaultData(db, {
          dryRun: true,
          ...(options.dropSearch === true ? { dropSearch: true } : {}),
          now: this.options.clock.now(),
        })
        return this.toResult(report, 0)
      } finally {
        db.close()
      }
    }

    /**
     * ① 卸载：await 到底。它会等在途那一轮采集收尾、停 kl 子进程、
     *    退订事件长连、最后关库（见 `teardownVault`）。
     */
    this.options.logger.info("channel data wipe: unmounting vault", {})
    await this.options.unmount()

    let report: WipeVaultReport
    let removedPaths = 0
    try {
      // ② 清库。库这时已经没有别的持有者，可以安全开一个自己的连接。
      const db = openConnection(vault.database)
      try {
        report = wipeVaultData(db, {
          ...(options.dropSearch === true ? { dropSearch: true } : {}),
          now: this.options.clock.now(),
        })
        /**
         * WAL 里还留着刚删掉的那几百 MB —— checkpoint + VACUUM 才会真的
         * 还给磁盘。不做的话用户清完看到占用没变，会以为没生效。
         */
        db.pragma("wal_checkpoint(TRUNCATE)")
        db.exec("VACUUM")
      } finally {
        db.close()
      }

      /**
       * ③ 删文件产物。
       *
       * 逐个 catch：漏删只留下孤儿文件（可观测、可再清），而让整轮清理
       * 因为一个文件删不掉就失败，会把状态留在"库清了、文件还在、而且
       * 没重新挂载"——那比留几个孤儿文件糟得多。
       */
      for (const path of this.filesToRemove(vault.root, report.filePaths)) {
        try {
          rmSync(path, { recursive: true, force: true })
          removedPaths += 1
        } catch (error) {
          this.options.logger.warn("channel data wipe: file remove failed", {
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      /**
       * ④ 无论清理成不成功都**必须**重挂。
       *
       * 放在 finally 里是刻意的：清到一半抛异常而不重挂的话，应用会留在
       * "已登录但什么服务都没起"的状态 —— 界面上看起来像整个应用坏了，
       * 而用户唯一的出路是重启。重挂一个空库至少是一个可用的起点。
       */
      this.options.logger.info("channel data wipe: remounting vault", {})
      await this.options.remount()
    }

    this.options.logger.info("channel data wipe done", {
      rows: report.totalRows,
      removedPaths,
      ftsIntegrityOk: report.ftsIntegrityOk,
    })
    /**
     * FTS 自检失败要**说出来**而不是静默通过：那意味着索引里可能留了
     * 孤儿行（搜得到已经删掉的内容），而它不会以任何别的方式表现出来。
     */
    if (report.ftsIntegrityOk === false) {
      this.options.logger.error("channel data wipe: fts integrity check failed", {
        detail: report.ftsError,
      })
    }
    return this.toResult(report, removedPaths)
  }

  /**
   * 要删的文件与目录。
   *
   * 目录清单与 `scripts/reset-vault.mjs` 的 `fileTargets` 同源，也与
   * `KlServerService.wipeGraphData` 对 kl 那几项一致。
   *
   * ★ `extraction_cache` 必须删：抽取缓存的 key 是 `md5(msg.id)`，不删的话
   * 下次建图会全部命中旧结果（可能是空的），表现是"重建了但图还是空"。
   */
  private filesToRemove(root: string, mediaPaths: readonly string[]): string[] {
    return [
      // 图谱库 + 向量 + 抽取缓存
      join(root, "kl", "knowledge.db"),
      join(root, "kl", "knowledge.db-shm"),
      join(root, "kl", "knowledge.db-wal"),
      join(root, "kl", "qdrant_data"),
      join(root, "kl", "extraction_cache"),
      // 四件套导出（下一轮 GraphSync 会重新物化）
      join(root, "exports", "dws"),
      /**
       * forge 的派生库与产物。
       *
       * ★ `database/` 里有它**自己那份语料副本**与 `pulledThrough` 水位 ——
       * 不删的话 vault 清空了而 forge 仍能从自己的副本蒸出画像来，
       * 那正是"清了但画像没变"的原因。
       *
       * ★ 但**不删 `forge/` 整个目录**：`persona-config.json`、
       * `locale-overrides.json`、`relationship-overrides.json` 是用户/应用的
       * 配置（含手写的 owner 块，那是 forge 唯一不可重建的东西）。
       */
      join(root, "forge", "database"),
      join(root, "forge", "derived"),
      join(root, "forge", "backups"),
      join(root, "forge", "skills"),
      // 下载的媒体与头像目录
      join(root, "media"),
      join(root, "avatars"),
      /**
       * 库里记着的媒体绝对路径 —— 绝大多数落在上面那两个目录里（会被整体
       * 删掉），但历史上有过落在别处的（见 media 服务的路径演进）。
       * 一起传进来兜住那部分，`rmSync` 的 `force` 让"已经不存在"不报错。
       */
      ...mediaPaths,
    ]
  }

  private toResult(report: WipeVaultReport, removedPaths: number): ChannelDataWipeResult {
    return {
      rows: report.totalRows,
      byTable: Object.entries(report.rows)
        .filter(([, rows]) => rows > 0)
        .map(([table, rows]) => ({ table, rows }))
        .sort((left, right) => right.rows - left.rows),
      removedPaths,
      dryRun: report.dryRun,
      ftsIntegrityOk: report.ftsIntegrityOk,
    }
  }
}
