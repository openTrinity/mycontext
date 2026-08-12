"""Stable community identity and lineage across detection runs.

``graspologic_native.hierarchical_leiden`` returns integer ``cluster_id`` values
that are per-run positional labels: they are renumbered whenever the graph, the
input order, or the algorithm's internal state changes. ``community_id_from``
(``kl_graph/models/types.py``) is deterministic *for a fixed ``(level,
cluster_id)`` pair*, so it is emphatically **not** a semantic identity across
runs. Both downstream features (incremental detection, gated re-summarization)
need to know that "this community" is the *same* community across successive
updates so a cumulative baseline can be tracked.

This module builds that stable-identity layer. Given the current partition
(native ``(level, cluster_id) -> member set``) and the last persisted partition,
it reconciles them by **member-set overlap** (symmetric Jaccard plus the two
directional inclusion ratios, following Greene et al. 2010, Palla et al. 2007,
and Bródka et al. 2013), assigns/retains a stable ``community_uuid`` per lineage,
and records auditable lineage events (continue / grow / shrink / split / merge /
birth / death).

Design invariants (see ``docs/todo/stable-community-identity.md``):

* The Leiden integer is an ephemeral label, never the cross-run key. Identity is
  a persisted UUID reconciled by overlap.
* Continuation is a **global maximum-weight one-to-one** assignment. A greedy
  "best overlap per new cluster" can silently fan one predecessor into several
  successors; that is corruption. One old UUID continues into at most one
  successor.
* A sorted member-set hash is a *version fingerprint* only — a one-member change
  breaks the hash, but identity must survive membership drift.
* Split / merge **retire all** predecessor UUIDs and **mint fresh** UUIDs for
  every product (each product is a ``birth``), recording full lineage
  (``split_from`` / ``merged_into``) for audit. There is no largest-overlap
  inheritance.
* Reconciliation runs independently **per hierarchy level**.
* Persistence is **idempotent by ``run_id``**: re-running ``reconcile`` for the
  same run overwrites that run's rows rather than appending, so a crashed and
  retried run leaves no partial residue.

The module owns all of its own persistence (lazy ``CREATE TABLE IF NOT EXISTS``),
mirroring how ``community_detection.py`` and ``community_summarizer.py`` own
theirs; it never writes ``kl_graph/storage/sqlite_store.py``.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

# Namespace for deterministic-but-unique UUID minting. A fresh community UUID is
# a UUID5 over this namespace plus the run_id, level, cluster_id, and a sorted
# member fingerprint, so mint is reproducible within a run yet unique across the
# (run, level, cluster, members) tuple. Continuation reuses an existing UUID, so
# this is only ever used at birth.
_UUID_NAMESPACE = uuid.UUID("6f1d2c9e-3b7a-4e2f-9c11-8a5b2d4e6f70")

# Fallback thresholds used only when application config is unavailable (e.g. a
# standalone unit test that constructs the reconciler without loading config).
# These mirror the ``community_identity.default`` defaults in config.default.yaml.
_DEFAULT_MIN_INTERSECTION = 2
_DEFAULT_JACCARD_THRESHOLD = 0.3
_DEFAULT_INCLUSION_THRESHOLD = 0.5


# Lineage event type constants.
EVENT_CONTINUE = "continue"
EVENT_GROW = "grow"
EVENT_SHRINK = "shrink"
EVENT_SPLIT = "split"
EVENT_MERGE = "merge"
EVENT_BIRTH = "birth"
EVENT_DEATH = "death"

# Community lifecycle status constants.
STATUS_ACTIVE = "active"
STATUS_RETIRED = "retired"  # split / merged into successors
STATUS_DEAD = "dead"  # no successor at all


@dataclass(frozen=True)
class Thresholds:
    """Resolved overlap thresholds for a single hierarchy level."""

    min_intersection: int
    jaccard: float
    inclusion: float


@dataclass(frozen=True)
class LineageEvent:
    """One auditable reconciliation decision.

    Every score and threshold that drove the decision is recorded so the
    classification is reproducible after the fact.
    """

    run_id: str
    level: int
    event_type: str
    predecessor_uuid: str | None
    successor_uuid: str | None
    jaccard: float | None
    incl_old: float | None
    incl_new: float | None
    min_intersection: int
    jaccard_threshold: float
    inclusion_threshold: float
    tie_break: str | None


def _fingerprint(members: Iterable[str]) -> str:
    """Return a canonical sorted-member hash.

    This is a *version fingerprint* / cache key only. It is never used as
    identity: a single added or removed member changes the hash, whereas
    identity must survive membership drift.
    """
    canonical = "\n".join(sorted(members))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _mint_uuid(run_id: str, level: int, cluster_id: int, members: set[str]) -> str:
    """Mint a fresh, reproducible community UUID for a birth."""
    key = f"{run_id}|{level}|{cluster_id}|{_fingerprint(members)}"
    return str(uuid.uuid5(_UUID_NAMESPACE, key))


def _jaccard(old: set[str], new: set[str]) -> float:
    """Symmetric Jaccard overlap ``|O∩N| / |O∪N|``."""
    if not old and not new:
        return 0.0
    inter = len(old & new)
    union = len(old | new)
    return inter / union if union else 0.0


def _inclusion(inter: int, denom: int) -> float:
    """Directional inclusion ratio ``|O∩N| / |denom|`` (0 if denom is empty)."""
    return inter / denom if denom else 0.0


def _hungarian_max_weight(profit: list[list[int]]) -> list[int]:
    """Solve max-weight perfect assignment on a square matrix (Hungarian).

    Args:
        profit: An ``n x n`` matrix of non-negative integer profits.

    Returns:
        ``assignment`` where ``assignment[i] = j`` means row ``i`` is matched to
        column ``j`` in the maximum-total-profit perfect matching. Determinism:
        for equal-profit alternatives the Jonker-style potentials with ascending
        column scan yield a stable, reproducible assignment.

    The implementation converts profit to cost (``maxv - profit``) and runs the
    O(n^3) Kuhn-Munkres shortest-augmenting-path variant. Matrices here are
    tiny (communities per level), so this is negligible.
    """
    n = len(profit)
    if n == 0:
        return []
    maxv = max((max(row) for row in profit), default=0)
    # cost[i][j] = maxv - profit -> minimizing cost maximizes profit.
    cost = [[maxv - profit[i][j] for j in range(n)] for i in range(n)]

    inf = float("inf")
    u = [0.0] * (n + 1)
    v = [0.0] * (n + 1)
    p = [0] * (n + 1)  # p[j] = row assigned to column j (1-indexed rows)
    way = [0] * (n + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [inf] * (n + 1)
        used = [False] * (n + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = inf
            j1 = -1
            for j in range(1, n + 1):
                if not used[j]:
                    cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j] = cur
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j
            for j in range(n + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
    assignment = [0] * n
    for j in range(1, n + 1):
        if p[j]:
            assignment[p[j] - 1] = j - 1
    return assignment


def _connected_components(
    edges: list[tuple[int, int]],
) -> list[tuple[list[int], list[int]]]:
    """Group a bipartite edge list into connected components.

    Old-side and new-side vertices live in disjoint namespaces (both are
    integers, so they are tagged ``("o", id)`` / ``("n", id)`` internally). Two
    vertices are in the same component iff connected through qualifying edges.

    Args:
        edges: ``(old_cluster, new_cluster)`` qualifying overlap edges.

    Returns:
        A list of ``(sorted_old_clusters, sorted_new_clusters)`` per component,
        ordered deterministically by the component's smallest old then new id.
    """
    adj: dict[tuple[str, int], list[tuple[str, int]]] = {}
    for o, nn in edges:
        a = ("o", o)
        b = ("n", nn)
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen: set[tuple[str, int]] = set()
    components: list[tuple[list[int], list[int]]] = []
    for start in adj:
        if start in seen:
            continue
        stack = [start]
        seen.add(start)
        comp_old: set[int] = set()
        comp_new: set[int] = set()
        while stack:
            node = stack.pop()
            side, vid = node
            if side == "o":
                comp_old.add(vid)
            else:
                comp_new.add(vid)
            for nb in adj[node]:
                if nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        components.append((sorted(comp_old), sorted(comp_new)))
    components.sort(
        key=lambda c: (c[0][0] if c[0] else -1, c[1][0] if c[1] else -1)
    )
    return components


@dataclass(frozen=True)
class _Candidate:
    """A qualifying old->new overlap edge for one level."""

    old_cluster: int
    new_cluster: int
    intersection: int
    jaccard: float
    incl_old: float
    incl_new: float


class CommunityIdentity:
    """Reconciles successive partitions into stable community UUIDs.

    The reconciler owns four tables (all lazily created):

    * ``community_identity`` — one row per stable UUID with lifecycle status.
    * ``community_identity_map`` — ``(run_id, level, cluster_id) -> uuid`` so a
      consumer can resolve a current native label to its stable UUID.
    * ``community_membership_snapshot`` — the member set persisted per
      ``(uuid, run_id)`` so a later run can compare against the prior members.
    * ``community_lineage_event`` — the auditable decision log.

    Example:
        >>> ident = CommunityIdentity(store)           # store: SQLiteStore
        >>> mapping = ident.reconcile(
        ...     {0: {1: {"e:a", "e:b"}, 2: {"e:c"}}}, run_id="run-1"
        ... )
        >>> ident.resolve(0, 1) == mapping[(0, 1)]
        True
    """

    def __init__(
        self,
        store: object,
        *,
        thresholds: Mapping[int, Thresholds] | None = None,
        default_thresholds: Thresholds | None = None,
    ) -> None:
        """Bind the reconciler to a SQLite-backed store.

        Args:
            store: A ``SQLiteStore`` (anything exposing a ``sql_conn``
                ``sqlite3.Connection``) or a raw ``sqlite3.Connection``.
            thresholds: Optional explicit per-level thresholds. A level present
                here always wins. Supplying this lets unit tests run without
                loading config.
            default_thresholds: Optional default applied to any level not present
                in ``thresholds``. Honoured even when ``thresholds`` is ``None``,
                and it takes precedence over application config, so an explicit
                caller value is never silently discarded.

        Threshold precedence, highest first: per-level ``thresholds`` entry,
        ``default_thresholds``, application config
        (``pipelines.ingestion.community_identity``), module fallback constants.
        When ``thresholds`` is supplied but a level is absent and no
        ``default_thresholds`` is given, the module fallback is used rather than
        ambient config, so behaviour stays deterministic.
        """
        self._conn = self._coerce_conn(store)
        self._explicit_thresholds = dict(thresholds) if thresholds is not None else None
        self._explicit_default = default_thresholds
        self._config_cache: dict[int, Thresholds] = {}
        self._ensure_tables()

    # ── connection / config plumbing ────────────────────────────────────────

    @staticmethod
    def _coerce_conn(store: object) -> sqlite3.Connection:
        """Accept a ``SQLiteStore`` (via ``.sql_conn``) or a raw connection."""
        conn = getattr(store, "sql_conn", store)
        if not isinstance(conn, sqlite3.Connection):
            msg = (
                "CommunityIdentity requires a SQLiteStore (with a .sql_conn) or a "
                f"sqlite3.Connection, got {type(store)!r}"
            )
            raise TypeError(msg)
        return conn

    def _thresholds_for(self, level: int) -> Thresholds:
        """Resolve effective thresholds for ``level`` (per-level override else default).

        Precedence, highest first:

        1. an explicit per-level entry in ``thresholds``;
        2. an explicit ``default_thresholds``;
        3. application config (``pipelines.ingestion.community_identity``);
        4. module fallback constants.

        Steps 1 and 2 are independent: supplying only ``default_thresholds``
        must still win over config, otherwise a caller's explicit value would be
        silently discarded whenever config happens to be importable.
        """
        if self._explicit_thresholds is not None and level in self._explicit_thresholds:
            return self._explicit_thresholds[level]
        if self._explicit_default is not None:
            return self._explicit_default
        if self._explicit_thresholds is not None:
            # Explicit per-level map supplied but this level is absent and no
            # explicit default was given: stay deterministic (do NOT silently
            # fall back to ambient config, which would make the same call behave
            # differently depending on whether config is importable).
            return Thresholds(
                _DEFAULT_MIN_INTERSECTION,
                _DEFAULT_JACCARD_THRESHOLD,
                _DEFAULT_INCLUSION_THRESHOLD,
            )
        if level in self._config_cache:
            return self._config_cache[level]
        resolved = self._resolve_from_config(level)
        self._config_cache[level] = resolved
        return resolved

    @staticmethod
    def _resolve_from_config(level: int) -> Thresholds:
        """Read per-level identity thresholds from application config.

        Falls back to module defaults if config cannot be imported/read, so the
        reconciler is usable in isolation.
        """
        try:
            from kl_graph.config import cfg

            ident = cfg.pipelines.ingestion.community_identity
            default = ident.default
            level_key = f"L{level}"
            override = getattr(ident.levels, level_key, None)

            def pick(field: str) -> object:
                base = getattr(default, field)
                if override is None:
                    return base
                ov = getattr(override, field, None)
                return base if ov is None else ov

            return Thresholds(
                min_intersection=int(pick("identity_min_intersection")),
                jaccard=float(pick("identity_jaccard_threshold")),
                inclusion=float(pick("identity_inclusion_threshold")),
            )
        except Exception:  # noqa: BLE001 - config optional; any read failure falls back to module defaults
            return Thresholds(
                _DEFAULT_MIN_INTERSECTION,
                _DEFAULT_JACCARD_THRESHOLD,
                _DEFAULT_INCLUSION_THRESHOLD,
            )

    # ── schema ──────────────────────────────────────────────────────────────

    def _ensure_tables(self) -> None:
        """Create the module-owned tables if they do not exist (idempotent)."""
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS community_identity (
                community_uuid TEXT PRIMARY KEY,
                level INTEGER NOT NULL,
                status TEXT NOT NULL,
                first_seen_run TEXT NOT NULL,
                last_seen_run TEXT NOT NULL,
                split_from TEXT,       -- JSON list of predecessor uuids (split/merge product)
                merged_into TEXT,      -- JSON list of successor uuids (retired predecessor)
                member_count INTEGER NOT NULL DEFAULT 0,
                fingerprint TEXT
            );

            CREATE TABLE IF NOT EXISTS community_identity_map (
                run_id TEXT NOT NULL,
                level INTEGER NOT NULL,
                cluster_id INTEGER NOT NULL,
                community_uuid TEXT NOT NULL,
                PRIMARY KEY (run_id, level, cluster_id)
            );

            CREATE TABLE IF NOT EXISTS community_membership_snapshot (
                community_uuid TEXT NOT NULL,
                run_id TEXT NOT NULL,
                level INTEGER NOT NULL,
                cluster_id INTEGER NOT NULL,
                member_ids TEXT NOT NULL,   -- JSON sorted list of member ids
                member_count INTEGER NOT NULL,
                fingerprint TEXT NOT NULL,
                PRIMARY KEY (community_uuid, run_id)
            );

            CREATE TABLE IF NOT EXISTS community_lineage_event (
                run_id TEXT NOT NULL,
                level INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                predecessor_uuid TEXT,
                successor_uuid TEXT,
                jaccard REAL,
                incl_old REAL,
                incl_new REAL,
                min_intersection INTEGER NOT NULL,
                jaccard_threshold REAL NOT NULL,
                inclusion_threshold REAL NOT NULL,
                tie_break TEXT
            );

            CREATE TABLE IF NOT EXISTS community_run_level (
                run_id TEXT NOT NULL,
                level INTEGER NOT NULL,
                seq INTEGER,
                PRIMARY KEY (run_id, level)
            );

            CREATE INDEX IF NOT EXISTS idx_identity_map_lookup
                ON community_identity_map (level, cluster_id, run_id);
            CREATE INDEX IF NOT EXISTS idx_lineage_event_run
                ON community_lineage_event (run_id);
            CREATE INDEX IF NOT EXISTS idx_snapshot_uuid
                ON community_membership_snapshot (community_uuid);
            """
        )
        self._conn.commit()

    # ── run-scoped idempotency ──────────────────────────────────────────────

    def _purge_run(self, run_id: str) -> None:
        """Remove any prior rows written for ``run_id`` (overwrite-safe retry).

        Snapshots and the label map are keyed by ``run_id`` and simply deleted.
        Lineage events for the run are deleted. Identity rows whose
        ``first_seen_run`` equals this run (i.e. minted *by* this run) are
        removed so a retried run does not leave orphan births; identity rows
        that pre-date this run are left intact and will be re-touched by the
        replay.
        """
        self._conn.execute(
            "DELETE FROM community_identity WHERE first_seen_run = ?", (run_id,)
        )
        self._conn.execute(
            "DELETE FROM community_identity_map WHERE run_id = ?", (run_id,)
        )
        self._conn.execute(
            "DELETE FROM community_membership_snapshot WHERE run_id = ?", (run_id,)
        )
        self._conn.execute(
            "DELETE FROM community_lineage_event WHERE run_id = ?", (run_id,)
        )
        self._conn.execute(
            "DELETE FROM community_run_level WHERE run_id = ?", (run_id,)
        )

    # ── previous-partition lookup ───────────────────────────────────────────

    def _known_levels(self, exclude_run: str) -> set[int]:
        """Return all hierarchy levels that any PRIOR run reconciled.

        Used so an empty (or level-missing) current partition still reconciles
        previously-known levels into deaths rather than leaving them active.
        Unions the run/level ledger with the membership snapshot so both new and
        legacy databases report every level ever seen.
        """
        rows = self._conn.execute(
            "SELECT DISTINCT level FROM community_membership_snapshot WHERE run_id != ?",
            (exclude_run,),
        ).fetchall()
        ledger = self._conn.execute(
            "SELECT DISTINCT level FROM community_run_level WHERE run_id != ?",
            (exclude_run,),
        ).fetchall()
        return {int(r[0]) for r in rows} | {int(r[0]) for r in ledger}

    def _previous_run_for_level(self, level: int, exclude_run: str) -> str | None:
        """Return the most recent prior ``run_id`` that reconciled ``level``.

        Uses the ``community_run_level`` ledger rather than the membership
        snapshot, because a run in which a level was EMPTY writes no snapshot
        rows. Keying off snapshots alone would make such a run invisible and let
        a later run match against a pre-death partition, resurrecting a dead
        community. Runs are ordered by the monotonic ``seq`` recorded when the
        level was reconciled.
        """
        row = self._conn.execute(
            """
            SELECT run_id
            FROM community_run_level
            WHERE level = ? AND run_id != ?
            ORDER BY seq DESC
            LIMIT 1
            """,
            (level, exclude_run),
        ).fetchone()
        if row:
            return row[0]
        # Legacy databases written before the ledger existed: fall back to the
        # snapshot ordering so older state still reconciles.
        legacy = self._conn.execute(
            """
            SELECT run_id, MAX(rowid) AS r
            FROM community_membership_snapshot
            WHERE level = ? AND run_id != ?
            GROUP BY run_id
            ORDER BY r DESC
            LIMIT 1
            """,
            (level, exclude_run),
        ).fetchone()
        return legacy[0] if legacy else None

    def _record_run_level(self, run_id: str, level: int) -> None:
        """Note that ``run_id`` reconciled ``level`` (even if it was empty)."""
        self._conn.execute(
            "INSERT OR REPLACE INTO community_run_level (run_id, level, seq) "
            "VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM community_run_level), 0) + 1)",
            (run_id, level),
        )

    def _load_prev_partition(
        self, level: int, run_id: str
    ) -> dict[str, tuple[int, set[str]]]:
        """Load a prior run's level partition as ``uuid -> (cluster_id, members)``."""
        rows = self._conn.execute(
            """
            SELECT community_uuid, cluster_id, member_ids
            FROM community_membership_snapshot
            WHERE level = ? AND run_id = ?
            """,
            (level, run_id),
        ).fetchall()
        out: dict[str, tuple[int, set[str]]] = {}
        for community_uuid, cluster_id, member_ids in rows:
            out[community_uuid] = (int(cluster_id), set(json.loads(member_ids)))
        return out

    # ── candidate building + matching ───────────────────────────────────────

    def _build_candidates(
        self,
        prev: dict[str, tuple[int, set[str]]],
        curr: dict[int, set[str]],
        th: Thresholds,
    ) -> list[_Candidate]:
        """Build qualifying old->new overlap edges for one level.

        A candidate qualifies when the intersection reaches
        ``min_intersection`` AND (Jaccard clears its threshold OR either
        directional inclusion ratio clears the inclusion threshold). Using OR
        for the overlap test lets a small-but-fully-contained community match a
        much larger one (high inclusion, low Jaccard) while the absolute
        intersection floor keeps noise out.
        """
        prev_by_cluster = {cid: (u, mem) for u, (cid, mem) in prev.items()}
        candidates: list[_Candidate] = []
        for old_cluster, (_old_uuid, old_mem) in prev_by_cluster.items():
            for new_cluster, new_mem in curr.items():
                inter = len(old_mem & new_mem)
                if inter < th.min_intersection or inter == 0:
                    continue
                jac = _jaccard(old_mem, new_mem)
                incl_old = _inclusion(inter, len(old_mem))
                incl_new = _inclusion(inter, len(new_mem))
                if jac < th.jaccard and incl_old < th.inclusion and incl_new < th.inclusion:
                    continue
                candidates.append(
                    _Candidate(old_cluster, new_cluster, inter, jac, incl_old, incl_new)
                )
        return candidates

    @staticmethod
    def _max_weight_matching(
        candidates: list[_Candidate],
    ) -> set[tuple[int, int]]:
        """Exact global maximum-weight one-to-one bipartite matching.

        Returns the set of ``(old_cluster, new_cluster)`` edges in the matching
        that maximizes total weight. Weight is ``jaccard`` with ``intersection``
        as a deterministic secondary key (scaled and summed into a single
        integer so ties resolve reproducibly). Implemented as the Hungarian
        (Kuhn-Munkres) algorithm on a dense padded profit matrix; candidate
        graphs per level are small so this is inexpensive and, unlike greedy
        endpoint removal, is guaranteed optimal.
        """
        if not candidates:
            return set()
        olds = sorted({c.old_cluster for c in candidates})
        news = sorted({c.new_cluster for c in candidates})
        oi = {o: i for i, o in enumerate(olds)}
        nj = {nn: j for j, nn in enumerate(news)}
        weight: dict[tuple[int, int], int] = {}
        for c in candidates:
            w = round(c.jaccard * 1_000_000) * 1_000_000 + c.intersection * 1_000
            weight[(c.old_cluster, c.new_cluster)] = w
        n = max(len(olds), len(news))
        profit = [[0] * n for _ in range(n)]
        for (o, nn), w in weight.items():
            profit[oi[o]][nj[nn]] = w
        assignment = _hungarian_max_weight(profit)
        matched: set[tuple[int, int]] = set()
        for i, j in enumerate(assignment):
            if i < len(olds) and j < len(news):
                edge = (olds[i], news[j])
                if edge in weight:  # only real (qualifying) edges count
                    matched.add(edge)
        return matched

    @staticmethod
    def _match_one_to_one(
        candidates: list[_Candidate],
    ) -> tuple[list[_Candidate], list[tuple[str, _Candidate]]]:
        """Global maximum-weight one-to-one continuation matching.

        Delegates to :meth:`_max_weight_matching` (exact Hungarian) for the
        chosen edge set, then records deterministic tie-break audit notes where
        two candidate edges share the same ``(jaccard, intersection)`` weight.

        Returns:
            ``(matched, tie_notes)`` where ``matched`` is the chosen one-to-one
            continuation edges and ``tie_notes`` records any deterministic
            tie-break that was applied (for audit).
        """
        chosen = CommunityIdentity._max_weight_matching(candidates)
        matched = [c for c in candidates if (c.old_cluster, c.new_cluster) in chosen]
        matched.sort(key=lambda c: (c.old_cluster, c.new_cluster))
        tie_notes: list[tuple[str, _Candidate]] = []
        seen_weights: dict[tuple[float, int], int] = {}
        for c in candidates:
            w = (c.jaccard, c.intersection)
            seen_weights[w] = seen_weights.get(w, 0) + 1
        for c in matched:
            if seen_weights.get((c.jaccard, c.intersection), 0) > 1:
                tie_notes.append(
                    (
                        (
                            f"weight-tie j={c.jaccard:.6f} i={c.intersection}"
                            f" -> chose old={c.old_cluster} new={c.new_cluster}"
                            " by exact max-weight matching"
                        ),
                        c,
                    )
                )
        return matched, tie_notes

    # ── public API ──────────────────────────────────────────────────────────

    def reconcile(
        self,
        current_memberships: Mapping[int, Mapping[int, set[str]]],
        run_id: str,
    ) -> dict[tuple[int, int], str]:
        """Reconcile the current partition into stable UUIDs and persist.

        Runs independently per level, is idempotent by ``run_id`` (a retry
        overwrites this run's rows), and returns the resolved mapping.

        Args:
            current_memberships: ``{level: {cluster_id: set(member_id)}}`` — the
                current partition. This matches
                ``detect_communities_hierarchical``'s ``assignments`` after
                inverting it from ``{level: {node_key: cluster_id}}`` to
                per-cluster member sets; callers holding the raw ``assignments``
                should use :func:`invert_assignments`.
            run_id: Stable identifier for this detection run. Re-running the same
                ``run_id`` reproduces identical rows.

        Ordering contract (important): runs are ordered by the sequence in which
        they reconcile, NOT by ``run_id`` string order. Re-running a ``run_id``
        purges its prior rows and re-appends it as the newest run. That is
        exactly right for the intended immediate-retry case (retry the run that
        just failed), but it means a DELAYED replay of an older ``run_id`` after
        newer runs have completed would make the stale partition authoritative.
        Callers must not replay a superseded ``run_id``; use a fresh id for a new
        detection pass (the runner does this via a durable per-pass id).

        Returns:
            ``{(level, cluster_id): community_uuid}`` for the current run.
        """
        if not run_id:
            msg = "run_id must be a non-empty string"
            raise ValueError(msg)

        # Wrap the whole run so a mid-run failure leaves NO partial residue
        # (overwrite-safe retry, idempotent by run_id). Use a SAVEPOINT so we
        # never commit or roll back a transaction we do not own: if the caller
        # already has an open transaction, the savepoint scopes exactly our
        # writes; otherwise the savepoint implicitly opens one we release here.
        # The savepoint name is a FIXED identifier (never interpolated from
        # run_id) so an arbitrary run_id — including one with whitespace or
        # punctuation — can never break the SQL identifier.
        savepoint = "community_identity_reconcile"
        self._conn.execute(f"SAVEPOINT {savepoint}")
        try:
            self._purge_run(run_id)

            # Reconcile every level that is present in the CURRENT partition OR
            # was seen in a prior run. Including prior-only levels is mandatory:
            # if the current partition is empty (or a level vanished), those
            # prior communities must be reconciled to DEATHS, not silently left
            # active. Without this an empty full rebuild would leave stale
            # identities alive.
            levels = {int(lv) for lv in current_memberships}
            levels |= self._known_levels(exclude_run=run_id)

            mapping: dict[tuple[int, int], str] = {}
            for level in sorted(levels):
                raw = current_memberships.get(level, {})
                curr = {
                    int(cid): set(members)
                    for cid, members in raw.items()
                    if members
                }
                level_map = self._reconcile_level(level, curr, run_id)
                for cluster_id, community_uuid in level_map.items():
                    mapping[(level, cluster_id)] = community_uuid
        except Exception:
            # Roll back ONLY our savepoint, preserving any enclosing transaction.
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise

        self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        # If we are the outermost owner (no enclosing transaction), persist.
        if not self._conn.in_transaction:
            self._conn.commit()
        return mapping

    def _reconcile_level(
        self, level: int, curr: dict[int, set[str]], run_id: str
    ) -> dict[int, str]:
        """Reconcile a single level; persist mapping, snapshots, events."""
        # Record that this run reconciled this level BEFORE any early return, so
        # an empty level is still observable to later runs (prevents a dead
        # community being resurrected by matching past the empty run).
        self._record_run_level(run_id, level)
        th = self._thresholds_for(level)
        prev_run = self._previous_run_for_level(level, exclude_run=run_id)
        prev = self._load_prev_partition(level, prev_run) if prev_run else {}

        events: list[LineageEvent] = []
        result: dict[int, str] = {}  # cluster_id -> uuid

        if not prev:
            # First run at this level: every current cluster is a birth.
            for cluster_id, members in curr.items():
                new_uuid = _mint_uuid(run_id, level, cluster_id, members)
                result[cluster_id] = new_uuid
                self._insert_identity(new_uuid, level, run_id, members, born=True)
                events.append(self._event(run_id, level, EVENT_BIRTH, None, new_uuid, th, None, None, None, None))
            self._persist_level(run_id, level, curr, result, events)
            return result

        candidates = self._build_candidates(prev, curr, th)
        matched, tie_notes = self._match_one_to_one(candidates)
        matched_edges = {(c.old_cluster, c.new_cluster) for c in matched}
        tie_by_edge = {(c.old_cluster, c.new_cluster): note for note, c in tie_notes}
        prev_by_cluster = {cid: (u, mem) for u, (cid, mem) in prev.items()}
        cand_by_edge = {(c.old_cluster, c.new_cluster): c for c in candidates}

        # Group the qualifying candidate graph into connected components. A
        # component's shape classifies the event set for everyone in it:
        #   * 1 old <-> 1 new (and it is the chosen match) -> continuation
        #     (grow / shrink / continue), UUID kept.
        #   * anything else (1->many, many->1, many->many) -> STRUCTURAL:
        #     retire ALL predecessor UUIDs, mint a FRESH birth UUID for EVERY
        #     product new cluster, and record both a birth event per product
        #     AND the split/merge lineage edges. Every product carries the full
        #     list of its qualifying predecessors in split_from (audit).
        components = _connected_components(
            [(c.old_cluster, c.new_cluster) for c in candidates],
        )

        events: list[LineageEvent] = []
        result: dict[int, str] = {}
        handled_old: set[int] = set()

        for comp_olds, comp_news in components:
            is_continuation = (
                len(comp_olds) == 1
                and len(comp_news) == 1
                and (comp_olds[0], comp_news[0]) in matched_edges
            )
            if is_continuation:
                oc, nc = comp_olds[0], comp_news[0]
                old_uuid, old_mem = prev_by_cluster[oc]
                new_mem = curr[nc]
                cand = cand_by_edge[(oc, nc)]
                result[nc] = old_uuid
                handled_old.add(oc)
                delta = len(new_mem) - len(old_mem)
                etype = (
                    EVENT_CONTINUE if delta == 0
                    else (EVENT_GROW if delta > 0 else EVENT_SHRINK)
                )
                events.append(
                    self._event(
                        run_id, level, etype, old_uuid, old_uuid, th,
                        cand.jaccard, cand.incl_old, cand.incl_new,
                        tie_by_edge.get((oc, nc)),
                    )
                )
                continue

            # STRUCTURAL component (split / merge / many-to-many).
            for nc in sorted(comp_news):
                new_uuid = _mint_uuid(run_id, level, nc, curr[nc])
                result[nc] = new_uuid
                # Full predecessor lineage for THIS product: every old cluster
                # in the component with a qualifying edge to it.
                this_preds = sorted(
                    prev_by_cluster[oc][0]
                    for oc in comp_olds
                    if (oc, nc) in cand_by_edge
                )
                self._insert_identity(
                    new_uuid, level, run_id, curr[nc], born=True,
                    split_from=this_preds,
                )
                # Every structural product is a birth (forced-fresh).
                events.append(
                    self._event(run_id, level, EVENT_BIRTH, None, new_uuid, th,
                                None, None, None, None)
                )
                # Record a structural lineage edge from each qualifying
                # predecessor: split when the component fans out to multiple
                # new clusters, merge when multiple old clusters converge.
                edge_type = EVENT_SPLIT if len(comp_news) > 1 else EVENT_MERGE
                for oc in sorted(comp_olds):
                    if (oc, nc) not in cand_by_edge:
                        continue
                    cand = cand_by_edge[(oc, nc)]
                    events.append(
                        self._event(
                            run_id, level, edge_type,
                            prev_by_cluster[oc][0], new_uuid, th,
                            cand.jaccard, cand.incl_old, cand.incl_new,
                            tie_by_edge.get((oc, nc)),
                        )
                    )
            succs = sorted(result[nc] for nc in comp_news)
            for oc in sorted(comp_olds):
                handled_old.add(oc)
                self._retire_identity(
                    prev_by_cluster[oc][0], run_id,
                    merged_into=succs, status=STATUS_RETIRED,
                )

        # Births: current clusters with no qualifying predecessor at all.
        for cluster_id, members in curr.items():
            if cluster_id in result:
                continue
            new_uuid = _mint_uuid(run_id, level, cluster_id, members)
            result[cluster_id] = new_uuid
            self._insert_identity(new_uuid, level, run_id, members, born=True)
            events.append(
                self._event(run_id, level, EVENT_BIRTH, None, new_uuid, th,
                            None, None, None, None)
            )

        # Deaths: prior UUIDs with no successor and not already retired.
        for old_cluster, (old_uuid, _mem) in prev_by_cluster.items():
            if old_cluster in handled_old:
                continue
            self._retire_identity(old_uuid, run_id, merged_into=None, status=STATUS_DEAD)
            events.append(
                self._event(run_id, level, EVENT_DEATH, old_uuid, None, th,
                            None, None, None, None)
            )

        # Touch last_seen_run for every active (result) uuid.
        for cluster_id, community_uuid in result.items():
            self._touch_identity(community_uuid, run_id, curr[cluster_id])

        self._persist_level(run_id, level, curr, result, events)
        return result

    # ── persistence helpers ─────────────────────────────────────────────────

    def _event(
        self, run_id: str, level: int, etype: str,
        pred: str | None, succ: str | None, th: Thresholds,
        jac: float | None, incl_old: float | None, incl_new: float | None,
        tie: str | None,
    ) -> LineageEvent:
        return LineageEvent(
            run_id=run_id, level=level, event_type=etype,
            predecessor_uuid=pred, successor_uuid=succ,
            jaccard=jac, incl_old=incl_old, incl_new=incl_new,
            min_intersection=th.min_intersection,
            jaccard_threshold=th.jaccard, inclusion_threshold=th.inclusion,
            tie_break=tie,
        )

    def _insert_identity(
        self, community_uuid: str, level: int, run_id: str, members: set[str],
        *, born: bool, split_from: list[str] | None = None,
    ) -> None:
        self._conn.execute(
            """
            INSERT OR REPLACE INTO community_identity
                (community_uuid, level, status, first_seen_run, last_seen_run,
                 split_from, merged_into, member_count, fingerprint)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                community_uuid, level, STATUS_ACTIVE, run_id, run_id,
                json.dumps(split_from) if split_from else None, None,
                len(members), _fingerprint(members),
            ),
        )

    def _touch_identity(self, community_uuid: str, run_id: str, members: set[str]) -> None:
        self._conn.execute(
            """
            UPDATE community_identity
            SET last_seen_run = ?, member_count = ?, fingerprint = ?, status = ?
            WHERE community_uuid = ?
            """,
            (run_id, len(members), _fingerprint(members), STATUS_ACTIVE, community_uuid),
        )

    def _retire_identity(
        self, community_uuid: str, run_id: str,
        *, merged_into: list[str] | None, status: str,
    ) -> None:
        self._conn.execute(
            """
            UPDATE community_identity
            SET status = ?, last_seen_run = ?, merged_into = ?
            WHERE community_uuid = ?
            """,
            (
                status, run_id,
                json.dumps(merged_into) if merged_into else None,
                community_uuid,
            ),
        )

    def _persist_level(
        self, run_id: str, level: int,
        curr: dict[int, set[str]], result: dict[int, str],
        events: list[LineageEvent],
    ) -> None:
        for cluster_id, community_uuid in result.items():
            members = curr[cluster_id]
            self._conn.execute(
                """
                INSERT OR REPLACE INTO community_identity_map
                    (run_id, level, cluster_id, community_uuid)
                VALUES (?, ?, ?, ?)
                """,
                (run_id, level, cluster_id, community_uuid),
            )
            self._conn.execute(
                """
                INSERT OR REPLACE INTO community_membership_snapshot
                    (community_uuid, run_id, level, cluster_id, member_ids,
                     member_count, fingerprint)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    community_uuid, run_id, level, cluster_id,
                    json.dumps(sorted(members)), len(members), _fingerprint(members),
                ),
            )
        for e in events:
            self._conn.execute(
                """
                INSERT INTO community_lineage_event
                    (run_id, level, event_type, predecessor_uuid, successor_uuid,
                     jaccard, incl_old, incl_new, min_intersection,
                     jaccard_threshold, inclusion_threshold, tie_break)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    e.run_id, e.level, e.event_type, e.predecessor_uuid, e.successor_uuid,
                    e.jaccard, e.incl_old, e.incl_new, e.min_intersection,
                    e.jaccard_threshold, e.inclusion_threshold, e.tie_break,
                ),
            )

    # ── read API ────────────────────────────────────────────────────────────

    def resolve(self, level: int, cluster_id: int) -> str | None:
        """Resolve a native ``(level, cluster_id)`` to its UUID (latest run)."""
        row = self._conn.execute(
            """
            SELECT community_uuid FROM community_identity_map
            WHERE level = ? AND cluster_id = ?
            ORDER BY rowid DESC LIMIT 1
            """,
            (level, cluster_id),
        ).fetchone()
        return row[0] if row else None

    def current_members(self, community_uuid: str) -> set[str]:
        """Return the member set from the most recent snapshot of a UUID."""
        row = self._conn.execute(
            """
            SELECT member_ids FROM community_membership_snapshot
            WHERE community_uuid = ?
            ORDER BY rowid DESC LIMIT 1
            """,
            (community_uuid,),
        ).fetchone()
        return set(json.loads(row[0])) if row else set()

    def baseline_members(self, community_uuid: str) -> set[str] | None:
        """Return the *earliest* recorded member set for a UUID, or ``None``.

        This is the identity-layer view of a community's first-seen membership.
        The gated summarizer maintains its own *summary* baseline (advanced only
        on successful regeneration); this method exposes the identity snapshot
        for callers that want the raw first-seen members.
        """
        row = self._conn.execute(
            """
            SELECT member_ids FROM community_membership_snapshot
            WHERE community_uuid = ?
            ORDER BY rowid ASC LIMIT 1
            """,
            (community_uuid,),
        ).fetchone()
        return set(json.loads(row[0])) if row else None

    def lineage_events_for(self, run_id: str) -> list[LineageEvent]:
        """Return all lineage events recorded for a run, in insertion order."""
        rows = self._conn.execute(
            """
            SELECT run_id, level, event_type, predecessor_uuid, successor_uuid,
                   jaccard, incl_old, incl_new, min_intersection,
                   jaccard_threshold, inclusion_threshold, tie_break
            FROM community_lineage_event
            WHERE run_id = ?
            ORDER BY rowid ASC
            """,
            (run_id,),
        ).fetchall()
        return [
            LineageEvent(
                run_id=r[0], level=r[1], event_type=r[2],
                predecessor_uuid=r[3], successor_uuid=r[4],
                jaccard=r[5], incl_old=r[6], incl_new=r[7],
                min_intersection=r[8], jaccard_threshold=r[9],
                inclusion_threshold=r[10], tie_break=r[11],
            )
            for r in rows
        ]


def invert_assignments(
    assignments: Mapping[int, Mapping[tuple[str, str], int]],
) -> dict[int, dict[int, set[str]]]:
    """Convert detection ``assignments`` to per-cluster member sets.

    ``detect_communities_hierarchical`` returns
    ``{level: {(node_type, original_id): cluster_id}}``. Reconciliation needs
    ``{level: {cluster_id: set(member_id)}}``. Member ids are the collision-proof
    ``"<node_type>:<original_id>"`` form so entities and facts sharing a textual
    id never collide.

    Args:
        assignments: The detection ``assignments`` mapping.

    Returns:
        ``{level: {cluster_id: set(member_id)}}``.
    """
    out: dict[int, dict[int, set[str]]] = {}
    for level, node_map in assignments.items():
        per_cluster: dict[int, set[str]] = {}
        for (node_type, original_id), cluster_id in node_map.items():
            member_id = f"{node_type}:{original_id}"
            per_cluster.setdefault(int(cluster_id), set()).add(member_id)
        out[int(level)] = per_cluster
    return out
