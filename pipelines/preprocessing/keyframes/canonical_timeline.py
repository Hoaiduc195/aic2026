"""Build the exact source-frame timeline without image-quality extraction.

The identity-mapping gate only needs a sequential decode, frame PTS, and
codec dimensions.  Image quality signals remain a separate, more expensive
stage; this artifact never fills those fields with fabricated values.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from collections.abc import Mapping
from fractions import Fraction
from pathlib import Path
from typing import Any

import av
import pandas as pd

from ..io_utils import write_parquet_atomic

CANONICAL_TIMELINE_COLUMNS = [
    "video_id",
    "original_frame_id",
    "decoded_frame_index",
    "pts",
    "time_base_num",
    "time_base_den",
    "fps_num",
    "fps_den",
    "raw_pts_timestamp_ms",
    "pts_origin_ms",
    "pts_timestamp_ms",
    "cfr_timestamp_ms",
    "timestamp_ms",
    "timestamp_source",
    "is_codec_keyframe",
    "decode_status",
    "width",
    "height",
    "timeline_backend",
]


def _row_value(row: Mapping[str, Any] | pd.Series, key: str) -> Any:
    return row.get(key)


def _positive_fraction(value: Any) -> Fraction | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    try:
        result = value if isinstance(value, Fraction) else Fraction(str(value))
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return result if result > 0 else None


def _fraction_parts(value: Any) -> tuple[int | None, int | None]:
    if value is None:
        return None, None
    try:
        result = value if isinstance(value, Fraction) else Fraction(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None, None
    if result.denominator <= 0:
        return None, None
    return int(result.numerator), int(result.denominator)


def _timestamp_ms(numerator: int, denominator: int) -> float:
    return float(Fraction(numerator * 1000, denominator))


def _fps(row: Mapping[str, Any] | pd.Series, stream: Any) -> Fraction | None:
    exact = _positive_fraction(_row_value(row, "fps_str"))
    if exact is not None:
        return exact
    return _positive_fraction(getattr(stream, "average_rate", None))


def validate_canonical_timeline(frame: pd.DataFrame) -> None:
    """Validate the identity/timestamp invariants of a decoded timeline."""

    missing = sorted(set(CANONICAL_TIMELINE_COLUMNS) - set(frame.columns))
    if missing:
        raise ValueError(f"canonical timeline is missing columns: {missing}")
    expected = list(range(len(frame)))
    for column in ("original_frame_id", "decoded_frame_index"):
        values = pd.to_numeric(frame[column], errors="coerce")
        if values.isna().any() or (values % 1 != 0).any():
            raise ValueError(f"canonical timeline has invalid {column}")
        if values.astype("int64").tolist() != expected:
            raise ValueError(f"canonical timeline {column} must be contiguous and zero-based")
    if frame["decode_status"].ne("success").any():
        raise ValueError("canonical timeline contains non-success decode rows")
    timestamps = pd.to_numeric(frame["timestamp_ms"], errors="coerce")
    if timestamps.isna().any() or (~timestamps.map(math.isfinite)).any() or (timestamps < 0).any():
        raise ValueError("canonical timeline has invalid timestamps")
    if timestamps.tolist() != sorted(timestamps.tolist()):
        raise ValueError("canonical timeline timestamps must be non-decreasing")


def build_canonical_timeline(
    video_row: Mapping[str, Any] | pd.Series,
    output_path: str | Path,
    *,
    backend: str = "pyav",
) -> pd.DataFrame:
    """Sequentially decode one local video and persist metadata-only rows."""

    if backend == "ffprobe":
        return _build_ffprobe_timeline(video_row, output_path)
    if backend != "pyav":
        raise ValueError("backend must be 'pyav' or 'ffprobe'")

    video_id = str(_row_value(video_row, "video_id") or "").strip()
    path_value = _row_value(video_row, "path")
    if not video_id or not path_value:
        raise ValueError("video_row requires video_id and local path")
    video_path = Path(str(path_value))
    if not video_path.is_file():
        raise FileNotFoundError(video_path)

    rows: list[dict[str, Any]] = []
    with av.open(str(video_path)) as container:
        stream = next(iter(container.streams.video), None)
        if stream is None:
            empty = pd.DataFrame(columns=CANONICAL_TIMELINE_COLUMNS)
            write_parquet_atomic(empty, output_path)
            return empty

        fps = _fps(video_row, stream)
        fps_num = fps.numerator if fps is not None else None
        fps_den = fps.denominator if fps is not None else None
        pts_origin_ms: float | None = None

        for decoded_frame_index, frame in enumerate(container.decode(stream)):
            time_base_num, time_base_den = _fraction_parts(
                frame.time_base or stream.time_base
            )
            pts = int(frame.pts) if frame.pts is not None else None
            raw_pts_timestamp_ms = None
            if pts is not None and time_base_num is not None and time_base_den is not None:
                raw_pts_timestamp_ms = _timestamp_ms(
                    pts * time_base_num,
                    time_base_den,
                )
            cfr_timestamp_ms = None
            if fps_num is not None and fps_den is not None:
                cfr_timestamp_ms = _timestamp_ms(decoded_frame_index * fps_den, fps_num)
            if raw_pts_timestamp_ms is not None and pts_origin_ms is None:
                pts_origin_ms = raw_pts_timestamp_ms - (cfr_timestamp_ms or 0.0)
            pts_timestamp_ms = (
                raw_pts_timestamp_ms - pts_origin_ms
                if raw_pts_timestamp_ms is not None and pts_origin_ms is not None
                else None
            )
            if pts_timestamp_ms is not None and abs(pts_timestamp_ms) < 1e-9:
                pts_timestamp_ms = 0.0
            if pts_timestamp_ms is not None:
                timestamp_ms = pts_timestamp_ms
                timestamp_source = "pts"
            elif cfr_timestamp_ms is not None:
                timestamp_ms = cfr_timestamp_ms
                timestamp_source = "cfr_fallback"
            else:
                timestamp_ms = None
                timestamp_source = "unavailable"
            rows.append(
                {
                    "video_id": video_id,
                    "original_frame_id": decoded_frame_index,
                    "decoded_frame_index": decoded_frame_index,
                    "pts": pts,
                    "time_base_num": time_base_num,
                    "time_base_den": time_base_den,
                    "fps_num": fps_num,
                    "fps_den": fps_den,
                    "raw_pts_timestamp_ms": raw_pts_timestamp_ms,
                    "pts_origin_ms": pts_origin_ms,
                    "pts_timestamp_ms": pts_timestamp_ms,
                    "cfr_timestamp_ms": cfr_timestamp_ms,
                    "timestamp_ms": timestamp_ms,
                    "timestamp_source": timestamp_source,
                    "is_codec_keyframe": bool(frame.key_frame),
                    "decode_status": "success",
                    "width": int(frame.width),
                    "height": int(frame.height),
                    "timeline_backend": "pyav_sequential_metadata",
                }
            )

    if pts_origin_ms is not None:
        for row in rows:
            row["pts_origin_ms"] = pts_origin_ms
    timeline = pd.DataFrame(rows, columns=CANONICAL_TIMELINE_COLUMNS)
    if not timeline.empty:
        validate_canonical_timeline(timeline)
    write_parquet_atomic(timeline, output_path)
    return timeline


def _ffprobe_executable() -> str:
    executable = shutil.which("ffprobe")
    if executable is None:
        raise FileNotFoundError("ffprobe is required for the fast canonical timeline backend")
    return executable


def _ffprobe_number(record: dict[str, Any], *names: str) -> float | None:
    for name in names:
        value = record.get(name)
        if value is None:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            return number
    return None


def _build_ffprobe_timeline(
    video_row: Mapping[str, Any] | pd.Series,
    output_path: str | Path,
) -> pd.DataFrame:
    """Read decoded frame metadata through ffprobe without converting pixels."""

    video_id = str(_row_value(video_row, "video_id") or "").strip()
    path_value = _row_value(video_row, "path")
    if not video_id or not path_value:
        raise ValueError("video_row requires video_id and local path")
    video_path = Path(str(path_value))
    if not video_path.is_file():
        raise FileNotFoundError(video_path)

    command = [
        _ffprobe_executable(),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=key_frame,width,height,best_effort_timestamp_time,pts_time,pkt_duration_time",
        "-of",
        "json",
        str(video_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=True)
    payload = json.loads(completed.stdout)
    records = payload.get("frames", [])
    fps = _positive_fraction(_row_value(video_row, "fps_str"))
    if fps is None:
        raise ValueError(f"{video_id}: exact fps_str is required for canonical timeline")
    fps_num, fps_den = fps.numerator, fps.denominator
    rows: list[dict[str, Any]] = []
    raw_pts_values = [
        _ffprobe_number(record, "best_effort_timestamp_time", "pts_time")
        for record in records
    ]
    first_raw_pts = next((value for value in raw_pts_values if value is not None), None)
    pts_origin_ms = (
        first_raw_pts * 1000.0
        if first_raw_pts is not None
        else None
    )
    for decoded_frame_index, record in enumerate(records):
        cfr_timestamp_ms = _timestamp_ms(decoded_frame_index * fps_den, fps_num)
        raw_pts_seconds = raw_pts_values[decoded_frame_index]
        raw_pts_timestamp_ms = (
            raw_pts_seconds * 1000.0 if raw_pts_seconds is not None else None
        )
        pts_timestamp_ms = (
            raw_pts_timestamp_ms - (pts_origin_ms or 0.0)
            if raw_pts_timestamp_ms is not None
            else None
        )
        if pts_timestamp_ms is not None and abs(pts_timestamp_ms - cfr_timestamp_ms) > 5.0:
            # An incomplete/offset PTS stream is not allowed to move the
            # identity timeline away from the exact CFR fallback used by the
            # source map. Keep the raw value for diagnosis.
            pts_timestamp_ms = None
        if pts_timestamp_ms is not None:
            timestamp_ms = pts_timestamp_ms
            timestamp_source = "pts"
        else:
            timestamp_ms = cfr_timestamp_ms
            timestamp_source = "cfr_fallback"
        width = int(record.get("width") or _row_value(video_row, "width") or 0)
        height = int(record.get("height") or _row_value(video_row, "height") or 0)
        if width <= 0 or height <= 0:
            raise ValueError(f"{video_id}: ffprobe did not return frame dimensions")
        rows.append(
            {
                "video_id": video_id,
                "original_frame_id": decoded_frame_index,
                "decoded_frame_index": decoded_frame_index,
                "pts": None,
                "time_base_num": None,
                "time_base_den": None,
                "fps_num": fps_num,
                "fps_den": fps_den,
                "raw_pts_timestamp_ms": raw_pts_timestamp_ms,
                "pts_origin_ms": pts_origin_ms,
                "pts_timestamp_ms": pts_timestamp_ms,
                "cfr_timestamp_ms": cfr_timestamp_ms,
                "timestamp_ms": timestamp_ms,
                "timestamp_source": timestamp_source,
                "is_codec_keyframe": bool(int(record.get("key_frame", 0))),
                "decode_status": "success",
                "width": width,
                "height": height,
                "timeline_backend": "ffprobe_frame_metadata",
            }
        )
    timeline = pd.DataFrame(rows, columns=CANONICAL_TIMELINE_COLUMNS)
    if not timeline.empty:
        validate_canonical_timeline(timeline)
    write_parquet_atomic(timeline, output_path)
    return timeline


def load_canonical_timeline(path: str | Path) -> pd.DataFrame:
    timeline = pd.read_parquet(path)
    validate_canonical_timeline(timeline)
    return timeline


__all__ = [
    "CANONICAL_TIMELINE_COLUMNS",
    "build_canonical_timeline",
    "load_canonical_timeline",
    "validate_canonical_timeline",
]
