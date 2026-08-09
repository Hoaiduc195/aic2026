import unittest

from pipelines.preprocessing.keyframes.dedup import enforce_coverage


def candidate(pts_time, blur_score, quality_ok=True):
    return {
        "pts_time": float(pts_time),
        "blur_score": float(blur_score),
        "quality_ok": quality_ok,
    }


class CoverageRepairTest(unittest.TestCase):
    def test_repairs_using_actual_output_timestamps(self):
        candidates = [
            candidate(2, 10),
            candidate(8, 30),
            candidate(12, 20),
            candidate(18, 40),
        ]
        # Simulate dedup representatives selected at opposite ends of adjacent
        # local windows, leaving a gap larger than the configured guarantee.
        kept = [candidates[0], candidates[-1]]

        repaired = enforce_coverage(candidates, kept, 10, 0, 20)
        timestamps = [0, *(item["pts_time"] for item in repaired), 20]

        self.assertLessEqual(
            max(right - left for left, right in zip(timestamps, timestamps[1:])),
            10,
        )

    def test_prefers_quality_candidate_over_sharper_soft_candidate(self):
        quality = candidate(10, 5, quality_ok=True)
        soft = candidate(9, 500, quality_ok=False)

        repaired = enforce_coverage([soft, quality], [], 10, 0, 20)

        self.assertIn(quality, repaired)
        self.assertNotIn(soft, repaired)

    def test_unresolvable_gap_terminates_without_inventing_frames(self):
        self.assertEqual(enforce_coverage([], [], 5, 0, 20), [])


if __name__ == "__main__":
    unittest.main()
