"""Convert legacy per-video ASR JSON into retrieval-ready span artifacts.

The legacy files contain model-specific logs, partial hypotheses, and optional
word timings.  This module keeps the source files untouched and emits a small,
stable span contract for offline retrieval.  Conversion is fail-closed: a
malformed source is reported and no partial output is promoted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import tempfile
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

ASR_SPAN_COLUMNS = (
    "video_id",
    "segment_id",
    "start_ms",
    "end_ms",
    "text_raw",
    "text_normalized",
    "language",
    "producer",
    "model_version",
    "pipeline_version",
    "schema_version",
    "source_file",
    "source_segment_index",
    "duration_ms",
)

SCHEMA_VERSION = "1.0.0"
DATASET_VERSION = "asr-retrieval-v1"
PIPELINE_VERSION = "asr-dataset-refactor-v1"
PRODUCER = "legacy-asr-json"
SOURCE_GLOB = "*.asr.json"


class RefactorValidationError(ValueError):
    """Raised when one or more legacy ASR records violate the span contract."""

    def __init__(self, issues: Iterable[dict[str, Any]]) -> None:
        self.issues = tuple(issues)
        message = f"ASR refactor validation failed with {len(self.issues)} issue(s)"
        if self.issues:
            first = self.issues[0]
            message += f": {first.get('source_file', '<unknown>')}"
            if first.get("source_segment_index") is not None:
                message += f" segment {first['source_segment_index']}"
            message += f" ({first.get('code', 'invalid')})"
        super().__init__(message)


@dataclass(frozen=True)
class ParsedLegacyFile:
    """Validated rows and source metadata for one legacy video file."""

    video_id: str
    source_file: str
    duration_ms: int
    model_version: str
    rows: tuple[dict[str, Any], ...]


def normalize_text(value: str) -> str:
    """Normalize Unicode and whitespace without removing Vietnamese diacritics."""

    if not isinstance(value, str):
        raise TypeError("transcript text must be a string")
    return " ".join(unicodedata.normalize("NFC", value).split())


def _issue(
    source_file: str,
    code: str,
    message: str,
    source_segment_index: int | None = None,
) -> dict[str, Any]:
    issue: dict[str, Any] = {
        "source_file": source_file,
        "code": code,
        "message": message,
    }
    if source_segment_index is not None:
        issue["source_segment_index"] = source_segment_index
    return issue


def _seconds_to_ms(
    value: Any,
    *,
    source_file: str,
    field_name: str,
    source_segment_index: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RefactorValidationError(
            [_issue(source_file, "invalid_timestamp", f"{field_name} must be numeric", source_segment_index)]
        )
    if not math.isfinite(float(value)) or value < 0:
        raise RefactorValidationError(
            [_issue(source_file, "invalid_timestamp", f"{field_name} must be finite and non-negative", source_segment_index)]
        )
    return int(round(float(value) * 1000))


def _load_json(path: Path) -> dict[str, Any]:
    source_file = path.name
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RefactorValidationError(
            [_issue(source_file, "invalid_json", f"cannot read JSON: {exc}")]
        ) from exc
    if not isinstance(payload, dict):
        raise RefactorValidationError(
            [_issue(source_file, "invalid_root", "root JSON value must be an object")]
        )
    return payload


def _model_version(payload: dict[str, Any], source_file: str) -> str:
    value = payload.get("model", payload.get("model_version"))
    if not isinstance(value, str) or not value.strip():
        raise RefactorValidationError(
            [_issue(source_file, "missing_model", "model version is missing")]
        )
    return value.strip()


def _duration_ms(payload: dict[str, Any], source_file: str) -> int:
    value = payload.get("duration_sec")
    duration_ms = _seconds_to_ms(
        value,
        source_file=source_file,
        field_name="duration_sec",
    )
    if duration_ms <= 0:
        raise RefactorValidationError(
            [_issue(source_file, "invalid_duration", "duration_sec must be positive")]
        )
    return duration_ms


def _end_seconds(segment: dict[str, Any], source_file: str, index: int) -> Any:
    if "end_time" in segment:
        return segment["end_time"]
    partials = segment.get("partials")
    if not isinstance(partials, list) or not partials:
        raise RefactorValidationError(
            [_issue(source_file, "missing_partials", "segment has no partial timestamp", index)]
        )
    last_partial = partials[-1]
    if not isinstance(last_partial, dict) or "timestamp" not in last_partial:
        raise RefactorValidationError(
            [_issue(source_file, "missing_end_timestamp", "last partial has no timestamp", index)]
        )
    return last_partial["timestamp"]


def _segment_row(
    segment: Any,
    *,
    video_id: str,
    source_file: str,
    source_segment_index: int,
    duration_ms: int,
    model_version: str,
    language: str,
    pipeline_version: str,
) -> dict[str, Any]:
    if not isinstance(segment, dict):
        raise RefactorValidationError(
            [_issue(source_file, "invalid_segment", "segment must be an object", source_segment_index)]
        )
    if segment.get("type", "text") != "text":
        raise RefactorValidationError(
            [_issue(source_file, "unsupported_segment_type", "only text segments are supported", source_segment_index)]
        )

    text = segment.get("text")
    if not isinstance(text, str):
        raise RefactorValidationError(
            [_issue(source_file, "missing_text", "segment text must be a string", source_segment_index)]
        )
    text_raw = normalize_text(text)
    if not text_raw:
        raise RefactorValidationError(
            [_issue(source_file, "empty_text", "segment text is empty", source_segment_index)]
        )

    start_ms = _seconds_to_ms(
        segment.get("start_time"),
        source_file=source_file,
        field_name="start_time",
        source_segment_index=source_segment_index,
    )
    end_ms = _seconds_to_ms(
        _end_seconds(segment, source_file, source_segment_index),
        source_file=source_file,
        field_name="end_time",
        source_segment_index=source_segment_index,
    )
    if end_ms <= start_ms:
        raise RefactorValidationError(
            [_issue(source_file, "invalid_interval", "end timestamp must be greater than start", source_segment_index)]
        )
    if end_ms > duration_ms:
        raise RefactorValidationError(
            [_issue(source_file, "duration_mismatch", "segment end exceeds video duration", source_segment_index)]
        )
    if not isinstance(language, str) or not language.strip():
        raise ValueError("language must be a non-empty string")

    return {
        "video_id": video_id,
        "segment_id": f"{video_id}_asr_{source_segment_index:06d}",
        "start_ms": start_ms,
        "end_ms": end_ms,
        "text_raw": text_raw,
        "text_normalized": normalize_text(text_raw),
        "language": language.strip(),
        "producer": PRODUCER,
        "model_version": model_version,
        "pipeline_version": pipeline_version,
        "schema_version": SCHEMA_VERSION,
        "source_file": source_file,
        "source_segment_index": source_segment_index,
        "duration_ms": duration_ms,
    }


def parse_legacy_file(
    path: Path,
    source_root: Path,
    *,
    language: str = "vi",
    pipeline_version: str = PIPELINE_VERSION,
) -> ParsedLegacyFile:
    """Validate one legacy file and return retrieval-ready rows."""

    source_file = path.relative_to(source_root).as_posix()
    video_id = path.name.removesuffix(".asr.json")
    if not video_id:
        raise RefactorValidationError(
            [_issue(source_file, "missing_video_id", "file name does not contain a video ID")]
        )
    payload = _load_json(path)
    duration_ms = _duration_ms(payload, source_file)
    model_version = _model_version(payload, source_file)
    segments = payload.get("segments")
    if not isinstance(segments, list):
        raise RefactorValidationError(
            [_issue(source_file, "missing_segments", "segments must be a list")]
        )

    rows: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for index, segment in enumerate(segments):
        try:
            rows.append(
                _segment_row(
                    segment,
                    video_id=video_id,
                    source_file=source_file,
                    source_segment_index=index,
                    duration_ms=duration_ms,
                    model_version=model_version,
                    language=language,
                    pipeline_version=pipeline_version,
                )
            )
        except RefactorValidationError as exc:
            issues.extend(exc.issues)
    if issues:
        raise RefactorValidationError(issues)

    return ParsedLegacyFile(
        video_id=video_id,
        source_file=source_file,
        duration_ms=duration_ms,
        model_version=model_version,
        rows=tuple(rows),
    )


def _parquet_schema() -> Any:
    try:
        import pyarrow as pa
    except ImportError as exc:
        raise RuntimeError("pyarrow is required to write ASR Parquet output") from exc

    fields = [
        pa.field("video_id", pa.string()),
        pa.field("segment_id", pa.string()),
        pa.field("start_ms", pa.int64()),
        pa.field("end_ms", pa.int64()),
        pa.field("text_raw", pa.string()),
        pa.field("text_normalized", pa.string()),
        pa.field("language", pa.string()),
        pa.field("producer", pa.string()),
        pa.field("model_version", pa.string()),
        pa.field("pipeline_version", pa.string()),
        pa.field("schema_version", pa.string()),
        pa.field("source_file", pa.string()),
        pa.field("source_segment_index", pa.int64()),
        pa.field("duration_ms", pa.int64()),
    ]
    return pa.schema(fields, metadata={b"schema_version": SCHEMA_VERSION.encode()})


def _write_json_rows(file: Any, rows: Iterable[dict[str, Any]]) -> None:
    for row in rows:
        file.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _artifact_metadata(path: Path, name: str, rows: int | None = None) -> dict[str, Any]:
    artifact: dict[str, Any] = {
        "path": name,
        "size_bytes": path.stat().st_size,
        "sha256": _sha256(path),
    }
    if rows is not None:
        artifact["rows"] = rows
    return artifact


def _write_json_atomic(payload: dict[str, Any], path: Path) -> Path:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as file:
            temporary_path = Path(file.name)
            json.dump(payload, file, ensure_ascii=False, indent=2)
            file.write("\n")
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
    return path


def _validate_generated_files(
    parquet_path: Path,
    jsonl_path: Path,
    *,
    expected_rows: int,
    duration_by_video: dict[str, int],
) -> None:
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError("pyarrow is required to validate ASR Parquet output") from exc

    table = pq.read_table(parquet_path)
    if table.column_names != list(ASR_SPAN_COLUMNS):
        raise RefactorValidationError(
            [_issue("asr_spans.parquet", "schema_mismatch", "Parquet columns do not match the span contract")]
        )
    if table.num_rows != expected_rows:
        raise RefactorValidationError(
            [_issue("asr_spans.parquet", "row_count_mismatch", "Parquet row count does not match conversion count")]
        )

    ids = set()
    jsonl_rows = 0
    for line_number, line in enumerate(jsonl_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        jsonl_rows += 1
        required = set(ASR_SPAN_COLUMNS)
        if set(row) != required:
            raise RefactorValidationError(
                [_issue("asr_spans.jsonl", "schema_mismatch", f"unexpected keys at line {line_number}")]
            )
        segment_id = row["segment_id"]
        if segment_id in ids:
            raise RefactorValidationError(
                [_issue("asr_spans.jsonl", "duplicate_segment_id", segment_id)]
            )
        ids.add(segment_id)
        if not row["text_normalized"].strip():
            raise RefactorValidationError(
                [_issue("asr_spans.jsonl", "empty_text", f"empty text at line {line_number}")]
            )
        if not 0 <= row["start_ms"] < row["end_ms"] <= duration_by_video[row["video_id"]]:
            raise RefactorValidationError(
                [_issue("asr_spans.jsonl", "invalid_interval", f"invalid interval at line {line_number}")]
            )
    if jsonl_rows != expected_rows:
        raise RefactorValidationError(
            [_issue("asr_spans.jsonl", "row_count_mismatch", "JSONL row count does not match conversion count")]
        )


def refactor_dataset(
    source_dir: Path,
    output_dir: Path,
    *,
    language: str = "vi",
    dataset_version: str = DATASET_VERSION,
    pipeline_version: str = PIPELINE_VERSION,
    batch_size: int = 4096,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Convert all legacy ASR files into validated retrieval artifacts."""

    source_dir = Path(source_dir)
    output_dir = Path(output_dir)
    if not source_dir.is_dir():
        raise FileNotFoundError(f"source directory does not exist: {source_dir}")
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    if not language.strip():
        raise ValueError("language must be non-empty")
    if output_dir.resolve() == source_dir.resolve():
        raise ValueError("output directory must be separate from the legacy source directory")
    try:
        output_dir.resolve().relative_to(source_dir.resolve())
    except ValueError:
        pass
    else:
        raise ValueError("output directory cannot be inside the legacy source directory")

    source_files = sorted(source_dir.glob(SOURCE_GLOB), key=lambda path: path.name)
    if not source_files:
        raise ValueError(f"no source files matched {SOURCE_GLOB} in {source_dir}")

    artifact_names = (
        "asr_spans.parquet",
        "asr_spans.jsonl",
        "manifest.json",
        "quality_report.json",
    )
    existing = [output_dir / name for name in artifact_names if (output_dir / name).exists()]
    if existing and not overwrite:
        raise FileExistsError(
            "output already exists; pass overwrite=True: "
            + ", ".join(str(path) for path in existing)
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    temporary_paths: list[Path] = []
    parquet_writer: Any = None
    source_files_processed = 0
    source_segments_discovered = 0
    spans_written = 0
    total_duration_ms = 0
    model_counts: Counter[str] = Counter()
    duration_by_video: dict[str, int] = {}
    issues: list[dict[str, Any]] = []
    anomaly_counts = {
        "timestamp_clip": 0,
        "duration_mismatch": 0,
        "empty_text": 0,
        "missing_partials": 0,
    }

    parquet_tmp: Path | None = None
    jsonl_tmp: Path | None = None
    quality_tmp: Path | None = None
    manifest_tmp: Path | None = None
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq

        parquet_tmp = Path(
            tempfile.NamedTemporaryFile(
                dir=output_dir,
                prefix=".asr_spans.parquet.",
                suffix=".tmp",
                delete=False,
            ).name
        )
        jsonl_tmp = Path(
            tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="\n",
                dir=output_dir,
                prefix=".asr_spans.jsonl.",
                suffix=".tmp",
                delete=False,
            ).name
        )
        temporary_paths.extend([parquet_tmp, jsonl_tmp])
        parquet_writer = pq.ParquetWriter(parquet_tmp, _parquet_schema(), compression="snappy")
        batch: list[dict[str, Any]] = []

        with jsonl_tmp.open("w", encoding="utf-8", newline="\n") as jsonl_file:
            for source_path in source_files:
                try:
                    parsed = parse_legacy_file(
                        source_path,
                        source_dir,
                        language=language,
                        pipeline_version=pipeline_version,
                    )
                except RefactorValidationError as exc:
                    issues.extend(exc.issues)
                    for issue in exc.issues:
                        code = issue.get("code")
                        if code in anomaly_counts:
                            anomaly_counts[code] += 1
                    continue

                source_files_processed += 1
                source_segments_discovered += len(parsed.rows)
                spans_written += len(parsed.rows)
                total_duration_ms += parsed.duration_ms
                model_counts[parsed.model_version] += 1
                duration_by_video[parsed.video_id] = parsed.duration_ms
                for row in parsed.rows:
                    batch.append(row)
                    if len(batch) >= batch_size:
                        _write_json_rows(jsonl_file, batch)
                        parquet_writer.write_table(pa.Table.from_pylist(batch, schema=_parquet_schema()))
                        batch.clear()
            if batch:
                _write_json_rows(jsonl_file, batch)
                parquet_writer.write_table(pa.Table.from_pylist(batch, schema=_parquet_schema()))
                batch.clear()
        parquet_writer.close()
        parquet_writer = None

        if issues:
            raise RefactorValidationError(issues)

        assert parquet_tmp is not None
        assert jsonl_tmp is not None
        _validate_generated_files(
            parquet_tmp,
            jsonl_tmp,
            expected_rows=spans_written,
            duration_by_video=duration_by_video,
        )

        quality_report = {
            "dataset_version": dataset_version,
            "schema_version": SCHEMA_VERSION,
            "pipeline_version": pipeline_version,
            "source_glob": SOURCE_GLOB,
            "source_files_discovered": len(source_files),
            "source_files_processed": source_files_processed,
            "source_segments_discovered": source_segments_discovered,
            "spans_written": spans_written,
            "invalid_file_count": len({issue["source_file"] for issue in issues}),
            "invalid_segment_count": len(
                [issue for issue in issues if issue.get("source_segment_index") is not None]
            ),
            "anomaly_counts": anomaly_counts,
            "issues": issues,
        }
        quality_tmp = _temporary_json_path(output_dir, "quality_report.json")
        manifest_tmp = _temporary_json_path(output_dir, "manifest.json")
        temporary_paths.extend([quality_tmp, manifest_tmp])
        quality_tmp.write_text(
            json.dumps(quality_report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        generated_at = datetime.now(timezone.utc).isoformat()
        manifest = {
            "dataset_id": "asr_retrieval",
            "dataset_version": dataset_version,
            "schema_version": SCHEMA_VERSION,
            "pipeline_version": pipeline_version,
            "generated_at": generated_at,
            "source_glob": SOURCE_GLOB,
            "source_files_discovered": len(source_files),
            "source_files_processed": source_files_processed,
            "source_segments_discovered": source_segments_discovered,
            "spans_written": spans_written,
            "total_duration_ms": total_duration_ms,
            "language": language,
            "model_counts": dict(sorted(model_counts.items())),
            "artifacts": {
                "asr_spans.parquet": _artifact_metadata(parquet_tmp, "asr_spans.parquet", spans_written),
                "asr_spans.jsonl": _artifact_metadata(jsonl_tmp, "asr_spans.jsonl", spans_written),
                "quality_report.json": _artifact_metadata(quality_tmp, "quality_report.json"),
            },
        }
        manifest_tmp.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        os.replace(parquet_tmp, output_dir / "asr_spans.parquet")
        os.replace(jsonl_tmp, output_dir / "asr_spans.jsonl")
        os.replace(quality_tmp, output_dir / "quality_report.json")
        os.replace(manifest_tmp, output_dir / "manifest.json")
        temporary_paths.clear()
        return manifest
    finally:
        if parquet_writer is not None:
            parquet_writer.close()
        for temporary_path in temporary_paths:
            if temporary_path.exists():
                temporary_path.unlink()


def _temporary_json_path(output_dir: Path, name: str) -> Path:
    handle = tempfile.NamedTemporaryFile(
        dir=output_dir,
        prefix=f".{name}.",
        suffix=".tmp",
        delete=False,
    )
    handle.close()
    return Path(handle.name)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--language", default="vi")
    parser.add_argument("--dataset-version", default=DATASET_VERSION)
    parser.add_argument("--pipeline-version", default=PIPELINE_VERSION)
    parser.add_argument("--batch-size", type=int, default=4096)
    parser.add_argument("--overwrite", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    manifest = refactor_dataset(
        args.source_dir,
        args.output_dir,
        language=args.language,
        dataset_version=args.dataset_version,
        pipeline_version=args.pipeline_version,
        batch_size=args.batch_size,
        overwrite=args.overwrite,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
