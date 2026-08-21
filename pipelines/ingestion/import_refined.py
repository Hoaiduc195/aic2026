"""Idempotently import frame-first refined artifacts into PostgreSQL.

The importer keeps the sparse map-keyframes identity intact:

``video -> canonical frame -> occurrence alias -> evidence``

Visual vectors are read from local ``.npy`` files and inserted into pgvector;
they do not need to be uploaded to R2 for local database search.  The module
validates the complete input set before opening a database transaction, then
uses deterministic IDs and upserts so a stopped run can be safely repeated.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

import numpy as np
import pyarrow.parquet as pq

EMBEDDING_DIMENSIONS = 1024
IMPORTER_VERSION = "refined-postgres-import-v2"
FRAME_PIPELINE_VERSION = "map-keyframes-canonical-v1"
DEFAULT_INDEX_VERSION = "aic2026-local-v1"

FrameKey = tuple[str, int]
AliasKey = tuple[str, int]


@dataclass
class DatasetState:
    """Validated in-memory identity maps and artifact counters."""

    data_root: Path
    selected_video_ids: tuple[str, ...]
    videos: dict[str, dict[str, Any]] = field(default_factory=dict)
    canonical_frames: dict[FrameKey, dict[str, Any]] = field(default_factory=dict)
    aliases: dict[AliasKey, dict[str, Any]] = field(default_factory=dict)
    embedding_rows_by_video: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    embedding_paths: dict[str, Path] = field(default_factory=dict)
    embedding_canonical_keys: set[FrameKey] = field(default_factory=set)
    modality_metadata: dict[str, dict[str, Any]] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)
    dataset_version: str = "aic2026"


@dataclass(frozen=True)
class ImportOptions:
    """Runtime options for validation and database import."""

    data_root: Path
    database_url: str | None = None
    batch_size: int = 512
    video_ids: tuple[str, ...] = ()
    limit_videos: int | None = None
    include_captions: bool = True
    include_ocr: bool = True
    include_asr: bool = True
    include_objects: bool = True
    include_embeddings: bool = True
    index_version: str = DEFAULT_INDEX_VERSION
    text_encoder_name: str | None = None
    text_encoder_revision: str | None = None
    dry_run: bool = False


@dataclass(frozen=True)
class FeatureSpec:
    modality: str
    feature_set_id: str
    manifest_path: Path
    producer: str
    pipeline_version: str
    schema_version: str
    model_name: str | None
    model_version: str | None
    embedding_dimensions: int | None
    embedding_dtype: str | None
    embedding_normalized: bool | None
    manifest_sha256: str
    metadata: dict[str, Any]


@dataclass(frozen=True)
class ArtifactSpec:
    modality: str
    feature_set_id: str
    path: Path
    video_id: str | None
    artifact_type: str
    record_count: int | None
    target_table: str
    artifact_id: str
    storage_uri: str
    sha256: str
    size_bytes: int
    metadata: dict[str, Any]


@dataclass(frozen=True)
class ImportBundle:
    feature_specs: tuple[FeatureSpec, ...]
    artifact_specs: tuple[ArtifactSpec, ...]
    primary_artifacts: dict[str, ArtifactSpec]
    embedding_artifacts: dict[str, ArtifactSpec]


def local_file_uri(path: str | Path) -> str:
    """Return a standards-compliant file URI without leaking host separators."""

    raw = str(path).replace("\\", "/")
    if not re.match(r"^[A-Za-z]:/", raw):
        raw = Path(path).resolve().as_posix()
    return f"file:///{quote(raw.lstrip('/'), safe='/:')}"


def _stable_id(prefix: str, *parts: object) -> str:
    payload = "\x1f".join(str(part) for part in parts)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]
    return f"{prefix}_{digest}"


def build_artifact_id(modality: str, storage_uri: str) -> str:
    """Build a deterministic artifact primary key."""

    return _stable_id("artifact", modality, storage_uri)


def build_evidence_id(evidence_type: str, *parts: object) -> str:
    """Build a deterministic evidence ID scoped by modality and source key."""

    return _stable_id("evidence", evidence_type, *parts)


def to_pgvector_literal(vector: np.ndarray | Sequence[float]) -> str:
    """Convert a finite one-dimensional vector to PostgreSQL vector syntax."""

    values = np.asarray(vector)
    if values.ndim != 1:
        raise ValueError("embedding vector must be one-dimensional")
    if values.size == 0:
        raise ValueError("embedding vector cannot be empty")
    if not np.isfinite(values.astype(np.float64, copy=False)).all():
        raise ValueError("embedding vector must contain only finite values")

    rendered: list[str] = []
    for value in values:
        token = format(float(value), ".9g")
        if "e" not in token.lower() and "." not in token:
            token = f"{token}.0"
        rendered.append(token)
    return f"[{','.join(rendered)}]"


def validate_embedding_rows(
    rows: Sequence[dict[str, Any]],
    matrix: np.ndarray,
    *,
    expected_dim: int = EMBEDDING_DIMENSIONS,
) -> None:
    """Validate matrix shape and one-to-one row-index coverage."""

    if matrix.ndim != 2 or matrix.shape[1] != expected_dim:
        raise ValueError(
            f"embedding matrix must have shape (N, {expected_dim}), got {matrix.shape}"
        )
    indices = [int(row["embedding_row_index"]) for row in rows]
    if len(indices) != matrix.shape[0] or set(indices) != set(range(matrix.shape[0])):
        raise ValueError("embedding row index coverage does not match matrix row count")
    if len(set(indices)) != len(indices):
        raise ValueError("embedding row index values must be unique")
    for row in rows:
        if int(row.get("embedding_dim", -1)) != expected_dim:
            raise ValueError("embedding metadata dimension does not match schema")


def _json_object(value: Any) -> dict[str, Any]:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return {}
    if isinstance(value, dict):
        return _json_clean(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {"raw": value}
        return _json_object(parsed)
    return {"value": _json_clean(value)}


def _json_clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_clean(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def _json_text(value: Any) -> str:
    return json.dumps(_json_object(value), ensure_ascii=False, separators=(",", ":"))


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float):
        return math.isnan(value)
    return False


def _as_int(value: Any, field_name: str) -> int:
    if _is_missing(value) or isinstance(value, bool):
        raise ValueError(f"{field_name} must be an integer")
    result = int(value)
    if result != float(value):
        raise ValueError(f"{field_name} must be an integer")
    return result


def _as_float(value: Any, field_name: str) -> float:
    if _is_missing(value) or isinstance(value, bool):
        raise ValueError(f"{field_name} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field_name} must be finite")
    return result


def _parquet_rows(
    path: Path,
    *,
    batch_size: int,
    columns: Sequence[str] | None = None,
) -> Iterator[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(f"missing refined artifact: {path}")
    parquet = pq.ParquetFile(path)
    available = set(parquet.schema_arrow.names)
    if columns:
        missing = sorted(set(columns) - available)
        if missing:
            raise ValueError(f"{path.name} is missing columns: {missing}")
    for batch in parquet.iter_batches(batch_size=batch_size, columns=columns):
        yield from batch.to_pylist()


def _resolve_embedding_path(root: Path, relative_path: str) -> Path:
    normalized = Path(relative_path.replace("\\", "/"))
    candidates = (root / normalized, root / "embeddings" / normalized.name)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"missing local embedding matrix for {relative_path}")


def _capture_metadata(
    state: DatasetState,
    modality: str,
    row: dict[str, Any],
    *,
    keys: Sequence[str],
) -> None:
    current = state.modality_metadata.setdefault(modality, {})
    for key in keys:
        value = row.get(key)
        if _is_missing(value) or str(value).strip() == "":
            continue
        value = str(value)
        if key in current and current[key] != value:
            raise ValueError(f"{modality} has conflicting {key} values")
        current[key] = value


def _alias_for_row(
    state: DatasetState,
    row: dict[str, Any],
    *,
    keyframe_column: str,
) -> tuple[AliasKey, dict[str, Any]]:
    video_id = str(row["video_id"])
    keyframe_no = _as_int(row[keyframe_column], keyframe_column)
    key = (video_id, keyframe_no)
    try:
        alias = state.aliases[key]
    except KeyError as exc:
        raise ValueError(f"row references unknown keyframe occurrence: {key}") from exc

    for candidate_column in (
        "source_frame_idx",
        "source_original_frame_id_candidate",
        "original_frame_id_candidate",
    ):
        candidate = row.get(candidate_column)
        if not _is_missing(candidate) and _as_int(candidate, candidate_column) != int(
            alias["original_frame_id"]
        ):
            raise ValueError(f"{candidate_column} disagrees with map-keyframes for {key}")
    return key, alias


def validate_refined(
    data_root: str | Path,
    *,
    video_ids: Sequence[str] = (),
    limit_videos: int | None = None,
    batch_size: int = 4096,
    include_captions: bool = True,
    include_ocr: bool = True,
    include_asr: bool = True,
    include_objects: bool = True,
    include_embeddings: bool = True,
) -> tuple[DatasetState, dict[str, Any]]:
    """Fail-closed validation of all selected refined artifacts."""

    root = Path(data_root).resolve()
    videos_path = root / "videos_manifest.parquet"
    canonical_path = root / "canonical_frame_candidates.parquet"
    aliases_path = root / "frame_aliases.parquet"
    required_paths = [videos_path, canonical_path, aliases_path]
    if include_captions:
        required_paths.append(root / "captions_en.parquet")
    if include_ocr:
        required_paths.append(root / "ocr.parquet")
    if include_asr:
        required_paths.append(root / "asr_spans.parquet")
    if include_objects:
        required_paths.extend([root / "objects.parquet", root / "object_frame_manifest.parquet"])
    if include_embeddings:
        required_paths.extend([root / "embedding_index.parquet", root / "embeddings"])
    for path in required_paths:
        if not path.exists():
            raise FileNotFoundError(f"missing refined input: {path}")

    raw_videos = list(_parquet_rows(videos_path, batch_size=batch_size))
    available_video_ids = {str(row["video_id"]) for row in raw_videos}
    requested = {str(video_id) for video_id in video_ids}
    unknown = sorted(requested - available_video_ids)
    if unknown:
        raise ValueError(f"unknown video_id values: {unknown[:5]}")
    selected = requested or available_video_ids
    if limit_videos is not None:
        if limit_videos <= 0:
            raise ValueError("limit_videos must be positive")
        selected = set(sorted(selected)[:limit_videos])
    selected_ids = tuple(sorted(selected))

    state = DatasetState(data_root=root, selected_video_ids=selected_ids)
    for row in raw_videos:
        video_id = str(row["video_id"])
        if video_id not in selected:
            continue
        if video_id in state.videos:
            raise ValueError(f"duplicate video_id: {video_id}")
        duration_ms = _as_int(row["duration_ms"], "duration_ms")
        if duration_ms <= 0:
            raise ValueError(f"video duration must be positive: {video_id}")
        state.videos[video_id] = row
    if set(state.videos) != selected:
        raise ValueError("videos manifest does not cover selected video IDs")
    state.dataset_version = str(next(iter(state.videos.values())).get("dataset_version") or "aic2026")

    for row in _parquet_rows(canonical_path, batch_size=batch_size):
        video_id = str(row["video_id"])
        if video_id not in selected:
            continue
        original_frame_id = _as_int(row["original_frame_id"], "original_frame_id")
        if original_frame_id < 0:
            raise ValueError("original_frame_id must be non-negative")
        key = (video_id, original_frame_id)
        if key in state.canonical_frames:
            raise ValueError(f"duplicate canonical frame: {key}")
        if _as_int(row["timestamp_ms"], "timestamp_ms") < 0:
            raise ValueError(f"negative frame timestamp: {key}")
        state.canonical_frames[key] = row

    seen_thumbnails: set[str] = set()
    seen_uris: set[str] = set()
    for row in _parquet_rows(aliases_path, batch_size=batch_size):
        video_id = str(row["video_id"])
        if video_id not in selected:
            continue
        key = (video_id, _as_int(row["keyframe_no"], "keyframe_no"))
        if key in state.aliases:
            raise ValueError(f"duplicate frame alias: {key}")
        canonical_key = (video_id, _as_int(row["original_frame_id"], "original_frame_id"))
        if canonical_key not in state.canonical_frames:
            raise ValueError(f"alias references unknown canonical frame: {key}")
        thumbnail = str(row["thumbnail_object_key"])
        storage_uri = str(row["storage_uri"])
        if thumbnail in seen_thumbnails or storage_uri in seen_uris:
            raise ValueError(f"duplicate keyframe storage identity: {key}")
        seen_thumbnails.add(thumbnail)
        seen_uris.add(storage_uri)
        state.aliases[key] = row

    if not state.canonical_frames or not state.aliases:
        raise ValueError("selected refined data contains no frame identity rows")

    if include_captions:
        caption_count = 0
        for row in _parquet_rows(root / "captions_en.parquet", batch_size=batch_size):
            if str(row["video_id"]) not in selected:
                continue
            _alias_for_row(state, row, keyframe_column="keyframe_no")
            if str(row.get("language", "")) != "en":
                raise ValueError("captions_en.parquet contains a non-English caption")
            if not str(row.get("text_content", "")).strip():
                raise ValueError("caption text cannot be empty")
            _capture_metadata(
                state,
                "caption",
                row,
                keys=("producer", "pipeline_version", "schema_version", "source_model"),
            )
            caption_count += 1
        state.counts["captions"] = caption_count

    if include_ocr:
        ocr_count = 0
        seen_ocr_keys: set[tuple[str, int, int]] = set()
        for row in _parquet_rows(root / "ocr.parquet", batch_size=batch_size):
            video_id = str(row["video_id"])
            if video_id not in selected:
                continue
            key, _alias = _alias_for_row(state, row, keyframe_column="keyframe_no")
            text = str(row.get("text_content", "")).strip()
            normalized_text = str(row.get("normalized_text", "")).strip()
            if not text or not normalized_text:
                raise ValueError("OCR text cannot be empty")
            if str(row.get("language", "")) != "vi":
                raise ValueError("ocr.parquet must contain Vietnamese OCR rows")
            confidence = _as_float(row["confidence"], "confidence")
            if not 0 <= confidence <= 1:
                raise ValueError("OCR confidence must be between 0 and 1")
            detection_confidence = row.get("detection_confidence")
            if not _is_missing(detection_confidence):
                value = _as_float(detection_confidence, "detection_confidence")
                if not 0 <= value <= 1:
                    raise ValueError("OCR detection confidence must be between 0 and 1")
            bbox = row.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) < 4:
                raise ValueError("OCR bbox must contain at least four points")
            for point in bbox:
                if not isinstance(point, (list, tuple)) or len(point) != 2:
                    raise ValueError("OCR bbox points must contain two values")
                _as_float(point[0], "bbox.x")
                _as_float(point[1], "bbox.y")
            source_record_index = _as_int(row["source_record_index"], "source_record_index")
            source_detection_index = _as_int(row["source_detection_index"], "source_detection_index")
            if source_record_index < 0 or source_detection_index < 0:
                raise ValueError("OCR source indexes must be non-negative")
            identity = (key[0], source_record_index, source_detection_index)
            if identity in seen_ocr_keys:
                raise ValueError(f"duplicate OCR detection identity: {identity}")
            seen_ocr_keys.add(identity)
            _capture_metadata(
                state,
                "ocr",
                row,
                keys=("producer", "pipeline_version", "schema_version", "model_version"),
            )
            ocr_count += 1
        state.counts["ocr"] = ocr_count

    if include_asr:
        asr_count = 0
        for row in _parquet_rows(root / "asr_spans.parquet", batch_size=batch_size):
            video_id = str(row["video_id"])
            if video_id not in selected:
                continue
            start_ms = _as_int(row["start_ms"], "start_ms")
            end_ms = _as_int(row["end_ms"], "end_ms")
            duration_ms = _as_int(state.videos[video_id]["duration_ms"], "duration_ms")
            if not 0 <= start_ms < end_ms <= duration_ms:
                raise ValueError(f"invalid ASR interval for {video_id}: {start_ms}-{end_ms}")
            if not str(row.get("text_normalized", "")).strip():
                raise ValueError("ASR normalized text cannot be empty")
            _capture_metadata(
                state,
                "asr",
                row,
                keys=("producer", "pipeline_version", "schema_version", "model_version"),
            )
            asr_count += 1
        state.counts["asr"] = asr_count

    if include_objects:
        object_count = 0
        for row in _parquet_rows(root / "objects.parquet", batch_size=batch_size):
            if str(row["video_id"]) not in selected:
                continue
            _alias_for_row(state, row, keyframe_column="keyframe_no")
            confidence = _as_float(row["confidence"], "confidence")
            if not 0 <= confidence <= 1:
                raise ValueError("object confidence must be between 0 and 1")
            bbox = row.get("bbox")
            normalized_bbox = row.get("normalized_bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                raise ValueError("object bbox must contain four values")
            if not isinstance(normalized_bbox, (list, tuple)) or len(normalized_bbox) != 4:
                raise ValueError("normalized object bbox must contain four values")
            if any(not 0 <= _as_float(value, "normalized_bbox") <= 1 for value in normalized_bbox):
                raise ValueError("normalized object bbox values must be between 0 and 1")
            if not str(row.get("label", "")).strip():
                raise ValueError("object label cannot be empty")
            _capture_metadata(
                state,
                "object",
                row,
                keys=("producer", "pipeline_version", "schema_version", "model_version"),
            )
            object_count += 1
        state.counts["objects"] = object_count

    if include_embeddings:
        embedding_index_path = root / "embedding_index.parquet"
        for row in _parquet_rows(embedding_index_path, batch_size=batch_size):
            video_id = str(row["video_id"])
            if video_id not in selected:
                continue
            keyframe_column = "keyframe_no_candidate"
            key, alias = _alias_for_row(state, row, keyframe_column=keyframe_column)
            if str(row.get("mapping_status", "")) != "canonical_source_frame_id_resolved":
                raise ValueError(f"embedding mapping is not canonical for {key}")
            if str(row.get("dtype", "")) != "float32":
                raise ValueError("only float32 embedding artifacts are supported")
            if row.get("normalized") is not True:
                raise ValueError("embedding rows must be normalized")
            relative_path = str(row["embedding_relative_path"])
            path = _resolve_embedding_path(root, relative_path)
            previous_path = state.embedding_paths.get(video_id)
            if previous_path is not None and previous_path != path:
                raise ValueError(f"video has multiple embedding matrices: {video_id}")
            state.embedding_paths[video_id] = path
            state.embedding_rows_by_video.setdefault(video_id, []).append(row)
            state.embedding_canonical_keys.add((key[0], int(alias["original_frame_id"])))
            _capture_metadata(
                state,
                "visual_embedding",
                row,
                keys=("model_name", "model_version"),
            )

        embedding_count = 0
        for video_id, rows in state.embedding_rows_by_video.items():
            matrix = np.load(state.embedding_paths[video_id], mmap_mode="r", allow_pickle=False)
            validate_embedding_rows(rows, matrix, expected_dim=EMBEDDING_DIMENSIONS)
            if not np.isfinite(matrix).all():
                raise ValueError(f"embedding matrix contains non-finite values: {video_id}")
            embedding_count += len(rows)
        if set(state.embedding_rows_by_video) != set(selected):
            missing = sorted(set(selected) - set(state.embedding_rows_by_video))
            raise ValueError(f"missing embedding matrices for videos: {missing[:5]}")
        state.counts["embeddings"] = embedding_count

    state.counts["videos"] = len(state.videos)
    state.counts["canonical_frames"] = len(state.canonical_frames)
    state.counts["frame_aliases"] = len(state.aliases)
    state.counts["embedding_canonical_frames"] = len(state.embedding_canonical_keys)
    summary = {
        "status": "validated",
        "importer_version": IMPORTER_VERSION,
        "data_root": str(root),
        "dataset_version": state.dataset_version,
        "video_ids": list(selected_ids),
        "counts": dict(state.counts),
        "embedding_upload_to_r2_required": False,
        "text_encoder_revision": None,
    }
    return state, summary


def _sha256_and_size(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _feature_spec(
    state: DatasetState,
    options: ImportOptions,
    *,
    modality: str,
    manifest_path: Path,
    default_producer: str,
    default_pipeline: str,
    model_name: str | None = None,
    model_version: str | None = None,
    embedding: bool = False,
) -> FeatureSpec:
    metadata = state.modality_metadata.get(modality, {})
    producer = str(metadata.get("producer") or default_producer)
    pipeline_version = str(metadata.get("pipeline_version") or default_pipeline)
    schema_version = str(metadata.get("schema_version") or "1.0.0")
    if modality == "visual_embedding":
        model_name = str(metadata.get("model_name") or model_name or "unknown")
        model_version = str(metadata.get("model_version") or model_version or "unknown")
    elif modality == "ocr":
        model_name = str(metadata.get("model_name") or model_name or "PaddleOCR")
        model_version = str(metadata.get("model_version") or model_version or "unknown")
    feature_set_id = f"{state.dataset_version}:{modality}"
    manifest_sha256, _ = _sha256_and_size(manifest_path)
    spec_metadata: dict[str, Any] = {
        "importer_version": IMPORTER_VERSION,
        "storage_mode": "local",
        "r2_embedding_upload_required": False,
    }
    if modality == "visual_embedding":
        spec_metadata.update(
            {
                "query_encoder_name": options.text_encoder_name,
                "query_encoder_revision": options.text_encoder_revision,
                "query_encoder_status": "configured"
                if options.text_encoder_name and options.text_encoder_revision
                else "missing_exact_revision",
            }
        )
    return FeatureSpec(
        modality=modality,
        feature_set_id=feature_set_id,
        manifest_path=manifest_path,
        producer=producer,
        pipeline_version=pipeline_version,
        schema_version=schema_version,
        model_name=model_name if embedding or modality == "ocr" else None,
        model_version=model_version if embedding or modality == "ocr" else None,
        embedding_dimensions=EMBEDDING_DIMENSIONS if embedding else None,
        embedding_dtype="float32" if embedding else None,
        embedding_normalized=True if embedding else None,
        manifest_sha256=manifest_sha256,
        metadata=spec_metadata,
    )


def build_import_bundle(state: DatasetState, options: ImportOptions) -> ImportBundle:
    """Build feature-set/artifact provenance records without touching the DB."""

    specs: list[FeatureSpec] = []
    artifacts: list[ArtifactSpec] = []
    primary: dict[str, ArtifactSpec] = {}
    embedding_artifacts: dict[str, ArtifactSpec] = {}
    root = state.data_root

    modality_config = (
        ("caption", options.include_captions, root / "captions_en.parquet", "legacy-captioning", "caption-import", "captions"),
        ("ocr", options.include_ocr, root / "ocr.parquet", "paddleocr", "ocr-import", "ocr"),
        ("asr", options.include_asr, root / "asr_spans.parquet", "legacy-asr-json", "asr-import", "asr"),
        ("object", options.include_objects, root / "objects.parquet", "object-detection", "object-import", "objects"),
        (
            "visual_embedding",
            options.include_embeddings,
            root / "embedding_index.parquet",
            "visual-embedding-import",
            "embedding-import",
            "embeddings",
        ),
    )
    for modality, enabled, manifest_path, producer, pipeline, count_key in modality_config:
        if not enabled:
            continue
        spec = _feature_spec(
            state,
            options,
            modality=modality,
            manifest_path=manifest_path,
            default_producer=producer,
            default_pipeline=pipeline,
            embedding=modality == "visual_embedding",
        )
        specs.append(spec)
        sha256, size_bytes = _sha256_and_size(manifest_path)
        primary_artifact = ArtifactSpec(
            modality=modality,
            feature_set_id=spec.feature_set_id,
            path=manifest_path,
            video_id=None,
            artifact_type="parquet",
            record_count=state.counts.get(count_key),
            target_table={
                "caption": "text_evidence",
                "ocr": "text_evidence",
                "asr": "text_evidence",
                "object": "object_evidence",
                "visual_embedding": "clip_embeddings",
            }[modality],
            artifact_id=build_artifact_id(modality, local_file_uri(manifest_path)),
            storage_uri=local_file_uri(manifest_path),
            sha256=sha256,
            size_bytes=size_bytes,
            metadata={"role": "index_manifest", "path": str(manifest_path)},
        )
        primary[modality] = primary_artifact
        artifacts.append(primary_artifact)

        if modality == "object":
            frame_manifest_path = root / "object_frame_manifest.parquet"
            frame_sha256, frame_size = _sha256_and_size(frame_manifest_path)
            artifacts.append(
                ArtifactSpec(
                    modality=modality,
                    feature_set_id=spec.feature_set_id,
                    path=frame_manifest_path,
                    video_id=None,
                    artifact_type="parquet",
                    record_count=state.counts["frame_aliases"],
                    target_table="object_frame_manifest",
                    artifact_id=build_artifact_id(modality, local_file_uri(frame_manifest_path)),
                    storage_uri=local_file_uri(frame_manifest_path),
                    sha256=frame_sha256,
                    size_bytes=frame_size,
                    metadata={"role": "frame_status_manifest", "path": str(frame_manifest_path)},
                )
            )

        if modality == "visual_embedding":
            for video_id in state.selected_video_ids:
                path = state.embedding_paths[video_id]
                sha256, size_bytes = _sha256_and_size(path)
                artifact = ArtifactSpec(
                    modality=modality,
                    feature_set_id=spec.feature_set_id,
                    path=path,
                    video_id=video_id,
                    artifact_type="npy",
                    record_count=len(state.embedding_rows_by_video[video_id]),
                    target_table="clip_embeddings",
                    artifact_id=build_artifact_id(modality, local_file_uri(path)),
                    storage_uri=local_file_uri(path),
                    sha256=sha256,
                    size_bytes=size_bytes,
                    metadata={
                        "role": "embedding_matrix",
                        "video_id": video_id,
                        "remote_object_key": f"embeddings/{path.name}",
                    },
                )
                embedding_artifacts[video_id] = artifact
                artifacts.append(artifact)

    return ImportBundle(
        feature_specs=tuple(specs),
        artifact_specs=tuple(artifacts),
        primary_artifacts=primary,
        embedding_artifacts=embedding_artifacts,
    )


def import_to_database(state: DatasetState, options: ImportOptions) -> dict[str, Any]:
    """Delegate PostgreSQL writes to the database writer module."""

    from .database_writer import import_to_database as write_to_database

    return write_to_database(state, options)


def run_import(options: ImportOptions) -> dict[str, Any]:
    state, summary = validate_refined(
        options.data_root,
        video_ids=options.video_ids,
        limit_videos=options.limit_videos,
        batch_size=options.batch_size,
        include_captions=options.include_captions,
        include_ocr=options.include_ocr,
        include_asr=options.include_asr,
        include_objects=options.include_objects,
        include_embeddings=options.include_embeddings,
    )
    if options.dry_run:
        summary["status"] = "dry_run"
        return summary
    return {**summary, **import_to_database(state, options)}


def _default_data_root() -> Path:
    return Path(__file__).resolve().parents[3] / "data" / "refined"


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=_default_data_root())
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--batch-size", type=_positive_int, default=512)
    parser.add_argument("--video-id", dest="video_ids", action="append", default=[])
    parser.add_argument("--limit-videos", type=_positive_int, default=None)
    parser.add_argument("--skip-captions", action="store_true")
    parser.add_argument("--skip-ocr", action="store_true")
    parser.add_argument("--skip-asr", action="store_true")
    parser.add_argument("--skip-objects", action="store_true")
    parser.add_argument("--skip-embeddings", action="store_true")
    parser.add_argument("--index-version", default=DEFAULT_INDEX_VERSION)
    parser.add_argument("--text-encoder-name", default=None)
    parser.add_argument("--text-encoder-revision", default=None)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    database_url = args.database_url or os.environ.get("DATABASE_DIRECT_URL") or os.environ.get("DATABASE_URL")
    options = ImportOptions(
        data_root=args.data_root,
        database_url=database_url,
        batch_size=args.batch_size,
        video_ids=tuple(args.video_ids),
        limit_videos=args.limit_videos,
        include_captions=not args.skip_captions,
        include_ocr=not args.skip_ocr,
        include_asr=not args.skip_asr,
        include_objects=not args.skip_objects,
        include_embeddings=not args.skip_embeddings,
        index_version=args.index_version,
        text_encoder_name=args.text_encoder_name,
        text_encoder_revision=args.text_encoder_revision,
        dry_run=args.dry_run,
    )
    try:
        result = run_import(options)
    except (FileNotFoundError, ValueError, RuntimeError, OSError) as exc:
        print(f"Import failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
