/**
 * 把一个 vault 的渠道配置目录**钉死在一个身份**上（seed `profiles.json`）。
 *
 * ## ★★ 这是身份隔离的**主防线**，比 `--profile` 强
 *
 * 渠道 CLI 用 `DWS_CONFIG_DIR` 指向的目录里的 `profiles.json` 决定
 * 「本机有哪些身份、当前用哪个」。给每个 vault 一份**只含它那一个身份**的
 * profiles 之后，越权读取变成**结构性不可能** —— 实测在只 seed 组织甲的
 * 目录里拿组织乙的 `--profile` 去问，直接
 * `organization "…" not found`。
 *
 * 对比 `--profile` 钉住：那只是"我们记得传"。漏一处（而这个仓库有**三条**
 * 独立的起进程路径）就是一次泄漏。两道一起上，与 `vault.ts` 文件头那条
 * 推理同构：隔离靠文件系统，不靠每处调用都自觉。
 *
 * ## ★ 为什么必须**显式 seed**，不能只建一个空目录
 *
 * 实测：全新空目录跑 `auth status` 会返回 `authenticated: true` ——
 * 因为 token 的密钥在系统钥匙串里（不在这个目录），CLI 会就地重建一份
 * `profiles.json`。但它重建出来的是**钥匙串里那个全局 current**，
 * 而那个值会被用户在终端里改掉。也就是说"建个空目录"会把这次要修的
 * 问题原样搬进新目录。
 *
 * ## ★ seed 只需要三个字段（实测）
 *
 * ```
 * 写入 {corpId, userId, clientId} + primaryProfile/currentProfile
 *   → auth status 返回 authenticated=true，且
 *     corp_id / corp_name / user_id / user_name / refresh_expires_at 全部非空
 *   → 也就是 parseAuthStatus 要求的 5 个必需字段都齐，判定 authorized
 * ```
 * 组织名、真名、有效期**不用我们写** —— CLI 自己从钥匙串里的 token 补齐
 * （seed 之后再读那个文件，我们写的三个字段一个没多）。
 *
 * ★ **不复制 token**：它在钥匙串里，本来就复制不了，也不该复制。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** seed 一个身份所需的最小信息。 */
export interface ChannelProfileSeed {
  corpId: string
  userId: string
  /**
   * OAuth 客户端 id（上游 `clientId`）。
   *
   * 可空：首次授权前我们可能还不知道它。缺它时 CLI 用自己的默认值 ——
   * 实测仍能解析出身份，所以不值得为它把整条 seed 拦下来。
   */
  clientId?: string | undefined
}

/** `profiles.json` 里我们会写的那几个字段（其余由 CLI 自己补齐）。 */
interface ProfilesFile {
  version: number
  primaryProfile: string
  currentProfile: string
  previousProfile?: string
  profiles: { corpId: string; userId: string; clientId?: string }[]
}

/** 上游当前的 `profiles.json` 版本号（实测 v1）。 */
const PROFILES_VERSION = 1

/** 身份的寻址形态。与 `--profile` 用的是同一种写法（上游 `--help` 推荐）。 */
function profileId(seed: ChannelProfileSeed): string {
  return `${seed.corpId}:${seed.userId}`
}

/**
 * 把 `dwsHome` seed 成"只认这一个身份"。
 *
 * 幂等：已经是这个身份就不重写（避免每次挂载都动一次文件 ——
 * CLI 可能正拿着它，而且无谓的写入会让"什么时候被改过"这条线索失真）。
 *
 * ★ 只在**内容需要变**时写。判据是我们关心的那三个字段，
 * 不比整个文件 —— CLI 会往里补 `corpName`/`status`/时间戳等字段，
 * 逐字节比对会让每次挂载都判成"要重写"，把它自己补的东西反复擦掉。
 *
 * @returns 是否真的写了（供日志与测试断言）
 */
export function seedChannelProfile(dwsHome: string, seed: ChannelProfileSeed): boolean {
  const target = profileId(seed)
  const file = join(dwsHome, "profiles.json")

  if (matchesSeed(file, seed)) return false

  mkdirSync(dwsHome, { recursive: true })
  const next: ProfilesFile = {
    version: PROFILES_VERSION,
    primaryProfile: target,
    currentProfile: target,
    previousProfile: target,
    profiles: [
      {
        corpId: seed.corpId,
        userId: seed.userId,
        ...(seed.clientId === undefined || seed.clientId === "" ? {} : { clientId: seed.clientId }),
      },
    ],
  }
  /**
   * 权限收紧到 600：这个文件里是身份标识（corpId/userId）。
   * 不是凭据（token 在钥匙串），但也没有任何理由让同机其他用户读到。
   */
  writeFileSync(file, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 })
  return true
}

/**
 * 现有文件是否已经**恰好只认**这一个身份。
 *
 * 三条都要成立：只有一个 profile 条目、它是目标身份、两个指针都指向它。
 * 少判任何一条都会让"多了一个身份"或"指针指着别人"这种状态被当成 OK ——
 * 而那正是隔离失效的样子。
 */
function matchesSeed(file: string, seed: ChannelProfileSeed): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    // 不存在 / 坏了 / 不是 JSON → 一律重写（这不是错误，是首次或需要修复）
    return false
  }
  if (typeof parsed !== "object" || parsed === null) return false
  const current = parsed as Partial<ProfilesFile>
  const entries = Array.isArray(current.profiles) ? current.profiles : []
  if (entries.length !== 1) return false
  const only = entries[0]
  if (only === undefined) return false
  if (only.corpId !== seed.corpId || only.userId !== seed.userId) return false
  const target = profileId(seed)
  return current.primaryProfile === target && current.currentProfile === target
}
