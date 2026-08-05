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
}

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
 * 解析本人身份。
 *
 * @throws AppError(SELF_IDENTITY_AMBIGUOUS) 当 userId 精确匹配到 0 个或 >1 个候选。
 */
export async function resolveSelf(
  cli: Pick<DwsCli, "json">,
  channelId = "dingtalk",
): Promise<ResolvedSelfIdentity> {
  // ★ 必须压平：真实形状是数组 + orgEmployeeModel 嵌套（见文件头 §4）。
  const self = flattenSelfPayload(await cli.json<unknown>(["contact", "user", "get-self"]))
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

  // get-self 有时直接带 openDingTalkId —— 有就用，省一次 search（也省掉歧义风险）。
  const direct = str(self.openDingTalkId, self.open_dingtalk_id)
  if (direct !== null) {
    return {
      userId,
      openIds: [{ kind: "openDingTalkId", value: direct }],
      displayNames: [...new Set(displayNames)],
      corpId,
      corpName,
    }
  }

  if (orgName === null) {
    throw new AppError("SELF_IDENTITY_AMBIGUOUS", "本人姓名缺失，无法定位消息中使用的标识", {
      messageKey: "errors:byCode.SELF_IDENTITY_AMBIGUOUS",
      context: { channelId, userId },
    })
  }

  const candidates = toCandidateArray(
    await cli.json<unknown>(["contact", "user", "search", "--query", orgName]),
  )

  // ★ 只按 userId 精确匹配。姓名相同的候选实测有 6 个。
  const matched = candidates.filter(
    (candidate) => str(candidate.userId, candidate.user_id) === userId,
  )

  if (matched.length !== 1) {
    throw new AppError(
      "SELF_IDENTITY_AMBIGUOUS",
      `按 userId 精确匹配到 ${matched.length} 条记录（期望 1 条），需要人工确认身份`,
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

  const openId = str(matched[0]?.openDingTalkId, matched[0]?.open_dingtalk_id)
  if (openId === null) {
    throw new AppError("SELF_IDENTITY_AMBIGUOUS", "匹配到本人但缺少消息中使用的标识", {
      messageKey: "errors:byCode.SELF_IDENTITY_AMBIGUOUS",
      context: { channelId, userId },
    })
  }

  // search 结果里的 name / nick / flowerName 都收进显示名 ——
  // 实测 `{name:"高鹏", nick:"小周", flowerName:"知白"}` 三种形态都可能出现在 @ 里。
  const candidateNames = [
    str(matched[0]?.name),
    str(matched[0]?.nick),
    str(matched[0]?.flowerName, matched[0]?.flower_name),
  ]

  return {
    userId,
    openIds: [{ kind: "openDingTalkId", value: openId }],
    displayNames: [
      ...new Set(
        [...displayNames, ...candidateNames].filter((value): value is string => value !== null),
      ),
    ],
    corpId,
    corpName,
  }
}
