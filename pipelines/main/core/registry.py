"""Provider registry for task nodes."""

from __future__ import annotations

from collections.abc import Iterable

from .node import PipelineNode


class NodeRegistry:
    def __init__(self, nodes: Iterable[PipelineNode] = ()) -> None:
        self._nodes: dict[tuple[str, str], PipelineNode] = {}
        for node in nodes:
            self.register(node)

    def register(self, node: PipelineNode) -> None:
        key = (node.task_name, node.provider)
        if key in self._nodes:
            raise ValueError(f"duplicate node provider: {node.task_name}/{node.provider}")
        self._nodes[key] = node

    def resolve(self, task_name: str, provider: str) -> PipelineNode:
        try:
            return self._nodes[(task_name, provider)]
        except KeyError as error:
            raise KeyError(f"node provider not registered: {task_name}/{provider}") from error

    def tasks(self) -> tuple[str, ...]:
        return tuple(sorted({task for task, _ in self._nodes}))

    def providers(self, task_name: str) -> tuple[str, ...]:
        return tuple(sorted(provider for task, provider in self._nodes if task == task_name))
