from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from pipelines.main.config import NodeConfig, PipelineConfig
from pipelines.main.core.models import NodeContext, NodeResult, PipelineRequest, RunStatus
from pipelines.main.core.registry import NodeRegistry
from pipelines.main.core.dag import PipelineGraph
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
            self.assertTrue(Path(artifact.uri.removeprefix("file://")).exists())
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


if __name__ == "__main__":
    unittest.main()
