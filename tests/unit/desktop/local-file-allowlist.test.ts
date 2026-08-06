/**
 * `mycontext-file://` 的白名单判定。
 *
 * ## 这一组锁的是一个**已经真实发生过**的静默失效
 *
 * 媒体与头像改成按 vault 隔离（`vaults/<id>/{media,avatars}`）之后，
 * 这个白名单没跟着改 —— 于是新下载的图片全部 403，而**老图仍然正常**
 * （它们还在旧的应用级目录下、仍被放行）。
 *
 * 表现是"图片突然坏了一部分"，而这是最难查的形态：
 * · `Avatar` / `<img>` 的 onError 会静默回退到兜底，界面看起来像"没做"；
 * · 部分正常会让人以为是"某些图下载失败"而去查采集，方向完全错。
 * 实测一次会话 191 条 `local file blocked`。
 *
 * 而这段判定原来**内联在 `protocol.handle` 的回调里**，也就是没法测 ——
 * 要测就得起一个 Electron。所以先提成纯函数，再锁两件事：
 * ① vault 内的媒体必须放行（那是这次的回归）；
 * ② 路径穿越必须挡住（那是白名单存在的**原本**理由，不能为了①放宽掉）。
 */
import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { normalizeAllowedRoots, resolveAllowedPath } from "@main/windows/local-file-protocol.js"

/** 照真实布局造：vaults 根 + 三个旧的应用级目录。 */
const USER_DATA = "/tmp/mycontext-test-userdata"
const VAULTS_ROOT = join(USER_DATA, "vaults")
const ROOTS = normalizeAllowedRoots(VAULTS_ROOT, [
  join(USER_DATA, "avatars"),
  join(USER_DATA, "media"),
  join(USER_DATA, "uploads"),
])

const VAULT_ID = "1f167422-a5c0-41a5-993c-fb7a673fa937"

describe("★★ vault 内的媒体必须放行（这次的回归）", () => {
  /**
   * ★★ 这三条是那个 bug 的直接反面。
   *
   * 媒体/头像/上传按 vault 分之后落在 `vaults/<id>/…` 下，
   * 而白名单原来只有 `<userData>/{avatars,media,uploads}`。
   */
  it.each([
    ["消息里的图片", join(VAULTS_ROOT, VAULT_ID, "media", "7d88e4ae784b97de")],
    ["联系人头像", join(VAULTS_ROOT, VAULT_ID, "avatars", "0b13ad7f7.jpg")],
    ["用户上传的形象", join(VAULTS_ROOT, VAULT_ID, "uploads", "figure", "a.png")],
  ])("%s 放行", (_label, path) => {
    expect(resolveAllowedPath(ROOTS, path)).toBe(path)
  })

  /**
   * ★ 另一个 vault 的媒体也放行 —— 这是刻意的，不是漏网。
   *
   * 白名单是**启动时**注册一次的（协议必须在建窗口之前注册），而"挂哪个
   * vault"是登录/切身份时才知道的。逐 vault 列举需要每次挂载重注册协议，
   * 而那不是 `protocol.handle` 的用法。
   *
   * 实际暴露面是"本应用自己的全部 vault 目录"，而真正要挡的是"跳出应用
   * 数据目录"—— 那道防线在下面那组穿越测试里。
   */
  it("另一个 vault 的媒体同样放行（白名单是启动时定的，见注释）", () => {
    const other = join(VAULTS_ROOT, "another-vault-id", "media", "x")
    expect(resolveAllowedPath(ROOTS, other)).toBe(other)
  })
})

describe("旧的应用级目录仍要放行（存量绝对路径）", () => {
  /**
   * ★ 库里存的是**绝对路径**（`media_assets.path` /
   * `contact_avatars.local_path`），所以迁移刻意没搬这两个目录 ——
   * 搬了那些行就全部失效，而失效的表现是"图片永久显示不出来"。
   *
   * 也就是说这三条**不能删**，直到存量自然淘汰。
   */
  it.each([
    ["旧媒体", join(USER_DATA, "media", "abc")],
    ["旧头像", join(USER_DATA, "avatars", "def.jpg")],
    ["旧上传", join(USER_DATA, "uploads", "self", "x.png")],
  ])("%s 放行", (_label, path) => {
    expect(resolveAllowedPath(ROOTS, path)).toBe(path)
  })
})

describe("★★ 路径穿越必须挡住（白名单存在的原本理由）", () => {
  /**
   * ★★ 为了修上面那个回归而放宽白名单时，**不能**把这道一起放宽。
   *
   * 判据是 `resolve` 之后再比前缀：不 resolve 的话下面这个串确实以
   * `…/vaults/` 开头，会通过检查，而 `net.fetch` 会老老实实把
   * /etc/passwd 读出来。
   */
  it("★★ `..` 跳出 vaults 根 → 拒", () => {
    const evil = join(VAULTS_ROOT, VAULT_ID, "media", "..", "..", "..", "..", "etc", "passwd")
    expect(resolveAllowedPath(ROOTS, evil)).toBeNull()
  })

  it("完全在白名单之外 → 拒", () => {
    expect(resolveAllowedPath(ROOTS, "/etc/passwd")).toBeNull()
    expect(resolveAllowedPath(ROOTS, join(USER_DATA, "control.sqlite"))).toBeNull()
  })

  /**
   * ★ 同前缀的**兄弟目录**要挡住 —— 这条锁的是"末尾补分隔符"那件事。
   *
   * 没补的话 `/…/vaults-evil/x` 会被 `/…/vaults` 前缀命中。
   */
  it("★ 同名前缀的兄弟目录 → 拒（末尾分隔符那道）", () => {
    expect(resolveAllowedPath(ROOTS, `${VAULTS_ROOT}-evil/x.jpg`)).toBeNull()
    expect(resolveAllowedPath(ROOTS, `${join(USER_DATA, "media")}-evil/x.jpg`)).toBeNull()
  })

  /**
   * ★ 数据库本身绝不能被渲染层读到。
   *
   * 它就在 vault 目录里、与 media 平级 —— 放行整个 vaults 根之后
   * 这条尤其要钉住：`core.sqlite` 不在 media/avatars/uploads 之下，
   * 但它**在 vaults 根之下**。
   */
  /**
   * ★★ 业务库绝不能被渲染层读到 —— 而它就在 vault 目录里、与 media 平级。
   *
   * 这条是"放行 vaults 根"那个决定的必要配套：只放行根而不加形状约束的话，
   * 渲染层拼一个 `mycontext-file://…/vaults/<id>/core.sqlite` 就能把整个
   * 业务库（会话、消息、画像）拖走 —— 而那**没有任何症状**，
   * 图片照常显示。
   *
   * 所以 vaults 根那条规则带 `mediaOnly`：第二段必须是
   * media/avatars/uploads 之一。
   */
  it.each([
    ["业务库", join(VAULTS_ROOT, VAULT_ID, "core.sqlite")],
    ["图谱库", join(VAULTS_ROOT, VAULT_ID, "kl", "knowledge.db")],
    ["四件套导出", join(VAULTS_ROOT, VAULT_ID, "exports", "dws", "chat", "records.jsonl")],
    [
      "渠道配置目录",
      join(VAULTS_ROOT, VAULT_ID, "channels", "dingtalk", "dws-home", "profiles.json"),
    ],
    ["vault 根下的裸文件", join(VAULTS_ROOT, VAULT_ID, "handoff.json")],
  ])("★★ %s 在 vaults 根之下但**不可读**（mediaOnly 那道）", (_label, path) => {
    expect(resolveAllowedPath(ROOTS, path)).toBeNull()
  })
})
