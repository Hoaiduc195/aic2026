import io
import json
import tempfile
import unittest
from pathlib import Path

import av
import numpy as np
import pandas as pd

from pipelines.preprocessing.keyframes.dense import (
    DenseFrame,
    decode_window,
    dense_candidates_dataframe,
    select_semantic_keyframe,
    write_dense_candidates,
    write_semantic_selection,
)


def _write_synthetic_video(path: Path, frame_count: int = 16, fps: int = 8) -> None:
    with av.open(str(path), mode="w") as container:
        stream = container.add_stream("mpeg4", rate=fps)
        stream.width = 64
        stream.height = 48
        stream.pix_fmt = "yuv420p"
        stream.codec_context.gop_size = 4
        for frame_id in range(frame_count):
            image = np.zeros((48, 64, 3), dtype=np.uint8)
            image[:, :, 0] = frame_id * 12
            image[:, frame_id % 64, 1] = 255
            frame = av.VideoFrame.from_ndarray(image, format="rgb24")
            frame.pts = frame_id
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def _build_manifest(path: Path) -> pd.DataFrame:
    rows = []
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        for frame_id, frame in enumerate(container.decode(stream)):
            rows.append({
                "original_frame_id": frame_id,
                "pts": frame.pts,
                "time_base_num": stream.time_base.numerator,
                "time_base_den": stream.time_base.denominator,
                "timestamp_ms": float(frame.pts * stream.time_base * 1000),
                "is_codec_keyframe": bool(frame.key_frame),
            })
    return pd.DataFrame(rows)


class DenseDecodeTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.video_path = Path(self.temp_dir.name) / "synthetic.mp4"
        _write_synthetic_video(self.video_path)
        self.manifest = _build_manifest(self.video_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_returns_every_frame_in_exact_half_open_range(self):
        frames = decode_window(self.video_path, self.manifest, 5, 11)

        self.assertEqual([frame.original_frame_id for frame in frames], list(range(5, 11)))
        self.assertEqual(len(frames), 6)
        self.assertTrue(all(frame.image.shape == (48, 64, 3) for frame in frames))
        self.assertTrue(all(frame.mapping_method == "pts" for frame in frames))

    def test_accepts_manifest_path_and_resize_without_changing_ids(self):
        manifest_path = Path(self.temp_dir.name) / "frames.parquet"
        self.manifest.to_parquet(manifest_path, index=False)

        frames = decode_window(str(self.video_path), manifest_path, 2, 5, resize=(32, 24))

        self.assertEqual([frame.original_frame_id for frame in frames], [2, 3, 4])
        self.assertTrue(all(frame.image.shape == (24, 32, 3) for frame in frames))

    def test_retries_from_stream_start_when_manifest_pts_cannot_seek(self):
        # Simulate a stale/missing PTS join.  A partial-seek ordinal would be
        # unsafe here, so decode_window must restart and use full decode order.
        stale_pts = self.manifest.copy()
        stale_pts["pts"] = stale_pts["pts"] + 1_000_000

        frames = decode_window(self.video_path, stale_pts, 6, 9)

        self.assertEqual([frame.original_frame_id for frame in frames], [6, 7, 8])
        self.assertTrue(all(frame.mapping_method == "decode_order_fallback" for frame in frames))

    def test_accepts_raw_av_compatible_file_like_source(self):
        source = io.BytesIO(self.video_path.read_bytes())

        frames = decode_window(source, self.manifest, 1, 3)

        self.assertEqual([frame.original_frame_id for frame in frames], [1, 2])

    def test_rejects_invalid_or_incomplete_ranges(self):
        with self.assertRaises(ValueError):
            decode_window(self.video_path, self.manifest, 4, 4)
        with self.assertRaises(ValueError):
            decode_window(self.video_path, self.manifest, 0, len(self.manifest) + 1)

        incomplete = self.manifest.drop(index=3)
        with self.assertRaisesRegex(ValueError, "full zero-based source timeline"):
            decode_window(self.video_path, incomplete, 1, 4)


class SemanticSelectorTest(unittest.TestCase):
    @staticmethod
    def _frames(count: int = 4) -> list[DenseFrame]:
        image = np.full((16, 16, 3), 80, dtype=np.uint8)
        return [
            DenseFrame(
                original_frame_id=frame_id,
                timestamp_ms=frame_id * 100.0,
                image=image.copy(),
                pts=frame_id,
                quality_scores={
                    "blur_score": 0.0,
                    "contrast_score": 0.0,
                    "entropy_score": 0.0,
                },
            )
            for frame_id in range(count)
        ]

    def test_external_event_score_is_primary_and_evidence_is_explainable(self):
        frames = self._frames()

        result = select_semantic_keyframe(
            frames,
            external_scores={0: 0.1, 1: 0.2, 2: 0.95, 3: 0.3},
            target_frame_id=1,
        )

        self.assertEqual(result.original_frame_id, 2)
        self.assertEqual(result.timestamp_ms, 200.0)
        self.assertIn("candidate_scores", result.evidence)
        self.assertEqual(result.evidence["candidate_scores"]["2"]["external_score"], 0.95)

    def test_target_breaks_equal_visual_scores_and_final_tie_is_earlier(self):
        frames = self._frames()

        targeted = select_semantic_keyframe(frames, target_frame_id=3)
        tied = select_semantic_keyframe(frames)

        self.assertEqual(targeted.original_frame_id, 3)
        self.assertEqual(tied.original_frame_id, 0)

    def test_validates_external_scores_and_duplicate_ids(self):
        frames = self._frames()
        with self.assertRaises(ValueError):
            select_semantic_keyframe(frames, external_scores={99: 1.0})
        with self.assertRaisesRegex(ValueError, "cover every dense frame"):
            select_semantic_keyframe(frames, external_scores={2: -1.0})
        with self.assertRaises(TypeError):
            select_semantic_keyframe(frames, external_scores=[0.0, 0.0, 1.0, 0.0])
        with self.assertRaises(ValueError):
            select_semantic_keyframe([frames[0], frames[0]])

    def test_serializes_dense_parquet_and_semantic_json_contracts(self):
        frames = self._frames()
        scores = {0: 0.0, 1: 0.0, 2: 1.0, 3: 0.0}
        selection = select_semantic_keyframe(frames, external_scores=scores)
        with tempfile.TemporaryDirectory() as temp_dir:
            dense_path = Path(temp_dir) / "dense.parquet"
            selection_path = Path(temp_dir) / "semantic.json"

            table = dense_candidates_dataframe(
                frames,
                event_window_id="window-1",
                video_id="video-1",
                event_scores=scores,
            )
            write_dense_candidates(
                frames,
                dense_path,
                event_window_id="window-1",
                video_id="video-1",
                event_scores=scores,
            )
            write_semantic_selection(
                selection,
                selection_path,
                event_window_id="window-1",
                video_id="video-1",
            )

            loaded_dense = pd.read_parquet(dense_path)
            loaded_selection = json.loads(selection_path.read_text(encoding="utf-8"))

        self.assertEqual(table["original_frame_id"].tolist(), [0, 1, 2, 3])
        self.assertEqual(loaded_dense["event_score"].tolist(), [0.0, 0.0, 1.0, 0.0])
        self.assertEqual(loaded_selection["original_frame_id"], 2)
        self.assertEqual(loaded_selection["selector"], "weighted_event_quality_motion_v1")


if __name__ == "__main__":
    unittest.main()
