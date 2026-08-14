"""Immutable-ish value objects shared by nodes and orchestration."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any


class RunStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"


class NodeStatus(StrEnum):
    COMPLETED = "completed"
    SKIPPED = "skipped"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class PipelineRequest:
    inputs: tuple[str | Path, ...]
    output_dir: Path
    profile: str = "local"
    config_path: Path | None = None
    run_id: str | None = None
    tasks: tuple[str, ...] | None = None
    recursive: bool = False

    def __post_init__(self) -> None:
        if not self.inputs:
            raise ValueError("at least one input is required")
        if not str(self.output_dir).strip():
            raise ValueError("output_dir must not be empty")
        if self.profile not in {"local", "modal", "hybrid"}:
            raise ValueError("profile must be local, modal, or hybrid")
        if self.tasks is not None and not self.tasks:
            raise ValueError("tasks must not be empty when provided")


@dataclass(frozen=True)
class NodeContext:
    run_id: str
    video_id: str
    output_dir: Path
    config: Any
    artifacts: Mapping[str, Any] = field(default_factory=dict)
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NodeResult:
    task_name: str
    provider: str
    status: NodeStatus
    artifacts: tuple[Any, ...] = ()
    metrics: Mapping[str, Any] = field(default_factory=dict)
    errors: tuple[Mapping[str, Any], ...] = ()

    @classmethod
    def completed(cls, task_name: str, provider: str, **kwargs: Any) -> NodeResult:
        return cls(task_name, provider, NodeStatus.COMPLETED, **kwargs)

    @classmethod
    def skipped(cls, task_name: str, provider: str, **kwargs: Any) -> NodeResult:
        return cls(task_name, provider, NodeStatus.SKIPPED, **kwargs)

    @classmethod
    def failed(
        cls,
        task_name: str,
        provider: str,
        code: str,
        message: str,
        *,
        recoverable: bool = True,
        **kwargs: Any,
    ) -> NodeResult:
        error = {"code": code, "message": message, "recoverable": recoverable}
        return cls(task_name, provider, NodeStatus.FAILED, errors=(error,), **kwargs)


@dataclass(frozen=True)
class PipelineResult:
    run_id: str
    status: RunStatus
    node_results: Mapping[str, NodeResult]
    errors: tuple[Mapping[str, Any], ...] = ()
