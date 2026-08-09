"""Artifact-level orchestration for two-stage keyframe retrieval and alignment."""

from __future__ import annotations

import json
import hashlib
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ..video_source import parse_video_uri
from .dense import (
    decode_window,
    select_semantic_keyframe,
    write_dense_candidates,
    write_semantic_selection,
)
from .event_windows import build_event_windows, write_event_windows
from .frame_manifest import load_frame_manifest


_SAFE_ARTIFACT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def _safe_artifact_id(value: str, name: str) -> str:
    if not isinstance(value, str) or not _SAFE_ARTIFACT_ID.fullmatch(value):
        raise ValueError(f"{name} must contain only letters, digits, dot, underscore, or hyphen")
    return value


def _load_table(value: pd.DataFrame | str | Path) -> pd.DataFrame:
    if isinstance(value, pd.DataFrame):
        return value.copy()
    path = Path(value)
    if not path.exists():
        raise FileNotFoundError(path)
    suffix = path.suffix.lower()
    if suffix in {".parquet", ".pq"}:
        return pd.read_parquet(path)
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix in {".jsonl", ".ndjson"}:
        return pd.read_json(path, lines=True)
    if suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and all(
            isinstance(key, str) and isinstance(score, (int, float))
            for key, score in payload.items()
        ):
            return pd.DataFrame({
                "original_frame_id": [int(key) for key in payload],
                "event_score": list(payload.values()),
            })
        return pd.DataFrame(payload)
    raise ValueError(f"unsupported table format: {path.suffix}")


def build_event_window_artifact(
    store: Any,
    retrieval_hits: pd.DataFrame | str | Path,
    run_id: str,
    *,
    radius_ms: float = 2_000.0,
    merge_gap_ms: float = 500.0,
    frame_manifest: pd.DataFrame | str | Path | None = None,
    max_windows_per_video: int | None = None,
) -> Path:
    """Build one event-window Parquet from sparse hits and canonical timelines."""

    run_id = _safe_artifact_id(run_id, "run_id")
    hits = _load_table(retrieval_hits)
    if frame_manifest is not None:
        frames = _load_table(frame_manifest)
    else:
        if "video_id" not in hits.columns:
            raise ValueError("retrieval hits must contain video_id")
        manifests = []
        for video_id in sorted({str(value) for value in hits["video_id"]}):
            path = store.frame_manifest_path(video_id)
            if not path.exists():
                raise FileNotFoundError(
                    f"missing frame manifest for {video_id}; run the frames stage first"
                )
            manifests.append(load_frame_manifest(path))
        frames = pd.concat(manifests, ignore_index=True) if manifests else pd.DataFrame()
    windows = build_event_windows(
        hits,
        frames,
        radius_ms=radius_ms,
        merge_gap_ms=merge_gap_ms,
        max_windows_per_video=max_windows_per_video,
        namespace=run_id,
    )
    output = store.event_windows_path(run_id)
    write_event_windows(windows, output)
    return output


def _video_source_options(
    cfg: Any,
    uri: str,
    video_row: pd.Series | None = None,
) -> dict[str, Any] | None:
    options = (
        dict(cfg.video_source_kwargs(uri))
        if hasattr(cfg, "video_source_kwargs")
        else {}
    )
    if video_row is not None and parse_video_uri(uri).path is None:
        for field, option in (
            ("etag", "expected_etag"),
            ("version_id", "expected_version_id"),
        ):
            value = video_row.get(field)
            if value is not None and not bool(pd.isna(value)):
                options[option] = str(value)
    return options or None


def _source_uri(video_row: pd.Series) -> str:
    storage_uri = video_row.get("storage_uri")
    if isinstance(storage_uri, str) and storage_uri.strip():
        return storage_uri
    path = video_row.get("path")
    if isinstance(path, str) and path.strip():
        return path
    raise ValueError(f"video {video_row.get('video_id')} has no storage_uri or path")


def _member_ids(value: Any) -> list[int]:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            value = [part.strip() for part in text.split(",") if part.strip()]
    if isinstance(value, (list, tuple, set, np.ndarray, pd.Series)):
        return sorted({int(item) for item in value})
    return [int(value)]


def _json_scalar(value: Any) -> Any:
    return value.item() if hasattr(value, "item") else value


def _dense_fingerprint(
    *,
    event_window_id: str,
    video_id: str,
    start_frame_id: int,
    end_frame_id: int,
    resize: Any,
    target_frame_id: int | None,
    event_scores: dict[int, float] | None,
    frame_manifest_path: Path,
    video_row: pd.Series,
) -> str:
    manifest_stat = frame_manifest_path.stat()
    source_identity = {
        key: _json_scalar(video_row.get(key))
        for key in ("storage_uri", "size_bytes", "etag", "version_id", "sha256")
        if key in video_row.index and pd.notna(video_row.get(key))
    }
    source_uri = source_identity.get("storage_uri")
    if isinstance(source_uri, str):
        parsed = parse_video_uri(source_uri)
        if parsed.path is not None and parsed.path.exists():
            source_stat = parsed.path.stat()
            source_identity["local_size"] = source_stat.st_size
            source_identity["local_mtime_ns"] = source_stat.st_mtime_ns
    payload = {
        "version": "dense_workflow_v1",
        "event_window_id": event_window_id,
        "video_id": video_id,
        "start_frame_id": start_frame_id,
        "end_frame_id": end_frame_id,
        "resize": resize,
        "target_frame_id": target_frame_id,
        "event_scores": sorted((event_scores or {}).items()),
        "frame_manifest_size": manifest_stat.st_size,
        "frame_manifest_mtime_ns": manifest_stat.st_mtime_ns,
        "source_identity": source_identity,
        "selector": "weighted_event_quality_motion_v1",
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _dense_checkpoint_valid(
    dense_path: Path,
    semantic_path: Path,
    *,
    event_window_id: str,
    video_id: str,
    expected_ids: list[int],
    fingerprint: str,
) -> dict[str, Any] | None:
    try:
        if not dense_path.exists() or not semantic_path.exists():
            return None

        dense = pd.read_parquet(dense_path)
        record = json.loads(semantic_path.read_text(encoding="utf-8"))

        required_dense_columns = {
            "event_window_id",
            "video_id",
            "original_frame_id",
            "timestamp_ms",
            "decode_status",
        }
        if dense.columns.duplicated().any() or not required_dense_columns.issubset(dense.columns):
            return None
        if not expected_ids:
            return None

        frame_ids = dense["original_frame_id"]
        if pd.api.types.is_bool_dtype(frame_ids.dtype) or not pd.api.types.is_integer_dtype(
            frame_ids.dtype
        ):
            return None
        actual_ids = [int(value) for value in frame_ids.tolist()]
        if actual_ids != expected_ids:
            return None

        timestamps = dense["timestamp_ms"]
        if pd.api.types.is_bool_dtype(timestamps.dtype) or not pd.api.types.is_numeric_dtype(
            timestamps.dtype
        ):
            return None
        timestamp_values = timestamps.to_numpy(dtype=float, na_value=np.nan)
        if not np.isfinite(timestamp_values).all() or (timestamp_values < 0.0).any():
            return None

        expected_window_values = [event_window_id] * len(expected_ids)
        expected_video_values = [video_id] * len(expected_ids)
        window_values = dense["event_window_id"].tolist()
        video_values = dense["video_id"].tolist()
        if not all(isinstance(value, str) for value in window_values):
            return None
        if not all(isinstance(value, str) for value in video_values):
            return None
        if window_values != expected_window_values or video_values != expected_video_values:
            return None

        statuses = dense["decode_status"].tolist()
        if not all(isinstance(status, str) and status == "success" for status in statuses):
            return None

        required_semantic_fields = {
            "event_window_id",
            "video_id",
            "original_frame_id",
            "timestamp_ms",
            "selection_score",
            "selector",
            "evidence",
        }
        if not isinstance(record, dict) or not required_semantic_fields.issubset(record):
            return None
        if record["event_window_id"] != event_window_id or record["video_id"] != video_id:
            return None
        if not isinstance(record["event_window_id"], str) or not isinstance(record["video_id"], str):
            return None

        selected_frame_id = record["original_frame_id"]
        if isinstance(selected_frame_id, bool) or not isinstance(selected_frame_id, int):
            return None
        if selected_frame_id not in expected_ids:
            return None

        selected_timestamp = record["timestamp_ms"]
        selection_score = record["selection_score"]
        for value in (selected_timestamp, selection_score):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None
            if not np.isfinite(float(value)):
                return None
        if float(selected_timestamp) < 0.0:
            return None

        selector = record["selector"]
        if selector != "weighted_event_quality_motion_v1":
            return None
        evidence = record["evidence"]
        if not isinstance(evidence, dict) or evidence.get("workflow_fingerprint") != fingerprint:
            return None

        selected_positions = [
            index for index, frame_id in enumerate(actual_ids) if frame_id == selected_frame_id
        ]
        if len(selected_positions) != 1:
            return None
        dense_timestamp = timestamp_values[selected_positions[0]]
        if not np.isclose(
            float(selected_timestamp),
            float(dense_timestamp),
            rtol=0.0,
            atol=1e-6,
        ):
            return None
        return record
    # A checkpoint is untrusted input even when its Parquet/JSON container is
    # readable.  Any parsing, dtype, or nested-structure failure makes it stale
    # so the caller can rebuild both artifacts from the source window.
    except Exception:  # noqa: BLE001 -- checkpoint validation boundary
        return None


def _event_score_mapping(
    scores: pd.DataFrame | None,
    *,
    event_window_id: str,
    video_id: str,
    start_frame_id: int,
    end_frame_id: int,
) -> dict[int, float] | None:
    if scores is None:
        return None
    subset = scores
    if "event_window_id" in subset.columns:
        subset = subset[subset["event_window_id"].astype(str) == event_window_id]
    if "video_id" in subset.columns:
        subset = subset[subset["video_id"].astype(str) == video_id]
    if "original_frame_id" not in subset.columns:
        raise ValueError("event-score table must contain original_frame_id")
    score_column = next(
        (column for column in ("event_score", "score") if column in subset.columns),
        None,
    )
    if score_column is None:
        raise ValueError("event-score table must contain event_score or score")
    mapping = {
        int(row.original_frame_id): float(getattr(row, score_column))
        for row in subset.itertuples(index=False)
        if start_frame_id <= int(row.original_frame_id) < end_frame_id
    }
    relevant = subset[
        (pd.to_numeric(subset["original_frame_id"], errors="coerce") >= start_frame_id)
        & (pd.to_numeric(subset["original_frame_id"], errors="coerce") < end_frame_id)
    ]
    if relevant["original_frame_id"].duplicated().any():
        raise ValueError(
            f"event-score table contains duplicate frame IDs for {event_window_id}"
        )
    expected_ids = set(range(start_frame_id, end_frame_id))
    actual_ids = {int(value) for value in relevant["original_frame_id"]}
    missing_ids = expected_ids - actual_ids
    if missing_ids:
        raise ValueError(
            f"event scores for {event_window_id} must cover every dense frame; "
            f"missing ids: {sorted(missing_ids)}"
        )
    return mapping or None


def run_dense_event_windows(
    cfg: Any,
    store: Any,
    video_manifest: pd.DataFrame,
    event_windows: pd.DataFrame | str | Path,
    *,
    event_scores: pd.DataFrame | str | Path | None = None,
    resize: int | tuple[int, int] | None = 720,
    force: bool = False,
) -> list[dict[str, Any]]:
    """Dense-decode and select one exact semantic frame for every event window."""

    windows = _load_table(event_windows)
    required = {"event_window_id", "video_id", "start_frame_id", "end_frame_id"}
    missing = required - set(windows.columns)
    if missing:
        raise ValueError(f"event windows are missing columns: {sorted(missing)}")
    if windows["event_window_id"].astype(str).duplicated().any():
        raise ValueError("event windows contain duplicate event_window_id values")
    score_table = _load_table(event_scores) if event_scores is not None else None
    if score_table is not None and len(windows) > 1:
        missing_scope = {"video_id", "event_window_id"} - set(score_table.columns)
        if missing_scope:
            raise ValueError(
                "multi-window event scores require scope columns: "
                f"{sorted(missing_scope)}"
            )
    videos = video_manifest.set_index("video_id", drop=False)
    results: list[dict[str, Any]] = []

    for window in windows.itertuples(index=False):
        event_window_id = _safe_artifact_id(str(window.event_window_id), "event_window_id")
        video_id = str(window.video_id)
        if video_id not in videos.index:
            raise ValueError(f"event window references unknown video_id={video_id}")
        dense_path = store.dense_candidates_path(event_window_id)
        semantic_path = store.semantic_keyframe_path(event_window_id)

        start_frame_id = int(window.start_frame_id)
        end_frame_id = int(window.end_frame_id)
        frame_manifest_path = store.frame_manifest_path(video_id)
        if not frame_manifest_path.exists():
            raise FileNotFoundError(
                f"missing frame manifest for {video_id}; run the frames stage first"
            )
        video_row = videos.loc[video_id]
        if isinstance(video_row, pd.DataFrame):
            raise ValueError(f"video manifest contains duplicate video_id={video_id}")
        uri = _source_uri(video_row)
        mapping = _event_score_mapping(
            score_table,
            event_window_id=event_window_id,
            video_id=video_id,
            start_frame_id=start_frame_id,
            end_frame_id=end_frame_id,
        )
        members = _member_ids(getattr(window, "member_frame_ids", None))
        in_window_members = [
            frame_id for frame_id in members if start_frame_id <= frame_id < end_frame_id
        ]
        peak_frame_id = getattr(window, "peak_frame_id", None)
        if peak_frame_id is not None and not (
            isinstance(peak_frame_id, float) and np.isnan(peak_frame_id)
        ):
            peak_frame_id = int(peak_frame_id)
        else:
            peak_frame_id = None
        target_frame_id = (
            peak_frame_id
            if peak_frame_id is not None and start_frame_id <= peak_frame_id < end_frame_id
            else in_window_members[0] if in_window_members else None
        )
        fingerprint = _dense_fingerprint(
            event_window_id=event_window_id,
            video_id=video_id,
            start_frame_id=start_frame_id,
            end_frame_id=end_frame_id,
            resize=resize,
            target_frame_id=target_frame_id,
            event_scores=mapping,
            frame_manifest_path=frame_manifest_path,
            video_row=video_row,
        )
        if not force:
            record = _dense_checkpoint_valid(
                dense_path,
                semantic_path,
                event_window_id=event_window_id,
                video_id=video_id,
                expected_ids=list(range(start_frame_id, end_frame_id)),
                fingerprint=fingerprint,
            )
            if record is not None:
                results.append({"status": "skipped", **record})
                continue

        frames = decode_window(
            uri,
            frame_manifest_path,
            start_frame_id,
            end_frame_id,
            resize,
            source_options=_video_source_options(cfg, uri, video_row),
        )
        selection = select_semantic_keyframe(
            frames,
            external_scores=mapping,
            target_frame_id=target_frame_id,
        )
        selection.evidence["workflow_fingerprint"] = fingerprint
        write_dense_candidates(
            frames,
            dense_path,
            event_window_id=event_window_id,
            video_id=video_id,
            event_scores=mapping,
        )
        write_semantic_selection(
            selection,
            semantic_path,
            event_window_id=event_window_id,
            video_id=video_id,
        )
        results.append({
            "status": "written",
            "event_window_id": event_window_id,
            "video_id": video_id,
            "original_frame_id": selection.original_frame_id,
            "timestamp_ms": selection.timestamp_ms,
            "dense_frame_count": len(frames),
        })
    return results


__all__ = ["build_event_window_artifact", "run_dense_event_windows"]
