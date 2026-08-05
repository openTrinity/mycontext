from qdrant_client.http import models

INFERENCE_OBJECT_NAMES: set[str] = {"Document", "Image", "InferenceObject"}
INFERENCE_OBJECT_TYPES = models.Document | models.Image | models.InferenceObject
