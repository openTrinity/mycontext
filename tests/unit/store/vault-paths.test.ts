/**
 * 磁盘落点按 vault 隔离。
 *
 * ## 这一组锁的是一句话：**vault 目录里就是这个身份的全部**
 *
 * 改动前有五处是**应用级**的（跨身份共用），而它们装的全是派生自聊天记录
 * 的东西：图谱库（实测 37 MB + 258 个抽取缓存目录）、四件套导出（聊天正文）、
 * 媒体与头像、agent workspace（含 transcript 片段）、渠道 CLI 的配置目录。
 *
 * 第二个身份登录后读到的是第一个身份的那些数据 —— 而这**不报错**，
 * 只是答错。所以这一组的核心断言是"两个 vault 的路径互不包含"。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { VaultStore, type VaultPaths } from "@mycontext/store"

let root: string
let vaults: VaultStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mycontext-vault-paths-"))
  vaults = new VaultStore({ root })
})

afterEach(() => {
  vaults.closeAll()
  rmSync(root, { recursive: true, force: true })
})

/** 全部落点字段名 —— 新增一个落点时这里会失败，提醒把它纳入隔离断言。 */
const ALL_KEYS: readonly (keyof VaultPaths)[] = [
  "root",
  "database",
  "forgeRoot",
  "skillRoot",
  "klRoot",
  "exportRoot",
  "handoffFile",
  "mediaRoot",
  "avatarRoot",
  "uploadRoot",
  "agentWorkspaceRoot",
  "agentHome",
  "dwsHome",
  "feishuAuthRoot",
]

describe("每个落点都在 vault 目录内", () => {
  /**
   * ★★ 这是"删账号 = 删一个目录"那条收益的前提。
   *
   * 有任何一个落点在 vault 外，删 vault 就删不干净 —— 而残留的是聊天内容。
   */
  it("★★ 全部路径都在 vault 目录之下（否则删 vault 删不干净）", () => {
    const paths = vaults.paths("vault-a")
    for (const key of ALL_KEYS) {
      expect(paths[key].startsWith(paths.root), `${key} 落在了 vault 外：${paths[key]}`).toBe(true)
    }
  })

  /**
   * ★ 断言字段齐全：`paths()` 少给一个字段，装配层就会有人去拼一个应用级
   * 路径兜底 —— 而那是一次静默的跨身份写入。
   */
  it("字段齐全（新增落点必须同时纳入隔离断言）", () => {
    const paths = vaults.paths("vault-a")
    expect(Object.keys(paths).sort()).toEqual([...ALL_KEYS].sort())
    for (const key of ALL_KEYS) expect(paths[key]).not.toBe("")
  })

  it("feishuAuthRoot 在 vault 内（与 dwsHome 对称：凭据跟着身份走）", () => {
    const paths = vaults.paths("vault-a")
    expect(paths.feishuAuthRoot.startsWith(paths.root)).toBe(true)
    // ★ 与 dwsHome 各自独立：两个渠道的 CLI 配置不能互相看见
    expect(paths.feishuAuthRoot.startsWith(paths.dwsHome)).toBe(false)
    expect(paths.dwsHome.startsWith(paths.feishuAuthRoot)).toBe(false)
  })

  it("路径都是绝对路径（相对路径会落到进程 cwd，也就是仓库目录里）", () => {
    const paths = vaults.paths("vault-a")
    for (const key of ALL_KEYS) expect(paths[key].startsWith(sep)).toBe(true)
  })
})

describe("★★ 两个 vault 的落点互不相交", () => {
  /**
   * ## 这条断言的形式很重要
   *
   * 不是"逐个字符串不相等"（那太弱：`/x/a` 与 `/x/ab` 不相等但前者是后者的
   * 前缀，一个 `startsWith` 判断就会串）。而是**任一路径都不能是另一个
   * vault 任一路径的前缀**。
   */
  it("A 的任何落点都不是 B 任何落点的前缀，反之亦然", () => {
    const a = vaults.paths("vault-a")
    const b = vaults.paths("vault-b")
    for (const ka of ALL_KEYS) {
      for (const kb of ALL_KEYS) {
        const pa = a[ka]
        const pb = b[kb]
        expect(pa).not.toBe(pb)
        // 加 sep 再判前缀：避免 `/x/vault-a` 与 `/x/vault-ab` 的假阳性
        expect(`${pb}${sep}`.startsWith(`${pa}${sep}`)).toBe(false)
        expect(`${pa}${sep}`.startsWith(`${pb}${sep}`)).toBe(false)
      }
    }
  })

  it("每个落点里都含各自的 vaultId（便于人眼在磁盘上分辨）", () => {
    const a = vaults.paths("vault-a")
    for (const key of ALL_KEYS) expect(a[key]).toContain("vault-a")
  })
})

describe("落点的具体形状（下游注入依赖它）", () => {
  /**
   * ★ `klRoot` 就是算法团队要的 `databaseDir`：上游全部路径都从一个环境
   * 变量（`KL_DATA_DIR`）派生（`knowledge.db` / `qdrant_data` /
   * `extraction_cache` / `entity_dict.txt` 全在它下面），所以按 vault 换
   * 目录**不需要改他们那侧任何代码**。
   */
  it("klRoot 是 vault 下的 kl/（= 注入 KL_DATA_DIR 的那个值）", () => {
    expect(vaults.paths("vault-a").klRoot).toBe(join(root, "vault-a", "kl"))
  })

  it("exportRoot 是 exports/dws（= 注入 KL_DWS_EXPORT_DIR）", () => {
    expect(vaults.paths("vault-a").exportRoot).toBe(join(root, "vault-a", "exports", "dws"))
  })

  /**
   * ★ handoff 一身份一份。
   *
   * 改动前是**一个**应用级路径，于是两个身份共用、谁后挂载谁覆盖 ——
   * 算法团队拿到的永远是"最后一次登录的那个身份"，而这件事在文件里
   * 完全看不出来。
   */
  it("handoffFile 在 vault 内（一身份一份，不再共用一个文件）", () => {
    const a = vaults.paths("vault-a").handoffFile
    const b = vaults.paths("vault-b").handoffFile
    expect(a).toBe(join(root, "vault-a", "handoff.json"))
    expect(a).not.toBe(b)
  })

  /**
   * ★★ 渠道 CLI 的配置目录 —— 身份隔离的主防线。
   * 实测：目录里只 seed 该身份那一条 profile 之后，拿另一个身份的
   * `--profile` 去问会直接 `organization "…" not found`。
   */
  it("dwsHome 在 vault 内（结构性隔离的落点）", () => {
    expect(vaults.paths("vault-a").dwsHome).toBe(
      join(root, "vault-a", "channels", "dingtalk", "dws-home"),
    )
  })

  it("forge 的两个路径与既有实现一致（不能因为改动而漂）", () => {
    const paths = vaults.paths("vault-a")
    expect(paths.forgeRoot).toBe(vaults.forgeRoot("vault-a"))
    expect(paths.skillRoot).toBe(vaults.skillRoot("vault-a"))
    expect(paths.database).toBe(vaults.path("vault-a"))
  })
})
