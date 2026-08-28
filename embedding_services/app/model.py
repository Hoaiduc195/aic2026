from __future__ import annotations

import math
import os
from collections.abc import Sequence
from typing import Protocol

from .config import ServiceSettings


class TextEmbeddingEncoder(Protocol):
    model_name: str
    model_version: str
    dimensions: int
    device: str

    def embed_text(self, text: str) -> Sequence[float]: ...

    def embed_image(self, image: bytes, mime_type: str) -> Sequence[float]: ...

    def embed_images(self, images: Sequence[tuple[bytes, str]]) -> Sequence[Sequence[float]]: ...


def validate_embedding(values: Sequence[float], dimensions: int) -> list[float]:
    """Validate the fixed CLIPA query-vector contract and return a new list."""

    if len(values) != dimensions:
        raise ValueError(f"embedding must contain {dimensions} values")
    result = [float(value) for value in values]
    if not all(math.isfinite(value) for value in result):
        raise ValueError("embedding contains a non-finite value")
    norm = math.sqrt(sum(value * value for value in result))
    if not math.isfinite(norm) or not math.isclose(norm, 1.0, rel_tol=0.0, abs_tol=2e-3):
        raise ValueError("embedding must be L2-normalized")
    return result


class OpenClipTextEncoder:
    """Lazy OpenCLIP text encoder using the same checkpoint as image embeddings."""

    def __init__(
        self,
        model: object,
        tokenizer: object,
        preprocess: object,
        torch_module: object,
        device: object,
        settings: ServiceSettings,
    ) -> None:
        self._model = model
        self._tokenizer = tokenizer
        self._preprocess = preprocess
        self._torch = torch_module
        self._device = device
        self.model_name = settings.model_name
        self.model_version = settings.model_version
        self.dimensions = settings.dimensions
        self.device = str(device)

    @classmethod
    def from_settings(cls, settings: ServiceSettings) -> OpenClipTextEncoder:
        # The model weights are downloaded at runtime into a mounted cache, never baked into the image.
        os.environ.setdefault("HF_HOME", settings.model_cache_dir)
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", f"{settings.model_cache_dir}/hub")
        os.environ.setdefault("TORCH_HOME", settings.model_cache_dir)

        import open_clip
        import torch

        if settings.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("EMBEDDING_DEVICE=cuda nhưng CUDA không khả dụng")
        device_name = "cuda" if settings.device == "cuda" or (
            settings.device == "auto" and torch.cuda.is_available()
        ) else "cpu"
        device = torch.device(device_name)
        if settings.pretrained:
            model, _, preprocess = open_clip.create_model_and_transforms(
                settings.model_name,
                pretrained=settings.pretrained,
                device=device,
            )
        else:
            model, preprocess = open_clip.create_model_from_pretrained(settings.model_name, device=device)
        model.eval()
        tokenizer = open_clip.get_tokenizer(settings.model_name)
        return cls(model, tokenizer, preprocess, torch, device, settings)

    def embed_text(self, text: str) -> list[float]:
        torch = self._torch
        tokens = self._tokenizer([text]).to(self._device)
        with torch.inference_mode():
            features = self._model.encode_text(tokens)
            normalized = torch.nn.functional.normalize(features.float(), dim=-1)
        matrix = normalized.detach().cpu().numpy()
        if matrix.ndim != 2 or matrix.shape != (1, self.dimensions):
            raise ValueError(f"model returned shape {matrix.shape}, expected (1, {self.dimensions})")
        return matrix[0].astype("float32", copy=False).tolist()

    def embed_image(self, image: bytes, mime_type: str) -> list[float]:
        return self.embed_images([(image, mime_type)])[0]

    def embed_images(self, images: Sequence[tuple[bytes, str]]) -> list[list[float]]:
        from io import BytesIO

        from PIL import Image

        if not images:
            raise ValueError("images must not be empty")
        decoded = []
        for image, mime_type in images:
            del mime_type
            with Image.open(BytesIO(image)) as opened:
                decoded.append(self._preprocess(opened.convert("RGB")))
        torch = self._torch
        tensor = torch.stack(decoded).to(self._device)
        with torch.inference_mode():
            features = self._model.encode_image(tensor)
            normalized = torch.nn.functional.normalize(features.float(), dim=-1)
        matrix = normalized.detach().cpu().numpy()
        expected_shape = (len(images), self.dimensions)
        if matrix.ndim != 2 or matrix.shape != expected_shape:
            raise ValueError(f"model returned shape {matrix.shape}, expected {expected_shape}")
        return matrix.astype("float32", copy=False).tolist()
