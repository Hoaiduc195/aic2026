"""Typed configuration for the greenfield pipeline."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SUPPORTED_BACKENDS = frozenset({"local", "modal"})
SUPPORTED_PROFILES = frozenset({"local", "modal", "hybrid"})
DEFAULT_TASKS = (
    "ingestion",
    "frame_manifest",
    "shot_detection",
    "segmentation",
    "keyframes",
    "visual_embedding",
    "asr",
    "ocr",
    "object_detection",
    "captioning",
    "normalization",
)


@dataclass(frozen=True)
class NodeConfig:
    backend: str = "local"
    enabled: bool = True
    options: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> None:
        if self.backend not in SUPPORTED_BACKENDS:
            raise ValueError(f"backend must be one of {sorted(SUPPORTED_BACKENDS)}")
        if not isinstance(self.enabled, bool):
            raise TypeError("enabled must be a boolean")
        if not isinstance(self.options, dict):
            raise TypeError("options must be an object")


@dataclass(frozen=True)
class PipelineConfig:
    profile: str = "local"
    pipeline_version: str = "main-v1.0.0"
    schema_version: str = "1.0.0"
    dataset_id: str = "video-features"
    dataset_version: str = "local"
    output_dir: Path = Path("outputs")
    max_concurrency: int = 1
    fail_fast: bool = False
    tasks: tuple[str, ...] = DEFAULT_TASKS
    nodes: dict[str, NodeConfig] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.nodes:
            default_nodes = {name: NodeConfig() for name in DEFAULT_TASKS}
            object.__setattr__(self, "nodes", default_nodes)

    def node(self, task_name: str) -> NodeConfig:
        return self.nodes.get(task_name, NodeConfig())

    def validate(self) -> None:
        if self.profile not in SUPPORTED_PROFILES:
            raise ValueError(f"profile must be one of {sorted(SUPPORTED_PROFILES)}")
        if not self.pipeline_version.strip():
            raise ValueError("pipeline_version must not be empty")
        if not self.schema_version.strip():
            raise ValueError("schema_version must not be empty")
        if not self.dataset_id.strip() or not self.dataset_version.strip():
            raise ValueError("dataset identity must not be empty")
        if self.max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")
        if not isinstance(self.fail_fast, bool):
            raise TypeError("fail_fast must be a boolean")
        if not self.tasks:
            raise ValueError("tasks must not be empty")
        if len(set(self.tasks)) != len(self.tasks):
            raise ValueError("tasks must not contain duplicates")
        for task_name, node in self.nodes.items():
            if not task_name.strip():
                raise ValueError("node task names must not be empty")
            node.validate()

    @classmethod
    def from_toml(cls, path: str | Path) -> PipelineConfig:
        import tomllib

        config_path = Path(path)
        with config_path.open("rb") as stream:
            payload = tomllib.load(stream)
        node_payload = payload.pop("nodes", {})
        node_configs = {
            str(name): NodeConfig(
                backend=str(value.get("backend", "local")),
                enabled=bool(value.get("enabled", True)),
                options=dict(value.get("options", {})),
            )
            for name, value in node_payload.items()
        }
        if "output_dir" in payload:
            payload["output_dir"] = Path(str(payload["output_dir"]))
        if "tasks" in payload:
            payload["tasks"] = tuple(str(value) for value in payload["tasks"])
        config = cls(nodes=node_configs, **payload)
        config.validate()
        return config

    def to_dict(self) -> dict[str, Any]:
        return {
            "profile": self.profile,
            "pipeline_version": self.pipeline_version,
            "schema_version": self.schema_version,
            "dataset_id": self.dataset_id,
            "dataset_version": self.dataset_version,
            "output_dir": str(self.output_dir),
            "max_concurrency": self.max_concurrency,
            "fail_fast": self.fail_fast,
            "tasks": list(self.tasks),
            "nodes": {
                name: {
                    "backend": node.backend,
                    "enabled": node.enabled,
                    "options": node.options,
                }
                for name, node in sorted(self.nodes.items())
            },
        }

    def stable_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
