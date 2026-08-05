/**
 * LlmHolder —— 把「有没有配网关」的 null 状态从 LlmClient 挪到 holder 上。
 *
 * 锁住：null↔已配置能来回切（这正是「运行期改配置生效」的地基），
 * 且 reconfigure 后 get() 返回的是**新**实例（旧实例被替换，不是原地改字段）。
 */
import { describe, expect, it } from "vitest"
import { LlmClient, LlmHolder, staticLlmProvider } from "@mycontext/llm"

describe("LlmHolder", () => {
  it("初始为 null（未配网关）", () => {
    const holder = new LlmHolder()
    expect(holder.get()).toBeNull()
  })

  it("配齐 base+key → get() 给出 LlmClient", () => {
    const holder = new LlmHolder()
    holder.reconfigure({ baseUrl: "https://gw", apiKey: "sk-1", model: "glm-5.2" })
    expect(holder.get()).toBeInstanceOf(LlmClient)
  })

  it("base 或 key 为空 → 回到 null（不构造会抛的 client）", () => {
    const holder = new LlmHolder()
    holder.reconfigure({ baseUrl: "https://gw", apiKey: "sk-1", model: "m" })
    expect(holder.get()).not.toBeNull()
    // 清空 key → null
    holder.reconfigure({ baseUrl: "https://gw", apiKey: "", model: "m" })
    expect(holder.get()).toBeNull()
    // 传 null 同样 → null
    holder.reconfigure({ baseUrl: "https://gw", apiKey: "sk-1", model: "m" })
    holder.reconfigure(null)
    expect(holder.get()).toBeNull()
  })

  it("reconfigure 替换整个实例（不是原地改字段）", () => {
    const holder = new LlmHolder()
    holder.reconfigure({ baseUrl: "https://gw", apiKey: "sk-1", model: "a" })
    const first = holder.get()
    holder.reconfigure({ baseUrl: "https://gw", apiKey: "sk-1", model: "b" })
    const second = holder.get()
    expect(first).not.toBe(second)
  })

  it("staticLlmProvider 固定返回同一个（含 null）", () => {
    expect(staticLlmProvider(null).get()).toBeNull()
    const client = new LlmClient({ baseUrl: "https://gw", apiKey: "k", model: "m" })
    expect(staticLlmProvider(client).get()).toBe(client)
  })
})
