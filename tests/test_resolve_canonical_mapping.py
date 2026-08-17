from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from pipelines.preprocessing.keyframes import resolve_canonical_mapping as resolver


def _canonical_frames() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "video_id": ["v", "v", "v"],
            "original_frame_id": [0, 1, 2],
            "decoded_frame_index": [0, 1, 2],
            "timestamp_ms": [0.0, 40.0, 80.0],
            "timestamp_source": ["pts", "pts", "pts"],
        }
    )


def _keyframes() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "video_id": ["v", "v", "v"],
            "keyframe_no": [1, 2, 3],
            "source_frame_idx": [1, 1, 2],
            "original_frame_id_candidate": [None, None, 2],
            "timestamp_ms_candidate": [33, 67, 80],
            "frame_id_status": [
                "candidate_source_frame_idx_needs_canonical_validation",
                "duplicate_source_frame_idx",
                "candidate_source_frame_idx_needs_canonical_validation",
            ],
            "ready_for_db": [False, False, False],
        }
    )


def test_resolve_mapping_preserves_duplicate_occurrences() -> None:
    resolved = resolver.resolve_keyframe_mapping(_keyframes(), _canonical_frames())

    assert resolved["original_frame_id_candidate"].tolist() == [1, 1, 2]
    assert resolved["timestamp_ms_candidate"].tolist() == [40, 40, 80]
    assert resolved["source_timestamp_ms_candidate"].tolist() == [33, 67, 80]
    assert resolved["frame_id_status"].tolist() == [
        resolver.RESOLVED_STATUS,
        resolver.RESOLVED_STATUS,
        resolver.RESOLVED_STATUS,
    ]
    assert resolved["ready_for_db"].tolist() == [True, True, True]


def test_resolve_mapping_rejects_source_index_outside_timeline() -> None:
    keyframes = _keyframes()
    keyframes.loc[2, "source_frame_idx"] = 3
    with pytest.raises(ValueError, match="outside canonical timeline"):
        resolver.resolve_keyframe_mapping(keyframes, _canonical_frames())


def test_load_source_frame_map_accepts_json_and_normalizes_identity(tmp_path: Path) -> None:
    map_root = tmp_path / "map-keyframes"
    map_root.mkdir()
    (map_root / "v.json").write_text(
        '{"keyframes": [{"n": 1, "pts_time": 0.0, "fps": 25.0, "frame_idx": 0}, '
        '{"n": 2, "pts_time": 1.24, "fps": 25.0, "frame_idx": 31}]}',
        encoding="utf-8",
    )

    loaded = resolver.load_source_frame_map(map_root, expected_video_ids={"v"})

    assert loaded[["video_id", "keyframe_no", "source_frame_idx"]].to_dict("records") == [
        {"video_id": "v", "keyframe_no": 1, "source_frame_idx": 0},
        {"video_id": "v", "keyframe_no": 2, "source_frame_idx": 31},
    ]
    assert loaded["timestamp_ms"].tolist() == [0, 1240]


def test_resolve_mapping_from_source_map_marks_sparse_ids_verified(tmp_path: Path) -> None:
    map_root = tmp_path / "map-keyframes"
    map_root.mkdir()
    pd.DataFrame(
        {
            "n": [1, 2, 3],
            "pts_time": [0.0, 1.0, 1.0],
            "fps": [25.0, 25.0, 25.0],
            "frame_idx": [1, 1, 2],
        }
    ).to_csv(map_root / "v.csv", index=False)

    keyframes = pd.DataFrame(
        {
            "video_id": ["v", "v", "v"],
            "keyframe_no": [1, 2, 3],
            "source_frame_idx": [1, 1, 2],
            "timestamp_ms_candidate": [0, 1000, 1000],
            "frame_id_status": ["candidate"] * 3,
            "ready_for_db": [False] * 3,
        }
    )
    source_map = resolver.load_source_frame_map(map_root, expected_video_ids={"v"})

    resolved = resolver.resolve_keyframe_mapping_from_source_map(keyframes, source_map)

    assert resolved["original_frame_id_candidate"].tolist() == [1, 1, 2]
    assert resolved["canonical_timestamp_ms"].tolist() == [0, 1000, 1000]
    assert resolved["frame_id_status"].tolist() == [resolver.RESOLVED_STATUS] * 3
    assert resolved["ready_for_db"].tolist() == [True] * 3
    assert resolved["canonical_timestamp_source"].tolist() == ["map-keyframes"] * 3


def test_resolve_mapping_from_source_map_rejects_conflicting_source_id(tmp_path: Path) -> None:
    map_root = tmp_path / "map-keyframes"
    map_root.mkdir()
    pd.DataFrame(
        {"n": [1], "pts_time": [0.0], "fps": [25.0], "frame_idx": [7]}
    ).to_csv(map_root / "v.csv", index=False)
    source_map = resolver.load_source_frame_map(map_root, expected_video_ids={"v"})
    keyframes = pd.DataFrame(
        {
            "video_id": ["v"],
            "keyframe_no": [1],
            "source_frame_idx": [8],
            "timestamp_ms_candidate": [0],
        }
    )

    with pytest.raises(ValueError, match="conflicts with source map"):
        resolver.resolve_keyframe_mapping_from_source_map(keyframes, source_map)


def test_apply_mapping_handles_artifact_without_existing_status_column() -> None:
    resolved = pd.DataFrame(
        {
            "video_id": ["v"],
            "keyframe_no": [1],
            "original_frame_id_candidate": [7],
            "timestamp_ms_candidate": [280],
            "canonical_timestamp_ms": [280],
            "frame_id_status": [resolver.RESOLVED_STATUS],
        }
    )
    artifact = pd.DataFrame(
        {
            "video_id": ["v"],
            "keyframe_no_candidate": [1],
            "original_frame_id_candidate": [0],
        }
    )

    updated = resolver._apply_mapping_to_artifact(
        artifact,
        resolver._mapping_table(resolved),
        keyframe_column="keyframe_no_candidate",
        ready_for_db=True,
    )

    assert updated.loc[0, "original_frame_id_candidate"] == 7
    assert updated.loc[0, "frame_id_status"] == resolver.RESOLVED_STATUS
    assert bool(updated.loc[0, "ready_for_db"]) is True


def test_build_local_video_manifest_requires_exact_local_files(tmp_path: Path) -> None:
    (tmp_path / "v.mp4").write_bytes(b"video")
    videos = pd.DataFrame(
        {
            "video_id": ["v"],
            "original_filename": ["v.mp4"],
            "fps_str": ["25/1"],
            "fps": [25.0],
            "duration_s": [1.0],
        }
    )

    local = resolver.build_local_video_manifest(videos, tmp_path)

    assert local.to_dict("records") == [
        {
            "video_id": "v",
            "path": str(tmp_path / "v.mp4"),
            "fps_str": "25/1",
            "fps": 25.0,
            "duration_s": 1.0,
        }
    ]
