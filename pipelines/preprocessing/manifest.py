"""Deterministic, content-addressed source manifests."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


def _non_empty(value: str, name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")


@dataclass(frozen=True)
class SourceAsset:
    video_id: str
    relative_path: str
    sha256: str
    size_bytes: int


@dataclass(frozen=True)
class DatasetManifest:
    manifest_id: str
    dataset_id: str
    dataset_version: str
    assets: tuple[SourceAsset, ...]

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256_and_size(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        before = path.stat()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
        after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError(f"source changed while hashing: {path}")
    return digest.hexdigest(), after.st_size


def build_dataset_manifest(
    dataset_id: str,
    dataset_version: str,
    dataset_root: Path,
    source_paths: Iterable[Path],
) -> DatasetManifest:
    """Create the same manifest for the same named bytes, regardless of input order."""

    _non_empty(dataset_id, "dataset_id")
    _non_empty(dataset_version, "dataset_version")
    root = Path(dataset_root).resolve(strict=True)
    seen: set[Path] = set()
    assets: list[SourceAsset] = []
    for requested in source_paths:
        path = Path(requested)
        if not path.exists():
            raise FileNotFoundError(path)
        resolved = path.resolve(strict=True)
        try:
            relative = resolved.relative_to(root).as_posix()
        except ValueError as exc:
            raise ValueError(f"source is outside dataset root: {path}") from exc
        if resolved in seen:
            raise ValueError(f"duplicate source: {relative}")
        seen.add(resolved)
        if not resolved.is_file():
            raise ValueError(f"source must be a regular file: {relative}")
        checksum, size_bytes = _sha256_and_size(resolved)
        identity = f"{dataset_id}\0{dataset_version}\0{relative}\0{checksum}".encode()
        assets.append(SourceAsset(hashlib.sha256(identity).hexdigest(), relative, checksum, size_bytes))
    ordered = tuple(sorted(assets, key=lambda item: item.relative_path))
    payload = {
        "dataset_id": dataset_id,
        "dataset_version": dataset_version,
        "assets": [asdict(item) for item in ordered],
    }
    manifest_id = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return DatasetManifest(manifest_id, dataset_id, dataset_version, ordered)
