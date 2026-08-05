from typing import Any, TypeAlias

import numpy as np

from qdrant_client.http import models
from qdrant_client.conversions import common_types as types
from qdrant_client.local.distances import (
    calculate_distance,
    scaled_fast_sigmoid,
    EPSILON,
    fast_sigmoid,
)


class MultiRecoQuery:
    def __init__(
        self,
        positive: list[list[list[float]]] | None = None,  # list of matrices
        negative: list[list[list[float]]] | None = None,  # list of matrices
        strategy: models.RecommendStrategy | None = None,
    ):
        assert strategy is not None, "Recommend strategy must be provided"

        self.strategy = strategy

        positive = positive if positive is not None else []
        negative = negative if negative is not None else []

        for vector in positive:
            assert not np.isnan(vector).any(), "Positive vectors must not contain NaN"
        for vector in negative:
            assert not np.isnan(vector).any(), "Negative vectors must not contain NaN"

        self.positive: list[types.NumpyArray] = [np.array(vector) for vector in positive]
        self.negative: list[types.NumpyArray] = [np.array(vector) for vector in negative]


class MultiContextPair:
    def __init__(self, positive: list[list[float]], negative: list[list[float]]):
        self.positive: types.NumpyArray = np.array(positive)
        self.negative: types.NumpyArray = np.array(negative)

        assert not np.isnan(self.positive).any(), "Positive vector must not contain NaN"
        assert not np.isnan(self.negative).any(), "Negative vector must not contain NaN"


class MultiDiscoveryQuery:
    def __init__(self, target: list[list[float]], context: list[MultiContextPair]):
        self.target: types.NumpyArray = np.array(target)
        self.context = context

        assert not np.isnan(self.target).any(), "Target vector must not contain NaN"


class MultiContextQuery:
    def __init__(self, context_pairs: list[MultiContextPair]):
        self.context_pairs = context_pairs


MultiQueryVector: TypeAlias = MultiDiscoveryQuery | MultiContextQuery | MultiRecoQuery


def calculate_multi_distance(
    query_matrix: types.NumpyArray,
    matrices: list[types.NumpyArray],
    distance_type: models.Distance,
) -> types.NumpyArray:
    assert not np.isnan(query_matrix).any(), "Query matrix must not contain NaN"
    assert len(query_matrix.shape) == 2, "Query must be a matrix"

    distances = calculate_multi_distance_core(query_matrix, matrices, distance_type)

    if distance_type == models.Distance.EUCLID:
        distances = np.sqrt(np.abs(distances))
    elif distance_type == models.Distance.MANHATTAN:
        distances = np.abs(distances)
    return distances


def calculate_multi_distance_core(
    query_matrix: types.NumpyArray,
    matrices: list[types.NumpyArray],
    distance_type: models.Distance,
) -> types.NumpyArray:
    def euclidean(q: types.NumpyArray, m: types.NumpyArray, *_: Any) -> types.NumpyArray:
        return -np.square(m - q, dtype=np.float32).sum(axis=-1, dtype=np.float32)

    def manhattan(q: types.NumpyArray, m: types.NumpyArray, *_: Any) -> types.NumpyArray:
        return -np.abs(m - q, dtype=np.float32).sum(axis=-1, dtype=np.float32)

    assert not np.isnan(query_matrix).any(), "Query vector must not contain NaN"
    similarities: list[float] = []

    # Euclid and Manhattan are the only ones which are calculated differently during candidate selection
    # in core, here we make sure to use the same internal similarity function as in core.
    if distance_type in [models.Distance.EUCLID, models.Distance.MANHATTAN]:
        query_matrix = query_matrix[:, np.newaxis]
        dist_func = euclidean if distance_type == models.Distance.EUCLID else manhattan
    else:
        dist_func = calculate_distance  # type: ignore

    for matrix in matrices:
        sim_matrix = dist_func(query_matrix, matrix, distance_type)
        similarity = float(np.sum(np.max(sim_matrix, axis=-1)))
        similarities.append(similarity)
    return np.array(similarities)


def calculate_multi_recommend_best_scores(
    query: MultiRecoQuery, matrices: list[types.NumpyArray], distance_type: models.Distance
) -> types.NumpyArray:
    def get_best_scores(examples: list[types.NumpyArray]) -> types.NumpyArray:
        matrix_count = len(matrices)

        # Get scores to all examples
        scores: list[types.NumpyArray] = []
        for example in examples:
            score = calculate_multi_distance_core(example, matrices, distance_type)
            scores.append(score)

        # Keep only max for each vector
        if len(scores) == 0:
            scores.append(np.full(matrix_count, -np.inf))
        best_scores = np.array(scores, dtype=np.float32).max(axis=0)

        return best_scores

    pos = get_best_scores(query.positive)
    neg = get_best_scores(query.negative)

    # Choose from the best positive or the best negative,
    # in both cases we apply sigmoid and then negate depending on the order
    return np.where(
        pos > neg,
        np.fromiter((scaled_fast_sigmoid(xi) for xi in pos), pos.dtype),
        np.fromiter((-scaled_fast_sigmoid(xi) for xi in neg), neg.dtype),
    )


def calculate_multi_recommend_sum_scores(
    query: MultiRecoQuery, matrices: list[types.NumpyArray], distance_type: models.Distance
) -> types.NumpyArray:
    def get_sum_scores(examples: list[types.NumpyArray]) -> types.NumpyArray:
        matrix_count = len(matrices)

        scores: list[types.NumpyArray] = []
        for example in examples:
            score = calculate_multi_distance_core(example, matrices, distance_type)
            scores.append(score)

        if len(scores) == 0:
            scores.append(np.zeros(matrix_count))

        sum_scores = np.array(scores, dtype=np.float32).sum(axis=0)
        return sum_scores

    pos = get_sum_scores(query.positive)
    neg = get_sum_scores(query.negative)

    return pos - neg


def calculate_multi_discovery_ranks(
    context: list[MultiContextPair],
    matrices: list[types.NumpyArray],
    distance_type: models.Distance,
) -> types.NumpyArray:
    overall_ranks: types.NumpyArray = np.zeros(len(matrices), dtype=np.int32)
    for pair in context:
        # Get distances to positive and negative vectors
        pos = calculate_multi_distance_core(pair.positive, matrices, distance_type)
        neg = calculate_multi_distance_core(pair.negative, matrices, distance_type)

        pair_ranks = np.array(
            [
                1 if is_bigger else 0 if is_equal else -1
                for is_bigger, is_equal in zip(pos > neg, pos == neg)
            ]
        )

        overall_ranks += pair_ranks

    return overall_ranks


def calculate_multi_discovery_scores(
    query: MultiDiscoveryQuery, matrices: list[types.NumpyArray], distance_type: models.Distance
) -> types.NumpyArray:
    ranks = calculate_multi_discovery_ranks(query.context, matrices, distance_type)

    # Get distances to target
    distances_to_target = calculate_multi_distance_core(query.target, matrices, distance_type)

    sigmoided_distances = np.fromiter(
        (scaled_fast_sigmoid(xi) for xi in distances_to_target), np.float32
    )

    return ranks + sigmoided_distances


def calculate_multi_context_scores(
    query: MultiContextQuery, matrices: list[types.NumpyArray], distance_type: models.Distance
) -> types.NumpyArray:
    overall_scores: types.NumpyArray = np.zeros(len(matrices), dtype=np.float32)
    for pair in query.context_pairs:
        # Get distances to positive and negative vectors
        pos = calculate_multi_distance_core(pair.positive, matrices, distance_type)
        neg = calculate_multi_distance_core(pair.negative, matrices, distance_type)

        difference = pos - neg - EPSILON
        pair_scores = np.fromiter(
            (fast_sigmoid(xi) for xi in np.minimum(difference, 0.0)), np.float32
        )
        overall_scores += pair_scores

    return overall_scores
