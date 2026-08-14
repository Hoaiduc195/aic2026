"""Artifact references and manifest records."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ArtifactRef:
    artifact_id: str
    run_id: str
    artifact_type: str
    uri: str
    sha256: str
    schema_name: str
    schema_version: str
    size_bytes: int
    record_count: int

    def to_manifest(self, *, dataset_id: str, dataset_version: str, created_at: str) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "run_id": self.run_id,
            "dataset_id": dataset_id,
            "dataset_version": dataset_version,
            "artifact_type": self.artifact_type,
            "uri": self.uri,
            "sha256": self.sha256,
            "schema_name": self.schema_name,
            "schema_version": self.schema_version,
            "size_bytes": self.size_bytes,
            "record_count": self.record_count,
            "publication_state": "staged",
            "created_at": created_at,
        }
