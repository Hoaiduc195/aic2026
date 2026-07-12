"""ASR preprocessing module.

The module transcribes one audio stream per video, maps transcript chunks onto
segment IDs, and writes records matching ``contracts/schemas/asr_result``.
"""

from pipelines.feature_extraction.asr.models import AsrResult, Segment, TranscriptChunk
from pipelines.feature_extraction.asr.segment_mapping import map_transcripts_to_segments
from pipelines.feature_extraction.asr.transcriber import JsonTranscriptBackend, WhisperBackend

__all__ = [
    "AsrResult",
    "JsonTranscriptBackend",
    "Segment",
    "TranscriptChunk",
    "WhisperBackend",
    "map_transcripts_to_segments",
]
