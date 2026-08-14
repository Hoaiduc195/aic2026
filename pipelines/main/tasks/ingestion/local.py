from __future__ import annotations

from pipelines.main.contracts.validation import validate_record
from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import json_bytes
from pipelines.main.tasks.video import probe_video


class IngestionLocalNode(TaskNode):
    task_name = "ingestion"
    provider = "local"
    dependencies = ()

    async def run(self, context: NodeContext) -> NodeResult:
        manifest = probe_video(self._input_path(context), video_id=context.video_id)
        validate_record("video_manifest", manifest)
        artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="video-manifest",
            relative_path=f"source/{context.video_id}/manifest.json",
            payload=json_bytes(manifest),
            schema_name="video_manifest",
            schema_version=manifest["schema_version"],
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            content_type="application/json",
        )
        return NodeResult.completed(
            self.task_name,
            self.provider,
            artifacts=(artifact,),
            metrics={"frame_count_estimate": manifest.get("frame_count", 0), "manifest": manifest},
        )
