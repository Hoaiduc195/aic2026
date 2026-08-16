from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import first_artifact_path, jsonl_bytes, read_jsonl
from pipelines.main.tasks.normalization.records import FrameIdentity, normalize_ocr


class OcrLocalNode(TaskNode):
    task_name = "ocr"
    provider = "local"
    dependencies = ("keyframes",)

    def __init__(self, *, artifact_store: Any) -> None:
        super().__init__(artifact_store=artifact_store)
        self._engine = None

    async def run(self, context: NodeContext) -> NodeResult:
        try:
            from paddleocr import PaddleOCR
        except ImportError:
            return NodeResult.failed(self.task_name, self.provider, "missing_ocr_dependency", "OCR requires paddleocr")
        rows = read_jsonl(first_artifact_path(context.artifacts["keyframes"]))
        language = str(context.config.node(self.task_name).options.get("language", "vi"))
        model_version = str(context.config.node(self.task_name).options.get("model_version", "PP-OCRv5"))
        try:
            if self._engine is None:
                self._engine = PaddleOCR(lang=language)
            records = []
            for row in rows:
                raw = self._predict(str(row["path"]))
                identity = FrameIdentity(context.video_id, int(row["original_frame_id"]), int(row["timestamp_ms"]))
                records.append(normalize_ocr(identity, raw, model_version=model_version))
            from pipelines.main.contracts.validation import validate_records

            validate_records("ocr_result", records)
        except Exception as error:  # noqa: BLE001 - model boundary
            return NodeResult.failed(self.task_name, self.provider, "ocr_inference_failed", str(error))
        artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="ocr",
            relative_path=f"canonical/{context.video_id}/ocr.jsonl",
            payload=jsonl_bytes(records),
            schema_name="ocr_result",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(records),
            content_type="application/jsonl",
        )
        return NodeResult.completed(self.task_name, self.provider, artifacts=(artifact,), metrics={"frame_count": len(records), "language": language})

    def _predict(self, path: str) -> dict[str, Any]:
        result = self._engine.predict(path) if hasattr(self._engine, "predict") else self._engine.ocr(path)
        return _parse_result(result)


def _parse_result(value: Any) -> dict[str, Any]:
    if isinstance(value, list) and len(value) == 1:
        value = value[0]
    if isinstance(value, Mapping):
        texts = value.get("rec_texts", [])
        scores = value.get("rec_scores", [])
        polygons = value.get("rec_polys", value.get("dt_polys", []))
        return _from_columns(texts, scores, polygons)
    records = []
    if isinstance(value, list):
        for item in value:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            polygon, payload = item[0], item[1]
            if isinstance(payload, (list, tuple)) and payload:
                text = payload[0]
                score = payload[1] if len(payload) > 1 else 0.0
            else:
                text, score = payload, 0.0
            records.append({"text": str(text), "box": polygon, "confidence": float(score)})
    return {"text": " ".join(row["text"] for row in records), "boxes": records, "confidence": _mean(row["confidence"] for row in records), "language": "vi"}


def _from_columns(texts: Any, scores: Any, polygons: Any) -> dict[str, Any]:
    boxes = []
    for index, text in enumerate(texts if isinstance(texts, list) else []):
        polygon = polygons[index] if isinstance(polygons, list) and index < len(polygons) else []
        if not isinstance(polygon, list) or len(polygon) != 4:
            continue
        boxes.append({"text": str(text), "box": polygon, "confidence": float(scores[index]) if isinstance(scores, list) and index < len(scores) else 0.0})
    return {"text": " ".join(row["text"] for row in boxes), "boxes": boxes, "confidence": _mean(row["confidence"] for row in boxes), "language": "vi"}


def _mean(values: Any) -> float:
    values = tuple(float(value) for value in values)
    return sum(values) / len(values) if values else 0.0
