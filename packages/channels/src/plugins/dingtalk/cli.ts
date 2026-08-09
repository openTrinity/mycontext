/**
 * DWS CLI 的执行封装。
 *
 * 三件事这一层必须做对，否则表现出来都是「功能不工作」而排查方向完全不同：
 *
 * ## 1. 交互式确认（首版最容易漏的一类故障）
 *
 * DWS 有全局 `-y/--yes`（跳过确认提示，AI Agent 模式）。若某命令触发确认提示
 * 而我们没传，子进程会**静默挂到 timeout** —— 看起来像"卡住了"或"超时了"，
 * 而真实原因是它在等一个永远不会来的回车。
 *
 * 因此命令分两类白名单：
 * · **可自动 `-y`**：无副作用的读/查询命令；
 * · **必须走宿主 UI 授权**：`chmod` / `data-auth` / `send` ——
 *   实测 help 原文明确「每次执行都需要用户在宿主 UI 中确认，模型无法静默绕过」，
 *   给 `-y` 也绕不过弹窗。这类命令返回的权限错误必须归类为终态。
 *
 * ## 2. 错误归类：区分「重试有用」与「重试永远没用」
 *
 * `SESSION_EXPIRED`（登录过期）与 `PERMISSION_REQUIRED`（缺授权）都是**终态**：
 * 靠重试永远好不了，重试只会反复弹窗骚扰用户。
 * 不区分的话就会得到一个"无意义的重试风暴"。
 *
 * ## 3. 读命令固定注入 `-f json`
 *
 * 我们只解析 JSON。不注入的话某些子命令会输出人类可读格式，
 * 解析失败的表现是"字段全空"而不是报错。
 *
 * ## 4. 剥掉响应信封（见 `unwrapEnvelope`）
 *
 * 每个子命令的 JSON 都包在 `{arguments, errorCode, errorMsg, result, success}` 里。
 * 这一层剥掉之后业务解析器只看业务形状 —— 让「一处剥了一处没剥」这个
 * 静默失效模式不可能发生。
 */
import { AppError, type Logger } from "@mycontext/kernel"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"

/**
 * 需要宿主 UI 授权的命令（`-y` 绕不过）。
 *
 * ## 为什么这三条用**前缀**而其余用完整命令
 *
 * 它们后面跟的是**位置参数**或子命令，不是纯 flag：
 * · `chat chmod <scope> --agentCode ...`（scope 是位置参数）
 * · `chat data-auth cross-org ...`（还有一层子命令）
 * 所以只能按前两三个 token 判定。
 *
 * ⚠️ 首版这里写的是顶层 `["data-auth"]` —— 实测**没有**顶层 `data-auth` 命令
 * （`dws data-auth` 打印的是服务列表），真实位置是 `dws chat data-auth`。
 * 那一条既挡不住任何东西、也放行不了任何东西，属于纯死条目。
 */
const HOST_APPROVAL_COMMANDS: readonly string[][] = [
  ["chat", "chmod"],
  ["chat", "message", "send"],
  ["chat", "data-auth"],
]

/**
 * 可以自动加 `-y` 的读命令。**按完整命令逐条列，不用前缀。**
 *
 * ## ★ 为什么必须是完整命令（前缀粒度会放行整棵子树）
 *
 * 首版写的是 `["contact","user"]`，而这条前缀放行了整个 `contact user` 子树 ——
 * 实测包括：
 * · `contact user profile get` —— 其 --help 原文写明返回**银行卡 / 合同 /
 *   家庭信息 / 学历**；
 * · `contact user search-mobile` —— 按手机号反查人；
 * · `contact user dismission search` —— 离职员工名单。
 *
 * 三条都 `blocked=false` 且被注入 `-y` 自动确认。也就是说门禁的宣称
 * （「白名单外的命令走不出这个函数」）与实际行为不符：我们只想读
 * 「我是谁」和「按关键词搜人」，却顺手放行了整份花名册。
 *
 * 这类 PII 命令**不进白名单**：我们的蒸馏语料来自聊天记录，
 * 不需要银行卡与合同。将来真需要某一条，就单独加那一条，
 * 并且要走 `HOST_APPROVAL_COMMANDS`（让用户在宿主 UI 上确认一次）。
 *
 * ## ★ 每一条都实测过存在
 *
 * 首版有三条**匹配不到任何真实命令**（前缀是全等比较）：
 * `["chat","conversation"]`（真实是 `chat conversation-info`）、
 * `["chat","list-unread-conversations"]` 与 `["chat","list-mentions"]`
 * （真实位置在 `chat message` 下）。实测 `dws chat list-unread-conversations`
 * 返回 `unknown subcommand ... for "dws chat"` —— 而**采集插件正在调它**
 * （ingest.ts 的 probe），所以那是一条真实的运行时故障，不只是死条目。
 * `cli-confirm.test.ts` 里有一条断言锁住"每项都能匹配到真实子命令"。
 */
const READ_COMMANDS: readonly string[][] = [
  ["auth", "status"],
  // 「我是谁」：身份解析用。返回本人的 userId / openId，不含花名册字段。
  ["contact", "user", "get-self"],
  // 按关键词搜人：解析本人身份时用来消歧（同名同姓）。
  ["contact", "user", "search"],
  // 会话消息：采集的主力命令。
  ["chat", "message", "list-all"],
  ["chat", "message", "list"],
  ["chat", "message", "list-mentions"],
  // 未读会话列表：L1 探针用（★ 在 `chat message` 下，不在 `chat` 下）。
  ["chat", "message", "list-unread-conversations"],
  /**
   * 查我们自己发出去的那条消息的状态。**关联链的必需一跳。**
   *
   * ★ `send` 只返回 `openTaskId`，**没有** `openMessageId`（实测）——
   * 这条命令是把 taskId 换成消息 id 的唯一入口。
   *
   * 不放它进白名单的后果是静默的：`sent_message_external_id` 永远为 NULL
   * → `claimAgentOrigin` 匹配不到 → `messages.origin` 恒 `human`
   * → 界面上分不出哪条是分身发的，且分身的回复被当本人语料再蒸一遍。
   *
   * 归在 READ 里是对的：它**只查状态**，对远端没有任何副作用
   * （判据见下面 download-media 那一段：看的是"对远端有没有副作用"）。
   */
  ["chat", "message", "query-send-status"],
  // 会话基础信息 / 全部会话列表：补齐会话标题与成员数。
  ["chat", "conversation-info"],
  ["chat", "list-all-conversations"],
  /**
   * 我加入的全部群。**补** `list-all-conversations` 的分页缺陷用的
   * （那条命令的 `--cursor` 实测无效、`--limit` 硬顶 100，只能拿一个固定窗口；
   * 这条的分页是真的）。详见 conversations.ts 文件头。
   */
  ["chat", "group", "list-all"],
  /**
   * 群成员详情（按 openDingTalkId 批量）。**头像的唯一来源**。
   *
   * ★ 为什么取头像要经过"群"：钉钉没有开放的用户头像接口
   * （`contact user get` 不返回头像字段，`dws api` 那条路要自有 AppKey）。
   * 实际可行的路径是「共同群的成员详情里有 `avatarMediaId`」——
   * 所以必须与目标**有共同群**才取得到。见 avatar.ts 的文件头。
   *
   * 这条**只读**：它不改群、不加人（那是 `group members add`，不在白名单里）。
   */
  ["chat", "group", "members", "list-by-ids"],
  /**
   * 共同群搜索：找"我和某人都在的群"，用来定位上面那条命令的 `--id`。
   *
   * 比遍历我的全部会话快得多（后者在 86 个会话上要几十次调用）。
   */
  ["chat", "search-common"],
  /**
   * 下载媒体（图片 / 文件 / 头像）。
   *
   * ★ 它是**写本地文件**的命令，但不改远端任何东西 —— 归在 READ 里是
   * 因为"能不能自动 -y"这个判据看的是**对远端有没有副作用**。
   * 落地路径由我们传 `--output` 决定，所以本地侧的边界在调用方手上。
   *
   * mediaId 不是可直接访问的 URL：签名 URL 不外露且会过期，
   * 所以"只拿 URL 不落地"这种用法不存在 —— 唯一稳定产物是本地文件。
   */
  ["chat", "message", "download-media"],
  /**
   * 听记（会议转写）。三条都是纯读。
   *
   * ★ `minutes list` 必须带 scope 子命令 `all` —— 文档明确写了裸 `minutes list`
   * 「不会报错，但返回结果**不完整**（仅最近少量条目，约 913 字节）」。
   * 这里把 `all` 写进白名单路径，让"忘了带 scope"变成**被门禁拒绝**
   * 而不是"静默拿到不完整数据"。
   */
  ["minutes", "list", "all"],
  ["minutes", "get", "summary"],
  ["minutes", "get", "transcription"],
  /**
   * 事件（DingTalk Stream 长连接推送）。四条都不改远端聊天、不含花名册字段。
   *
   * · `event consume user_im_message_receive_at` —— 起长连接订阅「@我的消息」，
   *   NDJSON 推送。**只当叫醒信号**，正文仍走采集（见 events.ts 文件头）。
   *   ★ 写**完整命令**（含 event_key）而不是前缀 `["event","consume"]`：
   *   READ 表是**全等**匹配（`matchesExact` 要求长度相等），而这条调用带一个
   *   位置参数 `user_im_message_receive_at`；写全一是能匹配上，二是把订阅**钉死**
   *   在这一个 key 上——不放行 `event consume <任意其他 key>`。它走 `spawnDuplex`
   *   （长连），绕过 `DwsCli.run` 的门禁，events.ts 里显式补调 assertAllowedCommand。
   * · `event list` —— 事件**目录**（列出可订阅的 event_key），订阅面对账用。
   * · `event status` —— 当前订阅/消费者状态。
   * · `event stop`（`--all` 清全部）—— 退订。退出时必调，否则服务端订阅泄漏。
   *   `--all` 是 flag，commandPath 停在它之前，所以 `["event","stop"]` 全等即可。
   *
   * 归 READ 是对的：判据是"对远端聊天有没有副作用"（见 download-media 那段），
   * 而这四条只读事件流 / 管本地订阅，不发消息、不改群。
   */
  ["event", "consume", "user_im_message_receive_at"],
  ["event", "list"],
  ["event", "status"],
  ["event", "stop"],
  /**
   * 文档（知识库 wiki + 钉盘 drive）。四条都是纯读。
   *
   * ★ 这一组解决了一个曾被判成"做不到"的问题：消息里的 `fileId` 与
   * `doc read` 要的 `--node` 不是同一套 ID，而 fileId → node 没有直接命令。
   * 但**不必从 fileId 反查** —— `drive recent` 与 `wiki node list` 都直接
   * 给出 `nodeId`，正向枚举即可（见 documents.ts 文件头）。
   *
   * · `drive recent` —— 最近访问/编辑过的文档（个人视角）。
   * · `wiki space list` / `wiki node list` —— 知识库与其节点（团队视角，可递归）。
   * · `doc read` —— 取一篇文档的 Markdown 正文。
   *
   * ⚠️ 刻意**不放行** `drive download`：那是下字节（体积/并发/重试三类新问题），
   * 与"媒体只记 ID 不下载"同一个口径。也不放行 `doc create/update/block/import`
   * 之类的写命令 —— 白名单的判据是"对远端有没有副作用"。
   */
  ["drive", "recent"],
  ["wiki", "space", "list"],
  ["wiki", "node", "list"],
  ["doc", "read"],
]

/**
 * 交互式命令：允许执行，但**不能**自动 `-y`。
 *
 * `auth login` 会起本机回环监听并等用户扫码，加 `-y` 没有意义
 * （它等的不是确认提示而是真人操作）。单列一类是为了让
 * 「白名单内」与「可自动确认」这两件事不再耦合 ——
 * 首版把它们绑在一起，于是想放行 auth 就必须同时给它 `-y`。
 */
const INTERACTIVE_COMMANDS: readonly string[][] = [
  ["auth", "login"],
  ["auth", "logout"],
]

/**
 * 取出命令路径：从头开始到第一个 flag 之前的那些 token。
 *
 * `["chat","chmod","chat.message:send","--ttl","24h"]` → 前三个。
 * 需要它是因为完整命令匹配不能把位置参数与 flag 混进来比较。
 */
function commandPath(args: readonly string[]): string[] {
  const path: string[] = []
  for (const token of args) {
    if (token.startsWith("-")) break
    path.push(token)
  }
  return path
}

/**
 * 完整命令匹配（全等）。
 *
 * 与前缀匹配的区别正是本轮修的那个洞：前缀会放行整棵子树。
 */
function matchesExact(args: readonly string[], commands: readonly string[][]): boolean {
  const path = commandPath(args)
  return commands.some(
    (command) =>
      command.length > 0 &&
      command.length === path.length &&
      command.every((token, index) => path[index] === token),
  )
}

/**
 * 前缀匹配。**只给会跟位置参数的那几条命令用**（见 HOST_APPROVAL_COMMANDS）。
 *
 * `prefix.length > 0` 的守卫不是多余的：空数组会让 `every` 恒真、
 * 于是**匹配一切命令**。当前表里没有空项，但将来有人不小心加进一个
 * （比如从配置生成这张表），后果是「所有命令都需宿主授权」或
 * 「所有命令都自动确认」—— 前者功能全废、后者安全全废，
 * 而两者都不会有任何报错。
 */
function matchesPrefix(args: readonly string[], prefixes: readonly string[][]): boolean {
  const path = commandPath(args)
  return prefixes.some(
    (prefix) => prefix.length > 0 && prefix.every((token, index) => path[index] === token),
  )
}

export function requiresHostApproval(args: readonly string[]): boolean {
  return matchesPrefix(args, HOST_APPROVAL_COMMANDS)
}

export function canAutoConfirm(args: readonly string[]): boolean {
  return !requiresHostApproval(args) && matchesExact(args, READ_COMMANDS)
}

/**
 * 命令白名单**门禁**（不只是"建议"）。
 *
 * 安全边界文档第 9 行写的是「白名单 + 参数正则；写操作不在白名单」，
 * 但首版的 `requiresHostApproval` / `canAutoConfirm` 只用来决定**是否注入 `-y`**
 * —— `run()` 并不拒绝白名单外的命令。也就是文档描述的这道拦**实际不存在**。
 *
 * 现在补上：只有三张表里的命令允许执行，其余一律抛错。
 *
 * ## ★ 这个函数必须是**所有** dws 调用的必经之路
 *
 * 首版只有 `DwsCli.run()` 调它，而 `auth.ts` 直接用 `processes.exec` /
 * `processes.spawn` 起 dws —— 那条路径完全绕过门禁。现在 auth 侧也显式调用
 * 本函数（见 auth.ts 的注释），并且 `auth login` / `auth logout` 进了
 * `INTERACTIVE_COMMANDS`（首版若走门禁会被拒，因为白名单里只有 `auth status`）。
 *
 * 这是「agent 手上没有发送工具」之外的**第二道保险**：
 * 即使将来某处代码路径被 injection 影响去拼一条 `dws` 命令，
 * 白名单外的命令名根本走不出这个函数。
 */
export function assertAllowedCommand(args: readonly string[]): void {
  if (
    matchesExact(args, READ_COMMANDS) ||
    matchesExact(args, INTERACTIVE_COMMANDS) ||
    matchesPrefix(args, HOST_APPROVAL_COMMANDS)
  ) {
    return
  }
  throw new AppError("FORBIDDEN", "渠道命令不在白名单内", {
    messageKey: "errors:byCode.FORBIDDEN",
    // 只记命令路径（不含 flag 值）：参数里可能有会话 id、手机号等标识
    context: { args: commandPath(args).slice(0, 4) },
  })
}

/**
 * 三张白名单表的只读视图。
 *
 * 导出是为了让测试能断言「每一项都能匹配到至少一条真实 dws 子命令」——
 * 首版有三条匹配不到任何真实命令的死条目（其中一条还是采集正在调的），
 * 而死条目与"挡住了"在外观上完全相同。
 */
export const DWS_COMMAND_ALLOWLIST = {
  read: READ_COMMANDS,
  hostApproval: HOST_APPROVAL_COMMANDS,
  interactive: INTERACTIVE_COMMANDS,
} as const

/**
 * 服务端错误码 → 我们的错误码。**这是首选判据**（见 `classifyDwsError`）。
 *
 * 实测失败响应里有一个结构化的 `server_error_code` 字段，比在中文文案里
 * 找关键词可靠得多。当前实测到的两个：
 *
 * · `1001` —— 「该群为保密群，无法获取消息记录」。**没有补救动作**，
 *   唯一正确处置是永久跳过（`RESOURCE_FORBIDDEN`）。
 * · `CrossOrgPermissionDenied` —— 对端在其它组织，需要用户在宿主 UI 上
 *   授权一次（`PERMISSION_REQUIRED`）。
 *   ⚠️ 实测这个错误**绝大多数是我们自己调错了**：用会话列表里的
 *   `ownerOpenDingtalkId` 当单聊对端会稳定触发它（那个字段在 20 个不同
 *   单聊里取值完全相同，根本不是对端标识）。改用消息里的
 *   `senderOpenDingTalkId` 后 30 个单聊里 29 个不再需要任何授权。
 *   所以看到这个码先怀疑 ID，别急着让用户去授权。
 */
const SERVER_ERROR_CODES: Readonly<
  Record<
    string,
    { code: "RESOURCE_FORBIDDEN" | "PERMISSION_REQUIRED"; message: string; messageKey: string }
  >
> = {
  "1001": {
    code: "RESOURCE_FORBIDDEN",
    message: "该会话被服务端标记为不可读取（保密会话）",
    messageKey: "errors:byCode.RESOURCE_FORBIDDEN",
  },
  CrossOrgPermissionDenied: {
    code: "PERMISSION_REQUIRED",
    message: "跨组织会话需要在来源应用中授权",
    messageKey: "errors:byCode.PERMISSION_REQUIRED",
  },
}

/**
 * PAT 家族的错误码。这类失败**不走 `{"error":{...}}` 信封**，
 * 而是把一行裸 JSON 直接打到 stderr（`{"code":"PAT_...","data":{...},"success":false}`）。
 *
 * 两族的处置不同，所以分开列：
 * · `*_NO_PERMISSION` / `ORG_POLICY_DENIED` —— 权限不足，用户要去授权；
 * · `*_AUTH_REQUIRED` / `AGENT_CODE_NOT_EXISTS` / `BATCH_AUTH_PENDING` ——
 *   需要补一次授权动作（scope 不够等）。
 *
 * ⚠️ 都归 `PERMISSION_REQUIRED`（去来源应用确认），**不是** `SESSION_EXPIRED`：
 * 提示用户重新扫码对缺 scope 永远无效，用户会反复扫而问题不变。
 */
const PAT_ERROR_CODES: readonly string[] = [
  "PAT_NO_PERMISSION",
  "PAT_LOW_RISK_NO_PERMISSION",
  "PAT_MEDIUM_RISK_NO_PERMISSION",
  "PAT_HIGH_RISK_NO_PERMISSION",
  "PAT_ORG_POLICY_DENIED",
  "PAT_SCOPE_AUTH_REQUIRED",
  "PAT_BATCH_AUTH_PENDING",
  "AGENT_CODE_NOT_EXISTS",
]

/**
 * 失败输出里的结构化字段。
 *
 * 失败响应实测走 **stderr**、**stdout 为空**（`-f json` 也一样）。
 * 调用方把 stdout 与 stderr 拼在一起喂进来，所以这里对两者都能工作。
 *
 * 两种形态都要认：
 * · 信封式 `{"error":{"category":"auth","code":2,"reason":"not_authenticated",...}}`
 * · PAT 裸 JSON `{"code":"PAT_NO_PERMISSION","data":{...},"success":false}`
 */
interface DwsErrorEnvelope {
  /** `error.category`。⚠️ 实测**不可靠**，见 `classifyDwsError` 里的说明。 */
  category: string | null
  /** `error.code`：与进程退出码同值。2=授权、4=PAT。 */
  code: number | null
  /** `error.reason`：稳定的机器可读原因，如 `not_authenticated`、`http_401`。 */
  reason: string | null
  /** 服务端业务码（保密群 1001 等）。 */
  serverErrorCode: string | null
  /** PAT 裸 JSON 顶层的 `code`（字符串码，与上面的数字 `code` 不同层）。 */
  patCode: string | null
  /**
   * `error.message` 原文。
   *
   * ★ 需要它是因为 **code 3（validation）不止一种含义**，而它们的处置不同：
   * · `organization "…" not found` —— 钉住的身份在本机没登录态（终态，要重新授权）
   * · `unknown flag: …`           —— 我们自己传错了参数（终态，但那是代码 bug）
   * 两者的 `code` 与 `category` 完全一样，只有 `reason` 与文案能分开
   * （实测前者无 `reason`，后者是 `unknown_flag`）。
   */
  message: string | null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/**
 * 解析失败输出里的结构化字段。全部拿不到时返回 null（退回文本匹配）——
 * 拿不到结构化码不该让归类整体失效。
 *
 * 复用 `extractJson`（它按**出现位置**选定界符，见那里的注释），
 * 不要另写一个 `indexOf("{")` 版本：两份提取逻辑会在某天对同一段输出给出不同结果。
 */
function extractErrorEnvelope(output: string): DwsErrorEnvelope | null {
  const parsed = extractJson(output)
  if (typeof parsed !== "object" || parsed === null) return null
  const root = parsed as Record<string, unknown>

  // PAT 家族：裸 JSON，顶层就是 code/success，没有 error 信封。
  const patCode = asNonEmptyString(root["code"])

  const error = root["error"]
  if (typeof error !== "object" || error === null) {
    return patCode === null
      ? null
      : { category: null, code: null, reason: null, serverErrorCode: null, patCode, message: null }
  }
  const fields = error as Record<string, unknown>
  return {
    category: asNonEmptyString(fields["category"]),
    code: typeof fields["code"] === "number" ? (fields["code"] as number) : null,
    reason: asNonEmptyString(fields["reason"]),
    serverErrorCode: asNonEmptyString(fields["server_error_code"]),
    patCode,
    message: asNonEmptyString(fields["message"]),
  }
}

/**
 * 「钉住的那个身份在本机不存在」的判据。
 *
 * ## ★★ 为什么不能只看 `code === 3`
 *
 * 实测 code 3（`category: "validation"`）**至少两种含义**：
 *
 * | 触发                          | code | reason         | message                              |
 * |-------------------------------|------|----------------|--------------------------------------|
 * | `--profile` 指向不存在的身份   | 3    | （无）         | `organization "…" not found`         |
 * | 我们自己传了个不存在的 flag    | 3    | `unknown_flag` | `unknown flag: --xxx`                |
 *
 * 只看 code 会把后者也归成"身份不可用"，于是一个**代码 bug**被显示成
 * 「请重新授权」——用户照做，扫完码问题还在，而真正的原因（参数拼错了）
 * 被一条用户友好的文案盖住了。这正是本仓库最贵的那类 bug 的形状。
 *
 * 所以判据是三段：`code === 3` **且** 不是 `unknown_flag` **且** 文案含
 * `not found`。三种真实身份错误的文案都命中最后一条（实测）：
 * `organization "…" not found` / `account "…" not found in organization "…"` /
 * `profile "…" not found`。
 */
function isIdentityUnavailable(envelope: DwsErrorEnvelope): boolean {
  if (envelope.code !== 3) return false
  // 参数拼错是我们自己的 bug，不是用户要重新授权 —— 让它走兜底并保留原文。
  if (envelope.reason === "unknown_flag") return false
  return (envelope.message ?? "").toLowerCase().includes("not found")
}

/**
 * 授权失效的 `error.reason` 值（实测自 CLI 源码 `internal/`，见下方矩阵）。
 *
 * 都表示「当前登录态不被接受」，处置是让用户重新扫码。
 * `http_403` **刻意不在这里** —— 它是权限不足而不是登录掉了，
 * 提示重新扫码对它无效（归到 `PERMISSION_REQUIRED`）。
 */
const SESSION_EXPIRED_REASONS: readonly string[] = [
  "not_authenticated",
  "not_configured",
  "http_401",
  "gateway_auth_expired",
  "auth_refresh_failed",
  "token_refresh_failed",
]

/** 权限不足（不是登录问题）的 `error.reason` 值。 */
const PERMISSION_REASONS: readonly string[] = ["http_403"]

/**
 * 从输出里归类错误。
 *
 * ## ★ 优先读结构化字段，文本匹配只是退路
 *
 * 首版只有文本匹配，两次都栽在同一件事上：**文案里没有我们找的那个词**。
 * · 保密群（`server_error_code=1001`）一个关键词都不命中；
 * · 未登录时 CLI 输出的是 `not_authenticated`（**下划线**），
 *   而模式串写的是 `"not authenticated"`（空格）—— 12 条串**全部 miss**。
 *   后果：`PROCESS_FAILED{retryable:true}` → 无限退避重试，
 *   `blockedReason` 永不置位，界面只显示「渠道命令失败（exit 2）」，
 *   用户不知道要去重新授权（实测连续重试 16 次仍在重试）。
 *
 * ## ★ 判据为什么是 `code`/`reason` 而不是 `category`
 *
 * 实测矩阵（0.2.99 与 v1.0.52.1 一致；用空 HOME + 回环 mock endpoint 复现）：
 *
 * | 场景                              | exit | category   | code | reason              |
 * |-----------------------------------|------|------------|------|---------------------|
 * | 未登录（数据命令）                 | 2    | `auth`     | 2    | `not_authenticated` |
 * | 200 体带 `USER_TOKEN_ILLEGAL`     | 2    | `internal` | 2    | （无）               |
 * | 真 HTTP 401（带 `--token`）        | 5    | `internal` | 5    | （无）               |
 * | `PAT_NO_PERMISSION`               | 4    | 裸 JSON     | —    | —                   |
 * | `PAT_SCOPE_AUTH_REQUIRED`         | 5    | 裸 JSON     | —    | —                   |
 *
 * 所以 **`category` 不可靠**（网关类授权错误报的是 `internal`），
 * 单看 exit code 也不够（401 走 5、PAT 有 4 也有 5）。
 * 判据按可靠性排：PAT 码 → `reason` → `code===2` → 文本兜底。
 *
 * `code===2` 可以直接判成授权失效：CLI 里 exit 2 **只有** auth 一族用
 * （`internal/errors/errors.go` CategoryAuth→2、
 * `internal/helpers/errors.go` AUTH_NOT_CONFIGURED/AUTH_TOKEN_EXPIRED→2）。
 *
 * 文本匹配保留为退路（老版本、非 JSON 输出、裸 Error 冒上来的场景）。
 * 匹配串保持宽松，漏判退化成可重试错误 —— 可接受；
 * 误判成终态会让本可自愈的故障要求用户介入 —— 不可接受。
 */
export function classifyDwsError(output: string): AppError | null {
  const envelope = extractErrorEnvelope(output)

  if (envelope !== null) {
    // ① PAT 家族：裸 JSON，处置是去来源应用授权（不是重新扫码）。
    if (envelope.patCode !== null && PAT_ERROR_CODES.includes(envelope.patCode)) {
      return new AppError("PERMISSION_REQUIRED", "缺少授权，需要在来源应用中确认", {
        retryable: false,
        messageKey: "errors:byCode.PERMISSION_REQUIRED",
        context: { patCode: envelope.patCode },
      })
    }

    // ② 服务端业务码：保密群等「授权也解决不了」的终态。
    if (envelope.serverErrorCode !== null) {
      /**
       * 开源版 v1.0.56 的 `list_group_member_by_ids` 也会复用 1001 表示
       * `no permission: org not match`。它不是保密群，只是该群所属组织与
       * 当前 profile 不匹配；仍归 RESOURCE_FORBIDDEN，但不能给用户错误文案。
       */
      if (envelope.serverErrorCode === "1001" && output.toLowerCase().includes("org not match")) {
        return new AppError("RESOURCE_FORBIDDEN", "该资源所属组织与当前登录组织不一致", {
          retryable: false,
          messageKey: "errors:byCode.RESOURCE_FORBIDDEN",
          context: { serverErrorCode: envelope.serverErrorCode, reason: "org_not_match" },
        })
      }
      const mapped = SERVER_ERROR_CODES[envelope.serverErrorCode]
      if (mapped !== undefined) {
        return new AppError(mapped.code, mapped.message, {
          // 终态：重试永远好不了，只会反复骚扰用户或白烧配额。
          retryable: false,
          messageKey: mapped.messageKey,
          context: { serverErrorCode: envelope.serverErrorCode },
        })
      }
    }

    // ③ reason 是最精确的授权判据（能分开「登录掉了」与「缺权限」）。
    if (envelope.reason !== null) {
      if (SESSION_EXPIRED_REASONS.includes(envelope.reason)) {
        return sessionExpired({ reason: envelope.reason })
      }
      if (PERMISSION_REASONS.includes(envelope.reason)) {
        return new AppError("PERMISSION_REQUIRED", "缺少授权，需要在来源应用中确认", {
          retryable: false,
          messageKey: "errors:byCode.PERMISSION_REQUIRED",
          context: { reason: envelope.reason },
        })
      }
    }

    /**
     * ④ 钉住的身份在本机没有登录态（`--profile` 指向一个不存在的组织/账号）。
     *
     * ★ 必须在下面的数字 code 分支**之前**，而它本身要比 `code === 3` 更严 ——
     * 判据见 `isIdentityUnavailable`（code 3 还被 `unknown_flag` 用着，
     * 那是代码 bug 而不是"请重新授权"）。
     *
     * ★★ 终态（`retryable: false`）。不归类的话它落到最下面的兜底
     * `PROCESS_FAILED` + `retryable: true` —— 那是一场无限重试风暴：
     * 每一轮采集都失败、每一次都判定可以重试，日志刷屏而用户毫不知情。
     */
    if (isIdentityUnavailable(envelope)) {
      return new AppError(
        "CHANNEL_IDENTITY_UNAVAILABLE",
        "这个身份在本机没有登录态，请重新授权到它（或切换到其它身份）",
        {
          retryable: false,
          messageKey: "errors:byCode.CHANNEL_IDENTITY_UNAVAILABLE",
          // 只记 code：message 里带组织 id，那是标识符，不进日志
          context: { code: 3 },
        },
      )
    }

    // ⑤ 没有 reason 时退到数字 code（`category` 不可信，见上方矩阵）：
    //    · 2 = auth 一族独占（CategoryAuth 与 AUTH_NOT_CONFIGURED/AUTH_TOKEN_EXPIRED）；
    //    · 4 = 权限不足（PAT 拦截与实测的 HTTP 403 都落在这里）。
    //    ⚠️ 顺序上 4 要先判：403 是权限问题，提示重新扫码对它无效。
    if (envelope.code === 4) {
      return new AppError("PERMISSION_REQUIRED", "缺少授权，需要在来源应用中确认", {
        retryable: false,
        messageKey: "errors:byCode.PERMISSION_REQUIRED",
        context: { code: 4 },
      })
    }
    if (envelope.code === 2) {
      return sessionExpired({ code: 2 })
    }
  }

  const text = output.toLowerCase()

  if (
    text.includes("refresh token") ||
    // ★ 下划线与空格两种都要有：CLI 输出的是 `not_authenticated`，
    //   只写空格版等于这条判据从不生效（首版就是这么漏的）。
    text.includes("not_authenticated") ||
    text.includes("not authenticated") ||
    text.includes("unauthenticated") ||
    text.includes("未登录") ||
    text.includes("登录已过期") ||
    text.includes("请重新登录") ||
    text.includes("token expired") ||
    text.includes("token 已过期") ||
    // ★ 真 HTTP 401 实测报的是 `category:internal, code:5`，**既没有 reason
    //   也不含上面任何一个词**（原文：`Auth error: request to ... returned
    //   HTTP 401`）。只靠结构化字段会漏掉它，所以这两个标记必须留在文本兜底里。
    text.includes("auth error") ||
    text.includes("http 401")
  ) {
    return sessionExpired({ matchedBy: "text" })
  }

  if (
    text.includes("permission denied") ||
    text.includes("not authorized") ||
    text.includes("scope") ||
    text.includes("需要授权") ||
    text.includes("未授权") ||
    text.includes("chmod")
  ) {
    return new AppError("PERMISSION_REQUIRED", "缺少授权，需要在来源应用中确认", {
      retryable: false,
      messageKey: "errors:byCode.PERMISSION_REQUIRED",
      context: { matchedBy: "text" },
    })
  }

  return null
}

function sessionExpired(context: Record<string, unknown>): AppError {
  return new AppError("SESSION_EXPIRED", "渠道登录已过期，需要重新授权", {
    retryable: false,
    messageKey: "errors:byCode.SESSION_EXPIRED",
    context,
  })
}

export interface DwsCliOptions {
  runtime: RuntimeEnv
  processes: ProcessRunner
  logger: Logger
  /** 单次命令超时。读命令实测 0.6-0.7s，30s 足够且能挡住挂死。 */
  timeoutMs?: number
}

export interface DwsCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export class DwsCli {
  constructor(private readonly options: DwsCliOptions) {}

  /**
   * 执行一条命令并返回原始输出。
   *
   * 不在这一层解析 JSON：有的命令输出数组、有的输出对象、有的先打横幅，
   * 让每个调用方按自己的形态解析比在这里做一个"万能解析"更清楚。
   */
  async run(
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs?: number; establishingIdentity?: boolean } = {},
  ): Promise<DwsCommandResult> {
    // ★ 白名单门禁：白名单外的命令根本走不出这里（不只是"不自动确认"）。
    assertAllowedCommand(args)

    const binary = this.options.runtime.resolve("dws")
    const finalArgs = [...args]

    // 读命令固定 JSON 输出。已经带了 -f 的不重复注入（调用方可能指定别的格式）。
    if (!finalArgs.includes("-f") && !finalArgs.includes("--format")) {
      finalArgs.push("-f", "json")
    }
    // 可自动确认的读命令加 -y，避免子进程静默挂在确认提示上。
    if (canAutoConfirm(args) && !finalArgs.includes("-y") && !finalArgs.includes("--yes")) {
      finalArgs.push("-y")
    }
    /**
     * ★★ 钉住身份：这条命令按**当前挂载 vault 绑定的那个身份**作答。
     *
     * 不钉的话它跟着 CLI 的全局 `currentProfile` 走 —— 那个值可能被用户在
     * 终端里改掉，于是我们拿着 A 的库去读 B 的会话（实测过：库里 248 个会话
     * 属于组织甲，而采集器在按组织乙列会话）。完整的实测数据与为什么用
     * `--profile` 而不是 `profile switch`，见 `RuntimeEnvOptions.dwsProfile`。
     *
     * 调用方已显式指定时不覆盖：那是"我就要问这一个身份"（比如授权后
     * 拿刚拿到的凭据去核对），比这里的默认更具体。
     */
    if (!finalArgs.includes("--profile")) {
      const pinned = this.options.runtime.dwsProfileArgs()
      /**
       * ★★ 钉不上身份时**拒绝执行业务命令**，而不是"就这么跑"。
       *
       * ## 为什么必须拒绝
       *
       * 钉不上（vault 还没绑身份）时不带 `--profile`，命令就跟着 CLI 的
       * **全局 currentProfile** 走 —— 而那个值由用户在终端里的最后一次
       * 操作决定，可能是**另一个组织**。于是"还没授权"这个状态下我们
       * 反而去读了某个人的会话与消息，且落进一个不属于任何身份的库。
       *
       * 这与 CLAUDE.md §5「不许扩大读取面」直接冲突，而且完全静默：
       * 命令成功、数据入库、日志正常。
       *
       * ## 为什么 `auth` 一族要放行
       *
       * 它们是"还没有身份时唯一能做的事"：`auth status` 要回答"这台机器
       * 登录了谁"（不钉才问得到），`auth login` 是获得身份的入口。
       * 判据用**命令路径前两段**而不是白名单表：`auth` 子树整体属于
       * "身份之前"的阶段，而业务命令（chat/contact/minutes/doc/…）
       * 一律要求先有身份。
       *
       * ★ 抛而不是返回空结果：静默返回空会被上层解读成"这个账号没有会话"，
       * 那正是本仓库最贵的那类 bug（把"读不到"记成"0 条"）。
       *
       * ## ★★ `establishingIdentity` —— 「获得身份」那条链的显式通路
       *
       * 光放行 `auth` 不够：**确定"我是谁"本身**要跑 `contact user get-self`
       * 与 `contact user search`，而那两条是 contact 子树。于是这道闸把
       * 「用这个身份」按钮打死了（实测：点了没反应）——
       * `adoptExistingSession → resolveSelf → get-self` 被拒，
       * 而上层 `confirmIdentity` 的 catch 把异常吞掉、照常返回成功。
       * 死锁：采纳是**获得**身份的入口，却需要身份才能跑。
       *
       * 所以给这条链一个**显式**的旗子，而不是放宽判据：
       * · 调用方必须写明"我正在确定身份"，读代码时看得见；
       * · 只有 `identity.resolveSelf()` 那一条链传它（见 self-identity.ts），
       *   其余业务命令一律照拦。
       *
       * ⚠️ 它**不是**万能钥匙：`assertAllowedCommand` 那道白名单门禁在上面、
       * 与这里无关，`get-self`/`search` 本来就在白名单里且都是纯读。
       * 这个旗子只解除"必须先有身份"这一条前置，而那一条对
       * "正在确定身份"这件事本身自相矛盾。
       */
      if (
        pinned.length === 0 &&
        commandPath(args)[0] !== "auth" &&
        options.establishingIdentity !== true
      ) {
        throw new AppError(
          "CHANNEL_IDENTITY_UNAVAILABLE",
          "还没绑定渠道身份，拒绝执行渠道命令（否则会跟着 CLI 的全局身份读到别人的数据）",
          {
            retryable: false,
            messageKey: "errors:byCode.CHANNEL_IDENTITY_UNAVAILABLE",
            // 只记命令名：参数里可能有会话 id
            context: { command: commandPath(args).join(" ") },
          },
        )
      }
      finalArgs.push(...pinned)
    }

    const result = await this.options.processes.exec({
      executable: binary.path,
      args: finalArgs,
      env: this.options.runtime.buildEnv(),
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 30_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    if (result.exitCode !== 0) {
      const classified = classifyDwsError(`${result.stdout}\n${result.stderr}`)
      if (classified !== null) throw classified
      throw new AppError("PROCESS_FAILED", `渠道命令失败（exit ${result.exitCode}）`, {
        // 未归类的失败按可重试处理：本可自愈的故障不该要求用户介入。
        retryable: true,
        messageKey: "errors:process.failed",
        messageParams: { detail: result.stderr.slice(-200) },
        context: { args: finalArgs.slice(0, 4), exitCode: result.exitCode },
      })
    }

    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  /**
   * 执行并解析 JSON，**并剥掉传输层信封**。解析失败抛 PARSE_FAILED（不是静默返回空对象）。
   *
   * 返回的是 `result` 的内容，业务解析器看不到信封。
   */
  async json<T>(
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs?: number; establishingIdentity?: boolean } = {},
  ): Promise<T> {
    const result = await this.run(args, options)
    const parsed = extractJson(result.stdout)
    if (parsed === undefined) {
      throw new AppError("PARSE_FAILED", "渠道命令未返回可解析的 JSON", {
        messageKey: "errors:byCode.PARSE_FAILED",
        context: { args: args.slice(0, 4), head: result.stdout.slice(0, 120) },
      })
    }
    return unwrapEnvelope(parsed, args) as T
  }
}

/**
 * 剥掉 DWS 的响应信封 `{arguments, errorCode, errorMsg, result, success}`。
 *
 * ## 为什么在传输层剥，而不是各解析器自己剥
 *
 * 信封是 **CLI 的传输层约定**（每个子命令都有），不是某个命令的业务形状。
 * 在唯一入口剥掉之后，业务解析器不必知道它存在 —— 也就不会再出现
 * 「一处剥了、一处没剥」。
 *
 * ★ 这正是本轮修复的那个故障：`message-parse.ts` 在**根对象**上找
 * `conversationMessagesList`（真实位置在 `result` 下），而同一个仓库里
 * 探针的 `toArray()` 候选键里**有** `result` 所以是对的。
 * 同一个 CLI 的信封假设在一个仓库里不一致，正文那条路于是静默返回
 * `{messages: [], itemCount: 0}` —— 看起来就是"这个时间窗没有新消息"，
 * 采集器照常记成功、水位照常前移。**实测 277 页原始响应、1678 条消息，
 * 落库 0 条。**
 *
 * ## 判据：同时有 `success` 且有 `result` 键
 *
 * 只看 `result` 会误伤某些业务对象本身就叫 `result` 的响应；
 * 只看 `success` 则拿不到数据。两者同时出现才是信封。
 * `result` 可能是对象（`chat message list-all`）也可能是**数组**
 * （`contact user get-self` / `search` 实测），所以不能假设它是对象。
 *
 * `errorCode` / `errorMsg` 实测存在于 `minutes list` 等命令：
 * exit code 为 0 但业务失败时，这两个字段是唯一的信号 ——
 * 不检查会让业务错误伪装成"返回了空数据"。
 */
export function unwrapEnvelope(parsed: unknown, args: readonly string[] = []): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed
  const record = parsed as Record<string, unknown>
  if (!("success" in record) || !("result" in record)) return parsed

  // exit 0 但业务失败：errorCode 非空是唯一信号。
  const errorCode = record["errorCode"]
  if (errorCode !== null && errorCode !== undefined && errorCode !== "") {
    const errorMsg = record["errorMsg"]
    throw new AppError("PROCESS_FAILED", `渠道命令返回业务错误：${String(errorCode)}`, {
      retryable: true,
      messageKey: "errors:process.failed",
      messageParams: { detail: typeof errorMsg === "string" ? errorMsg : String(errorCode) },
      context: { args: args.slice(0, 4), errorCode: String(errorCode) },
    })
  }

  // `success: false` 且没有 errorCode：仍然是失败，但没有可用的分类信息。
  if (record["success"] === false) {
    throw new AppError("PROCESS_FAILED", "渠道命令返回 success=false", {
      retryable: true,
      messageKey: "errors:process.failed",
      messageParams: { detail: "success=false" },
      context: { args: args.slice(0, 4) },
    })
  }

  return record["result"]
}

/**
 * 从可能混有日志行的输出里提取 JSON。
 *
 * DWS 在某些子命令下会先打人类可读的横幅再打 JSON，
 * 因此不能直接 `JSON.parse` 整段。
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // 退回到「第一个 { 或 [ 到对应的最后一个 } 或 ]」。
    //
    // ★ 必须按**出现位置**选定界符，不能固定先试 `{`：
    //   `INFO ready\n[{"id":"x"}]` 里 `{` 出现在 `[` 之后，
    //   先试 `{` 会切出内层对象 `{"id":"x"}` 并成功解析 ——
    //   于是数组响应被静默降级成了它的第一个元素（下游只看到一条记录）。
    const candidates = [
      { open: trimmed.indexOf("{"), close: trimmed.lastIndexOf("}") },
      { open: trimmed.indexOf("["), close: trimmed.lastIndexOf("]") },
    ]
      .filter((candidate) => candidate.open !== -1 && candidate.close > candidate.open)
      .sort((a, b) => a.open - b.open)

    for (const candidate of candidates) {
      try {
        return JSON.parse(trimmed.slice(candidate.open, candidate.close + 1))
      } catch {
        continue
      }
    }
    return undefined
  }
}
