"""ASR preprocessing module.

The module transcribes one audio stream per video, maps transcript chunks onto
segment IDs, and writes records matching ``contracts/schemas/asr_result``.
"""

from pipelines.feature_extraction.asr.models import (
    AsrResult,
    QualityInfo,
    Segment,
    TranscriptChunk,
    WordTiming,
)
from pipelines.feature_extraction.asr.refactor import (
    ASR_SPAN_COLUMNS,
    RefactorValidationError,
    normalize_text,
    parse_legacy_file,
    refactor_dataset,
)
from pipelines.feature_extraction.asr.segment_mapping import map_transcripts_to_segments
from pipelines.feature_extraction.asr.transcriber import (
    JsonTranscriptBackend,
    WhisperBackend,
)

__all__ = [
    "ASR_SPAN_COLUMNS",
    "AsrResult",
    "JsonTranscriptBackend",
    "QualityInfo",
    "RefactorValidationError",
    "Segment",
    "TranscriptChunk",
    "WhisperBackend",
    "WordTiming",
    "map_transcripts_to_segments",
    "normalize_text",
    "parse_legacy_file",
    "refactor_dataset",
]
