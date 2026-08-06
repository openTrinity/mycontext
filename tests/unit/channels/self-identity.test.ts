/**
 * 本人身份歧义拒绝。
 *
 * 这是 R3（本人身份误判）的唯一防线：把别人的消息当本人语料会让画像
 * **从根上错**，而且**不可逆** —— 污染后的结论会作为下一轮的基线继续放大。
 *
 * 核心断言：喂 5 个同名不同 ID 的候选，只有 userId 精确匹配的被选中；
 * 0 个或 2 个匹配时抛 SELF_IDENTITY_AMBIGUOUS 而不是"挑第一个"。
 */
import { describe, expect, it } from "vitest"
import { resolveSelf } from "@mycontext/channels"
import { isAppError } from "@mycontext/kernel"

/** 实测形态：同名同姓返回 5+ 个不同 openDingTalkId。 */
const FIVE_SAME_NAME = [
  { userId: "111", openDingTalkId: "DeAAA", name: "王强" },
  { userId: "222", openDingTalkId: "DeBBB", name: "王强" },
  { userId: "100001", openDingTalkId: "DeMINE", name: "王强" },
  { userId: "333", openDingTalkId: "DeCCC", name: "王强" },
  { userId: "444", openDingTalkId: "DeDDD", name: "王强" },
]

/** 只实现 json()：resolveSelf 的依赖就是这一个方法。 */
function fakeCli(responses: { getSelf: unknown; search?: unknown }) {
  const calls: string[][] = []
  return {
    calls,
    json: <T>(args: readonly string[]): Promise<T> => {
      calls.push([...args])
      if (args.includes("get-self")) return Promise.resolve(responses.getSelf as T)
      if (args.includes("search")) return Promise.resolve((responses.search ?? []) as T)
      throw new Error(`未预期的命令：${args.join(" ")}`)
    },
  }
}

describe("按 userId 精确匹配", () => {
  it("5 个同名候选里只选 userId 相同的那个", async () => {
    const cli = fakeCli({
      getSelf: { userId: "100001", orgUserName: "王强", corpName: "某公司" },
      search: FIVE_SAME_NAME,
    })
    const identity = await resolveSelf(cli)
    expect(identity.userId).toBe("100001")
    expect(identity.openIds).toEqual([{ kind: "openDingTalkId", value: "DeMINE" }])
  })

  it("get-self 直接带标识时不再 search（省一次调用也省掉歧义风险）", async () => {
    const cli = fakeCli({
      getSelf: { userId: "100001", orgUserName: "王强", openDingTalkId: "DeDIRECT" },
    })
    const identity = await resolveSelf(cli)
    expect(identity.openIds).toEqual([{ kind: "openDingTalkId", value: "DeDIRECT" }])
    expect(cli.calls.some((args) => args.includes("search"))).toBe(false)
  })

  it("显示名收集起来供人工确认，但不参与判定", async () => {
    const cli = fakeCli({
      // 实测：本人在群里显示花名「小周」，与 orgUserName「王强」不一致
      getSelf: { userId: "100001", orgUserName: "王强", nick: "小王" },
      search: FIVE_SAME_NAME,
    })
    const identity = await resolveSelf(cli)
    expect(identity.displayNames).toContain("王强")
    expect(identity.displayNames).toContain("小王")
  })
})

describe("歧义时拒绝（宁可不蒸馏，也不能污染画像）", () => {
  async function expectAmbiguous(responses: { getSelf: unknown; search?: unknown }) {
    try {
      await resolveSelf(fakeCli(responses))
      expect.unreachable("应当抛 SELF_IDENTITY_AMBIGUOUS")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) expect(error.code).toBe("SELF_IDENTITY_AMBIGUOUS")
    }
  }

  it("0 个匹配 → 抛错（不是退回到第一个候选）", async () => {
    await expectAmbiguous({
      getSelf: { userId: "not-in-list", orgUserName: "王强" },
      search: FIVE_SAME_NAME,
    })
  })

  it("2 个匹配 → 抛错（数据异常，不猜）", async () => {
    await expectAmbiguous({
      getSelf: { userId: "dup", orgUserName: "王强" },
      search: [
        { userId: "dup", openDingTalkId: "DeA", name: "王强" },
        { userId: "dup", openDingTalkId: "DeB", name: "王强" },
      ],
    })
  })

  it("search 返回空 → 抛错", async () => {
    await expectAmbiguous({ getSelf: { userId: "100001", orgUserName: "王强" }, search: [] })
  })

  it("get-self 无 userId → 抛错（没有权威标识就不该继续）", async () => {
    await expectAmbiguous({ getSelf: { orgUserName: "王强" } })
  })

  it("无姓名且无直接标识 → 抛错（无从定位）", async () => {
    await expectAmbiguous({ getSelf: { userId: "100001" } })
  })

  it("匹配到本人但缺 openDingTalkId → 抛错（缺的正是消息里用的那个标识）", async () => {
    await expectAmbiguous({
      getSelf: { userId: "100001", orgUserName: "王强" },
      search: [{ userId: "100001", name: "王强" }],
    })
  })
})

describe("候选列表的多种包装形态都能解开", () => {
  it.each([
    ["数组", FIVE_SAME_NAME],
    ["{items}", { items: FIVE_SAME_NAME }],
    ["{users}", { users: FIVE_SAME_NAME }],
    ["{data:{list}}", { data: { list: FIVE_SAME_NAME } }],
  ])("%s", async (_label, search) => {
    const identity = await resolveSelf(
      fakeCli({ getSelf: { userId: "100001", orgUserName: "王强" }, search }),
    )
    expect(identity.openIds[0]?.value).toBe("DeMINE")
  })
})

/**
 * ★★ 真实响应形状：`result` 是**数组**，业务字段在 `[0].orgEmployeeModel` 里。
 *
 * 上面那些用例喂的是**压平后**的形状（字段直接在根上），它们测的是
 * 「消歧算法对不对」—— 那层价值仍然有效。
 *
 * 这一组测的是**另一件事**：真实响应长什么样。首版直接读 `self.userId`
 * （根对象）→ 恒为 null → 每次都抛 SELF_IDENTITY_AMBIGUOUS →
 * `channel_self_identity` 永远为空 → `is_self` 恒为 null →
 * 蒸馏守卫的 `identity_unconfirmed` **拒掉全部语料**。
 *
 * 而这个失败在采集链路里完全看不见（采集不依赖身份），所以必须单独测。
 */
/**
 * 真实的嵌套 get-self 响应，与配套的 search 结果。
 *
 * ★ 提到 describe 外面是因为下面「单聊交集」那一组也要用它们做交叉校验 ——
 * 而交叉校验必须拿**真实形状**测，用压平后的假形状测等于绕开了那个坑。
 */
const NESTED_SELF = [
  {
    isAdmin: false,
    orgEmployeeModel: {
      corpId: "dingexampleorgid0001",
      orgName: "示例集团",
      orgUserName: "王强",
      userId: "100001",
    },
  },
]

const SEARCH_WITH_FLOWER = [
  {
    flowerName: "澄一",
    name: "王强",
    nick: "小王",
    openDingTalkId: "DeMINE",
    userId: "100001",
  },
  { name: "王强", openDingTalkId: "DeOTHER", userId: "999" },
]

describe("★★ 真实的嵌套响应形状（orgEmployeeModel）", () => {
  it("从 result[0].orgEmployeeModel 里取到 userId（首版在这里必然失败）", async () => {
    const identity = await resolveSelf(
      fakeCli({ getSelf: NESTED_SELF, search: SEARCH_WITH_FLOWER }),
    )
    expect(identity.userId).toBe("100001")
    expect(identity.openIds).toEqual([{ kind: "openDingTalkId", value: "DeMINE" }])
  })

  it("★ 花名进 displayNames（群里显示花名，@ 形态是 `@真名(花名)`）", async () => {
    const identity = await resolveSelf(
      fakeCli({ getSelf: NESTED_SELF, search: SEARCH_WITH_FLOWER }),
    )
    // 三种形态都要能命中「@我」判定
    expect(identity.displayNames).toContain("王强")
    expect(identity.displayNames).toContain("小王")
    expect(identity.displayNames).toContain("澄一")
  })

  it("组织名从 orgName 取（嵌套对象里不叫 corpName）", async () => {
    const identity = await resolveSelf(
      fakeCli({ getSelf: NESTED_SELF, search: SEARCH_WITH_FLOWER }),
    )
    expect(identity.corpId).toBe("dingexampleorgid0001")
    expect(identity.corpName).toBe("示例集团")
  })

  it("嵌套形状下依然只按 userId 精确匹配（不会选中同名的另一个人）", async () => {
    const identity = await resolveSelf(
      fakeCli({ getSelf: NESTED_SELF, search: SEARCH_WITH_FLOWER }),
    )
    expect(identity.openIds[0]?.value).not.toBe("DeOTHER")
  })
})

/**
 * ★★ 第二条判据：单聊交集（`inferFromMessages`）。
 *
 * ## 为什么加这条路
 *
 * 上面那些用例锁的都是 `search` 那条路 —— 它**判定是准的**（最终判据是
 * userId），但**失败率高**：搜不到、花名与实名不一致搜不着、上游少给一个
 * 字段，都会抛 `SELF_IDENTITY_AMBIGUOUS`。而那时用户只能看着一条红字手动
 * 确认，未确认期间蒸馏拒掉**全部**语料 —— 也就是说"解析失败"的真实代价
 * 是画像完全出不来。
 *
 * 单聊交集完全不碰姓名（判据与自检在 store 的
 * `inferSelfExternalIdFromDirectChats`，那里有专门的测试文件）。
 * 这一组只锁 `resolveSelf` 里的**编排**：什么时候用它、和 search 冲突时怎么办。
 */
describe("★★ 单聊交集作为兜底判据", () => {
  const INFERRED = "DeFROMCHATS"

  it("★ search 搜不到本人时用交集兜底（从前这里必然抛错）", async () => {
    const cli = fakeCli({
      // userId 不在候选里 → search 那条路失败
      getSelf: { userId: "not-in-list", orgUserName: "王强" },
      search: FIVE_SAME_NAME,
    })
    const identity = await resolveSelf(cli, "dingtalk", {
      inferFromMessages: () => INFERRED,
    })
    expect(identity.openIds).toEqual([{ kind: "openDingTalkId", value: INFERRED }])
    expect(identity.source).toBe("direct-chat-intersection")
  })

  it("★ 没有姓名时也能兜底（花名/实名对不上导致搜不着的那类失败）", async () => {
    const identity = await resolveSelf(fakeCli({ getSelf: { userId: "100001" } }), "dingtalk", {
      inferFromMessages: () => INFERRED,
    })
    expect(identity.openIds[0]?.value).toBe(INFERRED)
    expect(identity.source).toBe("direct-chat-intersection")
  })

  it("推不出来（返回 null）时行为与从前一致 —— 照旧抛错", async () => {
    try {
      await resolveSelf(
        fakeCli({
          getSelf: { userId: "not-in-list", orgUserName: "王强" },
          search: FIVE_SAME_NAME,
        }),
        "dingtalk",
        { inferFromMessages: () => null },
      )
      expect.unreachable("应当抛 SELF_IDENTITY_AMBIGUOUS")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) expect(error.code).toBe("SELF_IDENTITY_AMBIGUOUS")
    }
  })

  it("get-self 直给标识时不走交集（路 1 优先，最省）", async () => {
    let called = false
    const identity = await resolveSelf(
      fakeCli({ getSelf: { userId: "100001", orgUserName: "王强", openDingTalkId: "DeDIRECT" } }),
      "dingtalk",
      {
        inferFromMessages: () => {
          called = true
          return INFERRED
        },
      },
    )
    expect(identity.openIds[0]?.value).toBe("DeDIRECT")
    expect(identity.source).toBe("get-self")
    expect(called).toBe(false)
  })

  it("两条路一致 → 采用（并保留 search 带回的花名）", async () => {
    const identity = await resolveSelf(
      fakeCli({ getSelf: NESTED_SELF, search: SEARCH_WITH_FLOWER }),
      "dingtalk",
      { inferFromMessages: () => "DeMINE" },
    )
    expect(identity.openIds[0]?.value).toBe("DeMINE")
    expect(identity.source).toBe("search")
    // 花名只有 search 那条路能带回来，交叉校验不该把它弄丢
    expect(identity.displayNames).toContain("澄一")
  })

  /**
   * ★★ 这一条是本次改动**提高**安全性的地方。
   *
   * 从前 search 给出唯一匹配就直接采用，没有任何第二来源能证伪它。
   * 现在两条独立判据冲突时抛错 —— 因为无从知道哪条是错的，而"挑一个"
   * 等于有 50% 概率把别人的消息当本人语料，代价是**不可逆**的画像污染
   * （污染后的结论会作为下一轮的基线继续放大）。
   */
  it("★★ 两条路冲突 → 抛错，不挑一个", async () => {
    try {
      await resolveSelf(fakeCli({ getSelf: NESTED_SELF, search: SEARCH_WITH_FLOWER }), "dingtalk", {
        inferFromMessages: () => "DeCONFLICT",
      })
      expect.unreachable("冲突时应当抛 SELF_IDENTITY_AMBIGUOUS")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) {
        expect(error.code).toBe("SELF_IDENTITY_AMBIGUOUS")
        // ★ 标识符不进日志/上下文，只记"冲突了"这个事实
        expect(JSON.stringify(error.context)).not.toContain("DeCONFLICT")
        expect(JSON.stringify(error.context)).not.toContain("DeMINE")
      }
    }
  })

  it("不传 inferFromMessages 时完全是旧行为（首次授权、库为空的那一刻）", async () => {
    const identity = await resolveSelf(
      fakeCli({ getSelf: NESTED_SELF, search: SEARCH_WITH_FLOWER }),
    )
    expect(identity.openIds[0]?.value).toBe("DeMINE")
    expect(identity.source).toBe("search")
  })
})
