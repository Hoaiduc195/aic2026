from __future__ import annotations

from typing import Any

from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import first_artifact_path, jsonl_bytes, read_jsonl


class CaptioningLocalNode(TaskNode):
    task_name = "captioning"
    provider = "local"
    dependencies = ("keyframes",)

    def __init__(self, *, artifact_store: Any) -> None:
        super().__init__(artifact_store=artifact_store)
        self._captioner = None

    async def run(self, context: NodeContext) -> NodeResult:
        try:
            from transformers import pipeline
        except ImportError:
            return NodeResult.failed(self.task_name, self.provider, "missing_caption_dependency", "captioning requires transformers")
        rows = read_jsonl(first_artifact_path(context.artifacts["keyframes"]))
        model_name = str(context.config.node(self.task_name).options.get("model", "microsoft/Florence-2-base"))
        try:
            if self._captioner is None:
                self._captioner = pipeline("image-to-text", model=model_name)
            records = []
            for row in rows:
                generated = self._captioner(str(row["path"]))
                caption_en = _caption_text(generated)
                records.append({
                    "video_id": context.video_id,
                    "original_frame_id": int(row["original_frame_id"]),
                    "timestamp_ms": int(row["timestamp_ms"]),
                    "caption_en": caption_en,
                    "language": "en",
                    "subjects": [],
                    "appearance": [],
                    "actions": [],
                    "objects": [],
                    "scene": None,
                    "state_before": None,
                    "state_after": None,
                    "confidence": 0.0,
                    "producer": "captioning:main",
                    "model_version": model_name,
                    "prompt_version": None,
                    "pipeline_version": "main-v1.0.0",
                    "schema_version": "2.0.0",
                })
        except Exception as error:  # noqa: BLE001 - model boundary
            return NodeResult.failed(self.task_name, self.provider, "caption_inference_failed", str(error))
        from pipelines.main.contracts.validation import validate_records

        validate_records("caption_result", records)
        artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="captions",
            relative_path=f"canonical/{context.video_id}/captions.jsonl",
            payload=jsonl_bytes(records),
            schema_name="caption_result",
            schema_version="2.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(records),
            content_type="application/jsonl",
        )
        return NodeResult.completed(self.task_name, self.provider, artifacts=(artifact,), metrics={"frame_count": len(records), "model": model_name})


def _caption_text(value: Any) -> str:
    if not isinstance(value, list) or not value:
        return ""
    first = value[0]
    if not isinstance(first, dict):
        return str(first).strip()
    return str(first.get("generated_text", first.get("caption", ""))).strip()
