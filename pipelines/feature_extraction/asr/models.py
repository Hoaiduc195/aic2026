"""Immutable data models for ASR preprocessing."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


def _require_non_empty(value: str, field_name: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field_name} must be a non-empty string")


def _require_milliseconds(value: int, field_name: str) -> None:
    if not isinstance(value, int) or value < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")


def _require_confidence(value: float, field_name: str = "confidence") -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
        or value > 1
    ):
        raise ValueError(f"{field_name} must be a number between 0 and 1")


@dataclass(frozen=True)
class Segment:
    """Video segment used as the temporal target for ASR chunks."""

    video_id: str
    segment_id: str
    segment_start_ms: int
    segment_end_ms: int
    source: str = "asr_mapper"
    confidence: float = 1.0

    def __post_init__(self) -> None:
        _require_non_empty(self.video_id, "video_id")
        _require_non_empty(self.segment_id, "segment_id")
        _require_milliseconds(self.segment_start_ms, "segment_start_ms")
        _require_milliseconds(self.segment_end_ms, "segment_end_ms")
        _require_non_empty(self.source, "source")
        _require_confidence(self.confidence)
        if self.segment_end_ms <= self.segment_start_ms:
            raise ValueError("segment_end_ms must be greater than segment_start_ms")


@dataclass(frozen=True)
class TranscriptChunk:
    """Timestamped text emitted by an ASR backend."""

    start_ms: int
    end_ms: int
    text: str
    confidence: float = 1.0

    def __post_init__(self) -> None:
        _require_milliseconds(self.start_ms, "start_ms")
        _require_milliseconds(self.end_ms, "end_ms")
        if not isinstance(self.text, str):
            raise ValueError("text must be a string")
        _require_confidence(self.confidence)
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")


@dataclass(frozen=True)
class AsrResult:
    """Contract-compatible ASR output row."""

    video_id: str
    segment_id: str
    asr_start_ms: int
    asr_end_ms: int
    text: str
    confidence: float

    def __post_init__(self) -> None:
        _require_non_empty(self.video_id, "video_id")
        _require_non_empty(self.segment_id, "segment_id")
        _require_milliseconds(self.asr_start_ms, "asr_start_ms")
        _require_milliseconds(self.asr_end_ms, "asr_end_ms")
        if not isinstance(self.text, str):
            raise ValueError("text must be a string")
        _require_confidence(self.confidence)
        if self.asr_end_ms <= self.asr_start_ms:
            raise ValueError("asr_end_ms must be greater than asr_start_ms")

    def to_dict(self) -> dict[str, Any]:
        return {
            "video_id": self.video_id,
            "segment_id": self.segment_id,
            "asr_start_ms": self.asr_start_ms,
            "asr_end_ms": self.asr_end_ms,
            "text": self.text,
            "confidence": self.confidence,
        }
