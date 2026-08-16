"""ASR preprocessing module.

The module transcribes one audio stream per video and writes timeline-only
records matching ``contracts/schemas/asr_result``.
"""

from pipelines.feature_extraction.asr.models import (
    AsrResult,
    QualityInfo,
    TranscriptChunk,
    WordTiming,
)
from pipelines.feature_extraction.asr.transcriber import (
    JsonTranscriptBackend,
    WhisperBackend,
)

__all__ = [
    "AsrResult",
    "JsonTranscriptBackend",
    "QualityInfo",
    "TranscriptChunk",
    "WhisperBackend",
    "WordTiming",
]
