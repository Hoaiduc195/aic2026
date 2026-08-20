"""Normalize PaddleOCR JSONL output into a frame-first refined artifact."""

from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

OCR_SCHEMA_VERSION = "1.0.0"
OCR_PRODUCER = "paddleocr"
OCR_PIPELINE_VERSION = "ocr-modal-ppocrv6-vi-batched-v4"
_VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
_IMAGE_PATTERN = re.compile(r"^(?P<keyframe_no>[0-9]+)\.(?:jpg|jpeg|png|webp)$", re.IGNORECASE)

OCR_SCHEMA = pa.schema(
    [
        ("video_id", pa.string()),
        ("keyframe_no", pa.int64()),
        ("text_content", pa.string()),
        ("normalized_text", pa.string()),
        ("language", pa.string()),
        ("confidence", pa.float64()),
        ("detection_confidence", pa.float64()),
        ("bbox", pa.list_(pa.list_(pa.float64()))),
        ("image_width", pa.int64()),
        ("image_height", pa.int64()),
        ("source_frame_path", pa.string()),
        ("source_frame_id", pa.int64()),
        ("source_record_index", pa.int64()),
        ("source_detection_index", pa.int64()),
        ("source", pa.string()),
        ("model_version", pa.string()),
        ("pipeline_version", pa.string()),
        ("schema_version", pa.string()),
        ("producer", pa.string()),
    ],
)


def _normalized_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).strip().split()).casefold()


def _finite_number(value: Any, field_name: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"{field_name} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} must be numeric") from error
    if not math.isfinite(result):
        raise ValueError(f"{field_name} must be finite")
    return result


def _frame_identity(frame_path: str) -> tuple[str, int]:
    normalized = frame_path.replace("\\", "/")
    parts = normalized.split("/")
    if len(parts) != 2 or parts[0] in {"", ".", ".."} or parts[1] in {"", ".", ".."}:
        raise ValueError(f"invalid OCR frame_path: {frame_path}")
    video_id = parts[0]
    match = _IMAGE_PATTERN.fullmatch(parts[1])
    if not _VIDEO_ID_PATTERN.fullmatch(video_id) or match is None:
        raise ValueError(f"invalid OCR frame_path: {frame_path}")
    keyframe_no = int(match.group("keyframe_no"))
    if keyframe_no <= 0:
        raise ValueError(f"invalid OCR frame_path: {frame_path}")
    return video_id, keyframe_no


def _polygon(value: Any) -> list[list[float]]:
    if not isinstance(value, (list, tuple)) or len(value) < 4:
        raise ValueError("OCR bbox must contain at least four points")
    points: list[list[float]] = []
    for point in value:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise ValueError("OCR bbox points must contain two values")
        points.append([
            _finite_number(point[0], "bbox.x"),
            _finite_number(point[1], "bbox.y"),
        ])
    return points


def normalize_ocr_record(
    record: dict[str, Any],
    *,
    source_record_index: int,
) -> tuple[dict[str, Any], ...]:
    """Flatten one frame-level OCR record into accepted text detections."""

    frame_path = record.get("frame_path")
    texts = record.get("texts")
    frame_id = record.get("frame_id")
    if not isinstance(frame_path, str) or not isinstance(texts, list):
        raise TypeError("OCR record must contain frame_path and texts")
    if isinstance(frame_id, bool) or not isinstance(frame_id, int):
        raise TypeError("OCR frame_id must be a non-negative integer")
    if frame_id < 0:
        raise ValueError("OCR frame_id must be a non-negative integer")
    video_id, keyframe_no = _frame_identity(frame_path)
    language = str(record.get("language") or "vi").strip().casefold()
    model_version = str(record.get("model_version") or "unknown").strip()
    pipeline_version = str(record.get("pipeline_version") or OCR_PIPELINE_VERSION).strip()
    width = int(record.get("width") or 0)
    height = int(record.get("height") or 0)
    rows: list[dict[str, Any]] = []
    for detection_index, detection in enumerate(texts):
        if not isinstance(detection, dict):
            raise TypeError(f"OCR detection {detection_index} must be an object")
        if detection.get("accepted") is not True:
            continue
        text = detection.get("text")
        if not isinstance(text, str) or not _normalized_text(text):
            raise ValueError(f"accepted OCR detection {detection_index} has empty text")
        confidence = _finite_number(detection.get("confidence"), "confidence")
        if not 0 <= confidence <= 1:
            raise ValueError("OCR confidence must be between 0 and 1")
        detection_confidence = detection.get("detection_confidence")
        normalized_detection_confidence = (
            None
            if detection_confidence is None
            else _finite_number(detection_confidence, "detection_confidence")
        )
        if normalized_detection_confidence is not None and not 0 <= normalized_detection_confidence <= 1:
            raise ValueError("OCR detection confidence must be between 0 and 1")
        rows.append(
            {
                "video_id": video_id,
                "keyframe_no": keyframe_no,
                "text_content": " ".join(text.strip().split()),
                "normalized_text": _normalized_text(text),
                "language": language,
                "confidence": confidence,
                "detection_confidence": normalized_detection_confidence,
                "bbox": _polygon(detection.get("bbox")),
                "image_width": width,
                "image_height": height,
                "source_frame_path": frame_path.replace("\\", "/"),
                "source_frame_id": frame_id,
                "source_record_index": source_record_index,
                "source_detection_index": detection_index,
                "source": str(detection.get("source") or OCR_PRODUCER),
                "model_version": model_version,
                "pipeline_version": pipeline_version,
                "schema_version": OCR_SCHEMA_VERSION,
                "producer": OCR_PRODUCER,
            }
        )
    return tuple(rows)


def normalize_ocr_jsonl(input_path: str | Path, output_path: str | Path) -> dict[str, int]:
    """Convert frame-level OCR JSONL to an atomic Parquet artifact."""

    source = Path(input_path)
    destination = Path(output_path)
    if not source.is_file():
        raise FileNotFoundError(f"OCR source does not exist: {source}")
    rows: list[dict[str, Any]] = []
    source_records = 0
    skipped_records = 0
    with source.open("r", encoding="utf-8") as stream:
        for source_record_index, line in enumerate(stream):
            if not line.strip():
                continue
            source_records += 1
            parsed = json.loads(line)
            if not isinstance(parsed, dict):
                raise TypeError(f"OCR line {source_record_index + 1} must be an object")
            normalized = normalize_ocr_record(
                parsed,
                source_record_index=source_record_index,
            )
            if not normalized:
                skipped_records += 1
            rows.extend(normalized)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    try:
        table = pa.Table.from_pylist(rows, schema=OCR_SCHEMA)
        pq.write_table(table, temporary, compression="zstd")
        temporary.replace(destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {
        "source_records": source_records,
        "output_rows": len(rows),
        "skipped_records": skipped_records,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    print(json.dumps(normalize_ocr_jsonl(args.input, args.output), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
