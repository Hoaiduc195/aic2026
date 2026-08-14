from __future__ import annotations

from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import json_bytes


class NormalizationLocalNode(TaskNode):
    task_name = "normalization"
    provider = "local"
    dependencies = (
        "asr",
        "captioning",
        "keyframes",
        "object_detection",
        "ocr",
        "visual_embedding",
    )
    allow_failed_dependencies = True

    async def run(self, context: NodeContext) -> NodeResult:
        available = {}
        failed = {}
        for task_name, result in sorted(context.artifacts.items()):
            if result.status.value in {"completed", "skipped"}:
                available[task_name] = [artifact.artifact_id for artifact in result.artifacts]
            else:
                failed[task_name] = [dict(error) for error in result.errors]
        bundle = {
            "video_id": context.video_id,
            "run_id": context.run_id,
            "pipeline_version": "main-v1.0.0",
            "schema_version": "1.0.0",
            "status": "completed" if not failed else "partial",
            "artifacts": available,
            "failed_tasks": failed,
        }
        artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="feature-bundle",
            relative_path=f"bundles/{context.video_id}/manifest.json",
            payload=json_bytes(bundle),
            schema_name="feature_bundle",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            content_type="application/json",
        )
        return NodeResult.completed(self.task_name, self.provider, artifacts=(artifact,), metrics={"available_tasks": sorted(available), "failed_tasks": sorted(failed)})
