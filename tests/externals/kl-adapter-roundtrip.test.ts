/**
 * 我们的导出 → 他们的**加载器**：端到端往返。
 *
 * 这条测试的价值在于它跨越了**语言边界**：TS 侧导出、Python 侧读入。
 * 各自单测都过而拼起来不对是完全可能的（字段名拼错、时间单位不一致），
 * 而那种错在联调现场才发现的成本高得多。
 *
 * ## ★ 曾经整组静默跳过（比红更糟）
 *
 * 首版的门槛是 `existsSync(".../kl_graph/adapters/dws_message_adapter.py")`。
 * 上游把那个文件**删了**（能力并入 `ingest/loaders/`），于是 `hasKl` 恒假 ——
 * 整组 5 条**静默跳过**，`pnpm test:externals` 报的是"跳过"而不是"坏了"。
 * 而"跳过"看起来像是环境没装 python，没人会去查。
 *
 * 两处都改了：门槛改成判**加载器**是否存在（那是生产链路真正在用的模块），
 * 脚本也改成调 `message_loader.load_all_messages` —— 测同一段代码，
 * 而不是一个平行的转换实现。
 *
 * 放在 `tests/externals/`：它需要 `kl-graph` 与一个可用的 python3。
 * 不进门禁（`pnpm test` 用 `--exclude tests/externals/**`）——
 * 所以**每次同步上游代码后必须显式跑一次 `pnpm test:externals`**。
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { formatDwsIsoTime, parseDwsLocalTime } from "@mycontext/channels"
import { ConversationRepository, MessageRepository } from "@mycontext/store"
import { ExportMaterializer } from "@mycontext/knowledge-feed"
import { openTestVault } from "../helpers/vault.js"

const root = resolve(import.meta.dirname, "../..")
const klRoot = join(root, "kl-graph")
/**
 * 门槛判**加载器**而不是已被删掉的 adapter。
 *
 * 判一个"上游随时可能删掉的文件"会让整组测试在上游重构后静默跳过 ——
 * 而这个 loader 是他们 `scripts/ingest.py` 的必经之路：它要是没了，
 * 说明 kl-graph 变了个大样，那时候确实该整组跳过并让人来看。
 */
const hasKl = existsSync(join(klRoot, "kl_graph/ingest/loaders/message_loader.py"))

const START = 1_785_000_000_000
const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 用他们**生产链路里的**加载器读我们导出的四件套，返回解析结果。 */
function adaptWithPython(exportDir: string): { id: string; timestamp: number; senderId: string }[] {
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from pathlib import Path",
    "from kl_graph.ingest.loaders.message_loader import load_all_messages",
    "messages = load_all_messages(Path(sys.argv[2]) / 'chat')",
    "messages.sort(key=lambda m: m.timestamp)",
    "print(json.dumps([",
    "  {'id': m.id, 'timestamp': m.timestamp, 'senderId': m.sender_id} for m in messages",
    "]))",
  ].join("\n")

  const out = execFileSync("python3", ["-c", script, klRoot, exportDir], { encoding: "utf8" })
  return JSON.parse(out) as { id: string; timestamp: number; senderId: string }[]
}

describe.skipIf(!hasKl)("★ 导出 → 加载器往返", () => {
  function seedAndExport() {
    const vault = openTestVault()
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-"))
    dirs.push(dir)

    new ConversationRepository(vault.db).upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-group",
      type: "group",
      title: "沙箱项目群",
      memberCount: 12,
      createdAt: START,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "m-1",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "msg-1",
        senderExternalId: "DeMINE",
        senderDisplayName: "小周",
        contentText: "沙箱环境部署完成了",
        sentAt: parseDwsLocalTime("2026-07-28 10:53:49"),
        direction: "outbound",
        isSelf: true,
        createdAt: START,
      },
      {
        id: "m-2",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "msg-2",
        senderExternalId: "DeLI",
        senderDisplayName: "小李",
        contentText: "收到",
        sentAt: parseDwsLocalTime("2026-07-28 10:55:02"),
        direction: "inbound",
        isSelf: false,
        createdAt: START,
      },
    ])

    new ExportMaterializer({
      db: vault.db,
      clock: new ManualClock(START),
      exportDir: dir,
      formatTime: formatDwsIsoTime,
    }).run()

    return { vault, dir }
  }

  it("他们的加载器能读出我们导出的全部消息", () => {
    const { vault, dir } = seedAndExport()
    const adapted = adaptWithPython(dir)
    expect(adapted.map((item) => item.id)).toEqual(["msg-1", "msg-2"])
    vault.close()
  })

  /**
   * ★ 这是整条链路上最容易错的一环：TS 侧的 unix ms 与
   * Python 侧解析出来的必须是**同一个瞬间**。
   */
  it("时间戳跨语言完全一致（不是差 8 小时）", () => {
    const { vault, dir } = seedAndExport()
    const adapted = adaptWithPython(dir)
    const stored = new MessageRepository(vault.db).findByExternalId("dingtalk", "msg-1")
    expect(adapted[0]?.timestamp).toBe(stored?.sentAt)
    vault.close()
  })

  it("发送者用的是稳定 ID（不是显示名）", () => {
    const { vault, dir } = seedAndExport()
    expect(adaptWithPython(dir)[0]?.senderId).toBe("DeMINE")
    vault.close()
  })

  it.each(["UTC", "Asia/Shanghai"])("TZ=%s 下加载结果不变", (tz) => {
    const original = process.env["TZ"]
    try {
      process.env["TZ"] = tz
      const { vault, dir } = seedAndExport()
      const adapted = adaptWithPython(dir)
      // createTime 带 +08:00 偏移，他们的 fromisoformat 分支与运行环境无关
      expect(adapted[0]?.timestamp).toBe(parseDwsLocalTime("2026-07-28 10:53:49"))
      vault.close()
    } finally {
      if (original === undefined) delete process.env["TZ"]
      else process.env["TZ"] = original
    }
  })
})
