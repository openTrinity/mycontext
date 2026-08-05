/**
 * 向量 KNN。
 *
 * ## 为什么必须离开主进程
 *
 * 实测 1024 维 5 万条单查询 = **35.7ms 纯 CPU 阻塞**。放在 Electron 主进程里
 * 就是全进程停顿：IPC 停、采集延迟、UI 掉帧。数字人 8 会话并发时串行约 290ms。
 *
 * 因此计算跑在 worker 里，向量矩阵放 `SharedArrayBuffer` **零拷贝**共享 ——
 * 否则每次查询都要把 49MB 结构化克隆一遍，那比计算本身还贵。
 *
 * ## 为什么是 worker_threads 而不是 utilityProcess
 *
 * `utilityProcess` 是 Electron API，会让这个包**不能在 Node 与测试里直接跑**
 * （而 packages/* 不依赖 electron 是由 lint 强制的铁律）。
 * `worker_threads` 在两种环境下都可用，且 `SharedArrayBuffer` 的零拷贝语义相同。
 *
 * ## 为什么 sqlite-vec 不是主方案
 *
 * 实测 `db.loadExtension('vec0')` → `dlopen ... no such file`：
 * 需要额外分发 loadable extension，Electron 下还要处理 ABI 与签名。
 * 把它写成主方案会让实施时花时间去试一条走不通的路 ——
 * 一期唯一方案就是本文件 + `message_vectors` 表。
 */
import { cosineInt8 } from "./quantize.js"

export interface KnnCandidate {
  messageId: string
  embedding: Buffer
  scale: number
  dim: number
}

export interface KnnHit {
  messageId: string
  score: number
}

/**
 * 同步的暴力 KNN。
 *
 * 直接导出是为了让 worker 与测试共用同一份实现 ——
 * 「worker 里算的和测试里算的是同一段代码」这件事不该靠人保证。
 *
 * @param scopeIds 限定候选集（persona 侧的隐私边界）。undefined = 全库。
 */
export function knnSearch(
  query: { embedding: Buffer; scale: number; dim: number },
  candidates: readonly KnnCandidate[],
  options: { topK?: number; scopeIds?: ReadonlySet<string> } = {},
): KnnHit[] {
  const topK = options.topK ?? 20
  const scope = options.scopeIds
  const hits: KnnHit[] = []

  for (const candidate of candidates) {
    if (scope !== undefined && !scope.has(candidate.messageId)) continue
    // 维度不同不是错误而是"换过模型"：跳过而不是抛错，让重建可以渐进进行。
    if (candidate.dim !== query.dim) continue
    hits.push({
      messageId: candidate.messageId,
      score: cosineInt8(
        query.embedding,
        query.scale,
        candidate.embedding,
        candidate.scale,
        query.dim,
      ),
    })
  }

  // 部分排序足够：topK 通常是 20，而候选可能 20 万。
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}

/**
 * KNN 后端接口。
 *
 * 接口是 `Promise<KnnHit[]>`，调用方对「跑在哪」无感 ——
 * 这也是把它做成可替换后端的原因：测试用同步后端（无 worker 开销），
 * 生产用 worker 后端（不阻塞主线程）。
 */
export interface KnnBackend {
  /** 载入/替换常驻向量集。 */
  load(candidates: readonly KnnCandidate[]): Promise<void>
  search(
    query: { embedding: Buffer; scale: number; dim: number },
    options?: { topK?: number; scopeIds?: ReadonlySet<string> },
  ): Promise<KnnHit[]>
  /** 常驻条数：状态页显示「常驻 N / 总 M / 量化 int8」，让降级可见。 */
  residentCount(): number
  dispose(): Promise<void>
}

/**
 * 同进程后端。
 *
 * ## ★ 一期唯一实现，且尚未接入搜索路径
 *
 * 上面那段论证（35.7ms 纯 CPU 阻塞必须离开主进程）**是对的，但还没落地**：
 * worker 后端一期**未实现**（首版注释写「生产路径应使用
 * `createWorkerKnnBackend`」，而那个函数全仓库不存在 —— 注释比代码超前，
 * 读者会误判完成度）。当前 `SearchService` 也**不调用任何向量检索**，
 * 走的是 FTS 召回。
 *
 * 因此这个类现在承担两个角色：单测用的后端，以及将来 worker 化时的参考实现。
 * 接入前必须先做 worker 化 —— 直接在主进程调它会让 8 会话并发串行约 290ms，
 * 表现是 IPC 停顿 + 采集延迟 + UI 掉帧。
 *
 * ## ★ 有门禁守着（不只是这段注释）
 *
 * `tests/unit/agent-runtime/spawn-wiring.test.ts` 里有一条源码扫描：
 * **`apps/desktop/src/main` 下不得出现 `InlineKnnBackend`**。
 * 与 opencode spawn 那条同形状，理由也一样 —— 这个错误的表现是
 * 「功能完全正常，只是全进程周期性停顿」，没有任何红灯会亮，
 * 而注释挡不住任何人。
 */
export class InlineKnnBackend implements KnnBackend {
  private candidates: readonly KnnCandidate[] = []

  load(candidates: readonly KnnCandidate[]): Promise<void> {
    this.candidates = candidates
    return Promise.resolve()
  }

  search(
    query: { embedding: Buffer; scale: number; dim: number },
    options: { topK?: number; scopeIds?: ReadonlySet<string> } = {},
  ): Promise<KnnHit[]> {
    return Promise.resolve(knnSearch(query, this.candidates, options))
  }

  residentCount(): number {
    return this.candidates.length
  }

  dispose(): Promise<void> {
    this.candidates = []
    return Promise.resolve()
  }
}
