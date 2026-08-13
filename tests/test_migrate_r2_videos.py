"""Unit tests for the dry-run-safe R2 video migration helper."""

from __future__ import annotations

import hashlib
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

MODULE_PATH = Path(__file__).parents[1] / "tmp" / "migrate_r2_videos.py"
SPEC = importlib.util.spec_from_file_location("migrate_r2_videos", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MIGRATION
SPEC.loader.exec_module(MIGRATION)


class FakeR2Client:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)
        self.copy_calls: list[dict[str, Any]] = []
        self.delete_calls: list[str] = []

    def list_objects_v2(self, **kwargs: Any) -> dict[str, Any]:
        keys = sorted(self.objects)
        return {
            "Contents": [
                {
                    "Key": key,
                    "Size": len(self.objects[key]),
                    "ETag": f'"{hashlib.md5(self.objects[key]).hexdigest()}"',
                }
                for key in keys
            ],
            "IsTruncated": False,
        }

    def head_object(self, **kwargs: Any) -> dict[str, Any]:
        key = kwargs["Key"]
        if key not in self.objects:
            error = RuntimeError("not found")
            error.response = {"Error": {"Code": "404"}}  # type: ignore[attr-defined]
            raise error
        return {
            "ContentLength": len(self.objects[key]),
            "ETag": f'"{hashlib.md5(self.objects[key]).hexdigest()}"',
        }

    def copy_object(self, **kwargs: Any) -> dict[str, Any]:
        source_key = kwargs["CopySource"]["Key"]
        target_key = kwargs["Key"]
        self.copy_calls.append(kwargs)
        self.objects[target_key] = self.objects[source_key]
        return {}

    def delete_object(self, **kwargs: Any) -> dict[str, Any]:
        key = kwargs["Key"]
        self.delete_calls.append(key)
        self.objects.pop(key, None)
        return {}


class MigrationTests(unittest.TestCase):
    def test_load_env_file_parses_values_without_overriding_shell(self) -> None:
        env_file = Path(self.id().replace(".", "_") + ".env")
        try:
            env_file.write_text(
                """\n# comment\nR2_BUCKET=from-file\nR2_REGION=\"auto\" # inline comment\nexport R2_ACCESS_KEY_ID='access-value'\n""",
                encoding="utf-8",
            )
            with patch.dict(
                MIGRATION.os.environ,
                {"R2_BUCKET": "from-shell"},
                clear=True,
            ):
                MIGRATION.load_env_file(env_file)

                self.assertEqual(MIGRATION.os.environ["R2_BUCKET"], "from-shell")
                self.assertEqual(MIGRATION.os.environ["R2_REGION"], "auto")
                self.assertEqual(
                    MIGRATION.os.environ["R2_ACCESS_KEY_ID"],
                    "access-value",
                )
        finally:
            env_file.unlink(missing_ok=True)

    def test_resolve_env_file_prefers_script_directory(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".env") as env_file:
            env_path = Path(env_file.name)
            self.assertEqual(
                MIGRATION.resolve_env_file(env_path),
                env_path.resolve(),
            )

    def test_video_name_allow_list_and_destination(self) -> None:
        self.assertTrue(MIGRATION.is_video_key("L21_V001.mp4"))
        self.assertTrue(MIGRATION.is_video_key("old/path/L05_V005.mp4"))
        self.assertFalse(MIGRATION.is_video_key("L21_V001.MP4"))
        self.assertFalse(MIGRATION.is_video_key("L21_V001.json"))
        self.assertEqual(
            MIGRATION.destination_key("L21_V001.mp4"),
            "videos/L21_V001.mp4",
        )

    def test_migrate_dry_run_does_not_mutate_bucket(self) -> None:
        client = FakeR2Client(
            {
                "L21_V001.mp4": b"video",
                "metadata.json": b"metadata",
            }
        )
        config = MIGRATION.MigrationConfig(bucket="test-bucket")

        report = MIGRATION.migrate(client, config)

        self.assertTrue(report.dry_run)
        self.assertEqual(
            report.copied,
            ["L21_V001.mp4 -> videos/L21_V001.mp4"],
        )
        self.assertEqual(report.invalid_or_extra, ["metadata.json"])
        self.assertEqual(
            client.objects,
            {
                "L21_V001.mp4": b"video",
                "metadata.json": b"metadata",
            },
        )
        self.assertEqual(client.copy_calls, [])
        self.assertEqual(client.delete_calls, [])

    def test_apply_copies_and_deletes_only_with_explicit_flag(self) -> None:
        client = FakeR2Client(
            {
                "L21_V001.mp4": b"video",
                "metadata.json": b"metadata",
            }
        )
        config = MIGRATION.MigrationConfig(
            bucket="test-bucket",
            apply=True,
            delete_extra=True,
        )

        report = MIGRATION.migrate(client, config)

        self.assertIn("videos/L21_V001.mp4", client.objects)
        self.assertNotIn("L21_V001.mp4", client.objects)
        self.assertCountEqual(
            client.delete_calls,
            ["L21_V001.mp4", "metadata.json"],
        )
        self.assertCountEqual(
            report.deleted,
            ["L21_V001.mp4", "metadata.json"],
        )

    def test_delete_extra_requires_apply(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires --apply"):
            MIGRATION.MigrationConfig(bucket="test-bucket", delete_extra=True)

    def test_existing_destination_with_different_size_is_collision(self) -> None:
        client = FakeR2Client(
            {
                "L21_V001.mp4": b"video",
                "videos/L21_V001.mp4": b"different",
            }
        )
        config = MIGRATION.MigrationConfig(bucket="test-bucket", apply=True)

        report = MIGRATION.migrate(client, config)

        self.assertTrue(report.collisions)
        self.assertEqual(client.copy_calls, [])
        self.assertEqual(client.delete_calls, [])


if __name__ == "__main__":
    unittest.main()
