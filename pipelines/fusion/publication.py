"""Offline evidence alignment and reproducible artifact publication."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

from pipelines.preprocessing.temporal import TemporalNode


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    segment_id: str
    modality: str
    start_ms: int
    end_ms: int
    content: str
    confidence: float
    extraction_version: str

    def __post_init__(self) -> None:
        if not self.evidence_id or not self.segment_id or not self.modality or not self.extraction_version:
            raise ValueError("evidence identity, modality, and extraction_version are required")
        if isinstance(self.start_ms, bool) or isinstance(self.end_ms, bool) or not isinstance(self.start_ms, int) or not isinstance(self.end_ms, int) or self.start_ms < 0 or self.end_ms <= self.start_ms:
            raise ValueError("evidence must use a valid half-open millisecond interval")
        if not isinstance(self.content, str):
            raise ValueError("evidence content must be a string")
        if not isinstance(self.confidence, (int, float)) or not math.isfinite(self.confidence) or not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")


@dataclass(frozen=True)
class FusedRecord:
    segment_id: str
    video_id: str
    start_ms: int
    end_ms: int
    evidence_ids: tuple[str, ...]
    modalities: tuple[str, ...]


def fuse_evidence(segments: Iterable[TemporalNode], evidence: Iterable[Evidence]) -> tuple[FusedRecord, ...]:
    segment_items = tuple(segments)
    segment_by_id = {item.node_id: item for item in segment_items}
    if len(segment_by_id) != len(segment_items) or any(item.kind != "segment" for item in segment_items):
        raise ValueError("segments must contain unique segment nodes")
    grouped: dict[str, list[Evidence]] = {item.node_id: [] for item in segment_items}
    seen: set[str] = set()
    for item in evidence:
        if item.evidence_id in seen:
            raise ValueError(f"duplicate evidence_id: {item.evidence_id}")
        seen.add(item.evidence_id)
        segment = segment_by_id.get(item.segment_id)
        if segment is None:
            raise ValueError(f"unknown segment: {item.segment_id}")
        if item.start_ms < segment.start_ms or item.end_ms > segment.end_ms:
            raise ValueError(f"evidence {item.evidence_id} is outside segment")
        grouped[item.segment_id].append(item)
    records = []
    for segment in sorted(segment_items, key=lambda item: (item.video_id, item.start_ms, item.node_id)):
        rows = sorted(grouped[segment.node_id], key=lambda item: (item.start_ms, item.end_ms, item.evidence_id))
        records.append(FusedRecord(segment.node_id, segment.video_id, segment.start_ms, segment.end_ms,
                                   tuple(item.evidence_id for item in rows), tuple(sorted({item.modality for item in rows}))))
    return tuple(records)


@dataclass(frozen=True)
class PublishedArtifact:
    relative_path: str
    sha256: str
    size_bytes: int


@dataclass(frozen=True)
class PublicationReceipt:
    """Deterministic batch receipt; not the canonical per-artifact manifest."""
    manifest_id: str
    run_id: str
    dataset_version: str
    pipeline_version: str
    artifacts: tuple[PublishedArtifact, ...]

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _checksum_and_size(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        before = path.stat()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError(f"artifact changed while hashing: {path}")
    return digest.hexdigest(), after.st_size


def publish_artifacts(
    run_id: str,
    dataset_version: str,
    pipeline_version: str,
    artifact_root: Path,
    artifact_paths: Iterable[Path],
) -> PublicationReceipt:
    if any(not isinstance(value, str) or not value.strip() for value in (run_id, dataset_version, pipeline_version)):
        raise ValueError("run and version identifiers must be non-empty")
    root = Path(artifact_root).resolve(strict=True)
    seen: set[Path] = set()
    artifacts: list[PublishedArtifact] = []
    for requested in artifact_paths:
        path = Path(requested)
        if not path.exists():
            raise FileNotFoundError(path)
        resolved = path.resolve(strict=True)
        try:
            relative = resolved.relative_to(root).as_posix()
        except ValueError as exc:
            raise ValueError(f"artifact is outside publication root: {path}") from exc
        if resolved in seen:
            raise ValueError(f"duplicate artifact: {relative}")
        seen.add(resolved)
        if not resolved.is_file():
            raise ValueError(f"artifact must be a file: {relative}")
        checksum, size_bytes = _checksum_and_size(resolved)
        artifacts.append(PublishedArtifact(relative, checksum, size_bytes))
    ordered = tuple(sorted(artifacts, key=lambda item: item.relative_path))
    payload = {"run_id": run_id, "dataset_version": dataset_version, "pipeline_version": pipeline_version,
               "artifacts": [asdict(item) for item in ordered]}
    manifest_id = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return PublicationReceipt(manifest_id, run_id, dataset_version, pipeline_version, ordered)
