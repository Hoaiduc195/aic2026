from __future__ import annotations

from pipelines.main.contracts.validation import validate_records
from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import first_artifact_path, jsonl_bytes, read_json
from pipelines.main.tasks.video import decode_frames


class FrameManifestLocalNode(TaskNode):
    task_name = "frame_manifest"
    provider = "local"
    dependencies = ("ingestion",)

    async def run(self, context: NodeContext) -> NodeResult:
        manifest = read_json(first_artifact_path(context.artifacts["ingestion"]))
        records = [record for record, _ in decode_frames(self._input_path(context), manifest)]
        if not records:
            return NodeResult.failed(self.task_name, self.provider, "no_decodable_frames", "video has no decodable frames")
        validate_records("frame", records)
        artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="frame-manifest",
            relative_path=f"raw/{context.video_id}/frames.jsonl",
            payload=jsonl_bytes(records),
            schema_name="frame",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(records),
            content_type="application/jsonl",
        )
        return NodeResult.completed(
            self.task_name,
            self.provider,
            artifacts=(artifact,),
            metrics={"frame_count": len(records), "first_timestamp_ms": records[0]["timestamp_ms"], "last_timestamp_ms": records[-1]["timestamp_ms"]},
        )
