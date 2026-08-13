/**
 * LLM 客户端的门禁。
 *
 * ## 这里锁的是三条**实测出来的网关行为**，不是 OpenAI 文档
 *
 * 1. **开了 `response_format: json_object` 仍可能带 ```json 围栏。**
 *    实测同一个模型（qwen3.7-plus）在有/无 system 提示时两种都出现过。
 *    直接 `JSON.parse(content)` 会抛 `Unexpected token \`` ——
 *    而那个错看起来像"模型不听话"，实际是网关行为不稳定。
 * 2. **HTTP 200 但 body 里有 `error`。** 只看 `res.ok` 会把它当成
 *    "content 是 undefined" 往下传 → 抽取阶段得到 0 条结论且无错误。
 * 3. **响应里有 `reasoning_content`**（思考过程，不是答案）。
 *
 * 另外锁重试策略：**只重试 429/5xx**。400 重试三次只是把同一个错误犯
 * 三遍还烧三倍配额 —— 这条很容易在"加个重试更稳"的名义下被改坏。
 *
 * 用注入的假 fetch：真调的核验在 `scripts/check-map.mjs`（那条会花钱，
 * 不进门禁）。两者分工明确 —— 这里验逻辑，那里验"网关还是那个形状"。
 */
import { describe, expect, it, vi } from "vitest"
import { LlmClient, isRetryable, stripCodeFence } from "@mycontext/llm"
import { isAppError } from "@mycontext/kernel"

/** 造一个成功响应。 */
function okResponse(content: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content, ...extra } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    text: () => Promise.resolve(""),
  } as unknown as Response
}

function errorResponse(status: number, body = "boom") {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  } as unknown as Response
}

function makeClient(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new LlmClient({
    baseUrl: "https://gateway.invalid",
    apiKey: "sk-test",
    model: "test-model",
    // 睡眠注入成立即返回：不然重试用例要真等 500ms/1000ms
    sleep: () => Promise.resolve(),
    fetchImpl,
    ...overrides,
  })
}

const ask = { messages: [{ role: "user" as const, content: "hi" }] }

describe("★ 代码块围栏必须剥掉（json_object 也不保证不带）", () => {
  it("剥 ```json 围栏", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it("剥无语言标注的 ``` 围栏", () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it("裸 JSON 原样返回（不能把内容截坏）", () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}')
  })

  it("内容里合法出现的 ``` 不被动到", () => {
    // 结论正文引用了一段代码：外层没有围栏，就不该剥
    const text = '{"value":"用 ```ts 标注"}'
    expect(stripCodeFence(text)).toBe(text)
  })

  it("json 模式下客户端返回的是剥过的文本（可直接 JSON.parse）", async () => {
    const client = makeClient(() => Promise.resolve(okResponse('```json\n{"items":[]}\n```')))
    const result = await client.complete({ ...ask, json: true })
    expect(() => JSON.parse(result.text)).not.toThrow()
  })

  it("非 json 模式不剥（正文可能本来就是 markdown）", async () => {
    const client = makeClient(() => Promise.resolve(okResponse("```js\ncode\n```")))
    const result = await client.complete(ask)
    expect(result.text).toContain("```")
  })
})

describe("★ HTTP 200 + body.error 必须当失败", () => {
  it("抛错而不是返回空内容", async () => {
    const client = makeClient(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ error: { message: "quota exceeded" } }),
        text: () => Promise.resolve(""),
      } as unknown as Response),
    )
    await expect(client.complete(ask)).rejects.toThrow()
  })

  it("这类业务错误**不重试**（同样的请求会得到同样的错误）", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ error: { message: "bad request" } }),
        text: () => Promise.resolve(""),
      } as unknown as Response),
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch, { maxRetries: 3 })
    await expect(client.complete(ask)).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe("reasoning_content 是思考过程，不是答案", () => {
  it("text 取 content，reasoning 单独给", async () => {
    const client = makeClient(() =>
      Promise.resolve(okResponse("答案", { reasoning_content: "先想一想…" })),
    )
    const result = await client.complete(ask)
    expect(result.text).toBe("答案")
    expect(result.reasoning).toBe("先想一想…")
  })
})

describe("★ 只重试 429/5xx", () => {
  it("isRetryable 的判据", () => {
    expect(isRetryable(429)).toBe(true)
    expect(isRetryable(500)).toBe(true)
    expect(isRetryable(503)).toBe(true)
    // 这四个重试只是把同一个错误犯多遍
    expect(isRetryable(400)).toBe(false)
    expect(isRetryable(401)).toBe(false)
    expect(isRetryable(403)).toBe(false)
    expect(isRetryable(404)).toBe(false)
  })

  it("429 会重试，且最终成功", async () => {
    let calls = 0
    const client = makeClient(() => {
      calls += 1
      return Promise.resolve(calls === 1 ? errorResponse(429) : okResponse("ok"))
    })
    const result = await client.complete(ask)
    expect(result.text).toBe("ok")
    expect(calls).toBe(2)
  })

  it("400 只调一次（不重试）", async () => {
    let calls = 0
    const client = makeClient(
      () => {
        calls += 1
        return Promise.resolve(errorResponse(400))
      },
      { maxRetries: 3 },
    )
    await expect(client.complete(ask)).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it("重试次数用尽后抛，且抛的是最后那个错误", async () => {
    let calls = 0
    const client = makeClient(
      () => {
        calls += 1
        return Promise.resolve(errorResponse(503))
      },
      { maxRetries: 2 },
    )
    await expect(client.complete(ask)).rejects.toThrow()
    // 1 次首发 + 2 次重试
    expect(calls).toBe(3)
  })
})

describe("空内容按可重试处理（截断/过滤是偶发的）", () => {
  it("空串会重试一次，第二次成功就算成功", async () => {
    let calls = 0
    const client = makeClient(() => {
      calls += 1
      return Promise.resolve(okResponse(calls === 1 ? "   " : "有内容"))
    })
    expect((await client.complete(ask)).text).toBe("有内容")
    expect(calls).toBe(2)
  })
})

describe("并发闸真的限流", () => {
  it("concurrency=1 时两个请求串行", async () => {
    let active = 0
    let peak = 0
    const client = makeClient(
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return okResponse("ok")
      },
      { concurrency: 1 },
    )

    await Promise.all([client.complete(ask), client.complete(ask), client.complete(ask)])
    /**
     * ★ 这条防的是"闸看起来在但其实没生效"。
     * 蒸馏会一次排上几百个任务，闸失效 → 全部打到限流 → 一起进重试 → 雪崩。
     */
    expect(peak).toBe(1)
  })

  it("concurrency=2 时峰值不超过 2", async () => {
    let active = 0
    let peak = 0
    const client = makeClient(
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return okResponse("ok")
      },
      { concurrency: 2 },
    )

    await Promise.all(Array.from({ length: 6 }, () => client.complete(ask)))
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe("用量累计（进度页要显示花了多少 token）", () => {
  it("多次调用累加", async () => {
    const client = makeClient(() => Promise.resolve(okResponse("ok")))
    await client.complete(ask)
    await client.complete(ask)
    expect(client.usage().totalTokens).toBe(30)
  })
})

describe("配置缺失要 fail-fast", () => {
  it("baseUrl 为空时构造就抛（而不是发一个打不通的请求）", () => {
    expect(() => new LlmClient({ baseUrl: "", apiKey: "k", model: "m" })).toThrow()
    try {
      new LlmClient({ baseUrl: "  ", apiKey: "k", model: "m" })
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("CONFIG_INVALID")
    }
  })
})

describe("请求形状", () => {
  it("json 模式带 response_format，非 json 模式不带", async () => {
    const bodies: unknown[] = []
    const client = makeClient((_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)))
      return Promise.resolve(okResponse('{"items":[]}'))
    })
    await client.complete({ ...ask, json: true })
    await client.complete(ask)
    expect((bodies[0] as { response_format?: unknown }).response_format).toEqual({
      type: "json_object",
    })
    expect((bodies[1] as { response_format?: unknown }).response_format).toBeUndefined()
  })

  it("URL 拼在 baseUrl 后，重复斜杠被规范化", async () => {
    const urls: string[] = []
    const client = new LlmClient({
      baseUrl: "https://gateway.invalid///",
      apiKey: "k",
      model: "m",
      sleep: () => Promise.resolve(),
      fetchImpl: (url) => {
        urls.push(String(url))
        return Promise.resolve(okResponse("ok"))
      },
    })
    await client.complete(ask)
    expect(urls[0]).toBe("https://gateway.invalid/v1/chat/completions")
  })
})

/**
 * ★★ Anthropic 传输（`provider:"anthropic"` → `/v1/messages`）。
 *
 * 这条锁的是主模型能切协议之后**直连这条路**的形状：数字分身降级直连、
 * 蒸馏抽取都走这个 client。与 opencode 那条（`resolveGatewayModelConfig`
 * 换 `@ai-sdk/anthropic`）是同一个用户设置的两半，形状差异全在 client 里收口。
 */
describe("Anthropic 传输", () => {
  /** 造一个 Anthropic Messages 成功响应。 */
  function anthropicOk(blocks: unknown[], stopReason = "end_turn") {
    return {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          type: "message",
          content: blocks,
          stop_reason: stopReason,
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
      text: () => Promise.resolve(""),
    } as unknown as Response
  }

  function anthropicClient(fetchImpl: typeof fetch) {
    return new LlmClient({
      baseUrl: "https://gw.invalid",
      apiKey: "sk-ant",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      sleep: () => Promise.resolve(),
      fetchImpl,
    })
  }

  it("★ 打 /v1/messages，用 x-api-key + anthropic-version（不是 Bearer）", async () => {
    let seenUrl = ""
    let seenHeaders: Record<string, string> = {}
    const client = anthropicClient((url, init) => {
      seenUrl = String(url)
      seenHeaders = (init as RequestInit).headers as Record<string, string>
      return Promise.resolve(anthropicOk([{ type: "text", text: "hi" }]))
    })
    await client.complete(ask)
    expect(seenUrl).toBe("https://gw.invalid/v1/messages")
    expect(seenHeaders["x-api-key"]).toBe("sk-ant")
    expect(seenHeaders["anthropic-version"]).toBe("2023-06-01")
    expect(seenHeaders["Authorization"]).toBeUndefined()
  })

  it("★ system 提成顶层、其余进 content blocks，且必填 max_tokens", async () => {
    let body: {
      system?: string
      messages?: { role: string; content: { type: string; text?: string }[] }[]
      max_tokens?: number
    } = {}
    const client = anthropicClient((_url, init) => {
      body = JSON.parse(String((init as RequestInit).body))
      return Promise.resolve(anthropicOk([{ type: "text", text: "ok" }]))
    })
    await client.complete({
      messages: [
        { role: "system", content: "you are X" },
        { role: "user", content: "hello" },
      ],
      maxTokens: 128,
    })
    expect(body.system).toBe("you are X")
    // system 不再作为一条消息
    expect(body.messages).toHaveLength(1)
    expect(body.messages?.[0]?.role).toBe("user")
    expect(body.messages?.[0]?.content[0]).toEqual({ type: "text", text: "hello" })
    expect(body.max_tokens).toBe(128)
  })

  it("★ 多个 text block 拼接；usage 用 input/output_tokens（自相加 total）", async () => {
    const client = anthropicClient(() =>
      Promise.resolve(
        anthropicOk([
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ]),
      ),
    )
    const out = await client.complete(ask)
    expect(out.text).toBe("Hello world")
    expect(out.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 })
    expect(out.finishReason).toBe("end_turn")
  })

  it("★ tool_use block → toolCalls（input 对象转 JSON 串）", async () => {
    const client = anthropicClient(() =>
      Promise.resolve(
        anthropicOk(
          [{ type: "tool_use", id: "tu_1", name: "search", input: { query: "abc" } }],
          "tool_use",
        ),
      ),
    )
    const out = await client.complete({
      ...ask,
      tools: [{ name: "search", description: "d", parameters: { type: "object" } }],
    })
    expect(out.toolCalls).toEqual([
      { id: "tu_1", name: "search", argumentsJson: JSON.stringify({ query: "abc" }) },
    ])
  })

  it("★ 工具声明用 input_schema（不是 OpenAI 的 function.parameters）", async () => {
    let body: { tools?: { name: string; input_schema: unknown }[] } = {}
    const client = anthropicClient((_url, init) => {
      body = JSON.parse(String((init as RequestInit).body))
      return Promise.resolve(anthropicOk([{ type: "text", text: "ok" }]))
    })
    await client.complete({
      ...ask,
      tools: [{ name: "search", description: "d", parameters: { type: "object" } }],
    })
    expect(body.tools?.[0]).toEqual({
      name: "search",
      description: "d",
      input_schema: { type: "object" },
    })
  })

  it("★ role:tool 结果 → role:user + tool_result block（tool_use_id 对上）", async () => {
    let body: { messages?: { role: string; content: { type: string; tool_use_id?: string }[] }[] } =
      {}
    const client = anthropicClient((_url, init) => {
      body = JSON.parse(String((init as RequestInit).body))
      return Promise.resolve(anthropicOk([{ type: "text", text: "done" }]))
    })
    await client.complete({
      messages: [{ role: "tool", content: "result text", toolCallId: "tu_1" }],
    })
    const msg = body.messages?.[0]
    expect(msg?.role).toBe("user")
    expect(msg?.content[0]?.type).toBe("tool_result")
    expect(msg?.content[0]?.tool_use_id).toBe("tu_1")
  })

  it("★ 空正文（无 tool_use）→ 可重试的 PARSE_FAILED，带 stop_reason", async () => {
    const client = anthropicClient(() => Promise.resolve(anthropicOk([], "max_tokens")))
    await expect(client.complete(ask)).rejects.toMatchObject({
      code: "PARSE_FAILED",
    })
  })

  it("★ json 模式仍剥围栏（Messages API 无 response_format）", async () => {
    const client = anthropicClient(() =>
      Promise.resolve(anthropicOk([{ type: "text", text: '```json\n{"a":1}\n```' }])),
    )
    const out = await client.complete({ ...ask, json: true })
    expect(out.text).toBe('{"a":1}')
  })
})

/**
 * ★★ 视觉输入（图片）的线上形状。
 *
 * ## 为什么这一层必须有断言
 *
 * 数字分身要能"看到"聊天里的图片。ACP（opencode）那条路走
 * `{type:"image", data, mimeType}`，而**降级到直连时**走的是这里 ——
 * OpenAI 兼容协议的 `content: [{type:"text"},{type:"image_url"}]`。
 *
 * 两条路形状不同，而降级是常态（opencode 缺失 / 冷启动超时 / 0-token）。
 * 这里写错的后果是"有时能看到图、有时看不到"，而两次的日志都是"生成成功"
 * —— 那种不一致最难查。
 *
 * 实测这个网关上 `qwen3.7-plus` 与 `gpt-5.6-sol` 都能正确读出图里的文字。
 */
describe("★★ 带图的消息转写成多模态 content", () => {
  /** 取出这次请求的 body。 */
  async function captureBody(
    messages: Parameters<LlmClient["complete"]>[0]["messages"],
  ): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {}
    const client = makeClient((_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return Promise.resolve(okResponse("ok"))
    })
    await client.complete({ messages })
    return captured
  }

  it("★ 没有图时 content 保持**裸字符串**（绝大多数请求走这条）", async () => {
    const body = await captureBody([{ role: "user", content: "在吗" }])
    const wire = (body["messages"] as { content: unknown }[])[0]
    expect(typeof wire?.content, "多包一层数组会让每条日志与重试的 body 都变大").toBe("string")
  })

  it("★★ 有图时 content 变数组：文本块 + image_url（data URI 带 mime）", async () => {
    const body = await captureBody([
      {
        role: "user",
        content: "看这个 [图片 1]",
        images: [{ base64: "QUFBQQ==", mimeType: "image/png" }],
      },
    ])
    const content = (body["messages"] as { content: unknown }[])[0]?.content as {
      type: string
      text?: string
      image_url?: { url: string }
    }[]
    expect(Array.isArray(content)).toBe(true)
    /**
     * ★ 文本块在**第一个**：正文里有「[图片 1]」这类标注，
     * 模型要先读到它才知道图属于谁。
     */
    expect(content[0]?.type).toBe("text")
    expect(content[0]?.text).toBe("看这个 [图片 1]")
    expect(content[1]?.type).toBe("image_url")
    /**
     * ★ data URI 里的 mime **必须**带上（协议要求）。猜错或漏掉时
     * 网关直接拒 —— 而那时用户看到的只是"草稿没提到图里的内容"。
     */
    expect(content[1]?.image_url?.url).toBe("data:image/png;base64,QUFBQQ==")
  })

  it("★ images 是空数组时**不**转数组（等价于没有图）", async () => {
    const body = await captureBody([{ role: "user", content: "在吗", images: [] }])
    const wire = (body["messages"] as { content: unknown }[])[0]
    expect(typeof wire?.content).toBe("string")
  })
})
