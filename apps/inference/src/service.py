"""Dependency-light inference boundary used by the internal HTTP adapter.

The deterministic encoder is deliberately a development implementation.  It
lets the complete retrieval path run offline while preserving the same model
revision and vector-shape checks required by a production encoder.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping


def _required_text(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value.strip()


@dataclass(frozen=True)
class EncodeTextRequest:
    request_id: str
    text: str
    model_family: str
    model_revision: str
    deadline_ms: int

    def __post_init__(self) -> None:
        for value, field in (
            (self.request_id, "request_id"),
            (self.text, "text"),
            (self.model_family, "model_family"),
            (self.model_revision, "model_revision"),
        ):
            _required_text(value, field)
        if isinstance(self.deadline_ms, bool) or not isinstance(self.deadline_ms, int):
            raise ValueError("deadline_ms must be an integer")
        if not 1 <= self.deadline_ms <= 30_000:
            raise ValueError("deadline_ms must be between 1 and 30000")


@dataclass(frozen=True)
class EncodeTextResponse:
    request_id: str
    model_family: str
    model_revision: str
    status: str
    dimension: int
    dtype: str
    embedding: tuple[float, ...]


class InferenceService:
    """Allow-listed, version-strict model registry and text encoder."""

    def __init__(
        self,
        *,
        allowed_models: Mapping[str, str],
        dimensions: Mapping[str, int],
    ) -> None:
        if set(allowed_models) != set(dimensions):
            raise ValueError("every allowed model must have one configured dimension")
        if any(value < 1 for value in dimensions.values()):
            raise ValueError("model dimensions must be positive")
        self._allowed_models = MappingProxyType(dict(allowed_models))
        self._dimensions = MappingProxyType(dict(dimensions))

    def encode_text(self, request: EncodeTextRequest) -> EncodeTextResponse:
        expected_revision = self._allowed_models.get(request.model_family)
        if expected_revision is None:
            raise ValueError("model_family is not enabled")
        if request.model_revision != expected_revision:
            raise ValueError("model_revision does not match the active registry")
        dimension = self._dimensions[request.model_family]
        embedding = _hash_embedding(request.text, dimension)
        return EncodeTextResponse(
            request_id=request.request_id,
            model_family=request.model_family,
            model_revision=request.model_revision,
            status="completed",
            dimension=dimension,
            dtype="float32",
            embedding=embedding,
        )


def _hash_embedding(text: str, dimension: int) -> tuple[float, ...]:
    normalized = " ".join(text.casefold().split()).encode("utf-8")
    values: list[float] = []
    counter = 0
    while len(values) < dimension:
        digest = hashlib.sha256(normalized + counter.to_bytes(4, "big")).digest()
        values.extend((byte - 127.5) / 127.5 for byte in digest)
        counter += 1
    selected = values[:dimension]
    norm = math.sqrt(sum(value * value for value in selected))
    return tuple(value / norm for value in selected)
