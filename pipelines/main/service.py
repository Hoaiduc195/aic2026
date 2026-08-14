"""Public orchestration service for CLI and future workers."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .config import PipelineConfig
from .core.checkpoint import CheckpointStore
from .core.dag import PipelineGraph
from .core.models import NodeContext, NodeResult, PipelineRequest, PipelineResult, RunStatus
from .core.registry import NodeRegistry
from .storage.local_store import LocalArtifactStore
from .tasks.registry import build_registry


CORE_LOCAL_TASKS = frozenset({
    "ingestion",
    "frame_manifest",
    "shot_detection",
    "segmentation",
    "keyframes",
    "normalization",
})


class PipelineService:
    def __init__(self, config: PipelineConfig, registry: NodeRegistry | None = None) -> None:
        config.validate()
        self.config = config
        self.registry = registry

    @classmethod
    def from_toml(cls, path: str | Path) -> "PipelineService":
        return cls(PipelineConfig.from_toml(path))

    async def run(self, request: PipelineRequest) -> PipelineResult:
        config = self._config_for_request(request)
        run_id = request.run_id or self._new_run_id(request.inputs)
        run_root = Path(request.output_dir).expanduser().resolve() / "runs" / run_id
        store = LocalArtifactStore(run_root)
        registry = self.registry or build_registry(artifact_store=store)
        selected = request.tasks or config.tasks
        nodes = [self._resolve_node(registry, task, config) for task in selected]
        graph = PipelineGraph(nodes)
        checkpoints = CheckpointStore(run_root)
        all_results: dict[str, NodeResult] = {}
        errors: list[dict[str, object]] = []

        inputs = self._expand_inputs(request.inputs, request.recursive)
        for input_path in inputs:
            video_id = self._video_id(input_path)
            context_artifacts: dict[str, NodeResult] = {}
            for task_name in graph.topological_order():
                node = graph.node(task_name)
                if not config.node(task_name).enabled:
                    result = NodeResult.skipped(task_name, node.provider)
                    all_results[f"{video_id}:{task_name}"] = result
                    continue
                dependency_results = [context_artifacts[name] for name in node.dependencies]
                blocked = next((item for item in dependency_results if item.status in {
                    item.status.FAILED,
                    item.status.BLOCKED,
                    item.status.CANCELLED,
                }), None)
                context = NodeContext(
                    run_id=run_id,
                    video_id=video_id,
                    output_dir=run_root,
                    config=config,
                    artifacts=context_artifacts,
                    metadata={"input_path": str(input_path), "artifact_store": store},
                )
                fingerprint = node.fingerprint(context)
                checkpoint = checkpoints.read(video_id, task_name)
                if checkpoint and checkpoint.get("fingerprint") == fingerprint and checkpoint.get("status") == "completed":
                    result = NodeResult.skipped(task_name, node.provider, metrics={"fingerprint": fingerprint})
                elif blocked is not None:
                    result = NodeResult.failed(
                        task_name,
                        node.provider,
                        "blocked_by_dependency",
                        f"dependency for {task_name} did not complete",
                    )
                else:
                    try:
                        result = await node.run(context)
                    except Exception as error:  # noqa: BLE001 - node boundary
                        result = NodeResult.failed(
                            task_name,
                            node.provider,
                            "node_exception",
                            f"{type(error).__name__}: {error}",
                        )
                context_artifacts[task_name] = result
                all_results[f"{video_id}:{task_name}"] = result
                checkpoints.write(video_id, task_name, self._checkpoint_payload(result, fingerprint))
                errors.extend({**dict(error), "video_id": video_id, "task": task_name} for error in result.errors)
                if config.fail_fast and result.status.value == "failed":
                    break

        status = self._run_status(all_results)
        run_record = self._run_record(run_id, status, config, all_results, errors)
        run_root.mkdir(parents=True, exist_ok=True)
        (run_root / "run.json").write_text(
            json.dumps(run_record, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return PipelineResult(run_id, status, all_results, tuple(errors))

    def _config_for_request(self, request: PipelineRequest) -> PipelineConfig:
        if request.config_path:
            config = PipelineConfig.from_toml(request.config_path)
        else:
            config = self.config
        if request.profile == config.profile:
            return config
        return PipelineConfig(
            profile=request.profile,
            pipeline_version=config.pipeline_version,
            schema_version=config.schema_version,
            dataset_id=config.dataset_id,
            dataset_version=config.dataset_version,
            output_dir=request.output_dir,
            max_concurrency=config.max_concurrency,
            fail_fast=config.fail_fast,
            tasks=request.tasks or config.tasks,
            nodes={
                name: self._profile_node(name, request.profile, config.node(name))
                for name in set(config.tasks) | set(request.tasks or ())
            },
        )

    @staticmethod
    def _profile_node(task_name: str, profile: str, node_config: object):
        from dataclasses import replace

        if profile == "local":
            return replace(node_config, backend="local")
        if profile == "modal":
            return replace(node_config, backend="modal")
        backend = "local" if task_name in CORE_LOCAL_TASKS else "modal"
        return replace(node_config, backend=backend)

    @staticmethod
    def _resolve_node(registry: NodeRegistry, task_name: str, config: PipelineConfig):
        node = registry.resolve(task_name, config.node(task_name).backend)
        return node.configure(config.node(task_name).options)

    @staticmethod
    def _expand_inputs(inputs: Iterable[str | Path], recursive: bool) -> tuple[Path, ...]:
        extensions = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v"}
        result: list[Path] = []
        for raw in inputs:
            path = Path(raw).expanduser().resolve()
            if path.is_file():
                result.append(path)
            elif path.is_dir():
                iterator = path.rglob("*") if recursive else path.glob("*")
                result.extend(item for item in iterator if item.is_file() and item.suffix.lower() in extensions)
            else:
                raise FileNotFoundError(path)
        if not result:
            raise ValueError("no supported video inputs found")
        return tuple(sorted(set(result)))

    @staticmethod
    def _video_id(path: Path) -> str:
        safe = "".join(character if character.isalnum() or character in "_.-" else "_" for character in path.stem)
        return safe or hashlib.sha256(str(path).encode()).hexdigest()[:12]

    @staticmethod
    def _new_run_id(inputs: Iterable[str | Path]) -> str:
        value = "|".join(str(Path(item).resolve()) for item in inputs)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"run-{timestamp}-{hashlib.sha256(value.encode()).hexdigest()[:10]}"

    @staticmethod
    def _checkpoint_payload(result: NodeResult, fingerprint: str) -> dict[str, object]:
        return {
            "task_name": result.task_name,
            "provider": result.provider,
            "status": result.status.value,
            "fingerprint": fingerprint,
            "metrics": dict(result.metrics),
            "errors": [dict(error) for error in result.errors],
        }

    @staticmethod
    def _run_status(results: dict[str, NodeResult]) -> RunStatus:
        if not results:
            return RunStatus.FAILED
        statuses = {result.status.value for result in results.values()}
        if "failed" not in statuses and "blocked" not in statuses:
            return RunStatus.COMPLETED
        if any(status in statuses for status in {"completed", "skipped"}):
            return RunStatus.PARTIAL
        return RunStatus.FAILED

    def _run_record(
        self,
        run_id: str,
        status: RunStatus,
        config: PipelineConfig,
        results: dict[str, NodeResult],
        errors: list[dict[str, object]],
    ) -> dict[str, object]:
        now = datetime.now(timezone.utc).isoformat()
        return {
            "run_id": run_id,
            "dataset_id": config.dataset_id,
            "dataset_version": config.dataset_version,
            "pipeline_version": config.pipeline_version,
            "schema_version": config.schema_version,
            "status": status.value,
            "started_at": now,
            "finished_at": now,
            "profile": config.profile,
            "node_statuses": {
                key: result.status.value for key, result in sorted(results.items())
            },
            "errors": errors,
        }
