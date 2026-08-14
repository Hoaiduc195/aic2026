"""Shared task-node helpers."""

from __future__ import annotations

from abc import abstractmethod
from pathlib import Path
from typing import Any

from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.core.node import PipelineNode


class TaskNode(PipelineNode):
    def __init__(self, *, artifact_store: Any) -> None:
        self.artifact_store = artifact_store

    @property
    def options(self) -> dict[str, Any]:
        return dict(self._options)

    def configure(self, options: dict[str, Any]) -> "TaskNode":
        self._options = dict(options)
        return self

    def _input_path(self, context: NodeContext) -> Path:
        value = context.metadata.get("input_path")
        if value is None:
            raise ValueError("node context is missing input_path")
        return Path(value)

    @abstractmethod
    async def run(self, context: NodeContext) -> NodeResult:
        raise NotImplementedError


class UnavailableNode(TaskNode):
    """Explicit provider failure instead of silently producing fake features."""

    def __init__(self, task_name: str, provider: str, *, artifact_store: Any) -> None:
        super().__init__(artifact_store=artifact_store)
        self.task_name = task_name
        self.provider = provider
        self._options: dict[str, Any] = {}

    async def run(self, context: NodeContext) -> NodeResult:
        return NodeResult.failed(
            self.task_name,
            self.provider,
            "provider_unavailable",
            f"{self.task_name}/{self.provider} is not configured for this runtime",
        )
