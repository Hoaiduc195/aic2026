"""File IO for timeline-aligned ASR spans."""

from __future__ import annotations

import json
import unicodedata
from collections.abc import Iterable
from pathlib import Path

from pipelines.feature_extraction.asr.models import AsrResult, TranscriptChunk

ASR_COLUMNS = (
    "video_id", "start_ms", "end_ms", "text_raw", "text_normalized", "language", "confidence"
)
ASR_DTYPES = {
    "video_id": "string",
    "start_ms": "int64",
    "end_ms": "int64",
    "text_raw": "string",
    "text_normalized": "string",
    "language": "string",
    "confidence": "float64",
}


def write_asr_results_jsonl(results: Iterable[AsrResult], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for result in results:
            file.write(json.dumps(result.to_dict(), ensure_ascii=False) + "\n")
    return path


def write_canonical_asr_jsonl(
    chunks: Iterable[TranscriptChunk],
    path: Path,
    *,
    video_id: str,
    model_version: str,
    producer: str = "sherpa-vietnamese-asr",
    pipeline_version: str = "asr-cli-v1",
) -> Path:
    """Write one canonical interval record per transcript chunk."""

    results = (
        _asr_result(
            chunk,
            video_id=video_id,
            model_version=model_version,
            producer=producer,
            pipeline_version=pipeline_version,
        )
        for chunk in chunks
    )
    return write_asr_results_jsonl(results, path)


def write_asr_results_json(results: Iterable[AsrResult], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = [result.to_dict() for result in results]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_asr_results_parquet(results: Iterable[AsrResult], path: Path) -> Path:
    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError("Install pandas and pyarrow to write Parquet output") from exc

    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [result.to_dict() for result in results]
    if rows:
        frame = pd.DataFrame(rows, columns=ASR_COLUMNS).astype(ASR_DTYPES)
    else:
        frame = pd.DataFrame(
            {column: pd.Series(dtype=ASR_DTYPES[column]) for column in ASR_COLUMNS}
        )
    frame.to_parquet(path, index=False)
    return path


def _asr_result(
    chunk: TranscriptChunk,
    *,
    video_id: str,
    model_version: str,
    producer: str,
    pipeline_version: str,
) -> AsrResult:
    return AsrResult(
        video_id=video_id,
        start_ms=chunk.start_ms,
        end_ms=chunk.end_ms,
        text_raw=_normalize_text(chunk.text_raw if chunk.text_raw is not None else chunk.text),
        text_normalized=_normalize_text(chunk.text),
        language=chunk.language,
        confidence=chunk.confidence,
        producer=producer,
        model_version=model_version,
        pipeline_version=pipeline_version,
        words=chunk.words,
        no_speech_probability=chunk.no_speech_probability,
        quality=chunk.quality,
    )


def chunks_to_results(
    chunks: Iterable[TranscriptChunk],
    *,
    video_id: str,
    model_version: str,
    producer: str = "asr",
    pipeline_version: str = "asr-v1",
) -> list[AsrResult]:
    return [
        _asr_result(
            chunk,
            video_id=video_id,
            model_version=model_version,
            producer=producer,
            pipeline_version=pipeline_version,
        )
        for chunk in chunks
        if chunk.text.strip()
    ]


def _normalize_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())
