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
class WordTiming:
    """Word-level timing and confidence emitted by the Sherpa pipeline."""

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
        if not isinstance(self.language, str) or not self.language.strip():
            raise ValueError("language must be a non-empty string")
        _require_optional_score(
            self.no_speech_probability, "no_speech_probability", 1.0
        )
        if self.quality is not None and not isinstance(self.quality, QualityInfo):
            raise ValueError("quality must be QualityInfo or null")
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
            raise TypeError("text must be a string")
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
