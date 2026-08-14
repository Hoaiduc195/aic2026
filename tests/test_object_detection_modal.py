from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from pipelines.feature_extraction.object_detection import modal_yolo as detection


class ObjectDetectionPlanningTests(unittest.TestCase):
    def test_iter_images_filters_and_naturally_sorts_recursive_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "video_b").mkdir()
            (root / "video_a" / "nested").mkdir(parents=True)
            (root / "video_a" / "010.jpg").touch()
            (root / "video_a" / "002.png").touch()
            (root / "video_a" / "nested" / "001.webp").touch()
            (root / "video_a" / "ignore.txt").touch()
            (root / "video_b" / "001.JPG").touch()

            result = detection.iter_images(root)

            self.assertEqual(
                tuple(path.relative_to(root).as_posix() for path in result),
                (
                    "video_a/002.png",
                    "video_a/010.jpg",
                    "video_a/nested/001.webp",
                    "video_b/001.JPG",
                ),
            )

    def test_partition_paths_is_disjoint_and_covers_all_images(self) -> None:
        paths = tuple(Path(f"frame_{index:03d}.jpg") for index in range(7))

        partitions = tuple(
            detection.partition_paths(paths, batch_index=index, num_batches=3)
            for index in range(3)
        )

        self.assertEqual(tuple(len(partition) for partition in partitions), (3, 2, 2))
        self.assertEqual(set().union(*map(set, partitions)), set(paths))
        self.assertEqual(sum(len(set(partition)) for partition in partitions), len(paths))

    def test_output_path_preserves_layout_and_rejects_nested_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_dir = root / "frames"
            output_dir = root / "detections"
            image_path = input_dir / "L21_V001" / "001.jpg"

            self.assertEqual(
                detection.result_path_for(input_dir, output_dir, image_path),
                output_dir / "L21_V001" / "001.json",
            )
            detection.validate_directory_layout(input_dir, output_dir)
            with self.assertRaises(ValueError):
                detection.validate_directory_layout(input_dir, input_dir / "detections")

    def test_validation_rejects_invalid_detection_ranges(self) -> None:
        with self.assertRaises(ValueError):
            detection.validate_options(
                batch_size=0,
                max_retries=2,
                max_images=0,
            )
        with self.assertRaises(ValueError):
            detection.validate_options(
                batch_size=8,
                max_retries=2,
                max_images=0,
                confidence_threshold=1.1,
            )
        with self.assertRaises(ValueError):
            detection.validate_options(
                batch_size=8,
                max_retries=2,
                max_images=0,
                image_size=31,
            )

    def test_dry_run_does_not_require_modal_or_write_results(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_dir = root / "frames"
            output_dir = root / "detections"
            input_dir.mkdir()
            (input_dir / "001.jpg").write_bytes(b"not-decoded-yet")

            asyncio.run(
                detection.detect_directory(
                    input_dir=input_dir,
                    output_dir=output_dir,
                    max_images=1,
                    dry_run=True,
                )
            )

            self.assertFalse(output_dir.exists())


class ObjectDetectionResultTests(unittest.TestCase):
    class _FakeTensor:
        def __init__(self, value: Any) -> None:
            self.value = value

        def detach(self) -> ObjectDetectionResultTests._FakeTensor:
            return self

        def cpu(self) -> ObjectDetectionResultTests._FakeTensor:
            return self

        def tolist(self) -> Any:
            return self.value

    class _FakeBoxes:
        def __init__(self) -> None:
            self.xyxy = ObjectDetectionResultTests._FakeTensor(
                [[10, 20, 110, 220]]
            )
            self.conf = ObjectDetectionResultTests._FakeTensor([0.88])
            self.cls = ObjectDetectionResultTests._FakeTensor([0.0])

    class _FakeResult:
        def __init__(self) -> None:
            self.orig_shape = (480, 640)
            self.names = {0: "person"}
            self.boxes = ObjectDetectionResultTests._FakeBoxes()

    def test_ultralytics_result_is_converted_without_importing_torch(self) -> None:
        record = detection._record_from_ultralytics_result(
            "001.jpg",
            self._FakeResult(),
            model_name="yolo26n.pt",
            image_size=640,
            confidence_threshold=0.25,
            iou_threshold=0.45,
        )

        self.assertEqual(record["detections"][0]["class_name"], "person")
        self.assertEqual(record["detections"][0]["bbox_xyxy"], [10.0, 20.0, 110.0, 220.0])

    def test_build_detection_record_contains_pixel_and_normalized_boxes(self) -> None:
        record = detection.build_detection_record(
            "L21_V001/001.jpg",
            {
                "image_width": 1000,
                "image_height": 500,
                "boxes": [[100, 50, 300, 250], [0, 0, 1000, 500]],
                "confidences": [0.91, 0.25],
                "class_ids": [0, 2],
                "class_names": ["person", "car"],
            },
        )

        self.assertEqual(record["relative_path"], "L21_V001/001.jpg")
        self.assertEqual(record["image_width"], 1000)
        self.assertEqual(record["num_detections"], 2)
        self.assertEqual(record["detections"][0]["class_name"], "person")
        self.assertEqual(record["detections"][0]["confidence"], 0.91)
        self.assertEqual(
            record["detections"][0]["bbox_normalized"],
            [0.1, 0.1, 0.3, 0.5],
        )

    def test_build_detection_record_supports_empty_frame(self) -> None:
        record = detection.build_detection_record(
            "001.jpg",
            {
                "image_width": 640,
                "image_height": 480,
                "boxes": [],
                "confidences": [],
                "class_ids": [],
                "class_names": [],
            },
        )

        self.assertEqual(record["num_detections"], 0)
        self.assertEqual(record["detections"], [])

    def test_parse_remote_result_rejects_unknown_or_unsafe_identity(self) -> None:
        valid = json.dumps(
            detection.build_detection_record(
                "L21_V001/001.jpg",
                {
                    "image_width": 640,
                    "image_height": 480,
                    "boxes": [],
                    "confidences": [],
                    "class_ids": [],
                    "class_names": [],
                },
            )
        )

        self.assertEqual(
            detection.parse_remote_result(valid)["relative_path"],
            "L21_V001/001.jpg",
        )
        with self.assertRaises(ValueError):
            detection.parse_remote_result(
                valid.replace("L21_V001/001.jpg", "../escape.jpg")
            )
        with self.assertRaises(ValueError):
            detection.parse_remote_result("not-json")


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

    def aio(self, requests: tuple[tuple[bytes, str], ...]) -> _AsyncResults:
        return self.handler(requests)


class _FakeBatch:
    def __init__(self, handler: Any) -> None:
        self.starmap = _FakeStarmap(handler)


class _FakeWorker:
    def __init__(self, handler: Any) -> None:
        self.detect_batch = _FakeBatch(handler)


class ObjectDetectionRemoteTests(unittest.TestCase):
    def test_remote_window_maps_results_by_relative_path(self) -> None:
        def handler(requests: tuple[tuple[bytes, str], ...]) -> _AsyncResults:
            results = [
                json.dumps(
                    detection.build_detection_record(
                        request[1],
                        {
                            "image_width": 640,
                            "image_height": 480,
                            "boxes": [],
                            "confidences": [],
                            "class_ids": [],
                            "class_names": [],
                        },
                    )
                )
                for request in reversed(requests)
            ]
            return _AsyncResults(results)

        jobs = (
            detection.ImageJob("L21_V001/001.jpg", b"a"),
            detection.ImageJob("L21_V001/002.jpg", b"b"),
        )
        results, failures, error, _ = asyncio.run(
            detection._detect_remote_window(
                _FakeWorker(handler),
                jobs,
                max_retries=0,
            )
        )

        self.assertEqual(set(results), {job.relative_path for job in jobs})
        self.assertEqual(failures, ())
        self.assertIsNone(error)

    def test_recovery_isolates_a_malformed_image_from_good_jobs(self) -> None:
        def handler(requests: tuple[tuple[Any, ...], ...]) -> _AsyncResults:
            if any(request[0] == b"bad" for request in requests):
                raise RuntimeError("cannot identify image")
            results = [
                json.dumps(
                    detection.build_detection_record(
                        request[1],
                        {
                            "image_width": 640,
                            "image_height": 480,
                            "boxes": [],
                            "confidences": [],
                            "class_ids": [],
                            "class_names": [],
                        },
                    )
                )
                for request in requests
            ]
            return _AsyncResults(results)

        jobs = (
            detection.ImageJob("good.jpg", b"good"),
            detection.ImageJob("bad.jpg", b"bad"),
        )
        results, failures, error, _ = asyncio.run(
            detection._detect_remote_with_recovery(
                _FakeWorker(handler),
                jobs,
                max_retries=0,
            )
        )

        self.assertEqual(set(results), {"good.jpg"})
        self.assertEqual(tuple(job.relative_path for job in failures), ("bad.jpg",))
        self.assertIsNotNone(error)


if __name__ == "__main__":
    unittest.main()
