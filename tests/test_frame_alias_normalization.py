from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from pipelines.preprocessing.keyframes import build_frame_aliases as aliases


def _manifest() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "video_id": "L21_V006",
                "keyframe_no": 1,
                "source_frame_idx": 0,
                "original_frame_id_candidate": None,
                "pts_time": 0.0,
                "timestamp_ms_candidate": 0,
                "fps": 30.0,
                "source_map_file": "L21_V006.csv",
                "source_row_index": 0,
            },
            {
                "video_id": "L21_V006",
                "keyframe_no": 2,
                "source_frame_idx": 0,
                "original_frame_id_candidate": None,
                "pts_time": 0.033,
                "timestamp_ms_candidate": 33,
                "fps": 30.0,
                "source_map_file": "L21_V006.csv",
                "source_row_index": 1,
            },
            {
                "video_id": "L21_V006",
                "keyframe_no": 3,
                "source_frame_idx": 120,
                "original_frame_id_candidate": 120,
                "pts_time": 4.0,
                "timestamp_ms_candidate": 4000,
                "fps": 30.0,
                "source_map_file": "L21_V006.csv",
                "source_row_index": 2,
            },
        ]
    )


def _write_images(root: Path) -> None:
    directory = root / "L21_V006"
    directory.mkdir(parents=True)
    for number in (1, 2, 3):
        (directory / f"{number:03d}.jpg").write_bytes(b"image")


def test_duplicate_occurrences_share_canonical_candidate_but_keep_alias_keys(
    tmp_path: Path,
) -> None:
    _write_images(tmp_path)
    occurrence_rows, canonical_rows, stats = aliases.build_alias_artifacts(
        _manifest(),
        keyframe_root=tmp_path,
    )

    assert len(occurrence_rows) == 3
    assert len(canonical_rows) == 2
    duplicate = occurrence_rows[occurrence_rows["keyframe_no"].isin([1, 2])]
    assert duplicate["original_frame_id"].tolist() == [0, 0]
    assert duplicate["storage_uri"].tolist() == [
        "r2://aic/keyframes/L21_V006/001.jpg",
        "r2://aic/keyframes/L21_V006/002.jpg",
    ]
    assert canonical_rows.loc[
        canonical_rows["original_frame_id"] == 0, "keyframe_no"
    ].item() == 1
    assert stats["duplicate_extra_occurrence_count"] == 1

    metadata = json.loads(duplicate.iloc[1]["metadata"])
    assert metadata["duplicate_group_size"] == 2
    assert metadata["duplicate_occurrence_ordinal"] == 2


def test_alias_artifact_validation_rejects_duplicate_occurrence_identity() -> None:
    rows = pd.DataFrame(
        [
            {
                "video_id": "v",
                "keyframe_no": 1,
                "original_frame_id": 0,
                "timestamp_ms": 0,
                "thumbnail_object_key": "keyframes/v/001.jpg",
                "storage_uri": "r2://aic/keyframes/v/001.jpg",
                "metadata": "{}",
            },
            {
                "video_id": "v",
                "keyframe_no": 1,
                "original_frame_id": 0,
                "timestamp_ms": 0,
                "thumbnail_object_key": "keyframes/v/002.jpg",
                "storage_uri": "r2://aic/keyframes/v/002.jpg",
                "metadata": "{}",
            },
        ]
    )
    with pytest.raises(ValueError, match="video_id, keyframe_no"):
        aliases.validate_alias_artifact(rows)


def test_missing_keyframe_image_is_a_hard_error(tmp_path: Path) -> None:
    _write_images(tmp_path)
    (tmp_path / "L21_V006" / "002.jpg").unlink()
    with pytest.raises(FileNotFoundError, match="L21_V006/002"):
        aliases.build_alias_artifacts(_manifest(), keyframe_root=tmp_path)


def test_report_removes_only_duplicate_blocker(tmp_path: Path) -> None:
    report_path = tmp_path / "normalization_report.json"
    report_path.write_text(
        json.dumps(
            {
                "status": "staging_not_import_ready",
                "blockers": [
                    "192 keyframe map files contain duplicate source frame_idx values",
                    "embedding parquet original_frame_id values are row ordinals rather than canonical source frame IDs",
                    "R2 object URIs are not available for videos/keyframes/vector artifacts",
                ],
                "output_files": [],
            }
        ),
        encoding="utf-8",
    )

    report = aliases.update_normalization_report(
        report_path,
        {
            "video_count": 1,
            "source_row_count": 3,
            "alias_row_count": 3,
            "canonical_candidate_count": 2,
            "duplicate_source_frame_idx_group_count": 1,
            "duplicate_source_frame_idx_row_count": 2,
            "duplicate_extra_occurrence_count": 1,
            "source_map_file_count": 1,
        },
        aliases_path=tmp_path / "frame_aliases.parquet",
        canonical_path=tmp_path / "canonical_frame_candidates.parquet",
    )

    assert not any("duplicate source frame_idx" in blocker for blocker in report["blockers"])
    assert any("embedding parquet" in blocker for blocker in report["blockers"])
    assert "R2 object URIs are not available for vector artifacts" in report["blockers"]
    assert report["frame_aliases"]["ready_for_db"] is False
