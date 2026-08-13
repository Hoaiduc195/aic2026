import json
import tempfile
import unittest
from pathlib import Path

import pyarrow.parquet as pq

from pipelines.feature_extraction.asr.refactor import (
    ASR_SPAN_COLUMNS,
    RefactorValidationError,
    normalize_text,
    refactor_dataset,
)


def _write_legacy_file(
    root: Path,
    video_id: str,
    *,
    duration_sec: float = 4.5,
    segments: list[dict] | None = None,
) -> Path:
    payload = {
        "version": 1,
        "model": "zipformer-test",
        "model_type": "file",
        "created_at": "2026-08-04T12:11:33.200191",
        "duration_sec": duration_sec,
        "segments": segments
        or [
            {
                "type": "text",
                "text": "  Xin  chào\nquý vị. ",
                "start_time": 0.5,
                "segment_id": 99,
                "partials": [{"text": "Xin chào quý vị.", "timestamp": 1.75}],
                "raw_words": [
                    {"text": "xin", "start": 0.5, "end": 0.8},
                    {"text": "chào", "start": 0.8, "end": 1.2},
                ],
            }
        ],
    }
    path = root / f"{video_id}.asr.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


class AsrDatasetRefactorTest(unittest.TestCase):
    def test_normalize_text_preserves_diacritics_and_collapses_whitespace(self):
        self.assertEqual(normalize_text("  A\u0301   b\n c  "), "Á b c")

    def test_refactor_writes_canonical_span_without_confidence_or_words(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            _write_legacy_file(source, "L01_V001")

            summary = refactor_dataset(source, output)

            rows = [
                json.loads(line)
                for line in (output / "asr_spans.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]

        self.assertEqual(summary["source_files_processed"], 1)
        self.assertEqual(summary["spans_written"], 1)
        self.assertEqual(
            rows[0],
            {
                "video_id": "L01_V001",
                "segment_id": "L01_V001_asr_000000",
                "start_ms": 500,
                "end_ms": 1750,
                "text_raw": "Xin chào quý vị.",
                "text_normalized": "Xin chào quý vị.",
                "language": "vi",
                "producer": "legacy-asr-json",
                "model_version": "zipformer-test",
                "pipeline_version": "asr-dataset-refactor-v1",
                "schema_version": "1.0.0",
                "source_file": "L01_V001.asr.json",
                "source_segment_index": 0,
                "duration_ms": 4500,
            },
        )
        self.assertNotIn("confidence", rows[0])
        self.assertNotIn("words", rows[0])

    def test_refactor_writes_matching_parquet_schema_and_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            _write_legacy_file(source, "L01_V002")
            _write_legacy_file(source, "L01_V001", duration_sec=5.0)

            refactor_dataset(source, output)

            table = pq.read_table(output / "asr_spans.parquet")
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            quality = json.loads(
                (output / "quality_report.json").read_text(encoding="utf-8")
            )

        self.assertEqual(table.column_names, list(ASR_SPAN_COLUMNS))
        self.assertEqual(table.num_rows, 2)
        self.assertEqual(manifest["source_files_processed"], 2)
        self.assertEqual(manifest["spans_written"], 2)
        self.assertEqual(manifest["artifacts"]["asr_spans.parquet"]["rows"], 2)
        self.assertEqual(quality["invalid_file_count"], 0)
        self.assertEqual(quality["invalid_segment_count"], 0)
        self.assertEqual(quality["anomaly_counts"]["timestamp_clip"], 0)

    def test_small_end_overflow_is_clipped_and_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            _write_legacy_file(
                source,
                "L01_EDGE",
                duration_sec=4.5,
                segments=[
                    {
                        "type": "text",
                        "text": "boundary",
                        "start_time": 4.0,
                        "segment_id": 0,
                        "partials": [{"timestamp": 4.501}],
                    }
                ],
            )

            refactor_dataset(source, output)

            row = json.loads(
                (output / "asr_spans.jsonl").read_text(encoding="utf-8").strip()
            )
            quality = json.loads(
                (output / "quality_report.json").read_text(encoding="utf-8")
            )

        self.assertEqual(row["end_ms"], 4500)
        self.assertEqual(quality["anomaly_counts"]["timestamp_clip"], 1)

    def test_invalid_segment_fails_without_leaving_partial_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            _write_legacy_file(
                source,
                "L01_BAD",
                segments=[
                    {
                        "type": "text",
                        "text": "invalid",
                        "start_time": 2.0,
                        "segment_id": 0,
                        "partials": [{"timestamp": 1.0}],
                    }
                ],
            )

            with self.assertRaises(RefactorValidationError):
                refactor_dataset(source, output)

            self.assertFalse((output / "asr_spans.parquet").exists())
            self.assertFalse((output / "asr_spans.jsonl").exists())
            self.assertFalse((output / "manifest.json").exists())

    def test_existing_output_requires_explicit_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            _write_legacy_file(source, "L01_V001")
            refactor_dataset(source, output)

            with self.assertRaises(FileExistsError):
                refactor_dataset(source, output)


if __name__ == "__main__":
    unittest.main()
