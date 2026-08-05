# Inference code generated from the JSON schema spec in @huggingface/tasks.
#
# See:
#   - script: https://github.com/huggingface/huggingface.js/blob/main/packages/tasks/scripts/inference-codegen.ts
#   - specs:  https://github.com/huggingface/huggingface.js/tree/main/packages/tasks/src/tasks.
from typing import Any, Literal, Union

from .base import BaseInferenceType, dataclass_with_extra


TextToAudioEarlyStoppingEnum = Literal["never"]


@dataclass_with_extra
class TextToAudioGenerationParameters(BaseInferenceType):
    """Parametrization of the text generation process"""

    do_sample: bool | None = None
    """Whether to use sampling instead of greedy decoding when generating new tokens."""
    early_stopping: Union[bool, "TextToAudioEarlyStoppingEnum"] | None = None
    """Controls the stopping condition for beam-based methods."""
    epsilon_cutoff: float | None = None
    """If set to float strictly between 0 and 1, only tokens with a conditional probability
    greater than epsilon_cutoff will be sampled. In the paper, suggested values range from
    3e-4 to 9e-4, depending on the size of the model. See [Truncation Sampling as Language
    Model Desmoothing](https://hf.co/papers/2210.15191) for more details.
    """
    eta_cutoff: float | None = None
    """Eta sampling is a hybrid of locally typical sampling and epsilon sampling. If set to
    float strictly between 0 and 1, a token is only considered if it is greater than either
    eta_cutoff or sqrt(eta_cutoff) * exp(-entropy(softmax(next_token_logits))). The latter
    term is intuitively the expected next token probability, scaled by sqrt(eta_cutoff). In
    the paper, suggested values range from 3e-4 to 2e-3, depending on the size of the model.
    See [Truncation Sampling as Language Model Desmoothing](https://hf.co/papers/2210.15191)
    for more details.
    """
    max_length: int | None = None
    """The maximum length (in tokens) of the generated text, including the input."""
    max_new_tokens: int | None = None
    """The maximum number of tokens to generate. Takes precedence over max_length."""
    min_length: int | None = None
    """The minimum length (in tokens) of the generated text, including the input."""
    min_new_tokens: int | None = None
    """The minimum number of tokens to generate. Takes precedence over min_length."""
    num_beam_groups: int | None = None
    """Number of groups to divide num_beams into in order to ensure diversity among different
    groups of beams. See [this paper](https://hf.co/papers/1610.02424) for more details.
    """
    num_beams: int | None = None
    """Number of beams to use for beam search."""
    penalty_alpha: float | None = None
    """The value balances the model confidence and the degeneration penalty in contrastive
    search decoding.
    """
    temperature: float | None = None
    """The value used to modulate the next token probabilities."""
    top_k: int | None = None
    """The number of highest probability vocabulary tokens to keep for top-k-filtering."""
    top_p: float | None = None
    """If set to float < 1, only the smallest set of most probable tokens with probabilities
    that add up to top_p or higher are kept for generation.
    """
    typical_p: float | None = None
    """Local typicality measures how similar the conditional probability of predicting a target
    token next is to the expected conditional probability of predicting a random token next,
    given the partial text already generated. If set to float < 1, the smallest set of the
    most locally typical tokens with probabilities that add up to typical_p or higher are
    kept for generation. See [this paper](https://hf.co/papers/2202.00666) for more details.
    """
    use_cache: bool | None = None
    """Whether the model should use the past last key/values attentions to speed up decoding"""


@dataclass_with_extra
class TextToAudioParameters(BaseInferenceType):
    """Additional inference parameters for Text To Audio"""

    generation_parameters: TextToAudioGenerationParameters | None = None
    """Parametrization of the text generation process"""


@dataclass_with_extra
class TextToAudioInput(BaseInferenceType):
    """Inputs for Text To Audio inference"""

    inputs: str
    """The input text data"""
    parameters: TextToAudioParameters | None = None
    """Additional inference parameters for Text To Audio"""


@dataclass_with_extra
class TextToAudioOutput(BaseInferenceType):
    """Outputs of inference for the Text To Audio task"""

    audio: Any
    """The generated audio waveform."""
    sampling_rate: float
    """The sampling rate of the generated audio waveform."""
