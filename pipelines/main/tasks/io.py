"""Small helpers for newline JSON artifacts."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from pipelines.main.core.models import NodeResult


def jsonl_bytes(records: Iterable[dict[str, Any]]) -> bytes:
    return "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records).encode("utf-8")


def json_bytes(record: dict[str, Any]) -> bytes:
    return (json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"JSONL row must be an object: {path}")
            records.append(value)
    return records


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"JSON artifact must be an object: {path}")
    return value


def first_artifact_path(result: NodeResult) -> Path:
    if not result.artifacts:
        raise FileNotFoundError(f"node {result.task_name} did not produce an artifact")
    uri = str(result.artifacts[0].uri)
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise ValueError(f"expected local artifact URI, got {uri}")
    path_value = unquote(parsed.path)
    if parsed.netloc and parsed.netloc != "localhost":
        path_value = f"//{parsed.netloc}{path_value}"
    if len(path_value) >= 3 and path_value[0] == "/" and path_value[2] == ":":
        path_value = path_value[1:]
    return Path(path_value)
