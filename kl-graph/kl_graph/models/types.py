"""Core data models for the knowledge graph."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class EdgeType(str, Enum):
    """All typed edge types in the graph."""
    # Category A: Primitive structural
    TEMPORAL = "TEMPORAL"
    REPLY_TO = "REPLY_TO"
    SENT_BY = "SENT_BY"
    IN_CONV = "IN_CONV"
    MENTIONS = "MENTIONS"
    STATES = "STATES"         # Fact → Message (provenance)
    ABOUT = "ABOUT"           # Fact → Entity (subject)
    INVOLVES = "INVOLVES"     # Fact → Entity (participant)

    # Category C: Semantic (periodic batch)
    SIMILAR_TO = "SIMILAR_TO"
    SUPERSEDES = "SUPERSEDES"
    CONFLICTS = "CONFLICTS"

    # Category D: Derived
    BELONGS_TO = "BELONGS_TO"


class EntityType(str, Enum):
    """Entity type classification."""
    PERSON = "Person"
    SYSTEM = "System"
    PROJECT = "Project"
    ORGANIZATION = "Organization"
    LOCATION = "Location"
    DOCUMENT = "Document"
    UNKNOWN = "Unknown"


class FactType(str, Enum):
    """Fact classification by speech act."""
    DECISION = "DECISION"
    DELEGATE = "DELEGATE"
    STATUS = "STATUS"
    CAUSAL = "CAUSAL"
    GENERAL = "GENERAL"


@dataclass(kw_only=True)
class Chunk:
    """A generic retrieval unit.

    Any piece of source content that gets embedded and retrieved: a chat
    message, a PDF page, a document section, etc. Source-specific subtypes
    (e.g. :class:`Message`) add their own typed fields; open-ended per-source
    extras that don't warrant a column live in ``metadata``.
    """
    id: str
    content: str
    source_type: str = "message"           # "message" | "pdf" | "doc" | ...
    timestamp: int = 0                     # unix ms (creation/sent time)
    embedding_id: Optional[str] = None     # qdrant point id
    source_ref: Optional[str] = None       # producer of the content: file name,
                                           # sender, doc id, URL, ... (not the bytes)
    metadata: dict = field(default_factory=dict)  # open-ended per-source extras


@dataclass(kw_only=True)
class Message(Chunk):
    """A DingTalk chat message (a :class:`Chunk` sourced from DingTalk)."""
    conversation_id: str                 # openConversationId
    sender: str                          # display name
    sender_id: Optional[str] = None      # senderOpenDingTalkId
    reply_to: Optional[str] = None       # openMessageId of quoted message
    source_type: str = "message"
    # inherits id (openMessageId), content, timestamp, embedding_id, metadata


@dataclass
class Entity:
    """An extracted entity (person, system, project, etc.)."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    entity_type: EntityType = EntityType.UNKNOWN
    first_seen: int = 0
    last_seen: int = 0
    mention_count: int = 1
    embedding_id: Optional[str] = None


@dataclass
class Fact:
    """A reified claim/event extracted from a message."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    text: str = ""
    fact_type: FactType = FactType.GENERAL
    timestamp: int = 0
    confidence: float = 0.8
    source_message_id: str = ""
    embedding_id: Optional[str] = None


@dataclass
class Edge:
    """A typed structural connection between two nodes."""
    source_type: str         # 'message', 'entity', 'fact'
    source_id: str
    target_type: str
    target_id: str
    edge_type: EdgeType
    properties: Optional[dict] = None
