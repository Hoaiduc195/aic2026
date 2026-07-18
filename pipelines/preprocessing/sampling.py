"""Coverage-preserving frame selection."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable

from pipelines.preprocessing.temporal import TemporalNode


@dataclass(frozen=True)
class FrameCandidate:
    frame_id: str
    video_id: str
    pts_ms: int
    motion_score: float = 0.0

    def __post_init__(self) -> None:
        if not self.frame_id or not self.video_id or not isinstance(self.pts_ms, int) or self.pts_ms < 0:
            raise ValueError("invalid frame candidate identity or timestamp")
        if not isinstance(self.motion_score, (int, float)) or not math.isfinite(self.motion_score) or self.motion_score < 0:
            raise ValueError("motion_score must be finite and non-negative")


@dataclass(frozen=True)
class SelectedFrame:
    frame_id: str
    video_id: str
    segment_id: str
    pts_ms: int
    motion_score: float


def coverage_safe_sample(
    segments: Iterable[TemporalNode],
    frames: Iterable[FrameCandidate],
    *,
    max_per_segment: int = 3,
) -> tuple[SelectedFrame, ...]:
    if not isinstance(max_per_segment, int) or max_per_segment < 1:
        raise ValueError("max_per_segment must be positive")
    frame_items = tuple(frames)
    if len({item.frame_id for item in frame_items}) != len(frame_items):
        raise ValueError("duplicate frame_id")
    selected: list[SelectedFrame] = []
    for segment in sorted(segments, key=lambda item: (item.start_ms, item.node_id)):
        if segment.kind != "segment":
            raise ValueError("coverage_safe_sample accepts segment nodes only")
        available = [item for item in frame_items if item.video_id == segment.video_id and segment.start_ms <= item.pts_ms < segment.end_ms]
        if not available:
            raise ValueError(f"segment {segment.node_id} has no candidate frame")
        midpoint = (segment.start_ms + segment.end_ms) / 2
        ranked = sorted(available, key=lambda item: (-item.motion_score, abs(item.pts_ms - midpoint), item.pts_ms, item.frame_id))
        for item in ranked[:max_per_segment]:
            selected.append(SelectedFrame(item.frame_id, item.video_id, segment.node_id, item.pts_ms, item.motion_score))
    return tuple(sorted(selected, key=lambda item: (item.pts_ms, item.frame_id)))
