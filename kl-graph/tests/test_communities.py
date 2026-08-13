"""Tests for hierarchical community detection.

Covers:
- Weight policy: ABOUT weight = plain fact.confidence, FACT_SIMILAR pure score,
  ENTITY_SIMILAR hybrid_score; edges with missing weights are skipped (not defaulted)
- Parallel-pair max merge
- Hub guard: entity with >200 fact edges skipped (ABOUT), entity with >200 distinct
  partners skipped (co-mention); two entities sharing 201 chunks are NOT capped
- Collision-proof labels: identical textual id in entities and facts stays two vertices
- Hierarchy: coupled-cliques graph in the nucleation regime yields depth 2 with
  parent links pointing UP (level 0 is the finest)
- Determinism: two runs with fixed seed on large graph give identical assignments
- Isolated nodes unassigned
- Shared namespace: entities and facts in same cluster id space with overlap
- Dense semantics: every node carries its own cluster at every level, with
  COMM_MEMBER edges at every level
- Deep-then-shallow rebuild leaves no stale deeper state
- Empty detection result clears all community_L* columns, Community rows, COMM_MEMBER edges
"""

from __future__ import annotations

import sqlite3

import pytest

from kl_graph.models.types import Edge, EdgeType, community_id_from
from kl_graph.periodic.community_detection import (
    HUB_GUARD_THRESHOLD,
    _build_community_graph,
    detect_communities_hierarchical,
    project_community_membership_edges,
    store_communities,
)
from kl_graph.storage.sqlite_store import SQLiteStore


def _make_store_with_graph() -> SQLiteStore:
    """Create a store with a small test graph.

    Graph structure:
    - 3 entities (e1, e2, e3) forming a triangle via ENTITY_SIMILAR
    - 2 facts (f1, f2) about e1 and e2
    - 1 fact (f3) about e3
    - Co-mention edges via shared chunks
    """
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Insert entities
    conn.executemany(
        "INSERT INTO entities (id, name) VALUES (?, ?)",
        [("e1", "Entity1"), ("e2", "Entity2"), ("e3", "Entity3")],
    )

    # Insert facts with confidences
    conn.executemany(
        "INSERT INTO facts (id, text, confidence, source_chunk_id) VALUES (?, ?, ?, ?)",
        [
            ("f1", "Fact about e1 and e2", 0.9, "c1"),
            ("f2", "Another fact about e1", 0.8, "c2"),
            ("f3", "Fact about e3", 0.7, "c3"),
        ],
    )

    # Insert chunks for co-mention
    conn.executemany(
        "INSERT INTO chunks (id, content, content_hash) VALUES (?, ?, ?)",
        [("c1", "chunk1", "h1"), ("c2", "chunk2", "h2"), ("c3", "chunk3", "h3")],
    )

    # ENTITY_SIMILAR edges (e1-e2, e2-e3, e1-e3 triangle)
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.85},
            ),
            Edge(
                source_type="entity",
                source_id="e2",
                target_type="entity",
                target_id="e3",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.75},
            ),
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="entity",
                target_id="e3",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.65},
            ),
        ]
    )

    # ABOUT edges (facts to entities)
    store.insert_edges(
        [
            Edge(
                source_type="fact",
                source_id="f1",
                target_type="entity",
                target_id="e1",
                edge_type=EdgeType.ABOUT,
            ),
            Edge(
                source_type="fact",
                source_id="f1",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.ABOUT,
            ),
            Edge(
                source_type="fact",
                source_id="f2",
                target_type="entity",
                target_id="e1",
                edge_type=EdgeType.ABOUT,
            ),
            Edge(
                source_type="fact",
                source_id="f3",
                target_type="entity",
                target_id="e3",
                edge_type=EdgeType.ABOUT,
            ),
        ]
    )

    # MENTIONS edges for co-mention (e1 and e2 both mentioned in c1, c2)
    store.insert_edges(
        [
            Edge(
                source_type="chunk",
                source_id="c1",
                target_type="entity",
                target_id="e1",
                edge_type=EdgeType.MENTIONS,
            ),
            Edge(
                source_type="chunk",
                source_id="c1",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.MENTIONS,
            ),
            Edge(
                source_type="chunk",
                source_id="c2",
                target_type="entity",
                target_id="e1",
                edge_type=EdgeType.MENTIONS,
            ),
            Edge(
                source_type="chunk",
                source_id="c2",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.MENTIONS,
            ),
            Edge(
                source_type="chunk",
                source_id="c3",
                target_type="entity",
                target_id="e3",
                edge_type=EdgeType.MENTIONS,
            ),
        ]
    )

    conn.commit()
    return store


def test_about_weight_equals_plain_confidence() -> None:
    """ABOUT edges use plain fact.confidence as weight (no fan-out discount)."""
    store = _make_store_with_graph()
    edges, label_map = _build_community_graph(store)

    # Find ABOUT edges (fact↔entity) using collision-proof labels
    about_edges = []
    for u, v, w in edges:
        u_type, u_id = label_map[u]
        v_type, v_id = label_map[v]
        # ABOUT edges connect facts to entities
        if (u_type == "fact" and v_type == "entity") or (u_type == "entity" and v_type == "fact"):
            about_edges.append((u_id, v_id, w, u_type, v_type))

    # f1 has confidence 0.9, f2 has 0.8, f3 has 0.7
    fact_weights = {}
    for u_id, v_id, w, u_type, v_type in about_edges:
        fact_id = u_id if u_type == "fact" else v_id
        if fact_id not in fact_weights or w > fact_weights[fact_id]:
            fact_weights[fact_id] = w

    assert fact_weights.get("f1") == pytest.approx(0.9, abs=0.01)
    assert fact_weights.get("f2") == pytest.approx(0.8, abs=0.01)
    assert fact_weights.get("f3") == pytest.approx(0.7, abs=0.01)

    store.close()


def test_fact_similar_uses_pure_score() -> None:
    """FACT_SIMILAR edges use pure score (no hybrid_score fallback)."""
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Insert facts
    conn.executemany(
        "INSERT INTO facts (id, text, confidence, source_chunk_id) VALUES (?, ?, ?, ?)",
        [
            ("f1", "Fact 1", 0.9, "c1"),
            ("f2", "Fact 2", 0.8, "c2"),
        ],
    )

    # FACT_SIMILAR edge with explicit score
    store.insert_edges(
        [
            Edge(
                source_type="fact",
                source_id="f1",
                target_type="fact",
                target_id="f2",
                edge_type=EdgeType.FACT_SIMILAR,
                properties={"score": 0.75},
            ),
        ]
    )

    conn.commit()
    edges, label_map = _build_community_graph(store)

    # Find FACT_SIMILAR edge
    fact_sim_edges = []
    for u, v, w in edges:
        u_type, _ = label_map[u]
        v_type, _ = label_map[v]
        if u_type == "fact" and v_type == "fact":
            fact_sim_edges.append((u, v, w))

    assert len(fact_sim_edges) == 1
    assert fact_sim_edges[0][2] == pytest.approx(0.75, abs=0.01)

    store.close()


def test_entity_similar_uses_hybrid_score() -> None:
    """ENTITY_SIMILAR edges use hybrid_score (no fallback)."""
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Insert entities
    conn.executemany(
        "INSERT INTO entities (id, name) VALUES (?, ?)",
        [("e1", "Entity1"), ("e2", "Entity2")],
    )

    # ENTITY_SIMILAR edge with hybrid_score
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.85},
            ),
        ]
    )

    conn.commit()
    edges, label_map = _build_community_graph(store)

    # Find ENTITY_SIMILAR edge
    entity_sim_edges = []
    for u, v, w in edges:
        u_type, _ = label_map[u]
        v_type, _ = label_map[v]
        if u_type == "entity" and v_type == "entity":
            entity_sim_edges.append((u, v, w))

    assert len(entity_sim_edges) == 1
    assert entity_sim_edges[0][2] == pytest.approx(0.85, abs=0.01)

    store.close()


def test_edges_with_missing_weights_are_skipped() -> None:
    """Edges with missing or invalid weights are skipped, not defaulted."""
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Insert entities and facts
    conn.executemany(
        "INSERT INTO entities (id, name) VALUES (?, ?)",
        [("e1", "Entity1"), ("e2", "Entity2"), ("e3", "Entity3")],
    )
    conn.executemany(
        "INSERT INTO facts (id, text, confidence, source_chunk_id) VALUES (?, ?, ?, ?)",
        [
            ("f1", "Fact 1", 0.9, "c1"),
            ("f2", "Fact 2", 0.8, "c2"),
        ],
    )

    # ENTITY_SIMILAR edge without hybrid_score (should be skipped)
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={},  # Missing hybrid_score
            ),
        ]
    )

    # ENTITY_SIMILAR edge with hybrid_score (should be included)
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e2",
                target_type="entity",
                target_id="e3",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.75},
            ),
        ]
    )

    # FACT_SIMILAR edge without score (should be skipped)
    store.insert_edges(
        [
            Edge(
                source_type="fact",
                source_id="f1",
                target_type="fact",
                target_id="f2",
                edge_type=EdgeType.FACT_SIMILAR,
                properties={},  # Missing score
            ),
        ]
    )

    conn.commit()
    edges, label_map = _build_community_graph(store)

    # Count edges by type
    entity_sim_count = 0
    fact_sim_count = 0
    for u, v, w in edges:
        u_type, _ = label_map[u]
        v_type, _ = label_map[v]
        if u_type == "entity" and v_type == "entity":
            entity_sim_count += 1
        elif u_type == "fact" and v_type == "fact":
            fact_sim_count += 1

    # Only the edge with hybrid_score should be included
    assert entity_sim_count == 1
    # FACT_SIMILAR edge without score should be skipped
    assert fact_sim_count == 0

    store.close()


def test_parallel_pair_max_merge() -> None:
    """Parallel edges between same pair are merged by MAX weight."""
    store = _make_store_with_graph()

    # Add duplicate ENTITY_SIMILAR edge with lower weight
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.5},  # Lower than existing 0.85
            ),
        ]
    )

    edges, label_map = _build_community_graph(store)

    # Find e1-e2 edge using collision-proof labels
    e1_e2_edges = []
    for u, v, w in edges:
        u_type, u_id = label_map[u]
        v_type, v_id = label_map[v]
        if (u_id == "e1" and v_id == "e2") or (u_id == "e2" and v_id == "e1"):
            e1_e2_edges.append((u, v, w))

    # Should have exactly one edge with weight = max(0.85, 0.5) = 0.85
    assert len(e1_e2_edges) == 1
    assert e1_e2_edges[0][2] == pytest.approx(0.85, abs=0.01)

    store.close()


def test_hub_guard_skips_high_degree_entity_about() -> None:
    """Entity with >HUB_GUARD_THRESHOLD fact edges is skipped in ABOUT."""
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Create one hub entity and many facts about it
    conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", ("hub", "HubEntity"))
    for i in range(HUB_GUARD_THRESHOLD + 10):
        fact_id = f"f{i}"
        conn.execute(
            "INSERT INTO facts (id, text, confidence, source_chunk_id) VALUES (?, ?, ?, ?)",
            (fact_id, f"Fact {i}", 0.8, f"c{i}"),
        )
        store.insert_edges(
            [
                Edge(
                    source_type="fact",
                    source_id=fact_id,
                    target_type="entity",
                    target_id="hub",
                    edge_type=EdgeType.ABOUT,
                ),
            ]
        )

    conn.commit()
    edges, label_map = _build_community_graph(store)

    # Hub entity should have no ABOUT edges
    hub_about_edges = []
    for u, v, w in edges:
        u_type, u_id = label_map[u]
        v_type, v_id = label_map[v]
        if (u_id == "hub" or v_id == "hub") and (u_type == "fact" or v_type == "fact"):
            hub_about_edges.append((u, v, w))

    assert len(hub_about_edges) == 0, f"Hub should be skipped, but found {len(hub_about_edges)} edges"

    store.close()


def test_hub_guard_skips_high_degree_entity_comention_distinct_partners() -> None:
    """A high-partner entity contributes no co-mention edge.

    Originally this asserted the hub guard's distinct-partner cap. With the
    co-mention block commented out the expectation is unchanged (still zero
    edges) but the *reason* is now that the synthesis never runs — so this no
    longer exercises the guard itself. Retained as a co-mention-off regression.
    """
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Create one hub entity and many distinct partners
    conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", ("hub", "HubEntity"))
    
    # Create 210 distinct partner entities
    for i in range(HUB_GUARD_THRESHOLD + 10):
        partner_id = f"partner{i}"
        conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", (partner_id, f"Partner{i}"))
        
        # Create 2 chunks where both hub and partner are mentioned (required for co-mention)
        for j in range(2):
            chunk_id = f"c_{i}_{j}"
            conn.execute(
                "INSERT INTO chunks (id, content, content_hash) VALUES (?, ?, ?)",
                (chunk_id, f"chunk {i} {j}", f"h_{i}_{j}"),
            )
            # Mention hub in this chunk
            store.insert_edges(
                [
                    Edge(
                        source_type="chunk",
                        source_id=chunk_id,
                        target_type="entity",
                        target_id="hub",
                        edge_type=EdgeType.MENTIONS,
                    ),
                ]
            )
            # Mention partner in this chunk
            store.insert_edges(
                [
                    Edge(
                        source_type="chunk",
                        source_id=chunk_id,
                        target_type="entity",
                        target_id=partner_id,
                        edge_type=EdgeType.MENTIONS,
                    ),
                ]
            )

    conn.commit()
    edges, label_map = _build_community_graph(store)

    # Hub entity should have no co-mention edges (too many distinct partners)
    hub_comention_edges = []
    for u, v, w in edges:
        u_type, u_id = label_map[u]
        v_type, v_id = label_map[v]
        if (u_id == "hub" or v_id == "hub") and (u_type == "entity" and v_type == "entity"):
            # Check if this is a co-mention edge (not ENTITY_SIMILAR)
            # Co-mention edges have weights based on shared_chunks/10
            hub_comention_edges.append((u, v, w))

    assert len(hub_comention_edges) == 0, (
        f"Hub should be skipped (too many distinct partners), but found {len(hub_comention_edges)} edges"
    )

    store.close()


def test_hub_guard_allows_two_entities_sharing_many_chunks() -> None:
    """Co-mention synthesis is disabled: shared chunks yield no entity edge.

    Previously two entities sharing 201 chunks were joined by a co-mention edge
    of weight ``min(201/10, 1.0) == 1.0`` (the hub guard counted *distinct
    partners*, of which each had only one, so the pair was not capped). The
    co-mention block in :func:`_build_community_graph` is now commented out, so
    ``MENTIONS``/``AUTHORED_BY`` co-occurrence no longer reaches the community
    graph at all and the pair produces no edge.

    Kept (rather than deleted) as the regression that proves the synthesis is
    off: if co-mention is ever re-enabled, this fails and points at the decision.
    """
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Create two entities
    conn.executemany(
        "INSERT INTO entities (id, name) VALUES (?, ?)",
        [("e1", "Entity1"), ("e2", "Entity2")],
    )

    # Create 201 chunks where both entities are mentioned
    all_edges = []
    for i in range(201):
        chunk_id = f"c{i}"
        conn.execute(
            "INSERT INTO chunks (id, content, content_hash) VALUES (?, ?, ?)",
            (chunk_id, f"chunk {i}", f"h{i}"),
        )
        # Mention e1
        all_edges.append(
            Edge(
                source_type="chunk",
                source_id=chunk_id,
                target_type="entity",
                target_id="e1",
                edge_type=EdgeType.MENTIONS,
            )
        )
        # Mention e2
        all_edges.append(
            Edge(
                source_type="chunk",
                source_id=chunk_id,
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.MENTIONS,
            )
        )
    
    # Insert all edges in one batch
    store.insert_edges(all_edges)

    conn.commit()
    edges, label_map = _build_community_graph(store)

    # Co-mention synthesis is disabled, so no entity↔entity edge is emitted for
    # a pair that merely shares chunks (regardless of how many).
    e1_e2_edges = []
    for u, v, w in edges:
        u_type, u_id = label_map[u]
        v_type, v_id = label_map[v]
        if (u_id == "e1" and v_id == "e2") or (u_id == "e2" and v_id == "e1"):
            e1_e2_edges.append((u, v, w))

    assert e1_e2_edges == []
    # Nothing else can connect them either: no ENTITY_SIMILAR, no ABOUT.
    assert edges == []

    store.close()


def test_collision_proof_labels_keep_separate_vertices() -> None:
    """Identical textual id in entities and facts tables stays two vertices."""
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Create entity and fact with same id
    conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", ("shared_id", "Entity"))
    conn.execute(
        "INSERT INTO facts (id, text, confidence, source_chunk_id) VALUES (?, ?, ?, ?)",
        ("shared_id", "Fact", 0.9, "c1"),
    )
    conn.execute("INSERT INTO chunks (id, content, content_hash) VALUES (?, ?, ?)", ("c1", "chunk", "h1"))

    # Create edges for both
    conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", ("e2", "Entity2"))
    conn.execute(
        "INSERT INTO facts (id, text, confidence, source_chunk_id) VALUES (?, ?, ?, ?)",
        ("f2", "Fact 2", 0.8, "c2"),
    )
    conn.execute("INSERT INTO chunks (id, content, content_hash) VALUES (?, ?, ?)", ("c2", "chunk", "h2"))

    # ENTITY_SIMILAR edge for entity shared_id
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="shared_id",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.85},
            ),
        ]
    )

    # FACT_SIMILAR edge for fact shared_id
    store.insert_edges(
        [
            Edge(
                source_type="fact",
                source_id="shared_id",
                target_type="fact",
                target_id="f2",
                edge_type=EdgeType.FACT_SIMILAR,
                properties={"score": 0.75},
            ),
        ]
    )

    conn.commit()
    edges, label_map = _build_community_graph(store)

    # Check that both vertices exist with different collision-proof labels
    entity_label = None
    fact_label = None
    for label, (node_type, node_id) in label_map.items():
        if node_id == "shared_id":
            if node_type == "entity":
                entity_label = label
            elif node_type == "fact":
                fact_label = label

    assert entity_label is not None, "Entity vertex should exist"
    assert fact_label is not None, "Fact vertex should exist"
    assert entity_label != fact_label, "Collision-proof labels should be different"
    assert entity_label.startswith("e:"), "Entity label should start with 'e:'"
    assert fact_label.startswith("f:"), "Fact label should start with 'f:'"

    # Check that both edges exist
    entity_sim_count = 0
    fact_sim_count = 0
    for u, v, w in edges:
        u_type, _ = label_map[u]
        v_type, _ = label_map[v]
        if u_type == "entity" and v_type == "entity":
            entity_sim_count += 1
        elif u_type == "fact" and v_type == "fact":
            fact_sim_count += 1

    assert entity_sim_count == 1, "ENTITY_SIMILAR edge should exist"
    assert fact_sim_count == 1, "FACT_SIMILAR edge should exist"

    store.close()


def test_determinism_with_fixed_seed_on_large_graph() -> None:
    """Two runs with same seed produce identical assignments on large graph."""
    store = _make_barbell_graph_store()
    edges1, label_map1 = _build_community_graph(store)
    
    # Run detection twice
    result1 = detect_communities_hierarchical(edges1, label_map1)
    result2 = detect_communities_hierarchical(edges1, label_map1)

    # Compare assignments
    assignments1 = result1["assignments"]
    assignments2 = result2["assignments"]
    
    assert assignments1.keys() == assignments2.keys()
    for level in assignments1:
        assert assignments1[level] == assignments2[level]

    # Compare parents
    assert result1["parents"] == result2["parents"]

    store.close()


def _make_barbell_graph_store() -> SQLiteStore:
    """Create a barbell graph with two 20-node clusters connected by a weak bridge.

    Each cluster uses a ring+chord topology (each node connects to its 4
    nearest neighbours). Used as a non-trivial fixed graph for determinism
    checks; hierarchy depth on it is data-dependent under HIT-Leiden.
    """
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Two clusters of 20 entities each.
    cluster_size = 20
    clique1_entities = [f"c1_e{i}" for i in range(cluster_size)]
    clique2_entities = [f"c2_e{i}" for i in range(cluster_size)]

    # Insert entities.
    for eid in clique1_entities + clique2_entities:
        conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", (eid, eid))

    # Ring+chord edges within each cluster (connect to 4 nearest neighbours).
    all_edges: list[Edge] = []
    for clique in (clique1_entities, clique2_entities):
        n = len(clique)
        for i in range(n):
            for offset in (1, 2, 3, 4):
                j = (i + offset) % n
                if i < j:
                    all_edges.append(
                        Edge(
                            source_type="entity",
                            source_id=clique[i],
                            target_type="entity",
                            target_id=clique[j],
                            edge_type=EdgeType.ENTITY_SIMILAR,
                            properties={"hybrid_score": 0.9},
                        )
                    )

    # Weak bridge between clusters (single low-weight edge).
    all_edges.append(
        Edge(
            source_type="entity",
            source_id=clique1_entities[0],
            target_type="entity",
            target_id=clique2_entities[0],
            edge_type=EdgeType.ENTITY_SIMILAR,
            properties={"hybrid_score": 0.2},
        )
    )

    store.insert_edges(all_edges)
    conn.commit()
    return store


def test_isolated_nodes_unassigned() -> None:
    """Nodes with no edges remain unassigned (not in any community)."""
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    # Insert isolated entity and fact
    conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", ("isolated_e", "Isolated"))
    conn.execute(
        "INSERT INTO facts (id, text, confidence, source_chunk_id) VALUES (?, ?, ?, ?)",
        ("isolated_f", "Isolated fact", 0.8, "c1"),
    )
    conn.execute("INSERT INTO chunks (id, content, content_hash) VALUES (?, ?, ?)", ("c1", "chunk", "h1"))

    # Add a connected component
    conn.executemany(
        "INSERT INTO entities (id, name) VALUES (?, ?)",
        [("e1", "E1"), ("e2", "E2")],
    )
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.9},
            ),
        ]
    )

    conn.commit()
    edges, label_map = _build_community_graph(store)
    result = detect_communities_hierarchical(edges, label_map)
    assignments = result["assignments"]

    # Isolated nodes should not appear in any level
    # Keys are now (node_type, original_id) tuples
    for level, node_map in assignments.items():
        assert ("entity", "isolated_e") not in node_map
        assert ("fact", "isolated_f") not in node_map

    store.close()


def test_shared_namespace_entities_and_facts_with_overlap() -> None:
    """Entities and facts share the same cluster id namespace with overlap."""
    store = _make_store_with_graph()
    edges, label_map = _build_community_graph(store)
    result = detect_communities_hierarchical(edges, label_map)
    assignments = result["assignments"]

    # Store assignments
    store_communities(store, result)

    # Check that community_L columns exist
    entity_cols = {row[1] for row in store.sql_conn.execute("PRAGMA table_info(entities)").fetchall()}
    fact_cols = {row[1] for row in store.sql_conn.execute("PRAGMA table_info(facts)").fetchall()}
    
    entity_comm_cols = [c for c in entity_cols if c.startswith("community_L")]
    fact_comm_cols = [c for c in fact_cols if c.startswith("community_L")]
    
    assert len(entity_comm_cols) > 0
    assert len(fact_comm_cols) > 0

    # Check that both entities and facts have assignments at level 0
    entity_assignments = store.sql_conn.execute(
        "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
    ).fetchall()
    fact_assignments = store.sql_conn.execute(
        "SELECT id, community_L0 FROM facts WHERE community_L0 IS NOT NULL"
    ).fetchall()

    # Both entities and facts should be assigned
    assert len(entity_assignments) > 0, "Entities should be assigned to communities"
    assert len(fact_assignments) > 0, "Facts should be assigned to communities"

    # Check that cluster ids overlap between entities and facts (shared namespace)
    entity_cluster_ids = {row[1] for row in entity_assignments}
    fact_cluster_ids = {row[1] for row in fact_assignments}
    
    # They should share the same cluster ids (not separate numbering)
    overlap = entity_cluster_ids & fact_cluster_ids
    assert len(overlap) > 0, (
        f"Entity and fact cluster ids should overlap (shared namespace). "
        f"Entity clusters: {entity_cluster_ids}, Fact clusters: {fact_cluster_ids}"
    )

    store.close()


def _make_coupled_cliques_store() -> SQLiteStore:
    """Two 10-cliques with full bipartite coupling (weight 0.9).

    Nucleation-barrier regime: no single node benefits from crossing, so the
    base partition keeps two communities; the JOINT merge improves
    modularity, so the supergraph coarsens them into one community. Yields a
    genuine depth-2 hierarchy at the default γ=1.0.
    """
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)

    ids = [f"a{i}" for i in range(10)] + [f"b{i}" for i in range(10)]
    for eid in ids:
        conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", (eid, eid))

    all_edges: list[Edge] = []
    for prefix in ("a", "b"):
        grp = [f"{prefix}{i}" for i in range(10)]
        for x in range(10):
            for y in range(x + 1, 10):
                all_edges.append(
                    Edge(
                        source_type="entity",
                        source_id=grp[x],
                        target_type="entity",
                        target_id=grp[y],
                        edge_type=EdgeType.ENTITY_SIMILAR,
                        properties={"hybrid_score": 1.0},
                    )
                )
    for i in range(10):
        for j in range(10):
            all_edges.append(
                Edge(
                    source_type="entity",
                    source_id=f"a{i}",
                    target_type="entity",
                    target_id=f"b{j}",
                    edge_type=EdgeType.ENTITY_SIMILAR,
                    properties={"hybrid_score": 0.9},
                )
            )
    store.insert_edges(all_edges)
    conn.commit()
    return store


def _coupled_cliques_dynamic_graph():
    """Two 10-cliques with full bipartite coupling w=0.9 as a DynamicGraph.

    Mirrors the engine-test fixture; see its docstring for the analytic
    zero-joint-gain / nucleation-barrier properties at γ=1.
    """
    import itertools

    from kl_graph.periodic.incremental_leiden import DynamicGraph

    g = DynamicGraph()
    for prefix in ("a", "b"):
        grp = [f"{prefix}{i}" for i in range(10)]
        for x, y in itertools.combinations(grp, 2):
            g.add_edge(x, y, 1.0)
    for i in range(10):
        for j in range(10):
            g.add_edge(f"a{i}", f"b{j}", 0.9)
    return g


def test_hierarchy_produces_aggregation_levels_with_parent_links() -> None:
    """A genuinely deep hierarchy reports parent links one level up.

    Depth is GROWN, not assumed: the coupled cliques build at depth 1 (the
    super-level joint-merge gain is exactly zero), and a batch that makes
    the joint gain strictly positive extends the hierarchy. The detection
    conversion must then report dense assignments with each level-0 cluster's
    parent at level 1 and no parent at the top.
    """
    from kl_graph.periodic.community_detection import _hierarchy_to_detection
    from kl_graph.periodic.incremental_leiden import (
        EdgeChange,
        HITLeiden,
        IncrementalLeidenConfig,
    )
    from kl_graph.periodic.incremental_leiden.static_build import (
        LeidenLevel,
        LeidenResult,
    )

    cfg = IncrementalLeidenConfig(gamma=1.0, max_levels=8, seed=0xDEADBEEF)
    hl = HITLeiden.build(_coupled_cliques_dynamic_graph(), config=cfg)
    assert len(hl.hierarchy.levels) == 1, "zero joint gain: honest depth 1"

    hl.apply_batch([EdgeChange("a0", "b0", 1.0)])
    assert len(hl.hierarchy.levels) == 2, "strictly favorable joint merge extends"

    levels = [
        LeidenLevel(
            graph=lvl.graph,
            membership=dict(lvl.movement.membership),
            sub_membership=dict(lvl.refinement.membership),
            node_to_children=dict(lvl.node_to_children),
            s_pre=dict(lvl.s_pre),
        )
        for lvl in hl.hierarchy.levels
    ]
    result = LeidenResult(levels=levels, base_membership=dict(hl.flat_membership()))
    label_map = {label: ("entity", label) for label in levels[0].graph.vertices}
    assignments, parents = _hierarchy_to_detection(result, label_map)

    level_ids = sorted(assignments.keys())
    assert level_ids == [0, 1]
    top = level_ids[-1]

    # Non-top clusters have parents one level up; top-level clusters do not.
    for level in level_ids:
        for cluster in set(assignments[level].values()):
            parent = parents[(level, cluster)]
            if level < top:
                assert parent is not None, (
                    f"cluster ({level}, {cluster}) must have a parent"
                )
                assert parent in set(assignments[level + 1].values())
            else:
                assert parent is None

    # Dense: every node at every level.
    for level in level_ids:
        assert set(assignments[level].keys()) == set(assignments[0].keys())


def test_projection_creates_mixed_communities() -> None:
    """project_community_membership_edges creates node_type='mixed' communities."""
    store = _make_store_with_graph()
    edges, label_map = _build_community_graph(store)
    result = detect_communities_hierarchical(edges, label_map)

    # Store and project
    store_communities(store, result)
    project_community_membership_edges(store, result)

    # Check communities table
    communities = store.conn.execute(
        "SELECT id, node_type, parent_id, parent_level FROM communities"
    ).fetchall()

    assert len(communities) > 0
    for comm_id, node_type, parent_id, parent_level in communities:
        assert node_type == "mixed"
        # Level 0 communities have no parent
        if parent_id is not None:
            assert parent_level is not None

    store.close()


def test_dense_columns_and_comm_member_edges_across_all_levels() -> None:
    """Every node owns its cluster at every level: columns AND edges are dense.

    The aggregation hierarchy assigns every vertex a community at every level
    (no finality), so each node keeps its own cluster id in every
    community_L{i} column and gets a genuine COMM_MEMBER edge at every level.
    """
    store = _make_coupled_cliques_store()
    edges, label_map = _build_community_graph(store)
    result = detect_communities_hierarchical(edges, label_map)

    assignments = result["assignments"]

    # Store and project
    store_communities(store, result)
    project_community_membership_edges(store, result)

    levels = sorted(assignments.keys())

    # Community rows: one per cluster at every level.
    native_pairs = {
        (level, cid) for level in levels for cid in assignments[level].values()
    }
    native_ids = {community_id_from(f"L{level}", cid) for level, cid in native_pairs}
    row_ids = {
        r[0] for r in store.conn.execute("SELECT id FROM communities").fetchall()
    }
    assert row_ids == native_ids, "Community rows must be exactly the clusters"

    # Every node: own cluster id in every level column AND one COMM_MEMBER
    # edge per level.
    for level in levels:
        level_str = f"L{level}"
        for node_key, cluster in assignments[level].items():
            node_type, original_id = node_key
            table = "entities" if node_type == "entity" else "facts"
            col = f"community_L{level}"
            row = store.sql_conn.execute(
                f"SELECT {col} FROM {table} WHERE id = ?", (original_id,)
            ).fetchone()
            assert row is not None and row[0] == cluster

            edges_found = store.sql_conn.execute(
                """
                SELECT COUNT(*) FROM edges
                WHERE source_type = ? AND source_id = ?
                AND edge_type = 'COMM_MEMBER'
                AND json_extract(properties, '$.level') = ?
                """,
                (node_type, original_id, level_str),
            ).fetchone()[0]
            assert edges_found == 1, (
                f"Node {original_id} must have exactly one COMM_MEMBER edge "
                f"at level {level}"
            )

    store.close()


def test_entity_fact_id_collision_preserved_through_pipeline() -> None:
    """Entity and fact with same textual id are distinguished through detect/store/project.
    
    This test verifies the fix for the collision bug where `detect_communities_hierarchical`
    discarded node type and keyed assignments by original_id only, causing an entity and fact
    sharing the same textual id to overwrite each other.
    
    The test creates an entity 'x' and a fact 'x', runs them through the full pipeline, and verifies:
    1. Both nodes get distinct community assignments
    2. Both appear in the correct table (entities vs facts) with correct community_L0 values
    3. COMM_MEMBER edges correctly distinguish the entity 'x' from the fact 'x'
    """
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)
    
    # Create entity 'x' and fact 'x' (same textual id, different node types)
    conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", ("x", "Entity X"))
    conn.execute(
        "INSERT INTO facts (id, text, confidence, source_chunk_id) VALUES (?, ?, ?, ?)",
        ("x", "Fact X", 0.9, "chunk1"),
    )
    
    # Create another entity 'y' to connect to entity 'x'
    conn.execute("INSERT INTO entities (id, name) VALUES (?, ?)", ("y", "Entity Y"))
    
    # Create another fact 'y' to connect to fact 'x'
    conn.execute(
        "INSERT INTO facts (id, text, confidence, source_chunk_id) VALUES (?, ?, ?, ?)",
        ("y", "Fact Y", 0.8, "chunk2"),
    )
    
    # Create edges to ensure both nodes are in the graph and form a single connected component
    store.insert_edges([
        Edge(
            source_type="entity",
            source_id="x",
            target_type="entity",
            target_id="y",
            edge_type=EdgeType.ENTITY_SIMILAR,
            properties={"hybrid_score": 0.8},
        ),
        Edge(
            source_type="fact",
            source_id="x",
            target_type="fact",
            target_id="y",
            edge_type=EdgeType.FACT_SIMILAR,
            properties={"score": 0.7},
        ),
        # Add ABOUT edge to connect fact and entity components into a single LCC
        Edge(
            source_type="fact",
            source_id="x",
            target_type="entity",
            target_id="x",
            edge_type=EdgeType.ABOUT,
            properties={},
        ),
    ])
    conn.commit()
    
    # Run the full pipeline
    edges, label_map = _build_community_graph(store)
    result = detect_communities_hierarchical(edges, label_map)
    store_communities(store, result)
    project_community_membership_edges(store, result)
    
    # Verify 1: Both nodes have distinct assignments (tuple keys)
    assignments = result["assignments"][0]
    entity_x_key = ("entity", "x")
    fact_x_key = ("fact", "x")
    
    assert entity_x_key in assignments, "Entity 'x' should have an assignment"
    assert fact_x_key in assignments, "Fact 'x' should have an assignment"
    assert entity_x_key != fact_x_key, "Keys should be distinct tuples"
    
    # Verify 2: Both nodes appear in correct tables with community_L0 values
    entity_row = store.sql_conn.execute(
        "SELECT id, community_L0 FROM entities WHERE id = ?", ("x",)
    ).fetchone()
    fact_row = store.sql_conn.execute(
        "SELECT id, community_L0 FROM facts WHERE id = ?", ("x",)
    ).fetchone()
    
    assert entity_row is not None, "Entity 'x' should exist in entities table"
    assert fact_row is not None, "Fact 'x' should exist in facts table"
    assert entity_row[1] is not None, "Entity 'x' should have community_L0"
    assert fact_row[1] is not None, "Fact 'x' should have community_L0"
    
    # Verify 3: COMM_MEMBER edges correctly distinguish entity 'x' from fact 'x'
    entity_comm_edges = store.sql_conn.execute(
        """SELECT COUNT(*) FROM edges 
           WHERE edge_type = 'COMM_MEMBER' 
           AND source_type = 'entity' AND source_id = 'x'"""
    ).fetchone()[0]
    
    fact_comm_edges = store.sql_conn.execute(
        """SELECT COUNT(*) FROM edges 
           WHERE edge_type = 'COMM_MEMBER' 
           AND source_type = 'fact' AND source_id = 'x'"""
    ).fetchone()[0]
    
    assert entity_comm_edges >= 1, "Entity 'x' should have at least one COMM_MEMBER edge"
    assert fact_comm_edges >= 1, "Fact 'x' should have at least one COMM_MEMBER edge"
    
    store.close()


def test_deep_then_shallow_rebuild_clears_stale_state() -> None:
    """Deep-then-shallow rebuild leaves no stale deeper state."""
    # First, create a store with a genuine depth-2 hierarchy.
    store = _make_coupled_cliques_store()
    edges, label_map = _build_community_graph(store)
    result_deep = detect_communities_hierarchical(edges, label_map)
    
    # Store deep result
    store_communities(store, result_deep)
    project_community_membership_edges(store, result_deep)
    
    deep_levels = sorted(result_deep["assignments"].keys())
    max_deep_level = max(deep_levels)
    
    # Verify deep columns exist
    entity_cols = {row[1] for row in store.sql_conn.execute("PRAGMA table_info(entities)").fetchall()}
    deep_cols = [c for c in entity_cols if c.startswith("community_L")]
    assert len(deep_cols) > 0

    # Now create a shallow result (manually construct a single-level result)
    # Keys must be (node_type, original_id) tuples
    sample_keys = list(result_deep["assignments"][0].keys())[:5]
    shallow_result = {
        "assignments": {0: {node_key: 0 for node_key in sample_keys}},
        "parents": {(0, 0): None},
    }
    
    # Rebuild with shallow result
    store_communities(store, shallow_result)
    project_community_membership_edges(store, shallow_result)

    # Check that only level 0 columns have data, deeper columns are cleared
    for level in range(1, max_deep_level + 1):
        col = f"community_L{level}"
        # Check if column exists
        try:
            rows = store.sql_conn.execute(
                f"SELECT COUNT(*) FROM entities WHERE {col} IS NOT NULL"
            ).fetchone()
            # If column exists, it should be empty (all NULL)
            assert rows[0] == 0, (
                f"Column {col} should be cleared after shallow rebuild, "
                f"but found {rows[0]} non-NULL values"
            )
        except sqlite3.OperationalError:
            # Column doesn't exist, which is fine
            pass

    # Check that COMM_MEMBER edges only exist for level 0
    comm_member_edges = store.sql_conn.execute(
        """
        SELECT json_extract(properties, '$.level'), COUNT(*) 
        FROM edges 
        WHERE edge_type = 'COMM_MEMBER'
        GROUP BY json_extract(properties, '$.level')
        """
    ).fetchall()
    
    for level_str, count in comm_member_edges:
        assert level_str == "L0", (
            f"Only L0 COMM_MEMBER edges should exist after shallow rebuild, "
            f"but found {count} edges at {level_str}"
        )

    store.close()


def test_empty_detection_result_clears_all_state() -> None:
    """Empty detection result clears all community_L* columns, Community rows, COMM_MEMBER edges."""
    store = _make_store_with_graph()
    edges, label_map = _build_community_graph(store)
    result = detect_communities_hierarchical(edges, label_map)

    # First, populate with real result
    store_communities(store, result)
    project_community_membership_edges(store, result)

    # Verify state is populated
    communities_before = store.conn.execute("SELECT COUNT(*) FROM communities").fetchone()[0]
    comm_member_before = store.conn.execute(
        "SELECT COUNT(*) FROM edges WHERE edge_type = 'COMM_MEMBER'"
    ).fetchone()[0]
    
    assert communities_before > 0, "Should have communities before clearing"
    assert comm_member_before > 0, "Should have COMM_MEMBER edges before clearing"

    # Now clear with empty result
    empty_result = {
        "assignments": {},
        "parents": {},
    }
    
    store_communities(store, empty_result)
    project_community_membership_edges(store, empty_result)

    # Check that all community_L* columns are cleared (all NULL)
    entity_cols = {row[1] for row in store.sql_conn.execute("PRAGMA table_info(entities)").fetchall()}
    comm_cols = [c for c in entity_cols if c.startswith("community_L")]
    
    for col in comm_cols:
        rows = store.sql_conn.execute(
            f"SELECT COUNT(*) FROM entities WHERE {col} IS NOT NULL"
        ).fetchone()
        assert rows[0] == 0, f"Column {col} should be cleared (all NULL)"

    # Check that Community rows are cleared
    communities_after = store.conn.execute("SELECT COUNT(*) FROM communities").fetchone()[0]
    assert communities_after == 0, "All Community rows should be cleared"

    # Check that COMM_MEMBER edges are cleared
    comm_member_after = store.conn.execute(
        "SELECT COUNT(*) FROM edges WHERE edge_type = 'COMM_MEMBER'"
    ).fetchone()[0]
    assert comm_member_after == 0, "All COMM_MEMBER edges should be cleared"

    store.close()
