"""Modal provider boundary for the greenfield pipeline.

The node deliberately keeps Modal optional for local runs. Concrete tasks can
subclass this boundary and provide a remote function name or image contract
without importing Modal during package discovery.
"""

from __future__ import annotations

import inspect
from dataclasses import asdict
from typing import Any

from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.storage.artifacts import ArtifactRef

from .base import TaskNode


class ModalNode(TaskNode):
    provider = "modal"

    def __init__(self, task_name: str, *, artifact_store: Any, dependencies: tuple[str, ...] = ()) -> None:
        super().__init__(artifact_store=artifact_store)
        self.task_name = task_name
        self.dependencies = dependencies
        self._options: dict[str, Any] = {}

    async def run(self, context: NodeContext) -> NodeResult:
        try:
            import modal
        except ImportError:
            return NodeResult.failed(
                self.task_name,
                self.provider,
                "missing_modal_dependency",
                "Modal provider requires the modal package; install requirements-modal.txt",
            )
        options = context.config.node(self.task_name).options
        app_name = str(options.get("app_name", "aic-main-pipeline"))
        function_name = str(options.get("function_name", "run_task"))
        try:
            function_factory = getattr(modal.Function, "from_name", None) or modal.Function.lookup
            function = function_factory(app_name, function_name)
            payload = {
                "task_name": self.task_name,
                "video_id": context.video_id,
                "input_path": str(context.metadata.get("input_path", "")),
                "run_id": context.run_id,
                "config": context.config.to_dict(),
                "artifacts": {
                    name: [asdict(artifact) for artifact in result.artifacts]
                    for name, result in context.artifacts.items()
                },
            }
            remote_result = function.remote(payload)
            if inspect.isawaitable(remote_result):
                remote_result = await remote_result
            return _result_from_remote(self.task_name, remote_result)
        except Exception as error:  # noqa: BLE001 - remote boundary
            return NodeResult.failed(
                self.task_name,
                self.provider,
                "modal_remote_failed",
                f"{type(error).__name__}: {error}",
            )


def _result_from_remote(task_name: str, payload: Any) -> NodeResult:
    if isinstance(payload, NodeResult):
        return payload
    if not isinstance(payload, dict):
        raise TypeError("Modal task must return a result object")
    status = str(payload.get("status", "completed"))
    provider = "modal"
    if status == "completed":
        artifacts = tuple(
            ArtifactRef(
                artifact_id=str(item["artifact_id"]),
                run_id=str(item["run_id"]),
                artifact_type=str(item["artifact_type"]),
                uri=str(item["uri"]),
                sha256=str(item["sha256"]),
                schema_name=str(item["schema_name"]),
                schema_version=str(item["schema_version"]),
                size_bytes=int(item["size_bytes"]),
                record_count=int(item["record_count"]),
            )
            for item in payload.get("artifacts", [])
            if isinstance(item, dict)
        )
        return NodeResult.completed(task_name, provider, artifacts=artifacts, metrics=dict(payload.get("metrics", {})))
    return NodeResult.failed(
        task_name,
        provider,
        str(payload.get("code", "modal_task_failed")),
        str(payload.get("message", "Modal task failed")),
    )
