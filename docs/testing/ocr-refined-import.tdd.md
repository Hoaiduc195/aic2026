# TDD evidence: OCR refined artifact and database import

## Source and user journeys

No separate plan file was provided; journeys were derived from the request:

- A team member keeps the original frame-level PaddleOCR output under
  `data/refined/` and can rebuild the normalized artifact deterministically.
- The importer validates each OCR detection through `frame_aliases.parquet`,
  then writes Vietnamese OCR text evidence while preserving polygon metadata.
- Re-running the import remains idempotent and does not require uploading local
  embedding matrices to R2.

## Evidence

| Guarantee | Test or command | Result |
|---|---|---|
| Accepted OCR detections are flattened with `(video_id, keyframe_no)`, normalized text, confidence and polygon | `tests/test_ocr_refined.py::test_normalize_ocr_record_keeps_accepted_detections_and_occurrence_identity` | PASS |
| JSONL normalization writes only accepted detections to Parquet | `tests/test_ocr_refined.py::test_normalize_ocr_jsonl_writes_only_accepted_text_rows` | PASS |
| OCR validation uses frame aliases and registers a text-evidence artifact | `tests/test_import_refined.py::test_validate_refined_includes_ocr_and_uses_frame_alias_identity` | PASS |
| Full fake database import includes OCR evidence and provenance | `tests/test_import_refined.py::test_full_import_flow_is_idempotent_and_preserves_legacy_ordinal` | PASS |
| Python ingestion tests | `D:\python_3_12_5\python.exe -m pytest -q tests/test_ocr_refined.py tests/test_import_refined.py` | 9 passed |
| Python lint | `ruff check pipelines/ingestion/ocr_refined.py pipelines/ingestion/import_refined.py pipelines/ingestion/database_writer.py tests/test_ocr_refined.py tests/test_import_refined.py` | PASS |
| Real OCR artifact generation | `python -m pipelines.ingestion.ocr_refined --input .../ocr/ocr.jsonl --output .../refined/ocr.parquet` | 93,199 source records → 739,065 rows |
| Real refined dataset dry-run | `python -m pipelines.ingestion.import_refined --data-root .../data/refined --dry-run` | PASS: 873 videos, 739,065 OCR rows |

## RED/GREEN history

- RED: the new tests failed because `ocr_refined` and `include_ocr` did not
  exist in the importer.
- GREEN: the normalizer, OCR validation, feature artifact registration and
  database writer now pass the focused suite and the real dataset dry-run.

## Known gaps

- No live PostgreSQL import was run in this change; the dry-run validates the
  complete artifact set and the fake connection covers SQL phase dispatch.
- The existing untracked `apps/backend/src/database/import-ocr.ts` was not
  modified. The canonical importer remains `pipelines/ingestion/import_refined.py`;
  the untracked file is outside this change's staged scope.
