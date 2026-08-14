from __future__ import annotations

from typing import Any

from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import first_artifact_path, jsonl_bytes, read_jsonl
from pipelines.main.tasks.normalization.records import (
    FrameIdentity,
    normalize_detections,
)


class ObjectDetectionLocalNode(TaskNode):
    task_name = "object_detection"
    provider = "local"
    dependencies = ("keyframes",)

    def __init__(self, *, artifact_store: Any) -> None:
        super().__init__(artifact_store=artifact_store)
        self._model = None

    async def run(self, context: NodeContext) -> NodeResult:
        try:
            from ultralytics import YOLO
        except ImportError:
            return NodeResult.failed(self.task_name, self.provider, "missing_detection_dependency", "object detection requires ultralytics")
        rows = read_jsonl(first_artifact_path(context.artifacts["keyframes"]))
        model_name = str(context.config.node(self.task_name).options.get("model", "yolo26n.pt"))
        image_size = int(context.config.node(self.task_name).options.get("image_size", 640))
        confidence_threshold = float(context.config.node(self.task_name).options.get("confidence_threshold", 0.25))
        try:
            if self._model is None:
                self._model = YOLO(model_name)
            records = []
            for row in rows:
                result = self._model.predict(
                    source=str(row["path"]),
                    imgsz=image_size,
                    conf=confidence_threshold,
                    verbose=False,
                )[0]
                detections = []
                names = getattr(result, "names", {})
                boxes = getattr(result, "boxes", None)
                if boxes is not None:
                    xyxy = boxes.xyxy.cpu().tolist()
                    confidences = boxes.conf.cpu().tolist()
                    class_ids = boxes.cls.cpu().tolist()
                    width = float(getattr(result, "orig_shape", (1, 1))[1])
                    height = float(getattr(result, "orig_shape", (1, 1))[0])
                    for box, score, class_id in zip(xyxy, confidences, class_ids):
                        class_id_int = int(class_id)
                        detections.append({
                            "class_id": class_id_int,
                            "class_name": str(names.get(class_id_int, class_id_int)),
                            "confidence": float(score),
                            "bbox_xyxy": [float(value) for value in box],
                            "bbox_normalized": [
                                float(box[0]) / max(width, 1.0),
                                float(box[1]) / max(height, 1.0),
                                float(box[2]) / max(width, 1.0),
                                float(box[3]) / max(height, 1.0),
                            ],
                        })
                identity = FrameIdentity(context.video_id, str(row.get("segment_id") or f"{context.video_id}-seg-unknown"), int(row["original_frame_id"]), int(row["timestamp_ms"]))
                records.append(normalize_detections(identity, detections, model_version=model_name))
            from pipelines.main.contracts.validation import validate_records

            validate_records("object_result", records)
        except Exception as error:  # noqa: BLE001 - model boundary
            return NodeResult.failed(self.task_name, self.provider, "detection_inference_failed", str(error))
        artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="object-detection",
            relative_path=f"canonical/{context.video_id}/objects.jsonl",
            payload=jsonl_bytes(records),
            schema_name="object_result",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(records),
            content_type="application/jsonl",
        )
        return NodeResult.completed(self.task_name, self.provider, artifacts=(artifact,), metrics={"frame_count": len(records), "model": model_name})
