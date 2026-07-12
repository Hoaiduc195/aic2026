"""File IO for ASR pipeline inputs and outputs."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from pipelines.feature_extraction.asr.models import AsrResult, Segment

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
        raise ValueError("segments JSON must be a list or an object with segments")
    return [Segment(**_segment_kwargs(row)) for row in rows]


def write_asr_results_jsonl(results: Iterable[AsrResult], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for result in results:
            file.write(json.dumps(result.to_dict(), ensure_ascii=False) + "\n")
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
        raise ValueError("segment row must be an object")
    return {
        "video_id": row["video_id"],
        "segment_id": row["segment_id"],
        "segment_start_ms": int(row["segment_start_ms"]),
        "segment_end_ms": int(row["segment_end_ms"]),
        "source": row.get("source", "segments_json"),
        "confidence": float(row.get("confidence", 1.0)),
    }
