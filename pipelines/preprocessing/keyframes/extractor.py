"""Sparse retrieval-keyframe extraction on top of the canonical frame manifest.

The full frame manifest is the source of truth for frame identity and time.  A
frame that fails the quality gate is routed to ``temporal_only`` and remains in
that manifest for dense alignment; it is never silently put back into the
retrieval embedding/index lane.
"""

from __future__ import annotations

import json
import hashlib
import platform
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import av
import cv2
import numpy as np
import pandas as pd

from ..io_utils import (
    write_csv_atomic,
    write_json_atomic,
    write_numpy_atomic,
    write_parquet_atomic,
)
from ..video_source import open_video_source, parse_video_uri
from .dedup import cosine_dedup, enforce_coverage, phash_dedup
from .frame_manifest import load_frame_manifest
from .mapping import parse_fps
from .quality import quality_route, resize_long_edge
from .sampling import build_candidates
from .structural import global_structural_dedup, select_cosine_cluster_medoids


CANDIDATE_COLUMNS = [
    "candidate_order",
    "video_id",
    "shot_id",
    "target_original_frame_id",
    "original_frame_id",
    "decoded_frame_index",
    "timestamp_ms",
    "pts",
    "fps",
    "retrieval_role",
    "retrieval_roles",
    "brightness_score",
    "blur_score",
    "contrast_score",
    "entropy_score",
    "quality_ok",
    "quality_route",
    "quality_reason",
    "eligible_for_embedding",
    "selected_for_retrieval",
    "source_storage_uri",
]

RETRIEVAL_FRAME_COLUMNS = [
    "n", "video_id", "shot_id", "shot_ids", "original_frame_id",
    "decoded_frame_index", "timestamp_ms", "pts", "frame_idx",
    "pts_time", "fps", "path", "storage_uri", "source_storage_uri",
    "retrieval_role", "retrieval_roles", "brightness_score", "blur_score",
    "contrast_score", "entropy_score", "quality_scores", "quality_route",
    "quality_reason", "quality_ok", "eligible_for_embedding",
    "selected_for_retrieval", "brightness", "std_score",
]


def _row_value(row: Any, key: str, default: Any = None) -> Any:
    if isinstance(row, pd.Series):
        value = row.get(key, default)
    elif isinstance(row, dict):
        value = row.get(key, default)
    else:
        value = getattr(row, key, default)
    return default if value is None or (isinstance(value, float) and np.isnan(value)) else value


def _source_uri(video_row: Any) -> str:
    value = _row_value(video_row, "storage_uri") or _row_value(video_row, "path")
    if not value:
        raise ValueError("video manifest row needs storage_uri or path")
    return str(value)


def _remote_source_options(
    uri: str,
    cfg: Any,
    source_client: Any = None,
    video_row: Any = None,
) -> dict[str, Any]:
    options = (
        dict(cfg.video_source_kwargs(uri))
        if hasattr(cfg, "video_source_kwargs")
        else {}
    )
    if source_client is not None:
        options["client"] = source_client
    if video_row is not None and parse_video_uri(uri).path is None:
        for field, option in (
            ("etag", "expected_etag"),
            ("version_id", "expected_version_id"),
        ):
            value = _row_value(video_row, field)
            if value is not None and not bool(pd.isna(value)):
                options[option] = str(value)
    return options


def _artifact_storage_uri(cfg: Any, image_path: Path, relative_path: str) -> str:
    prefix = getattr(cfg, "artifact_uri_prefix", None)
    if prefix:
        return f"{str(prefix).rstrip('/')}/{relative_path.replace(chr(92), '/')}"
    return image_path.resolve().as_uri()


def _fps_fraction(video_row: Any, frame_manifest: pd.DataFrame):
    fps_text = _row_value(video_row, "fps_str")
    if fps_text:
        try:
            return parse_fps(str(fps_text))
        except ValueError:
            pass
    if not frame_manifest.empty:
        numerator = frame_manifest.iloc[0].get("fps_num")
        denominator = frame_manifest.iloc[0].get("fps_den")
        if pd.notna(numerator) and pd.notna(denominator):
            return parse_fps(f"{int(numerator)}/{int(denominator)}")
    return parse_fps("25/1")


def _scores_from_manifest(row: pd.Series) -> dict[str, float]:
    brightness = float(row["brightness_score"])
    contrast = float(row["contrast_score"])
    return {
        "brightness_score": brightness,
        "blur_score": float(row["blur_score"]),
        "contrast_score": contrast,
        "entropy_score": float(row["entropy_score"]),
        # Compatibility names consumed by the quality gate and old reports.
        "brightness": brightness,
        "std_score": contrast,
    }


def _normalise_shots(shots_df: pd.DataFrame, frame_manifest: pd.DataFrame) -> pd.DataFrame:
    if frame_manifest.empty:
        return shots_df.copy()
    shots = shots_df.copy()
    last_id = int(frame_manifest["original_frame_id"].iloc[-1])
    shots["start_frame"] = shots["start_frame"].clip(lower=0, upper=last_id).astype("int64")
    shots["end_frame"] = shots["end_frame"].clip(lower=0, upper=last_id).astype("int64")
    if len(shots) and str(shots.iloc[-1].get("method", "")) == "fallback":
        shots.loc[shots.index[-1], "end_frame"] = last_id
        last_ms = frame_manifest["timestamp_ms"].iloc[-1]
        if pd.notna(last_ms):
            shots.loc[shots.index[-1], "end_time"] = float(last_ms) / 1000.0
    return shots


def _candidate_roles(candidate: dict) -> list[str]:
    roles = candidate.get("retrieval_roles") or [candidate.get("retrieval_role", "shot_anchor")]
    return sorted({str(role) for role in roles})


def _select_sparse_candidates(
    video_id: str,
    source_uri: str,
    shots_df: pd.DataFrame,
    frame_manifest: pd.DataFrame,
    cfg: Any,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Choose one source frame around every sparse target using manifest scores.

    Returns candidate-table rows, unique quality-passing image requests, and
    temporal-only candidates.  The latter are audit records only: their source
    frames remain available through the full frame manifest and raw video.
    """

    required = {
        "original_frame_id",
        "timestamp_ms",
        "pts",
        "brightness_score",
        "blur_score",
        "contrast_score",
        "entropy_score",
    }
    missing = required - set(frame_manifest.columns)
    if missing:
        raise ValueError(f"frame manifest is missing columns: {sorted(missing)}")

    shots = _normalise_shots(shots_df, frame_manifest)
    candidates = build_candidates(shots, cfg, frame_manifest)
    shot_ranges = {
        int(row.shot_id): (int(row.start_frame), int(row.end_frame))
        for row in shots.itertuples()
    }
    candidate_rows: list[dict] = []
    selected_by_frame: dict[int, dict] = {}
    temporal_only: list[dict] = []

    indexed_manifest = frame_manifest.set_index("original_frame_id", drop=False)
    for candidate_order, candidate in enumerate(candidates):
        target_id = int(candidate["target_frame_id"])
        shot_id = int(candidate["shot_id"])
        shot_start, shot_end = shot_ranges.get(
            shot_id,
            (int(indexed_manifest.index.min()), int(indexed_manifest.index.max())),
        )
        start_id = max(shot_start, target_id - int(cfg.window_radius))
        end_id = min(shot_end, target_id + int(cfg.window_radius))
        window = indexed_manifest.loc[
            (indexed_manifest.index >= start_id) & (indexed_manifest.index <= end_id)
        ]
        if window.empty:
            continue

        ranked: list[tuple[pd.Series, dict, bool, str, str]] = []
        for _, frame_row in window.iterrows():
            scores = _scores_from_manifest(frame_row)
            ok, reason, route = quality_route(scores, cfg)
            ranked.append((frame_row, scores, ok, reason, route))
        passing = [item for item in ranked if item[2]]
        pool = passing or ranked
        chosen_row, scores, quality_ok, reason, route = max(
            pool,
            key=lambda item: (
                item[1]["blur_score"],
                item[1]["contrast_score"],
                -abs(int(item[0]["original_frame_id"]) - target_id),
                -int(item[0]["original_frame_id"]),
            ),
        )
        frame_id = int(chosen_row["original_frame_id"])
        timestamp_ms = float(chosen_row["timestamp_ms"])
        roles = _candidate_roles(candidate)
        record = {
            "candidate_order": candidate_order,
            "video_id": video_id,
            "shot_id": shot_id,
            "target_original_frame_id": target_id,
            "original_frame_id": frame_id,
            "decoded_frame_index": int(chosen_row.get("decoded_frame_index", frame_id)),
            "timestamp_ms": timestamp_ms,
            "pts": None if pd.isna(chosen_row["pts"]) else int(chosen_row["pts"]),
            "fps": "",
            "retrieval_role": roles[0],
            "retrieval_roles": roles,
            "brightness_score": scores["brightness_score"],
            "blur_score": scores["blur_score"],
            "contrast_score": scores["contrast_score"],
            "entropy_score": scores["entropy_score"],
            "quality_ok": bool(quality_ok),
            "quality_route": route,
            "quality_reason": reason,
            "eligible_for_embedding": bool(quality_ok),
            "selected_for_retrieval": False,
            "source_storage_uri": source_uri,
        }
        candidate_rows.append(record)

        if not quality_ok:
            temporal_only.append(record)
            continue
        aggregate = selected_by_frame.setdefault(
            frame_id,
            {
                "original_frame_id": frame_id,
                "decoded_frame_index": record["decoded_frame_index"],
                "pts_time": timestamp_ms / 1000.0,
                "timestamp_ms": timestamp_ms,
                "pts": record["pts"],
                "shot_ids": set(),
                "candidate_orders": set(),
                "retrieval_roles": set(),
                "quality_ok": True,
                "quality_reason": "",
                "quality_route": "retrieval_embedding",
                **scores,
            },
        )
        aggregate["shot_ids"].add(shot_id)
        aggregate["candidate_orders"].add(candidate_order)
        aggregate["retrieval_roles"].update(roles)

    selected = sorted(selected_by_frame.values(), key=lambda item: item["original_frame_id"])
    return candidate_rows, selected, temporal_only


def _decode_selected_images(
    video_row: Any,
    requests: list[dict],
    cfg: Any,
    source_client: Any = None,
) -> int:
    if not requests:
        return 0
    source_uri = _source_uri(video_row)
    requested = {int(item["original_frame_id"]): item for item in requests}
    highest_id = max(requested)
    decoded_count = 0
    with open_video_source(
        source_uri,
        **_remote_source_options(source_uri, cfg, source_client, video_row),
    ) as source:
        with av.open(source) as container:
            if not container.streams.video:
                raise ValueError("video source has no video stream")
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            for original_frame_id, frame in enumerate(container.decode(stream)):
                decoded_count += 1
                item = requested.get(original_frame_id)
                if item is not None:
                    expected_pts = item.get("pts")
                    if expected_pts is not None and frame.pts != expected_pts:
                        raise RuntimeError(
                            "source no longer matches its frame manifest at "
                            f"original_frame_id={original_frame_id}: "
                            f"expected pts={expected_pts}, decoded pts={frame.pts}"
                        )
                    item["frame"] = resize_long_edge(
                        frame.to_ndarray(format="rgb24"),
                        int(cfg.webp_long_edge),
                    )
                if original_frame_id >= highest_id:
                    break
    missing = sorted(frame_id for frame_id, item in requested.items() if "frame" not in item)
    if missing:
        preview = ", ".join(map(str, missing[:10]))
        raise RuntimeError(f"could not decode selected original_frame_id values: {preview}")
    return decoded_count


def _coverage_violations(
    kept: list[dict],
    max_gap_s: float,
    video_start: float,
    video_end: float,
) -> list[dict[str, float]]:
    if max_gap_s <= 0:
        return []
    timestamps = [video_start] + sorted(float(item["pts_time"]) for item in kept) + [video_end]
    return [
        {"start_s": a, "end_s": b, "gap_s": b - a}
        for a, b in zip(timestamps, timestamps[1:])
        if b - a > max_gap_s + 1e-6
    ]


def _extract_stage_fingerprint(
    video_row: Any,
    shots_path: Path,
    frame_manifest_path: Path,
    cfg: Any,
) -> str:
    uri = _source_uri(video_row)
    parsed = parse_video_uri(uri)
    if parsed.path is not None:
        source_stat = parsed.path.stat()
        source_identity = {
            "scheme": "local",
            "size_bytes": source_stat.st_size,
            "mtime_ns": source_stat.st_mtime_ns,
        }
    else:
        with open_video_source(
            uri,
            **_remote_source_options(uri, cfg, video_row=video_row),
        ) as opened:
            source_identity = {
                "scheme": parsed.scheme,
                "size_bytes": int(getattr(opened, "size")),
                "etag": getattr(opened, "etag", None),
                "version_id": getattr(opened, "version_id", None),
            }
    frame_stat = frame_manifest_path.stat()
    shots_stat = shots_path.stat()
    config = cfg.to_dict() if hasattr(cfg, "to_dict") else vars(cfg).copy()
    for key in (
        "input_glob",
        "out_dir",
        "r2_endpoint_url",
        "r2_region_name",
        "s3_endpoint_url",
        "s3_region_name",
        "sbd_weights",
        "sbd_threshold",
        "sbd_min_shot_frames",
    ):
        config.pop(key, None)
    payload = {
        "version": "sparse_retrieval_v2",
        "video_id": str(_row_value(video_row, "video_id")),
        "source": source_identity,
        "frame_manifest": [frame_stat.st_size, frame_stat.st_mtime_ns],
        "shots": [shots_stat.st_size, shots_stat.st_mtime_ns],
        "config": config,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _retrieval_checkpoint_complete(
    store: Any,
    video_id: str,
    *,
    fingerprint: str,
    embed: bool,
) -> bool:
    paths = (
        store.metadata_path(video_id),
        store.retrieval_candidates_path(video_id),
        store.retrieval_frames_path(video_id),
    )
    if not all(path.exists() for path in paths):
        return False
    try:
        metadata = json.loads(paths[0].read_text(encoding="utf-8"))
        if not isinstance(metadata, dict):
            return False
        candidates = pd.read_parquet(paths[1])
        selected = pd.read_parquet(paths[2])
        if not set(CANDIDATE_COLUMNS).issubset(candidates.columns):
            return False
        if not set(RETRIEVAL_FRAME_COLUMNS).issubset(selected.columns):
            return False
        if metadata.get("fingerprint") != fingerprint:
            return False
        if len(candidates) != int(metadata.get("n_candidates", -1)):
            return False
        if len(selected) != int(metadata.get("n_keyframes", -1)):
            return False
        if metadata.get("status") == "no_video_frames":
            return len(candidates) == 0 and len(selected) == 0

        if len(candidates):
            if set(candidates["video_id"].astype(str)) != {video_id}:
                return False
            candidate_ids = pd.to_numeric(candidates["original_frame_id"], errors="raise")
            candidate_times = pd.to_numeric(candidates["timestamp_ms"], errors="raise")
            if (candidate_ids < 0).any() or not np.isfinite(candidate_times).all():
                return False
        if len(selected):
            if set(selected["video_id"].astype(str)) != {video_id}:
                return False
            selected_ids = pd.to_numeric(selected["original_frame_id"], errors="raise")
            selected_times = pd.to_numeric(selected["timestamp_ms"], errors="raise")
            if selected_ids.duplicated().any() or (selected_ids < 0).any():
                return False
            if not np.isfinite(selected_times).all() or (selected_times < 0).any():
                return False
            if not selected["eligible_for_embedding"].fillna(False).astype(bool).all():
                return False
            if not selected["selected_for_retrieval"].fillna(False).astype(bool).all():
                return False
            if set(selected["quality_route"].astype(str)) != {"retrieval_embedding"}:
                return False
        keyframe_root = store.keyframe_dir(video_id).resolve()
        for relative_path in selected["path"].astype(str):
            image_path = (store.root / relative_path).resolve()
            image_path.relative_to(keyframe_root)
            if not image_path.is_file():
                return False
        if embed:
            feature_path = store.features_path(video_id)
            if not feature_path.exists():
                return False
            features = np.load(feature_path, mmap_mode="r")
            if features.ndim != 2 or len(features) != len(selected):
                return False
        return True
    except Exception:  # noqa: BLE001 -- checkpoint validation boundary
        return False


def extract_video(
    video_row: Any,
    shots_df: pd.DataFrame,
    frame_manifest: pd.DataFrame,
    cfg: Any,
    store: Any,
    embedder: Any = None,
    structural_embedder: Any = None,
    source_client: Any = None,
    stage_fingerprint: str | None = None,
) -> dict:
    """Extract retrieval frames without changing canonical source-frame IDs."""

    video_id = str(_row_value(video_row, "video_id"))
    source_uri = _source_uri(video_row)
    started = time.perf_counter()
    fps_fraction = _fps_fraction(video_row, frame_manifest)
    fps_text = f"{fps_fraction.numerator}/{fps_fraction.denominator}"

    candidate_rows, picked, temporal_only = _select_sparse_candidates(
        video_id,
        source_uri,
        shots_df,
        frame_manifest,
        cfg,
    )
    for row in candidate_rows:
        row["fps"] = fps_text

    n_decoded = _decode_selected_images(video_row, picked, cfg, source_client)
    n_after_quality = len(picked)
    kept = phash_dedup(picked, int(cfg.phash_hamming_max))
    n_after_phash = len(kept)

    cosine_drops = 0
    dino_mode = str(getattr(cfg, "dino_mode", "off"))
    dedup_backend = "none"
    if dino_mode != "off" and structural_embedder is None and kept:
        raise RuntimeError("DINO mode is enabled but no structural embedder was provided")
    if structural_embedder is not None and kept:
        structural_features = structural_embedder.encode_images(
            [item["frame"] for item in kept]
        )
        timestamps = [float(item["pts_time"]) for item in kept]
        if dino_mode == "cluster_medoids":
            keep_indexes = select_cosine_cluster_medoids(
                structural_features,
                similarity_threshold=float(cfg.dino_similarity_threshold),
                timestamps=timestamps,
            )
            for index in keep_indexes:
                kept[index]["retrieval_roles"].add("cluster_medoid")
            dedup_backend = "dinov2_cluster_medoids"
        else:
            keep_indexes = global_structural_dedup(
                structural_features,
                similarity_threshold=float(cfg.dino_similarity_threshold),
                timestamps=timestamps,
            )
            dedup_backend = "dinov2_global_dedup"
        cosine_drops = len(kept) - len(keep_indexes)
        kept = [kept[index] for index in keep_indexes]
    elif embedder is not None and kept:
        # Backward-compatible tier-2 compaction when DINO is disabled.
        preview_features = embedder.encode_images([item["frame"] for item in kept])
        keep_indexes = cosine_dedup(preview_features, float(cfg.cosine_dup_threshold))
        cosine_drops = len(kept) - len(keep_indexes)
        kept = [kept[index] for index in keep_indexes]
        dedup_backend = "siglip_cosine"
    n_after_cosine = len(kept)

    duration_s = float(_row_value(video_row, "duration_s", 0.0))
    before_coverage = len(kept)
    # Deliberately pass only quality-passing candidates. A temporal-only frame
    # remains dense evidence and is never promoted to the retrieval index.
    kept = enforce_coverage(picked, kept, float(cfg.max_gap_s), 0.0, duration_s)
    backfilled = len(kept) - before_coverage
    # Retrieval features are generated only for the final post-coverage rows;
    # DINO features remain a separate structural lane and never enter FAISS.
    features = (
        embedder.encode_images([item["frame"] for item in kept])
        if embedder is not None
        else None
    )

    selected_orders = {
        order
        for item in kept
        for order in item.get("candidate_orders", set())
    }
    for row in candidate_rows:
        row["selected_for_retrieval"] = row["candidate_order"] in selected_orders
        for score_name in (
            "brightness_score",
            "blur_score",
            "contrast_score",
            "entropy_score",
        ):
            row[score_name] = round(float(row[score_name]), 4)
    write_parquet_atomic(
        pd.DataFrame(candidate_rows, columns=CANDIDATE_COLUMNS),
        store.retrieval_candidates_path(video_id),
    )

    keyframe_dir = store.keyframe_dir(video_id)
    keyframe_dir.mkdir(parents=True, exist_ok=True)
    selected_rows: list[dict] = []
    for ordinal, item in enumerate(sorted(kept, key=lambda value: value["original_frame_id"]), start=1):
        name = f"{ordinal:04d}.webp"
        image_path = keyframe_dir / name
        bgr = cv2.cvtColor(item["frame"], cv2.COLOR_RGB2BGR)
        written = cv2.imwrite(
            str(image_path),
            bgr,
            [int(cv2.IMWRITE_WEBP_QUALITY), int(cfg.webp_quality)],
        )
        if not written:
            raise OSError(f"failed to write {image_path}")
        roles = sorted(item["retrieval_roles"])
        shot_ids = sorted(int(value) for value in item["shot_ids"])
        relative_path = f"keyframes/{video_id}/{name}"
        quality_scores = {
            "brightness_score": round(float(item["brightness_score"]), 4),
            "blur_score": round(float(item["blur_score"]), 4),
            "contrast_score": round(float(item["contrast_score"]), 4),
            "entropy_score": round(float(item["entropy_score"]), 4),
        }
        selected_rows.append({
            "n": ordinal,
            "video_id": video_id,
            "shot_id": shot_ids[0] if shot_ids else None,
            "shot_ids": shot_ids,
            "original_frame_id": int(item["original_frame_id"]),
            "decoded_frame_index": int(item["decoded_frame_index"]),
            "timestamp_ms": float(item["timestamp_ms"]),
            "pts": item["pts"],
            "frame_idx": int(item["original_frame_id"]),
            "pts_time": round(float(item["pts_time"]), 6),
            "fps": fps_text,
            "path": relative_path,
            "storage_uri": _artifact_storage_uri(cfg, image_path, relative_path),
            "source_storage_uri": source_uri,
            "retrieval_role": roles[0],
            "retrieval_roles": roles,
            "brightness_score": quality_scores["brightness_score"],
            "blur_score": quality_scores["blur_score"],
            "contrast_score": quality_scores["contrast_score"],
            "entropy_score": quality_scores["entropy_score"],
            "quality_scores": quality_scores,
            "quality_route": "retrieval_embedding",
            "quality_reason": "",
            "quality_ok": True,
            "eligible_for_embedding": True,
            "selected_for_retrieval": True,
            # Compatibility aliases used by the existing report.
            "brightness": quality_scores["brightness_score"],
            "std_score": quality_scores["contrast_score"],
        })

    selected_frames = pd.DataFrame(selected_rows)
    if selected_frames.empty:
        selected_frames = pd.DataFrame(columns=RETRIEVAL_FRAME_COLUMNS)
    write_parquet_atomic(selected_frames, store.retrieval_frames_path(video_id))
    write_csv_atomic(selected_frames, store.map_path(video_id))
    if features is not None:
        write_numpy_atomic(features.astype(np.float16), store.features_path(video_id))

    coverage_violations = _coverage_violations(kept, float(cfg.max_gap_s), 0.0, duration_s)
    drops = {
        "quality_routed_temporal_only": len(temporal_only),
        "phash": n_after_quality - n_after_phash,
        "cosine": cosine_drops,
        "backfilled": backfilled,
        "soft_backfilled": 0,
        "coverage_unresolved_gaps": len(coverage_violations),
    }
    meta = {
        "status": "success",
        "video_id": video_id,
        "duration_s": duration_s,
        "fps": fps_text,
        "source_fps": _row_value(video_row, "fps_str", fps_text),
        "n_frames_raw_est": int(_row_value(video_row, "n_frames_est", len(frame_manifest))),
        "n_frames_manifest": int(len(frame_manifest)),
        "n_frames_decoded_for_images": n_decoded,
        "n_shots": int(len(shots_df)),
        "sbd_method": str(shots_df["method"].iloc[0]) if len(shots_df) else "none",
        "n_candidates": len(candidate_rows),
        "n_after_quality": n_after_quality,
        "n_after_phash": n_after_phash,
        "n_after_cosine": n_after_cosine,
        "structural_dedup_backend": dedup_backend,
        "dino_mode": dino_mode,
        "dino_model": getattr(cfg, "dino_model", None) if dino_mode != "off" else None,
        "n_keyframes": len(kept),
        "quality_routing": "no_hard_delete",
        "coverage_guaranteed": not coverage_violations,
        "coverage_violations": coverage_violations,
        "drops": drops,
        "embedded": features is not None,
        "fingerprint": stage_fingerprint,
        "elapsed_s": round(time.perf_counter() - started, 2),
    }
    # Completion metadata is written last so resume never observes a new
    # fingerprint before all data artifacts are durable.
    write_json_atomic(meta, store.metadata_path(video_id))
    return meta


def _write_no_video_checkpoint(
    video_row: Any,
    shots_df: pd.DataFrame,
    cfg: Any,
    store: Any,
    *,
    fingerprint: str,
) -> dict[str, Any]:
    """Persist a terminal, resumable extraction result for a zero-frame source."""

    video_id = str(_row_value(video_row, "video_id"))
    write_parquet_atomic(
        pd.DataFrame(columns=CANDIDATE_COLUMNS),
        store.retrieval_candidates_path(video_id),
    )
    empty_selected = pd.DataFrame(columns=RETRIEVAL_FRAME_COLUMNS)
    write_parquet_atomic(empty_selected, store.retrieval_frames_path(video_id))
    write_csv_atomic(empty_selected, store.map_path(video_id))
    meta = {
        "status": "no_video_frames",
        "video_id": video_id,
        "duration_s": float(_row_value(video_row, "duration_s", 0.0)),
        "fps": str(_row_value(video_row, "fps_str", "25/1")),
        "source_fps": str(_row_value(video_row, "fps_str", "25/1")),
        "n_frames_raw_est": int(_row_value(video_row, "n_frames_est", 0)),
        "n_frames_manifest": 0,
        "n_frames_decoded_for_images": 0,
        "n_shots": int(len(shots_df)),
        "sbd_method": str(shots_df["method"].iloc[0]) if len(shots_df) else "none",
        "n_candidates": 0,
        "n_after_quality": 0,
        "n_after_phash": 0,
        "n_after_cosine": 0,
        "structural_dedup_backend": "none",
        "dino_mode": str(getattr(cfg, "dino_mode", "off")),
        "dino_model": (
            getattr(cfg, "dino_model", None)
            if getattr(cfg, "dino_mode", "off") != "off"
            else None
        ),
        "n_keyframes": 0,
        "quality_routing": "no_hard_delete",
        "coverage_guaranteed": True,
        "coverage_violations": [],
        "drops": {
            "quality_routed_temporal_only": 0,
            "phash": 0,
            "cosine": 0,
            "backfilled": 0,
            "soft_backfilled": 0,
            "coverage_unresolved_gaps": 0,
        },
        "embedded": False,
        "fingerprint": fingerprint,
        "elapsed_s": 0.0,
    }
    write_json_atomic(meta, store.metadata_path(video_id))
    return meta


def _write_env_info(store: Any) -> None:
    info = {"platform": platform.platform(), "python": platform.python_version()}
    try:
        import torch

        info["torch"] = torch.__version__
        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
    except ModuleNotFoundError:
        pass
    write_json_atomic(info, store.root / "env.json")


def run_pass_b(cfg: Any, store: Any, manifest: pd.DataFrame, limit: int | None = None) -> None:
    """Run sparse extraction for each video after shots and frame manifests exist."""

    _write_env_info(store)
    embedder = None
    structural_embedder = None

    if "video_id" not in manifest.columns or manifest["video_id"].astype(str).duplicated().any():
        raise ValueError("video manifest needs unique video_id values")
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 0):
        raise ValueError("limit must be a non-negative integer or None")
    todo = manifest.head(limit) if limit is not None else manifest
    done = skipped = failed = 0
    for _, row in todo.iterrows():
        video_id = row["video_id"]
        shots_path = store.shots_path(video_id)
        frame_manifest_path = store.frame_manifest_path(video_id)
        if not shots_path.exists():
            store.log_failed(str(video_id), "extract | missing shots checkpoint (run shots first)")
            failed += 1
            continue
        if not frame_manifest_path.exists():
            store.log_failed(
                str(video_id),
                "extract | missing frame manifest checkpoint (run frames first)",
            )
            failed += 1
            continue
        try:
            fingerprint = _extract_stage_fingerprint(
                row,
                shots_path,
                frame_manifest_path,
                cfg,
            )
            if _retrieval_checkpoint_complete(
                store,
                str(video_id),
                fingerprint=fingerprint,
                embed=bool(cfg.embed),
            ):
                skipped += 1
                continue
            shots = pd.read_parquet(shots_path)
            frames = load_frame_manifest(frame_manifest_path)
            if frames.empty:
                meta = _write_no_video_checkpoint(
                    row,
                    shots,
                    cfg,
                    store,
                    fingerprint=fingerprint,
                )
                print(f"[extract] {video_id}: terminal checkpoint (no decodable video frames)")
                done += 1
                continue
            if cfg.embed and embedder is None:
                from ..embed import ClipEmbedder

                embedder = ClipEmbedder(cfg)
            if cfg.dino_mode != "off" and structural_embedder is None:
                from .structural import DinoV2Embedder

                structural_embedder = DinoV2Embedder(
                    model_name=cfg.dino_model,
                    device=cfg.device,
                    batch_size=cfg.dino_batch_size,
                )
            meta = extract_video(
                row,
                shots,
                frames,
                cfg,
                store,
                embedder,
                structural_embedder,
                stage_fingerprint=fingerprint,
            )
        except Exception as error:  # noqa: BLE001 - isolate bad videos in batch jobs
            store.log_failed(str(video_id), f"extract | {type(error).__name__} | {error}")
            failed += 1
            if embedder is not None or structural_embedder is not None:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            continue
        done += 1
        print(
            f"[extract] {video_id}: {meta['n_candidates']} candidates -> "
            f"{meta['n_after_quality']} retrieval quality -> "
            f"{meta['n_after_phash']} dHash -> {meta['n_keyframes']} final "
            f"({meta['elapsed_s']:.1f}s)"
        )
    print(f"[extract] done={done} skipped={skipped} failed={failed}")
