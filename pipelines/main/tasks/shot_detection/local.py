from __future__ import annotations

from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import first_artifact_path, jsonl_bytes, read_jsonl


class ShotDetectionLocalNode(TaskNode):
    task_name = "shot_detection"
    provider = "local"
    dependencies = ("frame_manifest",)

    async def run(self, context: NodeContext) -> NodeResult:
        frames = read_jsonl(first_artifact_path(context.artifacts["frame_manifest"]))
        if not frames:
            return NodeResult.failed(self.task_name, self.provider, "no_frames", "frame manifest is empty")
        threshold = float(context.config.node(self.task_name).options.get("scene_change_threshold", 0.35))
        min_frames = max(1, int(context.config.node(self.task_name).options.get("min_frames", 8)))
        boundaries = [0]
        for index, frame in enumerate(frames[1:], start=1):
            if float(frame.get("scene_change_score", 0.0)) >= threshold and index - boundaries[-1] >= min_frames:
                boundaries.append(index)
        shots = []
        for shot_index, start_position in enumerate(boundaries):
            end_position = boundaries[shot_index + 1] if shot_index + 1 < len(boundaries) else len(frames)
            start = frames[start_position]
            end = frames[end_position - 1]
            shots.append({
                "video_id": context.video_id,
                "shot_id": shot_index,
                "start_frame_id": int(start["original_frame_id"]),
                "end_frame_id": int(end["original_frame_id"]) + 1,
                "start_ms": int(start["timestamp_ms"]),
                "end_ms": int(end["timestamp_ms"]) + 1,
                "boundary_score": float(end.get("scene_change_score", 0.0)),
                "producer": "shot-detection:main",
                "pipeline_version": "main-v1.0.0",
            })
        # shot_manifest is an internal frame-timeline artifact.
        artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="shot-manifest",
            relative_path=f"raw/{context.video_id}/shots.jsonl",
            payload=jsonl_bytes(shots),
            schema_name="shot_manifest",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(shots),
            content_type="application/jsonl",
        )
        return NodeResult.completed(self.task_name, self.provider, artifacts=(artifact,), metrics={"shot_count": len(shots)})
