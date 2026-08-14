"""Validate records against ``src/contracts/schemas`` without copying schemas."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any


def schema_path(schema_name: str, schema_root: Path | None = None) -> Path:
    root = schema_root or Path(__file__).resolve().parents[3] / "contracts" / "schemas"
    path = root / schema_name / "schema.json"
    if not path.is_file():
        raise FileNotFoundError(f"canonical contract not found: {schema_name}")
    return path


def load_schema(schema_name: str, schema_root: Path | None = None) -> dict[str, Any]:
    return json.loads(schema_path(schema_name, schema_root).read_text(encoding="utf-8"))


def validate_record(
    schema_name: str,
    record: Mapping[str, Any],
    *,
    schema_root: Path | None = None,
) -> None:
    try:
        import jsonschema
    except ImportError as error:  # pragma: no cover - dependency boundary
        raise RuntimeError("jsonschema is required for contract validation") from error

    jsonschema.validate(dict(record), load_schema(schema_name, schema_root))
    try:
        from contracts.semantic_validation import validate_record_semantics
    except ImportError:
        return
    validate_record_semantics(schema_name, record)


def validate_records(
    schema_name: str,
    records: list[Mapping[str, Any]],
    *,
    schema_root: Path | None = None,
) -> None:
    for index, record in enumerate(records):
        try:
            validate_record(schema_name, record, schema_root=schema_root)
        except Exception as error:
            raise ValueError(f"invalid {schema_name} record at index {index}: {error}") from error
