from __future__ import annotations

import io
import tempfile
import unittest
import zipfile
from pathlib import Path
import numpy as np
import pandas as pd
from PIL import Image

from pipelines.feature_extraction.visual_embedding.config import VisualEmbeddingConfig
from pipelines.feature_extraction.visual_embedding import modal_clip_embedding as modal_clip


class VisualEmbeddingModalTests(unittest.TestCase):
    def test_default_config_uses_clipa_v2_h14(self) -> None:
        config = VisualEmbeddingConfig()
        self.assertIn("CLIPA", config.model_name)
        self.assertIn("ViT-H-14", config.model_name)
        self.assertEqual(config.pipeline_version, "visual-embedding-clipa-v2-h14")

    def test_save_embedding_results_creates_valid_npy_and_parquet(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            out_dir = Path(temp_dir)
            video_id = "L21_V001"
            dummy_embeddings = np.random.randn(3, 1024).astype(np.float32)

            items = [
                modal_clip.LocalKeyframeItem(
                    video_id=video_id,
                    original_frame_id=0,
                    timestamp_ms=0,
                    image_path=out_dir / "000.webp",
                    segment_id=video_id,
                ),
                modal_clip.LocalKeyframeItem(
                    video_id=video_id,
                    original_frame_id=1,
                    timestamp_ms=1000,
                    image_path=out_dir / "001.webp",
                    segment_id=video_id,
                ),
                modal_clip.LocalKeyframeItem(
                    video_id=video_id,
                    original_frame_id=2,
                    timestamp_ms=2000,
                    image_path=out_dir / "002.webp",
                    segment_id=video_id,
                ),
            ]

            npy_path, pq_path = modal_clip.save_embedding_results(
                output_dir=out_dir,
                video_id=video_id,
                embeddings=dummy_embeddings,
                items=items,
                model_name=modal_clip.MODEL_NAME,
                pipeline_version=modal_clip.PIPELINE_VERSION,
            )

            self.assertTrue(npy_path.exists())
            self.assertTrue(pq_path.exists())

            loaded_npy = np.load(npy_path)
            self.assertEqual(loaded_npy.shape, (3, 1024))

            df = pd.read_parquet(pq_path)
            self.assertEqual(len(df), 3)
            self.assertEqual(df["video_id"].iloc[0], video_id)
            self.assertEqual(df["embedding_dim"].iloc[0], 1024)
            self.assertEqual(df["model_name"].iloc[0], modal_clip.MODEL_NAME)
            self.assertEqual(df["model_version"].iloc[0], modal_clip.PIPELINE_VERSION)
            self.assertEqual(df["normalized"].iloc[0], True)
            self.assertNotIn("embedding_id", df.columns)
            self.assertNotIn("timestamp_id", df.columns)

    def test_discover_keyframes_from_directory_structure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            v_dir = root / "L21_V002"
            v_dir.mkdir()

            img = Image.new("RGB", (10, 10), color="blue")
            img.save(v_dir / "001.webp")
            img.save(v_dir / "002.webp")

            discovered = modal_clip.discover_keyframes(root)
            self.assertIn("L21_V002", discovered)
            self.assertEqual(len(discovered["L21_V002"]), 2)

    def test_discover_keyframes_from_zip_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            zip_path = Path(temp_dir) / "test_archive.zip"
            with zipfile.ZipFile(zip_path, "w") as zf:
                buf = io.BytesIO()
                Image.new("RGB", (10, 10), color="red").save(buf, format="JPEG")
                img_data = buf.getvalue()
                zf.writestr("keyframes/L21_V001/001.jpg", img_data)
                zf.writestr("keyframes/L21_V001/002.jpg", img_data)
                zf.writestr("keyframes/L21_V002/001.jpg", img_data)

            discovered = modal_clip.discover_keyframes(zip_path)
            self.assertIn("L21_V001", discovered)
            self.assertIn("L21_V002", discovered)
            self.assertEqual(len(discovered["L21_V001"]), 2)
            self.assertEqual(discovered["L21_V001"][0].original_frame_id, 0)
            self.assertEqual(discovered["L21_V001"][0].timestamp_ms, 0)
            self.assertEqual(discovered["L21_V001"][1].original_frame_id, 1)
            self.assertEqual(discovered["L21_V001"][1].timestamp_ms, 1000)

    def test_parse_args_sets_defaults(self) -> None:
        cfg = modal_clip.parse_args([
            "--input-dir", "dummy_input",
            "--output-dir", "dummy_output",
            "--budget-usd", "15.0",
        ])
        self.assertEqual(cfg.input_dir, Path("dummy_input"))
        self.assertEqual(cfg.output_dir, Path("dummy_output"))
        self.assertEqual(cfg.budget_usd, 15.0)
        self.assertIn("CLIPA", cfg.model_name)
