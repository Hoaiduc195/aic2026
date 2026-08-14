"""Convert provider records into the repository's canonical evidence shapes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


PIPELINE_VERSION = "main-v1.0.0"
SCHEMA_VERSION = "1.0.0"


@dataclass(frozen=True)
class FrameIdentity:
    video_id: str
    segment_id: str
    original_frame_id: int
    timestamp_ms: int


def normalize_detection(
    identity: FrameIdentity,
    detection: Mapping[str, Any],
    *,
    model_version: str,
) -> dict[str, Any]:
    class_name = str(detection.get("class_name", detection.get("class", "unknown"))).strip()
    if not class_name:
        raise ValueError("detection class name must not be empty")
    confidence = float(detection.get("confidence", 0.0))
    if not 0.0 <= confidence <= 1.0:
        raise ValueError("detection confidence must be between 0 and 1")
    box = [float(value) for value in detection.get("bbox_xyxy", detection.get("box", []))]
    if len(box) != 4 or any(value < 0 for value in box):
        raise ValueError("detection box must contain four non-negative coordinates")
    attributes = dict(detection.get("attributes", {}))
    if "class_id" in detection:
        attributes["class_id"] = int(detection["class_id"])
    if "bbox_normalized" in detection:
        attributes["bbox_normalized"] = list(detection["bbox_normalized"])
    return {
        "video_id": identity.video_id,
        "segment_id": identity.segment_id,
        "timestamp_ms": identity.timestamp_ms,
        "original_frame_id": identity.original_frame_id,
        "objects": [{"class": class_name, "box": box, "confidence": confidence, "attributes": attributes}],
        "producer": "object-detection:main",
        "model_version": model_version,
        "pipeline_version": PIPELINE_VERSION,
        "schema_version": SCHEMA_VERSION,
    }


def normalize_ocr(
    identity: FrameIdentity,
    result: Mapping[str, Any],
    *,
    model_version: str,
) -> dict[str, Any]:
    text = str(result.get("text", ""))
    confidence = float(result.get("confidence", 0.0))
    if not 0.0 <= confidence <= 1.0:
        raise ValueError("OCR confidence must be between 0 and 1")
    boxes = []
    for item in result.get("boxes", []):
        box = item.get("box", [])
        if len(box) != 4:
            raise ValueError("OCR box must contain four points")
        boxes.append({
            "text": str(item.get("text", "")),
            "box": [[float(point[0]), float(point[1])] for point in box],
            "confidence": float(item.get("confidence", 0.0)),
        })
    return {
        "video_id": identity.video_id,
        "segment_id": identity.segment_id,
        "timestamp_ms": identity.timestamp_ms,
        "original_frame_id": identity.original_frame_id,
        "text": text,
        "normalized_text": text.casefold(),
        "boxes": boxes,
        "confidence": confidence,
        "language": result.get("language", "vi"),
        "producer": "ocr:main",
        "model_version": model_version,
        "pipeline_version": PIPELINE_VERSION,
        "schema_version": SCHEMA_VERSION,
    }
