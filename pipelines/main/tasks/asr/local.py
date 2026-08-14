from __future__ import annotations

from typing import Any

from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import first_artifact_path, jsonl_bytes, read_jsonl


class AsrLocalNode(TaskNode):
    task_name = "asr"
    provider = "local"
    dependencies = ("segmentation",)

    def __init__(self, *, artifact_store: Any) -> None:
        super().__init__(artifact_store=artifact_store)
        self._model = None

    async def run(self, context: NodeContext) -> NodeResult:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            return NodeResult.failed(self.task_name, self.provider, "missing_asr_dependency", "ASR requires faster-whisper")
        segments = read_jsonl(first_artifact_path(context.artifacts["segmentation"]))
        model_name = str(context.config.node(self.task_name).options.get("model", "small"))
        language = str(context.config.node(self.task_name).options.get("language", "vi"))
        device = str(context.config.node(self.task_name).options.get("device", "auto"))
        compute_type = str(context.config.node(self.task_name).options.get("compute_type", "auto"))
        try:
            if self._model is None:
                resolved_device = "cuda" if device == "auto" else device
                if resolved_device == "cuda":
                    self._model = WhisperModel(model_name, device="cuda", compute_type="float16" if compute_type == "auto" else compute_type)
                else:
                    self._model = WhisperModel(model_name, device=resolved_device, compute_type="int8" if compute_type == "auto" else compute_type)
            chunks, _ = self._model.transcribe(str(self._input_path(context)), language=language, vad_filter=True)
            records = []
            for chunk in chunks:
                start_ms = round(float(chunk.start) * 1000)
                end_ms = max(start_ms + 1, round(float(chunk.end) * 1000))
                text = str(chunk.text).strip()
                if not text:
                    continue
                confidence = _confidence(chunk)
                for segment in segments:
                    overlap_start = max(start_ms, int(segment["start_ms"]))
                    overlap_end = min(end_ms, int(segment["end_ms"]))
                    if overlap_end <= overlap_start:
                        continue
                    records.append({
                        "video_id": context.video_id,
                        "segment_id": str(segment["segment_id"]),
                        "start_ms": overlap_start,
                        "end_ms": overlap_end,
                        "text_raw": text,
                        "text_normalized": " ".join(text.split()).casefold(),
                        "language": language,
                        "confidence": confidence,
                        "producer": "asr:main-faster-whisper",
                        "model_version": model_name,
                        "pipeline_version": "main-v1.0.0",
                        "schema_version": "1.0.0",
                    })
        except Exception as error:  # noqa: BLE001 - model boundary
            return NodeResult.failed(self.task_name, self.provider, "asr_inference_failed", str(error))
        from pipelines.main.contracts.validation import validate_records

        validate_records("asr_result", records)
        artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="asr",
            relative_path=f"canonical/{context.video_id}/asr.jsonl",
            payload=jsonl_bytes(records),
            schema_name="asr_result",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(records),
            content_type="application/jsonl",
        )
        return NodeResult.completed(self.task_name, self.provider, artifacts=(artifact,), metrics={"span_count": len(records), "language": language})


def _confidence(chunk: Any) -> float:
    value = getattr(chunk, "avg_logprob", None)
    if value is None:
        return 0.0
    import math

    return max(0.0, min(1.0, math.exp(float(value))))
