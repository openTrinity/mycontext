# Inference code generated from the JSON schema spec in @huggingface/tasks.
#
# See:
#   - script: https://github.com/huggingface/huggingface.js/blob/main/packages/tasks/scripts/inference-codegen.ts
#   - specs:  https://github.com/huggingface/huggingface.js/tree/main/packages/tasks/src/tasks.
from typing import Any

from .base import BaseInferenceType, dataclass_with_extra


@dataclass_with_extra
class ImageTextToImageTargetSize(BaseInferenceType):
    """The size in pixels of the output image. This parameter is only supported by some
    providers and for specific models. It will be ignored when unsupported.
    """

    height: int
    width: int


@dataclass_with_extra
class ImageTextToImageParameters(BaseInferenceType):
    """Additional inference parameters for Image Text To Image"""

    guidance_scale: float | None = None
    """For diffusion models. A higher guidance scale value encourages the model to generate
    images closely linked to the text prompt at the expense of lower image quality.
    """
    negative_prompt: str | None = None
    """One prompt to guide what NOT to include in image generation."""
    num_inference_steps: int | None = None
    """For diffusion models. The number of denoising steps. More denoising steps usually lead to
    a higher quality image at the expense of slower inference.
    """
    prompt: str | None = None
    """The text prompt to guide the image generation. Either this or inputs (image) must be
    provided.
    """
    seed: int | None = None
    """Seed for the random number generator."""
    target_size: ImageTextToImageTargetSize | None = None
    """The size in pixels of the output image. This parameter is only supported by some
    providers and for specific models. It will be ignored when unsupported.
    """


@dataclass_with_extra
class ImageTextToImageInput(BaseInferenceType):
    """Inputs for Image Text To Image inference. Either inputs (image) or prompt (in parameters)
    must be provided, or both.
    """

    inputs: str | None = None
    """The input image data as a base64-encoded string. If no `parameters` are provided, you can
    also provide the image data as a raw bytes payload. Either this or prompt must be
    provided.
    """
    parameters: ImageTextToImageParameters | None = None
    """Additional inference parameters for Image Text To Image"""


@dataclass_with_extra
class ImageTextToImageOutput(BaseInferenceType):
    """Outputs of inference for the Image Text To Image task"""

    image: Any
    """The generated image returned as raw bytes in the payload."""
