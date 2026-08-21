from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from pipelines.feature_extraction.ocr import modal_paddleocr as ocr


class OcrPlanningTests(unittest.TestCase):
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

            result = ocr.iter_images(root)

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
            ocr.partition_paths(paths, batch_index=index, num_batches=3)
            for index in range(3)
        )

        self.assertEqual(tuple(len(partition) for partition in partitions), (3, 2, 2))
        self.assertEqual(set().union(*map(set, partitions)), set(paths))
        self.assertEqual(sum(len(set(partition)) for partition in partitions), len(paths))

    def test_output_path_preserves_layout_and_rejects_nested_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_dir = root / "frames"
            output_dir = root / "ocr"
            image_path = input_dir / "L21_V001" / "001.jpg"

            self.assertEqual(
                ocr.ocr_path_for(input_dir, output_dir, image_path),
                output_dir / "L21_V001" / "001.json",
            )
            ocr.validate_directory_layout(input_dir, output_dir)
            with self.assertRaises(ValueError):
                ocr.validate_directory_layout(input_dir, input_dir / "ocr")

    def test_validation_rejects_invalid_ranges(self) -> None:
        with self.assertRaises(ValueError):
            ocr.validate_options(batch_size=0, max_retries=2, max_images=0)
        with self.assertRaises(ValueError):
            ocr.validate_options(batch_size=8, max_retries=-1, max_images=0)
        with self.assertRaises(ValueError):
            ocr.validate_options(batch_size=8, max_retries=2, max_images=-1)

    def test_model_configuration_supports_vietnamese_and_english_on_t4(self) -> None:
        self.assertEqual(ocr.DEFAULT_GPU_TYPE, "T4")
        self.assertEqual(ocr.DETECTION_MODEL_VERSION, "PP-OCRv6")
        self.assertEqual(ocr.DETECTION_MODEL_NAME, "PP-OCRv6_small_det")
        self.assertEqual(ocr.PADDLEPADDLE_VERSION, "3.2.1")
        self.assertEqual(
            ocr.PADDLE_BASE_IMAGE,
            "paddlepaddle/paddle:3.2.1-gpu-cuda11.8-cudnn8.9",
        )
        self.assertEqual(ocr.PADDLEOCR_VERSION, "3.7.0")
        self.assertEqual(
            ocr.OPENCV_SYSTEM_PACKAGES,
            (
                "libgl1",
                "libglib2.0-0",
                "libsm6",
                "libxext6",
                "libxrender1",
            ),
        )
        self.assertEqual(ocr.SUPPORTED_LANGUAGES, ("vi",))
        self.assertEqual(ocr.LANGUAGE, "vi")
        self.assertEqual(ocr.RECOGNITION_BACKEND, "paddleocr")
        self.assertEqual(
            ocr.RECOGNITION_MODEL_NAME,
            "latin_PP-OCRv5_mobile_rec",
        )
        self.assertEqual(ocr.RECOGNITION_BATCH_SIZE, 64)

    def test_detection_options_match_paddleocr_37_api(self) -> None:
        options = ocr.build_detection_options(
            model_name="PP-OCRv6_small_det",
            engine=None,
            enable_hpi=False,
            use_tensorrt=False,
            precision="fp32",
            threshold=0.3,
        )

        self.assertEqual(options["model_name"], "PP-OCRv6_small_det")
        self.assertIsNone(options["limit_side_len"])
        self.assertIsNone(options["limit_type"])
        self.assertEqual(options["thresh"], 0.3)
        self.assertEqual(options["box_thresh"], 0.3)
        self.assertNotIn("max_side_limit", options)

    def test_modal_image_bootstraps_pyyaml_before_paddleocr(self) -> None:
        self.assertEqual(ocr.PYYAML_REQUIREMENT, "PyYAML>=6.0,<7")
        self.assertEqual(ocr.PYYAML_BOOTSTRAP_OPTIONS, "--ignore-installed")

    def test_format_fps_is_stable_for_positive_and_empty_durations(self) -> None:
        self.assertEqual(ocr.format_fps(120, 30.0), "4.00")
        self.assertEqual(ocr.format_fps(1, 0.0), "0.00")
        self.assertEqual(ocr.format_fps(0, 2.0), "0.00")

    def test_recognition_result_keeps_detection_polygons_and_recognition_order(self) -> None:
        polygon = [[10, 20], [200, 20], [200, 50], [10, 50]]

        result = ocr.assemble_recognition_result(
            {"dt_polys": [polygon]},
            ["Xin chào"],
            [0.91],
        )

        self.assertEqual(result["dt_polys"], [polygon])
        self.assertEqual(result["rec_texts"], ["Xin chào"])
        self.assertEqual(result["rec_scores"], [0.91])

    def test_extract_recognition_result_preserves_vietnamese_unicode(self) -> None:
        text, score = ocr.extract_recognition_result(
            {"res": {"rec_text": "Cửa hàng tiện lợi", "rec_score": 0.93}}
        )

        self.assertEqual(text, "Cửa hàng tiện lợi")
        self.assertEqual(score, 0.93)

    def test_dry_run_does_not_require_modal_or_write_results(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_dir = root / "frames"
            output_dir = root / "ocr"
            input_dir.mkdir()
            (input_dir / "001.jpg").write_bytes(b"not-decoded-yet")

            asyncio.run(
                ocr.ocr_directory(
                    input_dir=input_dir,
                    output_dir=output_dir,
                    max_images=1,
                    dry_run=True,
                )
            )

            self.assertFalse(output_dir.exists())


class OcrResultTests(unittest.TestCase):
    def test_build_ocr_record_keeps_vietnamese_diacritics_and_boxes(self) -> None:
        record = ocr.build_ocr_record(
            "L21_V001/001.jpg",
            {
                "rec_texts": ["Xin chào Việt Nam", ""],
                "rec_scores": [0.96, 0.12],
                "rec_polys": [
                    [[10, 20], [200, 20], [200, 50], [10, 50]],
                    [[1, 2], [3, 2], [3, 4], [1, 4]],
                ],
            },
        )

        self.assertEqual(record["relative_path"], "L21_V001/001.jpg")
        self.assertEqual(record["text"], "Xin chào Việt Nam")
        self.assertEqual(record["normalized_text"], "xin chào việt nam")
        self.assertEqual(len(record["boxes"]), 1)
        self.assertEqual(record["boxes"][0]["confidence"], 0.96)
        self.assertEqual(record["language"], "vi")

    def test_build_ocr_record_supports_empty_frame_without_fabricating_text(self) -> None:
        record = ocr.build_ocr_record(
            "001.jpg",
            {"rec_texts": [], "rec_scores": [], "rec_polys": []},
        )

        self.assertEqual(record["text"], "")
        self.assertEqual(record["normalized_text"], "")
        self.assertEqual(record["boxes"], [])
        self.assertEqual(record["confidence"], 0.0)

    def test_parse_remote_result_rejects_unknown_or_unsafe_identity(self) -> None:
        valid = json.dumps(
            {
                "relative_path": "L21_V001/001.jpg",
                "text": "Xin chào",
                "normalized_text": "xin chào",
                "boxes": [],
                "confidence": 0.9,
            },
            ensure_ascii=False,
        )

        self.assertEqual(ocr.parse_remote_result(valid)["text"], "Xin chào")
        with self.assertRaises(ValueError):
            ocr.parse_remote_result(
                json.dumps(
                    {
                        "relative_path": "../escape.jpg",
                        "text": "x",
                        "normalized_text": "x",
                        "boxes": [],
                        "confidence": 0.9,
                    }
                )
            )
        with self.assertRaises(ValueError):
            ocr.parse_remote_result("not-json")


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
        self.ocr_batch = _FakeBatch(handler)


class OcrRemoteTests(unittest.TestCase):
    def test_remote_window_maps_results_by_relative_path(self) -> None:
        def handler(requests: tuple[tuple[bytes, str], ...]) -> _AsyncResults:
            results = [
                json.dumps(
                    {
                        "relative_path": request[1],
                        "text": request[1],
                        "normalized_text": request[1].casefold(),
                        "boxes": [],
                        "confidence": 0.9,
                    }
                )
                for request in reversed(requests)
            ]
            return _AsyncResults(results)

        jobs = (
            ocr.ImageJob("L21_V001/001.jpg", b"a"),
            ocr.ImageJob("L21_V001/002.jpg", b"b"),
        )
        results, failures, error, _ = asyncio.run(
            ocr._ocr_remote_window(
                _FakeWorker(handler),
                jobs,
                max_retries=0,
            )
        )

        self.assertEqual(set(results), {job.relative_path for job in jobs})
        self.assertEqual(failures, ())
        self.assertIsNone(error)


if __name__ == "__main__":
    unittest.main()
