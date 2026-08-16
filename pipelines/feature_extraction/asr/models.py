"""Immutable data models for ASR preprocessing."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


def _require_non_empty(value: str, field_name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")


def _require_milliseconds(value: int, field_name: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
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


def _require_optional_score(value: float | None, field_name: str, maximum: float) -> None:
    if value is None:
        return
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
        or value > maximum
    ):
        raise ValueError(f"{field_name} must be between 0 and {maximum}")


@dataclass(frozen=True)
class WordTiming:
    """Word-level timing and confidence emitted by an ASR backend."""

    text: str
    start_ms: int
    end_ms: int
    confidence: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("word text must be a non-empty string")
        _require_milliseconds(self.start_ms, "word.start_ms")
        _require_milliseconds(self.end_ms, "word.end_ms")
        _require_confidence(self.confidence, "word.confidence")
        if self.end_ms <= self.start_ms:
            raise ValueError("word.end_ms must be greater than word.start_ms")

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "confidence": self.confidence,
        }


@dataclass(frozen=True)
class QualityInfo:
    """Headless audio-quality summary attached to canonical ASR records."""

    asr_confidence: float | None = None
    dnsmos_sig: float | None = None
    dnsmos_bak: float | None = None
    dnsmos_ovrl: float | None = None
    ready: bool | None = None
    suggestions: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_optional_score(self.asr_confidence, "quality.asr_confidence", 1.0)
        _require_optional_score(self.dnsmos_sig, "quality.dnsmos_sig", 5.0)
        _require_optional_score(self.dnsmos_bak, "quality.dnsmos_bak", 5.0)
        _require_optional_score(self.dnsmos_ovrl, "quality.dnsmos_ovrl", 5.0)
        if self.ready is not None and not isinstance(self.ready, bool):
            raise ValueError("quality.ready must be a boolean or null")
        if not isinstance(self.suggestions, tuple) or not all(
            isinstance(item, str) for item in self.suggestions
        ):
            raise ValueError("quality.suggestions must be a tuple of strings")

    def to_dict(self) -> dict[str, Any]:
        return {
            "asr_confidence": self.asr_confidence,
            "dnsmos_sig": self.dnsmos_sig,
            "dnsmos_bak": self.dnsmos_bak,
            "dnsmos_ovrl": self.dnsmos_ovrl,
            "ready": self.ready,
            "suggestions": list(self.suggestions),
        }


@dataclass(frozen=True)
class TranscriptChunk:
    """Timestamped text emitted by an ASR backend."""

    start_ms: int
    end_ms: int
    text: str
    confidence: float = 1.0
    words: tuple[WordTiming, ...] = ()
    text_raw: str | None = None
    language: str = "vi"
    no_speech_probability: float | None = None
    quality: QualityInfo | None = None

    def __post_init__(self) -> None:
        _require_milliseconds(self.start_ms, "start_ms")
        _require_milliseconds(self.end_ms, "end_ms")
        if not isinstance(self.text, str):
            raise TypeError("text must be a string")
        _require_confidence(self.confidence)
        if not isinstance(self.words, tuple) or not all(
            isinstance(word, WordTiming) for word in self.words
        ):
            raise ValueError("words must be a tuple of WordTiming")
        if self.text_raw is not None and not isinstance(self.text_raw, str):
            raise ValueError("text_raw must be a string or null")
        _require_non_empty(self.language, "language")
        _require_optional_score(
            self.no_speech_probability, "no_speech_probability", 1.0
        )
        if self.quality is not None and not isinstance(self.quality, QualityInfo):
            raise ValueError("quality must be QualityInfo or null")
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")


@dataclass(frozen=True)
class AsrResult:
    """One interval of spoken content anchored only to the video timeline."""

    video_id: str
    start_ms: int
    end_ms: int
    text_raw: str
    text_normalized: str
    language: str
    confidence: float
    producer: str = "asr"
    model_version: str = "unknown"
    pipeline_version: str = "asr-v1"
    schema_version: str = "1.0.0"
    words: tuple[WordTiming, ...] = ()
    no_speech_probability: float | None = None
    quality: QualityInfo | None = None

    def __post_init__(self) -> None:
        _require_non_empty(self.video_id, "video_id")
        _require_milliseconds(self.start_ms, "start_ms")
        _require_milliseconds(self.end_ms, "end_ms")
        _require_non_empty(self.text_raw, "text_raw")
        _require_non_empty(self.text_normalized, "text_normalized")
        _require_non_empty(self.language, "language")
        _require_confidence(self.confidence)
        _require_non_empty(self.producer, "producer")
        _require_non_empty(self.model_version, "model_version")
        _require_non_empty(self.pipeline_version, "pipeline_version")
        _require_non_empty(self.schema_version, "schema_version")
        if not isinstance(self.words, tuple) or not all(
            isinstance(word, WordTiming) for word in self.words
        ):
            raise ValueError("words must be a tuple of WordTiming")
        _require_optional_score(self.no_speech_probability, "no_speech_probability", 1.0)
        if self.quality is not None and not isinstance(self.quality, QualityInfo):
            raise ValueError("quality must be QualityInfo or null")
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")

    def to_dict(self) -> dict[str, Any]:
        row: dict[str, Any] = {
            "video_id": self.video_id,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "text_raw": self.text_raw,
            "text_normalized": self.text_normalized,
            "language": self.language,
            "confidence": self.confidence,
            "producer": self.producer,
            "model_version": self.model_version,
            "pipeline_version": self.pipeline_version,
            "schema_version": self.schema_version,
        }
        if self.words:
            row["words"] = [word.to_dict() for word in self.words]
        if self.no_speech_probability is not None:
            row["no_speech_probability"] = self.no_speech_probability
        if self.quality is not None:
            row["quality"] = self.quality.to_dict()
        return row
