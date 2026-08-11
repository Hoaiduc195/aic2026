import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pipelines.feature_extraction.asr.config import (
    SherpaAsrConfig,
    load_sherpa_config,
    resolve_model_path,
)
from pipelines.feature_extraction.asr.installer import (
    CORE_SOURCE_FILES,
    install_sherpa_core,
)
from pipelines.feature_extraction.asr.io import write_canonical_asr_jsonl
from pipelines.feature_extraction.asr.models import QualityInfo, TranscriptChunk, WordTiming
from pipelines.feature_extraction.asr.runner import batch_transcribe, transcribe_file


class FakeBackend:
    model_version = "test-model"

    def __init__(self, chunks_by_name):
        self.chunks_by_name = chunks_by_name
        self.calls = []

    def transcribe(self, audio_path):
        self.calls.append(audio_path)
        return self.chunks_by_name.get(audio_path.name, [])


class SherpaAsrCliTest(unittest.TestCase):
    def test_installer_copies_only_core_allowlist_and_headless_analyzer(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sherpa"
            core = source / "core"
            core.mkdir(parents=True)
            for filename in CORE_SOURCE_FILES:
                (core / filename).write_text(f"# {filename}\n", encoding="utf-8")
            (source / "app.py").write_text("from PyQt6 import QtWidgets\n", encoding="utf-8")
            (core / "audio_analyzer.py").write_text(
                "from PyQt6.QtCore import QThread\n", encoding="utf-8"
            )

            target = Path(directory) / "vendor" / "core"
            manifest = install_sherpa_core(source, target)

            self.assertEqual(manifest.target_dir, str(target.resolve()))
            self.assertTrue((target / "asr_engine.py").exists())
            self.assertTrue((target / "audio_analyzer.py").exists())
            self.assertFalse((target / "app.py").exists())
            self.assertNotIn("PyQt6", (target / "audio_analyzer.py").read_text(encoding="utf-8"))
            self.assertTrue((target / "install-manifest.json").exists())

    def test_installer_rejects_source_without_asr_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sherpa"
            (source / "core").mkdir(parents=True)

            with self.assertRaisesRegex(FileNotFoundError, "asr_engine.py"):
                install_sherpa_core(source, Path(directory) / "target")

    def test_config_reads_ini_and_resolves_model_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.ini"
            config_path.write_text(
                "[asr]\n"
                "model_name = custom-model\n"
                "cpu_threads = 6\n"
                "punctuation = false\n"
                "quality = true\n",
                encoding="utf-8",
            )
            config = load_sherpa_config(config_path)
            models = Path(directory) / "models"
            (models / "custom-model").mkdir(parents=True)

            self.assertEqual(config.model_name, "custom-model")
            self.assertEqual(config.cpu_threads, 6)
            self.assertFalse(config.punctuation)
            self.assertTrue(config.quality)
            self.assertEqual(resolve_model_path(models, config.model_name), models / "custom-model")

    def test_canonical_jsonl_contains_timestamps_words_confidence_and_quality(self):
        chunk = TranscriptChunk(
            1200,
            2500,
            "Xin chào.",
            0.91,
            words=(WordTiming("Xin", 1200, 1600, 0.9),),
            text_raw="xin chao",
            quality=QualityInfo(
                asr_confidence=0.91,
                dnsmos_sig=3.8,
                dnsmos_bak=3.4,
                dnsmos_ovrl=3.6,
                ready=True,
            ),
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.jsonl"
            write_canonical_asr_jsonl(
                [chunk], output, video_id="video_01", model_version="test-model"
            )
            row = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(row["start_ms"], 1200)
        self.assertEqual(row["end_ms"], 2500)
        self.assertEqual(row["text_raw"], "xin chao")
        self.assertEqual(row["text_normalized"], "Xin chào.")
        self.assertEqual(row["words"][0]["confidence"], 0.9)
        self.assertEqual(row["quality"]["dnsmos_ovrl"], 3.6)
        self.assertEqual(row["producer"], "sherpa-vietnamese-asr")

    def test_transcribe_file_writes_sidecar_and_skips_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "clip one.mp4"
            media.touch()
            output = root / "out" / "clip one.asr.jsonl"
            chunk = TranscriptChunk(0, 1000, "hello", 0.7)
            backend = FakeBackend({media.name: [chunk]})

            result = transcribe_file(media, output, backend=backend)
            skipped = transcribe_file(media, output, backend=backend)

            self.assertEqual(result, output)
            self.assertIsNone(skipped)
            self.assertEqual(len(backend.calls), 1)
            self.assertEqual(len(output.read_text(encoding="utf-8").splitlines()), 1)

    def test_batch_processes_direct_media_and_can_recurse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nested = root / "nested"
            nested.mkdir()
            first = root / "first.wav"
            second = nested / "second.mp4"
            ignored = nested / "notes.txt"
            first.touch()
            second.touch()
            ignored.touch()
            backend = FakeBackend(
                {
                    first.name: [TranscriptChunk(0, 500, "one")],
                    second.name: [TranscriptChunk(500, 1000, "two")],
                }
            )

            direct = batch_transcribe(root, root / "outputs", backend=backend)
            recursive = batch_transcribe(
                root, root / "recursive-outputs", backend=backend, recursive=True
            )

            self.assertEqual(len(direct), 1)
            self.assertEqual(len(recursive), 2)
            self.assertEqual(len(backend.calls), 3)
            self.assertTrue((root / "recursive-outputs" / "nested" / "second.asr.jsonl").exists())

    def test_model_resolution_rejects_missing_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            models = Path(directory) / "models"
            models.mkdir()

            with self.assertRaisesRegex(FileNotFoundError, "model"):
                resolve_model_path(models, "missing")


if __name__ == "__main__":
    unittest.main()
