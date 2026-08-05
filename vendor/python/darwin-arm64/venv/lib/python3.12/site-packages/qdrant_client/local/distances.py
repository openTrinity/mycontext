from enum import Enum
from typing import TypeAlias
from itertools import permutations

import numpy as np

from qdrant_client.conversions import common_types as types
from qdrant_client.http import models

EPSILON = 1.1920929e-7  # https://doc.rust-lang.org/std/f32/constant.EPSILON.html
# https://github.com/qdrant/qdrant/blob/7164ac4a5987d28f1c93f5712aef8e09e7d93555/lib/segment/src/spaces/simple_avx.rs#L99C10-L99C10

NAIVE_FEEDBACK_CONFIDENCE_MARGIN = 0.0


class DistanceOrder(str, Enum):
    BIGGER_IS_BETTER = "bigger_is_better"
    SMALLER_IS_BETTER = "smaller_is_better"


class RecoQuery:
    def __init__(
        self,
        positive: list[list[float]] | None = None,
        negative: list[list[float]] | None = None,
        strategy: models.RecommendStrategy | None = None,
    ):
        assert strategy is not None, "Recommend strategy must be provided"

        self.strategy = strategy
        positive = positive if positive is not None else []
        negative = negative if negative is not None else []

        self.positive: list[types.NumpyArray] = [np.array(vector) for vector in positive]
        self.negative: list[types.NumpyArray] = [np.array(vector) for vector in negative]

        assert not np.isnan(self.positive).any(), "Positive vectors must not contain NaN"
        assert not np.isnan(self.negative).any(), "Negative vectors must not contain NaN"


class ContextPair:
    def __init__(self, positive: list[float], negative: list[float]):
        self.positive: types.NumpyArray = np.array(positive)
        self.negative: types.NumpyArray = np.array(negative)

        assert not np.isnan(self.positive).any(), "Positive vector must not contain NaN"
        assert not np.isnan(self.negative).any(), "Negative vector must not contain NaN"


class DiscoveryQuery:
    def __init__(self, target: list[float], context: list[ContextPair]):
        self.target: types.NumpyArray = np.array(target)
        self.context = context

        assert not np.isnan(self.target).any(), "Target vector must not contain NaN"


class ContextQuery:
    def __init__(self, context_pairs: list[ContextPair]):
        self.context_pairs = context_pairs


class FeedbackItem:
    def __init__(self, vector: list[float], score: float):
        self.vector = np.array(vector)
        self.score = score
        assert not np.isnan(self.vector).any(), "Feedback vector must not contain NaN"


class NaiveFeedbackCoefficients:
    def __init__(self, a: float, b: float, c: float):
        self.a = a
        self.b = b
        self.c = c


class FeedbackContextPair:
    def __init__(
        self, positive: types.NumpyArray, negative: types.NumpyArray, partial_computation: float
    ):
        self.positive = positive
        self.negative = negative
        self.partial_computation = partial_computation


class NaiveFeedbackQuery:
    def __init__(
        self,
        target: list[float],
        feedback: list[FeedbackItem],
        coefficients: NaiveFeedbackCoefficients,
    ):
        self.target = np.array(target)
        self.feedback = feedback
        self.coefficients = coefficients

        assert not np.isnan(self.target).any(), "Target vector must not contain NaN"
        for item in self.feedback:
            assert not np.isnan(item.vector).any(), "Feedback vector must not contain NaN"


DenseQueryVector: TypeAlias = DiscoveryQuery | ContextQuery | RecoQuery | NaiveFeedbackQuery


def distance_to_order(distance: models.Distance) -> DistanceOrder:
    """
    Convert distance to order
    Args:
        distance: distance to convert
    Returns:
        order
    """
    if distance == models.Distance.EUCLID:
        return DistanceOrder.SMALLER_IS_BETTER
    elif distance == models.Distance.MANHATTAN:
        return DistanceOrder.SMALLER_IS_BETTER

    return DistanceOrder.BIGGER_IS_BETTER


def cosine_similarity(query: types.NumpyArray, vectors: types.NumpyArray) -> types.NumpyArray:
    """
    Calculate cosine distance between query and vectors
    Args:
        query: query vector
        vectors: vectors to calculate distance with
    Returns:
        distances
    """
    vectors_norm = np.linalg.norm(vectors, axis=-1)[:, np.newaxis]
    vectors /= np.where(vectors_norm != 0.0, vectors_norm, EPSILON)

    if len(query.shape) == 1:
        query_norm = np.linalg.norm(query)
        query /= np.where(query_norm != 0.0, query_norm, EPSILON)
        return np.dot(vectors, query)

    query_norm = np.linalg.norm(query, axis=-1)[:, np.newaxis]
    query /= np.where(query_norm != 0.0, query_norm, EPSILON)
    return np.dot(query, vectors.T)


def dot_product(query: types.NumpyArray, vectors: types.NumpyArray) -> types.NumpyArray:
    """
    Calculate dot product between query and vectors
    Args:
        query: query vector.
        vectors: vectors to calculate distance with
    Returns:
        distances
    """
    if len(query.shape) == 1:
        return np.dot(vectors, query)
    else:
        return np.dot(query, vectors.T)


def euclidean_distance(query: types.NumpyArray, vectors: types.NumpyArray) -> types.NumpyArray:
    """
    Calculate euclidean distance between query and vectors
    Args:
        query: query vector.
        vectors: vectors to calculate distance with
    Returns:
        distances
    """
    if len(query.shape) == 1:
        return np.linalg.norm(vectors - query, axis=-1)
    else:
        return np.linalg.norm(vectors - query[:, np.newaxis], axis=-1)


def manhattan_distance(query: types.NumpyArray, vectors: types.NumpyArray) -> types.NumpyArray:
    """
    Calculate manhattan distance between query and vectors
    Args:
        query: query vector.
        vectors: vectors to calculate distance with
    Returns:
        distances
    """
    if len(query.shape) == 1:
        return np.sum(np.abs(vectors - query), axis=-1)
    else:
        return np.sum(np.abs(vectors - query[:, np.newaxis]), axis=-1)


def calculate_distance(
    query: types.NumpyArray, vectors: types.NumpyArray, distance_type: models.Distance
) -> types.NumpyArray:
    assert not np.isnan(query).any(), "Query vector must not contain NaN"

    if distance_type == models.Distance.COSINE:
        return cosine_similarity(query, vectors)
    elif distance_type == models.Distance.DOT:
        return dot_product(query, vectors)
    elif distance_type == models.Distance.EUCLID:
        return euclidean_distance(query, vectors)
    elif distance_type == models.Distance.MANHATTAN:
        return manhattan_distance(query, vectors)
    else:
        raise ValueError(f"Unknown distance type {distance_type}")


def calculate_distance_core(
    query: types.NumpyArray, vectors: types.NumpyArray, distance_type: models.Distance
) -> types.NumpyArray:
    """
    Calculate same internal distances as in core, rather than the final displayed distance
    """
    assert not np.isnan(query).any(), "Query vector must not contain NaN"

    if distance_type == models.Distance.EUCLID:
        return -np.square(vectors - query, dtype=np.float32).sum(axis=1, dtype=np.float32)
    if distance_type == models.Distance.MANHATTAN:
        return -np.abs(vectors - query, dtype=np.float32).sum(axis=1, dtype=np.float32)
    else:
        return calculate_distance(query, vectors, distance_type)


def fast_sigmoid(x: np.float32) -> np.float32:
    if np.isnan(x) or np.isinf(x):
        # To avoid divisions on NaNs or inf, which gets: RuntimeWarning: invalid value encountered in scalar divide
        return x
    return x / np.add(1.0, abs(x))


def scaled_fast_sigmoid(x: np.float32) -> np.float32:
    return 0.5 * (np.add(fast_sigmoid(x), 1.0))


def calculate_recommend_best_scores(
    query: RecoQuery, vectors: types.NumpyArray, distance_type: models.Distance
) -> types.NumpyArray:
    def get_best_scores(examples: list[types.NumpyArray]) -> types.NumpyArray:
        vector_count = vectors.shape[0]

        # Get scores to all examples
        scores: list[types.NumpyArray] = []
        for example in examples:
            score = calculate_distance_core(example, vectors, distance_type)
            scores.append(score)

        # Keep only max for each vector
        if len(scores) == 0:
            scores.append(np.full(vector_count, -np.inf))
        best_scores = np.array(scores, dtype=np.float32).max(axis=0)

        return best_scores

    pos = get_best_scores(query.positive)
    neg = get_best_scores(query.negative)

    # Choose from best positive or best negative,
    # in in both cases we apply sigmoid and then negate depending on the order
    return np.where(
        pos > neg,
        np.fromiter((scaled_fast_sigmoid(xi) for xi in pos), pos.dtype),
        np.fromiter((-scaled_fast_sigmoid(xi) for xi in neg), neg.dtype),
    )


def calculate_recommend_sum_scores(
    query: RecoQuery, vectors: types.NumpyArray, distance_type: models.Distance
) -> types.NumpyArray:
    def get_sum_scores(examples: list[types.NumpyArray]) -> types.NumpyArray:
        vector_count = vectors.shape[0]

        scores: list[types.NumpyArray] = []
        for example in examples:
            score = calculate_distance_core(example, vectors, distance_type)
            scores.append(score)

        if len(scores) == 0:
            scores.append(np.zeros(vector_count))

        sum_scores = np.array(scores, dtype=np.float32).sum(axis=0)

        return sum_scores

    pos = get_sum_scores(query.positive)
    neg = get_sum_scores(query.negative)

    return pos - neg


def calculate_discovery_ranks(
    context: list[ContextPair],
    vectors: types.NumpyArray,
    distance_type: models.Distance,
) -> types.NumpyArray:
    overall_ranks = np.zeros(vectors.shape[0], dtype=np.int32)
    for pair in context:
        # Get distances to positive and negative vectors
        pos = calculate_distance_core(pair.positive, vectors, distance_type)
        neg = calculate_distance_core(pair.negative, vectors, distance_type)

        pair_ranks = np.array(
            [
                1 if is_bigger else 0 if is_equal else -1
                for is_bigger, is_equal in zip(pos > neg, pos == neg)
            ]
        )

        overall_ranks += pair_ranks

    return overall_ranks


def calculate_discovery_scores(
    query: DiscoveryQuery, vectors: types.NumpyArray, distance_type: models.Distance
) -> types.NumpyArray:
    ranks = calculate_discovery_ranks(query.context, vectors, distance_type)

    # Get distances to target
    distances_to_target = calculate_distance_core(query.target, vectors, distance_type)

    sigmoided_distances = np.fromiter(
        (scaled_fast_sigmoid(xi) for xi in distances_to_target), np.float32
    )

    return ranks + sigmoided_distances


def calculate_context_scores(
    query: ContextQuery, vectors: types.NumpyArray, distance_type: models.Distance
) -> types.NumpyArray:
    overall_scores = np.zeros(vectors.shape[0], dtype=np.float32)
    for pair in query.context_pairs:
        # Get distances to positive and negative vectors
        pos = calculate_distance_core(pair.positive, vectors, distance_type)
        neg = calculate_distance_core(pair.negative, vectors, distance_type)

        difference = pos - neg - EPSILON
        pair_scores = np.fromiter(
            (fast_sigmoid(xi) for xi in np.minimum(difference, 0.0)), np.float32
        )
        overall_scores += pair_scores

    return overall_scores


def calculate_naive_feedback_query(
    query: NaiveFeedbackQuery, vectors: types.NumpyArray, distance_type: models.Distance
) -> types.NumpyArray:
    context_pairs: list[FeedbackContextPair] = []
    if len(query.feedback) >= 2:
        for p in permutations(query.feedback, 2):
            positive_item, negative_item = p[0], p[1]
            confidence = positive_item.score - negative_item.score

            if confidence <= NAIVE_FEEDBACK_CONFIDENCE_MARGIN:
                continue

            partial_computation = (confidence**query.coefficients.b) * query.coefficients.c
            context_pairs.append(
                FeedbackContextPair(
                    positive=positive_item.vector,
                    negative=negative_item.vector,
                    partial_computation=partial_computation,
                )
            )

    score = query.coefficients.a * calculate_distance_core(query.target, vectors, distance_type)

    for pair in context_pairs:
        sim_pos = calculate_distance_core(pair.positive, vectors, distance_type)
        sim_neg = calculate_distance_core(pair.negative, vectors, distance_type)
        delta = sim_pos - sim_neg

        score += pair.partial_computation * delta

    return score
