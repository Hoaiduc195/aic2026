import json
import math
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from pipelines.feature_extraction.asr.cli import _resolve_audio_path, main
from pipelines.feature_extraction.asr.io import (
    chunks_to_results,
    write_asr_results_jsonl,
    write_asr_results_parquet,
)
from pipelines.feature_extraction.asr.models import TranscriptChunk
from pipelines.feature_extraction.asr.transcriber import (
    JsonTranscriptBackend,
    WhisperBackend,
    demux_audio_to_wav,
)


class AsrModuleTest(unittest.TestCase):
    def test_rejects_nan_confidence(self):
        with self.assertRaisesRegex(ValueError, "confidence"):
            TranscriptChunk(0, 1000, "noi dung", float("nan"))

    def test_json_transcript_backend_accepts_seconds_timestamps(self):
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "transcript.json"
            transcript_path.write_text(
                json.dumps({("seg" + "ments"): [{"start": 1.25, "end": 2.5, "text": "noi dung"}]}),
                encoding="utf-8",
            )

            chunks = list(JsonTranscriptBackend(transcript_path).transcribe(Path("ignored.wav")))

        self.assertEqual(chunks, [TranscriptChunk(1250, 2500, "noi dung", 0.0)])

    def test_faster_whisper_model_is_cached_and_confidence_uses_avg_logprob(self):
        chunk = types.SimpleNamespace(
            start=0.25,
            end=1.5,
            text=" xin chao ",
            avg_logprob=math.log(0.8),
            no_speech_prob=0.95,
        )
        model = Mock()
        model.transcribe.return_value = ([chunk], object())
        whisper_model = Mock(return_value=model)
        fake_module = types.SimpleNamespace(WhisperModel=whisper_model)
        backend = WhisperBackend(implementation="faster-whisper")

        with patch.dict(sys.modules, {"faster_whisper": fake_module}):
            first = list(backend.transcribe(Path("first.wav")))
            second = list(backend.transcribe(Path("second.wav")))

        whisper_model.assert_called_once_with("small", device="auto")
        self.assertEqual(model.transcribe.call_count, 2)
        self.assertAlmostEqual(first[0].confidence, 0.8)
        self.assertAlmostEqual(second[0].confidence, 0.8)

    def test_openai_whisper_model_is_cached_and_confidence_uses_avg_logprob(self):
        model = Mock()
        model.transcribe.return_value = {
            ("seg" + "ments"): [
                {
                    "start": 0.0,
                    "end": 1.0,
                    "text": "hello",
                    "avg_logprob": math.log(0.6),
                }
            ]
        }
        load_model = Mock(return_value=model)
        fake_module = types.SimpleNamespace(load_model=load_model)
        backend = WhisperBackend(implementation="openai-whisper")

        with patch.dict(sys.modules, {"whisper": fake_module}):
            chunks = list(backend.transcribe(Path("first.wav")))
            list(backend.transcribe(Path("second.wav")))

        load_model.assert_called_once_with("small", device=None)
        self.assertAlmostEqual(chunks[0].confidence, 0.6)

    def test_transcript_json_cli_emits_timeline_only_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript_path = root / "transcript.json"
            output_path = root / "asr.jsonl"
            transcript_path.write_text(
                json.dumps([{"start": 0, "end": 1, "text": "hello"}]),
                encoding="utf-8",
            )
            argv = [
                "asr",
                "--video-id", "video_1",
                "--output", str(output_path),
                "--backend", "transcript-json",
                "--transcript-json", str(transcript_path),
            ]

            with patch.object(sys, "argv", argv):
                main()

            rows = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]

        self.assertEqual(rows[0]["video_id"], "video_1")
        self.assertEqual(rows[0]["start_ms"], 0)
        self.assertEqual(rows[0]["end_ms"], 1000)

    def test_rejects_video_id_that_can_escape_workdir(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "input.mp4"
            video.touch()
            with patch("pipelines.feature_extraction.asr.cli.demux_audio_to_wav") as demux:
                with self.assertRaisesRegex(ValueError, "video_id"):
                    _resolve_audio_path("../outside", None, video, root / "work")
            demux.assert_not_called()

    def test_empty_parquet_keeps_timeline_schema(self):
        captured = {}

        class FakeDataFrame:
            def __init__(self, data, columns=None):
                captured["data"] = data
                captured["columns"] = columns

            def to_parquet(self, path, index):
                captured["path"] = path
                captured["index"] = index

        def fake_series(*, dtype):
            return types.SimpleNamespace(dtype=dtype)

        fake_pandas = types.SimpleNamespace(DataFrame=FakeDataFrame, Series=fake_series)
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            sys.modules, {"pandas": fake_pandas}
        ):
            output = Path(directory) / "empty.parquet"
            write_asr_results_parquet([], output)

        self.assertEqual(
            list(captured["data"]),
            ["video_id", "start_ms", "end_ms", "text_raw", "text_normalized", "language", "confidence"],
        )
        self.assertEqual(captured["data"]["start_ms"].dtype, "int64")
        self.assertEqual(captured["data"]["confidence"].dtype, "float64")

    def test_converts_chunks_to_independent_timeline_spans(self):
        results = chunks_to_results(
            [TranscriptChunk(0, 1000, " hello ", 0.7)],
            video_id="video_1",
            model_version="test-model",
        )
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].to_dict()["text_normalized"], "hello")

        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "asr.jsonl"
            write_asr_results_jsonl(results, output_path)
            row = json.loads(output_path.read_text(encoding="utf-8").strip())
        self.assertEqual(row["start_ms"], 0)
        self.assertEqual(row["end_ms"], 1000)

    def test_demux_uses_timeout_and_cleans_temporary_output_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "input.mp4"
            output = root / "audio.wav"
            video.touch()

            def time_out(command, **kwargs):
                Path(command[-1]).write_bytes(b"partial")
                raise subprocess.TimeoutExpired(command, kwargs.get("timeout", 0))

            with patch("pipelines.feature_extraction.asr.transcriber.subprocess.run", side_effect=time_out) as run:
                with self.assertRaises(subprocess.TimeoutExpired):
                    demux_audio_to_wav(video, output)

            self.assertIn("timeout", run.call_args.kwargs)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob("*.tmp*")), [])


if __name__ == "__main__":
    unittest.main()
