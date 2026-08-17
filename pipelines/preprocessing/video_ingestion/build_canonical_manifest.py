"""Build the AIC canonical video manifest from local source videos.

The repository's probe module already defines the technical video contract,
but local probing naturally returns ``file://`` URIs. This command converts
those rows into the credential-free R2 identity used by the database importer:
``object_key=videos/<filename>`` and ``storage_uri=r2://aic/videos/<filename>``.

It intentionally does not infer ``frame_count`` from a container estimate.
That field remains nullable until the sequential full-frame stage produces a
truthful count. Keyframe counts are never used as video frame counts.

Example::

    python -m pipelines.preprocessing.video_ingestion.build_canonical_manifest \
        --input-dir E:/aic2026/videos \
        --data-root D:/workspace/aic/data
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from .probe import probe_one

VIDEO_EXTENSIONS = frozenset({".mp4", ".webm", ".ogg"})
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
FPS_PATTERN = re.compile(r"^[1-9][0-9]*/[1-9][0-9]*$")
SCHEMA_VERSION = "1.0.0"

CANONICAL_COLUMNS = [
    "video_id",
    "object_key",
    "original_filename",
    "storage_uri",
    "duration_ms",
    "fps_str",
    "fps",
    "width",
    "height",
    "size_bytes",
    "sha256",
    "etag",
    "version_id",
    "frame_count",
    "mime_type",
    "dataset_version",
    "pipeline_version",
    "schema_version",
    # Legacy local-probe columns retained for preprocessing compatibility.
    "path",
    "duration_s",
    "codec",
    "n_frames_est",
]


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


def video_files(input_dir: Path) -> tuple[Path, ...]:
    """Return supported video files in deterministic order."""

    if not input_dir.is_dir():
        raise FileNotFoundError(f"Không tìm thấy input video directory: {input_dir}")
    files = tuple(
        sorted(
            (
                path
                for path in input_dir.iterdir()
                if path.is_file() and path.suffix.casefold() in VIDEO_EXTENSIONS
            ),
            key=lambda path: _natural_key(path.name),
        )
    )
    if not files:
        raise FileNotFoundError(f"Không có video được hỗ trợ trong {input_dir}")
    return files


def r2_identity(
    filename: str, *, bucket: str = "aic", object_prefix: str = "videos"
) -> tuple[str, str]:
    """Return a safe object key and credential-free R2 URI."""

    if not filename or Path(filename).name != filename:
        raise ValueError(f"Tên file video không hợp lệ: {filename!r}")
    if not bucket or "/" in bucket or "\\" in bucket or any(c.isspace() for c in bucket):
        raise ValueError(f"Bucket không hợp lệ: {bucket!r}")
    prefix = object_prefix.strip("/")
    if not prefix or ".." in Path(prefix).parts or "\\" in prefix:
        raise ValueError(f"Object prefix không hợp lệ: {object_prefix!r}")
    object_key = f"{prefix}/{filename}"
    return object_key, f"r2://{bucket}/{object_key}"


def build_manifest_row(
    video_path: Path,
    probed: Mapping[str, Any],
    *,
    bucket: str = "aic",
    object_prefix: str = "videos",
    dataset_version: str = "aic2026",
    pipeline_version: str = "video-manifest-probe-v1",
) -> dict[str, Any]:
    """Convert one local probe result to the canonical video row."""

    video_id = video_path.stem
    if not VIDEO_ID_PATTERN.fullmatch(video_id):
        raise ValueError(f"video_id không an toàn: {video_id!r}")
    object_key, storage_uri = r2_identity(
        video_path.name,
        bucket=bucket,
        object_prefix=object_prefix,
    )
    fps_str = str(probed["fps_str"])
    if not FPS_PATTERN.fullmatch(fps_str):
        raise ValueError(f"{video_id}: fps_str không chính xác: {fps_str!r}")
    suffix = video_path.suffix.casefold()
    mime_type = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".ogg": "video/ogg",
    }[suffix]
    return {
        "video_id": video_id,
        "object_key": object_key,
        "original_filename": video_path.name,
        "storage_uri": storage_uri,
        "duration_ms": int(probed["duration_ms"]),
        "fps_str": fps_str,
        "fps": float(probed["fps"]),
        "width": int(probed["width"]),
        "height": int(probed["height"]),
        "size_bytes": int(video_path.stat().st_size),
        "sha256": None,
        "etag": probed.get("etag"),
        "version_id": probed.get("version_id"),
        # Probe deliberately leaves this null; full sequential decode owns it.
        "frame_count": None,
        "mime_type": mime_type,
        "dataset_version": dataset_version,
        "pipeline_version": pipeline_version,
        "schema_version": SCHEMA_VERSION,
        "path": str(video_path.resolve()),
        "duration_s": float(probed["duration_s"]),
        "codec": str(probed["codec"]),
        "n_frames_est": int(probed["n_frames_est"]),
    }


def validate_video_ids(
    frame: pd.DataFrame,
    *,
    expected_ids: set[str] | None = None,
    bucket: str = "aic",
    object_prefix: str = "videos",
) -> None:
    """Validate identity and DB-bound fields before writing an artifact."""

    missing = sorted(set(CANONICAL_COLUMNS).difference(frame.columns))
    if missing:
        raise ValueError(f"Manifest thiếu cột: {missing}")
    if frame.empty:
        raise ValueError("Manifest video rỗng")
    if frame["video_id"].duplicated().any():
        raise ValueError("Manifest chứa video_id trùng")
    ids = set(frame["video_id"].astype(str))
    if expected_ids is not None and ids != expected_ids:
        raise ValueError(
            f"video_id lệch expected: missing={sorted(expected_ids - ids)[:5]}, "
            f"extra={sorted(ids - expected_ids)[:5]}"
        )
    for row in frame.itertuples(index=False):
        if not VIDEO_ID_PATTERN.fullmatch(str(row.video_id)):
            raise ValueError(f"video_id không an toàn: {row.video_id!r}")
        expected_key, expected_uri = r2_identity(
            row.original_filename,
            bucket=bucket,
            object_prefix=object_prefix,
        )
        if row.object_key != expected_key:
            raise ValueError(f"{row.video_id}: object_key không khớp filename")
        if row.storage_uri != expected_uri:
            raise ValueError(f"{row.video_id}: storage_uri không khớp object_key")
        if int(row.duration_ms) <= 0 or float(row.fps) <= 0:
            raise ValueError(f"{row.video_id}: duration/fps không hợp lệ")
        if not FPS_PATTERN.fullmatch(str(row.fps_str)):
            raise ValueError(f"{row.video_id}: fps_str không hợp lệ")
        if int(row.width) <= 0 or int(row.height) <= 0:
            raise ValueError(f"{row.video_id}: kích thước video không hợp lệ")
        if int(row.size_bytes) < 0:
            raise ValueError(f"{row.video_id}: size_bytes không hợp lệ")


def load_expected_video_ids(keyframe_manifest: Path) -> set[str]:
    """Load the existing keyframe manifest only for identity cross-checking."""

    manifest = pd.read_parquet(keyframe_manifest, columns=["video_id"])
    ids = set(manifest["video_id"].astype(str))
    if not ids:
        raise ValueError("keyframe manifest không có video_id")
    return ids


def _probe_path(path: Path, options: Mapping[str, str]) -> dict[str, Any]:
    probed = probe_one(str(path))
    return build_manifest_row(path, probed, **options)


def build_manifest(
    input_dir: Path,
    *,
    expected_ids: set[str] | None,
    bucket: str,
    object_prefix: str,
    dataset_version: str,
    pipeline_version: str,
    workers: int,
) -> pd.DataFrame:
    """Probe all videos concurrently, then validate the complete table."""

    paths = video_files(input_dir)
    options = {
        "bucket": bucket,
        "object_prefix": object_prefix,
        "dataset_version": dataset_version,
        "pipeline_version": pipeline_version,
    }
    rows: list[dict[str, Any] | None] = [None] * len(paths)
    failures: list[str] = []
    max_workers = max(1, min(int(workers), len(paths)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_probe_path, path, options): index
            for index, path in enumerate(paths)
        }
        for future in as_completed(futures):
            index = futures[future]
            try:
                rows[index] = future.result()
            except Exception as error:  # noqa: BLE001 - aggregate all failures.
                failures.append(f"{paths[index].name}: {type(error).__name__}: {error}")
    if failures:
        raise RuntimeError(
            f"Probe thất bại {len(failures)}/{len(paths)} video:\n"
            + "\n".join(sorted(failures)[:20])
        )
    frame = pd.DataFrame([row for row in rows if row is not None], columns=CANONICAL_COLUMNS)
    validate_video_ids(
        frame,
        expected_ids=expected_ids,
        bucket=bucket,
        object_prefix=object_prefix,
    )
    return frame.sort_values("video_id").reset_index(drop=True)


def _atomic_write_parquet(frame: pd.DataFrame, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=target.parent, prefix=f".{target.name}.", suffix=".parquet", delete=False
    ) as handle:
        temporary = Path(handle.name)
    try:
        frame.to_parquet(temporary, index=False)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_write_csv(frame: pd.DataFrame, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=target.parent, prefix=f".{target.name}.", suffix=".csv", delete=False
    ) as handle:
        temporary = Path(handle.name)
    try:
        frame.to_csv(temporary, index=False, encoding="utf-8")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_write_json(payload: object, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=target.parent, prefix=f".{target.name}.", suffix=".json", delete=False
    ) as handle:
        temporary = Path(handle.name)
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def update_normalization_report(
    report_path: Path, *, video_count: int, output_files: list[str]
) -> None:
    """Record the completed artifact without clearing unrelated blockers."""

    if not report_path.is_file():
        return
    report = json.loads(report_path.read_text(encoding="utf-8"))
    blocker = "canonical videos manifest is not present in aic/data"
    report["blockers"] = [item for item in report.get("blockers", []) if item != blocker]
    current_outputs = list(report.get("output_files", []))
    for output in output_files:
        if output not in current_outputs:
            current_outputs.append(output)
    report["output_files"] = current_outputs
    report["video_manifest"] = {
        "status": "complete",
        "video_count": video_count,
        "manifest_path": "videos_manifest.parquet",
        "object_bucket": "aic",
        "object_prefix": "videos",
        "frame_count_policy": "nullable_until_sequential_full_frame_decode",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write_json(report, report_path)


def run(
    *,
    input_dir: Path,
    data_root: Path,
    keyframe_manifest: Path,
    bucket: str,
    object_prefix: str,
    dataset_version: str,
    pipeline_version: str,
    workers: int,
    dry_run: bool,
) -> pd.DataFrame:
    expected_ids = load_expected_video_ids(keyframe_manifest)
    frame = build_manifest(
        input_dir,
        expected_ids=expected_ids,
        bucket=bucket,
        object_prefix=object_prefix,
        dataset_version=dataset_version,
        pipeline_version=pipeline_version,
        workers=workers,
    )
    safe_print(
        f"[video-manifest] videos={len(frame)} "
        f"frame_count_null={int(frame['frame_count'].isna().sum())}"
    )
    if dry_run:
        return frame
    refined_dir = data_root / "refined"
    parquet_path = refined_dir / "videos_manifest.parquet"
    csv_path = refined_dir / "videos_manifest.csv"
    _atomic_write_parquet(frame, parquet_path)
    _atomic_write_csv(frame, csv_path)
    report_path = refined_dir / "normalization_report.json"
    update_normalization_report(
        report_path,
        video_count=len(frame),
        output_files=["videos_manifest.parquet", "videos_manifest.csv"],
    )
    safe_print(f"[video-manifest] wrote {parquet_path}")
    safe_print(f"[video-manifest] wrote {csv_path}")
    return frame


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=Path(r"E:\aic2026\videos"))
    parser.add_argument("--data-root", type=Path, default=Path(r"D:\workspace\aic\data"))
    parser.add_argument(
        "--keyframe-manifest",
        type=Path,
        default=Path(r"D:\workspace\aic\data\refined\keyframe_manifest.parquet"),
    )
    parser.add_argument("--bucket", default="aic")
    parser.add_argument("--object-prefix", default="videos")
    parser.add_argument("--dataset-version", default="aic2026")
    parser.add_argument("--pipeline-version", default="video-manifest-probe-v1")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> None:
    args = _parser().parse_args()
    run(
        input_dir=args.input_dir,
        data_root=args.data_root,
        keyframe_manifest=args.keyframe_manifest,
        bucket=args.bucket,
        object_prefix=args.object_prefix,
        dataset_version=args.dataset_version,
        pipeline_version=args.pipeline_version,
        workers=args.workers,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
