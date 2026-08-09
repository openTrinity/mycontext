/**
 * ## ★★ 一个渠道的东西必须全在它自己的目录下
 *
 * 这条不变式的收益是"删一个渠道 = 删一个目录"，以及"不可能与别的渠道互相
 * 覆盖"。而它破过一次，形态是**路径拼错**：
 *
 * 飞书的导出物落在 `exports/dws/feishu` —— 因为 `VaultPaths.exportRoot`
 * 已经是 `exports/dws`（`dws` 是**主渠道 CLI 的名字**），而装配层又在它下面
 * `join(channelId)`。于是：
 *
 * · 语义错：读起来像"dws 的飞书子目录"，而两者毫无关系；
 * · 层级错：那个目录下本来是**内容类型**分层（`chat` / `wiki` / `minutes`），
 *   于是一个渠道名与三个内容类型并列成了兄弟。下一个人按这个布局推断
 *   "飞书也是一种内容类型"会写出更多错位。
 *
 * 这类错误 typecheck 看不见（都是合法的 string 拼接），运行时也不报错 ——
 * 只是文件长在了错的地方。所以要有门禁。
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { VaultStore } from "@mycontext/store"

const VAULT = "vaultFAKE0001"
const CHANNEL = "feishu"

function store(): { vaults: VaultStore; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mycontext-paths-"))
  return {
    vaults: new VaultStore({ root }),
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe("★★ 非主渠道的落点全在 sources/<channelId>/ 下", () => {
  it("★★ 库 / 导出 / 图谱 / handoff 四样都在同一个渠道目录里", () => {
    const { vaults, cleanup } = store()
    const base = vaults.sourceRoot(VAULT, CHANNEL)
    for (const path of [
      vaults.sourcePath(VAULT, CHANNEL),
      vaults.sourceExportRoot(VAULT, CHANNEL),
      vaults.sourceKlRoot(VAULT, CHANNEL),
      vaults.sourceHandoffFile(VAULT, CHANNEL),
    ]) {
      expect(path.startsWith(base + sep), `${path} 不在 ${base} 下`).toBe(true)
    }
    cleanup()
  })

  /**
   * ★★★ 这一条直接锁住那个错误路径。
   *
   * 判据是"**不含** `exports/dws`" —— 而不是"等于某个具体路径"：
   * 后者在有人把它改成另一个同样错的位置时也可能通过。
   */
  it("★★★ 导出目录不许出现在主渠道 CLI 的目录下（exports/dws）", () => {
    const { vaults, cleanup } = store()
    const exportRoot = vaults.sourceExportRoot(VAULT, CHANNEL)
    expect(exportRoot).not.toContain(join("exports", "dws"))
    // 反证：它确实在渠道目录里，且叫 exports
    expect(exportRoot.endsWith(join("sources", CHANNEL, "exports"))).toBe(true)
    cleanup()
  })

  /**
   * ★ handoff 不再是 vault 根下的 `handoff.<channelId>.json`。
   *
   * 那个形状会让 vault 根随渠道数量长出一堆同名前缀的文件，
   * 而主渠道那份（`handoff.json`）夹在中间 —— 谁是谁要靠文件名猜。
   */
  it("★ handoff 收在渠道目录里，不是 vault 根下的 handoff.<id>.json", () => {
    const { vaults, root, cleanup } = store()
    const file = vaults.sourceHandoffFile(VAULT, CHANNEL)
    expect(file).not.toBe(join(root, VAULT, `handoff.${CHANNEL}.json`))
    expect(file.endsWith(join("sources", CHANNEL, "handoff.json"))).toBe(true)
    cleanup()
  })

  /**
   * ★★ 两个渠道的落点**互不包含** —— 这是"不可能互相覆盖"的形式化表述。
   */
  it("★★ 不同渠道的目录互不包含", () => {
    const { vaults, cleanup } = store()
    const a = vaults.sourceRoot(VAULT, "feishu")
    const b = vaults.sourceRoot(VAULT, "dingtalk")
    expect(a.startsWith(b + sep)).toBe(false)
    expect(b.startsWith(a + sep)).toBe(false)
    cleanup()
  })

  /**
   * ★ 主渠道那两个路径**保持原位**。
   *
   * 上游（算法团队）按固定路径读 `handoff.json` 与 `KL_DWS_EXPORT_DIR`，
   * 动它们要改他们那侧 —— 这条锁住"归位非主渠道"时没有顺手把主渠道也搬了。
   */
  it("★ 主渠道的 exportRoot / handoffFile 不变（上游按固定路径读）", () => {
    const { vaults, root, cleanup } = store()
    const paths = vaults.paths(VAULT)
    expect(paths.exportRoot).toBe(join(root, VAULT, "exports", "dws"))
    expect(paths.handoffFile).toBe(join(root, VAULT, "handoff.json"))
    cleanup()
  })
})
