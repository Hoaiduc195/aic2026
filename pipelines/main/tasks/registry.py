"""Default node registry for the greenfield pipeline."""

from __future__ import annotations

from typing import Any

from pipelines.main.config import DEFAULT_TASKS
from pipelines.main.core.registry import NodeRegistry
from .base import UnavailableNode
from .modal import ModalNode


def build_registry(*, artifact_store: Any) -> NodeRegistry:
    """Build all task/provider slots without importing model libraries eagerly."""

    registry = NodeRegistry()
    for task_name in DEFAULT_TASKS:
        registry.register(UnavailableNode(task_name, "local", artifact_store=artifact_store))
        registry.register(ModalNode(task_name, artifact_store=artifact_store))
    return registry
