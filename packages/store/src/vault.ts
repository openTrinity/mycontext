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

  /** 打开（或复用）指定 vault，按需应用 vault 迁移。 */
  handle(vaultId: string): StoreHandle {
    const existing = this.open.get(vaultId)
    if (existing !== undefined) return existing

    const handle = openStore({
      path: this.path(vaultId),
      migrations: VAULT_MIGRATIONS,
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    })
    this.open.set(vaultId, handle)
    this.options.logger?.info("vault opened", { vaultId, version: handle.appliedVersion })
    return handle
  }

  isOpen(vaultId: string): boolean {
    return this.open.has(vaultId)
  }

  close(vaultId: string): void {
    const handle = this.open.get(vaultId)
    if (handle === undefined) return
    this.open.delete(vaultId)
    try {
      handle.close()
    } catch {
      // 关闭失败（通常是已被关闭）无需再处理：句柄已从表中移除。
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
