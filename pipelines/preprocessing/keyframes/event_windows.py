"""Build coarse event windows from sparse retrieval hits.

Stage 1 returns source-aligned retrieval frames. This module expands and merges
those hits into half-open frame intervals for Stage 2 dense decoding.
"""

from dataclasses import asdict, dataclass
from math import isfinite
from pathlib import Path

import pandas as pd

from ..io_utils import write_parquet_atomic


@dataclass(frozen=True)
class EventWindow:
    event_window_id: str
    video_id: str
    start_frame_id: int
    end_frame_id: int
    start_ms: float
    end_ms: float
    source: str
    retrieval_score: float | None
    member_frame_ids: tuple[int, ...]
    peak_frame_id: int | None = None

    def __post_init__(self) -> None:
        if self.start_frame_id < 0 or self.end_frame_id <= self.start_frame_id:
            raise ValueError("event window must be a non-empty half-open frame interval")
        if (
            not isfinite(self.start_ms)
            or not isfinite(self.end_ms)
            or self.start_ms < 0
            or self.end_ms < self.start_ms
        ):
            raise ValueError("event window timestamps are invalid")
        if self.retrieval_score is not None and not isfinite(self.retrieval_score):
            raise ValueError("retrieval_score must be finite when present")
        if self.peak_frame_id is not None and self.peak_frame_id not in self.member_frame_ids:
            raise ValueError("peak_frame_id must be one of member_frame_ids")

    def to_dict(self) -> dict:
        row = asdict(self)
        row["member_frame_ids"] = list(self.member_frame_ids)
        return row


def _load_table(value: pd.DataFrame | str | Path) -> pd.DataFrame:
    if isinstance(value, pd.DataFrame):
        return value.copy()
    path = Path(value)
    return pd.read_parquet(path) if path.suffix.lower() == ".parquet" else pd.read_csv(path)


def _validate_inputs(hits: pd.DataFrame, frames: pd.DataFrame) -> None:
    hit_columns = {"video_id", "original_frame_id"}
    frame_columns = {"video_id", "original_frame_id", "timestamp_ms"}
    if missing := hit_columns - set(hits.columns):
        raise ValueError(f"retrieval hits missing columns: {sorted(missing)}")
    if hits.empty:
        return
    if missing := frame_columns - set(frames.columns):
        raise ValueError(f"frame manifest missing columns: {sorted(missing)}")
    if frames.duplicated(["video_id", "original_frame_id"]).any():
        raise ValueError("frame manifest contains duplicate source-frame identities")
    if frames["timestamp_ms"].isna().any():
        raise ValueError("frame manifest contains unavailable timestamp_ms values")


def build_event_windows(
    retrieval_hits: pd.DataFrame | str | Path,
    frame_manifest: pd.DataFrame | str | Path,
    *,
    radius_ms: float = 2_000.0,
    merge_gap_ms: float = 500.0,
    max_windows_per_video: int | None = None,
    namespace: str | None = None,
) -> list[EventWindow]:
    """Expand sparse hits into merged, half-open dense-decode intervals.

    ``radius_ms`` expands on both sides. Windows overlap or separated by at
    most ``merge_gap_ms`` are merged. Frame IDs always come from the canonical
    manifest; timestamps are never converted back to frame IDs by rounding.
    """
    if not isfinite(radius_ms) or not isfinite(merge_gap_ms) or radius_ms < 0 or merge_gap_ms < 0:
        raise ValueError("radius_ms and merge_gap_ms must be finite and non-negative")
    if max_windows_per_video is not None and max_windows_per_video <= 0:
        raise ValueError("max_windows_per_video must be positive")

    hits = _load_table(retrieval_hits)
    frames = _load_table(frame_manifest)
    _validate_inputs(hits, frames)
    if hits.empty:
        return []

    score_column = "score" if "score" in hits.columns else None
    provisional: list[dict] = []
    for video_id, video_hits in hits.groupby("video_id", sort=True):
        video_frames = frames[frames["video_id"] == video_id].sort_values("original_frame_id")
        if video_frames.empty:
            raise ValueError(f"frame manifest has no rows for video_id={video_id}")
        timestamps = video_frames.set_index("original_frame_id")["timestamp_ms"]
        for hit in video_hits.itertuples(index=False):
            frame_id = int(hit.original_frame_id)
            if frame_id not in timestamps.index:
                raise ValueError(f"retrieval hit references unknown frame {video_id}:{frame_id}")
            hit_ms = float(timestamps.loc[frame_id])
            lower_ms = max(0.0, hit_ms - radius_ms)
            upper_ms = hit_ms + radius_ms
            inside = video_frames[
                (video_frames["timestamp_ms"] >= lower_ms)
                & (video_frames["timestamp_ms"] <= upper_ms)
            ]
            if inside.empty:
                inside = video_frames[video_frames["original_frame_id"] == frame_id]
            start_frame = int(inside["original_frame_id"].iloc[0])
            end_frame = int(inside["original_frame_id"].iloc[-1]) + 1
            end_row = video_frames[video_frames["original_frame_id"] == end_frame]
            if not end_row.empty:
                end_ms = float(end_row["timestamp_ms"].iloc[0])
            elif len(video_frames) >= 2:
                last_two = video_frames["timestamp_ms"].astype(float).iloc[-2:]
                end_ms = float(last_two.iloc[-1] + max(last_two.iloc[-1] - last_two.iloc[-2], 0.0))
            else:
                end_ms = float(inside["timestamp_ms"].iloc[-1])
            retrieval_score = (
                float(getattr(hit, score_column)) if score_column is not None else None
            )
            if retrieval_score is not None and not isfinite(retrieval_score):
                raise ValueError("retrieval hit score must be finite")
            provisional.append({
                "video_id": str(video_id),
                "start_frame_id": start_frame,
                "end_frame_id": end_frame,
                "start_ms": float(inside["timestamp_ms"].iloc[0]),
                "end_ms": end_ms,
                "member_frame_ids": {frame_id},
                "retrieval_score": retrieval_score,
                "peak_frame_id": frame_id,
            })

    merged: list[dict] = []
    for window in sorted(provisional, key=lambda item: (item["video_id"], item["start_ms"])):
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and previous["video_id"] == window["video_id"]
            and window["start_ms"] <= previous["end_ms"] + merge_gap_ms
        ):
            previous["start_frame_id"] = min(previous["start_frame_id"], window["start_frame_id"])
            previous["end_frame_id"] = max(previous["end_frame_id"], window["end_frame_id"])
            previous["start_ms"] = min(previous["start_ms"], window["start_ms"])
            previous["end_ms"] = max(previous["end_ms"], window["end_ms"])
            previous["member_frame_ids"].update(window["member_frame_ids"])
            scores = [
                score for score in (previous["retrieval_score"], window["retrieval_score"])
                if score is not None
            ]
            previous_score = previous["retrieval_score"]
            window_score = window["retrieval_score"]
            if window_score is not None and (
                previous_score is None or window_score > previous_score
            ):
                previous["peak_frame_id"] = window["peak_frame_id"]
            previous["retrieval_score"] = max(scores) if scores else None
        else:
            merged.append(window)

    if max_windows_per_video is not None:
        selected_rows: list[dict] = []
        for _video_id, video_rows in pd.DataFrame(merged).groupby("video_id", sort=True):
            ranked = sorted(
                video_rows.to_dict("records"),
                key=lambda row: (
                    -(row["retrieval_score"] if row["retrieval_score"] is not None else float("-inf")),
                    row["start_frame_id"],
                ),
            )[:max_windows_per_video]
            selected_rows.extend(ranked)
        merged = sorted(selected_rows, key=lambda row: (row["video_id"], row["start_frame_id"]))

    windows: list[EventWindow] = []
    per_video_counts: dict[str, int] = {}
    for row in merged:
        video_id = row["video_id"]
        ordinal = per_video_counts.get(video_id, 0)
        per_video_counts[video_id] = ordinal + 1
        prefix = f"{namespace}_" if namespace else ""
        windows.append(EventWindow(
            event_window_id=f"{prefix}{video_id}_event_{ordinal:04d}",
            video_id=video_id,
            start_frame_id=row["start_frame_id"],
            end_frame_id=row["end_frame_id"],
            start_ms=row["start_ms"],
            end_ms=row["end_ms"],
            source="retrieval_hits",
            retrieval_score=row["retrieval_score"],
            member_frame_ids=tuple(sorted(row["member_frame_ids"])),
            peak_frame_id=row["peak_frame_id"],
        ))
    return windows


def write_event_windows(windows: list[EventWindow], output_path: str | Path) -> Path:
    path = Path(output_path)
    columns = [field.name for field in EventWindow.__dataclass_fields__.values()]
    rows = [window.to_dict() for window in windows]
    write_parquet_atomic(pd.DataFrame(rows, columns=columns), path)
    return path
