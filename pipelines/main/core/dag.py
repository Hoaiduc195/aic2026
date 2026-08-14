"""Dependency graph validation and deterministic ordering."""

from __future__ import annotations

from collections.abc import Iterable

from .node import PipelineNode


class PipelineGraph:
    def __init__(self, nodes: Iterable[PipelineNode]) -> None:
        self._nodes = {node.task_name: node for node in nodes}
        if len(self._nodes) == 0:
            raise ValueError("pipeline graph must contain at least one node")
        self._validate_dependencies()

    def _validate_dependencies(self) -> None:
        for name, node in self._nodes.items():
            missing = sorted(set(node.dependencies) - self._nodes.keys())
            if missing:
                raise ValueError(f"{name} depends on missing tasks: {missing}")
        self.topological_order()

    def topological_order(self) -> list[str]:
        visiting: set[str] = set()
        visited: set[str] = set()
        ordered: list[str] = []

        def visit(name: str) -> None:
            if name in visited:
                return
            if name in visiting:
                raise ValueError(f"pipeline graph contains a cycle at {name}")
            visiting.add(name)
            for dependency in sorted(self._nodes[name].dependencies):
                visit(dependency)
            visiting.remove(name)
            visited.add(name)
            ordered.append(name)

        for name in sorted(self._nodes):
            visit(name)
        return ordered

    def node(self, task_name: str) -> PipelineNode:
        return self._nodes[task_name]
