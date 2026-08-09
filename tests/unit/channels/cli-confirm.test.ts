/**
 * CLI 命令白名单与错误归类。
 *
 * 两类静默失败：
 * ① 触发确认提示而没传 `-y` → 子进程**挂到 timeout**，
 *    表现是"超时了"而真实原因是它在等一个永远不会来的回车；
 * ② 把「缺授权」当可重试错误 → 反复弹窗骚扰用户，而且永远好不了。
 */
import { describe, expect, it } from "vitest"
import {
  assertAllowedCommand,
  canAutoConfirm,
  classifyDwsError,
  DWS_COMMAND_ALLOWLIST,
  DwsCli,
  extractJson,
  requiresHostApproval,
} from "@mycontext/channels"
import { type AppError, isAppError } from "@mycontext/kernel"
import {
  REAL_ERR_GATEWAY_TOKEN_INVALID,
  REAL_ERR_HTTP_401,
  REAL_ERR_HTTP_403,
  REAL_ERR_NOT_AUTHENTICATED,
  REAL_ERR_NOT_AUTHENTICATED_TABLE,
  REAL_ERR_PAT_NO_PERMISSION,
  REAL_ERR_PAT_SCOPE_REQUIRED,
  REAL_ERR_PROFILE_ACCOUNT_NOT_FOUND,
  REAL_ERR_PROFILE_NOT_FOUND,
  REAL_ERR_PROFILE_ORG_NOT_FOUND,
  REAL_ERR_UNKNOWN_FLAG,
} from "../../fixtures/dingtalk-real-payloads.js"

describe("命令分类", () => {
  it.each([
    [["chat", "chmod", "chat.message:send"]],
    [["chat", "message", "send", "--user", "x"]],
    // ★ 顶层 `data-auth` 不存在（实测 `dws data-auth` 打印服务列表），
    // 真实路径是 `chat data-auth [cross-org]`。
    [["chat", "data-auth", "cross-org"]],
  ])("%j 需要宿主 UI 授权（-y 绕不过）", (args) => {
    expect(requiresHostApproval(args)).toBe(true)
    // 需要宿主授权的命令**不能**自动确认
    expect(canAutoConfirm(args)).toBe(false)
  })

  it.each([
    [["auth", "status"]],
    [["contact", "user", "get-self"]],
    [["chat", "message", "list-all", "--start", "x"]],
    // ★ 在 `chat message` 下，不在 `chat` 下（首版写错，实测探针从未工作）
    [["chat", "message", "list-unread-conversations"]],
    [["chat", "conversation-info", "--group", "cid"]],
  ])("%j 是读命令，可自动 -y", (args) => {
    expect(requiresHostApproval(args)).toBe(false)
    expect(canAutoConfirm(args)).toBe(true)
  })

  /**
   * ★ 白名单而不是黑名单：新增一个我们没预料到的写命令时，
   * 白名单的默认行为是"不自动确认"（安全），黑名单是"自动确认"（危险）。
   */
  it("未登记的命令默认不自动确认", () => {
    expect(canAutoConfirm(["some", "future", "write-command"])).toBe(false)
  })

  it("send 不会因为前缀相似而被误判为读命令", () => {
    // `chat message list` 可自动确认，`chat message send` 绝不可以
    expect(canAutoConfirm(["chat", "message", "list"])).toBe(true)
    expect(canAutoConfirm(["chat", "message", "send"])).toBe(false)
  })

  /**
   * ★★ PII 子树不得因前缀而被顺手放行。
   *
   * 首版白名单里是 `["contact","user"]`（前缀），于是整棵子树被放行 ——
   * 实测 `contact user profile get` 的 --help 原文写明返回
   * **银行卡 / 合同 / 家庭信息 / 学历**，而它 `blocked=false` 且被注入 `-y`。
   * 我们的蒸馏语料来自聊天记录，不需要花名册；这三条必须挡住。
   */
  it.each([
    [["contact", "user", "profile", "get", "--userid", "x"]],
    [["contact", "user", "search-mobile", "--mobile", "13800000000"]],
    [["contact", "user", "dismission", "search"]],
  ])("★ 拒绝 PII 类命令 %j（前缀白名单曾把它们顺手放行）", (args) => {
    expect(canAutoConfirm(args)).toBe(false)
    expect(() => assertAllowedCommand(args)).toThrow()
  })

  it("交互式命令（auth login）允许执行但不自动 -y", () => {
    const args = ["auth", "login", "--no-browser"]
    expect(() => assertAllowedCommand(args)).not.toThrow()
    // 它等的是真人扫码而不是确认提示，加 -y 只会让人误以为能无人值守
    expect(canAutoConfirm(args)).toBe(false)
  })
})

describe("错误归类：区分终态与可重试", () => {
  /**
   * ★ 这一组喂的是**真实 stderr**（`tests/fixtures` 里逐字节记录的）。
   *
   * 必须如此：首版 12 条模式串对真实输出**全部 miss**（CLI 输出
   * `not_authenticated` 下划线，模式写的是空格），而当时的单测全绿 ——
   * 因为 fixture 是照想象写的。用手写串测这个函数等于没测。
   *
   * 每条都标了它锁的是哪个坑；删掉判据里对应那一支，这里必须变红。
   */
  it.each([
    // 判据：reason=not_authenticated（首版就是这条 miss 的）
    ["未登录 / JSON", REAL_ERR_NOT_AUTHENTICATED],
    // 判据：文本兜底（非 JSON 输出没有结构化字段）
    ["未登录 / 表格", REAL_ERR_NOT_AUTHENTICATED_TABLE],
    // 判据：code===2（category 是 internal，且没有 reason）
    ["网关 token 失效", REAL_ERR_GATEWAY_TOKEN_INVALID],
    // 判据：文本里的 `auth error` / `http 401`（exit 5、无 reason）
    ["真 HTTP 401", REAL_ERR_HTTP_401],
  ])("真实输出 %s → SESSION_EXPIRED 且不可重试", (_label, output) => {
    const error = classifyDwsError(output)
    expect(error?.code).toBe("SESSION_EXPIRED")
    expect(error?.retryable).toBe(false)
  })

  it.each([
    // 判据：code===4。★ 403 是权限不是登录 —— 提示重新扫码对它无效
    ["真 HTTP 403", REAL_ERR_HTTP_403],
    // 判据：PAT 裸 JSON 顶层 code
    ["PAT 权限不足", REAL_ERR_PAT_NO_PERMISSION],
    ["PAT 缺 scope", REAL_ERR_PAT_SCOPE_REQUIRED],
  ])("真实输出 %s → PERMISSION_REQUIRED 且不可重试", (_label, output) => {
    const error = classifyDwsError(output)
    expect(error?.code).toBe("PERMISSION_REQUIRED")
    expect(error?.retryable).toBe(false)
  })

  /**
   * ★ 反证：锁住"下划线"这个具体的失效点。
   *
   * 这条不是重复上面 —— 上面喂整段真实输出，任何一支判据命中都会绿；
   * 这条只留下划线那个词，所以只有下划线模式串（或结构化判据）能救它。
   */
  it("`not_authenticated`（下划线）单独出现也能归类", () => {
    const error = classifyDwsError("dws: not_authenticated")
    expect(error?.code).toBe("SESSION_EXPIRED")
  })

  it("403 不能被误判成登录过期（提示重新扫码对权限问题无效）", () => {
    expect(classifyDwsError(REAL_ERR_HTTP_403)?.code).not.toBe("SESSION_EXPIRED")
  })

  /**
   * ★★ 钉住的身份在本机没有登录态 → 终态，**不是**可重试。
   *
   * ## 这一组锁的是一场无限重试风暴
   *
   * 渠道命令一律用 `--profile <corpId>:<userId>` 钉住当前 vault 绑的身份
   * （`corpId + userId` 是渠道侧多账号体系的主键：userId 只在企业内唯一，
   * 跨企业唯一要靠这两个的组合）。而那个身份可能已经不在本机了 ——
   * 用户在终端跑过登出、或换了台机器只拷了应用数据。
   *
   * 实测那时是 exit 3 + `{"category":"validation","message":"organization … not found"}`，
   * 而 `classifyDwsError` 原本对 code 3 **没有任何分支** —— 于是它落到最下面
   * 兜底的 `PROCESS_FAILED` + `retryable: true`：每一轮采集都失败、每一次都
   * 判定可以重试，日志刷屏而用户毫不知情。
   *
   * 三条真实文案（三种 `--profile` 写法各触发一种）都必须命中同一个终态。
   */
  it.each([
    ["组织不存在", REAL_ERR_PROFILE_ORG_NOT_FOUND],
    ["组织存在但账号不存在", REAL_ERR_PROFILE_ACCOUNT_NOT_FOUND],
    ["profile 串整个不认", REAL_ERR_PROFILE_NOT_FOUND],
  ])("真实输出 %s → CHANNEL_IDENTITY_UNAVAILABLE 且不可重试", (_label, output) => {
    const error = classifyDwsError(output)
    expect(error?.code).toBe("CHANNEL_IDENTITY_UNAVAILABLE")
    // ★ 关键断言：终态。改成 true 就是那场重试风暴。
    expect(error?.retryable).toBe(false)
  })

  /**
   * ★★ **不能只看 `code === 3`** —— 参数拼错也是 code 3 + validation。
   *
   * 实测两种含义，处置完全不同：
   * ```
   * --profile 指向不存在的身份 → code 3、无 reason、文案含 not found → 请用户重新授权
   * 我们自己传了个不存在的 flag → code 3、reason=unknown_flag、文案无 not found → 代码 bug
   * ```
   * 只看 code 会把后者也说成「请重新授权」—— 用户照做、扫完码问题还在，
   * 而真正的原因（参数拼错了）被一条用户友好的文案彻底盖住。
   *
   * ★ 真实的 `unknown_flag` 输出里**没有** `not found`，所以是文案判据把它
   * 挡住的；`isIdentityUnavailable` 里那句 `reason === "unknown_flag"` 是
   * **第二道**（万一上游哪天把文案改成 `flag … not found` 就靠它）。
   * 下面第二条用例专门锁那道 —— 它必须用一个**同时**命中两个信号的输入，
   * 否则删掉那一支这里也不会红（首版就是这样，等于没锁）。
   */
  it("★ 参数拼错（真实输出：code 3 + validation）不被当成身份不可用", () => {
    const error = classifyDwsError(REAL_ERR_UNKNOWN_FLAG)
    expect(error?.code).not.toBe("CHANNEL_IDENTITY_UNAVAILABLE")
  })

  /**
   * ★ 隔离 `reason === "unknown_flag"` 那一支（上面那条锁不住它）。
   *
   * 输入是**手构**的：code 3 + `unknown_flag` + 文案含 `not found` ——
   * 当前上游不产出这种组合（实测 unknown_flag 的文案里没有 not found），
   * 所以这是一条**前瞻**断言：上游改文案时它替我们守住"参数 bug 不要
   * 显示成请重新授权"。手构输入在这里是对的，因为要锁的正是"两个信号
   * 同时出现时谁优先"，而那个状态实测拿不到。
   */
  it("★ code 3 + unknown_flag + 文案含 not found → 仍不归身份不可用", () => {
    const output = `{"error":{"category":"validation","code":3,"reason":"unknown_flag","message":"unknown flag: --profiel not found"}}`
    expect(classifyDwsError(output)?.code).not.toBe("CHANNEL_IDENTITY_UNAVAILABLE")
  })

  /**
   * ★ 隔离"文案含 not found"这一支：code 3 但文案里没有 `not found`
   * （比如将来上游加了别的 validation 错误）不该被误归成身份问题。
   */
  it("code=3 但文案不含 not found → 不归身份不可用（留给上层重试）", () => {
    const output = `{"error":{"category":"validation","code":3,"message":"limit must be positive"}}`
    expect(classifyDwsError(output)?.code).not.toBe("CHANNEL_IDENTITY_UNAVAILABLE")
  })

  /**
   * ★ 隔离 `code===2` 这一支。
   *
   * 不能用整段真实网关输出来锁它：那段文案里带「Token 已过期」，
   * 会被文本兜底顺手接住 —— 实测把 `code===2` 分支整个删掉，
   * 上面那组真实输出**依然全绿**。所以这里把文案换成不含任何关键词的，
   * 让 `code===2` 成为唯一能救它的判据。
   *
   * 这正是「断言的字符串必须是被测逻辑独有的」那条：
   * 别处也能命中就等于没锁。
   */
  it("code=2 且文案无任何关键词 → 仍归 SESSION_EXPIRED（结构化判据独立生效）", () => {
    const output = `{"error":{"category":"internal","code":2,"message":"boom (operation: im/x)"}}`
    expect(classifyDwsError(output)?.code).toBe("SESSION_EXPIRED")
  })

  /** 同上，隔离 `code===4`（403/PAT 的结构化判据）。 */
  it("code=4 且文案无任何关键词 → 仍归 PERMISSION_REQUIRED", () => {
    const output = `{"error":{"category":"internal","code":4,"message":"boom (operation: im/x)"}}`
    expect(classifyDwsError(output)?.code).toBe("PERMISSION_REQUIRED")
  })

  /** 隔离 reason 判据：文案不含关键词、code 也不是 2/4。 */
  it("reason=gateway_auth_expired 且 code 非 2/4 → 仍归 SESSION_EXPIRED", () => {
    const output = `{"error":{"category":"internal","code":5,"reason":"gateway_auth_expired","message":"boom"}}`
    expect(classifyDwsError(output)?.code).toBe("SESSION_EXPIRED")
  })

  /** 隔离 PAT 判据：裸 JSON、文案无关键词。 */
  it("PAT 裸 JSON 且无关键词 → 仍归 PERMISSION_REQUIRED", () => {
    const output = `{"code":"PAT_BATCH_AUTH_PENDING","data":{},"success":false}`
    expect(classifyDwsError(output)?.code).toBe("PERMISSION_REQUIRED")
  })

  it("开源版复用 1001 表示跨组织群不可读时，不误报成保密会话", () => {
    const output = JSON.stringify({
      error: {
        category: "api",
        code: 5,
        server_error_code: "1001",
        message: "no permission: org not match",
      },
    })
    const error = classifyDwsError(output)
    expect(error?.code).toBe("RESOURCE_FORBIDDEN")
    expect(error?.message).toContain("组织")
    expect(error?.context?.["reason"]).toBe("org_not_match")
  })

  it("1001 的保密群错误仍保留原有分类与文案", () => {
    const output = JSON.stringify({
      error: {
        category: "api",
        code: 5,
        server_error_code: "1001",
        message: "该群为保密群，无法获取消息记录",
      },
    })
    const error = classifyDwsError(output)
    expect(error?.code).toBe("RESOURCE_FORBIDDEN")
    expect(error?.message).toContain("保密会话")
  })

  it.each([
    "Error: refresh token expired",
    "not authenticated",
    "登录已过期，请重新登录",
    "TOKEN EXPIRED",
  ])("%j → SESSION_EXPIRED 且不可重试", (output) => {
    const error = classifyDwsError(output)
    expect(error?.code).toBe("SESSION_EXPIRED")
    expect(error?.retryable).toBe(false)
  })

  it.each([
    "permission denied for scope chat.message:send",
    "not authorized",
    "需要授权：请在应用中确认",
    "未授权的操作",
  ])("%j → PERMISSION_REQUIRED 且不可重试", (output) => {
    const error = classifyDwsError(output)
    expect(error?.code).toBe("PERMISSION_REQUIRED")
    expect(error?.retryable).toBe(false)
  })

  it("网络类错误不被归类（交给上层退避重试）", () => {
    expect(classifyDwsError("connection reset by peer")).toBeNull()
    expect(classifyDwsError("dial tcp: i/o timeout")).toBeNull()
  })

  it("空输出不被归类", () => {
    expect(classifyDwsError("")).toBeNull()
  })

  /**
   * 非授权类的结构化失败**不能**被 code 判据顺手归成终态：
   * 校验失败（exit 3）与内部错误（exit 5）都该留给上层退避重试。
   */
  it.each([3, 5, 6])("error.code=%i 不被归类为授权终态", (code) => {
    const output = `{"error":{"category":"internal","code":${code},"message":"boom"}}`
    expect(classifyDwsError(output)).toBeNull()
  })
})

describe("JSON 提取（输出可能先带人类可读横幅）", () => {
  it("纯 JSON 对象", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it("前面有日志行的对象", () => {
    expect(extractJson('Loading profile...\n{"a":1}')).toEqual({ a: 1 })
  })

  it("数组形态", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3])
  })

  it("前面有日志行的数组", () => {
    expect(extractJson('INFO ready\n[{"id":"x"}]')).toEqual([{ id: "x" }])
  })

  it("完全不是 JSON 时返回 undefined（让调用方抛 PARSE_FAILED）", () => {
    expect(extractJson("just text")).toBeUndefined()
    expect(extractJson("")).toBeUndefined()
  })
})

/**
 * ★ 白名单是**门禁**而不是建议。
 *
 * 安全边界文档第 9 行写的是「白名单 + 参数正则；写操作不在白名单」，
 * 但首版的两个判定函数只用来决定是否注入 `-y` —— `run()` 不拒绝白名单外的命令，
 * 也就是文档描述的这道拦实际不存在。这组断言让它真实存在且不可回退。
 */
describe("★ 命令白名单门禁", () => {
  it.each([
    [["auth", "status"]],
    [["chat", "message", "list-all", "--start", "x"]],
    [["chat", "message", "list-unread-conversations"]],
    [["contact", "user", "get-self"]],
    [["contact", "user", "search", "--query", "x"]],
  ])("放行白名单内的读命令 %j", (args) => {
    expect(() => assertAllowedCommand(args)).not.toThrow()
  })

  it.each([
    [["chat", "chmod", "chat.message:send"]],
    [["chat", "message", "send", "--user", "x"]],
    [["chat", "data-auth"]],
  ])("放行需宿主授权的命令 %j（DWS 侧自己弹确认）", (args) => {
    expect(() => assertAllowedCommand(args)).not.toThrow()
  })

  it.each([
    [["chat", "message", "delete"]],
    [["admin", "reset"]],
    [["chat", "conversation-delete"]],
    // 会话管理类写操作：曾因 `["chat","conversation"]` 前缀相邻而值得单独钉住
    [["chat", "clear-messages"]],
    [["chat", "group", "destroy"]],
    // 顶层 data-auth 不存在，也不该被放行
    [["data-auth"]],
    [[]],
    [["--help"]],
  ])("拒绝白名单外的命令 %j", (args) => {
    expect(() => assertAllowedCommand(args)).toThrow()
  })

  it("拒绝时抛 FORBIDDEN（可被 UI 按错误码翻译）", () => {
    try {
      assertAllowedCommand(["admin", "reset"])
      expect.unreachable("应该抛错")
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("FORBIDDEN")
    }
  })

  /**
   * 拒绝时记的 context 只含命令路径，**不含 flag 值**。
   *
   * flag 值里会有会话 id、手机号这类标识；日志会被贴到 issue 里。
   */
  it("拒绝时的 context 不泄漏 flag 值", () => {
    try {
      assertAllowedCommand(["contact", "user", "search-mobile", "--mobile", "13800000000"])
      expect.unreachable("应该抛错")
    } catch (error) {
      expect(JSON.stringify(isAppError(error) ? error.context : {})).not.toContain("13800000000")
    }
  })

  /**
   * 空 prefix 数组会让 `every` 恒真、于是匹配一切命令。
   * 当前常量表里没有空项，这条断言的是「空参数不被任何前缀匹配上」——
   * 也就是守卫确实生效。
   */
  it("空参数不被任何前缀匹配（matchesPrefix 的空数组守卫）", () => {
    expect(requiresHostApproval([])).toBe(false)
    expect(canAutoConfirm([])).toBe(false)
    expect(() => assertAllowedCommand([])).toThrow()
  })
})

/**
 * ★★ 白名单里的**每一项**都必须能匹配到至少一条真实 dws 子命令。
 *
 * ## 为什么这条断言是必需的
 *
 * 死条目与"挡住了"在外观上完全相同。首版有三条匹配不到任何真实命令：
 * · `["chat","conversation"]` —— 真实是 `chat conversation-info`（前缀是全等比较，
 *   `conversation-info` ≠ `conversation`）；
 * · `["chat","list-unread-conversations"]` 与 `["chat","list-mentions"]` ——
 *   真实位置在 `chat message` 下。
 *
 * 前者是纯死条目（既挡不住也放行不了任何东西），后两条更糟：
 * **采集插件正在调 `chat list-unread-conversations`**，实测 DWS 返回
 * `unknown subcommand ... for "dws chat"` —— L1 探针从未真正工作过，
 * 而且不报错（走 PROCESS_FAILED 重试，表现是"探不到变化"）。
 *
 * ## 为什么不直接跑真 CLI
 *
 * 跑真二进制会让这条测试依赖 vendor 里的那个包与当前平台，
 * 门禁会在别人的机器上随机变红。所以这里对照一份**从真 CLI 的 --help
 * 抄下来的**子命令清单（每条都实测过），并要求两侧对得上。
 * dws 升级新增/改名子命令时，这份清单要跟着更新 —— 那正是我们希望
 * 有人显式做一次的动作。
 */
const REAL_DWS_COMMANDS: readonly string[][] = [
  // 实测来源：`dws auth --help`
  ["auth", "status"],
  ["auth", "login"],
  ["auth", "logout"],
  // 实测来源：`dws contact user --help`
  ["contact", "user", "get-self"],
  ["contact", "user", "get"],
  ["contact", "user", "search"],
  ["contact", "user", "search-mobile"],
  ["contact", "user", "profile"],
  ["contact", "user", "dismission"],
  // 实测来源：`dws chat --help`
  ["chat", "chmod"],
  ["chat", "data-auth"],
  ["chat", "conversation-info"],
  ["chat", "list-all-conversations"],
  ["chat", "list-top-conversations"],
  ["chat", "clear-messages"],
  ["chat", "search"],
  ["chat", "search-common"],
  // 实测来源：`dws chat group --help`
  ["chat", "group", "list-all"],
  ["chat", "group", "list-my-groups"],
  ["chat", "group", "get-by-group-id"],
  // 实测来源：`dws chat group members --help`（reference: chat/chat-group.md:64-69）
  ["chat", "group", "members"],
  ["chat", "group", "members", "list-by-ids"],
  ["chat", "group", "members", "add"],
  ["chat", "group", "members", "remove"],
  ["chat", "group", "members", "add-bot"],
  ["chat", "group", "members", "remove-bot"],
  // 实测来源：`dws chat message --help`
  ["chat", "message", "send"],
  ["chat", "message", "list"],
  ["chat", "message", "list-all"],
  ["chat", "message", "list-mentions"],
  ["chat", "message", "list-unread-conversations"],
  ["chat", "message", "list-by-ids"],
  /**
   * 实测来源：`dws chat message query-send-status --help`
   * （原文：「查询以当前用户身份发送的消息的发送状态。需要传入发送消息时
   * 返回的 openTaskId」，必填参数 `--open-task-id`）。
   *
   * 它是 `send` → 消息 id 关联链的必需一跳：`send` 只返回 `openTaskId`。
   */
  ["chat", "message", "query-send-status"],
  ["chat", "message", "download-media"],
  // 实测来源：`dws minutes --help` / `minutes list --help` / `minutes get --help`
  ["minutes", "list", "all"],
  ["minutes", "list", "mine"],
  ["minutes", "list", "shared"],
  ["minutes", "get", "info"],
  ["minutes", "get", "summary"],
  ["minutes", "get", "transcription"],
  ["minutes", "get", "keywords"],
  ["minutes", "get", "todos"],
  ["minutes", "get", "audio"],
  ["minutes", "get", "batch"],
  // 实测来源：`dws event --help`（DingTalk Stream 长连接事件）
  // consume 带一个位置参数 event_key；at 那条不需要指定会话（一个订阅覆盖全部群）。
  ["event", "consume", "user_im_message_receive_at"],
  ["event", "consume", "user_im_message_receive_o2o"],
  ["event", "consume", "user_im_message_receive_group"],
  ["event", "list"],
  ["event", "status"],
  ["event", "stop"],
  // 实测来源：`dws doc --help` / `doc read --help`
  // ★ 文件管理已从 doc 迁到 drive（doc --help 原文注明），所以列举走 drive/wiki。
  ["doc", "read"],
  ["doc", "info"],
  ["doc", "create"],
  ["doc", "update"],
  ["doc", "export"],
  ["doc", "import"],
  ["doc", "block"],
  ["doc", "comment"],
  ["doc", "template"],
  ["doc", "version"],
  ["doc", "media"],
  ["doc", "file"],
  // 实测来源：`dws drive --help` / `drive recent --help`
  ["drive", "recent"],
  ["drive", "list"],
  ["drive", "list-spaces"],
  ["drive", "info"],
  ["drive", "search"],
  ["drive", "download"],
  ["drive", "upload"],
  ["drive", "upload-info"],
  ["drive", "commit"],
  ["drive", "mkdir"],
  ["drive", "copy"],
  ["drive", "move"],
  ["drive", "rename"],
  ["drive", "delete"],
  ["drive", "recycle"],
  ["drive", "permission"],
  ["drive", "publish"],
  ["drive", "shortcut"],
  ["drive", "star"],
  ["drive", "stats"],
  // 实测来源：`dws wiki --help` / `wiki space --help` / `wiki node list --help`
  ["wiki", "space", "list"],
  ["wiki", "space", "create"],
  ["wiki", "space", "get"],
  ["wiki", "space", "search"],
  ["wiki", "space", "delete"],
  ["wiki", "node", "list"],
  ["wiki", "node", "create"],
  ["wiki", "node", "copy"],
  ["wiki", "node", "move"],
  ["wiki", "node", "delete"],
  ["wiki", "member"],
]

describe("★ 白名单每一项都对应真实 dws 子命令", () => {
  const allEntries = [
    ...DWS_COMMAND_ALLOWLIST.read.map((c) => ({ table: "read", command: c })),
    ...DWS_COMMAND_ALLOWLIST.hostApproval.map((c) => ({ table: "hostApproval", command: c })),
    ...DWS_COMMAND_ALLOWLIST.interactive.map((c) => ({ table: "interactive", command: c })),
  ]

  it.each(allEntries)("$table: $command 存在于真实 CLI", ({ command }) => {
    // 白名单项要么与某条真实命令全等，要么是它的前缀（chat chmod <scope> 那类）。
    const matched = REAL_DWS_COMMANDS.some(
      (real) =>
        real.length >= command.length && command.every((token, index) => real[index] === token),
    )
    expect(
      matched,
      `白名单项 ${JSON.stringify(command)} 匹配不到任何真实 dws 子命令 —— ` +
        `它要么是死条目（永远不生效），要么会让真实调用被门禁拒掉（运行时 FORBIDDEN）。` +
        `请对照 \`dws <service> --help\` 修正，并同步更新本文件的 REAL_DWS_COMMANDS。`,
    ).toBe(true)
  })

  /** 反向：清单本身不能空掉（否则上面那条 `some` 会恒假而不是恒真，但仍值得钉住）。 */
  it("清单与白名单都非空（否则这条门禁是空的）", () => {
    expect(REAL_DWS_COMMANDS.length).toBeGreaterThan(10)
    expect(allEntries.length).toBeGreaterThan(5)
  })
})

/**
 * `DwsCli.run` 的**整条缝**：真实 stderr → AppError。
 *
 * ## 为什么必须单独测这一层
 *
 * `classifyDwsError` 单独绿不代表生产会绿 —— 生产走的是
 * `run()` 里的 `exitCode !== 0` 分支，它把 stdout 与 stderr 拼起来再归类。
 * 而真实授权失败的形态恰好是 **stdout 为空、信封全在 stderr**：
 * 如果哪天有人"顺手"只把 stdout 喂进归类（看起来很合理，毕竟 `-f json`
 * 的输出通常在 stdout），判据会整体失效，而表现只是"又变成 exit 2 了"。
 *
 * 这条断言钉住的是：**stderr-only 的授权失败也必须被认出来**。
 */
describe("DwsCli.run：真实授权失败 → 终态 AppError", () => {
  const runWithStderr = async (stderr: string, exitCode: number) => {
    const cli = new DwsCli({
      runtime: {
        resolve: () => ({ path: "/fake/dws" }),
        buildEnv: () => ({}),
        /**
         * 钉一个假身份。
         *
         * ★ 这里**必须**钉：`run()` 现在对"没绑身份 + 业务命令"直接抛
         * `CHANNEL_IDENTITY_UNAVAILABLE`（不带 profile 会跟着 CLI 的全局身份
         * 读到别人的数据，见那处注释）。不钉的话这一组测的就变成了那个守卫，
         * 而它们真正要测的是**错误归类**（stderr-only 的授权失败能否被认出）。
         */
        dwsProfileArgs: () => ["--profile", "dingFAKECORP0001"],
      } as never,
      processes: {
        exec: async () => ({ exitCode, stdout: "", stderr, timedOut: false }),
      } as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    })
    return await cli.run(["chat", "list-all-conversations"]).then(
      () => null,
      (error: unknown) => error,
    )
  }

  it("未登录（信封只在 stderr）→ SESSION_EXPIRED 且不可重试", async () => {
    const error = await runWithStderr(REAL_ERR_NOT_AUTHENTICATED, 2)
    expect(isAppError(error)).toBe(true)
    expect((error as AppError).code).toBe("SESSION_EXPIRED")
    // ★ 关键：不可重试。首版归成 PROCESS_FAILED{retryable:true}，
    //   于是采集器无限退避重试，blockedReason 永不置位（实测连续 16 次）。
    expect((error as AppError).retryable).toBe(false)
  })

  it("403（stderr）→ PERMISSION_REQUIRED，不是登录过期", async () => {
    const error = await runWithStderr(REAL_ERR_HTTP_403, 4)
    expect((error as AppError).code).toBe("PERMISSION_REQUIRED")
  })

  it("网络类失败仍是可重试的 PROCESS_FAILED（不能误判成终态）", async () => {
    const error = await runWithStderr("dial tcp: i/o timeout", 1)
    expect((error as AppError).code).toBe("PROCESS_FAILED")
    expect((error as AppError).retryable).toBe(true)
  })
})
