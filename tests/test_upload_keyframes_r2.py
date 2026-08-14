"""Unit tests for the dry-run-safe keyframe uploader."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

MODULE_PATH = Path(__file__).parents[1] / "tmp" / "upload_keyframes_r2.py"
SPEC = importlib.util.spec_from_file_location("upload_keyframes_r2", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
UPLOADER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = UPLOADER
SPEC.loader.exec_module(UPLOADER)


class FakeUploadClient:
    def __init__(self, existing_keys: set[str] | None = None) -> None:
        self.existing_keys = set(existing_keys or set())
        self.upload_calls: list[dict[str, Any]] = []
        self.head_calls: list[str] = []
        self.failures_remaining: dict[str, int] = {}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        del Bucket
        self.head_calls.append(Key)
        if Key not in self.existing_keys:
            error = RuntimeError("not found")
            error.response = {"Error": {"Code": "404"}}  # type: ignore[attr-defined]
            raise error
        return {"ContentLength": 1}

    def upload_file(
        self,
        Filename: str,
        Bucket: str,
        Key: str,
        ExtraArgs: dict[str, str] | None = None,
    ) -> None:
        del Bucket
        remaining = self.failures_remaining.get(Key, 0)
        if remaining:
            self.failures_remaining[Key] = remaining - 1
            raise RuntimeError("temporary upload failure")
        self.upload_calls.append(
            {"Filename": Filename, "Key": Key, "ExtraArgs": ExtraArgs or {}}
        )


class UploadKeyframesTests(unittest.TestCase):
    def _create_keyframes(self, root: Path) -> None:
        (root / "L21_V001").mkdir(parents=True)
        (root / "L21_V001" / "0001.webp").write_bytes(b"webp")
        (root / "L21_V001" / "0002.JPG").write_bytes(b"jpg")
        (root / "ignore.txt").write_text("not an image", encoding="utf-8")

    def test_iter_keyframes_maps_relative_paths_and_filters_extensions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._create_keyframes(root)

            candidates = list(UPLOADER.iter_keyframes(root, "keyframes/"))

        self.assertEqual(
            [(candidate.key, candidate.content_type) for candidate in candidates],
            [
                ("keyframes/L21_V001/0001.webp", "image/webp"),
                ("keyframes/L21_V001/0002.JPG", "image/jpeg"),
            ],
        )

    def test_dry_run_never_calls_r2(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._create_keyframes(root)
            client = FakeUploadClient()
            config = UPLOADER.UploadConfig(
                input_dir=root,
                bucket="test-bucket",
                apply=False,
            )

            report = UPLOADER.upload_keyframes(client, config)

        self.assertTrue(report.dry_run)
        self.assertEqual(report.planned, 2)
        self.assertEqual(report.uploaded, 0)
        self.assertEqual(client.upload_calls, [])

    def test_apply_uploads_with_content_type(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._create_keyframes(root)
            client = FakeUploadClient()
            config = UPLOADER.UploadConfig(
                input_dir=root,
                bucket="test-bucket",
                apply=True,
                workers=2,
            )

            report = UPLOADER.upload_keyframes(client, config)

        self.assertFalse(report.dry_run)
        self.assertEqual(report.uploaded, 2)
        self.assertEqual(report.failed, [])
        self.assertCountEqual(
            [call["Key"] for call in client.upload_calls],
            ["keyframes/L21_V001/0001.webp", "keyframes/L21_V001/0002.JPG"],
        )
        content_types = {call["ExtraArgs"]["ContentType"] for call in client.upload_calls}
        self.assertEqual(content_types, {"image/webp", "image/jpeg"})

    def test_retry_recovers_from_transient_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._create_keyframes(root)
            client = FakeUploadClient()
            client.failures_remaining["keyframes/L21_V001/0001.webp"] = 1
            config = UPLOADER.UploadConfig(
                input_dir=root,
                bucket="test-bucket",
                apply=True,
                retries=1,
            )

            report = UPLOADER.upload_keyframes(
                client,
                config,
                sleep=lambda _: None,
            )

        self.assertEqual(report.uploaded, 2)
        self.assertEqual(report.failed, [])

    def test_failed_file_is_reported_while_other_files_continue(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._create_keyframes(root)
            client = FakeUploadClient()
            client.failures_remaining["keyframes/L21_V001/0001.webp"] = 3
            config = UPLOADER.UploadConfig(
                input_dir=root,
                bucket="test-bucket",
                apply=True,
                retries=1,
            )

            report = UPLOADER.upload_keyframes(
                client,
                config,
                sleep=lambda _: None,
            )

        self.assertEqual(report.uploaded, 1)
        self.assertEqual(len(report.failed), 1)
        self.assertEqual(report.failed[0]["key"], "keyframes/L21_V001/0001.webp")

    def test_main_dry_run_does_not_build_an_r2_client(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._create_keyframes(root)
            report_path = root / "report.json"
            with patch.object(
                UPLOADER,
                "build_client",
                side_effect=AssertionError("dry-run must not build a client"),
            ):
                exit_code = UPLOADER.main(
                    [
                        "--input-dir",
                        str(root),
                        "--bucket",
                        "test-bucket",
                        "--report",
                        str(report_path),
                    ]
                )

            self.assertEqual(exit_code, 0)
            self.assertTrue(report_path.is_file())

    def test_skip_existing_avoids_uploading_existing_object(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._create_keyframes(root)
            client = FakeUploadClient({"keyframes/L21_V001/0001.webp"})
            config = UPLOADER.UploadConfig(
                input_dir=root,
                bucket="test-bucket",
                apply=True,
                skip_existing=True,
            )

            report = UPLOADER.upload_keyframes(client, config)

        self.assertEqual(report.skipped, 1)
        self.assertEqual(report.uploaded, 1)
        self.assertEqual(
            [call["Key"] for call in client.upload_calls],
            ["keyframes/L21_V001/0002.JPG"],
        )

    def test_config_rejects_a_prefix_outside_keyframes(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(
            ValueError, "keyframes/"
        ):
            UPLOADER.UploadConfig(
                input_dir=Path(directory),
                bucket="test-bucket",
                target_prefix="videos/",
            )

    def test_normalize_extensions_accepts_spaces_and_missing_dots(self) -> None:
        self.assertEqual(
            UPLOADER.normalize_extensions([" WEBP ", "jpg"]),
            frozenset({".webp", ".jpg"}),
        )


if __name__ == "__main__":
    unittest.main()
