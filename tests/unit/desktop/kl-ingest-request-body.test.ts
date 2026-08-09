/**
 * `POST /ingest` 的**请求体形状**。
 *
 * ## 这一组锁的是一个刚发生过的静默失效
 *
 * 上游把请求体换成了（实测 2026-08-09，`kl_server.py`）：
 *
 * ```py
 * class IngestRequest(BaseModel):
 *     model_config = ConfigDict(extra="forbid")   # ← 多一个字段就 422
 *     input_dir: str                              # ← 我们发的是 export_dir
 *     source_id: str = Field(min_length=1)        # ← 新增，必填非空
 * ```
 *
 * 而我们一直发 `{export_dir}`，三条校验一起挂（curl 复现）：
 * `input_dir` missing + `source_id` missing + `export_dir` extra_forbidden → 422。
 *
 * ## ★★ 为什么现有的 kl-server 测试没拦住
 *
 * 那边的 fake 是 `postIngest: async (port, dir) => 200` —— 只看**参数**，
 * 从不构造真实请求体。TS 允许少声明形参，所以字段名换了、少了一个必填项，
 * 类型与测试都一声不响。
 *
 * 表现是 `graph build failed {reason:"建图启动失败：HTTP 422"}` 每轮重复，
 * 而采集/导出/蒸馏全部正常 —— 也就是"只有图谱不长"，而 422 本身
 * 不说是哪个字段。所以这一组直接对着 `defaultPostIngest` 真的发出去的
 * body 断言，而不是对着形参。
 */
import { describe, expect, it } from "vitest"
import { buildIngestRequestBody } from "@main/services/kl-server.service.js"

const EXPORT_DIR = "/tmp/vault-fake/exports/dws"
const SOURCE_ID = "dingtalk"

describe("★★ /ingest 的请求体必须与上游 IngestRequest 对齐", () => {
  /**
   * ★★ 字段名是 `input_dir`，**不是** `export_dir`。
   *
   * 这条就是那个 bug 的直接反面。反证：改回 `export_dir` → 红。
   */
  it("★★ 用 input_dir 而不是 export_dir", () => {
    const body = buildIngestRequestBody(EXPORT_DIR, SOURCE_ID)
    expect(body).toHaveProperty("input_dir", EXPORT_DIR)
    expect(body).not.toHaveProperty("export_dir")
  })

  /**
   * ★★ `source_id` 必填且非空（上游 `Field(min_length=1)`）。
   * 缺了或空串都是 422，而 422 不会告诉用户是哪个字段。
   */
  it("★★ 带上非空的 source_id", () => {
    const body = buildIngestRequestBody(EXPORT_DIR, SOURCE_ID)
    expect(body["source_id"]).toBe(SOURCE_ID)
    expect(String(body["source_id"]).length).toBeGreaterThan(0)
  })

  /**
   * ★★ 上游是 `extra="forbid"` —— **多一个字段就整体 422**。
   *
   * 所以这条锁"只发这两个键"。将来要加参数（比如 concurrency / improve 模式）
   * 必须先确认上游 schema 里有，否则加上去会把**本来能用**的建图打挂。
   */
  it("★★ 不含任何额外字段（上游 extra=forbid）", () => {
    const body = buildIngestRequestBody(EXPORT_DIR, SOURCE_ID)
    expect(Object.keys(body).sort()).toEqual(["input_dir", "source_id"])
  })

  /** 序列化之后仍是那两个键 —— 真正上线的是 JSON，不是对象。 */
  it("JSON 序列化后形状不变", () => {
    const parsed = JSON.parse(
      JSON.stringify(buildIngestRequestBody(EXPORT_DIR, SOURCE_ID)),
    ) as Record<string, unknown>
    expect(parsed).toEqual({ input_dir: EXPORT_DIR, source_id: SOURCE_ID })
  })
})
