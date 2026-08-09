/**
 * 本人身份解析。
 *
 * ## 实测的三个坑，决定了算法必须这么绕
 *
 * 1. `contact user get-self` 给权威 `userId`，但**不给** `openDingTalkId`，
 *    而消息里的发送者标识是后者；
 * 2. 消息里本人 sender 显示**花名**（如「小周」），与 `orgUserName`（「高鹏」）不一致；
 * 3. `contact user search "高鹏"` 实测返回 **6 个不同 openDingTalkId**（同名同姓）。
 *
 * 因此：get-self 取 userId → 按姓名 search → **用 userId 精确匹配**挑出本人。
 * 匹配不到唯一记录时**抛错并要求用户手动确认** ——
 * 宁可不蒸馏，也不能把别人的消息当本人语料：画像被污染是**不可逆**的
 * （污染后的结论会作为下一轮的基线继续放大）。
 *
 * ## 为什么姓名绝对不参与判定
 *
 * 见坑 3：同名同姓有 6 个 ID。姓名匹配会造成灾难性误判，
 * 而误判的表现是"数字人说话像另一个人" —— 极难归因到这一步。
 *
 * ## ★ 4. get-self 的真实形状是**数组 + 嵌套对象**
 *
 * 信封剥掉之后 `result` 是一个**数组**，userId 藏在 `[0].orgEmployeeModel` 里：
 *
 * ```json
 * [ { "isAdmin": false,
 *     "orgEmployeeModel": { "userId": "100001", "orgUserName": "高鹏",
 *       "corpId": "dingexampleorgid0001", "orgName": "（公司）" } } ]
 * ```
 *
 * 首版直接读 `self.userId`（根对象）→ 恒为 null → **每次都抛
 * SELF_IDENTITY_AMBIGUOUS**。后果不是"报错很吵"，而是
 * `channel_self_identity` 永远为空 → `is_self` 永远是 null →
 * 蒸馏守卫的 `identity_unconfirmed` **拒掉全部语料**。
 * 也就是说数字人即使接上 UI 也没有任何可蒸馏的数据，而这一步的失败
 * 在采集链路里完全看不见（采集不依赖身份）。
 *
 * ## ★★ 5. 三条路，姓名那条降为最后
 *
 * 上面 §1-3 描述的绕路（按姓名 search → 用 userId 精确挑）**判定是准的**
 * （最终判据是 userId，不是姓名），但**失败率高**：搜不到、花名与实名不一致
 * 搜不着、上游少给一个字段，都会让它抛 `SELF_IDENTITY_AMBIGUOUS`。
 * 而那时用户只能看着一条红字手动处理 —— 未确认期间蒸馏拒掉**全部**语料。
 *
 * 于是加了第二条**完全不碰姓名**的路：**单聊交集**。
 * 单聊定义上只有两人，所以「在我的多个单聊里都出现过的标识」只能是我自己
 * （不存在第三个人同时在我的多个单聊里）。判据与两道自检写在 store 的
 * `inferSelfExternalIdFromDirectChats`；这里只消费它的结果。
 *
 * 现在的顺序：
 *
 * | 路 | 手段 | 靠姓名 | 何时可用 |
 * |---|---|---|---|
 * | 1 | `get-self` 直接给 openDingTalkId | 否 | 偶尔（实测通常不给） |
 * | 2 | 单聊交集 | **否** | 有 ≥2 个双方都发过言的单聊 |
 * | 3 | `search` + userId 精确匹配 | 是（仅作检索词） | 首次授权、库为空时 |
 *
 * ★ 路 2 **不是** 路 3 的替代品：首次授权那一刻库里还没有消息，那时只有
 * 路 3 可用。它是兜底 —— 好在采集不依赖身份（照常跑），所以等用户看到
 * 那条红字时库里通常已经有消息了，这正是路 2 能救回的场景。
 *
 * ★★ 两条路都有结论时**交叉校验**：不一致就抛错，不挑一个。
 * 这比从前严格 —— 从前 search 给出唯一匹配就直接采用，没有任何第二来源
 * 能证伪它。而 50% 概率把别人的消息当本人语料，代价是不可逆的画像污染。
 */
import { AppError } from "@mycontext/kernel"
import type { DwsCli } from "./cli.js"

export interface ResolvedSelfIdentity {
  userId: string
  /** 消息里用的标识（可能多个） */
  openIds: { kind: string; value: string }[]
  /** 仅用于展示与人工确认，**不参与判定** */
  displayNames: string[]
  corpId: string | null
  corpName: string | null
  /**
   * 这次的 openId 是从哪条路得来的。只用于日志与诊断，**不参与任何判定**。
   *
   * 三条路的可靠性不同（`direct-chat-intersection` 是结构推断、
   * `search` 依赖姓名检索），出问题时第一个要问的就是"这次走的哪条"。
   */
  source: "get-self" | "search" | "direct-chat-intersection"
}

/**
 * 从库里的单聊反推本人标识 —— `resolveSelf` 的**兜底与交叉校验**来源。
 *
 * ## ★ 为什么是注入的回调，而不是直接查库
 *
 * 分层：`@mycontext/channels`（L2）**不能**依赖 `@mycontext/store`（L3）。
 * 而这条推断本质是一句 SQL（见 store 的 `inferSelfExternalIdFromDirectChats`，
 * 那里有完整的判据说明）。所以由上层把结果喂进来，这里只消费一个字符串。
 *
 * 返回 `null` = 推不出来（单聊不足 / 交集不唯一 / 库还是空的）。
 * **不抛** —— 推不出来是正常状态，调用方要能继续走其它路。
 */
export type InferSelfFromMessages = () => string | null

interface GetSelfPayload {
  userId?: unknown
  user_id?: unknown
  orgUserName?: unknown
  org_user_name?: unknown
  nick?: unknown
  nickname?: unknown
  corpId?: unknown
  corp_id?: unknown
  corpName?: unknown
  corp_name?: unknown
  /** 实测 get-self **不返回**这个（所以才要走 search）；有就直接用。 */
  openDingTalkId?: unknown
  open_dingtalk_id?: unknown
  /** 组织名。实测在 orgEmployeeModel 里叫 orgName（不叫 corpName） */
  orgName?: unknown
  org_name?: unknown
  flowerName?: unknown
  flower_name?: unknown
}

interface SearchCandidate {
  userId?: unknown
  user_id?: unknown
  openDingTalkId?: unknown
  open_dingtalk_id?: unknown
  name?: unknown
  nick?: unknown
  /** 花名。实测本人在群里显示的就是它，@ 的形态是 `@真名(花名)` */
  flowerName?: unknown
  flower_name?: unknown
}

function str(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return null
}

/**
 * 把 `get-self` 的响应压平成一个字段包。
 *
 * 实测形状：`result` 是数组，业务字段在 `[0].orgEmployeeModel` 里
 * （见文件头 §4）。同时兼容"字段直接在根上"的形态 —— 不同版本/命令可能不同，
 * 而少解析出一个字段的表现是静默失败。
 */
function flattenSelfPayload(payload: unknown): GetSelfPayload {
  const first = Array.isArray(payload) ? payload[0] : payload
  if (typeof first !== "object" || first === null) return {}
  const record = first as Record<string, unknown>
  const nested = record["orgEmployeeModel"] ?? record["org_employee_model"]
  if (typeof nested === "object" && nested !== null) {
    // 嵌套优先：真名/corpId 都在里面。外层的字段作为兜底合并进来。
    return { ...record, ...(nested as Record<string, unknown>) } as GetSelfPayload
  }
  return record as GetSelfPayload
}

/**
 * 候选列表可能是数组、`{items:[]}`、`{users:[]}`、`{data:{list:[]}}` —— 都试一遍。
 *
 * 实测 `contact user search` 剥掉信封后 `result` **直接是数组**，
 * 所以第一行的 `Array.isArray` 就命中了。保留其余候选键给别的形态。
 */
function toCandidateArray(payload: unknown): SearchCandidate[] {
  if (Array.isArray(payload)) return payload as SearchCandidate[]
  if (typeof payload !== "object" || payload === null) return []
  const record = payload as Record<string, unknown>
  for (const key of ["items", "users", "list", "records", "data"]) {
    const value = record[key]
    if (Array.isArray(value)) return value as SearchCandidate[]
    if (typeof value === "object" && value !== null) {
      const nested = toCandidateArray(value)
      if (nested.length > 0) return nested
    }
  }
  return []
}

/**
 * 「拿不到 `get-self` 时，从授权态里取本人身份」的注入点。
 *
 * 返回 null = 也拿不到（未授权 / 字段缺失），那时 `resolveSelf` 才抛。
 *
 * ★ 为什么是注入而不是在这里直接调 `auth status`：这个模块只拿到 `cli`，
 * 而解析授权态是 `DingTalkAuth` 的职责（它还管 profile 钉住与状态归类）。
 * 让身份模块自己再解析一遍等于把那段逻辑抄第二份。
 */
export type AuthIdentityFallback = () => Promise<{
  userId: string
  userName: string | null
  corpId: string | null
  corpName: string | null
} | null>

/**
 * 读本人档案：先 `get-self`，失败退到授权态。
 *
 * ★ 两者的字段形状不同，所以统一压成 `flattenSelfPayload` 的产物形态
 * （`userId` / `orgUserName` / `corpId` / `corpName`），让下游一视同仁。
 *
 * ★ `get-self` 仍然**优先**：它可能带 `openDingTalkId` 与花名，
 * 而授权态只有 userId 与真名。退路是为了"总比整条链断掉好"，
 * 不是为了省一次调用。
 */
async function readSelfProfile(
  cli: Pick<DwsCli, "json">,
  channelId: string,
  authIdentity: AuthIdentityFallback | undefined,
): Promise<GetSelfPayload> {
  try {
    return flattenSelfPayload(
      await cli.json<unknown>(["contact", "user", "get-self"], { establishingIdentity: true }),
    )
  } catch (error) {
    if (authIdentity === undefined) throw error
    const fromAuth = await authIdentity()
    /**
     * 退路也拿不到 → 把**原来那个错**抛出去，而不是换成一句
     * "无法获取本人 userId"。前者带着服务端的真实原因
     * （`ENTERPRISE_NOT_AUTHORIZED` → "请在设置里换一份客户端"），
     * 后者会把用户引向"是不是我名字有问题"。
     */
    if (fromAuth === null) throw error
    return {
      userId: fromAuth.userId,
      orgUserName: fromAuth.userName,
      corpId: fromAuth.corpId,
      corpName: fromAuth.corpName,
      // ★ 刻意不造 openDingTalkId：授权态里没有它，编一个会让下游
      //   以为拿到了真值。缺它时后面两条兜底路会去推断（那才是对的）。
    }
  }
}

/**
 * 跑 `contact user search`；**失败不抛，返回空数组**。
 *
 * ## ★★ 为什么只吞异常，而**不是**"路 2 有结论就跳过"
 *
 * 我第一版写成"`inferred !== null` 就直接 return []"，理由是"已经有答案了，
 * 何必冒没权限的风险"。那是错的，而现有测试当场驳回了它：
 * search 与单聊交集是**两条独立判据**，两者一致才采用、冲突就抛错
 * （见文件头 §5 与 `resolveSelf` 里的交叉校验）。跳过 search 等于把
 * 那道交叉校验废掉 —— 而它防的是"把别人的消息当本人语料"，
 * 那种污染是不可逆的。
 *
 * 所以正确做法是**照常调**，只把"调不通"与"调通了但没结论"合并处理：
 *
 * · 有权限 → 照旧交叉校验（安全性不变）；
 * · 没权限（实测 `contact/search_contact_by_key_word` 报
 *   `ENTERPRISE_NOT_AUTHORIZED`）→ 视作"这条路没结论"，
 *   让下游用 `inferred` 兜底，而不是让整条链断掉。
 *
 * ★ search 是三条路里最不可靠的一条（靠姓名当检索词），
 * 它挂掉不该比它不存在更糟。
 */
async function searchCandidatesOrEmpty(
  cli: Pick<DwsCli, "json">,
  orgName: string,
): Promise<unknown> {
  try {
    return await cli.json<unknown>(["contact", "user", "search", "--query", orgName], {
      establishingIdentity: true,
    })
  } catch {
    return []
  }
}

/**
 * 解析本人身份。
 *
 * ## 三条路，按可靠性排序（详见文件头 §5）
 *
 * 1. `get-self` 直接给 `openDingTalkId` —— 最快，但实测通常不给；
 * 2. **单聊交集**（`options.inferFromMessages`）—— 纯结构推断，不碰姓名；
 * 3. `contact user search` + userId 精确匹配 —— 要靠姓名当检索词，失败率高。
 *
 * ★ 2 与 3 都成功时**交叉校验**：两条独立的路得出同一个标识才采用，
 * 冲突则抛错。这比只信任一条更安全（见文件头 §5）。
 *
 * @throws AppError(SELF_IDENTITY_AMBIGUOUS) 三条路都没能唯一确定标识时。
 */
export async function resolveSelf(
  cli: Pick<DwsCli, "json">,
  channelId = "dingtalk",
  options: { inferFromMessages?: InferSelfFromMessages; authIdentity?: AuthIdentityFallback } = {},
): Promise<ResolvedSelfIdentity> {
  /**
   * ★ 必须压平：真实形状是数组 + orgEmployeeModel 嵌套（见文件头 §4）。
   *
   * ★★ `establishingIdentity` —— 这一条与下面那条 `search` 是「**确定我是谁**」
   * 本身，所以要显式解除 `DwsCli` 那道"必须先有身份"的前置（见 cli.ts 里
   * 那段注释）。不传的话「用这个身份」/首次授权后的自动确认会被自己的
   * 守卫拦掉，而上层 catch 把异常吞掉 —— 表现是"点了没反应"。
   *
   * ## ★★ `get-self` 失败**不再是致命的** —— 这是一次实测过的死锁
   *
   * 实测（用户日志 2026-08-09）：随包那份客户端对某企业的 `contact` 域没开通，
   * `contact/get_current_user_profile` 报 `ENTERPRISE_NOT_AUTHORIZED`。
   * 而它原本是**硬前置**（抛出即整个函数结束），于是：
   *
   *     点「用这个身份」→ resolveSelf → get-self 被服务端拒
   *       → 抛错 → 后面两条兜底路（单聊交集 / search）一条都到不了
   *       → 身份行永远写不成 → 引导页那两句提示永远不消失
   *
   * ★ 关键是**这一步要的东西 `auth status` 已经有了**：
   * 它返回 `user_id` / `user_name` / `corp_id` / `corp_name`，
   * 而那条命令走的是 auth 域（不需要 contact 权限）——
   * 实测同一份客户端、同一个企业，`auth status` 正常返回。
   *
   * 也就是说我们为了拿一个已经在手边的值，去调了一个可能没权限的接口，
   * 并且让它的失败终止了整条链。所以现在：`get-self` 失败 → 退到
   * `authIdentity()`，拿不到才抛。
   */
  const self = await readSelfProfile(cli, channelId, options.authIdentity)
  const userId = str(self.userId, self.user_id)
  if (userId === null) {
    throw new AppError("SELF_IDENTITY_AMBIGUOUS", "无法从渠道获取本人 userId", {
      messageKey: "errors:byCode.SELF_IDENTITY_AMBIGUOUS",
      context: { channelId },
    })
  }

  const orgName = str(self.orgUserName, self.org_user_name, self.nick, self.nickname)
  // 花名也收：实测本人在群里显示花名，而 @ 的形态是 `@真名(花名)` ——
  // 两种形态都要能命中「@我」判定。
  const displayNames = [
    orgName,
    str(self.nick, self.nickname),
    str(self.flowerName, self.flower_name),
  ].filter((value): value is string => value !== null)

  const corpId = str(self.corpId, self.corp_id)
  const corpName = str(self.corpName, self.corp_name, self.orgName, self.org_name)

  const base = { userId, corpId, corpName }
  const done = (
    openId: string,
    source: ResolvedSelfIdentity["source"],
    extraNames: (string | null)[] = [],
  ): ResolvedSelfIdentity => ({
    ...base,
    openIds: [{ kind: "openDingTalkId", value: openId }],
    displayNames: [
      ...new Set(
        [...displayNames, ...extraNames].filter((value): value is string => value !== null),
      ),
    ],
    source,
  })

  // ── 路 1：get-self 有时直接带 openDingTalkId —— 有就用，省一次 search（也省掉歧义风险）。
  const direct = str(self.openDingTalkId, self.open_dingtalk_id)
  if (direct !== null) return done(direct, "get-self")

  /**
   * ── 路 2：单聊交集。**先于 search 算**，因为它不碰姓名。
   *
   * 即使 search 那条路也能走通，这个结果仍然有用 —— 下面用它交叉校验。
   * 推不出来返回 null（库为空 / 单聊不足 / 交集不唯一），不影响后续。
   */
  const inferred = options.inferFromMessages?.() ?? null

  /**
   * ── 路 3：search。
   *
   * ★ 只在**没有姓名**且路 2 也没结论时才算无从下手 —— 有了路 2，
   * "花名与实名不一致导致搜不着"这类失败不再是死路。
   */
  if (orgName === null) {
    if (inferred !== null) return done(inferred, "direct-chat-intersection")
    throw new AppError("SELF_IDENTITY_AMBIGUOUS", "本人姓名缺失，无法定位消息中使用的标识", {
      messageKey: "errors:byCode.SELF_IDENTITY_AMBIGUOUS",
      context: { channelId, userId },
    })
  }

  const candidates = toCandidateArray(
    // 同 get-self：这是"确定我是谁"的一部分（见那里的注释）
    await searchCandidatesOrEmpty(cli, orgName),
  )

  // ★ 只按 userId 精确匹配。姓名相同的候选实测有 6 个。
  const matched = candidates.filter(
    (candidate) => str(candidate.userId, candidate.user_id) === userId,
  )

  // search 结果里的 name / nick / flowerName 都收进显示名 ——
  // 实测 `{name:"高鹏", nick:"小周", flowerName:"知白"}` 三种形态都可能出现在 @ 里。
  const first = matched.length === 1 ? matched[0] : undefined
  const searchOpenId =
    first === undefined ? null : str(first.openDingTalkId, first.open_dingtalk_id)
  const candidateNames =
    first === undefined
      ? []
      : [str(first.name), str(first.nick), str(first.flowerName, first.flower_name)]

  /**
   * ★★ 两条路都有结论 → **必须一致**，否则抛错。
   *
   * 不一致意味着有一条是错的，而我们无从知道是哪条。此时"挑一个"等于
   * 有 50% 概率把别人的消息当本人语料 —— 而画像污染是**不可逆**的
   * （污染后的结论会作为下一轮的基线继续放大）。所以宁可挡住，让用户确认。
   *
   * 这一档比"只信 search"严格：从前 search 给出唯一匹配就直接采用，
   * 没有任何第二来源能证伪它。
   */
  if (searchOpenId !== null && inferred !== null && searchOpenId !== inferred) {
    throw new AppError(
      "SELF_IDENTITY_AMBIGUOUS",
      "两条独立判据得出的本人标识不一致，需要人工确认身份",
      {
        messageKey: "errors:byCode.SELF_IDENTITY_AMBIGUOUS",
        // ★ 不记 openId 本身（是标识符，不进日志）——只记"冲突了"这个事实。
        context: { channelId, userId, conflict: "search-vs-direct-chats" },
      },
    )
  }

  // 一致，或只有 search 有结论 → 采用 search（它顺带带回花名）。
  if (searchOpenId !== null) return done(searchOpenId, "search", candidateNames)

  // search 没结论 → 用路 2 兜底。这是本次改动救回的主要场景。
  if (inferred !== null) return done(inferred, "direct-chat-intersection")

  /**
   * 三条路都没结论 → 抛错要求人工确认。
   *
   * 分成两句是为了让日志能区分"搜出来一堆但没一个是我"与"搜到我了但那条
   * 记录缺 openDingTalkId" —— 前者是同名歧义，后者是上游字段缺失。
   */
  if (first === undefined) {
    throw new AppError(
      "SELF_IDENTITY_AMBIGUOUS",
      `按 userId 精确匹配到 ${String(matched.length)} 条记录（期望 1 条），需要人工确认身份`,
      {
        messageKey: "errors:byCode.SELF_IDENTITY_AMBIGUOUS",
        context: {
          channelId,
          userId,
          candidateCount: candidates.length,
          matchedCount: matched.length,
        },
      },
    )
  }
  throw new AppError("SELF_IDENTITY_AMBIGUOUS", "匹配到本人但缺少消息中使用的标识", {
    messageKey: "errors:byCode.SELF_IDENTITY_AMBIGUOUS",
    context: { channelId, userId },
  })
}
