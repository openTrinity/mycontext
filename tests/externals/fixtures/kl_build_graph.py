"""把我们导出的文件建成他们的图库，并把统计打成 JSON。

这个脚本是测试的一部分（由 kl-e2e.test.ts 调用），刻意只用他们的
**加载器 + 存储层 + 类型**：这三层是纯 stdlib，不需要 jieba/qdrant/LLM。
实体抽取用一个显式的规则替身 —— 我们要验的是管道，不是抽取质量。

## ★ 走 `message_loader.load_all_messages` 而不是 adapter

上游把 `kl_graph/adapters/dws_message_adapter.py` **删掉了**（改成标准四件套
+ `ingest/loaders/`）。我们上一轮同步了他们的新版代码，却漏改这个 fixture ——
于是 `ModuleNotFoundError: No module named 'kl_graph.adapters'`。

那次没被发现的原因值得记下来：`pnpm test` 用 `--exclude 'tests/externals/**'`
把这一层排除了，只有 `pnpm test:externals` 会跑。也就是说**同步外部依赖时
必须显式跑一次 externals**，否则「他们删了什么」要等到很久以后才知道。

现在用他们的加载器反而更强：它就是生产链路真正在用的那个函数
（`scripts/ingest.py` → `pipeline` → `load_all_messages`），
测的是同一段代码而不是一个平行的转换实现。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

kl_root, export_dir, db_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
sys.path.insert(0, kl_root)

from kl_graph.ingest.loaders.message_loader import load_all_messages
from kl_graph.models.types import Edge, EdgeType, Entity, EntityType
from kl_graph.storage.sqlite_store import SQLiteStore

# ── 1. 用他们**生产链路里的**加载器读我们导出的标准四件套 ─────────────
#     load_all_messages 已按 timestamp 排序，但显式再排一次：
#     下面 TEMPORAL 边依赖时间序，让这个依赖在本文件里可见。
messages = load_all_messages(export_dir / "chat")
messages.sort(key=lambda m: m.timestamp)
if not messages:
    raise SystemExit("load_all_messages 读到 0 条 —— 导出格式与他们的加载器对不上")

store = SQLiteStore(db_path)
store.insert_messages(messages)

# ── 2. 发送者建成 Person 实体 ─────────────────────────────────────────
#     用 sender_id（稳定标识）去重，而不是 sender（显示名可能是花名）。
by_sender_id: dict[str, Entity] = {}
for message in messages:
    key = message.sender_id or ""
    if key == "" or key in by_sender_id:
        continue
    by_sender_id[key] = Entity(
        name=message.sender,
        entity_type=EntityType.PERSON,
        first_seen=message.timestamp,
        last_seen=message.timestamp,
    )
store.upsert_entities_bulk(list(by_sender_id.values()))

# ── 3. 建结构边 ───────────────────────────────────────────────────────
edges: list[Edge] = []
for index, message in enumerate(messages):
    sender_entity = by_sender_id.get(message.sender_id or "")
    if sender_entity is not None:
        edges.append(Edge("message", message.id, "entity", sender_entity.id, EdgeType.SENT_BY))
    edges.append(
        Edge("message", message.id, "conversation", message.conversation_id, EdgeType.IN_CONV)
    )
    if message.reply_to:
        edges.append(Edge("message", message.id, "message", message.reply_to, EdgeType.REPLY_TO))
    if index > 0:
        # TEMPORAL：前一条 → 这一条（时间序已在上面排好）
        edges.append(
            Edge("message", messages[index - 1].id, "message", message.id, EdgeType.TEMPORAL)
        )
store.insert_edges(edges)

# ── 4. 查出来（走他们的 API，不是我们自己写 SQL）────────────────────
last = messages[-1]
neighbors = store.get_neighbors("message", last.id, direction="both")

print(
    json.dumps(
        {
            "messages": store.count_messages(),
            "entities": store.count_entities(),
            "edges": store.count_edges_by_type(),
            "neighborsOfLast": sorted({row["edge_type"] for row in neighbors}),
            "timestamps": [m.timestamp for m in messages],
        },
        ensure_ascii=False,
    )
)
store.close()
