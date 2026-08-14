from __future__ import annotations

import hashlib
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from urllib.parse import unquote

from pipelines.main.config import NodeConfig, PipelineConfig
from pipelines.main.core.dag import PipelineGraph
from pipelines.main.core.models import (
    NodeContext,
    NodeResult,
    PipelineRequest,
    RunStatus,
)
from pipelines.main.core.node import PipelineNode
from pipelines.main.core.registry import NodeRegistry
from pipelines.main.service import PipelineService
from pipelines.main.storage.local_store import LocalArtifactStore


class _Node:
    def __init__(self, name: str, dependencies: tuple[str, ...] = ()) -> None:
        self.task_name = name
        self.provider = "fake"
        self.dependencies = dependencies

    def fingerprint(self, context: NodeContext) -> str:
        return f"{self.task_name}:{context.run_id}"

    async def run(self, context: NodeContext) -> NodeResult:
        return NodeResult.completed(self.task_name, self.provider)


class _ServiceNode(PipelineNode):
    def __init__(self, name: str, dependencies: tuple[str, ...] = ()) -> None:
        self.task_name = name
        self.provider = "local"
        self.dependencies = dependencies
        self.calls = 0

    async def run(self, context: NodeContext) -> NodeResult:
        self.calls += 1
        return NodeResult.completed(self.task_name, self.provider, metrics={"calls": self.calls})


class CoreContractTests(unittest.TestCase):
    def test_default_config_is_local_and_validates_backend_names(self) -> None:
        config = PipelineConfig()
        config.validate()
        self.assertEqual(config.profile, "local")
        self.assertEqual(config.node("object_detection").backend, "local")

        with self.assertRaises(ValueError):
            replace(config, profile="unknown").validate()
        with self.assertRaises(ValueError):
            NodeConfig(backend="remote").validate()

    def test_graph_orders_dependencies_and_rejects_cycles(self) -> None:
        graph = PipelineGraph(
            (
                _Node("features", ("frames",)),
                _Node("frames", ("probe",)),
                _Node("probe"),
            )
        )
        self.assertEqual(graph.topological_order(), ["probe", "frames", "features"])

        with self.assertRaises(ValueError):
            PipelineGraph((_Node("a", ("b",)), _Node("b", ("a",))))

    def test_registry_resolves_provider_and_rejects_duplicates(self) -> None:
        registry = NodeRegistry()
        first = _Node("ocr")
        registry.register(first)
        self.assertIs(registry.resolve("ocr", "fake"), first)
        with self.assertRaises(ValueError):
            registry.register(_Node("ocr"))
        with self.assertRaises(KeyError):
            registry.resolve("ocr", "modal")

    def test_local_store_writes_checksum_and_reuses_valid_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = LocalArtifactStore(Path(directory))
            payload = b"hello"
            artifact = store.write_bytes(
                run_id="run-1",
                artifact_type="test",
                relative_path="video-1/test.bin",
                payload=payload,
                schema_name="test",
                schema_version="1.0.0",
            )
            self.assertEqual(artifact.sha256, hashlib.sha256(payload).hexdigest())
            uri_path = unquote(artifact.uri.removeprefix("file:///"))
            self.assertTrue(Path(uri_path).exists())
            manifest = store.read_artifact_manifest(artifact.artifact_id)
            self.assertEqual(manifest["record_count"], 1)

            same = store.write_bytes(
                run_id="run-1",
                artifact_type="test",
                relative_path="video-1/test.bin",
                payload=payload,
                schema_name="test",
                schema_version="1.0.0",
            )
            self.assertEqual(same.artifact_id, artifact.artifact_id)

    def test_request_rejects_empty_input_and_result_status_is_explicit(self) -> None:
        with self.assertRaises(ValueError):
            PipelineRequest(inputs=(), output_dir=Path("outputs"))
        result = NodeResult.failed("ocr", "local", "missing_dependency", "PaddleOCR missing")
        self.assertEqual(result.status, RunStatus.FAILED)
        self.assertTrue(result.errors)

    def test_service_resumes_completed_nodes_from_fingerprinted_checkpoints(self) -> None:
        import asyncio

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "video.mp4"
            video.write_bytes(b"fixture")
            probe = _ServiceNode("probe")
            feature = _ServiceNode("feature", ("probe",))
            registry = NodeRegistry((probe, feature))
            config = PipelineConfig(tasks=("probe", "feature"), output_dir=root / "outputs")
            service = PipelineService(config, registry=registry)
            request = PipelineRequest((video,), root / "outputs", tasks=("probe", "feature"))

            first = asyncio.run(service.run(request))
            second = asyncio.run(service.run(replace(request, run_id=first.run_id)))

            self.assertEqual(first.status, RunStatus.COMPLETED)
            self.assertEqual(second.status, RunStatus.COMPLETED)
            self.assertEqual(probe.calls, 1)
            self.assertEqual(feature.calls, 1)
            self.assertEqual(second.node_results["video:probe"].status.value, "skipped")


if __name__ == "__main__":
    unittest.main()
