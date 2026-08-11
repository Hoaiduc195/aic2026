"""File IO for ASR pipeline inputs and outputs."""

from __future__ import annotations

import json
import os
import tempfile
import unicodedata
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from pipelines.feature_extraction.asr.models import AsrResult, Segment, TranscriptChunk

ASR_COLUMNS = (
    "video_id", "segment_id", "asr_start_ms", "asr_end_ms", "text", "confidence"
)
ASR_DTYPES = {
    "video_id": "string",
    "segment_id": "string",
    "asr_start_ms": "int64",
    "asr_end_ms": "int64",
    "text": "string",
    "confidence": "float64",
}


def read_segments_json(path: Path) -> list[Segment]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    rows = raw["segments"] if isinstance(raw, dict) and "segments" in raw else raw
    if not isinstance(rows, list):
        raise TypeError("segments JSON must be a list or an object with segments")
    return [Segment(**_segment_kwargs(row)) for row in rows]


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
    """Write one canonical ``asr_result`` object per transcript chunk."""

    if not video_id.strip():
        raise ValueError("video_id must be non-empty")
    if not model_version.strip():
        raise ValueError("model_version must be non-empty")

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as file:
            temporary_path = Path(file.name)
            for index, chunk in enumerate(chunks, start=1):
                file.write(
                    json.dumps(
                        _canonical_row(
                            chunk,
                            video_id=video_id,
                            segment_id=f"{video_id}_asr_{index:06d}",
                            model_version=model_version,
                            producer=producer,
                            pipeline_version=pipeline_version,
                        ),
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
    return path


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


def _segment_kwargs(row: Any) -> dict[str, Any]:
    if not isinstance(row, dict):
        raise TypeError("segment row must be an object")
    return {
        "video_id": row["video_id"],
        "segment_id": row["segment_id"],
        "segment_start_ms": int(row["segment_start_ms"]),
        "segment_end_ms": int(row["segment_end_ms"]),
        "source": row.get("source", "segments_json"),
        "confidence": float(row.get("confidence", 1.0)),
    }


def _canonical_row(
    chunk: TranscriptChunk,
    *,
    video_id: str,
    segment_id: str,
    model_version: str,
    producer: str,
    pipeline_version: str,
) -> dict[str, Any]:
    text_raw = _normalize_text(chunk.text_raw if chunk.text_raw is not None else chunk.text)
    text_normalized = _normalize_text(chunk.text)
    row: dict[str, Any] = {
        "video_id": video_id,
        "segment_id": segment_id,
        "start_ms": chunk.start_ms,
        "end_ms": chunk.end_ms,
        "text_raw": text_raw,
        "text_normalized": text_normalized,
        "text": text_normalized,
        "language": chunk.language,
        "confidence": chunk.confidence,
        "producer": producer,
        "model_version": model_version,
        "pipeline_version": pipeline_version,
        "schema_version": "1.0.0",
    }
    if chunk.words:
        row["words"] = [word.to_dict() for word in chunk.words]
    if chunk.no_speech_probability is not None:
        row["no_speech_probability"] = chunk.no_speech_probability
    if chunk.quality is not None:
        row["quality"] = chunk.quality.to_dict()
    return row


def _normalize_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())
