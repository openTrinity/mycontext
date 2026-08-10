"""Core data models for the knowledge graph."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from enum import Enum


class EdgeType(str, Enum):
    """All typed edge types in the graph."""

    # Category A: Primitive structural
    TEMPORAL = "TEMPORAL"
    REPLY_TO = "REPLY_TO"
    AUTHORED_BY = "AUTHORED_BY"
    PART_OF = "PART_OF"  # Chunk → Scope (source-container membership)
    MENTIONS = "MENTIONS"
    STATES = "STATES"  # Fact → Chunk (provenance)
    ABOUT = "ABOUT"  # Fact → Entity (subject + every participant)

    # Category C: Semantic (periodic batch)
    ENTITY_SIMILAR = "ENTITY_SIMILAR"  # Entity → Entity
    FACT_SIMILAR = "FACT_SIMILAR"  # Fact → Fact
    ENTAILS = "ENTAILS"
    CONTRADICTS = "CONTRADICTS"

    # Category D: Derived
    COMM_MEMBER = "COMM_MEMBER"


class EntityType(str, Enum):
    """Entity type classification."""

    PERSON = "Person"
    SYSTEM = "System"
    PROJECT = "Project"
    ORGANIZATION = "Organization"
    LOCATION = "Location"
    DOCUMENT = "Document"
    EVENT = "Event"
    UNKNOWN = "Unknown"


class FactType(str, Enum):
    """Fact classification by speech act."""

    DECISION = "DECISION"
    DELEGATE = "DELEGATE"
    STATUS = "STATUS"
    CAUSAL = "CAUSAL"
    OPINION = "OPINION"
    GENERAL = "GENERAL"


@dataclass(kw_only=True)
class Chunk:
    """The one and only content unit: any embedded, retrievable piece of source.

    A chat message, a PDF page, a document section — all are Chunks,
    discriminated by ``source_type`` (``graph-design.md``). There is deliberately
    no per-source subclass: source-specific structured fields live in
    ``metadata`` so the graph node vocabulary stays a single ``chunk`` type and
    every structural edge is ``chunk → …``.

    Chat chunks carry their DingTalk-specific fields under these ``metadata``
    keys: ``conversation_id`` (openConversationId), ``sender`` (display name),
    ``sender_id`` (senderOpenDingTalkId) and ``reply_to`` (openMessageId of the
    quoted message). ``id`` is the openMessageId.
    """

    id: str
    content: str
    source_type: str = "message"  # "message" | "pdf" | "doc" | ...
    timestamp: int = 0  # unix ms (creation/sent time)
    embedding_id: str | None = None  # qdrant point id
    source_ref: str | None = None  # producer of the content: file name,
    # sender, doc id, URL, ... (not the bytes)
    metadata: dict = field(default_factory=dict)  # open-ended per-source extras


@dataclass
class SourceUnit:
    """Smallest caller-owned input unit tracked for ingestion deduplication."""

    source_id: str
    source_type: str
    unit_id: str
    content_hash: str
    timestamp: int = 0
    metadata: dict = field(default_factory=dict)


@dataclass
class ChunkUnit:
    """Ordered many-to-many membership between a source unit and a chunk."""

    chunk_id: str
    source_id: str
    source_type: str
    unit_id: str
    unit_ordinal_in_chunk: int
    chunk_ordinal_in_unit: int
    start_offset: int | None = None
    end_offset: int | None = None


@dataclass(kw_only=True)
class ExtractionItem:
    """Ephemeral source-aware LLM target projected by an ingestion plan."""

    id: str
    source_type: str
    content: str
    target_chunk_id: str
    context: str = ""
    source_unit_id: str | None = None
    timestamp: int = 0
    source_ref: str | None = None
    strategy_version: str = "stored-chunk-v1"
    prompt_version: str = "zh-v1"
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True, kw_only=True)
class ExtractionProjection:
    """How one extraction result is attached to a persistent retrieval chunk."""

    extraction_item_id: str
    chunk_id: str
    role: str = "supporting"  # exactly one projection per item is ``primary``
    project_mentions: bool = True
    project_facts: bool = True
    start_offset: int | None = None
    end_offset: int | None = None


@dataclass
class IngestionPlan:
    """Source-strategy output consumed by the generic ingestion pipeline."""

    chunks: list[Chunk] = field(default_factory=list)
    extraction_items: list[ExtractionItem] = field(default_factory=list)
    chunk_units: list[ChunkUnit] = field(default_factory=list)
    projections: list[ExtractionProjection] = field(default_factory=list)
    strategy_version: str = "source-processing-v1"
    schema_version: int = 1

    def validate(self) -> None:
        """Reject dangling or ambiguous projection plans before persistence."""

        chunk_ids = {chunk.id for chunk in self.chunks}
        item_ids = {item.id for item in self.extraction_items}
        if len(chunk_ids) != len(self.chunks):
            raise ValueError("ingestion plan contains duplicate chunk ids")
        if len(item_ids) != len(self.extraction_items):
            raise ValueError("ingestion plan contains duplicate extraction item ids")
        by_item: dict[str, list[ExtractionProjection]] = {}
        for projection in self.projections:
            if projection.extraction_item_id not in item_ids:
                raise ValueError(
                    f"projection references unknown item {projection.extraction_item_id!r}"
                )
            if projection.chunk_id not in chunk_ids:
                raise ValueError(
                    f"projection references unknown chunk {projection.chunk_id!r}"
                )
            by_item.setdefault(projection.extraction_item_id, []).append(projection)
        for item in self.extraction_items:
            projections = by_item.get(item.id, [])
            primaries = [p for p in projections if p.role == "primary"]
            if len(primaries) != 1:
                raise ValueError(
                    f"extraction item {item.id!r} must have exactly one primary projection"
                )
            if item.target_chunk_id != primaries[0].chunk_id:
                raise ValueError(
                    f"extraction item {item.id!r} target does not match its primary projection"
                )


@dataclass(kw_only=True)
class Scope:
    """A source container that chunks belong to (chat conversation, doc, ...).

    One Scope per distinct source-native container: a chat conversation, a wiki
    document, a mail thread, a meeting. Chunks point at it with a ``PART_OF``
    edge, so cross-source grouping goes through one graph structure instead of
    per-source columns. ``metadata`` keeps the source-native identity
    (``source_type`` + ``native_id``) because :func:`scope_id_from` hashes that
    identity into an opaque UUID5.
    """

    id: str
    scope_type: str = ""  # "conversation" | "document" | "thread" | ...
    title: str = ""
    metadata: dict = field(default_factory=dict)


def scope_id_from(source_type: str, native_id: str) -> str:
    """Deterministic Scope id from a source-native container identity.

    Namespaced by ``source_type`` so two sources reusing the same native id
    (e.g. a numeric thread id) cannot collide into one Scope. Deterministic so
    re-ingestion maps the same container onto the same node and ``PART_OF``
    stays idempotent under the edge uniqueness constraint. Lives next to
    :class:`Scope` (not with the pipeline's entity/fact id helpers) so storage
    backends and backfills can derive an id without importing ingestion.

    The hashed name is a canonical JSON array rather than a ``:``-joined string:
    delimiter-joining is ambiguous when a component itself contains the
    delimiter (``("a:b", "c")`` and ``("a", "b:c")`` would hash alike), which
    would break the namespacing guarantee for ids like ``wiki:n1``. JSON quotes
    and escapes each component, so the two-tuple is recoverable from the name
    and distinct pairs always hash distinctly. ``separators``/``ensure_ascii``
    are pinned so the encoding — and therefore the id — is stable across runs
    and Python versions.

    Args:
        source_type: Source discriminator (``Chunk.source_type``, e.g.
            ``"message"``, ``"wiki"``).
        native_id: The source's own container id (conversation id, node id, ...).

    Returns:
        UUID5 string for the scope.
    """
    name = json.dumps(
        ["scope", source_type, native_id], ensure_ascii=True, separators=(",", ":")
    )
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, name))


@dataclass(kw_only=True)
class Community:
    """A detected cluster of entities or facts at one resolution level.

    Reifies what the ``community_L0..L3`` columns on entities/facts describe: the
    columns stay the authoritative, low-churn assignment storage (re-clustering
    rewrites many memberships at once) and Community rows plus ``COMM_MEMBER``
    edges are the derived projection of those columns, never the reverse.

    ``summary``/``tags`` are filled in by the community summarizer, so a freshly
    projected Community starts empty and gets enriched later.

    Example:
        >>> cid = community_id_from("L1", 7)
        >>> c = Community(id=cid, level="L1", node_type="mixed", member_count=12)
        >>> (c.level, c.node_type, c.member_count, c.tags)
        ('L1', 'mixed', 12, [])
    """

    id: str
    level: str = ""  # "L0" | "L1" | "L2" | "L3"
    node_type: str = ""  # "entity" | "fact" | "mixed"
    summary: str = ""
    tags: list[str] = field(default_factory=list)
    member_count: int = 0
    parent_id: str | None = None  # Deterministic id of parent community (None for roots)
    parent_level: int | None = None  # Level integer of parent (None for roots)


def community_id_from(level: str, cluster_id: int | str) -> str:
    """Deterministic Community id from its detection-run identity.

    Namespaced by ``level`` so community 3 at L0 and community 3 at L1 are
    distinct nodes (Leiden numbers clusters from 0 independently per level).
    Deterministic so the delete-and-rebuild ``COMM_MEMBER`` projection re-derives
    the same target ids every run and any summary/vector keyed on the same pair
    lands on the same Community. Mirrors :func:`scope_id_from`, including the
    canonical-JSON hashing rationale (a ``:``-joined string would be ambiguous
    when a component contains the delimiter).

    ``cluster_id`` is normalized to its string form, so the integer read from a
    ``community_L*`` column and its textual spelling map onto one Community.

    Args:
        level: Resolution level (``"L0"``, ``"L1"``, ``"L2"``, etc.).
        cluster_id: Cluster number as stored in the ``community_{level}`` column.

    Returns:
        UUID5 string for the community.
    """
    name = json.dumps(
        ["community", level, str(cluster_id)],
        ensure_ascii=True,
        separators=(",", ":"),
    )
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, name))


@dataclass
class Entity:
    """An extracted entity (person, system, project, etc.)."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    entity_type: EntityType = EntityType.UNKNOWN
    first_seen: int = 0
    last_seen: int = 0
    mention_count: int = 1
    embedding_id: str | None = None
    # Short generalized description, accumulated from every chunk the entity was
    # extracted from: newline-joined ``- <desc>`` bullets, collapsed to one
    # LLM-generalized paragraph once the bullet list grows past the gate. Small
    # by construction, so it stays an in-graph node property next to ``name``.
    description: str = ""
    # Reversible cleanup state. Quarantined entities retain provenance but are
    # excluded from retrieval, embedding, and new graph edges.
    quality_status: str = "active"


@dataclass
class Fact:
    """A reified claim/event extracted from a chunk."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    text: str = ""
    fact_type: FactType = FactType.GENERAL
    timestamp: int = 0
    confidence: float = 0.8
    source_chunk_id: str = ""
    source_unit_id: str | None = None
    extraction_item_id: str | None = None
    embedding_id: str | None = None


@dataclass
class Edge:
    """A typed structural connection between two nodes."""

    source_type: str  # 'chunk', 'entity', 'fact', 'scope', 'community'
    source_id: str
    target_type: str
    target_id: str
    edge_type: EdgeType
    properties: dict | None = None
