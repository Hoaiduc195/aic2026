# ASR retrieval dataset refactor — TDD evidence

## Source plan and user journeys

The source was the approved conversational plan for refactoring the official
offline ASR dataset for retrieval/KIS competition use.

- As an offline retrieval pipeline, I need stable segment-level ASR spans so
  that text search and video seeking use one canonical interval contract.
- As a data maintainer, I need the legacy per-video JSON preserved so that the
  derived dataset can be regenerated and audited without data loss.
- As a competition operator, I need Parquet, JSONL, manifest, and quality
  outputs so that the dataset can be indexed, inspected, and verified.

## RED / GREEN / refactor evidence

| Stage | Command | Result |
|---|---|---|
| RED | `venv\\Scripts\\python.exe -m unittest tests.test_asr_dataset_refactor` | Failed as intended with `ModuleNotFoundError: pipelines.feature_extraction.asr.refactor`. |
| GREEN | `venv\\Scripts\\python.exe -m unittest tests.test_asr_dataset_refactor tests.test_asr_module tests.test_sherpa_asr_cli` | 35 tests passed. |
| Refactor | `ruff check pipelines/feature_extraction/asr tests/test_asr_dataset_refactor.py` | All checks passed. |

## Guarantees

| # | Guarantee | Evidence | Result |
|---|---|---|---|
| 1 | Unicode NFC and whitespace normalization preserves Vietnamese diacritics. | `tests/test_asr_dataset_refactor.py:test_normalize_text_preserves_diacritics_and_collapses_whitespace` | PASS |
| 2 | Legacy seconds become integer milliseconds with stable segment IDs and no confidence/word fields. | `tests/test_asr_dataset_refactor.py:test_refactor_writes_canonical_span_without_confidence_or_words` | PASS |
| 3 | Parquet, JSONL, manifest, and quality report share the canonical schema and counts. | `tests/test_asr_dataset_refactor.py:test_refactor_writes_matching_parquet_schema_and_manifest` | PASS |
| 4 | Small timestamp rounding overflow is clipped and reported; larger invalid intervals fail. | `tests/test_asr_dataset_refactor.py:test_small_end_overflow_is_clipped_and_reported`; `test_invalid_segment_fails_without_leaving_partial_artifacts` | PASS |
| 5 | Existing outputs are protected unless overwrite is explicit. | `tests/test_asr_dataset_refactor.py:test_existing_output_requires_explicit_overwrite` | PASS |
| 6 | Existing ASR behavior remains regression-free. | `venv\\Scripts\\python.exe -m unittest discover -s tests` | 178 tests passed. |
| 7 | Changed Python modules compile and lint cleanly. | `venv\\Scripts\\python.exe -m compileall -q pipelines/feature_extraction/asr tests/test_asr_dataset_refactor.py`; Ruff | PASS |
| 8 | Converter executable-line coverage meets the 80% target. | Python built-in trace report for `pipelines.feature_extraction.asr.refactor` | 408 lines, 100%. |

## Full dataset result

Command:

```powershell
venv\\Scripts\\python.exe -m pipelines.feature_extraction.asr.refactor `
  --source-dir D:\\workspace\\aic\\data\\asr `
  --output-dir D:\\workspace\\aic\\data\\asr_refactored --overwrite
```

Result:

- 873 source files discovered and processed.
- 77,377 spans written.
- Parquet and JSONL contain identical rows and canonical columns.
- 0 invalid files, 0 invalid segments, 0 empty texts.
- 2 timestamp boundary clips (4 ms and 1 ms); no large duration mismatch.
- Manifest checksums match the generated artifacts.
- Legacy `data/asr/*.asr.json` files remain unchanged.

## Checkpoint commits

- `b01647c test: add ASR dataset refactor coverage` — RED tests.
- `b6acaa4 fix: add ASR retrieval dataset converter` — initial GREEN implementation.
- `730c967 refactor: finalize ASR retrieval dataset contract` — schema/docs/export cleanup.
- `dfda441 fix: clip bounded ASR timestamp overflow` — data-driven boundary policy and regression test.
- `47add0a fix: avoid ASR refactor CLI import warning` — clean module CLI invocation.

## Known gaps

The environment does not include `coverage.py` or `pytest`; the coverage figure
uses Python's standard-library `trace` module. The dataset intentionally omits
confidence and word-level timestamps as agreed for this retrieval-only artifact.
