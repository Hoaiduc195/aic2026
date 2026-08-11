import json
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
from pipelines.feature_extraction.asr.models import (
    QualityInfo,
    TranscriptChunk,
    WordTiming,
)
from pipelines.feature_extraction.asr.runner import batch_transcribe, transcribe_file
from pipelines.feature_extraction.asr.sherpa_backend import (
    _chunks_from_result,
    _pipeline_config,
    _validate_ffmpeg_tools,
)


class FakeBackend:
    model_version = "test-model"
    pipeline_version = "test-pipeline-v2"

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
                content = f"# {filename}\n"
                if filename == "punctuation_restorer_improved.py":
                    content = (
                        "import os\n"
                        "base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\n"
                    )
                (core / filename).write_text(content, encoding="utf-8")
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
            self.assertEqual(config.pipeline_version, "asr-cli-v1")
            for filename in ("encoder-test.onnx", "decoder-test.onnx", "joiner-test.onnx", "tokens.txt"):
                (models / "custom-model" / filename).write_text("asset", encoding="utf-8")
            self.assertEqual(
                resolve_model_path(models, config.model_name),
                (models / "custom-model").resolve(),
            )

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
        self.assertEqual(row["pipeline_version"], "asr-cli-v1")

        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema is not installed")
        schema = json.loads(
            Path("contracts/schemas/asr_result/schema.json").read_text(encoding="utf-8")
        )
        jsonschema.Draft202012Validator(schema).validate(row)

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

            self.assertEqual(result, output.resolve())
            self.assertIsNone(skipped)
            self.assertEqual(len(backend.calls), 1)
            self.assertEqual(len(output.read_text(encoding="utf-8").splitlines()), 1)
            self.assertEqual(
                json.loads(output.read_text(encoding="utf-8"))["pipeline_version"],
                "test-pipeline-v2",
            )

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

    def test_batch_ids_are_unique_for_duplicate_basenames(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            left = root / "left"
            right = root / "right"
            left.mkdir()
            right.mkdir()
            (left / "clip.mp4").touch()
            (right / "clip.mp4").touch()
            backend = FakeBackend(
                {
                    "clip.mp4": [TranscriptChunk(0, 500, "same")],
                }
            )

            outputs = batch_transcribe(root, root / "outputs", backend=backend, recursive=True)
            rows = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in outputs
            ]

            self.assertEqual(len(rows), 2)
            self.assertEqual(
                len({row["video_id"] for row in rows}),
                2,
            )

    def test_model_resolution_rejects_missing_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            models = Path(directory) / "models"
            models.mkdir()

            with self.assertRaisesRegex(FileNotFoundError, "model"):
                resolve_model_path(models, "missing")

    def test_sherpa_result_conversion_keeps_word_timestamps_and_quality(self):
        chunks = _chunks_from_result(
            {
                "asr_confidence": 0.82,
                "quality_info": {
                    "dnsmos_sig": 3.1,
                    "dnsmos_bak": 3.4,
                    "dnsmos_ovrl": 3.2,
                },
                "segments": [
                    {
                        "start": 1.25,
                        "end": 2.5,
                        "text": "Xin chào.",
                        "raw_words": [
                            {"text": "Xin", "start": 1.25, "end": 1.6, "prob": 0.8},
                            {"text": "chào", "start": 1.61, "end": 2.2, "prob": 0.84},
                        ],
                    }
                ],
            },
            language="vi",
            include_quality=True,
        )

        self.assertEqual(len(chunks), 1)
        self.assertEqual((chunks[0].start_ms, chunks[0].end_ms), (1250, 2500))
        self.assertEqual(chunks[0].words[1].start_ms, 1610)
        self.assertAlmostEqual(chunks[0].confidence, 0.82)
        self.assertEqual(chunks[0].quality.dnsmos_ovrl, 3.2)

    def test_pipeline_config_disables_unsupported_gui_features(self):
        runtime = _pipeline_config(
            SherpaAsrConfig(model_dir=Path("models"), punctuation=True, quality=True)
        )

        self.assertTrue(runtime["restore_punctuation"])
        self.assertTrue(runtime["auto_analyze_quality"])
        self.assertFalse(runtime["speaker_diarization"])
        self.assertFalse(runtime["overlap_separation"])

    def test_ffmpeg_check_invokes_both_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ffmpeg.exe").touch()
            (root / "ffprobe.exe").touch()
            with patch(
                "pipelines.feature_extraction.asr.sherpa_backend.subprocess.run"
            ) as run:
                _validate_ffmpeg_tools(root)

            self.assertEqual(run.call_count, 2)
            self.assertTrue(all(call.kwargs["check"] for call in run.call_args_list))


if __name__ == "__main__":
    unittest.main()
