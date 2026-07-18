"""Canonical half-open temporal hierarchy creation and validation."""

from __future__ import annotations

import hashlib
from bisect import bisect_right
from dataclasses import dataclass
from typing import Iterable

KINDS = ("context_window", "segment", "micro_event", "frame")
PARENT_KIND = {"segment": "context_window", "micro_event": "segment", "frame": "segment"}


@dataclass(frozen=True)
class TemporalNode:
    node_id: str
    video_id: str
    kind: str
    start_ms: int
    end_ms: int
    parent_id: str | None

    def __post_init__(self) -> None:
        if not self.node_id or not self.video_id:
            raise ValueError("node_id and video_id must be non-empty")
        if self.kind not in KINDS:
            raise ValueError(f"unsupported temporal kind: {self.kind}")
        if isinstance(self.start_ms, bool) or not isinstance(self.start_ms, int) or self.start_ms < 0:
            raise ValueError("start_ms must be a non-negative integer")
        if isinstance(self.end_ms, bool) or not isinstance(self.end_ms, int) or self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be an integer greater than start_ms")


def _id(video_id: str, kind: str, start_ms: int, end_ms: int) -> str:
    digest = hashlib.sha256(f"{video_id}\0{kind}\0{start_ms}\0{end_ms}".encode()).hexdigest()[:24]
    return f"{kind}:{digest}"


def _coverage(nodes: list[TemporalNode], start: int, end: int, label: str) -> None:
    cursor = start
    for node in sorted(nodes, key=lambda item: (item.start_ms, item.end_ms, item.node_id)):
        if node.start_ms > cursor:
            raise ValueError(f"{label} coverage gap at {cursor}")
        if node.start_ms < cursor:
            raise ValueError(f"{label} overlap at {node.start_ms}")
        cursor = node.end_ms
    if cursor < end:
        raise ValueError(f"{label} coverage gap at {cursor}")
    if cursor > end:
        raise ValueError(f"{label} exceeds expected duration")


def validate_hierarchy(nodes: Iterable[TemporalNode], *, expected_duration_ms: int) -> None:
    items = tuple(nodes)
    if not items:
        raise ValueError("hierarchy must not be empty")
    if not isinstance(expected_duration_ms, int) or expected_duration_ms <= 0:
        raise ValueError("expected_duration_ms must be positive")
    by_id = {node.node_id: node for node in items}
    if len(by_id) != len(items):
        raise ValueError("duplicate temporal node_id")
    videos = {node.video_id for node in items}
    if len(videos) != 1:
        raise ValueError("hierarchy contains multiple videos")
    contexts = [node for node in items if node.kind == "context_window"]
    segments = [node for node in items if node.kind == "segment"]
    _coverage(contexts, 0, expected_duration_ms, "context_window")
    _coverage(segments, 0, expected_duration_ms, "segment")
    for node in items:
        if node.kind == "context_window":
            if node.parent_id is not None:
                raise ValueError("context_window cannot have a parent")
        else:
            parent = by_id.get(node.parent_id or "")
            if parent is None or parent.kind != PARENT_KIND[node.kind]:
                raise ValueError(f"node {node.node_id} has wrong parent")
            if node.video_id != parent.video_id or node.start_ms < parent.start_ms or node.end_ms > parent.end_ms:
                raise ValueError(f"node {node.node_id} is not contained by parent")
        if node.end_ms > expected_duration_ms:
            raise ValueError(f"node {node.node_id} is outside expected duration")
    for segment in segments:
        micros = [node for node in items if node.kind == "micro_event" and node.parent_id == segment.node_id]
        if micros:
            _coverage(micros, segment.start_ms, segment.end_ms, f"micro_event for {segment.node_id}")


def build_temporal_hierarchy(
    video_id: str,
    *,
    duration_ms: int,
    frame_pts_ms: Iterable[int],
    segment_boundaries_ms: Iterable[int],
    micro_event_ms: int = 2_000,
    context_window_ms: int = 15_000,
) -> tuple[TemporalNode, ...]:
    if not video_id:
        raise ValueError("video_id must be non-empty")
    if not isinstance(duration_ms, int) or duration_ms <= 0:
        raise ValueError("duration_ms must be positive")
    if micro_event_ms <= 0 or context_window_ms <= 0:
        raise ValueError("window sizes must be positive")
    boundaries = tuple(segment_boundaries_ms)
    if not boundaries or boundaries[0] != 0 or boundaries[-1] != duration_ms:
        raise ValueError("segment boundaries must start at 0 and end at duration_ms")
    if any(not isinstance(value, int) for value in boundaries) or any(a >= b for a, b in zip(boundaries, boundaries[1:])):
        raise ValueError("segment boundaries must be strictly increasing integer milliseconds")
    intervals = list(zip(boundaries, boundaries[1:]))
    context_ranges: list[tuple[int, int]] = []
    group_start = intervals[0][0]
    group_end = intervals[0][1]
    for start, end in intervals[1:]:
        if end - group_start <= context_window_ms:
            group_end = end
        else:
            context_ranges.append((group_start, group_end))
            group_start, group_end = start, end
    context_ranges.append((group_start, group_end))
    contexts = [TemporalNode(_id(video_id, "context_window", start, end), video_id, "context_window", start, end, None) for start, end in context_ranges]
    segments: list[TemporalNode] = []
    micros: list[TemporalNode] = []
    for start, end in intervals:
        context = next(item for item in contexts if item.start_ms <= start and end <= item.end_ms)
        segment = TemporalNode(_id(video_id, "segment", start, end), video_id, "segment", start, end, context.node_id)
        segments.append(segment)
        cursor = start
        while cursor < end:
            micro_end = min(end, cursor + micro_event_ms)
            micros.append(TemporalNode(_id(video_id, "micro_event", cursor, micro_end), video_id, "micro_event", cursor, micro_end, segment.node_id))
            cursor = micro_end
    points = tuple(frame_pts_ms)
    if len(set(points)) != len(points) or any(not isinstance(point, int) or point < 0 or point >= duration_ms for point in points):
        raise ValueError("frame PTS values must be unique integer milliseconds within duration")
    ordered_points = sorted(points)
    frames: list[TemporalNode] = []
    for index, point in enumerate(ordered_points):
        segment_index = bisect_right(boundaries, point) - 1
        segment = segments[segment_index]
        next_point = ordered_points[index + 1] if index + 1 < len(ordered_points) else duration_ms
        end = min(segment.end_ms, max(point + 1, next_point))
        frames.append(TemporalNode(_id(video_id, "frame", point, end), video_id, "frame", point, end, segment.node_id))
    result = tuple(contexts + segments + micros + frames)
    validate_hierarchy(result, expected_duration_ms=duration_ms)
    return result
