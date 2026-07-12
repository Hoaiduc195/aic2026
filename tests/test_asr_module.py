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
    read_segments_json,
    write_asr_results_jsonl,
    write_asr_results_parquet,
)
from pipelines.feature_extraction.asr.models import Segment, TranscriptChunk
from pipelines.feature_extraction.asr.segment_mapping import map_transcripts_to_segments
from pipelines.feature_extraction.asr.transcriber import (
    JsonTranscriptBackend,
    WhisperBackend,
    demux_audio_to_wav,
)


class AsrModuleTest(unittest.TestCase):
    def test_rejects_nan_confidence(self):
        with self.assertRaisesRegex(ValueError, "confidence"):
            TranscriptChunk(0, 1000, "noi dung", float("nan"))

    def test_maps_transcript_to_overlapping_segments_with_clipped_timestamps(self):
        segments = [
            Segment("video_1", "seg_1", 0, 5000),
            Segment("video_1", "seg_2", 5000, 10000),
        ]
        transcripts = [TranscriptChunk(4500, 6500, "xin chao", 0.8)]

        results = map_transcripts_to_segments("video_1", transcripts, segments)

        self.assertEqual([result.segment_id for result in results], ["seg_1", "seg_2"])
        self.assertEqual(results[0].asr_start_ms, 4500)
        self.assertEqual(results[0].asr_end_ms, 5000)
        self.assertEqual(results[1].asr_start_ms, 5000)
        self.assertEqual(results[1].asr_end_ms, 6500)
        self.assertEqual(results[1].text, "xin chao")

    def test_ignores_transcript_without_segment_overlap(self):
        segments = [Segment("video_1", "seg_1", 0, 5000)]
        transcripts = [TranscriptChunk(6000, 7000, "ngoai segment")]

        results = map_transcripts_to_segments("video_1", transcripts, segments)

        self.assertEqual(results, [])

    def test_rejects_segments_from_different_video(self):
        segments = [Segment("other_video", "seg_1", 0, 5000)]
        transcripts = [TranscriptChunk(0, 1000, "noi dung")]

        with self.assertRaisesRegex(ValueError, "different video_id"):
            map_transcripts_to_segments("video_1", transcripts, segments)

    def test_skips_blank_transcript_text(self):
        segments = [Segment("video_1", "seg_1", 0, 5000)]
        transcripts = [TranscriptChunk(0, 1000, "   ")]

        results = map_transcripts_to_segments("video_1", transcripts, segments)

        self.assertEqual(results, [])

    def test_json_transcript_backend_accepts_seconds_timestamps(self):
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "transcript.json"
            transcript_path.write_text(
                json.dumps({"segments": [{"start": 1.25, "end": 2.5, "text": "noi dung"}]}),
                encoding="utf-8",
            )

            chunks = list(JsonTranscriptBackend(transcript_path).transcribe(Path("ignored.wav")))

        self.assertEqual(chunks, [TranscriptChunk(1250, 2500, "noi dung", 0.0)])

    def test_faster_whisper_model_is_cached_and_confidence_uses_avg_logprob(self):
        segment = types.SimpleNamespace(
            start=0.25,
            end=1.5,
            text=" xin chao ",
            avg_logprob=math.log(0.8),
            no_speech_prob=0.95,
        )
        model = Mock()
        model.transcribe.return_value = ([segment], object())
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
            "segments": [
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

    def test_transcript_json_cli_does_not_require_audio_or_video(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript_path = root / "transcript.json"
            segments_path = root / "segments.json"
            output_path = root / "asr.jsonl"
            transcript_path.write_text(
                json.dumps([{"start": 0, "end": 1, "text": "hello"}]),
                encoding="utf-8",
            )
            segments_path.write_text(
                json.dumps(
                    [{"video_id": "video_1", "segment_id": "seg_1", "segment_start_ms": 0, "segment_end_ms": 1000}]
                ),
                encoding="utf-8",
            )
            argv = [
                "asr",
                "--video-id", "video_1",
                "--segments", str(segments_path),
                "--output", str(output_path),
                "--backend", "transcript-json",
                "--transcript-json", str(transcript_path),
            ]

            with patch.object(sys, "argv", argv):
                main()

            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8")), {
                "video_id": "video_1",
                "segment_id": "seg_1",
                "asr_start_ms": 0,
                "asr_end_ms": 1000,
                "text": "hello",
                "confidence": 0.0,
            })

    def test_rejects_video_id_that_can_escape_workdir(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "input.mp4"
            video.touch()
            with patch("pipelines.feature_extraction.asr.cli.demux_audio_to_wav") as demux:
                with self.assertRaisesRegex(ValueError, "video_id"):
                    _resolve_audio_path("../outside", None, video, root / "work")
            demux.assert_not_called()

    def test_mapping_preserves_chunk_order_with_unsorted_segments(self):
        segments = [
            Segment("video_1", "late", 1000, 2000),
            Segment("video_1", "early", 0, 1000),
        ]
        chunks = [
            TranscriptChunk(500, 1500, "crosses"),
            TranscriptChunk(1500, 1750, "late only"),
        ]

        results = map_transcripts_to_segments("video_1", chunks, segments)

        self.assertEqual(
            [(row.segment_id, row.text) for row in results],
            [("early", "crosses"), ("late", "crosses"), ("late", "late only")],
        )

    def test_mapping_skips_segments_that_end_before_chunk(self):
        segments = [
            Segment("video_1", f"seg_{index}", index * 1000, (index + 1) * 1000)
            for index in range(100)
        ]
        chunk = TranscriptChunk(99_100, 99_500, "last")

        with patch(
            "pipelines.feature_extraction.asr.segment_mapping._overlap_ms",
            wraps=lambda left_start, left_end, right_start, right_end: max(
                0, min(left_end, right_end) - max(left_start, right_start)
            ),
        ) as overlap:
            results = map_transcripts_to_segments("video_1", [chunk], segments)

        self.assertEqual([row.segment_id for row in results], ["seg_99"])
        self.assertLess(overlap.call_count, 10)

    def test_empty_parquet_keeps_contract_schema(self):
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
            ["video_id", "segment_id", "asr_start_ms", "asr_end_ms", "text", "confidence"],
        )
        self.assertEqual(captured["data"]["asr_start_ms"].dtype, "int64")
        self.assertEqual(captured["data"]["confidence"].dtype, "float64")

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

    def test_reads_segments_json_with_contract_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            segments_path = Path(directory) / "segments.json"
            segments_path.write_text(
                json.dumps(
                    [
                        {
                            "video_id": "video_1",
                            "segment_id": "seg_1",
                            "segment_start_ms": 0,
                            "segment_end_ms": 3000,
                            "source": "baseline",
                            "confidence": 0.9,
                        }
                    ]
                ),
                encoding="utf-8",
            )

            segments = read_segments_json(segments_path)

        self.assertEqual(segments, [Segment("video_1", "seg_1", 0, 3000, "baseline", 0.9)])

    def test_writes_jsonl_matching_asr_contract_keys(self):
        result = map_transcripts_to_segments(
            "video_1",
            [TranscriptChunk(0, 1000, "hello", 0.7)],
            [Segment("video_1", "seg_1", 0, 2000)],
        )

        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "asr.jsonl"
            write_asr_results_jsonl(result, output_path)
            rows = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]

        self.assertEqual(
            rows,
            [
                {
                    "video_id": "video_1",
                    "segment_id": "seg_1",
                    "asr_start_ms": 0,
                    "asr_end_ms": 1000,
                    "text": "hello",
                    "confidence": 0.7,
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
