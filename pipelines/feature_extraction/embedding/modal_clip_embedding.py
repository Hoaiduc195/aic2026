"""Resume the existing CLIPA visual-embedding dataset through Modal.

The source parquet files are the authority for the embedding model and row
order. This module only computes the missing suffix of a video: existing
vectors are never sent to Modal and are never recomputed. After the missing
vectors are appended to ``data/embeddings`` it rebuilds the embedding-only
artifacts in ``data/refined``.

The canonical refined schema remains video -> frame. A legacy ``segment_id``
column is preserved only when it already exists in a source parquet so that
the raw source file remains backward compatible; it is not written to the
canonical refined index.

Example::

    modal run pipelines/feature_extraction/embedding/modal_clip_embedding.py \
        --keyframe-dir E:/aic2026/keyframes \
        --data-root D:/workspace/aic/data \
        --batch-size 16

Use ``--dry-run`` to audit the pending suffix without downloading the model or
writing any file. Set ``EMBEDDING_MODAL_GPU=L4`` when a larger GPU is needed.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
import pandas as pd

try:
    import modal
except ModuleNotFoundError:  # Keep local data helpers and tests independent.
    modal = None  # type: ignore[assignment]


MODEL_NAME = "hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B"
MODEL_VERSION = "visual-embedding-clipa-v2-h14"
EMBEDDING_DIMENSION = 1024
EMBEDDING_DTYPE = "float32"
NORMALIZED = True
OPEN_CLIP_VERSION = "2.31.0"
GPU_TYPE = os.environ.get("EMBEDDING_MODAL_GPU", "L4").upper()

REMOTE_BATCH_SIZE = 16
MAX_IMAGE_BYTES = 20 * 1024 * 1024
IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})

INDEX_COLUMNS = [
    "video_id",
    "embedding_row_index",
    "keyframe_no_candidate",
    "original_frame_id_candidate",
    "source_original_frame_id",
    "timestamp_ms_candidate",
    "source_frame_idx",
    "embedding_relative_path",
    "source_embedding_uri",
    "embedding_dim",
    "dtype",
    "normalized",
    "model_name",
    "model_version",
    "mapping_status",
    "ready_for_db",
]

SOURCE_REQUIRED_COLUMNS = {
    "video_id",
    "embedding_uri",
    "embedding_dim",
    "model_name",
    "model_version",
    "original_frame_id",
    "dtype",
    "normalized",
}

KEYFRAME_REQUIRED_COLUMNS = {
    "video_id",
    "keyframe_no",
    "source_frame_idx",
    "original_frame_id_candidate",
    "timestamp_ms_candidate",
    "frame_id_status",
}


@dataclass(frozen=True, slots=True)
class PendingJob:
    """One keyframe that still needs an embedding."""

    video_id: str
    keyframe_no: int
    image_path: Path
    relative_path: str


@dataclass(frozen=True, slots=True)
class VideoAudit:
    """Counts and pending jobs for one video."""

    video_id: str
    expected_rows: int
    existing_rows: int
    pending_jobs: tuple[PendingJob, ...]
    pending_insert_positions: tuple[int, ...]
    pending_original_frame_ids: tuple[int, ...]


def safe_print(message: str) -> None:
    """Print logs without failing on a non-Unicode Windows console."""

    try:
        print(message)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "utf-8"
        print(message.encode(encoding, errors="backslashreplace").decode(encoding))


def _natural_key(value: str | Path) -> tuple[tuple[int, int | str], ...]:
    pieces = re.split(r"(\d+)", str(value).replace("\\", "/"))
    return tuple(
        (0, int(piece)) if piece.isdigit() else (1, piece.casefold())
        for piece in pieces
        if piece
    )


def validate_relative_path(relative_path: str) -> str:
    """Reject absolute, traversing, drive-qualified, or non-normal paths."""

    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("relative_path phải là chuỗi không rỗng")
    if "\\" in relative_path:
        raise ValueError("relative_path phải dùng dấu /")
    parsed = PurePosixPath(relative_path)
    if (
        parsed.is_absolute()
        or ".." in parsed.parts
        or (parsed.parts and ":" in parsed.parts[0])
    ):
        raise ValueError("relative_path không được là absolute hoặc chứa ..")
    normalized = parsed.as_posix()
    if normalized != relative_path:
        raise ValueError("relative_path phải ở dạng chuẩn")
    return normalized


def _validate_required_columns(
    frame: pd.DataFrame, required: set[str], label: str
) -> None:
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"{label} thiếu cột: {', '.join(missing)}")


def _validate_normalized_vectors(vectors: np.ndarray, label: str) -> np.ndarray:
    """Validate and return a new float32 matrix with unit-length rows."""

    array = np.asarray(vectors)
    if array.ndim != 2 or array.shape[1] != EMBEDDING_DIMENSION:
        raise ValueError(
            f"{label} phải có shape (n, {EMBEDDING_DIMENSION}), nhận {array.shape}"
        )
    if array.dtype != np.dtype(EMBEDDING_DTYPE):
        raise ValueError(f"{label} phải có dtype {EMBEDDING_DTYPE}, nhận {array.dtype}")
    if not np.isfinite(array).all():
        raise ValueError(f"{label} chứa NaN hoặc vô cực")
    norms = np.linalg.norm(array, axis=1)
    if not np.allclose(norms, 1.0, rtol=0.0, atol=2e-3):
        raise ValueError(f"{label} không được normalize theo L2")
    return np.array(array, dtype=np.float32, copy=True)


def validate_source_artifacts(
    source_frame: pd.DataFrame, embedding_matrix: np.ndarray, *, video_id: str
) -> None:
    """Fail fast if a source file does not use the recorded model contract."""

    _validate_required_columns(source_frame, SOURCE_REQUIRED_COLUMNS, "source parquet")
    if len(source_frame) != len(embedding_matrix):
        raise ValueError(
            f"{video_id}: parquet có {len(source_frame)} dòng nhưng npy có "
            f"{len(embedding_matrix)} vector"
        )
    if len(source_frame) == 0:
        raise ValueError(f"{video_id}: source embedding rỗng")
    if set(source_frame["video_id"].astype(str)) != {video_id}:
        raise ValueError(f"{video_id}: source parquet chứa video_id khác")
    if set(source_frame["model_name"].dropna().astype(str)) != {MODEL_NAME}:
        raise ValueError(f"{video_id}: model_name không đúng model đã dùng")
    if set(source_frame["model_version"].dropna().astype(str)) != {MODEL_VERSION}:
        raise ValueError(f"{video_id}: model_version không đúng manifest")
    if set(source_frame["embedding_dim"].dropna().astype(int)) != {
        EMBEDDING_DIMENSION
    }:
        raise ValueError(f"{video_id}: embedding_dim không phải {EMBEDDING_DIMENSION}")
    if set(source_frame["dtype"].dropna().astype(str)) != {EMBEDDING_DTYPE}:
        raise ValueError(f"{video_id}: dtype không phải {EMBEDDING_DTYPE}")
    if not source_frame["normalized"].eq(NORMALIZED).all():
        raise ValueError(f"{video_id}: normalized phải là True")
    original_ids = source_frame["original_frame_id"].astype(int).tolist()
    if any(identifier < 0 for identifier in original_ids):
        raise ValueError(f"{video_id}: original_frame_id không được âm")
    if len(set(original_ids)) != len(original_ids):
        raise ValueError(f"{video_id}: original_frame_id bị trùng trong source parquet")
    matrix = np.asarray(embedding_matrix)
    if matrix.ndim != 2 or matrix.shape[1] != EMBEDDING_DIMENSION:
        raise ValueError(f"{video_id}: npy có shape không đúng: {matrix.shape}")
    if matrix.dtype != np.dtype(EMBEDDING_DTYPE):
        raise ValueError(f"{video_id}: npy có dtype không đúng: {matrix.dtype}")
    sample_indices = sorted({0, len(matrix) // 2, len(matrix) - 1})
    _validate_normalized_vectors(matrix[sample_indices], f"{video_id} source sample")


def resolve_keyframe_image(keyframe_dir: Path, video_id: str, keyframe_no: int) -> Path:
    """Resolve one numeric keyframe without trusting a path from external data."""

    root = keyframe_dir.resolve()
    video_dir = (root / video_id).resolve()
    if root not in video_dir.parents:
        raise ValueError(f"video_id không hợp lệ: {video_id}")
    if not video_dir.is_dir():
        raise FileNotFoundError(f"Không tìm thấy keyframe directory: {video_dir}")
    matches = [
        path
        for path in video_dir.iterdir()
        if path.is_file()
        and path.suffix.casefold() in IMAGE_EXTENSIONS
        and path.stem.isdigit()
        and int(path.stem) == int(keyframe_no)
    ]
    if not matches:
        raise FileNotFoundError(
            f"{video_id}: thiếu ảnh keyframe_no={keyframe_no} trong {video_dir}"
        )
    if len(matches) > 1:
        names = ", ".join(sorted(path.name for path in matches))
        raise ValueError(f"{video_id}: keyframe {keyframe_no} bị trùng file: {names}")
    return matches[0]


def pending_manifest_rows(
    manifest_frame: pd.DataFrame, *, existing_rows: int, video_id: str
) -> pd.DataFrame:
    """Return the suffix after the already generated row ordinal range."""

    _validate_required_columns(manifest_frame, KEYFRAME_REQUIRED_COLUMNS, "keyframe manifest")
    ordered = (
        manifest_frame[manifest_frame["video_id"].astype(str) == video_id]
        .sort_values(["keyframe_no"])
        .reset_index(drop=True)
    )
    if ordered["keyframe_no"].duplicated().any():
        raise ValueError(f"{video_id}: keyframe_no bị trùng trong manifest")
    if existing_rows > len(ordered):
        raise ValueError(
            f"{video_id}: source có {existing_rows} dòng, manifest chỉ có {len(ordered)}"
        )
    return ordered.iloc[existing_rows:].copy()


def pending_manifest_alignment(
    manifest_frame: pd.DataFrame,
    source_frame: pd.DataFrame,
    *,
    video_id: str,
) -> tuple[pd.DataFrame, tuple[int, ...], tuple[int, ...]]:
    """Find missing rows and their final insertion positions.

    Most incomplete files are a prefix and therefore use row ordinal order.
    Two source files preserve a gap in ``original_frame_id`` for a keyframe
    that was absent when embeddings were generated. When their IDs fit the
    expected row-ordinal range, the missing vector must be inserted at that
    gap, not appended to the end.
    """

    _validate_required_columns(source_frame, SOURCE_REQUIRED_COLUMNS, "source parquet")
    ordered = (
        manifest_frame[manifest_frame["video_id"].astype(str) == video_id]
        .sort_values(["keyframe_no"])
        .reset_index(drop=True)
    )
    existing_ids = source_frame["original_frame_id"].astype(int).tolist()
    if len(existing_ids) > len(ordered):
        raise ValueError(
            f"{video_id}: source có {len(existing_ids)} dòng, manifest chỉ có {len(ordered)}"
        )

    expected_ordinal_ids = set(range(len(ordered)))
    if set(existing_ids).issubset(expected_ordinal_ids):
        missing_ids = sorted(expected_ordinal_ids.difference(existing_ids))
        pending = ordered.iloc[missing_ids].copy()
        positions = tuple(missing_ids)
        original_ids = tuple(missing_ids)
        return pending, positions, original_ids

    candidate_values = ordered["original_frame_id_candidate"]
    if candidate_values.isna().any():
        raise ValueError(
            f"{video_id}: source không phải prefix nhưng manifest có candidate ID thiếu"
        )
    candidate_ids = candidate_values.astype(int).tolist()
    existing_set = set(existing_ids)
    expected_existing_ids = [identifier for identifier in candidate_ids if identifier in existing_set]
    if existing_ids != expected_existing_ids:
        raise ValueError(
            f"{video_id}: không xác định được row order an toàn giữa source và manifest"
        )
    missing_mask = ~candidate_values.astype(int).isin(existing_set)
    pending = ordered.loc[missing_mask].copy()
    positions = tuple(int(position) for position in np.flatnonzero(missing_mask.to_numpy()))
    original_ids = tuple(int(value) for value in pending["original_frame_id_candidate"])
    if len(existing_ids) + len(pending) != len(ordered):
        raise ValueError(f"{video_id}: số dòng missing không khớp manifest")
    return pending, positions, original_ids


def audit_dataset(
    *, data_root: Path, keyframe_dir: Path, video_id: str = ""
) -> tuple[VideoAudit, ...]:
    """Audit all source files and discover only missing keyframe suffixes."""

    manifest_path = data_root / "refined" / "keyframe_manifest.parquet"
    manifest = pd.read_parquet(manifest_path)
    _validate_required_columns(manifest, KEYFRAME_REQUIRED_COLUMNS, "keyframe manifest")
    selected = {video_id} if video_id else set(manifest["video_id"].astype(str))
    audits: list[VideoAudit] = []
    source_dir = data_root / "embeddings"
    for current_video_id in sorted(selected):
        video_manifest = manifest[
            manifest["video_id"].astype(str) == current_video_id
        ]
        if video_manifest.empty:
            raise FileNotFoundError(f"Không có {current_video_id} trong keyframe manifest")
        parquet_path = source_dir / f"{current_video_id}.parquet"
        npy_path = source_dir / f"{current_video_id}.npy"
        if not parquet_path.is_file() or not npy_path.is_file():
            raise FileNotFoundError(
                f"{current_video_id}: thiếu source parquet hoặc npy trong {source_dir}"
            )
        source_frame = pd.read_parquet(parquet_path)
        matrix = np.load(npy_path, mmap_mode="r", allow_pickle=False)
        validate_source_artifacts(source_frame, matrix, video_id=current_video_id)
        pending, insert_positions, original_frame_ids = pending_manifest_alignment(
            video_manifest,
            source_frame,
            video_id=current_video_id,
        )
        jobs: list[PendingJob] = []
        for row in pending.itertuples(index=False):
            image_path = resolve_keyframe_image(
                keyframe_dir, current_video_id, int(row.keyframe_no)
            )
            if image_path.stat().st_size > MAX_IMAGE_BYTES:
                raise ValueError(f"Ảnh quá lớn, từ chối gửi lên Modal: {image_path}")
            relative_path = validate_relative_path(
                f"{current_video_id}/{image_path.name}"
            )
            jobs.append(
                PendingJob(
                    video_id=current_video_id,
                    keyframe_no=int(row.keyframe_no),
                    image_path=image_path,
                    relative_path=relative_path,
                )
            )
        audits.append(
            VideoAudit(
                video_id=current_video_id,
                expected_rows=len(video_manifest),
                existing_rows=len(source_frame),
                pending_jobs=tuple(jobs),
                pending_insert_positions=insert_positions,
                pending_original_frame_ids=original_frame_ids,
            )
        )
    return tuple(audits)


def _temporary_path(target: Path, suffix: str) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=target.parent,
        prefix=f".{target.name}.",
        suffix=suffix,
        delete=False,
    ) as handle:
        return Path(handle.name)


def _atomic_save_npy(target: Path, matrix: np.ndarray) -> None:
    temporary = _temporary_path(target, ".npy")
    try:
        np.save(temporary, matrix, allow_pickle=False)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_to_parquet(target: Path, frame: pd.DataFrame) -> None:
    temporary = _temporary_path(target, ".parquet")
    try:
        frame.to_parquet(temporary, index=False)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_write_json(target: Path, payload: object) -> None:
    temporary = _temporary_path(target, ".json")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_copy(source: Path, target: Path) -> None:
    temporary = _temporary_path(target, target.suffix or ".tmp")
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_image_jobs(jobs: Sequence[PendingJob]) -> tuple[bytes, ...]:
    payloads: list[bytes] = []
    for job in jobs:
        payload = job.image_path.read_bytes()
        if not payload:
            raise ValueError(f"Ảnh rỗng: {job.image_path}")
        if len(payload) > MAX_IMAGE_BYTES:
            raise ValueError(f"Ảnh quá lớn: {job.image_path}")
        payloads.append(payload)
    return tuple(payloads)


def _append_video_embeddings(
    *,
    data_root: Path,
    audit: VideoAudit,
    vectors: np.ndarray,
) -> None:
    """Append one video after full validation."""

    if len(vectors) != len(audit.pending_jobs):
        raise ValueError(
            f"{audit.video_id}: Modal trả {len(vectors)} vector, cần "
            f"{len(audit.pending_jobs)}"
        )
    if not len(vectors):
        return
    new_matrix = _validate_normalized_vectors(vectors, f"{audit.video_id} new vectors")
    source_dir = data_root / "embeddings"
    parquet_path = source_dir / f"{audit.video_id}.parquet"
    npy_path = source_dir / f"{audit.video_id}.npy"
    source_frame = pd.read_parquet(parquet_path)
    existing_matrix = np.load(npy_path, allow_pickle=False)
    validate_source_artifacts(source_frame, existing_matrix, video_id=audit.video_id)
    if len(source_frame) != audit.existing_rows:
        raise RuntimeError(
            f"{audit.video_id}: source đã thay đổi trong lúc chạy; chạy lại audit"
        )
    rows: list[dict[str, Any]] = []
    template = source_frame.iloc[0].to_dict()
    for offset in range(len(new_matrix)):
        row = dict(template)
        row["video_id"] = audit.video_id
        row["original_frame_id"] = audit.pending_original_frame_ids[offset]
        row["embedding_dim"] = EMBEDDING_DIMENSION
        row["model_name"] = MODEL_NAME
        row["model_version"] = MODEL_VERSION
        row["dtype"] = EMBEDDING_DTYPE
        row["normalized"] = NORMALIZED
        row["pipeline_version"] = MODEL_VERSION
        rows.append(row)
    new_rows_by_position = dict(zip(audit.pending_insert_positions, rows))
    source_rows = source_frame.to_dict("records")
    combined_rows: list[dict[str, Any]] = []
    matrix_parts: list[np.ndarray] = []
    existing_index = 0
    new_index = 0
    for final_position in range(audit.expected_rows):
        if final_position in new_rows_by_position:
            combined_rows.append(new_rows_by_position[final_position])
            matrix_parts.append(new_matrix[new_index])
            new_index += 1
        else:
            combined_rows.append(source_rows[existing_index])
            matrix_parts.append(
                np.asarray(existing_matrix[existing_index], dtype=np.float32)
            )
            existing_index += 1
    if existing_index != len(source_rows):
        raise RuntimeError(f"{audit.video_id}: không dùng hết source rows khi chèn")
    if new_index != len(new_matrix):
        raise RuntimeError(f"{audit.video_id}: không dùng hết vector mới khi chèn")
    combined_frame = pd.DataFrame(combined_rows, columns=source_frame.columns)
    combined_matrix = np.stack(matrix_parts).astype(np.float32, copy=False)
    _atomic_save_npy(npy_path, combined_matrix)
    _atomic_to_parquet(parquet_path, combined_frame)
    safe_print(
        f"[embedding] appended {len(new_matrix)}: {audit.video_id} "
        f"({len(combined_matrix)} rows)"
    )


def _mapping_status(manifest_frame: pd.DataFrame) -> str:
    if manifest_frame["frame_id_status"].eq("duplicate_source_frame_idx").any():
        return "duplicate_source_frame_idx_unresolved"
    return "row_order_candidate_needs_canonical_validation"


def _sync_refined_matrix(source_npy: Path, refined_npy: Path) -> None:
    if not refined_npy.is_file() or _sha256(source_npy) != _sha256(refined_npy):
        _atomic_copy(source_npy, refined_npy)


def rebuild_refined_embedding_artifacts(*, data_root: Path) -> dict[str, int]:
    """Rebuild the complete embedding index and manifest after filling gaps."""

    refined_dir = data_root / "refined"
    source_dir = data_root / "embeddings"
    manifest = pd.read_parquet(refined_dir / "keyframe_manifest.parquet")
    _validate_required_columns(manifest, KEYFRAME_REQUIRED_COLUMNS, "keyframe manifest")
    manifest_groups = {
        video: group.sort_values(["keyframe_no"]).reset_index(drop=True)
        for video, group in manifest.groupby(manifest["video_id"].astype(str), sort=True)
    }
    source_parquets = tuple(sorted(source_dir.glob("*.parquet"), key=_natural_key))
    if not source_parquets:
        raise FileNotFoundError(f"Không có source parquet trong {source_dir}")

    index_parts: list[pd.DataFrame] = []
    artifacts: list[dict[str, Any]] = []
    refined_matrix_dir = refined_dir / "embeddings"
    refined_matrix_dir.mkdir(parents=True, exist_ok=True)
    for source_parquet in source_parquets:
        video_id = source_parquet.stem
        if video_id not in manifest_groups:
            raise ValueError(f"{video_id}: source parquet không có trong keyframe manifest")
        source_npy = source_dir / f"{video_id}.npy"
        if not source_npy.is_file():
            raise FileNotFoundError(f"{video_id}: thiếu {source_npy}")
        source_frame = pd.read_parquet(source_parquet)
        matrix = np.load(source_npy, mmap_mode="r", allow_pickle=False)
        validate_source_artifacts(source_frame, matrix, video_id=video_id)
        map_frame = manifest_groups[video_id]
        if len(map_frame) != len(source_frame):
            raise ValueError(
                f"{video_id}: manifest={len(map_frame)} source={len(source_frame)}; "
                "không thể rebuild refined an toàn"
            )

        refined_npy = refined_matrix_dir / f"{video_id}.npy"
        _sync_refined_matrix(source_npy, refined_npy)
        status = _mapping_status(map_frame)
        source_uri = source_frame["embedding_uri"].tolist()
        index_parts.append(
            pd.DataFrame(
                {
                    "video_id": [video_id] * len(source_frame),
                    "embedding_row_index": list(range(len(source_frame))),
                    "keyframe_no_candidate": map_frame["keyframe_no"].tolist(),
                    "original_frame_id_candidate": map_frame[
                        "original_frame_id_candidate"
                    ].tolist(),
                    "source_original_frame_id": source_frame[
                        "original_frame_id"
                    ].astype(int).tolist(),
                    "timestamp_ms_candidate": map_frame[
                        "timestamp_ms_candidate"
                    ].tolist(),
                    "source_frame_idx": map_frame["source_frame_idx"].tolist(),
                    "embedding_relative_path": [
                        f"embeddings/{video_id}.npy"
                    ]
                    * len(source_frame),
                    "source_embedding_uri": source_uri,
                    "embedding_dim": [EMBEDDING_DIMENSION] * len(source_frame),
                    "dtype": [EMBEDDING_DTYPE] * len(source_frame),
                    "normalized": [NORMALIZED] * len(source_frame),
                    "model_name": [MODEL_NAME] * len(source_frame),
                    "model_version": [MODEL_VERSION] * len(source_frame),
                    "mapping_status": [status] * len(source_frame),
                    "ready_for_db": [False] * len(source_frame),
                },
                columns=INDEX_COLUMNS,
            )
        )
        artifacts.append(
            {
                "video_id": video_id,
                "source_parquet": str(source_parquet.resolve()),
                "source_parquet_sha256": _sha256(source_parquet),
                "source_npy": str(source_npy.resolve()),
                "refined_npy": f"embeddings/{video_id}.npy",
                "npy_sha256": _sha256(refined_npy),
                "map_row_count": len(map_frame),
                "parquet_row_count": len(source_frame),
                "npy_row_count": len(matrix),
                "npy_dimension": int(matrix.shape[1]),
                "npy_dtype": str(matrix.dtype),
                "count_match": True,
                "duplicate_map_frame_idx": bool(
                    map_frame["source_frame_idx"].duplicated(keep=False).any()
                ),
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "mapping_status": status,
            }
        )

    index = pd.concat(index_parts, ignore_index=True)[INDEX_COLUMNS]
    _atomic_to_parquet(refined_dir / "embedding_index.parquet", index)
    _atomic_write_json(refined_dir / "embedding_artifacts.json", artifacts)
    _update_normalization_report(
        refined_dir / "normalization_report.json",
        video_count=len(artifacts),
        row_count=len(index),
    )
    return {"video_count": len(artifacts), "row_count": len(index)}


def _update_normalization_report(
    report_path: Path, *, video_count: int, row_count: int
) -> None:
    if not report_path.is_file():
        return
    report = json.loads(report_path.read_text(encoding="utf-8"))
    blockers = report.get("blockers", [])
    report["blockers"] = [
        blocker
        for blocker in blockers
        if not str(blocker).startswith("embedding row counts differ")
    ]
    report["embedding_artifacts"] = {
        "status": "complete_for_keyframe_manifest_rows",
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "video_count": video_count,
        "row_count": row_count,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write_json(report_path, report)


def _parse_remote_results(
    jobs: Sequence[PendingJob], results: Iterable[Mapping[str, Any]]
) -> dict[str, np.ndarray]:
    expected = {job.relative_path: job for job in jobs}
    received: dict[str, np.ndarray] = {}
    for result in results:
        relative_path = validate_relative_path(str(result["relative_path"]))
        if relative_path not in expected:
            raise ValueError(f"Modal trả về path không được yêu cầu: {relative_path}")
        if relative_path in received:
            raise ValueError(f"Modal trả trùng kết quả: {relative_path}")
        vector = np.asarray(result["embedding"], dtype=np.float32)
        received[relative_path] = _validate_normalized_vectors(
            vector.reshape(1, -1), f"Modal result {relative_path}"
        )[0]
    if set(received) != set(expected):
        missing = sorted(set(expected).difference(received))
        raise RuntimeError(f"Modal thiếu kết quả cho {len(missing)} ảnh: {missing[:3]}")
    grouped: dict[str, list[np.ndarray]] = {}
    for job in jobs:
        grouped.setdefault(job.video_id, []).append(received[job.relative_path])
    return {
        video_id: np.stack(video_vectors).astype(np.float32, copy=False)
        for video_id, video_vectors in grouped.items()
    }


def run_pipeline(
    *,
    data_root: Path,
    keyframe_dir: Path,
    batch_size: int = REMOTE_BATCH_SIZE,
    video_id: str = "",
    dry_run: bool = False,
    rebuild_only: bool = False,
) -> None:
    if batch_size < 1:
        raise ValueError("batch_size phải lớn hơn 0")
    audits = audit_dataset(
        data_root=data_root,
        keyframe_dir=keyframe_dir,
        video_id=video_id,
    )
    pending_jobs = tuple(job for audit in audits for job in audit.pending_jobs)
    safe_print(
        f"[embedding] model={MODEL_NAME} version={MODEL_VERSION} "
        f"dim={EMBEDDING_DIMENSION} dtype={EMBEDDING_DTYPE} normalized={NORMALIZED}"
    )
    safe_print(
        f"[embedding] videos={len(audits)} pending={len(pending_jobs)} "
        f"batch_size={batch_size} gpu={GPU_TYPE}"
    )
    for audit in audits:
        safe_print(
            f"[embedding] {audit.video_id}: existing={audit.existing_rows} "
            f"expected={audit.expected_rows} pending={len(audit.pending_jobs)}"
        )
    if dry_run:
        return
    if rebuild_only:
        result = rebuild_refined_embedding_artifacts(data_root=data_root)
        safe_print(f"[embedding] refined rebuilt: {result}")
        return
    if not pending_jobs:
        result = rebuild_refined_embedding_artifacts(data_root=data_root)
        safe_print(f"[embedding] nothing pending; refined rebuilt: {result}")
        return
    if modal is None or VisualEmbeddingWorker is None:
        raise RuntimeError(
            "Thiếu Modal SDK. Cài requirements-modal.txt rồi chạy bằng modal run."
        )

    worker = VisualEmbeddingWorker()
    remote_results: list[Mapping[str, Any]] = []
    for start in range(0, len(pending_jobs), batch_size):
        batch = pending_jobs[start : start + batch_size]
        safe_print(
            f"[embedding] gửi Modal {start + 1}-{start + len(batch)}/{len(pending_jobs)}"
        )
        results = worker.embed_batch.remote(
            list(_read_image_jobs(batch)),
            [job.relative_path for job in batch],
        )
        remote_results.extend(results)

    vectors_by_video = _parse_remote_results(pending_jobs, remote_results)
    for audit in audits:
        _append_video_embeddings(
            data_root=data_root,
            audit=audit,
            vectors=vectors_by_video.get(
                audit.video_id,
                np.empty((0, EMBEDDING_DIMENSION), dtype=np.float32),
            ),
        )
    result = rebuild_refined_embedding_artifacts(data_root=data_root)
    safe_print(f"[embedding] refined rebuilt: {result}")


app = None
VisualEmbeddingWorker: Any = None

if modal is not None:
    MODEL_CACHE_DIR = "/root/.cache/aic-clipa"
    model_cache = modal.Volume.from_name(
        "aic-clipa-model-cache",
        create_if_missing=True,
    )
    image = (
        modal.Image.debian_slim(python_version="3.11")
        .pip_install(
            "open_clip_torch==2.31.0",
            "Pillow>=10,<13",
            "pandas>=2.2,<3",
            "torch>=2.3,<2.6",
            "torchvision>=0.18,<0.21",
        )
        .env(
            {
                "HF_HOME": MODEL_CACHE_DIR,
                "HUGGINGFACE_HUB_CACHE": f"{MODEL_CACHE_DIR}/hub",
                "TORCH_HOME": MODEL_CACHE_DIR,
            }
        )
    )
    app = modal.App(
        "aic-clipa-embedding",
        image=image,
        volumes={MODEL_CACHE_DIR: model_cache},
    )

    @app.cls(
        gpu=GPU_TYPE,
        memory=24_576,
        timeout=12 * 60 * 60,
        scaledown_window=120,
        max_containers=1,
    )
    class VisualEmbeddingWorker:
        """Long-lived OpenCLIP worker for exact CLIPA inference."""

        @modal.enter()
        def load_model(self) -> None:
            import open_clip
            import torch

            self.device = torch.device("cuda")
            self.model, self.preprocess = open_clip.create_model_from_pretrained(
                MODEL_NAME,
                device=self.device,
            )
            self.model.eval()
            model_cache.commit()
            safe_print(
                f"Loaded {MODEL_NAME} with open_clip 2.31.0 "
                f"on Modal {GPU_TYPE} in float32"
            )

        @modal.method()
        def embed_batch(
            self, image_bytes: list[bytes], relative_paths: list[str]
        ) -> list[dict[str, Any]]:
            import io

            import torch
            from PIL import Image

            if len(image_bytes) != len(relative_paths):
                raise ValueError("Modal input ảnh và path không cùng số lượng")
            if not image_bytes:
                return []
            tensors = []
            for payload in image_bytes:
                with Image.open(io.BytesIO(payload)) as image_item:
                    tensors.append(self.preprocess(image_item.convert("RGB")))
            batch = torch.stack(tensors).to(self.device)
            with torch.inference_mode():
                features = self.model.encode_image(batch)
                features = torch.nn.functional.normalize(features.float(), dim=-1)
            matrix = features.detach().cpu().numpy().astype(np.float32, copy=False)
            if matrix.shape != (len(relative_paths), EMBEDDING_DIMENSION):
                raise RuntimeError(
                    f"Model trả shape {matrix.shape}, cần "
                    f"({len(relative_paths)}, {EMBEDDING_DIMENSION})"
                )
            return [
                {
                    "relative_path": validate_relative_path(relative_path),
                    "embedding": vector.tolist(),
                }
                for relative_path, vector in zip(relative_paths, matrix)
            ]

    @app.local_entrypoint()
    def main(
        keyframe_dir: str = r"E:\aic2026\keyframes",
        data_root: str = r"D:\workspace\aic\data",
        batch_size: int = REMOTE_BATCH_SIZE,
        video_id: str = "",
        dry_run: bool = False,
        rebuild_only: bool = False,
    ) -> None:
        run_pipeline(
            data_root=Path(data_root),
            keyframe_dir=Path(keyframe_dir),
            batch_size=batch_size,
            video_id=video_id,
            dry_run=dry_run,
            rebuild_only=rebuild_only,
        )


if __name__ == "__main__":
    if modal is None:
        raise SystemExit(
            "Cài Modal SDK rồi chạy: modal run "
            "pipelines/feature_extraction/embedding/modal_clip_embedding.py"
        )
    raise SystemExit(
        "Hãy chạy file này bằng `modal run "
        "pipelines/feature_extraction/embedding/modal_clip_embedding.py`."
    )
