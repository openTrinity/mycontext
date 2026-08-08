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

/**
 * 我们写入时用的 `profiles.json` 版本号。
 *
 * ## ★ 写 1 是**故意**的，即使当前 CLI 用的是 v2
 *
 * 实测（v1.0.56 / v1.0.57，2026-08-08）：往目录里放一份 `version: 1` 的
 * seed，跑一次 `auth status` 之后 CLI **就地把它升级成 v2** 并补上
 * `orgCurrentProfiles`，profile 条目也被补成 `{corpId, name, status, userId}`
 * —— 而我们 seed 的那一条身份**没被改动**，`authenticated: true` 正常返回。
 *
 * 也就是说版本号由上游负责迁移，我们跟着写高版本反而有风险：
 * v2 的 `orgCurrentProfiles` 我们并不知道该填什么（它是"每个组织当前用哪个
 * 身份"的映射），瞎填一个会让 CLI 拿着我们编的值去寻址。写最小的 v1
 * 让上游自己补齐，是这里唯一**不需要我们理解 v2 语义**的写法。
 *
 * ⚠️ 如果哪天上游不再接受 v1，症状是 seed 后 `auth status` 变成未登录 ——
 * 那时要重新实测再决定写什么，不要照抄这段注释。
 */
const PROFILES_VERSION = 1

/**
 * `profiles.json` 里**指针字段**（`primaryProfile` / `currentProfile`）的写法。
 *
 * 用 `corpId:userId` —— 实测真实文件（CLI 自己写的那份）就是这个形状。
 *
 * ## ★ 这与命令行 `--profile` 是**两件事**，别顺手统一
 *
 * `--profile` 的形态见 `active-identity.service.ts` 的 `CHANNEL_PROFILE_FORM`
 * （那里记的是裸 corpId，附了当时的实测）。这里是**文件内容**，那里是
 * **命令行参数**；即使两者恰好长得一样，它们的正确性也由不同的东西保证,
 * 改一处不代表另一处跟着变。
 *
 * ⚠️ 关于 `--profile` 两种形态的差异：2026-08-08 在 v1.0.56 上重测,
 * 裸 corpId 与 `corpId:userId` 在 `auth status` 与 `contact user get-self`
 * 上**表现相同**（都能定位到身份）,也就是说 442a605 记录的那个差异
 * 在当前版本上已经复现不出来了。所以**不要**依赖"哪种形态才对"这个结论 ——
 * 要改动 `--profile` 的拼法时重新实测（CLAUDE.md §4：注释里的实测有保质期）。
 */
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
 *
 * ## ★★ 「只有一条」是**我们的**要求，不是渠道 CLI 的限制
 *
 * 渠道 CLI 本身**允许一个配置目录里有多个 profile**（多组织/多身份是它的
 * 正常能力，`profile list` 就是为此存在的）。这里要求 `length === 1` 是
 * 因为**我们**给每个 vault 一个目录、一个身份 —— 目录即隔离边界。
 *
 * 这个区别有实际后果，别读反：
 * · 在**我们的** dws-home 里看到两条 profile → 说明 seed 没跑过或被绕过了,
 *   要修的是 seed 的调用时机,不是去删用户的 profile；
 * · 在**用户自己的** dws-home（终端里那个）里有多条 → 完全正常,
 *   不要去"纠正"它。我们只管自己那份。
 *
 * 实测踩到过的真实场景（2026-08-08）：引导还没走完时 vault 尚未绑身份,
 * `startup.ts` 那处 seed 因此**不执行**,于是目录里留着 CLI 自己重建的
 * 双 profile 文件（两个组织）。那时再 `auth login` 会被上游以
 * `refusing to overwrite a potentially unique old login` 拒绝 ——
 * 症状是界面上「授权流程结束但未检测到有效登录态」,而根因与"检测"无关。
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
