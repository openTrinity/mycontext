/**
 * `POST /ingest` 的请求体必须**与上游 kl 的 `IngestRequest` 完全对齐**。
 *
 * ## 实测的坏形态（本机 2026-08-09 15:08）
 *
 * ```
 * [Main:KlServer] graph build started {"fresh":false,…}
 * [Main:KlServer] kl-server  INFO: 127.0.0.1 - "POST /ingest HTTP/1.1" 422 Unprocessable Entity
 * [Main:KlServer] graph build failed {"reason":"建图启动失败：HTTP 422"}
 * ```
 *
 * 也就是**每次建图都立刻失败**。成因是我们发 `{ export_dir }`，而
 * `IngestRequest`（`kl-graph/kl_server.py`）要的是：
 *
 * ```py
 * class IngestRequest(BaseModel):
 *     model_config = ConfigDict(extra="forbid")   # ← 多一个键就 422
 *     input_dir: str
 *     source_id: str = Field(min_length=1)
 * ```
 *
 * 三重不匹配：字段名错（`export_dir` vs `input_dir`）、必填的 `source_id` 缺、
 * 且那个多出来的键本身会被 `extra="forbid"` 拒掉。
 *
 * ## 为什么这一组盯的是「键集恰好相等」而不只是「有这两个键」
 *
 * `extra="forbid"` 让**多发**与**少发**同样致命。只断言"包含 input_dir"
 * 挡不住"顺手带上一个 export_dir 兼容旧版"这种改法 —— 而那个改法会让
 * 建图 100% 失败，且失败信息（`HTTP 422`）完全指不到是哪个字段。
 *
 * ## `source_id` 为什么必须是 channelId
 *
 * 它不是标签：kl 用它算断点续传的 checkpoint 路径
 * （`checkpoint_path(source_id)`，见 `kl_graph/ingest/runner.py`）。
 * 两个渠道共用一个值 → 互相覆盖对方的续传进度，表现是"增量建图每次都从头扫"
 * 或"某渠道的新导出被当成已处理过"——都是静默的。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger, systemClock } from "@mycontext/kernel"
import type { ProcessRunner } from "@mycontext/runtime-env"
import { KlServerService } from "@main/services/kl-server.service"

const logger = createLogger("test-ingest-body", { level: "error" })

/** kl 的 `IngestRequest` 认的键 —— 与那个 pydantic 模型逐字对应。 */
const REQUIRED_KEYS = ["input_dir", "source_id"]
/** 有服务端默认值、我们**刻意不发**的（forbid 下能不发就不发）。 */
const OPTIONAL_KEYS = ["concurrency", "improve_mode"]

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 拿到 `defaultPostIngest` 真正发出的请求体。
 *
 * ★ 走 `KlServerService` 而不是直接调那个函数：它没导出，而且这样才能
 * 一并验"channelId 有没有被透传进去"（那正是漏过的那一环）。
 */
async function captureBody(channelId: string): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null
  vi.stubGlobal("fetch", (url: string, init: { body: string }) => {
    expect(url).toContain("/ingest")
    captured = JSON.parse(init.body) as Record<string, unknown>
    return Promise.resolve({ status: 200 } as Response)
  })

  const service = new KlServerService({
    clock: systemClock,
    logger,
    processes: {} as unknown as ProcessRunner,
    channelId,
    klRoot: "/tmp/kl-root-not-used",
    dataDir: "/tmp/kl-data",
    exportDir: "/tmp/exports/whatever",
    port: 8299,
    getWindow: () => null,
  })

  // postIngest 是 private —— 这一条门禁的判据就在它身上，所以显式取用
  await (service as unknown as { postIngest(dir: string): Promise<string | null> }).postIngest(
    "/tmp/exports/whatever",
  )

  expect(captured, "fetch 没被调用 —— postIngest 的实现变了？").not.toBeNull()
  return captured as unknown as Record<string, unknown>
}

describe("POST /ingest 的请求体对齐 kl 的 IngestRequest", () => {
  it("★★ 键集恰好是 input_dir + source_id（extra=forbid：多一个也 422）", async () => {
    const body = await captureBody("dingtalk")
    expect(Object.keys(body).sort()).toEqual([...REQUIRED_KEYS].sort())
    // ★ 反证那个造成 422 的旧键没回来
    expect(body).not.toHaveProperty("export_dir")
    for (const key of OPTIONAL_KEYS) {
      expect(body, `${key} 有服务端默认值，不该发`).not.toHaveProperty(key)
    }
  })

  it("★★ source_id 是 channelId（checkpoint 按渠道分，共用会互相覆盖）", async () => {
    expect((await captureBody("dingtalk"))["source_id"]).toBe("dingtalk")
    expect((await captureBody("feishu"))["source_id"]).toBe("feishu")
  })

  it("★ input_dir 是导出目录（不是 dataDir —— 那是 kl 自己的运行目录）", async () => {
    expect((await captureBody("dingtalk"))["input_dir"]).toBe("/tmp/exports/whatever")
  })

  /**
   * ★★ 上游那个 pydantic 模型仍然是这个形状吗。
   *
   * 上面三条锁的是"我们发什么"，锁不住"kl 要什么"—— 而这次的 bug 正是
   * **上游改了而我们没跟**（rebase 带进来的契约变更）。所以这一条直接读
   * `kl_server.py`：它下次再改字段名时这里会红，而不是等到真机 422。
   */
  it("★★ kl_server.py 里的 IngestRequest 仍是 input_dir + source_id + forbid", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const source = readFileSync(join(process.cwd(), "kl-graph/kl_server.py"), "utf8")
    const start = source.indexOf("class IngestRequest(BaseModel):")
    expect(start, "kl_server.py 里找不到 IngestRequest").toBeGreaterThan(-1)
    const model = source.slice(start, start + 600)
    expect(model).toContain('extra="forbid"')
    for (const key of REQUIRED_KEYS) {
      expect(model, `IngestRequest 少了 ${key} —— 上游契约变了，请求体要跟着改`).toContain(key)
    }
  })
})
