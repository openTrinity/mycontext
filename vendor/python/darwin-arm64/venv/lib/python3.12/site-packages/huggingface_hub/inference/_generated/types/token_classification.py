# Inference code generated from the JSON schema spec in @huggingface/tasks.
#
# See:
#   - script: https://github.com/huggingface/huggingface.js/blob/main/packages/tasks/scripts/inference-codegen.ts
#   - specs:  https://github.com/huggingface/huggingface.js/tree/main/packages/tasks/src/tasks.
from typing import Literal, Optional

from .base import BaseInferenceType, dataclass_with_extra


TokenClassificationAggregationStrategy = Literal["none", "simple", "first", "average", "max"]


@dataclass_with_extra
class TokenClassificationParameters(BaseInferenceType):
    """Additional inference parameters for Token Classification"""

    aggregation_strategy: Optional["TokenClassificationAggregationStrategy"] = None
    """The strategy used to fuse tokens based on model predictions"""
    ignore_labels: list[str] | None = None
    """A list of labels to ignore"""
    stride: int | None = None
    """The number of overlapping tokens between chunks when splitting the input text."""


@dataclass_with_extra
class TokenClassificationInput(BaseInferenceType):
    """Inputs for Token Classification inference"""

    inputs: str
    """The input text data"""
    parameters: TokenClassificationParameters | None = None
    """Additional inference parameters for Token Classification"""


@dataclass_with_extra
class TokenClassificationOutputElement(BaseInferenceType):
    """Outputs of inference for the Token Classification task"""

    end: int
    """The character position in the input where this group ends."""
    score: float
    """The associated score / probability"""
    start: int
    """The character position in the input where this group begins."""
    word: str
    """The corresponding text"""
    entity: str | None = None
    """The predicted label for a single token"""
    entity_group: str | None = None
    """The predicted label for a group of one or more tokens"""
