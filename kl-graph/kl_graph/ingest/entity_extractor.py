"""Entity extraction using dictionary matching + patterns (no LLM)."""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import jieba

from kl_graph.models.types import Entity, EntityType

# Pattern for @mentions in DingTalk
AT_PATTERN = re.compile(r"@(\S+)")
# CamelCase / English product names
CAMEL_PATTERN = re.compile(r"\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b")
# Bracketed terms (common in Chinese IM)
BRACKET_PATTERN = re.compile(r"【(.+?)】")
# English acronyms/product names (2+ uppercase)
ACRONYM_PATTERN = re.compile(r"\b([A-Z][A-Z0-9]{1,}(?:\s*[A-Z0-9]+)*)\b")


class EntityExtractor:
    """Dictionary + pattern-based entity extraction (zero LLM)."""

    def __init__(self, entity_dict: dict[str, EntityType] | None = None):
        """
        Args:
            entity_dict: {entity_name: EntityType} mapping for dictionary-based extraction.
        """
        self.entity_dict: dict[str, EntityType] = entity_dict or {}
        self.entity_name_to_id: dict[str, str] = {}  # name → stable uuid

        # Pre-assign IDs for known entities
        for name in self.entity_dict:
            self.entity_name_to_id[name] = str(uuid.uuid5(uuid.NAMESPACE_DNS, name))

        # Load jieba user dict if entity_dict is populated
        if self.entity_dict:
            self._load_jieba_dict()

    def _load_jieba_dict(self):
        """Add entity names to jieba's dictionary for accurate segmentation."""
        for name in self.entity_dict:
            # High frequency ensures the name is kept as a single token
            jieba.suggest_freq(name, tune=True)
            # Also add as user word
            jieba.add_word(name, freq=1000)

    @classmethod
    def from_dict_file(cls, dict_path: Path) -> EntityExtractor:
        """Load from a tab/space-separated file: name type."""
        entity_dict = {}
        if dict_path.exists():
            with open(dict_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split("\t")
                    if len(parts) >= 2:
                        name, etype = parts[0], parts[1]
                    else:
                        parts = line.split()
                        if len(parts) >= 2:
                            name, etype = parts[0], parts[1]
                        else:
                            name, etype = parts[0], "Unknown"
                    try:
                        entity_dict[name] = EntityType(etype)
                    except ValueError:
                        entity_dict[name] = EntityType.UNKNOWN
        return cls(entity_dict)

    @classmethod
    def from_name_type_pairs(cls, pairs: list[tuple[str, str]]) -> EntityExtractor:
        """Create from a list of (name, type_string) tuples."""
        entity_dict = {}
        for name, etype_str in pairs:
            try:
                entity_dict[name] = EntityType(etype_str)
            except ValueError:
                entity_dict[name] = EntityType.UNKNOWN
        return cls(entity_dict)

    def get_or_create_id(self, name: str) -> str:
        """Get stable ID for an entity name (creates if new)."""
        if name not in self.entity_name_to_id:
            self.entity_name_to_id[name] = str(uuid.uuid5(uuid.NAMESPACE_DNS, name))
        return self.entity_name_to_id[name]

    def extract(self, text: str, timestamp: int = 0) -> list[Entity]:
        """Extract entities from text using dictionary + patterns.

        Returns deduplicated list of Entity objects.
        """
        found: dict[str, Entity] = {}  # name → Entity

        # 1. Dictionary matching via jieba segmentation
        words = jieba.cut(text)
        for word in words:
            if word in self.entity_dict:  # noqa: SIM102
                if word not in found:
                    found[word] = Entity(
                        id=self.get_or_create_id(word),
                        name=word,
                        entity_type=self.entity_dict[word],
                        first_seen=timestamp,
                        last_seen=timestamp,
                    )

        # 2. @mention pattern → Person
        for match in AT_PATTERN.finditer(text):
            name = match.group(1)
            if len(name) >= 2 and name not in found:
                found[name] = Entity(
                    id=self.get_or_create_id(name),
                    name=name,
                    entity_type=EntityType.PERSON,
                    first_seen=timestamp,
                    last_seen=timestamp,
                )

        # 3. CamelCase → System/Product
        for match in CAMEL_PATTERN.finditer(text):
            name = match.group(1)
            if name not in found and len(name) >= 4:
                found[name] = Entity(
                    id=self.get_or_create_id(name),
                    name=name,
                    entity_type=EntityType.SYSTEM,
                    first_seen=timestamp,
                    last_seen=timestamp,
                )

        # 4. Bracketed terms → Project
        for match in BRACKET_PATTERN.finditer(text):
            name = match.group(1)
            if name not in found and len(name) >= 2:
                found[name] = Entity(
                    id=self.get_or_create_id(name),
                    name=name,
                    entity_type=EntityType.PROJECT,
                    first_seen=timestamp,
                    last_seen=timestamp,
                )

        return list(found.values())

    def save_dict(self, path: Path):
        """Save current entity dictionary to file."""
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(f"{name}\t{etype.value}\n" for name, etype in sorted(self.entity_dict.items()))

    @property
    def dict_size(self) -> int:
        return len(self.entity_dict)
