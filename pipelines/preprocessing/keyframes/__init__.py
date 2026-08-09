"""Two-stage source-aligned keyframe preprocessing.

Sparse retrieval and dense temporal alignment share the canonical frame
manifest, while dense frames deliberately bypass retrieval quality deletion
and deduplication.
"""

from .dense import DenseFrame, decode_window, select_semantic_keyframe
from .event_windows import EventWindow, build_event_windows
from .frame_manifest import build_frame_manifest, load_frame_manifest
from .mapping import exact_timestamp_ms, frame_id_from_timestamp_ms, parse_fps
from .structural import (
    DinoV2Embedder,
    global_structural_dedup,
    select_cosine_cluster_medoids,
)

__all__ = [
    "DenseFrame",
    "DinoV2Embedder",
    "EventWindow",
    "build_event_windows",
    "build_frame_manifest",
    "decode_window",
    "exact_timestamp_ms",
    "frame_id_from_timestamp_ms",
    "global_structural_dedup",
    "load_frame_manifest",
    "parse_fps",
    "select_semantic_keyframe",
    "select_cosine_cluster_medoids",
]
