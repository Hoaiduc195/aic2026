from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from pipelines.feature_extraction.captioning import (
    modal_florence_captioning as captioning,
)


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

    def test_bounded_path_chunks_respects_count_and_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            paths = []
            for index, size in enumerate((3, 3, 1)):
                path = root / f"{index}.jpg"
                path.write_bytes(b"x" * size)
                paths.append(path)

            result = tuple(
                captioning.bounded_path_chunks(
                    tuple(paths), max_items=3, max_bytes=5
                )
            )

            self.assertEqual(
                tuple(tuple(path.name for path in chunk) for chunk in result),
                (("0.jpg",), ("1.jpg", "2.jpg")),
            )

    def test_relative_path_rejects_traversal(self) -> None:
        with self.assertRaises(ValueError):
            captioning.parse_remote_result(
                json.dumps({"relative_path": "../escape.jpg", "caption": "x"})
            )

    def test_output_directory_cannot_be_inside_input_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_dir = Path(temporary_directory) / "frames"
            input_dir.mkdir()

            with self.assertRaises(ValueError):
                captioning.validate_directory_layout(
                    input_dir, input_dir / "captioning"
                )


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


class _AsyncResults:
    def __init__(self, results: list[str], error: BaseException | None = None) -> None:
        self._results = iter(results)
        self._error = error
        self._raised = False

    def __aiter__(self) -> _AsyncResults:
        return self

    async def __anext__(self) -> str:
        if self._error is not None and not self._raised:
            self._raised = True
            raise self._error
        try:
            return next(self._results)
        except StopIteration as error:
            raise StopAsyncIteration from error


class _FakeStarmap:
    def __init__(self, handler: Any) -> None:
        self.handler = handler

    def aio(self, requests: tuple[tuple[bytes, str, int, int], ...]) -> _AsyncResults:
        return self.handler(requests)


class _FakeBatch:
    def __init__(self, handler: Any) -> None:
        self.starmap = _FakeStarmap(handler)


class _FakeCaptioner:
    def __init__(self, handler: Any) -> None:
        self.caption_batch = _FakeBatch(handler)


class RemoteCaptioningTests(unittest.TestCase):
    def test_remote_window_maps_results_by_relative_path(self) -> None:
        def handler(requests: tuple[tuple[bytes, str, int, int], ...]) -> _AsyncResults:
            results = [
                json.dumps({"relative_path": request[1], "caption": request[1]})
                for request in reversed(requests)
            ]
            return _AsyncResults(results)

        jobs = (
            captioning.ImageJob("L21_V001/001.jpg", b"a"),
            captioning.ImageJob("L21_V001/002.jpg", b"b"),
        )
        captioner = _FakeCaptioner(handler)

        results, failures, error, _ = asyncio.run(
            captioning._caption_remote_window(
                captioner,
                jobs,
                max_new_tokens=32,
                num_beams=1,
                max_retries=0,
            )
        )

        self.assertEqual(set(results), {job.relative_path for job in jobs})
        self.assertEqual(failures, ())
        self.assertIsNone(error)

    def test_recovery_splits_an_isolateable_bad_image(self) -> None:
        def handler(requests: tuple[tuple[bytes, str, int, int], ...]) -> _AsyncResults:
            if any(request[1].endswith("bad.jpg") for request in requests):
                return _AsyncResults([], ValueError("cannot identify image file"))
            return _AsyncResults(
                [
                    json.dumps(
                        {"relative_path": request[1], "caption": "A caption."}
                    )
                    for request in requests
                ]
            )

        jobs = (
            captioning.ImageJob("L21_V001/good.jpg", b"good"),
            captioning.ImageJob("L21_V001/bad.jpg", b"bad"),
        )
        captioner = _FakeCaptioner(handler)

        results, failures, _, _ = asyncio.run(
            captioning._caption_remote_with_recovery(
                captioner,
                jobs,
                max_new_tokens=32,
                num_beams=1,
                max_retries=0,
            )
        )

        self.assertEqual(set(results), {"L21_V001/good.jpg"})
        self.assertEqual(tuple(job.relative_path for job in failures), ("L21_V001/bad.jpg",))


if __name__ == "__main__":
    unittest.main()
