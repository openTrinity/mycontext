"""Immutable, copy-on-write adjacency mapping for the retrieval server.

The graph store is authoritative.  This mapping is only a serving index: full
startup builds populate it from every edge, while normal ingestion replaces the
buckets for nodes whose incident edges changed.  Sharding keeps a small update
from copying the whole top-level mapping and publishing a new object gives
readers a stable snapshot without locks.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence

AdjacencyEntry = tuple[str, str, str, str]
AdjacencyBucket = tuple[AdjacencyEntry, ...]

_SHARD_COUNT = 256
_SHARD_MASK = _SHARD_COUNT - 1


def _freeze_bucket(entries: Sequence[AdjacencyEntry]) -> AdjacencyBucket:
    """Deduplicate and deterministically order one node's neighbor entries."""

    return tuple(sorted(set(entries)))


class AdjacencyIndex(Mapping[str, AdjacencyBucket]):
    """Read-only sharded adjacency map with copy-on-write bucket replacement."""

    __slots__ = ("_shards", "_size")

    def __init__(
        self,
        shards: tuple[dict[str, AdjacencyBucket], ...] | None = None,
        size: int = 0,
    ) -> None:
        self._shards = shards or tuple({} for _ in range(_SHARD_COUNT))
        self._size = size

    @classmethod
    def from_mapping(
        cls, buckets: Mapping[str, Sequence[AdjacencyEntry]]
    ) -> AdjacencyIndex:
        """Create an index from mutable buckets produced by a full edge scan."""

        shards: list[dict[str, AdjacencyBucket]] = [{} for _ in range(_SHARD_COUNT)]
        size = 0
        for node_id, entries in buckets.items():
            bucket = _freeze_bucket(entries)
            if not bucket:
                continue
            shards[hash(node_id) & _SHARD_MASK][node_id] = bucket
            size += 1
        return cls(tuple(shards), size)

    def replace_buckets(
        self, replacements: Mapping[str, Sequence[AdjacencyEntry]]
    ) -> AdjacencyIndex:
        """Return a new index with only the supplied node buckets replaced.

        Empty replacement buckets remove their key.  Only shards containing a
        replacement are copied; all other shard dictionaries are shared safely
        because neither this class nor its callers mutate published buckets.
        """

        if not replacements:
            return self

        by_shard: dict[int, list[tuple[str, AdjacencyBucket]]] = {}
        for node_id, entries in replacements.items():
            by_shard.setdefault(hash(node_id) & _SHARD_MASK, []).append(
                (node_id, _freeze_bucket(entries))
            )

        shards = list(self._shards)
        size = self._size
        changed = False
        for shard_index, updates in by_shard.items():
            old_shard = self._shards[shard_index]
            new_shard = old_shard.copy()
            shard_changed = False
            for node_id, bucket in updates:
                previous = old_shard.get(node_id)
                if bucket:
                    if previous != bucket:
                        new_shard[node_id] = bucket
                        if previous is None:
                            size += 1
                        shard_changed = True
                elif previous is not None:
                    new_shard.pop(node_id, None)
                    size -= 1
                    shard_changed = True
            if shard_changed:
                shards[shard_index] = new_shard
                changed = True

        return AdjacencyIndex(tuple(shards), size) if changed else self

    def __getitem__(self, node_id: str) -> AdjacencyBucket:
        return self._shards[hash(node_id) & _SHARD_MASK][node_id]

    def __iter__(self) -> Iterator[str]:
        for shard in self._shards:
            yield from shard

    def __len__(self) -> int:
        return self._size
