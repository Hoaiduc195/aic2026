"""Executable checks for the canonical JSON contract fixtures."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

from contracts.validate import build_validator, validation_errors, validate_contract


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = ROOT / "contracts" / "schemas"
EXAMPLE_ROOT = ROOT / "contracts" / "examples"


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def schema_path(name: str) -> Path:
    return SCHEMA_ROOT / name / "schema.json"


def validator(name: str) -> Draft202012Validator:
    return build_validator(name)


class CanonicalContractTest(unittest.TestCase):
    maxDiff = None

    def test_all_schemas_are_valid_draft_2020_12(self) -> None:
        paths = sorted(SCHEMA_ROOT.glob("*/schema.json"))
        self.assertGreaterEqual(len(paths), 18)
        for path in paths:
            with self.subTest(schema=path.parent.name):
                Draft202012Validator.check_schema(load_json(path))

    def test_canonical_valid_examples_pass(self) -> None:
        names = (
            "version_manifest",
            "temporal_hierarchy",
            "evidence_record",
            "artifact_manifest",
            "query_plan",
            "branch_result",
            "search_response",
        )
        for name in names:
            example = EXAMPLE_ROOT / "valid_outputs" / f"{name}.valid.json"
            with self.subTest(contract=name):
                self.assertTrue(example.is_file(), example)
                validate_contract(name, load_json(example))

    def test_canonical_invalid_examples_fail_for_the_intended_contract(self) -> None:
        fixtures = {
            "version_manifest": "version_manifest__missing_index_version.invalid.json",
            "temporal_hierarchy": "temporal_hierarchy__gap.invalid.json",
            "evidence_record": "evidence_record__missing_provenance.invalid.json",
            "artifact_manifest": "artifact_manifest__relative_uri.invalid.json",
            "query_plan": "query_plan__unbounded_branch.invalid.json",
            "branch_result": "branch_result__completed_with_error.invalid.json",
            "search_response": "search_response__mixed_versions.invalid.json",
        }
        for contract, filename in fixtures.items():
            path = EXAMPLE_ROOT / "invalid_outputs" / filename
            with self.subTest(contract=contract):
                self.assertTrue(path.is_file(), path)
                errors = validation_errors(contract, load_json(path))
                self.assertTrue(errors, f"{filename} unexpectedly passed")

    def test_temporal_hierarchy_requires_complete_ordered_coverage(self) -> None:
        payload = load_json(
            EXAMPLE_ROOT / "valid_outputs" / "temporal_hierarchy.valid.json"
        )
        validator("temporal_hierarchy").validate(payload)
        nodes = payload["nodes"]
        by_id = {node["node_id"]: node for node in nodes}
        for parent in (node for node in nodes if node["child_ids"]):
            children = [by_id[node_id] for node_id in parent["child_ids"]]
            self.assertEqual(children[0]["start_ms"], parent["start_ms"])
            self.assertEqual(children[-1]["end_ms"], parent["end_ms"])
            self.assertTrue(
                all(left["end_ms"] == right["start_ms"] for left, right in zip(children, children[1:]))
            )

    def test_search_response_repeats_one_coherent_version_manifest(self) -> None:
        payload = load_json(
            EXAMPLE_ROOT / "valid_outputs" / "search_response.valid.json"
        )
        validator("search_response").validate(payload)
        expected = payload["versions"]
        for branch in payload["branches"]:
            self.assertEqual(branch["versions"], expected)
        for result in payload["results"]:
            self.assertEqual(result["versions"], expected)


if __name__ == "__main__":
    unittest.main()
