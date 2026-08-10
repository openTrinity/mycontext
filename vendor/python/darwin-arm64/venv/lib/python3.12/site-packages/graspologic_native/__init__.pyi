# Copyright (c) Microsoft Corporation.
# Licensed under the MIT license.

from typing import Dict, List, Optional, Tuple

class HierarchicalCluster:
    node: str
    cluster: int
    level: int
    parent_cluster: Optional[int]
    is_final_cluster: bool

def leiden(
    edges: List[Tuple[str, str, float]],
    starting_communities: Optional[Dict[str, int]],
    resolution: float,
    randomness: float,
    iterations: int,
    use_modularity: bool,
    seed: Optional[int],
    trials: int
) -> Tuple[float, Dict[str, int]]: ...

def hierarchical_leiden(
    edges: List[Tuple[str, str, float]],
    starting_communities: Optional[Dict[str, int]],
    resolution: float,
    randomness: float,
    iterations: int,
    use_modularity: bool,
    max_cluster_size: int,
    seed: Optional[int],
) -> List[HierarchicalCluster]: ...

def modularity(
    edges: List[Tuple[str, str, float]],
    starting_communities: Dict[str, int],
    resolution: float
) -> float: ...
