import unittest
from fractions import Fraction
from types import SimpleNamespace

import pandas as pd

from pipelines.preprocessing.keyframes.mapping import (
    exact_timestamp_ms,
    frame_id_from_timestamp_ms,
    parse_fps,
)
from pipelines.preprocessing.keyframes.sampling import (
    build_candidates,
    candidate_times_for_shot,
)


class FrameMappingTest(unittest.TestCase):
    def test_preserves_fractional_fps(self):
        fps = parse_fps("30000/1001")

        self.assertEqual(fps, Fraction(30000, 1001))
        self.assertEqual(exact_timestamp_ms(30, fps), 1001.0)

    def test_timestamp_mapping_clamps_to_source_range(self):
        self.assertEqual(frame_id_from_timestamp_ms(0, "30/1", 100), 0)
        self.assertEqual(frame_id_from_timestamp_ms(100_000, "30/1", 100), 99)

    def test_rejects_invalid_mapping_inputs(self):
        with self.assertRaises(ValueError):
            exact_timestamp_ms(-1, "30/1")
        with self.assertRaises(ValueError):
            parse_fps("0/1")
        with self.assertRaises(ValueError):
            frame_id_from_timestamp_ms(0, "30/1", 0)


class SparseSamplingTest(unittest.TestCase):
    def setUp(self):
        self.cfg = SimpleNamespace(
            short_shot_max_s=3.0,
            medium_shot_max_s=10.0,
            long_shot_period_s=2.0,
            include_shot_boundaries=True,
            signal_sampling=True,
            signal_peaks_per_shot=1,
            signal_min_distance_frames=2,
            motion_peak_min=5.0,
            scene_change_peak_min=0.2,
            text_change_peak_min=3.0,
        )

    def test_duration_rules(self):
        self.assertEqual(candidate_times_for_shot(0.0, 2.0, self.cfg), [1.0])
        self.assertEqual(candidate_times_for_shot(0.0, 4.0, self.cfg), [1.0, 2.0, 3.0])
        self.assertEqual(candidate_times_for_shot(0.0, 11.0, self.cfg), [1.0, 3.0, 5.0, 7.0, 9.0])

    def test_candidates_have_explicit_retrieval_roles(self):
        shots = pd.DataFrame([
            {"shot_id": 0, "start_time": 0.0, "end_time": 2.0},
            {"shot_id": 1, "start_time": 2.0, "end_time": 6.0},
        ])

        candidates = build_candidates(shots, self.cfg)

        self.assertEqual(candidates[0]["retrieval_role"], "shot_anchor")
        self.assertEqual(
            [item["retrieval_role"] for item in candidates[1:]],
            ["uniform_anchor", "uniform_anchor", "uniform_anchor"],
        )
        self.assertEqual(
            [item["target_time"] for item in candidates],
            sorted(item["target_time"] for item in candidates),
        )

    def test_manifest_sampling_adds_boundaries_and_signal_peaks(self):
        shots = pd.DataFrame([{
            "shot_id": 0,
            "start_frame": 0,
            "end_frame": 9,
            "start_time": 0.0,
            "end_time": 1.0,
        }])
        manifest = pd.DataFrame({
            "original_frame_id": range(10),
            "timestamp_ms": [index * 100 for index in range(10)],
            "motion_score": [0, 0, 0, 0, 9, 0, 0, 0, 0, 0],
            "scene_change_score": [0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0],
            "text_change_score": [0, 0, 7, 0, 0, 0, 0, 0, 0, 0],
        })

        candidates = build_candidates(shots, self.cfg, manifest)
        by_frame = {item["target_frame_id"]: item["retrieval_roles"] for item in candidates}

        self.assertIn("shot_boundary", by_frame[0])
        self.assertIn("shot_boundary", by_frame[9])
        self.assertIn("text_change_peak", by_frame[2])
        self.assertIn("motion_peak", by_frame[4])
        self.assertIn("scene_change_peak", by_frame[6])


if __name__ == "__main__":
    unittest.main()
