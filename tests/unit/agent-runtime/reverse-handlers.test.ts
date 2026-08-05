/**
 * ACP 反向调用 handler。
 *
 * ★ 不实现 `requestPermission` 的后果：实测 `acp/permission.ts:55-58`
 * 在 client 未实现时**直接 reply(reject)**（catch 分支同样 reject）——
 * 所有需要授权的工具调用被静默拒绝，表现为「agent 什么都不做」，
 * 而日志里什么都没有。这是最难归因的一类失效。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createReverseHandlers,
  HOST_TOOLS,
  isAllowlistedTool,
  isInsideWorkspace,
} from "@mycontext/agent-runtime"
import { isAppError } from "@mycontext/kernel"

describe("工具授权", () => {
  it("白名单内的只读工具直接放行（每次问用户是纯骚扰）", () => {
    const handlers = createReverseHandlers({ kind: "search" })
    expect(handlers.requestPermission({ toolName: HOST_TOOLS.localRecall })).toEqual({
      outcome: "selected",
      optionId: "always",
    })
  })

  /**
   * 白名单外**拒绝**而不是询问用户：
   * 让用户面对一个他无法判断的技术问题，只会训练他一路点"允许"。
   */
  it("白名单外一律拒绝，不询问用户", () => {
    const handlers = createReverseHandlers({ kind: "search" })
    for (const toolName of ["bash", "edit", "write", "webfetch", "unknown_tool"]) {
      expect(handlers.requestPermission({ toolName })).toEqual({ outcome: "cancelled" })
    }
  })

  /**
   * ★ 实测 ACP 传的 toolName 是 permission key，与内建 read/edit/bash
   * **同命名空间** —— 不加 `mycontext_` 前缀的话，「放行 read」
   * = 放行 opencode 的文件读工具。
   */
  it("所有宿主工具名都带 mycontext_ 前缀（避免与内建工具碰撞）", () => {
    for (const toolName of Object.values(HOST_TOOLS)) {
      expect(toolName.startsWith("mycontext_"), toolName).toBe(true)
    }
  })

  it("不带前缀的同名工具不被放行", () => {
    const handlers = createReverseHandlers({ kind: "search" })
    // `local_recall`（无前缀）不在白名单里
    expect(handlers.requestPermission({ toolName: "local_recall" })).toEqual({
      outcome: "cancelled",
    })
  })

  it("每次调用都记审计（没有它「agent 查了什么」事后无法回答）", () => {
    const audit: { toolName: string; allowed: boolean }[] = []
    const handlers = createReverseHandlers({
      kind: "search",
      onToolAudit: (entry) => audit.push(entry),
    })
    handlers.requestPermission({ toolName: HOST_TOOLS.localRecall })
    handlers.requestPermission({ toolName: "bash" })
    expect(audit).toEqual([
      { toolName: HOST_TOOLS.localRecall, allowed: true },
      { toolName: "bash", allowed: false },
    ])
  })
})

describe("两个 Agent 系统的白名单差异是刻意的", () => {
  it("persona 有 profile_read，search 没有", () => {
    expect(isAllowlistedTool("persona", HOST_TOOLS.profileRead)).toBe(true)
    // 搜索不该能读本人画像 —— 那是数字人的数据
    expect(isAllowlistedTool("search", HOST_TOOLS.profileRead)).toBe(false)
  })

  it("search 有 dws_query（实时查渠道），persona 没有", () => {
    expect(isAllowlistedTool("search", HOST_TOOLS.dwsQuery)).toBe(true)
    expect(isAllowlistedTool("persona", HOST_TOOLS.dwsQuery)).toBe(false)
  })

  it("两边都没有任何写操作工具", () => {
    for (const kind of ["search", "persona"] as const) {
      for (const forbidden of ["send", "chat_send", "write", "edit", "bash"]) {
        expect(isAllowlistedTool(kind, forbidden), `${kind}/${forbidden}`).toBe(false)
        expect(isAllowlistedTool(kind, `mycontext_${forbidden}`)).toBe(false)
      }
    }
  })
})

describe("文件读写", () => {
  /**
   * agent 的 workspace 里只有 materialize 出的 md（本来就是给它看的），
   * 它没有任何需要写文件的正当理由。而「能写文件」意味着它能改自己的
   * 系统提示 —— 那是 prompt injection 最想要的能力。
   */
  it("写文件一律拒绝（抛 FORBIDDEN）", () => {
    const handlers = createReverseHandlers({ kind: "persona" })
    try {
      handlers.writeTextFile()
      expect.unreachable("应当抛错")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) expect(error.code).toBe("FORBIDDEN")
    }
  })

  it("读 workspace 内的相对路径允许", () => {
    const handlers = createReverseHandlers({ kind: "persona" })
    expect(handlers.readTextFile({ path: "knowledge/profile.md", workspaceRoot: "/ws" })).toEqual({
      allowed: true,
    })
  })

  /**
   * 路径逃逸会让它读到别的会话的画像目录 —— 那是单聊隐私边界的一部分。
   */
  it.each(["../other/profile.md", "../../etc/passwd", "/etc/passwd", "a/../../b", ""])(
    "拒绝逃逸路径 %j",
    (path) => {
      const handlers = createReverseHandlers({ kind: "persona" })
      expect(handlers.readTextFile({ path, workspaceRoot: "/ws" })).toEqual({ allowed: false })
    },
  )

  it("Windows 风格的反斜杠逃逸也被拦住", () => {
    const handlers = createReverseHandlers({ kind: "persona" })
    expect(handlers.readTextFile({ path: "..\\other\\x.md", workspaceRoot: "C:\\ws" })).toEqual({
      allowed: false,
    })
  })
})

/**
 * ★★ 路径包含判定 —— 单聊隐私边界（R5）的防线。
 *
 * 首版用字符串判断 `includes("../") || startsWith("/")`，实测漏两类：
 * · 裸 `".."`：不含 `"../"` 子串，但 `resolve("/ws/search/s1","..")` = `/ws/search`
 *   —— **逃出 workspace**，而会话目录同级就是别的会话的画像；
 * · `"./.."`：同理。
 * 且首版收下 `workspaceRoot` 参数却**从未使用**。
 */
describe("★ readTextFile 路径包含判定", () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeWorkspace() {
    const base = mkdtempSync(join(tmpdir(), "mycontext-ws-"))
    dirs.push(base)
    // 结构：<base>/s1（本会话 workspace）与 <base>/s2（别的会话画像）
    const s1 = join(base, "s1")
    const s2 = join(base, "s2")
    mkdirSync(join(s1, "knowledge"), { recursive: true })
    mkdirSync(s2, { recursive: true })
    writeFileSync(join(s1, "knowledge", "profile.md"), "mine")
    writeFileSync(join(s2, "profile.md"), "SECRET-别的会话")
    return { base, s1, s2 }
  }

  it("workspace 内的相对路径放行", () => {
    const { s1 } = makeWorkspace()
    expect(isInsideWorkspace(s1, "knowledge/profile.md")).toBe(true)
  })

  /** ★ 修复前这两个都被放行。 */
  it.each(["..", "./..", "sub/../..", "../s2/profile.md", "knowledge/../../s2/profile.md"])(
    "拒绝逃逸路径 %j",
    (path) => {
      const { s1 } = makeWorkspace()
      expect(isInsideWorkspace(s1, path)).toBe(false)
    },
  )

  /**
   * ★ 绝对路径按**是否落在 workspace 内**判，不是一律拒绝。
   *
   * 首版一律拒绝。但 ACP 的 `fs/read_text_file` 传的就是绝对路径
   * （对照 opencode 的 `acp/tool.ts:286`：绝对路径原样透传），
   * 一律拒的表现会是「agent 读不到自己 workspace 里的画像」**且不报错**。
   *
   * 安全属性不变：判据始终是 realpath 后的前缀包含。
   */
  it("★ 指向 workspace 内的绝对路径放行（ACP 传的就是绝对路径）", () => {
    const { s1 } = makeWorkspace()
    expect(isInsideWorkspace(s1, join(s1, "knowledge", "profile.md"))).toBe(true)
    // workspace 根自身也算"在内"
    expect(isInsideWorkspace(s1, s1)).toBe(true)
    // 尚不存在的文件同样放行（读不到是另一回事）
    expect(isInsideWorkspace(s1, join(s1, "knowledge", "not-yet.md"))).toBe(true)
  })

  it("拒绝指向 workspace 外的绝对路径", () => {
    const { s1, s2 } = makeWorkspace()
    // 隔壁会话的画像 —— R5 单聊隐私边界
    expect(isInsideWorkspace(s1, join(s2, "profile.md"))).toBe(false)
    expect(isInsideWorkspace(s1, "/etc/passwd")).toBe(false)
    expect(isInsideWorkspace(s1, "/")).toBe(false)
  })

  /**
   * 前缀相邻的兄弟目录不能被"字符串前缀"误判为在内：
   * `<base>/s1-evil` 以 `<base>/s1` 为字符串前缀，但它在 workspace 外。
   * 判定用的是 `root + sep` 而不是裸 `root`，正是为了挡这个。
   */
  it("拒绝名字以 workspace 为前缀的兄弟目录（s1-evil vs s1）", () => {
    const { base, s1 } = makeWorkspace()
    const sibling = join(base, "s1-evil")
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, "profile.md"), "SECRET")
    expect(isInsideWorkspace(s1, join(sibling, "profile.md"))).toBe(false)
  })

  it("拒绝 Windows 盘符与反斜杠形式（判定必须与平台无关）", () => {
    const { s1 } = makeWorkspace()
    expect(isInsideWorkspace(s1, "C:/Windows/x")).toBe(false)
    expect(isInsideWorkspace(s1, "..\\s2\\profile.md")).toBe(false)
  })

  /**
   * ★ symlink：纯路径判定完全看不出来。
   * agent workspace 里的 md 是我们生成的，但**同级就是别的会话的画像**。
   */
  it("拒绝指向 workspace 外的 symlink（文件）", () => {
    const { s1, s2 } = makeWorkspace()
    symlinkSync(join(s2, "profile.md"), join(s1, "leak.md"))
    expect(isInsideWorkspace(s1, "leak.md")).toBe(false)
  })

  it("拒绝穿过指向外部的 symlink 目录（祖先上的 symlink）", () => {
    const { s1, s2 } = makeWorkspace()
    symlinkSync(s2, join(s1, "other"))
    // 目标文件存在
    expect(isInsideWorkspace(s1, "other/profile.md")).toBe(false)
    // 目标文件还不存在时也要挡住（不能因为整条路径不存在就跳过 realpath）
    expect(isInsideWorkspace(s1, "other/not-yet.md")).toBe(false)
  })

  it("workspace 内尚不存在的文件仍然放行（读不到是另一回事）", () => {
    const { s1 } = makeWorkspace()
    expect(isInsideWorkspace(s1, "knowledge/not-yet.md")).toBe(true)
    expect(isInsideWorkspace(s1, "deep/nested/new.md")).toBe(true)
  })

  /**
   * ★ 逃逸形状清单 —— 这次修复的核心价值就在这份清单上。
   *
   * 首版是 `normalized.includes("../") || normalized.startsWith("/")`，
   * 而下面这些**都不含 `"../"` 子串**或以别的方式绕开字符串规则。
   * 把它们逐条钉住，比只写"改成了 resolve + 前缀判定"有用得多：
   * 将来有人为了性能把 realpath 去掉时，是这份清单会红。
   */
  it.each([
    // 裸 `..` —— 不含 "../"，但 resolve 后逃出了 workspace
    "..",
    "./..",
    "../",
    "sub/../..",
    "../s2/profile.md",
    "knowledge/../../s2/profile.md",
    // 多层
    "../../",
    "a/b/c/../../../..",
    // Windows 分隔符（POSIX 的 path 把 `\` 当普通字符）
    "..\\s2\\profile.md",
    "..\\",
    // 盘符
    "C:/Windows/x",
    "c:\\windows\\x",
    // 点号变体
    ".",
    "./",
  ])("拒绝逃逸/非法形状 %j", (path) => {
    const { s1 } = makeWorkspace()
    // "." 与 "./" 解析到 workspace 根自身 —— 那是目录不是文件，
    // 但它确实"在内"，所以这两条的期望值单独判。
    const resolvesToRoot = path === "." || path === "./"
    expect(isInsideWorkspace(s1, path)).toBe(resolvesToRoot)
  })

  it("空路径与空 root 都拒绝", () => {
    const { s1 } = makeWorkspace()
    expect(isInsideWorkspace(s1, "")).toBe(false)
    expect(isInsideWorkspace("", "a.md")).toBe(false)
  })

  it("handler 实际使用 workspaceRoot（首版收下却忽略了它）", () => {
    const { s1, s2 } = makeWorkspace()
    const handlers = createReverseHandlers({ kind: "persona" })
    symlinkSync(join(s2, "profile.md"), join(s1, "leak.md"))
    expect(handlers.readTextFile({ path: "leak.md", workspaceRoot: s1 })).toEqual({
      allowed: false,
    })
    expect(handlers.readTextFile({ path: "..", workspaceRoot: s1 })).toEqual({ allowed: false })
  })
})
