"""JSON Schema plus cross-field validation for canonical AIC contracts."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, RefResolver


SCHEMA_ROOT = Path(__file__).resolve().parent / "schemas"


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _schema_store() -> dict[str, dict[str, Any]]:
    store: dict[str, dict[str, Any]] = {}
    for path in SCHEMA_ROOT.glob("*/schema.json"):
        schema = _load(path)
        schema_id = schema.get("$id")
        if isinstance(schema_id, str):
            store[schema_id] = schema
            store[path.parent.name + "/schema.json"] = schema
        store[path.resolve().as_uri()] = schema
    return store


def build_validator(contract: str) -> Draft202012Validator:
    path = SCHEMA_ROOT / contract / "schema.json"
    schema = _load(path)
    Draft202012Validator.check_schema(schema)
    resolver = RefResolver.from_schema(schema, store=_schema_store())
    return Draft202012Validator(schema, resolver=resolver)


def validation_errors(contract: str, payload: Any) -> list[str]:
    errors = [error.message for error in build_validator(contract).iter_errors(payload)]
    if errors or not isinstance(payload, dict):
        return sorted(errors)
    errors.extend(_interval_errors(payload))
    if contract == "temporal_hierarchy":
        errors.extend(_hierarchy_errors(payload))
    elif contract == "search_response":
        errors.extend(_search_version_errors(payload))
    return sorted(errors)


def validate_contract(contract: str, payload: Any) -> None:
    errors = validation_errors(contract, payload)
    if errors:
        raise ValueError(f"invalid {contract}: " + "; ".join(errors))


def _walk(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _interval_errors(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for value in _walk(payload):
        if isinstance(value.get("start_ms"), int) and isinstance(value.get("end_ms"), int):
            if value["end_ms"] <= value["start_ms"]:
                errors.append("end_ms must be greater than start_ms")
    return errors


def _hierarchy_errors(payload: dict[str, Any]) -> list[str]:
    nodes = payload.get("nodes", [])
    by_id = {node.get("node_id"): node for node in nodes if isinstance(node, dict)}
    errors: list[str] = []
    if len(by_id) != len(nodes):
        errors.append("node_id values must be unique")
    type_child = {"context_window": "segment", "segment": "micro_event", "micro_event": "frame"}
    for node in nodes:
        node_id = node.get("node_id")
        parent_id = node.get("parent_id")
        if parent_id is not None and parent_id not in by_id:
            errors.append(f"{node_id} references missing parent {parent_id}")
        child_ids = node.get("child_ids", [])
        children = [by_id[child_id] for child_id in child_ids if child_id in by_id]
        if len(children) != len(child_ids):
            errors.append(f"{node_id} references a missing child")
            continue
        expected_type = type_child.get(node.get("node_type"))
        if expected_type is None and children:
            errors.append(f"frame {node_id} cannot have children")
        if any(child.get("node_type") != expected_type for child in children):
            errors.append(f"{node_id} has a child at the wrong temporal level")
        if any(child.get("parent_id") != node_id for child in children):
            errors.append(f"{node_id} child parent linkage is inconsistent")
        ordered = sorted(children, key=lambda child: child.get("ordinal", -1))
        if ordered:
            if ordered[0].get("start_ms") != node.get("start_ms") or ordered[-1].get("end_ms") != node.get("end_ms"):
                errors.append(f"{node_id} children do not cover parent boundaries")
            if any(left.get("end_ms") != right.get("start_ms") for left, right in zip(ordered, ordered[1:])):
                errors.append(f"{node_id} children contain a gap or overlap")
    roots = [node for node in nodes if node.get("parent_id") is None]
    if not roots or any(node.get("node_type") != "context_window" for node in roots):
        errors.append("all hierarchy roots must be context windows")
    ordered_roots = sorted(roots, key=lambda node: node.get("ordinal", -1))
    if ordered_roots:
        if ordered_roots[0].get("start_ms") != payload.get("timeline_start_ms") or ordered_roots[-1].get("end_ms") != payload.get("timeline_end_ms"):
            errors.append("context windows do not cover timeline boundaries")
        if any(left.get("end_ms") != right.get("start_ms") for left, right in zip(ordered_roots, ordered_roots[1:])):
            errors.append("context windows contain a timeline gap or overlap")
    return errors


def _search_version_errors(payload: dict[str, Any]) -> list[str]:
    expected = payload.get("versions")
    errors: list[str] = []
    for branch in payload.get("branches", []):
        if branch.get("versions") != expected:
            errors.append("branch version manifest differs from response")
    for result in payload.get("results", []):
        if result.get("versions") != expected:
            errors.append("result version manifest differs from response")
    return errors
