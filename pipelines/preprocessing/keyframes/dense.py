"""Dense event-window decoding and deterministic semantic-frame selection.

This module is deliberately independent from sparse retrieval deduplication:
every canonical source frame in the requested half-open interval is returned.
The frame manifest is the authority for ``original_frame_id`` and timestamps;
decoder-local counters are used only as a documented last-resort mapping after
retrying the decode from the beginning of the stream.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass, field
from math import isfinite, log1p
import os
from pathlib import Path
from typing import Any

import av
import cv2
import numpy as np
import pandas as pd

from ..io_utils import write_json_atomic, write_parquet_atomic
from ..video_source import open_video_source
from .quality import quality_scores as measure_quality


@dataclass(slots=True)
class DenseFrame:
    """One canonical source frame decoded for temporal alignment.

    ``image`` is RGB.  Quality values are observations, never deletion flags.
    ``mapping_method`` is either ``"pts"`` or ``"decode_order_fallback"`` so
    downstream code can audit how the decoded image was joined to the manifest.
    """

    original_frame_id: int
    timestamp_ms: float
    image: np.ndarray = field(repr=False)
    pts: int | None = None
    is_codec_keyframe: bool = False
    mapping_method: str = "pts"
    quality_scores: dict[str, float] = field(default_factory=dict)


@dataclass(slots=True)
class SemanticKeyframeSelection:
    """Explainable result of the deterministic baseline selector."""

    frame: DenseFrame
    score: float
    evidence: dict[str, Any]

    @property
    def original_frame_id(self) -> int:
        return self.frame.original_frame_id

    @property
    def timestamp_ms(self) -> float:
        return self.frame.timestamp_ms


def _load_manifest(frame_manifest: pd.DataFrame | str | Path) -> pd.DataFrame:
    if isinstance(frame_manifest, pd.DataFrame):
        manifest = frame_manifest.copy()
    else:
        path = Path(frame_manifest)
        if not path.exists():
            raise FileNotFoundError(f"frame manifest does not exist: {path}")
        suffix = path.suffix.lower()
        if suffix in {".parquet", ".pq"}:
            manifest = pd.read_parquet(path)
        elif suffix == ".csv":
            manifest = pd.read_csv(path)
        elif suffix in {".jsonl", ".ndjson"}:
            manifest = pd.read_json(path, lines=True)
        elif suffix == ".json":
            manifest = pd.read_json(path)
        else:
            raise ValueError(
                "frame_manifest path must end in .parquet, .pq, .csv, .json, "
                "or .jsonl"
            )

    if manifest.empty:
        raise ValueError("frame_manifest must not be empty")
    if "original_frame_id" not in manifest.columns:
        raise ValueError("frame_manifest must contain original_frame_id")

    numeric_ids = pd.to_numeric(manifest["original_frame_id"], errors="coerce")
    if numeric_ids.isna().any() or (numeric_ids % 1 != 0).any():
        raise ValueError("original_frame_id must contain integers only")
    manifest["original_frame_id"] = numeric_ids.astype("int64")
    manifest = manifest.sort_values("original_frame_id").reset_index(drop=True)

    ids = manifest["original_frame_id"].tolist()
    if ids[0] != 0 or ids != list(range(len(ids))):
        raise ValueError(
            "frame_manifest must describe the full zero-based source timeline "
            "without duplicate or missing original_frame_id values"
        )

    if "pts" not in manifest.columns:
        manifest["pts"] = pd.Series([pd.NA] * len(manifest), dtype="Int64")
    else:
        numeric_pts = pd.to_numeric(manifest["pts"], errors="coerce")
        non_null_pts = numeric_pts.dropna()
        if (non_null_pts % 1 != 0).any():
            raise ValueError("manifest pts values must be integers")
        if non_null_pts.duplicated().any():
            raise ValueError("non-null manifest pts values must be unique")
        manifest["pts"] = numeric_pts.astype("Int64")

    keyframe_column = next(
        (name for name in ("is_codec_keyframe", "key_frame") if name in manifest.columns),
        None,
    )
    if keyframe_column is None:
        manifest["is_codec_keyframe"] = False
        manifest.loc[0, "is_codec_keyframe"] = True
    else:
        manifest["is_codec_keyframe"] = manifest[keyframe_column].fillna(False).astype(bool)
        # Frame zero is always a safe full-decode anchor, even if a producer did
        # not expose the codec keyframe flag correctly.
        manifest.loc[0, "is_codec_keyframe"] = True
    return manifest


def _validate_window(start_frame_id: int, end_frame_id: int, frame_count: int) -> None:
    for name, value in (
        ("start_frame_id", start_frame_id),
        ("end_frame_id", end_frame_id),
    ):
        if isinstance(value, bool) or not isinstance(value, (int, np.integer)):
            raise TypeError(f"{name} must be an integer")
    if start_frame_id < 0:
        raise ValueError("start_frame_id must be non-negative")
    if end_frame_id <= start_frame_id:
        raise ValueError("end_frame_id must be greater than start_frame_id")
    if end_frame_id > frame_count:
        raise ValueError(
            f"requested frame range ends at {end_frame_id}, but manifest has "
            f"{frame_count} frames"
        )


def _resize_rgb(image: np.ndarray, resize: int | tuple[int, int] | None) -> np.ndarray:
    if resize is None:
        return image
    if isinstance(resize, bool):
        raise TypeError("resize must be a positive long-edge integer or (width, height)")
    if isinstance(resize, (int, np.integer)):
        long_edge = int(resize)
        if long_edge <= 0:
            raise ValueError("resize long edge must be positive")
        height, width = image.shape[:2]
        scale = long_edge / max(height, width)
        if scale == 1:
            return image
        interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
        return cv2.resize(
            image,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=interpolation,
        )
    if isinstance(resize, tuple) and len(resize) == 2:
        width, height = resize
        if any(
            isinstance(value, bool) or not isinstance(value, (int, np.integer)) or value <= 0
            for value in (width, height)
        ):
            raise ValueError("resize width and height must be positive integers")
        return cv2.resize(image, (int(width), int(height)), interpolation=cv2.INTER_AREA)
    raise TypeError("resize must be a positive long-edge integer or (width, height)")


def _timestamp_ms(row: pd.Series, stream_time_base: Any) -> float:
    if "timestamp_ms" in row.index and pd.notna(row["timestamp_ms"]):
        value = float(row["timestamp_ms"])
    elif pd.notna(row["pts"]):
        if (
            "time_base_num" in row.index
            and "time_base_den" in row.index
            and pd.notna(row["time_base_num"])
            and pd.notna(row["time_base_den"])
        ):
            denominator = int(row["time_base_den"])
            if denominator <= 0:
                raise ValueError("time_base_den must be positive")
            value = int(row["pts"]) * int(row["time_base_num"]) * 1000 / denominator
        elif stream_time_base is not None:
            value = float(int(row["pts"]) * stream_time_base * 1000)
        else:
            raise ValueError(
                "manifest needs timestamp_ms or a usable pts/time_base mapping"
            )
    else:
        raise ValueError("manifest row needs timestamp_ms when pts is null")
    if not isfinite(value) or value < 0:
        raise ValueError("manifest timestamp_ms values must be finite and non-negative")
    return value


def _build_dense_frame(
    decoded_frame: av.VideoFrame,
    row: pd.Series,
    stream_time_base: Any,
    resize: int | tuple[int, int] | None,
    mapping_method: str,
) -> DenseFrame:
    image = _resize_rgb(decoded_frame.to_ndarray(format="rgb24"), resize)
    return DenseFrame(
        original_frame_id=int(row["original_frame_id"]),
        timestamp_ms=_timestamp_ms(row, stream_time_base),
        image=image,
        pts=None if pd.isna(row["pts"]) else int(row["pts"]),
        is_codec_keyframe=bool(row["is_codec_keyframe"]),
        mapping_method=mapping_method,
        quality_scores={key: float(value) for key, value in measure_quality(image).items()},
    )


def _decode_pass(
    container: av.container.InputContainer,
    stream: av.video.stream.VideoStream,
    manifest: pd.DataFrame,
    start_frame_id: int,
    end_frame_id: int,
    resize: int | tuple[int, int] | None,
    *,
    from_start: bool,
) -> dict[int, DenseFrame]:
    """Decode once, preferring exact PTS joins and optionally falling back to order."""

    pts_to_id = {
        int(row.pts): int(row.original_frame_id)
        for row in manifest[["original_frame_id", "pts"]].itertuples(index=False)
        if pd.notna(row.pts)
    }
    selected: dict[int, DenseFrame] = {}
    decode_order = 0
    last_mapped_id = -1

    for decoded in container.decode(stream):
        canonical_id = pts_to_id.get(int(decoded.pts)) if decoded.pts is not None else None
        mapping_method = "pts"

        if canonical_id is None and from_start:
            # A full decode from stream start has the same presentation order
            # used to construct a full manifest.  This fallback is deliberately
            # unavailable after a partial seek, where the starting ordinal is
            # ambiguous until at least one PTS matches.
            canonical_id = decode_order
            mapping_method = "decode_order_fallback"
        elif canonical_id is None and last_mapped_id >= 0:
            candidate_id = last_mapped_id + 1
            if candidate_id < len(manifest):
                canonical_id = candidate_id
                mapping_method = "decode_order_fallback"

        decode_order += 1
        if canonical_id is None or canonical_id < last_mapped_id:
            continue
        last_mapped_id = canonical_id
        if canonical_id >= len(manifest):
            break
        if start_frame_id <= canonical_id < end_frame_id:
            selected[canonical_id] = _build_dense_frame(
                decoded,
                manifest.iloc[canonical_id],
                stream.time_base,
                resize,
                mapping_method,
            )
        if canonical_id >= end_frame_id - 1:
            break
    return selected


def decode_window(
    video_source_or_path: Any,
    frame_manifest: pd.DataFrame | str | Path,
    start_frame_id: int,
    end_frame_id: int,
    resize: int | tuple[int, int] | None = None,
    *,
    source_options: Mapping[str, Any] | None = None,
) -> list[DenseFrame]:
    """Decode every canonical frame in ``[start_frame_id, end_frame_id)``.

    The nearest preceding codec-keyframe PTS in the full frame manifest is used
    as the first seek anchor.  Exact decoded-PTS joins are preferred.  If that
    pass is incomplete, the stream is reset and decoded from the beginning so
    presentation order can safely fill missing PTS joins.  A partial or shifted
    result is never returned.

    Local paths, ``file://``, ``s3://`` and ``r2://`` values are opened through
    :func:`open_video_source`; pass its keyword arguments (for example an
    injected R2 ``client``) in ``source_options``.  A raw seekable file-like
    value accepted by :func:`av.open` is also supported for tests/callers that
    already own source lifetime. ``resize`` accepts a positive target long edge
    or an explicit ``(width, height)`` tuple and never changes canonical IDs.
    """

    manifest = _load_manifest(frame_manifest)
    _validate_window(start_frame_id, end_frame_id, len(manifest))
    # Validate resize before opening a potentially remote or expensive source.
    _resize_rgb(np.zeros((1, 1, 3), dtype=np.uint8), resize)
    expected_ids = list(range(start_frame_id, end_frame_id))

    options = dict(source_options or {})
    if isinstance(video_source_or_path, (str, os.PathLike)):
        source_context = open_video_source(video_source_or_path, **options)
    else:
        if options:
            raise ValueError("source_options are only valid for a path or storage URI")
        source_context = nullcontext(video_source_or_path)

    with source_context as resolved_source, av.open(resolved_source) as container:
        if not container.streams.video:
            raise ValueError("video source has no video stream")
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"

        anchors = manifest.loc[
            (manifest["original_frame_id"] <= start_frame_id)
            & manifest["is_codec_keyframe"]
            & manifest["pts"].notna()
        ]
        if not anchors.empty:
            seek_pts = int(anchors.iloc[-1]["pts"])
        elif pd.notna(manifest.iloc[start_frame_id]["pts"]):
            # With ``any_frame=False``, FFmpeg still seeks backward to a codec
            # keyframe even if the manifest producer omitted keyframe flags.
            seek_pts = int(manifest.iloc[start_frame_id]["pts"])
        else:
            seek_pts = 0

        first_error: Exception | None = None
        try:
            container.seek(seek_pts, stream=stream, backward=True, any_frame=False)
            selected = _decode_pass(
                container,
                stream,
                manifest,
                start_frame_id,
                end_frame_id,
                resize,
                from_start=False,
            )
        except (av.error.FFmpegError, OSError, ValueError) as error:
            first_error = error
            selected = {}

        if sorted(selected) != expected_ids:
            try:
                container.seek(0, stream=stream, backward=True, any_frame=False)
                selected = _decode_pass(
                    container,
                    stream,
                    manifest,
                    start_frame_id,
                    end_frame_id,
                    resize,
                    from_start=True,
                )
            except (av.error.FFmpegError, OSError, ValueError) as error:
                detail = f"; initial seek failed: {first_error}" if first_error else ""
                raise RuntimeError(f"could not restart video for safe dense decode{detail}") from error

    missing = [frame_id for frame_id in expected_ids if frame_id not in selected]
    if missing:
        preview = ", ".join(map(str, missing[:10]))
        suffix = "..." if len(missing) > 10 else ""
        raise RuntimeError(
            "dense decode could not map every requested source frame; missing "
            f"original_frame_id values: {preview}{suffix}"
        )
    return [selected[frame_id] for frame_id in expected_ids]


DENSE_CANDIDATE_COLUMNS = [
    "event_window_id",
    "video_id",
    "original_frame_id",
    "timestamp_ms",
    "decode_status",
    "quality_scores",
    "event_score",
    "evidence",
]


def dense_candidates_dataframe(
    frames: Sequence[DenseFrame],
    *,
    event_window_id: str,
    video_id: str,
    event_scores: Mapping[int, float] | None = None,
) -> pd.DataFrame:
    """Return schema-aligned, image-free dense candidate metadata.

    RGB arrays intentionally remain in memory; Parquet receives only canonical
    IDs, timestamps, quality/event values, and auditable decoder evidence.
    """

    if not event_window_id or not isinstance(event_window_id, str):
        raise ValueError("event_window_id must be a non-empty string")
    if not video_id or not isinstance(video_id, str):
        raise ValueError("video_id must be a non-empty string")
    ordered = sorted(frames, key=lambda frame: frame.original_frame_id)
    if len({frame.original_frame_id for frame in ordered}) != len(ordered):
        raise ValueError("frames must have unique original_frame_id values")
    scores = _external_values(ordered, event_scores)
    has_scores = event_scores is not None
    quality_keys = sorted({key for frame in ordered for key in frame.quality_scores})
    rows = []
    for index, frame in enumerate(ordered):
        if not isfinite(float(frame.timestamp_ms)) or frame.timestamp_ms < 0:
            raise ValueError("frame timestamps must be finite and non-negative")
        quality = {
            key: (
                float(frame.quality_scores[key])
                if key in frame.quality_scores
                else None
            )
            for key in quality_keys
        }
        if any(value is not None and not isfinite(value) for value in quality.values()):
            raise ValueError("quality scores must be finite")
        rows.append({
            "event_window_id": event_window_id,
            "video_id": video_id,
            "original_frame_id": int(frame.original_frame_id),
            "timestamp_ms": float(frame.timestamp_ms),
            "decode_status": "success",
            "quality_scores": quality,
            "event_score": scores[index] if has_scores else None,
            "evidence": {
                "pts": frame.pts,
                "is_codec_keyframe": bool(frame.is_codec_keyframe),
                "mapping_method": frame.mapping_method,
            },
        })
    return pd.DataFrame(rows, columns=DENSE_CANDIDATE_COLUMNS)


def write_dense_candidates(
    frames: Sequence[DenseFrame],
    output_path: str | Path,
    *,
    event_window_id: str,
    video_id: str,
    event_scores: Mapping[int, float] | None = None,
) -> Path:
    """Write dense candidate metadata to Parquet and return its path."""

    path = Path(output_path)
    if path.suffix.lower() not in {".parquet", ".pq"}:
        raise ValueError("dense candidate output path must end in .parquet or .pq")
    write_parquet_atomic(
        dense_candidates_dataframe(
            frames,
            event_window_id=event_window_id,
            video_id=video_id,
            event_scores=event_scores,
        ),
        path,
    )
    return path


def semantic_selection_record(
    selection: SemanticKeyframeSelection,
    *,
    event_window_id: str,
    video_id: str,
) -> dict[str, Any]:
    """Convert a selection to the semantic-keyframe JSON contract."""

    if not event_window_id or not isinstance(event_window_id, str):
        raise ValueError("event_window_id must be a non-empty string")
    if not video_id or not isinstance(video_id, str):
        raise ValueError("video_id must be a non-empty string")
    if not isfinite(float(selection.score)):
        raise ValueError("selection score must be finite")
    return {
        "event_window_id": event_window_id,
        "video_id": video_id,
        "original_frame_id": int(selection.original_frame_id),
        "timestamp_ms": float(selection.timestamp_ms),
        "selection_score": float(selection.score),
        "selector": "weighted_event_quality_motion_v1",
        "evidence": selection.evidence,
    }


def write_semantic_selection(
    selection: SemanticKeyframeSelection,
    output_path: str | Path,
    *,
    event_window_id: str,
    video_id: str,
) -> Path:
    """Write one semantic selection as strict, schema-aligned JSON."""

    path = Path(output_path)
    if path.suffix.lower() != ".json":
        raise ValueError("semantic selection output path must end in .json")
    record = semantic_selection_record(
        selection,
        event_window_id=event_window_id,
        video_id=video_id,
    )
    write_json_atomic(record, path, ensure_ascii=False)
    return path


_DEFAULT_WEIGHTS = {
    "external": 0.65,
    "quality": 0.15,
    "motion": 0.10,
    "target": 0.10,
}


def _normalise(values: Sequence[float]) -> list[float]:
    low, high = min(values), max(values)
    if high == low:
        return [0.0] * len(values)
    return [(value - low) / (high - low) for value in values]


def _quality_value(frame: DenseFrame) -> float:
    scores = frame.quality_scores or measure_quality(frame.image)
    blur = max(0.0, float(scores.get("blur_score", 0.0)))
    contrast = max(
        0.0,
        float(scores.get("contrast_score", scores.get("std_score", 0.0))),
    )
    entropy = max(0.0, float(scores.get("entropy_score", 0.0)))
    return log1p(blur) + log1p(contrast) + entropy


def _pair_motion(left: np.ndarray, right: np.ndarray) -> float:
    left_gray = cv2.cvtColor(left, cv2.COLOR_RGB2GRAY)
    right_gray = cv2.cvtColor(right, cv2.COLOR_RGB2GRAY)
    if right_gray.shape != left_gray.shape:
        right_gray = cv2.resize(
            right_gray,
            (left_gray.shape[1], left_gray.shape[0]),
            interpolation=cv2.INTER_AREA,
        )
    return float(np.mean(cv2.absdiff(left_gray, right_gray)))


def _motion_values(frames: Sequence[DenseFrame]) -> list[float]:
    if len(frames) == 1:
        return [0.0]
    pair_values = [
        _pair_motion(frames[index].image, frames[index + 1].image)
        for index in range(len(frames) - 1)
    ]
    values = []
    for index in range(len(frames)):
        neighbours = []
        if index > 0:
            neighbours.append(pair_values[index - 1])
        if index < len(frames) - 1:
            neighbours.append(pair_values[index])
        values.append(sum(neighbours) / len(neighbours))
    return values


def _external_values(
    frames: Sequence[DenseFrame],
    external_scores: Mapping[int, float] | None,
) -> list[float]:
    if external_scores is None:
        return [0.0] * len(frames)
    frame_ids = {frame.original_frame_id for frame in frames}
    if isinstance(external_scores, Mapping):
        unknown = set(external_scores) - frame_ids
        if unknown:
            raise ValueError(f"external_scores contains unknown frame ids: {sorted(unknown)}")
        missing = frame_ids - set(external_scores)
        if missing:
            raise ValueError(
                "external_scores must cover every dense frame; missing ids: "
                f"{sorted(missing)}"
            )
        values = [float(external_scores[frame.original_frame_id]) for frame in frames]
    else:
        raise TypeError(
            "external_scores must map original_frame_id to score; positional sequences are unsafe"
        )
    if any(not isfinite(value) for value in values):
        raise ValueError("external_scores must contain finite numeric values")
    return values


def _active_weights(
    weights: Mapping[str, float] | None,
    *,
    has_external: bool,
    has_target: bool,
) -> dict[str, float]:
    result = dict(_DEFAULT_WEIGHTS)
    if weights is not None:
        unknown = set(weights) - set(result)
        if unknown:
            raise ValueError(f"unknown semantic selection weights: {sorted(unknown)}")
        for name, value in weights.items():
            numeric = float(value)
            if not isfinite(numeric) or numeric < 0:
                raise ValueError("semantic selection weights must be finite and non-negative")
            result[name] = numeric
    if not has_external:
        result["external"] = 0.0
    if not has_target:
        result["target"] = 0.0
    total = sum(result.values())
    if total <= 0:
        raise ValueError("at least one active semantic selection weight must be positive")
    return {name: value / total for name, value in result.items() if value > 0}


def select_semantic_keyframe(
    frames: Sequence[DenseFrame],
    external_scores: Mapping[int, float] | None = None,
    target_frame_id: int | None = None,
    weights: Mapping[str, float] | None = None,
) -> SemanticKeyframeSelection:
    """Select one frame using event evidence first, then quality and motion.

    Scores are min-max normalised within the event window.  Default external
    weight is 0.65, so an event model is the primary signal; image quality and
    local motion provide deterministic baseline evidence rather than deleting
    frames.  ``target_frame_id`` is an optional proximity hint.  Final ties are
    resolved by external, quality, motion, target proximity, then the earlier
    canonical frame ID.
    """

    ordered = sorted(frames, key=lambda frame: frame.original_frame_id)
    if not ordered:
        raise ValueError("frames must not be empty")
    ids = [frame.original_frame_id for frame in ordered]
    if len(ids) != len(set(ids)):
        raise ValueError("frames must have unique original_frame_id values")
    for frame in ordered:
        if frame.original_frame_id < 0:
            raise ValueError("original_frame_id must be non-negative")
        if not isinstance(frame.image, np.ndarray) or frame.image.ndim != 3 or frame.image.shape[2] != 3:
            raise ValueError("every DenseFrame.image must be an HxWx3 RGB numpy array")
        if frame.image.size == 0:
            raise ValueError("DenseFrame.image must not be empty")
    if target_frame_id is not None:
        if (
            isinstance(target_frame_id, bool)
            or not isinstance(target_frame_id, (int, np.integer))
            or target_frame_id < 0
        ):
            raise ValueError("target_frame_id must be a non-negative integer")

    external_raw = _external_values(ordered, external_scores)
    quality_raw = [_quality_value(frame) for frame in ordered]
    motion_raw = _motion_values(ordered)
    target_raw = [
        0.0 if target_frame_id is None else 1.0 / (1.0 + abs(frame.original_frame_id - target_frame_id))
        for frame in ordered
    ]
    external_norm = _normalise(external_raw)
    quality_norm = _normalise(quality_raw)
    motion_norm = _normalise(motion_raw)
    target_norm = target_raw
    active_weights = _active_weights(
        weights,
        has_external=external_scores is not None,
        has_target=target_frame_id is not None,
    )

    candidates: list[dict[str, Any]] = []
    for index, frame in enumerate(ordered):
        components = {
            "external": external_norm[index],
            "quality": quality_norm[index],
            "motion": motion_norm[index],
            "target": target_norm[index],
        }
        total = sum(active_weights.get(name, 0.0) * value for name, value in components.items())
        candidates.append({
            "frame": frame,
            "total": float(total),
            "external_raw": external_raw[index],
            "quality_raw": quality_raw[index],
            "motion_raw": motion_raw[index],
            "target_distance_frames": (
                None if target_frame_id is None else abs(frame.original_frame_id - target_frame_id)
            ),
            **components,
        })

    winner = max(
        candidates,
        key=lambda candidate: (
            candidate["total"],
            candidate["external"],
            candidate["quality"],
            candidate["motion"],
            candidate["target"],
            -candidate["frame"].original_frame_id,
        ),
    )
    candidate_scores = {
        str(candidate["frame"].original_frame_id): {
            "total_score": candidate["total"],
            "external_score": candidate["external_raw"],
            "external_normalized": candidate["external"],
            "quality_score": candidate["quality_raw"],
            "quality_normalized": candidate["quality"],
            "motion_score": candidate["motion_raw"],
            "motion_normalized": candidate["motion"],
            "target_distance_frames": candidate["target_distance_frames"],
            "target_proximity": candidate["target"],
        }
        for candidate in candidates
    }
    evidence = {
        "selection_rule": "weighted_event_quality_motion_with_deterministic_tiebreak",
        "weights": active_weights,
        "target_frame_id": target_frame_id,
        "mapping_method": winner["frame"].mapping_method,
        "candidate_scores": candidate_scores,
        "tie_break_order": [
            "total_score",
            "external_score",
            "quality_score",
            "motion_score",
            "target_proximity",
            "earlier_original_frame_id",
        ],
    }
    return SemanticKeyframeSelection(
        frame=winner["frame"],
        score=winner["total"],
        evidence=evidence,
    )


__all__ = [
    "DENSE_CANDIDATE_COLUMNS",
    "DenseFrame",
    "SemanticKeyframeSelection",
    "decode_window",
    "dense_candidates_dataframe",
    "semantic_selection_record",
    "select_semantic_keyframe",
    "write_dense_candidates",
    "write_semantic_selection",
]
