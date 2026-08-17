"""Resolve and apply canonical source-frame identities.

The organizer's map-keyframes files provide an authoritative source-frame
index for every selected keyframe occurrence.  This module accepts those maps
directly (CSV or JSON), validates them, and updates all frame-level staging
artifacts without decoding every video again.  The existing sequential
timeline path remains available for callers that need a full-frame manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from ..io_utils import write_csv_atomic, write_json_atomic, write_parquet_atomic
from .build_frame_aliases import (
    ALIAS_COLUMNS,
    CANONICAL_CANDIDATE_COLUMNS,
    validate_alias_artifact,
    validate_canonical_candidates,
)
from .canonical_timeline import build_canonical_timeline, load_canonical_timeline

RESOLVED_STATUS = "canonical_source_frame_id_resolved"
CANONICAL_TIMELINE_DIRNAME = "canonical_frame_timeline"
CANONICAL_TIMELINE_STATS_DIRNAME = "canonical_frame_timeline_stats"
_SAFE_VIDEO_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_SOURCE_MAP_ALIASES = {
    "keyframe_no": ("keyframe_no", "n", "keyframe", "keyframe_id"),
    "source_frame_idx": ("source_frame_idx", "frame_idx", "original_frame_id"),
    "pts_time": ("pts_time", "timestamp_s", "timestamp_seconds"),
    "timestamp_ms": ("timestamp_ms", "pts_timestamp_ms"),
    "fps": ("fps", "frame_rate"),
}


def _validate_video_id(video_id: str) -> str:
    value = str(video_id)
    if not _SAFE_VIDEO_ID.fullmatch(value):
        raise ValueError(f"unsafe video_id: {value}")
    return value


def _json_source_map_rows(payload: Any, default_video_id: str | None) -> list[dict[str, Any]]:
    """Extract row dictionaries from the common per-video JSON map shapes."""

    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = None
        for key in ("keyframes", "frames", "data", "items", "map"):
            value = payload.get(key)
            if isinstance(value, list):
                rows = value
                break
        if rows is None:
            list_values = [
                (str(key), value)
                for key, value in payload.items()
                if isinstance(value, list)
            ]
            if list_values and len(list_values) == len(payload):
                rows = [
                    {**dict(row), "video_id": dict(row).get("video_id", key)}
                    for key, values in list_values
                    for row in values
                    if isinstance(row, dict)
                ]
            elif all(isinstance(value, dict) for value in payload.values()):
                rows = [
                    {**dict(value), "keyframe_no": dict(value).get("keyframe_no", key)}
                    for key, value in payload.items()
                ]
            else:
                rows = [payload]
    else:
        raise TypeError("source map JSON must contain an object or array")

    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise TypeError("source map rows must be JSON objects")
        item = dict(row)
        if "video_id" not in item and default_video_id is not None:
            item["video_id"] = default_video_id
        normalized.append(item)
    return normalized


def _read_source_map_file(path: Path) -> pd.DataFrame:
    default_video_id = path.stem if _SAFE_VIDEO_ID.fullmatch(path.stem) else None
    if path.suffix.lower() == ".csv":
        frame = pd.read_csv(path)
    elif path.suffix.lower() == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        frame = pd.DataFrame(_json_source_map_rows(payload, default_video_id))
    else:
        raise ValueError(f"unsupported source map format: {path}")
    if frame.empty:
        raise ValueError(f"source map is empty: {path}")
    if "video_id" not in frame.columns:
        if default_video_id is None:
            raise ValueError(f"source map needs video_id: {path}")
        frame["video_id"] = default_video_id
    frame["source_map_file"] = path.name
    frame["source_row_index"] = range(len(frame))
    return frame


def _normalize_source_map_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Normalize a raw map to the internal occurrence-map columns."""

    result = frame.copy(deep=True)
    for canonical, aliases in _SOURCE_MAP_ALIASES.items():
        if canonical in result.columns:
            continue
        source = next((name for name in aliases if name in result.columns), None)
        if source is not None:
            result[canonical] = result[source]

    required = {"video_id", "keyframe_no", "source_frame_idx"}
    missing = sorted(required - set(result.columns))
    if missing:
        raise ValueError(f"source map is missing columns: {missing}")

    result["video_id"] = result["video_id"].map(_validate_video_id)
    result["keyframe_no"] = pd.to_numeric(result["keyframe_no"], errors="coerce")
    result["source_frame_idx"] = pd.to_numeric(
        result["source_frame_idx"], errors="coerce"
    )
    for column in ("keyframe_no", "source_frame_idx"):
        values = result[column]
        if values.isna().any() or (values < 0).any() or (values % 1 != 0).any():
            raise ValueError(f"source map has invalid {column}")
    if (result["keyframe_no"] < 1).any():
        raise ValueError("source map has keyframe_no < 1")

    if "timestamp_ms" not in result.columns:
        if "pts_time" not in result.columns:
            raise ValueError("source map needs pts_time or timestamp_ms")
        result["timestamp_ms"] = pd.to_numeric(result["pts_time"], errors="coerce") * 1000.0
    else:
        result["timestamp_ms"] = pd.to_numeric(result["timestamp_ms"], errors="coerce")
    if result["timestamp_ms"].isna().any() or (result["timestamp_ms"] < 0).any():
        raise ValueError("source map has invalid timestamp")
    result["timestamp_ms"] = result["timestamp_ms"].round().astype("int64")
    if "pts_time" not in result.columns:
        result["pts_time"] = result["timestamp_ms"] / 1000.0
    result["pts_time"] = pd.to_numeric(result["pts_time"], errors="coerce")
    if result["pts_time"].isna().any() or (result["pts_time"] < 0).any():
        raise ValueError("source map has invalid pts_time")
    if "fps" in result.columns:
        result["fps"] = pd.to_numeric(result["fps"], errors="coerce")
        if result["fps"].isna().any() or (result["fps"] <= 0).any():
            raise ValueError("source map has invalid fps")
    if result[["video_id", "keyframe_no"]].duplicated().any():
        raise ValueError("source map has duplicate (video_id, keyframe_no)")
    return result.sort_values(
        ["video_id", "keyframe_no", "source_row_index"], kind="stable"
    ).reset_index(drop=True)


def load_source_frame_map(
    map_root: str | Path,
    *,
    expected_video_ids: set[str] | None = None,
) -> pd.DataFrame:
    """Load authoritative per-occurrence source-frame maps from CSV or JSON."""

    root = Path(map_root)
    if root.is_file():
        paths = [root]
    elif root.is_dir():
        paths = sorted(
            path
            for path in root.rglob("*")
            if path.is_file() and path.suffix.lower() in {".csv", ".json"}
        )
    else:
        raise FileNotFoundError(f"source map root does not exist: {root}")
    if not paths:
        raise FileNotFoundError(f"no CSV/JSON source maps found under: {root}")

    if expected_video_ids is not None:
        expected = {_validate_video_id(value) for value in expected_video_ids}
        exact_paths = [path for path in paths if path.stem in expected]
        if exact_paths:
            paths = exact_paths
        elif len(paths) != 1:
            missing = sorted(expected - {path.stem for path in paths})
            raise FileNotFoundError(f"missing source maps for videos: {missing[:10]}")

    parts = [_normalize_source_map_frame(_read_source_map_file(path)) for path in paths]
    result = pd.concat(parts, ignore_index=True)
    if result[["video_id", "keyframe_no"]].duplicated().any():
        raise ValueError("source maps contain duplicate (video_id, keyframe_no)")
    if expected_video_ids is not None:
        expected = {_validate_video_id(value) for value in expected_video_ids}
        actual = set(result["video_id"].astype(str))
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        if missing or extra:
            raise ValueError(
                f"source map video set mismatch; missing={missing[:10]}, extra={extra[:10]}"
            )
    return result


def build_local_video_manifest(
    videos: pd.DataFrame,
    video_root: str | Path,
) -> pd.DataFrame:
    """Build the local decode view without changing the R2 video manifest."""

    required = {"video_id", "original_filename", "fps_str", "fps", "duration_s"}
    missing = sorted(required - set(videos.columns))
    if missing:
        raise ValueError(f"video manifest is missing columns: {missing}")
    root = Path(video_root)
    if not root.is_dir():
        raise FileNotFoundError(f"local video root does not exist: {root}")

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in videos.to_dict("records"):
        video_id = _validate_video_id(raw["video_id"])
        if video_id in seen:
            raise ValueError(f"duplicate video_id: {video_id}")
        seen.add(video_id)
        filename = str(raw["original_filename"]).strip()
        if not filename or Path(filename).name != filename:
            raise ValueError(f"unsafe original_filename for {video_id}: {filename}")
        path = root / filename
        if not path.is_file():
            raise FileNotFoundError(f"missing local video for {video_id}: {path}")
        rows.append(
            {
                "video_id": video_id,
                "path": str(path.resolve()),
                "fps_str": str(raw["fps_str"]),
                "fps": float(raw["fps"]),
                "duration_s": float(raw["duration_s"]),
            }
        )
    return pd.DataFrame(rows, columns=["video_id", "path", "fps_str", "fps", "duration_s"])


def _timeline_fingerprint(row: dict[str, Any]) -> str:
    path = Path(str(row["path"]))
    stat = path.stat()
    payload = "|".join(
        (
            "canonical_timeline_ffprobe_v1",
            str(row["video_id"]),
            str(stat.st_size),
            str(stat.st_mtime_ns),
            str(row["fps_str"]),
        )
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def run_canonical_timelines(
    local_manifest: pd.DataFrame,
    refined_dir: str | Path,
    *,
    limit: int | None = None,
    workers: int = 4,
) -> dict[str, int]:
    """Build resumable metadata-only timelines for local videos."""

    root = Path(refined_dir)
    timeline_dir = root / CANONICAL_TIMELINE_DIRNAME
    stats_dir = root / CANONICAL_TIMELINE_STATS_DIRNAME
    timeline_dir.mkdir(parents=True, exist_ok=True)
    stats_dir.mkdir(parents=True, exist_ok=True)
    if workers < 1:
        raise ValueError("workers must be positive")
    todo = local_manifest.head(limit) if limit is not None else local_manifest
    records = todo.to_dict("records")

    def process(raw: dict[str, Any]) -> str:
        video_id = _validate_video_id(raw["video_id"])
        output_path = timeline_dir / f"{video_id}.parquet"
        stats_path = stats_dir / f"{video_id}.json"
        fingerprint = _timeline_fingerprint(raw)
        if output_path.is_file() and stats_path.is_file():
            try:
                stats = json.loads(stats_path.read_text(encoding="utf-8"))
                existing = load_canonical_timeline(output_path)
                if stats.get("fingerprint") == fingerprint and stats.get("status") == "success":
                    print(f"[canonical-timeline] SKIP {video_id}: {len(existing)} frames")
                    return "skipped"
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                pass

        started = time.perf_counter()
        try:
            timeline = build_canonical_timeline(raw, output_path, backend="ffprobe")
            write_json_atomic(
                {
                    "video_id": video_id,
                    "frame_count": len(timeline),
                    "elapsed_s": round(time.perf_counter() - started, 3),
                    "fingerprint": fingerprint,
                    "status": "success" if len(timeline) else "no_video_frames",
                    "backend": "pyav_sequential_metadata",
                },
                stats_path,
            )
            print(f"[canonical-timeline] {video_id}: {len(timeline)} frames")
            return "done"
        except Exception as error:  # noqa: BLE001 - one damaged video must not abort the batch
            with (root / "canonical_timeline_failed.log").open(
                "a", encoding="utf-8"
            ) as handle:
                handle.write(f"{datetime.now(timezone.utc).isoformat()} | {video_id} | {error}\n")
            print(f"[canonical-timeline] FAILED {video_id}: {type(error).__name__}: {error}")
            return "failed"

    if workers == 1 or len(records) <= 1:
        statuses = [process(raw) for raw in records]
    else:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(process, raw) for raw in records]
            statuses = [future.result() for future in as_completed(futures)]
    return {
        "done": statuses.count("done"),
        "skipped": statuses.count("skipped"),
        "failed": statuses.count("failed"),
    }


def _integer_series(frame: pd.DataFrame, column: str) -> pd.Series:
    values = pd.to_numeric(frame[column], errors="coerce")
    if values.isna().any() or (values < 0).any() or (values % 1 != 0).any():
        raise ValueError(f"{column} must contain non-negative integers")
    return values.astype("int64")


def _validate_canonical_timeline(frame_manifest: pd.DataFrame) -> None:
    required = {"original_frame_id", "decoded_frame_index", "timestamp_ms"}
    missing = sorted(required - set(frame_manifest.columns))
    if missing:
        raise ValueError(f"canonical frame manifest is missing columns: {missing}")
    ids = _integer_series(frame_manifest, "original_frame_id").tolist()
    decoded = _integer_series(frame_manifest, "decoded_frame_index").tolist()
    expected = list(range(len(frame_manifest)))
    if ids != expected or decoded != expected:
        raise ValueError("canonical frame manifest IDs must be contiguous and zero-based")
    timestamps = pd.to_numeric(frame_manifest["timestamp_ms"], errors="coerce")
    if timestamps.isna().any() or (~timestamps.map(math.isfinite)).any() or (timestamps < 0).any():
        raise ValueError("canonical frame manifest has missing or invalid timestamps")


def resolve_keyframe_mapping(
    keyframes: pd.DataFrame,
    canonical_frames: pd.DataFrame,
) -> pd.DataFrame:
    """Resolve every sparse occurrence to a verified canonical frame ID."""

    required = {"video_id", "keyframe_no", "source_frame_idx"}
    missing = sorted(required - set(keyframes.columns))
    if missing:
        raise ValueError(f"keyframe manifest is missing columns: {missing}")
    _validate_canonical_timeline(canonical_frames)

    result = keyframes.copy(deep=True)
    if result[["video_id", "keyframe_no"]].duplicated().any():
        raise ValueError("keyframe manifest has duplicate (video_id, keyframe_no)")
    source_ids = _integer_series(result, "source_frame_idx")
    if len(source_ids) and int(source_ids.max()) >= len(canonical_frames):
        raise ValueError("source_frame_idx is outside canonical timeline")

    canonical_rows = canonical_frames.iloc[source_ids.tolist()].reset_index(drop=True)
    canonical_timestamps = pd.to_numeric(canonical_rows["timestamp_ms"], errors="coerce")
    if canonical_timestamps.isna().any():
        raise ValueError("mapped source frames have missing canonical timestamps")

    if "timestamp_ms_candidate" in result.columns:
        result["source_timestamp_ms_candidate"] = result["timestamp_ms_candidate"]
    result["original_frame_id_candidate"] = source_ids.to_numpy()
    result["canonical_timestamp_ms"] = canonical_timestamps.round().astype("int64").to_numpy()
    result["timestamp_ms_candidate"] = result["canonical_timestamp_ms"]
    if "timestamp_source" in canonical_rows.columns:
        result["canonical_timestamp_source"] = canonical_rows["timestamp_source"].tolist()
    result["frame_id_status"] = RESOLVED_STATUS
    result["ready_for_db"] = True
    return result


def resolve_keyframe_mapping_from_source_map(
    keyframes: pd.DataFrame,
    source_map: pd.DataFrame,
) -> pd.DataFrame:
    """Resolve selected keyframes using the authoritative sparse source map.

    The map proves the identity of selected occurrences; it does not claim to
    enumerate every frame in the video.  Duplicate source frame indices remain
    valid and are intentionally preserved as separate occurrences.
    """

    required = {"video_id", "keyframe_no"}
    missing = sorted(required - set(keyframes.columns))
    if missing:
        raise ValueError(f"keyframe manifest is missing columns: {missing}")
    map_required = {
        "video_id",
        "keyframe_no",
        "source_frame_idx",
        "timestamp_ms",
        "source_map_file",
        "source_row_index",
    }
    missing = sorted(map_required - set(source_map.columns))
    if missing:
        raise ValueError(f"source map is missing normalized columns: {missing}")

    result = keyframes.copy(deep=True)
    if result[["video_id", "keyframe_no"]].duplicated().any():
        raise ValueError("keyframe manifest has duplicate (video_id, keyframe_no)")
    source = source_map.copy(deep=True)
    if source[["video_id", "keyframe_no"]].duplicated().any():
        raise ValueError("source map has duplicate (video_id, keyframe_no)")

    payload_columns = [
        "source_frame_idx",
        "timestamp_ms",
        "source_map_file",
        "source_row_index",
        "pts_time",
        "fps",
    ]
    payload = source[["video_id", "keyframe_no", *payload_columns]].rename(
        columns={column: f"__source_map_{column}" for column in payload_columns}
    )
    merged = result.merge(
        payload,
        on=["video_id", "keyframe_no"],
        how="left",
        validate="one_to_one",
        indicator=True,
    )
    if not merged["_merge"].eq("both").all():
        missing_rows = merged.loc[
            merged["_merge"] != "both", ["video_id", "keyframe_no"]
        ]
        raise ValueError(
            "keyframe manifest has occurrences missing from source map: "
            f"{missing_rows.head(5).to_dict('records')}"
        )
    merged = merged.drop(columns=["_merge"])

    mapped_ids = merged["__source_map_source_frame_idx"].astype("int64")
    for column in ("source_frame_idx", "original_frame_id_candidate"):
        if column not in merged.columns:
            continue
        current = pd.to_numeric(merged[column], errors="coerce")
        conflicts = current.notna() & (current != mapped_ids)
        if conflicts.any():
            sample = merged.loc[conflicts, ["video_id", "keyframe_no", column]]
            raise ValueError(
                f"{column} conflicts with source map: {sample.head(5).to_dict('records')}"
            )

    if "source_timestamp_ms_candidate" not in merged.columns:
        if "timestamp_ms_candidate" in merged.columns:
            merged["source_timestamp_ms_candidate"] = merged[
                "timestamp_ms_candidate"
            ]
        else:
            merged["source_timestamp_ms_candidate"] = pd.NA
    merged["source_frame_idx"] = mapped_ids
    merged["source_map_file"] = merged["__source_map_source_map_file"]
    merged["source_row_index"] = merged["__source_map_source_row_index"].astype("int64")
    merged["pts_time"] = merged["__source_map_pts_time"]
    if "fps" in source.columns:
        merged["fps"] = merged["__source_map_fps"]
    merged["original_frame_id_candidate"] = mapped_ids
    merged["canonical_timestamp_ms"] = merged["__source_map_timestamp_ms"].astype("int64")
    merged["timestamp_ms_candidate"] = merged["canonical_timestamp_ms"]
    merged["canonical_timestamp_source"] = "map-keyframes"
    merged["frame_id_status"] = RESOLVED_STATUS
    merged["ready_for_db"] = True
    return merged.drop(
        columns=[f"__source_map_{column}" for column in payload_columns]
    )


def _mapping_table(resolved: pd.DataFrame) -> pd.DataFrame:
    required = {
        "video_id",
        "keyframe_no",
        "original_frame_id_candidate",
        "timestamp_ms_candidate",
        "canonical_timestamp_ms",
        "frame_id_status",
    }
    missing = sorted(required - set(resolved.columns))
    if missing:
        raise ValueError(f"resolved keyframe manifest is missing columns: {missing}")
    mapping = resolved[
        [
            "video_id",
            "keyframe_no",
            "original_frame_id_candidate",
            "timestamp_ms_candidate",
            "canonical_timestamp_ms",
            "frame_id_status",
        ]
    ].copy()
    if mapping[["video_id", "keyframe_no"]].duplicated().any():
        raise ValueError("resolved keyframe mapping has duplicate occurrence keys")
    return mapping


def _apply_mapping_to_artifact(
    artifact: pd.DataFrame,
    mapping: pd.DataFrame,
    *,
    keyframe_column: str = "keyframe_no",
    ready_for_db: bool = True,
) -> pd.DataFrame:
    if keyframe_column not in artifact.columns:
        raise ValueError(f"artifact is missing {keyframe_column}")
    if "video_id" not in artifact.columns:
        raise ValueError("artifact is missing video_id")
    right = mapping.rename(columns={"keyframe_no": keyframe_column})
    artifact_columns = set(artifact.columns)
    merged = artifact.merge(
        right,
        on=["video_id", keyframe_column],
        how="left",
        validate="many_to_one",
        suffixes=("", "__canonical"),
        indicator=True,
    )
    if not merged["_merge"].eq("both").all():
        missing_rows = merged.loc[merged["_merge"] != "both", ["video_id", keyframe_column]]
        sample = missing_rows.head(5).to_dict("records")
        raise ValueError(f"artifact has unmapped keyframe occurrences: {sample}")
    merged = merged.drop(columns=["_merge"])

    def mapped_column(column: str) -> str:
        suffixed = f"{column}__canonical"
        return suffixed if suffixed in merged.columns else column

    if "original_frame_id_candidate" in artifact_columns:
        merged["source_original_frame_id_candidate"] = merged[
            "original_frame_id_candidate"
        ]
    if "timestamp_ms_candidate" in artifact_columns:
        merged["source_timestamp_ms_candidate"] = merged["timestamp_ms_candidate"]
    merged["original_frame_id_candidate"] = merged[
        mapped_column("original_frame_id_candidate")
    ].astype("int64")
    merged["timestamp_ms_candidate"] = merged[
        mapped_column("timestamp_ms_candidate")
    ].astype("int64")
    merged["canonical_timestamp_ms"] = merged[
        mapped_column("canonical_timestamp_ms")
    ].astype("int64")
    merged["frame_id_status"] = merged[mapped_column("frame_id_status")]
    merged["ready_for_db"] = ready_for_db
    return merged.drop(
        columns=[
            column
            for column in (
                "original_frame_id_candidate__canonical",
                "timestamp_ms_candidate__canonical",
                "canonical_timestamp_ms__canonical",
                "frame_id_status__canonical",
            )
            if column in merged.columns
        ]
    )


def _update_alias_artifacts(refined_dir: Path, mapping: pd.DataFrame) -> None:
    alias_path = refined_dir / "frame_aliases.parquet"
    canonical_path = refined_dir / "canonical_frame_candidates.parquet"
    if not alias_path.is_file() or not canonical_path.is_file():
        return

    aliases = pd.read_parquet(alias_path)
    aliases = aliases.merge(
        mapping.rename(
            columns={
                "original_frame_id_candidate": "canonical_original_frame_id",
                "timestamp_ms_candidate": "canonical_alias_timestamp_ms",
            }
        ),
        on=["video_id", "keyframe_no"],
        how="left",
        validate="one_to_one",
        indicator=True,
    )
    if not aliases["_merge"].eq("both").all():
        raise ValueError("frame_aliases contains an unmapped occurrence")
    aliases = aliases.drop(columns=["_merge"])
    metadata: list[str] = []
    for encoded, old_timestamp, canonical_timestamp, status in zip(
        aliases["metadata"],
        aliases["timestamp_ms"],
        aliases["canonical_alias_timestamp_ms"],
        aliases["frame_id_status"],
    ):
        value = json.loads(encoded)
        value["source_timestamp_ms_candidate"] = int(old_timestamp)
        value["canonical_timestamp_ms"] = int(canonical_timestamp)
        value["mapping_status"] = str(status)
        metadata.append(json.dumps(value, ensure_ascii=False, sort_keys=True))
    aliases["original_frame_id"] = aliases["canonical_original_frame_id"].astype("int64")
    aliases["timestamp_ms"] = aliases["canonical_alias_timestamp_ms"].astype("int64")
    aliases["metadata"] = metadata
    aliases = aliases[ALIAS_COLUMNS]
    validate_alias_artifact(aliases)
    write_parquet_atomic(aliases, alias_path)
    write_csv_atomic(aliases, alias_path.with_suffix(".csv"))

    canonical = pd.read_parquet(canonical_path)
    canonical_mapping = (
        aliases.groupby(["video_id", "original_frame_id"], sort=True)
        .agg(
            keyframe_no=("keyframe_no", "min"),
            timestamp_ms=("timestamp_ms", "min"),
            thumbnail_object_key=("thumbnail_object_key", "first"),
            storage_uri=("storage_uri", "first"),
            alias_count=("keyframe_no", "count"),
        )
        .reset_index()
    )
    if len(canonical_mapping) != len(canonical):
        raise ValueError("canonical candidate count changed while refreshing aliases")
    canonical = canonical.drop(
        columns=[
            "keyframe_no",
            "timestamp_ms",
            "thumbnail_object_key",
            "storage_uri",
            "alias_count",
        ]
    ).merge(
        canonical_mapping,
        on=["video_id", "original_frame_id"],
        how="left",
        validate="one_to_one",
    )
    canonical_metadata: list[str] = []
    for encoded, count in zip(canonical["metadata"], canonical["alias_count"]):
        value = json.loads(encoded)
        value["mapping_status"] = RESOLVED_STATUS
        value["canonical_mapping_verified"] = True
        value["alias_count"] = int(count)
        canonical_metadata.append(json.dumps(value, ensure_ascii=False, sort_keys=True))
    canonical["metadata"] = canonical_metadata
    canonical = canonical[CANONICAL_CANDIDATE_COLUMNS]
    validate_canonical_candidates(canonical)
    write_parquet_atomic(canonical, canonical_path)
    write_csv_atomic(canonical, canonical_path.with_suffix(".csv"))


def _update_frame_artifacts(
    refined_dir: Path,
    resolved: pd.DataFrame,
    *,
    embedding_ready_for_db: bool = False,
) -> dict[str, int]:
    mapping = _mapping_table(resolved)
    updated: dict[str, int] = {}
    frame_artifacts = (
        "captions_en.parquet",
        "objects.parquet",
        "object_frame_manifest.parquet",
    )
    for name in frame_artifacts:
        path = refined_dir / name
        if not path.is_file():
            continue
        artifact = pd.read_parquet(path)
        artifact = _apply_mapping_to_artifact(artifact, mapping, ready_for_db=True)
        write_parquet_atomic(artifact, path)
        write_csv_atomic(artifact, path.with_suffix(".csv"))
        updated[name] = len(artifact)

    embedding_path = refined_dir / "embedding_index.parquet"
    if embedding_path.is_file():
        embedding = pd.read_parquet(embedding_path)
        embedding = _apply_mapping_to_artifact(
            embedding,
            mapping,
            keyframe_column="keyframe_no_candidate",
            ready_for_db=embedding_ready_for_db,
        )
        embedding["mapping_status"] = RESOLVED_STATUS
        write_parquet_atomic(embedding, embedding_path)
        write_csv_atomic(embedding, embedding_path.with_suffix(".csv"))
        updated["embedding_index.parquet"] = len(embedding)

    _update_alias_artifacts(refined_dir, mapping)
    return updated


def build_frame_manifest_index(
    refined_dir: str | Path,
    video_ids: list[str],
) -> pd.DataFrame:
    root = Path(refined_dir)
    rows: list[dict[str, Any]] = []
    for video_id in sorted(video_ids):
        path = root / CANONICAL_TIMELINE_DIRNAME / f"{_validate_video_id(video_id)}.parquet"
        frame = load_canonical_timeline(path)
        rows.append(
            {
                "video_id": video_id,
                "frame_manifest_path": f"{CANONICAL_TIMELINE_DIRNAME}/{path.name}",
                "frame_count": len(frame),
                "first_original_frame_id": int(frame["original_frame_id"].iloc[0]),
                "last_original_frame_id": int(frame["original_frame_id"].iloc[-1]),
                "first_timestamp_ms": round(float(frame["timestamp_ms"].iloc[0])),
                "last_timestamp_ms": round(float(frame["timestamp_ms"].iloc[-1])),
                "timestamp_source": str(frame["timestamp_source"].value_counts().index[0])
                if "timestamp_source" in frame.columns
                else "unknown",
            }
        )
    return pd.DataFrame(rows)


def build_source_map_index(resolved: pd.DataFrame) -> pd.DataFrame:
    """Summarize the verified sparse map without pretending it is full video decode."""

    required = {
        "video_id",
        "keyframe_no",
        "original_frame_id_candidate",
        "timestamp_ms_candidate",
        "source_map_file",
    }
    missing = sorted(required - set(resolved.columns))
    if missing:
        raise ValueError(f"resolved map is missing columns: {missing}")

    rows: list[dict[str, Any]] = []
    for video_id, group in resolved.groupby("video_id", sort=True):
        canonical_ids = pd.to_numeric(
            group["original_frame_id_candidate"], errors="coerce"
        )
        timestamps = pd.to_numeric(group["timestamp_ms_candidate"], errors="coerce")
        if canonical_ids.isna().any() or timestamps.isna().any():
            raise ValueError(f"source map has invalid resolved values for {video_id}")
        rows.append(
            {
                "video_id": str(video_id),
                "source_map_file": str(group["source_map_file"].iloc[0]),
                "map_row_count": len(group),
                "canonical_frame_count": int(canonical_ids.nunique()),
                "first_original_frame_id": int(canonical_ids.min()),
                "last_original_frame_id": int(canonical_ids.max()),
                "first_timestamp_ms": int(timestamps.min()),
                "last_timestamp_ms": int(timestamps.max()),
                "mapping_status": RESOLVED_STATUS,
            }
        )
    return pd.DataFrame(rows)


def resolve_all_keyframes(
    refined_dir: str | Path,
    *,
    expected_video_ids: set[str] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Resolve the complete keyframe manifest from per-video timelines."""

    root = Path(refined_dir)
    keyframe_path = root / "keyframe_manifest.parquet"
    keyframes = pd.read_parquet(keyframe_path)
    keyframes["__input_order"] = range(len(keyframes))
    actual_ids = set(keyframes["video_id"].astype(str))
    if expected_video_ids is not None and actual_ids != expected_video_ids:
        raise ValueError("keyframe/video manifest video_id sets differ")

    parts: list[pd.DataFrame] = []
    for video_id, group in keyframes.groupby("video_id", sort=True):
        frame_path = root / CANONICAL_TIMELINE_DIRNAME / f"{_validate_video_id(video_id)}.parquet"
        if not frame_path.is_file():
            raise FileNotFoundError(f"missing canonical frame manifest: {frame_path}")
        canonical = load_canonical_timeline(frame_path)
        parts.append(resolve_keyframe_mapping(group, canonical))

    resolved = pd.concat(parts, ignore_index=True)
    resolved = resolved.sort_values("__input_order", kind="stable").drop(
        columns=["__input_order"]
    ).reset_index(drop=True)
    index = build_frame_manifest_index(root, sorted(actual_ids))
    return resolved, index


def _write_resolved_keyframes(refined_dir: Path, resolved: pd.DataFrame) -> None:
    write_parquet_atomic(resolved, refined_dir / "keyframe_manifest.parquet")
    write_csv_atomic(resolved, refined_dir / "keyframe_manifest.csv")


def _update_report(
    refined_dir: Path,
    *,
    frame_index: pd.DataFrame,
    updated_artifacts: dict[str, int],
) -> None:
    report_path = refined_dir / "normalization_report.json"
    if not report_path.is_file():
        return
    report = json.loads(report_path.read_text(encoding="utf-8"))
    old_embedding_blocker = (
        "embedding parquet original_frame_id values are row ordinals rather than canonical source frame IDs"
    )
    report["blockers"] = [
        blocker for blocker in report.get("blockers", []) if blocker != old_embedding_blocker
    ]
    report["status"] = "staging_not_import_ready" if report["blockers"] else "import_ready"
    report["frame_manifest"] = {
        "status": "complete",
        "video_count": len(frame_index),
        "frame_count": int(frame_index["frame_count"].sum()),
        "manifest_directory": CANONICAL_TIMELINE_DIRNAME,
        "index_artifact": "frame_manifest_index.parquet",
        "canonical_id_policy": "decoded_frame_index_zero_based",
        "mapping_status": RESOLVED_STATUS,
        "canonical_mapping_verified": True,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    report["frame_aliases"] = {
        **report.get("frame_aliases", {}),
        "mapping_status": RESOLVED_STATUS,
        "canonical_mapping_verified": True,
        "ready_for_db": True,
    }
    output_files = list(report.get("output_files", []))
    for name in (
        "frame_manifest_index.parquet",
        "frame_manifest_index.csv",
        "canonical_frame_timeline/*.parquet",
        "canonical_frame_timeline_stats/*.json",
    ):
        if name not in output_files:
            output_files.append(name)
    report["output_files"] = output_files
    report["updated_frame_artifacts"] = updated_artifacts
    if isinstance(report.get("embedding_artifacts"), list):
        for artifact in report["embedding_artifacts"]:
            artifact["mapping_status"] = RESOLVED_STATUS
            artifact["canonical_mapping_verified"] = True
    if isinstance(report.get("objects"), dict):
        report["objects"]["mapping_status"] = RESOLVED_STATUS
    write_json_atomic(report, report_path)

    object_report_path = refined_dir / "objects_normalization_report.json"
    if object_report_path.is_file():
        object_report = json.loads(object_report_path.read_text(encoding="utf-8"))
        object_report["blockers"] = [
            blocker
            for blocker in object_report.get("blockers", [])
            if "canonical original_frame_id" not in str(blocker)
        ]
        object_report["status"] = (
            "complete_for_canonical_frame_mapping"
            if not object_report["blockers"]
            else "staging_not_import_ready"
        )
        object_report["canonical_mapping_verified"] = True
        write_json_atomic(object_report, object_report_path)


def _update_sparse_map_report(
    refined_dir: Path,
    *,
    source_map_index: pd.DataFrame,
    updated_artifacts: dict[str, int],
) -> None:
    """Record map verification while keeping full-timeline status explicit."""

    report_path = refined_dir / "normalization_report.json"
    if not report_path.is_file():
        return
    report = json.loads(report_path.read_text(encoding="utf-8"))
    old_embedding_blocker = (
        "embedding parquet original_frame_id values are row ordinals rather than canonical source frame IDs"
    )
    embedding_path = refined_dir / "embedding_index.parquet"
    embedding_mapping_complete = False
    if embedding_path.is_file():
        embedding = pd.read_parquet(embedding_path)
        embedding_mapping_complete = bool(
            not embedding.empty
            and embedding["frame_id_status"].eq(RESOLVED_STATUS).all()
            and embedding["ready_for_db"].eq(True).all()
        )
        map_counts = dict(
            zip(
                source_map_index["video_id"].astype(str),
                source_map_index["map_row_count"].astype(int),
            )
        )
        embedding_counts = embedding.groupby("video_id").size().to_dict()
        count_mismatches = sorted(
            video_id
            for video_id in set(map_counts) | set(map(str, embedding_counts))
            if map_counts.get(video_id, 0) != embedding_counts.get(video_id, 0)
        )
        report["embedding_index_mapping"] = {
            "status": "complete" if embedding_mapping_complete else "incomplete",
            "row_count": len(embedding),
            "video_count": int(embedding["video_id"].astype(str).nunique()),
            "mapping_status": RESOLVED_STATUS
            if embedding_mapping_complete
            else "incomplete",
        }
        report["embeddings"] = {
            **report.get("embeddings", {}),
            "video_count": int(embedding["video_id"].astype(str).nunique()),
            "parquet_row_count": len(embedding),
            "map_row_count": int(source_map_index["map_row_count"].sum()),
            "count_mismatch_video_count": len(count_mismatches),
            "count_mismatch_videos": count_mismatches,
        }
        report["embedding_artifacts"] = {
            **(
                report.get("embedding_artifacts", {})
                if isinstance(report.get("embedding_artifacts"), dict)
                else {}
            ),
            "status": "complete_for_keyframe_manifest_rows"
            if embedding_mapping_complete
            else "staging_not_import_ready",
            "row_count": len(embedding),
            "canonical_mapping_verified": embedding_mapping_complete,
        }
    if embedding_mapping_complete:
        report["blockers"] = [
            blocker for blocker in report.get("blockers", []) if blocker != old_embedding_blocker
        ]
    report["status"] = "staging_not_import_ready" if report.get("blockers") else "import_ready"

    map_rows = int(source_map_index["map_row_count"].sum())
    canonical_rows = int(source_map_index["canonical_frame_count"].sum())
    report["source_frame_map"] = {
        "status": "complete",
        "video_count": len(source_map_index),
        "map_row_count": map_rows,
        "canonical_frame_count": canonical_rows,
        "mapping_status": RESOLVED_STATUS,
        "canonical_mapping_verified": True,
        "full_sequential_timeline": False,
        "identity_policy": "source_map_frame_idx_zero_based",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    report["frame_manifest"] = {
        "status": "verified_sparse_source_map",
        "video_count": len(source_map_index),
        "selected_keyframe_count": map_rows,
        "canonical_frame_count": canonical_rows,
        "manifest_type": "sparse_keyframe_map",
        "index_artifact": "source_map_index.parquet",
        "canonical_id_policy": "source_map_frame_idx_zero_based",
        "mapping_status": RESOLVED_STATUS,
        "canonical_mapping_verified": True,
        "full_sequential_timeline": False,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    report["frame_aliases"] = {
        **report.get("frame_aliases", {}),
        "mapping_status": RESOLVED_STATUS,
        "canonical_mapping_verified": True,
        "ready_for_db": True,
        "mapping_source": "map-keyframes",
    }
    report["updated_frame_artifacts"] = updated_artifacts
    output_files = list(report.get("output_files", []))
    for name in ("source_map_index.parquet", "source_map_index.csv"):
        if name not in output_files:
            output_files.append(name)
    report["output_files"] = output_files
    if isinstance(report.get("embedding_artifacts"), list):
        for artifact in report["embedding_artifacts"]:
            artifact["mapping_status"] = RESOLVED_STATUS
            artifact["canonical_mapping_verified"] = True
    if isinstance(report.get("objects"), dict):
        report["objects"]["mapping_status"] = RESOLVED_STATUS
        report["objects"]["canonical_mapping_verified"] = True
    write_json_atomic(report, report_path)

    object_report_path = refined_dir / "objects_normalization_report.json"
    if object_report_path.is_file():
        object_report = json.loads(object_report_path.read_text(encoding="utf-8"))
        object_report["blockers"] = [
            blocker
            for blocker in object_report.get("blockers", [])
            if "canonical original_frame_id" not in str(blocker)
        ]
        object_report["status"] = (
            "complete_for_canonical_frame_mapping"
            if not object_report["blockers"]
            else "staging_not_import_ready"
        )
        object_report["canonical_mapping_verified"] = True
        object_report["mapping_status"] = RESOLVED_STATUS
        object_report["ready_for_db"] = not bool(object_report["blockers"])
        write_json_atomic(object_report, object_report_path)


def run_from_source_map(
    *,
    data_root: str | Path,
    source_map_root: str | Path,
) -> dict[str, Any]:
    """Resolve all refined artifacts from the existing organizer map."""

    root = Path(data_root)
    refined_dir = root / "refined"
    videos = pd.read_parquet(refined_dir / "videos_manifest.parquet")
    keyframes = pd.read_parquet(refined_dir / "keyframe_manifest.parquet")
    expected_ids = set(videos["video_id"].astype(str))
    keyframe_ids = set(keyframes["video_id"].astype(str))
    if expected_ids != keyframe_ids:
        raise ValueError("videos_manifest and keyframe_manifest video_id sets differ")

    source_map = load_source_frame_map(
        source_map_root,
        expected_video_ids=expected_ids,
    )
    resolved = resolve_keyframe_mapping_from_source_map(keyframes, source_map)
    _write_resolved_keyframes(refined_dir, resolved)
    source_map_index = build_source_map_index(resolved)
    write_parquet_atomic(source_map_index, refined_dir / "source_map_index.parquet")
    write_csv_atomic(source_map_index, refined_dir / "source_map_index.csv")
    updated = _update_frame_artifacts(
        refined_dir,
        resolved,
        embedding_ready_for_db=True,
    )
    _update_sparse_map_report(
        refined_dir,
        source_map_index=source_map_index,
        updated_artifacts=updated,
    )
    return {
        "source_map_video_count": len(source_map_index),
        "source_map_row_count": len(source_map),
        "canonical_frame_count": int(
            resolved[["video_id", "original_frame_id_candidate"]]
            .drop_duplicates()
            .shape[0]
        ),
        "resolved_keyframe_count": len(resolved),
        "updated_artifacts": updated,
        "mapping_status": RESOLVED_STATUS,
        "full_sequential_timeline": False,
    }


def run(
    *,
    data_root: str | Path,
    video_root: str | Path,
    source_map_root: str | Path | None = None,
    limit: int | None = None,
    video_ids: list[str] | None = None,
    skip_decode: bool = False,
    map_artifacts: bool = True,
    workers: int = 4,
    signal_long_edge: int = 320,
    quality_long_edge: int = 720,
) -> dict[str, Any]:
    if source_map_root is not None:
        if limit is not None or video_ids:
            raise ValueError("source-map mode requires all refined video IDs")
        return run_from_source_map(
            data_root=data_root,
            source_map_root=source_map_root,
        )

    root = Path(data_root)
    refined_dir = root / "refined"
    video_manifest_path = refined_dir / "videos_manifest.parquet"
    keyframe_manifest_path = refined_dir / "keyframe_manifest.parquet"
    videos = pd.read_parquet(video_manifest_path)
    keyframes = pd.read_parquet(keyframe_manifest_path)
    expected_ids = set(keyframes["video_id"].astype(str))
    if set(videos["video_id"].astype(str)) != expected_ids:
        raise ValueError("videos_manifest and keyframe_manifest video_id sets differ")

    local_manifest = build_local_video_manifest(videos, video_root)
    if video_ids:
        requested = {_validate_video_id(value) for value in video_ids}
        unknown = requested - expected_ids
        if unknown:
            raise ValueError(f"unknown video_id values: {sorted(unknown)}")
        local_manifest = local_manifest[local_manifest["video_id"].isin(requested)].reset_index(
            drop=True
        )

    if not skip_decode:
        run_canonical_timelines(local_manifest, refined_dir, limit=limit, workers=workers)

    if not map_artifacts:
        return {
            "decoded_requested_video_count": len(local_manifest),
            "mapped": False,
        }
    if limit is not None or video_ids:
        raise ValueError("mapping all refined artifacts requires decoding the complete video set")

    resolved, frame_index = resolve_all_keyframes(refined_dir, expected_video_ids=expected_ids)
    _write_resolved_keyframes(refined_dir, resolved)
    write_parquet_atomic(frame_index, refined_dir / "frame_manifest_index.parquet")
    write_csv_atomic(frame_index, refined_dir / "frame_manifest_index.csv")
    updated = _update_frame_artifacts(refined_dir, resolved)
    _update_report(refined_dir, frame_index=frame_index, updated_artifacts=updated)
    return {
        "decoded_video_count": len(frame_index),
        "decoded_frame_count": int(frame_index["frame_count"].sum()),
        "resolved_keyframe_count": len(resolved),
        "updated_artifacts": updated,
        "mapping_status": RESOLVED_STATUS,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=Path(r"D:\workspace\aic\data"))
    parser.add_argument("--video-root", type=Path, default=Path(r"E:\aic2026\videos"))
    parser.add_argument(
        "--source-map-root",
        type=Path,
        default=None,
        help="Use existing per-video map-keyframes CSV/JSON files; skip video decoding.",
    )
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--video-id", action="append", default=[])
    parser.add_argument("--skip-decode", action="store_true")
    parser.add_argument("--no-map", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--signal-long-edge", type=int, default=320)
    parser.add_argument("--quality-long-edge", type=int, default=720)
    return parser


def main() -> None:
    args = _parser().parse_args()
    if args.limit is not None and args.limit < 0:
        raise ValueError("--limit must be non-negative")
    if args.workers < 1:
        raise ValueError("--workers must be positive")
    result = run(
        data_root=args.data_root,
        video_root=args.video_root,
        source_map_root=args.source_map_root,
        limit=args.limit,
        video_ids=args.video_id or None,
        skip_decode=args.skip_decode,
        map_artifacts=not args.no_map,
        workers=args.workers,
        signal_long_edge=args.signal_long_edge,
        quality_long_edge=args.quality_long_edge,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
