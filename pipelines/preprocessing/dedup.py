"""Deterministic, OCR-aware perceptual duplicate clustering."""

from __future__ import annotations

import hashlib
import math
import unicodedata
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class DedupCandidate:
    frame_id: str
    video_id: str
    pts_ms: int
    perceptual_hash: int
    ocr_text: str
    quality_score: float

    def __post_init__(self) -> None:
        if not self.frame_id or not self.video_id or not isinstance(self.pts_ms, int) or self.pts_ms < 0:
            raise ValueError("invalid dedup candidate identity or timestamp")
        if isinstance(self.perceptual_hash, bool) or not isinstance(self.perceptual_hash, int) or self.perceptual_hash < 0:
            raise ValueError("perceptual_hash must be a non-negative integer")
        if not isinstance(self.ocr_text, str):
            raise ValueError("ocr_text must be a string")
        if not isinstance(self.quality_score, (int, float)) or not math.isfinite(self.quality_score) or not 0 <= self.quality_score <= 1:
            raise ValueError("quality_score must be between 0 and 1")


@dataclass(frozen=True)
class DuplicateCluster:
    cluster_id: str
    representative_id: str
    members: tuple[str, ...]


def _normalize_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def cluster_duplicates(candidates: Iterable[DedupCandidate], *, max_hamming_distance: int = 4) -> tuple[DuplicateCluster, ...]:
    if not isinstance(max_hamming_distance, int) or max_hamming_distance < 0:
        raise ValueError("max_hamming_distance must be non-negative")
    items = tuple(sorted(candidates, key=lambda item: (item.video_id, item.pts_ms, item.frame_id)))
    if len({item.frame_id for item in items}) != len(items):
        raise ValueError("duplicate frame_id")
    parent = list(range(len(items)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[max(left_root, right_root)] = min(left_root, right_root)

    for left in range(len(items)):
        for right in range(left + 1, len(items)):
            if items[left].video_id != items[right].video_id:
                continue
            if _normalize_text(items[left].ocr_text) != _normalize_text(items[right].ocr_text):
                continue
            if (items[left].perceptual_hash ^ items[right].perceptual_hash).bit_count() <= max_hamming_distance:
                union(left, right)
    groups: dict[int, list[DedupCandidate]] = {}
    for index, item in enumerate(items):
        groups.setdefault(find(index), []).append(item)
    clusters: list[DuplicateCluster] = []
    for members in groups.values():
        member_ids = tuple(sorted(item.frame_id for item in members))
        representative = min(members, key=lambda item: (-item.quality_score, item.pts_ms, item.frame_id))
        cluster_id = "cluster:" + hashlib.sha256("\0".join(member_ids).encode()).hexdigest()[:24]
        clusters.append(DuplicateCluster(cluster_id, representative.frame_id, member_ids))
    return tuple(sorted(clusters, key=lambda item: item.members))
