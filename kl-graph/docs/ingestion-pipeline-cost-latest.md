# Ingestion Pipeline 代价分析（含 checkpoint 策略与步骤依赖）

*本地参考文档，不提交到 git。基于 commit 293319b 后的代码状态。*

## 流程

每次 `/ingest` 请求走同一套 Phase A → Phase B → Improvement → Finalization。
首次构建和增量更新代码路径完全相同，区别只在于有多少 unit 是新的。
Dedup 基于复合身份 `(source_id, source_type, unit_id)`，已提交的 unit 自动跳过。

## 变量定义

| 变量 | 含义 |
|---|---|
| B | 输入字节 |
| U | 候选 source unit 数 |
| N | 本批次新 chunk 数 |
| T | 提取输入 token 数 |
| K_e, K_f | 受影响实体数、新事实数 |
| V, V_e, E | 全图节点/实体/边数 |
| S | 缓存的结构边数 |
| P, E_P | frontier 节点/诱导边数 |
| I_K | 受影响节点的结构关联遍历量 |
| Q_P | frontier 内结构配对数 |
| C | 变更社区成员行数 |
| D | 向量维度 (4096) |
| F | 全图事实数 |
| A | ANN limit (50) |
| Z, I_Z | 增量 finalization 的 dirty 邻接键数及其 incident 边数 |
| E_R, J | PageRank 的 facts-only 实体投影边数和迭代次数 |

## Phase A + B（每批次）

| 步骤 | 代价 | 性质 | checkpoint 策略 |
|---|---|---|---|
| 源扫描解析 | O(B) | 本地 IO | 无（幂等，重跑无副作用） |
| 分 chunk + dedup | O(U) | 本地 CPU + SQLite 索引 | 无（幂等） |
| chunk 持久化 | O(N) | SQLite 事务 | `phase_a.persist_chunks` — 标记后跳过，重跑时 chunk 已在库 |
| chunk embedding | O(N×D) | 远程 API，重 | `phase_a.embed_chunks` — 标记后跳过，Qdrant 点已写入 |
| extraction cache 查询 | O(N) | SQLite 读 | 无（只读） |
| LLM 提取 | O(T) | 远程 API，通常最贵 | `phase_b.extraction` — 整个 workset 提取完成后标记；逐 chunk 结果由 extraction cache 复用 |
| 实体构建 | O(提取结果) | 本地 upsert | `phase_b.build_entities` — 标记后跳过 |
| 事实构建 | O(提取结果) | 本地，确定性 ID | `phase_b.build_facts` — 标记后跳过 |
| 实体/事实 embedding | O((Ke+Kf)×D) | 远程 API，重 | `phase_b.embed_graph` — 标记后跳过，确定性 vector ID |
| 结构边构建 + cache delta | O(新边数) | 本地写入 + 内存更新 | `phase_b.create_edges` — delta 在 checkpoint 内 apply，crash 后重跑重建边并重新 apply delta |

## Improvement（incremental 模式）

| 步骤 | 代价 | 备注 | checkpoint 策略 |
|---|---|---|---|
| 恢复受影响 ID | O(N + output IDs) | StructuralCache 反向查询；无缓存时 O(E) | 无（从持久化 workset 读，幂等） |
| ANN 相似度 | O(K×A) | 每个受影响节点一次 Qdrant ANN | `improve.incremental_similarity` — 标记后跳过，边已插入 |
| 批内相似度 | O(K²×D) | 密集余弦矩阵，大批次是风险点 | 同上 |
| 结构特征/frontier 加载 | O(I_K) | 缓存查询避免 store 扫描；高度数实体可能很贵 | 无（读缓存，幂等） |
| Frontier 社区 | O(P + E_P + Q_P) | 1) 查种子相似度边+结构邻居扩展 frontier；2) 对完整 frontier 重查诱导边；3) 构建小 igraph；4) 4 级 × 3 轮 Leiden | `improve.incremental_leiden` — 存 `changed_communities` (UUID 集合) + `changed_community_keys` (可逆 (node_type, level, cluster_id) 元组) 到 meta |
| 社区投影 | O(C) | 用可逆键做 `WHERE community_Lx IN (...)` 索引读取 + scoped COMM_MEMBER 删建。空变更是 no-op | `improve.incremental_projection` — 从 meta 恢复 changed_communities + community_keys，只用那些键做投影 |
| 摘要失效标记 | O(touched) | 本地元数据更新 | 同上（projection checkpoint 内） |

**总成本**：排除 ANN 和密集余弦后，本地增量图工作约 O(K + I_K + P + Q_P + E_P + C)。
不是严格 O(K)——依赖节点度数。高度数实体可能让小批次也很贵，但不会触发全图扫描。

## Finalization（增量刷新）

| 步骤 | 代价 | 性质 | checkpoint 策略 |
|---|---|---|---|
| 邻接索引增量刷新 | O(Z + I_Z) | copy-on-write 分片替换，只重建 dirty 节点的 bucket | 无 — 不在 checkpoint 覆盖内，crash 后 server 重启从 store 全量重建 |
| PageRank 重算 | O(E_R × J) | 仅当 workset 有新 facts 时触发 | 同上 |

Finalization 现在是增量的。`ServingIndexUpdate` 从 runner 传 dirty scope 到 server：
- `structural_nodes` = 批次的 chunks + facts（有新结构边）
- `similarity_nodes` = 批次的 entities + facts（有新相似度边，仅 incremental 模式）
- `community_ids` = improvement 返回的 changed_community_ids
- `full_adjacency` = full improvement 模式
- `pagerank_dirty` = 批次有新 facts

server 的 `_hot_swap_graph` 用 `AdjacencyIndex.replace_buckets()` 只替换受影响节点的 bucket。
安全阀：dirty 节点超过总节点 25% 或异常时降级为全量重建。

## Checkpoint 语义汇总

| checkpoint key | 覆盖范围 | 标记时机 | 恢复行为 | 原子性 |
|---|---|---|---|---|
| `phase_a.persist_chunks` | chunk 持久化 | SQLite commit 后 | 跳过，chunk 已在库 | SQLite 事务 |
| `phase_a.embed_chunks` | chunk 向量化 | Qdrant 写入后 | 跳过，向量已写入 | Qdrant upsert |
| `phase_b.extraction` | LLM 提取 | 全部 workset chunk 的提取完成后 | checkpoint 命中则跳过；结果从 extraction cache 恢复 | extraction_cache SQLite 表 |
| `phase_b.build_entities` | 实体构建 | SQLite upsert 后 | 跳过，实体已在库 | SQLite 事务 |
| `phase_b.build_facts` | 事实构建 | SQLite insert 后 | 跳过，事实已在库 | SQLite 事务 |
| `phase_b.embed_graph` | 实体/事实向量化 | Qdrant 写入后 | 跳过，确定性 vector ID | Qdrant upsert |
| `phase_b.create_edges` | 结构边 + cache delta | bulk insert + `apply_delta` 后 | 重跑重建边并重新 apply delta | SQLite 事务，delta 在 checkpoint 内 |
| `improve.incremental_similarity` | ANN + 批内余弦 + 边插入 | `store.insert_edges` 后 | 重跑全部相似度计算 | 边插入是 UPSERT/INSERT OR IGNORE |
| `improve.incremental_leiden` | frontier Leiden + 社区列更新 | `UPDATE community_Lx` + commit 后 | 跳过，从 meta 恢复 changed 集合 | SQLite executemany + commit |
| `improve.incremental_projection` | scoped COMM_MEMBER 投影 + 摘要失效 | 投影写入后 | 从 meta 恢复 community_keys，重跑 scoped 投影 | SQLite 事务（SQLiteStore 路径） |
| `ingest.complete` | 整个 ingest 完成标记 | improvement 和 server finalization 成功后、workset 清理前 | 跳过已完成阶段并幂等重试 workset 清理 | JSON 原子 rename |

## 全图操作（不随 K 缩小）

| 操作 | 频率 | 代价 | 可优化？ | checkpoint？ |
|---|---|---|---|---|
| Structural cache 启动 | server 启动一次 | O(S) 时间 + 内存 | 一次性成本 | 无 |
| 社区列索引创建 | full rebuild 时一次 | O(V) | 一次性成本 | 无 |
| 邻接索引全量重建 | server 启动 / full improvement / dirty > 25% / 异常恢复 | O(E) | 仅 fallback 路径 | 无 |
| PageRank 全量重算 | server 启动 / workset 有新 facts | O(E_R × J) | 仅 conditional 触发 | 无 |

**不再有每批次固定 O(E) 的全图操作。** 正常增量路径的全链路——improvement + finalization——都是 output-sensitive 的。

## Full improvement

| 步骤 | 代价 | checkpoint 策略 |
|---|---|---|
| 事实全量相似度 | O(F²×D)，17K×4096 维约 1.1GB | `improve.fact_similarity` — `run_if_needed` |
| 实体全量相似度 | O(Ve²×D) | `improve.entity_similarity` — `run_if_needed` |
| 实体消歧 | 最多 500 次 LLM 调用 | `improve.disambiguation` — `run_if_needed` |
| 全量社区 + 全量投影 | 4×2 Leiden，10 轮，全图；随后删重建全量 COMM_MEMBER | `improve.communities` — assignment、存储和投影是一个逻辑 checkpoint |
| 邻接索引全量重建 | O(E) | 无（`full_adjacency=True` 触发） |
| PageRank（独立条件） | O(E_R × J) | full improvement 本身不触发；仅在 PageRank 输入 dirty、server 启动或显式完整 refresh 时重算 |

## 步骤间依赖关系

> **维护规则：修改 schema 或增加/删除步骤时，必须检查下表确认 dirty scope 和 checkpoint 是否需要同步更新。**

### Artifact dependency registry

这张表是依赖关系的主索引。修改任何 producer、artifact schema、算法参数或 consumer 时，应沿同一行检查 invalidation、checkpoint 和删除语义，而不是只修改当前步骤。

| Artifact | Producer / authoritative input | Consumer | Refresh / invalidation trigger | Checkpoint / version contract | Delete / replacement semantics |
|---|---|---|---|---|---|
| Durable workset | Phase A admission；`(source_id, source_type, unit_id)` 去重后写入 `ingest_batch_chunks` | extraction、graph build、improvement target recovery、finalization scope | 新 checkpoint epoch / 新 admitted unit | `batch_id` 是整条链路的稳定身份；`ingest.complete` 在 finalization 成功后、cleanup 前标记 | 当前只支持新增；same-ID/different-content 被跳过。workset 只能在所有 dependent phase 成功后清理 |
| Chunk rows + chunk vectors | Phase A persist + embed；chunk text 和 embedding model/config 是输入 | chunk retrieval；Phase B extraction 使用 chunk rows | 新 chunk；未来若 text/model/dimension 改变必须显式 re-embed | `phase_a.persist_chunks` / `phase_a.embed_chunks` 当前没有 model/schema revision | Qdrant point 是确定性 ID；当前 resume 语义会复用已存在向量，不代表内容/model 变更已传播 |
| Entity/fact rows + graph vectors | Phase B extraction → entity/fact build → `phase_b.embed_graph` | ANN/full similarity、entity disambiguation、fact retrieval | 新 node；未来 node text、embedding model或 dimension 改变 | `phase_b.embed_graph` 当前只按 checkpoint 和 point ID 判断，不记录 embedding generation | 已存在 point ID 会被跳过；replacement feature 必须定义 vector overwrite/delete，并让 similarity/community 下游失效 |
| Structural edges + `StructuralCache` | `phase_b.create_edges` 生成 MENTIONS、AUTHORED_BY、ABOUT；同一 checkpoint 内 `apply_delta` | improvement target recovery、entity hybrid score、community frontier；ABOUT 同时是 PageRank 输入 | 每批新结构边；任何未来结构边 update/delete | edge persistence 和 cache delta 必须在 `phase_b.create_edges` checkpoint 内一起完成 | cache 当前是 append-only。未来 delete/replace 必须传 old/new delta 或完整重建 cache，否则 target 和 scoring 会读到 stale mapping |
| Similarity edges | Incremental ANN/intra-batch；full similarity；full entity disambiguation | Leiden community graph、graph walk/query expansion、adjacency serving index | target vector/structural feature、threshold、weights、ANN policy、algorithm/model generation 改变 | incremental checkpoint 当前只记录 `batch_id` + strategy names；full checkpoint只覆盖部分显式 thresholds | similarity/full paths主要是 insert；除 disambiguation 自有边外没有 canonical replacement。重跑不能删除全部 obsolete edges，社区仍可能消费 stale edges |
| Community assignment columns | Incremental frontier Leiden 或 full Leiden；输入是 similarity + structural projection + resolutions | COMM_MEMBER projection、community summary generation、global search membership lookup | 上游 similarity/structural graph改变；resolution/iteration/algorithm改变 | `improve.incremental_leiden` 必须在 similarity 后；full assignment/projection共用 `improve.communities` | full 清空并重写全部 assignment；incremental只修改 frontier。changed UUID + reversible community key 必须持久化供 resume/projection 使用 |
| Community rows + `COMM_MEMBER` | Assignment columns → scoped/full projection | adjacency、graph walk、community browse；summary invalidation以 changed communities 为 scope | assignment changed set | `improve.incremental_projection` 依赖 Leiden checkpoint meta；full projection属于 `improve.communities` | SQLite full/scoped replacement是事务性的；generic backend是 best-effort。删除 old member 时 finalization 必须同时刷新 old member bucket |
| Community summaries + community vectors | 独立 summarizer 写 `community_summaries`；独立 embed tool 写 community Qdrant | global search、`/community`、community vector search | community membership/content改变，或 summarizer/embedding model改变 | 不属于 `POST /ingest` checkpoint；当前没有统一 summary/vector generation revision | 当前 incremental 路径只写 `communities.summary_stale`；global search直接读 `community_summaries`，community Qdrant也不读取该 flag，因此 invalidation 尚未端到端传播 |
| In-memory adjacency index | Server startup full build；server ingest finalization增量/完整 reconcile committed edges | graph walk、context/entity/community endpoints | `_EDGE_ENDPOINTS` 中任何边的 insert/update/delete；投影规则变化 | 无 durable checkpoint；crash 后 server startup 从 store 全量重建 | 增量路径从当前 store发现 new endpoints，并只为 COMM_MEMBER 从 old snapshot恢复 deleted endpoints。未来 structural/similarity delete需要显式 old endpoints或强制 full rebuild |
| In-memory PageRank prior | Facts/confidence + fact→entity ABOUT 投影；startup/finalization计算 | `state.pagerank` 直接用户；`state.engine.pagerank` query-engine 用户 | 任何 fact confidence、ABOUT endpoint或未来新增 PageRank input改变 | 无 durable checkpoint；producer dirty contract目前硬编码在 runner | 完整替换内存 dict，并同步更新 query engine handle；新增缓存 PageRank 的 consumer 时必须加入 publication hook |

共同规则：

1. artifact 的输入定义变化时，producer 的版本/revision 必须变化。
2. producer 重跑时，所有 downstream checkpoint 必须失效或证明仍然有效。
3. “重新计算”只有在能删除/替换 obsolete output 时才等价于 reconciliation；纯 insert 不是完整 rebuild。
4. server 内存 artifact 只有通过 server endpoint 的 finalizer 或 server restart 才会刷新；standalone writer 不会自动 hot-swap live server state。

### Vector → similarity → community checkpoint chain

```
Phase B entity/fact rows
  → phase_b.embed_graph (Qdrant vectors)
  → improve.incremental_similarity (similarity edges)
  → improve.incremental_leiden (community assignment columns)
  → improve.incremental_projection (community rows + COMM_MEMBER)
  → finalization (adjacency buckets)
```

修改 embedding generation、similarity threshold/weights/ANN limit、community resolution 或算法实现时，不能只清理当前 step 的 checkpoint。必须从第一个受影响 artifact 开始向下游级联失效。当前 incremental checkpoint params 只包含 `batch_id`、`similarity_strategy` 和 `community_strategy`，尚未覆盖默认 thresholds、ANN top-K、`RESOLUTIONS`、Leiden iteration count、embedding model 或实现版本。

### Community summary / vector freshness

incremental community projection 会在 `communities.summary_stale` 上标记一部分 reified community row，但当前主要 summary consumer `GlobalSearch` 直接读取 `community_summaries`，community vector search 则读取单独的 Qdrant collection。两者都不读取这个 stale flag。因此当前行为只是记录“需要重建”的信号，不会阻止 stale summary/vector 被继续使用。

完整 dependency 是：

```
community assignment / membership changed
  → mark summary generation dirty
  → regenerate community_summaries
  → regenerate/upsert community vectors
  → publish or reopen the serving view if required
```

在该链路有 durable generation/revision 之前，文档和 API 不应把 `summary_stale` 描述成已经完成 summary/vector refresh。

### 邻接索引（AdjacencyIndex）依赖

邻接索引从 `_EDGE_ENDPOINTS` 表列出的所有边类型构建。dirty scope 必须覆盖所有产生新边或删除边的步骤。

| 产生/修改边的步骤 | 影响的边类型 | dirty scope 字段 | 代码位置 |
|---|---|---|---|
| Phase B: 结构边构建 | MENTIONS, AUTHORED_BY, ABOUT, TEMPORAL, REPLY_TO, STATES, PART_OF | `structural_nodes` (batch chunks + facts) | `runner.py` 构建 `ServingIndexUpdate` |
| Improvement: 相似度 | ENTITY_SIMILAR, FACT_SIMILAR | `similarity_nodes` (batch entities + facts) | 同上 |
| Improvement: 社区投影 | COMM_MEMBER | `community_ids` (changed community UUIDs) | 同上 |
| Full improvement | 全部 | `full_adjacency=True` | 同上 |

**如果新增边类型**：
1. 在 `graph-design.md` 和 `EdgeType` 枚举中声明
2. 在 `_EDGE_ENDPOINTS` (`kl_server.py`) 中添加 `(edge_type, source_type, target_type)`
3. 在 `_append_adjacency_edge` (`kl_server.py`) 中添加投影逻辑
4. 在 `_build_adjacency_buckets_full` (`kl_server.py`) 中确保投影一致
5. 在 `runner.py` 的 `ServingIndexUpdate` 构建逻辑中添加对应的 dirty scope（如果新边类型的产生源不是已覆盖的 structural/similarity/community 范围）

### PageRank 依赖

PageRank 从 facts→entity ABOUT 投影计算实体图，然后跑 power iteration。

| PageRank 输入 | 来源步骤 | dirty 触发条件 | 代码位置 |
|---|---|---|---|
| ABOUT 边 (fact→entity) | Phase B: 事实构建 + 结构边构建 | `pagerank_dirty=bool(targets.fact_ids)` | `runner.py` |

**当前只依赖 facts→entity ABOUT 边。** 如果 PageRank 的输入图改变（例如加入 ENTITY_SIMILAR 边或社区结构作为先验），必须同步更新 `pagerank_dirty` 的触发条件。

⚠️ **这是当前最 fragile 的依赖**：`pagerank_dirty` 的触发条件硬编码在 `runner.py` 中，基于 `_compute_pagerank` 只用 ABOUT 边的假设。如果 `_compute_pagerank` 的逻辑改变（例如开始包含 ENTITY_SIMILAR），runner 不会知道，PageRank 在 similarity-only 变更时不会被标记为 dirty。

### StructuralCache 依赖

StructuralCache 缓存 MENTIONS, AUTHORED_BY, ABOUT 边的双向映射。delta 从 `_create_edges` 的输出边列表中提取。

| Cache 映射 | 来源边类型 | delta 触发 | 代码位置 |
|---|---|---|---|
| entity→chunks, chunk→entities | MENTIONS, AUTHORED_BY | `phase_b.create_edges` checkpoint 内 `apply_delta(edges)` | `pipeline.py:_create_edges` |
| entity→facts, fact→entities | ABOUT | 同上 | 同上 |

**如果 StructuralCache 的用途扩展**（例如开始缓存 ENTITY_SIMILAR 用于其他计算），必须：
1. 在 `StructuralCache.__init__` 添加新映射
2. 在 `from_store` 添加加载逻辑
3. 在 `apply_delta` 的 `_STRUCTURAL_EDGE_TYPES` 添加新边类型
4. 确保 delta 来源（`_create_edges` 的输出）包含该边类型

### Improvement dirty scope → Finalization 传递链

```
improvement.py:run_incremental_improvement
  → communities.assign_communities() 返回 CommunityChanges (UUID 集合 + community_keys)
  → ImprovementResult.changed_community_ids = tuple(sorted(changed))
  → runner.py:run_ingestion
    → improvement = run_improvement(...)  # 返回 ImprovementResult
    → ServingIndexUpdate.community_ids = improvement.changed_community_ids
    → finalize_callback(ServingIndexUpdate)
      → kl_server._hot_swap_graph(update)
        → _incremental_adjacency(store, current, update)
          → _scan_incident_edges(store, community_nodes, edge_types={"COMM_MEMBER"})
```

**如果 improvement 新增改变 COMM_MEMBER 边的步骤**（例如未来加入社区合并/分裂操作），必须确保：
1. 新步骤返回的 changed community UUIDs 被加入 `ImprovementResult.changed_community_ids`
2. 对应的 `community_keys` 被加入 checkpoint meta
3. `ServingIndexUpdate.community_ids` 覆盖这些变更

### 邻接增量刷新 → 查询引擎一致性

查询引擎 (`graph_walk.py`) 通过 `Mapping[str, Sequence[tuple]]` 接口读邻接索引。`AdjacencyIndex` 是 immutable 的，`replace_buckets` 返回新实例。server 用 Python 引用赋值原子替换，in-flight 查询继续用旧索引直到新索引就绪。

**如果查询引擎新增对邻接索引的使用方式**（例如新增需要遍历某类边的端点），必须确保：
1. 该边类型在 `_EDGE_ENDPOINTS` 中声明
2. dirty scope 覆盖产生该边类型的步骤
3. `_append_adjacency_edge` 正确投影该边类型到两端

## 实际瓶颈

对于增量请求，LLM 提取和 embedding API 调用通常是最贵的。
本地图工作从原来的 O(E) + O(V+E) + O(V) + O(E) ≈ 百万级数百秒，
降到了 O(K + I_K + P + Q_P + E_P + C + Z + I_Z) ≈ 度数依赖的亚秒级。
**不再有每批次固定 O(V) 或 O(E) 的全图操作。** 全量重建仅在 server 启动、full improvement、dirty 范围过大（>25%）或异常恢复时触发。
