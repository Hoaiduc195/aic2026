import tempfile
import unittest
from pathlib import Path

import pandas as pd

from pipelines.preprocessing.keyframes.event_windows import (
    build_event_windows,
    write_event_windows,
)


class EventWindowTest(unittest.TestCase):
    def setUp(self):
        self.frames = pd.DataFrame({
            "video_id": ["v1"] * 100,
            "original_frame_id": range(100),
            "timestamp_ms": [frame_id * 100 for frame_id in range(100)],
        })

    def test_expands_and_merges_nearby_sparse_hits(self):
        hits = pd.DataFrame([
            {"video_id": "v1", "original_frame_id": 20, "score": 0.8},
            {"video_id": "v1", "original_frame_id": 24, "score": 0.9},
            {"video_id": "v1", "original_frame_id": 80, "score": 0.7},
        ])

        windows = build_event_windows(hits, self.frames, radius_ms=500, merge_gap_ms=100)

        self.assertEqual(len(windows), 2)
        self.assertEqual(windows[0].member_frame_ids, (20, 24))
        self.assertEqual(windows[0].start_frame_id, 15)
        self.assertEqual(windows[0].end_frame_id, 30)
        self.assertEqual(windows[0].end_ms, 3000.0)
        self.assertEqual(windows[0].retrieval_score, 0.9)
        self.assertEqual(windows[0].peak_frame_id, 24)

    def test_half_open_adjacent_frames_merge_and_namespace_is_stable(self):
        hits = pd.DataFrame([
            {"video_id": "v1", "original_frame_id": 20},
            {"video_id": "v1", "original_frame_id": 21},
        ])

        windows = build_event_windows(
            hits,
            self.frames,
            radius_ms=0,
            merge_gap_ms=0,
            namespace="queryA",
        )

        self.assertEqual(len(windows), 1)
        self.assertEqual((windows[0].start_frame_id, windows[0].end_frame_id), (20, 22))
        self.assertEqual((windows[0].start_ms, windows[0].end_ms), (2000.0, 2200.0))
        self.assertEqual(windows[0].event_window_id, "queryA_v1_event_0000")

    def test_window_cap_prefers_highest_score_then_returns_chronologically(self):
        hits = pd.DataFrame([
            {"video_id": "v1", "original_frame_id": 10, "score": 0.1},
            {"video_id": "v1", "original_frame_id": 80, "score": 0.9},
        ])

        windows = build_event_windows(
            hits,
            self.frames,
            radius_ms=0,
            merge_gap_ms=0,
            max_windows_per_video=1,
        )

        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0].member_frame_ids, (80,))

    def test_rejects_unknown_source_frame(self):
        hits = pd.DataFrame([{"video_id": "v1", "original_frame_id": 999}])
        with self.assertRaisesRegex(ValueError, "unknown frame"):
            build_event_windows(hits, self.frames)

    def test_writes_empty_table_with_stable_columns(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "windows.parquet"
            write_event_windows([], path)
            table = pd.read_parquet(path)
        self.assertEqual(
            list(table.columns),
            [
                "event_window_id", "video_id", "start_frame_id", "end_frame_id",
                "start_ms", "end_ms", "source", "retrieval_score", "member_frame_ids",
                "peak_frame_id",
            ],
        )


if __name__ == "__main__":
    unittest.main()
