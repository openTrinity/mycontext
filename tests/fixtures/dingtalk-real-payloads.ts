/**
 * 钉钉 `chat message list-all` 的**真实形态** fixture（已脱敏）。
 *
 * ## 为什么这个文件必须存在
 *
 * 修复前的 fixture（`parse-list-all.test.ts` / `pipeline.test.ts`）都是
 * **直接从 `conversationMessagesList` 开始**构造的 —— 没有一个带 `result` 信封。
 * 于是 1191 个单测全绿，而生产环境 277 页原始响应落库 **0 条消息**。
 *
 * fixture 照着"我以为的形状"写，就测不出"真实形状不是这样"。
 * 这个文件是从真实 payload **逐字段核对**后脱敏来的，保留了每一个
 * 会影响解析的结构特征：
 *
 * | 特征 | 真实值 | 为什么必须保留 |
 * | --- | --- | --- |
 * | `{arguments, result, success}` 信封 | 有 | 少了它就测不出信封 bug |
 * | 数据在 `result` 下 | 是 | 同上 |
 * | `singleChat` 布尔（无 conversationType/memberCount） | 有 | 群聊/单聊判定的唯一依据 |
 * | `hasMore:false` + **非空** `nextCursor` | 276/277 页 | 翻页终止判据（活锁来源） |
 * | 消息**没有** msgType / atUsers / mediaId 字段 | 确认 | 媒体与 @ 必须从 content 抽 |
 * | `[图片消息](mediaId=@...)` | 200 条 | 媒体抽取 |
 * | `[文件] <名> fileId: <id>` | 1 条 | 另一条资源链路 |
 * | `@真名(花名)` | 524 条 | @我 判定 |
 * | `@程砚(程砚（砚之）)` 嵌套全角括号 | 有 | 正则边界 |
 * | `emotionReplyList` / `forwardMessages` | 有 | 嵌套结构不能让解析崩 |
 * | 表情标记 `[狗子]` 等 | 22+ 次 | **不能**被当成媒体 |
 *
 * ## ★ 脱敏是**硬要求**，而且这条已经被违反过一次
 *
 * 2026-07-30 审计发现：已推送到远端的这份 fixture 里有 **3 个真实
 * `openConversationId`**（逐个在本地 vault 里核对过确实存在），
 * 以及真实同事姓名。成因不是有人偷懒，而是"照真实响应写 fixture"
 * 这个本来正确的做法漏了脱敏那一步 —— 而泄漏的形态与正常代码
 * **完全一样**：一个 base64 串看不出它是真的还是编的，
 * review 时没人会拿本地库去比对。
 *
 * 现在有门禁盯着：`scripts/check-no-local-data.mjs` 直接读本地 vault，
 * 拿真实值去所有已跟踪文件里搜。真实值出现 = 泄漏，没有歧义。
 *
 * 脱敏规则：人名换化名、ID 改写但**保留长度与字符集**
 * （mediaId 的 `@`/`$` 前缀、base64 变体字符、`==` 结尾都保留 ——
 * 那些正是正则要处理的东西，改了长度这些 fixture 就测不出边界了）。
 */

/** 真实响应的一页（两个群 + 一个单聊）。 */
export const REAL_LIST_ALL_PAGE = {
  arguments: [],
  result: {
    conversationMessagesList: [
      {
        // 群聊：singleChat=false，且**没有** conversationType / memberCount
        openConversationId: "cid1a9eda76d755a3ba7ccf9e==",
        singleChat: false,
        title: "沙箱项目交流群",
        messages: [
          {
            // 纯文本 + @真名(花名)
            content: "@柏松岩(松岩) 说来沙箱那台机器的证书还是去年配的[二哈]要轮换得走工单",
            createTime: "2026-07-29 14:28:25",
            openConversationId: "cid1a9eda76d755a3ba7ccf9e==",
            openMessageId: "msgFAKE0002xxxxxxxxxxxxxx==",
            sender: "岸青",
            senderOpenDingTalkId: "D0AUGTeHwfaxAAAAAAAAAAAAAAAAAAAAA",
            // 引用消息：嵌套对象，只取 openMessageId
            quotedMessage: {
              content: "@周允(允之) 早就放弃了，那套流程目前还好",
              createTime: "2026-07-29 14:26:02",
              openMessageId: "msgQuotedAAA1122334455==",
              sender: "允之",
              senderOpenDingTalkId: "D37ux7lachiPCCCCCCCCCCCCCCCCCCCCCCCC",
            },
          },
          {
            // 图片：mediaId 以 `@` 开头
            content:
              "[图片消息](mediaId=@lQLPKG-foZGeBQPNAhDNBnSwy5WPOdO12_8KPMFctT2OAA)这个报错是不是又炸了",
            createTime: "2026-07-29 14:30:49",
            openConversationId: "cid1a9eda76d755a3ba7ccf9e==",
            openMessageId: "msgFAKE0006xxxxxxxxxxxxxx==",
            sender: "迈普",
            senderOpenDingTalkId: "D0AUGTeHwfawBBBBBBBBBBBBBBBBBBBBB",
          },
          {
            // 图片：mediaId 以 `$` 开头（另一种前缀）+ 官方提示语
            content:
              "[图片消息](mediaId=$iwELAqNwbmcDAATRAfQF0QG_BrDRUYuYlWDPdAopn4eV0mwABwAIAAmgCgALAA) 注意：如需下载使用dws chat message download-media命令下载",
            createTime: "2026-07-29 14:31:19",
            openConversationId: "cid1a9eda76d755a3ba7ccf9e==",
            openMessageId: "msgFAKE0005xxxxxxxxxxxxxx==",
            sender: "岸青",
            senderOpenDingTalkId: "D0AUGTeHwfaxAAAAAAAAAAAAAAAAAAAAA",
          },
          {
            // ★ 嵌套全角括号的 @：`@程砚(程砚（砚之）)`
            content: "@程砚(程砚（砚之）) 那个模型要开源的话审核也没办法",
            createTime: "2026-07-29 14:32:00",
            openConversationId: "cid1a9eda76d755a3ba7ccf9e==",
            openMessageId: "msgNestedParenAAA99==",
            sender: "允之",
            senderOpenDingTalkId: "D37ux7lachiPCCCCCCCCCCCCCCCCCCCCCCCC",
            // 表情回复：嵌套数组，解析不能崩
            emotionReplyList: [{ emoji: "是的", replyUsers: ["清和"] }],
          },
          {
            // ★ 表情标记**不是**媒体：`[狗子]` 这类不能被抽成 media
            content: "好像只能这样[狗子][忍者]",
            createTime: "2026-07-29 14:33:10",
            openConversationId: "cid1a9eda76d755a3ba7ccf9e==",
            openMessageId: "msgEmojiOnlyBBB88==",
            sender: "迈普",
            senderOpenDingTalkId: "D0AUGTeHwfawBBBBBBBBBBBBBBBBBBBBB",
          },
        ],
      },
      {
        // 另一个群：@本人（用于测 @我 判定）
        openConversationId: "cid63a781adb2b4372785f36a==",
        singleChat: false,
        title: "[会议群]密钥轮转方案",
        messages: [
          {
            // @ 本人的真名（fixture 里本人 = 沈云舟 / 云舟 / 澄一）
            content: "@沈云舟(澄一) 麻烦看下这个轮转脚本",
            createTime: "2026-07-29 14:35:00",
            openConversationId: "cid63a781adb2b4372785f36a==",
            openMessageId: "msgMentionSelfCCC77==",
            sender: "清和",
            senderOpenDingTalkId: "D0AUGTeHwfaxAAAAAAAAAAAAAAAAAAAAA",
          },
          {
            // 本人自己发的（is_self 判定 → outbound）
            content: "收到，我看下",
            createTime: "2026-07-29 14:36:12",
            openConversationId: "cid63a781adb2b4372785f36a==",
            openMessageId: "msgSelfSentDDD66==",
            sender: "澄一",
            senderOpenDingTalkId: "D0AUGTeHwfaySELFxxxxxxxxxxxxxxxxx",
          },
        ],
      },
      {
        // ★ 单聊：singleChat=true
        openConversationId: "cid6c0d4d382ddd037f260da4==",
        singleChat: true,
        title: "顾行之",
        messages: [
          {
            // 文件：`[文件] <名> fileId: <id>`
            content:
              "[文件] deploy.env fileId: 4lgGw3P8vzw9zZerhgnYx0n585daZ90D 注意：如需下载使用dws drive download命令下载",
            createTime: "2026-07-29 14:20:05",
            openConversationId: "cid6c0d4d382ddd037f260da4==",
            openMessageId: "msgFileEEE55==",
            sender: "顾行之",
            senderOpenDingTalkId: "D0AUGTeHwfayGuXingZhi001122",
          },
          {
            // 合并转发：嵌套的聊天记录数组
            content:
              "顾行之与澄一的聊天记录\n顾行之:那个接口有更新么\n澄一:[图片]\n顾行之:我先看下文档",
            createTime: "2026-07-29 14:21:30",
            openConversationId: "cid6c0d4d382ddd037f260da4==",
            openMessageId: "msgForwardFFF44==",
            sender: "顾行之",
            senderOpenDingTalkId: "D0AUGTeHwfayGuXingZhi001122",
            forwardMessages: [
              {
                content: "那个接口有更新么",
                createTime: "2026-07-29 14:15:10",
                openConversationId: "cidFAKE0001xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=",
                openMessageId: "msgFAKE0004xxxxxxxxxxxxxx==",
                sender: "顾行之",
                senderOpenDingTalkId: "D0AUGTeHwfayGuXingZhi001122",
              },
              {
                content: "我查一下",
                createTime: "2026-07-29 14:17:49",
                openConversationId: "cidFAKE0001xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=",
                openMessageId: "msgForwardInner2233==",
                sender: "澄一",
                senderOpenDingTalkId: "D0AUGTeHwfaySELFxxxxxxxxxxxxxxxxx",
              },
            ],
          },
        ],
      },
    ],
    // ★★ 真实形态：hasMore=false 却带**非空** nextCursor（276/277 页如此）
    hasMore: false,
    nextCursor:
      "+ZxkstgRjAHHWH1PXhefxShisamgzL7cVkaVgovcHGYmklGcErSxAl1ClJMvaaZHbm1gCWcZ36fZ4wI3bI2SJ6VCnEfck6JjE6KcNS46pw",
  },
  success: true,
} as const

/** fixture 里"本人"的身份（与 `resolveSelf` 的真实产出同形）。 */
export const REAL_SELF_IDENTITY = {
  userId: "100001",
  openIds: [{ kind: "openDingTalkId", value: "D0AUGTeHwfaySELFxxxxxxxxxxxxxxxxx" }],
  displayNames: ["沈云舟", "云舟", "澄一"],
  corpId: "dingexampleorgid0001",
  corpName: "示例集团",
} as const

/**
 * `contact user get-self` 的**真实形态**：`result` 是**数组**，
 * 业务字段在 `[0].orgEmployeeModel` 里。
 *
 * 首版直接读 `result.userId` → 恒为 null → 每次都抛 SELF_IDENTITY_AMBIGUOUS
 * → `channel_self_identity` 永远为空 → 蒸馏守卫拒掉全部语料。
 */
export const REAL_GET_SELF = {
  result: [
    {
      isAdmin: false,
      orgEmployeeModel: {
        corpId: "dingexampleorgid0001",
        depts: [{ deptId: -1, deptName: "示例事业群-技术部-技术四组" }],
        orgName: "示例集团",
        orgUserName: "沈云舟",
        stateCode: "86",
        userId: "100001",
      },
    },
  ],
  success: true,
} as const

/**
 * `contact user search` 的真实形态：`result` 直接是数组，
 * 且**同名同姓有多条**（实测 6 条）—— 这正是"只按 userId 精确匹配"的由来。
 */
export const REAL_USER_SEARCH = {
  result: [
    {
      flowerName: "澄一",
      name: "沈云舟",
      nick: "云舟",
      openDingTalkId: "D0AUGTeHwfaySELFxxxxxxxxxxxxxxxxx",
      title: "技术-基础平台-开发",
      userId: "100001",
    },
    // 同名不同人：姓名匹配会灾难性误判
    {
      name: "沈云舟",
      nick: "云舟",
      openDingTalkId: "D9zzOtherPersonSameName001",
      userId: "1900000000000001",
    },
    { name: "沈云舟", openDingTalkId: "D9zzOtherPersonSameName002", userId: "532322" },
    { name: "沈云舟", openDingTalkId: "D9zzOtherPersonSameName003", userId: "WB02488056" },
  ],
  success: true,
} as const

/** `minutes list all` 的真实形态。`durationMicros` 是**微秒**。 */
export const REAL_MINUTES_LIST = {
  arguments: [],
  errorCode: null,
  errorMsg: null,
  result: {
    hasMore: true,
    itemList: [
      {
        durationMicros: 1224340000,
        endTime: 1785080873000,
        endTimeISO: "2026-07-26T23:47:53+08:00",
        flashUserInfo: { name: "云舟" },
        keywordsInfo: { keywords: ["内部会议", "连接器管理", "默认开启"], statusCode: 200 },
        liveType: 0,
        orgId: 21001,
        orgName: "示例集团",
        shareUrl: "https://example.invalid/app/transcribes/76327569643337393837",
        startTime: 1785079649000,
        startTimeISO: "2026-07-26T23:27:29+08:00",
        title: "连接器授权策略讨论",
        uuid: "6d696e75746573756964305f6578616d706c655f30303031",
      },
    ],
    nextToken: "315f305f305f31385f31",
  },
  success: true,
} as const

/** `minutes get summary` 的真实形态。 */
export const REAL_MINUTES_SUMMARY = {
  dingOpenErrcode: "0",
  errorMsg: "ok",
  result: {
    fullSummary:
      '> **主题**: 连接器授权策略讨论\n> **时间**: <time data-ts="1785079409000">2026-07-26 23:23:29</time>\n> **参与人**: 沈云舟, 顾行之, 柏松岩\n\n## 会议背景\n\n组织端连接器授权的短期方案与默认开启逻辑。',
  },
  success: true,
} as const

/**
 * `minutes get transcription` 的**真实分页形态**（已脱敏）。
 *
 * ## ★★ 这个 fixture 存在的理由是记住**收尾页没有 `hasNext` 键**
 *
 * 实测（2026-08-09，开源版 v1.0.57，三场长会共 57 页）：
 *
 * | | 中间页 | 最后一页 |
 * | --- | --- | --- |
 * | `hasNext` | `true` | **键不出现**（= `undefined`，不是 `false`） |
 * | `nextToken` | 非空串 | **不出现** |
 * | `paragraphList` | 恒 **50** 段 | 不足 50（9 / 21 段） |
 *
 * 判据因此必须是 `hasNext === true`。写成 `!== false` 的话最后一页会被判成
 * "还有下一页"，只能靠"没给游标"那条兜底才停 —— 而那意味着每场会都多跑
 * 一次注定失败的判断，且哪天上游给了非空尾游标就变成死循环。
 *
 * ## 规模（决定了 `MAX_TRANSCRIPT_PAGES` / `MAX_TRANSCRIPT_CHARS` 的取值）
 *
 * | 会议时长 | 页数 | 段数 | 字符数 |
 * | --- | --- | --- | --- |
 * | 106 分钟 | 18 | 859 | 464k |
 * | 138 分钟 | 21 | 1021 | 551k |
 * | 343 分钟 | ≥25 | ≥1250 | ≥648k |
 *
 * 单页恒 50 段 ≈ **26000 字符**（方差很小：23.6k–28.7k）。也就是
 * 页数 ≈ 会议时长 / 6 分钟。首版把字符预算定在 200k（≈8 页），
 * 那会让上面三场会**全部**被砍掉一半以上。
 */
export const REAL_MINUTES_TRANSCRIPTION_MIDDLE_PAGE = {
  result: {
    hasNext: true,
    nextToken: "315f325f305f35305f32",
    paragraphList: [
      {
        endTime: 1785079700000,
        nickName: "小孙",
        paragraph: "比如说我这是可以加的。",
        startTime: 1785079695000,
      },
      {
        endTime: 1785079712000,
        nickName: "小王",
        paragraph: "那就先这样，我下午同步一下。",
        startTime: 1785079705000,
      },
    ],
  },
  success: true,
} as const

/**
 * 收尾页。★ **刻意没有 `hasNext` 与 `nextToken` 两个键** —— 那是实测形态，
 * 不是漏写（见 `REAL_MINUTES_TRANSCRIPTION_MIDDLE_PAGE` 的文件头）。
 */
export const REAL_MINUTES_TRANSCRIPTION_LAST_PAGE = {
  result: {
    paragraphList: [
      {
        endTime: 1785080873000,
        nickName: "小李",
        paragraph: "好，那今天就到这里。",
        startTime: 1785080869000,
      },
    ],
  },
  success: true,
} as const

/**
 * `chat list-all-conversations --limit 100` 的**真实形态**（已脱敏）。
 *
 * ★ 这个 fixture 存在的理由是**记住这条命令的分页是坏的**。逐条实测：
 *
 * | `--help` 说 | 实测（账号 113+ 个会话） |
 * | --- | --- |
 * | `--limit` 默认 1000 | **上限 100**，传 101/150/200/1000 都只回 100，无警告 |
 * | `hasMore=true` 时继续翻 | **恒 false**（`--limit 50` 只回 50 条时也 false） |
 * | `--cursor` 传 nextCursor 翻页 | **完全无效**：cursor=0/1/50 返回逐字相同的首页 |
 * | 用 `nextCursor` 当游标 | 响应里**没有** `nextCursor` 字段 |
 *
 * 照文档写的翻页循环会「跑一页就停」且看起来完全正常 —— 那正是最坏的情况：
 * 以为拿到了全部，其实只有一个 100 条窗口。
 *
 * 保留的结构特征：ISO-8601 **带时区**的 `lastMsgCreateAt`（与消息接口的
 * `"yyyy-MM-dd HH:mm:ss"` 不同，混用会得到 NaN）、`groupType` 的五种取值、
 * `singleChat` 布尔与 `groupType` **同时存在**。
 */
export const REAL_CONVERSATION_LIST = {
  arguments: [],
  errorCode: null,
  errorMsg: null,
  result: {
    conversations: [
      {
        channel: false,
        createAt: "2025-07-03T11:52:26+08:00",
        groupType: "SINGLE_CHAT",
        lastMsgCreateAt: "2026-07-29T17:16:15.863+08:00",
        memberCount: 2,
        notificationOff: 0,
        openConversationId: "cidD3a716b38b52346a4df6f5bc31edd6b588a03bb8f21=",
        ownerOpenDingtalkId: "DFAKE0001owner1111111111111",
        singleChat: true,
        title: "云舟",
        unreadPoint: 0,
      },
      {
        channel: false,
        createAt: "2025-10-24T16:56:32+08:00",
        groupType: "INTERNAL_GROUP",
        lastMsgCreateAt: "2026-07-29T20:31:04.258+08:00",
        memberCount: 16,
        notificationOff: 0,
        openConversationId: "cid3e1cf7dac23168f7cad940==",
        ownerOpenDingtalkId: "D01830ebdd6f6fe55801bfbf12a134809c",
        singleChat: false,
        title: "连接器产研交流群",
        unreadPoint: 0,
      },
      {
        channel: false,
        createAt: "2026-03-11T09:02:11+08:00",
        groupType: "UNKNOWN_TYPE",
        lastMsgCreateAt: "2026-07-28T11:20:03.001+08:00",
        memberCount: 19,
        notificationOff: 0,
        openConversationId: "cid939d6ce04bc5d4c7ed5224==",
        ownerOpenDingtalkId: "DFAKE0002owner2222222222222222222",
        singleChat: false,
        title: "系统通知",
        unreadPoint: 0,
      },
    ],
    // ★ 恒 false，且**没有** nextCursor 字段。这两点就是"不能靠它翻页"的证据。
    hasMore: false,
  },
  success: true,
} as const

/**
 * 同一命令加 `--exclude-muted` 的真实形态（已脱敏）。
 *
 * 免打扰被排除后窗口**下移**，实测多出 13 个会话（5 单聊 / 8 群聊），
 * 其中 9 个是主窗口里没有的。所以这不是"同一份数据的过滤"，
 * 而是**另一个窗口** —— 值得多花一次 0.67s 的调用。
 */
export const REAL_CONVERSATION_LIST_EXCLUDE_MUTED = {
  arguments: [],
  errorCode: null,
  errorMsg: null,
  result: {
    conversations: [
      {
        channel: false,
        createAt: "2026-07-10T16:48:37+08:00",
        groupType: "INTERNAL_GROUP",
        lastMsgCreateAt: "2026-07-14T16:53:45.858+08:00",
        memberCount: 7,
        notificationOff: 0,
        openConversationId: "cidFFFFFFFFFFFFFFFFFFFF01==",
        ownerOpenDingtalkId: "Da7872b792b465f4cf17be46f656ddbf9930",
        singleChat: false,
        title: "示例群聊名称",
        unreadPoint: 0,
      },
    ],
    hasMore: false,
  },
  success: true,
} as const

/**
 * `chat group list-all` 的**真实形态**（已脱敏）——**这条的分页是好的**。
 *
 * 实测 73 + 39 = 112 个群，两页**零重叠**，`hasMore` 诚实，
 * `nextCursor` 是个真游标（数字 `1782315723736`，虽然 flag 声明 string）。
 * 所以它被用来补 `list-all-conversations` 那个固定窗口拿不到的群 ——
 * 实测有 60 个群落在会话窗口之外。
 *
 * ★ item **没有** `lastMsgCreateAt`：只有 `createAt`（而且是
 * `"yyyy-MM-dd HH:mm:ss"` 格式，与会话列表的 ISO 串又不一样）。
 * 因此从这一路来的会话最后消息时间只能是 null —— 那是事实，不能编。
 */
export const REAL_GROUP_LIST_PAGE1 = {
  arguments: [],
  errorCode: null,
  errorMsg: null,
  result: {
    groups: [
      {
        channel: false,
        createAt: "2025-07-03 09:26:35",
        groupType: "INTERNAL_GROUP",
        memberCount: 17675,
        myRole: "普通成员",
        openConversationId: "cidB21bfe4e9bfae84a9eec62==",
        ownerOpenDingtalkId: "D0AUGTeHwfazOWNERdddddddddddddddd",
        title: "云智能全员群",
      },
      {
        channel: false,
        createAt: "2025-07-03 11:37:49",
        groupType: "INTERNAL_GROUP",
        memberCount: 60,
        myRole: "普通成员",
        openConversationId: "cidFFFFFFFFFFFFFFFFFFFF02==",
        ownerOpenDingtalkId: "D0AUGTeHwfaGGGGGGGGGGGGGGGGGGGGGGGGGG",
        title: "示例项目组",
      },
    ],
    hasMore: true,
    // 实测是**数字**而不是 flag 声明的 string —— 解析要容忍两种
    nextCursor: 1782315723736,
  },
  success: true,
} as const

/** 群列表第二页：`hasMore:false` + `nextCursor:0`（游标归零即终止）。 */
export const REAL_GROUP_LIST_PAGE2 = {
  arguments: [],
  errorCode: null,
  errorMsg: null,
  result: {
    groups: [
      {
        channel: false,
        createAt: "2026-02-18 14:03:22",
        groupType: "NEW_EXTERNAL_GROUP",
        memberCount: 8,
        myRole: "群主",
        openConversationId: "cidZq3mLpX8vTaHkNoq21oJ4b==",
        ownerOpenDingtalkId: "DFAKE0001owner1111111111111",
        title: "外部协作群",
      },
    ],
    hasMore: false,
    nextCursor: 0,
  },
  success: true,
} as const

/**
 * 授权类失败的**真实 stderr**（逐字节记录，只删了 mock 的 trace 行）。
 *
 * ## 为什么这几段必须是真的
 *
 * `classifyDwsError` 首版的 12 条模式串**对真实输出全部 miss** ——
 * 关键那条找 `"not authenticated"`（空格），而 CLI 输出的是
 * `not_authenticated`（**下划线**）。单测却全绿，因为 fixture 是照
 * 想象写的（`"not authenticated"`、`"登录已过期"`）。
 * 后果：终态被归成 `PROCESS_FAILED{retryable:true}` → 无限退避重试、
 * 界面永远显示「渠道命令失败（exit 2）」而不提示重新授权。
 *
 * 所以这几段**只能是实测抓的**。复现方式（不碰真实登录态）：
 * 空 `HOME` + `DWS_CONFIG_DIR` 得到未登录态；
 * 401/403/网关码/PAT 用回环 mock endpoint（`DINGTALK_IM_MCP_URL`
 * + `DWS_ALLOW_HTTP_ENDPOINTS=1`）+ `--token` 绕过登录来触发。
 *
 * 实测矩阵见 `classifyDwsError` 的注释 —— 关键是 **`category` 不可信**
 * （网关类授权错误报 `internal`），判据要用 `code`/`reason`。
 *
 * 版本：0.2.99 与 v1.0.52.1 输出一致。
 */

/** 未登录（数据命令）：exit 2、`category:auth`、`reason:not_authenticated`。 */
export const REAL_ERR_NOT_AUTHENTICATED = `{
  "error": {
    "actions": [
      "dws auth login"
    ],
    "category": "auth",
    "code": 2,
    "hint": "运行 'dws auth login' 完成登录后重试",
    "message": "[UNCLASSIFIED] 未登录，请先执行 dws auth login (operation: im/list_all_conversations)\\n  hint: Use --verbose for detailed error logs",
    "reason": "not_authenticated"
  }
}`

/** 未登录（非 JSON 模式）：老路径/人类可读输出也要能归类。 */
export const REAL_ERR_NOT_AUTHENTICATED_TABLE = `● Error: [AUTH] 未登录，请先执行 dws auth login
Hint: 运行 'dws auth login' 完成登录后重试
Action: dws auth login`

/**
 * 200 响应体里带网关码（`USER_TOKEN_ILLEGAL`）：exit 2、
 * ★ `category` 是 **internal** 而不是 auth，且**没有 `reason`** ——
 * 只判 `category==="auth"` 会漏掉这一整类。
 */
export const REAL_ERR_GATEWAY_TOKEN_INVALID = `{
  "error": {
    "category": "internal",
    "code": 2,
    "message": "[AUTH_TOKEN_EXPIRED] Token 已过期或验证失败 (operation: im/list_all_conversations)\\n  hint: Re-authenticate: dws auth login"
  }
}`

/**
 * 真 HTTP 401：★ exit **5**、`category:internal`、**没有 `reason`**，
 * 文案里也没有任何"未登录/过期"字样 —— 只能靠 `Auth error` / `HTTP 401` 兜底。
 */
export const REAL_ERR_HTTP_401 = `{
  "error": {
    "category": "internal",
    "code": 5,
    "message": "[UNCLASSIFIED] Auth error: request to http://127.0.0.1:18099/mcp returned HTTP 401. Re-run previous command (max 2 retries) (operation: im/list_all_conversations)\\n  hint: Use --verbose for detailed error logs"
  }
}`

/** 真 HTTP 403：exit 4、`code:4`。是**权限**不是登录 —— 不能提示重新扫码。 */
export const REAL_ERR_HTTP_403 = `{
  "error": {
    "category": "internal",
    "code": 4,
    "message": "[AUTH_PERMISSION_DENIED] Permission denied (operation: im/list_all_conversations)\\n  hint: Verify your account has permission for this resource"
  }
}`

/** PAT 权限拦截：exit 4，**裸 JSON**（没有 `error` 信封）。 */
export const REAL_ERR_PAT_NO_PERMISSION = `{
  "code": "PAT_NO_PERMISSION",
  "data": {
    "uri": "https://example.invalid/authorize"
  },
  "success": false
}`

/** PAT 缺 scope：★ exit **5**（不是 4），同样是裸 JSON 单行。 */
export const REAL_ERR_PAT_SCOPE_REQUIRED = `{"code":"PAT_SCOPE_AUTH_REQUIRED","data":{"missingScope":"chat.message:read","openBrowser":true},"success":false}`

/**
 * ★★ 客户端对该企业没开通能力：`server_error_code: ENTERPRISE_NOT_AUTHORIZED`。
 *
 * ## 这一段是从真实刷屏事故里抓的
 *
 * 来源：一次真实会话的日志 —— 8 分钟内约 50 条同一个错，三个 operation
 * 轮着报（`chat/unread_message_conversation_list`、`im/list_all_conversations`、
 * `chat/search_messages_by_time_range`），而界面上什么都不说。
 *
 * 成因：这个码原来**不在** `SERVER_ERROR_CODES` 里 → 落到兜底的
 * `PROCESS_FAILED{retryable:true}` → 采集每 10 秒重试一次、`blockedReason`
 * 永不置位。与本文件开头记的那次 `not_authenticated` 事故**同一个形状**。
 *
 * ★ 注意 `category` 是 **api**、`code` 是 **1** —— 又一次印证"category 不可信"：
 * 它既不是 `auth` 也不是 `internal`，而 `reason` 是笼统的 `business_error`
 * （那个值本身区分不了任何东西）。唯一可靠的判据就是 `server_error_code`。
 *
 * 值按 CLAUDE.md §1.2 脱敏：`trace_id` 换成假值，长度与字符集保持一致。
 */
export const REAL_ERR_ENTERPRISE_NOT_AUTHORIZED = `{
  "error": {
    "category": "api",
    "code": 1,
    "hint": "The API returned a business-level error. Check required parameters and values.",
    "message": "[UNCLASSIFIED] business error: code ENTERPRISE_NOT_AUTHORIZED (operation: chat/unread_message_conversation_list)\\n  hint: Use --verbose for detailed error logs",
    "operation": "tools/call",
    "reason": "business_error",
    "server_error_code": "ENTERPRISE_NOT_AUTHORIZED",
    "server_key": "chat",
    "trace_id": "0bFAKE00011786000000000000e00000"
  }
}`

/**
 * ★★ `--profile` 钉住的身份在本机不存在 —— 三种真实形态，全是 exit 3。
 *
 * 复现（不碰真实登录态、不改全局 profile）：拿一个编造的 profile 值去跑
 * `auth status --profile <假值>`。实测 dws v1.0.56，三种写法各触发一种文案：
 *
 * | 传的值                  | message                                        |
 * |-------------------------|------------------------------------------------|
 * | 假 corpId:假 userId     | `organization "…" not found`                   |
 * | 真 corpId:假 userId     | `account "…" not found in organization "…"`    |
 * | 一个不含 `:` 的串       | `profile "…" not found`                        |
 *
 * ★ 三段的 `corpId` / `userId` 都已替换成假值（CLAUDE.md §1.2）；
 * 形状（字段、转义、exit code）逐字节照实测。
 *
 * ★ 三条都**没有** `reason` 字段 —— 这正是与下面 `UNKNOWN_FLAG` 区分的关键。
 */
export const REAL_ERR_PROFILE_ORG_NOT_FOUND = `{
  "error": {
    "category": "validation",
    "code": 3,
    "message": "organization \\"dingFAKECORP0001\\" not found"
  }
}`

export const REAL_ERR_PROFILE_ACCOUNT_NOT_FOUND = `{
  "error": {
    "category": "validation",
    "code": 3,
    "message": "account \\"FAKEUSER0009\\" not found in organization \\"dingFAKECORP0001\\""
  }
}`

export const REAL_ERR_PROFILE_NOT_FOUND = `{
  "error": {
    "category": "validation",
    "code": 3,
    "message": "profile \\"garbagevalue\\" not found"
  }
}`

/**
 * ★★ 参数拼错（**我们自己的 bug**）：也是 `category: validation` + `code: 3`。
 *
 * 这一段的存在就是为了钉住「不能只看 code 3」：把它误归成
 * `CHANNEL_IDENTITY_UNAVAILABLE` 的话，一个代码 bug 会被显示成
 * 「请重新授权」—— 用户照做，扫完码问题还在，而真正的原因被一条
 * 用户友好的文案彻底盖住。区分靠 `reason: "unknown_flag"`。
 *
 * 实测触发：`dws chat list-all-conversations --bogusflag`。
 */
export const REAL_ERR_UNKNOWN_FLAG = `{
  "error": {
    "actions": [
      "Run 'dws chat list-all-conversations --help' for valid flags"
    ],
    "available_flags": [
      "client-id",
      "client-secret",
      "cursor",
      "debug",
      "dry-run",
      "exclude-muted",
      "fields",
      "format",
      "help",
      "jq",
      "limit",
      "mock",
      "profile",
      "timeout",
      "verbose",
      "yes"
    ],
    "category": "validation",
    "cause": "unknown flag: --bogusflag",
    "code": 3,
    "hint": "Run 'dws chat list-all-conversations --help' to see available options",
    "message": "unknown flag: --bogusflag\\nSee 'dws chat list-all-conversations --help' for usage.",
    "reason": "unknown_flag"
  }
}`
