"""Modal provider boundary for the greenfield pipeline.

The node deliberately keeps Modal optional for local runs. Concrete tasks can
subclass this boundary and provide a remote function name or image contract
without importing Modal during package discovery.
"""

from __future__ import annotations

from typing import Any

from pipelines.main.core.models import NodeContext, NodeResult
from .base import TaskNode


class ModalNode(TaskNode):
    provider = "modal"

    def __init__(self, task_name: str, *, artifact_store: Any) -> None:
        super().__init__(artifact_store=artifact_store)
        self.task_name = task_name
        self._options: dict[str, Any] = {}

    async def run(self, context: NodeContext) -> NodeResult:
        try:
            import modal  # noqa: F401
        except ImportError:
            return NodeResult.failed(
                self.task_name,
                self.provider,
                "missing_modal_dependency",
                "Modal provider requires the modal package; install requirements-modal.txt",
            )
        return NodeResult.failed(
            self.task_name,
            self.provider,
            "modal_entrypoint_unconfigured",
            f"No remote entrypoint has been configured for {self.task_name}",
            recoverable=False,
        )
