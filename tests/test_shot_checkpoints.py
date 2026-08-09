import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd
import numpy as np

from pipelines.preprocessing.shot_detection.shots import (
    detect_shots,
    _scenes_from_predictions,
    _shot_checkpoint_table_valid,
    run_pass_a,
)


class _Store:
    def __init__(self, root: Path):
        self.root = root
        (root / "shots").mkdir(parents=True)
        self.failures = []

    def shots_path(self, video_id: str) -> Path:
        return self.root / "shots" / f"{video_id}.parquet"

    def log_failed(self, video_id: str, error: str) -> None:
        self.failures.append((video_id, error))


def _config(root: Path):
    return SimpleNamespace(
        sbd_weights=str(root / "missing-weights.pth"),
        sbd_threshold=0.3,
        sbd_min_shot_frames=8,
        device="cpu",
    )


def _row(video_id: str, path: Path, *, frame_count: int = 10, estimate: int = 99):
    return {
        "video_id": video_id,
        "path": str(path),
        "frame_count": frame_count,
        "n_frames_est": estimate,
        "duration_s": 1.0,
    }


def _two_shots(video_id: str) -> pd.DataFrame:
    return pd.DataFrame([
        {
            "video_id": video_id,
            "shot_id": 0,
            "start_frame": 0,
            "end_frame": 4,
            "start_time": 0.0,
            "end_time": 0.4,
            "method": "transnetv2",
        },
        {
            "video_id": video_id,
            "shot_id": 1,
            "start_frame": 5,
            "end_frame": 9,
            "start_time": 0.5,
            "end_time": 0.9,
            "method": "transnetv2",
        },
    ])


class ShotCheckpointTest(unittest.TestCase):
    def test_transition_runs_still_partition_the_complete_timeline(self):
        predictions = np.array([0.0, 0.0, 0.9, 0.8, 0.0, 0.0, 0.95])
        scenes = _scenes_from_predictions(predictions, 0.5)
        self.assertEqual(scenes[0][0], 0)
        self.assertEqual(scenes[-1][1], len(predictions) - 1)
        flattened = [
            frame_id
            for start, end in scenes
            for frame_id in range(start, end + 1)
        ]
        self.assertEqual(flattened, list(range(len(predictions))))

    def test_checkpoint_validator_rejects_identity_and_bound_corruption(self):
        valid = _two_shots("video")
        valid["sbd_elapsed_s"] = 0.1
        valid["stage_fingerprint"] = "fingerprint"
        valid["checkpoint_shot_count"] = 2
        valid["checkpoint_frame_count"] = 10
        self.assertTrue(
            _shot_checkpoint_table_valid(
                valid,
                video_id="video",
                fingerprint="fingerprint",
                frame_count=10,
            )
        )

        corruptions = []
        wrong_fingerprint = valid.copy()
        wrong_fingerprint.loc[1, "stage_fingerprint"] = "wrong"
        corruptions.append(wrong_fingerprint)
        wrong_video = valid.copy()
        wrong_video.loc[1, "video_id"] = "other"
        corruptions.append(wrong_video)
        non_finite = valid.copy()
        non_finite.loc[1, "end_time"] = float("inf")
        corruptions.append(non_finite)
        out_of_bounds = valid.copy()
        out_of_bounds.loc[1, "end_frame"] = 10
        corruptions.append(out_of_bounds)
        incomplete_coverage = valid.copy()
        incomplete_coverage.loc[1, "end_frame"] = 8
        corruptions.append(incomplete_coverage)
        timeline_gap = valid.copy()
        timeline_gap.loc[1, "start_frame"] = 6
        corruptions.append(timeline_gap)
        broken_ids = valid.copy()
        broken_ids.loc[1, "shot_id"] = 7
        corruptions.append(broken_ids)

        for corrupted in corruptions:
            with self.subTest(columns=corrupted.to_dict("list")):
                self.assertFalse(
                    _shot_checkpoint_table_valid(
                        corrupted,
                        video_id="video",
                        fingerprint="fingerprint",
                        frame_count=10,
                    )
                )

    def test_fallback_prefers_exact_frame_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "video.mp4"
            source.write_bytes(b"source identity")
            store = _Store(root / "outputs")
            manifest = pd.DataFrame([_row("video", source, frame_count=4, estimate=99)])

            with patch(
                "pipelines.preprocessing.shot_detection.shots.load_transnet",
                return_value=None,
            ):
                run_pass_a(_config(root), store, manifest)

            shots = pd.read_parquet(store.shots_path("video"))
            self.assertEqual(int(shots.loc[0, "end_frame"]), 3)
            self.assertEqual(int(shots.loc[0, "checkpoint_frame_count"]), 4)

    def test_zero_frame_source_never_invokes_transnet_decode(self):
        row = pd.Series({
            "video_id": "empty",
            "frame_count": 0,
            "n_frames_est": 99,
            "duration_s": 0.0,
        })
        with patch(
            "pipelines.preprocessing.shot_detection.shots._decode_lowres"
        ) as decoder:
            shots = detect_shots(row, _config(Path(".")), model=object())
        decoder.assert_not_called()
        self.assertEqual(int(shots.loc[0, "start_frame"]), 0)
        self.assertEqual(int(shots.loc[0, "end_frame"]), 0)

    def test_remote_identity_is_forwarded_to_transnet_decode(self):
        client = object()
        row = pd.Series({
            "video_id": "remote",
            "storage_uri": "r2://raw/video.mp4",
            "frame_count": 2,
            "duration_s": 1.0,
            "etag": '"object-etag"',
            "version_id": "object-version",
        })
        cfg = _config(Path("."))
        cfg.video_source_kwargs = lambda _uri: {
            "client": client,
            "endpoint_url": "https://example.invalid",
        }
        frames = np.zeros((2, 27, 48, 3), dtype=np.uint8)
        timestamps = np.array([0.0, 0.5])
        with (
            patch(
                "pipelines.preprocessing.shot_detection.shots._decode_lowres",
                return_value=(frames, timestamps),
            ) as decoder,
            patch(
                "pipelines.preprocessing.shot_detection.shots._predict",
                return_value=np.zeros(2),
            ),
        ):
            detect_shots(row, cfg, model=object())

        kwargs = decoder.call_args.kwargs
        self.assertIs(kwargs["client"], client)
        self.assertEqual(kwargs["source_options"]["expected_etag"], '"object-etag"')
        self.assertEqual(
            kwargs["source_options"]["expected_version_id"], "object-version"
        )

    def test_physical_and_logically_truncated_checkpoints_are_rebuilt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "video.mp4"
            source.write_bytes(b"source identity")
            store = _Store(root / "outputs")
            manifest = pd.DataFrame([_row("video", source)])
            expected = _two_shots("video")

            with (
                patch(
                    "pipelines.preprocessing.shot_detection.shots.load_transnet",
                    return_value=None,
                ),
                patch(
                    "pipelines.preprocessing.shot_detection.shots.detect_shots",
                    return_value=expected.copy(),
                ) as detector,
            ):
                run_pass_a(_config(root), store, manifest)
                self.assertEqual(detector.call_count, 1)

                store.shots_path("video").write_bytes(b"not parquet")
                run_pass_a(_config(root), store, manifest)
                self.assertEqual(detector.call_count, 2)

                truncated = pd.read_parquet(store.shots_path("video")).iloc[:1]
                truncated.to_parquet(store.shots_path("video"), index=False)
                run_pass_a(_config(root), store, manifest)
                self.assertEqual(detector.call_count, 3)

            rebuilt = pd.read_parquet(store.shots_path("video"))
            self.assertEqual(len(rebuilt), 2)
            self.assertTrue((rebuilt["checkpoint_shot_count"] == 2).all())

    def test_fingerprint_failure_is_isolated_per_video(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            missing = root / "missing.mp4"
            good = root / "good.mp4"
            good.write_bytes(b"source identity")
            store = _Store(root / "outputs")
            manifest = pd.DataFrame([
                _row("bad", missing),
                _row("good", good, frame_count=3),
            ])

            with patch(
                "pipelines.preprocessing.shot_detection.shots.load_transnet",
                return_value=None,
            ):
                run_pass_a(_config(root), store, manifest)

            self.assertEqual(store.failures[0][0], "bad")
            self.assertTrue(store.shots_path("good").exists())


if __name__ == "__main__":
    unittest.main()
