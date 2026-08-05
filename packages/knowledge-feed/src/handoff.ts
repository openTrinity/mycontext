/**
 * 对接清单（handoff.json）。
 *
 * 一个文件把「算法团队需要知道的全部运行时事实」写清：端口、token、
 * 共享目录、embedding 网关。他们零猜测就能接上。
 *
 * ★ 为什么把 embedding 的 baseURL/模型/维度也写进来（而不是把我们的向量给他们）：
 * 需求里 embedding 列在"要给算法团队的"里，而向量的**生产方是他们**
 * （他们的维度写死 2048，我们本地用 1024）。所以我们该给的是
 * 「能让他们自己算」的东西 + 模型接入方式，不是我们算好的向量 ——
 * 给了也用不了，反而会制造"这份能不能复用"的反复讨论。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface HandoffManifest {
  /** 我们的 Feed 接口 */
  feed: {
    baseUrl: string
    token: string
    endpoints: { head: string; changes: string; ack: string; snapshot: string }
  }
  /** 共享目录：文件物化的落点 */
  shared: {
    root: string
    dwsExportDir: string
    klDataDir: string
  }
  /**
   * embedding 网关。
   *
   * 维度写的是**他们那边**的值（2048），不是我们本地的 1024 ——
   * 这个字段的用途是"让他们零配置调通同一个网关"，
   * 而他们的向量库维度是写死的外部约束。两套维度的原因见对接文档。
   */
  embedding: {
    baseUrl: string
    model: string
    dim: number
    /** 环境变量名，方便他们直接 export */
    envNames: { baseUrl: string; apiKey: string; model: string }
  }
  /** 我们本地索引用的 embedding（仅告知，不共享向量） */
  localEmbedding: {
    model: string
    dim: number
    note: string
  }
  /**
   * LLM 网关（他们的抽取阶段要用）。
   *
   * ★ `modelNote` 是实测踩出来的一条，值得占一个字段：
   * 他们的 `llm_extractor.py:200` 自己拼 `f"anthropic/{model}"`，
   * 所以 `KL_LLM_MODEL` 必须传**裸模型名**。传全名会二次拼接成
   * `anthropic/anthropic/xxx` → `model_not_found`，
   * 而那个错**被 `extract_one` 吞掉并写进缓存**：
   * 命令退出码 0、看起来跑完了、只是什么都没抽出来，
   * 且下次重跑会命中空缓存所以"再试一次"也不会恢复。
   *
   * 把这句话放进 manifest 而不是只放在文档里：文档会没人读，
   * 而 `kl:env --json` 是他们一定会看的东西。
   */
  llm: {
    baseUrl: string
    model: string
    envNames: { baseUrl: string; model: string; apiKey: string }
    modelNote: string
  }
  generatedAt: number
}

export interface BuildHandoffInput {
  sharedRoot: string
  feedPort: number
  feedToken: string
  embeddingBaseUrl: string
  embeddingModel: string
  /** 算法侧写死的维度 */
  embeddingDim: number
  localEmbeddingModel: string
  localEmbeddingDim: number
  /** LLM 网关（他们抽取阶段用的，与我们自己推理用的是同一个） */
  llmBaseUrl: string
  llmModel: string
  nowMs: number
}

export function buildHandoffManifest(input: BuildHandoffInput): HandoffManifest {
  const baseUrl = `http://127.0.0.1:${input.feedPort}/v1`
  return {
    feed: {
      baseUrl,
      token: input.feedToken,
      endpoints: {
        head: `${baseUrl}/head`,
        changes: `${baseUrl}/changes?since=<seq>&limit=500`,
        ack: `${baseUrl}/ack`,
        snapshot: `${baseUrl}/snapshot`,
      },
    },
    shared: {
      root: input.sharedRoot,
      dwsExportDir: join(input.sharedRoot, "exports", "dws"),
      klDataDir: join(input.sharedRoot, "kl"),
    },
    embedding: {
      baseUrl: input.embeddingBaseUrl,
      model: input.embeddingModel,
      dim: input.embeddingDim,
      envNames: {
        baseUrl: "KL_EMBED_BASE_URL",
        apiKey: "KL_EMBED_API_KEY",
        model: "KL_EMBED_MODEL",
      },
    },
    localEmbedding: {
      model: input.localEmbeddingModel,
      dim: input.localEmbeddingDim,
      note:
        "本地索引自用，维度与图谱侧不同，**不作为共享产物**；" +
        "二期若统一维度可直接复用（见对接文档的 embedding 边界一节）",
    },
    llm: {
      baseUrl: input.llmBaseUrl,
      model: input.llmModel,
      envNames: {
        baseUrl: "KL_LLM_BASE_URL",
        model: "KL_LLM_MODEL",
        apiKey: "ANTHROPIC_AUTH_TOKEN",
      },
      modelNote:
        "KL_LLM_MODEL 传裸模型名，**不要带 anthropic/ 前缀** —— " +
        "llm_extractor.py:200 会自己拼。传全名 → anthropic/anthropic/xxx → " +
        "model_not_found，而该错误被 extract_one 吞掉并写进 extraction_cache/：" +
        "退出码 0、看起来跑完了、实际什么都没抽出来，且重跑会命中空缓存。" +
        "请看输出里的 `LLM errors:` 一行，不要只看退出码。",
    },
    generatedAt: input.nowMs,
  }
}

/** 写盘。token 在里面，所以文件权限收紧到 600。 */
export function writeHandoffManifest(path: string, manifest: HandoffManifest): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 })
}
