# Inference code generated from the JSON schema spec in @huggingface/tasks.
#
# See:
#   - script: https://github.com/huggingface/huggingface.js/blob/main/packages/tasks/scripts/inference-codegen.ts
#   - specs:  https://github.com/huggingface/huggingface.js/tree/main/packages/tasks/src/tasks.
from typing import Any, Literal

from .base import BaseInferenceType, dataclass_with_extra


TypeEnum = Literal["json", "regex", "json_schema"]


@dataclass_with_extra
class TextGenerationInputGrammarType(BaseInferenceType):
    type: "TypeEnum"
    value: Any
    """A string that represents a [JSON Schema](https://json-schema.org/).
    JSON Schema is a declarative language that allows to annotate JSON documents
    with types and descriptions.
    """


@dataclass_with_extra
class TextGenerationInputGenerateParameters(BaseInferenceType):
    adapter_id: str | None = None
    """Lora adapter id"""
    best_of: int | None = None
    """Generate best_of sequences and return the one if the highest token logprobs."""
    decoder_input_details: bool | None = None
    """Whether to return decoder input token logprobs and ids."""
    details: bool | None = None
    """Whether to return generation details."""
    do_sample: bool | None = None
    """Activate logits sampling."""
    frequency_penalty: float | None = None
    """The parameter for frequency penalty. 1.0 means no penalty
    Penalize new tokens based on their existing frequency in the text so far,
    decreasing the model's likelihood to repeat the same line verbatim.
    """
    grammar: TextGenerationInputGrammarType | None = None
    max_new_tokens: int | None = None
    """Maximum number of tokens to generate."""
    repetition_penalty: float | None = None
    """The parameter for repetition penalty. 1.0 means no penalty.
    See [this paper](https://arxiv.org/pdf/1909.05858.pdf) for more details.
    """
    return_full_text: bool | None = None
    """Whether to prepend the prompt to the generated text"""
    seed: int | None = None
    """Random sampling seed."""
    stop: list[str] | None = None
    """Stop generating tokens if a member of `stop` is generated."""
    temperature: float | None = None
    """The value used to module the logits distribution."""
    top_k: int | None = None
    """The number of highest probability vocabulary tokens to keep for top-k-filtering."""
    top_n_tokens: int | None = None
    """The number of highest probability vocabulary tokens to keep for top-n-filtering."""
    top_p: float | None = None
    """Top-p value for nucleus sampling."""
    truncate: int | None = None
    """Truncate inputs tokens to the given size."""
    typical_p: float | None = None
    """Typical Decoding mass
    See [Typical Decoding for Natural Language Generation](https://arxiv.org/abs/2202.00666)
    for more information.
    """
    watermark: bool | None = None
    """Watermarking with [A Watermark for Large Language
    Models](https://arxiv.org/abs/2301.10226).
    """


@dataclass_with_extra
class TextGenerationInput(BaseInferenceType):
    """Text Generation Input.
    Auto-generated from TGI specs.
    For more details, check out
    https://github.com/huggingface/huggingface.js/blob/main/packages/tasks/scripts/inference-tgi-import.ts.
    """

    inputs: str
    parameters: TextGenerationInputGenerateParameters | None = None
    stream: bool | None = None


TextGenerationOutputFinishReason = Literal["length", "eos_token", "stop_sequence"]


@dataclass_with_extra
class TextGenerationOutputPrefillToken(BaseInferenceType):
    id: int
    logprob: float
    text: str


@dataclass_with_extra
class TextGenerationOutputToken(BaseInferenceType):
    id: int
    logprob: float
    special: bool
    text: str


@dataclass_with_extra
class TextGenerationOutputBestOfSequence(BaseInferenceType):
    finish_reason: "TextGenerationOutputFinishReason"
    generated_text: str
    generated_tokens: int
    prefill: list[TextGenerationOutputPrefillToken]
    tokens: list[TextGenerationOutputToken]
    seed: int | None = None
    top_tokens: list[list[TextGenerationOutputToken]] | None = None


@dataclass_with_extra
class TextGenerationOutputDetails(BaseInferenceType):
    finish_reason: "TextGenerationOutputFinishReason"
    generated_tokens: int
    prefill: list[TextGenerationOutputPrefillToken]
    tokens: list[TextGenerationOutputToken]
    best_of_sequences: list[TextGenerationOutputBestOfSequence] | None = None
    seed: int | None = None
    top_tokens: list[list[TextGenerationOutputToken]] | None = None


@dataclass_with_extra
class TextGenerationOutput(BaseInferenceType):
    """Text Generation Output.
    Auto-generated from TGI specs.
    For more details, check out
    https://github.com/huggingface/huggingface.js/blob/main/packages/tasks/scripts/inference-tgi-import.ts.
    """

    generated_text: str
    details: TextGenerationOutputDetails | None = None


@dataclass_with_extra
class TextGenerationStreamOutputStreamDetails(BaseInferenceType):
    finish_reason: "TextGenerationOutputFinishReason"
    generated_tokens: int
    input_length: int
    seed: int | None = None


@dataclass_with_extra
class TextGenerationStreamOutputToken(BaseInferenceType):
    id: int
    logprob: float
    special: bool
    text: str


@dataclass_with_extra
class TextGenerationStreamOutput(BaseInferenceType):
    """Text Generation Stream Output.
    Auto-generated from TGI specs.
    For more details, check out
    https://github.com/huggingface/huggingface.js/blob/main/packages/tasks/scripts/inference-tgi-import.ts.
    """

    index: int
    token: TextGenerationStreamOutputToken
    details: TextGenerationStreamOutputStreamDetails | None = None
    generated_text: str | None = None
    top_tokens: list[TextGenerationStreamOutputToken] | None = None
