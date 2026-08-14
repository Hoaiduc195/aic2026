"""Atomic node checkpoint persistence."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class CheckpointStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root).resolve()

    def path(self, video_id: str, task_name: str) -> Path:
        safe_video = _safe_id(video_id)
        safe_task = _safe_id(task_name)
        return self.root / "nodes" / safe_video / f"{safe_task}.json"

    def read(self, video_id: str, task_name: str) -> dict[str, Any] | None:
        path = self.path(video_id, task_name)
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def write(self, video_id: str, task_name: str, payload: dict[str, Any]) -> Path:
        path = self.path(video_id, task_name)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
        return path


def _safe_id(value: str) -> str:
    normalized = str(value).strip()
    if not normalized or normalized in {".", ".."} or "/" in normalized or "\\" in normalized:
        raise ValueError(f"unsafe artifact ID: {value!r}")
    return normalized
