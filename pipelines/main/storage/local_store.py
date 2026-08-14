"""Local atomic artifact store."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .artifacts import ArtifactRef


class LocalArtifactStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def write_bytes(
        self,
        *,
        run_id: str,
        artifact_type: str,
        relative_path: str,
        payload: bytes,
        schema_name: str,
        schema_version: str,
        dataset_id: str = "video-features",
        dataset_version: str = "local",
        record_count: int = 1,
        content_type: str = "application/octet-stream",
    ) -> ArtifactRef:
        target = self._safe_target(relative_path)
        digest = hashlib.sha256(payload).hexdigest()
        artifact_id = f"{artifact_type}-{digest[:24]}"
        if target.exists() and self._sha256(target) == digest:
            manifest = self.read_artifact_manifest(artifact_id)
            if manifest is not None:
                return self._ref_from_manifest(manifest)

        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{digest[:12]}.tmp")
        temporary.write_bytes(payload)
        os.replace(temporary, target)

        ref = ArtifactRef(
            artifact_id=artifact_id,
            run_id=run_id,
            artifact_type=artifact_type,
            uri=target.as_uri(),
            sha256=digest,
            schema_name=schema_name,
            schema_version=schema_version,
            size_bytes=len(payload),
            record_count=record_count,
        )
        manifest = ref.to_manifest(
            dataset_id=dataset_id,
            dataset_version=dataset_version,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        manifest["content_type"] = content_type
        from pipelines.main.contracts.validation import validate_record

        validate_record("artifact_manifest", manifest)
        manifest_path = self.root / "manifests" / f"{artifact_id}.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_manifest = manifest_path.with_name(f".{manifest_path.name}.tmp")
        temporary_manifest.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary_manifest, manifest_path)
        return ref

    def read_artifact_manifest(self, artifact_id: str) -> dict[str, object] | None:
        path = self.root / "manifests" / f"{artifact_id}.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _safe_target(self, relative_path: str) -> Path:
        candidate = Path(relative_path)
        if candidate.is_absolute() or ".." in candidate.parts:
            raise ValueError(f"unsafe artifact path: {relative_path!r}")
        target = (self.root / candidate).resolve()
        if self.root != target and self.root not in target.parents:
            raise ValueError(f"artifact path escapes store: {relative_path!r}")
        return target

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _ref_from_manifest(payload: dict[str, object]) -> ArtifactRef:
        return ArtifactRef(
            artifact_id=str(payload["artifact_id"]),
            run_id=str(payload["run_id"]),
            artifact_type=str(payload["artifact_type"]),
            uri=str(payload["uri"]),
            sha256=str(payload["sha256"]),
            schema_name=str(payload["schema_name"]),
            schema_version=str(payload["schema_version"]),
            size_bytes=int(payload["size_bytes"]),
            record_count=int(payload["record_count"]),
        )
