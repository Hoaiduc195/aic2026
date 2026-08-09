import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from pipelines.preprocessing.cli import (
    _config_from_args,
    _explicit_source_uris,
    _load_environment_file,
    _normalise_video_manifest,
    _read_manifest_table,
    build_parser,
)
from pipelines.preprocessing.config import PipelineConfig
from pipelines.preprocessing.store import OutputStore


class PreprocessingCliTest(unittest.TestCase):
    def test_normalises_curated_r2_manifest_without_local_path(self):
        manifest = pd.DataFrame([{
            "video_id": "L01_V001",
            "original_filename": "L01_V001.mp4",
            "storage_uri": "r2://raw-videos/L01_V001.mp4",
            "duration_ms": 10_000,
            "fps_str": "30000/1001",
            "width": 1920,
            "height": 1080,
        }])

        result = _normalise_video_manifest(manifest)

        self.assertAlmostEqual(result.loc[0, "duration_s"], 10.0)
        self.assertAlmostEqual(result.loc[0, "fps"], 30000 / 1001)
        self.assertEqual(result.loc[0, "n_frames_est"], 300)

    def test_manifest_requires_exact_positive_fractional_fps(self):
        base = {
            "video_id": "video",
            "storage_uri": "r2://bucket/video.mp4",
            "duration_ms": 1000,
            "width": 1920,
            "height": 1080,
        }
        with self.assertRaisesRegex(ValueError, "cannot be reconstructed"):
            _normalise_video_manifest(pd.DataFrame([{**base, "fps": 29.97}]))
        for invalid in ("0/1", "29.97", "30000/0", "-25/1", 25.0):
            with self.subTest(fps_str=invalid), self.assertRaisesRegex(
                ValueError, "positive fraction"
            ):
                _normalise_video_manifest(pd.DataFrame([{**base, "fps_str": invalid}]))

        result = _normalise_video_manifest(pd.DataFrame([{
            **base,
            "fps_str": "30000/1001",
            "fps": 30.0,
        }]))
        self.assertEqual(result.loc[0, "fps_str"], "30000/1001")
        self.assertAlmostEqual(result.loc[0, "fps"], 30000 / 1001)

    def test_reads_singleton_and_array_json_manifests(self):
        records = [{
            "video_id": "video-1",
            "storage_uri": "r2://bucket/video-1.mp4",
            "duration_ms": 1000,
            "fps_str": "25/1",
        }]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            singleton = root / "singleton.json"
            array = root / "array.json"
            singleton.write_text(json.dumps(records[0]), encoding="utf-8")
            array.write_text(json.dumps(records), encoding="utf-8")

            self.assertEqual(_read_manifest_table(str(singleton)).to_dict("records"), records)
            self.assertEqual(_read_manifest_table(str(array)).to_dict("records"), records)

    def test_rejects_duplicate_unsafe_ids_and_runtime_unsupported_uris(self):
        base = {
            "video_id": "video",
            "storage_uri": "r2://bucket/video.mp4",
            "duration_ms": 1000,
            "fps_str": "25/1",
        }
        with self.assertRaisesRegex(ValueError, "duplicate"):
            _normalise_video_manifest(pd.DataFrame([base, base]))
        with self.assertRaisesRegex(ValueError, "unsafe"):
            _normalise_video_manifest(pd.DataFrame([{**base, "video_id": "../escape"}]))
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            _normalise_video_manifest(
                pd.DataFrame([{**base, "storage_uri": "https://example.com/video.mp4"}])
            )
        with self.assertRaisesRegex(ValueError, "canonical"):
            _normalise_video_manifest(
                pd.DataFrame([{**base, "storage_uri": "D:/videos/video.mp4"}])
            )

    def test_negative_limit_is_rejected_by_argparse(self):
        with self.assertRaises(SystemExit):
            build_parser().parse_args(["extract", "--limit", "-1"])

    def test_dino_cli_and_config_validation(self):
        args = build_parser().parse_args([
            "extract",
            "--dino-mode",
            "cluster_medoids",
            "--dino-similarity-threshold",
            "0.82",
        ])
        self.assertEqual(args.dino_mode, "cluster_medoids")
        self.assertAlmostEqual(args.dino_similarity_threshold, 0.82)
        PipelineConfig(
            dino_mode="dedup",
            dino_batch_size=2,
            dino_similarity_threshold=0.9,
        ).validate()
        for config in (
            PipelineConfig(dino_mode="unknown"),
            PipelineConfig(dino_model=""),
            PipelineConfig(dino_batch_size=0),
            PipelineConfig(dino_similarity_threshold=1.1),
        ):
            with self.assertRaises(ValueError):
                config.validate()

    def test_explicit_env_file_bridges_r2_console_names_without_secret_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(
                "R2_ACCOUNT_ID=abc123\n"
                "R2_ACCESS_KEY_ID=access-value\n"
                "R2_SECRET_ACCESS_KEY=secret-value\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {}, clear=True):
                args = build_parser().parse_args([
                    "frames",
                    "--env-file",
                    str(env_file),
                ])
                _load_environment_file(args.env_file)
                cfg = _config_from_args(args)

                self.assertEqual(os.environ["AWS_ACCESS_KEY_ID"], "access-value")
                self.assertEqual(os.environ["AWS_SECRET_ACCESS_KEY"], "secret-value")
                self.assertEqual(
                    cfg.r2_endpoint_url,
                    "https://abc123.r2.cloudflarestorage.com",
                )

        with patch.dict(
            os.environ,
            {"AWS_ACCESS_KEY_ID": "existing", "R2_ACCESS_KEY_ID": "r2-value"},
            clear=True,
        ):
            _load_environment_file(None)
            self.assertEqual(os.environ["AWS_ACCESS_KEY_ID"], "existing")

    def test_explicit_source_uri_flags_and_file_are_combined(self):
        with tempfile.TemporaryDirectory() as directory:
            uri_file = Path(directory) / "sources.txt"
            uri_file.write_text(
                "# one URI per line\n"
                "r2://bucket/folder/b.mp4\n",
                encoding="utf-8",
            )
            args = build_parser().parse_args([
                "frames",
                "--source-uri",
                "r2://bucket/folder/a.mp4",
                "--source-uri-file",
                str(uri_file),
            ])
            self.assertEqual(
                _explicit_source_uris(args),
                [
                    "r2://bucket/folder/a.mp4",
                    "r2://bucket/folder/b.mp4",
                ],
            )

            duplicate_args = build_parser().parse_args([
                "frames",
                "--source-uri",
                "r2://bucket/folder/b.mp4",
                "--source-uri-file",
                str(uri_file),
            ])
            with self.assertRaisesRegex(ValueError, "duplicates"):
                _explicit_source_uris(duplicate_args)

    def test_source_options_are_scoped_by_scheme(self):
        cfg = PipelineConfig(
            r2_endpoint_url="https://account.r2.cloudflarestorage.com",
            r2_region_name="auto",
            s3_region_name="ap-southeast-1",
        )

        self.assertEqual(
            cfg.video_source_kwargs("r2://bucket/video.mp4"),
            {
                "endpoint_url": "https://account.r2.cloudflarestorage.com",
                "region_name": "auto",
            },
        )
        self.assertEqual(
            cfg.video_source_kwargs("s3://bucket/video.mp4"),
            {"region_name": "ap-southeast-1"},
        )
        self.assertEqual(cfg.video_source_kwargs("file:///D:/video.mp4"), {})

    def test_storage_endpoints_require_safe_transport_and_no_credentials(self):
        for endpoint in (
            "https://account.r2.cloudflarestorage.com",
            "http://localhost:9000",
            "http://127.0.0.1:9000",
            "http://[::1]:9000",
        ):
            with self.subTest(endpoint=endpoint):
                PipelineConfig(r2_endpoint_url=endpoint).validate()

        for endpoint in (
            "http://account.r2.cloudflarestorage.com",
            "https://user:secret@account.r2.cloudflarestorage.com",
            "https://account.r2.cloudflarestorage.com?token=secret",
            "https://account.r2.cloudflarestorage.com/#fragment",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                PipelineConfig(s3_endpoint_url=endpoint).validate()

    def test_store_rejects_path_traversal_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            store = OutputStore(directory)
            with self.assertRaises(ValueError):
                store.frame_manifest_path("../escape")
            self.assertEqual(
                store.frame_manifest_path("L01_V001"),
                Path(directory) / "frame_manifests" / "L01_V001.parquet",
            )


if __name__ == "__main__":
    unittest.main()
