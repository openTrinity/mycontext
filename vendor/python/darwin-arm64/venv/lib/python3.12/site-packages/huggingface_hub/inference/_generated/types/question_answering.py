# Inference code generated from the JSON schema spec in @huggingface/tasks.
#
# See:
#   - script: https://github.com/huggingface/huggingface.js/blob/main/packages/tasks/scripts/inference-codegen.ts
#   - specs:  https://github.com/huggingface/huggingface.js/tree/main/packages/tasks/src/tasks.
from .base import BaseInferenceType, dataclass_with_extra


@dataclass_with_extra
class QuestionAnsweringInputData(BaseInferenceType):
    """One (context, question) pair to answer"""

    context: str
    """The context to be used for answering the question"""
    question: str
    """The question to be answered"""


@dataclass_with_extra
class QuestionAnsweringParameters(BaseInferenceType):
    """Additional inference parameters for Question Answering"""

    align_to_words: bool | None = None
    """Attempts to align the answer to real words. Improves quality on space separated
    languages. Might hurt on non-space-separated languages (like Japanese or Chinese)
    """
    doc_stride: int | None = None
    """If the context is too long to fit with the question for the model, it will be split in
    several chunks with some overlap. This argument controls the size of that overlap.
    """
    handle_impossible_answer: bool | None = None
    """Whether to accept impossible as an answer."""
    max_answer_len: int | None = None
    """The maximum length of predicted answers (e.g., only answers with a shorter length are
    considered).
    """
    max_question_len: int | None = None
    """The maximum length of the question after tokenization. It will be truncated if needed."""
    max_seq_len: int | None = None
    """The maximum length of the total sentence (context + question) in tokens of each chunk
    passed to the model. The context will be split in several chunks (using docStride as
    overlap) if needed.
    """
    top_k: int | None = None
    """The number of answers to return (will be chosen by order of likelihood). Note that we
    return less than topk answers if there are not enough options available within the
    context.
    """


@dataclass_with_extra
class QuestionAnsweringInput(BaseInferenceType):
    """Inputs for Question Answering inference"""

    inputs: QuestionAnsweringInputData
    """One (context, question) pair to answer"""
    parameters: QuestionAnsweringParameters | None = None
    """Additional inference parameters for Question Answering"""


@dataclass_with_extra
class QuestionAnsweringOutputElement(BaseInferenceType):
    """Outputs of inference for the Question Answering task"""

    answer: str
    """The answer to the question."""
    end: int
    """The character position in the input where the answer ends."""
    score: float
    """The probability associated to the answer."""
    start: int
    """The character position in the input where the answer begins."""
