"""Entity disambiguation pipeline.

Resolves entity duplicates that share different surface names but refer to
the same real-world entity. Produces ENTITY_SIMILAR edges with confidence scores
rather than hard merges — resolution happens at query time.

Pipeline:
1. Candidate generation (blocking): pinyin, char overlap, embedding ANN, structural
2. Hybrid scoring: weighted combination of 5 signals
3. Decision: auto-link (≥0.7), auto-reject (<0.3), LLM judge (0.3-0.7)
4. Edge creation: ENTITY_SIMILAR with confidence + source metadata

This avoids O(n²) pairwise comparison by using cheap blocking first.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np

from kl_graph.config import cfg
from kl_graph.models.types import Edge, EdgeType
from kl_graph.storage.base import KnowledgeStore
from kl_graph.storage.vector_store import VectorStore
from kl_graph.utils.litellm_config import litellm, provider_api_key, provider_model


@dataclass
class EntityInfo:
    """Lightweight entity info for disambiguation."""

    id: str
    name: str
    entity_type: str
    mention_count: int = 1
    pinyin: str = ""
    pinyin_initials: str = ""
    message_ids: set = field(default_factory=set)
    conversation_ids: set = field(default_factory=set)
    connected_entities: list = field(default_factory=list)


@dataclass
class CandidatePair:
    """A candidate pair with scoring details."""

    entity_a: EntityInfo
    entity_b: EntityInfo
    # Scores
    pinyin_score: float = 0.0
    char_jaccard: float = 0.0
    embedding_score: float = 0.0
    structural_score: float = 0.0
    cooccurrence_score: float = 0.0
    # Aggregate
    hybrid_score: float = 0.0
    # Decision
    decision: str = ""  # "link", "reject", "judge"
    llm_verdict: dict = field(default_factory=dict)
    # Final confidence for edge creation
    confidence: float = 0.0


def get_pinyin(text: str) -> tuple[str, str]:
    """Get full pinyin and initials for a text string."""
    try:
        from pypinyin import Style, lazy_pinyin

        full = lazy_pinyin(text, style=Style.NORMAL)
        initials = lazy_pinyin(text, style=Style.FIRST_LETTER)
        return "".join(full), "".join(initials)
    except ImportError:
        # Fallback: just use the raw text
        return text.lower(), text[0].lower() if text else ""


def pinyin_similarity(py_a: str, py_b: str) -> float:
    """Normalized edit-distance similarity between two pinyin strings."""
    if not py_a or not py_b:
        return 0.0
    if py_a == py_b:
        return 1.0

    # Levenshtein distance
    m, n = len(py_a), len(py_b)
    if m == 0 or n == 0:
        return 0.0

    dp = list(range(n + 1))
    for i in range(1, m + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, n + 1):
            temp = dp[j]
            if py_a[i - 1] == py_b[j - 1]:
                dp[j] = prev
            else:
                dp[j] = 1 + min(prev, dp[j], dp[j - 1])
            prev = temp

    max_len = max(m, n)
    return 1.0 - dp[n] / max_len


def char_jaccard(name_a: str, name_b: str) -> float:
    """Character-level Jaccard similarity."""
    chars_a = set(name_a)
    chars_b = set(name_b)
    if not chars_a or not chars_b:
        return 0.0
    intersection = len(chars_a & chars_b)
    union = len(chars_a | chars_b)
    return intersection / union if union > 0 else 0.0


def structural_jaccard(msgs_a: set, msgs_b: set, min_shared: int = 3) -> float:
    """Jaccard similarity on message sets.

    Only counts as meaningful if they share at least min_shared messages.
    """
    if not msgs_a or not msgs_b:
        return 0.0
    intersection = len(msgs_a & msgs_b)
    if intersection < min_shared:
        return 0.0
    union = len(msgs_a | msgs_b)
    return intersection / union if union > 0 else 0.0


def conversation_cooccurrence(convs_a: set, convs_b: set) -> float:
    """Fraction of overlapping conversations.

    Downweighted: only meaningful if they share multiple conversations.
    """
    if not convs_a or not convs_b:
        return 0.0
    intersection = len(convs_a & convs_b)
    if intersection < 2:
        return 0.0
    min_size = min(len(convs_a), len(convs_b))
    return intersection / min_size if min_size > 0 else 0.0


def differs_only_by_punctuation(name_a: str, name_b: str) -> bool:
    """Check if two names differ only by punctuation/spacing.

    "eval-system" / "evalsystem" / "eval_system" → True
    "qwen3.7-plus" / "qwen3.7plus" → True
    "陈明（小陈）" / "陈明(小陈)" → True
    """
    # Normalize: remove all punctuation (including CJK punctuation) and spaces, lowercase
    norm = re.compile(r"[-_.\s（）()【】\[\]{}「」《》<>]+")
    a_norm = norm.sub("", name_a).lower()
    b_norm = norm.sub("", name_b).lower()
    return a_norm == b_norm and name_a != name_b


def load_entity_info(store: KnowledgeStore) -> dict[str, EntityInfo]:
    """Load all entities with their context for disambiguation."""
    print("  Loading entity info...")

    # Basic entity data
    rows = store.sql_conn.execute(
        "SELECT id, name, entity_type, mention_count FROM entities"
    ).fetchall()

    entities = {}
    for r in rows:
        eid = r[0]
        name = r[1]
        pinyin_full, pinyin_init = get_pinyin(name)
        entities[eid] = EntityInfo(
            id=eid,
            name=name,
            entity_type=r[2],
            mention_count=r[3] or 1,
            pinyin=pinyin_full,
            pinyin_initials=pinyin_init,
        )

    # Load chunk associations (via MENTIONS/AUTHORED_BY edges), through the
    # backend-agnostic edge API. MENTIONS/AUTHORED_BY are chunk→entity.
    for chunk_id, entity_id, _props in store.scan_edges_by_type(
        ["MENTIONS", "AUTHORED_BY"], source_type="chunk", target_type="entity"
    ):
        if entity_id in entities:
            entities[entity_id].message_ids.add(chunk_id)

    # Load conversation IDs for each entity's chat chunks. The per-message
    # detail table is gone: ``conversation_id`` lives in the chunk metadata JSON.
    msg_to_conv = {}
    conv_rows = store.sql_conn.execute(
        """SELECT id, json_extract(metadata, '$.conversation_id') FROM chunks
           WHERE source_type = 'message'"""
    ).fetchall()
    for r in conv_rows:
        msg_to_conv[r[0]] = r[1]

    for ent in entities.values():
        for mid in ent.message_ids:
            if mid in msg_to_conv:
                ent.conversation_ids.add(msg_to_conv[mid])

    # Load connected entities (for context in LLM judge)
    entity_cooccur = defaultdict(lambda: defaultdict(int))
    fact_entities = defaultdict(set)
    for fact_id, entity_id, _props in store.scan_edges_by_type(
        ["ABOUT"], source_type="fact", target_type="entity"
    ):
        fact_entities[fact_id].add(entity_id)
    for fact_id, ent_set in fact_entities.items():  # noqa: PERF102
        ent_list = list(ent_set)
        for i in range(len(ent_list)):
            for j in range(i + 1, len(ent_list)):
                entity_cooccur[ent_list[i]][ent_list[j]] += 1
                entity_cooccur[ent_list[j]][ent_list[i]] += 1

    for eid, ent in entities.items():
        if eid in entity_cooccur:
            # Top-5 most connected entities
            sorted_neighbors = sorted(entity_cooccur[eid].items(), key=lambda x: -x[1])[
                :5
            ]
            ent.connected_entities = [
                entities[nid].name for nid, _ in sorted_neighbors if nid in entities
            ]

    print(f"  Loaded {len(entities)} entities with context")
    return entities


def generate_candidates(
    entities: dict[str, EntityInfo],
    embedding_vectors: dict[str, np.ndarray],
    pinyin_threshold: float = 0.8,
    char_overlap_threshold: float = 0.3,
    embedding_threshold: float = 0.82,
    structural_threshold: float = 0.3,
) -> list[tuple[str, str]]:
    """Generate candidate pairs via multiple blocking strategies.

    Returns deduplicated list of (entity_id_a, entity_id_b) pairs.
    """
    print("  Generating candidate pairs via blocking...")
    candidates = set()

    ent_list = list(entities.values())

    # Strategy 1: Pinyin equality / high similarity
    pinyin_groups = defaultdict(list)
    for ent in ent_list:
        if ent.pinyin:
            pinyin_groups[ent.pinyin].append(ent.id)

    pinyin_exact_pairs = 0
    for py, eids in pinyin_groups.items():  # noqa: PERF102
        if len(eids) > 1 and len(eids) <= 20:  # Skip huge groups
            for i in range(len(eids)):
                for j in range(i + 1, len(eids)):
                    candidates.add(tuple(sorted([eids[i], eids[j]])))
                    pinyin_exact_pairs += 1
    print(f"    Pinyin exact: {pinyin_exact_pairs} pairs")

    # Strategy 2: Pinyin initial match (for abbreviated names)
    initial_groups = defaultdict(list)
    for ent in ent_list:
        if ent.pinyin_initials and len(ent.pinyin_initials) >= 2:
            initial_groups[ent.pinyin_initials].append(ent.id)

    pinyin_initial_pairs = 0
    for initials, eids in initial_groups.items():  # noqa: PERF102
        if len(eids) > 1 and len(eids) <= 10:
            for i in range(len(eids)):
                for j in range(i + 1, len(eids)):
                    pair = tuple(sorted([eids[i], eids[j]]))
                    if pair not in candidates:
                        candidates.add(pair)
                        pinyin_initial_pairs += 1
    print(f"    Pinyin initials: {pinyin_initial_pairs} pairs")

    # Strategy 3: Character overlap for short Chinese names
    char_pairs = 0
    short_entities = [e for e in ent_list if 1 < len(e.name) <= 5]
    for i in range(len(short_entities)):
        for j in range(i + 1, len(short_entities)):
            a, b = short_entities[i], short_entities[j]
            shared = set(a.name) & set(b.name)
            if shared and char_jaccard(a.name, b.name) >= char_overlap_threshold:
                pair = tuple(sorted([a.id, b.id]))
                if pair not in candidates:
                    candidates.add(pair)
                    char_pairs += 1
    print(f"    Char overlap (short names): {char_pairs} pairs")

    # Strategy 4: Embedding ANN (batch cosine above threshold)
    if embedding_vectors:
        eids_with_emb = [eid for eid in entities if eid in embedding_vectors]
        if eids_with_emb:
            vecs = np.array(
                [embedding_vectors[eid] for eid in eids_with_emb], dtype=np.float32
            )
            norms = np.linalg.norm(vecs, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            vecs_norm = vecs / norms

            # Chunked cosine to find pairs above threshold
            emb_pairs = 0
            chunk_size = 200
            for i in range(0, len(eids_with_emb), chunk_size):
                chunk = vecs_norm[i : i + chunk_size]
                sims = chunk @ vecs_norm.T
                for local_idx in range(len(chunk)):
                    global_idx = i + local_idx
                    row = sims[local_idx]
                    row[global_idx] = 0.0  # mask self
                    above = np.where(row >= embedding_threshold)[0]
                    for j in above:
                        if j > global_idx:  # only one direction
                            pair = tuple(
                                sorted([eids_with_emb[global_idx], eids_with_emb[j]])
                            )
                            if pair not in candidates:
                                candidates.add(pair)
                                emb_pairs += 1
            print(f"    Embedding ANN: {emb_pairs} pairs")

    # Strategy 5: Structural (high message overlap)
    struct_pairs = 0
    active_ents = [e for e in ent_list if len(e.message_ids) >= 3]
    active_ents.sort(key=lambda e: -len(e.message_ids))
    active_ents = active_ents[:500]  # Cap at top 500 by activity

    for i in range(len(active_ents)):
        for j in range(i + 1, len(active_ents)):
            a, b = active_ents[i], active_ents[j]
            sj = structural_jaccard(a.message_ids, b.message_ids)
            if sj >= structural_threshold:
                pair = tuple(sorted([a.id, b.id]))
                if pair not in candidates:
                    candidates.add(pair)
                    struct_pairs += 1
    print(f"    Structural overlap: {struct_pairs} pairs")

    print(f"  Total candidate pairs: {len(candidates)}")
    return list(candidates)


def score_candidates(
    candidates: list[tuple[str, str]],
    entities: dict[str, EntityInfo],
    embedding_vectors: dict[str, np.ndarray],
    weight_pinyin: float = 0.25,
    weight_char: float = 0.20,
    weight_embedding: float = 0.15,
    weight_structural: float = 0.25,
    weight_cooccurrence: float = 0.15,
) -> list[CandidatePair]:
    """Score each candidate pair using hybrid metrics."""
    print(f"  Scoring {len(candidates)} candidate pairs...")

    scored = []
    for id_a, id_b in candidates:
        ent_a = entities[id_a]
        ent_b = entities[id_b]

        # Pinyin similarity
        py_sim = pinyin_similarity(ent_a.pinyin, ent_b.pinyin)

        # Character Jaccard
        cj = char_jaccard(ent_a.name, ent_b.name)

        # Embedding cosine
        emb_sim = 0.0
        if id_a in embedding_vectors and id_b in embedding_vectors:
            va = embedding_vectors[id_a]
            vb = embedding_vectors[id_b]
            norm_a = np.linalg.norm(va)
            norm_b = np.linalg.norm(vb)
            if norm_a > 0 and norm_b > 0:
                emb_sim = float(np.dot(va, vb) / (norm_a * norm_b))

        # Structural Jaccard (shared messages)
        sj = structural_jaccard(ent_a.message_ids, ent_b.message_ids)

        # Conversation co-occurrence
        co = conversation_cooccurrence(ent_a.conversation_ids, ent_b.conversation_ids)

        # Hybrid score
        hybrid = (
            weight_pinyin * py_sim
            + weight_char * cj
            + weight_embedding * emb_sim
            + weight_structural * sj
            + weight_cooccurrence * co
        )

        pair = CandidatePair(
            entity_a=ent_a,
            entity_b=ent_b,
            pinyin_score=py_sim,
            char_jaccard=cj,
            embedding_score=emb_sim,
            structural_score=sj,
            cooccurrence_score=co,
            hybrid_score=hybrid,
        )

        # Decision logic
        # Auto-link if purely punctuation/spacing difference
        if differs_only_by_punctuation(ent_a.name, ent_b.name):
            pair.decision = "link"
            pair.confidence = 0.99
        elif hybrid >= 0.7:
            pair.decision = "link"
            pair.confidence = hybrid
        elif hybrid < 0.3:
            pair.decision = "reject"
            pair.confidence = 0.0
        else:
            pair.decision = "judge"
            pair.confidence = hybrid  # Updated after LLM

        scored.append(pair)

    # Sort by hybrid score descending
    scored.sort(key=lambda p: -p.hybrid_score)

    n_link = sum(1 for p in scored if p.decision == "link")
    n_judge = sum(1 for p in scored if p.decision == "judge")
    n_reject = sum(1 for p in scored if p.decision == "reject")
    print(
        f"  Decisions: {n_link} auto-link, {n_judge} need LLM judge, {n_reject} auto-reject"
    )

    return scored


def _run_coro_sync(coro):
    """Run *coro* to completion from sync code, with or without a running loop.

    ``scripts/improve.py`` calls the periodic path with no event loop, but a
    library caller may already have one where ``asyncio.run`` cannot nest. In
    that case the coroutine runs on a dedicated thread with its own loop.
    Callers must ensure the coroutine
    performs no thread-bound IO (e.g. SQLite handles created on the main
    thread); the judge coroutines are LLM-only after prompt pre-build.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def run_llm_judge(
    pairs_to_judge: list[CandidatePair],
    store: KnowledgeStore,
    batch_size: int = 5,
    max_budget: int = 500,
    concurrency: int = 20,
) -> list[CandidatePair]:
    """Use LLM to judge ambiguous pairs.

    Batches are dispatched CONCURRENTLY (async acompletion + gather, bounded by
    a semaphore) rather than one blocking call at a time.

    Args:
        pairs_to_judge: Pairs with decision="judge"
        store: KnowledgeStore for fetching example messages
        batch_size: Pairs per LLM call
        max_budget: Maximum total LLM calls
        concurrency: Max concurrent LLM calls in flight
    """
    if not pairs_to_judge:
        return pairs_to_judge

    provider = cfg.services.llm_flash.provider
    api_key = provider_api_key(provider)
    if provider == "anthropic" and not api_key:
        print(
            "  WARNING: No ANTHROPIC_AUTH_TOKEN — skipping LLM judge, treating all as reject"
        )
        for p in pairs_to_judge:
            p.decision = "reject"
            p.confidence = 0.0
        return pairs_to_judge

    # Cap budget
    pairs_to_judge = pairs_to_judge[: max_budget * batch_size]
    print(
        f"  Running LLM judge on {len(pairs_to_judge)} pairs (batch_size={batch_size})..."
    )

    batches = [
        pairs_to_judge[start : start + batch_size]
        for start in range(0, len(pairs_to_judge), batch_size)
    ]
    # Build prompts (the only store reads) synchronously on the caller's thread
    # so the async judge coroutines are LLM-only — that keeps them safe to run
    # on a side thread when we are already inside an event loop (see
    # _run_coro_sync).
    prompts = [_build_judge_prompt(batch, store) for batch in batches]

    async def _run_all() -> int:
        semaphore = asyncio.Semaphore(concurrency)
        results = await asyncio.gather(
            *(
                _judge_batch(batch, prompt, api_key, semaphore)
                for batch, prompt in zip(batches, prompts)
            )
        )
        return sum(results)

    judged = _run_coro_sync(_run_all())

    print(f"  LLM judged {judged} pairs")
    return pairs_to_judge


def _build_judge_prompt(batch: list[CandidatePair], store: KnowledgeStore) -> str:
    """Build the judge prompt for one batch, reading sample context from the store.

    Runs synchronously on the caller's thread so the async judge coroutines
    perform no store IO (see :func:`_run_coro_sync`).
    """
    pair_descriptions = []
    for i, pair in enumerate(batch):
        sample_msgs_a = _get_sample_messages(store, pair.entity_a, limit=2)
        sample_msgs_b = _get_sample_messages(store, pair.entity_b, limit=2)

        desc = f"""Pair {i + 1}:
  Entity A: "{pair.entity_a.name}" (type={pair.entity_a.entity_type}, mentions={pair.entity_a.mention_count})
    Connected to: {pair.entity_a.connected_entities[:3]}
    Sample context: {sample_msgs_a}
  Entity B: "{pair.entity_b.name}" (type={pair.entity_b.entity_type}, mentions={pair.entity_b.mention_count})
    Connected to: {pair.entity_b.connected_entities[:3]}
    Sample context: {sample_msgs_b}
  Signals: pinyin={pair.pinyin_score:.2f}, char_jaccard={pair.char_jaccard:.2f}, embedding={pair.embedding_score:.2f}, structural={pair.structural_score:.2f}, cooccurrence={pair.cooccurrence_score:.2f}"""
        pair_descriptions.append(desc)

    return f"""You are an entity resolution expert. For each pair below, determine if both names refer to the SAME real-world entity (person, system, place, etc.).

Consider:
- Chinese name variants (nicknames, surname only, full name)
- System/product name variants (abbreviations, versions)
- Different transliterations of the same thing

{chr(10).join(pair_descriptions)}

Respond with a JSON array of objects, one per pair:
[{{"pair": 1, "same_entity": true/false, "confidence": 0.0-1.0}}]

Only output the JSON array, nothing else."""


async def _judge_batch(
    batch: list[CandidatePair],
    prompt: str,
    api_key: str | None,
    semaphore: asyncio.Semaphore,
) -> int:
    """Judge a single batch of pairs with one LLM call. Returns count judged.

    Mutates each pair's decision/confidence/llm_verdict in place. On error,
    any still-undecided pairs in the batch are marked reject. The prompt is
    pre-built by :func:`_build_judge_prompt` — this coroutine performs no
    store IO, so it is safe on any thread/loop.
    """
    judged = 0
    try:
        async with semaphore:
            resp = await litellm.acompletion(
                model=provider_model(
                    cfg.services.llm_flash.provider,
                    cfg.services.llm_flash.model,
                ),
                messages=[{"role": "user", "content": prompt}],
                api_base=cfg.services.llm_flash.base_url or "",
                api_key=api_key,
                temperature=0.1,
                max_tokens=1024,
                timeout=60.0,
            )
        content = resp.choices[0].message.content

        # Parse JSON from response
        content = content.strip()
        if content.startswith("```"):
            content = re.sub(r"^```\w*\n?", "", content)
            content = re.sub(r"\n?```$", "", content)

        verdicts = json.loads(content)

        for verdict in verdicts:
            idx = verdict.get("pair", 0) - 1
            if 0 <= idx < len(batch):
                pair = batch[idx]
                pair.llm_verdict = verdict
                if verdict.get("same_entity", False):
                    pair.decision = "link"
                    pair.confidence = verdict.get("confidence", 0.7)
                else:
                    pair.decision = "reject"
                    pair.confidence = 0.0
                judged += 1

    except Exception as e:  # noqa: BLE001
        print(f"  LLM judge error: {e}")
        # Mark remaining as reject on error
        for pair in batch:
            if pair.decision == "judge":
                pair.decision = "reject"
                pair.confidence = 0.0

    return judged


def _get_sample_messages(
    store: KnowledgeStore, entity: EntityInfo, limit: int = 2
) -> list[str]:
    """Get sample message snippets for an entity."""
    if not entity.message_ids:
        return []

    sample_ids = list(entity.message_ids)[: limit * 3]
    placeholders = ",".join("?" * len(sample_ids))
    rows = store.sql_conn.execute(
        f"SELECT content FROM chunks WHERE id IN ({placeholders}) LIMIT ?",
        sample_ids + [limit],
    ).fetchall()

    snippets = []
    for r in rows:
        text = r[0][:100] if r[0] else ""
        snippets.append(text)
    return snippets


def create_disambiguation_edges(
    pairs: list[CandidatePair],
    store: KnowledgeStore,
) -> int:
    """Create ENTITY_SIMILAR edges for linked entity pairs.

    Instead of merging entities, we create weighted ENTITY_SIMILAR edges with
    confidence scores and source metadata. Resolution happens at query time.

    Returns: number of edges created
    """
    link_pairs = [p for p in pairs if p.decision == "link"]
    if not link_pairs:
        print("  No pairs to link.")
        return 0

    print(f"  Creating {len(link_pairs)} disambiguation ENTITY_SIMILAR edges...")

    # Rewrite disambiguation edges through the backend-agnostic edge API so this
    # works on both SQLite and LadybugDB. First drop the previous run's
    # disambiguation edges (matched by their ``source`` property), then upsert:
    # if entity_similarity already emitted an ENTITY_SIMILAR edge for the pair we
    # replace it (delete + insert) so the richer disambiguation properties win.
    store.delete_edges(
        edge_type=EdgeType.ENTITY_SIMILAR.value,
        where_properties={"source": "disambiguation"},
    )

    # Existing ENTITY_SIMILAR endpoint pairs (any source), so we can replace an
    # edge emitted by the similarity phase instead of duplicating it.
    existing_pairs = {
        (src, tgt)
        for src, tgt, _props in store.scan_edges_by_type(
            [EdgeType.ENTITY_SIMILAR.value],
            source_type="entity",
            target_type="entity",
        )
    }

    edges_created = 0
    for pair in link_pairs:
        # Consistent ordering: alphabetical by ID
        id_a, id_b = sorted([pair.entity_a.id, pair.entity_b.id])
        properties = {
            "source": "disambiguation",
            "confidence": round(pair.confidence, 3),
            "hybrid_score": round(pair.hybrid_score, 3),
            "pinyin_score": round(pair.pinyin_score, 3),
            "char_jaccard": round(pair.char_jaccard, 3),
            "embedding_score": round(pair.embedding_score, 3),
            "structural_score": round(pair.structural_score, 3),
            "cooccurrence_score": round(pair.cooccurrence_score, 3),
            "llm_judged": bool(pair.llm_verdict),
        }
        # Replace an existing same-pair edge so disambiguation properties win
        # (delete-then-insert is the upsert the KnowledgeStore API exposes).
        if (id_a, id_b) in existing_pairs:
            store.delete_edges(
                source_id=id_a,
                target_id=id_b,
                edge_type=EdgeType.ENTITY_SIMILAR.value,
            )
        store.insert_edges(
            [
                Edge(
                    source_type="entity",
                    source_id=id_a,
                    target_type="entity",
                    target_id=id_b,
                    edge_type=EdgeType.ENTITY_SIMILAR,
                    properties=properties,
                )
            ]
        )
        edges_created += 1

    print(f"  Created/updated {edges_created} disambiguation edges")

    # Print top pairs
    link_pairs.sort(key=lambda p: -p.confidence)
    print("  Top disambiguation links:")
    for p in link_pairs[:15]:
        source = (
            "LLM" if p.llm_verdict else ("punct" if p.confidence >= 0.99 else "auto")
        )
        print(
            f'    "{p.entity_a.name}" ↔ "{p.entity_b.name}" '
            f"(conf={p.confidence:.3f}, source={source})"
        )

    return edges_created


def load_embedding_vectors(qdrant: VectorStore) -> dict[str, np.ndarray]:
    """Load all entity embedding vectors from the vector store."""
    print("  Loading entity embeddings from vector store...")
    all_points = list(qdrant.scroll_all("entities"))

    vectors = {}
    for p in all_points:
        eid = p.payload.get("entity_id")
        if eid and p.vector:
            vectors[eid] = np.array(p.vector, dtype=np.float32)

    print(f"  Loaded {len(vectors)} entity vectors")
    return vectors


def run_entity_disambiguation(
    store: KnowledgeStore,
    qdrant: VectorStore,
    # Blocking thresholds
    pinyin_threshold: float = 0.8,
    char_overlap_threshold: float = 0.3,
    embedding_threshold: float = 0.82,
    structural_threshold: float = 0.3,
    # Scoring weights
    weight_pinyin: float = 0.25,
    weight_char: float = 0.20,
    weight_embedding: float = 0.15,
    weight_structural: float = 0.25,
    weight_cooccurrence: float = 0.15,
    # Decision thresholds
    link_threshold: float = 0.7,
    reject_threshold: float = 0.3,
    # LLM budget
    llm_batch_size: int = 5,
    llm_max_budget: int = 500,
    # Skip LLM entirely (for testing)
    skip_llm: bool = False,
) -> int:
    """Run the full entity disambiguation pipeline.

    Produces ENTITY_SIMILAR edges with confidence scores between likely-same entities.
    NO hard merges — resolution happens at query time via edge traversal.

    Returns: number of ENTITY_SIMILAR edges created.
    """
    print("\n" + "=" * 60)
    print("ENTITY DISAMBIGUATION")
    print("=" * 60)

    # Step 1: Load entity info
    entities = load_entity_info(store)

    # Step 2: Load embeddings
    embedding_vectors = load_embedding_vectors(qdrant)

    # Step 3: Generate candidates
    candidates = generate_candidates(
        entities,
        embedding_vectors,
        pinyin_threshold=pinyin_threshold,
        char_overlap_threshold=char_overlap_threshold,
        embedding_threshold=embedding_threshold,
        structural_threshold=structural_threshold,
    )

    if not candidates:
        print("  No candidates found. Skipping disambiguation.")
        return 0

    # Step 4: Score candidates
    scored = score_candidates(
        candidates,
        entities,
        embedding_vectors,
        weight_pinyin=weight_pinyin,
        weight_char=weight_char,
        weight_embedding=weight_embedding,
        weight_structural=weight_structural,
        weight_cooccurrence=weight_cooccurrence,
    )

    # Override thresholds if custom
    for p in scored:
        # Skip if already decided by punctuation rule
        if p.decision == "link" and p.confidence >= 0.99:
            continue
        if p.hybrid_score >= link_threshold:
            p.decision = "link"
            p.confidence = p.hybrid_score
        elif p.hybrid_score < reject_threshold:
            p.decision = "reject"
            p.confidence = 0.0
        else:
            p.decision = "judge"
            p.confidence = p.hybrid_score

    n_link = sum(1 for p in scored if p.decision == "link")
    n_judge = sum(1 for p in scored if p.decision == "judge")
    n_reject = sum(1 for p in scored if p.decision == "reject")
    print(f"  After thresholds: {n_link} link, {n_judge} judge, {n_reject} reject")

    # Print top auto-link pairs
    link_pairs = [p for p in scored if p.decision == "link"]
    if link_pairs:
        print("  Top auto-link pairs:")
        for p in link_pairs[:10]:
            print(
                f'    "{p.entity_a.name}" ↔ "{p.entity_b.name}" '
                f"(conf={p.confidence:.3f}, py={p.pinyin_score:.2f}, "
                f"struct={p.structural_score:.2f})"
            )

    # Step 5: LLM judge for ambiguous pairs
    judge_pairs = [p for p in scored if p.decision == "judge"]
    if judge_pairs and not skip_llm:
        judge_pairs = run_llm_judge(
            judge_pairs,
            store,
            batch_size=llm_batch_size,
            max_budget=llm_max_budget,
        )

        # Report LLM results
        llm_links = sum(1 for p in judge_pairs if p.decision == "link")
        llm_rejects = sum(1 for p in judge_pairs if p.decision == "reject")
        print(f"  LLM judge results: {llm_links} link, {llm_rejects} reject")

        if llm_links > 0:
            print("  LLM-approved links:")
            for p in judge_pairs:
                if p.decision == "link":
                    print(
                        f'    "{p.entity_a.name}" ↔ "{p.entity_b.name}" '
                        f"(conf={p.confidence:.3f})"
                    )
    elif judge_pairs and skip_llm:
        print(f"  Skipping LLM judge ({len(judge_pairs)} pairs) — skip_llm=True")
        for p in judge_pairs:
            p.decision = "reject"
            p.confidence = 0.0

    # Step 6: Create ENTITY_SIMILAR edges (NOT merges)
    n_edges = create_disambiguation_edges(scored, store)

    print(f"\n  Disambiguation complete: {n_edges} ENTITY_SIMILAR edges created")
    print("=" * 60)

    return n_edges
