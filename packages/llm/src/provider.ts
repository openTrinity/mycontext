/**
 * LLM 客户端的 holder（间接层）。
 *
 * ## 为什么需要它
 *
 * `LlmClient` 的语义是「一个**已配置**的客户端」——`baseUrl===""` 构造即抛
 * （见 client.ts）。而「有没有配网关」这个 null 状态，以前被塞进各服务
 * 持有的 `LlmClient | null` 里，一旦配置在运行期变化（用户在设置里刚填了
 * key），那个 null 就永远是 null——服务是启动时快照的。
 *
 * holder 把 null 状态挪到自己身上：各消费者持有同一个 `LlmProvider`，
 * 每次用时 `get()`。改配置时 holder `reconfigure()` 内部替换 client
 * （null↔已配置都能切），消费者下一次 `get()` 就拿到新值——**不重启即生效**。
 *
 * ## 为什么替换整个实例而不是改字段
 *
 * `LlmClient` 的并发闸与用量累计绑在实例上，且字段是 `private readonly`。
 * 替换整实例语义干净：旧实例上的在途请求在旧闸上跑完（瞬时重叠，可接受），
 * 新请求走新实例。共用一个实例的初衷（并发闸不翻倍）在稳态下仍然成立——
 * holder 任一时刻只持有一个 client。
 */
import { LlmClient, type LlmClientOptions } from "./client.js"
import type { Logger } from "@mycontext/kernel"

/** 消费者只依赖这个接口：要么拿到已配置的 client，要么 null（未配网关）。 */
export interface LlmProvider {
  get(): LlmClient | null
}

/** holder 的重配置入参：baseUrl/apiKey 任一为空即视为「未配置」→ null。 */
export interface LlmProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 网关协议（openai/anthropic）。缺省 openai。 */
  provider?: "openai" | "anthropic"
}

export class LlmHolder implements LlmProvider {
  private client: LlmClient | null = null

  constructor(private readonly logger?: Logger) {}

  get(): LlmClient | null {
    return this.client
  }

  /**
   * 用新配置重建 client（或置 null）。
   *
   * baseUrl/apiKey 任一为空 → null（与旧 startup 里 `llm=null` 的判据一致）：
   * 未配 key 时构造 client 只会在第一次请求失败，而 null 让消费者走
   * 明确的降级分支（数字人出占位草稿、蒸馏跳过抽取型任务）。
   */
  reconfigure(config: LlmProviderConfig | null): void {
    if (config === null || config.baseUrl.trim() === "" || config.apiKey.trim() === "") {
      if (this.client !== null) this.logger?.info("llm holder cleared (gateway unconfigured)", {})
      this.client = null
      return
    }
    const options: LlmClientOptions = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      ...(config.provider === undefined ? {} : { provider: config.provider }),
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    }
    this.client = new LlmClient(options)
    this.logger?.info("llm holder reconfigured", {
      model: config.model,
      provider: config.provider ?? "openai",
    })
  }
}

/** 测试/静态场景用：包一个固定 client（或 null）成 provider。 */
export function staticLlmProvider(client: LlmClient | null): LlmProvider {
  return { get: () => client }
}
