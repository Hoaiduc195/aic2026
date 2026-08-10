from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from pipelines.feature_extraction.captioning import modal_florence_captioning as captioning


class CaptioningPlanningTests(unittest.TestCase):
    def test_partition_splits_873_videos_into_three_disjoint_batches(self) -> None:
        video_ids = tuple(f"L21_V{index:03d}" for index in range(1, 874))

        batches = tuple(
            captioning.partition_video_ids(video_ids, batch_index=index, num_batches=3)
            for index in range(3)
        )

        self.assertEqual(tuple(len(batch) for batch in batches), (291, 291, 291))
        self.assertEqual(set().union(*map(set, batches)), set(video_ids))
        self.assertEqual(sum(len(set(batch)) for batch in batches), len(video_ids))
        self.assertEqual(batches[0][0], "L21_V001")
        self.assertEqual(batches[2][-1], "L21_V873")

    def test_partition_rejects_uneven_batches_and_invalid_indexes(self) -> None:
        with self.assertRaises(ValueError):
            captioning.partition_video_ids(("a", "b"), batch_index=0, num_batches=3)
        with self.assertRaises(ValueError):
            captioning.partition_video_ids(("a",), batch_index=1, num_batches=1)
        with self.assertRaises(ValueError):
            captioning.partition_video_ids(("a",), batch_index=0, num_batches=0)

    def test_iter_images_filters_and_naturally_sorts_selected_video(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video_dir = root / "L21_V001"
            video_dir.mkdir()
            (video_dir / "010.jpg").touch()
            (video_dir / "002.jpg").touch()
            (video_dir / "001.txt").touch()
            (root / "L21_V002").mkdir()
            (root / "L21_V002" / "001.jpg").touch()

            result = captioning.iter_images(root, ("L21_V001",))

            self.assertEqual(
                tuple(path.name for path in result),
                ("002.jpg", "010.jpg"),
            )

    def test_caption_path_and_resume_only_accept_non_empty_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            image_path = root / "frames" / "L21_V001" / "001.jpg"
            output_dir = root / "captioning"
            caption_path = captioning.caption_path_for(
                root / "frames", output_dir, image_path
            )

            self.assertEqual(
                caption_path,
                output_dir / "L21_V001" / "001.txt",
            )
            self.assertFalse(captioning.is_complete_caption(caption_path))
            caption_path.parent.mkdir(parents=True)
            caption_path.write_text("\n", encoding="utf-8")
            self.assertFalse(captioning.is_complete_caption(caption_path))
            caption_path.write_text("A person walks.\n", encoding="utf-8")
            self.assertTrue(captioning.is_complete_caption(caption_path))

    def test_chunked_does_not_drop_or_mutate_items(self) -> None:
        items = tuple(range(5))

        result = tuple(captioning.chunked(items, 2))

        self.assertEqual(result, ((0, 1), (2, 3), (4,)))
        self.assertEqual(items, tuple(range(5)))


class CaptioningValidationTests(unittest.TestCase):
    def test_validate_options_rejects_unsafe_or_empty_values(self) -> None:
        with self.assertRaises(ValueError):
            captioning.validate_options(
                batch_size=0,
                max_new_tokens=32,
                num_beams=1,
                max_retries=2,
                budget_usd=25.0,
            )
        with self.assertRaises(ValueError):
            captioning.validate_options(
                batch_size=128,
                max_new_tokens=0,
                num_beams=1,
                max_retries=2,
                budget_usd=25.0,
            )
        with self.assertRaises(ValueError):
            captioning.validate_options(
                batch_size=128,
                max_new_tokens=32,
                num_beams=0,
                max_retries=2,
                budget_usd=25.0,
            )
        with self.assertRaises(ValueError):
            captioning.validate_options(
                batch_size=128,
                max_new_tokens=32,
                num_beams=1,
                max_retries=2,
                budget_usd=0.0,
            )

    def test_read_image_job_rejects_empty_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "empty.jpg"
            path.touch()

            with self.assertRaises(ValueError):
                captioning.read_image_job(path, "empty.jpg")

    def test_parse_remote_result_validates_identity_and_caption(self) -> None:
        payload = json.dumps(
            {"relative_path": "L21_V001/001.jpg", "caption": "A street."}
        )

        self.assertEqual(
            captioning.parse_remote_result(payload),
            ("L21_V001/001.jpg", "A street."),
        )
        with self.assertRaises(ValueError):
            captioning.parse_remote_result('{"relative_path":"x","caption":" "}')
        with self.assertRaises(ValueError):
            captioning.parse_remote_result("not-json")


class CostTrackerTests(unittest.TestCase):
    def test_cost_tracker_is_immutable_and_reports_budget(self) -> None:
        tracker = captioning.CostTracker(
            budget_usd=25.0,
            gpu_rate_usd_per_hour=0.5904,
        )
        updated = tracker.add_remote_seconds(60.0)

        self.assertEqual(tracker.remote_seconds, 0.0)
        self.assertEqual(updated.remote_seconds, 60.0)
        self.assertAlmostEqual(updated.estimated_cost_usd, 0.00984, places=6)
        self.assertFalse(updated.over_budget)
        self.assertTrue(updated.add_remote_seconds(200_000).over_budget)


if __name__ == "__main__":
    unittest.main()
