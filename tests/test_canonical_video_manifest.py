from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from pipelines.preprocessing.video_ingestion import build_canonical_manifest as manifest


def _probe() -> dict[str, object]:
    return {
        "duration_ms": 1000,
        "fps_str": "30000/1001",
        "fps": 29.97002997,
        "width": 1280,
        "height": 720,
        "duration_s": 1.0,
        "codec": "h264",
        "n_frames_est": 30,
        "etag": None,
        "version_id": None,
    }


def test_r2_identity_is_credential_free_and_stable() -> None:
    assert manifest.r2_identity("L21_V001.mp4") == (
        "videos/L21_V001.mp4",
        "r2://aic/videos/L21_V001.mp4",
    )


def test_build_row_preserves_exact_fps_and_nullable_frame_count(tmp_path: Path) -> None:
    video = tmp_path / "L21_V001.mp4"
    video.write_bytes(b"video")
    row = manifest.build_manifest_row(video, _probe())
    assert row["video_id"] == "L21_V001"
    assert row["object_key"] == "videos/L21_V001.mp4"
    assert row["storage_uri"] == "r2://aic/videos/L21_V001.mp4"
    assert row["fps_str"] == "30000/1001"
    assert row["frame_count"] is None


def test_validate_video_ids_rejects_wrong_object_identity(tmp_path: Path) -> None:
    video = tmp_path / "L21_V001.mp4"
    video.write_bytes(b"video")
    row = manifest.build_manifest_row(video, _probe())
    row["object_key"] = "keyframes/L21_V001.mp4"
    with pytest.raises(ValueError, match="object_key"):
        manifest.validate_video_ids(
            pd.DataFrame([row], columns=manifest.CANONICAL_COLUMNS),
            expected_ids={"L21_V001"},
        )


def test_validate_video_ids_requires_exact_expected_set(tmp_path: Path) -> None:
    video = tmp_path / "L21_V001.mp4"
    video.write_bytes(b"video")
    row = manifest.build_manifest_row(video, _probe())
    with pytest.raises(ValueError, match="video_id lệch expected"):
        manifest.validate_video_ids(
            pd.DataFrame([row], columns=manifest.CANONICAL_COLUMNS),
            expected_ids={"L21_V001", "L21_V002"},
        )
