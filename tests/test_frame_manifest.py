import io
import tempfile
import unittest
import wave
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import av
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from pipelines.preprocessing.keyframes.frame_manifest import (
    FRAME_MANIFEST_SCHEMA,
    build_frame_manifest,
    load_frame_manifest,
    run_frame_manifest,
    validate_frame_manifest,
)


def _write_cfr_video(
    path: Path,
    frame_count: int = 8,
    rate: Fraction = Fraction(30, 1),
    pts_start: int | None = None,
) -> None:
    with av.open(str(path), mode="w") as container:
        stream = container.add_stream("mpeg4", rate=rate)
        stream.width = 96
        stream.height = 64
        stream.pix_fmt = "yuv420p"
        for frame_index in range(frame_count):
            image = np.zeros((64, 96, 3), dtype=np.uint8)
            image[:, :, 1] = frame_index * 12
            x = 4 + frame_index * 7
            image[16:48, x : x + 16] = (255, 255, 255)
            frame = av.VideoFrame.from_ndarray(image, format="rgb24")
            if pts_start is not None:
                frame.pts = pts_start + frame_index
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def _write_audio_only_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8_000)
        output.writeframes(b"\x00\x00" * 80)


class _RangeClient:
    def __init__(self, payload: bytes):
        self.payload = payload
        self.head_calls = 0
        self.get_calls = 0

    def head_object(self, *, Bucket, Key):
        self.head_calls += 1
        return {"ContentLength": len(self.payload), "ETag": '"manifest-etag"'}

    def get_object(self, *, Bucket, Key, Range, IfMatch=None, VersionId=None):
        self.get_calls += 1
        if IfMatch != '"manifest-etag"':
            raise AssertionError("immutable read must carry IfMatch")
        interval = Range.removeprefix("bytes=")
        start_text, end_text = interval.split("-", 1)
        start, end = int(start_text), int(end_text)
        return {
            "Body": io.BytesIO(self.payload[start : end + 1]),
            "ETag": '"manifest-etag"',
            "ContentRange": f"bytes {start}-{end}/{len(self.payload)}",
        }


class _Store:
    def __init__(self, root: Path):
        self.root = root
        self.failures = []

    def frame_manifest_path(self, video_id: str) -> Path:
        return self.root / "frame_manifests" / f"{video_id}.parquet"

    @property
    def manifest_path(self) -> Path:
        return self.root / "videos_manifest.parquet"

    def log_failed(self, video_id: str, error: str) -> None:
        self.failures.append((video_id, error))


class FrameManifestTest(unittest.TestCase):
    def test_sequential_decode_produces_exact_ids_timestamps_and_signals(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video_path = root / "synthetic.mp4"
            output_path = root / "frames.parquet"
            _write_cfr_video(video_path)

            built = build_frame_manifest(
                {
                    "video_id": "synthetic",
                    "path": str(video_path),
                    "fps_str": "30/1",
                },
                output_path,
                signal_long_edge=64,
            )
            loaded = load_frame_manifest(output_path)

            self.assertEqual(len(built), 8)
            self.assertEqual(len(loaded), 8)
            self.assertEqual(loaded["original_frame_id"].tolist(), list(range(8)))
            self.assertEqual(loaded["decoded_frame_index"].tolist(), list(range(8)))
            self.assertEqual(set(zip(loaded["fps_num"], loaded["fps_den"])), {(30, 1)})
            self.assertAlmostEqual(loaded.loc[3, "cfr_timestamp_ms"], 100.0, places=6)
            self.assertAlmostEqual(
                loaded.loc[3, "pts_timestamp_ms"],
                loaded.loc[3, "timestamp_ms"],
                places=6,
            )
            self.assertEqual(loaded.loc[3, "timestamp_source"], "pts")
            self.assertEqual(loaded.loc[0, "motion_score"], 0.0)
            self.assertGreater(float(loaded.loc[1:, "motion_score"].max()), 0.0)
            self.assertGreater(float(loaded.loc[1:, "text_change_score"].max()), 0.0)
            self.assertLessEqual(float(loaded["text_change_score"].max()), 100.0)
            self.assertGreater(float(loaded["brightness_score"].max()), 0.0)
            self.assertTrue(loaded["is_codec_keyframe"].any())
            validate_frame_manifest(loaded)

    def test_fractional_fps_is_not_rounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video_path = root / "synthetic.mp4"
            output_path = root / "frames.parquet"
            _write_cfr_video(video_path, frame_count=4, rate=Fraction(30000, 1001))

            loaded = build_frame_manifest(
                {
                    "video_id": "fractional-contract",
                    "path": str(video_path),
                    "fps_str": "30000/1001",
                },
                output_path,
            )

            self.assertEqual((loaded.loc[0, "fps_num"], loaded.loc[0, "fps_den"]), (30000, 1001))
            self.assertAlmostEqual(loaded.loc[3, "cfr_timestamp_ms"], 100.1, places=6)
            self.assertAlmostEqual(loaded.loc[3, "timestamp_ms"], 100.1, places=6)

    def test_nonzero_source_pts_is_normalized_without_losing_raw_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video_path = root / "offset.mp4"
            _write_cfr_video(video_path, frame_count=4, pts_start=90)

            loaded = build_frame_manifest(
                {"video_id": "offset", "path": str(video_path), "fps_str": "30/1"},
                root / "offset.parquet",
            )

            self.assertGreater(loaded.loc[0, "raw_pts_timestamp_ms"], 0.0)
            self.assertAlmostEqual(loaded.loc[0, "timestamp_ms"], 0.0, places=6)
            self.assertEqual(loaded["timestamp_ms"].tolist(), sorted(loaded["timestamp_ms"]))

    def test_storage_uri_wins_and_missing_uri_falls_back_to_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fallback_video = root / "fallback.mp4"
            uri_video = root / "uri.mp4"
            _write_cfr_video(fallback_video, frame_count=2)
            _write_cfr_video(uri_video, frame_count=5)

            from_uri = build_frame_manifest(
                {
                    "video_id": "prefer-uri",
                    "storage_uri": uri_video.resolve().as_uri(),
                    "path": str(fallback_video),
                    "fps_str": "30/1",
                },
                root / "from-uri.parquet",
            )
            from_path = build_frame_manifest(
                pd.Series(
                    {
                        "video_id": "fallback-path",
                        "storage_uri": pd.NA,
                        "path": str(fallback_video),
                        "fps_str": "30/1",
                    }
                ),
                root / "from-path.parquet",
            )

            self.assertEqual(len(from_uri), 5)
            self.assertEqual(len(from_path), 2)

    def test_remote_source_accepts_injected_client_and_safe_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "remote-source.mp4"
            _write_cfr_video(video, frame_count=3)
            client = _RangeClient(video.read_bytes())

            result = build_frame_manifest(
                {
                    "video_id": "remote",
                    "storage_uri": "r2://raw-videos/remote-source.mp4",
                    "fps_str": "30/1",
                },
                root / "remote.parquet",
                client=client,
                source_options={"chunk_size": 512, "max_cached_chunks": 2},
            )

            self.assertEqual(len(result), 3)
            self.assertNotIn("client", result.columns)
            self.assertNotIn("source_options", result.columns)

    def test_batch_persists_and_pins_observed_remote_object_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "remote-batch.mp4"
            _write_cfr_video(video, frame_count=3)
            client = _RangeClient(video.read_bytes())
            store = _Store(root / "outputs")
            manifest = pd.DataFrame([{
                "video_id": "remote-batch",
                "storage_uri": "r2://raw-videos/remote-batch.mp4",
                "fps_str": "30/1",
                "n_frames_est": 999,
            }])
            store.root.mkdir(parents=True, exist_ok=True)
            manifest.to_parquet(store.manifest_path, index=False)
            cfg = SimpleNamespace(
                frame_signal_long_edge=64,
                webp_long_edge=64,
                video_source_kwargs=lambda _uri: {
                    "client": client,
                    "chunk_size": 512,
                },
            )

            run_frame_manifest(cfg, store, manifest)

            self.assertEqual(client.head_calls, 2)
            self.assertGreater(client.get_calls, 0)
            self.assertEqual(manifest.loc[0, "etag"], '"manifest-etag"')
            self.assertEqual(int(manifest.loc[0, "frame_count"]), 3)
            self.assertEqual(int(manifest.loc[0, "n_frames_est"]), 3)
            persisted = pd.read_parquet(store.manifest_path)
            self.assertEqual(persisted.loc[0, "etag"], '"manifest-etag"')
            self.assertEqual(int(persisted.loc[0, "size_bytes"]), len(client.payload))

    def test_quality_and_change_signals_use_independent_resolutions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "signals.mp4"
            _write_cfr_video(video, frame_count=5)
            row = {"video_id": "signals", "path": str(video), "fps_str": "30/1"}

            low_quality = build_frame_manifest(
                row,
                root / "low.parquet",
                signal_long_edge=48,
                quality_long_edge=32,
            )
            full_quality = build_frame_manifest(
                row,
                root / "full.parquet",
                signal_long_edge=48,
                quality_long_edge=96,
            )

            change_columns = [
                "motion_score",
                "scene_change_score",
                "text_change_score",
            ]
            np.testing.assert_allclose(
                low_quality[change_columns].to_numpy(),
                full_quality[change_columns].to_numpy(),
            )
            self.assertFalse(
                np.allclose(low_quality["blur_score"], full_quality["blur_score"])
            )

    def test_no_video_stream_writes_stable_empty_parquet(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path = root / "audio-only.wav"
            output_path = root / "frames.parquet"
            _write_audio_only_wav(source_path)

            built = build_frame_manifest(
                {"video_id": "empty", "path": str(source_path), "fps_str": "30/1"},
                output_path,
            )
            table = pq.read_table(output_path)

            self.assertTrue(built.empty)
            self.assertEqual(table.num_rows, 0)
            self.assertTrue(table.schema.equals(FRAME_MANIFEST_SCHEMA, check_metadata=False))
            validate_frame_manifest(output_path)

    def test_validation_rejects_broken_source_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video_path = root / "synthetic.mp4"
            output_path = root / "frames.parquet"
            _write_cfr_video(video_path, frame_count=3)
            manifest = build_frame_manifest(
                {"video_id": "broken", "path": str(video_path), "fps_str": "30/1"},
                output_path,
            )
            manifest.loc[1, "original_frame_id"] = 99

            with self.assertRaisesRegex(ValueError, "contiguous and zero-based"):
                validate_frame_manifest(manifest)

    def test_batch_runner_is_resumable_and_uses_configured_resolutions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "batch.mp4"
            _write_cfr_video(video, frame_count=3)
            store = _Store(root / "outputs")
            cfg = SimpleNamespace(frame_signal_long_edge=40, webp_long_edge=80)
            manifest = pd.DataFrame(
                [{"video_id": "batch", "path": str(video), "fps_str": "30/1"}]
            )

            with patch(
                "pipelines.preprocessing.keyframes.frame_manifest.build_frame_manifest",
                wraps=build_frame_manifest,
            ) as builder:
                run_frame_manifest(cfg, store, manifest)
                self.assertEqual(builder.call_args.kwargs["signal_long_edge"], 40)
                self.assertEqual(builder.call_args.kwargs["quality_long_edge"], 80)

            with patch(
                "pipelines.preprocessing.keyframes.frame_manifest.build_frame_manifest"
            ) as builder:
                run_frame_manifest(cfg, store, manifest)
                builder.assert_not_called()

            cfg.frame_signal_long_edge = 41
            with patch(
                "pipelines.preprocessing.keyframes.frame_manifest.build_frame_manifest",
                wraps=build_frame_manifest,
            ) as builder:
                run_frame_manifest(cfg, store, manifest)
                builder.assert_called_once()

            self.assertEqual(store.failures, [])

    def test_batch_runner_propagates_exact_count_in_memory_and_on_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "exact-count.mp4"
            _write_cfr_video(video, frame_count=4)
            store = _Store(root / "outputs")
            store.root.mkdir(parents=True)
            cfg = SimpleNamespace(frame_signal_long_edge=40, webp_long_edge=80)
            manifest = pd.DataFrame([{
                "video_id": "exact-count",
                "path": str(video),
                "fps_str": "30/1",
                "frame_count": 1,
                "n_frames_est": 99,
            }])
            manifest.to_parquet(store.manifest_path, index=False)

            run_frame_manifest(cfg, store, manifest)
            persisted = pd.read_parquet(store.manifest_path)

            self.assertEqual(int(manifest.loc[0, "frame_count"]), 4)
            self.assertEqual(int(manifest.loc[0, "n_frames_est"]), 4)
            self.assertEqual(int(persisted.loc[0, "frame_count"]), 4)
            self.assertEqual(int(persisted.loc[0, "n_frames_est"]), 4)


if __name__ == "__main__":
    unittest.main()
