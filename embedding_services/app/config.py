from __future__ import annotations

import os
from dataclasses import dataclass

MODEL_NAME = "hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B"
MODEL_VERSION = "visual-embedding-clipa-v2-h14"
EMBEDDING_DIMENSIONS = 1024


def _optional_env(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def _positive_int(name: str, fallback: int) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        return fallback
    try:
        parsed = int(value)
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


@dataclass(frozen=True, slots=True)
class ServiceSettings:
    host: str = "0.0.0.0"
    port: int = 8001
    token: str | None = None
    model_name: str = MODEL_NAME
    model_version: str = MODEL_VERSION
    dimensions: int = EMBEDDING_DIMENSIONS
    device: str = "auto"
    max_text_chars: int = 2000
    max_image_bytes: int = 12 * 1024 * 1024
    model_cache_dir: str = "/models/huggingface"

    @classmethod
    def from_env(cls) -> ServiceSettings:
        device = _optional_env("EMBEDDING_DEVICE") or "auto"
        if device not in {"auto", "cpu", "cuda"}:
            device = "auto"
        return cls(
            host=_optional_env("EMBEDDING_HOST") or "0.0.0.0",
            port=_positive_int("EMBEDDING_PORT", 8001),
            token=_optional_env("EMBEDDING_TOKEN"),
            model_name=_optional_env("EMBEDDING_MODEL_NAME") or MODEL_NAME,
            model_version=_optional_env("EMBEDDING_MODEL_VERSION") or MODEL_VERSION,
            dimensions=EMBEDDING_DIMENSIONS,
            device=device,
            max_text_chars=min(_positive_int("EMBEDDING_MAX_TEXT_CHARS", 2000), 2000),
            max_image_bytes=min(_positive_int("EMBEDDING_MAX_IMAGE_BYTES", 12 * 1024 * 1024), 12 * 1024 * 1024),
            model_cache_dir=_optional_env("EMBEDDING_MODEL_CACHE_DIR") or "/models/huggingface",
        )
