from __future__ import annotations

from pipelines.main.contracts.validation import validate_records
from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import first_artifact_path, jsonl_bytes, read_jsonl


class SegmentationLocalNode(TaskNode):
    task_name = "segmentation"
    provider = "local"
    dependencies = ("shot_detection",)

    async def run(self, context: NodeContext) -> NodeResult:
        shots = read_jsonl(first_artifact_path(context.artifacts["shot_detection"]))
        segments = []
        for index, shot in enumerate(shots):
            segment_id = f"{context.video_id}-seg-{index:04d}"
            segments.append({
                "video_id": context.video_id,
                "segment_id": segment_id,
                "granularity": "segment",
                "start_ms": int(shot["start_ms"]),
                "end_ms": max(int(shot["end_ms"]), int(shot["start_ms"]) + 1),
                "start_frame_id": int(shot["start_frame_id"]),
                "end_frame_id": int(shot["end_frame_id"]),
                "segment_type": "shot",
                "representative_frame_ids": [],
                "previous_segment_id": f"{context.video_id}-seg-{index - 1:04d}" if index else None,
                "next_segment_id": f"{context.video_id}-seg-{index + 1:04d}" if index + 1 < len(shots) else None,
                "interval_semantics": "half_open",
                "source": "shot_detection:main",
                "confidence": 1.0,
                "pipeline_version": "main-v1.0.0",
                "schema_version": "1.0.0",
            })
        validate_records("segment", segments)
        artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="segment-manifest",
            relative_path=f"canonical/{context.video_id}/segments.jsonl",
            payload=jsonl_bytes(segments),
            schema_name="segment",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(segments),
            content_type="application/jsonl",
        )
        return NodeResult.completed(self.task_name, self.provider, artifacts=(artifact,), metrics={"segment_count": len(segments)})
